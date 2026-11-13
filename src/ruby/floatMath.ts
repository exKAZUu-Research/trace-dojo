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

function roundedDouble(value: bigint, exponent: number): number {
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
