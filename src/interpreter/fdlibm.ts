// code-gauge-allow-file fileNcss -- The fdlibm functions share constants and kernels.
/**
 * The math functions of fdlibm 5.3, which the JVM's `StrictMath` is specified to compute, transcribed so that JVM
 * languages print the JVM's last digits. JavaScript engines compute `Math.sin` and the like with other algorithms,
 * whose results differ from the JVM's in the last digit for many arguments.
 *
 * Each function keeps the step order and the variable names of its fdlibm source file (named in its JSDoc), so that
 * reviews can compare the two. C's 32-bit `int` words are emulated by JavaScript's bitwise operators.
 *
 * The fdlibm sources carry this notice:
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 */

import { remPio2 } from './fdlibmRemPio2';
import { fromWords, high, low, withHigh, withLow } from './fdlibmWords';

const HUGE = 1e300;
const TINY = 1e-300;
const TWO54 = 18_014_398_509_481_984;
const PI = 3.141592653589793;
const PIO2_HI = 1.5707963267948966;
const PIO2_LO = 6.123233995736766e-17;
const PIO4 = 0.7853981633974483;
const PIO4_LO = 3.061616997868383e-17;
const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INVLN2 = 1.4426950408889634;
const O_THRESHOLD = 709.782712893384;

/** s_sin.c */
export function fdlibmSin(x: number): number {
  const y = [0, 0];
  const z = 0;
  let ix = high(x);
  ix &= 0x7f_ff_ff_ff;
  if (ix <= 0x3f_e9_21_fb) return kernelSin(x, z, 0);
  if (ix >= 0x7f_f0_00_00) return x - x;
  const n = remPio2(x, y);
  return sinOfQuadrant(n, y);
}

/** s_cos.c */
export function fdlibmCos(x: number): number {
  const y = [0, 0];
  const z = 0;
  let ix = high(x);
  ix &= 0x7f_ff_ff_ff;
  if (ix <= 0x3f_e9_21_fb) return kernelCos(x, z);
  if (ix >= 0x7f_f0_00_00) return x - x;
  const n = remPio2(x, y);
  // The cases of s_cos.c's switch are those of s_sin.c's switch shifted by one quadrant: cos(x) = sin(x + pi / 2).
  return sinOfQuadrant(n + 1, y);
}

/** The switch of s_sin.c: sin(n * pi / 2 + y[0] + y[1]). */
function sinOfQuadrant(n: number, y: number[]): number {
  switch (n & 3) {
    case 0: {
      return kernelSin(y[0], y[1], 1);
    }
    case 1: {
      return kernelCos(y[0], y[1]);
    }
    case 2: {
      return -kernelSin(y[0], y[1], 1);
    }
    default: {
      return -kernelCos(y[0], y[1]);
    }
  }
}

/** s_tan.c */
export function fdlibmTan(x: number): number {
  const y = [0, 0];
  const z = 0;
  let ix = high(x);
  ix &= 0x7f_ff_ff_ff;
  if (ix <= 0x3f_e9_21_fb) return kernelTan(x, z, 1);
  if (ix >= 0x7f_f0_00_00) return x - x;
  const n = remPio2(x, y);
  // 1 when n is even, -1 when n is odd.
  return kernelTan(y[0], y[1], 1 - ((n & 1) << 1));
}

const PS0 = 0.16666666666666666;
const PS1 = -0.3255658186224009;
const PS2 = 0.20121253213486293;
const PS3 = -0.04005553450067941;
const PS4 = 0.0007915349942898145;
const PS5 = 0.00003479331075960212;
const QS1 = -2.403394911734414;
const QS2 = 2.0209457602335057;
const QS3 = -0.6882839716054533;
const QS4 = 0.07703815055590194;

/** e_asin.c */
// code-gauge-allow functionNcss -- A transcription of fdlibm's e_asin.c, whose steps reviews compare with the original.
export function fdlibmAsin(x: number): number {
  let t = 0;
  let w: number;
  let p: number;
  let q: number;
  const hx = high(x);
  const ix = hx & 0x7f_ff_ff_ff;
  if (ix >= 0x3f_f0_00_00) {
    if (((ix - 0x3f_f0_00_00) | low(x)) === 0) return x * PIO2_HI + x * PIO2_LO;
    return (x - x) / (x - x);
  } else if (ix < 0x3f_e0_00_00) {
    if (ix < 0x3e_40_00_00) {
      if (HUGE + x > 1) return x;
    } else {
      t = x * x;
    }
    p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
    q = 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
    w = p / q;
    return x + x * w;
  }
  w = 1 - Math.abs(x);
  t = w * 0.5;
  p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
  q = 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
  const s = Math.sqrt(t);
  if (ix >= 0x3f_ef_33_33) {
    w = p / q;
    t = PIO2_HI - (2 * (s + s * w) - PIO2_LO);
  } else {
    w = s;
    w = withLow(w, 0);
    const c = (t - w * w) / (s + w);
    const r = p / q;
    p = 2 * s * r - (PIO2_LO - 2 * c);
    q = PIO4 - 2 * w;
    t = PIO4 - (p - q);
  }
  return hx > 0 ? t : -t;
}

/** e_acos.c */
// code-gauge-allow functionNcss -- A transcription of fdlibm's e_acos.c, whose steps reviews compare with the original.
export function fdlibmAcos(x: number): number {
  const hx = high(x);
  const ix = hx & 0x7f_ff_ff_ff;
  if (ix >= 0x3f_f0_00_00) {
    if (((ix - 0x3f_f0_00_00) | low(x)) === 0) {
      return hx > 0 ? 0 : PI + 2 * PIO2_LO;
    }
    return (x - x) / (x - x);
  }
  if (ix < 0x3f_e0_00_00) {
    if (ix <= 0x3c_60_00_00) return PIO2_HI + PIO2_LO;
    const z = x * x;
    const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
    const q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
    const r = p / q;
    return PIO2_HI - (x - (PIO2_LO - x * r));
  } else if (hx < 0) {
    const z = (1 + x) * 0.5;
    const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
    const q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
    const s = Math.sqrt(z);
    const r = p / q;
    const w = r * s - PIO2_LO;
    return PI - 2 * (s + w);
  }
  const z = (1 - x) * 0.5;
  const s = Math.sqrt(z);
  let df = s;
  df = withLow(df, 0);
  const c = (z - df * df) / (s + df);
  const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
  const q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
  const r = p / q;
  const w = r * s + c;
  return 2 * (df + w);
}

const ATANHI = [0.4636476090008061, PIO4, 0.982793723247329, PIO2_HI];
const ATANLO = [2.2698777452961687e-17, PIO4_LO, 1.3903311031230998e-17, PIO2_LO];
const AT = [
  0.3333333333333293, -0.19999999999876483, 0.14285714272503466, -0.11111110405462356, 0.09090887133436507,
  -0.0769187620504483, 0.06661073137387531, -0.058335701337905735, 0.049768779946159324, -0.036531572744216916,
  0.016285820115365782,
];

/** s_atan.c */
// code-gauge-allow functionCognitiveComplexity -- A transcription of fdlibm's s_atan.c, whose steps reviews compare with the original.
// code-gauge-allow functionNcss -- A transcription of fdlibm's s_atan.c, whose steps reviews compare with the original.
export function fdlibmAtan(argument: number): number {
  let x = argument;
  let id: number;
  const hx = high(x);
  const ix = hx & 0x7f_ff_ff_ff;
  if (ix >= 0x44_10_00_00) {
    if (ix > 0x7f_f0_00_00 || (ix === 0x7f_f0_00_00 && low(x) !== 0)) return x + x;
    return hx > 0 ? ATANHI[3] + ATANLO[3] : -ATANHI[3] - ATANLO[3];
  }
  if (ix < 0x3f_dc_00_00) {
    if (ix < 0x3e_20_00_00 && HUGE + x > 1) return x;
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3f_f3_00_00) {
      if (ix < 0x3f_e6_00_00) {
        id = 0;
        x = (2 * x - 1) / (2 + x);
      } else {
        id = 1;
        x = (x - 1) / (x + 1);
      }
    } else if (ix < 0x40_03_80_00) {
      id = 2;
      x = (x - 1.5) / (1 + 1.5 * x);
    } else {
      id = 3;
      x = -1 / x;
    }
  }
  let z = x * x;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  z = ATANHI[id] - (x * (s1 + s2) - ATANLO[id] - x);
  return hx < 0 ? -z : z;
}

const PI_LO = 1.2246467991473532e-16;

/** e_atan2.c */
// code-gauge-allow functionCognitiveComplexity -- A transcription of fdlibm's e_atan2.c, whose steps reviews compare with the original.
// code-gauge-allow functionNcss -- A transcription of fdlibm's e_atan2.c, whose steps reviews compare with the original.
export function fdlibmAtan2(y: number, x: number): number {
  const hx = high(x);
  const ix = hx & 0x7f_ff_ff_ff;
  const lx = low(x);
  const hy = high(y);
  const iy = hy & 0x7f_ff_ff_ff;
  const ly = low(y);
  if ((ix | ((lx | -lx) >>> 31)) > 0x7f_f0_00_00 || (iy | ((ly | -ly) >>> 31)) > 0x7f_f0_00_00) return x + y;
  if (((hx - 0x3f_f0_00_00) | lx) === 0) return fdlibmAtan(y);
  // 2 * sign(x) + sign(y)
  const m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
  if ((iy | ly) === 0) return atan2OfZeroY(y, m);
  if ((ix | lx) === 0) return hy < 0 ? -PIO2_HI - TINY : PIO2_HI + TINY;
  if (ix === 0x7f_f0_00_00) return atan2OfInfiniteX(iy === 0x7f_f0_00_00, m);
  if (iy === 0x7f_f0_00_00) return hy < 0 ? -PIO2_HI - TINY : PIO2_HI + TINY;
  let z: number;
  const k = (iy - ix) >> 20;
  if (k > 60) z = PIO2_HI + 0.5 * PI_LO;
  else if (hx < 0 && k < -60) z = 0;
  else z = fdlibmAtan(Math.abs(y / x));
  switch (m) {
    case 0: {
      return z;
    }
    case 1: {
      return withHigh(z, high(z) ^ 0x80_00_00_00);
    }
    case 2: {
      return PI - (z - PI_LO);
    }
    default: {
      return z - PI_LO - PI;
    }
  }
}

/** The `when y = 0` case of e_atan2.c. */
function atan2OfZeroY(y: number, m: number): number {
  switch (m) {
    case 0:
    case 1: {
      return y;
    }
    case 2: {
      return PI + TINY;
    }
    default: {
      return -PI - TINY;
    }
  }
}

/** The `when x is INF` case of e_atan2.c. */
function atan2OfInfiniteX(isYInfinite: boolean, m: number): number {
  if (isYInfinite) {
    switch (m) {
      case 0: {
        return PIO4 + TINY;
      }
      case 1: {
        return -PIO4 - TINY;
      }
      case 2: {
        return 3 * PIO4 + TINY;
      }
      default: {
        return -3 * PIO4 - TINY;
      }
    }
  }
  switch (m) {
    case 0: {
      return 0;
    }
    case 1: {
      return -0;
    }
    case 2: {
      return PI + TINY;
    }
    default: {
      return -PI - TINY;
    }
  }
}

const HALF = [0.5, -0.5];
const TWOM1000 = 9.332636185032189e-302;
const U_THRESHOLD = -745.1332191019411;
const LN2HI = [LN2_HI, -LN2_HI];
const LN2LO = [LN2_LO, -LN2_LO];
const P1 = 0.16666666666666602;
const P2 = -0.0027777777777015593;
const P3 = 0.00006613756321437934;
const P4 = -0.0000016533902205465252;
const P5 = 4.1381367970572385e-8;

/** e_exp.c */
// code-gauge-allow functionCognitiveComplexity -- A transcription of fdlibm's e_exp.c, whose steps reviews compare with the original.
// code-gauge-allow functionNcss -- A transcription of fdlibm's e_exp.c, whose steps reviews compare with the original.
export function fdlibmExp(argument: number): number {
  let x = argument;
  let hi = 0;
  let lo = 0;
  let k = 0;
  let hx = high(x);
  const xsb = (hx >> 31) & 1;
  hx &= 0x7f_ff_ff_ff;
  if (hx >= 0x40_86_2e_42) {
    if (hx >= 0x7f_f0_00_00) {
      if (((hx & 0xf_ff_ff) | low(x)) !== 0) return x + x;
      return xsb === 0 ? x : 0;
    }
    if (x > O_THRESHOLD) return HUGE * HUGE;
    if (x < U_THRESHOLD) return TWOM1000 * TWOM1000;
  }
  if (hx > 0x3f_d6_2e_42) {
    if (hx < 0x3f_f0_a2_b2) {
      hi = x - LN2HI[xsb];
      lo = LN2LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INVLN2 * x + HALF[xsb]);
      const t = k;
      // t * LN2HI[0] is exact here.
      hi = x - t * LN2HI[0];
      lo = t * LN2LO[0];
    }
    x = hi - lo;
  } else if (hx < 0x3e_30_00_00) {
    if (HUGE + x > 1) return 1 + x;
  } else {
    k = 0;
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  let y = 1 - (lo - (x * c) / (2 - c) - hi);
  if (k >= -1021) {
    y = withHigh(y, high(y) + (k << 20));
    return y;
  }
  y = withHigh(y, high(y) + ((k + 1000) << 20));
  return y * TWOM1000;
}

/** Lg1 to Lg7 of e_log.c, which equal Lp1 to Lp7 of s_log1p.c. */
const LG1 = 0.6666666666666735;
const LG2 = 0.3999999999940942;
const LG3 = 0.2857142874366239;
const LG4 = 0.22222198432149784;
const LG5 = 0.1818357216161805;
const LG6 = 0.15313837699209373;
const LG7 = 0.14798198605116586;

/** e_log.c */
// code-gauge-allow functionCognitiveComplexity -- A transcription of fdlibm's e_log.c, whose steps reviews compare with the original.
// code-gauge-allow functionNcss -- A transcription of fdlibm's e_log.c, whose steps reviews compare with the original.
export function fdlibmLog(argument: number): number {
  let x = argument;
  let hx = high(x);
  const lx = low(x);
  let k = 0;
  if (hx < 0x00_10_00_00) {
    if (((hx & 0x7f_ff_ff_ff) | lx) === 0) return -TWO54 / 0;
    if (hx < 0) return (x - x) / 0;
    k -= 54;
    x *= TWO54;
    hx = high(x);
  }
  if (hx >= 0x7f_f0_00_00) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x00_0f_ff_ff;
  let i = (hx + 0x9_5f_64) & 0x10_00_00;
  // Normalizes x or x / 2.
  x = withHigh(x, hx | (i ^ 0x3f_f0_00_00));
  k += i >> 20;
  const f = x - 1;
  let dk: number;
  let r: number;
  if ((0x00_0f_ff_ff & (2 + hx)) < 3) {
    if (f === 0) {
      if (k === 0) return 0;
      dk = k;
      return dk * LN2_HI + dk * LN2_LO;
    }
    r = f * f * (0.5 - 0.3333333333333333 * f);
    if (k === 0) return f - r;
    dk = k;
    return dk * LN2_HI - (r - dk * LN2_LO - f);
  }
  const s = f / (2 + f);
  dk = k;
  const z = s * s;
  i = hx - 0x6_14_7a;
  const w = z * z;
  const j = 0x6_b8_51 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  r = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + r));
    return dk * LN2_HI - (hfsq - (s * (hfsq + r) + dk * LN2_LO) - f);
  }
  if (k === 0) return f - s * (f - r);
  return dk * LN2_HI - (s * (f - r) - dk * LN2_LO - f);
}

const IVLN10 = 0.4342944819032518;
const LOG10_2HI = 0.30102999566361177;
const LOG10_2LO = 3.694239077158931e-13;

/** e_log10.c */
export function fdlibmLog10(argument: number): number {
  let x = argument;
  let hx = high(x);
  const lx = low(x);
  let k = 0;
  if (hx < 0x00_10_00_00) {
    if (((hx & 0x7f_ff_ff_ff) | lx) === 0) return -TWO54 / 0;
    if (hx < 0) return (x - x) / 0;
    k -= 54;
    x *= TWO54;
    hx = high(x);
  }
  if (hx >= 0x7f_f0_00_00) return x + x;
  k += (hx >> 20) - 1023;
  const i = (k & 0x80_00_00_00) >>> 31;
  hx = (hx & 0x00_0f_ff_ff) | ((0x3_ff - i) << 20);
  const y = k + i;
  x = withHigh(x, hx);
  const z = y * LOG10_2LO + IVLN10 * fdlibmLog(x);
  return z + y * LOG10_2HI;
}

const B1 = 715_094_163;
const B2 = 696_219_795;
const C = 0.5428571428571428;
const D = -0.7053061224489796;
const E = 1.4142857142857144;
const F = 1.6071428571428572;
const G = 0.35714285714285715;

/** s_cbrt.c */
export function fdlibmCbrt(argument: number): number {
  let x = argument;
  let t = 0;
  let hx = high(x);
  const sign = hx & 0x80_00_00_00;
  hx ^= sign;
  if (hx >= 0x7f_f0_00_00) return x + x;
  if ((hx | low(x)) === 0) return x;
  x = withHigh(x, hx);
  // A rough cbrt to 5 bits.
  if (hx < 0x00_10_00_00) {
    t = withHigh(t, 0x43_50_00_00);
    t *= x;
    t = withHigh(t, Math.trunc(high(t) / 3) + B2);
  } else {
    t = withHigh(t, Math.trunc(hx / 3) + B1);
  }
  // A new cbrt to 23 bits.
  let r = (t * t) / x;
  let s = C + r * t;
  t *= G + F / (s + E + D / s);
  // Chopped to 20 bits and made larger than cbrt(x).
  t = withLow(t, 0);
  t = withHigh(t, high(t) + 0x00_00_00_01);
  // One Newton step to 53 bits with an error of less than 0.667 ulps.
  s = t * t;
  r = x / s;
  const w = t + t;
  r = (r - t) / (w + r);
  t = t + t * r;
  // Restores the sign bit.
  t = withHigh(t, high(t) | sign);
  return t;
}

/** e_hypot.c */
// code-gauge-allow functionCognitiveComplexity -- A transcription of fdlibm's e_hypot.c, whose steps reviews compare with the original.
// code-gauge-allow functionNcss -- A transcription of fdlibm's e_hypot.c, whose steps reviews compare with the original.
export function fdlibmHypot(x: number, y: number): number {
  let a: number;
  let b: number;
  let t1: number;
  let ha = high(x) & 0x7f_ff_ff_ff;
  let hb = high(y) & 0x7f_ff_ff_ff;
  if (hb > ha) {
    a = y;
    b = x;
    const j = ha;
    ha = hb;
    hb = j;
  } else {
    a = x;
    b = y;
  }
  a = withHigh(a, ha);
  b = withHigh(b, hb);
  // x / y > 2 ** 60
  if (ha - hb > 0x3_c0_00_00) return a + b;
  let k = 0;
  if (ha > 0x5f_30_00_00) {
    if (ha >= 0x7f_f0_00_00) {
      let w = a + b;
      if (((ha & 0xf_ff_ff) | low(a)) === 0) w = a;
      if (((hb ^ 0x7f_f0_00_00) | low(b)) === 0) w = b;
      return w;
    }
    // Scales a and b by 2 ** -600.
    ha -= 0x25_80_00_00;
    hb -= 0x25_80_00_00;
    k += 600;
    a = withHigh(a, ha);
    b = withHigh(b, hb);
  }
  if (hb < 0x20_b0_00_00) {
    if (hb <= 0x00_0f_ff_ff) {
      if ((hb | low(b)) === 0) return a;
      t1 = 0;
      // t1 = 2 ** 1022
      t1 = withHigh(t1, 0x7f_d0_00_00);
      b *= t1;
      a *= t1;
      k -= 1022;
    } else {
      // Scales a and b by 2 ** 600.
      ha += 0x25_80_00_00;
      hb += 0x25_80_00_00;
      k -= 600;
      a = withHigh(a, ha);
      b = withHigh(b, hb);
    }
  }
  const w = hypotOfMediumSize(a, b, ha, hb);
  if (k !== 0) {
    t1 = 1;
    t1 = withHigh(t1, high(t1) + (k << 20));
    return t1 * w;
  }
  return w;
}

/** The `medium size a and b` part of e_hypot.c. */
function hypotOfMediumSize(aArgument: number, b: number, ha: number, hb: number): number {
  let a = aArgument;
  let t1: number;
  let t2: number;
  let w = a - b;
  if (w > b) {
    t1 = 0;
    t1 = withHigh(t1, ha);
    t2 = a - t1;
    return Math.sqrt(t1 * t1 - (b * -b - t2 * (a + t1)));
  }
  a += a;
  let y1 = 0;
  y1 = withHigh(y1, hb);
  const y2 = b - y1;
  t1 = 0;
  t1 = withHigh(t1, ha + 0x00_10_00_00);
  t2 = a - t1;
  w = Math.sqrt(t1 * y1 - (w * -w - (t1 * y2 + t2 * b)));
  return w;
}

const S1 = -0.16666666666666632;
const S2 = 0.00833333333332249;
const S3 = -0.0001984126982985795;
const S4 = 0.0000027557313707070068;
const S5 = -2.5050760253406863e-8;
const S6 = 1.58969099521155e-10;

/** k_sin.c: sin(x + y) for |x| <= pi / 4, where `iy` is 0 when `y` is 0. */
function kernelSin(x: number, y: number, iy: number): number {
  const ix = high(x) & 0x7f_ff_ff_ff;
  if (ix < 0x3e_40_00_00 && Math.trunc(x) === 0) return x;
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

const C1 = 0.0416666666666666;
const C2 = -0.001388888888887411;
const C3 = 0.00002480158728947673;
const C4 = -2.7557314351390663e-7;
const C5 = 2.087572321298175e-9;
const C6 = -1.1359647557788195e-11;

/** k_cos.c: cos(x + y) for |x| <= pi / 4. */
function kernelCos(x: number, y: number): number {
  const ix = high(x) & 0x7f_ff_ff_ff;
  if (ix < 0x3e_40_00_00 && Math.trunc(x) === 0) return 1;
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3f_d3_33_33) return 1 - (0.5 * z - (z * r - x * y));
  // x / 4
  const qx = ix > 0x3f_e9_00_00 ? 0.28125 : fromWords(ix - 0x00_20_00_00, 0);
  const hz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (hz - (z * r - x * y));
}

const T = [
  0.3333333333333341, 0.13333333333320124, 0.05396825397622605, 0.021869488294859542, 0.0088632398235993,
  0.0035920791075913124, 0.0014562094543252903, 0.0005880412408202641, 0.0002464631348184699, 0.00007817944429395571,
  0.00007140724913826082, -0.000018558637485527546, 0.00002590730518636337,
];

/** k_tan.c: tan(x + y) for |x| <= pi / 4 when `iy` is 1, and -1 / tan(x + y) when `iy` is -1. */
// code-gauge-allow functionNcss -- A transcription of fdlibm's k_tan.c, whose steps reviews compare with the original.
function kernelTan(xArgument: number, yArgument: number, iy: number): number {
  let x = xArgument;
  let y = yArgument;
  let z: number;
  let r: number;
  let v: number;
  let w: number;
  let s: number;
  const hx = high(x);
  const ix = hx & 0x7f_ff_ff_ff;
  if (ix < 0x3e_30_00_00 && Math.trunc(x) === 0) {
    if ((ix | low(x) | (iy + 1)) === 0) return 1 / Math.abs(x);
    if (iy === 1) return x;
    return negativeReciprocal(x + y, y - (withLow(x + y, 0) - x));
  }
  if (ix >= 0x3f_e5_94_28) {
    if (hx < 0) {
      x = -x;
      y = -y;
    }
    z = PIO4 - x;
    w = PIO4_LO - y;
    x = z + w;
    y = 0;
  }
  z = x * x;
  w = z * z;
  // x ** 5 * (T[1] + x ** 2 * T[2] + ...) is split into the odd and the even terms.
  r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
  v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
  s = z * x;
  r = y + z * (s * (r + v) + y);
  r += T[0] * s;
  w = x + r;
  if (ix >= 0x3f_e5_94_28) {
    v = iy;
    return (1 - ((hx >> 30) & 2)) * (v - 2 * (x - ((w * w) / (w + v) - r)));
  }
  if (iy === 1) return w;
  return negativeReciprocal(w, r - (withLow(w, 0) - x));
}

/** -1 / `w` computed accurately in k_tan.c, where `v` is the part of `w` that `w` without its low word lacks. */
function negativeReciprocal(w: number, v: number): number {
  const z = withLow(w, 0);
  const a = -1 / w;
  let t = a;
  t = withLow(t, 0);
  const s = 1 + t * z;
  return t + a * (s + t * v);
}
