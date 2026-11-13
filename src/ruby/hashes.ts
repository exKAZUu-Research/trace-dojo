import { inspect } from './conversions';
import { frozenError, runtimeError } from './errors';
import { callMethod, callProc, type Gen, runToEnd } from './interp';
import { type HashEntry, NIL, RArray, RBasic, RHash, RObject, RRange, RString, RSymbol, type Value } from './objects';
import { rt } from './runtime';
import { classOf, snapshot, str, truthy } from './values';

/**
 * The key a Hash files a value under: equal for keys that are `eql?`, computed without calling the program's methods
 * unless its objects define `hash`.
 */
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
    return 'recursive';
  }
  const method = classOf(value).findMethod('hash');
  if (method && method.body.kind === 'user') {
    if (value instanceof RBasic) ancestors.push(value);
    try {
      const hash = yield* callMethod(value, 'hash', []);
      return `u${digest(typeof hash === 'bigint' ? String(hash) : yield* hashKeyOf(hash, ancestors, cycle, memo))}`;
    } finally {
      if (value instanceof RBasic) ancestors.pop();
    }
  }
  switch (typeof value) {
    case 'bigint': {
      return `i${digest(String(value))}`;
    }
    case 'number': {
      return value === 0 ? 'f0' : `f${digest(String(value))}`;
    }
    case 'boolean': {
      return value ? 'T' : 'F';
    }
  }
  if (value === NIL) return 'N';
  if (value instanceof RSymbol) return `y${digest(value.name)}`;
  if (value instanceof RString) return `s${digest(value.s)}`;
  if (value instanceof RArray || value instanceof RRange || value instanceof RHash) {
    const root = ancestors.length === 0;
    const cached = memo.get(value);
    if (cached) return root && cycle.found ? 'recursive' : cached;
    ancestors.push(value);
    try {
      if (value instanceof RArray) {
        const parts: string[] = [];
        for (const item of value.items) parts.push(yield* hashKeyOf(item, ancestors, cycle, memo));
        const key = `a${digest(JSON.stringify(parts))}`;
        memo.set(value, key);
        return root && cycle.found ? 'recursive' : key;
      }
      if (value instanceof RRange) {
        const encoded = `r${JSON.stringify([
          yield* hashKeyOf(value.begin, ancestors, cycle, memo),
          value.exclusive,
          yield* hashKeyOf(value.end, ancestors, cycle, memo),
        ])}`;
        const key = `r${digest(encoded)}`;
        memo.set(value, key);
        return root && cycle.found ? 'recursive' : key;
      }
      const parts: string[] = [];
      for (const entry of value.map.values()) {
        parts.push(
          JSON.stringify([
            yield* hashKeyOf(entry.key, ancestors, cycle, memo),
            yield* hashKeyOf(entry.value, ancestors, cycle, memo),
          ])
        );
      }
      const key = `h${digest(JSON.stringify(parts.toSorted()))}`;
      memo.set(value, key);
      return root && cycle.found ? 'recursive' : key;
    } finally {
      ancestors.pop();
    }
  }
  const custom = value instanceof RObject ? (value.data as { hashKey?: () => string } | undefined) : undefined;
  if (custom?.hashKey) return custom.hashKey();
  return `o${(value as RBasic).id}`;
}

function digest(text: string): string {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index++)
    value = Math.imul(value ^ (text.codePointAt(index) as number), 16_777_619);
  return (value >>> 0).toString(16);
}

/** Finds the entry for `key`, checking equality even when distinct keys have the same hash. */
function* findEntry(hash: RHash, key: Value): Gen<{ base: string; slot: string; entry: HashEntry | undefined }> {
  const base = yield* hashKeyOf(key);
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

export function* hashSet(hash: RHash, key: Value, value: Value): Gen<void> {
  if (hash.frozen) throw frozenError(hash, yield* inspect(hash));
  const { base, slot, entry } = yield* findEntry(hash, key);
  if (entry) {
    entry.value = value;
    return;
  }
  if (hash.iterating > 0) throw runtimeError("can't add a new key into hash during iteration");
  rt().chargeSlots(1);
  rt().spend();
  const stored = key instanceof RString && !key.frozen ? frozenCopy(key) : key;
  hash.map.set(slot, { key: stored, value });
  const bucket = hash.buckets.get(base) ?? [];
  bucket.push(slot);
  hash.buckets.set(base, bucket);
  hash.bucketVersion = hash.map.version;
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

/** Iterates over a snapshot of the entries, marking the hash so that adding keys meanwhile is an error. */
export function* eachEntry(hash: RHash, visit: (entry: HashEntry) => Gen<void>): Gen<void> {
  hash.iterating++;
  try {
    for (const [slot, entry] of snapshot(hash.map)) {
      if (hash.map.get(slot) !== entry) continue;
      yield* visit(entry);
    }
  } finally {
    hash.iterating--;
  }
}

/** Rebuilds the slots after keys may have changed, as `rehash` does. */
export function rehash(hash: RHash): void {
  const entries = [...hash.map.values()];
  hash.map.clear();
  for (const entry of entries) runToEnd(hashSet(hash, entry.key, entry.value));
}
