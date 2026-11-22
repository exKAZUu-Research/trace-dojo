// code-gauge-allow-file fileNcss -- Groups the related standard library operations that share this module.
import {
  checked,
  divCeil,
  divExact,
  divFloor,
  divTrunc,
  floatMod,
  floatRem,
  intCast,
  mod,
  PANIC,
  panic,
  rem,
} from '../arith';
import type { Expression, Span } from '../ast';
import { fusedMultiplyAdd, intFittingRange, roundFloat } from '../builtins';
import { log2IntType } from '../expressions';
import {
  type AnyFloat,
  asBigFloat,
  BigFloat,
  compareFloats,
  floatArithmetic,
  type FloatBits,
  floatFromBigInt,
  floatOf,
  floatSqrt,
  FORMATS,
  integerSqrt,
  isInfinite,
  isNaNFloat,
  minMaxFloat,
  negate,
  parseFloatLiteral,
  signBit,
  truncateToBigInt,
} from '../floats';
import { spendIntegerOperation, spendIntegerShift } from '../integerWork';
import { spendMemory } from '../memoryAccounting';
import { isArithmeticType, isIntegerType } from '../operands';
import { referenceBinary, referenceUnary } from '../referenceMath';
import type { BinaryOperation, UnaryOperation } from '../referenceMathOperations';
import { ZigPanic } from '../runtime';
import { known, type NativeCall, runtime, type SemaApi, staticResultOf, type TExpr } from '../semaBase';
import {
  BOOL,
  COMPTIME_FLOAT,
  COMPTIME_INT,
  errorSetOf,
  errorUnionOf,
  fitsInt,
  type FloatType,
  fnType,
  type IntType,
  intType,
  maxInt,
  minInt,
  optionalOf,
  type StructType,
  TYPE,
  type Type,
  typeName,
} from '../types';
import { ErrorValue, NULL, type Value } from '../values';
import {
  compareScalars,
  computed,
  generic,
  nativeBudget,
  ORDER,
  ORDER_EQ,
  ORDER_GT,
  ORDER_LT,
  orderValue,
} from './common';
import { nativeEnum } from './heap';
import { addMembers, compileArgs, expectArgs, fnMember, type Member, nativeStruct, typeMember } from './native';

type FloatDomain = 'float' | 'comptime' | 'numeric' | 'f32-f64' | 'angle';

function floatArg(sema: SemaApi, arg: Expression, domain: FloatDomain): TExpr {
  let compiled = sema.compile(arg);
  if (domain === 'angle' && compiled.type.kind === 'comptime_int')
    compiled = sema.coerce(compiled, COMPTIME_FLOAT, arg);
  checkFloatDomain(sema, compiled.type, domain, arg);
  return compiled;
}

function checkFloatDomain(sema: SemaApi, type: Type, domain: FloatDomain, span: Expression): void {
  if (type.kind === 'float' && (domain !== 'f32-f64' || type.bits === 32 || type.bits === 64)) return;
  if (type.kind === 'comptime_float' && (domain === 'comptime' || domain === 'numeric' || domain === 'angle')) return;
  if (isIntegerType(type) && domain === 'numeric') return;
  sema.error(span, `この数学関数には ${typeName(type)} 型を渡せません。`);
}

function bitsOf(type: Type): 16 | 32 | 64 | 80 | 128 {
  return type.kind === 'float' ? type.bits : 128;
}

function unaryFloat(name: `std.math.${UnaryOperation}`, domain: FloatDomain = 'f32-f64'): () => Member {
  return fnMember(name, unaryFloatCall(name, domain));
}

function unaryFloatCall(
  name: `std.math.${UnaryOperation}`,
  domain: FloatDomain
): (sema: SemaApi, call: NativeCall) => TExpr {
  return (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, name);
    const value = floatArg(sema, arg, domain);
    const bits = bitsOf(value.type);
    const operation = name.slice('std.math.'.length) as UnaryOperation;
    return computed(value.type, [value], call.span, ([x]) => referenceUnary(operation, bits, x as AnyFloat));
  };
}

/** `log2` and `log10`, which give the floor of the logarithm for integers and the logarithm for floats. */
function logarithm(name: 'std.math.log2' | 'std.math.log10', base: bigint): () => Member {
  const forFloats = unaryFloatCall(name, 'comptime');
  return fnMember(name, (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, name);
    const value = sema.compile(arg);
    const type = value.type;
    if (type.kind !== 'int' && type.kind !== 'comptime_int') return forFloats(sema, call);
    if (base === 10n && type.kind === 'int' && type.signed) {
      return sema.error(call.span, `${name} は符号付き整数には使えません（${typeName(type)} 型です）。`);
    }
    const unsigned = type.kind === 'int' && type.signed ? intType(false, Math.max(0, type.bits - 1)) : undefined;
    return computed(type, [value], call.span, ([x], frame) => {
      const input = x as bigint;
      return integerLogarithm(base, unsigned ? intCast(input, unsigned) : input, nativeBudget(sema, frame));
    });
  });
}

function integerLogarithm(base: bigint, value: bigint, spend: (cost: number) => void): bigint {
  if (base <= 1n || value <= 0n) panic(PANIC.unreachable);
  const bits = value.toString(2).length;
  spend(bits);
  if (base === 2n) return BigInt(bits - 1);
  if (base === 10n) return BigInt(value.toString().length - 1);
  let result = 0n;
  while (value >= base) {
    spendIntegerOperation(value, base, 'read', spend);
    value /= base;
    result++;
  }
  return result;
}

function integerLog2Ceil(value: bigint): bigint {
  if (value === 0n) panic(PANIC.unreachable);
  if (value === 1n) return 0n;
  const width = (value - 1n).toString(2).length;
  spendMemory(width + 1);
  return BigInt(width);
}

function powerOfTwo(exponent: bigint): bigint {
  spendIntegerShift(1n, exponent, true, spendMemory);
  return 1n << exponent;
}

/** The integer part of a float, or a bound past the type for an infinity, for `lossyCast`'s clamping. */
function truncateOrInfinite(value: AnyFloat, type: IntType): bigint {
  if (isInfinite(value)) return signBit(value) ? minInt(type) - 1n : maxInt(type) + 1n;
  return truncateToBigInt(value);
}

/** `ang * rad_per_deg` and `ang * deg_per_rad`, with the decimal constants of Zig's `std.math`. */
function angleConversion(name: string, constant: string): () => Member {
  const factor128 = parseFloatLiteral(constant, 128, () => {});
  return fnMember(name, (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, name);
    const value = floatArg(sema, arg, 'angle');
    const bits = bitsOf(value.type);
    const factor = floatOf(factor128, bits);
    return computed(value.type, [value], call.span, ([x]) => floatArithmetic(x as AnyFloat, factor, '*', bits));
  });
}

function binaryFloat(name: `std.math.${BinaryOperation}`, domain: FloatDomain): () => Member {
  return fnMember(name, (sema, call) => {
    const sourceArgs = expectArgs(sema, call, 2, name);
    const args = sourceArgs.map((arg) => sema.compile(arg));
    const type = sema.peerType(args, call.span);
    checkFloatDomain(sema, type, domain, sourceArgs[0]);
    const [a, b] = args.map((arg) => sema.coerce(arg, type, arg.span));
    const operation = name.slice('std.math.'.length) as BinaryOperation;
    return computed(type, [a, b], call.span, ([x, y]) =>
      referenceBinary(operation, bitsOf(type), x as AnyFloat, y as AnyFloat)
    );
  });
}

function predicate(name: string, test: (value: AnyFloat | bigint) => boolean, domain: FloatDomain): () => Member {
  return fnMember(name, (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, name);
    const value = floatArg(sema, arg, domain);
    return computed(BOOL, [value], call.span, ([x]) => test(x as AnyFloat | bigint));
  });
}

/** A `std.math` function that only calls a builtin, as `std.math.floor` calls `@floor`. */
function builtinAlias(name: string, builtin: string): () => Member {
  return fnMember(name, (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, name);
    const { row, col, endRow } = call.span;
    return sema.compile({ kind: 'builtinCall', row, col, endRow, name: builtin, args: [arg] }, call.resultType);
  });
}

const OVERFLOW_ERROR = errorSetOf(['Overflow']);

/** `std.math.CompareOperator`. */
const COMPARE_OPERATOR = nativeEnum('math.CompareOperator', ['lt', 'lte', 'eq', 'gte', 'gt', 'neq']);

/** Whether a comparison's result (negative, zero, positive, or undefined when unordered) satisfies an operator. */
function compareHolds(order: number | undefined, operator: bigint): boolean {
  if (order === undefined) return operator === 5n;
  return [order < 0, order <= 0, order === 0, order >= 0, order > 0, order !== 0][Number(operator)];
}

addMembers(ORDER as unknown as StructType, {
  invert: fnMember(
    'Order.invert',
    (sema, call) => {
      expectArgs(sema, call, 0, 'invert');
      const self = orderReceiver(sema, call);
      return computed(ORDER, [self], call.span, ([order]) =>
        order === ORDER_LT ? ORDER_GT : order === ORDER_GT ? ORDER_LT : ORDER_EQ
      );
    },
    () => ({ type: fnType([ORDER], ORDER), receiver: true })
  ),
  compare: fnMember(
    'Order.compare',
    (sema, call) => {
      const [opArg] = expectArgs(sema, call, 1, 'compare');
      const self = orderReceiver(sema, call);
      const operator = sema.coerce(sema.compile(opArg, COMPARE_OPERATOR), COMPARE_OPERATOR, opArg);
      return computed(BOOL, [self, operator], call.span, ([order, op]) =>
        compareHolds(order === ORDER_LT ? -1 : order === ORDER_GT ? 1 : 0, op as bigint)
      );
    },
    () => ({ type: fnType([ORDER, COMPARE_OPERATOR], BOOL), receiver: true })
  ),
});

function orderReceiver(sema: SemaApi, call: NativeCall): TExpr {
  const receiver = call.receiver;
  if (!receiver) return sema.error(call.span, 'std.math.Order の値に対して呼び出してください。');
  return sema.coerce(receiver, ORDER, call.span);
}

/** `add`, `sub`, and `mul` of `(T, a, b)`, returning `error.Overflow` when the result does not fit. */
function checkedInt(name: string, operator: '+' | '-' | '*'): () => Member {
  return generic(name, 3, (sema, call, type, args) => {
    const operands = args.map((arg) => sema.coerce(sema.compile(arg, type), type, arg));
    return checkedIntegerResult(sema, type, operands, call.span, operator);
  });
}

function checkedIntegerResult(
  sema: SemaApi,
  type: Type,
  operands: readonly TExpr[],
  span: Span,
  operator: '+' | '-' | '*'
): TExpr {
  if (!isIntegerType(type)) return sema.error(span, '計算する値の型は整数にしてください。');
  return computed(errorUnionOf(OVERFLOW_ERROR, type), operands, span, ([a, b], frame) => {
    const left = a as bigint,
      right = b as bigint;
    spendIntegerOperation(left, right, operator === '*' ? 'multiply' : 'add', nativeBudget(sema, frame));
    const result = operator === '+' ? left + right : operator === '-' ? left - right : left * right;
    return type.kind === 'int' && !fitsInt(result, type) ? ErrorValue.of('Overflow') : result;
  });
}

/** `shl` and `shr` of `(T, a, amount)`: bits shifted out are dropped, and a negative amount shifts the other way. */
function shift(name: string, left: boolean): () => Member {
  return generic(name, 3, (sema, call, type, [aArg, amountArg]) => {
    if (type.kind !== 'int')
      return sema.error(call.span, `${name} には整数の型を渡してください（${typeName(type)} です）。`);
    const a = sema.coerce(sema.compile(aArg, type), type, aArg);
    const amount = sema.compile(amountArg);
    if (amount.type.kind !== 'int' && amount.type.kind !== 'comptime_int') {
      return sema.error(amountArg, `ずらす量は整数にしてください（${typeName(amount.type)} 型です）。`);
    }
    return computed(type, [a, amount], call.span, ([x, n]) => {
      const count = n as bigint;
      return shiftedBy(x as bigint, count < 0n ? -count : count, left === count >= 0n, type);
    });
  });
}

/** Shifts a value by a distance, dropping the bits shifted out; a signed value shifted right keeps its sign. */
function shiftedBy(value: bigint, distance: bigint, toLeft: boolean, type: IntType): bigint {
  if (distance >= BigInt(type.bits)) return !toLeft && value < 0n ? -1n : 0n;
  spendIntegerShift(value, distance, toLeft, spendMemory);
  if (!toLeft) return value >> distance;
  const shifted = value << distance;
  return type.signed ? BigInt.asIntN(type.bits, shifted) : BigInt.asUintN(type.bits, shifted);
}

/** `rotl` and `rotr` of `(T, x, r)` for an unsigned `T`, taking the amount modulo the bit count. */
// code-gauge-allow functionCognitiveComplexity -- Validates the rotation domain before sharing the modulo and bit arithmetic for both directions.
function rotate(name: string, left: boolean): () => Member {
  return generic(name, 3, (sema, call, type, [xArg, amountArg]) => {
    if (type.kind !== 'int' || type.signed) {
      return sema.error(call.span, `${name} には符号なし整数の型を渡してください（${typeName(type)} です）。`);
    }
    const x = sema.coerce(sema.compile(xArg, type), type, xArg);
    let amount = sema.compile(amountArg);
    if (type.bits !== 0) {
      if (amount.type.kind !== 'int' && amount.type.kind !== 'comptime_int')
        return sema.error(amountArg, `${name} の回転量は整数にしてください。`);
      if (amount.type.kind === 'comptime_int') amount = sema.coerce(amount, intType(false, 16), amountArg);
      const countType = intType(false, 16);
      const peer = sema.peerType([amount, runtime(countType, () => BigInt(type.bits), call.span)], amountArg);
      amount = sema.coerce(amount, peer, amountArg);
    }
    return computed(type, [x, amount], call.span, ([value, n]) => {
      if (type.bits === 0) return 0n;
      const bits = BigInt(type.bits);
      const r = (((n as bigint) % bits) + bits) % bits;
      const k = left ? r : (bits - r) % bits;
      const v = value as bigint;
      const high = shiftedBy(v, k, true, type);
      const low = shiftedBy(v, bits - k, false, type);
      spendIntegerOperation(high, low, 'read', spendMemory);
      return high | low;
    });
  });
}

/** A float type's constant `2^exponent`, as `floatEps`, `floatMin`, and `floatTrueMin` give. */
function floatConstant(name: string, exponent: (format: (typeof FORMATS)[FloatBits]) => number): () => Member {
  return generic(name, 1, (sema, call, type) => {
    if (type.kind !== 'float')
      return sema.error(call.span, `${name} には浮動小数点数の型を渡してください（${typeName(type)} です）。`);
    const value = new BigFloat(false, 'finite', 1n, exponent(FORMATS[type.bits]));
    return known(type, floatOf(value, type.bits), call.span);
  });
}

const DIVISION_ERRORS = errorSetOf(['DivisionByZero', 'Overflow']);
const MOD_ERRORS = errorSetOf(['DivisionByZero', 'NegativeDenominator']);

// code-gauge-allow functionCognitiveComplexity -- Shares argument validation and error-union handling across integer division variants.
function intDivision(
  name: string,
  errors: typeof DIVISION_ERRORS,
  compute: (a: bigint, b: bigint) => bigint
): () => Member {
  return generic(name, 3, (sema, call, type, [aArg, bArg]) => {
    if (type.kind === 'float' || type.kind === 'comptime_float')
      return floatDivisionMember(sema, call, name, errors, type, [aArg, bArg]);
    if (type.kind !== 'int' && type.kind !== 'comptime_int')
      return sema.error(call.span, `${name} は数の型にだけ使えます（${typeName(type)} です）。`);
    const a = sema.coerce(sema.compile(aArg, type), type, aArg);
    const b = sema.coerce(sema.compile(bArg, type), type, bArg);
    return checkedDivisionResult(
      computed(errorUnionOf(divisionErrors(type, errors), type), [a, b], call.span, ([x, y], frame) => {
        if ((y as bigint) === 0n) return ErrorValue.of('DivisionByZero');
        if (errors === MOD_ERRORS && (y as bigint) < 0n) return ErrorValue.of('NegativeDenominator');
        let result: bigint;
        try {
          spendIntegerOperation(x as bigint, y as bigint, 'read', nativeBudget(sema, frame));
          result = compute(x as bigint, y as bigint);
        } catch (error) {
          if (error instanceof ZigPanic && error.text === PANIC.exactRemainder)
            return ErrorValue.of('UnexpectedRemainder');
          throw error;
        }
        if (type.kind === 'int' && !fitsInt(result, type)) return ErrorValue.of('Overflow');
        return result;
      }),
      type
    );
  });
}

/** `divTrunc`, `divFloor`, `divCeil`, `mod`, and `rem` of floats, which Zig computes with the builtins. */
function floatDivisionMember(
  sema: SemaApi,
  call: NativeCall,
  name: string,
  errors: typeof DIVISION_ERRORS,
  type: Type,
  [aArg, bArg]: readonly Expression[]
): TExpr {
  const [a, b] = [aArg, bArg].map((arg) => sema.coerce(sema.compile(arg, type), type, arg));
  const operation = name.slice('std.math.'.length);
  const bits = bitsOf(type);
  return checkedDivisionResult(
    computed(errorUnionOf(divisionErrors(type, errors), type), [a, b], call.span, ([x, y]) => {
      const numerator = x as AnyFloat;
      const denominator = y as AnyFloat;
      const order = compareFloats(denominator, 0);
      if (order === 0) return ErrorValue.of('DivisionByZero');
      if (errors === MOD_ERRORS && order !== undefined && order < 0) return ErrorValue.of('NegativeDenominator');
      if (operation === 'mod') return floatMod(numerator, denominator, bits);
      if (operation === 'rem') return floatRem(numerator, denominator, bits);
      const quotient = floatArithmetic(numerator, denominator, '/', bits);
      if (operation === 'divExact') {
        const result = roundFloat('@trunc', quotient, bits);
        return compareFloats(floatArithmetic(result, denominator, '*', bits), numerator) === 0
          ? result
          : ErrorValue.of('UnexpectedRemainder');
      }
      return roundFloat(
        { divTrunc: '@trunc', divFloor: '@floor', divCeil: '@ceil' }[operation] as string,
        quotient,
        bits
      );
    }),
    type
  );
}

function divisionErrors(type: Type, errors: typeof DIVISION_ERRORS): typeof DIVISION_ERRORS {
  return type.kind === 'int' && type.signed
    ? errors
    : errorSetOf([...(errors.names ?? [])].filter((name) => name !== 'Overflow'));
}

function checkedDivisionResult(result: TExpr, type: Type): TExpr {
  if ((type.kind === 'comptime_int' || type.kind === 'comptime_float') && result.known)
    return known(
      errorUnionOf(errorSetOf(result.value instanceof ErrorValue ? [result.value.name] : []), type),
      result.value,
      result.span
    );
  return result;
}

function gcdMember(lcm: boolean): Member {
  const name = lcm ? 'std.math.lcm' : 'std.math.gcd';
  return fnMember(name, (sema, call) => {
    const [aArg, bArg] = expectArgs(sema, call, 2, name);
    const a = sema.compile(aArg);
    const b = sema.compile(bArg, a.type);
    const type = sema.peerType([a, b], call.span);
    if (type.kind !== 'int' && type.kind !== 'comptime_int')
      return sema.error(call.span, `${name} の引数は整数にしてください。`);
    if (
      !lcm &&
      ((type.kind === 'int' && type.signed) ||
        (type.kind === 'comptime_int' &&
          [a, b].some((x) => ((staticResultOf(x)?.value ?? sema.knownValue(x, '最大公約数の引数')) as bigint) < 0n)))
    )
      return sema.error(call.span, 'std.math.gcd の引数は符号なし整数にしてください。');
    return computed(type, [sema.coerce(a, type), sema.coerce(b, type)], call.span, ([x, y], frame) =>
      gcdResult(x as bigint, y as bigint, type, lcm, (cost) =>
        frame ? frame.runtime.spend(cost) : sema.spendCompilation(cost)
      )
    );
  })();
}

function gcdResult(left: bigint, right: bigint, type: Type, lcm: boolean, spend: (cost: number) => void): bigint {
  if (!lcm && left === 0n && right === 0n) panic(PANIC.unreachable);
  const divisor = gcd(left, right, spend);
  if (!lcm) return divisor;
  if (divisor === 0n) return 0n;
  spendIntegerOperation(left, divisor, 'read', spend);
  const quotient = left / divisor;
  spendIntegerOperation(quotient, right, 'multiply', spend);
  const product = quotient * right;
  const result = product < 0n ? -product : product;
  return type.kind === 'int' ? checked(result, type) : result;
}

function gcd(a: bigint, b: bigint, spend: (cost: number) => void): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    spendIntegerOperation(x, y, 'read', spend);
    [x, y] = [y, x % y];
  }
  return x;
}

const POW_ERRORS = errorSetOf(['Overflow', 'Underflow']);

/** `std.math.powi`, transcribed: the power, or the name of the error it returns. */
// code-gauge-allow functionCognitiveComplexity -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
// code-gauge-allow functionNcss -- Keeps checked, metered exponentiation and its numeric edge cases together.
function powi(x: bigint, y: bigint, type: IntType, spend: (cost: number) => void): bigint | 'Overflow' | 'Underflow' {
  const oneOverflows = maxInt(type) < 1n;
  const yEven = !oneOverflows && (y & 1n) === 0n;
  if (x === 1n || y === 0n || (x === -1n && yEven)) return oneOverflows ? 'Overflow' : 1n;
  if (x === -1n) return -1n;
  if (x === 0n) return y > 0n ? 0n : 'Overflow';
  if (y >= BigInt(type.bits)) return 'Overflow';
  if (y < 0n) return 'Underflow';
  let base = x;
  let exponent = y;
  let accumulator = 1n;
  while (exponent > 1n) {
    if ((exponent & 1n) === 1n) {
      spendIntegerOperation(accumulator, base, 'multiply', spend);
      accumulator *= base;
      if (!fitsInt(accumulator, type)) return 'Overflow';
    }
    exponent >>= 1n;
    spendIntegerOperation(base, base, 'multiply', spend);
    base *= base;
    if (!fitsInt(base, type)) return 'Overflow';
  }
  if (exponent === 1n) {
    spendIntegerOperation(accumulator, base, 'multiply', spend);
    accumulator *= base;
    if (!fitsInt(accumulator, type)) return 'Overflow';
  }
  return accumulator;
}

// code-gauge-allow functionCognitiveComplexity -- Implements precision-aware tolerance, equality and special-value rules as one operation.
function approximateEquality(relative: boolean): () => Member {
  const name = relative ? 'std.math.approxEqRel' : 'std.math.approxEqAbs';
  return generic(name, 4, (sema, call, type, args) => {
    if (type.kind !== 'float' && type.kind !== 'comptime_float')
      sema.error(call.span, `${name} には浮動小数点数の型を渡してください。`);
    const values = args.map((arg) => sema.coerce(sema.compile(arg, type), type, arg));
    const bits = bitsOf(type);
    return computed(BOOL, values, call.span, ([x, y, tolerance]) => {
      const a = x as AnyFloat,
        b = y as AnyFloat,
        t = tolerance as AnyFloat;
      const order = compareFloats(t, 0);
      if (order === undefined || (relative ? order <= 0 : order < 0)) panic(PANIC.unreachable);
      if (compareFloats(a, b) === 0) return true;
      if (isNaNFloat(a) || isNaNFloat(b)) return false;
      const difference = absoluteFloat(floatArithmetic(a, b, '-', bits));
      const absA = absoluteFloat(a),
        absB = absoluteFloat(b);
      const limit = relative ? floatArithmetic(compareFloats(absA, absB)! >= 0 ? absA : absB, t, '*', bits) : t;
      return (compareFloats(difference, limit) ?? 1) <= 0;
    });
  });
}

function absoluteFloat(value: AnyFloat): AnyFloat {
  return signBit(value) ? negate(value) : value;
}

const EULER = parseFloatLiteral('2.71828182845904523536028747135266249775724709369995', 128, () => {});

const MEMBERS: Record<string, () => Member> = {
  pi: () => ({
    type: COMPTIME_FLOAT,
    value: parseFloatLiteral('3.14159265358979323846264338327950288419716939937510', 128),
  }),
  e: () => ({
    type: COMPTIME_FLOAT,
    value: EULER,
  }),
  tau: () => ({
    type: COMPTIME_FLOAT,
    value: parseFloatLiteral('6.28318530717958647692528676655900576839433879875021', 128),
  }),
  sqrt2: () => ({
    type: COMPTIME_FLOAT,
    value: parseFloatLiteral('1.414213562373095048801688724209698078569671875376948', 128),
  }),
  ln2: () => ({
    type: COMPTIME_FLOAT,
    value: parseFloatLiteral('0.693147180559945309417232121458176568075500134360255', 128),
  }),
  ln10: () => ({
    type: COMPTIME_FLOAT,
    value: parseFloatLiteral('2.302585092994045684017991454684364207601101488628772', 128),
  }),
  Order: typeMember(() => ORDER),
  maxInt: generic('std.math.maxInt', 1, (sema, call, type) => {
    if (type.kind !== 'int')
      return sema.error(call.span, `std.math.maxInt には整数の型を渡してください（${typeName(type)} です）。`);
    return known(COMPTIME_INT, maxInt(type), call.span);
  }),
  minInt: generic('std.math.minInt', 1, (sema, call, type) => {
    if (type.kind !== 'int')
      return sema.error(call.span, `std.math.minInt には整数の型を渡してください（${typeName(type)} です）。`);
    return known(COMPTIME_INT, minInt(type), call.span);
  }),
  inf: generic('std.math.inf', 1, (sema, call, type) => {
    if (type.kind !== 'float') return sema.error(call.span, 'std.math.inf には浮動小数点数の型を渡してください。');
    return known(type, (type as FloatType).bits <= 64 ? Infinity : new BigFloat(false, 'inf', 0n, 0), call.span);
  }),
  nan: generic('std.math.nan', 1, (sema, call, type) => {
    if (type.kind !== 'float') return sema.error(call.span, 'std.math.nan には浮動小数点数の型を渡してください。');
    return known(type, (type as FloatType).bits <= 64 ? Number.NaN : new BigFloat(false, 'nan', 0n, 0), call.span);
  }),
  floatMax: generic('std.math.floatMax', 1, (sema, call, type) => {
    if (type.kind !== 'float') return sema.error(call.span, 'std.math.floatMax には浮動小数点数の型を渡してください。');
    const bits = (type as FloatType).bits;
    const value =
      bits === 64
        ? Number.MAX_VALUE
        : bits === 32
          ? 3.4028234663852886e38
          : bits === 16
            ? 65_504
            : new BigFloat(
                false,
                'finite',
                (1n << BigInt(FORMATS[bits].precision)) - 1n,
                FORMATS[bits].maxExponent - FORMATS[bits].precision + 1
              );
    return known(type, value, call.span);
  }),
  isNan: predicate('std.math.isNan', (x) => typeof x !== 'bigint' && isNaNFloat(x), 'numeric'),
  isInf: predicate('std.math.isInf', (x) => isInfinite(x as AnyFloat), 'float'),
  isPositiveInf: predicate(
    'std.math.isPositiveInf',
    (x) => isInfinite(x as AnyFloat) && !signBit(x as AnyFloat),
    'comptime'
  ),
  isNegativeInf: predicate(
    'std.math.isNegativeInf',
    (x) => isInfinite(x as AnyFloat) && signBit(x as AnyFloat),
    'comptime'
  ),
  isFinite: predicate('std.math.isFinite', (x) => !isInfinite(x as AnyFloat) && !isNaNFloat(x as AnyFloat), 'float'),
  signbit: predicate('std.math.signbit', (x) => (typeof x === 'bigint' ? x < 0n : signBit(x)), 'numeric'),
  sqrt: fnMember('std.math.sqrt', (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, 'std.math.sqrt');
    const value = sema.compile(arg);
    const type = value.type;
    if (type.kind === 'comptime_int') {
      const integer = (staticResultOf(value)?.value ?? sema.knownValue(value, '整数の平方根')) as bigint;
      if (integer < 0n || integer > maxInt(intType(false, 128)))
        return sema.error(arg, '整数の平方根には、0 以上で u128 の範囲内の値を渡してください。');
      return computed(COMPTIME_INT, [value], call.span, ([x]) => integerSqrt(x as bigint));
    }
    if (type.kind === 'int') {
      if (type.signed) return sema.error(arg, '整数の平方根には、符号なしの整数を渡してください。');
      if (type.bits + 1 > Number(maxInt(intType(false, 16))))
        return sema.error(arg, '整数の平方根の型計算で、u16 の範囲を超えます。');
      const result = intType(false, Math.ceil(type.bits / 2));
      return computed(result, [value], call.span, ([x]) => integerSqrt(x as bigint));
    }
    checkFloatDomain(sema, type, 'comptime', arg);
    return computed(type, [value], call.span, ([x]) => floatSqrt(x as AnyFloat, bitsOf(type)));
  }),
  cbrt: unaryFloat('std.math.cbrt'),
  exp: unaryFloat('std.math.exp', 'comptime'),
  exp2: unaryFloat('std.math.exp2', 'comptime'),
  log2: logarithm('std.math.log2', 2n),
  log10: logarithm('std.math.log10', 10n),
  log1p: unaryFloat('std.math.log1p'),
  acos: unaryFloat('std.math.acos', 'float'),
  asin: unaryFloat('std.math.asin', 'float'),
  atan: unaryFloat('std.math.atan', 'float'),
  sinh: unaryFloat('std.math.sinh'),
  cosh: unaryFloat('std.math.cosh'),
  tanh: unaryFloat('std.math.tanh'),
  degreesToRadians: angleConversion(
    'std.math.degreesToRadians',
    '0.0174532925199432957692369076848861271344287188854172545609719144'
  ),
  radiansToDegrees: angleConversion(
    'std.math.radiansToDegrees',
    '57.295779513082320876798154814105170332405472466564321549160243861'
  ),
  atan2: binaryFloat('std.math.atan2', 'f32-f64'),
  hypot: binaryFloat('std.math.hypot', 'comptime'),
  // code-gauge-allow functionCognitiveComplexity -- Keeps integer and float logarithm analysis with their generated computation.
  log: generic('std.math.log', 3, (sema, call, type, [baseArg, xArg]) => {
    if (!isArithmeticType(type)) return sema.error(call.span, 'std.math.log の型は整数か浮動小数点数にしてください。');
    if (type.kind === 'float' && type.bits !== 32 && type.bits !== 64)
      return sema.error(call.span, 'std.math.log の浮動小数点数の型は f32 か f64 にしてください。');
    const base = sema.coerce(sema.compile(baseArg, type), type, baseArg);
    const x = sema.coerce(sema.compile(xArg, type), type, xArg);
    if (type.kind === 'int' || type.kind === 'comptime_int') {
      if (type.kind === 'int' && type.signed)
        sema.error(call.span, '整数の対数には、符号なし整数の型を渡してください。');
      return computed(type, [base, x], call.span, ([b, v], frame) =>
        integerLogarithm(b as bigint, v as bigint, nativeBudget(sema, frame))
      );
    }
    const bits = bitsOf(type);
    return computed(type, [base, x], call.span, ([b, v]) => {
      if (type.kind !== 'comptime_float') return referenceBinary('logBase', bits, b as AnyFloat, v as AnyFloat);
      if (compareFloats(b as AnyFloat, 2) === 0) return referenceUnary('log2', bits, v as AnyFloat);
      if (compareFloats(b as AnyFloat, 10) === 0) return referenceUnary('log10', bits, v as AnyFloat);
      if (compareFloats(b as AnyFloat, EULER) === 0) return referenceUnary('log', bits, v as AnyFloat);
      return floatOf(asBigFloat(referenceBinary('logBase', 64, b as AnyFloat, v as AnyFloat)), bits);
    });
  }),
  pow: generic('std.math.pow', 3, (sema, call, type, [xArg, yArg]) => {
    const x = sema.coerce(sema.compile(xArg, type), type, xArg);
    const y = sema.coerce(sema.compile(yArg, type), type, yArg);
    if (type.kind === 'int') {
      return computed(type, [x, y], call.span, ([a, b], frame) => {
        const result = powi(a as bigint, b as bigint, type, nativeBudget(sema, frame));
        if (typeof result === 'string') panic(`attempt to unwrap error: ${result}`);
        return result;
      });
    }
    if (type.kind !== 'float' || (type.bits !== 32 && type.bits !== 64))
      return sema.error(call.span, `std.math.pow は ${typeName(type)} 型には使えません（f32 か f64 にしてください）。`);
    return computed(type, [x, y], call.span, ([a, b]) =>
      referenceBinary('pow', bitsOf(type), a as AnyFloat, b as AnyFloat)
    );
  }),
  powi: generic('std.math.powi', 3, (sema, call, type, [xArg, yArg]) => {
    if (type.kind !== 'int') return sema.error(call.span, 'std.math.powi は整数の型にだけ使えます。');
    const x = sema.coerce(sema.compile(xArg, type), type, xArg);
    const y = sema.coerce(sema.compile(yArg, type), type, yArg);
    return computed(errorUnionOf(POW_ERRORS, type), [x, y], call.span, ([a, b], frame) => {
      const result = powi(a as bigint, b as bigint, type, nativeBudget(sema, frame));
      return typeof result === 'string' ? ErrorValue.of(result) : result;
    });
  }),
  // code-gauge-allow functionCognitiveComplexity -- Keeps numeric type checks, ordered-bound assertions, and float min/max behavior together.
  clamp: fnMember('std.math.clamp', (sema, call) => {
    const [valueArg, lowArg, highArg] = expectArgs(sema, call, 3, 'std.math.clamp');
    const parts = [valueArg, lowArg, highArg].map((arg) => sema.compile(arg));
    const runtimeType = parts.find((part) => part.type.kind === 'int' || part.type.kind === 'float')?.type;
    const operands = runtimeType ? [valueArg, lowArg, highArg].map((arg) => sema.compile(arg, runtimeType)) : parts;
    const type = sema.peerType(operands, call.span);
    if (!['int', 'comptime_int', 'float', 'comptime_float'].includes(type.kind))
      return sema.error(call.span, 'std.math.clamp の引数は数にしてください。');
    const coerced = operands.map((operand) => sema.coerce(operand, type, operand.span));
    return computed(type, coerced, call.span, ([v, low, high]) => {
      if (type.kind === 'float' || type.kind === 'comptime_float') {
        const order = compareFloats(low as AnyFloat, high as AnyFloat);
        if (order === undefined || order > 0) panic(PANIC.unreachable);
        return minMaxFloat(
          low as AnyFloat,
          minMaxFloat(v as AnyFloat, high as AnyFloat, false, type.kind === 'comptime_float'),
          true,
          type.kind === 'comptime_float'
        );
      }
      if (compareScalarsAny(low, high) > 0) panic(PANIC.unreachable);
      return compareScalarsAny(v, low) < 0 ? low : compareScalarsAny(v, high) > 0 ? high : v;
    });
  }),
  order: fnMember('std.math.order', (sema, call) => {
    const [aArg, bArg] = expectArgs(sema, call, 2, 'std.math.order');
    const [a, b] = comparisonOperands(sema, aArg, bArg);
    return computed(ORDER, [a, b], call.span, ([x, y]) => {
      // Zig's `order` reaches `unreachable` when neither `<`, `==`, nor `>` holds, as for NaN.
      if ([x, y].some((value) => typeof value !== 'bigint' && isNaNFloat(value as AnyFloat))) panic(PANIC.unreachable);
      return orderValue(compareScalarsAny(x, y));
    });
  }),
  divTrunc: intDivision('std.math.divTrunc', DIVISION_ERRORS, (a, b) => divTrunc(a, b, undefined)),
  divFloor: intDivision('std.math.divFloor', DIVISION_ERRORS, (a, b) => divFloor(a, b, undefined)),
  divCeil: intDivision('std.math.divCeil', DIVISION_ERRORS, (a, b) => divCeil(a, b, undefined)),
  divExact: intDivision(
    'std.math.divExact',
    errorSetOf(['DivisionByZero', 'Overflow', 'UnexpectedRemainder']),
    (a, b) => divExact(a, b, undefined)
  ),
  mod: intDivision('std.math.mod', MOD_ERRORS, (a, b) => mod(a, b)),
  rem: intDivision('std.math.rem', MOD_ERRORS, (a, b) => rem(a, b)),
  gcd: () => gcdMember(false),
  lcm: () => gcdMember(true),
  CompareOperator: typeMember(() => COMPARE_OPERATOR),
  compare: fnMember('std.math.compare', (sema, call) => {
    const [aArg, opArg, bArg] = expectArgs(sema, call, 3, 'std.math.compare');
    const [a, b] = comparisonOperands(sema, aArg, bArg);
    const operator = sema.coerce(sema.compile(opArg, COMPARE_OPERATOR), COMPARE_OPERATOR, opArg);
    return computed(BOOL, [a, operator, b], call.span, ([x, op, y]) => {
      const unordered = [x, y].some((value) => typeof value !== 'bigint' && isNaNFloat(value as AnyFloat));
      return compareHolds(unordered ? undefined : compareScalarsAny(x, y), op as bigint);
    });
  }),
  floorPowerOfTwo: generic('std.math.floorPowerOfTwo', 2, (sema, call, type, [valueArg]) => {
    if (type.kind !== 'int')
      return sema.error(call.span, `std.math.floorPowerOfTwo には整数の型を渡してください（${typeName(type)} です）。`);
    const value = sema.coerce(sema.compile(valueArg, type), type, valueArg);
    return computed(type, [value], call.span, ([x]) => {
      const n = x as bigint;
      return n <= 0n ? 0n : powerOfTwo(integerLogarithm(2n, n, spendMemory));
    });
  }),
  ceilPowerOfTwo: generic('std.math.ceilPowerOfTwo', 2, (sema, call, type, [valueArg]) => {
    if (type.kind !== 'int' || type.signed) {
      return sema.error(
        call.span,
        `std.math.ceilPowerOfTwo には符号なし整数の型を渡してください（${typeName(type)} です）。`
      );
    }
    const value = sema.coerce(sema.compile(valueArg, type), type, valueArg);
    return computed(errorUnionOf(OVERFLOW_ERROR, type), [value], call.span, ([x]) => {
      const exponent = integerLog2Ceil(x as bigint);
      return exponent < BigInt(type.bits) ? powerOfTwo(exponent) : ErrorValue.of('Overflow');
    });
  }),
  log2_int_ceil: generic('std.math.log2_int_ceil', 2, (sema, call, type, [xArg]) => {
    if (type.kind !== 'int' || type.signed) {
      return sema.error(
        call.span,
        `std.math.log2_int_ceil には符号なし整数の型を渡してください（${typeName(type)} です）。`
      );
    }
    const x = sema.coerce(sema.compile(xArg, type), type, xArg);
    return computed(log2IntType(intType(false, type.bits + 1)), [x], call.span, ([value]) =>
      integerLog2Ceil(value as bigint)
    );
  }),
  copysign: fnMember('std.math.copysign', (sema, call) => {
    const [magnitudeArg, signArg] = expectArgs(sema, call, 2, 'std.math.copysign');
    const magnitude = floatArg(sema, magnitudeArg, 'float');
    const sign = sema.coerce(sema.compile(signArg, magnitude.type), magnitude.type, signArg);
    return computed(magnitude.type, [magnitude, sign], call.span, ([m, s]) =>
      signBit(m as AnyFloat) === signBit(s as AnyFloat) ? m : negate(m as AnyFloat)
    );
  }),
  isPositiveZero: predicate(
    'std.math.isPositiveZero',
    (x) => compareFloats(x as AnyFloat, 0) === 0 && !signBit(x as AnyFloat),
    'float'
  ),
  isNegativeZero: predicate(
    'std.math.isNegativeZero',
    (x) => compareFloats(x as AnyFloat, 0) === 0 && signBit(x as AnyFloat),
    'float'
  ),
  asinh: unaryFloat('std.math.asinh'),
  acosh: unaryFloat('std.math.acosh'),
  atanh: unaryFloat('std.math.atanh'),
  expm1: unaryFloat('std.math.expm1'),
  isNormal: fnMember('std.math.isNormal', (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, 'std.math.isNormal');
    const value = floatArg(sema, arg, 'float');
    const minExponent = FORMATS[bitsOf(value.type)].minExponent;
    return computed(BOOL, [value], call.span, ([x]) => {
      if (isNaNFloat(x as AnyFloat) || isInfinite(x as AnyFloat)) return false;
      const big = asBigFloat(x as AnyFloat);
      return !big.isZero && big.exponent + big.mantissa.toString(2).length - 1 >= minExponent;
    });
  }),
  ldexp: fnMember('std.math.ldexp', (sema, call) => {
    const [xArg, nArg] = expectArgs(sema, call, 2, 'std.math.ldexp');
    const x = floatArg(sema, xArg, 'float');
    const n = sema.coerce(sema.compile(nArg, intType(true, 32)), intType(true, 32), nArg);
    const bits = bitsOf(x.type);
    return computed(x.type, [x, n], call.span, ([value, exponent]) => {
      const big = asBigFloat(value as AnyFloat);
      if (big.kind !== 'finite' || big.isZero) return value;
      // Scaling by a power of two is exact until the result rounds to the type.
      return floatOf(new BigFloat(big.sign, 'finite', big.mantissa, big.exponent + Number(exponent as bigint)), bits);
    });
  }),
  log10_int: fnMember('std.math.log10_int', (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, 'std.math.log10_int');
    const value = sema.compile(arg);
    const type = value.type;
    if (type.kind !== 'int' || type.signed) {
      return sema.error(arg, `std.math.log10_int には符号なし整数を渡してください（${typeName(type)} 型です）。`);
    }
    return computed(log2IntType(type), [value], call.span, ([x]) => integerLogarithm(10n, x as bigint, spendMemory));
  }),
  // code-gauge-allow functionCognitiveComplexity -- Validates numeric domains before selecting integer clamping or float conversion.
  lossyCast: generic('std.math.lossyCast', 2, (sema, call, type, [valueArg]) => {
    const value = sema.compile(valueArg);
    if (!isArithmeticType(value.type)) return sema.error(valueArg, 'std.math.lossyCast の値は数にしてください。');
    if (type.kind === 'float') {
      return computed(type, [value], call.span, ([x]) =>
        typeof x === 'bigint' ? floatFromBigInt(x, type.bits) : floatOf(asBigFloat(x as AnyFloat), type.bits)
      );
    }
    if (type.kind !== 'int')
      return sema.error(call.span, `std.math.lossyCast には数の型を渡してください（${typeName(type)} です）。`);
    return computed(type, [value], call.span, ([x]) => {
      if (typeof x !== 'bigint' && isNaNFloat(x as AnyFloat)) return 0n;
      const n = typeof x === 'bigint' ? x : truncateOrInfinite(x as AnyFloat, type);
      return n >= maxInt(type) ? maxInt(type) : n <= minInt(type) ? minInt(type) : n;
    });
  }),
  floor: builtinAlias('std.math.floor', '@floor'),
  ceil: builtinAlias('std.math.ceil', '@ceil'),
  round: builtinAlias('std.math.round', '@round'),
  trunc: builtinAlias('std.math.trunc', '@trunc'),
  sin: builtinAlias('std.math.sin', '@sin'),
  cos: builtinAlias('std.math.cos', '@cos'),
  tan: builtinAlias('std.math.tan', '@tan'),
  // code-gauge-allow functionCognitiveComplexity -- Resolves the sign result type and value for integer and float arguments.
  sign: fnMember('std.math.sign', (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, 'std.math.sign');
    const value = sema.compile(arg);
    const type = value.type;
    let result: Type;
    if (type.kind === 'comptime_int' || type.kind === 'comptime_float') result = COMPTIME_INT;
    else if (type.kind === 'int') result = intType(type.signed, Math.min(type.bits, type.signed ? 2 : 1));
    else if (type.kind === 'float') result = intFittingRange(-1n, 1n, sema, call.span);
    else return sema.error(arg, `std.math.sign には数を渡してください（${typeName(type)} 型です）。`);
    return computed(result, [value], call.span, ([x]) => {
      const order = typeof x === 'bigint' ? (x > 0n ? 1 : x < 0n ? -1 : 0) : (compareFloats(x as AnyFloat, 0) ?? 0);
      if (result.kind === 'int') {
        const positive = intCast(order > 0 ? 1n : 0n, result);
        const negative = intCast(order < 0 ? 1n : 0n, result);
        return positive - negative;
      }
      return BigInt(order);
    });
  }),
  add: checkedInt('std.math.add', '+'),
  sub: checkedInt('std.math.sub', '-'),
  mul: checkedInt('std.math.mul', '*'),
  negate: fnMember('std.math.negate', (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, 'std.math.negate');
    const value = sema.compile(arg);
    return checkedIntegerResult(sema, value.type, [known(value.type, 0n, call.span), value], call.span, '-');
  }),
  shl: shift('std.math.shl', true),
  shr: shift('std.math.shr', false),
  rotl: rotate('std.math.rotl', true),
  rotr: rotate('std.math.rotr', false),
  log2_int: generic('std.math.log2_int', 2, (sema, call, type, [xArg]) => {
    if (type.kind !== 'int' || type.signed) {
      return sema.error(
        call.span,
        `std.math.log2_int には符号なし整数の型を渡してください（${typeName(type)} です）。`
      );
    }
    const x = sema.coerce(sema.compile(xArg, type), type, xArg);
    return computed(log2IntType(type), [x], call.span, ([value]) => integerLogarithm(2n, value as bigint, spendMemory));
  }),
  floatEps: floatConstant('std.math.floatEps', (format) => 1 - format.precision),
  floatMin: floatConstant('std.math.floatMin', (format) => format.minExponent),
  floatTrueMin: floatConstant('std.math.floatTrueMin', (format) => format.minExponent - (format.precision - 1)),
  approxEqRel: approximateEquality(true),
  lerp: fnMember('std.math.lerp', (sema, call) => {
    const args = expectArgs(sema, call, 3, 'std.math.lerp').map((arg) => sema.compile(arg));
    const type = sema.peerType(args, call.span);
    if (type.kind !== 'float' && type.kind !== 'comptime_float') {
      return sema.error(call.span, `std.math.lerp には浮動小数点数を渡してください（${typeName(type)} 型です）。`);
    }
    const bits = bitsOf(type);
    const coerced = args.map((arg) => sema.coerce(arg, type, arg.span));
    return computed(type, coerced, call.span, ([a, b, t], frame) => {
      // `@mulAdd(T, b - a, t, a)`, rounding once after the product and the sum.
      const difference = asBigFloat(floatArithmetic(b as AnyFloat, a as AnyFloat, '-', bits));
      return fusedMultiplyAdd(
        difference,
        asBigFloat(t as AnyFloat),
        asBigFloat(a as AnyFloat),
        bits,
        nativeBudget(sema, frame)
      );
    });
  }),
  isPowerOfTwo: fnMember('std.math.isPowerOfTwo', (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, 'std.math.isPowerOfTwo');
    const value = sema.compile(arg);
    if (!isIntegerType(value.type)) return sema.error(arg, 'std.math.isPowerOfTwo の値は整数にしてください。');
    return computed(BOOL, [value], call.span, ([x]) => {
      const n = x as bigint;
      if (n <= 0n) panic(PANIC.unreachable);
      spendIntegerOperation(n, 1n, 'read', spendMemory);
      return (n & (n - 1n)) === 0n;
    });
  }),
  cast: generic('std.math.cast', 2, (sema, call, type, [valueArg]) => {
    if (type.kind !== 'int') return sema.error(call.span, 'std.math.cast には整数の型を渡してください。');
    const value = sema.compile(valueArg);
    if (!isIntegerType(value.type)) return sema.error(valueArg, 'std.math.cast の値は整数にしてください。');
    return computed(optionalOf(type), [value], call.span, ([x]) => (fitsInt(x as bigint, type) ? x : NULL));
  }),
  IntFittingRange: fnMember('std.math.IntFittingRange', (sema, call) => {
    const [lowArg, highArg] = expectArgs(sema, call, 2, 'std.math.IntFittingRange');
    const [low, high] = compileArgs(sema, [lowArg, highArg], [COMPTIME_INT, COMPTIME_INT]).map(
      (value) => sema.knownValue(value, '範囲') as bigint
    );
    return known(TYPE, intFittingRange(low, high, sema, call.span), call.span);
  }),
  Log2Int: generic('std.math.Log2Int', 1, (sema, call, type) => {
    if (type.kind === 'comptime_int') return known(TYPE, type, call.span);
    if (type.kind !== 'int') return sema.error(call.span, 'std.math.Log2Int には整数の型を渡してください。');
    if (type.bits === 0)
      return sema.error(call.span, 'std.math.Log2Int にはビット数が 1 以上の整数型を渡してください。');
    let bits = 0;
    while (2 ** bits < type.bits) bits++;
    return known(TYPE, intType(false, bits), call.span);
  }),
  approxEqAbs: approximateEquality(false),
};

function comparisonOperands(sema: SemaApi, a: Expression, b: Expression): [TExpr, TExpr] {
  const operands = [sema.compile(a), sema.compile(b)] as const;
  for (const operand of operands)
    if (!isArithmeticType(operand.type)) sema.error(operand.span, '大小を比べる引数は数にしてください。');
  if (operands.every((operand) => isIntegerType(operand.type))) return [...operands];
  const type = sema.peerType(operands, a);
  return [sema.coerce(operands[0], type, a), sema.coerce(operands[1], type, b)];
}

function compareScalarsAny(a: Value, b: Value): number {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    if (typeof a === 'bigint' && typeof b === 'bigint') return compareScalars(a, b);
    const x = typeof a === 'bigint' ? floatFromBigInt(a, 128) : (a as AnyFloat);
    const y = typeof b === 'bigint' ? floatFromBigInt(b, 128) : (b as AnyFloat);
    return compareFloats(x, y) ?? 0;
  }
  return compareFloats(a as AnyFloat, b as AnyFloat) ?? 0;
}

let math: StructType | undefined;

export function mathNamespace(): StructType {
  math ??= nativeStruct('std.math', MEMBERS);
  return math;
}

export { floatOf };
