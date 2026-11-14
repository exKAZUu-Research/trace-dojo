import { inspect, rEquals } from './conversions';
import { def, sdef } from './define';
import { argumentError, frozenError, runtimeError, typeError } from './errors';
import { eachEntry, hashDelete, hashDeleteEntry, hashGet, hashKeyOf, hashSet, rehash } from './hashes';
import { callBlock, callMethod, type Gen, respondsTo } from './interp';
import { iterate, STOP, toArray } from './libEnumerable';
import { makeEnumerator } from './libEnumerator';
import { NIL, type RHash, RObject, type Value } from './objects';
import { rt, whileHeld } from './runtime';
import { arr, newHash, str, truthy } from './values';

/** A Set keeps its members as the keys of a Hash, which gives it the Hash's insertion order and equality. */
class SetData {
  hashing = false;
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
}

function membersOf(set: RObject): RHash {
  return (set.data as SetData).members;
}

export function setSize(set: RObject): bigint {
  return BigInt(membersOf(set).map.size);
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
  const members = membersOf(self);
  members.iterating++;
  try {
    for (const entry of members.map.values()) parts.push(yield* inspect(entry.key));
    return `Set[${parts.join(', ')}]`;
  } finally {
    members.iterating--;
  }
}

function* other(value: Value): Gen<Value[]> {
  if (value instanceof RObject && value.data instanceof SetData)
    return [...membersOf(value).map.values()].map((e) => e.key);
  if (!respondsTo(value, 'each')) throw typeError('value must be enumerable');
  return yield* toArray(value);
}

function* eachOther(value: Value, visit: (item: Value) => Gen<void>): Gen<void> {
  if (value instanceof RObject && value.data instanceof SetData) {
    yield* eachEntry(membersOf(value), function* (entry) {
      yield* visit(entry.key);
    });
    return;
  }
  if (!respondsTo(value, 'each')) throw typeError('value must be enumerable');
  yield* iterate(value, visit);
}

def(
  'Set',
  'initialize',
  [0, 1],
  function* (self: RObject, args, block) {
    const fresh = !(self.data instanceof SetData);
    if (fresh) self.data = new SetData(newHash());
    if (args.length > 0 && args[0] !== NIL) {
      if (
        !block &&
        args[0] instanceof RObject &&
        args[0].data instanceof SetData &&
        (self.cls === rt().c.Set || args[0].cls === self.cls)
      ) {
        if (fresh) self.data = (args[0].data as SetData).copy();
        else {
          yield* modify(self);
          for (const entry of membersOf(args[0]).map.values()) yield* hashSet(membersOf(self), entry.key, true);
        }
        return NIL;
      }
      if (self.cls !== rt().c.Set) {
        yield* iterate(args[0], function* (value) {
          yield* callMethod(self, 'add', [block ? yield* callBlock(block, [value]) : value]);
        });
        return NIL;
      }
      yield* iterate(args[0], function* (value) {
        yield* hashSet(membersOf(self), block ? yield* callBlock(block, [value]) : value, true);
      });
    }
    return NIL;
  },
  { visibility: 'private' }
);
sdef('Set', '[]', [0, -1], (self, args) => callMethod(self, 'new', [arr(args)]));
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
  if (self.cls !== rt().c.Set)
    return truthy(yield* callMethod(self, 'include?', [value])) ? yield* callMethod(self, 'delete', [value]) : NIL;
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
  const result = (yield* callMethod(self, 'dup', [])) as RObject;
  return yield* whileHeld(result, function* () {
    yield* eachOther(value, function* (item) {
      yield* result.cls === rt().c.Set ? hashSet(membersOf(result), item, true) : callMethod(result, 'add', [item]);
    });
    return result;
  });
});
def('Set', ['&', 'intersection'], 1, function* (self: RObject, [value]) {
  const result = (yield* callMethod(self.cls, 'new', [])) as RObject;
  return yield* whileHeld(result, function* () {
    yield* addIntersectionMembers(self, value, result);
    return result;
  });
});
function* addIntersectionMembers(self: RObject, value: Value, result: RObject): Gen<void> {
  if (value instanceof RObject && value.data instanceof SetData) {
    const scanSelf = membersOf(value).map.size > membersOf(self).map.size;
    const scanned = scanSelf ? self : value;
    const lookup = scanSelf ? value : self;
    yield* eachEntry(membersOf(scanned), function* (entry) {
      if (truthy(yield* callMethod(lookup, 'include?', [entry.key]))) yield* callMethod(result, 'add', [entry.key]);
    });
  } else {
    yield* eachOther(value, function* (item) {
      if (truthy(yield* callMethod(self, 'include?', [item]))) yield* callMethod(result, 'add', [item]);
    });
  }
}
def('Set', ['-', 'difference'], 1, function* (self: RObject, [value]) {
  const result = (yield* callMethod(self, 'dup', [])) as RObject;
  return yield* whileHeld(result, function* () {
    yield* eachOther(value, function* (item) {
      yield* result.cls === rt().c.Set ? hashDelete(membersOf(result), item) : callMethod(result, 'delete', [item]);
    });
    return result;
  });
});
def('Set', '^', 1, function* (self: RObject, [value]) {
  if (self.cls !== rt().c.Set) {
    const result = (yield* callMethod(self.cls, 'new', [value])) as RObject;
    return yield* whileHeld(result, function* () {
      yield* eachEntry(membersOf(self), function* (entry) {
        if (!truthy(yield* callMethod(result, 'delete?', [entry.key]))) yield* callMethod(result, 'add', [entry.key]);
      });
      return result;
    });
  }
  const result = new RObject(self.cls);
  result.data = (self.data as SetData).copy();
  return yield* whileHeld(result, function* () {
    const right = value instanceof RObject && value.data instanceof SetData ? value : yield* setFromEnumerable(value);
    return yield* whileHeld(right, function* () {
      for (const entry of membersOf(right).map.values()) {
        if (yield* hashSet(membersOf(result), entry.key, true)) yield* hashDelete(membersOf(result), entry.key);
      }
      return result;
    });
  });
});

function* setFromEnumerable(value: Value): Gen<RObject> {
  if (!respondsTo(value, 'each')) throw typeError('value must be enumerable');
  const result = yield* newSet([]);
  return yield* whileHeld(result, function* () {
    yield* iterate(value, function* (item) {
      yield* hashSet(membersOf(result), item, true);
    });
    return result;
  });
}

function* subset(small: RObject, large: RObject): Gen<boolean> {
  const members = membersOf(small);
  members.iterating++;
  try {
    for (const entry of members.map.values()) if (!(yield* hashGet(membersOf(large), entry.key))) return false;
    return true;
  } finally {
    members.iterating--;
  }
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
  return !(yield* someOther(value, (item) => callMethod(self, 'include?', [item])));
});
def('Set', 'intersect?', 1, function* (self: RObject, [value]) {
  return yield* someOther(value, (item) => callMethod(self, 'include?', [item]));
});
function* someOther(value: Value, predicate: (item: Value) => Gen): Gen<boolean> {
  if (value instanceof RObject && value.data instanceof SetData) {
    const members = membersOf(value);
    members.iterating++;
    try {
      for (const entry of members.map.values()) if (truthy(yield* predicate(entry.key))) return true;
      return false;
    } finally {
      members.iterating--;
    }
  }
  if (!respondsTo(value, 'each')) throw typeError('value must be enumerable');
  let found = false;
  yield* iterate(value, function* (item) {
    if (truthy(yield* predicate(item))) {
      found = true;
      return STOP;
    }
  });
  return found;
}
def('Set', ['==', 'eql?'], 1, function* (self: RObject, [value]) {
  if (!(value instanceof RObject && value.data instanceof SetData)) return false;
  return membersOf(self).map.size === membersOf(value).map.size && (yield* subset(self, value));
});
def('Set', 'hash', 0, function* (self: RObject) {
  const data = self.data as SetData;
  if (data.hashing) return 0n;
  data.hashing = true;
  try {
    let hash = 0n;
    yield* eachEntry(data.members, function* (entry) {
      hash += BigInt(`0x${yield* hashKeyOf(entry.key)}`);
    });
    return hash;
  } finally {
    data.hashing = false;
  }
});
def('Set', 'clear', 0, function* (self: RObject) {
  yield* modify(self);
  membersOf(self).map.clear();
  return self;
});
def('Set', ['merge'], [0, -1], function* (self: RObject, values) {
  yield* modify(self);
  for (const value of values)
    yield* eachOther(value, function* (item) {
      yield* self.cls === rt().c.Set ? hashSet(membersOf(self), item, true) : callMethod(self, 'add', [item]);
    });
  return self;
});
def('Set', 'subtract', 1, function* (self: RObject, [value]) {
  yield* modify(self);
  yield* eachOther(value, function* (item) {
    yield* self.cls === rt().c.Set ? hashDelete(membersOf(self), item) : callMethod(self, 'delete', [item]);
  });
  return self;
});
def('Set', 'replace', 1, function* (self: RObject, [value]) {
  yield* modify(self);
  if (membersOf(self).iterating > 0) throw runtimeError('cannot replace set during iteration');
  const items = yield* other(value);
  membersOf(self).map.clear();
  for (const item of items) yield* hashSet(membersOf(self), item, true);
  return self;
});
def('Set', 'reset', 0, function* (self: RObject) {
  yield* modify(self);
  rehash(membersOf(self));
  return self;
});
def('Set', 'join', [0, 1], function* (self: RObject, args) {
  const values = arr([...membersOf(self).map.values()].map((entry) => entry.key));
  return yield* callMethod(values, 'join', args);
});
def('Set', ['map!', 'collect!'], 0, function* (self: RObject, _args, block) {
  if (!block) return makeEnumerator(self, 'map!', []);
  yield* modify(self);
  const mapped: Value[] = [];
  rt().heldArrays.push(mapped);
  try {
    yield* eachEntry(membersOf(self), function* (entry) {
      mapped.push(yield* callBlock(block, [entry.key]));
    });
    const replacement = yield* newSet(mapped);
    const members = membersOf(replacement);
    members.frozen = self.frozen;
    self.data = new SetData(members);
    return self;
  } finally {
    rt().heldArrays.pop();
  }
});
def('Set', 'flatten', 0, function* (self: RObject) {
  const result = (yield* callMethod(self.cls, 'new', [])) as RObject;
  return yield* whileHeld(result, function* () {
    for (const item of yield* flattenMembers(self, new Set())) yield* callMethod(result, 'add', [item]);
    return result;
  });
});
def('Set', 'flatten!', 0, function* (self: RObject) {
  yield* modify(self);
  if (
    ![...membersOf(self).map.values()].some(
      (entry) => entry.key instanceof RObject && entry.key.data instanceof SetData
    )
  )
    return NIL;
  const values = yield* flattenMembers(self, new Set());
  rt().heldArrays.push(values);
  try {
    membersOf(self).map.clear();
    for (const value of values)
      yield* self.cls === rt().c.Set ? hashSet(membersOf(self), value, true) : callMethod(self, 'add', [value]);
    return self;
  } finally {
    rt().heldArrays.pop();
  }
});
def('Set', 'classify', 0, function* (self: RObject, _args, block) {
  if (!block) return makeEnumerator(self, 'classify', []);
  const groups = newHash();
  return yield* whileHeld(groups, function* () {
    yield* eachEntry(membersOf(self), function* (entry) {
      const key = yield* callBlock(block, [entry.key]);
      const group = yield* hashGet(groups, key);
      const values = group ? (group.value as RObject) : yield* newSet([]);
      yield* hashSet(membersOf(values), entry.key, true);
      if (!group) yield* hashSet(groups, key, values);
    });
    return groups;
  });
});

function* flattenMembers(self: RObject, seen: Set<RObject>): Gen<Value[]> {
  if (seen.has(self)) throw argumentError('tried to flatten recursive set');
  seen.add(self);
  const values: Value[] = [];
  for (const entry of membersOf(self).map.values()) {
    if (entry.key instanceof RObject && entry.key.data instanceof SetData)
      for (const item of yield* flattenMembers(entry.key, seen)) values.push(item);
    else values.push(entry.key);
  }
  seen.delete(self);
  return values;
}
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
