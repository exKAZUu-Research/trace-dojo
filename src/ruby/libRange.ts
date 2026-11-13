import { compareValues, inspectRange, rangeCovers, rEql, rEquals, spaceship, toIndex, toS } from './conversions';
import { def, sdef } from './define';
import { argumentError, rangeError, typeError } from './errors';
import { structuralHashValue } from './hashes';
import { callBlock, callMethod, type Gen, invoke, makeRange, nativeProc, respondsTo, truthyValue } from './interp';
import { rangeHelpers, STOP, sum, toArray } from './libEnumerable';
import { makeEnumerator, sizedEnumerator } from './libEnumerator';
import { succ } from './libString';
import { NIL, type RProc, RRange, RString, type Value } from './objects';
import { rt } from './runtime';
import { arr, realClassOf, str } from './values';

type Visit = (value: Value) => Gen<unknown>;

/** Visits a range's members: integers counting up, strings by `succ`, or what `succ` gives for other objects. */
function* iterateRange(range: RRange, visit: Visit): Gen<void> {
  const { begin } = range;
  if (typeof begin === 'bigint') yield* iterateIntegers(range, begin, visit);
  else if (begin instanceof RString) yield* iterateStrings(range, begin, visit);
  else if (begin === NIL || typeof begin === 'number' || !respondsToSucc(begin)) {
    throw typeError(`can't iterate from ${realClassOf(begin).name}`);
  } else {
    yield* iterateSuccessors(range, visit);
  }
}

function* iterateIntegers(range: RRange, begin: bigint, visit: Visit): Gen<void> {
  const runtime = rt();
  const { end, exclusive } = range;
  if (end !== NIL && typeof end !== 'bigint' && typeof end !== 'number') {
    throw typeError(`can't iterate from ${realClassOf(begin).name}`);
  }
  const inRange = (value: bigint): boolean => {
    if (end === NIL) return true;
    if (typeof end === 'number') return exclusive ? Number(value) < end : Number(value) <= end;
    return exclusive ? value < (end as bigint) : value <= (end as bigint);
  };
  for (let value = begin; inRange(value); value++) {
    runtime.spend();
    if ((yield* visit(value)) === STOP) return;
  }
}

function* iterateStrings(range: RRange, begin: RString, visit: Visit): Gen<void> {
  const { end, exclusive } = range;
  if (end === NIL) {
    for (let text = begin.s; ; text = succ(text)) {
      rt().spend();
      if ((yield* visit(str(text))) === STOP) return;
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
    if (end !== NIL) {
      const order = yield* compareValues(current, end);
      if (order > 0 || (exclusive && order === 0)) return;
    }
    if ((yield* visit(current)) === STOP) return;
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
  if (count > 0) {
    yield* iterateRange(self, function* (value) {
      items.push(value);
      yield* [];
      return items.length >= count ? STOP : undefined;
    });
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
  if (count === 0) {
    yield* iterateRange(self, function* () {
      yield* [];
      return STOP;
    });
    return arr([]);
  }
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
    if (typeof self.end === 'number') throw typeError('cannot exclude non Integer end value');
    throw rangeError('cannot get the maximum of beginless range with custom comparison method');
  }
  if (block || args.length > 0) return yield* callEnumerable(self, 'max', args, block);
  if (self.end === NIL) throw rangeError('cannot get the maximum of endless range');
  const order = yield* spaceship(self.begin, self.end);
  if (order === undefined || order > 0 || (order === 0 && self.exclusive)) return NIL;
  if (self.exclusive) {
    if (typeof self.end === 'bigint' && typeof self.begin === 'bigint') return self.end - 1n;
    if (typeof self.end === 'number') throw typeError('cannot exclude non Integer end value');
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
    return yield* callMethod(initial, '+', [total]);
  }
  return yield* sum(self, args, block);
});

// code-gauge-allow functionCognitiveComplexity 21 -- Ruby's method takes these argument forms, which the branches mirror.
function rangeSize(range: RRange): Value {
  const { begin, end, exclusive } = range;
  if (typeof begin === 'bigint') {
    if (end === NIL) return Number.POSITIVE_INFINITY;
    if (typeof end === 'bigint') {
      const size = end - begin + (exclusive ? 0n : 1n);
      return size > 0n ? size : 0n;
    }
    if (typeof end === 'number') {
      if (end === Number.POSITIVE_INFINITY) return end;
      if (end === Number.NEGATIVE_INFINITY) return 0n;
      const last = Math.floor(end);
      let size = BigInt(last) - begin + 1n;
      if (exclusive && last === end) size -= 1n;
      return size > 0n ? size : 0n;
    }
  }
  if (typeof begin === 'number') throw typeError(`can't iterate from Float`);
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
  if (typeof self.begin === 'bigint' || typeof self.begin === 'number' || self.begin === NIL)
    return yield* rangeCovers(self, value);
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
  const begin = self.begin === NIL ? '' : yield* toS(self.begin);
  const end = self.end === NIL ? '' : yield* toS(self.end);
  return str(`${begin}${self.exclusive ? '...' : '..'}${end}`);
});
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
def('Range', ['step', '%'], [0, 1], function* (self: RRange, args, block) {
  const step = args.length > 0 ? args[0] : 1n;
  if (typeof step !== 'bigint' && typeof step !== 'number')
    throw typeError('no implicit conversion of String into Integer');
  if (Number(step) < 0) throw argumentError("step can't be negative");
  if (Number(step) === 0) throw argumentError("step can't be 0");
  if (!block) return makeEnumerator(self, 'step', [step]);
  return yield* stepRange(self, step, block);
});

function* stepRange(self: RRange, step: bigint | number, block: RProc): Gen {
  const { begin, end } = self;
  if (typeof begin === 'bigint' && typeof step === 'bigint' && (typeof end === 'bigint' || end === NIL)) {
    return yield* stepIntegerRange(self, begin, step, block);
  }
  if (
    (typeof begin === 'bigint' || typeof begin === 'number') &&
    (typeof end === 'bigint' || typeof end === 'number' || end === NIL)
  ) {
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
  const n = end === NIL ? Number.POSITIVE_INFINITY : Math.floor((Number(end) - start) / by + 1e-9);
  for (let index = 0; index <= n; index++) {
    rt().spend();
    const value = start + index * by;
    if (end !== NIL && exclusive && value >= Number(end)) break;
    yield* callBlock(block, [value], false);
  }
  return self;
}

function* stepCustomRange(self: RRange, step: bigint | number, block: RProc): Gen {
  const { end, exclusive } = self;
  let value = self.begin;
  if (end !== NIL && !exclusive && (yield* spaceship(value, end)) === 0) {
    yield* callBlock(block, [value], false);
    return self;
  }
  for (;;) {
    rt().spend();
    if (end !== NIL) {
      const order = yield* spaceship(value, end);
      if (order === undefined || order > 0 || (exclusive && order === 0)) break;
    }
    const next = yield* callMethod(value, '+', [step]);
    yield* callBlock(block, [value], false);
    value = next;
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
def('Range', 'dup', 0, (self) => self);
def('Range', 'frozen?', 0, () => true);
sdef('Range', 'new', [2, 3], function* (_self, [begin, end, exclusive = false]) {
  return yield* makeRange(begin, end, truthyValue(exclusive));
});
