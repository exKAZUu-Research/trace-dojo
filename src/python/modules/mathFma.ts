import { exactBinary, scaleToFloat } from '../numbers';
import { pyError } from '../types';

/** `math.fma(x, y, z)`: x * y + z rounded once, from the exact product and sum, with math_fma_impl's errors. */
export function fma(x: number, y: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    // The exact product of finite factors never overflows, so only infinite factors make an infinite product.
    const product = Number.isFinite(x) && Number.isFinite(y) ? 0 : x * y;
    const result = product + z;
    if (Number.isNaN(result) && !Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) {
      throw pyError('ValueError', 'invalid operation in fma');
    }
    return result;
  }
  if (x === 0 || y === 0) {
    const product = x * y;
    return z === 0 ? product + z : z;
  }
  const a = exactBinary(x);
  const b = exactBinary(y);
  const c = exactBinary(z);
  const productExponent = a.exponent + b.exponent;
  const exponent = Math.min(productExponent, c.exponent);
  const sum =
    a.mantissa * b.mantissa * (1n << BigInt(productExponent - exponent)) +
    c.mantissa * (1n << BigInt(c.exponent - exponent));
  if (sum === 0n) return 0;
  const result = scaleToFloat(sum, exponent);
  if (!Number.isFinite(result)) throw pyError('OverflowError', 'overflow in fma');
  return result;
}
