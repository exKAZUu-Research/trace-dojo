import { toIndex } from '../numbers';
import { pyError, valueError } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import type { PyValue } from '../values';
import { realArgument } from './math';

/** The source of random floats in [0, 1) the distributions draw from, a Random instance's Mersenne Twister. */
export interface RandomSource {
  random(): number;
}

export const NV_MAGICCONST = (4 * Math.exp(-0.5)) / Math.sqrt(2);
export const TWOPI = 2 * Math.PI;
export const LOG4 = Math.log(4);
export const SG_MAGICCONST = 1 + Math.log(4.5);

/**
 * The distributions of CPython 3.14's Lib/random.py, transcribed with the same floating-point operations in the same
 * order, so that a seeded generator gives the same values.
 */

export function triangular(
  source: RandomSource,
  lowValue: PyValue,
  highValue: PyValue,
  mode: PyValue | undefined
): PyValue {
  const u0 = source.random();
  let low = realArgument(lowValue);
  let high = realArgument(highValue);
  let c: number;
  if (mode === undefined) {
    c = 0.5;
  } else {
    if (high - low === 0) return lowValue;
    c = (realArgument(mode) - low) / (high - low);
  }
  let u = u0;
  if (u > c) {
    u = 1 - u;
    c = 1 - c;
    [low, high] = [high, low];
  }
  return low + (high - low) * Math.sqrt(u * c);
}

export function normalvariate(source: RandomSource, mu: number, sigma: number): number {
  let z: number;
  for (;;) {
    const u1 = source.random();
    const u2 = 1 - source.random();
    z = (NV_MAGICCONST * (u1 - 0.5)) / u2;
    const zz = (z * z) / 4;
    if (zz <= -Math.log(u2)) break;
  }
  return mu + z * sigma;
}

export function lognormvariate(source: RandomSource, mu: number, sigma: number): number {
  return Math.exp(normalvariate(source, mu, sigma));
}

export function expovariate(source: RandomSource, lambd: number): number {
  if (lambd === 0) throw pyError('ZeroDivisionError', 'float division by zero');
  return -Math.log(1 - source.random()) / lambd;
}

export function vonmisesvariate(source: RandomSource, mu: number, kappa: number): number {
  if (kappa <= 1e-6) return TWOPI * source.random();
  const s = 0.5 / kappa;
  const r = s + Math.sqrt(1 + s * s);
  let z: number;
  for (;;) {
    const u1 = source.random();
    z = Math.cos(Math.PI * u1);
    const d = z / (r + z);
    const u2 = source.random();
    if (u2 < 1 - d * d || u2 <= (1 - d) * Math.exp(d)) break;
  }
  const q = 1 / r;
  const f = (q + z) / (1 + q * z);
  const u3 = source.random();
  return u3 > 0.5 ? pyMod(mu + Math.acos(f), TWOPI) : pyMod(mu - Math.acos(f), TWOPI);
}

/** Python's float `%`, whose result takes the sign of the divisor. */
function pyMod(a: number, b: number): number {
  const remainder = a % b;
  if (remainder === 0) return b < 0 ? -0 : 0;
  return remainder < 0 !== b < 0 ? remainder + b : remainder;
}

export function gammavariate(source: RandomSource, alpha: number, beta: number): number {
  if (alpha <= 0 || beta <= 0) throw valueError('gammavariate: alpha and beta must be > 0.0');
  if (alpha > 1) {
    const ainv = Math.sqrt(2 * alpha - 1);
    const bbb = alpha - LOG4;
    const ccc = alpha + ainv;
    for (;;) {
      const u1 = source.random();
      if (!(1e-7 < u1 && u1 < 0.9999999)) continue;
      const u2 = 1 - source.random();
      const v = Math.log(u1 / (1 - u1)) / ainv;
      const x = alpha * Math.exp(v);
      const z = u1 * u1 * u2;
      const r = bbb + ccc * v - x;
      if (r + SG_MAGICCONST - 4.5 * z >= 0 || r >= Math.log(z)) return x * beta;
    }
  }
  if (alpha === 1) return -Math.log(1 - source.random()) * beta;
  return smallGamma(source, alpha) * beta;
}

function smallGamma(source: RandomSource, alpha: number): number {
  for (;;) {
    const u = source.random();
    const b = (Math.E + alpha) / Math.E;
    const p = b * u;
    const x = p <= 1 ? p ** (1 / alpha) : -Math.log((b - p) / alpha);
    const u1 = source.random();
    if (p > 1) {
      if (u1 <= x ** (alpha - 1)) return x;
    } else if (u1 <= Math.exp(-x)) {
      return x;
    }
  }
}

export function betavariate(source: RandomSource, alpha: number, beta: number): number {
  const y = gammavariate(source, alpha, 1);
  if (y) return y / (y + gammavariate(source, beta, 1));
  return 0;
}

export function paretovariate(source: RandomSource, alpha: number): number {
  const u = 1 - source.random();
  return u ** (-1 / alpha);
}

export function weibullvariate(source: RandomSource, alpha: number, beta: number): number {
  const u = 1 - source.random();
  return alpha * (-Math.log(u)) ** (1 / beta);
}

/** `random.binomialvariate(n, p)`, whose BTRS method needs the C library's lgamma, which this grader lacks. */
export function binomialvariate(source: RandomSource, nValue: PyValue, pValue: PyValue): bigint {
  const n = toIndex(nValue);
  const p = realArgument(pValue);
  if (n < 0n) throw valueError('n must be non-negative');
  if (p <= 0 || p >= 1) {
    if (p === 0) return 0n;
    if (p === 1) return n;
    throw valueError('p must be in the range 0.0 <= p <= 1.0');
  }
  if (n === 1n) return source.random() < p ? 1n : 0n;
  if (p > 0.5) return n - binomialvariate(source, n, 1 - p);
  if (Number(n) * p < 10) return geometricBinomial(source, n, p);
  throw new UnsupportedFeatureError(
    'n * p が 10 以上の random.binomialvariate()（C ライブラリの lgamma と最後の桁まで同じ値を出せないため）'
  );
}

/** The geometric method of binomialvariate for small n * p, which counts the trials that fit before n. */
function geometricBinomial(source: RandomSource, n: bigint, p: number): bigint {
  let x = 0n;
  let y = 0n;
  const c = Math.log2(1 - p);
  if (!c) return x;
  for (;;) {
    const r = source.random();
    if (r === 0) continue;
    y += BigInt(Math.floor(Math.log2(r) / c)) + 1n;
    if (y > n) return x;
    x++;
  }
}
