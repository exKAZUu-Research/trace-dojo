// code-gauge-allow-file fileNcss 879 -- The libArray module keeps one concern's cases together.
import {
  combinedStringEncoding,
  compareValues,
  inspect,
  inspectArray,
  rEql,
  rEquals,
  toIndex,
  toIndexExact,
  toInt,
  toStrValue,
  toSValue,
} from './conversions';
import { def, sdef } from './define';
import { argumentError, frozenError, implicitConversionError, indexError, rangeError, typeError } from './errors';
import { hashGet, hashSet, structuralHashValue } from './hashes';
import { callBlock, callMethod, type Gen, respondsTo } from './interp';
import {
  blockCompare,
  inject,
  iterate,
  minmax as enumerableMinmax,
  nmin,
  sortBy,
  sortValues,
  sum,
  uniqValues,
  zipCollections,
} from './libEnumerable';
import { makeEnumerator, sizedEnumerator } from './libEnumerator';
import { randomIndex } from './libRandom';
import { rangeBounds } from './libString';
import { NIL, RArray, type RHash, type RProc, RRange, RString, RSymbol, type Value } from './objects';
import { rt, UnsupportedFeatureError, whileHeld } from './runtime';
import { arr, newHash, realClassOf, str, stringBytes, stringFromBytes, truthy } from './values';

function* modify(self: RArray): Gen<void> {
  if (self.frozen) throw frozenError(self, yield* inspectArray(self));
  self.version++;
  rt().containerVersion++;
}

function grow(length: number, self?: RArray): void {
  if (length > 10_000_000) throw argumentError('array size too big');
  if (self) rt().chargeSlots(Math.max(0, length - self.items.length));
  rt().spend(Math.floor(length / 64));
}

function* toAry(value: Value): Gen<RArray> {
  const array = yield* tryAry(value);
  if (array) return array;
  throw implicitConversionError(value, 'Array');
}

export function* tryAry(value: Value): Gen<RArray | undefined> {
  if (value instanceof RArray) return value;
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
    if (args.length === 1) {
      const source = yield* tryAry(args[0]);
      if (source) {
        grow(source.items.length, self);
        self.items = [...source.items];
        return NIL;
      }
    }
    const size = yield* toIndex(args[0]);
    if (size < 0) throw argumentError('negative array size');
    if (block) {
      grow(size);
      self.items = [];
      for (let index = 0; index < size; index++) {
        const result = yield* call(block, BigInt(index));
        yield* modify(self);
        grow(index + 1, self);
        while (self.items.length < index) self.items.push(NIL);
        self.items[index] = result;
        self.items.length = index + 1;
      }
    } else {
      grow(size, self);
      const items: Value[] = [];
      const fill = args[1] ?? NIL;
      for (let index = 0; index < size; index++) items.push(fill);
      self.items = items;
    }
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
  return (yield* resolvedSlice(self, args)).value;
}

function* resolvedSlice(self: RArray, args: Value[]): Gen<{ value: Value; start?: number; count?: number }> {
  const [first, second] = args;
  if (second === undefined && !(first instanceof RRange)) {
    let index = yield* toIndex(first);
    const length = self.items.length;
    if (index < 0) index += length;
    return index < 0 || index >= length ? { value: NIL } : { value: self.items[index], start: index, count: 1 };
  }
  if (second !== undefined) {
    let start = yield* toIndex(first);
    const count = yield* toIndex(second);
    const length = self.items.length;
    if (start < 0) start += length;
    if (start < 0 || start > length || count < 0) return { value: NIL };
    const selected = self.items.slice(start, start + count);
    return { value: arr(selected), start, count: selected.length };
  }
  const bounds = yield* rangeBounds(first as RRange, () => self.items.length);
  if (!bounds) return { value: NIL };
  const selected = self.items.slice(bounds.start, bounds.start + bounds.count);
  return { value: arr(selected), start: bounds.start, count: selected.length };
}

def('Array', ['[]', 'slice'], [1, 2], (self: RArray, args) => slice(self, args));
def('Array', 'at', 1, (self: RArray, [index]) => elementAt(self, index));
def('Array', '[]=', [2, 3], function* (self: RArray, args) {
  yield* modify(self);
  const value = args.at(-1) as Value;
  if (args.length === 2 && !(args[0] instanceof RRange)) {
    const index = yield* assignmentIndex(self, args[0]);
    grow(index + 1, self);
    while (self.items.length < index) self.items.push(NIL);
    self.items[index] = value;
    return value;
  }
  let start: number;
  let count: number;
  if (args.length === 3) {
    const { integer } = yield* toIndexExact(args[0]);
    count = yield* toIndex(args[1]);
    start = assignmentIndexExact(self, integer);
    if (count < 0) throw indexError(`negative length (${count})`);
  } else {
    const range = args[0] as RRange;
    start = range.begin === NIL ? 0 : yield* toIndex(range.begin);
    let end = range.end === NIL ? undefined : yield* toIndex(range.end);
    const length = self.items.length;
    end ??= length;
    if (start < 0) {
      start += length;
      if (start < 0) throw rangeError(`${yield* inspect(range)} out of range`);
    }
    if (end < 0) end += length;
    if (!range.exclusive && range.end !== NIL) end++;
    count = Math.max(0, end - start);
  }
  const converted = yield* tryAry(value);
  const replacement = converted ? [...converted.items] : [value];
  const filled = Math.max(self.items.length, start);
  const removed = Math.min(count, Math.max(0, filled - start));
  grow(filled - removed + replacement.length, self);
  while (self.items.length < start) self.items.push(NIL);
  self.items = [...self.items.slice(0, start), ...replacement, ...self.items.slice(start + count)];
  return value;
});

function* assignmentIndex(self: RArray, value: Value): Gen<number> {
  const { integer } = yield* toIndexExact(value);
  return assignmentIndexExact(self, integer);
}

function assignmentIndexExact(self: RArray, integer: bigint): number {
  const length = self.items.length;
  const adjusted = integer < 0n ? integer + BigInt(length) : integer;
  if (adjusted < 0n) throw indexError(`index ${integer} too small for array; minimum: -${length}`);
  if (adjusted >= 1_152_921_504_606_846_975n) throw indexError(`index ${integer} too big`);
  return Number(adjusted);
}
def('Array', 'fetch', [1, 2], function* (self: RArray, args, block) {
  const { number: raw, integer: exact } = yield* toIndexExact(args[0]);
  const index = raw < 0 ? raw + self.items.length : raw;
  if (index >= 0 && index < self.items.length) return self.items[index];
  if (block) return yield* call(block, args[0]);
  if (args.length > 1) return args[1];
  throw indexError(`index ${exact} outside of array bounds: ${-self.items.length}...${self.items.length}`);
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
// code-gauge-allow functionCognitiveComplexity 20 -- values_at processes Integer and Range selectors, including out-of-bounds and beginless ranges.
def('Array', 'values_at', [0, -1], function* (self: RArray, args) {
  const values: Value[] = [];
  for (const arg of args) {
    if (arg instanceof RRange) {
      let start = arg.begin === NIL ? 0 : yield* toIndex(arg.begin);
      if (start < 0) start += self.items.length;
      if (start < 0) throw rangeError(`${yield* inspect(arg)} out of range`);
      let end = arg.end === NIL ? self.items.length : Number(yield* toIndex(arg.end));
      if (end < 0) end += self.items.length;
      if (!arg.exclusive && arg.end !== NIL) end++;
      grow(values.length + Math.max(0, end - start));
      for (let index = start; index < end; index++) values.push(self.items[index] ?? NIL);
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
  return yield* structuralHashValue(self);
});
def('Array', '==', 1, function* (self: RArray, [other]) {
  if (!(other instanceof RArray)) {
    return respondsTo(other, 'to_ary') ? truthy(yield* callMethod(other, '==', [self])) : false;
  }
  return yield* rEquals(self, other);
});
def('Array', 'eql?', 1, (self: RArray, [other]) => rEql(self, other));
def('Array', '<=>', 1, function* (self: RArray, [other]) {
  const compared = other instanceof RArray ? other : yield* tryAry(other);
  if (!compared) return NIL;
  const length = Math.min(self.items.length, compared.items.length);
  for (let index = 0; index < length; index++) {
    const result = yield* callMethod(self.items[index] ?? NIL, '<=>', [compared.items[index] ?? NIL]);
    if (result !== 0n) return result;
  }
  return BigInt(Math.sign(self.items.length - compared.items.length));
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
  grow(self.items.length + args.length, self);
  self.items = [...args, ...self.items];
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
  grow(Math.max(index, self.items.length) + args.length - 1, self);
  while (self.items.length < index) self.items.push(NIL);
  self.items = [...self.items.slice(0, index), ...args.slice(1), ...self.items.slice(index)];
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
  const items = (yield* toAry(other)).items;
  grow(items.length, self);
  self.items = [...items];
  return self;
});
def('Array', 'clear', 0, function* (self: RArray) {
  yield* modify(self);
  self.items = [];
  return self;
});
def('Array', 'delete', 1, function* (self: RArray, [target], block) {
  let found: Value | undefined;
  let read = 0;
  let write = 0;
  try {
    for (; read < self.items.length; read++) {
      const item = self.items[read];
      if (yield* rEquals(item, target)) {
        yield* modify(self);
        found = item;
      } else self.items[write++] = item;
    }
  } finally {
    if (write < read) self.items = [...self.items.slice(0, write), ...self.items.slice(read)];
  }
  if (found === undefined) return block ? yield* call(block, target) : NIL;
  yield* modify(self);
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
  const { value, start, count } = yield* resolvedSlice(self, args);
  if (start !== undefined) self.items.splice(start, count ?? 0);
  return value;
});

function* filterInPlace(self: RArray, block: RProc, keep: (result: boolean) => boolean): Gen<boolean> {
  yield* modify(self);
  let changed = false;
  let read = 0;
  let write = 0;
  try {
    for (; read < self.items.length; read++) {
      const item = self.items[read];
      if (keep(truthy(yield* call(block, item)))) self.items[write++] = item;
      else changed = true;
    }
  } finally {
    if (write < read) self.items = [...self.items.slice(0, write), ...self.items.slice(read)];
  }
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
  for (let index = 0; index < self.items.length; index++) {
    const value = yield* call(block, self.items[index]);
    grow(index + 1, self);
    while (self.items.length <= index) self.items.push(NIL);
    self.items[index] = value;
  }
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
  rt().heldArrays.push(result);
  const stack: { items: Value[]; index: number; depth: number; owner?: RArray }[] = [{ items, index: 0, depth }];
  try {
    while (stack.length > 0) {
      rt().spend();
      const frame = stack.at(-1) as (typeof stack)[number];
      if (frame.index >= frame.items.length) {
        stack.pop();
        if (frame.owner) {
          seen.delete(frame.owner);
          rt().held.pop();
        }
        continue;
      }
      const item = frame.items[frame.index++];
      const nested = frame.depth !== 0 ? yield* tryAry(item) : undefined;
      if (!nested) {
        result.push(item);
        grow(result.length);
        continue;
      }
      if (seen.has(nested)) throw argumentError('tried to flatten recursive array');
      seen.add(nested);
      rt().held.push(nested);
      stack.push({ items: nested.items, index: 0, depth: frame.depth - 1, owner: nested });
    }
  } finally {
    for (const frame of stack) if (frame.owner) seen.delete(frame.owner);
    for (let index = 0; index < stack.length - 1; index++) rt().held.pop();
    rt().heldArrays.pop();
  }
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
  const changed = flattened.length !== self.items.length || flattened.some((item, index) => item !== self.items[index]);
  grow(flattened.length, self);
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

function rotated(items: Value[], count: bigint): Value[] {
  if (items.length === 0) return [];
  const length = BigInt(items.length);
  const shift = Number(((count % length) + length) % length);
  return [...items.slice(shift), ...items.slice(0, shift)];
}

def('Array', 'rotate', [0, 1], function* (self: RArray, args) {
  return arr(rotated(self.items, args.length > 0 ? (yield* toIndexExact(args[0])).integer : 1n));
});
def('Array', 'rotate!', [0, 1], function* (self: RArray, args) {
  yield* modify(self);
  self.items = rotated(self.items, args.length > 0 ? (yield* toIndexExact(args[0])).integer : 1n);
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
// code-gauge-allow functionCognitiveComplexity 28 -- fill combines value, start, length, Range, and block forms with shared growth validation.
// code-gauge-allow functionNcss 32 -- fill combines value, start, length, Range, and block forms with shared growth validation.
def('Array', 'fill', [0, 3], function* (self: RArray, args, block) {
  yield* modify(self);
  const values = block ? args : args.slice(1);
  const value = block ? undefined : args[0];
  if (!block && args.length === 0) throw argumentError('wrong number of arguments (given 0, expected 1..3)');
  let start = 0;
  let end = self.items.length;
  if (values.length > 0 && values[0] instanceof RRange) {
    const range = values[0];
    start = range.begin === NIL ? 0 : yield* toIndex(range.begin);
    if (start < 0) start += self.items.length;
    if (start < 0) throw rangeError(`${yield* inspect(range)} out of range`);
    let last = range.end === NIL ? self.items.length : yield* toIndex(range.end);
    if (last < 0) last += self.items.length;
    end = range.exclusive || range.end === NIL ? last : last + 1;
  } else {
    if (values.length > 0 && values[0] !== NIL) {
      start = yield* toIndex(values[0]);
      if (start < 0) start = Math.max(0, start + self.items.length);
    }
    if (values.length > 1 && values[1] !== NIL) end = start + (yield* toIndex(values[1]));
    else if (values.length > 0) end = self.items.length;
  }
  grow(end, self);
  while (self.items.length < end) self.items.push(NIL);
  for (let index = start; index < end && index < self.items.length; index++) {
    const next = block ? yield* call(block, BigInt(index)) : (value as Value);
    if (index >= self.items.length) break;
    self.items[index] = next;
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
  const excluded = newHash();
  for (const other of others) for (const item of (yield* toAry(other)).items) yield* hashSet(excluded, item, true);
  const result: Value[] = [];
  for (const item of self.items) if (!(yield* hashGet(excluded, item))) result.push(item);
  return arr(result);
});
def('Array', '*', 1, function* (self: RArray, [count]) {
  if (count instanceof RString) return yield* join(self, count);
  if (respondsTo(count, 'to_str', true)) {
    const separator = yield* callMethod(count, 'to_str', [], undefined, undefined, { fcall: true });
    if (separator instanceof RString) return yield* join(self, separator);
    if (separator !== NIL) {
      const name = realClassOf(count).name;
      throw typeError(`can't convert ${name} to String (${name}#to_str gives ${realClassOf(separator).name})`);
    }
  }
  const times = yield* toIndex(count);
  if (times < 0) throw argumentError('negative argument');
  if (self.items.length === 0) return arr([]);
  grow(self.items.length * times);
  const items: Value[] = [];
  for (let index = 0; index < times; index++) for (const item of self.items) items.push(item);
  return arr(items);
});
def('Array', ['&', 'intersection'], [0, -1], function* (self: RArray, others) {
  let result = yield* uniqValues(self.items, undefined);
  for (const other of others) {
    const keys = newHash();
    for (const item of (yield* toAry(other)).items) yield* hashSet(keys, item, true);
    const kept: Value[] = [];
    for (const item of result) if (yield* hashGet(keys, item)) kept.push(item);
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
  const keys = newHash();
  for (const item of (yield* toAry(other)).items) yield* hashSet(keys, item, true);
  for (const item of self.items) if (yield* hashGet(keys, item)) return true;
  return false;
});

/** `join`: elements' bytes with a separator, nested arrays joined recursively. */
function* join(self: RArray, separator: RString, seen = new Set<RArray>()): Gen<RString> {
  if (seen.has(self)) throw argumentError('recursive array join');
  seen.add(self);
  const chunks: Uint8Array[] = [];
  let length = 0;
  let binary = false;
  let ascii = true;
  try {
    yield* preflightJoinFirst(self);
    for (let index = 0; index < self.items.length; index++) {
      if (index > 0) append(separator);
      append(yield* joinValue(self.items[index], separator, seen));
    }
  } finally {
    seen.delete(self);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return stringFromBytes(bytes, binary);

  function append(part: RString): void {
    binary = combinedStringEncoding(binary, ascii, part);
    const bytes = stringBytes(part);
    length += bytes.length;
    if (length > 1_000_000) throw argumentError('string size too big');
    chunks.push(bytes);
    ascii &&= bytes.every((byte) => byte < 0x80);
  }
}

function* preflightJoinFirst(self: RArray): Gen<void> {
  for (const first of self.items) {
    if (first instanceof RString) continue;
    if (respondsTo(first, 'to_str', true)) {
      const converted = yield* callMethod(first, 'to_str', [], undefined, undefined, { fcall: true });
      if (!(converted instanceof RString) && converted !== NIL) throw joinStringConversionError(first, converted);
    }
    break;
  }
}

def('Array', 'join', [0, 1], function* (self: RArray, args) {
  const separator = args.length > 0 && args[0] !== NIL ? yield* toStrValue(args[0]) : str('');
  return yield* join(self, separator);
});

function* joinValue(value: Value, separator: RString, seen: Set<RArray>): Gen<RString> {
  if (value instanceof RString) return value;
  if (value instanceof RArray) return yield* join(value, separator, seen);
  if (respondsTo(value, 'to_str', true)) {
    const converted = yield* callMethod(value, 'to_str', [], undefined, undefined, { fcall: true });
    if (converted instanceof RString) return converted;
    if (converted !== NIL) throw joinStringConversionError(value, converted);
  }
  const converted = yield* tryAry(value);
  return converted
    ? yield* whileHeld(converted, function* () {
        return yield* join(converted, separator, seen);
      })
    : yield* toSValue(value);
}

function joinStringConversionError(value: Value, converted: Value): unknown {
  const name = realClassOf(value).name;
  return typeError(`can't convert ${name} to String (${name}#to_str gives ${realClassOf(converted).name})`);
}
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
def('Array', 'deconstruct', 0, (self: RArray) => self);
def('Array', 'fetch_values', [0, -1], function* (self: RArray, indexes, block) {
  const values: Value[] = [];
  for (const index of indexes) values.push(yield* callMethod(self, 'fetch', [index], undefined, block));
  return arr(values);
});
def('Array', 'rfind', [0, 1], function* (self: RArray, args, block) {
  if (!block) return makeEnumerator(self, 'rfind', args);
  for (let index = self.items.length - 1; index >= 0; index--) {
    if (index >= self.items.length) continue;
    const item = self.items[index];
    if (truthy(yield* call(block, item))) return item;
  }
  return args.length > 0 && args[0] !== NIL ? yield* callMethod(args[0], 'call', []) : NIL;
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
  return yield* zipCollections(self, others, block);
});
def('Array', 'product', [0, -1], function* (self: RArray, others, block) {
  const arrays = [[...self.items]];
  for (const other of others) arrays.push([...(yield* toAry(other)).items]);
  if (block) {
    if (arrays.some((items) => items.length === 0)) return self;
    const indexes = arrays.map(() => 0);
    for (;;) {
      rt().spend();
      yield* call(block, arr(arrays.map((items, index) => items[indexes[index]])), false);
      let position = indexes.length - 1;
      while (position >= 0 && ++indexes[position] === arrays[position].length) {
        indexes[position] = 0;
        position--;
      }
      if (position < 0) return self;
    }
  }
  rt().chargeSlots(self.items.length);
  let tuples: Value[][] = self.items.map((item) => [item]);
  for (const items of arrays.slice(1)) {
    const size = tuples.length * items.length;
    grow(size);
    rt().chargeSlots(size);
    const next: Value[][] = [];
    for (const tuple of tuples) for (const item of items) next.push([...tuple, item]);
    tuples = next;
  }
  return arr(tuples.map((tuple) => arr(tuple)));
});

function* combinations(items: Value[], size: number, visit: (combination: Value[]) => Gen<void>): Gen<void> {
  if (size < 0 || size > items.length) return;
  const indices = Array.from({ length: size }, (_, index) => index);
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
  const limit = items.length;
  const next = Array.from({ length: limit }, (_, index) => index + 1);
  const previous = Array.from({ length: limit }, (_, index) => index - 1);
  const selected: number[] = [];
  const successors: number[] = [];
  const predecessors: number[] = [];
  const following: number[] = [];
  let head = 0;
  let depth = 0;
  const restore = (level: number): void => {
    const index = selected[level];
    const before = predecessors[level];
    const after = following[level];
    if (before < 0) head = index;
    else next[before] = index;
    if (after < limit) previous[after] = index;
    previous[index] = before;
    next[index] = after;
  };
  successors[0] = head;
  while (depth >= 0) {
    if (depth === size) {
      rt().spend();
      yield* visit(selected.map((index) => items[index]));
      depth--;
      if (depth >= 0) restore(depth);
      continue;
    }
    const index = successors[depth];
    if (index === limit) {
      depth--;
      if (depth >= 0) restore(depth);
      continue;
    }
    const before = previous[index];
    const after = next[index];
    successors[depth] = after;
    predecessors[depth] = before;
    following[depth] = after;
    if (before < 0) head = after;
    else next[before] = after;
    if (after < limit) previous[after] = before;
    selected[depth] = index;
    depth++;
    successors[depth] = head;
  }
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
// code-gauge-allow duplicateLines 16 -- Both repeated iterators yield index tuples, but their carry rules differ.
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
// code-gauge-allow duplicateLines 16 -- Both repeated iterators yield index tuples, but their carry rules differ.
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
  for (let index = 0; index < self.items.length; index++) {
    rt().spend();
    const item = self.items[index];
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
def('Array', ['inject', 'reduce'], [0, -1], (self: RArray, args, block) => inject(self, args, block));
def('Array', 'max', [0, 1], function* (self: RArray, args, block) {
  if (args.length > 0 && args[0] !== NIL) return yield* nmin(self.items, args[0], undefined, block, true);
  if (!block) return yield* arrayExtreme(self, true);
  let result: Value | undefined;
  for (const item of self.items) {
    if (result === undefined) result = item;
    else if ((yield* blockCompare(block, item, result)) > 0) result = item;
  }
  return result ?? NIL;
});
def('Array', 'min', [0, 1], function* (self: RArray, args, block) {
  if (args.length > 0 && args[0] !== NIL) return yield* nmin(self.items, args[0], undefined, block, false);
  if (!block) return yield* arrayExtreme(self, false);
  let result: Value | undefined;
  for (const item of self.items) {
    if (result === undefined) result = item;
    else if ((yield* blockCompare(block, item, result)) < 0) result = item;
  }
  return result ?? NIL;
});
def('Array', 'minmax', 0, function* (self: RArray, _args, block) {
  if (block) return yield* enumerableMinmax(self, block);
  return arr([yield* arrayExtreme(self, false), yield* arrayExtreme(self, true)]);
});

function* arrayExtreme(self: RArray, wantMax: boolean): Gen {
  let result: Value | undefined;
  for (const item of self.items) {
    if (result === undefined) result = item;
    else {
      const order = yield* compareValues(result, item);
      if (wantMax ? order < 0 : order > 0) result = item;
    }
  }
  return result ?? NIL;
}

def('Array', 'cycle', [0, 1], function* (self: RArray, args, block) {
  if (!block) return makeEnumerator(self, 'cycle', args);
  const times = args.length > 0 && args[0] !== NIL ? yield* toInt(args[0]) : undefined;
  if (times !== undefined && times <= 0n) return NIL;
  for (let round = 0n; times === undefined || round < times; round++) {
    if (self.items.length === 0) return NIL;
    for (let index = 0; index < self.items.length; index++) yield* call(block, self.items[index], false);
  }
  return NIL;
});
// code-gauge-allow functionCognitiveComplexity 16 -- bsearch handles Boolean search and numeric search modes with their distinct return rules.
def('Array', 'bsearch', 0, function* (self: RArray, _args, block) {
  if (!block) return makeEnumerator(self, 'bsearch', []);
  return yield* arrayBsearch(self, block, false);
});
def('Array', 'bsearch_index', 0, function* (self: RArray, _args, block) {
  if (!block) return makeEnumerator(self, 'bsearch_index', []);
  return yield* arrayBsearch(self, block, true);
});

function* arrayBsearch(self: RArray, block: RProc, indexOnly: boolean): Gen {
  let low = 0;
  let high = self.items.length;
  let found: number | undefined;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const result = yield* call(block, self.items[middle] ?? NIL);
    high = Math.min(high, self.items.length);
    if (result === true) {
      found = middle;
      high = middle;
    } else if (result === false || result === NIL) {
      low = middle + 1;
    } else if (typeof result === 'bigint' || typeof result === 'number') {
      if (Number(result) === 0)
        return middle >= self.items.length ? NIL : indexOnly ? BigInt(middle) : self.items[middle];
      if (Number(result) < 0) high = middle;
      else low = middle + 1;
    } else {
      throw typeError(`wrong argument type ${yield* inspect(result)} (must be numeric, true, false or nil)`);
    }
  }
  return found === undefined || found >= self.items.length ? NIL : indexOnly ? BigInt(found) : self.items[found];
}
def('Array', 'to_h', 0, function* (self: RArray, _args, block) {
  const hash = newHash();
  return yield* whileHeld(hash, function* () {
    for (const [index, item] of self.items.entries()) {
      const value = block ? yield* call(block, item) : item;
      const pair = yield* tryAry(value);
      if (!pair) {
        throw typeError(
          `wrong element type ${value === NIL ? 'nil' : realClassOf(value).name} at ${index} (expected array)`
        );
      }
      if (pair.items.length !== 2) {
        throw argumentError(`wrong array length at ${index} (expected 2, was ${pair.items.length})`);
      }
      yield* hashSet(hash, pair.items[0], pair.items[1]);
    }
    return hash;
  });
});

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

function sampledItems(items: Value[], indexes: number[]): RArray {
  return arr(indexes.flatMap((index) => (items[index] === undefined ? [] : [items[index]])));
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
      return self.items[index] ?? NIL;
    }
    let n = yield* toIndex(args[0]);
    if (n < 0) throw argumentError('negative sample number');
    const length = items.length;
    if (n > length) n = length;
    if (n <= 0) return arr([]);
    if (n <= 10) {
      const draws: number[] = [];
      for (let i = 0; i < n; i++) draws.push(yield* randomIndex(randomizer, length - i));
      if (n === 1) return sampledItems(self.items, [draws[0]]);
      if (n === 2) {
        const i = draws[0];
        let j = draws[1];
        if (j >= i) j++;
        return sampledItems(self.items, [i, j]);
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
        return sampledItems(self.items, [i, j, k]);
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
      return sampledItems(self.items, chosen);
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
      if (self.items.length < n) return arr([]);
      for (let i = 0; i < n; i++) {
        const j = draws[i];
        const i2 = memo.get(i) ?? i;
        const j2 = memo.get(j) ?? j;
        memo.set(j, i2);
        const item = self.items[j2];
        if (item !== undefined) result.push(item);
      }
      return arr(result);
    }
    const result = [...items];
    const draws: number[] = [];
    for (let i = 0; i < n; i++) {
      draws.push((yield* randomIndex(randomizer, length - i)) + i);
    }
    for (let i = 0; i < Math.min(n, result.length); i++) {
      const j = draws[i];
      if (j >= result.length) continue;
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
