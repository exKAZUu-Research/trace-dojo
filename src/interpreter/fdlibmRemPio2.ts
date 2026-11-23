/**
 * e_rem_pio2.c and k_rem_pio2.c of fdlibm 5.3, which reduce the arguments of `fdlibmSin`, `fdlibmCos` and
 * `fdlibmTan` to [-pi / 4, pi / 4] exactly, even for huge arguments such as 1e300.
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

import { fromWords, high, low } from './fdlibmWords';

const TWO24 = 16_777_216;

/** 396 hex digits of 2 / pi in 24-bit chunks. */
const TWO_OVER_PI = [
  0xa2_f9_83, 0x6e_4e_44, 0x15_29_fc, 0x27_57_d1, 0xf5_34_dd, 0xc0_db_62, 0x95_99_3c, 0x43_90_41, 0xfe_51_63,
  0xab_de_bb, 0xc5_61_b7, 0x24_6e_3a, 0x42_4d_d2, 0xe0_06_49, 0x2e_ea_09, 0xd1_92_1c, 0xfe_1d_eb, 0x1c_b1_29,
  0xa7_3e_e8, 0x82_35_f5, 0x2e_bb_44, 0x84_e9_9c, 0x70_26_b4, 0x5f_7e_41, 0x39_91_d6, 0x39_83_53, 0x39_f4_9c,
  0x84_5f_8b, 0xbd_f9_28, 0x3b_1f_f8, 0x97_ff_de, 0x05_98_0f, 0xef_2f_11, 0x8b_5a_0a, 0x6d_1f_6d, 0x36_7e_cf,
  0x27_cb_09, 0xb7_4f_46, 0x3f_66_9e, 0x5f_ea_2d, 0x75_27_ba, 0xc7_eb_e5, 0xf1_7b_3d, 0x07_39_f7, 0x8a_52_92,
  0xea_6b_fb, 0x5f_b1_1f, 0x8d_5d_08, 0x56_03_30, 0x46_fc_7b, 0x6b_ab_f0, 0xcf_bc_20, 0x9a_f4_36, 0x1d_a9_e3,
  0x91_61_5e, 0xe6_1b_08, 0x65_99_85, 0x5f_14_a0, 0x68_40_8d, 0xff_d8_80, 0x4d_73_27, 0x31_06_06, 0x15_56_ca,
  0x73_a8_c9, 0x60_e2_7b, 0xc0_8c_6b,
];

/** The high words of n * pi / 2 for n in 1..32, which tell whether r - w cancels. */
const NPIO2_HW = [
  0x3f_f9_21_fb, 0x40_09_21_fb, 0x40_12_d9_7c, 0x40_19_21_fb, 0x40_1f_6a_7a, 0x40_22_d9_7c, 0x40_25_fd_bb,
  0x40_29_21_fb, 0x40_2c_46_3a, 0x40_2f_6a_7a, 0x40_31_47_5c, 0x40_32_d9_7c, 0x40_34_6b_9c, 0x40_35_fd_bb,
  0x40_37_8f_db, 0x40_39_21_fb, 0x40_3a_b4_1b, 0x40_3c_46_3a, 0x40_3d_d8_5a, 0x40_3f_6a_7a, 0x40_40_7e_4c,
  0x40_41_47_5c, 0x40_42_10_6c, 0x40_42_d9_7c, 0x40_43_a2_8c, 0x40_44_6b_9c, 0x40_45_34_ac, 0x40_45_fd_bb,
  0x40_46_c6_cb, 0x40_47_8f_db, 0x40_48_58_eb, 0x40_49_21_fb,
];

const INVPIO2 = 0.6366197723675814;
const PIO2_1 = 1.5707963267341256;
const PIO2_1T = 6.077100506506192e-11;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_2T = 2.0222662487959506e-21;
const PIO2_3 = 2.0222662487111665e-21;
const PIO2_3T = 8.4784276603689e-32;

/** e_rem_pio2.c: stores x - n * pi / 2 into `y` as `y[0] + y[1]` and returns n (modulo 8 for huge `x`). */
// code-gauge-allow functionNcss -- A transcription of fdlibm's e_rem_pio2.c, whose steps reviews compare with the original.
export function remPio2(x: number, y: number[]): number {
  let z: number;
  const hx = high(x);
  const ix = hx & 0x7f_ff_ff_ff;
  if (ix <= 0x3f_e9_21_fb) {
    y[0] = x;
    y[1] = 0;
    return 0;
  }
  if (ix < 0x40_02_d9_7c) {
    if (hx > 0) {
      z = x - PIO2_1;
      if (ix === 0x3f_f9_21_fb) {
        // Near pi / 2, 33 + 33 + 53 bits of pi are used.
        z -= PIO2_2;
        y[0] = z - PIO2_2T;
        y[1] = z - y[0] - PIO2_2T;
      } else {
        y[0] = z - PIO2_1T;
        y[1] = z - y[0] - PIO2_1T;
      }
      return 1;
    }
    z = x + PIO2_1;
    if (ix === 0x3f_f9_21_fb) {
      z += PIO2_2;
      y[0] = z + PIO2_2T;
      y[1] = z - y[0] + PIO2_2T;
    } else {
      y[0] = z + PIO2_1T;
      y[1] = z - y[0] + PIO2_1T;
    }
    return -1;
  }
  const n = ix <= 0x41_39_21_fb ? remPio2OfMediumSize(x, y, ix) : remPio2OfLargeSize(x, y, ix);
  if (hx < 0) {
    y[0] = -y[0];
    y[1] = -y[1];
    return -n;
  }
  return n;
}

/** The `|x| ~<= 2^19*(pi/2), medium size` part of e_rem_pio2.c, which leaves the sign of x to the caller. */
function remPio2OfMediumSize(x: number, y: number[], ix: number): number {
  let t = Math.abs(x);
  const n = Math.trunc(t * INVPIO2 + 0.5);
  const fn = n;
  let r = t - fn * PIO2_1;
  // The first round is good to 85 bits.
  let w = fn * PIO2_1T;
  if (n < 32 && ix !== NPIO2_HW[n - 1]) {
    y[0] = r - w;
  } else {
    const j = ix >> 20;
    y[0] = r - w;
    let i = j - ((high(y[0]) >> 20) & 0x7_ff);
    if (i > 16) {
      // The second iteration, good to 118 bits.
      t = r;
      w = fn * PIO2_2;
      r = t - w;
      w = fn * PIO2_2T - (t - r - w);
      y[0] = r - w;
      i = j - ((high(y[0]) >> 20) & 0x7_ff);
      if (i > 49) {
        // The third iteration, good to 151 bits, which covers all the cases.
        t = r;
        w = fn * PIO2_3;
        r = t - w;
        w = fn * PIO2_3T - (t - r - w);
        y[0] = r - w;
      }
    }
  }
  y[1] = r - y[0] - w;
  return n;
}

/** The `all other (large) arguments` part of e_rem_pio2.c, which leaves the sign of x to the caller. */
function remPio2OfLargeSize(x: number, y: number[], ix: number): number {
  if (ix >= 0x7f_f0_00_00) {
    y[0] = y[1] = x - x;
    return 0;
  }
  // z = scalbn(|x|, ilogb(x) - 23)
  const e0 = (ix >> 20) - 1046;
  let z = fromWords(ix - (e0 << 20), low(x));
  const tx = [0, 0, 0];
  for (let i = 0; i < 2; i++) {
    tx[i] = Math.trunc(z);
    z = (z - tx[i]) * TWO24;
  }
  tx[2] = z;
  let nx = 3;
  while (tx[nx - 1] === 0) nx--;
  return kernelRemPio2(tx, y, e0, nx);
}

const PIO2 = [
  1.570796251296997, 7.549789415861596e-8, 5.390302529957765e-15, 3.282003415807913e-22, 1.270655753080676e-29,
  1.2293330898111133e-36, 2.7337005381646456e-44, 2.1674168387780482e-51,
];
const TWON24 = 5.960464477539063e-8;
/** `init_jk[prec]` of k_rem_pio2.c for `prec` 2 (53-bit doubles), the only precision that e_rem_pio2.c requests. */
const JK = 4;

/** The working arrays and indexes of k_rem_pio2.c, which its steps share. */
interface Reduction {
  x: number[];
  jx: number;
  jv: number;
  q0: number;
  jz: number;
  iq: number[];
  f: number[];
  q: number[];
}

/**
 * k_rem_pio2.c for `prec` 2: stores x - n * pi / 2 into `y` as `y[0] + y[1]` and returns n modulo 8, where x is the sum
 * of `x[i] * 2 ** (e0 - 24 * i)` over the `nx` 24-bit chunks.
 */
function kernelRemPio2(x: number[], y: number[], e0: number, nx: number): number {
  const state = setUp(x, e0, nx);
  // The loop of the `recompute` label.
  for (;;) {
    const { z, n, ih } = distill(state);
    if (z !== 0 || !needsRecomputation(state)) {
      trimOrSplit(state, z);
      compress(state, y, ih);
      return n & 7;
    }
    addTerms(state);
  }
}

/** Determines jx, jv, and q0, where 3 > q0, and sets up f[0] to f[jx + JK] and q[0] to q[JK]. */
function setUp(x: number[], e0: number, nx: number): Reduction {
  const jx = nx - 1;
  let jv = Math.trunc((e0 - 3) / 24);
  if (jv < 0) jv = 0;
  const state: Reduction = {
    x,
    jx,
    jv,
    q0: e0 - 24 * (jv + 1),
    jz: JK,
    iq: Array.from({ length: 20 }, () => 0),
    f: Array.from({ length: 20 }, () => 0),
    q: Array.from({ length: 20 }, () => 0),
  };
  const m = jx + JK;
  for (let i = 0, j = jv - jx; i <= m; i++, j++) state.f[i] = j < 0 ? 0 : TWO_OVER_PI[j];
  for (let i = 0; i <= JK; i++) state.q[i] = product(state, i);
  return state;
}

/** The sum of `x[j] * f[jx + i - j]`, which is q[i]. */
function product({ x, f, jx }: Reduction, i: number): number {
  let fw = 0;
  for (let j = 0; j <= jx; j++) fw += x[j] * f[jx + i - j];
  return fw;
}

/** Distills q[] into iq[] reversingly, and computes n, the fraction z, and ih, whether the fraction exceeds 0.5. */
function distill(state: Reduction): { z: number; n: number; ih: number } {
  const { iq, q, jz, q0 } = state;
  let z = q[jz];
  for (let i = 0, j = jz; j > 0; i++, j--) {
    const fw = Math.trunc(TWON24 * z);
    iq[i] = Math.trunc(z - TWO24 * fw);
    z = q[j - 1] + fw;
  }
  z = scalbn(z, q0);
  // Trims off the integer part >= 8.
  z -= 8 * Math.floor(z * 0.125);
  let n = Math.trunc(z);
  z -= n;
  let ih = 0;
  if (q0 > 0) {
    // iq[jz - 1] is needed to determine n.
    const i = iq[jz - 1] >> (24 - q0);
    n += i;
    iq[jz - 1] -= i << (24 - q0);
    ih = iq[jz - 1] >> (23 - q0);
  } else if (q0 === 0) {
    ih = iq[jz - 1] >> 23;
  } else if (z >= 0.5) {
    ih = 2;
  }
  if (ih > 0) {
    n += 1;
    z = complement(state, z, ih);
  }
  return { z, n, ih };
}

/** Computes 1 - q, for a fraction above 0.5. */
function complement({ iq, jz, q0 }: Reduction, fraction: number, ih: number): number {
  let carry = 0;
  for (let i = 0; i < jz; i++) {
    const j = iq[i];
    if (carry === 0) {
      if (j !== 0) {
        carry = 1;
        iq[i] = 0x1_00_00_00 - j;
      }
    } else {
      iq[i] = 0xff_ff_ff - j;
    }
  }
  if (q0 === 1) iq[jz - 1] &= 0x7f_ff_ff;
  else if (q0 === 2) iq[jz - 1] &= 0x3f_ff_ff;
  if (ih !== 2) return fraction;
  const z = 1 - fraction;
  return carry === 0 ? z : z - scalbn(1, q0);
}

/** Whether a zero fraction needs more terms of 2/pi, which its zero chunks from JK on show. */
function needsRecomputation({ iq, jz }: Reduction): boolean {
  let j = 0;
  for (let i = jz - 1; i >= JK; i--) j |= iq[i];
  return j === 0;
}

/** Adds q[jz + 1] to q[jz + k], where k is the number of the terms needed. */
function addTerms(state: Reduction): void {
  const { iq, f, q, jx, jv, jz } = state;
  let k = 1;
  while (iq[JK - k] === 0) k++;
  for (let i = jz + 1; i <= jz + k; i++) {
    f[jx + i] = TWO_OVER_PI[jv + i];
    q[i] = product(state, i);
  }
  state.jz += k;
}

/** Chops off the zero terms of a zero fraction, or breaks the fraction into 24-bit chunks if necessary. */
function trimOrSplit(state: Reduction, fraction: number): void {
  const { iq } = state;
  if (fraction === 0) {
    state.jz -= 1;
    state.q0 -= 24;
    while (iq[state.jz] === 0) {
      state.jz--;
      state.q0 -= 24;
    }
    return;
  }
  const z = scalbn(fraction, -state.q0);
  if (z >= TWO24) {
    const fw = Math.trunc(TWON24 * z);
    iq[state.jz] = Math.trunc(z - TWO24 * fw);
    state.jz += 1;
    state.q0 += 24;
    iq[state.jz] = fw;
  } else {
    iq[state.jz] = Math.trunc(z);
  }
}

/** Converts the integer chunks into floating-point values, multiplies them by pi / 2, and compresses them into y. */
function compress({ iq, q, jz, q0 }: Reduction, y: number[], ih: number): void {
  const jp = JK;
  const fq = Array.from({ length: 20 }, () => 0);
  let fw = scalbn(1, q0);
  for (let i = jz; i >= 0; i--) {
    q[i] = fw * iq[i];
    fw *= TWON24;
  }
  // Computes PIO2[0..jp] * q[jz..0].
  for (let i = jz; i >= 0; i--) {
    fw = 0;
    for (let k = 0; k <= jp && k <= jz - i; k++) fw += PIO2[k] * q[i + k];
    fq[jz - i] = fw;
  }
  fw = 0;
  for (let i = jz; i >= 0; i--) fw += fq[i];
  y[0] = ih === 0 ? fw : -fw;
  fw = fq[0] - fw;
  for (let i = 1; i <= jz; i++) fw += fq[i];
  y[1] = ih === 0 ? fw : -fw;
}

/** `scalbn` for the `exponent`s in [-1022, 1023] that k_rem_pio2.c passes, where the product is exact. */
function scalbn(value: number, exponent: number): number {
  return value * fromWords((exponent + 0x3_ff) << 20, 0);
}
