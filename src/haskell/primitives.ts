// code-gauge-allow-file fileNcss 420 -- The primitive table lists every built-in operation the Haskell library calls.
import { TURTLE_METHOD_NAMES } from '../interpreter/turtleWorld';
import { CONS_CON, tupleCon, UNIT_CON } from './builtinTypes';
import type { ConInfo } from './entities';
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
  TurtleValue,
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

function define(name: string, arity: number, strict: Primitive['strict'], fn: Primitive['fn']): void {
  registry.set(name, { name, arity, strict, fn });
}

/** Defines a primitive whose arguments are all forced, taking their values. */
function strict(name: string, arity: number, fn: (args: Value[], runtime: Runtime) => PrimResult): void {
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

export function isTrue(value: Value): boolean {
  return (value as ConValue).con.tag === 1;
}

const unit = (): Value => nullary(UNIT_CON);

export function tuple(...items: Slot[]): Value {
  return new ConValue(tupleCon(items.length), items);
}

export function listOf(items: readonly Slot[]): Value {
  let result: Value = NIL();
  for (let index = items.length - 1; index >= 0; index--) result = cons(items[index], result);
  return result;
}

/** Forces a whole list, returning its elements (unevaluated). */
export function forceList(slot: Slot, runtime: Runtime): Slot[] {
  const items: Slot[] = [];
  let current = runtime.machine.force(slot) as ConValue;
  while (current.con === CONS_CON) {
    items.push(current.fields[0]);
    current = runtime.machine.force(current.fields[1]) as ConValue;
    runtime.spend();
  }
  return items;
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

function haskellError(message: string): HaskellException {
  return new HaskellException(message, 'ErrorCall');
}

const INT_MIN = -(2n ** 63n);

function wrapInt(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

function divideByZero(): HaskellException {
  return new HaskellException('divide by zero', 'ArithException');
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

// code-gauge-allow functionCognitiveComplexity 23 -- Each branch reproduces one of GHC's error or overflow behaviors for integral division.
// code-gauge-allow functionNcss 32 -- Each branch reproduces one of GHC's error or overflow behaviors for integral division.
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
        throw new HaskellException('arithmetic overflow', 'ArithException');
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
  strict(`${prefix}Compare`, 2, ([a, b]) => ordering((a as bigint) < (b as bigint) ? -1 : a === b ? 0 : 1));
  strict(`${prefix}Show`, 1, ([a]) => unpackString((a as bigint).toString(), 0));
  strict(`${prefix}ToDouble`, 1, ([a]) => bigintToDouble(a as bigint));
  strict(`${prefix}ToFloat`, 1, ([a]) => Math.fround(bigintToDouble(a as bigint)));
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
strict('wordShiftL', 2, ([a, b]) => ((b as bigint) >= 64n ? 0n : BigInt.asUintN(64, (a as bigint) << (b as bigint))));
strict('wordShiftR', 2, ([a, b]) => ((b as bigint) >= 64n ? 0n : (a as bigint) >> (b as bigint)));
strict('wordPopCount', 1, ([a]) => BigInt(countOnes(a as bigint)));
strict('integerToInt', 1, ([a]) => wrapInt(a as bigint));
strict('intToInteger', 1, ([a]) => a);
strict('integerPow', 2, ([a, b], runtime) => {
  const exponent = b as bigint;
  const base = a as bigint;
  const bits = (base < 0n ? -base : base).toString(2).length;
  runtime.spend(Math.ceil((bits * Number(exponent)) / 4096) + 1);
  return base ** exponent;
});
strict('intPow', 2, ([a, b]) => {
  let result = 1n;
  let base = a as bigint;
  let exponent = b as bigint;
  while (exponent > 0n) {
    if (exponent & 1n) result = wrapInt(result * base);
    base = wrapInt(base * base);
    exponent >>= 1n;
  }
  return result;
});
strict('integerGcd', 2, ([a, b]) => {
  let x = (a as bigint) < 0n ? -(a as bigint) : (a as bigint);
  let y = (b as bigint) < 0n ? -(b as bigint) : (b as bigint);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
});

// Bits
strict('intAnd', 2, ([a, b]) => wrapInt((a as bigint) & (b as bigint)));
strict('intOr', 2, ([a, b]) => wrapInt((a as bigint) | (b as bigint)));
strict('intXor', 2, ([a, b]) => wrapInt((a as bigint) ^ (b as bigint)));
strict('intComplement', 1, ([a]) => wrapInt(~(a as bigint)));
strict('intShiftL', 2, ([a, b]) => ((b as bigint) >= 64n ? 0n : wrapInt((a as bigint) << (b as bigint))));
strict('intShiftR', 2, ([a, b]) =>
  (b as bigint) >= 64n ? ((a as bigint) < 0n ? -1n : 0n) : (a as bigint) >> (b as bigint)
);
strict('intPopCount', 1, ([a]) => BigInt(countOnes(BigInt.asUintN(64, a as bigint))));
strict('integerAnd', 2, ([a, b]) => (a as bigint) & (b as bigint));
strict('integerOr', 2, ([a, b]) => (a as bigint) | (b as bigint));
strict('integerXor', 2, ([a, b]) => (a as bigint) ^ (b as bigint));
strict('integerComplement', 1, ([a]) => ~(a as bigint));
strict('integerShiftL', 2, ([a, b]) => (a as bigint) << (b as bigint));
strict('integerShiftR', 2, ([a, b]) => (a as bigint) >> (b as bigint));
strict('integerPopCount', 1, ([a]) => {
  const value = a as bigint;
  const count = countOnes(value < 0n ? ~value : value);
  return BigInt(value < 0n ? -count : count);
});

// ---------------------------------------------------------------------------------------------------------------
// Double and Float

// code-gauge-allow functionNcss 40 -- One definition per floating-point primitive.
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
  const unary: Record<string, (value: number) => number> = {
    Exp: Math.exp,
    Log: Math.log,
    Sqrt: Math.sqrt,
    Sin: Math.sin,
    Cos: Math.cos,
    Tan: Math.tan,
    Asin: Math.asin,
    Acos: Math.acos,
    Atan: Math.atan,
    Sinh: Math.sinh,
    Cosh: Math.cosh,
    Tanh: Math.tanh,
    Asinh: Math.asinh,
    Acosh: Math.acosh,
    Atanh: Math.atanh,
  };
  for (const [name, op] of Object.entries(unary)) strict(`${prefix}${name}`, 1, ([a]) => round(op(a as number)));
  strict(`${prefix}Pow`, 2, ([a, b]) => round((a as number) ** (b as number)));
  strict(`${prefix}LogBase`, 2, ([a, b]) => round(Math.log(b as number) / Math.log(a as number)));
  strict(`${prefix}Atan2`, 2, ([a, b]) => round(Math.atan2(a as number, b as number)));
  strict(`${prefix}IsNaN`, 1, ([a]) => bool(Number.isNaN(a)));
  strict(`${prefix}IsInfinite`, 1, ([a]) => bool(a === Number.POSITIVE_INFINITY || a === Number.NEGATIVE_INFINITY));
  strict(`${prefix}IsNegativeZero`, 1, ([a]) => bool(Object.is(a, -0)));
  strict(`${prefix}Truncate`, 1, ([a]) => {
    const value = a as number;
    if (!Number.isFinite(value)) return truncateNonFinite(value, prefix);
    return BigInt(Math.trunc(value));
  });
  strict(`${prefix}FromInteger`, 1, ([a]) => round(bigintToDouble(a as bigint)));
  strict(`${prefix}Digits`, 1, ([a]) => {
    const { digits, exponent } = floatToDigits(a as number, prefix === 'float');
    return tuple(listOf(digits.map(BigInt)), BigInt(exponent));
  });
  strict(`${prefix}Decode`, 1, ([a]) => {
    const { mantissa, exponent } = decodeFloat(a as number, prefix === 'float');
    return tuple(mantissa, BigInt(exponent));
  });
  strict(`${prefix}Encode`, 2, ([m, e]) => round(encodeFloat(m as bigint, Number(e))));
  strict(`${prefix}FromRational`, 2, ([n, d]) =>
    prefix === 'float' ? rationalToFloat(n as bigint, d as bigint) : rationalToDouble(n as bigint, d as bigint)
  );
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
// code-gauge-allow functionCognitiveComplexity 24 -- Decoding follows the IEEE 754 cases for normal, subnormal, and special values.
// code-gauge-allow functionNcss 42 -- Decoding follows the IEEE 754 cases for normal, subnormal, and special values.
export function decodeFloat(value: number, isFloat: boolean): { mantissa: bigint; exponent: number } {
  const bits = isFloat ? 24 : 53;
  if (value === 0) return { mantissa: 0n, exponent: 0 };
  if (!Number.isFinite(value)) {
    // GHC decodes the IEEE bit pattern: infinity as 2^(bits-1) * 2^(max exponent), NaN with its payload.
    const sign = value < 0 ? -1n : 1n;
    if (Number.isNaN(value)) {
      return isFloat ? { mantissa: -12_582_912n, exponent: 105 } : { mantissa: -6_755_399_441_055_744n, exponent: 972 };
    }
    return isFloat
      ? { mantissa: sign * 8_388_608n, exponent: 105 }
      : { mantissa: sign * 4_503_599_627_370_496n, exponent: 972 };
  }
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

function encodeFloat(mantissa: bigint, exponent: number): number {
  return rationalToDouble(
    exponent >= 0 ? mantissa << BigInt(exponent) : mantissa,
    exponent >= 0 ? 1n : 1n << BigInt(-exponent)
  );
}

/** The double nearest to n/d, rounding half to even. */
export function rationalToDouble(numerator: bigint, denominator: bigint): number {
  return rationalToBinary(numerator, denominator, 53, -1074, 1023);
}

function rationalToFloat(numerator: bigint, denominator: bigint): number {
  return Math.fround(rationalToBinary(numerator, denominator, 24, -149, 127));
}

// code-gauge-allow functionCognitiveComplexity 18 -- Rounding to nearest even needs the scaling and tie cases together.
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

/** The shortest decimal digits that identify a float, and its exponent: x = 0.d1d2... * 10^exponent. */
export function floatToDigits(value: number, isFloat: boolean): { digits: number[]; exponent: number } {
  if (value === 0) return { digits: [0], exponent: 0 };
  const magnitude = Math.abs(value);
  let text: string;
  if (isFloat) {
    text = '';
    for (let precision = 1; precision <= 9; precision++) {
      const candidate = magnitude.toPrecision(precision);
      if (Math.fround(Number(candidate)) === magnitude) {
        text = Number(candidate).toExponential();
        break;
      }
    }
  } else {
    text = magnitude.toExponential();
  }
  const [mantissa, exponentText] = text.split('e');
  const digits = Array.from(mantissa.replace('.', ''), Number);
  while (digits.length > 1 && digits.at(-1) === 0) digits.pop();
  return { digits, exponent: Number(exponentText) + 1 };
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
strict('ord', 1, ([a]) => BigInt((a as string).codePointAt(0) as number));
strict('chr', 1, ([a]) => {
  const code = a as bigint;
  if (code < 0n || code > 0x10_ff_ffn) throw haskellError(`Prelude.chr: bad argument: ${showSignedInt(code)}`);
  return String.fromCodePoint(Number(code));
});

function showSignedInt(value: bigint): string {
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

/** GHC's `generalCategory` as the index of its constructor in `GeneralCategory`. */
strict('generalCategory', 1, ([a]) => {
  const char = a as string;
  const index = CATEGORY_PATTERNS.findIndex(([, pattern]) => pattern.test(char));
  return BigInt(index === -1 ? 29 : index);
});

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
  return singleCase(char, char.toUpperCase());
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
  return TITLE_CASES[char] ?? singleCase(char, char.toUpperCase());
});

// ---------------------------------------------------------------------------------------------------------------
// Showing and reading numbers

define('readDecimal', 1, [], ([text], runtime) => BigInt(forceString(text, runtime)));
define('readFloatText', 1, [], ([text], runtime) => {
  // A lexeme `lex` accepted as a number: digits, a fraction, an exponent.
  const source = forceString(text, runtime);
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return tuple(0n, 1n);
  const digits = BigInt(`${match[1]}${match[2] ?? ''}`);
  const exponent = (match[3] ? Number(match[3]) : 0) - (match[2]?.length ?? 0);
  if (exponent > 100_000 || exponent < -100_000) {
    return exponent > 0 ? tuple(digits === 0n ? 0n : 10n ** 400n, 1n) : tuple(0n, 1n);
  }
  return exponent >= 0 ? tuple(digits * 10n ** BigInt(exponent), 1n) : tuple(digits, 10n ** BigInt(-exponent));
});
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

// ---------------------------------------------------------------------------------------------------------------
// IO

define('ioReturn', 1, [], ([a]) => new IOReturn(a));
define('ioBind', 2, [], ([m, k]) => new IOBind(m, k));
define('ioThen', 2, [], ([m, n]) => new IOThen(m, n));

/** Writes a string as it is evaluated, so that what precedes an error in it is still written. */
function writeLazily(slot: Slot, runtime: Runtime, channel: 'stdout' | 'stderr', suffix: string): void {
  let buffer = '';
  const out = runtime.io[channel];
  try {
    let current = runtime.machine.force(slot) as ConValue;
    while (current.con === CONS_CON) {
      buffer += runtime.machine.force(current.fields[0]) as string;
      if (buffer.length >= 256) {
        out.write(buffer);
        buffer = '';
      }
      current = runtime.machine.force(current.fields[1]) as ConValue;
      runtime.spend();
    }
  } finally {
    out.write(buffer);
  }
  if (suffix) out.write(suffix);
}

define(
  'putStr',
  1,
  [],
  ([text], runtime) =>
    new IOPrim(
      'putStr',
      () => {
        writeLazily(text, runtime, 'stdout', '');
        return unit();
      },
      [text]
    )
);
define(
  'putStrLn',
  1,
  [],
  ([text], runtime) =>
    new IOPrim(
      'putStrLn',
      () => {
        writeLazily(text, runtime, 'stdout', '\n');
        return unit();
      },
      [text]
    )
);
define(
  'hPutStr',
  2,
  [0],
  ([handle, text], runtime) =>
    new IOPrim(
      'hPutStr',
      () => {
        writeLazily(text, runtime, (handle as ConValue).con.tag === 0 ? 'stdout' : 'stderr', '');
        return unit();
      },
      [text]
    )
);
define('ioUnit', 0, [], () => new IOReturn(unit()));
define(
  'failIO',
  1,
  [],
  ([message], runtime) =>
    new IOPrim(
      'fail',
      () => {
        throw new HaskellException(`user error (${forceString(message, runtime)})`, 'IOException');
      },
      [message]
    )
);
define(
  'ioError',
  1,
  [],
  ([message], runtime) =>
    new IOPrim(
      'ioError',
      () => {
        throw new HaskellException(forceString(message, runtime), 'IOException');
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
  if ('error' in created) throw new HaskellException(created.error, 'ErrorCall');
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
  if (error) throw new HaskellException(error, 'ErrorCall');
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
defineTurtleMethod(TURTLE_METHOD_NAMES.canMoveForward, (runtime, { turtle }) =>
  bool(runtime.world.canMoveForward(turtle))
);
defineTurtleMethod(TURTLE_METHOD_NAMES.isFrontPainted, (runtime, { turtle }) =>
  bool(runtime.world.isFrontPainted(turtle))
);
defineTurtleMethod(TURTLE_METHOD_NAMES.remove, (runtime, { turtle }) => {
  runtime.world.remove(turtle);
  return unit();
});
