import type { Frame } from './runtime';
import type { PrimitiveKind } from './values';

export type ArithmeticOperator = '+' | '-' | '*' | '/' | '%';
export type NumericKind = Exclude<PrimitiveKind, 'Char'>;

export const NUMBER_OPERATOR_NAMES = {
  '+': 'plus',
  '-': 'minus',
  '*': 'times',
  '/': 'div',
  '%': 'rem',
} as const;

export const SIGNED_NUMBER_KINDS = ['Byte', 'Short', 'Int', 'Long', 'Float', 'Double'] as const;
export const UNSIGNED_NUMBER_KINDS = ['UByte', 'UShort', 'UInt', 'ULong'] as const;

type Binary = (frame: Frame, a: number | bigint, b: number | bigint) => number | bigint;

function isUnsignedKind(kind: PrimitiveKind): boolean {
  return kind.startsWith('U');
}

/** The type of an arithmetic operation's result, as Kotlin's operator overloads of the number types declare it. */
// code-gauge-allow functionCognitiveComplexity 23 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
export function arithmeticResult(
  left: PrimitiveKind,
  right: PrimitiveKind,
  operator: ArithmeticOperator
): PrimitiveKind | undefined {
  if (left === 'Char' || right === 'Char') {
    if (left === 'Char' && right === 'Int' && (operator === '+' || operator === '-')) return 'Char';
    if (left === 'Char' && right === 'Char' && operator === '-') return 'Int';
    return undefined;
  }
  if (isUnsignedKind(left) || isUnsignedKind(right)) {
    if (!isUnsignedKind(left) || !isUnsignedKind(right)) return undefined;
    return left === 'ULong' || right === 'ULong' ? 'ULong' : 'UInt';
  }
  if (left === 'Double' || right === 'Double') return 'Double';
  if (left === 'Float' || right === 'Float') return 'Float';
  if (left === 'Long' || right === 'Long') return 'Long';
  return 'Int';
}

/** Converts a value of a numeric kind to another, as an operand widens to the operation's type. */
export function widen(value: number | bigint, from: PrimitiveKind, to: PrimitiveKind): number | bigint {
  if (from === to) return value;
  switch (to) {
    case 'Long':
    case 'ULong': {
      return typeof value === 'bigint' ? value : BigInt(value);
    }
    case 'Double': {
      return Number(value);
    }
    case 'Float': {
      return toFloat(value);
    }
    default: {
      return Number(value);
    }
  }
}

export function toFloat(value: number | bigint): number {
  if (typeof value === 'number' || (value >= -9_007_199_254_740_992n && value <= 9_007_199_254_740_992n))
    return Math.fround(Number(value));
  // Converting a large Long through Double can round it to the midpoint between two floats.
  const magnitude = value < 0n ? -value : value;
  const shift = BigInt(magnitude.toString(2).length - 24);
  const significand = magnitude >> shift;
  const remainder = magnitude - (significand << shift);
  const midpoint = 1n << (shift - 1n);
  const rounded = remainder > midpoint || (remainder === midpoint && (significand & 1n) !== 0n);
  return (value < 0n ? -1 : 1) * Number((significand + BigInt(rounded)) << shift);
}

function divideByZero(frame: Frame): never {
  return frame.runtime.throwError(frame, 'java.lang.ArithmeticException', '/ by zero');
}

const INT_OPERATIONS: Record<ArithmeticOperator, Binary> = {
  '+': (_, a, b) => toInt32((a as number) + (b as number)),
  '-': (_, a, b) => toInt32((a as number) - (b as number)),
  '*': (_, a, b) => Math.imul(a as number, b as number),
  '/': (frame, a, b) => (b === 0 ? divideByZero(frame) : toInt32((a as number) / (b as number))),
  '%': (frame, a, b) => (b === 0 ? divideByZero(frame) : toInt32((a as number) % (b as number))),
};

const LONG_OPERATIONS: Record<ArithmeticOperator, Binary> = {
  '+': (_, a, b) => BigInt.asIntN(64, (a as bigint) + (b as bigint)),
  '-': (_, a, b) => BigInt.asIntN(64, (a as bigint) - (b as bigint)),
  '*': (_, a, b) => BigInt.asIntN(64, (a as bigint) * (b as bigint)),
  '/': (frame, a, b) => (b === 0n ? divideByZero(frame) : BigInt.asIntN(64, (a as bigint) / (b as bigint))),
  '%': (frame, a, b) => (b === 0n ? divideByZero(frame) : (a as bigint) % (b as bigint)),
};

const DOUBLE_OPERATIONS: Record<ArithmeticOperator, Binary> = {
  '+': (_, a, b) => (a as number) + (b as number),
  '-': (_, a, b) => (a as number) - (b as number),
  '*': (_, a, b) => (a as number) * (b as number),
  '/': (_, a, b) => (a as number) / (b as number),
  '%': (_, a, b) => (a as number) % (b as number),
};

const UINT_OPERATIONS: Record<ArithmeticOperator, Binary> = {
  '+': (_, a, b) => ((a as number) + (b as number)) >>> 0,
  '-': (_, a, b) => ((a as number) - (b as number)) >>> 0,
  '*': (_, a, b) => Math.imul(a as number, b as number) >>> 0,
  '/': (frame, a, b) => (b === 0 ? divideByZero(frame) : Math.floor((a as number) / (b as number))),
  '%': (frame, a, b) => (b === 0 ? divideByZero(frame) : (a as number) % (b as number)),
};

const ULONG_OPERATIONS: Record<ArithmeticOperator, Binary> = {
  '+': (_, a, b) => BigInt.asUintN(64, (a as bigint) + (b as bigint)),
  '-': (_, a, b) => BigInt.asUintN(64, (a as bigint) - (b as bigint)),
  '*': (_, a, b) => BigInt.asUintN(64, (a as bigint) * (b as bigint)),
  '/': (frame, a, b) => (b === 0n ? divideByZero(frame) : (a as bigint) / (b as bigint)),
  '%': (frame, a, b) => (b === 0n ? divideByZero(frame) : (a as bigint) % (b as bigint)),
};

/** The operation of a result kind, applied to operands already widened to it. */
export function arithmeticOperation(kind: PrimitiveKind, operator: ArithmeticOperator): Binary {
  switch (kind) {
    case 'Long': {
      return LONG_OPERATIONS[operator];
    }
    case 'Double': {
      return DOUBLE_OPERATIONS[operator];
    }
    case 'Float': {
      const operation = DOUBLE_OPERATIONS[operator];
      return (frame, a, b) => Math.fround(operation(frame, a, b) as number);
    }
    case 'UInt': {
      return UINT_OPERATIONS[operator];
    }
    case 'ULong': {
      return ULONG_OPERATIONS[operator];
    }
    case 'Char': {
      return operator === '+'
        ? (_, a, b) => ((a as number) + (b as number)) & 0xff_ff
        : (_, a, b) => ((a as number) - (b as number)) & 0xff_ff;
    }
    default: {
      return INT_OPERATIONS[operator];
    }
  }
}

/** Compares two numbers of possibly different kinds, as their `compareTo` overloads do. */
export function compareNumbers(a: number | bigint, b: number | bigint): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  const left = Number(a);
  const right = Number(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `compareTo` of `Double` and `Float`, which orders NaN above everything and -0.0 below 0.0, as Java's does. */
export function compareDoubles(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  const aBits = Number.isNaN(a) ? 1 : Object.is(a, -0) ? -0.5 : 0;
  const bBits = Number.isNaN(b) ? 1 : Object.is(b, -0) ? -0.5 : 0;
  if (Number.isNaN(a) && Number.isNaN(b)) return 0;
  return aBits < bBits ? -1 : aBits > bBits ? 1 : 0;
}

/** The kind of the result of a unary minus or plus, which widens `Byte` and `Short` to `Int`. */
export function unaryResult(kind: PrimitiveKind): PrimitiveKind | undefined {
  if (kind === 'Char' || kind.startsWith('U')) return undefined;
  return kind === 'Byte' || kind === 'Short' ? 'Int' : kind;
}

export function negate(kind: PrimitiveKind, value: number | bigint): number | bigint {
  switch (kind) {
    case 'Long': {
      return BigInt.asIntN(64, -(value as bigint));
    }
    case 'Double':
    case 'Float': {
      return -(value as number);
    }
    default: {
      return toInt32(-(value as number));
    }
  }
}

/** Adds one to or subtracts one from a value of its own kind, wrapping as `inc` and `dec` do. */
export function step(kind: PrimitiveKind, value: number | bigint, delta: 1 | -1): number | bigint {
  switch (kind) {
    case 'Long': {
      return BigInt.asIntN(64, (value as bigint) + BigInt(delta));
    }
    case 'ULong': {
      return BigInt.asUintN(64, (value as bigint) + BigInt(delta));
    }
    case 'Double': {
      return (value as number) + delta;
    }
    case 'Float': {
      return Math.fround((value as number) + delta);
    }
    case 'Char': {
      return ((value as number) + delta) & 0xff_ff;
    }
    case 'Byte': {
      return (((value as number) + delta) << 24) >> 24;
    }
    case 'Short': {
      return (((value as number) + delta) << 16) >> 16;
    }
    case 'UInt': {
      return ((value as number) + delta) >>> 0;
    }
    case 'UByte': {
      return ((value as number) + delta) & 0xff;
    }
    case 'UShort': {
      return ((value as number) + delta) & 0xff_ff;
    }
    default: {
      return toInt32((value as number) + delta);
    }
  }
}

/** Wraps a number to 32 bits, as Kotlin's `Int` arithmetic does. */
export function toInt32(value: number): number {
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps around at 32 bits, which Math.trunc does not.
  return value | 0;
}
