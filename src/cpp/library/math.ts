import { fma } from '../../c/library/binaryFloat';
import { BINARY, UNARY } from '../../c/library/mathFunctions';
import { overflowError } from '../errors';
import { copyFloatSign, FloatNaN, floatSignBit, NEGATIVE_NAN } from '../floatSign';
import { invoke } from '../objectCompiler';
import {
  BOOL,
  DOUBLE,
  FLOAT,
  type FloatType,
  type FunctionInfo,
  INT,
  intMin,
  type IntType,
  isArithmetic,
  LDOUBLE,
  LLONG,
  LONG,
  type NativeFunction,
  nonReference,
  typeName,
  unqualified,
} from '../types';
import { mathWrapperCall, mathWrapperNaNSigns } from './libcGlobals';
import { asNumber, generic, native } from './support';

type MathOperation = (args: number[], isFloat: boolean) => number;
const FLOAT_TYPES = [FLOAT, DOUBLE, LDOUBLE];

/** The functions of `<cmath>`, with the overloads for `float`, `double`, `long double`, and integers. */
export function mathFunctions(): Map<string, FunctionInfo[]> {
  const functions = new Map<string, FunctionInfo[]>();
  const add = (name: string, arity: number, run: MathOperation): void => {
    functions.set(name, [
      ...FLOAT_TYPES.map((type) => floatingOverload(name, name, type, arity, run)),
      promotedMath(name, arity, run),
    ]);
    if (name !== 'fma') {
      for (const [suffix, type] of [
        ['f', FLOAT],
        ['l', LDOUBLE],
      ] as const) {
        const exportedName = name + suffix;
        functions.set(exportedName, [floatingOverload(name, exportedName, type, arity, run)]);
      }
    }
  };
  for (const [name, fn] of Object.entries(UNARY)) add(name, 1, ([x]) => fn(x));
  for (const [name, fn] of Object.entries(BINARY)) add(name, 2, ([x, y], isFloat) => fn(x, y, isFloat));
  add('fma', 3, ([x, y, z], isFloat) => fma(x, y, z, isFloat));
  functions.set('abs', [
    native('abs', [INT], INT, ([x]) => integerAbs(x, INT)),
    native('abs', [LONG], LONG, ([x]) => integerAbs(x, LONG)),
    native('abs', [LLONG], LLONG, ([x]) => integerAbs(x, LLONG)),
    native('abs', [FLOAT], FLOAT, ([x]) => Math.abs(x as number)),
    native('abs', [DOUBLE], DOUBLE, ([x]) => Math.abs(x as number)),
    native('abs', [LDOUBLE], LDOUBLE, ([x]) => Math.abs(x as number)),
  ]);
  for (const name of ['labs', 'llabs'])
    functions.set(name, [
      native(name, [name === 'labs' ? LONG : LLONG], name === 'labs' ? LONG : LLONG, ([x]) =>
        integerAbs(x, name === 'labs' ? LONG : LLONG)
      ),
    ]);
  for (const [name, test] of [
    ['isnan', (x: unknown) => Number.isNaN(asNumber(x))],
    ['isinf', (x: unknown) => Math.abs(asNumber(x)) === Number.POSITIVE_INFINITY],
    ['isfinite', (x: unknown) => Number.isFinite(asNumber(x))],
    ['signbit', floatSignBit],
  ] as const) {
    functions.set(name, classification(name, test, name === 'signbit'));
  }
  return functions;
}

/** The overloads of a classification function such as `isnan`, which libc++ also has for integers. */
function classification(name: string, test: (x: unknown) => boolean, templateOnly: boolean): FunctionInfo[] {
  const template = generic(name, (args) => {
    const type = args.length === 1 ? unqualified(args[0].type) : undefined;
    if (!type || !isArithmetic(type) || (!templateOnly && type.kind !== 'int')) return;
    return native(name, [type], BOOL, ([x]) => (test(x) ? 1 : 0));
  });
  if (templateOnly) return [template];
  const ordinary = FLOAT_TYPES.map((type) => native(name, [type], BOOL, ([x]) => (test(x) ? 1 : 0)));
  return [...ordinary, template];
}

function floatingOverload(
  name: string,
  exportedName: string,
  type: FloatType,
  arity: number,
  run: MathOperation
): FunctionInfo {
  const symbol = mathWrapperCall(name, type.name);
  const args = Array.from({ length: arity }, () => type);
  const fn = native(exportedName, args, type, linkedMath(name, symbol, type, run));
  fn.mathIntrinsic = symbol === undefined;
  return fn;
}

function promotedMath(name: string, arity: number, run: MathOperation): FunctionInfo {
  return generic(name, (args) => {
    if (args.length !== arity) return;
    const types = args.map((arg) => unqualified(nonReference(arg.type)));
    if (!types.every(isArithmetic)) return;
    if (types[0].kind === 'float' && types.every((type) => type.kind === 'float' && type.name === types[0].name))
      return;
    const result = types.some((type) => type.kind === 'float' && type.name === 'ldouble') ? LDOUBLE : DOUBLE;
    const symbol = mathWrapperCall(name, result.name === 'ldouble' ? 'ldouble' : 'integer');
    return native(name, types, result, linkedMath(name, symbol, result, run));
  });
}

function linkedMath(name: string, symbol: string | undefined, type: FloatType, run: MathOperation): NativeFunction {
  const isFloat = type.name === 'float';
  const signs = mathWrapperNaNSigns(name, type.name);
  return (values, { frame, row }) => {
    const override = symbol && frame.runtime.libcOverrides.get(symbol);
    if (override) {
      const args = values.map((value) => (value instanceof FloatNaN ? value : asNumber(value)));
      return invoke(frame, override, args, undefined, row);
    }
    if (name === 'copysign') return copyFloatSign(values[0], values[1]);
    const numbers = values.map(asNumber);
    const result = run(numbers, isFloat);
    if (Number.isNaN(result) && signs && hasNegativeNaNResult(signs, values, numbers)) return NEGATIVE_NAN;
    return isFloat ? Math.fround(result) : result;
  };
}

// The SDK probe encodes each argument as finite (0), positive NaN (1), or negative NaN (2).
function hasNegativeNaNResult(signs: number, values: unknown[], numbers: number[]): boolean {
  let pattern = 0;
  for (let index = numbers.length - 1; index >= 0; index--) {
    const raw = values[index];
    const digit = raw instanceof FloatNaN && raw.negative ? 2 : Number.isNaN(numbers[index]) ? 1 : 0;
    pattern = pattern * 3 + digit;
  }
  return (signs & (1 << pattern)) !== 0;
}

function integerAbs(value: unknown, type: IntType): number | bigint {
  const numeric = BigInt(value as number | bigint);
  if (numeric === intMin(type.name)) throw overflowError(typeName(type));
  const magnitude = numeric < 0n ? -numeric : numeric;
  return typeof value === 'bigint' ? magnitude : Number(magnitude);
}
