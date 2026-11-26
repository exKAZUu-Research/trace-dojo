import { CsDecimal } from '../decimal';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { convertNumeric, integerRange, isBigIntKind, type NumericValue } from '../numeric';
import { specialOf, type SpecialType } from '../types';
import type { Value } from '../values';
import { roundDouble } from './nativesCore';
import { fail, primitive, unsupportedCall } from './support';

/**
 * The statics that the numeric types got from generic math, called on the type itself, as `double.Round(x, 1)` or
 * `long.CreateChecked(5)`; the generic math interfaces that declare them are not part of this library.
 */

const INTEGERS: [string, SpecialType][] = [
  ['SByte', 'sbyte'],
  ['Byte', 'byte'],
  ['Int16', 'short'],
  ['UInt16', 'ushort'],
  ['Int32', 'int'],
  ['UInt32', 'uint'],
  ['Int64', 'long'],
  ['UInt64', 'ulong'],
];

const NUMERIC = new Set<string>([
  'sbyte',
  'byte',
  'short',
  'ushort',
  'int',
  'uint',
  'long',
  'ulong',
  'char',
  'float',
  'double',
  'decimal',
]);

/** The kind of a generic factory's argument, which must be a number for .NET's `INumberBase<TOther>` constraint. */
function sourceKind(call: NativeCall, name: string): SpecialType {
  const kind = specialOf(call.typeArgs[0]);
  if (kind === undefined || !NUMERIC.has(kind)) unsupportedCall(call, `${name} の数値以外の型引数`);
  return kind;
}

/** A char arrives as its code unit, which the conversions take as a number. */
function numberOf(value: Value): NumericValue {
  return primitive<NumericValue>(value);
}

/** A number clamped to an integral type's range, NaN as 0, as `CreateSaturating` gives it. */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the .NET rule that the function applies.
function saturated(value: NumericValue, from: SpecialType, to: SpecialType): NumericValue {
  if (to === 'float' || to === 'double' || to === 'decimal') return convertNumeric(value, from, to);
  const [min, max] = integerRange(to);
  const fromBig = (integer: bigint): NumericValue => (isBigIntKind(to) ? integer : Number(integer));
  if (value instanceof CsDecimal) {
    const integer = value.truncate();
    return fromBig(integer < min ? min : integer > max ? max : integer);
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    if (Number.isNaN(value)) return fromBig(0n);
    if (value <= Number(min)) return fromBig(min);
    if (value >= Number(max)) return fromBig(max);
    return fromBig(BigInt(Math.trunc(value)));
  }
  const integer = BigInt(value as number | bigint);
  return fromBig(integer < min ? min : integer > max ? max : integer);
}

function factories(prefix: string, to: SpecialType): Record<string, NativeMethod> {
  return {
    [`${prefix}.CreateChecked`]: (call, _receiver, [value]) =>
      convertNumeric(numberOf(value as Value), sourceKind(call, 'CreateChecked'), to, true),
    [`${prefix}.CreateSaturating`]: (call, _receiver, [value]) =>
      saturated(numberOf(value as Value), sourceKind(call, 'CreateSaturating'), to),
    [`${prefix}.CreateTruncating`]: (call, _receiver, [value]) =>
      convertNumeric(numberOf(value as Value), sourceKind(call, 'CreateTruncating'), to),
  };
}

/** The one of two numbers with the greater magnitude, or the lesser, a tie going to the positive one, or the negative. */
function magnitude<T>(
  x: T,
  y: T,
  abs: (value: T) => number | bigint,
  isNegative: (value: T) => boolean,
  greater: boolean
): T {
  const [a, b] = [abs(x), abs(y)];
  if (a === b) return isNegative(x) === greater ? y : x;
  return a > b === greater ? x : y;
}

const integerOf = (value: Value): bigint => BigInt(value as number | bigint);
const integerAbs = (value: Value): bigint => (integerOf(value) < 0n ? -integerOf(value) : integerOf(value));
const isNegativeInteger = (value: Value): boolean => integerOf(value) < 0n;

for (const [name, kind] of INTEGERS) {
  const prefix = `System.${name}`;
  defineNatives(factories(prefix, kind));
  // The unsigned types implement the magnitudes of INumberBase only explicitly, which a program cannot call.
  if (name.startsWith('U') || name === 'Byte') continue;
  defineNatives({
    [`${prefix}.MaxMagnitude`]: (_call, _receiver, [x, y]) =>
      magnitude(x as Value, y as Value, integerAbs, isNegativeInteger, true),
    [`${prefix}.MinMagnitude`]: (_call, _receiver, [x, y]) =>
      magnitude(x as Value, y as Value, integerAbs, isNegativeInteger, false),
  });
}

defineNatives({
  'System.Int32.BigMul': (_call, _receiver, [a, b]) => BigInt(a as number) * BigInt(b as number),
  'System.UInt32.BigMul': (_call, _receiver, [a, b]) => BigInt(a as number) * BigInt(b as number),
});

const MIN_NORMAL = { double: 2.2250738585072014e-308, float: 1.1754943508222875e-38 };

const test =
  (predicate: (value: number) => boolean): NativeMethod =>
  (_call, _receiver, [value]) =>
    predicate(value as number);
/** Whether a float is negative, -0 included, as .NET's `IsNegative` tells by the sign bit. */
const isNegativeFloat = (value: number): boolean => value < 0 || Object.is(value, -0);

for (const [name, kind] of [
  ['Double', 'double'],
  ['Single', 'float'],
] as const) {
  const prefix = `System.${name}`;
  const narrowed = (value: number): number => (kind === 'float' ? Math.fround(value) : value);
  const unary =
    (operation: (value: number) => number): NativeMethod =>
    (_call, _receiver, [value]) =>
      narrowed(operation(value as number));
  const binary =
    (operation: (a: number, b: number) => number): NativeMethod =>
    (_call, _receiver, [a, b]) =>
      narrowed(operation(a as number, b as number));
  const extreme = (greater: boolean): NativeMethod =>
    binary((x, y) =>
      Number.isNaN(x) || Number.isNaN(y) ? Number.NaN : magnitude(x, y, Math.abs, isNegativeFloat, greater)
    );
  defineNatives({
    ...factories(prefix, kind),
    [`${prefix}.Round(${kind}, int)`]: (_call, _receiver, [value, digits]) =>
      narrowed(roundDouble(value as number, digits as number, 0)),
    [`${prefix}.Round(${kind}, MidpointRounding)`]: (_call, _receiver, [value, mode]) =>
      narrowed(roundDouble(value as number, 0, mode as number)),
    [`${prefix}.Round(${kind}, int, MidpointRounding)`]: (_call, _receiver, [value, digits, mode]) =>
      narrowed(roundDouble(value as number, digits as number, mode as number)),
    [`${prefix}.Sign`]: (_call, _receiver, [value]) => {
      if (Number.isNaN(value))
        fail('System.ArithmeticException', 'Function does not accept floating point Not-a-Number values.');
      return Math.sign(value as number);
    },
    [`${prefix}.IsPositive`]: test((value) => !isNegativeFloat(value) && !Number.isNaN(value)),
    [`${prefix}.IsEvenInteger`]: test((value) => Number.isInteger(value) && value % 2 === 0),
    [`${prefix}.IsOddInteger`]: test((value) => Number.isInteger(value) && Math.abs(value % 2) === 1),
    [`${prefix}.IsPow2`]: test((value) => value > 0 && Number.isFinite(value) && Number.isInteger(Math.log2(value))),
    [`${prefix}.IsNormal`]: test((value) => Number.isFinite(value) && Math.abs(value) >= MIN_NORMAL[kind]),
    [`${prefix}.IsSubnormal`]: test((value) => value !== 0 && Math.abs(value) < MIN_NORMAL[kind]),
    [`${prefix}.IsRealNumber`]: test((value) => !Number.isNaN(value)),
    [`${prefix}.CopySign`]: binary((value, sign) => Math.abs(value) * (isNegativeFloat(sign) ? -1 : 1)),
    [`${prefix}.MaxMagnitude`]: extreme(true),
    [`${prefix}.MinMagnitude`]: extreme(false),
    [`${prefix}.Exp`]: unary(Math.exp),
    [`${prefix}.Log(${kind})`]: unary(Math.log),
    [`${prefix}.Log(${kind}, ${kind})`]: binary((value, base) => Math.log(value) / Math.log(base)),
    [`${prefix}.Log2`]: unary(Math.log2),
    [`${prefix}.Log10`]: unary(Math.log10),
    [`${prefix}.Sin`]: unary(Math.sin),
    [`${prefix}.Cos`]: unary(Math.cos),
    [`${prefix}.Tan`]: unary(Math.tan),
    [`${prefix}.Asin`]: unary(Math.asin),
    [`${prefix}.Acos`]: unary(Math.acos),
    [`${prefix}.Atan`]: unary(Math.atan),
    [`${prefix}.Atan2`]: binary(Math.atan2),
    [`${prefix}.Sinh`]: unary(Math.sinh),
    [`${prefix}.Cosh`]: unary(Math.cosh),
    [`${prefix}.Tanh`]: unary(Math.tanh),
    [`${prefix}.Cbrt`]: unary(Math.cbrt),
    [`${prefix}.Hypot`]: binary(Math.hypot),
    [`${prefix}.Lerp`]: (_call, _receiver, [a, b, amount]) =>
      narrowed((a as number) * (1 - (amount as number)) + (b as number) * (amount as number)),
    [`${prefix}.DegreesToRadians`]: unary((degrees) => (degrees * Math.PI) / 180),
    [`${prefix}.RadiansToDegrees`]: unary((radians) => (radians * 180) / Math.PI),
    [`${prefix}.FusedMultiplyAdd`]: (_call, _receiver, [a, b, c]) =>
      narrowed((a as number) * (b as number) + (c as number)),
  });
}

const decimalTest =
  (predicate: (value: CsDecimal) => boolean): NativeMethod =>
  (_call, _receiver, [value]) =>
    predicate(value as CsDecimal);
const isWhole = (value: CsDecimal): boolean => value.equals(value.round(0, 'down'));

const decimalAbs = (value: CsDecimal): CsDecimal => (value.isNegative ? value.negate() : value);

function decimalMagnitude(x: CsDecimal, y: CsDecimal, greater: boolean): CsDecimal {
  const order = decimalAbs(x).compare(decimalAbs(y));
  if (order === 0) return x.isNegative === greater ? y : x;
  return order > 0 === greater ? x : y;
}

defineNatives({
  ...factories('System.Decimal', 'decimal'),
  'System.Decimal.IsInteger': decimalTest(isWhole),
  'System.Decimal.IsNegative': decimalTest((value) => value.isNegative),
  'System.Decimal.IsPositive': decimalTest((value) => !value.isNegative),
  'System.Decimal.IsEvenInteger': decimalTest((value) => isWhole(value) && value.truncate() % 2n === 0n),
  'System.Decimal.IsOddInteger': decimalTest((value) => isWhole(value) && value.truncate() % 2n !== 0n),
  'System.Decimal.CopySign': (_call, _receiver, [value, sign]) => {
    const [number, signed] = [value as CsDecimal, sign as CsDecimal];
    return number.isNegative === signed.isNegative ? number : number.negate();
  },
  'System.Decimal.MaxMagnitude': (_call, _receiver, [x, y]) => decimalMagnitude(x as CsDecimal, y as CsDecimal, true),
  'System.Decimal.MinMagnitude': (_call, _receiver, [x, y]) => decimalMagnitude(x as CsDecimal, y as CsDecimal, false),
});
