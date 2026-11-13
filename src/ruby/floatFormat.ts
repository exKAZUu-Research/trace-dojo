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
  let scaled: bigint;
  if (scale <= precision) scaled = digits * 10n ** BigInt(precision - scale);
  else scaled = divideHalfEven(digits, 10n ** BigInt(scale - precision));
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
