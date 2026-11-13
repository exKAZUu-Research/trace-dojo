import type { BinaryOperator } from './ast';
import { CRuntimeError, overflowError } from './errors';
import { type CType, type FloatType, INT_PROPERTIES, type IntName, type IntType, typeName } from './types';

/**
 * A scalar value: an integer of 32 bits or fewer, a floating-point number, or an address, as a number; a 64-bit
 * integer as a bigint.
 */
export type Scalar = number | bigint;

/** A struct or union as a value: a copy of its bytes and of which of them hold values. */
export interface RecordValue {
  bytes: Uint8Array;
  initialized: Uint8Array;
}

export type Value = Scalar | RecordValue;

export function isRecordValue(value: Value): value is RecordValue {
  return typeof value === 'object';
}

// Conversions -------------------------------------------------------------------------------------------------------

/** Wraps a number to a 32-bit signed integer, as C's conversion to int does on two's complement machines. */
export function toInt32(value: number): number {
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps to 32 bits; Math.trunc does not.
  return value | 0;
}

/** Wraps an integer to the width and signedness of a type of 32 bits or fewer, as conversions do. */
export function wrapNarrow(value: number, name: IntName): number {
  switch (name) {
    case 'bool': {
      return value === 0 ? 0 : 1;
    }
    case 'char':
    case 'schar': {
      return (value << 24) >> 24;
    }
    case 'uchar': {
      return value & 0xff;
    }
    case 'short': {
      return (value << 16) >> 16;
    }
    case 'ushort': {
      return value & 0xff_ff;
    }
    case 'int': {
      return toInt32(value);
    }
    default: {
      return value >>> 0;
    }
  }
}

/** Converts a scalar between types, as C's implicit and explicit conversions do. */
export function convertScalar(value: Scalar, from: CType, to: CType): Scalar {
  if (to.kind === 'int') return toInteger(value, from, to);
  if (to.kind === 'float') {
    // Number rounds a 64-bit integer to the nearest double, ties to even, as C's conversion does.
    const number = Number(value);
    return to.name === 'float' ? Math.fround(number) : number;
  }
  if (to.kind === 'pointer') return typeof value === 'bigint' ? Number(BigInt.asUintN(64, value)) : value;
  return value;
}

function toInteger(value: Scalar, from: CType, to: IntType): Scalar {
  if (from.kind === 'float') return floatToInteger(value as number, to);
  if (to.name === 'bool') return isZero(value) ? 0 : 1;
  const properties = INT_PROPERTIES[to.name];
  if (properties.size === 8) {
    const big = typeof value === 'bigint' ? value : BigInt(value);
    return properties.signed ? BigInt.asIntN(64, big) : BigInt.asUintN(64, big);
  }
  if (typeof value === 'bigint') return wrapNarrow(Number(BigInt.asIntN(32, value)), to.name);
  // An address converted to a narrow integer keeps its low bits.
  if (value > 0xff_ff_ff_ff || value < -0x80_00_00_00)
    return wrapNarrow(Number(BigInt.asIntN(32, BigInt(value))), to.name);
  return wrapNarrow(value, to.name);
}

function floatToInteger(number: number, to: IntType): Scalar {
  if (to.name === 'bool') return number === 0 ? 0 : 1;
  if (Number.isNaN(number)) throw new CRuntimeError('floatToInt');
  const properties = INT_PROPERTIES[to.name];
  const truncated = Math.trunc(number);
  if (properties.size === 8) {
    const limit = properties.signed ? 2 ** 63 : 2 ** 64;
    const low = properties.signed ? -(2 ** 63) : 0;
    // Converting to an integer type that cannot hold the truncated value is undefined behavior.
    if (!(truncated >= low && truncated < limit)) throw new CRuntimeError('floatToInt');
    return BigInt(truncated);
  }
  if (!(truncated >= Number(properties.min) && truncated <= Number(properties.max))) {
    throw new CRuntimeError('floatToInt');
  }
  return truncated === 0 ? 0 : truncated;
}

export function isZero(value: Scalar): boolean {
  return value === 0 || value === 0n;
}

// Arithmetic --------------------------------------------------------------------------------------------------------

type Operation = (left: Scalar, right: Scalar) => Scalar;

const truth = (value: boolean): number => (value ? 1 : 0);

/**
 * The operation of a binary operator on two operands already converted to `type`, which stops the program at the
 * undefined behavior of signed overflow, division by zero, and out-of-range shifts.
 */
export function binaryOperation(operator: BinaryOperator, type: IntType | FloatType): Operation {
  if (type.kind === 'float') return floatOperation(operator, type.name === 'float');
  const { size, signed } = INT_PROPERTIES[type.name];
  const name = typeName(type);
  if (size === 8) return signed ? signed64(operator, name) : unsigned64(operator);
  return signed ? signed32(operator, name) : unsigned32(operator);
}

// code-gauge-allow duplicateLines 21 -- The number and bigint operator paths intentionally mirror each other while retaining distinct host arithmetic.
function floatOperation(operator: BinaryOperator, isFloat: boolean): Operation {
  const round = isFloat ? Math.fround : (value: number): number => value;
  switch (operator) {
    case '+': {
      return (a, b) => round((a as number) + (b as number));
    }
    case '-': {
      return (a, b) => round((a as number) - (b as number));
    }
    case '*': {
      return (a, b) => round((a as number) * (b as number));
    }
    case '/': {
      return (a, b) => round((a as number) / (b as number));
    }
    case '==': {
      return (a, b) => truth(a === b);
    }
    case '!=': {
      return (a, b) => truth(a !== b);
    }
    case '<': {
      return (a, b) => truth(a < b);
    }
    case '<=': {
      return (a, b) => truth(a <= b);
    }
    case '>': {
      return (a, b) => truth(a > b);
    }
    case '>=': {
      return (a, b) => truth(a >= b);
    }
  }
  throw new Error(`No floating-point operator ${operator}`);
}

const INT_MAX = 2_147_483_647;
const INT_MIN = -2_147_483_648;

// code-gauge-allow functionCognitiveComplexity 25 -- One case per operator, with C's undefined behavior.
// code-gauge-allow functionNcss 36 -- Keep the signed 32-bit operator dispatch together; host-number overflow rules differ from bigint arithmetic.
function signed32(operator: BinaryOperator, name: string): Operation {
  const checked = (result: number): number => {
    if (result > INT_MAX || result < INT_MIN) throw overflowError(name);
    return result;
  };
  switch (operator) {
    case '+': {
      return (a, b) => checked((a as number) + (b as number));
    }
    case '-': {
      return (a, b) => checked((a as number) - (b as number));
    }
    case '*': {
      return (a, b) => checked((a as number) * (b as number) || 0);
    }
    case '/': {
      return (a, b) => {
        if (b === 0) throw new CRuntimeError('divisionByZero');
        if (a === INT_MIN && b === -1) throw overflowError(name);
        return Math.trunc((a as number) / (b as number)) || 0;
      };
    }
    case '%': {
      return (a, b) => {
        if (b === 0) throw new CRuntimeError('divisionByZero');
        if (a === INT_MIN && b === -1) throw overflowError(name);
        return (a as number) % (b as number) || 0;
      };
    }
    case '<<': {
      return (a, b) => {
        checkShift(b, 32);
        // C99 leaves shifting a negative value undefined, but K&R's examples rely on C89's two's complement result.
        return checked((a as number) * 2 ** (b as number));
      };
    }
    case '>>': {
      return (a, b) => {
        checkShift(b, 32);
        return (a as number) >> (b as number);
      };
    }
    default: {
      return bitwiseOrComparison(operator, toInt32);
    }
  }
}

function unsigned32(operator: BinaryOperator): Operation {
  switch (operator) {
    case '+': {
      return (a, b) => ((a as number) + (b as number)) >>> 0;
    }
    case '-': {
      return (a, b) => ((a as number) - (b as number)) >>> 0;
    }
    case '*': {
      return (a, b) => Math.imul(a as number, b as number) >>> 0;
    }
    case '/': {
      return (a, b) => {
        if (b === 0) throw new CRuntimeError('divisionByZero');
        return Math.floor((a as number) / (b as number));
      };
    }
    case '%': {
      return (a, b) => {
        if (b === 0) throw new CRuntimeError('divisionByZero');
        return (a as number) % (b as number);
      };
    }
    case '<<': {
      return (a, b) => {
        checkShift(b, 32);
        return ((a as number) << (b as number)) >>> 0;
      };
    }
    case '>>': {
      return (a, b) => {
        checkShift(b, 32);
        return (a as number) >>> (b as number);
      };
    }
    default: {
      return bitwiseOrComparison(operator, (value) => value >>> 0);
    }
  }
}

// code-gauge-allow duplicateLines 16 -- The number and bigint operator paths intentionally mirror each other while retaining distinct host arithmetic.
function bitwiseOrComparison(operator: BinaryOperator, wrap: (value: number) => number): Operation {
  switch (operator) {
    case '&': {
      return (a, b) => wrap((a as number) & (b as number));
    }
    case '|': {
      return (a, b) => wrap((a as number) | (b as number));
    }
    case '^': {
      return (a, b) => wrap((a as number) ^ (b as number));
    }
    default: {
      return comparison(operator);
    }
  }
}

// code-gauge-allow duplicateLines 21 -- The number and bigint operator paths intentionally mirror each other while retaining distinct host arithmetic.
function comparison(operator: BinaryOperator): Operation {
  switch (operator) {
    case '==': {
      return (a, b) => truth(a === b);
    }
    case '!=': {
      return (a, b) => truth(a !== b);
    }
    case '<': {
      return (a, b) => truth(a < b);
    }
    case '<=': {
      return (a, b) => truth(a <= b);
    }
    case '>': {
      return (a, b) => truth(a > b);
    }
    case '>=': {
      return (a, b) => truth(a >= b);
    }
  }
  throw new Error(`No integer operator ${operator}`);
}

function checkShift(count: Scalar, bits: number): void {
  const value = Number(count);
  if (value < 0 || value >= bits) throw new CRuntimeError('shiftCount');
}

// code-gauge-allow functionCognitiveComplexity 30 -- One case per operator, with C's undefined behavior.
// code-gauge-allow functionNcss 37 -- Keep the signed 64-bit operator dispatch together; bigint overflow and shift rules differ from host numbers.
function signed64(operator: BinaryOperator, name: string): Operation {
  const checked = (result: bigint): bigint => {
    if (BigInt.asIntN(64, result) !== result) throw overflowError(name);
    return result;
  };
  const MIN = -(1n << 63n);
  switch (operator) {
    case '+': {
      return (a, b) => checked((a as bigint) + (b as bigint));
    }
    case '-': {
      return (a, b) => checked((a as bigint) - (b as bigint));
    }
    case '*': {
      return (a, b) => checked((a as bigint) * (b as bigint));
    }
    case '/': {
      return (a, b) => {
        if (b === 0n) throw new CRuntimeError('divisionByZero');
        if (a === MIN && b === -1n) throw overflowError(name);
        return (a as bigint) / (b as bigint);
      };
    }
    case '%': {
      return (a, b) => {
        if (b === 0n) throw new CRuntimeError('divisionByZero');
        if (a === MIN && b === -1n) throw overflowError(name);
        return (a as bigint) % (b as bigint);
      };
    }
    case '<<': {
      return (a, b) => {
        checkShift(b, 64);
        return checked((a as bigint) << BigInt(b));
      };
    }
    case '>>': {
      return (a, b) => {
        checkShift(b, 64);
        return (a as bigint) >> BigInt(b);
      };
    }
    default: {
      return bigBitwiseOrComparison(operator, (value) => BigInt.asIntN(64, value));
    }
  }
}

const wrap = (value: bigint): bigint => BigInt.asUintN(64, value);

function unsigned64(operator: BinaryOperator): Operation {
  switch (operator) {
    case '+': {
      return (a, b) => wrap((a as bigint) + (b as bigint));
    }
    case '-': {
      return (a, b) => wrap((a as bigint) - (b as bigint));
    }
    case '*': {
      return (a, b) => wrap((a as bigint) * (b as bigint));
    }
    case '/': {
      return (a, b) => {
        if (b === 0n) throw new CRuntimeError('divisionByZero');
        return (a as bigint) / (b as bigint);
      };
    }
    case '%': {
      return (a, b) => {
        if (b === 0n) throw new CRuntimeError('divisionByZero');
        return (a as bigint) % (b as bigint);
      };
    }
    case '<<': {
      return (a, b) => {
        checkShift(b, 64);
        return wrap((a as bigint) << BigInt(b));
      };
    }
    case '>>': {
      return (a, b) => {
        checkShift(b, 64);
        return (a as bigint) >> BigInt(b);
      };
    }
    default: {
      return bigBitwiseOrComparison(operator, wrap);
    }
  }
}

// code-gauge-allow duplicateLines 16 -- The number and bigint operator paths intentionally mirror each other while retaining distinct host arithmetic.
function bigBitwiseOrComparison(operator: BinaryOperator, wrap: (value: bigint) => bigint): Operation {
  switch (operator) {
    case '&': {
      return (a, b) => wrap((a as bigint) & (b as bigint));
    }
    case '|': {
      return (a, b) => wrap((a as bigint) | (b as bigint));
    }
    case '^': {
      return (a, b) => wrap((a as bigint) ^ (b as bigint));
    }
    default: {
      return comparison(operator);
    }
  }
}

/** Negates a value of `type`, stopping at the overflow of negating the minimum of a signed type. */
export function negate(type: IntType | FloatType): (value: Scalar) => Scalar {
  if (type.kind === 'float') return (value) => -(value as number);
  const { size, signed } = INT_PROPERTIES[type.name];
  const name = typeName(type);
  if (size === 8) {
    if (!signed) return (value) => BigInt.asUintN(64, -(value as bigint));
    return (value) => {
      if (value === -(1n << 63n)) throw overflowError(name);
      return -(value as bigint);
    };
  }
  if (!signed) return (value) => -(value as number) >>> 0;
  return (value) => {
    if (value === INT_MIN) throw overflowError(name);
    return -(value as number) || 0;
  };
}

export function complement(type: IntType): (value: Scalar) => Scalar {
  const { size, signed } = INT_PROPERTIES[type.name];
  if (size === 8) return signed ? (value) => ~(value as bigint) : (value) => BigInt.asUintN(64, ~(value as bigint));
  return signed ? (value) => ~(value as number) : (value) => ~(value as number) >>> 0;
}

/** The value 1 of a type, which `++` and `--` add or subtract. */
export function oneOf(type: CType): Scalar {
  return type.kind === 'int' && INT_PROPERTIES[type.name].size === 8 ? 1n : 1;
}

export function zeroOf(type: CType): Scalar {
  return type.kind === 'int' && INT_PROPERTIES[type.name].size === 8 ? 0n : 0;
}
