import {
  type AnyFloat,
  asBigFloat,
  BigFloat,
  compareFloats,
  floatArithmetic,
  type FloatBits,
  floatFromBigInt,
  isInfinite,
  isNaNFloat,
  negate,
  roundTo,
  truncateToBigInt,
} from './floats';
import { ZigPanic } from './runtime';
import { fitsInt, type IntType, maxInt, minInt, wrapInt } from './types';

/** The panic messages of Zig's safety checks (`std.debug.FullPanic`). */
export const PANIC = {
  overflow: 'integer overflow',
  divisionByZero: 'division by zero',
  exactRemainder: 'exact division produced remainder',
  castTruncates: 'integer does not fit in destination type',
  floatToInt: 'integer part of floating point value out of bounds',
  unreachable: 'reached unreachable code',
  nullUnwrap: 'attempt to use null value',
  shiftTooLarge: 'shift amount is greater than the type size',
  leftShiftOverflow: 'left shift overflowed bits',
  rightShiftOverflow: 'right shift overflowed bits',
  invalidEnum: 'invalid enum value',
  forLengths: 'for loop over objects with non-equal lengths',
  memcpyLengths: 'source and destination arguments have non-equal lengths',
  memcpyAlias: '@memcpy arguments alias',
  invalidErrorCode: 'invalid error code',
  noreturnReturned: "'noreturn' function returned",
} as const;

export function panic(message: string): never {
  throw new ZigPanic(message);
}

export function indexOutOfBounds(index: bigint | number, length: number): never {
  throw new ZigPanic(`index out of bounds: index ${index}, len ${length}`);
}

/** Checks that an integer fits its type, as the safety check after an arithmetic operation does. */
export function checked(value: bigint, type: IntType): bigint {
  if (value < minInt(type) || value > maxInt(type)) panic(PANIC.overflow);
  return value;
}

export function saturate(value: bigint, type: IntType): bigint {
  const low = minInt(type);
  const high = maxInt(type);
  return value < low ? low : value > high ? high : value;
}

/** `a / b` for unsigned integers, or for signed ones whose operands the compiler knows to be positive. */
export function divide(a: bigint, b: bigint): bigint {
  if (b === 0n) panic(PANIC.divisionByZero);
  return a / b;
}

export function divTrunc(a: bigint, b: bigint, type: IntType | undefined): bigint {
  if (b === 0n) panic(PANIC.divisionByZero);
  const result = a / b;
  if (type && !fitsInt(result, type)) panic(PANIC.overflow);
  return result;
}

export function divFloor(a: bigint, b: bigint, type: IntType | undefined): bigint {
  if (b === 0n) panic(PANIC.divisionByZero);
  let result = a / b;
  if (a % b !== 0n && a < 0n !== b < 0n) result -= 1n;
  if (type && !fitsInt(result, type)) panic(PANIC.overflow);
  return result;
}

export function divCeil(a: bigint, b: bigint, type: IntType | undefined): bigint {
  if (b === 0n) panic(PANIC.divisionByZero);
  let result = a / b;
  if (a % b !== 0n && a < 0n === b < 0n) result += 1n;
  if (type && !fitsInt(result, type)) panic(PANIC.overflow);
  return result;
}

export function divExact(a: bigint, b: bigint, type: IntType | undefined): bigint {
  if (b === 0n) panic(PANIC.divisionByZero);
  if (a % b !== 0n) panic(PANIC.exactRemainder);
  const result = a / b;
  if (type && !fitsInt(result, type)) panic(PANIC.overflow);
  return result;
}

/** `@rem`: the remainder with the sign of the dividend; Zig checks the divisor at run time only for zero. */
export function rem(a: bigint, b: bigint): bigint {
  if (b === 0n) panic(PANIC.divisionByZero);
  return a % b;
}

/** `@mod`: the remainder with the sign of the divisor. */
export function mod(a: bigint, b: bigint): bigint {
  if (b === 0n) panic(PANIC.divisionByZero);
  const result = a % b;
  return result !== 0n && result < 0n !== b < 0n ? result + b : result;
}

/** Converts an integer to another integer type, as `@intCast` does with its safety check. */
export function intCast(value: bigint, type: IntType): bigint {
  if (!fitsInt(value, type)) panic(PANIC.castTruncates);
  return value;
}

export function truncate(value: bigint, type: IntType): bigint {
  return wrapInt(value, type);
}

/** `@intFromFloat`, which truncates and checks that the integer part fits. */
export function intFromFloat(value: AnyFloat, type: IntType): bigint {
  if (isNaNFloat(value) || isInfinite(value)) panic(PANIC.floatToInt);
  const integer = truncateToBigInt(value);
  if (!fitsInt(integer, type)) panic(PANIC.floatToInt);
  return integer;
}

export function shiftLeft(a: bigint, amount: bigint, type: IntType): bigint {
  if (amount >= BigInt(type.bits)) panic(PANIC.shiftTooLarge);
  return wrapInt(a << amount, type);
}

export function shiftRight(a: bigint, amount: bigint, type: IntType): bigint {
  if (amount >= BigInt(type.bits)) panic(PANIC.shiftTooLarge);
  return a >> amount;
}

export function shiftLeftSaturating(a: bigint, amount: bigint, type: IntType): bigint {
  if (a === 0n) return 0n;
  return saturate(a << amount, type);
}

export function floatValue(value: bigint | AnyFloat, bits: FloatBits): AnyFloat {
  return typeof value === 'bigint' ? floatFromBigInt(value, bits) : value;
}

/** Floating-point arithmetic, where `%` is `@rem` (the result has the dividend's sign). */
export function floatOperation(a: AnyFloat, b: AnyFloat, operator: '+' | '-' | '*' | '/', bits: FloatBits): AnyFloat {
  return floatArithmetic(a, b, operator, bits);
}

export function floatRem(a: AnyFloat, b: AnyFloat, bits: FloatBits): AnyFloat {
  if (typeof a === 'number' && typeof b === 'number') return a % b;
  const x = asBigFloat(a);
  const y = asBigFloat(b);
  if (x.kind !== 'finite' || y.kind !== 'finite' || y.isZero) return new BigFloat(false, 'nan', 0n, 0);
  // a - trunc(a / b) * b, computed exactly.
  const quotient = truncateToBigInt(floatArithmetic(x, y, '/', 128));
  const product = floatArithmetic(floatFromBigInt(quotient, 128), y, '*', 128);
  return roundTo(asBigFloat(floatArithmetic(x, product, '-', 128)), bits);
}

export function floatMod(a: AnyFloat, b: AnyFloat, bits: FloatBits): AnyFloat {
  const remainder = floatRem(a, b, bits);
  const sign = compareFloats(remainder, 0);
  if (sign === undefined || sign === 0) return remainder;
  const divisorSign = compareFloats(b, 0);
  return sign < 0 === (divisorSign !== undefined && divisorSign < 0)
    ? remainder
    : floatArithmetic(remainder, b, '+', bits);
}

export { negate as floatNegate };
