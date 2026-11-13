/** Parses numbers at the start of byte strings, as `strtol`, `strtod`, and `scanf` do. */

export function isSpaceByte(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

function digitValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x7a) return byte - 0x61 + 10;
  if (byte >= 0x41 && byte <= 0x5a) return byte - 0x41 + 10;
  return 99;
}

/**
 * The integer at the start of a string as `strtol` reads it: the value with its sign, its magnitude, and how many
 * bytes it takes (0 when no digits follow the white space and sign).
 */
// code-gauge-allow functionCognitiveComplexity 19 -- Sign, base detection, and digit consumption share one input cursor; separating branches would distribute that state.
export function parseIntegerPrefix(
  bytes: Uint8Array,
  requestedBase: number,
  maxLength = Number.POSITIVE_INFINITY
): { value: bigint; magnitude: bigint; length: number } {
  const limit = Math.min(bytes.length, maxLength);
  let index = 0;
  while (index < limit && isSpaceByte(bytes[index])) index++;
  let negative = false;
  if (index < limit && (bytes[index] === 0x2b || bytes[index] === 0x2d)) {
    negative = bytes[index] === 0x2d;
    index++;
  }
  let base = requestedBase;
  const hasHexPrefix =
    index + 1 < limit &&
    bytes[index] === 0x30 &&
    (bytes[index + 1] | 0x20) === 0x78 &&
    index + 2 < limit &&
    digitValue(bytes[index + 2]) < 16;
  if ((base === 0 || base === 16) && hasHexPrefix) {
    base = 16;
    index += 2;
  } else if (base === 0) {
    base = index < limit && bytes[index] === 0x30 ? 8 : 10;
  }
  if (base < 2 || base > 36) return { value: 0n, magnitude: 0n, length: 0 };
  const start = index;
  let magnitude = 0n;
  const bigBase = BigInt(base);
  while (index < limit && digitValue(bytes[index]) < base) {
    magnitude = magnitude * bigBase + BigInt(digitValue(bytes[index]));
    index++;
  }
  if (index === start) return { value: 0n, magnitude: 0n, length: 0 };
  return { value: negative ? -magnitude : magnitude, magnitude, length: index };
}

/** The floating-point number at the start of a string as `strtod` reads it. */
// code-gauge-allow functionCognitiveComplexity 30 -- The forms strtod accepts: decimal, hexadecimal, infinity, NaN.
// code-gauge-allow functionNcss 35 -- Decimal, hexadecimal, infinity, and NaN prefixes share one consumed-length contract.
export function parseFloatPrefix(
  bytes: Uint8Array,
  maxLength = Number.POSITIVE_INFINITY
): { value: number; length: number; isInfinityText: boolean; isNonzeroText: boolean } {
  const limit = Math.min(bytes.length, maxLength);
  let index = 0;
  while (index < limit && isSpaceByte(bytes[index])) index++;
  let sign = 1;
  if (index < limit && (bytes[index] === 0x2b || bytes[index] === 0x2d)) {
    sign = bytes[index] === 0x2d ? -1 : 1;
    index++;
  }
  const rest = String.fromCodePoint(...bytes.subarray(index, limit)).toLowerCase();
  if (rest.startsWith('inf')) {
    const length = rest.startsWith('infinity') ? 8 : 3;
    return {
      value: sign * Number.POSITIVE_INFINITY,
      length: index + length,
      isInfinityText: true,
      isNonzeroText: true,
    };
  }
  if (rest.startsWith('nan')) {
    const paren = /^nan\([\da-z_]*\)/.exec(rest);
    return {
      value: Number.NaN,
      length: index + (paren ? paren[0].length : 3),
      isInfinityText: true,
      isNonzeroText: true,
    };
  }
  const hex = /^0x([\da-f]*)(?:\.([\da-f]*))?(?:p([+-]?\d+))?/.exec(rest);
  if (hex && (hex[1] || hex[2])) {
    const integer = hex[1] ?? '';
    const fraction = hex[2] ?? '';
    const mantissa = BigInt(`0x${integer + fraction || '0'}`);
    const exponent = Number(hex[3] ?? '0') - fraction.length * 4;
    const value = sign * hexToDouble(mantissa, exponent);
    const matched = hex[3] === undefined ? `0x${integer}${hex[2] === undefined ? '' : `.${fraction}`}` : hex[0];
    return { value, length: index + matched.length, isInfinityText: false, isNonzeroText: mantissa !== 0n };
  }
  const decimal = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?/.exec(rest);
  if (!decimal || !(decimal[1] || decimal[2])) {
    return { value: 0, length: 0, isInfinityText: false, isNonzeroText: false };
  }
  let matched = decimal[0];
  if (/e[+-]?$/.test(matched)) matched = matched.replace(/e[+-]?$/, '');
  if (decimal[3] === undefined && /e/.test(matched)) matched = matched.replace(/e.*$/, '');
  const value = sign * Number(matched.startsWith('.') ? `0${matched}` : matched);
  return {
    value,
    length: index + matched.length,
    isInfinityText: false,
    isNonzeroText: /[1-9]/.test(matched.replace(/e.*$/, '')),
  };
}

/** mantissa × 2^exponent, rounded to the nearest double with ties to even. */
function hexToDouble(mantissa: bigint, exponent: number): number {
  if (mantissa === 0n) return 0;
  const bits = mantissa.toString(2).length;
  // Keep 54 significant bits plus a sticky bit, so that Number's conversion rounds once, correctly.
  if (bits > 60) {
    const shift = bits - 60;
    const sticky = (mantissa & ((1n << BigInt(shift)) - 1n)) === 0n ? 0n : 1n;
    return hexToDouble((mantissa >> BigInt(shift)) | sticky, exponent + shift);
  }
  return Number(mantissa) * 2 ** exponent;
}
