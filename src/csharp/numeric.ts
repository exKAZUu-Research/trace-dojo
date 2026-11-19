import type { OperandKind } from './bound';
import { CsDecimal, DecimalOverflowError } from './decimal';
import type { SpecialType } from './types';

/** A library exception that the evaluator turns into a C# exception object where the program can see it. */
export class PendingException extends Error {
  constructor(
    /** The exception's full type name, such as `System.DivideByZeroException`. */
    readonly typeName: string,
    readonly exceptionMessage: string | undefined,
    /** For an `ArgumentException`, the name of the parameter. */
    readonly paramName?: string
  ) {
    super(`${typeName}: ${exceptionMessage}`);
  }
}

export const DIVIDE_BY_ZERO = (): PendingException =>
  new PendingException('System.DivideByZeroException', 'Attempted to divide by zero.');
export const ARITHMETIC_OVERFLOW = (): PendingException =>
  new PendingException('System.OverflowException', 'Arithmetic operation resulted in an overflow.');

const DECIMAL_OVERFLOW = 'Value was either too large or too small for a Decimal.';

/** The .NET name in "Value was either too large or too small for an Int32." of each integral type. */
const OVERFLOW_NAMES: Partial<Record<SpecialType, string>> = {
  sbyte: 'an SByte',
  byte: 'an unsigned byte',
  short: 'an Int16',
  ushort: 'a UInt16',
  int: 'an Int32',
  uint: 'a UInt32',
  long: 'an Int64',
  ulong: 'a UInt64',
  char: 'a character',
};

export type NumericValue = number | bigint | CsDecimal;

const BITS: Partial<Record<SpecialType, number>> = {
  sbyte: 8,
  byte: 8,
  short: 16,
  ushort: 16,
  char: 16,
  int: 32,
  uint: 32,
  long: 64,
  ulong: 64,
};
const SIGNED = new Set<SpecialType>(['sbyte', 'short', 'int', 'long']);

export function isBigIntKind(kind: SpecialType): boolean {
  return kind === 'long' || kind === 'ulong';
}

/** Wraps an integer to an integral type's width, as unchecked arithmetic does. */
export function wrapInteger(value: bigint, kind: SpecialType): number | bigint {
  const bits = BITS[kind] ?? 32;
  const wrapped = SIGNED.has(kind) ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
  return isBigIntKind(kind) ? wrapped : Number(wrapped);
}

export function integerRange(kind: SpecialType): [bigint, bigint] {
  const bits = BITS[kind] ?? 32;
  if (SIGNED.has(kind)) return [-(1n << BigInt(bits - 1)), (1n << BigInt(bits - 1)) - 1n];
  return [0n, (1n << BigInt(bits)) - 1n];
}

export function toBigInt(value: NumericValue): bigint {
  if (typeof value === 'bigint') return value;
  if (value instanceof CsDecimal) return value.truncate();
  return BigInt(Math.trunc(value));
}

function isFloatKind(kind: SpecialType): boolean {
  return kind === 'float' || kind === 'double';
}

/**
 * Converts a numeric value between numeric types, as a cast does. `checked` makes integral overflow throw; a
 * conversion from decimal always does, as .NET's does.
 */
// code-gauge-allow functionNcss 50 -- One case per family of source and target types.
export function convertNumeric(value: NumericValue, from: SpecialType, to: SpecialType, checked = false): NumericValue {
  if (to === 'decimal') {
    if (value instanceof CsDecimal) return value;
    if (typeof value === 'bigint') return CsDecimal.fromBigInt(value);
    if (Number.isInteger(value) && !isFloatKind(from)) return CsDecimal.fromBigInt(BigInt(value));
    try {
      return CsDecimal.fromDouble(value, from === 'float' ? 7 : 15);
    } catch (error) {
      if (error instanceof DecimalOverflowError)
        throw new PendingException('System.OverflowException', DECIMAL_OVERFLOW);
      throw error;
    }
  }
  if (to === 'double' || to === 'float') {
    const number =
      value instanceof CsDecimal ? value.toDouble() : typeof value === 'bigint' ? bigIntToFloat(value, to) : value;
    return to === 'float' ? Math.fround(number) : number;
  }
  if (value instanceof CsDecimal) {
    const integer = value.truncate();
    const [min, max] = integerRange(to);
    if (integer < min || integer > max)
      throw new PendingException(
        'System.OverflowException',
        `Value was either too large or too small for ${OVERFLOW_NAMES[to]}.`
      );
    return isBigIntKind(to) ? integer : Number(integer);
  }
  if (typeof value === 'number' && isFloatKind(from)) return floatToIntegral(value, to, checked);
  const integer = typeof value === 'bigint' ? value : BigInt(value);
  if (checked) {
    const [min, max] = integerRange(to);
    if (integer < min || integer > max) throw ARITHMETIC_OVERFLOW();
  }
  return wrapInteger(integer, to);
}

/** Converts a floating-point value to an integral type, which saturates as .NET 9 and later do. */
function floatToIntegral(value: number, to: SpecialType, checked: boolean): number | bigint {
  if (checked) {
    const [min, max] = integerRange(to);
    if (Number.isNaN(value) || Math.trunc(value) < Number(min) - 1 || Math.trunc(value) > Number(max))
      throw ARITHMETIC_OVERFLOW();
  }
  if (to === 'long' || to === 'ulong' || to === 'int' || to === 'uint') {
    if (Number.isNaN(value)) return isBigIntKind(to) ? 0n : 0;
    const [min, max] = integerRange(to);
    const truncated = Math.trunc(value);
    let result: bigint;
    if (truncated <= Number(min)) result = min;
    else if (truncated >= Number(max)) result = max;
    else result = BigInt(truncated);
    return isBigIntKind(to) ? result : Number(result);
  }
  // Narrower types convert through int, then wrap.
  const asInt = floatToIntegral(value, 'int', false) as number;
  return wrapInteger(BigInt(asInt), to);
}

/** Converts a 64-bit integer to the nearest float or double, rounding once as .NET does. */
function bigIntToFloat(value: bigint, to: 'float' | 'double'): number {
  if (to === 'double') return Number(value);
  const magnitude = value < 0n ? -value : value;
  if (magnitude < 1n << 24n) return Number(value);
  const bits = magnitude.toString(2).length;
  const shift = BigInt(bits - 24);
  let mantissa = magnitude >> shift;
  const remainder = magnitude - (mantissa << shift);
  const half = 1n << (shift - 1n);
  if (remainder > half || (remainder === half && (mantissa & 1n) === 1n)) mantissa++;
  const result = Number(mantissa) * 2 ** Number(shift);
  return value < 0n ? -result : result;
}

/** Applies a binary arithmetic or bitwise operator to two operands of the same promoted kind. */
// code-gauge-allow functionNcss 80 -- One case per operator and kind of operand.
export function arithmetic(
  operator: string,
  kind: OperandKind,
  left: NumericValue,
  right: NumericValue,
  checked = false
): NumericValue {
  if (kind === 'decimal') return decimalArithmetic(operator, left as CsDecimal, right as CsDecimal);
  if (kind === 'double' || kind === 'float') {
    const a = left as number;
    const b = right as number;
    const result = floatArithmetic(operator, a, b);
    return kind === 'float' ? Math.fround(result) : result;
  }
  const special = kind as SpecialType;
  const a = typeof left === 'bigint' ? left : BigInt(left as number);
  const b = typeof right === 'bigint' ? right : BigInt(right as number);
  let result: bigint;
  switch (operator) {
    case '+': {
      result = a + b;
      break;
    }
    case '-': {
      result = a - b;
      break;
    }
    case '*': {
      result = a * b;
      break;
    }
    case '/':
    case '%': {
      if (b === 0n) throw DIVIDE_BY_ZERO();
      const [min] = integerRange(special);
      if (SIGNED.has(special) && a === min && b === -1n) throw ARITHMETIC_OVERFLOW();
      result = operator === '/' ? a / b : a % b;
      break;
    }
    case '&': {
      result = a & b;
      break;
    }
    case '|': {
      result = a | b;
      break;
    }
    case '^': {
      result = a ^ b;
      break;
    }
    case '<<':
    case '>>':
    case '>>>': {
      const width = BigInt(BITS[special] ?? 32);
      const count = b & (width - 1n);
      if (operator === '<<') result = a << count;
      else if (operator === '>>') result = a >> count;
      else result = BigInt.asUintN(Number(width), a) >> count;
      break;
    }
    default: {
      throw new Error(`Unknown operator ${operator}`);
    }
  }
  if (checked && ['+', '-', '*'].includes(operator)) {
    const [min, max] = integerRange(special);
    if (result < min || result > max) throw ARITHMETIC_OVERFLOW();
  }
  return wrapInteger(result, special);
}

function floatArithmetic(operator: string, a: number, b: number): number {
  switch (operator) {
    case '+': {
      return a + b;
    }
    case '-': {
      return a - b;
    }
    case '*': {
      return a * b;
    }
    case '/': {
      return a / b;
    }
    case '%': {
      return a % b;
    }
    default: {
      throw new Error(`Unknown operator ${operator}`);
    }
  }
}

function decimalArithmetic(operator: string, a: CsDecimal, b: CsDecimal): CsDecimal {
  try {
    switch (operator) {
      case '+': {
        return a.add(b);
      }
      case '-': {
        return a.subtract(b);
      }
      case '*': {
        return a.multiply(b);
      }
      case '/': {
        if (b.isZero()) throw DIVIDE_BY_ZERO();
        return a.divide(b);
      }
      case '%': {
        if (b.isZero()) throw DIVIDE_BY_ZERO();
        return a.remainder(b);
      }
      default: {
        throw new Error(`Unknown operator ${operator}`);
      }
    }
  } catch (error) {
    if (error instanceof DecimalOverflowError) throw new PendingException('System.OverflowException', DECIMAL_OVERFLOW);
    throw error;
  }
}

/** Compares two numeric operands of the same kind, where NaN compares false to everything. */
export function compareNumeric(operator: string, kind: OperandKind, left: NumericValue, right: NumericValue): boolean {
  if (kind === 'decimal') {
    const order = (left as CsDecimal).compare(right as CsDecimal);
    return relation(operator, order);
  }
  if (typeof left === 'number' && typeof right === 'number') {
    switch (operator) {
      case '==': {
        return left === right;
      }
      case '!=': {
        return left !== right;
      }
      case '<': {
        return left < right;
      }
      case '<=': {
        return left <= right;
      }
      case '>': {
        return left > right;
      }
      default: {
        return left >= right;
      }
    }
  }
  const a = BigInt(left as bigint);
  const b = BigInt(right as bigint);
  return relation(operator, a < b ? -1 : a > b ? 1 : 0);
}

function relation(operator: string, order: number): boolean {
  switch (operator) {
    case '==': {
      return order === 0;
    }
    case '!=': {
      return order !== 0;
    }
    case '<': {
      return order < 0;
    }
    case '<=': {
      return order <= 0;
    }
    case '>': {
      return order > 0;
    }
    default: {
      return order >= 0;
    }
  }
}

/** Negates or complements an operand of a promoted kind. */
export function unaryNumeric(operator: string, kind: OperandKind, value: NumericValue, checked = false): NumericValue {
  if (operator === '+') return value;
  if (kind === 'decimal') return (value as CsDecimal).negate();
  if (kind === 'double' || kind === 'float') return -(value as number);
  const integer = typeof value === 'bigint' ? value : BigInt(value as number);
  if (operator === '~') return wrapInteger(~integer, kind as SpecialType);
  if (checked && integer === integerRange(kind as SpecialType)[0] && SIGNED.has(kind as SpecialType))
    throw ARITHMETIC_OVERFLOW();
  return wrapInteger(-integer, kind as SpecialType);
}

/** The value one more or one less than a value of a numeric type, wrapping as unchecked `++` and `--` do. */
export function stepNumeric(kind: SpecialType, value: NumericValue, delta: 1 | -1): NumericValue {
  if (kind === 'decimal') return arithmetic('+', 'decimal', value, CsDecimal.fromBigInt(BigInt(delta)));
  if (kind === 'double') return (value as number) + delta;
  if (kind === 'float') return Math.fround((value as number) + delta);
  const integer = typeof value === 'bigint' ? value : BigInt(value as number);
  return wrapInteger(integer + BigInt(delta), kind);
}
