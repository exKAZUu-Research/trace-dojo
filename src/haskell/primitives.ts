import { power } from '../interpreter/power';
// code-gauge-allow-file fileNcss -- The primitive table lists every built-in operation the Haskell library calls.
import { TURTLE_METHOD_NAMES } from '../interpreter/turtleWorld';
import { CONS_CON, tupleCon, UNIT_CON } from './builtinTypes';
import type { ConInfo } from './entities';
import { changeIntegerBit, complementIntegerBit, makeIntegerBit, testIntegerBit } from './integerBits';
import { cons, NIL, nullary, type PrimResult, unpackString } from './machine';
import type { Runtime } from './runtime';
import {
  ConValue,
  HaskellException,
  IOBind,
  IOPrim,
  IOReturn,
  IOThen,
  type Slot,
  Thunk,
  TurtleValue,
  untypedSlot,
  type Value,
} from './values';

export interface Primitive {
  name: string;
  arity: number;
  /** The arguments forced to weak head normal form before the primitive runs. */
  strict: number[] | 'all';
  fn: (args: Slot[], runtime: Runtime) => PrimResult;
}

const registry = new Map<string, Primitive>();

export function primitiveNamed(name: string): Primitive {
  const prim = registry.get(name);
  if (!prim) throw new Error(`Unknown primitive ${name}`);
  return prim;
}

export function define(name: string, arity: number, strict: Primitive['strict'], fn: Primitive['fn']): void {
  registry.set(name, { name, arity, strict, fn });
}

/** Defines a primitive whose arguments are all forced, taking their values. */
export function strict(name: string, arity: number, fn: (args: Value[], runtime: Runtime) => PrimResult): void {
  define(name, arity, 'all', (args, runtime) => fn(args as Value[], runtime));
}

let boolCons: { false: ConInfo; true: ConInfo } | undefined;
let orderingCons: ConInfo[] | undefined;

/** Registers the library's `Bool` and `Ordering`, which primitives return. */
export function setPrimitiveTypes(bool: ConInfo[], ordering: ConInfo[]): void {
  boolCons = { false: bool[0], true: bool[1] };
  orderingCons = ordering;
}

export function bool(value: boolean): Value {
  const cons_ = boolCons as { false: ConInfo; true: ConInfo };
  return nullary(value ? cons_.true : cons_.false);
}

function ordering(order: number): Value {
  const cons_ = orderingCons as ConInfo[];
  return nullary(cons_[order < 0 ? 0 : order === 0 ? 1 : 2]);
}

strict('newtypeField', 1, ([value]) => (value as ConValue).fields[0]);

export const unit = (): Value => nullary(UNIT_CON);

export function tuple(...items: Slot[]): Value {
  return new ConValue(tupleCon(items.length), items);
}

export function listOf(items: readonly Slot[]): Value {
  let result: Value = NIL();
  for (let index = items.length - 1; index >= 0; index--) result = cons(items[index], result);
  return result;
}

export function forceString(slot: Slot, runtime: Runtime): string {
  let text = '';
  let current = runtime.machine.force(slot) as ConValue;
  while (current.con === CONS_CON) {
    text += runtime.machine.force(current.fields[0]) as string;
    current = runtime.machine.force(current.fields[1]) as ConValue;
    runtime.spend();
  }
  return text;
}

/**
 * The number a string starts with, after ASCII spaces and an optional `-`: decimal digits, and for a fractional one
 * an optional `.digits` and exponent, when the character after it cannot continue a number's lexeme (the end, a
 * space, `)`, `]` or `,`). Reads only the cells up to that character.
 */
function plainNumber(
  text: Slot,
  runtime: Runtime,
  fractional: boolean
): { negative: boolean; token: string; rest: Slot } | undefined {
  let rest = text;
  let cell = runtime.machine.force(rest) as ConValue;
  const charOf = (): string | undefined =>
    cell.con === CONS_CON ? (runtime.machine.force(cell.fields[0]) as string) : undefined;
  let token = '';
  const take = (): void => {
    token += charOf() as string;
    rest = cell.fields[1];
    cell = runtime.machine.force(rest) as ConValue;
    runtime.spend();
  };
  const isDigit = (): boolean => {
    const char = charOf();
    return char !== undefined && char >= '0' && char <= '9';
  };
  const digits = (): boolean => {
    if (!isDigit()) return false;
    while (isDigit()) take();
    return true;
  };
  while (charOf() !== undefined && ASCII_SPACE.test(charOf() as string)) take();
  const negative = charOf() === '-';
  if (negative) take();
  token = '';
  if (!digits()) return undefined;
  if (fractional && charOf() === '.') {
    take();
    if (!digits()) return undefined;
  }
  if (fractional && (charOf() === 'e' || charOf() === 'E')) {
    take();
    if (charOf() === '+' || charOf() === '-') take();
    if (!digits()) return undefined;
  }
  const next = charOf();
  if (next !== undefined && !ASCII_SPACE.test(next) && !')],'.includes(next)) return undefined;
  return { negative, token, rest };
}

/** The characters `isSpace` holds for below U+0080. */
const ASCII_SPACE = /^[\t\n\v\f\r ]$/;

function haskellError(message: string): HaskellException {
  return new HaskellException(message);
}

const INT_MIN = -(2n ** 63n);

function wrapInt(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

function divideByZero(): HaskellException {
  return new HaskellException('divide by zero', { kind: 'arith', error: 'DivideByZero' });
}

/** Floor division and modulus, as Haskell's `div` and `mod` round toward negative infinity. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function floorMod(a: bigint, b: bigint): bigint {
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? r + b : r;
}

// ---------------------------------------------------------------------------------------------------------------
// Int and Integer

// code-gauge-allow functionCognitiveComplexity -- Each branch reproduces one of GHC's error or overflow behaviors for integral division.
// code-gauge-allow functionNcss -- Each branch reproduces one of GHC's error or overflow behaviors for integral division.
function defineIntegral(prefix: 'int' | 'integer' | 'word', wrap: (value: bigint) => bigint): void {
  strict(`${prefix}Add`, 2, ([a, b]) => wrap((a as bigint) + (b as bigint)));
  strict(`${prefix}Sub`, 2, ([a, b]) => wrap((a as bigint) - (b as bigint)));
  strict(`${prefix}Mul`, 2, ([a, b], runtime) => {
    runtime.spend(bigCost(a as bigint, b as bigint));
    return wrap((a as bigint) * (b as bigint));
  });
  strict(`${prefix}Negate`, 1, ([a]) => wrap(-(a as bigint)));
  strict(`${prefix}Abs`, 1, ([a]) => wrap((a as bigint) < 0n ? -(a as bigint) : (a as bigint)));
  strict(`${prefix}Signum`, 1, ([a]) => ((a as bigint) > 0n ? 1n : (a as bigint) < 0n ? -1n : 0n));
  const checked =
    (op: (a: bigint, b: bigint) => bigint) =>
    ([a, b]: Value[]): Value => {
      if ((b as bigint) === 0n) throw divideByZero();
      if (prefix === 'int' && (a as bigint) === INT_MIN && (b as bigint) === -1n) {
        // GHC reports the overflow of the one quotient that does not fit.
        throw new HaskellException('arithmetic overflow', { kind: 'arith', error: 'Overflow' });
      }
      return wrap(op(a as bigint, b as bigint));
    };
  strict(
    `${prefix}Quot`,
    2,
    checked((a, b) => a / b)
  );
  strict(`${prefix}Rem`, 2, ([a, b]) => {
    if ((b as bigint) === 0n) throw divideByZero();
    return wrap((a as bigint) % (b as bigint));
  });
  strict(`${prefix}Div`, 2, checked(floorDiv));
  strict(`${prefix}Mod`, 2, ([a, b]) => {
    if ((b as bigint) === 0n) throw divideByZero();
    return wrap(floorMod(a as bigint, b as bigint));
  });
  strict(`${prefix}Eq`, 2, ([a, b]) => bool(a === b));
  strict(`${prefix}Lt`, 2, ([a, b]) => bool((a as bigint) < (b as bigint)));
  strict(`${prefix}Le`, 2, ([a, b]) => bool((a as bigint) <= (b as bigint)));
  strict(`${prefix}Gt`, 2, ([a, b]) => bool((a as bigint) > (b as bigint)));
  strict(`${prefix}Ge`, 2, ([a, b]) => bool((a as bigint) >= (b as bigint)));
  strict(`${prefix}Compare`, 2, ([a, b]) => ordering((a as bigint) < (b as bigint) ? -1 : a === b ? 0 : 1));
  strict(`${prefix}Show`, 1, ([a]) => unpackString((a as bigint).toString(), 0));
  strict(`${prefix}ToDouble`, 1, ([a]) => bigintToDouble(a as bigint));
  strict(`${prefix}ToFloat`, 1, ([a]) => rationalToFloat(a as bigint, 1n));
}

function countOnes(value: bigint): number {
  return value.toString(2).replaceAll('0', '').length;
}

function hexDigits(value: bigint): number {
  return (value < 0n ? -value : value).toString(16).length;
}

function bigCost(a: bigint, b: bigint): number {
  const size = hexDigits(a) + hexDigits(b);
  return size > 64 ? Math.ceil(size / 64) : 1;
}

function rotate64(value: bigint, count: bigint): bigint {
  const bits = BigInt.asUintN(64, value);
  const offset = BigInt.asUintN(6, count);
  return BigInt.asUintN(64, (bits << offset) | (bits >> (64n - offset)));
}

function shiftCount(value: Value): bigint {
  const count = value as bigint;
  if (count < 0n) throw new HaskellException('arithmetic overflow', { kind: 'arith', error: 'Overflow' });
  return count;
}

/** Converts an integer to the nearest double, rounding half to even as GHC's `fromInteger` does. */
export const bigintToDouble = Number;

defineIntegral('int', wrapInt);
defineIntegral('integer', (value) => value);
defineIntegral('word', (value) => BigInt.asUintN(64, value));
strict('integerToWord', 1, ([a]) => BigInt.asUintN(64, a as bigint));
strict('wordAnd', 2, ([a, b]) => (a as bigint) & (b as bigint));
strict('wordOr', 2, ([a, b]) => (a as bigint) | (b as bigint));
strict('wordXor', 2, ([a, b]) => (a as bigint) ^ (b as bigint));
strict('wordComplement', 1, ([a]) => BigInt.asUintN(64, ~(a as bigint)));
strict('wordShiftL', 2, ([a, b]) => (shiftCount(b) >= 64n ? 0n : BigInt.asUintN(64, (a as bigint) << (b as bigint))));
strict('wordShiftR', 2, ([a, b]) => (shiftCount(b) >= 64n ? 0n : (a as bigint) >> (b as bigint)));
strict('wordPopCount', 1, ([a]) => BigInt(countOnes(a as bigint)));
strict('integerToInt', 1, ([a]) => wrapInt(a as bigint));
strict('intToInteger', 1, ([a]) => a);
// Bits
strict('intRotate', 2, ([a, b]) => wrapInt(rotate64(a as bigint, b as bigint)));
strict('wordRotate', 2, ([a, b]) => rotate64(a as bigint, b as bigint));
strict('leadingZeros64', 1, ([a]) => {
  const value = BigInt.asUintN(64, a as bigint);
  return value === 0n ? 64n : 64n - BigInt(value.toString(2).length);
});
strict('trailingZeros64', 1, ([a]) => {
  const value = BigInt.asUintN(64, a as bigint);
  return value === 0n ? 64n : BigInt((value & -value).toString(2).length - 1);
});
strict('intAnd', 2, ([a, b]) => wrapInt((a as bigint) & (b as bigint)));
strict('intOr', 2, ([a, b]) => wrapInt((a as bigint) | (b as bigint)));
strict('intXor', 2, ([a, b]) => wrapInt((a as bigint) ^ (b as bigint)));
strict('intComplement', 1, ([a]) => wrapInt(~(a as bigint)));
strict('intShiftL', 2, ([a, b]) => (shiftCount(b) >= 64n ? 0n : wrapInt((a as bigint) << (b as bigint))));
strict('intShiftR', 2, ([a, b]) =>
  shiftCount(b) >= 64n ? ((a as bigint) < 0n ? -1n : 0n) : (a as bigint) >> (b as bigint)
);
strict('intPopCount', 1, ([a]) => BigInt(countOnes(BigInt.asUintN(64, a as bigint))));
define('integerAnd', 2, [0], ([a, b], runtime) =>
  a === 0n ? 0n : (a as bigint) & (runtime.machine.force(b) as bigint)
);
define('integerOr', 2, [0], ([a, b], runtime) =>
  a === -1n ? -1n : (a as bigint) | (runtime.machine.force(b) as bigint)
);
strict('integerXor', 2, ([a, b]) => (a as bigint) ^ (b as bigint));
strict('integerComplement', 1, ([a]) => ~(a as bigint));
define('integerShiftL', 2, [1], ([a, b], runtime) => {
  const count = shiftCount(b as bigint);
  const value = runtime.machine.force(a) as bigint;
  if (value === 0n) return 0n;
  runtime.spend(Math.ceil((hexDigits(value) * 4 + Number(count)) / 64));
  return value << count;
});
define('integerShiftR', 2, [1], ([a, b], runtime) => {
  const count = shiftCount(b as bigint);
  return (runtime.machine.force(a) as bigint) >> count;
});
strict('integerTestBit', 2, ([a, b], runtime) => bool(testIntegerBit(a as bigint, b as bigint, runtime)));
strict('integerBit', 1, ([index], runtime) => makeIntegerBit(index as bigint, runtime));
for (const [name, change, identity] of [
  ['integerSetBit', 'set', -1n],
  ['integerClearBit', 'clear', 0n],
] as const) {
  define(name, 2, [0], ([a, b], runtime) =>
    a === identity ? a : changeIntegerBit(a as bigint, runtime.machine.force(b) as bigint, change, runtime)
  );
}
define('integerComplementBit', 2, [1], ([a, b], runtime) =>
  complementIntegerBit(() => runtime.machine.force(a) as bigint, b as bigint, runtime)
);
strict('integerPopCount', 1, ([a]) => {
  const value = a as bigint;
  const count = countOnes(value < 0n ? -value : value);
  return BigInt(value < 0n ? -count : count);
});

// ---------------------------------------------------------------------------------------------------------------
// Double and Float

// code-gauge-allow functionNcss -- One definition per floating-point primitive.
function defineFloating(prefix: 'double' | 'float', round: (value: number) => number): void {
  strict(`${prefix}Add`, 2, ([a, b]) => round((a as number) + (b as number)));
  strict(`${prefix}Sub`, 2, ([a, b]) => round((a as number) - (b as number)));
  strict(`${prefix}Mul`, 2, ([a, b]) => round((a as number) * (b as number)));
  strict(`${prefix}Div`, 2, ([a, b]) => round((a as number) / (b as number)));
  strict(`${prefix}Negate`, 1, ([a]) => -(a as number));
  strict(`${prefix}Abs`, 1, ([a]) => Math.abs(a as number));
  strict(`${prefix}Signum`, 1, ([a]) => {
    const value = a as number;
    if (value > 0) return 1;
    if (value < 0) return -1;
    return value;
  });
  strict(`${prefix}Eq`, 2, ([a, b]) => bool(a === b));
  strict(`${prefix}Lt`, 2, ([a, b]) => bool((a as number) < (b as number)));
  strict(`${prefix}Le`, 2, ([a, b]) => bool((a as number) <= (b as number)));
  strict(`${prefix}Gt`, 2, ([a, b]) => bool((a as number) > (b as number)));
  strict(`${prefix}Ge`, 2, ([a, b]) => bool((a as number) >= (b as number)));
  const unary = [
    'Exp',
    'Log',
    'Sqrt',
    'Sin',
    'Cos',
    'Tan',
    'Asin',
    'Acos',
    'Atan',
    'Sinh',
    'Cosh',
    'Tanh',
    'Asinh',
    'Acosh',
    'Atanh',
  ] as const;
  for (const name of unary)
    strict(`${prefix}${name}`, 1, ([a]) => round(Math[name.toLowerCase() as Lowercase<typeof name>](a as number)));
  strict(`${prefix}Pow`, 2, ([a, b]) => round(power(a as number, b as number)));
  strict(`${prefix}IsNaN`, 1, ([a]) => bool(Number.isNaN(a)));
  strict(`${prefix}IsInfinite`, 1, ([a]) => bool(a === Number.POSITIVE_INFINITY || a === Number.NEGATIVE_INFINITY));
  strict(`${prefix}IsNegativeZero`, 1, ([a]) => bool(Object.is(a, -0)));
  strict(`${prefix}Truncate`, 1, ([a]) => {
    const value = a as number;
    if (!Number.isFinite(value)) return truncateNonFinite(value, prefix);
    return BigInt(Math.trunc(value));
  });
  strict(`${prefix}Rint`, 1, ([a]) => roundHalfEven(a as number));
  strict(`${prefix}FromInteger`, 1, ([a]) =>
    prefix === 'float' ? rationalToFloat(a as bigint, 1n) : bigintToDouble(a as bigint)
  );
  strict(`${prefix}Digits`, 1, ([a]) => {
    const { digits, exponent } = floatToDigits(a as number, prefix === 'float');
    return tuple(listOf(digits.map(BigInt)), BigInt(exponent));
  });
  strict(`${prefix}Decode`, 1, ([a]) => {
    const { mantissa, exponent } = decodeFloat(a as number, prefix === 'float');
    return tuple(mantissa, BigInt(exponent));
  });
  strict(`${prefix}Encode`, 2, ([m, e], runtime) => encodeFloat(m as bigint, Number(e), prefix === 'float', runtime));
  strict(`${prefix}FromRational`, 2, ([n, d]) =>
    prefix === 'float' ? rationalToFloat(n as bigint, d as bigint) : rationalToDouble(n as bigint, d as bigint)
  );
}

/** C's `rint`, which GHC's `round` applies before converting: the nearest integer, a tie going to the even one. */
function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction !== 0.5) return fraction < 0.5 ? floor : floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** GHC's `truncate` of an infinity or NaN, which converts the mantissa and exponent as they are. */
function truncateNonFinite(value: number, prefix: 'double' | 'float'): bigint {
  const { mantissa, exponent } = decodeFloat(value, prefix === 'float');
  return exponent >= 0 ? mantissa << BigInt(exponent) : mantissa >> BigInt(-exponent);
}

defineFloating('double', (value) => value);
defineFloating('float', Math.fround);
strict('doubleToFloat', 1, ([a]) => Math.fround(a as number));
strict('floatToDouble', 1, ([a]) => a);

/** GHC's `decodeFloat`: a mantissa of `floatDigits` bits and an exponent, with infinities and NaN as GHC gives them. */
// code-gauge-allow functionNcss -- Decoding follows the IEEE 754 cases for normal, subnormal, and special values.
export function decodeFloat(value: number, isFloat: boolean): { mantissa: bigint; exponent: number } {
  const bits = isFloat ? 24 : 53;
  if (value === 0) return { mantissa: 0n, exponent: 0 };
  const view = new DataView(new ArrayBuffer(8));
  if (isFloat) {
    view.setFloat32(0, value);
    const raw = view.getUint32(0);
    const sign = raw >>> 31 ? -1n : 1n;
    const biased = (raw >>> 23) & 0xff;
    let fraction = BigInt(raw & 0x7f_ff_ff);
    let exponent: number;
    if (biased === 0) {
      exponent = -149;
    } else {
      fraction |= 1n << 23n;
      exponent = biased - 150;
    }
    while (fraction < 1n << BigInt(bits - 1)) {
      fraction <<= 1n;
      exponent--;
    }
    return { mantissa: sign * fraction, exponent };
  }
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const sign = high >>> 31 ? -1n : 1n;
  const biased = (high >>> 20) & 0x7_ff;
  let fraction = (BigInt(high & 0xf_ff_ff) << 32n) | BigInt(low);
  let exponent: number;
  if (biased === 0) {
    exponent = -1074;
  } else {
    fraction |= 1n << 52n;
    exponent = biased - 1075;
  }
  while (fraction < 1n << BigInt(bits - 1)) {
    fraction <<= 1n;
    exponent--;
  }
  return { mantissa: sign * fraction, exponent };
}

function encodeFloat(mantissa: bigint, exponent: number, isFloat: boolean, runtime: Runtime): number {
  if (mantissa === 0n) return 0;
  const bits = (mantissa < 0n ? -mantissa : mantissa).toString(2).length;
  const topExponent = exponent + bits - 1;
  if (topExponent > (isFloat ? 128 : 1024)) {
    return mantissa < 0n ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (topExponent < (isFloat ? -150 : -1075)) return mantissa < 0n ? -0 : 0;
  runtime.spend(Math.ceil((bits + Math.abs(exponent)) / 64));
  const numerator = exponent >= 0 ? mantissa << BigInt(exponent) : mantissa;
  const denominator = exponent >= 0 ? 1n : 1n << BigInt(-exponent);
  return isFloat ? Math.fround(rationalToDouble(numerator, denominator)) : rationalToDouble(numerator, denominator);
}

/** The double nearest to n/d, rounding half to even. */
export function rationalToDouble(numerator: bigint, denominator: bigint): number {
  return rationalToBinary(numerator, denominator, 53, -1074, 1023);
}

export function rationalToFloat(numerator: bigint, denominator: bigint): number {
  return Math.fround(rationalToBinary(numerator, denominator, 24, -149, 127));
}

// code-gauge-allow functionCognitiveComplexity -- Rounding to nearest even needs the scaling and tie cases together.
function rationalToBinary(
  numerator: bigint,
  denominator: bigint,
  precision: number,
  minExponent: number,
  maxExponent: number
): number {
  if (numerator === 0n) return 0;
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (exponent: number): { q: bigint; r: bigint; div: bigint } => {
    const num = exponent >= 0 ? n : n << BigInt(-exponent);
    const div = exponent >= 0 ? d << BigInt(exponent) : d;
    return { q: num / div, r: num % div, div };
  };
  let exponent = n.toString(2).length - d.toString(2).length - precision;
  let { q, r, div } = quotient(exponent);
  while (q >= 1n << BigInt(precision)) ({ q, r, div } = quotient(++exponent));
  while (q < 1n << BigInt(precision - 1) && exponent > minExponent) ({ q, r, div } = quotient(--exponent));
  if (exponent < minExponent) {
    // A subnormal number keeps fewer bits.
    exponent = minExponent;
    ({ q, r, div } = quotient(exponent));
  }
  const twice = r * 2n;
  if (twice > div || (twice === div && (q & 1n) === 1n)) q += 1n;
  if (exponent + q.toString(2).length > maxExponent + 1) {
    return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  const result = Number(q) * 2 ** exponent;
  return negative ? -result : result;
}

define('hasNativeFloatDigits', 1, [], ([slot]) => {
  const raw = untypedSlot(slot);
  const value = raw instanceof Thunk ? (raw.state === 'done' ? raw.value : undefined) : raw;
  return bool(typeof value === 'number' && Number.isFinite(value) && value > 0);
});

strict('nativeFloatToDigits10', 2, ([precision, value], runtime) => {
  const { digits, exponent } = floatToDigits(value as number, precision === 24n);
  runtime.spend(digits.length);
  runtime.allocate(digits.length * 2 + 2);
  return tuple(listOf(digits.map(BigInt)), BigInt(exponent));
});

/** GHC's `floatToDigits` in base 10: the digits of a float and its exponent, x = 0.d1d2... * 10^exponent. */
export function floatToDigits(value: number, isFloat: boolean): { digits: number[]; exponent: number } {
  if (value === 0) return { digits: [0], exponent: 0 };
  const { r, s, mUp, mDn } = digitRatio(value, isFloat);
  // Any estimate at most the exponent works, since the loop only raises it.
  let k = Math.floor(Math.log10(Math.abs(value))) - 1;
  while (k >= 0 ? r + mUp > 10n ** BigInt(k) * s : 10n ** BigInt(-k) * (r + mUp) > s) k++;
  const scale = 10n ** BigInt(Math.abs(k));
  const digits =
    k >= 0 ? generateDigits(r, s * scale, mUp, mDn) : generateDigits(r * scale, s, mUp * scale, mDn * scale);
  return { digits, exponent: k };
}

/** A float's magnitude as r / s, with mUp / s and mDn / s the halves of the gaps to its neighbors, as GHC sets them. */
function digitRatio(value: number, isFloat: boolean): { r: bigint; s: bigint; mUp: bigint; mDn: bigint } {
  const precision = isFloat ? 24 : 53;
  const minExponent = (isFloat ? -125 : -1021) - precision;
  const decoded = decodeFloat(Math.abs(value), isFloat);
  const shift = minExponent - decoded.exponent;
  const f = shift > 0 ? decoded.mantissa / 2n ** BigInt(shift) : decoded.mantissa;
  const e = shift > 0 ? decoded.exponent + shift : decoded.exponent;
  const isPowerOfTwo = f === 2n ** BigInt(precision - 1);
  if (e >= 0) {
    const be = 2n ** BigInt(e);
    return isPowerOfTwo
      ? { r: f * be * 4n, s: 4n, mUp: be * 2n, mDn: be }
      : { r: f * be * 2n, s: 2n, mUp: be, mDn: be };
  }
  return e > minExponent && isPowerOfTwo
    ? { r: f * 4n, s: 2n ** BigInt(-e + 1) * 2n, mUp: 2n, mDn: 1n }
    : { r: f * 2n, s: 2n ** BigInt(-e) * 2n, mUp: 1n, mDn: 1n };
}

/** The decimal digits of r / s, which stop once they identify the value within the gaps mUp / s and mDn / s. */
function generateDigits(r: bigint, s: bigint, mUp: bigint, mDn: bigint): number[] {
  const digits: number[] = [];
  let rest = r;
  let up = mUp;
  let down = mDn;
  for (;;) {
    const digit = (rest * 10n) / s;
    rest = (rest * 10n) % s;
    up *= 10n;
    down *= 10n;
    // GHC excludes both ends of the rounding interval even for an even mantissa, so its digits are not always the shortest.
    const low = rest < down;
    const high = rest + up > s;
    if (!low && !high) {
      digits.push(Number(digit));
      continue;
    }
    digits.push(Number(low && (!high || rest * 2n < s) ? digit : digit + 1n));
    return digits;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Characters

strict('charEq', 2, ([a, b]) => bool(a === b));
strict('charLt', 2, ([a, b]) =>
  bool(((a as string).codePointAt(0) as number) < ((b as string).codePointAt(0) as number))
);
strict('charLe', 2, ([a, b]) =>
  bool(((a as string).codePointAt(0) as number) <= ((b as string).codePointAt(0) as number))
);
strict('charGt', 2, ([a, b]) =>
  bool(((a as string).codePointAt(0) as number) > ((b as string).codePointAt(0) as number))
);
strict('charGe', 2, ([a, b]) =>
  bool(((a as string).codePointAt(0) as number) >= ((b as string).codePointAt(0) as number))
);
strict('ord', 1, ([a]) => BigInt((a as string).codePointAt(0) as number));
strict('chr', 1, ([a]) => {
  const code = a as bigint;
  if (code < 0n || code > 0x10_ff_ffn) throw haskellError(`Prelude.chr: bad argument: ${showSignedInt(code)}`);
  return String.fromCodePoint(Number(code));
});

export function showSignedInt(value: bigint): string {
  return value < 0n ? `(${value})` : String(value);
}

const CATEGORY_PATTERNS: [string, RegExp][] = [
  ['Lu', /\p{Lu}/u],
  ['Ll', /\p{Ll}/u],
  ['Lt', /\p{Lt}/u],
  ['Lm', /\p{Lm}/u],
  ['Lo', /\p{Lo}/u],
  ['Mn', /\p{Mn}/u],
  ['Mc', /\p{Mc}/u],
  ['Me', /\p{Me}/u],
  ['Nd', /\p{Nd}/u],
  ['Nl', /\p{Nl}/u],
  ['No', /\p{No}/u],
  ['Pc', /\p{Pc}/u],
  ['Pd', /\p{Pd}/u],
  ['Ps', /\p{Ps}/u],
  ['Pe', /\p{Pe}/u],
  ['Pi', /\p{Pi}/u],
  ['Pf', /\p{Pf}/u],
  ['Po', /\p{Po}/u],
  ['Sm', /\p{Sm}/u],
  ['Sc', /\p{Sc}/u],
  ['Sk', /\p{Sk}/u],
  ['So', /\p{So}/u],
  ['Zs', /\p{Zs}/u],
  ['Zl', /\p{Zl}/u],
  ['Zp', /\p{Zp}/u],
  ['Cc', /\p{Cc}/u],
  ['Cf', /\p{Cf}/u],
  ['Cs', /\p{Cs}/u],
  ['Co', /\p{Co}/u],
];

/** GHC's `isSpace`: the ASCII control spaces and the characters of category Zs, unlike JavaScript's `\s`. */
strict('isSpace', 1, ([a]) => bool(HASKELL_SPACE.test(a as string)));

const HASKELL_SPACE = /^[\t\n\v\f\r\p{Zs}]$/u;

/** GHC's `generalCategory` as the index of its constructor in `GeneralCategory`. */
strict('generalCategory', 1, ([a]) => {
  const char = a as string;
  const index = CATEGORY_PATTERNS.findIndex(([, pattern]) => pattern.test(char));
  return BigInt(index === -1 ? 29 : index);
});

/**
 * The simple upper case of a Greek letter with ypogegrammeni, which JavaScript expands to two characters: GHC maps it
 * to the letter with prosgegrammeni.
 */
function greekIotaUpper(char: string): string | undefined {
  const code = char.codePointAt(0) as number;
  if (
    (code >= 0x1f_80 && code <= 0x1f_a7 && (code & 0x8) === 0) ||
    code === 0x1f_b3 ||
    code === 0x1f_c3 ||
    code === 0x1f_f3
  ) {
    return String.fromCodePoint(code >= 0x1f_b0 ? code + 9 : code + 8);
  }
  return undefined;
}

/** GHC maps each character to one character, so a mapping that JavaScript expands keeps the character. */
function singleCase(char: string, mapped: string): string {
  return (mapped.codePointAt(0) ?? 0) > 0xff_ff
    ? mapped.length === 2
      ? mapped
      : char
    : mapped.length === 1
      ? mapped
      : char;
}

const TITLE_CASES: Record<string, string> = {
  ǆ: 'ǅ',
  ǅ: 'ǅ',
  Ǆ: 'ǅ',
  ǉ: 'ǈ',
  ǈ: 'ǈ',
  Ǉ: 'ǈ',
  ǌ: 'ǋ',
  ǋ: 'ǋ',
  Ǌ: 'ǋ',
  ǳ: 'ǲ',
  ǲ: 'ǲ',
  Ǳ: 'ǲ',
};

strict('toUpper', 1, ([a]) => {
  const char = a as string;
  if (char === 'ǅ' || char === 'ǈ' || char === 'ǋ' || char === 'ǲ')
    return String.fromCodePoint((char.codePointAt(0) as number) - 1);
  return greekIotaUpper(char) ?? singleCase(char, char.toUpperCase());
});
strict('toLower', 1, ([a]) => {
  const char = a as string;
  if (char === 'İ') return 'i';
  if (char === 'ǅ' || char === 'ǈ' || char === 'ǋ' || char === 'ǲ')
    return String.fromCodePoint((char.codePointAt(0) as number) + 1);
  return singleCase(char, char.toLowerCase());
});
strict('toTitle', 1, ([a]) => {
  const char = a as string;
  const code = char.codePointAt(0) as number;
  // Georgian Mkhedruli letters have Mtavruli capitals but are their own title case.
  if ((code >= 0x10_d0 && code <= 0x10_fa) || (code >= 0x10_fd && code <= 0x10_ff)) return char;
  return TITLE_CASES[char] ?? greekIotaUpper(char) ?? singleCase(char, char.toUpperCase());
});

// ---------------------------------------------------------------------------------------------------------------
// Showing and reading numbers

define('readDecimal', 1, [], ([text], runtime) => BigInt(forceString(text, runtime)));
define('plainDecimal', 1, [], ([text], runtime) => {
  const plain = plainNumber(text, runtime, false);
  return plain
    ? tuple(bool(true), bool(plain.negative), BigInt(plain.token), plain.rest)
    : tuple(bool(false), bool(false), 0n, text);
});
define('plainFractional', 1, [], ([text], runtime) => {
  const plain = plainNumber(text, runtime, true);
  return plain
    ? tuple(bool(true), bool(plain.negative), unpackString(plain.token, 0), plain.rest)
    : tuple(bool(false), bool(false), NIL(), text);
});
define('readFloatText', 1, [], ([text], runtime) => {
  const parts = decimalParts(forceString(text, runtime));
  return tuple(...decimalRatio(parts, runtime));
});
for (const [name, convert] of [
  ['readDoubleText', rationalToDouble],
  ['readFloatValueText', rationalToFloat],
] as const) {
  define(name, 1, [], ([text], runtime) => {
    const parts = decimalParts(forceString(text, runtime));
    if (parts.digits.length === 0) return 0;
    const order = parts.digits.length + parts.exponent;
    if (order > 400) return Number.POSITIVE_INFINITY;
    if (order < -400) return 0;
    return convert(...decimalRatio(parts, runtime));
  });
}

interface DecimalParts {
  digits: string;
  exponent: number;
}

function decimalParts(source: string): DecimalParts {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return { digits: '', exponent: 0 };
  const digits = `${match[1]}${match[2] ?? ''}`.replace(/^0+/, '');
  return { digits, exponent: (match[3] ? Number(match[3]) : 0) - (match[2]?.length ?? 0) };
}

function decimalRatio({ digits, exponent }: DecimalParts, runtime: Runtime): [bigint, bigint] {
  if (digits.length === 0) return [0n, 1n];
  runtime.spend(Math.abs(exponent));
  const numerator = BigInt(digits);
  return exponent >= 0 ? [numerator * 10n ** BigInt(exponent), 1n] : [numerator, 10n ** BigInt(-exponent)];
}

define('readHexText', 1, [], ([text], runtime) => BigInt(`0x${forceString(text, runtime)}`));
define('readOctText', 1, [], ([text], runtime) => BigInt(`0o${forceString(text, runtime)}`));

// ---------------------------------------------------------------------------------------------------------------
// Control

define('seq', 2, [0], ([, b]) => b);
define('error', 1, [], ([message], runtime) => {
  throw haskellError(forceString(message, runtime));
});
define('errorEmptyList', 1, [], ([name], runtime) => {
  throw haskellError(`Prelude.${forceString(name, runtime)}: empty list`);
});
strict('primConTag', 1, ([a]) => BigInt((a as ConValue).con.tag));
strict('primConCount', 1, ([a]) => BigInt((a as ConValue).con.type.cons.length));
strict('primConAt', 2, ([a, n]) => nullary((a as ConValue).con.type.cons[Number(n as bigint)]));

// ---------------------------------------------------------------------------------------------------------------
// IO

define('ioReturn', 1, [], ([a]) => new IOReturn(a));
define('ioBind', 2, [], ([m, k]) => new IOBind(m, k));
define('ioThen', 2, [], ([m, n]) => new IOThen(m, n));

/**
 * Writes a string to a sink as it is evaluated, so that what precedes an error in it is still written, and that error,
 * not one the sink raises for the rest, is what escapes.
 */
export function writeString(slot: Slot, runtime: Runtime, write: (chunk: string) => void): void {
  let buffer = '';
  try {
    let current = runtime.machine.force(slot) as ConValue;
    while (current.con === CONS_CON) {
      const character = runtime.machine.force(current.fields[0]) as string;
      const codePoint = character.codePointAt(0)!;
      buffer += codePoint >= 0xd8_00 && codePoint <= 0xdf_ff ? '?' : character;
      if (buffer.length >= 256) {
        const chunk = buffer;
        buffer = '';
        write(chunk);
      }
      current = runtime.machine.force(current.fields[1]) as ConValue;
      runtime.spend();
    }
  } catch (error) {
    try {
      write(buffer);
    } catch {
      // The string's own failure came first, so it is the one the program sees.
    }
    throw error;
  }
  write(buffer);
}

define('divZeroError', 0, [], () => {
  throw divideByZero();
});
define('ratioZeroDenominatorError', 0, [], () => {
  throw new HaskellException('Ratio has zero denominator', { kind: 'arith', error: 'RatioZeroDenominator' });
});
define('overflowError', 0, [], () => {
  throw new HaskellException('arithmetic overflow', { kind: 'arith', error: 'Overflow' });
});
define('ioUnit', 0, [], () => new IOReturn(unit()));
define(
  'failIO',
  1,
  [],
  ([message], runtime) =>
    new IOPrim(
      'fail',
      () => {
        const description = forceString(message, runtime);
        throw new HaskellException(`user error (${description})`, {
          kind: 'io',
          type: 'UserError',
          location: '',
          description,
        });
      },
      [message]
    )
);
// ---------------------------------------------------------------------------------------------------------------
// Turtles

function turtleOf(slot: Slot, runtime: Runtime): TurtleValue {
  return runtime.machine.force(slot) as TurtleValue;
}

function turtleAction(name: string, args: Slot[], runtime: Runtime, act: (runtime: Runtime) => Value): IOPrim {
  return new IOPrim(name, () => act(runtime), args);
}

function createTurtle(runtime: Runtime, x: number, y: number, color: string | undefined): Value {
  const created = runtime.world.create(x, y, color);
  if ('error' in created) throw new HaskellException(created.error);
  return new TurtleValue(created);
}

define('newTurtle', 0, [], (_args, runtime) =>
  turtleAction('newTurtle', [], runtime, () => createTurtle(runtime, 0, 0, undefined))
);
define('newTurtleAt', 2, [], ([x, y], runtime) =>
  turtleAction('newTurtleAt', [x, y], runtime, () =>
    createTurtle(runtime, Number(runtime.machine.force(x)), Number(runtime.machine.force(y)), undefined)
  )
);
define('newTurtleWithColor', 3, [], ([x, y, color], runtime) =>
  turtleAction('newTurtleWithColor', [x, y, color], runtime, () =>
    createTurtle(
      runtime,
      Number(runtime.machine.force(x)),
      Number(runtime.machine.force(y)),
      forceString(color, runtime)
    )
  )
);

function defineTurtleMethod(names: readonly string[], act: (runtime: Runtime, turtle: TurtleValue) => Value): void {
  for (const name of names) {
    define(`turtle:${name}`, 1, [], ([turtle], runtime) =>
      turtleAction(name, [turtle], runtime, () => act(runtime, turtleOf(turtle, runtime)))
    );
  }
}

function moved(error: string | undefined): Value {
  if (error) throw new HaskellException(error);
  return unit();
}

defineTurtleMethod(TURTLE_METHOD_NAMES.forward, (runtime, { turtle }) => moved(runtime.world.move(turtle, 1)));
defineTurtleMethod(TURTLE_METHOD_NAMES.backward, (runtime, { turtle }) => moved(runtime.world.move(turtle, -1)));
defineTurtleMethod(TURTLE_METHOD_NAMES.turnRight, (runtime, { turtle }) => {
  runtime.world.turn(turtle, 1);
  return unit();
});
defineTurtleMethod(TURTLE_METHOD_NAMES.turnLeft, (runtime, { turtle }) => {
  runtime.world.turn(turtle, 3);
  return unit();
});
defineTurtleMethod(TURTLE_METHOD_NAMES.canMoveForward, (runtime, receiver) => {
  runtime.collectGarbage([receiver]);
  return bool(runtime.world.canMoveForward(receiver.turtle));
});
defineTurtleMethod(TURTLE_METHOD_NAMES.isFrontPainted, (runtime, { turtle }) =>
  bool(runtime.world.isFrontPainted(turtle))
);
defineTurtleMethod(TURTLE_METHOD_NAMES.remove, (runtime, { turtle }) => {
  runtime.world.remove(turtle);
  return unit();
});
