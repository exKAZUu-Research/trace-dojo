import {
  absolute,
  add,
  byMagnitude,
  byValue,
  choose,
  compareMethod,
  compareTotal,
  divide,
  divideWithRemainder,
  floorDivide,
  fusedMultiplyAdd,
  logb,
  logical,
  logicalInvert,
  negate,
  nextToward,
  nextValue,
  normalizeValue,
  numberClass,
  plus,
  quantize,
  remainder,
  remainderNear,
  rotateOrShift,
  scaleb,
  squareRoot,
  subtract,
  times,
  toIntegralExact,
  toIntegralValue,
} from './decimalArithmetic';
import type { DecimalContext, Rounding } from './decimalContext';
import {
  adjusted,
  checkNans,
  compareCheckNans,
  copyAbs,
  copyNegate,
  type Dec,
  dec,
  infinityKind,
  isFinite,
  isNan,
  isNonzero,
  NEGATIVE_ONE,
  ONE,
  ZERO,
} from './decimalNumber';
import { exponential, log10, naturalLog } from './decimalPower';

type Result = Dec | [Dec, Dec] | boolean | string;

/** An operation that both a Decimal method and a Context method perform, or one of them alone. */
export interface Operation {
  /** The number of Decimal operands, counting the instance of a Decimal method. */
  arity: number;
  /** The names of the operands after the instance, which keyword arguments of the Decimal method may use. */
  names: readonly string[];
  run: (operands: Dec[], context: DecimalContext, rounding: Rounding | undefined) => Result;
  /** Whether the Decimal method takes a `rounding` argument before `context`. */
  rounding?: boolean;
  /** Whether the Decimal method takes no context, as the predicates and copies do. */
  contextFree?: boolean;
  /** The name of the Context method, or null when only Decimal has the method. */
  contextName?: string | null;
  /** Whether only Context has the method. */
  contextOnly?: boolean;
}

const unary = (run: (value: Dec, context: DecimalContext) => Result, options: Partial<Operation> = {}): Operation => ({
  arity: 1,
  names: [],
  run: ([a], context) => run(a, context),
  ...options,
});

const binary = (
  run: (a: Dec, b: Dec, context: DecimalContext) => Result,
  options: Partial<Operation> = {}
): Operation => ({
  arity: 2,
  names: ['other'],
  run: ([a, b], context) => run(a, b, context),
  ...options,
});

const predicate = (test: (value: Dec, context: DecimalContext) => boolean, usesContext = false): Operation =>
  unary(test, { contextFree: !usesContext });

function compareSignal(a: Dec, b: Dec, context: DecimalContext): Dec {
  if (compareCheckNans(a, b, context)) return checkNans(a, b, context) ?? dec(0, '', 'n');
  return compareMethod(a, b, context);
}

const totalOrder = (order: number): Dec => (order === 0 ? ZERO : order < 0 ? NEGATIVE_ONE : ONE);

function sameQuantum(a: Dec, b: Dec): boolean {
  if (!isFinite(a) || !isFinite(b)) return (isNan(a) && isNan(b)) || (infinityKind(a) !== 0 && infinityKind(b) !== 0);
  return a.exp === b.exp;
}

/** The operations of Decimal and Context methods, by method name. */
export const DECIMAL_OPERATIONS: Record<string, Operation> = {
  add: binary(add, { contextOnly: true }),
  subtract: binary(subtract, { contextOnly: true }),
  multiply: binary(times, { contextOnly: true }),
  divide: binary(divide, { contextOnly: true }),
  divide_int: binary(floorDivide, { contextOnly: true }),
  divmod: binary(divideWithRemainder, { contextOnly: true }),
  remainder: binary(remainder, { contextOnly: true }),
  abs: unary(absolute, { contextOnly: true }),
  minus: unary(negate, { contextOnly: true }),
  plus: unary(plus, { contextOnly: true }),
  compare: binary(compareMethod),
  compare_signal: binary(compareSignal),
  compare_total: binary((a, b) => totalOrder(compareTotal(a, b)), { contextFree: true }),
  compare_total_mag: binary((a, b) => totalOrder(compareTotal(copyAbs(a), copyAbs(b))), { contextFree: true }),
  copy_abs: unary(copyAbs, { contextFree: true }),
  copy_negate: unary(copyNegate, { contextFree: true }),
  copy_sign: binary((a, b) => dec(b.sign, a.int, a.exp), { contextFree: true }),
  exp: unary(exponential),
  fma: { arity: 3, names: ['other', 'third'], run: ([a, b, c], context) => fusedMultiplyAdd(a, b, c, context) },
  is_canonical: predicate(() => true),
  is_finite: predicate((value) => isFinite(value)),
  is_infinite: predicate((value) => infinityKind(value) !== 0),
  is_nan: predicate((value) => isNan(value)),
  is_normal: predicate(
    (value, context) => isFinite(value) && isNonzero(value) && context.Emin <= adjusted(value),
    true
  ),
  is_qnan: predicate((value) => value.exp === 'n'),
  is_signed: predicate((value) => value.sign === 1),
  is_snan: predicate((value) => value.exp === 'N'),
  is_subnormal: predicate(
    (value, context) => isFinite(value) && isNonzero(value) && adjusted(value) < context.Emin,
    true
  ),
  is_zero: predicate((value) => isFinite(value) && !isNonzero(value)),
  ln: unary(naturalLog),
  log10: unary(log10),
  logb: unary(logb),
  logical_and: binary((a, b, context) => logical(a, b, context, (x, y) => x & y)),
  logical_invert: unary(logicalInvert),
  logical_or: binary((a, b, context) => logical(a, b, context, (x, y) => x | y)),
  logical_xor: binary((a, b, context) => logical(a, b, context, (x, y) => x ^ y)),
  max: binary((a, b, context) => choose(a, b, context, byValue, true)),
  max_mag: binary((a, b, context) => choose(a, b, context, byMagnitude, true)),
  min: binary((a, b, context) => choose(a, b, context, byValue, false)),
  min_mag: binary((a, b, context) => choose(a, b, context, byMagnitude, false)),
  next_minus: unary((value, context) => nextValue(value, context, false)),
  next_plus: unary((value, context) => nextValue(value, context, true)),
  next_toward: binary(nextToward),
  normalize: unary(normalizeValue),
  number_class: unary(numberClass),
  quantize: {
    arity: 2,
    names: ['exp'],
    rounding: true,
    run: ([a, b], context, rounding) => quantize(a, b, rounding ?? context.rounding, context),
  },
  remainder_near: binary(remainderNear),
  rotate: binary((a, b, context) => rotateOrShift(a, b, context, true)),
  same_quantum: binary(sameQuantum),
  scaleb: binary(scaleb),
  shift: binary((a, b, context) => rotateOrShift(a, b, context, false)),
  sqrt: unary(squareRoot),
  to_integral: {
    arity: 1,
    names: [],
    rounding: true,
    run: ([a], context, rounding) => toIntegralValue(a, rounding ?? context.rounding, context),
  },
  to_integral_exact: {
    arity: 1,
    names: [],
    rounding: true,
    run: ([a], context, rounding) => toIntegralExact(a, rounding ?? context.rounding, context),
  },
  to_integral_value: {
    arity: 1,
    names: [],
    rounding: true,
    run: ([a], context, rounding) => toIntegralValue(a, rounding ?? context.rounding, context),
  },
  canonical: unary((value) => value, { contextFree: true }),
  copy_decimal: unary((value) => value, { contextOnly: true }),
};

/** The operators a Decimal defines with the arithmetic of the operations above. */
export const OPERATORS: [string, (a: Dec, b: Dec, context: DecimalContext) => Dec][] = [
  ['add', add],
  ['sub', subtract],
  ['mul', times],
  ['truediv', divide],
];
