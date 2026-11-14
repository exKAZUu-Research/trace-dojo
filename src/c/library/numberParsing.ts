import { exactParts, roundBinary } from './binaryFloat';

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
 * The integer prefix with its sign, magnitude and consumed length (0 when no digits follow the sign).
 * Magnitudes beyond uint64 retain only an overflow sentinel while scanning continues to the end of the prefix.
 */
// code-gauge-allow functionCognitiveComplexity 23 -- Sign, base detection, bounded accumulation and digit consumption share one input cursor; separating branches would distribute that state.
// code-gauge-allow functionNcss 31 -- Prefix classification and the consumed-length result share the same scan cursor.
export function parseIntegerPrefix(
  bytes: Uint8Array,
  requestedBase: number,
  maxLength = Number.POSITIVE_INFINITY,
  spend?: () => void
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
    if (index % 64 === 0) spend?.();
    if (magnitude <= 0xff_ff_ff_ff_ff_ff_ff_ffn) magnitude = magnitude * bigBase + BigInt(digitValue(bytes[index]));
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
  const rest = new TextDecoder('latin1').decode(bytes.subarray(index, limit)).toLowerCase();
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
    const value = sign * roundBinary(mantissa, 1n, exponent);
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

export function isExactFloatPrefix(bytes: Uint8Array, length: number, value: number): boolean {
  const text = new TextDecoder().decode(bytes.subarray(0, length)).trim().replace(/^[+-]/, '').toLowerCase();
  const hex = /^0x([\da-f]*)(?:\.([\da-f]*))?(?:p([+-]?\d+))?$/.exec(text);
  const decimal = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(text);
  const match = hex ?? decimal;
  if (!match) return false;
  const fraction = match[2] ?? '';
  const digits = (match[1] ?? '') + fraction;
  const coefficient = BigInt((hex ? '0x' : '') + (digits || '0'));
  const exponent = Number(match[3] ?? 0) - fraction.length * (hex ? 4 : 1);
  if (!Number.isFinite(exponent) || Math.abs(exponent) > 5000) return coefficient === 0n && value === 0;
  const parts = exactParts(Math.abs(value));
  const binaryShift = parts.exponent - (hex ? exponent : 0);
  let left = parts.mantissa;
  let right = coefficient;
  if (binaryShift >= 0) left <<= BigInt(binaryShift);
  else right <<= BigInt(-binaryShift);
  if (!hex) {
    if (exponent >= 0) right *= 10n ** BigInt(exponent);
    else left *= 10n ** BigInt(-exponent);
  }
  return left === right;
}
