import { divCeil, divExact, divFloor, divTrunc, mod, PANIC, panic, rem } from '../arith';
import type { Expression } from '../ast';
import { intFittingRange } from '../builtins';
import {
  type AnyFloat,
  asBigFloat,
  BigFloat,
  compareFloats,
  floatFromBigInt,
  floatOf,
  floatSqrt,
  isInfinite,
  isNaNFloat,
  parseFloatLiteral,
  roundNumber,
  roundTo,
  signBit,
  toNumber,
} from '../floats';
import { known, type SemaApi, type TExpr } from '../semaBase';
import {
  BOOL,
  COMPTIME_FLOAT,
  errorSetOf,
  errorUnionOf,
  fitsInt,
  type FloatType,
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
import { compareScalars, computed, generic, ORDER, orderValue } from './common';
import { expectArgs, fnMember, type Member, nativeStruct, typeMember } from './native';

function floatArg(sema: SemaApi, arg: Expression, type?: Type): TExpr {
  let compiled = sema.compile(arg, type);
  if (compiled.type.kind === 'comptime_int') compiled = sema.coerce(compiled, type ?? COMPTIME_FLOAT, arg);
  if (compiled.type.kind !== 'float' && compiled.type.kind !== 'comptime_float') {
    sema.error(arg, `浮動小数点数が必要です（${typeName(compiled.type)} 型です）。`);
  }
  return compiled;
}

function bitsOf(type: Type): 16 | 32 | 64 | 80 | 128 {
  return type.kind === 'float' ? type.bits : 128;
}

/** A function of one float, computed in double precision and rounded to its type, as `std.math` does for f32/f64. */
function unaryFloat(name: string, compute: (x: number) => number): () => Member {
  return fnMember(name, (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, name);
    const value = floatArg(sema, arg, call.resultType?.kind === 'float' ? call.resultType : undefined);
    const bits = bitsOf(value.type);
    return computed(value.type, [value], call.span, ([x]) => fromDouble(compute(toDouble(x as AnyFloat)), bits));
  });
}

function toDouble(value: AnyFloat): number {
  return typeof value === 'number' ? value : toNumber(value);
}

function fromDouble(value: number, bits: 16 | 32 | 64 | 80 | 128): AnyFloat {
  return bits <= 64 ? roundNumber(value, bits as 16 | 32 | 64) : roundTo(asBigFloat(value), bits);
}

function predicate(name: string, test: (value: AnyFloat) => boolean): () => Member {
  return fnMember(name, (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, name);
    const value = floatArg(sema, arg);
    return computed(BOOL, [value], call.span, ([x]) => test(x as AnyFloat));
  });
}

class UnexpectedRemainder extends Error {}

const DIVISION_ERRORS = errorSetOf(['DivisionByZero', 'Overflow']);
const MOD_ERRORS = errorSetOf(['DivisionByZero', 'NegativeDenominator']);

// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function intDivision(
  name: string,
  errors: typeof DIVISION_ERRORS,
  compute: (a: bigint, b: bigint, type: IntType) => bigint
): () => Member {
  return generic(name, 3, (sema, call, type, [aArg, bArg]) => {
    if (type.kind !== 'int')
      return sema.error(call.span, `${name} は整数の型にだけ使えます（${typeName(type)} です）。`);
    const a = sema.coerce(sema.compile(aArg, type), type, aArg);
    const b = sema.coerce(sema.compile(bArg, type), type, bArg);
    return computed(errorUnionOf(errors, type), [a, b], call.span, ([x, y]) => {
      if ((y as bigint) === 0n) return ErrorValue.of('DivisionByZero');
      if (errors === MOD_ERRORS && (y as bigint) < 0n) return ErrorValue.of('NegativeDenominator');
      let result: bigint;
      try {
        result = compute(x as bigint, y as bigint, type);
      } catch (error) {
        if (error instanceof UnexpectedRemainder) return ErrorValue.of('UnexpectedRemainder');
        throw error;
      }
      if (!fitsInt(result, type)) return ErrorValue.of('Overflow');
      return result;
    });
  });
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

const POW_ERRORS = errorSetOf(['Overflow', 'Underflow']);

const MEMBERS: Record<string, () => Member> = {
  pi: () => ({
    type: COMPTIME_FLOAT,
    value: parseFloatLiteral('3.14159265358979323846264338327950288419716939937510', 128),
  }),
  e: () => ({
    type: COMPTIME_FLOAT,
    value: parseFloatLiteral('2.71828182845904523536028747135266249775724709369995', 128),
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
    return known({ kind: 'comptime_int' }, maxInt(type), call.span);
  }),
  minInt: generic('std.math.minInt', 1, (sema, call, type) => {
    if (type.kind !== 'int')
      return sema.error(call.span, `std.math.minInt には整数の型を渡してください（${typeName(type)} です）。`);
    return known({ kind: 'comptime_int' }, minInt(type), call.span);
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
            : roundTo(parseFloatLiteral('1e5000', bits), bits);
    return known(type, value, call.span);
  }),
  isNan: predicate('std.math.isNan', (x) => isNaNFloat(x)),
  isInf: predicate('std.math.isInf', (x) => isInfinite(x)),
  isPositiveInf: predicate('std.math.isPositiveInf', (x) => isInfinite(x) && !signBit(x)),
  isNegativeInf: predicate('std.math.isNegativeInf', (x) => isInfinite(x) && signBit(x)),
  isFinite: predicate('std.math.isFinite', (x) => !isInfinite(x) && !isNaNFloat(x)),
  signbit: predicate('std.math.signbit', (x) => signBit(x)),
  sqrt: fnMember('std.math.sqrt', (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, 'std.math.sqrt');
    const value = sema.compile(arg, call.resultType);
    const type = value.type;
    if (type.kind === 'int') {
      const result = intType(false, Math.ceil(type.bits / 2));
      return computed(result, [value], call.span, ([x]) => {
        let root = 0n;
        while ((root + 1n) * (root + 1n) <= (x as bigint)) root++;
        return root;
      });
    }
    const float = floatArg(sema, arg);
    return computed(float.type, [float], call.span, ([x]) => floatSqrt(x as AnyFloat, bitsOf(float.type)));
  }),
  cbrt: unaryFloat('std.math.cbrt', Math.cbrt),
  exp: unaryFloat('std.math.exp', Math.exp),
  exp2: unaryFloat('std.math.exp2', (x) => 2 ** x),
  log2: unaryFloat('std.math.log2', Math.log2),
  log10: unaryFloat('std.math.log10', Math.log10),
  log1p: unaryFloat('std.math.log1p', Math.log1p),
  acos: unaryFloat('std.math.acos', Math.acos),
  asin: unaryFloat('std.math.asin', Math.asin),
  atan: unaryFloat('std.math.atan', Math.atan),
  sinh: unaryFloat('std.math.sinh', Math.sinh),
  cosh: unaryFloat('std.math.cosh', Math.cosh),
  tanh: unaryFloat('std.math.tanh', Math.tanh),
  degreesToRadians: unaryFloat('std.math.degreesToRadians', (x) => x * (Math.PI / 180)),
  radiansToDegrees: unaryFloat('std.math.radiansToDegrees', (x) => x * (180 / Math.PI)),
  atan2: fnMember('std.math.atan2', (sema, call) => {
    const [yArg, xArg] = expectArgs(sema, call, 2, 'std.math.atan2');
    const y = floatArg(sema, yArg);
    const x = sema.coerce(floatArg(sema, xArg, y.type), y.type, xArg);
    return computed(y.type, [y, x], call.span, ([a, b]) =>
      fromDouble(Math.atan2(toDouble(a as AnyFloat), toDouble(b as AnyFloat)), bitsOf(y.type))
    );
  }),
  hypot: fnMember('std.math.hypot', (sema, call) => {
    const [xArg, yArg] = expectArgs(sema, call, 2, 'std.math.hypot');
    const x = floatArg(sema, xArg);
    const y = sema.coerce(floatArg(sema, yArg, x.type), x.type, yArg);
    return computed(x.type, [x, y], call.span, ([a, b]) =>
      fromDouble(Math.hypot(toDouble(a as AnyFloat), toDouble(b as AnyFloat)), bitsOf(x.type))
    );
  }),
  log: generic('std.math.log', 3, (sema, call, type, [baseArg, xArg]) => {
    const base = sema.coerce(sema.compile(baseArg, type), type, baseArg);
    const x = sema.coerce(sema.compile(xArg, type), type, xArg);
    if (type.kind === 'int') {
      return computed(type, [base, x], call.span, ([b, v]) => {
        let result = 0n;
        let value = v as bigint;
        while (value >= (b as bigint)) {
          value /= b as bigint;
          result++;
        }
        return result;
      });
    }
    return computed(type, [base, x], call.span, ([b, v]) =>
      fromDouble(Math.log(toDouble(v as AnyFloat)) / Math.log(toDouble(b as AnyFloat)), bitsOf(type))
    );
  }),
  pow: generic('std.math.pow', 3, (sema, call, type, [xArg, yArg]) => {
    const x = sema.coerce(sema.compile(xArg, type), type, xArg);
    const y = sema.coerce(sema.compile(yArg, type), type, yArg);
    if (type.kind === 'int') {
      return computed(type, [x, y], call.span, ([a, b]) => {
        const result = integerPower(a as bigint, b as bigint);
        if (result === undefined || !fitsInt(result, type)) panic(PANIC.unreachable);
        return result;
      });
    }
    return computed(type, [x, y], call.span, ([a, b]) =>
      fromDouble(toDouble(a as AnyFloat) ** toDouble(b as AnyFloat), bitsOf(type))
    );
  }),
  powi: generic('std.math.powi', 3, (sema, call, type, [xArg, yArg]) => {
    if (type.kind !== 'int') return sema.error(call.span, 'std.math.powi は整数の型にだけ使えます。');
    const x = sema.coerce(sema.compile(xArg, type), type, xArg);
    const y = sema.coerce(sema.compile(yArg, type), type, yArg);
    return computed(errorUnionOf(POW_ERRORS, type), [x, y], call.span, ([a, b]) => {
      const result = integerPower(a as bigint, b as bigint);
      if (result === undefined) return ErrorValue.of('Underflow');
      if (!fitsInt(result, type)) return ErrorValue.of(result < 0n ? 'Underflow' : 'Overflow');
      return result;
    });
  }),
  clamp: fnMember('std.math.clamp', (sema, call) => {
    const [valueArg, lowArg, highArg] = expectArgs(sema, call, 3, 'std.math.clamp');
    const parts = [valueArg, lowArg, highArg].map((arg) => sema.compile(arg));
    const runtimeType = parts.find((part) => part.type.kind === 'int' || part.type.kind === 'float')?.type;
    const operands = runtimeType ? [valueArg, lowArg, highArg].map((arg) => sema.compile(arg, runtimeType)) : parts;
    const type = sema.peerType(operands, call.span);
    const coerced = operands.map((operand) => sema.coerce(operand, type, operand.span));
    return computed(type, coerced, call.span, ([v, low, high]) => {
      if (compareScalarsAny(low, high) > 0) panic(PANIC.unreachable);
      return compareScalarsAny(v, low) < 0 ? low : compareScalarsAny(v, high) > 0 ? high : v;
    });
  }),
  order: fnMember('std.math.order', (sema, call) => {
    const [aArg, bArg] = expectArgs(sema, call, 2, 'std.math.order');
    const a = sema.compile(aArg);
    const b = sema.compile(bArg, a.type);
    return computed(ORDER, [a, b], call.span, ([x, y]) => orderValue(compareScalarsAny(x, y)));
  }),
  divTrunc: intDivision('std.math.divTrunc', DIVISION_ERRORS, (a, b) => divTrunc(a, b, undefined)),
  divFloor: intDivision('std.math.divFloor', DIVISION_ERRORS, (a, b) => divFloor(a, b, undefined)),
  divCeil: intDivision('std.math.divCeil', DIVISION_ERRORS, (a, b) => divCeil(a, b, undefined)),
  divExact: intDivision(
    'std.math.divExact',
    errorSetOf(['DivisionByZero', 'Overflow', 'UnexpectedRemainder']),
    (a, b) => {
      if (a % b !== 0n) throw new UnexpectedRemainder();
      return divExact(a, b, undefined);
    }
  ),
  mod: intDivision('std.math.mod', MOD_ERRORS, (a, b) => mod(a, b)),
  rem: intDivision('std.math.rem', MOD_ERRORS, (a, b) => rem(a, b)),
  gcd: fnMember('std.math.gcd', (sema, call) => {
    const [aArg, bArg] = expectArgs(sema, call, 2, 'std.math.gcd');
    const a = sema.compile(aArg);
    const b = sema.compile(bArg, a.type);
    const type = sema.peerType([a, b], call.span);
    return computed(type, [sema.coerce(a, type), sema.coerce(b, type)], call.span, ([x, y]) =>
      gcd(x as bigint, y as bigint)
    );
  }),
  lcm: fnMember('std.math.lcm', (sema, call) => {
    const [aArg, bArg] = expectArgs(sema, call, 2, 'std.math.lcm');
    const a = sema.compile(aArg);
    const b = sema.compile(bArg, a.type);
    const type = sema.peerType([a, b], call.span);
    return computed(type, [sema.coerce(a, type), sema.coerce(b, type)], call.span, ([x, y]) => {
      const divisor = gcd(x as bigint, y as bigint);
      return divisor === 0n ? 0n : ((x as bigint) / divisor) * (y as bigint);
    });
  }),
  isPowerOfTwo: fnMember('std.math.isPowerOfTwo', (sema, call) => {
    const [arg] = expectArgs(sema, call, 1, 'std.math.isPowerOfTwo');
    const value = sema.compile(arg);
    return computed(BOOL, [value], call.span, ([x]) => {
      const n = x as bigint;
      if (n <= 0n) panic(PANIC.unreachable);
      return (n & (n - 1n)) === 0n;
    });
  }),
  cast: generic('std.math.cast', 2, (sema, call, type, [valueArg]) => {
    if (type.kind !== 'int') return sema.error(call.span, 'std.math.cast には整数の型を渡してください。');
    const value = sema.compile(valueArg);
    return computed(optionalOf(type), [value], call.span, ([x]) => (fitsInt(x as bigint, type) ? x : NULL));
  }),
  IntFittingRange: fnMember('std.math.IntFittingRange', (sema, call) => {
    const [lowArg, highArg] = expectArgs(sema, call, 2, 'std.math.IntFittingRange');
    const low = sema.knownValue(sema.compile(lowArg), '範囲') as bigint;
    const high = sema.knownValue(sema.compile(highArg), '範囲') as bigint;
    return known(TYPE, intFittingRange(low, high), call.span);
  }),
  Log2Int: generic('std.math.Log2Int', 1, (sema, call, type) => {
    if (type.kind !== 'int') return sema.error(call.span, 'std.math.Log2Int には整数の型を渡してください。');
    let bits = 0;
    while (2 ** bits < type.bits) bits++;
    return known(TYPE, intType(false, bits), call.span);
  }),
  approxEqAbs: generic('std.math.approxEqAbs', 4, (sema, call, type, [xArg, yArg, toleranceArg]) => {
    const [x, y, tolerance] = [xArg, yArg, toleranceArg].map((arg) => sema.coerce(sema.compile(arg, type), type, arg));
    return computed(BOOL, [x, y, tolerance], call.span, ([a, b, t]) => {
      if (isNaNFloat(a as AnyFloat) || isNaNFloat(b as AnyFloat)) return false;
      return Math.abs(toDouble(a as AnyFloat) - toDouble(b as AnyFloat)) <= toDouble(t as AnyFloat);
    });
  }),
};

function compareScalarsAny(a: Value, b: Value): number {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    if (typeof a === 'bigint' && typeof b === 'bigint') return compareScalars(a, b);
    const x = typeof a === 'bigint' ? floatFromBigInt(a, 128) : (a as AnyFloat);
    const y = typeof b === 'bigint' ? floatFromBigInt(b, 128) : (b as AnyFloat);
    return compareFloats(x, y) ?? 0;
  }
  return compareFloats(a as AnyFloat, b as AnyFloat) ?? 0;
}

function integerPower(base: bigint, exponent: bigint): bigint | undefined {
  if (exponent < 0n) {
    if (base === 1n) return 1n;
    if (base === -1n) return exponent % 2n === 0n ? 1n : -1n;
    return base === 0n ? undefined : 0n;
  }
  return base ** exponent;
}

let math: StructType | undefined;

export function mathNamespace(): StructType {
  math ??= nativeStruct('std.math', MEMBERS);
  return math;
}

export { floatOf };
