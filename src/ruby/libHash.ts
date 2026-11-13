import { inspect, inspectHash, rEql, rEquals } from './conversions';
import { def, sdef } from './define';
import { argumentError, frozenError, implicitConversionError, rubyError, typeError } from './errors';
import { eachEntry, hashDefault, hashDelete, hashFetch, hashGet, hashSet, rehash, structuralHashValue } from './hashes';
import { callBlock, callMethod, callProc, type Gen, nativeProc, respondsTo } from './interp';
import { tryAry } from './libArray';
import { sum } from './libEnumerable';
import { makeEnumerator, sizedEnumerator } from './libEnumerator';
import { NIL, RArray, RHash, RProc, RSymbol, type Value } from './objects';
import { rt, UnsupportedFeatureError, whileHeld } from './runtime';
import { arr, newHash, realClassOf, snapshot, str, truthy } from './values';

function* modify(self: RHash): Gen<void> {
  if (self.frozen) throw frozenError(self, yield* inspectHash(self));
}

function* toHash(value: Value): Gen<RHash> {
  if (value instanceof RHash) return value;
  if (respondsTo(value, 'to_hash', true)) {
    const converted = yield* callMethod(value, 'to_hash', [], undefined, undefined, { fcall: true });
    if (converted instanceof RHash) return converted;
  }
  throw implicitConversionError(value, 'Hash');
}

/** Calls a block with a key and a value, as Hash's iterators yield them. */
function pair(block: RProc, key: Value, value: Value, used = true): Gen {
  return callBlock(block, [arr([key, value])], used);
}

def(
  'Hash',
  'initialize',
  [0, 1],
  function* (self: RHash, args, block, keywords) {
    if (keywords) {
      for (const entry of keywords.map.values()) {
        if (!(entry.key instanceof RSymbol) || entry.key.name !== 'capacity') {
          throw argumentError(`unknown keyword: ${yield* inspect(entry.key)}`);
        }
      }
    }
    if (block) {
      if (args.length > 0) throw argumentError('wrong number of arguments (given 1, expected 0)');
      self.defaultProc = block;
    } else if (args.length > 0) {
      self.defaultValue = args[0];
    }
    return NIL;
  },
  { visibility: 'private', keywords: true }
);
// code-gauge-allow functionCognitiveComplexity 18 -- Hash.[] accepts alternating key/value arguments or one pair collection and validates both forms.
sdef('Hash', '[]', [0, -1], function* (self, args) {
  const hash = new RHash(self);
  const source = args.length === 1 ? yield* hashLiteralSource(args[0]) : undefined;
  if (source instanceof RHash) {
    for (const entry of source.map.values()) yield* hashSet(hash, entry.key, entry.value);
    return hash;
  }
  if (source instanceof RArray) {
    for (const item of source.items) {
      const pair = yield* tryAry(item);
      if (!pair || pair.items.length === 0 || pair.items.length > 2) {
        throw argumentError(`invalid number of elements (${pair ? pair.items.length : 1} for 1..2)`);
      }
      yield* hashSet(hash, pair.items[0], pair.items[1] ?? NIL);
    }
    return hash;
  }
  if (args.length % 2 !== 0) throw argumentError('odd number of arguments for Hash');
  for (let index = 0; index < args.length; index += 2) yield* hashSet(hash, args[index], args[index + 1]);
  return hash;
});

function* hashLiteralSource(value: Value): Gen<RHash | RArray | undefined> {
  if (value instanceof RHash || value instanceof RArray) return value;
  if (respondsTo(value, 'to_hash', true)) {
    const converted = yield* callMethod(value, 'to_hash', [], undefined, undefined, { fcall: true });
    if (converted instanceof RHash) return converted;
    if (converted !== NIL)
      throw typeError(
        `can't convert ${realClassOf(value).name} to Hash (${realClassOf(value).name}#to_hash gives ${realClassOf(converted).name})`
      );
  }
  if (respondsTo(value, 'to_ary', true)) {
    const converted = yield* callMethod(value, 'to_ary', [], undefined, undefined, { fcall: true });
    if (converted instanceof RArray) return converted;
    if (converted !== NIL)
      throw typeError(
        `can't convert ${realClassOf(value).name} to Array (${realClassOf(value).name}#to_ary gives ${realClassOf(converted).name})`
      );
  }
  return undefined;
}

def('Hash', '[]', 1, (self: RHash, [key]) => hashFetch(self, key));
def('Hash', ['[]=', 'store'], 2, function* (self: RHash, [key, value]) {
  yield* hashSet(self, key, value);
  return value;
});
def('Hash', 'fetch', [1, 2], function* (self: RHash, args, block) {
  const entry = yield* hashGet(self, args[0]);
  if (entry) return entry.value;
  if (block) return yield* callBlock(block, [args[0]]);
  if (args.length > 1) return args[1];
  const error = rubyError(rt().c.KeyError, `key not found: ${yield* inspect(args[0])}`);
  error.exception.ivars = new Map([
    ['@__key', args[0]],
    ['@__receiver', self],
  ]);
  throw error;
});
def('Hash', ['key?', 'has_key?', 'include?', 'member?'], 1, function* (self: RHash, [key]) {
  return (yield* hashGet(self, key)) !== undefined;
});
def('Hash', ['value?', 'has_value?'], 1, function* (self: RHash, [value]) {
  for (const entry of self.map.values()) if (yield* rEquals(entry.value, value)) return true;
  return false;
});
def('Hash', 'key', 1, function* (self: RHash, [value]) {
  for (const entry of self.map.values()) if (yield* rEquals(entry.value, value)) return entry.key;
  return NIL;
});
def('Hash', 'keys', 0, (self: RHash) => arr([...self.map.values()].map((entry) => entry.key)));
def('Hash', 'values', 0, (self: RHash) => arr([...self.map.values()].map((entry) => entry.value)));
def('Hash', 'values_at', [0, -1], function* (self: RHash, keys) {
  const values: Value[] = [];
  for (const key of keys) values.push(yield* hashFetch(self, key));
  return arr(values);
});
def('Hash', 'fetch_values', [0, -1], function* (self: RHash, keys, block) {
  const values: Value[] = [];
  for (const key of keys) values.push(yield* callMethod(self, 'fetch', [key], undefined, block));
  return arr(values);
});
def('Hash', ['length', 'size'], 0, (self: RHash) => BigInt(self.map.size));
def('Hash', 'empty?', 0, (self: RHash) => self.map.size === 0);
def('Hash', ['to_s', 'inspect'], 0, function* (self: RHash) {
  return str(yield* inspectHash(self));
});
def('Hash', 'to_h', 0, function* (self: RHash, _args, block) {
  if (!block) return self.cls === rt().c.Hash ? self : yield* copy(self);
  const hash = newHash();
  yield* eachEntry(self, function* (entry) {
    const result = yield* pair(block, entry.key, entry.value);
    const converted = yield* tryAry(result);
    if (!converted || converted.items.length !== 2) {
      throw argumentError(`element has wrong array length (expected 2, was ${converted ? converted.items.length : 1})`);
    }
    yield* hashSet(hash, converted.items[0], converted.items[1]);
  });
  return hash;
});
def('Hash', 'to_hash', 0, (self) => self);
def('Hash', 'to_a', 0, (self: RHash) => arr([...self.map.values()].map((entry) => arr([entry.key, entry.value]))));
def('Hash', '==', 1, (self: RHash, [other]) => rEquals(self, other));
def('Hash', 'eql?', 1, function* (self: RHash, [other]) {
  if (!(other instanceof RHash) || self.map.size !== other.map.size) return false;
  for (const entry of self.map.values()) {
    const match = yield* hashGet(other, entry.key);
    if (!match || !(yield* rEql(entry.value, match.value))) return false;
  }
  return true;
});
def('Hash', 'default', [0, 1], function* (self: RHash, args) {
  if (args.length > 0 && self.defaultProc) return yield* hashDefault(self, args[0]);
  return self.defaultValue;
});
def('Hash', 'default=', 1, function* (self: RHash, [value]) {
  yield* modify(self);
  self.defaultValue = value;
  self.defaultProc = undefined;
  return value;
});
def('Hash', 'default_proc', 0, (self: RHash) => self.defaultProc ?? NIL);

function* copy(self: RHash): Gen<RHash> {
  const hash = newHash();
  hash.defaultValue = self.defaultValue;
  hash.defaultProc = self.defaultProc;
  for (const entry of self.map.values()) yield* hashSet(hash, entry.key, entry.value);
  return hash;
}

// Iteration -----------------------------------------------------------------------------------------------------------

def('Hash', ['each', 'each_pair'], 0, function* (self: RHash, _args, block) {
  if (!block) return sizedEnumerator(self, 'each', [], () => BigInt(self.map.size));
  yield* eachEntry(self, (entry) => pair(block, entry.key, entry.value, false) as Gen<never>);
  return self;
});
def('Hash', 'each_key', 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'each_key', []);
  yield* eachEntry(self, (entry) => callBlock(block, [entry.key], false) as Gen<never>);
  return self;
});
def('Hash', 'each_value', 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'each_value', []);
  yield* eachEntry(self, (entry) => callBlock(block, [entry.value], false) as Gen<never>);
  return self;
});

function* filtered(self: RHash, block: RProc, keep: boolean): Gen<RHash> {
  const hash = newHash();
  yield* eachEntry(self, function* (entry) {
    if (truthy(yield* pair(block, entry.key, entry.value)) === keep) yield* hashSet(hash, entry.key, entry.value);
  });
  return hash;
}

function* filterInPlace(self: RHash, block: RProc, keep: boolean): Gen<boolean> {
  yield* modify(self);
  let changed = false;
  self.iterating++;
  try {
    for (const [slot, entry] of snapshot(self.map)) {
      if (self.map.get(slot) !== entry) continue;
      if (truthy(yield* pair(block, entry.key, entry.value)) !== keep) {
        self.map.delete(slot);
        changed = true;
      }
    }
  } finally {
    self.iterating--;
  }
  return changed;
}

def('Hash', ['select', 'filter'], 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'select', []);
  return yield* filtered(self, block, true);
});
def('Hash', 'reject', 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'reject', []);
  return yield* filtered(self, block, false);
});
def('Hash', ['select!', 'filter!'], 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'select!', []);
  return (yield* filterInPlace(self, block, true)) ? self : NIL;
});
def('Hash', 'keep_if', 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'keep_if', []);
  yield* filterInPlace(self, block, true);
  return self;
});
def('Hash', 'reject!', 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'reject!', []);
  return (yield* filterInPlace(self, block, false)) ? self : NIL;
});
def('Hash', 'delete_if', 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'delete_if', []);
  yield* filterInPlace(self, block, false);
  return self;
});
def('Hash', 'delete', 1, function* (self: RHash, [key], block) {
  const entry = yield* hashDelete(self, key);
  if (entry) return entry.value;
  return block ? yield* callBlock(block, [key]) : NIL;
});
def('Hash', 'clear', 0, function* (self: RHash) {
  yield* modify(self);
  self.map.clear();
  return self;
});
def('Hash', 'replace', 1, function* (self: RHash, [other]) {
  yield* modify(self);
  const source = yield* toHash(other);
  const entries = [...source.map.values()];
  self.map.clear();
  for (const entry of entries) yield* hashSet(self, entry.key, entry.value);
  self.defaultValue = source.defaultValue;
  self.defaultProc = source.defaultProc;
  return self;
});
def('Hash', 'shift', 0, function* (self: RHash) {
  yield* modify(self);
  const first = self.map.entries().next();
  if (first.done) return NIL;
  self.map.delete(first.value[0]);
  return arr([first.value[1].key, first.value[1].value]);
});
def('Hash', 'assoc', 1, function* (self: RHash, [key]) {
  for (const entry of snapshot(self.map.values()))
    if (yield* rEquals(entry.key, key)) return arr([entry.key, entry.value]);
  return NIL;
});
def('Hash', 'rassoc', 1, function* (self: RHash, [value]) {
  for (const entry of snapshot(self.map.values()))
    if (yield* rEquals(entry.value, value)) return arr([entry.key, entry.value]);
  return NIL;
});
def('Hash', 'flatten', [0, 1], function* (self: RHash, args) {
  const pairs = arr(snapshot(self.map.values()).map((entry) => arr([entry.key, entry.value])));
  const depth = args.length > 0 ? args[0] : 1n;
  return yield* callMethod(pairs, 'flatten', [depth]);
});
def('Hash', 'to_proc', 0, (self: RHash) => {
  const proc = nativeProc(1, ([key]) => hashFetch(self, key), true);
  proc.captured = [self];
  return proc;
});

function* merge(target: RHash, others: Value[], block: RProc | undefined): Gen<RHash> {
  for (const other of others) {
    const source = yield* toHash(other);
    for (const entry of snapshot(source.map.values())) {
      const existing = block ? yield* hashGet(target, entry.key) : undefined;
      const value = existing && block ? yield* callBlock(block, [entry.key, existing.value, entry.value]) : entry.value;
      yield* hashSet(target, entry.key, value);
    }
  }
  return target;
}

def('Hash', 'merge', [0, -1], function* (self: RHash, others, block) {
  const result = yield* copy(self);
  result.defaultValue = self.defaultValue;
  result.defaultProc = self.defaultProc;
  return yield* merge(result, others, block);
});
def('Hash', ['merge!', 'update'], [0, -1], function* (self: RHash, others, block) {
  yield* modify(self);
  return yield* merge(self, others, block);
});
def('Hash', 'transform_values', 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'transform_values', []);
  const hash = newHash();
  yield* whileHeld(hash, () =>
    eachEntry(self, function* (entry) {
      yield* hashSet(hash, entry.key, yield* callBlock(block, [entry.value]));
    })
  );
  return hash;
});
def('Hash', 'transform_values!', 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'transform_values!', []);
  yield* modify(self);
  yield* eachEntry(self, function* (entry) {
    entry.value = yield* callBlock(block, [entry.value]);
  });
  return self;
});

function* transformKeys(self: RHash, args: Value[], block: RProc | undefined): Gen<RHash> {
  const mapping = args.length > 0 ? yield* toHash(args[0]) : undefined;
  const hash = newHash();
  yield* whileHeld(hash, () =>
    eachEntry(self, function* (entry) {
      const mapped = mapping ? yield* hashGet(mapping, entry.key) : undefined;
      const key = mapped ? mapped.value : block ? yield* callBlock(block, [entry.key]) : entry.key;
      yield* hashSet(hash, key, entry.value);
    })
  );
  return hash;
}

def('Hash', 'transform_keys', [0, 1], function* (self: RHash, args, block) {
  if (!block && args.length === 0) return makeEnumerator(self, 'transform_keys', []);
  return yield* transformKeys(self, args, block);
});
def('Hash', 'transform_keys!', [0, 1], function* (self: RHash, args, block) {
  if (!block && args.length === 0) return makeEnumerator(self, 'transform_keys!', []);
  yield* modify(self);
  const result = yield* transformKeys(self, args, block);
  self.map = result.map;
  self.bucketVersion = -1;
  return self;
});
def('Hash', 'invert', 0, function* (self: RHash) {
  const hash = newHash();
  for (const entry of self.map.values()) yield* hashSet(hash, entry.value, entry.key);
  return hash;
});
def('Hash', 'slice', [0, -1], function* (self: RHash, keys) {
  const hash = newHash();
  for (const key of keys) {
    const entry = yield* hashGet(self, key);
    if (entry) yield* hashSet(hash, entry.key, entry.value);
  }
  return hash;
});
def('Hash', 'except', [0, -1], function* (self: RHash, keys) {
  const hash = yield* copy(self);
  hash.defaultValue = NIL;
  hash.defaultProc = undefined;
  for (const key of keys) yield* hashDelete(hash, key);
  return hash;
});
def('Hash', 'filter_map', 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'filter_map', []);
  const results: Value[] = [];
  yield* eachEntry(self, function* (entry) {
    const value = yield* pair(block, entry.key, entry.value);
    if (truthy(value)) results.push(value);
  });
  return arr(results);
});
def('Hash', 'compact', 0, function* (self: RHash) {
  const hash = new RHash(self.cls);
  hash.defaultValue = self.defaultValue;
  hash.defaultProc = self.defaultProc;
  for (const entry of self.map.values()) if (entry.value !== NIL) yield* hashSet(hash, entry.key, entry.value);
  return hash;
});
def('Hash', 'compact!', 0, function* (self: RHash) {
  yield* modify(self);
  let changed = false;
  for (const [slot, entry] of snapshot(self.map)) {
    if (entry.value === NIL) {
      self.map.delete(slot);
      changed = true;
    }
  }
  return changed ? self : NIL;
});
def('Hash', 'dig', [1, -1], function* (self: RHash, args) {
  const value = yield* hashFetch(self, args[0]);
  if (args.length === 1 || value === NIL) return value;
  return yield* callMethod(value, 'dig', args.slice(1));
});
def('Hash', 'any?', [0, 1], function* (self: RHash, args, block) {
  let found = false;
  if (args.length > 0) {
    yield* eachEntry(self, function* (entry) {
      if (!found && truthy(yield* callMethod(args[0], '===', [arr([entry.key, entry.value])]))) found = true;
    });
    return found;
  }
  if (!block) return self.map.size > 0;
  yield* eachEntry(self, function* (entry) {
    if (!found && truthy(yield* pair(block, entry.key, entry.value))) found = true;
  });
  return found;
});
def('Hash', 'count', [0, 1], function* (self: RHash, args, block) {
  if (args.length === 0 && !block) return BigInt(self.map.size);
  let count = 0n;
  yield* eachEntry(self, function* (entry) {
    const item = arr([entry.key, entry.value]);
    if (args.length > 0 ? yield* rEquals(item, args[0]) : truthy(yield* callBlock(block as RProc, [item]))) count++;
  });
  return count;
});
def('Hash', 'sum', [0, 1], function* (self: RHash, args, block) {
  return yield* sum(self, args, block);
});

def('Hash', 'hash', 0, (self: RHash) => structuralHashValue(self));
def('Hash', 'rehash', 0, (self: RHash) => {
  rehash(self);
  return self;
});
def('Hash', ['compare_by_identity'], 0, () => {
  throw new UnsupportedFeatureError('compare_by_identity');
});
def('Hash', 'default_proc=', 1, function* (self: RHash, [proc]) {
  yield* modify(self);
  if (proc === NIL) {
    self.defaultProc = undefined;
    return proc;
  }
  const converted =
    proc instanceof RProc ? proc : respondsTo(proc, 'to_proc') ? yield* callMethod(proc, 'to_proc', []) : proc;
  if (!(converted instanceof RProc))
    throw typeError(`wrong default_proc type ${realClassOf(proc).name} (expected Proc)`);
  if (converted.isLambda) {
    const body = converted.body;
    const params = body.kind === 'block' ? body.def.params : undefined;
    const min = params ? params.required.length + params.post.length : body.kind === 'native' ? body.arity : 0;
    const max =
      params && params.rest === undefined
        ? min + params.optional.length
        : body.kind === 'native'
          ? body.arity
          : Infinity;
    if (min > 2 || max < 2) throw typeError(`default_proc takes two arguments (2 for ${min})`);
  }
  self.defaultProc = converted;
  return proc;
});
def('Hash', 'group_by', 0, function* (self: RHash, _args, block) {
  if (!block) return makeEnumerator(self, 'group_by', []);
  const groups = newHash();
  yield* whileHeld(groups, () =>
    eachEntry(self, function* (entry) {
      const item = arr([entry.key, entry.value]);
      const key = yield* callBlock(block, [item]);
      const existing = yield* hashGet(groups, key);
      if (existing) {
        rt().chargeSlots(1);
        (existing.value as RArray).items.push(item);
      } else yield* hashSet(groups, key, arr([item]));
    })
  );
  return groups;
});

export { callProc };
