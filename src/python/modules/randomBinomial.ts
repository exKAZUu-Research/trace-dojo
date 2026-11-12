import { intToFloat } from '../numbers';
import { currentRuntime } from '../runtimeContext';
import { pyError } from '../types';
import { lgamma } from './mathGamma';
import type { RandomSource } from './randomDistributions';

/**
 * The BTRS branch of `binomialvariate` in CPython 3.14's Lib/random.py (transformed rejection with squeeze), for
 * `n * p >= 10` and `p <= 0.5`, with Python's mixed int and float arithmetic: an int operand is converted to a float.
 */
export function transformedRejection(source: RandomSource, n: bigint, p: number): bigint {
  const spq = Math.sqrt(intToFloat(n) * p * (1 - p));
  const b = 1.15 + 2.53 * spq;
  const a = -0.0873 + 0.0248 * b + 0.01 * p;
  const c = intToFloat(n) * p + 0.5;
  const vr = 0.92 - 4.2 / b;
  let setup: { alpha: number; lpq: number; m: bigint; h: number } | undefined;
  const runtime = currentRuntime();
  for (;;) {
    runtime.spend();
    const u = source.random() - 0.5;
    const us = 0.5 - Math.abs(u);
    // Python raises ZeroDivisionError here, which the loop takes as a rejection.
    if (us === 0) continue;
    const k = BigInt(Math.floor(((2 * a) / us + b) * u + c));
    if (k < 0n || k > n) continue;
    let v = source.random();
    if (us >= 0.07 && v <= vr) return k;
    setup ??= setUp(n, p, b, spq);
    v *= setup.alpha / (a / (us * us) + b);
    const bound = setup.h - lgammaOf(k + 1n) - lgammaOf(n - k + 1n) + intToFloat(k - setup.m) * setup.lpq;
    if (logOf(v) <= bound) return k;
  }
}

function setUp(n: bigint, p: number, b: number, spq: number): { alpha: number; lpq: number; m: bigint; h: number } {
  const alpha = (2.83 + 5.1 / b) * spq;
  const lpq = Math.log(p / (1 - p));
  const m = BigInt(Math.floor(intToFloat(n + 1n) * p));
  const h = lgammaOf(m + 1n) + lgammaOf(n - m + 1n);
  return { alpha, lpq, m, h };
}

/** `math.lgamma` of a positive int, which overflows only for an int near the largest float. */
function lgammaOf(value: bigint): number {
  const result = lgamma(intToFloat(value));
  if (typeof result !== 'number') throw pyError('OverflowError', 'math range error');
  return result;
}

/** `math.log` of a non-negative float, which only a draw of exactly 0.0 makes zero. */
function logOf(x: number): number {
  if (x === 0) throw pyError('ValueError', 'expected a positive input, got 0.0');
  return Math.log(x);
}
