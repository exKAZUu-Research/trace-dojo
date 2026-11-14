import {
  combinedStringEncoding,
  compareValues,
  inspect,
  inspectRange,
  numericCompare,
  rangeCovers,
  rEql,
  rEquals,
  searchNumericSign,
  spaceship,
  toIndex,
  toSValue,
} from './conversions';
import { def, sdef } from './define';
import { argumentError, rangeError, typeError } from './errors';
import { floatStepCount, fusedMultiplyAdd } from './floatMath';
import { structuralHashValue } from './hashes';
import { callBlock, callMethod, type Gen, invoke, makeRange, nativeProc, respondsTo, truthyValue } from './interp';
import { rangeHelpers, STOP, sum, toArray } from './libEnumerable';
import { makeEnumerator, sizedEnumerator } from './libEnumerator';
import { kernelFloat } from './libNumeric';
import { isRubyFloat, isRubyNumber, NIL, type RProc, RRange, RString, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { successorBytes } from './stringTransforms';
import { arr, isA, realClassOf, str, stringBytes, stringFromBytes } from './values';

type Visit = (value: Value) => Gen<unknown>;

/** Visits a range's members: integers counting up, strings by `succ`, or what `succ` gives for other objects. */
function* iterateRange(range: RRange, visit: Visit): Gen<void> {
  const { begin } = range;
  if (typeof begin === 'bigint') yield* iterateIntegers(range, begin, visit);
  else if (begin instanceof RString) yield* iterateStrings(range, begin, visit);
  else if (begin === NIL || isRubyFloat(begin) || !respondsToSucc(begin)) {
    throw typeError(`can't iterate from ${realClassOf(begin).name}`);
  } else {
    yield* iterateSuccessors(range, visit);
  }
}

// code-gauge-allow functionCognitiveComplexity 19 -- Integer Range bounds use exact primitive comparison or Ruby numeric coercion.
function* iterateIntegers(range: RRange, begin: bigint, visit: Visit): Gen<void> {
  const runtime = rt();
  const { end, exclusive } = range;
  const inRange = function* (value: bigint): Gen<boolean> {
    if (end === NIL) return true;
    if (isRubyFloat(end)) {
      const order = numericCompare(value, Number(end));
      return order !== undefined && (exclusive ? order < 0 : order <= 0);
    }
    if (typeof end === 'bigint') return exclusive ? value < end : value <= end;
    const order = yield* spaceship(value, end);
    return order !== undefined && (exclusive ? order < 0 : order <= 0);
  };
  for (let value = begin; yield* inRange(value); value++) {
    runtime.spend();
    if ((yield* visit(value)) === STOP) return;
  }
}

function* iterateStrings(range: RRange, begin: RString, visit: Visit): Gen<void> {
  const { end, exclusive } = range;
  if (end === NIL) {
    for (
      let current = stringFromBytes(stringBytes(begin), begin.binary);
      ;
      current = stringFromBytes(successorBytes(stringBytes(current), begin.binary), begin.binary)
    ) {
      rt().spend();
      if ((yield* visit(current)) === STOP) return;
    }
  }
  if (!(end instanceof RString)) throw typeError(`can't iterate from ${realClassOf(begin).name}`);
  const stop = {};
  const block = nativeProc(1, function* ([value]) {
    if ((yield* visit(value)) === STOP) throw stop;
    return NIL;
  });
  try {
    yield* callMethod(begin, 'upto', [end, exclusive], undefined, block);
  } catch (error) {
    if (error !== stop) throw error;
  }
}

function* iterateSuccessors(range: RRange, visit: Visit): Gen<void> {
  const { end, exclusive } = range;
  let current: Value = range.begin;
  for (;;) {
    rt().spend();
    let atEnd = false;
    if (end !== NIL) {
      const order = yield* compareValues(current, end);
      if (order > 0 || (exclusive && order === 0)) return;
      atEnd = order === 0;
    }
    if ((yield* visit(current)) === STOP) return;
    if (atEnd) return;
    current = yield* callMethod(current, 'succ', []);
  }
}

function respondsToSucc(value: Value): boolean {
  return respondsTo(value, 'succ');
}

rangeHelpers.iterateRange = iterateRange;

def('Range', 'each', 0, function* (self: RRange, _args, block) {
  if (!block) return sizedEnumerator(self, 'each', [], () => rangeSize(self));
  yield* iterateRange(self, (value) => callBlock(block, [value], false));
  return self;
});
def('Range', 'reverse_each', 0, function* (self: RRange, _args, block) {
  if (!block) return makeEnumerator(self, 'reverse_each', []);
  if (typeof self.end === 'bigint' && (typeof self.begin === 'bigint' || self.begin === NIL)) {
    const last = self.exclusive ? self.end - 1n : self.end;
    for (let value = last; self.begin === NIL || value >= (self.begin as bigint); value--) {
      yield* callBlock(block, [value], false);
    }
    return self;
  }
  const items = yield* toArray(self);
  for (let index = items.length - 1; index >= 0; index--) yield* callBlock(block, [items[index]], false);
  return self;
});
def('Range', ['to_a', 'to_ary', 'entries'], 0, function* (self: RRange) {
  if (self.end === NIL) throw rangeError('cannot convert endless range to an array');
  return arr(yield* toArray(self));
});
def('Range', ['begin', 'first'], [0, 1], function* (self: RRange, args) {
  if (self.begin === NIL) throw rangeError('cannot get the first element of beginless range');
  if (args.length === 0) {
    return self.begin;
  }
  const count = yield* toIndex(args[0]);
  if (count < 0) throw argumentError('negative array size (or size too big)');
  const items: Value[] = [];
  rt().heldArrays.push(items);
  try {
    yield* iterateRange(self, function* (value) {
      if (count === 0) return STOP;
      items.push(value);
      yield* [];
      return items.length >= count ? STOP : undefined;
    });
  } finally {
    rt().heldArrays.pop();
  }
  return arr(items);
});
def('Range', 'begin', 0, (self: RRange) => self.begin);
def('Range', 'end', 0, (self: RRange) => self.end);
def('Range', 'last', [0, 1], function* (self: RRange, args) {
  if (args.length === 0) {
    if (self.end === NIL) throw rangeError('cannot get the last element of endless range');
    return self.end;
  }
  if (self.end === NIL) throw rangeError('cannot get the last element of endless range');
  const count = yield* toIndex(args[0]);
  if (count < 0) throw argumentError('negative array size');
  if (typeof self.begin === 'bigint' && typeof self.end === 'bigint') {
    const final = self.exclusive ? self.end - 1n : self.end;
    const start = self.begin > final - BigInt(count) + 1n ? self.begin : final - BigInt(count) + 1n;
    const items: Value[] = [];
    for (let value = start; value <= final; value++) {
      rt().spend();
      items.push(value);
    }
    return arr(items);
  }
  const items = yield* toArray(self);
  return arr(count === 0 ? [] : items.slice(-count));
});
def('Range', 'min', [0, 1], function* (self: RRange, args, block) {
  if (self.begin === NIL) throw rangeError('cannot get the minimum of beginless range');
  if (block || args.length > 0) return yield* callEnumerable(self, 'min', args, block);
  const order = self.end === NIL ? -1 : yield* spaceship(self.begin, self.end);
  if (order === undefined || order > 0 || (order === 0 && self.exclusive)) return NIL;
  return self.begin;
});
def('Range', 'max', [0, 1], function* (self: RRange, args, block) {
  if (self.begin === NIL && !block && args.length === 0) {
    if (self.end === NIL) throw rangeError('cannot get the maximum of endless range');
    if (!self.exclusive) return self.end;
    if (typeof self.end === 'bigint') return self.end - 1n;
    if (isRubyFloat(self.end)) throw typeError('cannot exclude non Integer end value');
    throw rangeError('cannot get the maximum of beginless range with custom comparison method');
  }
  if (block || args.length > 0) return yield* callEnumerable(self, 'max', args, block);
  if (self.end === NIL) throw rangeError('cannot get the maximum of endless range');
  const order = yield* spaceship(self.begin, self.end);
  if (order === undefined || order > 0 || (order === 0 && self.exclusive)) return NIL;
  if (self.exclusive) {
    if (typeof self.end === 'bigint' && typeof self.begin === 'bigint') return self.end - 1n;
    if (isRubyFloat(self.end)) throw typeError('cannot exclude non Integer end value');
    throw typeError('cannot exclude end value with non Integer begin value');
  }
  return self.end;
});

function* callEnumerable(self: RRange, name: string, args: Value[], block: RProc | undefined): Gen {
  const method = rt().c.Enumerable.methods.get(name);
  if (!method) throw new Error(`Enumerable#${name} is missing`);
  return yield* invoke(method, self, args, undefined, block, true);
}

def('Range', 'sum', [0, 1], function* (self: RRange, args, block) {
  if (!block && typeof self.begin === 'bigint' && typeof self.end === 'bigint') {
    const last = self.exclusive ? self.end - 1n : self.end;
    const initial = args.length > 0 ? args[0] : 0n;
    if (last < self.begin) return initial;
    const total = ((self.begin + last) * (last - self.begin + 1n)) / 2n;
    if (typeof initial !== 'bigint' && typeof initial !== 'number')
      return Number(yield* kernelFloat(initial, undefined)) + Number(total);
    return yield* callMethod(initial, '+', [total]);
  }
  return yield* sum(self, args, block);
});

// code-gauge-allow functionCognitiveComplexity 21 -- Range size handles Integer, Float, beginless, endless, and exclusive bounds.
export function rangeSize(range: RRange): Value {
  const { begin, end, exclusive } = range;
  if (typeof begin === 'bigint') {
    if (end === NIL) return Number.POSITIVE_INFINITY;
    if (typeof end === 'bigint') {
      const size = end - begin + (exclusive ? 0n : 1n);
      return size > 0n ? size : 0n;
    }
    if (isRubyFloat(end)) {
      const limit = Number(end);
      if (limit === Number.POSITIVE_INFINITY) return end;
      if (limit === Number.NEGATIVE_INFINITY) return 0n;
      const last = Math.floor(limit);
      let size = BigInt(last) - begin + 1n;
      if (exclusive && last === limit) size -= 1n;
      return size > 0n ? size : 0n;
    }
  }
  if (isRubyFloat(begin)) throw typeError(`can't iterate from Float`);
  return NIL;
}

def('Range', 'size', 0, (self: RRange) => rangeSize(self));
def('Range', 'count', [0, 1], function* (self: RRange, args, block) {
  if (args.length === 0 && !block) {
    const size = rangeSize(self);
    if (size !== NIL) return size;
  }
  return yield* callEnumerable(self, 'count', args, block);
});
def('Range', 'exclude_end?', 0, (self: RRange) => self.exclusive);
def('Range', ['include?', 'member?'], 1, function* (self: RRange, [value]) {
  if (value instanceof RRange) return false;
  if (isRubyNumber(self.begin) || self.begin === NIL) return yield* rangeCovers(self, value);
  let found = false;
  yield* iterateRange(self, function* (item) {
    if (yield* rEquals(item, value)) {
      found = true;
      return STOP;
    }
  });
  return found;
});
def('Range', '===', 1, function* (self: RRange, [value]) {
  if (value instanceof RRange) return false;
  return yield* rangeCovers(self, value);
});
def('Range', 'cover?', 1, function* (self: RRange, [value]) {
  if (value instanceof RRange) {
    const coversBegin = value.begin === NIL ? self.begin === NIL : yield* rangeCovers(self, value.begin);
    if (!coversBegin) return false;
    if (value.end === NIL) return self.end === NIL;
    if (self.end === NIL) return true;
    const order = yield* spaceship(value.end, self.end);
    if (order === undefined) return false;
    if (self.exclusive && !value.exclusive) return order < 0;
    return order <= 0;
  }
  return yield* rangeCovers(self, value);
});
def('Range', 'inspect', 0, function* (self: RRange) {
  return str(yield* inspectRange(self));
});
def('Range', 'to_s', 0, function* (self: RRange) {
  const parts = [
    self.begin === NIL ? str('') : yield* toSValue(self.begin),
    str(self.exclusive ? '...' : '..'),
    self.end === NIL ? str('') : yield* toSValue(self.end),
  ];
  let binary = false;
  let ascii = true;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (const part of parts) {
    binary = combinedStringEncoding(binary, ascii, part);
    const bytes = stringBytes(part);
    chunks.push(bytes);
    length += bytes.length;
    ascii &&= bytes.every((byte) => byte < 0x80);
  }
  rt().checkStringLength(length);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const bytes of chunks) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return stringFromBytes(result, binary);
});
def('Range', 'bsearch', 0, function* (self: RRange, _args, block) {
  if (!block) return makeEnumerator(self, 'bsearch', []);
  if ((self.begin !== NIL && !isRubyNumber(self.begin)) || (self.end !== NIL && !isRubyNumber(self.end)))
    throw typeError(`can't do binary search for ${realClassOf(self.begin).name}`);
  if (isRubyFloat(self.begin) || isRubyFloat(self.end)) {
    if (self.begin === NIL || self.end === NIL) throw new UnsupportedFeatureError('無限の浮動小数点範囲の二分探索');
    return yield* bsearchFloat(Number(self.begin), Number(self.end), self.exclusive, block);
  }
  return yield* bsearchInteger(self.begin, self.end, self.exclusive, block);
});
def('Range', 'overlap?', 1, function* (self: RRange, [other]) {
  if (!(other instanceof RRange)) throw typeError(`wrong argument type ${realClassOf(other).name} (expected Range)`);
  if ((yield* rangeIsEmpty(self)) || (yield* rangeIsEmpty(other))) return false;
  if (self.end !== NIL && other.begin !== NIL) {
    const order = yield* compareValues(self.end, other.begin);
    if (order < 0 || (order === 0 && self.exclusive)) return false;
  }
  if (other.end !== NIL && self.begin !== NIL) {
    const order = yield* compareValues(other.end, self.begin);
    if (order < 0 || (order === 0 && other.exclusive)) return false;
  }
  return true;
});

function* rangeIsEmpty(value: RRange): Gen<boolean> {
  if (value.begin === NIL || value.end === NIL) return false;
  const order = yield* compareValues(value.begin, value.end);
  return order > 0 || (order === 0 && value.exclusive);
}

function* bsearchInteger(begin: bigint | typeof NIL, end: bigint | typeof NIL, exclusive: boolean, block: RProc): Gen {
  let low: bigint;
  let high: bigint;
  if (begin === NIL) {
    high = (end as bigint) - BigInt(exclusive);
    const last = yield* bsearchDecision(block, high);
    if (last === 'found') return high;
    if (last === 'right') return NIL;
    let distance = 1n;
    for (;;) {
      const decision = yield* bsearchDecision(block, high - distance);
      if (decision === 'found') return high - distance;
      if (decision === 'right') {
        low = high - distance + 1n;
        break;
      }
      distance *= 2n;
    }
  } else {
    low = begin as bigint;
    if (end === NIL) {
      const first = yield* bsearchDecision(block, low);
      if (first !== 'right') return first === 'found' || first === 'left' ? low : NIL;
      let distance = 1n;
      for (;;) {
        high = low + distance;
        const decision = yield* bsearchDecision(block, high);
        if (decision === 'found') return high;
        if (decision === 'left') break;
        distance *= 2n;
      }
    } else high = (end as bigint) - BigInt(exclusive);
  }
  let found: Value = NIL;
  while (low <= high) {
    const middle = low + (high - low) / 2n;
    const decision = yield* bsearchDecision(block, middle);
    if (decision === 'found') return middle;
    if (decision === 'left') {
      found = middle;
      high = middle - 1n;
    } else low = middle + 1n;
  }
  return found;
}

function* bsearchFloat(begin: number, end: number, exclusive: boolean, block: RProc): Gen {
  const view = new DataView(new ArrayBuffer(8));
  const sign = 1n << 63n;
  const mask = (1n << 64n) - 1n;
  const ordered = (value: number): bigint => {
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    return bits & sign ? ~bits & mask : bits | sign;
  };
  const number = (bits: bigint): number => {
    view.setBigUint64(0, bits & sign ? bits & ~sign : ~bits & mask);
    return view.getFloat64(0);
  };
  let low = ordered(begin);
  let high = ordered(end) - BigInt(exclusive);
  let found: Value = NIL;
  while (low <= high) {
    const middle = low + (high - low) / 2n;
    const candidate = number(middle);
    const decision = yield* bsearchDecision(block, candidate);
    if (decision === 'found') return candidate;
    if (decision === 'left') {
      found = candidate;
      high = middle - 1n;
    } else low = middle + 1n;
  }
  return found;
}

function* bsearchDecision(block: RProc, value: Value): Gen<'left' | 'right' | 'found'> {
  const result = yield* callBlock(block, [value]);
  if (result === true) return 'left';
  if (result === false || result === NIL) return 'right';
  if (isA(result, rt().c.Numeric)) {
    const sign = yield* searchNumericSign(result);
    return sign === 0 ? 'found' : sign < 0 ? 'left' : 'right';
  }
  throw typeError(`wrong argument type ${yield* inspect(result)} (must be numeric, true, false or nil)`);
}
def('Range', '==', 1, (self: RRange, [other]) => rEquals(self, other));
def('Range', 'eql?', 1, function* (self: RRange, [other]) {
  return (
    other instanceof RRange &&
    self.exclusive === other.exclusive &&
    (yield* rEql(self.begin, other.begin)) &&
    (yield* rEql(self.end, other.end))
  );
});
def('Range', 'hash', 0, function* (self: RRange) {
  return yield* structuralHashValue(self);
});
for (const method of ['step', '%'])
  def('Range', method, [0, 1], function* (self: RRange, args, block) {
    const step = args.length > 0 ? args[0] : 1n;
    const customBegin =
      self.begin !== NIL &&
      typeof self.begin !== 'bigint' &&
      !isRubyFloat(self.begin) &&
      !(self.begin instanceof RString);
    if (typeof step !== 'bigint' && !isRubyFloat(step) && !customBegin && !respondsTo(step, 'coerce', true))
      throw typeError('no implicit conversion of String into Integer');
    if (isRubyNumber(step)) {
      if (Number(step) < 0) throw argumentError("step can't be negative");
      if (Number(step) === 0) throw argumentError("step can't be 0");
    }
    if (!block) return makeEnumerator(self, method, args);
    return yield* stepRange(self, step, block);
  });

function* stepRange(self: RRange, step: Value, block: RProc): Gen {
  const { begin, end } = self;
  if (typeof begin === 'bigint' && typeof step === 'bigint' && (typeof end === 'bigint' || end === NIL)) {
    return yield* stepIntegerRange(self, begin, step, block);
  }
  if (isRubyNumber(begin) && isRubyNumber(step) && (isRubyNumber(end) || end === NIL)) {
    return yield* stepNumericRange(self, Number(begin), Number(step), block);
  }
  if (begin !== NIL && !(begin instanceof RString)) return yield* stepCustomRange(self, step, block);
  if (typeof step !== 'bigint') throw typeError('no implicit conversion of Float into String');
  return yield* stepSuccessorRange(self, step, block);
}

function* stepIntegerRange(self: RRange, begin: bigint, step: bigint, block: RProc): Gen {
  const { end, exclusive } = self;
  for (
    let value = begin;
    end === NIL || (exclusive ? value < (end as bigint) : value <= (end as bigint));
    value += step
  )
    yield* callBlock(block, [value], false);
  return self;
}

function* stepNumericRange(self: RRange, start: number, by: number, block: RProc): Gen {
  const { end, exclusive } = self;
  const count = end === NIL ? Number.POSITIVE_INFINITY : floatStepCount(start, Number(end), by, exclusive);
  if (Number.isNaN(count)) return self;
  for (let index = 0; index < count; index++) {
    rt().spend();
    let value = fusedMultiplyAdd(index, by, start);
    if (end !== NIL) {
      if (exclusive && value >= Number(end)) break;
      if (value > Number(end)) value = Number(end);
    }
    yield* callBlock(block, [value], false);
  }
  return self;
}

function* stepCustomRange(self: RRange, step: Value, block: RProc): Gen {
  const { end, exclusive } = self;
  let value = self.begin;
  if (end !== NIL) {
    const initialOrder = yield* spaceship(value, end);
    if (initialOrder === 0) {
      if (!exclusive) yield* callBlock(block, [value], false);
      return self;
    }
    const next = yield* callMethod(value, '+', [step]);
    yield* spaceship(value, next);
    if (initialOrder === undefined || initialOrder > 0) return self;
  }
  for (;;) {
    rt().spend();
    if (end !== NIL) {
      const order = yield* spaceship(value, end);
      if (order === undefined || order > 0 || (exclusive && order === 0)) break;
      yield* callBlock(block, [value], false);
      if (order === 0) break;
    } else {
      yield* callBlock(block, [value], false);
    }
    value = yield* callMethod(value, '+', [step]);
  }
  return self;
}

function* stepSuccessorRange(self: RRange, step: bigint, block: RProc): Gen {
  let index = 0n;
  yield* iterateRange(self, function* (value) {
    if (index % step === 0n) yield* callBlock(block, [value], false);
    index++;
  });
  return self;
}
sdef('Range', 'new', [2, 3], function* (_self, [begin, end, exclusive = false]) {
  return yield* makeRange(begin, end, truthyValue(exclusive));
});
