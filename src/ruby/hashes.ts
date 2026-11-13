import { inspect, toInt } from './conversions';
import { frozenError, runtimeError } from './errors';
import { callMethod, callProc, type Gen, runToEnd } from './interp';
import { type HashEntry, RArray, RBasic, RHash, RRange, RString, type Value } from './objects';
import { rt } from './runtime';
import { classOf, snapshot, str, truthy } from './values';

/** A bounded structural digest for container hash methods, based on each child's public hash. */
// code-gauge-allow functionCognitiveComplexity 23 -- Hash keys have distinct primitive, composite, and user-defined hash rules.
// code-gauge-allow functionNcss 34 -- Hash keys have distinct primitive, composite, and user-defined hash rules.
export function* hashKeyOf(
  value: Value,
  ancestors: RBasic[] = [],
  cycle?: { found: boolean },
  memo?: WeakMap<RBasic, string>
): Gen<string> {
  cycle ??= { found: false };
  memo ??= new WeakMap();
  rt().spend();
  if (value instanceof RBasic && ancestors.includes(value)) {
    cycle.found = true;
    return 'cycle';
  }
  const method = classOf(value).findMethod('hash');
  if (method && method.body.kind === 'user') {
    const hash = yield* callMethod(value, 'hash', []);
    return digest(String(yield* toInt(hash)));
  }
  if (value instanceof RArray || value instanceof RRange || value instanceof RHash) {
    const cached = memo.get(value);
    if (cached) return cached;
    ancestors.push(value);
    try {
      const hash = yield* structuralHash(value, ancestors, cycle, memo);
      const key = digest(String(cycle.found ? 0n : hash));
      memo.set(value, key);
      return key;
    } finally {
      ancestors.pop();
    }
  }
  return digest(String(yield* toInt(yield* callMethod(value, 'hash', []))));
}

export function* structuralHashValue(value: RArray | RRange | RHash): Gen<bigint> {
  const cycle = { found: false };
  const hash = yield* structuralHash(value, [value], cycle, new WeakMap());
  return cycle.found ? 0n : hash;
}

function* structuralHash(
  value: RArray | RRange | RHash,
  ancestors: RBasic[],
  cycle: { found: boolean },
  memo: WeakMap<RBasic, string>
): Gen<bigint> {
  let parts: string[];
  if (value instanceof RArray) {
    parts = [];
    for (const item of value.items) parts.push(yield* hashKeyOf(item, ancestors, cycle, memo));
  } else if (value instanceof RRange) {
    parts = [
      yield* hashKeyOf(value.begin, ancestors, cycle, memo),
      value.exclusive ? 'exclusive' : 'inclusive',
      yield* hashKeyOf(value.end, ancestors, cycle, memo),
    ];
  } else {
    parts = [];
    for (const entry of value.map.values())
      parts.push(
        JSON.stringify([
          yield* hashKeyOf(entry.key, ancestors, cycle, memo),
          yield* hashKeyOf(entry.value, ancestors, cycle, memo),
        ])
      );
    parts.sort();
  }
  return BigInt(`0x${digest(JSON.stringify(parts))}`);
}

function digest(text: string): string {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index++)
    value = Math.imul(value ^ (text.codePointAt(index) as number), 16_777_619);
  return (value >>> 0).toString(16);
}

/** Finds the entry for `key`, checking equality even when distinct keys have the same hash. */
function* findEntry(hash: RHash, key: Value): Gen<{ base: string; slot: string; entry: HashEntry | undefined }> {
  const base = `h${digest(String(yield* toInt(yield* callMethod(key, 'hash', []))))}`;
  if (hash.bucketVersion !== hash.map.version) rebuildBuckets(hash);
  for (const slot of hash.buckets.get(base) ?? []) {
    const entry = hash.map.get(slot);
    if (entry && (entry.key === key || truthy(yield* callMethod(key, 'eql?', [entry.key]))))
      return { base, slot, entry };
  }
  for (let index = 0; ; index++) {
    const slot = JSON.stringify([base, index]);
    if (!hash.map.has(slot)) return { base, slot, entry: undefined };
  }
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
  const held = rt().held.length;
  rt().held.push(hash, key, value);
  try {
    if (hash.frozen) throw frozenError(hash, yield* inspect(hash));
    const { base, slot, entry } = yield* findEntry(hash, key);
    if (entry) {
      entry.value = value;
      return true;
    }
    if (hash.iterating > 0) throw runtimeError(hash.iterationError ?? "can't add a new key into hash during iteration");
    rt().chargeSlots(1);
    rt().spend();
    const stored = key instanceof RString && key.cls === rt().c.String && !key.frozen ? frozenCopy(key) : key;
    hash.map.set(slot, { key: stored, value });
    const bucket = hash.buckets.get(base) ?? [];
    bucket.push(slot);
    hash.buckets.set(base, bucket);
    hash.bucketVersion = hash.map.version;
    return false;
  } finally {
    rt().held.length = held;
  }
}

function frozenCopy(key: RString): RString {
  const copy = str(key.s);
  copy.binary = key.binary;
  copy.rawBytes = key.rawBytes ? Uint8Array.from(key.rawBytes) : undefined;
  copy.frozen = true;
  return copy;
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

/** Rebuilds the slots after keys may have changed, as `rehash` does. */
export function rehash(hash: RHash): void {
  if (hash.iterating > 0) throw runtimeError('rehash during iteration');
  if (hash.frozen) throw frozenError(hash, runToEnd(inspect(hash)));
  const replacement = new RHash(hash.cls);
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
