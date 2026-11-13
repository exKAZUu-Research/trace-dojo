import { exactBinary, scaleToFloat } from './numbers';

/**
 * `x ** y` rounded correctly (to the nearest float, halves to even), which the host's `**` is not: CPython takes the
 * C library's pow, whose results are the correctly rounded ones in all but about one case in a thousand. A negative
 * `x` needs an integral `y`; the caller raises CPython's errors for an infinite or a zero result.
 */
export function floatPower(x: number, y: number): number {
  if (x === 1 || y === 0) return 1;
  if (x === -1 && (y === Number.POSITIVE_INFINITY || y === Number.NEGATIVE_INFINITY)) return 1;
  // Apart from the two cases above, which C defines and ECMAScript does not, the host is exact for special values.
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0) return x ** y;
  if (x > 0) return positivePower(x, y);
  if (!Number.isInteger(y)) return Number.NaN;
  const magnitude = positivePower(-x, y);
  return y % 2 === 0 ? magnitude : -magnitude;
}

/** The power of a finite positive base to a finite non-zero exponent. */
function positivePower(x: number, y: number): number {
  // One correctly rounded host operation gives each of these.
  if (y === 1) return x;
  if (y === 2) return x * x;
  if (y === -1) return 1 / x;
  if (y === 0.5) return Math.sqrt(x);
  return rationalPower(x, y) ?? irrationalPower(x, y);
}

/** The largest integer whose power is computed exactly, as a product of the bits of the base and the exponent. */
const MAX_EXACT_BITS = 2048;

/**
 * The power when it is a rational number that may be a float or lie halfway between two floats, from exact integer
 * arithmetic; undefined for the others, which no approximation of enough precision rounds wrongly.
 *
 * With x = m * 2**e and y = n * 2**q (m and n odd), the power is rational only when q >= 0 or x is the 2**-q th
 * power of such a number, whose square roots are taken here. Its numerator or denominator is then a power of m, an
 * odd number of too many bits for a float or a halfway point once it exceeds the limit.
 */
function rationalPower(x: number, y: number): number | undefined {
  const base = oddBinary(x);
  const power = oddBinary(y);
  let m = Number(base.mantissa);
  let e = base.exponent;
  let q = power.exponent;
  for (; q < 0; q++) {
    const root = Math.sqrt(m);
    if (e % 2 !== 0 || !Number.isInteger(root) || root * root !== m) return undefined;
    m = root;
    e /= 2;
  }
  const n = Number(power.mantissa) * 2 ** q;
  if (m === 1) return powerOfTwo(e * n);
  const bits = m.toString(2).length;
  if (bits * Math.abs(n) > MAX_EXACT_BITS) return undefined;
  const numerator = BigInt(m) ** BigInt(Math.abs(n));
  if (n > 0) return scaleToFloat(numerator, e * n);
  // An odd divisor above 1 never divides a power of two, so a sticky bit below 55 quotient bits decides the rounding.
  const shift = numerator.toString(2).length + 55;
  return scaleToFloat(((1n << BigInt(shift)) / numerator) | 1n, e * n - shift);
}

/** A finite non-zero double as an odd integer times a power of two. */
function oddBinary(value: number): { mantissa: bigint; exponent: number } {
  let { mantissa, exponent } = exactBinary(value);
  while ((mantissa & 1n) === 0n) {
    mantissa >>= 1n;
    exponent++;
  }
  return { mantissa, exponent };
}

function powerOfTwo(exponent: number): number {
  if (exponent > 1024) return Number.POSITIVE_INFINITY;
  if (exponent < -1075) return 0;
  return scaleToFloat(1n, exponent);
}

/**
 * The power when it is irrational or a rational of too many bits to be a float or a halfway point: an approximation
 * with an error bound, of a precision doubled until both ends of the bound round to the same float.
 */
function irrationalPower(x: number, y: number): number {
  // The estimate only has to tell the powers far out of the range of floats, which would need long shifts.
  const estimate = y * Math.log2(x);
  if (estimate > 1100) return Number.POSITIVE_INFINITY;
  if (estimate < -1200) return 0;
  for (let precision = 128; ; precision *= 2) {
    const { mantissa, error, exponent } = approximatePower(x, y, precision);
    const low = scaleToFloat(mantissa - error, exponent);
    if (low === scaleToFloat(mantissa + error, exponent)) return low;
  }
}

/**
 * `x ** y` as `mantissa * 2 ** exponent`, within `error` of the mantissa, computed as 2**k * exp(r) with
 * y * ln(x) = k * ln(2) + r in fixed point of `precision` fractional bits. The error bounds are generous multiples of
 * the precision, since each series adds less than one unit of error for each of its terms, fewer than the bits.
 */
function approximatePower(
  x: number,
  y: number,
  precision: number
): { mantissa: bigint; error: bigint; exponent: number } {
  const bits = BigInt(precision);
  const ln2 = lnTwo(precision);
  const lnX = fixedLn(x, precision, ln2);
  const lnError = bits << 12n;
  const { mantissa: n, exponent: q } = exactBinary(y);
  const magnitude = n < 0n ? -n : n;
  const product = n * lnX;
  const t = q >= 0 ? product << BigInt(q) : product >> BigInt(-q);
  const tError = (q >= 0 ? (magnitude * lnError) << BigInt(q) : (magnitude * lnError) >> BigInt(-q)) + 1n;
  let k = t / ln2;
  if (t % ln2 < 0n) k--;
  return {
    mantissa: fixedExp(t - k * ln2, precision),
    error: 2n * tError + (bits << 14n),
    exponent: Number(k) - precision,
  };
}

const LN_TWO = new Map<number, bigint>();

/** ln(2) in fixed point, as 2 * atanh(1/3). */
function lnTwo(precision: number): bigint {
  let result = LN_TWO.get(precision);
  if (result === undefined) {
    result = 2n * fixedAtanh((1n << BigInt(precision)) / 3n, precision);
    LN_TWO.set(precision, result);
  }
  return result;
}

/** ln(x) in fixed point, as k * ln(2) + 2 * atanh((f - 1) / (f + 1)) with x = f * 2**k and f near 1. */
function fixedLn(x: number, precision: number, ln2: bigint): bigint {
  const { mantissa, exponent } = exactBinary(x);
  const length = mantissa.toString(2).length;
  const one = 1n << BigInt(precision);
  let f = mantissa << BigInt(precision - length);
  let k = exponent + length;
  // f moves from [1/2, 1) to (2/3, 4/3], where the argument of atanh is smallest.
  if (f * 3n <= 2n * one) {
    f <<= 1n;
    k--;
  }
  const z = ((f - one) << BigInt(precision)) / (f + one);
  const atanh = z < 0n ? -fixedAtanh(-z, precision) : fixedAtanh(z, precision);
  return BigInt(k) * ln2 + 2n * atanh;
}

/** atanh(z) in fixed point for a small non-negative z, by its Taylor series. */
function fixedAtanh(z: bigint, precision: number): bigint {
  const bits = BigInt(precision);
  const square = (z * z) >> bits;
  let sum = z;
  let term = z;
  for (let divisor = 3n; term > 0n; divisor += 2n) {
    term = (term * square) >> bits;
    sum += term / divisor;
  }
  return sum;
}

const EXP_HALVINGS = 8n;

/** exp(r) in fixed point for r in [0, ln 2), by the Taylor series of exp(r / 2**8), squared 8 times. */
function fixedExp(r: bigint, precision: number): bigint {
  const bits = BigInt(precision);
  const reduced = r >> EXP_HALVINGS;
  let sum = (1n << bits) + reduced;
  let term = reduced;
  for (let divisor = 2n; term > 0n; divisor++) {
    term = ((term * reduced) >> bits) / divisor;
    sum += term;
  }
  for (let squaring = 0n; squaring < EXP_HALVINGS; squaring++) sum = (sum * sum) >> bits;
  return sum;
}
