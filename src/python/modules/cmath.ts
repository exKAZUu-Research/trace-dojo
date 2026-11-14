import { newComplex } from '../complexNumbers';
import { builtin } from '../define';
import { fma } from '../floatArithmetic';
import { registerModule } from '../modules';
import { checkArgs } from '../nativeArgs';
import { bindValue, callValue, lookupSpecial } from '../objects';
import { nativeFunction, newTuple, pyError, typeError, typeName, valueError } from '../types';
import { type Kwargs, PyComplex, type PyValue } from '../values';
import { realArgument } from './math';

// Transcribes Modules/cmathmodule.c of CPython 3.14, including its tables of results for special values.

interface Complex {
  real: number;
  imag: number;
}

/** The floating-point exception a function raises, as cmathmodule.c reports it through errno. */
type Errno = 'EDOM' | 'ERANGE' | undefined;

interface Result extends Complex {
  errno?: Errno;
}

const DBL_MAX = Number.MAX_VALUE;
const DBL_MIN = 2.2250738585072014e-308;
const DBL_MANT_DIG = 53;
const LARGE_DOUBLE = DBL_MAX / 4;
const SQRT_LARGE_DOUBLE = Math.sqrt(LARGE_DOUBLE);
const LOG_LARGE_DOUBLE = Math.log(LARGE_DOUBLE);
const SQRT_DBL_MIN = Math.sqrt(DBL_MIN);
const SCALE_UP = 2 * Math.floor(DBL_MANT_DIG / 2) + 1;
const SCALE_DOWN = -(SCALE_UP + 1) / 2;
const LN2 = 0.6931471805599453;
const LN10 = 2.302585092994046;

const copysign = (x: number, y: number): number => (y < 0 || Object.is(y, -0) ? -Math.abs(x) : Math.abs(x));
const ldexp = (x: number, exponent: number): number => x * 2 ** exponent;

// Special values ---------------------------------------------------------------------------------------------------------

/** The class of a double that indexes the special value tables: -inf, negative, -0, +0, positive, +inf, nan. */
function specialType(value: number): number {
  if (Number.isFinite(value)) {
    if (value !== 0) return value > 0 ? 4 : 1;
    return Object.is(value, -0) ? 2 : 3;
  }
  if (Number.isNaN(value)) return 6;
  return value > 0 ? 5 : 0;
}

const P = Math.PI;
const P14 = 0.25 * Math.PI;
const P12 = 0.5 * Math.PI;
const P34 = 0.75 * Math.PI;
const INF = Number.POSITIVE_INFINITY;
const N = Number.NaN;
// The placeholder of the C tables for entries that finite arguments never read.
const U = Number('-9.5426319407711027e33');

type Table = Complex[][];

/** Builds a 7 × 7 table from pairs of real and imaginary parts, row by row. */
function table(values: number[]): Table {
  const rows: Table = [];
  for (let row = 0; row < 7; row++) {
    const cells: Complex[] = [];
    for (let column = 0; column < 7; column++) {
      const index = (row * 7 + column) * 2;
      cells.push({ real: values[index], imag: values[index + 1] });
    }
    rows.push(cells);
  }
  return rows;
}

// prettier-ignore
const ACOS = table([
  P34,INF, P,INF, P,INF, P,-INF, P,-INF, P34,-INF, N,INF,
  P12,INF, U,U, U,U, U,U, U,U, P12,-INF, N,N,
  P12,INF, U,U, P12,0, P12,-0, U,U, P12,-INF, P12,N,
  P12,INF, U,U, P12,0, P12,-0, U,U, P12,-INF, P12,N,
  P12,INF, U,U, U,U, U,U, U,U, P12,-INF, N,N,
  P14,INF, 0,INF, 0,INF, 0,-INF, 0,-INF, P14,-INF, N,INF,
  N,INF, N,N, N,N, N,N, N,N, N,-INF, N,N,
]);
// prettier-ignore
const ACOSH = table([
  INF,-P34, INF,-P, INF,-P, INF,P, INF,P, INF,P34, INF,N,
  INF,-P12, U,U, U,U, U,U, U,U, INF,P12, N,N,
  INF,-P12, U,U, 0,-P12, 0,P12, U,U, INF,P12, N,P12,
  INF,-P12, U,U, 0,-P12, 0,P12, U,U, INF,P12, N,P12,
  INF,-P12, U,U, U,U, U,U, U,U, INF,P12, N,N,
  INF,-P14, INF,-0, INF,-0, INF,0, INF,0, INF,P14, INF,N,
  INF,N, N,N, N,N, N,N, N,N, INF,N, N,N,
]);
// prettier-ignore
const ASINH = table([
  -INF,-P14, -INF,-0, -INF,-0, -INF,0, -INF,0, -INF,P14, -INF,N,
  -INF,-P12, U,U, U,U, U,U, U,U, -INF,P12, N,N,
  -INF,-P12, U,U, -0,-0, -0,0, U,U, -INF,P12, N,N,
  INF,-P12, U,U, 0,-0, 0,0, U,U, INF,P12, N,N,
  INF,-P12, U,U, U,U, U,U, U,U, INF,P12, N,N,
  INF,-P14, INF,-0, INF,-0, INF,0, INF,0, INF,P14, INF,N,
  INF,N, N,N, N,-0, N,0, N,N, INF,N, N,N,
]);
// prettier-ignore
const ATANH = table([
  -0,-P12, -0,-P12, -0,-P12, -0,P12, -0,P12, -0,P12, -0,N,
  -0,-P12, U,U, U,U, U,U, U,U, -0,P12, N,N,
  -0,-P12, U,U, -0,-0, -0,0, U,U, -0,P12, -0,N,
  0,-P12, U,U, 0,-0, 0,0, U,U, 0,P12, 0,N,
  0,-P12, U,U, U,U, U,U, U,U, 0,P12, N,N,
  0,-P12, 0,-P12, 0,-P12, 0,P12, 0,P12, 0,P12, 0,N,
  0,-P12, N,N, N,N, N,N, N,N, 0,P12, N,N,
]);
// prettier-ignore
const COSH = table([
  INF,N, U,U, INF,0, INF,-0, U,U, INF,N, INF,N,
  N,N, U,U, U,U, U,U, U,U, N,N, N,N,
  N,0, U,U, 1,0, 1,-0, U,U, N,0, N,0,
  N,0, U,U, 1,-0, 1,0, U,U, N,0, N,0,
  N,N, U,U, U,U, U,U, U,U, N,N, N,N,
  INF,N, U,U, INF,-0, INF,0, U,U, INF,N, INF,N,
  N,N, N,N, N,0, N,0, N,N, N,N, N,N,
]);
// prettier-ignore
const EXP = table([
  0,0, U,U, 0,-0, 0,0, U,U, 0,0, 0,0,
  N,N, U,U, U,U, U,U, U,U, N,N, N,N,
  N,N, U,U, 1,-0, 1,0, U,U, N,N, N,N,
  N,N, U,U, 1,-0, 1,0, U,U, N,N, N,N,
  N,N, U,U, U,U, U,U, U,U, N,N, N,N,
  INF,N, U,U, INF,-0, INF,0, U,U, INF,N, INF,N,
  N,N, N,N, N,-0, N,0, N,N, N,N, N,N,
]);
// prettier-ignore
const LOG = table([
  INF,-P34, INF,-P, INF,-P, INF,P, INF,P, INF,P34, INF,N,
  INF,-P12, U,U, U,U, U,U, U,U, INF,P12, N,N,
  INF,-P12, U,U, -INF,-P, -INF,P, U,U, INF,P12, N,N,
  INF,-P12, U,U, -INF,-0, -INF,0, U,U, INF,P12, N,N,
  INF,-P12, U,U, U,U, U,U, U,U, INF,P12, N,N,
  INF,-P14, INF,-0, INF,-0, INF,0, INF,0, INF,P14, INF,N,
  INF,N, N,N, N,N, N,N, N,N, INF,N, N,N,
]);
// prettier-ignore
const SINH = table([
  INF,N, U,U, -INF,-0, -INF,0, U,U, INF,N, INF,N,
  N,N, U,U, U,U, U,U, U,U, N,N, N,N,
  0,N, U,U, -0,-0, -0,0, U,U, 0,N, 0,N,
  0,N, U,U, 0,-0, 0,0, U,U, 0,N, 0,N,
  N,N, U,U, U,U, U,U, U,U, N,N, N,N,
  INF,N, U,U, INF,-0, INF,0, U,U, INF,N, INF,N,
  N,N, N,N, N,-0, N,0, N,N, N,N, N,N,
]);
// prettier-ignore
const SQRT = table([
  INF,-INF, 0,-INF, 0,-INF, 0,INF, 0,INF, INF,INF, N,INF,
  INF,-INF, U,U, U,U, U,U, U,U, INF,INF, N,N,
  INF,-INF, U,U, 0,-0, 0,0, U,U, INF,INF, N,N,
  INF,-INF, U,U, 0,-0, 0,0, U,U, INF,INF, N,N,
  INF,-INF, U,U, U,U, U,U, U,U, INF,INF, N,N,
  INF,-INF, INF,-0, INF,-0, INF,0, INF,0, INF,INF, INF,N,
  INF,-INF, N,N, N,N, N,N, N,N, INF,INF, N,N,
]);
// prettier-ignore
const TANH = table([
  -1,0, U,U, -1,-0, -1,0, U,U, -1,0, -1,0,
  N,N, U,U, U,U, U,U, U,U, N,N, N,N,
  -0,N, U,U, -0,-0, -0,0, U,U, -0,N, -0,N,
  0,N, U,U, 0,-0, 0,0, U,U, 0,N, 0,N,
  N,N, U,U, U,U, U,U, U,U, N,N, N,N,
  1,0, U,U, 1,-0, 1,0, U,U, 1,0, 1,0,
  N,N, N,N, N,-0, N,0, N,N, N,N, N,N,
]);
// prettier-ignore
const RECT = table([
  INF,N, U,U, -INF,0, -INF,-0, U,U, INF,N, INF,N,
  N,N, U,U, U,U, U,U, U,U, N,N, N,N,
  0,0, U,U, -0,0, -0,-0, U,U, 0,0, 0,0,
  0,0, U,U, 0,-0, 0,0, U,U, 0,0, 0,0,
  N,N, U,U, U,U, U,U, U,U, N,N, N,N,
  INF,N, U,U, INF,-0, INF,0, U,U, INF,N, INF,N,
  N,N, N,N, N,0, N,0, N,N, N,N, N,N,
]);

function special(z: Complex, values: Table): Result | undefined {
  if (Number.isFinite(z.real) && Number.isFinite(z.imag)) return undefined;
  return { ...values[specialType(z.real)][specialType(z.imag)] };
}

const negate = (z: Complex): Complex => ({ real: -z.real, imag: -z.imag });
/** Multiplies by i, which the trigonometric functions use to reduce to the hyperbolic ones. */
const timesI = (z: Complex): Complex => ({ real: -z.imag, imag: z.real });
/** Multiplies by -i, keeping errno. */
const timesMinusI = (z: Result): Result => ({ real: z.imag, imag: -z.real, errno: z.errno });

// The functions ------------------------------------------------------------------------------------------------------

function acos(z: Complex): Result {
  const value = special(z, ACOS);
  if (value) return value;
  if (Math.abs(z.real) > LARGE_DOUBLE || Math.abs(z.imag) > LARGE_DOUBLE) {
    return {
      real: Math.atan2(Math.abs(z.imag), z.real),
      imag: -copysign(Math.log(hypot(z.real / 2, z.imag / 2)) + LN2 * 2, z.imag),
    };
  }
  const s1 = sqrt({ real: 1 - z.real, imag: -z.imag });
  const s2 = sqrt({ real: 1 + z.real, imag: z.imag });
  return { real: 2 * Math.atan2(s1.real, s2.real), imag: Math.asinh(fma(s2.real, s1.imag, -(s2.imag * s1.real))) };
}

function acosh(z: Complex): Result {
  const value = special(z, ACOSH);
  if (value) return value;
  if (Math.abs(z.real) > LARGE_DOUBLE || Math.abs(z.imag) > LARGE_DOUBLE) {
    return { real: Math.log(hypot(z.real / 2, z.imag / 2)) + LN2 * 2, imag: Math.atan2(z.imag, z.real) };
  }
  const s1 = sqrt({ real: z.real - 1, imag: z.imag });
  const s2 = sqrt({ real: z.real + 1, imag: z.imag });
  return { real: Math.asinh(fma(s1.real, s2.real, s1.imag * s2.imag)), imag: 2 * Math.atan2(s1.imag, s2.real) };
}

function asinh(z: Complex): Result {
  const value = special(z, ASINH);
  if (value) return value;
  if (Math.abs(z.real) > LARGE_DOUBLE || Math.abs(z.imag) > LARGE_DOUBLE) {
    const log = Math.log(hypot(z.real / 2, z.imag / 2)) + LN2 * 2;
    return {
      real: z.imag >= 0 ? copysign(log, z.real) : -copysign(log, -z.real),
      imag: Math.atan2(z.imag, Math.abs(z.real)),
    };
  }
  const s1 = sqrt({ real: 1 + z.imag, imag: -z.real });
  const s2 = sqrt({ real: 1 - z.imag, imag: z.real });
  return {
    real: Math.asinh(fma(s1.real, s2.imag, -(s2.real * s1.imag))),
    imag: Math.atan2(z.imag, fma(s1.real, s2.real, -(s1.imag * s2.imag))),
  };
}

function atanh(z: Complex): Result {
  const value = special(z, ATANH);
  if (value) return value;
  if (z.real < 0) {
    const result = atanh(negate(z));
    return { ...negate(result), errno: result.errno };
  }
  const ay = Math.abs(z.imag);
  if (z.real > SQRT_LARGE_DOUBLE || ay > SQRT_LARGE_DOUBLE) {
    const h = hypot(z.real / 2, z.imag / 2);
    return { real: z.real / 4 / h / h, imag: copysign(Math.PI / 2, z.imag) };
  }
  if (z.real === 1 && ay < SQRT_DBL_MIN) {
    if (ay === 0) return { real: INF, imag: z.imag, errno: 'EDOM' };
    return {
      real: -Math.log(Math.sqrt(ay) / Math.sqrt(hypot(ay, 2))),
      imag: copysign(Math.atan2(2, -ay) / 2, z.imag),
    };
  }
  return {
    real: Math.log1p((4 * z.real) / fma(1 - z.real, 1 - z.real, ay * ay)) / 4,
    imag: -Math.atan2(-2 * z.imag, fma(1 - z.real, 1 + z.real, -(ay * ay))) / 2,
  };
}

/** The results of cosh, sinh, and exp for an infinite real part and a finite nonzero imaginary part. */
function infiniteReal(z: Complex, values: Table, finite: (z: Complex) => Complex): Complex {
  if (!Number.isFinite(z.real) && !Number.isNaN(z.real) && Number.isFinite(z.imag) && z.imag !== 0) {
    return finite(z);
  }
  return { ...values[specialType(z.real)][specialType(z.imag)] };
}

function overflowCheck(result: Complex): Result {
  const overflow = !Number.isFinite(result.real) && !Number.isNaN(result.real);
  const overflowImag = !Number.isFinite(result.imag) && !Number.isNaN(result.imag);
  return { ...result, errno: overflow || overflowImag ? 'ERANGE' : undefined };
}

function cosh(z: Complex): Result {
  if (!Number.isFinite(z.real) || !Number.isFinite(z.imag)) {
    const result = infiniteReal(z, COSH, ({ real, imag }) => ({
      real: copysign(INF, Math.cos(imag)),
      imag: real > 0 ? copysign(INF, Math.sin(imag)) : -copysign(INF, Math.sin(imag)),
    }));
    return { ...result, errno: isInfinite(z.imag) && !Number.isNaN(z.real) ? 'EDOM' : undefined };
  }
  if (Math.abs(z.real) > LOG_LARGE_DOUBLE) {
    const xMinusOne = z.real - copysign(1, z.real);
    return overflowCheck({
      real: Math.cos(z.imag) * Math.cosh(xMinusOne) * Math.E,
      imag: Math.sin(z.imag) * Math.sinh(xMinusOne) * Math.E,
    });
  }
  return overflowCheck({ real: Math.cos(z.imag) * Math.cosh(z.real), imag: Math.sin(z.imag) * Math.sinh(z.real) });
}

function sinh(z: Complex): Result {
  if (!Number.isFinite(z.real) || !Number.isFinite(z.imag)) {
    const result = infiniteReal(z, SINH, ({ real, imag }) => ({
      real: real > 0 ? copysign(INF, Math.cos(imag)) : -copysign(INF, Math.cos(imag)),
      imag: copysign(INF, Math.sin(imag)),
    }));
    return { ...result, errno: isInfinite(z.imag) && !Number.isNaN(z.real) ? 'EDOM' : undefined };
  }
  if (Math.abs(z.real) > LOG_LARGE_DOUBLE) {
    const xMinusOne = z.real - copysign(1, z.real);
    return overflowCheck({
      real: Math.cos(z.imag) * Math.sinh(xMinusOne) * Math.E,
      imag: Math.sin(z.imag) * Math.cosh(xMinusOne) * Math.E,
    });
  }
  return overflowCheck({ real: Math.cos(z.imag) * Math.sinh(z.real), imag: Math.sin(z.imag) * Math.cosh(z.real) });
}

function exp(z: Complex): Result {
  if (!Number.isFinite(z.real) || !Number.isFinite(z.imag)) {
    const result = infiniteReal(z, EXP, ({ real, imag }) =>
      real > 0
        ? { real: copysign(INF, Math.cos(imag)), imag: copysign(INF, Math.sin(imag)) }
        : { real: copysign(0, Math.cos(imag)), imag: copysign(0, Math.sin(imag)) }
    );
    const domain = isInfinite(z.imag) && (Number.isFinite(z.real) || z.real === INF);
    return { ...result, errno: domain ? 'EDOM' : undefined };
  }
  if (z.real > LOG_LARGE_DOUBLE) {
    const l = Math.exp(z.real - 1);
    return overflowCheck({ real: l * Math.cos(z.imag) * Math.E, imag: l * Math.sin(z.imag) * Math.E });
  }
  const l = Math.exp(z.real);
  return overflowCheck({ real: l * Math.cos(z.imag), imag: l * Math.sin(z.imag) });
}

function isInfinite(value: number): boolean {
  return !Number.isFinite(value) && !Number.isNaN(value);
}

function log(z: Complex): Result {
  const value = special(z, LOG);
  if (value) return value;
  const ax = Math.abs(z.real);
  const ay = Math.abs(z.imag);
  let real: number;
  if (ax > LARGE_DOUBLE || ay > LARGE_DOUBLE) {
    real = Math.log(hypot(ax / 2, ay / 2)) + LN2;
  } else if (ax < DBL_MIN && ay < DBL_MIN) {
    if (ax === 0 && ay === 0) return { real: -INF, imag: Math.atan2(z.imag, z.real), errno: 'EDOM' };
    real = Math.log(hypot(ldexp(ax, DBL_MANT_DIG), ldexp(ay, DBL_MANT_DIG))) - DBL_MANT_DIG * LN2;
  } else {
    const h = hypot(ax, ay);
    if (h >= 0.71 && h <= 1.73) {
      const am = Math.max(ax, ay);
      const an = Math.min(ax, ay);
      real = Math.log1p(fma(am - 1, am + 1, an * an)) / 2;
    } else {
      real = Math.log(h);
    }
  }
  return { real, imag: Math.atan2(z.imag, z.real) };
}

function sqrt(z: Complex): Result {
  const value = special(z, SQRT);
  if (value) return value;
  if (z.real === 0 && z.imag === 0) return { real: 0, imag: z.imag };
  let ax = Math.abs(z.real);
  const ay = Math.abs(z.imag);
  let s: number;
  if (ax < DBL_MIN && ay < DBL_MIN) {
    ax = ldexp(ax, SCALE_UP);
    s = ldexp(Math.sqrt(ax + hypot(ax, ldexp(ay, SCALE_UP))), SCALE_DOWN);
  } else {
    ax /= 8;
    s = 2 * Math.sqrt(ax + hypot(ax, ay / 8));
  }
  const d = ay / (2 * s);
  return z.real >= 0 ? { real: s, imag: copysign(d, z.imag) } : { real: d, imag: copysign(s, z.imag) };
}

function tanh(z: Complex): Result {
  if (!Number.isFinite(z.real) || !Number.isFinite(z.imag)) {
    const result = infiniteReal(z, TANH, ({ real, imag }) => ({
      real: real > 0 ? 1 : -1,
      imag: copysign(0, 2 * Math.sin(imag) * Math.cos(imag)),
    }));
    return { ...result, errno: isInfinite(z.imag) && Number.isFinite(z.real) ? 'EDOM' : undefined };
  }
  if (Math.abs(z.real) > LOG_LARGE_DOUBLE) {
    return {
      real: copysign(1, z.real),
      imag: 4 * Math.sin(z.imag) * Math.cos(z.imag) * Math.exp(-2 * Math.abs(z.real)),
    };
  }
  const tx = Math.tanh(z.real);
  const ty = Math.tan(z.imag);
  const cx = 1 / Math.cosh(z.real);
  const txty = tx * ty;
  const denominator = fma(txty, txty, 1);
  return { real: (tx * fma(ty, ty, 1)) / denominator, imag: (ty / denominator) * cx * cx };
}

const FUNCTIONS: Record<string, (z: Complex) => Result> = {
  acos,
  acosh,
  asin: (z) => timesMinusI(asinh(timesI(z))),
  asinh,
  atan: (z) => timesMinusI(atanh(timesI(z))),
  atanh,
  cos: (z) => cosh(timesI(z)),
  cosh,
  exp,
  log10: (z) => {
    const result = log(z);
    return { real: result.real / LN10, imag: result.imag / LN10, errno: result.errno };
  },
  sin: (z) => timesMinusI(sinh(timesI(z))),
  sinh,
  sqrt,
  tan: (z) => timesMinusI(tanh(timesI(z))),
  tanh,
};

/** Divides as `_Py_c_quot` does, reporting a zero divisor as EDOM. */
// code-gauge-allow functionCognitiveComplexity 26 -- Transcribes _Py_c_quot with its recovery of infinities.
function quotient(a: Complex, b: Complex): Result {
  const absReal = Math.abs(b.real);
  const absImag = Math.abs(b.imag);
  let r: Result;
  if (absReal >= absImag) {
    if (absReal === 0) return { real: 0, imag: 0, errno: 'EDOM' };
    const ratio = b.imag / b.real;
    const denominator = fma(b.imag, ratio, b.real);
    r = { real: fma(a.imag, ratio, a.real) / denominator, imag: fma(-a.real, ratio, a.imag) / denominator };
  } else if (absImag >= absReal) {
    const ratio = b.real / b.imag;
    const denominator = fma(b.real, ratio, b.imag);
    r = { real: fma(a.real, ratio, a.imag) / denominator, imag: fma(a.imag, ratio, -a.real) / denominator };
  } else {
    r = { real: N, imag: N };
  }
  if (Number.isNaN(r.real) && Number.isNaN(r.imag)) {
    if ((isInfinite(a.real) || isInfinite(a.imag)) && Number.isFinite(b.real) && Number.isFinite(b.imag)) {
      const x = copysign(isInfinite(a.real) ? 1 : 0, a.real);
      const y = copysign(isInfinite(a.imag) ? 1 : 0, a.imag);
      r = { real: INF * (x * b.real + y * b.imag), imag: INF * (y * b.real - x * b.imag) };
    } else if ((isInfinite(absReal) || isInfinite(absImag)) && Number.isFinite(a.real) && Number.isFinite(a.imag)) {
      const x = copysign(isInfinite(b.real) ? 1 : 0, b.real);
      const y = copysign(isInfinite(b.imag) ? 1 : 0, b.imag);
      // oxlint-disable-next-line erasing-op -- Multiplying by zero keeps the sign of zero that C11 Annex G prescribes.
      r = { real: 0 * (a.real * x + a.imag * y), imag: 0 * (a.imag * x - a.real * y) };
    }
  }
  return r;
}

function rect(r: number, phi: number): Result {
  if (!Number.isFinite(r) || !Number.isFinite(phi)) {
    let z: Complex;
    if (isInfinite(r) && Number.isFinite(phi) && phi !== 0) {
      const sign = r > 0 ? 1 : -1;
      z = { real: sign * copysign(INF, Math.cos(phi)), imag: sign * copysign(INF, Math.sin(phi)) };
    } else {
      z = { ...RECT[specialType(r)][specialType(phi)] };
    }
    return { ...z, errno: r !== 0 && !Number.isNaN(r) && isInfinite(phi) ? 'EDOM' : undefined };
  }
  if (phi === 0) return { real: r, imag: r * phi };
  return { real: r * Math.cos(phi), imag: r * Math.sin(phi) };
}

/** `_Py_c_abs`. */
function absolute(z: Complex): Result {
  if (!Number.isFinite(z.real) || !Number.isFinite(z.imag)) {
    if (isInfinite(z.real)) return { real: Math.abs(z.real), imag: 0 };
    if (isInfinite(z.imag)) return { real: Math.abs(z.imag), imag: 0 };
    return { real: N, imag: 0 };
  }
  const result = hypot(z.real, z.imag);
  return { real: result, imag: 0, errno: Number.isFinite(result) ? undefined : 'ERANGE' };
}

// Glue ----------------------------------------------------------------------------------------------------------------

/** A function taking one argument, whose count errors name the module as `METH_O` functions do. */
function oneArgument(name: string, run: (value: PyValue) => PyValue): PyValue {
  return nativeFunction(name, (args, kwargs) => {
    checkArgs({ qualified: `cmath.${name}`, min: 1, max: 1, style: 'one' }, args, kwargs);
    return run(args[0]);
  });
}

/** Checks the arguments of `isclose(a, b, /, *, rel_tol, abs_tol)` as its generated parser does. */
function checkIscloseArgs(args: PyValue[], kwargs: Kwargs): void {
  if (args.length > 2) throw typeError(`isclose() takes exactly 2 positional arguments (${args.length} given)`);
  for (const key of kwargs?.keys() ?? []) {
    if (!['a', 'b', 'rel_tol', 'abs_tol'].includes(key)) {
      throw typeError(`isclose() got an unexpected keyword argument '${key}'`);
    }
  }
  for (const [index, name] of ['a', 'b'].entries()) {
    if (args[index] === undefined && kwargs?.get(name) === undefined) {
      throw typeError(`isclose() missing required argument '${name}' (pos ${index + 1})`);
    }
    args[index] ??= kwargs?.get(name) as PyValue;
  }
}

/** `PyComplex_AsCComplex`: a complex, an object with `__complex__`, or a real number. */
function complexArgument(value: PyValue): Complex {
  if (value instanceof PyComplex) return { real: value.real, imag: value.imag };
  const special = lookupSpecial(value, '__complex__');
  if (special !== undefined) {
    const result = callValue(bindValue(special, value), []);
    if (!(result instanceof PyComplex)) {
      throw typeError(`__complex__ returned non-complex (type ${typeName(result)})`);
    }
    return { real: result.real, imag: result.imag };
  }
  return { real: realArgument(value), imag: 0 };
}

function checked(result: Result): PyValue {
  if (result.errno === 'EDOM') throw valueError('math domain error');
  if (result.errno === 'ERANGE') throw pyError('OverflowError', 'math range error');
  return newComplex(result.real, result.imag);
}

function logFunction([value, base]: PyValue[]): PyValue {
  let result = log(complexArgument(value));
  if (base !== undefined) {
    const divisor = log(complexArgument(base));
    const errno = result.errno ?? divisor.errno;
    const divided = quotient(result, divisor);
    result = { ...divided, errno: divided.errno ?? errno };
  }
  return checked(result);
}

function isclose(args: PyValue[], kwargs: Kwargs): boolean {
  checkIscloseArgs(args, kwargs);
  const a = complexArgument(args[0]);
  const b = complexArgument(args[1]);
  const relative = realArgument(kwargs?.get('rel_tol') ?? 1e-9);
  const absoluteTolerance = realArgument(kwargs?.get('abs_tol') ?? 0);
  if (relative < 0 || absoluteTolerance < 0) throw valueError('tolerances must be non-negative');
  if (a.real === b.real && a.imag === b.imag) return true;
  if ([a.real, a.imag, b.real, b.imag].some(isInfinite)) return false;
  const difference = absolute({ real: a.real - b.real, imag: a.imag - b.imag }).real;
  return (
    difference <= relative * absolute(b).real ||
    difference <= relative * absolute(a).real ||
    difference <= absoluteTolerance
  );
}

registerModule('cmath', () => {
  const namespace = new Map<string, PyValue>([
    ['pi', Math.PI],
    ['e', Math.E],
    ['tau', 2 * Math.PI],
    ['inf', INF],
    ['infj', newComplex(0, INF)],
    ['nan', N],
    ['nanj', newComplex(0, N)],
  ]);
  for (const [name, run] of Object.entries(FUNCTIONS)) {
    namespace.set(
      name,
      oneArgument(name, (value) => checked(run(complexArgument(value))))
    );
  }
  namespace.set('log', builtin('log', 'expected', 1, 2, logFunction));
  namespace.set(
    'phase',
    oneArgument('phase', (value) => {
      const z = complexArgument(value);
      return Math.atan2(z.imag, z.real);
    })
  );
  namespace.set(
    'polar',
    oneArgument('polar', (value) => {
      const z = complexArgument(value);
      const phi = Math.atan2(z.imag, z.real);
      const r = absolute(z);
      if (r.errno) throw pyError('OverflowError', 'math range error');
      return newTuple([r.real, phi]);
    })
  );
  namespace.set(
    'rect',
    builtin('rect', 'expected', 2, 2, ([r, phi]) => checked(rect(realArgument(r), realArgument(phi))))
  );
  for (const [name, test] of [
    ['isfinite', (z: Complex) => Number.isFinite(z.real) && Number.isFinite(z.imag)],
    ['isnan', (z: Complex) => Number.isNaN(z.real) || Number.isNaN(z.imag)],
    ['isinf', (z: Complex) => isInfinite(z.real) || isInfinite(z.imag)],
  ] as const) {
    namespace.set(
      name,
      oneArgument(name, (value) => test(complexArgument(value)))
    );
  }
  namespace.set('isclose', nativeFunction('isclose', isclose));
  return namespace;
});

/**
 * `hypot` as the C library of macOS computes it, which differs in the last bit from JavaScript's `Math.hypot` for many
 * arguments: the square root of a fused multiply-add, with scaling by a power of two against overflow and underflow.
 */
function hypot(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  if (x === INF || y === INF) return INF;
  if (Number.isNaN(x) || Number.isNaN(y)) return N;
  if (x < y) [x, y] = [y, x];
  let scale = 1;
  if (x > 2 ** 500) scale = 2 ** -600;
  else if (x < 2 ** -500) scale = 2 ** 600;
  x *= scale;
  y *= scale;
  return Math.sqrt(fma(y, y, x * x)) / scale;
}
