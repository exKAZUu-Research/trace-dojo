import { always, type Entity, type FuncEntity } from '../entities';
import { fma } from '../fma';
import { definePackage, fn, nativeFunction } from '../native';
import { BASIC } from '../types';
import { Complex } from '../values';
import * as goMath from './goMath';
import { hypot } from './math';
import { BOOL, FLOAT64 } from './support';

// Transcribed from Go's math/cmplx. Where Go's arm64 compiler fuses a product into an addition or subtraction (checked
// with `go tool objdump`), the transcription uses fma so that results match bit for bit.

const C = BASIC.complex128;

const isInf = (x: number): boolean => x === Infinity || x === -Infinity;
const signbit = (x: number): boolean => x < 0 || Object.is(x, -0);
const copysign = (magnitude: number, sign: number): number =>
  signbit(magnitude) === signbit(sign) ? magnitude : -magnitude;
const cx = (re: number, im: number): Complex => new Complex(re, im);
const NAN = cx(Number.NaN, Number.NaN);
const INF = cx(Infinity, Infinity);

/** `cmplx.Sqrt`, transcribed from Go's math/cmplx/sqrt.go. */
function sqrt(value: Complex): Complex {
  const { re, im } = value;
  if (im === 0) {
    if (re === 0) return new Complex(0, im);
    if (re < 0) return new Complex(0, Math.sign(im) < 0 || Object.is(im, -0) ? -Math.sqrt(-re) : Math.sqrt(-re));
    return new Complex(Math.sqrt(re), im);
  }
  if (im === Infinity || im === -Infinity) return new Complex(Infinity, im);
  if (re === 0) {
    if (im < 0) {
      const r = Math.sqrt(-0.5 * im);
      return new Complex(r, -r);
    }
    const r = Math.sqrt(0.5 * im);
    return new Complex(r, r);
  }
  let a = re;
  let b = im;
  let scale: number;
  if (Math.abs(a) > 4 || Math.abs(b) > 4) {
    a *= 0.25;
    b *= 0.25;
    scale = 2;
  } else {
    a *= 2 ** 54;
    b *= 2 ** 54;
    scale = 2 ** -27;
  }
  let r = hypot(a, b);
  let t: number;
  if (a > 0) {
    t = Math.sqrt(fma(0.5, a, 0.5 * r));
    r = scale * Math.abs((0.5 * b) / t);
    t *= scale;
  } else {
    r = Math.sqrt(fma(-0.5, a, 0.5 * r));
    t = scale * Math.abs((0.5 * b) / r);
    r *= scale;
  }
  if (b < 0) return new Complex(t, -r);
  return new Complex(t, r);
}

function abs(value: Complex): number {
  return hypot(value.re, value.im);
}

function phase(x: Complex): number {
  return goMath.atan2(x.im, x.re);
}

function isNaN(x: Complex): boolean {
  if (isInf(x.re) || isInf(x.im)) return false;
  return Number.isNaN(x.re) || Number.isNaN(x.im);
}

function log(x: Complex): Complex {
  return cx(goMath.log(abs(x)), phase(x));
}

/** `x * x`, with the second product of each part fused into its sum. */
function square(x: Complex): Complex {
  return cx(fma(-x.im, x.im, x.re * x.re), fma(x.re, x.im, x.re * x.im));
}

function exp(x: Complex): Complex {
  const { re, im } = x;
  if (isInf(re)) {
    if (re > 0 && im === 0) return x;
    if (isInf(im) || Number.isNaN(im)) return re < 0 ? cx(0, copysign(0, im)) : cx(Infinity, Number.NaN);
  } else if (Number.isNaN(re) && im === 0) {
    return cx(Number.NaN, im);
  }
  const r = goMath.exp(re);
  const [s, c] = goMath.sincos(im);
  return cx(r * c, r * s);
}

function pow(x: Complex, y: Complex): Complex {
  if (x.re === 0 && x.im === 0) {
    if (isNaN(y)) return NAN;
    if (y.re === 0) return cx(1, 0);
    if (y.re < 0) return y.im === 0 ? cx(Infinity, 0) : INF;
    if (y.re > 0) return cx(0, 0);
    throw new Error('not reached');
  }
  const modulus = abs(x);
  if (modulus === 0) return cx(0, 0);
  let r = goMath.pow(modulus, y.re);
  const arg = phase(x);
  let theta = y.re * arg;
  if (y.im !== 0) {
    r *= goMath.exp(-(y.im * arg));
    theta = fma(y.im, goMath.log(modulus), theta);
  }
  const [s, c] = goMath.sincos(theta);
  return cx(r * c, r * s);
}

function asin(x: Complex): Complex {
  const { re, im } = x;
  if (im === 0 && Math.abs(re) <= 1) return cx(goMath.asin(re), im);
  if (re === 0 && Math.abs(im) <= 1) return cx(re, goMath.asinh(im));
  if (Number.isNaN(im)) {
    if (re === 0) return cx(re, Number.NaN);
    if (isInf(re)) return cx(Number.NaN, re);
    return NAN;
  }
  if (isInf(im)) {
    if (Number.isNaN(re)) return x;
    if (isInf(re)) return cx(copysign(Math.PI / 4, re), im);
    return cx(copysign(0, re), im);
  }
  if (isInf(re)) return cx(copysign(Math.PI / 2, re), copysign(re, im));
  const xx = square(x);
  const root = sqrt(cx(1 - xx.re, -xx.im));
  const w = log(cx(-im + root.re, re + root.im));
  return cx(w.im, -w.re);
}

function asinh(x: Complex): Complex {
  const { re, im } = x;
  if (im === 0 && Math.abs(re) <= 1) return cx(goMath.asinh(re), im);
  if (re === 0 && Math.abs(im) <= 1) return cx(re, goMath.asin(im));
  if (isInf(re)) {
    if (isInf(im)) return cx(re, copysign(Math.PI / 4, im));
    if (Number.isNaN(im)) return x;
    return cx(re, copysign(0, im));
  }
  if (Number.isNaN(re)) {
    if (im === 0) return x;
    if (isInf(im)) return cx(im, re);
    return NAN;
  }
  if (isInf(im)) return cx(copysign(im, re), copysign(Math.PI / 2, im));
  const xx = square(x);
  const root = sqrt(cx(1 + xx.re, xx.im));
  return log(cx(re + root.re, im + root.im));
}

function acos(x: Complex): Complex {
  const w = asin(x);
  return cx(Math.PI / 2 - w.re, -w.im);
}

function acosh(x: Complex): Complex {
  if (x.re === 0 && x.im === 0) return cx(0, copysign(Math.PI / 2, x.im));
  const w = acos(x);
  return w.im <= 0 ? cx(-w.im, w.re) : cx(w.im, -w.re);
}

function atan(x: Complex): Complex {
  const { re, im } = x;
  if (im === 0) return cx(goMath.atan(re), im);
  if (re === 0 && Math.abs(im) <= 1) return cx(re, goMath.atanh(im));
  if (isInf(im) || isInf(re)) {
    if (Number.isNaN(re)) return cx(Number.NaN, copysign(0, im));
    return cx(copysign(Math.PI / 2, re), copysign(0, im));
  }
  if (Number.isNaN(re) || Number.isNaN(im)) return NAN;
  // Go never rounds x2 = re*re on its own: each use fuses the product.
  const a = fma(-im, im, fma(-re, re, 1));
  if (a === 0) return NAN;
  const w = reducePi(0.5 * goMath.atan2(2 * re, a));
  let t = im - 1;
  const b = fma(re, re, t * t);
  if (b === 0) return NAN;
  t = im + 1;
  const c = fma(re, re, t * t) / b;
  return cx(w, 0.25 * goMath.log(c));
}

function atanh(x: Complex): Complex {
  const z = atan(cx(-x.im, x.re));
  return cx(z.im, -z.re);
}

function sin(x: Complex): Complex {
  const { re, im } = x;
  if (im === 0 && (isInf(re) || Number.isNaN(re))) return cx(Number.NaN, im);
  if (isInf(im)) {
    if (re === 0) return x;
    if (isInf(re) || Number.isNaN(re)) return cx(Number.NaN, im);
  } else if (re === 0 && Number.isNaN(im)) return x;
  const [s, c] = goMath.sincos(re);
  const [sh, ch] = sinhcosh(im);
  return cx(s * ch, c * sh);
}

function sinh(x: Complex): Complex {
  const { re, im } = x;
  if (re === 0 && (isInf(im) || Number.isNaN(im))) return cx(re, Number.NaN);
  if (isInf(re)) {
    if (im === 0) return x;
    if (isInf(im) || Number.isNaN(im)) return cx(re, Number.NaN);
  } else if (im === 0 && Number.isNaN(re)) return cx(Number.NaN, im);
  const [s, c] = goMath.sincos(im);
  const [sh, ch] = sinhcosh(re);
  return cx(c * sh, s * ch);
}

function cos(x: Complex): Complex {
  const { re, im } = x;
  if (im === 0 && (isInf(re) || Number.isNaN(re))) return cx(Number.NaN, -im * copysign(0, re));
  if (isInf(im)) {
    if (re === 0) return cx(Infinity, -re * copysign(0, im));
    if (isInf(re) || Number.isNaN(re)) return cx(Infinity, Number.NaN);
  } else if (re === 0 && Number.isNaN(im)) return cx(Number.NaN, 0);
  const [s, c] = goMath.sincos(re);
  const [sh, ch] = sinhcosh(im);
  return cx(c * ch, -s * sh);
}

function cosh(x: Complex): Complex {
  const { re, im } = x;
  if (re === 0 && (isInf(im) || Number.isNaN(im))) return cx(Number.NaN, re * copysign(0, im));
  if (isInf(re)) {
    if (im === 0) return cx(Infinity, im * copysign(0, re));
    if (isInf(im) || Number.isNaN(im)) return cx(Infinity, Number.NaN);
  } else if (im === 0 && Number.isNaN(re)) return cx(Number.NaN, im);
  const [s, c] = goMath.sincos(im);
  const [sh, ch] = sinhcosh(re);
  return cx(c * ch, s * sh);
}

/** `sinhcosh`, where Go fuses `e *= 0.5` into both results. */
function sinhcosh(x: number): [number, number] {
  if (Math.abs(x) <= 0.5) return [goMath.sinh(x), goMath.cosh(x)];
  const e = goMath.exp(x);
  const ei = 0.5 / e;
  return [fma(e, 0.5, -ei), fma(e, 0.5, ei)];
}

function tan(x: Complex): Complex {
  const { re, im } = x;
  if (isInf(im)) {
    if (isInf(re) || Number.isNaN(re)) return cx(copysign(0, re), copysign(1, im));
    return cx(copysign(0, goMath.sin(2 * re)), copysign(1, im));
  }
  if (re === 0 && Number.isNaN(im)) return x;
  let d = goMath.cos(2 * re) + goMath.cosh(2 * im);
  if (Math.abs(d) < 0.25) d = tanSeries(x);
  if (d === 0) return INF;
  return cx(goMath.sin(2 * re) / d, goMath.sinh(2 * im) / d);
}

function tanh(x: Complex): Complex {
  const { re, im } = x;
  if (isInf(re)) {
    if (isInf(im) || Number.isNaN(im)) return cx(copysign(1, re), copysign(0, im));
    return cx(copysign(1, re), copysign(0, goMath.sin(2 * im)));
  }
  if (im === 0 && Number.isNaN(re)) return x;
  const d = goMath.cosh(2 * re) + goMath.cos(2 * im);
  if (d === 0) return INF;
  return cx(goMath.sinh(2 * re) / d, goMath.sin(2 * im) / d);
}

function cot(x: Complex): Complex {
  let d = goMath.cosh(2 * x.im) - goMath.cos(2 * x.re);
  if (Math.abs(d) < 0.25) d = tanSeries(x);
  if (d === 0) return INF;
  return cx(goMath.sin(2 * x.re) / d, -goMath.sinh(2 * x.im) / d);
}

/** The bits of 1/π, for the Payne–Hanek reduction of large arguments. */
const M_PI = [
  0x00_00_00_00_00_00_00_00n,
  0x51_7c_c1_b7_27_22_0a_94n,
  0xfe_13_ab_e8_fa_9a_6e_e0n,
  0x6d_b1_4a_cc_9e_21_c8_20n,
  0xff_28_b1_d5_ef_5d_e2_b0n,
  0xdb_92_37_1d_21_26_e9_70n,
  0x03_24_97_75_04_e8_c9_0en,
  0x7f_0e_f5_8e_58_94_d3_9fn,
  0x74_41_1a_fa_97_5d_a2_42n,
  0x74_ce_38_13_5a_2f_bf_20n,
  0x9c_c8_eb_1c_c1_a9_9c_fan,
  0x4e_42_2f_c5_de_fc_94_1dn,
  0x8f_fc_4b_ff_ef_02_cc_07n,
  0xf7_97_88_c5_ad_05_36_8fn,
  0xb6_9b_3f_67_93_e5_84_dbn,
  0xa7_a3_1f_b3_4f_2f_f5_16n,
  0xba_93_dd_63_f5_f2_f8_bdn,
  0x9e_83_9c_fb_c5_29_49_75n,
  0x35_fd_af_d8_8f_c6_ae_84n,
  0x2b_01_98_23_7e_3d_b5_d5n,
];

const U64 = (1n << 64n) - 1n;
const float64View = new DataView(new ArrayBuffer(8));

/** `reducePi`: x reduced to (-π/2, π/2]. */
function reducePi(x: number): number {
  if (Math.abs(x) < 2 ** 30) {
    const PI1 = 3.141592502593994;
    const PI2 = 1.5099578831723193e-7;
    const PI3 = 1.0780605716316238e-14;
    const t = Math.trunc(x / Math.PI + 0.5);
    return fma(-t, PI3, fma(-t, PI2, fma(-t, PI1, x)));
  }
  float64View.setFloat64(0, x);
  let ix = float64View.getBigUint64(0);
  const exponent = Number((ix >> 52n) & 0x7_ffn) - 1023 - 52;
  ix = (ix & ((1n << 52n) - 1n)) | (1n << 52n);
  const digit = Math.floor((exponent + 64) / 64);
  const shift = BigInt((exponent + 64) % 64);
  const word = (index: number): bigint => ((M_PI[index] << shift) | (M_PI[index + 1] >> (64n - shift))) & U64;
  const z0lo = (word(digit) * ix) & U64;
  const z1 = word(digit + 1) * ix;
  const z2hi = (word(digit + 2) * ix) >> 64n;
  const low = (z1 & U64) + z2hi;
  const lo = low & U64;
  let hi = (z0lo + (z1 >> 64n) + (low >> 64n)) & U64;
  const lz = hi === 0n ? 64n : BigInt(64 - hi.toString(2).length);
  const e = 1023n - (lz + 1n);
  hi = ((hi << (lz + 1n)) | (lo >> (64n - (lz + 1n)))) & U64;
  hi = (hi >> 12n) | (e << 52n);
  float64View.setBigUint64(0, hi & U64);
  let reduced = float64View.getFloat64(0);
  if (reduced > 0.5) reduced--;
  return Math.PI * reduced;
}

// code-gauge-allow functionNcss 35 -- Transcribes Go's tanSeries loop step by step.
/** `tanSeries`: the Taylor series for cosh(2y) - cos(2x), where Go fuses x2*x into each sum. */
function tanSeries(z: Complex): number {
  const MACHEP = 1 / 2 ** 53;
  let x = reducePi(Math.abs(2 * z.re));
  let y = Math.abs(2 * z.im);
  y *= y;
  x *= x;
  let x2 = 1;
  let y2 = 1;
  let f = 1;
  let rn = 0;
  let d = 0;
  for (;;) {
    rn++;
    f *= rn;
    rn++;
    f *= rn;
    let previous = x2;
    x2 *= x;
    y2 *= y;
    let t = fma(previous, x, y2) / f;
    d += t;
    rn++;
    f *= rn;
    rn++;
    f *= rn;
    previous = x2;
    x2 *= x;
    y2 *= y;
    t = fma(-x, previous, y2) / f;
    d += t;
    if (!(Math.abs(t / d) > MACHEP)) break;
  }
  return d;
}

const unary = (name: string, impl: (x: Complex) => Complex): FuncEntity =>
  nativeFunction(name, fn([C], [C]), ([value]) => impl(value as Complex));

const members: Record<string, Entity> = {
  Sqrt: unary('Sqrt', sqrt),
  Abs: nativeFunction('Abs', fn([C], [FLOAT64]), ([value]) => abs(value as Complex)),
  Phase: nativeFunction('Phase', fn([C], [FLOAT64]), ([value]) => phase(value as Complex)),
  Polar: nativeFunction('Polar', fn([C], [FLOAT64, FLOAT64]), ([value]) => [
    abs(value as Complex),
    phase(value as Complex),
  ]),
  Rect: nativeFunction('Rect', fn([FLOAT64, FLOAT64], [C]), ([r, theta]) => {
    const [s, c] = goMath.sincos(theta as number);
    return cx((r as number) * c, (r as number) * s);
  }),
  Conj: { ...unary('Conj', (x) => cx(x.re, -x.im)), inlinedResult: { partNegations: [undefined, always] } },
  IsNaN: nativeFunction('IsNaN', fn([C], [BOOL]), ([value]) => isNaN(value as Complex)),
  IsInf: nativeFunction(
    'IsInf',
    fn([C], [BOOL]),
    ([value]) => isInf((value as Complex).re) || isInf((value as Complex).im)
  ),
  Inf: nativeFunction('Inf', fn([], [C]), () => INF),
  NaN: nativeFunction('NaN', fn([], [C]), () => NAN),
  Exp: unary('Exp', exp),
  Log: unary('Log', log),
  Log10: unary('Log10', (x) => {
    const z = log(x);
    return cx(Math.LOG10E * z.re, Math.LOG10E * z.im);
  }),
  Pow: nativeFunction('Pow', fn([C, C], [C]), ([x, y]) => pow(x as Complex, y as Complex)),
  Sin: unary('Sin', sin),
  Cos: unary('Cos', cos),
  Tan: unary('Tan', tan),
  Cot: unary('Cot', cot),
  Asin: unary('Asin', asin),
  Acos: unary('Acos', acos),
  Atan: unary('Atan', atan),
  Sinh: unary('Sinh', sinh),
  Cosh: unary('Cosh', cosh),
  Tanh: unary('Tanh', tanh),
  Asinh: unary('Asinh', asinh),
  Acosh: unary('Acosh', acosh),
  Atanh: unary('Atanh', atanh),
};

export const CMPLX_PACKAGE = definePackage('math/cmplx', members);
