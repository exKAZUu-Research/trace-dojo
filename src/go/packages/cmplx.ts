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
};

export const CMPLX_PACKAGE = definePackage('math/cmplx', members, [
  'Exp',
  'Log',
  'Log10',
  'Pow',
  'Polar',
  'Rect',
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
  'IsInf',
  'NaN',
]);
