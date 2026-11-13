/** The exact decimal value of a finite double's magnitude, as `digits / 10 ** scale`. */
export function exactDecimal(value: number): { digits: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7_ffn);
  let mantissa = bits & 0xf_ff_ff_ff_ff_ff_ffn;
  let exponent: number;
  if (exponentBits === 0) {
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent = exponentBits - 1075;
  }
  if (exponent >= 0) return { digits: mantissa << BigInt(exponent), scale: 0 };
  return { digits: mantissa * 5n ** BigInt(-exponent), scale: -exponent };
}

/** Divides with rounding half to even, as C's printf rounds an exact decimal expansion. */
function divideHalfEven(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  const twice = (dividend % divisor) * 2n;
  if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) return quotient + 1n;
  return quotient;
}

/** The digits of `|value|` rounded to `precision` decimals, as C's `%.*f` makes them (without the sign). */
export function fixedDigits(value: number, precision: number): string {
  const { digits, scale } = exactDecimal(value);
  const scaled =
    scale <= precision
      ? digits * 10n ** BigInt(precision - scale)
      : divideHalfEven(digits, 10n ** BigInt(scale - precision));
  const text = scaled.toString().padStart(precision + 1, '0');
  if (precision === 0) return text;
  return `${text.slice(0, -precision)}.${text.slice(-precision)}`;
}

/** The mantissa digits and exponent of `|value|` rounded to `precision` decimals after the first digit (`%.*e`). */
export function exponentParts(value: number, precision: number): { mantissa: string; exponent: number } {
  if (value === 0) return { mantissa: precision > 0 ? `0.${'0'.repeat(precision)}` : '0', exponent: 0 };
  const { digits, scale } = exactDecimal(value);
  const text = digits.toString();
  let exponent = text.length - 1 - scale;
  const keep = precision + 1;
  let significant: bigint;
  if (text.length > keep) {
    significant = divideHalfEven(digits, 10n ** BigInt(text.length - keep));
    if (significant.toString().length > keep) {
      significant /= 10n;
      exponent++;
    }
  } else {
    significant = digits * 10n ** BigInt(keep - text.length);
  }
  const shown = significant.toString();
  return { mantissa: precision > 0 ? `${shown[0]}.${shown.slice(1)}` : shown, exponent };
}

/** C's `round`: half away from zero. */
export function roundHalfAway(value: number): number {
  const truncated = Math.trunc(value);
  return Math.abs(value - truncated) >= 0.5 ? truncated + Math.sign(value) : truncated;
}

/** `Float#round(ndigits)` for ndigits > 0, as Ruby computes it with doubles. */
export function roundFloatDigits(value: number, ndigits: number, mode: 'up' | 'even' | 'down'): number {
  const binaryExponent = frexpExponent(value);
  if (ndigits >= 17 - (binaryExponent > 0 ? Math.trunc(binaryExponent / 4) : Math.trunc(binaryExponent / 3) - 1)) {
    return value;
  }
  if (
    value > 0 &&
    ndigits < -(binaryExponent > 0 ? Math.trunc(binaryExponent / 3) + 1 : Math.trunc(binaryExponent / 4))
  ) {
    return 0;
  }
  if (ndigits > 14) return roundByRational(value, ndigits, mode);
  const scale = 10 ** ndigits;
  let rounded: number;
  if (mode === 'up') rounded = roundHalfUp(value, scale);
  else if (mode === 'down') rounded = roundHalfDown(value, scale);
  else rounded = roundHalfEven(value, scale);
  return rounded / scale;
}

function roundHalfUp(x: number, s: number): number {
  const xs = x * s;
  let f = roundHalfAway(xs);
  if (s === 1) return f;
  if (x > 0) {
    if ((f + 0.5) / s <= x) f += 1;
  } else if ((f - 0.5) / s >= x) {
    f -= 1;
  }
  return f;
}

function roundHalfDown(x: number, s: number): number {
  const xs = x * s;
  let f = roundHalfAway(xs);
  if (x > 0) {
    if ((f - 0.5) / s >= x) f -= 1;
  } else if ((f + 0.5) / s <= x) {
    f += 1;
  }
  return f;
}

function roundHalfEven(x: number, s: number): number {
  const xs = x * s;
  if (x > 0) {
    const u = Math.floor(xs);
    const v = xs - u;
    if (v > 0.5 || (v === 0.5 && u % 2 === 1)) return u + 1;
    return u;
  }
  const u = Math.ceil(xs);
  const v = u - xs;
  if (v > 0.5 || (v === 0.5 && Math.abs(u) % 2 === 1)) return u - 1;
  return u;
}

function roundByRational(value: number, ndigits: number, mode: 'up' | 'even' | 'down'): number {
  const { digits, scale } = exactDecimal(value);
  if (scale <= ndigits) return value;
  const divisor = 10n ** BigInt(scale - ndigits);
  let quotient = digits / divisor;
  const twice = (digits % divisor) * 2n;
  if (twice > divisor || (twice === divisor && (mode === 'up' || (mode === 'even' && quotient % 2n === 1n)))) {
    quotient += 1n;
  }
  return Math.sign(value) * Number(`${quotient}e-${ndigits}`);
}

/** The exponent `frexp` returns: `value = m * 2 ** e` with `0.5 <= |m| < 1`. */
export function frexpExponent(value: number): number {
  if (value === 0 || !Number.isFinite(value)) return 0;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const exponentBits = (view.getUint16(0) >> 4) & 0x7_ff;
  if (exponentBits === 0) return frexpExponent(value * 2 ** 64) - 64;
  return exponentBits - 1022;
}

const TENS = Array.from({ length: 23 }, (_, index) => 10 ** index);
const BIG_TENS = [1e16, 1e32, 1e64, 1e128, 1e256];
const QUICK_MAX = 14;

/**
 * The digits of a positive finite double as Ruby's `dtoa` gives them in mode 2 (`ndigits` significant digits) or
 * mode 3 (`ndigits` digits after the point), which `format` prints. Ruby's copy of `dtoa` first tries floating-point
 * arithmetic and, when the rest is within its error bound of one half, rounds the digits it has half to even, so a
 * value such as 2.675 (just below 2.675) prints as 2.68; otherwise the result is the exactly rounded one.
 */
export function rubyDtoa(value: number, mode: 2 | 3, requested: number): { digits: string; decpt: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const exponentBits = (view.getUint16(0) >> 4) & 0x7_ff;
  let mantissaScaled: number;
  let binaryExponent: number;
  if (exponentBits === 0) {
    binaryExponent = frexpExponent(value) - 1;
    mantissaScaled = value / 2 ** binaryExponent;
  } else {
    binaryExponent = exponentBits - 1023;
    mantissaScaled = value / 2 ** binaryExponent;
  }
  const estimate = (mantissaScaled - 1.5) * 0.289529654602168 + 0.1760912590558 + binaryExponent * 0.301029995663981;
  let k = Math.trunc(estimate);
  if (estimate < 0 && estimate !== k) k--;
  let kCheck = true;
  if (k >= 0 && k <= 22) {
    if (value < TENS[k]) k--;
    kCheck = false;
  }
  let ndigits = requested;
  let ilim: number;
  let ilim1: number;
  if (mode === 2) {
    if (ndigits <= 0) ndigits = 1;
    ilim = ndigits;
    ilim1 = ndigits;
  } else {
    ilim = ndigits + k + 1;
    ilim1 = ilim - 1;
  }
  let half = false;
  if (ilim >= 0 && ilim <= QUICK_MAX) {
    const quick = quickDigits(value, k, ilim, ilim1, kCheck);
    if (quick.result) return quick.result;
    half = quick.half;
  }
  return exactDigits(value, mode, ndigits, half);
}

function quickDigits(
  value: number,
  k0: number,
  ilim0: number,
  ilim1: number,
  kCheck: boolean
): { result?: { digits: string; decpt: number }; half: boolean } {
  let d = value;
  let k = k0;
  let ilim = ilim0;
  let ieps = 2;
  if (k > 0) {
    let ds = TENS[k & 0xf];
    let j = k >> 4;
    if (j & 0x10) {
      j &= 0xf;
      d /= BIG_TENS[4];
      ieps++;
    }
    for (let i = 0; j; j >>= 1, i++) {
      if (j & 1) {
        ieps++;
        ds *= BIG_TENS[i];
      }
    }
    d /= ds;
  } else if (k < 0) {
    const j1 = -k;
    d *= TENS[j1 & 0xf];
    for (let j = j1 >> 4, i = 0; j; j >>= 1, i++) {
      if (j & 1) {
        ieps++;
        d *= BIG_TENS[i];
      }
    }
  }
  if (kCheck && d < 1 && ilim > 0) {
    if (ilim1 <= 0) return { half: false };
    ilim = ilim1;
    k--;
    d *= 10;
    ieps++;
  }
  let eps = (ieps * d + 7) * 2 ** -52;
  if (ilim === 0) {
    d -= 5;
    if (d > eps) return { result: { digits: '1', decpt: k + 2 }, half: false };
    if (d < -eps) return { result: { digits: '', decpt: k + 1 }, half: false };
    return { half: false };
  }
  eps *= TENS[ilim - 1];
  const digits: number[] = [];
  for (let i = 1; ; i++, d *= 10) {
    const digit = Math.trunc(d);
    d -= digit;
    if (d === 0) ilim = i;
    digits.push(digit);
    if (i === ilim) {
      if (d > 0.5 + eps) return { result: bumpUp(digits, k), half: false };
      if (d < 0.5 - eps) return { result: { digits: trimZeros(digits), decpt: k + 1 }, half: false };
      if ((digits.at(-1) ?? 0) & 1) return { result: bumpUp(digits, k), half: true };
      return { half: true };
    }
  }
}

function bumpUp(digits: number[], k: number): { digits: string; decpt: number } {
  let index = digits.length - 1;
  while (index >= 0 && digits[index] === 9) index--;
  if (index < 0) return { digits: '1', decpt: k + 2 };
  digits[index]++;
  return { digits: trimZeros(digits.slice(0, index + 1)), decpt: k + 1 };
}

function trimZeros(digits: number[]): string {
  let end = digits.length;
  while (end > 0 && digits[end - 1] === 0) end--;
  return digits.slice(0, end).join('');
}

function exactDigits(value: number, mode: 2 | 3, ndigits: number, half: boolean): { digits: string; decpt: number } {
  const { digits: mantissa, scale } = exactDecimal(value);
  const text = mantissa.toString();
  const k = text.length - 1 - scale;
  const ilim = mode === 2 ? ndigits : ndigits + k + 1;
  if (ilim <= 0) {
    if (ilim < 0) return { digits: '', decpt: -ndigits };
    // Compare the value with half of 10 ** (k + 1).
    const doubled = mantissa * 2n;
    const unit = 10n ** BigInt(text.length);
    return doubled <= unit ? { digits: '', decpt: -ndigits } : { digits: '1', decpt: k + 2 };
  }
  if (text.length <= ilim) return { digits: text.replace(/0+$/, ''), decpt: k + 1 };
  const divisor = 10n ** BigInt(text.length - ilim);
  let quotient = mantissa / divisor;
  const twice = (mantissa % divisor) * 2n;
  const lastOdd = quotient % 2n === 1n;
  if ((twice > divisor || (twice === divisor && lastOdd)) && (!half || lastOdd)) quotient += 1n;
  let shown = quotient.toString();
  let decpt = k + 1;
  if (shown.length > ilim) {
    shown = shown.slice(0, ilim);
    decpt++;
  }
  return { digits: shown.replace(/0+$/, ''), decpt };
}
