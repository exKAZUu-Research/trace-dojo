/*
 * Go's math package (Go 1.27.3) transcribed to TypeScript, so that the interpreter returns the same bits as real Go
 * on arm64. Original code: Copyright The Go Authors, BSD license (see the Go distribution's LICENSE file); most of it
 * comes from FreeBSD's msun and the Cephes library, as the Go sources note.
 *
 * Why `fma` appears: on arm64 Go's compiler fuses a floating-point addition or subtraction with a multiplication that
 * feeds it (FMADD, FMSUB, FNMSUB), rounding once instead of twice. It does this in SSA form, so the fusion also reaches
 * across statements and local variables. Each `fma(x, y, a)` below marks a place where Go computes `a + x*y` (or
 * `a - x*y` as `fma(-x, y, a)`, `x*y - a` as `fma(x, y, -a)`) as one fused instruction. Where both operands of an
 * addition are products, the compiler fuses only one of them; the comments say which. `2*x` is rewritten to `x + x`
 * and so never fuses. Exp and Exp2 are written in assembly on arm64 (exp_arm64.s) and are transcribed from it.
 */
import { fma } from '../fma';

const PI = 3.141592653589793;
const PI_2 = 1.5707963267948966; // Pi/2
const PI_4 = 0.7853981633974483; // Pi/4
const PI_3_4 = 2.356194490192345; // 3*Pi/4
const FOUR_OVER_PI = 1.2732395447351628; // 4/Pi
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.4426950408889634; // 1/Ln2
const INV_LN10 = 0.4342944819032518; // 1/Ln10
const SQRT2_2 = 0.7071067811865476; // Sqrt2/2
const SMALLEST_NORMAL = 2.2250738585072014e-308;

const MASK = 0x7_ffn;
const SHIFT = 52n;
const BIAS = 1023;
const UINT64_MASK = (1n << 64n) - 1n;

// sin.go

const PI4A = 0.7853981256484985; // 0x3fe921fb40000000, Pi/4 split into three parts
const PI4B = 3.774894707930798e-8; // 0x3e64442d00000000,
const PI4C = 2.6951514290790595e-15; // 0x3ce8469898cc5170,

const SIN = [
  1.5896230157654656e-10, -2.5050747762857807e-8, 0.0000027557313621385722, -0.0001984126982958954,
  0.008333333333322118, -0.1666666666666663,
];
const COS = [
  -1.1358536521387682e-11, 2.087570084197473e-9, -2.755731417929674e-7, 0.000024801587288851704, -0.0013888888888873056,
  0.041666666666666595,
];

/** `math.Cos`. */
export function cos(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return Number.NaN;
  let sign = false;
  x = Math.abs(x);
  const [octant, z] = reduceOctant(x, true);
  let j = octant;
  if (j > 3) {
    j -= 4;
    sign = !sign;
  }
  if (j > 1) sign = !sign;
  const zz = z * z;
  const y = j === 1 || j === 2 ? sinPolynomial(z, zz) : cosPolynomial(zz);
  return sign ? -y : y;
}

/** `math.Sin`. */
export function sin(x: number): number {
  if (x === 0 || Number.isNaN(x)) return x;
  if (!Number.isFinite(x)) return Number.NaN;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  let [j, z] = reduceOctant(x, true);
  if (j > 3) {
    sign = !sign;
    j -= 4;
  }
  const zz = z * z;
  const y = j === 1 || j === 2 ? cosPolynomial(zz) : sinPolynomial(z, zz);
  return sign ? -y : y;
}

/**
 * The octant j and the remainder z of x ≥ 0 shared by Sin, Cos and Tan: `j = uint64(x * (4 / Pi))` rounded up to even,
 * then `z = ((x - y*PI4A) - y*PI4B) - y*PI4C`, or Payne-Hanek reduction for huge x. Sin and Cos also take `j &= 7`.
 */
function reduceOctant(x: number, maskOctant: boolean): [number, number] {
  if (x >= REDUCE_THRESHOLD) return trigReduce(x);
  let j = Math.trunc(x * FOUR_OVER_PI);
  let y = j;
  if (j % 2 === 1) {
    j++;
    y++;
  }
  if (maskOctant) j %= 8;
  return [j, fma(-y, PI4C, fma(-y, PI4B, fma(-y, PI4A, x)))];
}

/** `z + z*zz*(...)`: the addition fuses with the multiplication by the polynomial. */
function sinPolynomial(z: number, zz: number): number {
  let p = fma(SIN[0], zz, SIN[1]);
  for (const coefficient of SIN.slice(2)) p = fma(p, zz, coefficient);
  return fma(z * zz, p, z);
}

/** `1 - 0.5*zz + zz*zz*(...)`: both the subtraction and the addition fuse. */
function cosPolynomial(zz: number): number {
  let p = fma(COS[0], zz, COS[1]);
  for (const coefficient of COS.slice(2)) p = fma(p, zz, coefficient);
  return fma(zz * zz, p, fma(-0.5, zz, 1));
}

// tan.go

const TAN_P = [-13_093.693918138379, 1_153_516.6483858742, -17_956_525.197648488];
const TAN_Q = [1, 13_681.296347069296, -1_320_892.3444021097, 25_008_380.18233579, -53_869_575.592945464];

/** `math.Tan`. */
export function tan(x: number): number {
  if (x === 0 || Number.isNaN(x)) return x;
  if (!Number.isFinite(x)) return Number.NaN;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  const [j, z] = reduceOctant(x, false);
  const zz = z * z;
  let y = z;
  if (zz > 1e-14) {
    const p = fma(fma(TAN_P[0], zz, TAN_P[1]), zz, TAN_P[2]);
    const q = fma(fma(fma(zz + TAN_Q[1], zz, TAN_Q[2]), zz, TAN_Q[3]), zz, TAN_Q[4]);
    y = fma(z, (zz * p) / q, z);
  }
  if (Math.floor(j / 2) % 2 === 1) y = -1 / y;
  return sign ? -y : y;
}

// trig_reduce.go

/** Arguments at or above this use Payne-Hanek reduction. */
const REDUCE_THRESHOLD = 1 << 29;

/**
 * `trigReduce`: Payne-Hanek reduction of x ≥ 0 to an octant j and a remainder z in [-Pi/4, Pi/4], using the binary
 * digits of 4/Pi in mPi4.
 */
export function trigReduce(x: number): [number, number] {
  if (x < PI_4) return [0, x];
  let ix = float64bits(x);
  const exp = Number((ix >> SHIFT) & MASK) - BIAS - Number(SHIFT);
  ix &= ~(MASK << SHIFT);
  ix |= 1n << SHIFT;
  const digit = Math.floor((exp + 61) / 64);
  const bitshift = BigInt((exp + 61) % 64);
  const z0 = shiftLeft(M_PI4[digit], bitshift) | shiftRight(M_PI4[digit + 1], 64n - bitshift);
  const z1 = shiftLeft(M_PI4[digit + 1], bitshift) | shiftRight(M_PI4[digit + 2], 64n - bitshift);
  const z2 = shiftLeft(M_PI4[digit + 2], bitshift) | shiftRight(M_PI4[digit + 3], 64n - bitshift);
  const z2hi = (z2 * ix) >> 64n;
  const z1product = z1 * ix;
  const z1hi = z1product >> 64n;
  const z1lo = z1product & UINT64_MASK;
  const z0lo = (z0 * ix) & UINT64_MASK;
  const loSum = z1lo + z2hi;
  const lo = loSum & UINT64_MASK;
  let hi = (z0lo + z1hi + (loSum >> 64n)) & UINT64_MASK;
  let j = hi >> 61n;
  hi = shiftLeft(hi, 3n) | (lo >> 61n);
  const lz = BigInt(leadingZeros64(hi));
  const e = BigInt(BIAS) - (lz + 1n);
  hi = shiftLeft(hi, lz + 1n) | shiftRight(lo, 64n - (lz + 1n));
  hi >>= 64n - SHIFT;
  hi |= e << SHIFT;
  let z = float64frombits(hi);
  if ((j & 1n) === 1n) {
    j = (j + 1n) & 7n;
    z--;
  }
  return [Number(j), z * PI_4];
}

/** `mPi4` holds the binary digits of 4/Pi as a uint64 array. */
const M_PI4 = [
  0x00_00_00_00_00_00_00_01n,
  0x45_f3_06_dc_9c_88_2a_53n,
  0xf8_4e_af_a3_ea_69_bb_81n,
  0xb6_c5_2b_32_78_87_20_83n,
  0xfc_a2_c7_57_bd_77_8a_c3n,
  0x6e_48_dc_74_84_9b_a5_c0n,
  0x0c_92_5d_d4_13_a3_24_39n,
  0xfc_3b_d6_39_62_53_4e_7dn,
  0xd1_04_6b_ea_5d_76_89_09n,
  0xd3_38_e0_4d_68_be_fc_82n,
  0x73_23_ac_73_06_a6_73_e9n,
  0x39_08_bf_17_7b_f2_50_76n,
  0x3f_f1_2f_ff_bc_0b_30_1fn,
  0xde_5e_23_16_b4_14_da_3en,
  0xda_6c_fd_9e_4f_96_13_6en,
  0x9e_8c_7e_cd_3c_bf_d4_5an,
  0xea_4f_75_8f_d7_cb_e2_f6n,
  0x7a_0e_73_ef_14_a5_25_d4n,
  0xd7_f6_bf_62_3f_1a_ba_10n,
  0xac_06_60_8d_f8_f6_d7_57n,
];

// asin.go

/** `math.Asin`. */
export function asin(x: number): number {
  if (x === 0) return x;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  if (x > 1) return Number.NaN;
  let temp = Math.sqrt(fma(-x, x, 1));
  temp = x > 0.7 ? PI_2 - satan(temp / x) : satan(x / temp);
  return sign ? -temp : temp;
}

/** `math.Acos`. */
export function acos(x: number): number {
  return PI_2 - asin(x);
}

// atan.go

/** `xatan` evaluates a series valid in the range [0, 0.66]. */
function xatan(x: number): number {
  const P0 = -0.8750608600031904;
  const P1 = -16.157537187333652;
  const P2 = -75.00855792314705;
  const P3 = -122.88666844901361;
  const P4 = -64.85021904942025;
  const Q0 = +24.858464901423062;
  const Q1 = +165.02700983169885;
  const Q2 = +432.88106049129027;
  const Q3 = +485.3903996359137;
  const Q4 = +194.5506571482614;
  let z = x * x;
  const p = fma(fma(fma(fma(P0, z, P1), z, P2), z, P3), z, P4);
  const q = fma(fma(fma(fma(z + Q0, z, Q1), z, Q2), z, Q3), z, Q4);
  z = (z * p) / q;
  return fma(x, z, x);
}

/** `satan` reduces its argument (known to be positive) to the range [0, 0.66] and calls xatan. */
function satan(x: number): number {
  const Morebits = 6.123233995736766e-17; // pi/2 = PIO2 + Morebits
  const Tan3pio8 = 2.414213562373095; // tan(3*pi/8)
  if (x <= 0.66) return xatan(x);
  if (x > Tan3pio8) return PI_2 - xatan(1 / x) + Morebits;
  return PI_4 + xatan((x - 1) / (x + 1)) + 0.5 * Morebits;
}

/** `math.Atan`. */
export function atan(x: number): number {
  if (x === 0) return x;
  if (x > 0) return satan(x);
  return -satan(-x);
}

// atan2.go

/** `math.Atan2`. */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(y) || Number.isNaN(x)) return Number.NaN;
  if (y === 0) {
    if (x >= 0 && !signbit(x)) return copysign(0, y);
    return copysign(PI, y);
  }
  if (x === 0) return copysign(PI_2, y);
  if (!Number.isFinite(x)) {
    if (x === Infinity) return copysign(Number.isFinite(y) ? 0 : PI_4, y);
    return copysign(Number.isFinite(y) ? PI : PI_3_4, y);
  }
  if (!Number.isFinite(y)) return copysign(PI_2, y);
  const q = atan(y / x);
  if (x < 0) return q <= 0 ? q + PI : q - PI;
  return q;
}

// sinh.go

/** `math.Sinh`. */
export function sinh(x: number): number {
  const P0 = -630_767.3640497717;
  const P1 = -89_912.72022039509;
  const P2 = -2894.211355989564;
  const P3 = -26.30563213397497;
  const Q0 = -630_767.3640497717;
  const Q1 = 15_215.17378790019;
  const Q2 = -173.6789535582337;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  let temp: number;
  if (x > 21) {
    temp = exp(x) * 0.5;
  } else if (x > 0.5) {
    const ex = exp(x);
    temp = (ex - 1 / ex) * 0.5;
  } else {
    const sq = x * x;
    temp = fma(fma(fma(P3, sq, P2), sq, P1), sq, P0) * x;
    temp = temp / fma(fma(sq + Q2, sq, Q1), sq, Q0);
  }
  return sign ? -temp : temp;
}

/** `math.Cosh`. */
export function cosh(x: number): number {
  x = Math.abs(x);
  if (x > 21) return exp(x) * 0.5;
  const ex = exp(x);
  return (ex + 1 / ex) * 0.5;
}

// tanh.go

const TANH_P = [-0.9643991794250523, -99.28772310019185, -1614.6876844170845];
const TANH_Q = [112.81167849163293, 2235.4883906010045, 4844.063053251255];

/** `math.Tanh`. */
export function tanh(x: number): number {
  const MAXLOG = 88.02969193111305; // log(2**127)
  let z = Math.abs(x);
  if (z > 0.5 * MAXLOG) return x < 0 ? -1 : 1;
  if (z >= 0.625) {
    const s = exp(z + z);
    z = 1 - 2 / (s + 1);
    return x < 0 ? -z : z;
  }
  if (x === 0) return x;
  const s = x * x;
  const p = fma(fma(TANH_P[0], s, TANH_P[1]), s, TANH_P[2]);
  const q = fma(fma(s + TANH_Q[0], s, TANH_Q[1]), s, TANH_Q[2]);
  return x + (x * s * p) / q;
}

// asinh.go

/** `math.Asinh`. */
export function asinh(x: number): number {
  const Ln2 = 0.6931471805599453; // 0x3FE62E42FEFA39EF
  const NearZero = 1 / (1 << 28); // 2**-28
  const Large = 1 << 28; // 2**28
  if (Number.isNaN(x) || !Number.isFinite(x)) return x;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  let temp: number;
  if (x > Large) temp = log(x) + Ln2;
  else if (x > 2) temp = log(x + x + 1 / (Math.sqrt(fma(x, x, 1)) + x));
  else if (x < NearZero) temp = x;
  else temp = log1p(x + (x * x) / (1 + Math.sqrt(fma(x, x, 1))));
  return sign ? -temp : temp;
}

// acosh.go

/** `math.Acosh`. */
export function acosh(x: number): number {
  const Large = 1 << 28; // 2**28
  if (x < 1 || Number.isNaN(x)) return Number.NaN;
  if (x === 1) return 0;
  if (x >= Large) return log(x) + LN2;
  if (x > 2) return log(x + x - 1 / (x + Math.sqrt(fma(x, x, -1))));
  const t = x - 1;
  return log1p(t + Math.sqrt(fma(t, t, t + t)));
}

// atanh.go

/** `math.Atanh`. */
export function atanh(x: number): number {
  const NearZero = 1 / (1 << 28); // 2**-28
  if (x < -1 || x > 1 || Number.isNaN(x)) return Number.NaN;
  if (x === 1) return Infinity;
  if (x === -1) return -Infinity;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  let temp: number;
  if (x < NearZero) {
    temp = x;
  } else if (x < 0.5) {
    temp = x + x;
    temp = 0.5 * log1p(temp + (temp * x) / (1 - x));
  } else {
    temp = 0.5 * log1p((x + x) / (1 - x));
  }
  return sign ? -temp : temp;
}

// exp_arm64.s

const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;

/** `math.Exp` as computed by archExp in exp_arm64.s. */
export function exp(x: number): number {
  const Log2e = 1.4426950408889634;
  const Overflow = 709.782712893384;
  const Underflow = -745.1332191019411;
  const NearZero = 2 ** -28;
  if (Number.isNaN(x)) return x;
  if (x > Overflow) return Infinity;
  if (x < Underflow) return 0;
  if (Math.abs(x) < NearZero) return 1 + x;
  // FNMSUBD / FMADDD, then FCVTZSD (truncation) and SCVTFD.
  const k = Math.trunc(x < 0 ? fma(Log2e, x, -0.5) : fma(Log2e, x, 0.5));
  const hi = fma(-k, LN2_HI, x); // FMSUBD
  const lo = k * LN2_LO;
  return expmulti(hi, lo, k);
}

/** `math.Exp2` as computed by archExp2 in exp_arm64.s. */
export function exp2(x: number): number {
  const Overflow = 1023.9999999999999;
  const Underflow = -1074;
  if (Number.isNaN(x)) return x;
  if (x > Overflow) return Infinity;
  if (x < Underflow) return 0;
  const k = Math.trunc(x < 0 ? x - 0.5 : x + 0.5);
  const t = x - k;
  const hi = t * LN2_HI;
  const lo = -(t * LN2_LO); // FNMULD
  return expmulti(hi, lo, k);
}

/**
 * The common tail of archExp and archExp2: `exp(r)` for r = hi - lo, scaled by 2**k with the assembly's inline Ldexp,
 * which adds k to the exponent field and handles only the subnormal case.
 */
function expmulti(hi: number, lo: number, k: number): number {
  const P1 = 0.16666666666666666;
  const P2 = -0.0027777777777015593;
  const P3 = 0.00006613756321437934;
  const P4 = -0.0000016533902205465252;
  const P5 = 4.1381367970572385e-8;
  const r = hi - lo;
  const t = r * r;
  const c = fma(-t, fma(t, fma(t, fma(t, fma(t, P5, P4), P3), P2), P1), r);
  const y = 1 - (lo - (r * c) / (2 - c) - hi);
  const bits = float64bits(y);
  let exponent = (bits >> SHIFT) + BigInt(k);
  let m = 1;
  if (exponent < 1n) {
    exponent += 52n;
    m = 2 ** -52;
  }
  return m * float64frombits(BigInt.asUintN(64, (bits & FRAC_MASK) | (exponent << SHIFT)));
}

const FRAC_MASK = (1n << SHIFT) - 1n;

// expm1.go

/** `math.Expm1`. */
export function expm1(x: number): number {
  const Othreshold = 709.782712893384; // 0x40862E42FEFA39EF
  const Ln2X56 = 38.816242111356935; // 0x4043687a9f1af2b1
  const Ln2HalfX3 = 1.0397207708399179; // 0x3ff0a2b23f3bab73
  const Ln2Half = 0.34657359027997264; // 0x3fd62e42fefa39ef
  const InvLn2 = 1.4426950408889634; // 0x3ff71547652b82fe
  const Tiny = 1 / 2 ** 54; // 2**-54 = 0x3c90000000000000
  const Q1 = -0.03333333333333313; // 0xBFA11111111110F4
  const Q2 = 0.0015873015872548146; // 0x3F5A01A019FE5585
  const Q3 = -0.0000793650757867488; // 0xBF14CE199EAADBB7
  const Q4 = 0.000004008217827329362; // 0x3ED0CFCA86E65239
  const Q5 = -2.0109921818362437e-7; // 0xBE8AFDB76E09C32D
  if (x === Infinity || Number.isNaN(x)) return x;
  if (x === -Infinity) return -1;
  let absx = x;
  let sign = false;
  if (x < 0) {
    absx = -absx;
    sign = true;
  }
  if (absx >= Ln2X56) {
    if (sign) return -1;
    if (absx >= Othreshold) return Infinity;
  }
  let c = 0;
  let k = 0;
  if (absx > Ln2Half) {
    let hi: number;
    let lo: number;
    if (absx < Ln2HalfX3) {
      if (!sign) {
        hi = x - LN2_HI;
        lo = LN2_LO;
        k = 1;
      } else {
        hi = x + LN2_HI;
        lo = -LN2_LO;
        k = -1;
      }
    } else {
      k = Math.trunc(sign ? fma(InvLn2, x, -0.5) : fma(InvLn2, x, 0.5));
      hi = fma(-k, LN2_HI, x);
      lo = k * LN2_LO;
    }
    x = hi - lo;
    c = hi - x - lo;
  } else if (absx < Tiny) {
    return x;
  }
  const hfx = 0.5 * x;
  const hxs = x * hfx;
  const r1 = fma(hxs, fma(hxs, fma(hxs, fma(hxs, fma(hxs, Q5, Q4), Q3), Q2), Q1), 1);
  const t = fma(-r1, hfx, 3);
  const quotient = (r1 - t) / fma(-x, t, 6);
  // e := hxs * quotient stays a multiplication, so each later use of e fuses with it.
  if (k === 0) return x - fma(-x, hfx, x * (hxs * quotient)); // x - (x*e - hxs)
  let e = fma(x, fma(hxs, quotient, -c), -c); // x*(e-c) - c
  e = fma(-x, hfx, e); // e -= hxs
  if (k === -1) return fma(0.5, x - e, -0.5);
  if (k === 1) {
    if (x < -0.25) return -2 * (e - (x + 0.5));
    return 1 + 2 * (x - e);
  }
  if (k <= -2 || k > 56) {
    const y = addToExponent(1 - (e - x), k);
    return y - 1;
  }
  if (k < 20) {
    const scale = float64frombits(0x3f_f0_00_00_00_00_00_00n - (0x20_00_00_00_00_00_00n >> BigInt(k)));
    return addToExponent(scale - (e - x), k);
  }
  const scale = float64frombits(BigInt(0x3_ff - k) << SHIFT);
  return addToExponent(x - (e + scale) + 1, k);
}

/** `Float64frombits(Float64bits(y) + uint64(k)<<52)`. */
function addToExponent(y: number, k: number): number {
  return float64frombits(float64bits(y) + (BigInt(k) << SHIFT));
}

// log.go

/** `math.Log`. */
export function log(x: number): number {
  const L1 = 0.6666666666666735;
  const L2 = 0.3999999999940942;
  const L3 = 0.2857142874366239;
  const L4 = 0.22222198432149784;
  const L5 = 0.1818357216161805;
  const L6 = 0.15313837699209373;
  const L7 = 0.14798198605116586;
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x < 0) return Number.NaN;
  if (x === 0) return -Infinity;
  let [f1, ki] = frexp(x);
  if (f1 < SQRT2_2) {
    f1 *= 2;
    ki--;
  }
  const f = f1 - 1;
  const k = ki;
  const s = f / (2 + f);
  const s2 = s * s;
  const s4 = s2 * s2;
  const t2 = s4 * fma(s4, fma(s4, L6, L4), L2);
  // R := t1 + t2 fuses the multiplication of t1 := s2 * (...) (the compiler's argument order, checked on arm64).
  const R = fma(s2, fma(s4, fma(s4, fma(s4, L7, L5), L3), L1), t2);
  // hfsq := 0.5 * f * f fuses into both `hfsq+R` and `hfsq - (...)`; `s*(hfsq+R) + k*Ln2Lo` fuses s*(hfsq+R).
  const sum = fma(s, fma(0.5 * f, f, R), k * LN2_LO);
  return fma(k, LN2_HI, -(fma(0.5 * f, f, -sum) - f));
}

// log10.go

/** `math.Log10`. */
export function log10(x: number): number {
  return log(x) * INV_LN10;
}

/** `math.Log2`. */
export function log2(x: number): number {
  const [frac, exp] = frexp(x);
  // Make sure exact powers of two give an exact answer.
  if (frac === 0.5) return exp - 1;
  return fma(log(frac), INV_LN2, exp);
}

// log1p.go

/** `math.Log1p`. */
export function log1p(x: number): number {
  const Sqrt2M1 = 0.41421356237309503; // Sqrt(2)-1 = 0x3fda827999fcef34
  const Sqrt2HalfM1 = -0.2928932188134525; // Sqrt(2)/2-1 = 0xbfd2bec333018866
  const Small = 1 / (1 << 29); // 2**-29 = 0x3e20000000000000
  const Tiny = 1 / 2 ** 54; // 2**-54
  const Two53 = 2 ** 53; // 2**53
  const Lp1 = 0.6666666666666735; // 3FE5555555555593
  const Lp2 = 0.3999999999940942; // 3FD999999997FA04
  const Lp3 = 0.2857142874366239; // 3FD2492494229359
  const Lp4 = 0.22222198432149784; // 3FCC71C51D8E78AF
  const Lp5 = 0.1818357216161805; // 3FC7466496CB03DE
  const Lp6 = 0.15313837699209373; // 3FC39A09D078C69F
  const Lp7 = 0.14798198605116586; // 3FC2F112DF3E5244
  if (x < -1 || Number.isNaN(x)) return Number.NaN;
  if (x === -1) return -Infinity;
  if (x === Infinity) return Infinity;
  const absx = Math.abs(x);
  let f = 0;
  let iu = 0n;
  let k = 1;
  if (absx < Sqrt2M1) {
    if (absx < Small) {
      if (absx < Tiny) return x;
      return fma(-(x * x), 0.5, x); // x - x*x*0.5
    }
    if (x > Sqrt2HalfM1) {
      k = 0;
      f = x;
      iu = 1n;
    }
  }
  let c = 0;
  if (k !== 0) {
    let u: number;
    if (absx < Two53) {
      u = 1 + x;
      iu = float64bits(u);
      k = Number(iu >> SHIFT) - 1023;
      c = k > 0 ? 1 - (u - x) : x - (u - 1);
      c /= u;
    } else {
      u = x;
      iu = float64bits(u);
      k = Number(iu >> SHIFT) - 1023;
      c = 0;
    }
    iu &= FRAC_MASK;
    if (iu < 0x00_06_a0_9e_66_7f_3b_cdn) {
      u = float64frombits(iu | 0x3f_f0_00_00_00_00_00_00n); // normalize u
    } else {
      k++;
      u = float64frombits(iu | 0x3f_e0_00_00_00_00_00_00n); // normalize u/2
      iu = (0x00_10_00_00_00_00_00_00n - iu) >> 2n;
    }
    f = u - 1;
  }
  // hfsq := 0.5 * f * f stays a multiplication and fuses where it is added or subtracted.
  const hfsq = 0.5 * f * f;
  if (iu === 0n) {
    if (f === 0) {
      if (k === 0) return 0;
      c = fma(k, LN2_LO, c);
      return fma(k, LN2_HI, c);
    }
    const p = fma(-0.6666666666666666, f, 1); // R = hfsq * p
    if (k === 0) return fma(-hfsq, p, f);
    return fma(k, LN2_HI, -(fma(hfsq, p, -fma(k, LN2_LO, c)) - f));
  }
  const s = f / (2 + f);
  const z = s * s;
  const p = fma(z, fma(z, fma(z, fma(z, fma(z, fma(z, Lp7, Lp6), Lp5), Lp4), Lp3), Lp2), Lp1); // R = z * p
  const hfsqPlusR = fma(0.5 * f, f, z * p); // hfsq+R fuses hfsq, not R (the compiler's argument order)
  if (k === 0) return f - fma(-s, hfsqPlusR, hfsq);
  return fma(k, LN2_HI, -(fma(0.5 * f, f, -fma(s, hfsqPlusR, fma(k, LN2_LO, c))) - f));
}

// pow.go

/** `isOddInt` reports whether x is an odd integer. */
function isOddInt(x: number): boolean {
  if (Math.abs(x) >= 2 ** 53) return false;
  const [xi, xf] = modf(x);
  return xf === 0 && Math.abs(xi) % 2 === 1;
}

/** `math.Pow`. */
export function pow(x: number, y: number): number {
  if (y === 0 || x === 1) return 1;
  if (y === 1) return x;
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (x === 0) {
    if (y < 0) return signbit(x) && isOddInt(y) ? -Infinity : Infinity;
    if (y > 0) return signbit(x) && isOddInt(y) ? x : 0;
  } else if (!Number.isFinite(y)) {
    if (x === -1) return 1;
    if (Math.abs(x) < 1 === (y === Infinity)) return 0;
    return Infinity;
  } else if (!Number.isFinite(x)) {
    if (x === -Infinity) return pow(1 / x, -y); // Pow(-0, -y)
    if (y < 0) return 0;
    if (y > 0) return Infinity;
  } else if (y === 0.5) {
    return Math.sqrt(x);
  } else if (y === -0.5) {
    return 1 / Math.sqrt(x);
  }

  let [yi, yf] = modf(Math.abs(y));
  if (yf !== 0 && x < 0) return Number.NaN;
  if (yi >= 2 ** 63) {
    // yi is a large even int that will lead to overflow (or underflow to 0) for all x except -1 (x == 1 was handled).
    if (x === -1) return 1;
    if (Math.abs(x) < 1 === y > 0) return 0;
    return Infinity;
  }

  // ans = a1 * 2**ae (= 1 for now).
  let a1 = 1;
  let ae = 0;

  // ans *= x**yf
  if (yf !== 0) {
    if (yf > 0.5) {
      yf--;
      yi++;
    }
    a1 = exp(yf * log(x));
  }

  // ans *= x**yi by repeated squaring and multiplying by the bits of yi.
  let [x1, xe] = frexp(x);
  for (let i = yi; i !== 0; i = Math.floor(i / 2)) {
    if (xe < -(1 << 12) || 1 << 12 < xe) {
      // Catastrophic overflow; let Ldexp do the work.
      ae += xe;
      break;
    }
    if (i % 2 === 1) {
      a1 *= x1;
      ae += xe;
    }
    x1 *= x1;
    xe *= 2;
    if (x1 < 0.5) {
      x1 += x1;
      xe--;
    }
  }

  // ans = a1 * 2**ae; if y < 0 { ans = 1 / ans } but in the opposite order.
  if (y < 0) {
    a1 = 1 / a1;
    ae = -ae;
  }
  return ldexp(a1, ae);
}

// cbrt.go

/** `math.Cbrt`. */
export function cbrt(x: number): number {
  const B1 = 715_094_163n; // (682-0.03306235651)*2**20
  const B2 = 696_219_795n; // (664-0.03306235651)*2**20
  const C = 0.5428571428571428; // 19/35     = 0x3FE15F15F15F15F1
  const D = -0.7053061224489796; // -864/1225 = 0xBFE691DE2532C834
  const E = 1.4142857142857144; // 99/70     = 0x3FF6A0EA0EA0EA0F
  const F = 1.6071428571428572; // 45/28     = 0x3FF9B6DB6DB6DB6E
  const G = 0.35714285714285715; // 5/14      = 0x3FD6DB6DB6DB6DB7
  if (x === 0 || Number.isNaN(x) || !Number.isFinite(x)) return x;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  // rough cbrt to 5 bits
  let t = float64frombits(float64bits(x) / 3n + (B1 << 32n));
  if (x < SMALLEST_NORMAL) {
    // subnormal number
    t = 2 ** 54; // set t= 2**54
    t *= x;
    t = float64frombits(float64bits(t) / 3n + (B2 << 32n));
  }
  // new cbrt to 23 bits
  let r = (t * t) / x;
  let s = fma(r, t, C);
  t *= G + F / (s + E + D / s);
  // chop to 22 bits, make larger than cbrt(x)
  t = float64frombits((float64bits(t) & (0xf_ff_ff_ff_fcn << 28n)) + (1n << 30n));
  // one step newton iteration to 53 bits with error less than 0.667ulps
  s = t * t; // t*t is exact
  r = x / s;
  const w = t + t;
  r = (r - t) / (w + r); // r-s is exact
  t = fma(t, r, t);
  return sign ? -t : t;
}

// frexp.go, ldexp.go, modf.go

/** `math.Frexp` breaks f into a normalized fraction in [½, 1) and an integral power of two. */
export function frexp(f: number): [number, number] {
  if (f === 0 || Number.isNaN(f) || !Number.isFinite(f)) return [f, 0];
  const [normal, shift] = normalize(f);
  let x = float64bits(normal);
  const exp = shift + Number((x >> SHIFT) & MASK) - BIAS + 1;
  x &= ~(MASK << SHIFT);
  x |= BigInt(-1 + BIAS) << SHIFT;
  return [float64frombits(x), exp];
}

/** `math.Ldexp` returns frac × 2**exp. */
export function ldexp(frac: number, exp: number): number {
  if (frac === 0 || Number.isNaN(frac) || !Number.isFinite(frac)) return frac;
  const [normal, e] = normalize(frac);
  exp += e;
  let x = float64bits(normal);
  exp += Number((x >> SHIFT) & MASK) - BIAS;
  if (exp < -1075) return copysign(0, normal); // underflow
  if (exp > 1023) return normal < 0 ? -Infinity : Infinity; // overflow
  let m = 1;
  if (exp < -1022) {
    // denormal
    exp += 53;
    m = 1 / 2 ** 53; // 2**-53
  }
  x &= ~(MASK << SHIFT);
  x |= BigInt(exp + BIAS) << SHIFT;
  return m * float64frombits(x);
}

/** `math.Modf` returns the integer and fractional parts of f, both with the sign of f. */
export function modf(f: number): [number, number] {
  const integer = Math.trunc(f);
  return [integer, copysign(f - integer, f)];
}

// bits.go, copysign.go, signbit.go, math/bits

/** `normalize` returns a normal number y and exponent exp satisfying x == y × 2**exp. */
function normalize(x: number): [number, number] {
  if (Math.abs(x) < SMALLEST_NORMAL) return [x * 2 ** 52, -52];
  return [x, 0];
}

function copysign(f: number, sign: number): number {
  return signbit(f) === signbit(sign) ? f : -f;
}

function signbit(x: number): boolean {
  return float64bits(x) >> 63n === 1n;
}

const bitsView = new DataView(new ArrayBuffer(8));

function float64bits(f: number): bigint {
  bitsView.setFloat64(0, f);
  return bitsView.getBigUint64(0);
}

function float64frombits(b: bigint): number {
  bitsView.setBigUint64(0, BigInt.asUintN(64, b));
  return bitsView.getFloat64(0);
}

/** Go's `x << n` on a uint64: zero once n reaches 64. */
function shiftLeft(x: bigint, n: bigint): bigint {
  return n >= 64n ? 0n : (x << n) & UINT64_MASK;
}

/** Go's `x >> n` on a uint64: zero once n reaches 64 (or wraps around as a uint). */
function shiftRight(x: bigint, n: bigint): bigint {
  return n >= 64n || n < 0n ? 0n : x >> n;
}

function leadingZeros64(x: bigint): number {
  return x === 0n ? 64 : 64 - x.toString(2).length;
}
