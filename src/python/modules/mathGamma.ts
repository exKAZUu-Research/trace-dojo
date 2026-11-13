import { floatPower } from '../floatPower';
import { fusedMultiplyAdd as fma } from './mathFma';

/**
 * The gamma functions of CPython's mathmodule.c (m_tgamma, m_lgamma, and their helpers), which CPython computes itself
 * rather than taking from the C library, with each `a * b + c` contracted into one fused multiply-add as the reference
 * build compiles it. Each returns the C function's result, with `domain` or `range` where the C function sets errno to
 * EDOM or ERANGE.
 */
export type GammaResult = number | 'domain' | 'range';

const LANCZOS_G = 6.024680040776729583740234375;
const LANCZOS_G_MINUS_HALF = 5.524680040776729583740234375;
// The doubles nearest to the decimal coefficients of mathmodule.c.
const LANCZOS_NUM_COEFFS = [
  23_531_376_880.41076, 42_919_803_642.6491, 35_711_959_237.35567, 17_921_034_426.03721, 6_039_542_586.352028,
  1_439_720_407.3117216, 248_874_557.86205417, 31_426_415.585400194, 2_876_370.6289353725, 186_056.26539522348,
  8071.672002365816, 210.82427775157936, 2.5066282746310002,
];
const LANCZOS_DEN_COEFFS = [
  0, 39_916_800, 120_543_840, 150_917_976, 105_258_076, 45_995_730, 13_339_535, 2_637_558, 357_423, 32_670, 1925, 66, 1,
];
const GAMMA_INTEGRAL = [
  1, 1, 2, 6, 24, 120, 720, 5040, 40_320, 362_880, 3_628_800, 39_916_800, 479_001_600, 6_227_020_800, 87_178_291_200,
  1_307_674_368_000, 20_922_789_888_000, 355_687_428_096_000, 6_402_373_705_728_000, 121_645_100_408_832_000,
  2_432_902_008_176_640_000, 51_090_942_171_709_440_000, 1_124_000_727_777_607_680_000,
];
const LOG_PI = 1.1447298858494002;

/** Transcribes m_tgamma. */
export function tgamma(x: number): GammaResult {
  const special = specialGamma(x);
  if (special !== undefined) return special;
  const absx = Math.abs(x);
  if (absx < 1e-20) return finiteOrRange(1 / x);
  // C's 0.0 / sinpi(x): a zero with the sign of sin(pi * x).
  if (absx > 200) return x < 0 ? (sinpi(x) < 0 ? -0 : 0) : 'range';
  return finiteOrRange(x < 0 ? reflectedGamma(absx) : lanczosGamma(absx));
}

/** The result of m_tgamma for an infinity, a NaN, a zero, or an integer, which it gives before any approximation. */
function specialGamma(x: number): GammaResult | undefined {
  if (!Number.isFinite(x)) return Number.isNaN(x) || x > 0 ? x : 'domain';
  if (x === 0 || (x < 0 && x === Math.floor(x))) return 'domain';
  if (x === Math.floor(x) && x <= GAMMA_INTEGRAL.length) return GAMMA_INTEGRAL[x - 1];
  return undefined;
}

/** The correction of m_tgamma for the rounding error of `absx + lanczos_g - 0.5`. */
function sumError(absx: number, y: number): number {
  const z = absx > LANCZOS_G_MINUS_HALF ? y - absx - LANCZOS_G_MINUS_HALF : y - LANCZOS_G_MINUS_HALF - absx;
  return (z * LANCZOS_G) / y;
}

function lanczosGamma(absx: number): number {
  const y = absx + LANCZOS_G_MINUS_HALF;
  const z = sumError(absx, y);
  let r = lanczosSum(absx) / Math.exp(y);
  r = fma(z, r, r);
  if (absx < 140) return r * floatPower(y, absx - 0.5);
  const sqrtpow = floatPower(y, absx / 2 - 0.25);
  return r * sqrtpow * sqrtpow;
}

function reflectedGamma(absx: number): number {
  const y = absx + LANCZOS_G_MINUS_HALF;
  const z = sumError(absx, y);
  let r = ((-Math.PI / sinpi(absx) / absx) * Math.exp(y)) / lanczosSum(absx);
  r = fma(-z, r, r);
  if (absx < 140) return r / floatPower(y, absx - 0.5);
  const sqrtpow = floatPower(y, absx / 2 - 0.25);
  return r / sqrtpow / sqrtpow;
}

/** Transcribes m_lgamma. */
export function lgamma(x: number): GammaResult {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? x : Number.POSITIVE_INFINITY;
  if (x === Math.floor(x) && x <= 2) return x <= 0 ? 'domain' : 0;
  const absx = Math.abs(x);
  if (absx < 1e-20) return -Math.log(absx);
  let r = Math.log(lanczosSum(absx)) - LANCZOS_G;
  r = fma(absx - 0.5, Math.log(absx + LANCZOS_G - 0.5) - 1, r);
  if (x < 0) r = LOG_PI - Math.log(Math.abs(sinpi(absx))) - Math.log(absx) - r;
  return finiteOrRange(r);
}

function finiteOrRange(r: number): GammaResult {
  return Number.isFinite(r) ? r : 'range';
}

/** Transcribes lanczos_sum, for positive `x`. */
function lanczosSum(x: number): number {
  let num = 0;
  let den = 0;
  if (x < 5) {
    for (let i = LANCZOS_NUM_COEFFS.length - 1; i >= 0; i--) {
      num = fma(num, x, LANCZOS_NUM_COEFFS[i]);
      den = fma(den, x, LANCZOS_DEN_COEFFS[i]);
    }
  } else {
    for (const [i, coefficient] of LANCZOS_NUM_COEFFS.entries()) {
      num = num / x + coefficient;
      den = den / x + LANCZOS_DEN_COEFFS[i];
    }
  }
  return num / den;
}

/** Transcribes m_sinpi: sin(pi * x), exact at the integers and halves, for finite `x`. */
function sinpi(x: number): number {
  const y = Math.abs(x) % 2;
  const n = Math.round(2 * y);
  const pi = Math.PI;
  const r = [
    () => Math.sin(pi * y),
    () => Math.cos(pi * (y - 0.5)),
    () => Math.sin(pi * (1 - y)),
    () => -Math.cos(pi * (y - 1.5)),
    () => Math.sin(pi * (y - 2)),
  ][n]();
  return (x < 0 || Object.is(x, -0) ? -1 : 1) * r;
}
