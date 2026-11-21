import { LIMITS } from '../interpreter/limits';
import type { Runtime } from './runtime';
import { vmTypeString } from './types';
import type { Value } from './values';

export const BITWISE_OPERATORS: ReadonlySet<string> = new Set(['&', '|', '^', '<<', '>>', '>>>']);

/** Wraps an exact integer to the 64 bits of a Dart `int`. */
export function wrap(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

export function intTruncatingDivide(runtime: Runtime, a: bigint, b: bigint): bigint {
  if (b === 0n) runtime.throwError('IntegerDivisionByZeroException', '', []);
  return wrap(a / b);
}

/** Dart's `%`: the Euclidean remainder, which is never negative. */
export function intModulo(runtime: Runtime, a: bigint, b: bigint): bigint {
  if (b === 0n) runtime.throwError('IntegerDivisionByZeroException', '', []);
  const remainder = a % b;
  if (remainder >= 0n) return remainder;
  return b < 0n ? remainder - b : remainder + b;
}

export function intRemainder(runtime: Runtime, a: bigint, b: bigint): bigint {
  if (b === 0n) runtime.throwError('IntegerDivisionByZeroException', '', []);
  return a % b;
}

export function doubleModulo(a: number, b: number): number {
  if (b === 0) return Number.NaN;
  const remainder = a % b;
  if (remainder === 0) return 0;
  if (remainder > 0) return remainder;
  return b < 0 ? remainder - b : remainder + b;
}

/** `num.~/` on doubles: the truncated quotient, which must fit in an `int`. */
export function doubleTruncatingDivide(runtime: Runtime, a: number, b: number): bigint {
  const quotient = a / b;
  return truncateToInt(runtime, quotient);
}

/** Converts a double to an int as `truncate()` does, throwing for infinities and NaN. */
export function truncateToInt(runtime: Runtime, value: number): bigint {
  if (!Number.isFinite(value)) runtime.throwError('UnsupportedError', '', ['Infinity or NaN toInt']);
  const truncated = BigInt(Math.trunc(value));
  // The VM saturates conversions of doubles beyond the 64-bit range.
  if (truncated > 9_223_372_036_854_775_807n) return 9_223_372_036_854_775_807n;
  if (truncated < -9_223_372_036_854_775_808n) return -9_223_372_036_854_775_808n;
  return truncated;
}

export function shiftLeft(runtime: Runtime, a: bigint, b: bigint): bigint {
  if (b < 0n) runtime.throwError('ArgumentError', '', [b]);
  if (b >= 64n) return 0n;
  return wrap(a << b);
}

export function shiftRight(runtime: Runtime, a: bigint, b: bigint): bigint {
  if (b < 0n) runtime.throwError('ArgumentError', '', [b]);
  if (b >= 64n) return a < 0n ? -1n : 0n;
  return a >> b;
}

export function shiftRightUnsigned(runtime: Runtime, a: bigint, b: bigint): bigint {
  if (b < 0n) runtime.throwError('ArgumentError', '', [b]);
  if (b >= 64n) return 0n;
  return wrap(BigInt.asUintN(64, a) >> b);
}

/** Converts a value of `num` to a double for mixed arithmetic. */
function toDouble(value: bigint | number): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * A binary operator on values whose types are known only at runtime: numbers and strings by their rules, other
 * objects through their operator methods.
 */
export function dynamicBinary(
  runtime: Runtime,
  operator: string,
  a: Value,
  b: Value,
  callRow: number | undefined
): Value {
  if ((typeof a === 'bigint' || typeof a === 'number') && !BITWISE_OPERATORS.has(operator)) {
    if (typeof b !== 'bigint' && typeof b !== 'number') {
      if (operator === '==' || operator === '!=')
        return runtime.invoke(a, operator, { positional: [b], named: undefined }, [], callRow);
      runtime.throwTypeError(
        `type '${vmTypeString(runtime.runtimeTypeOf(b))}' is not a subtype of type 'num' of 'other'`
      );
    }
    return numericBinary(runtime, operator, a, b);
  }
  if (typeof a === 'string' && operator === '+') {
    if (typeof b !== 'string') {
      runtime.throwTypeError(
        `type '${vmTypeString(runtime.runtimeTypeOf(b))}' is not a subtype of type 'String' of 'other'`
      );
    }
    return concatenate(runtime, a, b);
  }
  return runtime.invoke(a, operator, { positional: [b], named: undefined }, [], callRow);
}

export function numericBinary(runtime: Runtime, operator: string, a: bigint | number, b: bigint | number): Value {
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    const result = intBinary(runtime, operator, a, b);
    if (result !== NOT_INT_OPERATOR) return result;
  }
  if (BITWISE_OPERATORS.has(operator)) {
    runtime.throwTypeError(`type 'double' is not a subtype of type 'int' of 'other'`);
  }
  return doubleBinary(runtime, operator, a, b);
}

const NOT_INT_OPERATOR = Symbol('not an int operator');

// code-gauge-allow duplicateLines 45 -- The int and double operators share their shape but not their semantics.
// code-gauge-allow functionNcss 36 -- One case per operator of int.
function intBinary(runtime: Runtime, operator: string, a: bigint, b: bigint): Value | typeof NOT_INT_OPERATOR {
  switch (operator) {
    case '+': {
      return wrap(a + b);
    }
    case '-': {
      return wrap(a - b);
    }
    case '*': {
      return wrap(a * b);
    }
    case '/': {
      return Number(a) / Number(b);
    }
    case '~/': {
      return intTruncatingDivide(runtime, a, b);
    }
    case '%': {
      return intModulo(runtime, a, b);
    }
    case '<': {
      return a < b;
    }
    case '<=': {
      return a <= b;
    }
    case '>': {
      return a > b;
    }
    case '>=': {
      return a >= b;
    }
    case '&': {
      return a & b;
    }
    case '|': {
      return a | b;
    }
    case '^': {
      return a ^ b;
    }
    case '<<': {
      return shiftLeft(runtime, a, b);
    }
    case '>>': {
      return shiftRight(runtime, a, b);
    }
    case '>>>': {
      return shiftRightUnsigned(runtime, a, b);
    }
    default: {
      return NOT_INT_OPERATOR;
    }
  }
}

// code-gauge-allow duplicateLines 36 -- The int and double operators share their shape but not their semantics.
function doubleBinary(runtime: Runtime, operator: string, a: bigint | number, b: bigint | number): Value {
  const x = toDouble(a);
  const y = toDouble(b);
  switch (operator) {
    case '+': {
      return x + y;
    }
    case '-': {
      return x - y;
    }
    case '*': {
      return x * y;
    }
    case '/': {
      return x / y;
    }
    case '~/': {
      if (typeof a === 'bigint' && typeof b === 'bigint') return intTruncatingDivide(runtime, a, b);
      return doubleTruncatingDivide(runtime, x, y);
    }
    case '%': {
      return doubleModulo(x, y);
    }
    case '<': {
      return x < y;
    }
    case '<=': {
      return x <= y;
    }
    case '>': {
      return x > y;
    }
    case '>=': {
      return x >= y;
    }
    default: {
      throw new Error(`Unknown operator ${operator}`);
    }
  }
}

export function concatenate(runtime: Runtime, a: string, b: string): string {
  const length = a.length + b.length;
  if (length > LIMITS.maxStringLength) runtime.throwError('OutOfMemoryError', '', []);
  runtime.spendString(length);
  return a + b;
}
