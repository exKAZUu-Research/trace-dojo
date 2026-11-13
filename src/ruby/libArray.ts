// code-gauge-allow-file fileNcss 879 -- The libArray module keeps one concern's cases together.
import {
  compareValues,
  inspect,
  inspectArray,
  rEql,
  rEquals,
  spaceship,
  toIndex,
  toInt,
  toS,
  toStr,
} from './conversions';
import { def, sdef } from './define';
import { argumentError, frozenError, implicitConversionError, indexError, rangeError, typeError } from './errors';
import { hashKeyOf, hashSet } from './hashes';
import { callBlock, callMethod, type Gen, respondsTo } from './interp';
import { inject, iterate, nmin, sortBy, sortValues, sum, toArray, uniqValues } from './libEnumerable';
import { makeEnumerator, sizedEnumerator } from './libEnumerator';
import { randomIndex } from './libRandom';
import { rangeBounds } from './libString';
import { NIL, RArray, type RHash, type RProc, RRange, RString, RSymbol, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, newHash, snapshot, str, truthy } from './values';

function* modify(self: RArray): Gen<void> {
  if (self.frozen) throw frozenError(self, yield* inspectArray(self));
}

function grow(length: number, self?: RArray): void {
  if (length > 10_000_000) throw argumentError('array size too big');
  if (self) rt().chargeSlots(Math.max(0, length - self.items.length));
  rt().spend(Math.floor(length / 64));
}

function* toAry(value: Value): Gen<RArray> {
  if (value instanceof RArray) return value;
  if (respondsTo(value, 'to_ary')) {
    const converted = yield* callMethod(value, 'to_ary', []);
    if (converted instanceof RArray) return converted;
  }
  throw implicitConversionError(value, 'Array');
}

function call(block: RProc, value: Value, used = true): Gen {
  return callBlock(block, [value], used);
}

// Construction --------------------------------------------------------------------------------------------------------

def(
  'Array',
  'initialize',
  [0, 2],
  function* (self: RArray, args, block) {
    yield* modify(self);
    if (args.length === 0) {
      self.items = [];
      return NIL;
    }
    if (args.length === 1 && args[0] instanceof RArray) {
      grow(args[0].items.length, self);
      self.items = [...args[0].items];
      return NIL;
    }
    const size = yield* toIndex(args[0]);
    if (size < 0) throw argumentError('negative array size');
    grow(size, self);
    const items: Value[] = [];
    if (block) {
      self.items = items;
      for (let index = 0; index < size; index++) items.push(yield* call(block, BigInt(index)));
    } else {
      const fill = args[1] ?? NIL;
      for (let index = 0; index < size; index++) items.push(fill);
    }
    self.items = items;
    return NIL;
  },
  { visibility: 'private' }
);
sdef('Array', '[]', [0, -1], (self, args) => new RArray(self, [...args]));

// Access --------------------------------------------------------------------------------------------------------------

function* elementAt(self: RArray, indexValue: Value): Gen {
  let index = yield* toIndex(indexValue);
  if (index < 0) index += self.items.length;
  return self.items[index] ?? NIL;
}

function* slice(self: RArray, args: Value[]): Gen {
  const [first, second] = args;
  if (second === undefined && !(first instanceof RRange)) return yield* elementAt(self, first);
  const length = self.items.length;
  if (second !== undefined) {
    let start = yield* toIndex(first);
    const count = yield* toIndex(second);
    if (start < 0) start += length;
    if (start < 0 || start > length || count < 0) return NIL;
    return arr(self.items.slice(start, start + count));
  }
  const bounds = yield* rangeBounds(first as RRange, length);
  if (!bounds) return NIL;
  return arr(self.items.slice(bounds.start, bounds.start + bounds.count));
}

def('Array', ['[]', 'slice'], [1, 2], (self: RArray, args) => slice(self, args));
def('Array', 'at', 1, (self: RArray, [index]) => elementAt(self, index));
def('Array', '[]=', [2, 3], function* (self: RArray, args) {
  yield* modify(self);
  const value = args.at(-1) as Value;
  const length = self.items.length;
  if (args.length === 2 && !(args[0] instanceof RRange)) {
    let index = yield* toIndex(args[0]);
    if (index < 0) {
      index += length;
      if (index < 0) throw indexError(`index ${index - length} too small for array; minimum: -${length}`);
    }
    grow(index + 1, self);
    while (self.items.length < index) self.items.push(NIL);
    self.items[index] = value;
    return value;
  }
  let start: number;
  let count: number;
  if (args.length === 3) {
    start = yield* toIndex(args[0]);
    count = yield* toIndex(args[1]);
    if (start < 0) {
      start += length;
      if (start < 0) throw indexError(`index ${start - length} too small for array; minimum: -${length}`);
    }
    if (count < 0) throw indexError(`negative length (${count})`);
  } else {
    const range = args[0] as RRange;
    start = range.begin === NIL ? 0 : yield* toIndex(range.begin);
    let end = range.end === NIL ? length : yield* toIndex(range.end);
    if (start < 0) {
      start += length;
      if (start < 0) throw rangeError(`${yield* inspect(range)} out of range`);
    }
    if (end < 0) end += length;
    if (!range.exclusive && range.end !== NIL) end++;
    count = Math.max(0, end - start);
  }
  const replacement = value instanceof RArray ? [...value.items] : [value];
  const filled = Math.max(self.items.length, start);
  const removed = Math.min(count, Math.max(0, filled - start));
  grow(filled - removed + replacement.length, self);
  while (self.items.length < start) self.items.push(NIL);
  self.items.splice(start, count, ...replacement);
  return value;
});
def('Array', 'fetch', [1, 2], function* (self: RArray, args, block) {
  const raw = yield* toIndex(args[0]);
  const index = raw < 0 ? raw + self.items.length : raw;
  if (index >= 0 && index < self.items.length) return self.items[index];
  if (block) return yield* call(block, args[0]);
  if (args.length > 1) return args[1];
  throw indexError(`index ${raw} outside of array bounds: ${-self.items.length}...${self.items.length}`);
});
def('Array', 'dig', [1, -1], function* (self: RArray, args) {
  const value = yield* elementAt(self, args[0]);
  if (args.length === 1 || value === NIL) return value;
  return yield* callMethod(value, 'dig', args.slice(1));
});
def('Array', 'first', [0, 1], function* (self: RArray, args) {
  if (args.length === 0) return self.items[0] ?? NIL;
  const count = yield* toIndex(args[0]);
  if (count < 0) throw argumentError('negative array size');
  return arr(self.items.slice(0, count));
});
def('Array', 'last', [0, 1], function* (self: RArray, args) {
  if (args.length === 0) return self.items.at(-1) ?? NIL;
  const count = yield* toIndex(args[0]);
  if (count < 0) throw argumentError('negative array size');
  return arr(count === 0 ? [] : self.items.slice(-count));
});
// code-gauge-allow functionCognitiveComplexity 20 -- Ruby's method takes these argument forms, which the branches mirror.
def('Array', 'values_at', [0, -1], function* (self: RArray, args) {
  const values: Value[] = [];
  for (const arg of args) {
    if (arg instanceof RRange) {
      const bounds = yield* rangeBounds(arg, self.items.length);
      if (!bounds) continue;
      let end = arg.end === NIL ? self.items.length : Number(yield* toIndex(arg.end));
      if (end < 0) end += self.items.length;
      if (!arg.exclusive && arg.end !== NIL) end++;
      for (let index = bounds.start; index < end; index++) values.push(self.items[index] ?? NIL);
    } else {
      values.push(yield* elementAt(self, arg));
    }
  }
  return arr(values);
});
def('Array', ['length', 'size'], 0, (self: RArray) => BigInt(self.items.length));
def('Array', 'empty?', 0, (self: RArray) => self.items.length === 0);
def('Array', ['to_a', 'entries'], 0, (self: RArray) => (self.cls === rt().c.Array ? self : arr([...self.items])));
def('Array', 'to_ary', 0, (self) => self);
def('Array', ['inspect', 'to_s'], 0, function* (self: RArray) {
  return str(yield* inspectArray(self));
});
def('Array', 'hash', 0, function* (self: RArray) {
  const key = yield* hashKeyOf(self);
  let hash = 17n;
  for (const char of key) hash = (hash * 31n + BigInt(char.codePointAt(0) as number)) % 2_305_843_009_213_693_951n;
  return hash;
});
def('Array', '==', 1, function* (self: RArray, [other]) {
  if (!(other instanceof RArray)) {
    return respondsTo(other, 'to_ary') ? truthy(yield* callMethod(other, '==', [self])) : false;
  }
  return yield* rEquals(self, other);
});
def('Array', 'eql?', 1, (self: RArray, [other]) => rEql(self, other));
def('Array', '<=>', 1, function* (self: RArray, [other]) {
  if (!(other instanceof RArray)) return NIL;
  const length = Math.min(self.items.length, other.items.length);
  for (let index = 0; index < length; index++) {
    const order = yield* spaceship(self.items[index], other.items[index]);
    if (order === undefined) return NIL;
    if (order !== 0) return BigInt(order);
  }
  return BigInt(Math.sign(self.items.length - other.items.length));
});

// Modification --------------------------------------------------------------------------------------------------------

def('Array', ['push', 'append'], [0, -1], function* (self: RArray, args) {
  yield* modify(self);
  grow(self.items.length + args.length, self);
  for (const arg of args) self.items.push(arg);
  return self;
});
def('Array', '<<', 1, function* (self: RArray, [value]) {
  yield* modify(self);
  grow(self.items.length + 1, self);
  self.items.push(value);
  return self;
});
def('Array', 'pop', [0, 1], function* (self: RArray, args) {
  yield* modify(self);
  if (args.length === 0) return self.items.pop() ?? NIL;
  const count = yield* toIndex(args[0]);
  if (count < 0) throw argumentError('negative array size');
  return arr(count === 0 ? [] : self.items.splice(-count));
});
def('Array', 'shift', [0, 1], function* (self: RArray, args) {
  yield* modify(self);
  if (args.length === 0) return self.items.shift() ?? NIL;
  const count = yield* toIndex(args[0]);
  if (count < 0) throw argumentError('negative array size');
  return arr(self.items.splice(0, count));
});
def('Array', ['unshift', 'prepend'], [0, -1], function* (self: RArray, args) {
  yield* modify(self);
  self.items.unshift(...args);
  return self;
});
def('Array', 'insert', [1, -1], function* (self: RArray, args) {
  yield* modify(self);
  let index = yield* toIndex(args[0]);
  if (args.length === 1) return self;
  if (index < 0) {
    index += self.items.length + 1;
    if (index < 0)
      throw indexError(
        `index ${index - self.items.length - 1} too small for array; minimum: -${self.items.length + 1}`
      );
  }
  while (self.items.length < index) self.items.push(NIL);
  self.items.splice(index, 0, ...args.slice(1));
  return self;
});
def('Array', 'concat', [0, -1], function* (self: RArray, args) {
  yield* modify(self);
  const additions: Value[] = [];
  for (const arg of args) for (const item of (yield* toAry(arg)).items) additions.push(item);
  grow(self.items.length + additions.length, self);
  for (const item of additions) self.items.push(item);
  return self;
});
def('Array', 'replace', 1, function* (self: RArray, [other]) {
  yield* modify(self);
  self.items = [...(yield* toAry(other)).items];
  return self;
});
def('Array', 'clear', 0, function* (self: RArray) {
  yield* modify(self);
  self.items = [];
  return self;
});
def('Array', 'delete', 1, function* (self: RArray, [target], block) {
  let found: Value | undefined;
  const kept: Value[] = [];
  for (const item of self.items) {
    if (yield* rEquals(item, target)) found = item;
    else kept.push(item);
  }
  if (found === undefined) return block ? yield* call(block, target) : NIL;
  yield* modify(self);
  self.items = kept;
  return found;
});
def('Array', 'delete_at', 1, function* (self: RArray, [indexValue]) {
  let index = yield* toIndex(indexValue);
  if (index < 0) index += self.items.length;
  if (index < 0 || index >= self.items.length) return NIL;
  yield* modify(self);
  return self.items.splice(index, 1)[0];
});
def('Array', 'slice!', [1, 2], function* (self: RArray, args) {
  yield* modify(self);
  const result = yield* slice(self, args);
  const length = self.items.length;
  if (args.length === 1 && !(args[0] instanceof RRange)) {
    let index = yield* toIndex(args[0]);
    if (index < 0) index += length;
    if (index >= 0 && index < length) self.items.splice(index, 1);
    return result;
  }
  if (result === NIL) return NIL;
  let start: number;
  if (args.length === 2) {
    start = yield* toIndex(args[0]);
    if (start < 0) start += length;
  } else {
    start = (yield* rangeBounds(args[0] as RRange, length))?.start ?? 0;
  }
  self.items.splice(start, (result as RArray).items.length);
  return result;
});

function* filterInPlace(self: RArray, block: RProc, keep: (result: boolean) => boolean): Gen<boolean> {
  yield* modify(self);
  const kept: Value[] = [];
  let changed = false;
  for (let index = 0; index < self.items.length; index++) {
    const item = self.items[index];
    if (keep(truthy(yield* call(block, item)))) kept.push(item);
    else changed = true;
  }
  self.items = kept;
  return changed;
}

def('Array', 'delete_if', 0, function* (self: RArray, _args, block) {
  if (!block) return makeEnumerator(self, 'delete_if', []);
  yield* filterInPlace(self, block, (result) => !result);
  return self;
});
def('Array', 'reject!', 0, function* (self: RArray, _args, block) {
  if (!block) return makeEnumerator(self, 'reject!', []);
  return (yield* filterInPlace(self, block, (result) => !result)) ? self : NIL;
});
def('Array', ['select!', 'filter!'], 0, function* (self: RArray, _args, block) {
  if (!block) return makeEnumerator(self, 'select!', []);
  return (yield* filterInPlace(self, block, (result) => result)) ? self : NIL;
});
def('Array', 'keep_if', 0, function* (self: RArray, _args, block) {
  if (!block) return makeEnumerator(self, 'keep_if', []);
  yield* filterInPlace(self, block, (result) => result);
  return self;
});
def('Array', ['map!', 'collect!'], 0, function* (self: RArray, _args, block) {
  if (!block) return makeEnumerator(self, 'map!', []);
  yield* modify(self);
  for (let index = 0; index < self.items.length; index++) self.items[index] = yield* call(block, self.items[index]);
  return self;
});
def('Array', 'compact', 0, (self: RArray) => arr(self.items.filter((item) => item !== NIL)));
def('Array', 'compact!', 0, function* (self: RArray) {
  yield* modify(self);
  const kept = self.items.filter((item) => item !== NIL);
  if (kept.length === self.items.length) return NIL;
  self.items = kept;
  return self;
});

function* flatten(items: Value[], depth: number, seen: Set<RArray>): Gen<Value[]> {
  const result: Value[] = [];
  for (const item of items) {
    if (item instanceof RArray && depth !== 0) {
      if (seen.has(item)) throw argumentError('tried to flatten recursive array');
      seen.add(item);
      for (const nested of yield* flatten(item.items, depth - 1, seen)) result.push(nested);
      seen.delete(item);
    } else {
      result.push(item);
    }
  }
  grow(result.length);
  return result;
}

def('Array', 'flatten', [0, 1], function* (self: RArray, args) {
  const depth = args.length > 0 && args[0] !== NIL ? yield* toIndex(args[0]) : -1;
  return arr(yield* flatten(self.items, depth, new Set([self])));
});
def('Array', 'flatten!', [0, 1], function* (self: RArray, args) {
  yield* modify(self);
  const depth = args.length > 0 && args[0] !== NIL ? yield* toIndex(args[0]) : -1;
  const flattened = yield* flatten(self.items, depth, new Set([self]));
  const changed = self.items.some((item) => item instanceof RArray) && depth !== 0;
  self.items = flattened;
  return changed ? self : NIL;
});
def('Array', 'uniq', 0, function* (self: RArray, _args, block) {
  return arr(yield* uniqValues(self.items, block));
});
def('Array', 'uniq!', 0, function* (self: RArray, _args, block) {
  yield* modify(self);
  const unique = yield* uniqValues(self.items, block);
  if (unique.length === self.items.length) return NIL;
  self.items = unique;
  return self;
});
def('Array', 'reverse', 0, (self: RArray) => arr(self.items.toReversed()));
def('Array', 'reverse!', 0, function* (self: RArray) {
  yield* modify(self);
  self.items.reverse();
  return self;
});

function rotated(items: Value[], count: number): Value[] {
  if (items.length === 0) return [];
  const shift = ((count % items.length) + items.length) % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

def('Array', 'rotate', [0, 1], function* (self: RArray, args) {
  return arr(rotated(self.items, args.length > 0 ? yield* toIndex(args[0]) : 1));
});
def('Array', 'rotate!', [0, 1], function* (self: RArray, args) {
  yield* modify(self);
  self.items = rotated(self.items, args.length > 0 ? yield* toIndex(args[0]) : 1);
  return self;
});
def('Array', 'sort', 0, function* (self: RArray, _args, block) {
  return arr(yield* sortValues(self.items, block));
});
def('Array', 'sort!', 0, function* (self: RArray, _args, block) {
  yield* modify(self);
  self.items = yield* sortValues(self.items, block);
  return self;
});
def('Array', 'sort_by!', 0, function* (self: RArray, _args, block) {
  if (!block) return sizedEnumerator(self, 'sort_by!', [], () => BigInt(self.items.length));
  yield* modify(self);
  self.items = yield* sortBy(self.items, block);
  return self;
});
// code-gauge-allow functionCognitiveComplexity 28 -- Ruby's method takes these argument forms, which the branches mirror.
// code-gauge-allow functionNcss 32 -- Ruby's method takes these argument forms, which the branches mirror.
def('Array', 'fill', [0, 3], function* (self: RArray, args, block) {
  yield* modify(self);
  const values = block ? args : args.slice(1);
  const value = block ? undefined : args[0];
  if (!block && args.length === 0) throw argumentError('wrong number of arguments (given 0, expected 1..3)');
  let start = 0;
  let end = self.items.length;
  if (values.length > 0 && values[0] instanceof RRange) {
    const bounds = yield* rangeBounds(values[0], self.items.length);
    start = bounds?.start ?? 0;
    const range = values[0];
    let last = range.end === NIL ? self.items.length : yield* toIndex(range.end);
    if (last < 0) last += self.items.length;
    end = range.exclusive || range.end === NIL ? last : last + 1;
  } else {
    if (values.length > 0 && values[0] !== NIL) {
      start = yield* toIndex(values[0]);
      if (start < 0) start = Math.max(0, start + self.items.length);
    }
    if (values.length > 1 && values[1] !== NIL) end = start + (yield* toIndex(values[1]));
    else if (values.length > 0) end = Math.max(self.items.length, start);
  }
  grow(end, self);
  while (self.items.length < end) self.items.push(NIL);
  for (let index = start; index < end; index++) {
    self.items[index] = block ? yield* call(block, BigInt(index)) : (value as Value);
  }
  return self;
});

// Combination ---------------------------------------------------------------------------------------------------------

def('Array', '+', 1, function* (self: RArray, [other]) {
  const items = [...self.items, ...(yield* toAry(other)).items];
  grow(items.length);
  return arr(items);
});
def('Array', ['-', 'difference'], [0, -1], function* (self: RArray, others) {
  const excluded = new Set<string>();
  for (const other of others) for (const item of (yield* toAry(other)).items) excluded.add(yield* hashKeyOf(item));
  const result: Value[] = [];
  for (const item of self.items) if (!excluded.has(yield* hashKeyOf(item))) result.push(item);
  return arr(result);
});
def('Array', '*', 1, function* (self: RArray, [count]) {
  if (count instanceof RString) return yield* join(self, count.s);
  const times = yield* toIndex(count);
  if (times < 0) throw argumentError('negative argument');
  grow(self.items.length * times);
  const items: Value[] = [];
  for (let index = 0; index < times; index++) for (const item of self.items) items.push(item);
  return arr(items);
});
def('Array', ['&', 'intersection'], [0, -1], function* (self: RArray, others) {
  let result = yield* uniqValues(self.items, undefined);
  for (const other of others) {
    const keys = new Set<string>();
    for (const item of (yield* toAry(other)).items) keys.add(yield* hashKeyOf(item));
    const kept: Value[] = [];
    for (const item of result) if (keys.has(yield* hashKeyOf(item))) kept.push(item);
    result = kept;
  }
  return arr(result);
});
def('Array', ['|', 'union'], [0, -1], function* (self: RArray, others) {
  const all = [...self.items];
  for (const other of others) for (const item of (yield* toAry(other)).items) all.push(item);
  return arr(yield* uniqValues(all, undefined));
});
def('Array', 'intersect?', 1, function* (self: RArray, [other]) {
  const keys = new Set<string>();
  for (const item of (yield* toAry(other)).items) keys.add(yield* hashKeyOf(item));
  for (const item of self.items) if (keys.has(yield* hashKeyOf(item))) return true;
  return false;
});

/** `join`: elements' text with a separator, nested arrays joined recursively. */
function* join(self: RArray, separator: string, seen = new Set<RArray>()): Gen {
  if (seen.has(self)) throw argumentError('recursive array join');
  seen.add(self);
  const parts: string[] = [];
  let length = 0;
  for (const item of self.items) {
    let part: string;
    if (item instanceof RArray) part = ((yield* join(item, separator, seen)) as RString).s;
    else if (item instanceof RString) part = item.s;
    else part = yield* toS(item);
    length += part.length + separator.length;
    if (length > 1_000_000) throw argumentError('string size too big');
    parts.push(part);
  }
  seen.delete(self);
  return str(parts.join(separator));
}

def('Array', 'join', [0, 1], function* (self: RArray, args) {
  const separator = args.length > 0 && args[0] !== NIL ? yield* toStr(args[0]) : '';
  return yield* join(self, separator);
});
def('Array', 'assoc', 1, function* (self: RArray, [key]) {
  for (const item of self.items) {
    if (item instanceof RArray && item.items.length > 0 && (yield* rEquals(item.items[0], key))) return item;
  }
  return NIL;
});
def('Array', 'rassoc', 1, function* (self: RArray, [value]) {
  for (const item of self.items) {
    if (item instanceof RArray && item.items.length > 1 && (yield* rEquals(item.items[1], value))) return item;
  }
  return NIL;
});
def('Array', 'transpose', 0, function* (self: RArray) {
  const rows: Value[][] = [];
  for (const item of self.items) rows.push((yield* toAry(item)).items);
  if (rows.length === 0) return arr([]);
  const width = rows[0].length;
  for (const row of rows) {
    if (row.length !== width) throw indexError(`element size differs (${row.length} should be ${width})`);
  }
  const result: Value[] = [];
  for (let column = 0; column < width; column++) result.push(arr(rows.map((row) => row[column])));
  return arr(result);
});
def('Array', 'zip', [0, -1], function* (self: RArray, others, block) {
  const lists: Value[][] = [];
  for (const other of others) lists.push(other instanceof RArray ? other.items : yield* toArray(other));
  const results: Value[] = [];
  for (const [index, item] of self.items.entries()) {
    const tuple = arr([item, ...lists.map((list) => list[index] ?? NIL)]);
    if (block) yield* call(block, tuple, false);
    else results.push(tuple);
  }
  return block ? NIL : arr(results);
});
def('Array', 'product', [0, -1], function* (self: RArray, others, block) {
  rt().chargeSlots(self.items.length);
  let tuples: Value[][] = self.items.map((item) => [item]);
  for (const other of others) {
    const items = (yield* toAry(other)).items;
    const size = tuples.length * items.length;
    grow(size);
    rt().chargeSlots(size);
    const next: Value[][] = [];
    for (const tuple of tuples) for (const item of items) next.push([...tuple, item]);
    tuples = next;
  }
  if (block) {
    for (const tuple of tuples) yield* call(block, arr(tuple), false);
    return self;
  }
  return arr(tuples.map((tuple) => arr(tuple)));
});

function* combinations(items: Value[], size: number, visit: (combination: Value[]) => Gen<void>): Gen<void> {
  const indices = Array.from({ length: size }, (_, index) => index);
  if (size > items.length) return;
  for (;;) {
    rt().spend();
    yield* visit(indices.map((index) => items[index]));
    let position = size - 1;
    while (position >= 0 && indices[position] === items.length - size + position) position--;
    if (position < 0) return;
    indices[position]++;
    for (let next = position + 1; next < size; next++) indices[next] = indices[next - 1] + 1;
  }
}

function* permutations(items: Value[], size: number, visit: (permutation: Value[]) => Gen<void>): Gen<void> {
  if (size > items.length || size < 0) return;
  const used = Array.from({ length: items.length }, () => false);
  const current: Value[] = [];
  const recurse = function* (): Gen<void> {
    if (current.length === size) {
      rt().spend();
      yield* visit([...current]);
      return;
    }
    for (let index = 0; index < items.length; index++) {
      if (used[index]) continue;
      used[index] = true;
      current.push(items[index]);
      yield* recurse();
      current.pop();
      used[index] = false;
    }
  };
  yield* recurse();
}

for (const [name, generate] of [
  ['combination', combinations],
  ['permutation', permutations],
] as const) {
  def('Array', name, [name === 'combination' ? 1 : 0, 1], function* (self: RArray, args, block) {
    const size = args.length > 0 ? yield* toIndex(args[0]) : self.items.length;
    if (!block) return makeEnumerator(self, name, args);
    const items = [...self.items];
    yield* generate(items, size, function* (combination) {
      yield* call(block, arr(combination), false);
    });
    return self;
  });
}
// code-gauge-allow duplicateLines 16 -- Each language wires its own parser and runtime into the shared modules alike.
def('Array', 'repeated_combination', 1, function* (self: RArray, [sizeValue], block) {
  const size = yield* toIndex(sizeValue);
  if (!block) return makeEnumerator(self, 'repeated_combination', [sizeValue]);
  const items = [...self.items];
  if (size < 0 || (items.length === 0 && size > 0)) return self;
  const indices = Array.from({ length: size }, () => 0);
  for (;;) {
    rt().spend();
    yield* call(block, arr(indices.map((index) => items[index])), false);
    let position = size - 1;
    while (position >= 0 && indices[position] === items.length - 1) position--;
    if (position < 0) return self;
    indices[position]++;
    for (let next = position + 1; next < size; next++) indices[next] = indices[position];
  }
});
// code-gauge-allow duplicateLines 16 -- Each language wires its own parser and runtime into the shared modules alike.
def('Array', 'repeated_permutation', 1, function* (self: RArray, [sizeValue], block) {
  const size = yield* toIndex(sizeValue);
  if (!block) return makeEnumerator(self, 'repeated_permutation', [sizeValue]);
  const items = [...self.items];
  if (size < 0 || (items.length === 0 && size > 0)) return self;
  const indices = Array.from({ length: size }, () => 0);
  for (;;) {
    rt().spend();
    yield* call(block, arr(indices.map((index) => items[index])), false);
    let position = size - 1;
    while (position >= 0 && indices[position] === items.length - 1) {
      indices[position] = 0;
      position--;
    }
    if (position < 0) return self;
    indices[position]++;
  }
});

// Iteration -----------------------------------------------------------------------------------------------------------

def('Array', 'each', 0, function* (self: RArray, _args, block) {
  if (!block) return sizedEnumerator(self, 'each', [], () => BigInt(self.items.length));
  const held = rt().held.length;
  for (let index = 0; index < self.items.length; index++) yield* call(block, self.items[index], false);
  rt().held.length = Math.max(held, rt().held.length);
  return self;
});
def('Array', 'each_index', 0, function* (self: RArray, _args, block) {
  if (!block) return makeEnumerator(self, 'each_index', []);
  for (let index = 0; index < self.items.length; index++) yield* call(block, BigInt(index), false);
  return self;
});
def('Array', 'reverse_each', 0, function* (self: RArray, _args, block) {
  if (!block) return makeEnumerator(self, 'reverse_each', []);
  for (let index = self.items.length - 1; index >= 0; index--) {
    if (index >= self.items.length) {
      index = self.items.length;
      continue;
    }
    yield* call(block, self.items[index], false);
  }
  return self;
});
def('Array', ['index', 'find_index'], [0, 1], function* (self: RArray, args, block) {
  if (args.length === 0 && !block) return makeEnumerator(self, 'index', []);
  for (let index = 0; index < self.items.length; index++) {
    const matched =
      args.length > 0
        ? yield* rEquals(self.items[index], args[0])
        : truthy(yield* call(block as RProc, self.items[index]));
    if (matched) return BigInt(index);
  }
  return NIL;
});
def('Array', 'rindex', [0, 1], function* (self: RArray, args, block) {
  if (args.length === 0 && !block) return makeEnumerator(self, 'rindex', []);
  for (let index = self.items.length - 1; index >= 0; index--) {
    if (index >= self.items.length) continue;
    const matched =
      args.length > 0
        ? yield* rEquals(self.items[index], args[0])
        : truthy(yield* call(block as RProc, self.items[index]));
    if (matched) return BigInt(index);
  }
  return NIL;
});
def('Array', 'include?', 1, function* (self: RArray, [target]) {
  for (const item of self.items) if (yield* rEquals(item, target)) return true;
  return false;
});
def('Array', 'count', [0, 1], function* (self: RArray, args, block) {
  if (args.length === 0 && !block) return BigInt(self.items.length);
  let count = 0n;
  for (const item of snapshot(self.items)) {
    if (args.length > 0 ? yield* rEquals(item, args[0]) : truthy(yield* call(block as RProc, item))) count++;
  }
  return count;
});
def('Array', 'take', 1, function* (self: RArray, [countValue]) {
  const count = yield* toIndex(countValue);
  if (count < 0) throw argumentError('attempt to take negative size');
  return arr(self.items.slice(0, count));
});
def('Array', 'drop', 1, function* (self: RArray, [countValue]) {
  const count = yield* toIndex(countValue);
  if (count < 0) throw argumentError('attempt to drop negative size');
  return arr(self.items.slice(count));
});
def('Array', 'sum', [0, 1], (self: RArray, args, block) => sum(self, args, block));
def('Array', ['inject', 'reduce'], [0, 2], (self: RArray, args, block) => inject(self, args, block));
def('Array', 'max', [0, 1], function* (self: RArray, args, block) {
  if (args.length > 0 && args[0] !== NIL) return yield* nmin(self.items, args[0], undefined, block, true);
  let result: Value | undefined;
  for (const item of self.items) {
    if (result === undefined) result = item;
    else if ((block ? yield* blockOrder(block, item, result) : yield* compareValues(item, result)) > 0) result = item;
  }
  return result ?? NIL;
});
def('Array', 'min', [0, 1], function* (self: RArray, args, block) {
  if (args.length > 0 && args[0] !== NIL) return yield* nmin(self.items, args[0], undefined, block, false);
  let result: Value | undefined;
  for (const item of self.items) {
    if (result === undefined) result = item;
    else if ((block ? yield* blockOrder(block, item, result) : yield* compareValues(item, result)) < 0) result = item;
  }
  return result ?? NIL;
});

function* blockOrder(block: RProc, a: Value, b: Value): Gen<number> {
  const result = yield* callBlock(block, [a, b]);
  if (typeof result === 'bigint') return result > 0n ? 1 : result < 0n ? -1 : 0;
  if (typeof result === 'number') return Math.sign(result);
  return yield* compareValues(result, 0n);
}

def('Array', 'cycle', [0, 1], function* (self: RArray, args, block) {
  if (!block) return makeEnumerator(self, 'cycle', args);
  const times = args.length > 0 && args[0] !== NIL ? yield* toInt(args[0]) : -1n;
  for (let round = 0n; times < 0n || round < times; round++) {
    if (self.items.length === 0) return NIL;
    for (let index = 0; index < self.items.length; index++) yield* call(block, self.items[index], false);
  }
  return NIL;
});
// code-gauge-allow functionCognitiveComplexity 16 -- Ruby's method takes these argument forms, which the branches mirror.
def('Array', 'bsearch', 0, function* (self: RArray, _args, block) {
  if (!block) return makeEnumerator(self, 'bsearch', []);
  let low = 0;
  let high = self.items.length;
  let found: Value = NIL;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const result = yield* call(block, self.items[middle]);
    if (result === true) {
      found = self.items[middle];
      high = middle;
    } else if (result === false || result === NIL) {
      low = middle + 1;
    } else if (typeof result === 'bigint' || typeof result === 'number') {
      if (Number(result) === 0) return self.items[middle];
      if (Number(result) < 0) high = middle;
      else low = middle + 1;
    } else {
      throw typeError(`wrong argument type ${yield* inspect(result)} (must be numeric, true, false or nil)`);
    }
  }
  return found;
});
def('Array', 'to_h', 0, function* (self: RArray, _args, block) {
  const hash = newHash();
  for (const [index, item] of self.items.entries()) {
    const pair = block ? yield* call(block, item) : item;
    if (!(pair instanceof RArray)) {
      throw typeError(
        `wrong element type ${pair === NIL ? 'nil' : yield* className(pair)} at ${index} (expected array)`
      );
    }
    if (pair.items.length !== 2) {
      throw argumentError(`wrong array length at ${index} (expected 2, was ${pair.items.length})`);
    }
    yield* hashSet(hash, pair.items[0], pair.items[1]);
  }
  return hash;
});

function* className(value: Value): Gen<string> {
  return (yield* callMethod(yield* callMethod(value, 'class', []), 'name', [])) instanceof RString
    ? ((yield* callMethod(yield* callMethod(value, 'class', []), 'name', [])) as RString).s
    : '';
}

def(
  'Array',
  'shuffle',
  [0, 1],
  function* (self: RArray, _args, _block, keywords) {
    const items = [...self.items];
    yield* shuffle(items, yield* randomOption(keywords));
    return arr(items);
  },
  { keywords: true }
);
def(
  'Array',
  'shuffle!',
  [0, 1],
  function* (self: RArray, _args, _block, keywords) {
    yield* modify(self);
    yield* shuffle(self.items, yield* randomOption(keywords));
    return self;
  },
  { keywords: true }
);

function* randomOption(keywords: RHash | undefined): Gen<Value | undefined> {
  if (!keywords) return undefined;
  for (const entry of keywords.map.values()) {
    if (entry.key instanceof RSymbol && entry.key.name === 'random') return entry.value;
    throw argumentError(`unknown keyword: ${yield* inspect(entry.key)}`);
  }
  return undefined;
}

function* shuffle(items: Value[], randomizer: Value | undefined): Gen<void> {
  let index = items.length;
  while (index > 1) {
    const other = yield* randomIndex(randomizer, index);
    index--;
    [items[index], items[other]] = [items[other], items[index]];
  }
}

def(
  'Array',
  'sample',
  [0, 1],
  function* (self: RArray, args, _block, keywords) {
    const randomizer = yield* randomOption(keywords);
    const items = self.items;
    if (args.length === 0) {
      if (items.length === 0) return NIL;
      const index = items.length < 2 ? 0 : yield* randomIndex(randomizer, items.length);
      return items[index] ?? NIL;
    }
    let n = yield* toIndex(args[0]);
    if (n < 0) throw argumentError('negative sample number');
    const length = items.length;
    if (n > length) n = length;
    if (n <= 0) return arr([]);
    if (n <= 10) {
      const draws: number[] = [];
      for (let i = 0; i < n; i++) draws.push(yield* randomIndex(randomizer, length - i));
      if (n === 1) return arr([items[draws[0]]]);
      if (n === 2) {
        const i = draws[0];
        let j = draws[1];
        if (j >= i) j++;
        return arr([items[i], items[j]]);
      }
      if (n === 3) {
        const i = draws[0];
        let j = draws[1];
        let k = draws[2];
        let l = j;
        let g = i;
        if (j >= i) {
          l = i;
          g = ++j;
        }
        if (k >= l && ++k >= g) ++k;
        return arr([items[i], items[j], items[k]]);
      }
      const sorted: number[] = [draws[0]];
      const chosen: number[] = [draws[0]];
      for (let i = 1; i < n; i++) {
        let k = draws[i];
        let j = 0;
        for (; j < i; j++) {
          if (k < sorted[j]) break;
          k++;
        }
        sorted.splice(j, 0, k);
        chosen.push(k);
      }
      return arr(chosen.map((index) => items[index]));
    }
    const memoThreshold =
      length < 2560
        ? Math.floor(length / 128)
        : length < 5120
          ? Math.floor(length / 64)
          : length < 10_240
            ? Math.floor(length / 32)
            : Math.floor(length / 16);
    if (n <= memoThreshold / 2) {
      const memo = new Map<number, number>();
      const result: Value[] = [];
      const draws: number[] = [];
      for (let i = 0; i < n; i++) draws.push((yield* randomIndex(randomizer, length - i)) + i);
      for (let i = 0; i < n; i++) {
        const j = draws[i];
        const i2 = memo.get(i) ?? i;
        const j2 = memo.get(j) ?? j;
        memo.set(j, i2);
        result.push(items[j2]);
      }
      return arr(result);
    }
    const result = [...items];
    for (let i = 0; i < n; i++) {
      const j = (yield* randomIndex(randomizer, length - i)) + i;
      [result[i], result[j]] = [result[j], result[i]];
    }
    return arr(result.slice(0, n));
  },
  { keywords: true }
);
def('Array', 'pack', [1, -1], () => {
  throw new UnsupportedFeatureError('Array#pack');
});

export { iterate };
