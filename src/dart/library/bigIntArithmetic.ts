import type { Runtime } from '../runtime';

export function modInverse(runtime: Runtime, value: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  const modulusWords = bigintWords(modulus);
  const reduced = modularRemainder(runtime, value, modulus, modulusWords);
  let oldR = modulus;
  let r = reduced < 0n ? reduced + modulus : reduced;
  let oldS = 0n;
  let s = 1n;
  while (r > 1n) {
    chargeDivision(runtime, oldR, bigintWords(r));
    const quotient = oldR / r;
    runtime.budget.checkClock();
    [oldR, r] = [r, oldR - multiply(runtime, quotient, r)];
    [oldS, s] = [s, oldS - multiply(runtime, quotient, s)];
  }
  if (r === 0n) runtime.throwError('Exception', '', ['Not coprime']);
  return s < 0n ? s + modulus : s;
}

export function modularRemainder(runtime: Runtime, value: bigint, modulus: bigint, modulusWords: number): bigint {
  if (value < modulus && value > -modulus) return value;
  chargeDivision(runtime, value, modulusWords);
  const remainder = value % modulus;
  runtime.budget.checkClock();
  return remainder;
}

function chargeDivision(runtime: Runtime, dividend: bigint, divisorWords: number): void {
  const words = bigintWords(dividend);
  runtime.spend(1 + (words + divisorWords) / 64 + ((words - divisorWords + 1) * divisorWords) / 128);
}

export function multiply(runtime: Runtime, left: bigint, right: bigint): bigint {
  runtime.spend(1 + (bigintWords(left) * bigintWords(right)) / 128);
  const product = left * right;
  runtime.budget.checkClock();
  return product;
}

export function bigintWords(value: bigint): number {
  return Math.max(1, Math.ceil(magnitudeBitLength(value) / 32));
}

export function magnitudeBitLength(value: bigint): number {
  if (value === 0n) return 0;
  const hex = (value < 0n ? -value : value).toString(16);
  return (hex.length - 1) * 4 + 32 - Math.clz32(Number.parseInt(hex[0], 16));
}
