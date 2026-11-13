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

// sincos.go

/** `math.Sincos`, which compiles to the same arithmetic as Sin and Cos. */
export function sincos(x: number): [number, number] {
  return [sin(x), cos(x)];
}

// pow10.go

const POW10_TAB = Array.from({ length: 32 }, (_, i) => Number(`1e${i}`));
const POW10_POS_TAB32 = Array.from({ length: 10 }, (_, i) => Number(`1e${i * 32}`));
const POW10_NEG_TAB32 = Array.from({ length: 11 }, (_, i) => Number(`1e-${i * 32}`));

/** `math.Pow10`. */
export function pow10(n: bigint): number {
  if (0n <= n && n <= 308n) return POW10_POS_TAB32[Number(n / 32n)] * POW10_TAB[Number(n % 32n)];
  if (-323n <= n && n < 0n) return POW10_NEG_TAB32[Number(-n / 32n)] / POW10_TAB[Number(-n % 32n)];
  return n > 0n ? Infinity : 0;
}

// logb.go

/** `math.Logb`. */
export function logb(x: number): number {
  if (x === 0) return -Infinity;
  if (!Number.isFinite(x)) return Number.isNaN(x) ? x : Infinity;
  return ilogbFinite(x);
}

/** `math.Ilogb`. */
export function ilogb(x: number): number {
  if (x === 0) return -2_147_483_648;
  if (!Number.isFinite(x)) return 2_147_483_647;
  return ilogbFinite(x);
}

function ilogbFinite(x: number): number {
  const [normal, exp] = normalize(x);
  return Number((float64bits(normal) >> SHIFT) & MASK) - BIAS + exp;
}

// gamma.go

const GAMMA_P = [
  1, 0.4942148268014971, 0.20744822764843598, 0.04763678004571372, 0.010421379756176158, 0.0011913514700658638,
  0.00016011952247675185,
];
const GAMMA_Q = [
  1, 0.0714304917030273, -0.23459179571824335, 0.035823639860549865, 0.011813978522206043, -0.004456419138517973,
  0.0005396055804933034, -0.000023158187332412014,
];
const GAMMA_S = [
  0.08333333333334822, 0.0034722222160545866, -0.0026813261780578124, -0.00022954996161337813, 0.0007873113957930937,
];

/** `math.Gamma`. */
export function gamma(x: number): number {
  const Euler = 0.5772156649015329;
  if (isNegInt(x) || x === -Infinity || Number.isNaN(x)) return Number.NaN;
  if (x === Infinity) return Infinity;
  if (x === 0) return signbit(x) ? -Infinity : Infinity;
  const q = Math.abs(x);
  let p = Math.floor(q);
  if (q > 33) {
    if (x >= 0) {
      const [y1, y2] = stirling(x);
      return y1 * y2;
    }
    const signgam = p % 2 === 0 ? -1 : 1;
    let z = q - p;
    if (z > 0.5) {
      p++;
      z = q - p;
    }
    z = q * sin(PI * z);
    if (z === 0) return signgam * Infinity;
    const [sq1, sq2] = stirling(q);
    const absz = Math.abs(z);
    const d = absz * sq1 * sq2;
    z = Number.isFinite(d) ? PI / d : PI / absz / sq1 / sq2;
    return signgam * z;
  }

  let z = 1;
  while (x >= 3) {
    x--;
    z *= x;
  }
  while (x < 0) {
    if (x > -1e-9) return gammaSmall(x, z, Euler);
    z /= x;
    x++;
  }
  while (x < 2) {
    if (x < 1e-9) return gammaSmall(x, z, Euler);
    z /= x;
    x++;
  }
  if (x === 2) return z;
  x -= 2;
  return (z * polynomial(x, GAMMA_P)) / polynomial(x, GAMMA_Q);
}

function gammaSmall(x: number, z: number, euler: number): number {
  if (x === 0) return Infinity;
  return z / (fma(euler, x, 1) * x);
}

/**
 * Gamma by Stirling's formula, as a pair whose product is the answer, so that callers can avoid overflow for
 * 172 <= x <= 180.
 */
function stirling(x: number): [number, number] {
  const SqrtTwoPi = 2.5066282746310007;
  const MaxStirling = 143.01608;
  if (x > 200) return [Infinity, 1];
  let w = 1 / x;
  w = fma(w, polynomial(w, GAMMA_S), 1);
  let y1 = exp(x);
  let y2 = 1;
  if (x > MaxStirling) {
    const v = pow(x, fma(0.5, x, -0.25));
    y2 = v / y1;
    y1 = v;
  } else {
    y1 = pow(x, x - 0.5) / y1;
  }
  return [y1, SqrtTwoPi * w * y2];
}

function isNegInt(x: number): boolean {
  return x < 0 && modf(x)[1] === 0;
}

// lgamma.go

const LGAMMA_A = [
  0.07721566490153287, 0.3224670334241136, 0.06735230105312927, 0.020580808432516733, 0.007385550860814029,
  0.0028905138367341563, 0.0011927076318336207, 0.0005100697921535113, 0.00022086279071390839, 0.00010801156724758394,
  0.000025214456545125733, 0.000044864094961891516,
];
const LGAMMA_A_EVEN = LGAMMA_A.filter((_, i) => i % 2 === 0);
const LGAMMA_A_ODD = LGAMMA_A.filter((_, i) => i % 2 === 1);
const LGAMMA_R = [
  1, 1.3920053346762105, 0.7219355475671381, 0.17193386563280308, 0.01864591917156529, 0.0007779424963818936,
  0.000007326684307446256,
];
const LGAMMA_S = [
  -0.07721566490153287, 0.21498241596060885, 0.325778796408931, 0.14635047265246445, 0.02664227030336386,
  0.0018402845140733772, 0.00003194753265841009,
];
const LGAMMA_T = [
  0.48383612272381005, -0.1475877229945939, 0.06462494023913339, -0.032788541075985965, 0.01797067508118204,
  -0.010314224129834144, 0.006100538702462913, -0.0036845201678113826, 0.0022596478090061247, -0.0014034646998923284,
  0.000881081882437654, -0.0005385953053567405, 0.00031563207090362595, -0.00031275416837512086, 0.0003355291926355191,
];
const LGAMMA_T_PARTS = [0, 1, 2].map((offset) => LGAMMA_T.filter((_, i) => i % 3 === offset));
const LGAMMA_U = [
  -0.07721566490153287, 0.6328270640250934, 1.4549225013723477, 0.9777175279633727, 0.22896372806469245,
  0.013381091853678766,
];
const LGAMMA_V = [
  1, 2.4559779371304113, 2.128489763798934, 0.7692851504566728, 0.10422264559336913, 0.003217092422824239,
];
const LGAMMA_W = [
  0.4189385332046727, 0.08333333333333297, -0.0027777777772877554, 0.0007936505586430196, -0.00059518755745034,
  0.0008363399189962821, -0.0016309293409657527,
];

/** `math.Lgamma` returns the natural logarithm and sign (-1 or +1) of Gamma(x). */
export function lgamma(x: number): [number, number] {
  const Two52 = 2 ** 52;
  const Two58 = 2 ** 58;
  const Tiny = 2 ** -70;
  const Tc = 1.4616321449683622;
  const Tf = -0.12148629053584961;
  const Tt = -3.638676997039505e-18;
  let sign = 1;
  if (Number.isNaN(x) || !Number.isFinite(x)) return [x, sign];
  if (x === 0) return [Infinity, sign];

  let neg = false;
  if (x < 0) {
    x = -x;
    neg = true;
  }
  if (x < Tiny) {
    if (neg) sign = -1;
    return [-log(x), sign];
  }
  let nadj = 0;
  if (neg) {
    if (x >= Two52) return [Infinity, sign];
    const t = sinPi(x);
    if (t === 0) return [Infinity, sign];
    nadj = log(PI / Math.abs(t * x));
    if (t < 0) sign = -1;
  }

  let result: number;
  if (x === 1 || x === 2) {
    return [0, sign];
  } else if (x < 2) {
    let y: number;
    let i: number;
    if (x <= 0.9) {
      result = -log(x);
      if (x >= 0.7316321449683623) {
        // Ymin - 1 + 0.27
        y = 1 - x;
        i = 0;
      } else if (x >= 0.19163214496836226) {
        // Ymin - 1 - 0.27
        y = x - 0.46163214496836225; // Tc - 1
        i = 1;
      } else {
        y = x;
        i = 2;
      }
    } else {
      result = 0;
      if (x >= 1.7316321449683623) {
        // Ymin + 0.27
        y = 2 - x;
        i = 0;
      } else if (x >= 1.1916321449683622) {
        // Ymin - 0.27
        y = x - Tc;
        i = 1;
      } else {
        y = x - 1;
        i = 2;
      }
    }
    if (i === 0) {
      const z = y * y;
      const p1 = polynomial(z, LGAMMA_A_EVEN);
      // p := y*p1 + p2 fuses the multiplication of p2 := z * (...) (checked on arm64).
      const p = fma(z, polynomial(z, LGAMMA_A_ODD), y * p1);
      result += fma(-0.5, y, p);
    } else if (i === 1) {
      const z = y * y;
      const w = z * y;
      const [p1, p2, p3] = LGAMMA_T_PARTS.map((part) => polynomial(w, part));
      const p = fma(z, p1, -fma(-w, fma(y, p3, p2), Tt));
      result += Tf + p;
    } else {
      const p1 = y * polynomial(y, LGAMMA_U);
      const p2 = polynomial(y, LGAMMA_V);
      result += fma(-0.5, y, p1 / p2);
    }
  } else if (x < 8) {
    const i = Math.trunc(x);
    const y = x - i;
    const p = y * polynomial(y, LGAMMA_S);
    const q = polynomial(y, LGAMMA_R);
    result = fma(0.5, y, p / q);
    if (i >= 3) {
      let z = 1;
      for (let k = i - 1; k >= 2; k--) z *= y + k;
      result += log(z);
    }
  } else if (x < Two58) {
    const t = log(x);
    const z = 1 / x;
    const y = z * z;
    const w = fma(z, polynomial(y, LGAMMA_W.slice(1)), LGAMMA_W[0]);
    result = fma(x - 0.5, t - 1, w);
  } else {
    result = x * (log(x) - 1);
  }
  if (neg) result = nadj - result;
  return [result, sign];
}

/** `sinPi(x)` returns -Sin(Pi*x) for x > 0. */
function sinPi(x: number): number {
  const Two52 = 2 ** 52;
  const Two53 = 2 ** 53;
  if (x < 0.25) return -sin(PI * x);
  let z = Math.floor(x);
  let n: number;
  if (z === x) {
    if (x >= Two53) {
      x = 0;
      n = 0;
    } else {
      if (x < Two52) z = x + Two52;
      n = Number(1n & float64bits(z));
      x = n;
      n <<= 2;
    }
  } else {
    x %= 2;
    n = Math.trunc(x * 4);
  }
  switch (n) {
    case 0: {
      x = sin(PI * x);
      break;
    }
    case 1:
    case 2: {
      x = cos(PI * (0.5 - x));
      break;
    }
    case 3:
    case 4: {
      x = sin(PI * (1 - x));
      break;
    }
    case 5:
    case 6: {
      x = -cos(PI * (x - 1.5));
      break;
    }
    default: {
      x = sin(PI * (x - 2));
      break;
    }
  }
  return -x;
}

// erf.go

const ERX = 0.8450629115104675;
const ERF_PP = [
  0.12837916709551256, -0.3250421072470015, -0.02848174957559851, -0.005770270296489442, -0.000023763016656650163,
];
const ERF_QQ = [
  1, 0.39791722395915535, 0.0650222499887673, 0.005081306281875766, 0.00013249473800432164, -0.000003960228278775368,
];
const ERF_PA = [
  -0.0023621185607526594, 0.41485611868374833, -0.3722078760357013, 0.31834661990116175, -0.11089469428239668,
  0.035478304325618236, -0.002166375594868791,
];
const ERF_QA = [
  1, 0.10642088040084423, 0.540397917702171, 0.07182865441419627, 0.12617121980876164, 0.01363708391202905,
  0.011984499846799107,
];
const ERF_RA = [
  -0.009864944034847148, -0.6938585727071818, -10.558626225323291, -62.375332450326006, -162.39666946257347,
  -184.60509290671104, -81.2874355063066, -9.814329344169145,
];
const ERF_SA = [
  1, 19.651271667439257, 137.65775414351904, 434.56587747522923, 645.3872717332679, 429.00814002756783,
  108.63500554177944, 6.570249770319282, -0.0604244152148581,
];
const ERF_RB = [
  -0.0098649429247001, -0.799283237680523, -17.757954917754752, -160.63638485582192, -637.5664433683896,
  -1025.0951316110772, -483.5191916086514,
];
const ERF_SB = [
  1, 30.33806074348246, 325.7925129965739, 1536.729586084437, 3199.8582195085955, 2553.0504064331644,
  474.52854120695537, -22.44095244658582,
];

/** `math.Erf`. */
export function erf(x: number): number {
  const VeryTiny = 2.848094538889218e-306;
  const Small = 2 ** -28;
  const efx = 0.1283791670955126;
  const efx8 = 1.0270333367641007;
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Infinity) return 1;
  if (x === -Infinity) return -1;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  if (x < 0.84375) {
    let temp: number;
    if (x < Small) {
      // 0.125 * (8.0*x + efx8*x) fuses efx8*x (checked on arm64).
      temp = x < VeryTiny ? 0.125 * fma(efx8, x, 8 * x) : fma(efx, x, x);
    } else {
      const y = erfSmallRatio(x);
      temp = fma(x, y, x);
    }
    return sign ? -temp : temp;
  }
  if (x < 1.25) {
    const ratio = erfNearOneRatio(x);
    return sign ? -ERX - ratio : ERX + ratio;
  }
  if (x >= 6) return sign ? -1 : 1;
  const r = erfTail(x, x < 1 / 0.35);
  return sign ? r / x - 1 : 1 - r / x;
}

/** `math.Erfc`. */
export function erfc(x: number): number {
  const Tiny = 2 ** -56;
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Infinity) return 0;
  if (x === -Infinity) return 2;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  if (x < 0.84375) {
    let temp: number;
    if (x < Tiny) {
      temp = x;
    } else {
      const y = erfSmallRatio(x);
      temp = x < 0.25 ? fma(x, y, x) : 0.5 + fma(x, y, x - 0.5);
    }
    return sign ? 1 + temp : 1 - temp;
  }
  if (x < 1.25) {
    const ratio = erfNearOneRatio(x);
    return sign ? 1.8450629115104675 + ratio : 0.15493708848953247 - ratio; // 1 + erx, 1 - erx
  }
  if (x < 28) {
    if (sign && x > 6) return 2;
    const r = erfTail(x, x < 1 / 0.35);
    return sign ? 2 - r / x : r / x;
  }
  return sign ? 2 : 0;
}

/** `r/s` with r and s the erf polynomials in x*x for |x| < 0.84375. */
function erfSmallRatio(x: number): number {
  const z = x * x;
  return polynomial(z, ERF_PP) / polynomial(z, ERF_QQ);
}

/** `P/Q` with P and Q the erf polynomials in x-1 for 0.84375 <= |x| < 1.25. */
function erfNearOneRatio(x: number): number {
  const s = x - 1;
  return polynomial(s, ERF_PA) / polynomial(s, ERF_QA);
}

/** `Exp(-z*z-0.5625) * Exp((z-x)*(z+x)+R/S)` for 1.25 <= x, where z is x with the low 32 bits cleared. */
function erfTail(x: number, belowOneOver035: boolean): number {
  const s = 1 / (x * x);
  const R = polynomial(s, belowOneOver035 ? ERF_RA : ERF_RB);
  const S = polynomial(s, belowOneOver035 ? ERF_SA : ERF_SB);
  const z = float64frombits(float64bits(x) & 0xff_ff_ff_ff_00_00_00_00n);
  return exp(fma(-z, z, -0.5625)) * exp(fma(z - x, z + x, R / S));
}

// erfinv.go

const ERFINV_A = [
  1.1975323115670913, 47.07268811238398, 697.062665343896, 4854.886889384388, 16_235.862515167575, 23_782.041382114385,
  11_819.493347062295, 887.0940696254552,
];
const ERFINV_B = [
  1, 42.31333070160091, 687.1870074920579, 5394.196021424751, 21_213.794301586597, 39_307.89580009271,
  28_729.085735721943, 5226.495278852854,
];
const ERFINV_C = [
  1.4234371107496835, 4.630337846156546, 5.769497221460691, 3.6478483247632045, 1.2704582524523684, 0.2417807251774506,
  0.022723844989269184, 0.0007745450142783414,
];
const ERFINV_D = [
  1.4142135623730951, 2.9036514445419948, 2.3707661626024534, 0.9754783200178743, 0.2094506521051275,
  0.021494160384252878, 0.0007744145906515771, 1.4859850019840355e-9,
];
const ERFINV_E = [
  6.657904643501103, 5.463784911164114, 1.7848265399172913, 0.29656057182850487, 0.026532189526576124,
  0.0012426609473880784, 0.000027115555687434876, 2.0103343992922881e-7,
];
const ERFINV_F = [
  1.4142135623730951, 0.8482908416595164, 0.19364809469506591, 0.02103693768272069, 0.0011128009970788597,
  0.000026110884050805935, 2.010321207683943e-7, 2.8910246058729655e-15,
];

/** `math.Erfinv`. */
export function erfinv(x: number): number {
  if (Number.isNaN(x) || x <= -1 || x >= 1) {
    if (x === -1 || x === 1) return x * Infinity;
    return Number.NaN;
  }
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  let ans: number;
  if (x <= 0.85) {
    const r = fma(-(0.25 * x), x, 0.180625);
    ans = (x * polynomial(r, ERFINV_A)) / polynomial(r, ERFINV_B);
  } else {
    let r = Math.sqrt(LN2 - log(1 - x));
    if (r <= 5) {
      r -= 1.6;
      ans = polynomial(r, ERFINV_C) / polynomial(r, ERFINV_D);
    } else {
      r -= 5;
      ans = polynomial(r, ERFINV_E) / polynomial(r, ERFINV_F);
    }
  }
  return sign ? -ans : ans;
}

/** `math.Erfcinv`. */
export function erfcinv(x: number): number {
  return erfinv(1 - x);
}

// j0.go

const INV_SQRT_PI = 0.5641895835477563; // 1/SqrtPi
const TWO_OVER_PI = 0.6366197723675814; // 2/Pi
const TWO_M27 = 2 ** -27;
const TWO_129 = 2 ** 129;
const HALF_MAX_FLOAT64 = Number.MAX_VALUE / 2;

/** `math.J0` returns the order-zero Bessel function of the first kind. */
export function j0(x: number): number {
  const TwoM13 = 2 ** -13;
  const R = [0.015624999999999995, -0.00018997929423885472, 0.0000018295404953270067, -4.618326885321032e-9];
  const S = [1, 0.015619102946489001, 0.00011692678466333745, 5.135465502073181e-7, 1.1661400333379e-9];
  if (Number.isNaN(x)) return x;
  if (!Number.isFinite(x)) return 0;
  if (x === 0) return 1;
  x = Math.abs(x);
  if (x >= 2) {
    const [s, c] = sincos(x);
    let ss = s - c;
    let cc = s + c;
    if (x < HALF_MAX_FLOAT64) {
      const z = -cos(x + x);
      if (s * c < 0) cc = z / ss;
      else ss = z / cc;
    }
    if (x > TWO_129) return (INV_SQRT_PI * cc) / Math.sqrt(x);
    const u = besselAsymptotic(x, P0_TABLES, 1);
    const v = besselAsymptotic(x, Q0_TABLES, -0.125) / x;
    return (INV_SQRT_PI * fma(-v, ss, u * cc)) / Math.sqrt(x);
  }
  if (x < TwoM13) {
    if (x < TWO_M27) return 1;
    return fma(-(0.25 * x), x, 1);
  }
  const z = x * x;
  const r = z * polynomial(z, R);
  const s = polynomial(z, S);
  if (x < 1) return fma(z, -0.25 + r / s, 1);
  // (1+u)*(1-u) + z*(r/s) with u := 0.5*x fuses z*(r/s), 0.5*x into 1+u, and 0.5*x into 1-u (checked on arm64).
  return fma(z, r / s, fma(0.5, x, 1) * fma(-0.5, x, 1));
}

/** `math.Y0` returns the order-zero Bessel function of the second kind. */
export function y0(x: number): number {
  const U = [
    -0.07380429510868723, 0.17666645250918112, -0.01381856719455969, 0.00034745343209368365, -0.0000038140705372436416,
    1.9559013703502292e-8, -3.982051941321034e-11,
  ];
  const V = [1, 0.01273048348341237, 0.00007600686273503533, 2.591508518404578e-7, 4.4111031133267547e-10];
  if (x < 0 || Number.isNaN(x)) return Number.NaN;
  if (x === Infinity) return 0;
  if (x === 0) return -Infinity;
  if (x >= 2) {
    const [s, c] = sincos(x);
    let ss = s - c;
    let cc = s + c;
    if (x < HALF_MAX_FLOAT64) {
      const z = -cos(x + x);
      if (s * c < 0) cc = z / ss;
      else ss = z / cc;
    }
    if (x > TWO_129) return (INV_SQRT_PI * ss) / Math.sqrt(x);
    const u = besselAsymptotic(x, P0_TABLES, 1);
    const v = besselAsymptotic(x, Q0_TABLES, -0.125) / x;
    // u*ss + v*cc fuses v*cc (checked on arm64).
    return (INV_SQRT_PI * fma(v, cc, u * ss)) / Math.sqrt(x);
  }
  if (x <= TWO_M27) return fma(TWO_OVER_PI, log(x), U[0]);
  const z = x * x;
  const u = polynomial(z, U);
  const v = polynomial(z, V);
  return fma(TWO_OVER_PI * j0(x), log(x), u / v);
}

type BesselTables = readonly (readonly [number, readonly number[], readonly number[]])[];

/**
 * pzero, qzero, pone, and qone: `base + r/s`, with r and s polynomials in 1/(x*x) chosen by the first table whose lower
 * bound x reaches. The s coefficients start with the constant 1.
 */
function besselAsymptotic(x: number, tables: BesselTables, base: number): number {
  const [, p, q] = tables.find(([lowerBound]) => x >= lowerBound) as BesselTables[number];
  const z = 1 / (x * x);
  return base + polynomial(z, p) / polynomial(z, q);
}

const P0_TABLES: BesselTables = [
  [
    8,
    [0, -0.07031249999999004, -8.081670412753498, -257.06310567970485, -2485.216410094288, -5253.043804907295],
    [1, 116.53436461966818, 3833.7447536412183, 40_597.857264847255, 116_752.97256437592, 47_627.728414673096],
  ],
  [
    4.5454,
    [
      -1.141254646918945e-11, -0.07031249408735993, -4.159610644705878, -67.67476522651673, -331.23129964917297,
      -346.4333883656049,
    ],
    [1, 60.753938269230034, 1051.2523059570458, 5978.970943338558, 9625.445143577745, 2406.058159229391],
  ],
  [
    2.8571,
    [
      -2.547046017719519e-9, -0.07031196163814817, -2.409032215495296, -21.96597747348831, -58.07917047017376,
      -31.44794705948885,
    ],
    [1, 35.85603380552097, 361.51398305030386, 1193.6078379211153, 1127.9967985690741, 173.58093081333575],
  ],
  [
    2,
    [
      -8.875343330325264e-8, -0.07030309954836247, -1.4507384678095299, -7.635696138235278, -11.193166886035675,
      -3.2336457935133534,
    ],
    [1, 22.22029975320888, 136.2067942182152, 270.4702786580835, 153.87539420832033, 14.65761769482562],
  ],
];

const Q0_TABLES: BesselTables = [
  [
    8,
    [0, 0.0732421874999935, 11.76820646822527, 557.6733802564019, 8859.197207564686, 37_014.62677768878],
    [
      1, 163.77602689568982, 8098.344946564498, 142_538.29141912048, 803_309.2571195144, 840_501.5798190605,
      -343_899.2935378666,
    ],
  ],
  [
    4.5454,
    [
      1.8408596359451553e-11, 0.07324217666126848, 5.8356350896205695, 135.11157728644983, 1027.243765961641,
      1989.9778586460538,
    ],
    [
      1, 82.77661022365378, 2077.81416421393, 18_847.28877857181, 56_751.11228949473, 35_976.75384251145,
      -5354.342756019448,
    ],
  ],
  [
    2.8571,
    [
      4.377410140897386e-9, 0.07324111800429114, 3.344231375161707, 42.621844074541265, 170.8080913405656,
      166.73394869665117,
    ],
    [
      1, 48.75887297245872, 709.689221056606, 3704.1482262011136, 6460.425167525689, 2516.3336892036896,
      -149.2474518361564,
    ],
  ],
  [
    2,
    [
      1.5044444488698327e-7, 0.07322342659630793, 1.99819174093816, 14.495602934788574, 31.666231750478154,
      16.252707571092927,
    ],
    [
      1, 30.36558483552192, 269.34811860804984, 844.7837575953201, 882.9358451124886, 212.66638851179883,
      -5.3109549388266695,
    ],
  ],
];

// j1.go

/** `math.J1` returns the order-one Bessel function of the first kind. */
export function j1(x: number): number {
  const R = [-0.0625, 0.001407056669551897, -0.00001599556310840356, 4.9672799960958445e-8];
  const S = [
    1, 0.019153759953836346, 0.00018594678558863092, 0.0000011771846404262368, 5.0463625707621704e-9,
    1.2354227442613791e-11,
  ];
  if (Number.isNaN(x)) return x;
  if (!Number.isFinite(x) || x === 0) return 0;
  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }
  if (x >= 2) {
    const [s, c] = sincos(x);
    let ss = -s - c;
    let cc = s - c;
    if (x < HALF_MAX_FLOAT64) {
      const z = cos(x + x);
      if (s * c > 0) cc = z / ss;
      else ss = z / cc;
    }
    let z: number;
    if (x > TWO_129) {
      z = (INV_SQRT_PI * cc) / Math.sqrt(x);
    } else {
      const u = besselAsymptotic(x, P1_TABLES, 1);
      const v = besselAsymptotic(x, Q1_TABLES, 0.375) / x;
      z = (INV_SQRT_PI * fma(-v, ss, u * cc)) / Math.sqrt(x);
    }
    return sign ? -z : z;
  }
  if (x < TWO_M27) return 0.5 * x; // Go drops the sign here
  const z = x * x;
  const r = z * polynomial(z, R) * x;
  const s = polynomial(z, S);
  const result = fma(0.5, x, r / s);
  return sign ? -result : result;
}

/** `math.Y1` returns the order-one Bessel function of the second kind. */
export function y1(x: number): number {
  const TwoM54 = 2 ** -54;
  const U = [
    -0.19605709064623894, 0.05044387166398113, -0.0019125689587576355, 0.00002352526005616105, -9.190991580398789e-8,
  ];
  const V = [
    1, 0.01991673182366499, 0.00020255258102513517, 0.0000013560880109751623, 6.227414523646215e-9,
    1.6655924620799208e-11,
  ];
  if (x < 0 || Number.isNaN(x)) return Number.NaN;
  if (x === Infinity) return 0;
  if (x === 0) return -Infinity;
  if (x >= 2) {
    const [s, c] = sincos(x);
    let ss = -s - c;
    let cc = s - c;
    if (x < HALF_MAX_FLOAT64) {
      const z = cos(x + x);
      if (s * c > 0) cc = z / ss;
      else ss = z / cc;
    }
    if (x > TWO_129) return (INV_SQRT_PI * ss) / Math.sqrt(x);
    const u = besselAsymptotic(x, P1_TABLES, 1);
    const v = besselAsymptotic(x, Q1_TABLES, 0.375) / x;
    // u*ss + v*cc fuses u*ss (checked on arm64).
    return (INV_SQRT_PI * fma(u, ss, v * cc)) / Math.sqrt(x);
  }
  if (x <= TwoM54) return -TWO_OVER_PI / x;
  const z = x * x;
  const u = polynomial(z, U);
  const v = polynomial(z, V);
  // x*(u/v) + (2/Pi)*(...) fuses x*(u/v) (checked on arm64).
  return fma(x, u / v, TWO_OVER_PI * fma(j1(x), log(x), -1 / x));
}

const P1_TABLES: BesselTables = [
  [
    8,
    [0, 0.11718749999998865, 13.239480659307358, 412.05185430737856, 3874.7453891396053, 7914.479540318917],
    [1, 114.20737037567841, 3650.9308342085346, 36_956.206026903346, 97_602.79359349508, 30_804.27206278888],
  ],
  [
    4.5454,
    [
      1.3199051955624352e-11, 0.1171874931906141, 6.802751278684329, 108.30818299018911, 517.6361395331998,
      528.7152013633375,
    ],
    [1, 59.28059872211313, 991.4014187336144, 5353.26695291488, 7844.690317495512, 1504.0468881036106],
  ],
  [
    2.8571,
    [
      3.025039161373736e-9, 0.11718686556725359, 3.9329775003331564, 35.11940355916369, 91.05501107507813,
      48.55906851973649,
    ],
    [1, 34.79130950012515, 336.76245874782575, 1046.8713997577513, 890.8113463982564, 103.78793243963928],
  ],
  [
    2,
    [
      1.0771083010687374e-7, 0.11717621946268335, 2.368514966676088, 12.242610914826123, 17.693971127168773,
      5.073523125888185,
    ],
    [1, 21.43648593638214, 125.29022716840275, 232.2764690571628, 117.6793732871471, 8.364638933716183],
  ],
];

const Q1_TABLES: BesselTables = [
  [
    8,
    [0, -0.10253906249999271, -16.271753454459, -759.6017225139501, -11_849.806670242959, -48_438.512428575035],
    [
      1, 161.3953697007229, 7825.385999233485, 133_875.33628724958, 719_657.7236832409, 666_601.2326177764,
      -294_490.26430383464,
    ],
  ],
  [
    4.5454,
    [
      -2.089799311417641e-11, -0.10253905024137543, -8.05644828123936, -183.66960747488838, -1373.1937606550816,
      -2612.4444045321566,
    ],
    [
      1, 81.27655013843358, 1991.7987346048596, 17_468.48519249089, 49_851.42709103523, 27_948.075163891812,
      -4719.183547951285,
    ],
  ],
  [
    2.8571,
    [
      -5.078312264617666e-9, -0.10253782982083709, -4.610115811394734, -57.847221656278364, -228.2445407376317,
      -219.21012847890933,
    ],
    [
      1, 47.66515503237295, 673.8651126766997, 3380.1528667952634, 5547.729097207228, 1903.119193388108,
      -135.20119144430734,
    ],
  ],
  [
    2,
    [
      -1.7838172751095887e-7, -0.10251704260798555, -2.7522056827818746, -19.663616264370372, -42.32531333728305,
      -21.371921170370406,
    ],
    [
      1, 29.533362906052385, 252.98154998219053, 757.5028348686454, 739.3932053204672, 155.94900333666612,
      -4.959498988226282,
    ],
  ],
];

// jn.go

const TWO_302 = 2 ** 302;
const MIN_INT64 = -(1n << 63n);

/** Go's `-n` on an int, which leaves MinInt64 unchanged. */
function negateInt(n: bigint): bigint {
  return n === MIN_INT64 ? n : -n;
}

/** `math.Jn` returns the order-n Bessel function of the first kind. */
export function jn(n: bigint, x: number): number {
  const TwoM29 = 2 ** -29;
  if (Number.isNaN(x)) return x;
  if (!Number.isFinite(x)) return 0;
  if (n === 0n) return j0(x);
  if (x === 0) return 0;
  if (n < 0n) {
    n = negateInt(n);
    x = -x;
  }
  if (n === 1n) return j1(x);
  let sign = false;
  if (x < 0) {
    x = -x;
    if ((n & 1n) === 1n) sign = true;
  }
  const order = Number(n);
  let b: number;
  if (order <= x) {
    if (x >= TWO_302) {
      const [s, c] = sincos(x);
      const temp = [c + s, -c + s, -c - s, c - s][Number(n & 3n)];
      b = (INV_SQRT_PI * temp) / Math.sqrt(x);
    } else {
      b = j1(x);
      let a = j0(x);
      for (let i = 1; i < order; i++) [a, b] = [b, fma(b, (i + i) / x, -a)];
    }
  } else if (x < TwoM29) {
    if (order > 33) {
      b = 0;
    } else {
      const temp = x * 0.5;
      b = temp;
      let a = 1;
      for (let i = 2; i <= order; i++) {
        a *= i;
        b *= temp;
      }
      b /= a;
    }
  } else {
    const w = (order + order) / x;
    const h = 2 / x;
    let q0 = w;
    let z = w + h;
    let q1 = fma(w, z, -1);
    let k = 1;
    while (q1 < 1e9) {
      k++;
      z += h;
      [q0, q1] = [q1, fma(z, q1, -q0)];
    }
    const m = order + order;
    let t = 0;
    for (let i = 2 * (order + k); i >= m; i -= 2) t = 1 / (i / x - t);
    let a = t;
    b = 1;
    const v = 2 / x;
    const tmp = order * log(Math.abs(v * order));
    const rescale = tmp >= 709.782712893384;
    for (let i = order - 1; i > 0; i--) {
      const di = i + i;
      [a, b] = [b, (b * di) / x - a];
      if (rescale && b > 1e100) {
        a /= b;
        t /= b;
        b = 1;
      }
    }
    b = (t * j0(x)) / b;
  }
  return sign ? -b : b;
}

/** `math.Yn` returns the order-n Bessel function of the second kind. */
export function yn(n: bigint, x: number): number {
  if (x < 0 || Number.isNaN(x)) return Number.NaN;
  if (x === Infinity) return 0;
  if (n === 0n) return y0(x);
  if (x === 0) return n < 0n && (n & 1n) === 1n ? Infinity : -Infinity;
  let sign = false;
  if (n < 0n) {
    n = negateInt(n);
    if ((n & 1n) === 1n) sign = true;
  }
  if (n === 1n) return sign ? -y1(x) : y1(x);
  let b: number;
  if (x >= TWO_302) {
    const [s, c] = sincos(x);
    const temp = [s - c, -s - c, -s + c, s + c][Number(n & 3n)];
    b = (INV_SQRT_PI * temp) / Math.sqrt(x);
  } else {
    let a = y0(x);
    b = y1(x);
    for (let i = 1; i < n && b !== -Infinity; i++) [a, b] = [b, fma((i + i) / x, b, -a)];
  }
  return sign ? -b : b;
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

/** `c[0] + z*(c[1] + z*(c[2] + ...))`, every step a fused multiply-add. */
function polynomial(z: number, coefficients: readonly number[]): number {
  let p = coefficients.at(-1) as number;
  for (let i = coefficients.length - 2; i >= 0; i--) p = fma(z, p, coefficients[i]);
  return p;
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
