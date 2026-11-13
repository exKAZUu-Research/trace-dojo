// `datetime.timedelta`, as CPython's `_datetimemodule.c` implements it.
import { method } from '../define';
import { tupleHash } from '../hashing';
import { exactBinary, floorDivInt, modInt, toIndex, trueDivideInt } from '../numbers';
import { intClass, isInstanceOf, newTuple, NotImplemented, pyError, typeError, typeName } from '../types';
import { type Kwargs, type PyClass, PyInstance, type PyValue } from '../values';
import { datetimeClass, defineComparisons, defineConstants, defineGetters, signOf, valueHash } from './datetimeClasses';

const US_PER_SECOND = 1_000_000n;
const US_PER_DAY = 86_400_000_000n;
const MAX_DAYS = 999_999_999;

export class PyTimedelta extends PyInstance {
  constructor(
    cls: PyClass,
    readonly days: number,
    readonly seconds: number,
    readonly microseconds: number
  ) {
    super(cls);
  }

  get totalMicroseconds(): bigint {
    return BigInt(this.days) * US_PER_DAY + BigInt(this.seconds) * US_PER_SECOND + BigInt(this.microseconds);
  }
}

export const timedeltaClass = datetimeClass('timedelta');

/** A timedelta of `microseconds`, raising OverflowError beyond its range as CPython does. */
export function newTimedelta(microseconds: bigint, cls: PyClass = timedeltaClass): PyTimedelta {
  const days = floorDivInt(microseconds, US_PER_DAY);
  const rest = modInt(microseconds, US_PER_DAY);
  if (days > 2_147_483_647n || days < -2_147_483_648n) {
    throw pyError('OverflowError', 'Python int too large to convert to C int');
  }
  if (days > BigInt(MAX_DAYS) || days < BigInt(-MAX_DAYS)) {
    throw pyError('OverflowError', `days=${days}; must have magnitude <= ${MAX_DAYS}`);
  }
  return new PyTimedelta(cls, Number(days), Number(rest / US_PER_SECOND), Number(rest % US_PER_SECOND));
}

export function isTimedelta(value: PyValue): value is PyTimedelta {
  return value instanceof PyTimedelta;
}

// Construction ------------------------------------------------------------------------------------------------------

const COMPONENTS = ['days', 'seconds', 'microseconds', 'milliseconds', 'minutes', 'hours', 'weeks'] as const;
/** The components in the order CPython accumulates them, with their factors in microseconds. */
const ACCUMULATION: [(typeof COMPONENTS)[number], bigint][] = [
  ['microseconds', 1n],
  ['milliseconds', 1000n],
  ['seconds', US_PER_SECOND],
  ['minutes', 60n * US_PER_SECOND],
  ['hours', 3600n * US_PER_SECOND],
  ['days', US_PER_DAY],
  ['weeks', 7n * US_PER_DAY],
];

timedeltaClass.construct = (cls, args, kwargs) => {
  const values = timedeltaArguments(args, kwargs);
  let total = 0n;
  const leftover = { value: 0 };
  for (const [name, factor] of ACCUMULATION) {
    const value = values.get(name);
    if (value !== undefined) total = accumulate(name, total, value, factor, leftover);
  }
  if (leftover.value !== 0) total += roundLeftover(leftover.value, total);
  return newTimedelta(total, cls);
};

function timedeltaArguments(args: PyValue[], kwargs: Kwargs): Map<string, PyValue> {
  if (args.length + (kwargs?.size ?? 0) > COMPONENTS.length) {
    throw typeError(`__new__() takes at most 7 arguments (${args.length + (kwargs?.size ?? 0)} given)`);
  }
  const values = new Map<string, PyValue>();
  for (const [index, value] of args.entries()) values.set(COMPONENTS[index], value);
  for (const [key, value] of kwargs ?? []) {
    const index = COMPONENTS.indexOf(key as (typeof COMPONENTS)[number]);
    if (index === -1) throw typeError(`__new__() got an unexpected keyword argument '${key}'`);
    if (index < args.length) {
      throw typeError(`argument for __new__() given by name ('${key}') and position (${index + 1})`);
    }
    values.set(key, value);
  }
  return values;
}

/** Adds one component as CPython's `accum` does: exactly for ints, and with float arithmetic for fractions. */
function accumulate(name: string, sofar: bigint, value: PyValue, factor: bigint, leftover: { value: number }): bigint {
  if (isInstanceOf(value, intClass)) return sofar + toIndex(value) * factor;
  if (typeof value !== 'number') {
    throw typeError(`unsupported type for timedelta ${name} component: ${typeName(value)}`);
  }
  const whole = Math.trunc(value);
  const sum = sofar + floatToBigint(whole) * factor;
  const fraction = value - whole;
  if (fraction === 0) return sum;
  const scaled = Number(factor) * fraction;
  const scaledWhole = Math.trunc(scaled);
  leftover.value += scaled - scaledWhole;
  return sum + BigInt(scaledWhole);
}

function floatToBigint(value: number): bigint {
  if (Number.isNaN(value)) throw pyError('ValueError', 'cannot convert float NaN to integer');
  if (!Number.isFinite(value)) throw pyError('OverflowError', 'cannot convert float infinity to integer');
  return BigInt(value);
}

/** Rounds the fractional microseconds left over, halves to even with the whole microseconds counted so far. */
function roundLeftover(leftover: number, total: bigint): bigint {
  let whole = roundHalfAway(leftover);
  if (Math.abs(whole - leftover) === 0.5) {
    const odd = Number(total & 1n);
    whole = 2 * roundHalfAway((leftover + odd) * 0.5) - odd;
  }
  return BigInt(whole);
}

/** C's `round()`, which rounds halves away from zero. */
function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

// Text --------------------------------------------------------------------------------------------------------------

function delta(self: PyValue): PyTimedelta {
  return self as PyTimedelta;
}

export function timedeltaRepr(value: PyTimedelta): string {
  const parts: string[] = [];
  if (value.days !== 0) parts.push(`days=${value.days}`);
  if (value.seconds !== 0) parts.push(`seconds=${value.seconds}`);
  if (value.microseconds !== 0) parts.push(`microseconds=${value.microseconds}`);
  const cls = value.cls;
  return `${cls.typeName ?? cls.name}(${parts.length === 0 ? '0' : parts.join(', ')})`;
}

export function timedeltaStr(value: PyTimedelta): string {
  const { days, seconds, microseconds } = value;
  const time = `${Math.floor(seconds / 3600)}:${pad2(Math.floor(seconds / 60) % 60)}:${pad2(seconds % 60)}`;
  const fraction = microseconds === 0 ? '' : `.${String(microseconds).padStart(6, '0')}`;
  const dayText = days === 0 ? '' : `${days} day${Math.abs(days) === 1 ? '' : 's'}, `;
  return dayText + time + fraction;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

method(timedeltaClass, '__repr__', 'none', 0, 0, (self) => timedeltaRepr(delta(self)));
method(timedeltaClass, '__str__', 'none', 0, 0, (self) => timedeltaStr(delta(self)));
defineGetters(timedeltaClass, {
  days: (self) => BigInt(delta(self).days),
  seconds: (self) => BigInt(delta(self).seconds),
  microseconds: (self) => BigInt(delta(self).microseconds),
});
method(timedeltaClass, 'total_seconds', 'none', 0, 0, (self) =>
  trueDivideInt(delta(self).totalMicroseconds, US_PER_SECOND)
);
valueHash(timedeltaClass, (self) => hashOfMicroseconds(delta(self).totalMicroseconds));
defineConstants(timedeltaClass, () => ({
  min: newTimedelta(BigInt(-MAX_DAYS) * US_PER_DAY),
  max: newTimedelta(BigInt(MAX_DAYS + 1) * US_PER_DAY - 1n),
  resolution: newTimedelta(1n),
}));

/**
 * The hash of a timedelta of `microseconds`, which CPython gives as the hash of its `(days, seconds, microseconds)`
 * state; it hashes an aware datetime or time as the timedelta of its fields minus its offset.
 */
export function hashOfMicroseconds(microseconds: bigint): bigint {
  const rest = modInt(microseconds, US_PER_DAY);
  return tupleHash([floorDivInt(microseconds, US_PER_DAY), rest / US_PER_SECOND, rest % US_PER_SECOND]);
}

// Arithmetic --------------------------------------------------------------------------------------------------------

method(timedeltaClass, '__add__', 'one', 1, 1, (self, [other]) =>
  isTimedelta(other) ? newTimedelta(delta(self).totalMicroseconds + other.totalMicroseconds) : NotImplemented
);
method(timedeltaClass, '__radd__', 'one', 1, 1, (self, [other]) =>
  isTimedelta(other) ? newTimedelta(delta(self).totalMicroseconds + other.totalMicroseconds) : NotImplemented
);
method(timedeltaClass, '__sub__', 'one', 1, 1, (self, [other]) =>
  isTimedelta(other) ? newTimedelta(delta(self).totalMicroseconds - other.totalMicroseconds) : NotImplemented
);
method(timedeltaClass, '__rsub__', 'one', 1, 1, (self, [other]) =>
  isTimedelta(other) ? newTimedelta(other.totalMicroseconds - delta(self).totalMicroseconds) : NotImplemented
);
method(timedeltaClass, '__neg__', 'none', 0, 0, (self) => newTimedelta(-delta(self).totalMicroseconds));
method(timedeltaClass, '__pos__', 'none', 0, 0, (self) => newTimedelta(delta(self).totalMicroseconds));
method(timedeltaClass, '__abs__', 'none', 0, 0, (self) => {
  const total = delta(self).totalMicroseconds;
  return newTimedelta(total < 0n ? -total : total);
});
method(timedeltaClass, '__bool__', 'none', 0, 0, (self) => delta(self).totalMicroseconds !== 0n);
method(timedeltaClass, '__mul__', 'one', 1, 1, (self, [other]) => multiply(delta(self), other));
method(timedeltaClass, '__rmul__', 'one', 1, 1, (self, [other]) => multiply(delta(self), other));
method(timedeltaClass, '__truediv__', 'one', 1, 1, (self, [other]) => trueDivide(delta(self), other));
method(timedeltaClass, '__floordiv__', 'one', 1, 1, (self, [other]) => {
  const total = delta(self).totalMicroseconds;
  if (isTimedelta(other)) return floorDivInt(total, nonZero(other.totalMicroseconds));
  if (isInstanceOf(other, intClass)) return newTimedelta(floorDivInt(total, nonZero(toIndex(other))));
  return NotImplemented;
});
method(timedeltaClass, '__mod__', 'one', 1, 1, (self, [other]) =>
  isTimedelta(other)
    ? newTimedelta(modInt(delta(self).totalMicroseconds, nonZero(other.totalMicroseconds)))
    : NotImplemented
);
method(timedeltaClass, '__divmod__', 'one', 1, 1, (self, [other]) => {
  if (!isTimedelta(other)) return NotImplemented;
  const total = delta(self).totalMicroseconds;
  const divisor = nonZero(other.totalMicroseconds);
  return newTuple([floorDivInt(total, divisor), newTimedelta(modInt(total, divisor))]);
});

function nonZero(value: bigint): bigint {
  if (value === 0n) throw pyError('ZeroDivisionError', 'division by zero');
  return value;
}

function multiply(self: PyTimedelta, other: PyValue): PyValue {
  if (isInstanceOf(other, intClass)) return newTimedelta(self.totalMicroseconds * toIndex(other));
  if (typeof other !== 'number') return NotImplemented;
  const [numerator, denominator] = integerRatio(other);
  return newTimedelta(divideNearest(self.totalMicroseconds * numerator, denominator));
}

function trueDivide(self: PyTimedelta, other: PyValue): PyValue {
  const total = self.totalMicroseconds;
  if (isTimedelta(other)) return trueDivideInt(total, other.totalMicroseconds);
  if (isInstanceOf(other, intClass)) return newTimedelta(divideNearest(total, nonZero(toIndex(other))));
  if (typeof other !== 'number') return NotImplemented;
  const [numerator, denominator] = integerRatio(other);
  return newTimedelta(divideNearest(total * denominator, nonZero(numerator)));
}

/** `float.as_integer_ratio()`. */
function integerRatio(value: number): [bigint, bigint] {
  if (Number.isNaN(value)) throw pyError('ValueError', 'cannot convert NaN to integer ratio');
  if (!Number.isFinite(value)) throw pyError('OverflowError', 'cannot convert Infinity to integer ratio');
  if (value === 0) return [0n, 1n];
  let { mantissa, exponent } = exactBinary(value);
  while ((mantissa & 1n) === 0n && exponent < 0) {
    mantissa >>= 1n;
    exponent++;
  }
  return exponent >= 0 ? [mantissa << BigInt(exponent), 1n] : [mantissa, 1n << BigInt(-exponent)];
}

/** `a / b` rounded to the nearest int, halves to even, as `_PyLong_DivmodNear` rounds. */
export function divideNearest(a: bigint, b: bigint): bigint {
  const quotient = floorDivInt(a, b);
  const remainder = a - quotient * b;
  const twice = 2n * remainder;
  const greater = b > 0n ? twice > b : twice < b;
  const equal = twice === b;
  return greater || (equal && (quotient & 1n) === 1n) ? quotient + 1n : quotient;
}

// Comparison --------------------------------------------------------------------------------------------------------

defineComparisons(timedeltaClass, (self, other) => {
  if (!isTimedelta(other)) return NotImplemented;
  return signOf(delta(self).totalMicroseconds - other.totalMicroseconds);
});
