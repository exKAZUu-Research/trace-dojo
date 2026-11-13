import { inspect, rEquals } from './conversions';
import { def, sdef } from './define';
import { frozenError, typeError } from './errors';
import { eachEntry, hashDelete, hashDeleteEntry, hashGet, hashSet } from './hashes';
import { callBlock, type Gen } from './interp';
import { iterate, toArray } from './libEnumerable';
import { makeEnumerator } from './libEnumerator';
import { NIL, type RHash, RObject, type Value } from './objects';
import { rt } from './runtime';
import { arr, newHash, str, truthy } from './values';

/** A Set keeps its members as the keys of a Hash, which gives it the Hash's insertion order and equality. */
class SetData {
  constructor(readonly members: RHash) {
    members.iterationError = "can't add a new item into set during iteration";
  }

  held(): Value[] {
    return [this.members];
  }

  copy(): SetData {
    const members = newHash();
    for (const [slot, entry] of this.members.map) members.map.set(slot, { ...entry });
    return new SetData(members);
  }

  /** Two sets are `eql?` when they hold equal members, whatever their order. */
  hashKey(): string {
    return `set{${[...this.members.map.keys()].toSorted().join(',')}}`;
  }
}

function membersOf(set: RObject): RHash {
  return (set.data as SetData).members;
}

export function newSet(values: Iterable<Value>): Gen<RObject> {
  return (function* () {
    const set = new RObject(rt().c.Set);
    set.data = new SetData(newHash());
    for (const value of values) yield* hashSet(membersOf(set), value, true);
    return set;
  })();
}

function* modify(self: RObject): Gen<void> {
  if (self.frozen) throw frozenError(self, yield* inspectSet(self));
}

function* inspectSet(self: RObject): Gen<string> {
  const parts: string[] = [];
  for (const entry of membersOf(self).map.values()) parts.push(yield* inspect(entry.key));
  return `Set[${parts.join(', ')}]`;
}

function* other(value: Value): Gen<Value[]> {
  if (value instanceof RObject && value.data instanceof SetData)
    return [...membersOf(value).map.values()].map((e) => e.key);
  if (value === NIL || typeof value !== 'object') throw typeError('value must be enumerable');
  return yield* toArray(value);
}

def(
  'Set',
  'initialize',
  [0, 1],
  function* (self: RObject, args, block) {
    self.data = new SetData(newHash());
    if (args.length > 0 && args[0] !== NIL) {
      for (const value of yield* toArray(args[0])) {
        yield* hashSet(membersOf(self), block ? yield* callBlock(block, [value]) : value, true);
      }
    }
    return NIL;
  },
  { visibility: 'private' }
);
sdef('Set', '[]', [0, -1], (_self, args) => newSet(args));
def('Set', 'each', 0, function* (self: RObject, _args, block) {
  if (!block) return makeEnumerator(self, 'each', []);
  yield* eachEntry(membersOf(self), function* (entry) {
    yield* callBlock(block, [entry.key], false);
  });
  return self;
});
def('Set', ['add', '<<'], 1, function* (self: RObject, [value]) {
  yield* modify(self);
  yield* hashSet(membersOf(self), value, true);
  return self;
});
def('Set', 'add?', 1, function* (self: RObject, [value]) {
  yield* modify(self);
  if (yield* hashGet(membersOf(self), value)) return NIL;
  yield* hashSet(membersOf(self), value, true);
  return self;
});
def('Set', 'delete', 1, function* (self: RObject, [value]) {
  yield* modify(self);
  yield* hashDelete(membersOf(self), value);
  return self;
});
def('Set', 'delete?', 1, function* (self: RObject, [value]) {
  yield* modify(self);
  return (yield* hashDelete(membersOf(self), value)) ? self : NIL;
});
def('Set', ['include?', 'member?', '===', 'contain?'], 1, function* (self: RObject, [value]) {
  return (yield* hashGet(membersOf(self), value)) !== undefined;
});
def('Set', ['size', 'length', 'count'], [0, 1], function* (self: RObject, args, block) {
  if (args.length === 0 && !block) return BigInt(membersOf(self).map.size);
  let count = 0n;
  yield* eachEntry(membersOf(self), function* (entry) {
    if (args.length > 0 ? yield* rEquals(entry.key, args[0]) : truthy(yield* callBlock(block!, [entry.key]))) count++;
  });
  return count;
});
def('Set', 'empty?', 0, (self: RObject) => membersOf(self).map.size === 0);
def('Set', 'to_a', 0, (self: RObject) => arr([...membersOf(self).map.values()].map((entry) => entry.key)));
def('Set', 'to_set', 0, (self) => self);
def('Set', ['inspect', 'to_s'], 0, function* (self: RObject) {
  return str(yield* inspectSet(self));
});
def('Set', ['|', 'union', '+'], 1, function* (self: RObject, [value]) {
  return yield* newSet([...[...membersOf(self).map.values()].map((e) => e.key), ...(yield* other(value))]);
});
def('Set', ['&', 'intersection'], 1, function* (self: RObject, [value]) {
  const right = yield* newSet(yield* other(value));
  const kept: Value[] = [];
  for (const entry of membersOf(self).map.values())
    if (yield* hashGet(membersOf(right), entry.key)) kept.push(entry.key);
  return yield* newSet(kept);
});
def('Set', ['-', 'difference'], 1, function* (self: RObject, [value]) {
  const right = yield* newSet(yield* other(value));
  const kept: Value[] = [];
  for (const entry of membersOf(self).map.values())
    if (!(yield* hashGet(membersOf(right), entry.key))) kept.push(entry.key);
  return yield* newSet(kept);
});
def('Set', '^', 1, function* (self: RObject, [value]) {
  const right = yield* newSet(yield* other(value));
  const union = [
    ...[...membersOf(self).map.values()].map((e) => e.key),
    ...[...membersOf(right).map.values()].map((e) => e.key),
  ];
  const kept: Value[] = [];
  for (const item of (yield* newSet(union)) === undefined
    ? []
    : [...membersOf(yield* newSet(union)).map.values()].map((e) => e.key)) {
    const inLeft = (yield* hashGet(membersOf(self), item)) !== undefined;
    const inRight = (yield* hashGet(membersOf(right), item)) !== undefined;
    if (inLeft !== inRight) kept.push(item);
  }
  return yield* newSet(kept);
});

function* subset(small: RObject, large: RObject): Gen<boolean> {
  for (const entry of membersOf(small).map.values()) if (!(yield* hashGet(membersOf(large), entry.key))) return false;
  return true;
}

function setArg(value: Value): RObject {
  if (value instanceof RObject && value.data instanceof SetData) return value;
  throw typeError('value must be a set');
}

def('Set', ['subset?', '<='], 1, (self: RObject, [value]) => subset(self, setArg(value)));
def('Set', ['superset?', '>='], 1, (self: RObject, [value]) => subset(setArg(value), self));
def('Set', 'proper_subset?', 1, function* (self: RObject, [value]) {
  const large = setArg(value);
  return membersOf(self).map.size < membersOf(large).map.size && (yield* subset(self, large));
});
def('Set', '<', 1, function* (self: RObject, [value]) {
  const large = setArg(value);
  return membersOf(self).map.size < membersOf(large).map.size && (yield* subset(self, large));
});
def('Set', ['proper_superset?', '>'], 1, function* (self: RObject, [value]) {
  const small = setArg(value);
  return membersOf(small).map.size < membersOf(self).map.size && (yield* subset(small, self));
});
def('Set', 'disjoint?', 1, function* (self: RObject, [value]) {
  for (const item of yield* other(value)) if (yield* hashGet(membersOf(self), item)) return false;
  return true;
});
def('Set', 'intersect?', 1, function* (self: RObject, [value]) {
  for (const item of yield* other(value)) if (yield* hashGet(membersOf(self), item)) return true;
  return false;
});
def('Set', ['==', 'eql?'], 1, function* (self: RObject, [value]) {
  if (!(value instanceof RObject && value.data instanceof SetData)) return false;
  return membersOf(self).map.size === membersOf(value).map.size && (yield* subset(self, value));
});
def('Set', 'hash', 0, (self: RObject) => BigInt((self.data as SetData).hashKey().length));
def('Set', 'clear', 0, function* (self: RObject) {
  yield* modify(self);
  membersOf(self).map.clear();
  return self;
});
def('Set', ['merge'], [0, -1], function* (self: RObject, values) {
  yield* modify(self);
  for (const value of values) for (const item of yield* other(value)) yield* hashSet(membersOf(self), item, true);
  return self;
});
for (const [name, keep] of [
  ['select!', true],
  ['filter!', true],
  ['keep_if', true],
  ['reject!', false],
  ['delete_if', false],
] as const) {
  def('Set', name, 0, function* (self: RObject, _args, block) {
    if (!block) return makeEnumerator(self, name, []);
    yield* modify(self);
    let changed = false;
    yield* eachEntry(membersOf(self), function* (entry, slot) {
      if (truthy(yield* callBlock(block, [entry.key])) !== keep) {
        hashDeleteEntry(membersOf(self), slot, entry);
        changed = true;
      }
    });
    return changed || name === 'keep_if' || name === 'delete_if' ? self : NIL;
  });
}
def('Set', 'freeze', 0, (self: RObject) => {
  self.frozen = true;
  membersOf(self).frozen = true;
  return self;
});

export { iterate };
