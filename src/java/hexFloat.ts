const HEX_FLOAT = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)[fFdD]?$/;

/** The significand bits and the lowest normal exponent of `double` and `float`. */
const FORMATS = { double: { precision: 53, minExponent: -1022 }, float: { precision: 24, minExponent: -126 } };

/**
 * The value a hexadecimal floating-point literal such as `0x1.8p1` denotes, rounded once to the nearest `double`
 * (or `float`, which `Math.fround` then holds exactly), or `undefined` for other text, as Java reads it in source and
 * in `Double.parseDouble` and `Float.parseFloat`.
 */
export function parseHexFloat(text: string, format: keyof typeof FORMATS = 'double'): number | undefined {
  const match = HEX_FLOAT.exec(text);
  if (!match) return undefined;
  const [, sign, integer = '', fraction = '', exponent = '0'] = match;
  if (integer === '' && fraction === '') return undefined;
  const value = roundBinary(BigInt(`0x${integer}${fraction}`), Number(exponent) - 4 * fraction.length, format);
  return sign === '-' ? -value : value;
}

/** `significand` × 2^`exponent`, rounded half to even to the format's precision, subnormals and overflow included. */
function roundBinary(significand: bigint, exponent: number, format: keyof typeof FORMATS): number {
  if (significand === 0n) return 0;
  const { precision, minExponent } = FORMATS[format];
  const bits = significand.toString(2).length;
  // The exponent of the leading bit decides how many bits fit: fewer once the value falls below the normal range.
  const leading = bits - 1 + exponent;
  const kept = leading >= minExponent ? precision : precision - (minExponent - leading);
  if (kept < 0) return 0;
  const shift = bits - kept;
  let rounded = significand;
  if (shift > 0) {
    const big = BigInt(shift);
    rounded = significand >> big;
    const remainder = significand - (rounded << big);
    const half = 1n << (big - 1n);
    if (remainder > half || (remainder === half && (rounded & 1n) === 1n)) rounded += 1n;
  }
  return scale(Number(rounded), exponent + Math.max(shift, 0));
}

/** `value` × 2^`exponent`, in steps that keep each power of two finite and normal. */
function scale(value: number, exponent: number): number {
  let result = value;
  let remaining = exponent;
  while (remaining !== 0 && result !== 0 && Number.isFinite(result)) {
    const step = Math.max(-1000, Math.min(1000, remaining));
    result *= 2 ** step;
    remaining -= step;
  }
  return result;
}
