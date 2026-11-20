import { commonType } from '../../c/types';
import { arithmeticOperation, convertNumeric, type NumericValue } from '../arithmetic';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { FloatNaN } from '../floatSign';
import { type Frame, holdAll } from '../runtime';
import { BOOL, ClassInfo, isArithmetic, sameType, type Type, typeName, unqualified } from '../types';
import { CObject, type Ptr, type Value } from '../values';
import { type CallbackOperand, callbackOperands, equalTo, lessThan, type ValueComparison } from './elements';
import type { ClassOperations } from './libraryClass';
import type { Library } from './registry';
import { constRef, native, nativeConstructor } from './support';
import { typeKey } from './templates';

const FUNCTORS: Record<string, { isComparison: boolean; operator: string }> = {
  less: { isComparison: true, operator: '<' },
  greater: { isComparison: true, operator: '>' },
  less_equal: { isComparison: true, operator: '<=' },
  greater_equal: { isComparison: true, operator: '>=' },
  equal_to: { isComparison: true, operator: '==' },
  not_equal_to: { isComparison: true, operator: '!=' },
  plus: { isComparison: false, operator: '+' },
  minus: { isComparison: false, operator: '-' },
  multiplies: { isComparison: false, operator: '*' },
  divides: { isComparison: false, operator: '/' },
  modulus: { isComparison: false, operator: '%' },
};

export const FUNCTOR_NAMES = Object.keys(FUNCTORS);

/**
 * A function object of `<functional>`, such as `std::greater<int>`, which compares or combines two values. Without a
 * template argument (`std::greater<>`), it takes values of any type.
 */
export function functorClass(library: Library, name: string, type: Type | undefined): ClassInfo {
  const argument = type?.kind === 'void' ? undefined : type;
  const key = `${name}<${argument ? typeKey(argument) : ''}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  const cls = new ClassInfo(`std::${name}<${argument ? typeName(argument) : ''}>`, 'struct');
  library.instances.set(key, cls);
  cls.isComplete = true;
  const { isComparison, operator } = FUNCTORS[name];
  const apply = (left: Type, right: Type): ValueComparison<Value> | undefined => {
    if (isArithmetic(left) && isArithmetic(right) && (!argument || isArithmetic(argument))) {
      const operand = commonType(argument ?? left, argument ?? right);
      const operation = arithmeticOperation(operator as never, operand);
      const convert = (value: NumericValue, type: typeof left): NumericValue =>
        argument
          ? convertNumeric(convertNumeric(value, type, argument), argument, operand)
          : convertNumeric(value, type, operand);
      return (a, b) => {
        const result = operation(convert(a as NumericValue, left), convert(b as NumericValue, right));
        return argument && !isComparison ? convertNumeric(result, operand, argument) : result;
      };
    }
    const operand = unqualified(argument ?? left);
    if (!sameType(operand, right, false)) return undefined;
    if (isComparison) {
      if (operator === '==' || operator === '!=') {
        const equal = equalTo(operand);
        if (!equal) return undefined;
        return (a, b, frame) => ((operator === '==') === equal(a, b, frame) ? 1 : 0);
      }
      const less = lessThan(operand);
      if (!less) return undefined;
      return (a, b, frame) => {
        const order = less(a, b, frame);
        const result =
          operator === '<' ? order < 0 : operator === '>' ? order > 0 : operator === '<=' ? order <= 0 : order >= 0;
        return result ? 1 : 0;
      };
    }
    return undefined;
  };
  cls.library = {
    kind: 'functor',
    args: argument ? [argument] : [],
    size: 1,
    align: 1,
    apply,
    call: (compiler, object, args, row) => {
      if (args.length !== 2) return;
      if (!argument) return transparentCall(compiler, operator, object, args, row);
      const type = unqualified(argument);
      if (operator === '+' && type.kind === 'class' && type.cls.library?.kind === 'string') {
        const [left, right] = args.map((arg) => constLvalue(compiler, arg, type, row));
        const result = compiler.binary(operator, left, right, row);
        return { ...result, run: (frame) => (object.run(frame), result.run(frame)) };
      }
      const operation = apply(type, type);
      if (!operation) return compiler.error(row, `${cls.name} は ${typeName(type)} の値に使えません。`);
      const values = args.map((arg) => {
        if (type.kind !== 'class') return compiler.convert(arg, type, row).run;
        const run = constLvalue(compiler, arg, type, row).run;
        return (frame: Frame) => (run(frame) as Ptr).read();
      });
      const objectRun = object.run;
      return {
        type: isComparison ? BOOL : unqualified(type),
        isLvalue: false,
        row,
        run: (frame) => {
          objectRun(frame);
          return operation(values[0](frame) as Value, values[1](frame) as Value, frame);
        },
      };
    },
  };
  cls.constructors = [nativeConstructor(cls, [], () => new CObject(cls, []))];
  cls.operations = statelessOperations(cls);
  return cls;
}

const LIMITS: Record<
  string,
  { min: number | bigint; max: number | bigint; lowest?: number; epsilon?: number; digits: number; digits10: number }
> = {
  bool: { min: 0, max: 1, digits: 1, digits10: 0 },
  char: { min: -128, max: 127, digits: 7, digits10: 2 },
  schar: { min: -128, max: 127, digits: 7, digits10: 2 },
  uchar: { min: 0, max: 255, digits: 8, digits10: 2 },
  short: { min: -32_768, max: 32_767, digits: 15, digits10: 4 },
  ushort: { min: 0, max: 65_535, digits: 16, digits10: 4 },
  int: { min: -2_147_483_648, max: 2_147_483_647, digits: 31, digits10: 9 },
  uint: { min: 0, max: 4_294_967_295, digits: 32, digits10: 9 },
  long: { min: -(2n ** 63n), max: 2n ** 63n - 1n, digits: 63, digits10: 18 },
  ulong: { min: 0n, max: 2n ** 64n - 1n, digits: 64, digits10: 19 },
  llong: { min: -(2n ** 63n), max: 2n ** 63n - 1n, digits: 63, digits10: 18 },
  ullong: { min: 0n, max: 2n ** 64n - 1n, digits: 64, digits10: 19 },
  float: {
    min: 1.1754943508222875e-38,
    max: 3.4028234663852886e38,
    lowest: -3.4028234663852886e38,
    epsilon: 1.1920928955078125e-7,
    digits: 24,
    digits10: 6,
  },
  double: {
    min: 2.2250738585072014e-308,
    max: Number.MAX_VALUE,
    lowest: -Number.MAX_VALUE,
    epsilon: Number.EPSILON,
    digits: 53,
    digits10: 15,
  },
  ldouble: {
    min: 2.2250738585072014e-308,
    max: Number.MAX_VALUE,
    lowest: -Number.MAX_VALUE,
    epsilon: Number.EPSILON,
    digits: 53,
    digits10: 15,
  },
};

const INTEGER_EXPONENTS = { max_digits10: 0, min_exponent: 0, max_exponent: 0, min_exponent10: 0, max_exponent10: 0 };
const BINARY32_EXPONENTS = {
  max_digits10: 9,
  min_exponent: -125,
  max_exponent: 128,
  min_exponent10: -37,
  max_exponent10: 38,
};
const BINARY64_EXPONENTS = {
  max_digits10: 17,
  min_exponent: -1021,
  max_exponent: 1024,
  min_exponent10: -307,
  max_exponent10: 308,
};
const SIGNALING_NAN = FloatNaN.fromBits(0x7f_f4_00_00_00_00_00_00n, false);

/** `std::numeric_limits<T>`, whose static members tell the range of an arithmetic type. */
export function numericLimitsClass(library: Library, type: Type): ClassInfo {
  const key = `numeric_limits<${typeKey(type)}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  const cls = new ClassInfo(`std::numeric_limits<${typeName(type)}>`, 'class');
  library.instances.set(key, cls);
  cls.isComplete = true;
  cls.library = { kind: 'numeric_limits', args: [type], size: 1, align: 1 };
  cls.operations = statelessOperations(cls);
  const target = unqualified(type);
  if (!isArithmetic(target)) return cls;
  const limits = LIMITS[target.name];
  const floating = target.kind === 'float';
  const binary32 = target.name === 'float';
  const signed = floating || limits.min < 0;
  const zero = typeof limits.max === 'bigint' ? 0n : 0;
  const special = floating
    ? {
        round_error: 0.5,
        infinity: Infinity,
        quiet_NaN: Number.NaN,
        signaling_NaN: SIGNALING_NAN,
        denorm_min: binary32 ? 2 ** -149 : Number.MIN_VALUE,
      }
    : { round_error: zero, infinity: zero, quiet_NaN: zero, signaling_NaN: zero, denorm_min: zero };
  const staticFunction = (name: string, value: NumericValue): void => {
    const method = native(name, [], target, () => value, { owner: cls, isStatic: true });
    cls.methods.set(name, [{ ...method, evaluateConstant: () => (value instanceof FloatNaN ? Number.NaN : value) }]);
  };
  for (const [name, value] of Object.entries({
    max: limits.max,
    min: limits.min,
    lowest: limits.lowest ?? limits.min,
    epsilon: limits.epsilon ?? zero,
    ...special,
  }))
    staticFunction(name, value);
  const int: Type = { kind: 'int', name: 'int' };
  for (const [name, value] of Object.entries({
    digits: limits.digits,
    digits10: limits.digits10,
    radix: 2,
    ...(floating ? (binary32 ? BINARY32_EXPONENTS : BINARY64_EXPONENTS) : INTEGER_EXPONENTS),
    has_denorm: Number(floating),
    round_style: Number(floating),
  }))
    cls.constants.set(name, constant(value, int));
  for (const [name, value] of Object.entries({
    is_specialized: true,
    is_signed: signed,
    is_integer: !floating,
    is_exact: !floating,
    has_infinity: floating,
    has_quiet_NaN: floating,
    has_signaling_NaN: floating,
    has_denorm_loss: false,
    is_iec559: floating,
    is_bounded: true,
    is_modulo: !signed && target.name !== 'bool',
    traps: false,
    tinyness_before: floating,
  }))
    cls.constants.set(name, constant(Number(value), BOOL));
  return cls;
}

const constant =
  (value: number | bigint, valueType: Type) =>
  (row: number): Expr => ({
    type: valueType,
    isLvalue: false,
    row,
    run: () => value,
    constant: value,
  });

function statelessOperations(cls: ClassInfo): ClassOperations {
  return { copyIsNoexcept: true, copy: () => new CObject(cls, []), assign: () => {} };
}

/** An operand bound to a typed functor's `const T&` parameter, which its body reads as an lvalue. */
function constLvalue(compiler: ExpressionCompiler, arg: Expr, type: Type, row: number): Expr {
  const bound = compiler.convert(arg, constRef(type), row);
  return { ...(bound.isLvalue ? bound : compiler.materialize(bound)), isXvalue: false };
}

/**
 * A transparent functor's call, such as `std::plus<>()(a, b)`: its arguments are evaluated as a call's arguments
 * (indeterminately sequenced, not as the operator's unsequenced operands), then the operator applies to them.
 */
function transparentCall(
  compiler: ExpressionCompiler,
  operator: string,
  object: Expr,
  args: Expr[],
  row: number
): Expr {
  const active: unknown[][] = [];
  const operands = args.map((arg): CallbackOperand => ({
    type: arg.type,
    category: arg.isLvalue ? (arg.isXvalue ? 'xvalue' : undefined) : 'prvalue',
  }));
  const [left, right] = callbackOperands(operands, row, (_frame, index) => active.at(-1)?.[index] as Value);
  const result = compiler.binary(operator, left, right, row);
  const runs = [object.run, ...args.map((arg) => arg.run)];
  return {
    ...result,
    run: (frame) =>
      holdAll(frame, runs, (values) => {
        active.push(values.slice(1));
        try {
          return result.run(frame);
        } finally {
          active.pop();
        }
      }),
  };
}
