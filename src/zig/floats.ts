/**
 * Floating-point numbers of every Zig float type. `f16`, `f32`, and `f64` values are JavaScript numbers rounded to
 * their type; `f80`, `f128`, and `comptime_float` (which Zig computes as `f128`) are {@link BigFloat}s, computed
 * exactly and rounded to nearest, ties to even, as IEEE 754 requires.
 */

export interface FloatFormat {
  /** The significand's bits, including the leading bit. */
  precision: number;
  /** The exponent of the smallest normal number. */
  minExponent: number;
  /** The exponent of the largest finite number. */
  maxExponent: number;
}

export const FORMATS: Record<16 | 32 | 64 | 80 | 128, FloatFormat> = {
  16: { precision: 11, minExponent: -14, maxExponent: 15 },
  32: { precision: 24, minExponent: -126, maxExponent: 127 },
  64: { precision: 53, minExponent: -1022, maxExponent: 1023 },
  80: { precision: 64, minExponent: -16_382, maxExponent: 16_383 },
  128: { precision: 113, minExponent: -16_382, maxExponent: 16_383 },
};

/** A float held exactly as `(-1)^sign * mantissa * 2^exponent`, or an infinity or NaN. */
export class BigFloat {
  constructor(
    readonly sign: boolean,
    readonly kind: 'finite' | 'inf' | 'nan',
    readonly mantissa: bigint,
    readonly exponent: number
  ) {}

  static zero(sign = false): BigFloat {
    return new BigFloat(sign, 'finite', 0n, 0);
  }

  get isZero(): boolean {
    return this.kind === 'finite' && this.mantissa === 0n;
  }
}

export type FloatBits = 16 | 32 | 64 | 80 | 128;

const LOG10_2 = Math.log10(2);

/** A float value of any width: a number for the widths JavaScript computes exactly, or a BigFloat. */
export type AnyFloat = number | BigFloat;

// Exact rationals ---------------------------------------------------------------------------------------------------

/** A finite value as `num / den` with `den > 0`, or a special value. */
interface Rational {
  sign: boolean;
  num: bigint;
  den: bigint;
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/** Rounds `num / den` (both positive) to a format, ties to even, giving a BigFloat. */
export function roundRational(sign: boolean, num: bigint, den: bigint, format: FloatFormat): BigFloat {
  if (num === 0n) return BigFloat.zero(sign);
  const { precision, minExponent, maxExponent } = format;
  // Choose e so that num / den / 2^e has `precision` bits before the point.
  let e = bitLength(num) - bitLength(den) - precision;
  const scaled = (exp: number): [bigint, bigint] => (exp >= 0 ? [num, den << BigInt(exp)] : [num << BigInt(-exp), den]);
  let [n, d] = scaled(e);
  if (n / d >= 1n << BigInt(precision)) {
    e++;
    [n, d] = scaled(e);
  } else if (n / d < 1n << BigInt(precision - 1)) {
    e--;
    [n, d] = scaled(e);
  }
  // Subnormal numbers have fewer bits.
  const minQuantum = minExponent - (precision - 1);
  if (e < minQuantum) {
    e = minQuantum;
    [n, d] = scaled(e);
  }
  let q = n / d;
  const remainder = n - q * d;
  const twice = remainder * 2n;
  if (twice > d || (twice === d && (q & 1n) === 1n)) q++;
  if (q === 1n << BigInt(precision)) {
    q >>= 1n;
    e++;
  }
  if (q !== 0n && e + precision - 1 > maxExponent) return new BigFloat(sign, 'inf', 0n, 0);
  return normalize(new BigFloat(sign, 'finite', q, e));
}

/** Removes trailing zero bits, so that equal values compare equal field by field. */
function normalize(value: BigFloat): BigFloat {
  if (value.kind !== 'finite' || value.mantissa === 0n)
    return value.kind === 'finite' ? BigFloat.zero(value.sign) : value;
  let { mantissa, exponent } = value;
  while ((mantissa & 1n) === 0n) {
    mantissa >>= 1n;
    exponent++;
  }
  return new BigFloat(value.sign, 'finite', mantissa, exponent);
}

function toRational(value: BigFloat): Rational {
  const { sign, mantissa, exponent } = value;
  return exponent >= 0
    ? { sign, num: mantissa << BigInt(exponent), den: 1n }
    : { sign, num: mantissa, den: 1n << BigInt(-exponent) };
}

// Conversions ---------------------------------------------------------------------------------------------------------

/** The exact BigFloat of a JavaScript number. */
export function bigFloatOf(value: number): BigFloat {
  if (Number.isNaN(value)) return new BigFloat(false, 'nan', 0n, 0);
  const sign = value < 0 || Object.is(value, -0);
  if (!Number.isFinite(value)) return new BigFloat(sign, 'inf', 0n, 0);
  if (value === 0) return BigFloat.zero(sign);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n);
  const fraction = bits & ((1n << 52n) - 1n);
  if (biased === 0) return normalize(new BigFloat(sign, 'finite', fraction, -1074));
  return normalize(new BigFloat(sign, 'finite', fraction | (1n << 52n), biased - 1075));
}

/** Rounds a BigFloat to a width that JavaScript numbers hold exactly. */
export function toNumber(value: BigFloat, bits: 16 | 32 | 64 = 64): number {
  if (value.kind === 'nan') return Number.NaN;
  if (value.kind === 'inf') return value.sign ? -Infinity : Infinity;
  const rounded = roundTo(value, bits);
  if (rounded.kind === 'inf') return rounded.sign ? -Infinity : Infinity;
  if (rounded.mantissa === 0n) return rounded.sign ? -0 : 0;
  // The value fits a double exactly, so scaling by powers of two is exact.
  let result = Number(rounded.mantissa);
  let { exponent } = rounded;
  while (exponent > 0) {
    const step = Math.min(exponent, 1000);
    result *= 2 ** step;
    exponent -= step;
  }
  while (exponent < 0) {
    const step = Math.min(-exponent, 1000);
    result /= 2 ** step;
    exponent += step;
  }
  return rounded.sign ? -result : result;
}

/** Rounds a value to a float type. */
export function roundTo(value: BigFloat, bits: FloatBits): BigFloat {
  if (value.kind !== 'finite' || value.mantissa === 0n) return value;
  const format = FORMATS[bits];
  const topExponent = value.exponent + value.mantissa.toString(2).length - 1;
  if (topExponent > format.maxExponent) return new BigFloat(value.sign, 'inf', 0n, 0);
  if (topExponent < format.minExponent - format.precision) return new BigFloat(value.sign, 'finite', 0n, 0);
  const { num, den } = toRational(value);
  return roundRational(value.sign, num, den, format);
}

/** A float of a width as the representation its type uses. */
export function floatOf(value: BigFloat, bits: FloatBits): AnyFloat {
  return bits <= 64 ? toNumber(value, bits as 16 | 32 | 64) : roundTo(value, bits);
}

export function asBigFloat(value: AnyFloat): BigFloat {
  return typeof value === 'number' ? bigFloatOf(value) : value;
}

/** Rounds a JavaScript number to a narrower type. */
export function roundNumber(value: number, bits: 16 | 32 | 64): number {
  if (bits === 64) return value;
  if (bits === 32) return Math.fround(value);
  return Math.f16round(value);
}

/** The float nearest to an integer. */
export function floatFromBigInt(value: bigint, bits: FloatBits): AnyFloat {
  const sign = value < 0n;
  const rounded = roundRational(sign, sign ? -value : value, 1n, FORMATS[bits]);
  return floatOf(rounded, bits);
}

/** The integer part of a finite float, truncating toward zero. */
export function truncateToBigInt(value: AnyFloat): bigint {
  const big = asBigFloat(value);
  if (big.kind !== 'finite') throw new Error('not finite');
  const { num, den } = toRational(big);
  const quotient = num / den;
  return big.sign ? -quotient : quotient;
}

/** Whether a float holds an integer. */
export function isIntegral(value: AnyFloat): boolean {
  const big = asBigFloat(value);
  return big.kind === 'finite' && big.exponent >= 0;
}

// Arithmetic ----------------------------------------------------------------------------------------------------------

function specialResult(a: BigFloat, b: BigFloat, operator: '+' | '-' | '*' | '/'): BigFloat | undefined {
  if (a.kind === 'finite' && b.kind === 'finite') return undefined;
  // Infinities and NaNs follow the double's rules, whose results have the same kind in every format.
  const result = arithmeticNumber(specialNumber(a), specialNumber(b), operator);
  return bigFloatOf(result);
}

function specialNumber(value: BigFloat): number {
  if (value.kind === 'nan') return Number.NaN;
  if (value.kind === 'inf') return value.sign ? -Infinity : Infinity;
  if (value.mantissa === 0n) return value.sign ? -0 : 0;
  return value.sign ? -1 : 1;
}

function arithmeticNumber(a: number, b: number, operator: '+' | '-' | '*' | '/'): number {
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
    default: {
      return a / b;
    }
  }
}

/** `a op b` rounded to a format, for BigFloats. */
// code-gauge-allow functionNcss 39 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
export function bigArithmetic(a: BigFloat, b: BigFloat, operator: '+' | '-' | '*' | '/', bits: FloatBits): BigFloat {
  const special = specialResult(a, b, operator);
  if (special) return special.kind === 'finite' ? roundTo(special, bits) : special;
  const format = FORMATS[bits];
  const x = toRational(a);
  const y = toRational(b);
  const xn = x.sign ? -x.num : x.num;
  const yn = y.sign ? -y.num : y.num;
  let num: bigint;
  let den: bigint;
  switch (operator) {
    case '+':
    case '-': {
      const ys = operator === '+' ? yn : -yn;
      num = xn * y.den + ys * x.den;
      den = x.den * y.den;
      if (num === 0n) {
        // An exact zero sum is +0, unless both operands are -0 (or one -0 is subtracted from the other).
        const negative = a.sign && (operator === '+' ? b.sign : !b.sign);
        return BigFloat.zero(negative && a.isZero);
      }
      break;
    }
    case '*': {
      num = xn * yn;
      den = x.den * y.den;
      if (num === 0n) return BigFloat.zero(a.sign !== b.sign);
      break;
    }
    default: {
      if (b.isZero) return bigFloatOf(arithmeticNumber(specialNumber(a), specialNumber(b), '/'));
      num = xn * y.den;
      den = x.den * yn;
      if (den < 0n) {
        num = -num;
        den = -den;
      }
      if (num === 0n) return BigFloat.zero(a.sign !== b.sign);
    }
  }
  const sign = num < 0n;
  return roundRational(sign, sign ? -num : num, den, format);
}

/** `a op b` for floats of a type. */
export function floatArithmetic(a: AnyFloat, b: AnyFloat, operator: '+' | '-' | '*' | '/', bits: FloatBits): AnyFloat {
  if (bits <= 64) {
    // Rounding a double's result to a narrower type is exact for these operations, since a double has more than twice
    // their precision.
    return roundNumber(arithmeticNumber(a as number, b as number, operator), bits as 16 | 32 | 64);
  }
  return bigArithmetic(asBigFloat(a), asBigFloat(b), operator, bits);
}

export function negate(value: AnyFloat): AnyFloat {
  if (typeof value === 'number') return -value;
  return new BigFloat(!value.sign, value.kind, value.mantissa, value.exponent);
}

export function minMaxFloat(a: AnyFloat, b: AnyFloat, isMax: boolean, comptime = false): AnyFloat {
  if (isNaNFloat(a)) return b;
  if (isNaNFloat(b)) return a;
  const order = compareFloats(a, b) ?? 0;
  if (order === 0 && signBit(a) !== signBit(b)) return comptime ? b : isMax === signBit(a) ? b : a;
  return isMax ? (order >= 0 ? a : b) : order <= 0 ? a : b;
}

/** Compares two floats: -1, 0, or 1, or undefined when either is NaN. */
// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
export function compareFloats(a: AnyFloat, b: AnyFloat): -1 | 0 | 1 | undefined {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const x = asBigFloat(a);
  const y = asBigFloat(b);
  if (x.kind === 'nan' || y.kind === 'nan') return undefined;
  if (x.kind === 'inf' || y.kind === 'inf') {
    const xs = infinityRank(x);
    const ys = infinityRank(y);
    return xs < ys ? -1 : xs > ys ? 1 : 0;
  }
  const rx = toRational(x);
  const ry = toRational(y);
  const left = (rx.sign ? -rx.num : rx.num) * ry.den;
  const right = (ry.sign ? -ry.num : ry.num) * rx.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

function infinityRank(value: BigFloat): number {
  return value.kind === 'inf' ? (value.sign ? -1 : 1) : 0;
}

export function isNaNFloat(value: AnyFloat): boolean {
  return typeof value === 'number' ? Number.isNaN(value) : value.kind === 'nan';
}

export function isInfinite(value: AnyFloat): boolean {
  return typeof value === 'number' ? value === Infinity || value === -Infinity : value.kind === 'inf';
}

export function signBit(value: AnyFloat): boolean {
  return typeof value === 'number' ? value < 0 || Object.is(value, -0) : value.sign;
}

/** The correctly rounded square root. */
export function floatSqrt(value: AnyFloat, bits: FloatBits): AnyFloat {
  if (bits <= 64) return roundNumber(Math.sqrt(value as number), bits as 16 | 32 | 64);
  const big = asBigFloat(value);
  if (big.kind === 'nan' || (big.sign && !big.isZero)) return new BigFloat(false, 'nan', 0n, 0);
  if (big.kind === 'inf' || big.isZero) return big;
  const format = FORMATS[bits];
  // Scale to an even exponent with enough bits that the integer root has the precision plus guard bits.
  let { mantissa, exponent } = big;
  const shift = 2 * (format.precision + 4) - bitLength(mantissa);
  let extra = Math.max(shift, 0);
  if ((exponent - extra) % 2 !== 0) extra++;
  mantissa <<= BigInt(extra);
  exponent -= extra;
  const root = integerSqrt(mantissa);
  const exact = root * root === mantissa;
  // A sticky bit makes the inexact root round as the exact one would.
  const num = (root << 1n) | (exact ? 0n : 1n);
  const resultExponent = exponent / 2 - 1;
  return resultExponent >= 0
    ? roundRational(false, num << BigInt(resultExponent), 1n, format)
    : roundRational(false, num, 1n << BigInt(-resultExponent), format);
}

export function integerSqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = 1n << BigInt(Math.ceil(bitLength(value) / 2));
  for (;;) {
    const y = (x + value / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

// Literals ------------------------------------------------------------------------------------------------------------

/** Parses a Zig float literal (decimal or hexadecimal, with `_` separators) to the nearest float of a format. */
// code-gauge-allow functionNcss 32 -- Keeps decimal and hexadecimal literal conversion together.
// code-gauge-allow functionCognitiveComplexity 19 -- Checks both literal radices before allocating their exact values.
export function parseFloatLiteral(text: string, bits: FloatBits): BigFloat {
  const clean = text.replaceAll('_', '');
  const format = FORMATS[bits];
  if (/^0x/i.test(clean)) {
    const match = /^0x([\da-f]*)(?:\.([\da-f]*))?(?:p([+-]?\d+))?$/i.exec(clean);
    if (!match) return new BigFloat(false, 'nan', 0n, 0);
    const whole = match[1] ?? '';
    const fraction = match[2] ?? '';
    const digits = BigInt(`0x${whole}${fraction}` === '0x' ? '0' : `0x${whole}${fraction}`);
    const binaryExponent = Number(match[3] ?? '0') - 4 * fraction.length;
    if (digits === 0n) return BigFloat.zero();
    if (binaryExponent > format.maxExponent + format.precision) return new BigFloat(false, 'inf', 0n, 0);
    if (binaryExponent + digits.toString(2).length < format.minExponent - format.precision) return BigFloat.zero();
    return binaryExponent >= 0
      ? roundRational(false, digits << BigInt(binaryExponent), 1n, format)
      : roundRational(false, digits, 1n << BigInt(-binaryExponent), format);
  }
  const match = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(clean);
  if (!match) return new BigFloat(false, 'nan', 0n, 0);
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  const digits = BigInt(`${whole}${fraction}` || '0');
  const decimalExponent = Number(match[3] ?? '0') - fraction.length;
  // Exponents far outside any format round to zero or infinity.
  if (digits === 0n) return BigFloat.zero();
  if (decimalExponent > 10_000) return new BigFloat(false, 'inf', 0n, 0);
  if (decimalExponent < -10_000) return BigFloat.zero();
  return decimalExponent >= 0
    ? roundRational(false, digits * 10n ** BigInt(decimalExponent), 1n, format)
    : roundRational(false, digits, 10n ** BigInt(-decimalExponent), format);
}

// Shortest decimal ----------------------------------------------------------------------------------------------------

/** A decimal `mantissa * 10^exponent`, as Ryu (`std.fmt.float.binaryToDecimal`) gives one. */
export interface Decimal {
  sign: boolean;
  mantissa: bigint;
  exponent: number;
  special?: 'inf' | 'nan';
}

/**
 * The shortest decimal that rounds back to a float of its type, the one nearest the float among those (ties to an even
 * last digit), which is what Ryu computes. A float halfway between two decimals of the interval's ends belongs to it
 * when the float's significand is even, as round-to-nearest-even reads it back.
 */
// code-gauge-allow functionNcss 45 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
// code-gauge-allow functionCognitiveComplexity 27 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
export function shortestDecimal(value: AnyFloat, bits: FloatBits): Decimal {
  const big = asBigFloat(value);
  if (big.kind === 'nan') return { sign: big.sign, mantissa: 1n, exponent: 0, special: 'nan' };
  if (big.kind === 'inf') return { sign: big.sign, mantissa: 0n, exponent: 0, special: 'inf' };
  if (big.isZero) return { sign: big.sign, mantissa: 0n, exponent: 0 };
  const format = FORMATS[bits];
  // Express the value with its type's significand M (precision bits, or fewer when subnormal) and quantum 2^E.
  let significand = big.mantissa;
  let quantum = big.exponent;
  const minQuantum = format.minExponent - (format.precision - 1);
  while (bitLength(significand) < format.precision && quantum > minQuantum) {
    significand <<= 1n;
    quantum--;
  }
  const lowerIsCloser = significand === 1n << BigInt(format.precision - 1) && quantum > minQuantum;
  // Work in units of 2^(E-2), so that the interval's ends are integers.
  const scale = quantum - 2;
  const v = significand * 4n;
  const upper = v + 2n;
  const lower = lowerIsCloser ? v - 1n : v - 2n;
  const inclusive = (significand & 1n) === 0n;
  const [num, numDen] = scale >= 0 ? [1n << BigInt(scale), 1n] : [1n, 1n << BigInt(-scale)];
  // A decimal d * 10^k lies in the interval when lower <= d * 10^k / (2^scale) <= upper.
  const high = Math.ceil((bitLength(upper) + scale) * LOG10_2) + 1;
  for (let k = high; ; k--) {
    // d * 10^k * numDen <= upper * num   and   d * 10^k * numDen >= lower * num
    const [left, right] = k >= 0 ? [10n ** BigInt(k) * numDen, 1n] : [numDen, 10n ** BigInt(-k)];
    // d * left <= upper * num * right
    const upperBound = upper * num * right;
    const lowerBound = lower * num * right;
    let dMax = upperBound / left;
    if (!inclusive && dMax * left === upperBound) dMax--;
    let dMin = (lowerBound + left - 1n) / left;
    if (!inclusive && dMin * left === lowerBound) dMin++;
    if (dMin > dMax) continue;
    // The candidate nearest the value: v * num * right / left.
    const target = v * num * right;
    let d = target / left;
    const remainder = target - d * left;
    if (remainder * 2n > left || (remainder * 2n === left && (d & 1n) === 1n)) d++;
    if (d < dMin) d = dMin;
    if (d > dMax) d = dMax;
    return { sign: big.sign, mantissa: d, exponent: k };
  }
}
