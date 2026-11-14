import { rt } from './runtime';

const bits = new DataView(new ArrayBuffer(8));
const FRACTION_MASK = (1n << 52n) - 1n;
const SIGN_BIT = 1n << 63n;

export function fusedMultiplyAdd(x: number, y: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return x * y + z;
  const left = dyadic(x);
  const right = dyadic(y);
  const addend = dyadic(z);
  const productExponent = left.exponent + right.exponent;
  const exponent = Math.min(productExponent, addend.exponent);
  const product = (left.mantissa * right.mantissa) << BigInt(productExponent - exponent);
  const sum = product + (addend.mantissa << BigInt(addend.exponent - exponent));
  return roundedDouble(sum, exponent);
}

export function floatFraction(value: number): { numerator: bigint | number; denominator: bigint } {
  if (!Number.isFinite(value)) return { numerator: value, denominator: 1n };
  const { mantissa, exponent } = dyadic(value);
  if (exponent >= 0) return { numerator: mantissa << BigInt(exponent), denominator: 1n };
  if (mantissa === 0n) return { numerator: 0n, denominator: 1n };
  let numerator = mantissa;
  let denominator = 1n << BigInt(-exponent);
  while (denominator > 1n && numerator % 2n === 0n) {
    numerator /= 2n;
    denominator /= 2n;
  }
  return { numerator, denominator };
}

export function frexpDouble(value: number): [number, number] {
  if (value === 0 || !Number.isFinite(value)) return [value, 0];
  const { mantissa, exponent } = dyadic(value);
  const width = (mantissa < 0n ? -mantissa : mantissa).toString(2).length;
  return [Number(mantissa) / 2 ** width, exponent + width];
}

export function ldexpDouble(value: number, exponent: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  if (exponent > 2000) return value < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (exponent < -2000) return value < 0 ? -0 : 0;
  const dyad = dyadic(value);
  return roundedDouble(dyad.mantissa, dyad.exponent + exponent);
}

export function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return Number(numerator) / 0;
  if (numerator === 0n) return denominator < 0n ? -0 : 0;
  const negative = numerator < 0n !== denominator < 0n;
  const left = numerator < 0n ? -numerator : numerator;
  const right = denominator < 0n ? -denominator : denominator;
  let exponent = left.toString(2).length - right.toString(2).length;
  if (exponent >= 0 ? left < right << BigInt(exponent) : left << BigInt(-exponent) < right) exponent--;
  if (exponent > 1023) return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (exponent < -1075) return negative ? -0 : 0;
  const unitExponent = Math.max(exponent - 52, -1074);
  const shift = -unitExponent;
  const scaledNumerator = shift >= 0 ? left << BigInt(shift) : left;
  const scaledDenominator = shift >= 0 ? right : right << BigInt(-shift);
  let significand = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  const twice = remainder * 2n;
  if (twice > scaledDenominator || (twice === scaledDenominator && significand % 2n !== 0n)) significand++;
  if (significand === 0n) return negative ? -0 : 0;
  return roundedDouble(negative ? -significand : significand, unitExponent);
}

export function floatStepCount(begin: number, end: number, step: number, exclusive = false): number {
  if (Number.isNaN(begin) || Number.isNaN(end) || Number.isNaN(step)) return Number.NaN;
  if (step === 0) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(step)) return step > 0 ? Number(begin <= end) : Number(begin >= end);
  let count = (end - begin) / step;
  const error = Math.min(
    0.5,
    ((Math.abs(begin) + Math.abs(end) + Math.abs(end - begin)) / Math.abs(step)) * Number.EPSILON
  );
  if (exclusive) {
    if (count <= 0) return 0;
    count = Math.floor(count + error) + 1;
    if (!Number.isSafeInteger(count) || error === 0.5) return count;
    const inside = (index: number): boolean =>
      step > 0 ? fusedMultiplyAdd(index, step, begin) < end : fusedMultiplyAdd(index, step, begin) > end;
    while (count > 0 && !inside(count - 1)) {
      rt().spend();
      count--;
    }
    while (Number.isSafeInteger(count) && inside(count)) {
      rt().spend();
      count++;
    }
    return count;
  } else {
    if (count < 0) return 0;
    count = Math.floor(count + error);
    const next = (count + 1) * step + begin;
    if ((begin < end && next <= end) || (begin > end && next >= end)) count++;
  }
  return count + 1;
}

function dyadic(value: number): { mantissa: bigint; exponent: number } {
  bits.setFloat64(0, value);
  const raw = bits.getBigUint64(0);
  const sign = raw & SIGN_BIT ? -1n : 1n;
  const storedExponent = Number((raw >> 52n) & 0x7_ffn);
  const fraction = raw & FRACTION_MASK;
  return storedExponent === 0
    ? { mantissa: sign * fraction, exponent: -1074 }
    : { mantissa: sign * ((1n << 52n) | fraction), exponent: storedExponent - 1075 };
}

export function roundedDouble(value: bigint, exponent: number): number {
  if (value === 0n) return 0;
  const sign = value < 0n ? SIGN_BIT : 0n;
  const magnitude = value < 0n ? -value : value;
  const leadingExponent = exponent + magnitude.toString(2).length - 1;
  if (leadingExponent > 1023) return sign ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (leadingExponent < -1022) {
    const fraction = roundAtExponent(magnitude, -1074 - exponent);
    if (fraction === 0n) return sign ? -0 : 0;
    return fromBits(sign | (fraction >= 1n << 52n ? 1n << 52n : fraction));
  }
  let storedExponent = leadingExponent + 1023;
  let significand = roundAtExponent(magnitude, leadingExponent - 52 - exponent);
  if (significand >= 1n << 53n) {
    significand >>= 1n;
    storedExponent++;
  }
  if (storedExponent >= 2047) return sign ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  return fromBits(sign | (BigInt(storedExponent) << 52n) | (significand & FRACTION_MASK));
}

function roundAtExponent(value: bigint, shift: number): bigint {
  if (shift <= 0) return value << BigInt(-shift);
  const quotient = value >> BigInt(shift);
  const remainder = value - (quotient << BigInt(shift));
  const half = 1n << BigInt(shift - 1);
  return remainder > half || (remainder === half && (quotient & 1n) !== 0n) ? quotient + 1n : quotient;
}

function fromBits(value: bigint): number {
  bits.setBigUint64(0, value);
  return bits.getFloat64(0);
}
