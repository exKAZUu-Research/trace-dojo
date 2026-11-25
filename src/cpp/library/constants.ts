import type { Expr } from '../expr';
import type { Entity } from '../scopes';
import {
  CHAR,
  DOUBLE,
  FLOAT,
  INT,
  LLONG,
  LONG,
  pointerTo,
  SCHAR,
  SHORT,
  type Type,
  UCHAR,
  UINT,
  ULLONG,
  ULONG,
  USHORT,
} from '../types';
import { Ptr } from '../values';
import type { Library } from './registry';

const DBL = {
  DBL_MAX: Number.MAX_VALUE,
  DBL_MIN: 2.2250738585072014e-308,
  DBL_EPSILON: Number.EPSILON,
  FLT_MAX: 3.4028234663852886e38,
  FLT_MIN: 1.1754943508222875e-38,
  FLT_EPSILON: 1.1920928955078125e-7,
};

export const MATH_CONSTANTS: Record<string, number> = {
  M_E: Math.E,
  M_LOG2E: Math.LOG2E,
  M_LOG10E: Math.LOG10E,
  M_LN2: Math.LN2,
  M_LN10: Math.LN10,
  M_PI: Math.PI,
  M_PI_2: Math.PI / 2,
  M_PI_4: Math.PI / 4,
  M_1_PI: 1 / Math.PI,
  M_2_PI: 2 / Math.PI,
  M_2_SQRTPI: 2 / Math.sqrt(Math.PI),
  M_SQRT2: Math.SQRT2,
  M_SQRT1_2: Math.SQRT1_2,
};

function constant(type: Type, value: number | bigint): (row: number) => Expr {
  return (row) => ({ type, isLvalue: false, row, run: () => value, constant: value });
}

/**
 * The macros and constants of `<climits>`, `<cfloat>`, `<cmath>`, `<cstdlib>`, and `<cstdio>` that programs use as
 * values, by name (`std::` for those in the namespace).
 */
export function constantsOf(library: Library): Map<string, Entity> {
  const entries = new Map<string, Entity>();
  const set = (name: string, make: (row: number) => Expr): void => {
    entries.set(name, { kind: 'value', make });
  };
  const limits: [string, Type, number | bigint][] = [
    ['CHAR_BIT', INT, 8],
    ['CHAR_MAX', INT, 127],
    ['CHAR_MIN', INT, -128],
    ['SCHAR_MAX', INT, 127],
    ['SCHAR_MIN', INT, -128],
    ['UCHAR_MAX', INT, 255],
    ['SHRT_MAX', INT, 32_767],
    ['SHRT_MIN', INT, -32_768],
    ['USHRT_MAX', INT, 65_535],
    ['INT_MAX', INT, 2_147_483_647],
    ['INT_MIN', INT, -2_147_483_648],
    ['UINT_MAX', UINT, 4_294_967_295],
    ['LONG_MAX', LONG, 2n ** 63n - 1n],
    ['LONG_MIN', LONG, -(2n ** 63n)],
    ['ULONG_MAX', ULONG, 2n ** 64n - 1n],
    ['LLONG_MAX', LLONG, 2n ** 63n - 1n],
    ['LLONG_MIN', LLONG, -(2n ** 63n)],
    ['ULLONG_MAX', ULLONG, 2n ** 64n - 1n],
    ['INT8_MAX', INT, 127],
    ['INT8_MIN', INT, -128],
    ['INT16_MAX', INT, 32_767],
    ['INT16_MIN', INT, -32_768],
    ['INT32_MAX', INT, 2_147_483_647],
    ['INT32_MIN', INT, -2_147_483_648],
    ['INT64_MAX', LLONG, 2n ** 63n - 1n],
    ['INT64_MIN', LLONG, -(2n ** 63n)],
    ['UINT8_MAX', INT, 255],
    ['UINT16_MAX', INT, 65_535],
    ['UINT32_MAX', UINT, 4_294_967_295],
    ['UINT64_MAX', ULLONG, 2n ** 64n - 1n],
    ['SIZE_MAX', ULONG, 2n ** 64n - 1n],
    ['RAND_MAX', INT, 0x7f_ff_ff_ff],
    ['EXIT_SUCCESS', INT, 0],
    ['EXIT_FAILURE', INT, 1],
    ['EOF', INT, -1],
  ];
  for (const [name, type, value] of limits) set(name, constant(type, value));
  for (const [name, value] of Object.entries(DBL)) set(name, constant(name.startsWith('FLT') ? FLOAT : DOUBLE, value));
  for (const [name, value] of Object.entries(MATH_CONSTANTS)) set(name, constant(DOUBLE, value));
  set('INFINITY', constant(FLOAT, Number.POSITIVE_INFINITY));
  set('NAN', constant(FLOAT, Number.NaN));
  set('HUGE_VAL', constant(DOUBLE, Number.POSITIVE_INFINITY));
  // clang++'s NULL is __null, a null pointer constant of type long.
  set('NULL', (row) => ({ ...constant(LONG, 0n)(row), isNullConstant: true }));
  const filePointer = pointerTo({ kind: 'class', cls: library.fileClass });
  for (const name of ['stdin', 'stdout', 'stderr'] as const) {
    const store = library.fileStore(name);
    set(name, (row) => ({ type: filePointer, isLvalue: false, row, run: () => new Ptr(store, 0) }));
  }
  void [CHAR, SCHAR, SHORT, UCHAR, USHORT];
  return entries;
}
