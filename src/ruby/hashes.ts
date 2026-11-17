import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { inspect, rEql, toInt } from './conversions';
import { coreMethod, isCoreMethod } from './define';
import { frozenError, runtimeError } from './errors';
import { callMethod, callProc, type Gen, invoke, isGenerator, runToEnd } from './interp';
import {
  type HashEntry,
  isRubyFloat,
  NIL,
  RArray,
  RBasic,
  RHash,
  RRange,
  RString,
  RSymbol,
  type Value,
} from './objects';
import { rt, RubyJump } from './runtime';
import { classOf, internFrozenString, requireObjectIdentity, sameIdentity, snapshot, str, stringBytes } from './values';

interface HashTraversal {
  active: Set<Value>;
  callbacks: number;
  memo: WeakMap<RBasic, { key: string; callbacks: number }>;
}

const hashTraversals = new WeakMap<object, HashTraversal>();

class RecursiveHashSignal extends RubyJump {
  constructor(readonly traversal: HashTraversal) {
    super();
  }
}

export function* hashKeyOf(value: Value): Gen<string> {
  rt().spend();
  if (value instanceof RString) return digest(String(stringKeyHash(value)));
  const classes = rt().c;
  const primitiveOwner =
    typeof value === 'bigint'
      ? classes.Integer
      : isRubyFloat(value)
        ? classes.Float
        : value instanceof RSymbol
          ? classes.Symbol
          : value === NIL || typeof value === 'boolean'
            ? classes.Kernel
            : undefined;
  if (primitiveOwner)
    return digest(
      String(yield* toInt(yield* invoke(coreMethod(primitiveOwner, 'hash'), value, [], undefined, undefined, true)))
    );
  return yield* withHashTraversal((traversal) => hashKeyInTraversal(value, traversal));
}

export function* structuralHashValue(value: RArray | RRange | RHash): Gen<bigint> {
  return yield* withHashTraversal(() => structuralHash(value));
}

export function* withHashTraversal<T>(body: (traversal: HashTraversal) => Gen<T>): Gen<T> {
  const context = rt().activeCursor ?? rt();
  const existing = hashTraversals.get(context);
  const traversal: HashTraversal = existing ?? { active: new Set<Value>(), callbacks: 0, memo: new WeakMap() };
  if (!existing) hashTraversals.set(context, traversal);
  try {
    return yield* body(traversal);
  } finally {
    if (!existing) hashTraversals.delete(context);
  }
}

// code-gauge-allow functionNcss 35 -- Recursive guards end before hash-code conversion, while roots and memoization span both phases.
function* hashKeyInTraversal(value: Value, traversal: HashTraversal): Gen<string> {
  if (traversal.active.has(value)) throw new RecursiveHashSignal(traversal);
  const structural = isStructuralHash(value);
  const cached = structural ? traversal.memo.get(value) : undefined;
  if (cached?.callbacks === traversal.callbacks) return cached.key;
  if (traversal.active.size >= LIMITS.maxCallDepth) throw new ExecutionLimitError('output');
  const callbacks = traversal.callbacks;
  const outermost = traversal.active.size === 0;
  const mark = rt().held.length;
  rt().held.push(value);
  let recursive = false;
  let hash: Value;
  traversal.active.add(value);
  try {
    try {
      if (structural) hash = (yield structuralHash(value)) as Value;
      else {
        traversal.callbacks++;
        hash = (yield callMethod(value, 'hash', [], undefined, undefined, { fcall: true })) as Value;
      }
    } catch (error) {
      if (!(outermost && error instanceof RecursiveHashSignal && error.traversal === traversal)) throw error;
      hash = 0n;
      recursive = true;
    } finally {
      traversal.active.delete(value);
    }
    rt().held.push(hash);
    const key = digest(String(yield* toInt(hash)));
    if (structural && !recursive && callbacks === traversal.callbacks) traversal.memo.set(value, { key, callbacks });
    return key;
  } finally {
    rt().held.length = mark;
  }
}

function isStructuralHash(value: Value): value is RArray | RRange | RHash {
  const owner =
    value instanceof RArray
      ? rt().c.Array
      : value instanceof RRange
        ? rt().c.Range
        : value instanceof RHash
          ? rt().c.Hash
          : undefined;
  return owner !== undefined && isCoreMethod(classOf(value).findMethod('hash'), owner, 'hash');
}

function* structuralHash(value: RArray | RRange | RHash): Gen<bigint> {
  let parts: string[];
  if (value instanceof RArray) {
    parts = [];
    for (let index = 0; index < value.items.length; index++) parts.push(yield* hashKeyOf(value.items[index]));
  } else if (value instanceof RRange) {
    parts = [yield* hashKeyOf(value.begin), value.exclusive ? 'exclusive' : 'inclusive', yield* hashKeyOf(value.end)];
  } else {
    parts = [];
    value.iterating++;
    try {
      for (const entry of value.map.values())
        parts.push(JSON.stringify([yield* hashKeyOf(entry.key), yield* hashKeyOf(entry.value)]));
    } finally {
      value.iterating--;
    }
    parts.sort();
  }
  return BigInt(`0x${digest(JSON.stringify(parts))}`);
}

export function digest(text: string): string {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index++)
    value = Math.imul(value ^ (text.codePointAt(index) as number), 16_777_619);
  return (value >>> 0).toString(16);
}

export function stringKeyHash(value: RString): bigint {
  let hash = 7n;
  for (const byte of stringBytes(value)) hash = (hash * 31n + BigInt(byte)) % 2_305_843_009_213_693_951n;
  return hash;
}

export function stringKeyEquals(left: RString, other: Value): boolean {
  if (!(other instanceof RString)) return false;
  if (!left.binary && !other.binary && !left.usAscii && !other.usAscii && !left.rawBytes && !other.rawBytes)
    return left.s === other.s;
  const leftBytes = stringBytes(left);
  const rightBytes = stringBytes(other);
  if (
    (left.binary !== other.binary || left.usAscii !== other.usAscii) &&
    (leftBytes.some((byte) => byte >= 0x80) || rightBytes.some((byte) => byte >= 0x80))
  )
    return false;
  return leftBytes.length === rightBytes.length && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

/** Finds the entry for `key`, checking equality even when distinct keys have the same hash. */
function* findEntry(hash: RHash, key: Value): Gen<{ base: string; slot: string; entry: HashEntry | undefined }> {
  if (hash.byIdentity) {
    requireObjectIdentity(key);
    const identity =
      key instanceof RBasic || key instanceof RSymbol
        ? `o${key.id}`
        : typeof key === 'object'
          ? 'nil'
          : `${typeof key}:${String(key)}`;
    return yield* findEntryInBucket(hash, key, `h${digest(identity)}`);
  }
  const base = `h${yield* hashKeyOf(key)}`;
  return yield* findEntryInBucket(hash, key, base);
}

function* findEntryInBucket(
  hash: RHash,
  key: Value,
  base: string
): Gen<{ base: string; slot: string; entry: HashEntry | undefined }> {
  if (hash.bucketVersion !== hash.map.version) rebuildBuckets(hash);
  for (const slot of hash.buckets.get(base) ?? []) {
    const entry = hash.map.get(slot);
    if (entry && (sameIdentity(entry.key, key) || (!hash.byIdentity && (yield* hashKeysEqual(key, entry.key)))))
      return { base, slot, entry };
  }
  for (let index = 0; ; index++) {
    const slot = JSON.stringify([base, index]);
    if (!hash.map.has(slot)) return { base, slot, entry: undefined };
  }
}

function* hashKeysEqual(key: Value, stored: Value): Gen<boolean> {
  if (key instanceof RString && key.cls === rt().c.String && stored instanceof RString && stored.cls === rt().c.String)
    return stringKeyEquals(key, stored);
  if (key instanceof RSymbol && stored instanceof RSymbol) return key === stored;
  return yield* rEql(key, stored);
}

export function* hashSetStored(hash: RHash, storedSlot: string, source: HashEntry): Gen<boolean> {
  const [base] = JSON.parse(storedSlot) as [string, number];
  return yield* hashPut(
    hash,
    source.key,
    source.value,
    () => findEntryInBucket(hash, source.key, base),
    () => source.key
  );
}

function rebuildBuckets(hash: RHash): void {
  hash.buckets.clear();
  for (const slot of hash.map.keys()) {
    const [base] = JSON.parse(slot) as [string, number];
    const bucket = hash.buckets.get(base) ?? [];
    bucket.push(slot);
    hash.buckets.set(base, bucket);
  }
  hash.bucketVersion = hash.map.version;
}

export function* hashGet(hash: RHash, key: Value): Gen<HashEntry | undefined> {
  return (yield* findEntry(hash, key)).entry;
}

export function* hashGetOrInsert(
  hash: RHash,
  key: Value,
  create: () => Value | Gen,
  recheckFrozen = true
): Gen<{ entry: HashEntry; inserted: boolean }> {
  const held = rt().held.length;
  rt().held.push(hash, key);
  try {
    if (hash.frozen) throw frozenError(hash, yield* inspect(hash));
    const { base, slot, entry } = yield* findEntry(hash, key);
    if (entry) return { entry, inserted: false };
    const created = create();
    const value = isGenerator(created) ? yield* created : created;
    rt().held.push(value);
    if (recheckFrozen && hash.frozen) throw frozenError(hash, yield* inspect(hash));
    const stored =
      key instanceof RString && key.cls === rt().c.String && !key.frozen && !hash.byIdentity ? frozenCopy(key) : key;
    return { entry: insertHashEntry(hash, base, slot, stored, value), inserted: true };
  } finally {
    rt().held.length = held;
  }
}

/** The value for `key`, or the hash's default (calling its default block) when it has none. */
export function* hashFetch(hash: RHash, key: Value): Gen {
  const entry = yield* hashGet(hash, key);
  if (entry) return entry.value;
  return yield* callMethod(hash, 'default', [key]);
}

export function* hashDefault(hash: RHash, key: Value): Gen {
  if (hash.defaultProc) return yield* callProc(hash.defaultProc, [hash, key]);
  return hash.defaultValue;
}

export function* hashSet(hash: RHash, key: Value, value: Value): Gen<boolean> {
  return yield* hashPut(
    hash,
    key,
    value,
    () => findEntry(hash, key),
    () =>
      key instanceof RString && key.cls === rt().c.String && !key.frozen && !hash.byIdentity ? frozenCopy(key) : key
  );
}

function* hashPut(
  hash: RHash,
  key: Value,
  value: Value,
  locate: () => Gen<{ base: string; slot: string; entry: HashEntry | undefined }>,
  storedKey: () => Value
): Gen<boolean> {
  const held = rt().held.length;
  rt().held.push(hash, key, value);
  try {
    if (hash.frozen) throw frozenError(hash, yield* inspect(hash));
    const { base, slot, entry } = yield* locate();
    if (hash.frozen) throw frozenError(hash, yield* inspect(hash));
    if (entry) {
      hashUpdateEntry(hash, entry, value);
      return true;
    }
    insertHashEntry(hash, base, slot, storedKey(), value);
    return false;
  } finally {
    rt().held.length = held;
  }
}

export function hashUpdateEntry(hash: RHash, entry: HashEntry, value: Value): void {
  entry.value = value;
  hash.map.version++;
  rt().containerVersion++;
}

function insertHashEntry(hash: RHash, base: string, slot: string, key: Value, value: Value): HashEntry {
  if (hash.iterating > 0) throw runtimeError(hash.iterationError ?? "can't add a new key into hash during iteration");
  rt().chargeSlots(1);
  rt().spend();
  const entry = { key, value };
  hash.map.set(slot, entry);
  const bucket = hash.buckets.get(base) ?? [];
  bucket.push(slot);
  hash.buckets.set(base, bucket);
  hash.bucketVersion = hash.map.version;
  return entry;
}

function frozenCopy(key: RString): RString {
  const copy = str(key.s);
  copy.binary = key.binary;
  copy.usAscii = key.usAscii;
  copy.rawBytes = key.rawBytes ? Uint8Array.from(key.rawBytes) : undefined;
  return internFrozenString(copy);
}

export function* hashDelete(hash: RHash, key: Value): Gen<HashEntry | undefined> {
  if (hash.frozen) throw frozenError(hash, yield* inspect(hash));
  const { base, slot, entry } = yield* findEntry(hash, key);
  if (entry) {
    hash.map.delete(slot);
    hash.buckets.set(
      base,
      (hash.buckets.get(base) ?? []).filter((item) => item !== slot)
    );
    hash.bucketVersion = hash.map.version;
  }
  return entry;
}

export function hashDeleteEntry(hash: RHash, slot: string, target: HashEntry): void {
  if (hash.map.get(slot) !== target) return;
  hash.map.delete(slot);
  hash.bucketVersion = -1;
}

/** Iterates over a snapshot of the entries, marking the hash so that adding keys meanwhile is an error. */
export function* eachEntry(hash: RHash, visit: (entry: HashEntry, slot: string) => Gen<void>): Gen<void> {
  hash.iterating++;
  try {
    for (const [slot, entry] of snapshot(hash.map)) {
      if (hash.map.get(slot) !== entry) continue;
      yield* visit(entry, slot);
    }
  } finally {
    hash.iterating--;
  }
}

export function* eachEntryUntil(
  hash: RHash,
  predicate: (entry: HashEntry, slot: string) => Gen<boolean>
): Gen<boolean> {
  hash.iterating++;
  try {
    for (const [slot, entry] of hash.map) {
      if (hash.map.get(slot) === entry && (yield* predicate(entry, slot))) return true;
    }
    return false;
  } finally {
    hash.iterating--;
  }
}

/** Rebuilds the slots after keys may have changed, as `rehash` does. */
export function rehash(hash: RHash): void {
  if (hash.iterating > 0) throw runtimeError('rehash during iteration');
  if (hash.frozen) throw frozenError(hash, runToEnd(inspect(hash)));
  const replacement = new RHash(hash.cls);
  replacement.byIdentity = hash.byIdentity;
  const held = rt().held.length;
  rt().held.push(replacement);
  hash.iterating++;
  try {
    for (const entry of hash.map.values()) runToEnd(hashSet(replacement, entry.key, entry.value));
  } finally {
    hash.iterating--;
    rt().held.length = held;
  }
  hash.map = replacement.map;
  hash.buckets = replacement.buckets;
  hash.bucketVersion = replacement.bucketVersion;
}
