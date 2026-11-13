import type { Entity } from '../entities';
import { fma } from '../fma';
import { definePackage, fn, nativeFunction } from '../native';
import { BASIC, type Type } from '../types';
import { Complex, type Value } from '../values';
import * as goMath from './goMath';
import { BOOL, FLOAT64, INT } from './support';

type Unary = (x: number) => number;

function constant(name: string, text: string, type: Type = BASIC.untypedFloat): Entity {
  const [whole, fraction = ''] = text.split('.');
  const num = BigInt(whole + fraction);
  const den = 10n ** BigInt(fraction.length);
  return {
    kind: 'const',
    name,
    type,
    value: { kind: 'float', value: { num, den } },
    span: { row: 0, column: 0 },
    used: true,
  };
}

function intConstant(name: string, value: bigint): Entity {
  return {
    kind: 'const',
    name,
    type: BASIC.untypedInt,
    value: { kind: 'int', value },
    span: { row: 0, column: 0 },
    used: true,
  };
}

/** A float constant written as an exact fraction, for the limits of float types. */
function exactFloat(name: string, num: bigint, den: bigint): Entity {
  return {
    kind: 'const',
    name,
    type: BASIC.untypedFloat,
    value: { kind: 'float', value: { num, den } },
    span: { row: 0, column: 0 },
    used: true,
  };
}

function unary(name: string, impl: Unary): Entity {
  return nativeFunction(name, fn([FLOAT64], [FLOAT64]), ([x]) => impl(x as number));
}

function binary(name: string, impl: (x: number, y: number) => number): Entity {
  return nativeFunction(name, fn([FLOAT64, FLOAT64], [FLOAT64]), ([x, y]) => impl(x as number, y as number));
}

/** `math.Mod`, whose result has the sign of x. */
function mod(x: number, y: number): number {
  if (y === 0 || !Number.isFinite(x) || Number.isNaN(y)) return Number.NaN;
  return x % y;
}

/** `math.Remainder` (IEEE 754), transcribed from Go's `math/remainder.go`. */
function remainder(x: number, y: number): number {
  const tiny = 4.450147717014403e-308;
  const halfMax = Number.MAX_VALUE / 2;
  if (Number.isNaN(x) || Number.isNaN(y) || !Number.isFinite(x) || y === 0) return Number.NaN;
  if (!Number.isFinite(y)) return x;
  let sign = false;
  let ax = x;
  let ay = y;
  if (ax < 0) {
    ax = -ax;
    sign = true;
  }
  if (ay < 0) ay = -ay;
  if (ax === ay) return sign ? -0 : 0;
  if (ay <= halfMax) ax %= ay + ay;
  if (ay < tiny) {
    if (ax + ax > ay) {
      ax -= ay;
      if (ax + ax >= ay) ax -= ay;
    }
  } else {
    const yHalf = 0.5 * ay;
    if (ax > yHalf) {
      ax -= ay;
      if (ax >= yHalf) ax -= ay;
    }
  }
  return sign ? -ax : ax;
}

/** `math.Round`: halves away from zero. */
function round(x: number): number {
  if (!Number.isFinite(x)) return x;
  const rounded = Math.sign(x) * Math.round(Math.abs(x));
  return rounded === 0 ? (Object.is(x, -0) || x < 0 ? -0 : 0) : rounded;
}

/** `math.RoundToEven`. */
function roundToEven(x: number): number {
  if (!Number.isFinite(x)) return x;
  const floor = Math.floor(x);
  const difference = x - floor;
  let result = floor;
  if (difference > 0.5 || (difference === 0.5 && floor % 2 !== 0)) result = floor + 1;
  return result === 0 && (x < 0 || Object.is(x, -0)) ? -0 : result;
}

function trunc(x: number): number {
  return Math.trunc(x);
}

/** `math.Max`, where NaN wins over everything but +Inf, and +0 is larger than -0. */
function max(x: number, y: number): number {
  if (x === Infinity || y === Infinity) return Infinity;
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (x === 0 && y === 0) return Object.is(x, -0) ? y : x;
  return x > y ? x : y;
}

function min(x: number, y: number): number {
  if (x === -Infinity || y === -Infinity) return -Infinity;
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (x === 0 && y === 0) return Object.is(x, -0) ? x : y;
  return x < y ? x : y;
}

function signbit(x: number): boolean {
  return x < 0 || Object.is(x, -0);
}

function copysign(magnitude: number, sign: number): number {
  return signbit(magnitude) === signbit(sign) ? magnitude : -magnitude;
}

function float64bits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}

function float64frombits(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt.asUintN(64, bits));
  return view.getFloat64(0);
}

function float32bits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return BigInt(view.getUint32(0));
}

function float32frombits(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, Number(BigInt.asUintN(32, bits)));
  return view.getFloat32(0);
}

/** `math.Hypot`, transcribed from Go's hypot.go with the fused `1+q*q` that its arm64 build computes. */
export function hypot(x: number, y: number): number {
  let p = Math.abs(x);
  let q = Math.abs(y);
  if (p === Infinity || q === Infinity) return Infinity;
  if (Number.isNaN(p) || Number.isNaN(q)) return Number.NaN;
  if (p < q) [p, q] = [q, p];
  if (p === 0) return 0;
  q /= p;
  return p * Math.sqrt(fma(q, q, 1));
}

/** `math.Nextafter32`: the next float32 after x towards y. */
function nextafter32(x: number, y: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (x === y) return x;
  if (x === 0) return copysign(float32frombits(1n), y);
  const bits = float32bits(x);
  return float32frombits(y > x === x > 0 ? bits + 1n : bits - 1n);
}

const MAX_UINT64 = (1n << 64n) - 1n;

const members: Record<string, Entity> = {
  Pi: constant('Pi', '3.14159265358979323846264338327950288419716939937510582097494459'),
  E: constant('E', '2.71828182845904523536028747135266249775724709369995957496696763'),
  Phi: constant('Phi', '1.61803398874989484820458683436563811772030917980576286213544862'),
  Sqrt2: constant('Sqrt2', '1.41421356237309504880168872420969807856967187537694807317667974'),
  SqrtE: constant('SqrtE', '1.64872127070012814684865078831848098737480349221048208617800616'),
  SqrtPi: constant('SqrtPi', '1.77245385090551602729816748334114518279754945612238712821380779'),
  SqrtPhi: constant('SqrtPhi', '1.27201964951406896425242246173749149171560804184009624861664038'),
  Ln2: constant('Ln2', '0.693147180559945309417232121458176568075500134360255254120680009'),
  Log2E: exactLog('Log2E', 'Ln2'),
  Ln10: constant('Ln10', '2.30258509299404568401799145468436420760110148862877297603332790'),
  Log10E: exactLog('Log10E', 'Ln10'),
  MaxInt: intConstant('MaxInt', (1n << 63n) - 1n),
  MinInt: intConstant('MinInt', -(1n << 63n)),
  MaxInt8: intConstant('MaxInt8', 127n),
  MinInt8: intConstant('MinInt8', -128n),
  MaxInt16: intConstant('MaxInt16', 32_767n),
  MinInt16: intConstant('MinInt16', -32_768n),
  MaxInt32: intConstant('MaxInt32', 2_147_483_647n),
  MinInt32: intConstant('MinInt32', -2_147_483_648n),
  MaxInt64: intConstant('MaxInt64', (1n << 63n) - 1n),
  MinInt64: intConstant('MinInt64', -(1n << 63n)),
  MaxUint: intConstant('MaxUint', MAX_UINT64),
  MaxUint8: intConstant('MaxUint8', 255n),
  MaxUint16: intConstant('MaxUint16', 65_535n),
  MaxUint32: intConstant('MaxUint32', 4_294_967_295n),
  MaxUint64: intConstant('MaxUint64', MAX_UINT64),
  // 0x1p127 * (1 + (1 - 0x1p-23)) and its relatives, as math/const.go defines them.
  MaxFloat32: exactFloat('MaxFloat32', (1n << 127n) * ((1n << 24n) - 1n), 1n << 23n),
  SmallestNonzeroFloat32: exactFloat('SmallestNonzeroFloat32', 1n, 1n << 149n),
  MaxFloat64: exactFloat('MaxFloat64', (1n << 1023n) * ((1n << 53n) - 1n), 1n << 52n),
  SmallestNonzeroFloat64: exactFloat('SmallestNonzeroFloat64', 1n, 1n << 1074n),
  Abs: unary('Abs', Math.abs),
  Sqrt: unary('Sqrt', Math.sqrt),
  Cbrt: unary('Cbrt', goMath.cbrt),
  Floor: unary('Floor', Math.floor),
  Ceil: unary('Ceil', Math.ceil),
  Trunc: unary('Trunc', trunc),
  Round: unary('Round', round),
  RoundToEven: unary('RoundToEven', roundToEven),
  Exp: unary('Exp', goMath.exp),
  Exp2: unary('Exp2', goMath.exp2),
  Expm1: unary('Expm1', goMath.expm1),
  Log: unary('Log', goMath.log),
  Log2: unary('Log2', goMath.log2),
  Log10: unary('Log10', goMath.log10),
  Log1p: unary('Log1p', goMath.log1p),
  Sin: unary('Sin', goMath.sin),
  Cos: unary('Cos', goMath.cos),
  Sincos: nativeFunction('Sincos', fn([FLOAT64], [FLOAT64, FLOAT64]), ([x]) => goMath.sincos(x as number)),
  Tan: unary('Tan', goMath.tan),
  Asin: unary('Asin', goMath.asin),
  Acos: unary('Acos', goMath.acos),
  Atan: unary('Atan', goMath.atan),
  Sinh: unary('Sinh', goMath.sinh),
  Cosh: unary('Cosh', goMath.cosh),
  Tanh: unary('Tanh', goMath.tanh),
  Asinh: unary('Asinh', goMath.asinh),
  Acosh: unary('Acosh', goMath.acosh),
  Atanh: unary('Atanh', goMath.atanh),
  Atan2: binary('Atan2', goMath.atan2),
  Hypot: binary('Hypot', hypot),
  Pow: binary('Pow', goMath.pow),
  Pow10: nativeFunction('Pow10', fn([INT], [FLOAT64]), ([n]) => goMath.pow10(n as bigint)),
  Gamma: unary('Gamma', goMath.gamma),
  Lgamma: nativeFunction('Lgamma', fn([FLOAT64], [FLOAT64, INT]), ([x]) => {
    const [lgamma, sign] = goMath.lgamma(x as number);
    return [lgamma, BigInt(sign)];
  }),
  Erf: unary('Erf', goMath.erf),
  Erfc: unary('Erfc', goMath.erfc),
  Erfinv: unary('Erfinv', goMath.erfinv),
  Erfcinv: unary('Erfcinv', goMath.erfcinv),
  J0: unary('J0', goMath.j0),
  J1: unary('J1', goMath.j1),
  Jn: nativeFunction('Jn', fn([INT, FLOAT64], [FLOAT64]), ([n, x]) => goMath.jn(n as bigint, x as number)),
  Y0: unary('Y0', goMath.y0),
  Y1: unary('Y1', goMath.y1),
  Yn: nativeFunction('Yn', fn([INT, FLOAT64], [FLOAT64]), ([n, x]) => goMath.yn(n as bigint, x as number)),
  Mod: binary('Mod', mod),
  Remainder: binary('Remainder', remainder),
  Max: binary('Max', max),
  Min: binary('Min', min),
  Dim: binary('Dim', (x, y) => (Number.isNaN(x) || Number.isNaN(y) ? Number.NaN : Math.max(x - y, 0))),
  Copysign: binary('Copysign', copysign),
  FMA: nativeFunction('FMA', fn([FLOAT64, FLOAT64, FLOAT64], [FLOAT64]), ([x, y, z]) =>
    fma(x as number, y as number, z as number)
  ),
  Inf: nativeFunction('Inf', fn([INT], [FLOAT64]), ([sign]) => ((sign as bigint) >= 0n ? Infinity : -Infinity)),
  NaN: nativeFunction('NaN', fn([], [FLOAT64]), () => Number.NaN),
  IsNaN: nativeFunction('IsNaN', fn([FLOAT64], [BOOL]), ([x]) => Number.isNaN(x)),
  IsInf: nativeFunction('IsInf', fn([FLOAT64, INT], [BOOL]), ([x, sign]) => {
    const s = sign as bigint;
    return (s >= 0n && x === Infinity) || (s <= 0n && x === -Infinity);
  }),
  Signbit: nativeFunction('Signbit', fn([FLOAT64], [BOOL]), ([x]) => signbit(x as number)),
  Modf: nativeFunction('Modf', fn([FLOAT64], [FLOAT64, FLOAT64]), ([x]) => goMath.modf(x as number)),
  Frexp: nativeFunction('Frexp', fn([FLOAT64], [FLOAT64, INT]), ([x]) => {
    const [fraction, exponent] = goMath.frexp(x as number);
    return [fraction, BigInt(exponent)];
  }),
  Ilogb: nativeFunction('Ilogb', fn([FLOAT64], [INT]), ([x]) => BigInt(goMath.ilogb(x as number))),
  Logb: unary('Logb', goMath.logb),
  Ldexp: nativeFunction('Ldexp', fn([FLOAT64, INT], [FLOAT64]), ([x, exponent]) =>
    goMath.ldexp(x as number, Number(exponent as bigint))
  ),
  Float64bits: nativeFunction('Float64bits', fn([FLOAT64], [BASIC.uint64]), ([x]) => float64bits(x as number)),
  Float64frombits: nativeFunction('Float64frombits', fn([BASIC.uint64], [FLOAT64]), ([bits]) =>
    float64frombits(bits as bigint)
  ),
  Float32bits: nativeFunction('Float32bits', fn([BASIC.float32], [BASIC.uint32]), ([x]) => float32bits(x as number)),
  Float32frombits: nativeFunction('Float32frombits', fn([BASIC.uint32], [BASIC.float32]), ([bits]) =>
    float32frombits(bits as bigint)
  ),
  Nextafter32: nativeFunction('Nextafter32', fn([BASIC.float32, BASIC.float32], [BASIC.float32]), ([x, y]) =>
    nextafter32(x as number, y as number)
  ),
  Nextafter: binary('Nextafter', (x, y) => {
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
    if (x === y) return x;
    if (x === 0) return copysign(float64frombits(1n), y);
    const bits = float64bits(x);
    return float64frombits(y > x === x > 0 ? bits + 1n : bits - 1n);
  }),
};

/** 1/Ln2 and 1/Ln10, which math/const.go defines by division of the exact constants. */
function exactLog(name: string, of: string): Entity {
  const denominator =
    of === 'Ln2'
      ? '0.693147180559945309417232121458176568075500134360255254120680009'
      : '2.30258509299404568401799145468436420760110148862877297603332790';
  const [whole, fraction] = denominator.split('.');
  return exactFloat(name, 10n ** BigInt(fraction.length), BigInt(whole + fraction));
}

export const MATH_PACKAGE = definePackage('math', members);

export { Complex };
export type { Value };
