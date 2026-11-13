import { inspect } from './conversions';
import { frozenError, runtimeError } from './errors';
import { callMethod, callProc, type Gen, runToEnd } from './interp';
import {
  type HashEntry,
  NIL,
  RArray,
  type RBasic,
  RHash,
  RObject,
  RRange,
  RString,
  RSymbol,
  type Value,
} from './objects';
import { rt } from './runtime';
import { classOf, snapshot, str, truthy } from './values';

/**
 * The key a Hash files a value under: equal for keys that are `eql?`, computed without calling the program's methods
 * unless its objects define `hash`.
 */
// code-gauge-allow functionCognitiveComplexity 23 -- Each language wires its own parser and runtime into the shared modules alike.
// code-gauge-allow functionNcss 34 -- Each language wires its own parser and runtime into the shared modules alike.
export function* hashKeyOf(value: Value): Gen<string> {
  switch (typeof value) {
    case 'bigint': {
      return `i${value}`;
    }
    case 'number': {
      return Object.is(value, -0) ? 'f0' : `f${value}`;
    }
    case 'boolean': {
      return value ? 'T' : 'F';
    }
  }
  if (value === NIL) return 'N';
  if (value instanceof RSymbol) return `y${value.name}`;
  if (value instanceof RString) return `s${value.s}`;
  if (value instanceof RArray) {
    const parts: string[] = [];
    for (const item of value.items) parts.push(yield* hashKeyOf(item));
    return `a[${parts.join(',')}]`;
  }
  if (value instanceof RRange) {
    return `r${yield* hashKeyOf(value.begin)}${value.exclusive ? '...' : '..'}${yield* hashKeyOf(value.end)}`;
  }
  if (value instanceof RHash) {
    const parts: string[] = [];
    for (const entry of value.map.values()) {
      parts.push(`${yield* hashKeyOf(entry.key)}=>${yield* hashKeyOf(entry.value)}`);
    }
    return `h{${parts.toSorted().join(',')}}`;
  }
  const method = classOf(value).findMethod('hash');
  if (method && method.body.kind === 'user') {
    const hash = yield* callMethod(value, 'hash', []);
    return `u${typeof hash === 'bigint' ? hash : yield* hashKeyOf(hash)}`;
  }
  const custom = value instanceof RObject ? (value.data as { hashKey?: () => string; hashParts?: () => Value[] } | undefined) : undefined;
  if (custom?.hashKey) return custom.hashKey();
  if (custom?.hashParts) {
    const parts: string[] = [];
    for (const part of custom.hashParts()) parts.push(yield* hashKeyOf(part));
    return `c${(value as RObject).cls.id}[${parts.join(',')}]`;
  }
  return `o${(value as RBasic).id}`;
}

/** Finds the entry for `key`, comparing keys whose objects define `hash` with their `eql?`. */
function* findEntry(hash: RHash, key: Value): Gen<{ slot: string; entry: HashEntry | undefined }> {
  const base = yield* hashKeyOf(key);
  if (!base.startsWith('u')) return { slot: base, entry: hash.map.get(base) };
  for (let index = 0; ; index++) {
    const slot = index === 0 ? base : `${base}#${index}`;
    const entry = hash.map.get(slot);
    if (!entry) return { slot, entry: undefined };
    if (entry.key === key || truthy(yield* callMethod(key, 'eql?', [entry.key]))) return { slot, entry };
  }
}

export function* hashGet(hash: RHash, key: Value): Gen<HashEntry | undefined> {
  return (yield* findEntry(hash, key)).entry;
}

/** The value for `key`, or the hash's default (calling its default block) when it has none. */
export function* hashFetch(hash: RHash, key: Value): Gen {
  const entry = yield* hashGet(hash, key);
  if (entry) return entry.value;
  return yield* hashDefault(hash, key);
}

export function* hashDefault(hash: RHash, key: Value): Gen {
  if (hash.defaultProc) return yield* callProc(hash.defaultProc, [hash, key]);
  return hash.defaultValue;
}

export function* hashSet(hash: RHash, key: Value, value: Value): Gen<void> {
  if (hash.frozen) throw frozenError(hash, yield* inspect(hash));
  const { slot, entry } = yield* findEntry(hash, key);
  if (entry) {
    entry.value = value;
    return;
  }
  if (hash.iterating > 0) throw runtimeError("can't add a new key into hash during iteration");
  rt().spend();
  const stored = key instanceof RString && !key.frozen ? frozenCopy(key) : key;
  hash.map.set(slot, { key: stored, value });
}

function frozenCopy(key: RString): RString {
  const copy = str(key.s);
  copy.frozen = true;
  return copy;
}

export function* hashDelete(hash: RHash, key: Value): Gen<HashEntry | undefined> {
  if (hash.frozen) throw frozenError(hash, yield* inspect(hash));
  const { slot, entry } = yield* findEntry(hash, key);
  if (entry) hash.map.delete(slot);
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
