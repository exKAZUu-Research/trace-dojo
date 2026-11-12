import type { Entity } from '../entities';
import { fma } from '../fma';
import { definePackage, fn, nativeFunction } from '../native';
import { BASIC } from '../types';
import { Complex } from '../values';
import * as goMath from './goMath';
import { hypot } from './math';
import { BOOL, FLOAT64 } from './support';

const C = BASIC.complex128;

/** `cmplx.Sqrt`, transcribed from Go's math/cmplx/sqrt.go. */
function sqrt(value: Complex): Complex {
  const { re, im } = value;
  if (im === 0) {
    if (re === 0) return new Complex(0, im);
    if (re < 0) return new Complex(0, Math.sign(im) < 0 || Object.is(im, -0) ? -Math.sqrt(-re) : Math.sqrt(-re));
    return new Complex(Math.sqrt(re), im);
  }
  if (!Number.isFinite(im)) return new Complex(Infinity, im);
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
  // Go's compiler fuses 0.5*r + 0.5*a into one rounding on arm64.
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

// Transcribed from Go's math/cmplx, with the fused multiply-adds of arm64 ------------------------------------------

const phase = (value: Complex): number => goMath.atan2(value.im, value.re);

function exp(value: Complex): Complex {
  const { re, im } = value;
  if (re === Infinity || re === -Infinity) {
    if (re > 0 && im === 0) return value;
    if (!Number.isFinite(im))
      return re < 0
        ? new Complex(0, Object.is(Math.sign(im), -0) || im < 0 ? -0 : 0)
        : new Complex(Infinity, Number.NaN);
  } else if (Number.isNaN(re) && im === 0) {
    return new Complex(Number.NaN, im);
  }
  const r = goMath.exp(re);
  return new Complex(r * goMath.cos(im), r * goMath.sin(im));
}

const log = (value: Complex): Complex => new Complex(goMath.log(abs(value)), phase(value));

/** math.Log10E, which Go computes exactly before rounding it. */
const LOG10E = 0.43429448190325182765112891891660508229439700580366656611445378;

function log10(value: Complex): Complex {
  const z = log(value);
  return new Complex(LOG10E * z.re, LOG10E * z.im);
}

const isNaNComplex = (value: Complex): boolean => {
  if (!Number.isFinite(value.re) && !Number.isNaN(value.re)) return false;
  if (!Number.isFinite(value.im) && !Number.isNaN(value.im)) return false;
  return Number.isNaN(value.re) || Number.isNaN(value.im);
};

function pow(x: Complex, y: Complex): Complex {
  if (x.re === 0 && x.im === 0) {
    if (isNaNComplex(y)) return new Complex(Number.NaN, Number.NaN);
    if (y.re === 0) return new Complex(1, 0);
    if (y.re < 0) return y.im === 0 ? new Complex(Infinity, 0) : new Complex(Infinity, Infinity);
    if (y.re > 0) return new Complex(0, 0);
  }
  const modulus = abs(x);
  if (modulus === 0) return new Complex(0, 0);
  let r = goMath.pow(modulus, y.re);
  const arg = phase(x);
  let theta = y.re * arg;
  if (y.im !== 0) {
    r *= goMath.exp(-y.im * arg);
    // theta += imag(y) * math.Log(modulus), which Go's compiler fuses on arm64.
    theta = fma(y.im, goMath.log(modulus), theta);
  }
  return new Complex(r * goMath.cos(theta), r * goMath.sin(theta));
}

function rect(r: number, theta: number): Complex {
  return new Complex(r * goMath.cos(theta), r * goMath.sin(theta));
}

const members: Record<string, Entity> = {
  Sqrt: nativeFunction('Sqrt', fn([C], [C]), ([value]) => sqrt(value as Complex)),
  Abs: nativeFunction('Abs', fn([C], [FLOAT64]), ([value]) => abs(value as Complex)),
  Phase: nativeFunction('Phase', fn([C], [FLOAT64]), ([value]) =>
    goMath.atan2((value as Complex).im, (value as Complex).re)
  ),
  Conj: nativeFunction('Conj', fn([C], [C]), ([value]) => new Complex((value as Complex).re, -(value as Complex).im)),
  IsNaN: nativeFunction('IsNaN', fn([C], [BOOL]), ([value]) => {
    const { re, im } = value as Complex;
    if (!Number.isFinite(re) && !Number.isNaN(re)) return false;
    if (!Number.isFinite(im) && !Number.isNaN(im)) return false;
    return Number.isNaN(re) || Number.isNaN(im);
  }),
  Inf: nativeFunction('Inf', fn([], [C]), () => new Complex(Infinity, Infinity)),
  NaN: nativeFunction('NaN', fn([], [C]), () => new Complex(Number.NaN, Number.NaN)),
  IsInf: nativeFunction('IsInf', fn([C], [BOOL]), ([value]) => {
    const { re, im } = value as Complex;
    return re === Infinity || re === -Infinity || im === Infinity || im === -Infinity;
  }),
  Exp: nativeFunction('Exp', fn([C], [C]), ([value]) => exp(value as Complex)),
  Log: nativeFunction('Log', fn([C], [C]), ([value]) => log(value as Complex)),
  Log10: nativeFunction('Log10', fn([C], [C]), ([value]) => log10(value as Complex)),
  Pow: nativeFunction('Pow', fn([C, C], [C]), ([x, y]) => pow(x as Complex, y as Complex)),
  Polar: nativeFunction('Polar', fn([C], [FLOAT64, FLOAT64]), ([value]) => [
    abs(value as Complex),
    phase(value as Complex),
  ]),
  Rect: nativeFunction('Rect', fn([FLOAT64, FLOAT64], [C]), ([r, theta]) => rect(r as number, theta as number)),
};

export const CMPLX_PACKAGE = definePackage('math/cmplx', members, [
  'Sin',
  'Cos',
  'Tan',
  'Asin',
  'Acos',
  'Atan',
  'Sinh',
  'Cosh',
  'Tanh',
  'Asinh',
  'Acosh',
  'Atanh',
  'Cot',
]);
