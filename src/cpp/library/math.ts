import { fma } from '../../c/library/binaryFloat';
import { BINARY, MATH_FUNCTIONS, UNARY } from '../../c/library/mathFunctions';
import { convertNumeric, type NumericValue } from '../arithmetic';
import { overflowError } from '../errors';
import { copyFloatSign, type FloatingValue, FloatNaN, floatSignBit, fusedNaN, NEGATIVE_NAN } from '../floatSign';
import { invoke } from '../objectCompiler';
import {
  type ArithmeticType,
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
import { mathWrapperCall, mathWrapperNaNResults } from './libcGlobals';
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
    ...FLOAT_TYPES.map((type) => native('abs', [type], type, ([x]) => copyFloatSign(x, 0))),
  ]);
  for (const name of ['ldexp', 'scalbn', 'scalbln']) {
    const exponent = name === 'scalbln' ? LONG : INT;
    functions.set(
      name,
      FLOAT_TYPES.map((type) =>
        native(name, [type, exponent], type, ([x, e], { frame }) =>
          (type === FLOAT ? MATH_FUNCTIONS.ldexpf : MATH_FUNCTIONS.ldexp)(
            frame.runtime as never,
            [x as number, Number(e)],
            [],
            0
          )
        )
      )
    );
  }
  functions.set(
    'ilogb',
    FLOAT_TYPES.map((type) =>
      native('ilogb', [type], INT, ([x], { frame }) =>
        MATH_FUNCTIONS.ilogb(frame.runtime as never, [x as number], [], 0)
      )
    )
  );
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
    return native(name, types, result, linkedMath(name, symbol, result, run, types));
  });
}

function linkedMath(
  name: string,
  symbol: string | undefined,
  type: FloatType,
  run: MathOperation,
  promotedFrom?: ArithmeticType[]
): NativeFunction {
  const isFloat = type.name === 'float';
  const nanResults = mathWrapperNaNResults(name, type.name);
  return (values, { frame, row }) => {
    const operands = promotedFrom
      ? values.map((value, index) => convertNumeric(value as NumericValue, promotedFrom[index], type))
      : values;
    const override = symbol && frame.runtime.libcOverrides.get(symbol);
    if (override) {
      const args = operands.map((value) => (value instanceof FloatNaN ? value : asNumber(value)));
      return invoke(frame, override, args, undefined, row);
    }
    if (name === 'copysign') return copyFloatSign(operands[0], operands[1]);
    if (name === 'fma') {
      const nan = fusedNaN(operands[0], operands[1], operands[2]);
      if (nan !== undefined) return nan;
    }
    const numbers = operands.map(asNumber);
    if (nanResults && numbers.some(Number.isNaN)) {
      const measured = measuredNaN(nanResults, operands, numbers);
      if (measured !== undefined) return measured;
    }
    const result = run(numbers, isFloat);
    return isFloat ? Math.fround(result) : result;
  };
}

// Each decimal digit is the input's NaN or special-number category in the SDK probe.
function measuredNaN(results: string, values: unknown[], numbers: number[]): FloatingValue | undefined {
  let pattern = 0;
  for (let index = numbers.length - 1; index >= 0; index--) {
    pattern = pattern * 10 + mathOperandCategory(values[index], numbers[index]);
  }
  const measured = results[pattern];
  if (!measured || measured === '0') return;
  if (measured === '1') return NEGATIVE_NAN;
  if (measured === 'N') return Number.NaN;
  const rule = (measured.codePointAt(0) ?? 0) - 65;
  const source = values[rule >> 2];
  const negative = (rule & 2) !== 0;
  if (!(source instanceof FloatNaN)) return negative ? NEGATIVE_NAN : Number.NaN;
  const result = source.withSign(negative);
  return (rule & 1) !== 0 ? result.quiet() : result;
}

function mathOperandCategory(raw: unknown, value: number): number {
  if (raw instanceof FloatNaN) return (raw.isSignaling ? 3 : 1) + Number(raw.negative);
  if (Number.isNaN(value)) return 1;
  if (value === 0) return 5;
  if (value === 1) return 6;
  if (value === -1) return 7;
  if (value === Number.POSITIVE_INFINITY) return 8;
  if (value === Number.NEGATIVE_INFINITY) return 9;
  return 0;
}

function integerAbs(value: unknown, type: IntType): number | bigint {
  const numeric = BigInt(value as number | bigint);
  if (numeric === intMin(type.name)) throw overflowError(typeName(type));
  const magnitude = numeric < 0n ? -numeric : numeric;
  return typeof value === 'bigint' ? magnitude : Number(magnitude);
}
