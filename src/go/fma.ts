import { scaleToFloat } from './constants';

/**
 * `a * b + c` rounded once, as Go's compiler computes `x*y + z` on arm64, where it fuses multiplications into the
 * additions and subtractions that use them (FMADD, FMSUB, FNMSUB).
 */
export function fma(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0 || b === 0) return a * b + c;
  // The exact product of finite factors is finite, so an infinite addend decides the result even where `a * b` overflows.
  if (!Number.isFinite(c)) return c;
  if (c === 0) return a * b;
  const x = exactBinary(a);
  const y = exactBinary(b);
  const z = exactBinary(c);
  const productExponent = x.exponent + y.exponent;
  const exponent = Math.min(productExponent, z.exponent);
  const sum =
    ((x.mantissa * y.mantissa) << BigInt(productExponent - exponent)) + (z.mantissa << BigInt(z.exponent - exponent));
  if (sum === 0n) return 0;
  return sum < 0n ? -scaleToFloat(-sum, exponent) : scaleToFloat(sum, exponent);
}

/** A finite double as an exact integer mantissa times a power of two. */
function exactBinary(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n);
  let mantissa = bits & ((1n << 52n) - 1n);
  if (biased !== 0) mantissa |= 1n << 52n;
  const exponent = biased === 0 ? -1074 : biased - 1075;
  return { mantissa: value < 0 ? -mantissa : mantissa, exponent };
}
