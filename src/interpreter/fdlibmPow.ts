/**
 * `pow` of fdlibm 5.3 (e_pow.c), which the JVM's `StrictMath.pow` and `Math.pow` compute, transcribed so that JVM
 * languages print the JVM's last digits. JavaScript's `**` rounds differently for many arguments, as `1.0125 ** 40` shows.
 *
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 */

const BP = [1, 1.5];
const DP_H = [0, 5.8496248722076416e-1];
const DP_L = [0, 1.350039202129749e-8];
const TWO53 = 9_007_199_254_740_992;
const HUGE = 1e300;
const TINY = 1e-300;
const L1 = 5.9999999999999465e-1;
const L2 = 4.285714285785502e-1;
const L3 = 3.3333332981837743e-1;
const L4 = 2.72728123808534e-1;
const L5 = 2.3066074577556175e-1;
const L6 = 2.0697501780033842e-1;
const P1 = 1.6666666666666602e-1;
const P2 = -2.7777777777015593e-3;
const P3 = 6.613756321437934e-5;
const P4 = -1.6533902205465252e-6;
const P5 = 4.1381367970572385e-8;
const LG2 = 6.931471805599453e-1;
const LG2_H = 6.931471824645996e-1;
const LG2_L = -1.904654299957768e-9;
const OVT = 8.008566259537294e-17;
const CP = 9.617966939259756e-1;
const CP_H = 9.617967009544373e-1;
const CP_L = -7.028461650952758e-9;
const IVLN2 = 1.4426950408889634;
const IVLN2_H = 1.4426950216293335;
const IVLN2_L = 1.9259629911266175e-8;

const view = new DataView(new ArrayBuffer(8));

function high(value: number): number {
  view.setFloat64(0, value);
  return view.getInt32(0);
}

function low(value: number): number {
  view.setFloat64(0, value);
  return view.getUint32(4);
}

function withHigh(value: number, word: number): number {
  view.setFloat64(0, value);
  view.setInt32(0, word);
  return view.getFloat64(0);
}

function withLowZero(value: number): number {
  view.setFloat64(0, value);
  view.setUint32(4, 0);
  return view.getFloat64(0);
}

function fromHigh(word: number): number {
  view.setInt32(0, word);
  view.setUint32(4, 0);
  return view.getFloat64(0);
}

/** `scalbn`: `value` times 2 to the power `exponent`, which subnormal results need. */
function scalbn(value: number, exponent: number): number {
  let result = value;
  let remaining = exponent;
  while (remaining > 1023) {
    result *= 2 ** 1023;
    remaining -= 1023;
  }
  while (remaining < -1022) {
    result *= 2 ** -1022;
    remaining += 1022;
  }
  return result * 2 ** remaining;
}

// code-gauge-allow functionNcss 160 -- A transcription of fdlibm's e_pow.c, whose steps reviews compare with the original.
// code-gauge-allow functionCognitiveComplexity 80 -- A transcription of fdlibm's e_pow.c, whose steps reviews compare with the original.
export function fdlibmPow(x: number, y: number): number {
  const hx = high(x);
  const lx = low(x);
  const hy = high(y);
  const ly = low(y);
  let ix = hx & 0x7f_ff_ff_ff;
  const iy = hy & 0x7f_ff_ff_ff;
  if ((iy | ly) === 0) return 1;
  if (
    ix > 0x7f_f0_00_00 ||
    (ix === 0x7f_f0_00_00 && lx !== 0) ||
    iy > 0x7f_f0_00_00 ||
    (iy === 0x7f_f0_00_00 && ly !== 0)
  ) {
    return x + y;
  }
  // Whether y is an odd (1) or even (2) integer, or no integer (0), when x is negative.
  let yisint = 0;
  if (hx < 0) {
    if (iy >= 0x43_40_00_00) yisint = 2;
    else if (iy >= 0x3f_f0_00_00) {
      const k = (iy >> 20) - 0x3_ff;
      if (k > 20) {
        const j = ly >>> (52 - k);
        if ((j << (52 - k)) >>> 0 === ly) yisint = 2 - (j & 1);
      } else if (ly === 0) {
        const j = iy >> (20 - k);
        if (j << (20 - k) === iy) yisint = 2 - (j & 1);
      }
    }
  }
  if (ly === 0) {
    if (iy === 0x7f_f0_00_00) {
      if (((ix - 0x3f_f0_00_00) | lx) === 0) return y - y;
      if (ix >= 0x3f_f0_00_00) return hy >= 0 ? y : 0;
      return hy < 0 ? -y : 0;
    }
    if (iy === 0x3f_f0_00_00) return hy < 0 ? 1 / x : x;
    if (hy === 0x40_00_00_00) return x * x;
    if (hy === 0x3f_e0_00_00 && hx >= 0) return Math.sqrt(x);
  }
  let ax = Math.abs(x);
  if (lx === 0 && (ix === 0x7f_f0_00_00 || ix === 0 || ix === 0x3f_f0_00_00)) {
    let z = ax;
    if (hy < 0) z = 1 / z;
    if (hx < 0) {
      if (((ix - 0x3f_f0_00_00) | yisint) === 0) z = (z - z) / (z - z);
      else if (yisint === 1) z = -z;
    }
    return z;
  }
  let n = (hx >> 31) + 1;
  if ((n | yisint) === 0) return (x - x) / (x - x);
  let s = 1;
  if ((n | (yisint - 1)) === 0) s = -1;
  let t1: number;
  let t2: number;
  if (iy > 0x41_e0_00_00) {
    if (iy > 0x43_f0_00_00) {
      if (ix <= 0x3f_ef_ff_ff) return hy < 0 ? HUGE * HUGE : TINY * TINY;
      if (ix >= 0x3f_f0_00_00) return hy > 0 ? HUGE * HUGE : TINY * TINY;
    }
    if (ix < 0x3f_ef_ff_ff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY;
    if (ix > 0x3f_f0_00_00) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY;
    const t = ax - 1;
    const w = t * t * (0.5 - t * (0.3333333333333333 - t * 0.25));
    const u = IVLN2_H * t;
    const v = t * IVLN2_L - w * IVLN2;
    t1 = withLowZero(u + v);
    t2 = v - (t1 - u);
  } else {
    n = 0;
    if (ix < 0x00_10_00_00) {
      ax *= TWO53;
      n -= 53;
      ix = high(ax);
    }
    n += (ix >> 20) - 0x3_ff;
    const j = ix & 0x00_0f_ff_ff;
    ix = j | 0x3f_f0_00_00;
    let k: number;
    if (j <= 0x3_98_8e) k = 0;
    else if (j < 0xb_b6_7a) k = 1;
    else {
      k = 0;
      n += 1;
      ix -= 0x00_10_00_00;
    }
    ax = withHigh(ax, ix);
    const u = ax - BP[k];
    const v = 1 / (ax + BP[k]);
    const ss = u * v;
    const sH = withLowZero(ss);
    let tH = fromHigh(((ix >> 1) | 0x20_00_00_00) + 0x00_08_00_00 + (k << 18));
    let tL = ax - (tH - BP[k]);
    const sL = v * (u - sH * tH - sH * tL);
    let s2 = ss * ss;
    let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += sL * (sH + ss);
    s2 = sH * sH;
    tH = withLowZero(3 + s2 + r);
    tL = r - (tH - 3 - s2);
    const uu = sH * tH;
    const vv = sL * tH + tL * ss;
    const pH = withLowZero(uu + vv);
    const pL = vv - (pH - uu);
    const zH = CP_H * pH;
    const zL = CP_L * pH + pL * CP + DP_L[k];
    const t = n;
    t1 = withLowZero(zH + zL + DP_H[k] + t);
    t2 = zL - (t1 - t - DP_H[k] - zH);
  }
  const y1 = withLowZero(y);
  const pL = (y - y1) * t1 + y * t2;
  let pH = y1 * t1;
  let z = pL + pH;
  let j = high(z);
  const i = low(z);
  if (j >= 0x40_90_00_00) {
    if (((j - 0x40_90_00_00) | i) !== 0) return s * HUGE * HUGE;
    if (pL + OVT > z - pH) return s * HUGE * HUGE;
  } else if ((j & 0x7f_ff_ff_ff) >= 0x40_90_cc_00) {
    if (((j - 0xc0_90_cc_00) | i) !== 0) return s * TINY * TINY;
    if (pL <= z - pH) return s * TINY * TINY;
  }
  const absJ = j & 0x7f_ff_ff_ff;
  let k = (absJ >> 20) - 0x3_ff;
  n = 0;
  if (absJ > 0x3f_e0_00_00) {
    n = j + (0x00_10_00_00 >> (k + 1));
    k = ((n & 0x7f_ff_ff_ff) >> 20) - 0x3_ff;
    const t = fromHigh(n & ~(0x00_0f_ff_ff >> k));
    n = ((n & 0x00_0f_ff_ff) | 0x00_10_00_00) >> (20 - k);
    if (j < 0) n = -n;
    pH -= t;
  }
  const t = withLowZero(pL + pH);
  const u = t * LG2_H;
  const v = (pL - (t - pH)) * LG2 + t * LG2_L;
  z = u + v;
  const w = v - (z - u);
  const tt = z * z;
  const tz = z - tt * (P1 + tt * (P2 + tt * (P3 + tt * (P4 + tt * P5))));
  const r = (z * tz) / (tz - 2) - (w + z * w);
  z = 1 - (r - z);
  j = high(z);
  j += n << 20;
  return s * (j >> 20 <= 0 ? scalbn(z, n) : withHigh(z, high(z) + (n << 20)));
}
