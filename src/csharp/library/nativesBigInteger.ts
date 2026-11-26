import { type Culture, providerCulture } from '../cultures';
import { CsDecimal } from '../decimal';
import { formatNumber } from '../format';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { PendingException } from '../numeric';
import type { Runtime } from '../runtime';
import { type NamedType, specialOf } from '../types';
import { CsBox, CsStruct, type Value } from '../values';
import { NumberStyles, parseBigIntegerText } from './numberParsing';
import { fail, failNegative, failNull, libraryType, refOf } from './support';

const BIG_INTEGER = 'System.Numerics.BigInteger';
/** The bits past which a BigInteger would outgrow what a run may build, as .NET runs out of memory. */
const MAX_BITS = 1n << 25n;
/** The products of 32-bit words that one operation of the budget stands for, in a multiplication or a division. */
const WORD_PRODUCTS_PER_OPERATION = 4096;

/** The value of a BigInteger, boxed or not, which its one field keeps as a bigint of any size. */
export function bigIntegerValue(value: Value): bigint {
  return ((value instanceof CsBox ? value.value : value) as CsStruct).fields[0] as bigint;
}

export function isBigInteger(value: Value): boolean {
  const inner = value instanceof CsBox ? value.value : value;
  return inner instanceof CsStruct && inner.type.symbol.fullName === BIG_INTEGER;
}

function outOfMemory(): never {
  throw new PendingException(
    'System.OutOfMemoryException',
    "Exception of type 'System.OutOfMemoryException' was thrown."
  );
}

function bitLength(value: bigint): bigint {
  return value === 0n ? 0n : BigInt((value < 0n ? -value : value).toString(2).length);
}

function wordsOf(value: bigint): number {
  return Number((bitLength(value) + 31n) / 32n);
}

function newBigInteger(call: NativeCall, value: bigint): CsStruct {
  if (bitLength(value) > MAX_BITS) outOfMemory();
  return new CsStruct(libraryType(call, BIG_INTEGER), [value]);
}

/** Charges a multiplication or a division of two values by the products of their words. */
function chargeProduct(runtime: Runtime, a: bigint, b: bigint): void {
  runtime.spend(1 + Math.floor((wordsOf(a) * wordsOf(b)) / WORD_PRODUCTS_PER_OPERATION));
}

function divisorOf(value: bigint): bigint {
  if (value === 0n) fail('System.DivideByZeroException', 'Attempted to divide by zero.');
  return value;
}

/** The value of a double or float, truncated, which NaN and the infinities cannot be. */
function fromDouble(value: number): bigint {
  if (Number.isNaN(value)) fail('System.OverflowException', 'The value is not a number.');
  if (!Number.isFinite(value)) fail('System.OverflowException', 'BigInteger cannot represent infinity.');
  return BigInt(Math.trunc(value));
}

function fromDecimal(value: CsDecimal): bigint {
  return value.truncate();
}

/** Whether .NET keeps a value in its sign field alone, without words: any int but `int.MinValue`. */
function isSmall(value: bigint): boolean {
  return value > -(2n ** 31n) && value < 2n ** 31n;
}

const GENERIC_OVERFLOW = 'Arithmetic operation resulted in an overflow.';

function overflow(typeName: string): never {
  return fail('System.OverflowException', `Value was either too large or too small for ${typeName}.`);
}

/** `(int)value`, whose message for a positive value that fits a word is the checked conversion's. */
function toInt32(value: bigint): number {
  if (isSmall(value)) return Number(value);
  if (wordsOf(value) > 1) overflow('an Int32');
  if (value > 0n) fail('System.OverflowException', GENERIC_OVERFLOW);
  if (value < -(2n ** 31n)) overflow('an Int32');
  return Number(value);
}

/**
 * `(uint)value` or `(ulong)value`: a negative int is the checked conversion's overflow, and any other value outside
 * the words the type holds is the type's.
 */
function toUnsigned(value: bigint, words: number, typeName: string): bigint {
  if (isSmall(value) && value < 0n) fail('System.OverflowException', GENERIC_OVERFLOW);
  if (value < 0n || wordsOf(value) > words) overflow(typeName);
  return value;
}

/** The narrower integral types convert through int, checked. */
const NARROW_RANGES: Record<string, readonly [number, number]> = {
  sbyte: [-128, 127],
  byte: [0, 255],
  short: [-32_768, 32_767],
  ushort: [0, 65_535],
  char: [0, 65_535],
};

function toIntegral(value: bigint, type: string): number | bigint {
  switch (type) {
    case 'int': {
      return toInt32(value);
    }
    case 'uint': {
      return Number(toUnsigned(value, 1, 'a UInt32'));
    }
    case 'long': {
      if (value < -(2n ** 63n) || value >= 2n ** 63n) overflow('an Int64');
      return value;
    }
    case 'ulong': {
      return toUnsigned(value, 2, 'a UInt64');
    }
    default: {
      const narrow = toInt32(value);
      const [min, max] = NARROW_RANGES[type];
      if (narrow < min || narrow > max) fail('System.OverflowException', GENERIC_OVERFLOW);
      return narrow;
    }
  }
}

/**
 * `(double)value`, which .NET builds from the top 53 bits of a value past int's range, truncating the rest, and which
 * is infinite past double's range.
 */
function toDouble(value: bigint): number {
  const magnitude = value < 0n ? -value : value;
  const bits = bitLength(magnitude);
  if (bits <= 53n) return Number(value);
  if (bits > 1024n) return value < 0n ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  const shift = bits - 53n;
  const truncated = Number(magnitude >> shift) * 2 ** Number(shift);
  return value < 0n ? -truncated : truncated;
}

function convertedTo(value: bigint, type: string): Value {
  switch (type) {
    case 'double': {
      return toDouble(value);
    }
    case 'float': {
      return Math.fround(toDouble(value));
    }
    case 'decimal': {
      if (wordsOf(value) > 3) overflow('a Decimal');
      return CsDecimal.fromBigInt(value);
    }
    default: {
      return toIntegral(value, type);
    }
  }
}

/** The value of an argument that converts to BigInteger: an integral number, a float, or a decimal. */
function valueFrom(argument: Value, type: string | undefined): bigint {
  if (argument instanceof CsDecimal) return fromDecimal(argument);
  if (type === 'float' || type === 'double') return fromDouble(argument as number);
  return BigInt(argument as number | bigint);
}

/**
 * The digits of a hexadecimal or binary text in two's complement, as BigInteger shows them: the fewest whose first
 * digit's top bit is the sign, padded to the precision with the sign's digit.
 */
function twosComplementText(value: bigint, radix: 16 | 2, precision: number): string {
  const digitBits = radix === 16 ? 4n : 1n;
  let text: string;
  if (value >= 0n) {
    text = value.toString(radix);
    if (value !== 0n && Number.parseInt(text[0], radix) >= radix / 2) text = `0${text}`;
    return text.padStart(precision, '0');
  }
  let digits = BigInt((-value).toString(radix).length);
  while (value < -(1n << (digits * digitBits - 1n))) digits++;
  text = ((1n << (digits * digitBits)) + value).toString(radix);
  return text.padStart(precision, radix === 16 ? 'f' : '1');
}

/** Formats a BigInteger as .NET does: in two's complement for `X` and `B`, and otherwise as any integer. */
export function formatBigInteger(value: bigint, format: string | undefined, culture: Culture): string {
  const radix = format === undefined ? undefined : /^([XxBb])(\d{0,9})$/.exec(format);
  if (!radix) return formatNumber(value, 'integer', format, culture);
  const precision = radix[2] === '' ? 0 : Number(radix[2]);
  const isHex = radix[1] === 'X' || radix[1] === 'x';
  const text = twosComplementText(value, isHex ? 16 : 2, precision);
  return radix[1] === 'X' ? text.toUpperCase() : text;
}

/**
 * `BigInteger.Log(value, baseValue)` as .NET computes it: from the top 64 bits of a value past int's range, with the
 * logarithm of the power of two that the rest stands for.
 */
function logarithm(value: bigint, baseValue: number): number {
  if (value < 0n || baseValue === 1) return Number.NaN;
  if (baseValue === Number.POSITIVE_INFINITY) return value === 1n ? 0 : Number.NaN;
  if (baseValue === 0 && value !== 1n) return Number.NaN;
  if (isSmall(value)) return mathLog(Number(value), baseValue);
  const bits = bitLength(value);
  const top = bits >= 64n ? value >> (bits - 64n) : value << (64n - bits);
  return mathLog(Number(top), baseValue) + Number(bits - 64n) / mathLog(baseValue, 2);
}

/** .NET's `Math.Log(a, newBase)`. */
function mathLog(a: number, newBase: number): number {
  if (Number.isNaN(a)) return a;
  if (Number.isNaN(newBase)) return newBase;
  if (newBase === 1) return Number.NaN;
  if (a !== 1 && (newBase === 0 || newBase === Number.POSITIVE_INFINITY)) return Number.NaN;
  return Math.log(a) / Math.log(newBase);
}

/**
 * `value >>> shift`, which .NET computes on the value's two's complement in the fewest 32-bit words that hold it with
 * its sign, so that a negative value shifted less than that width turns positive.
 */
function unsignedShiftRight(value: bigint, shift: number): bigint {
  if (shift <= 0) return shiftLeft(value, -shift);
  if (value >= 0n) return value >> BigInt(shift);
  let width = BigInt(Math.max(1, wordsOf(value))) * 32n;
  if (value < -(1n << (width - 1n))) width += 32n;
  if (BigInt(shift) >= width) return -1n;
  return ((1n << width) + value) >> BigInt(shift);
}

function shiftLeft(value: bigint, shift: number): bigint {
  if (shift < 0) return value >> BigInt(-shift);
  if (value !== 0n && bitLength(value) + BigInt(shift) > MAX_BITS) outOfMemory();
  return value << BigInt(shift);
}

function power(runtime: Runtime, value: bigint, exponent: number): bigint {
  if (value === 0n || value === 1n || exponent === 0) return exponent === 0 ? 1n : value;
  if (value === -1n) return exponent % 2 === 0 ? 1n : -1n;
  if (bitLength(value) * BigInt(exponent) > MAX_BITS + 64n) outOfMemory();
  const bits = bitLength(value) * BigInt(exponent);
  // The squarings cost about as much as multiplying the result by itself.
  const words = Number(bits / 32n) + 1;
  runtime.spend(1 + Math.floor((words * words) / WORD_PRODUCTS_PER_OPERATION));
  return value ** BigInt(exponent);
}

/** `ModPow`, whose result has the sign of `value ** exponent`, as `%` gives it. */
function modularPower(runtime: Runtime, value: bigint, exponent: bigint, modulus: bigint): bigint {
  const divisor = divisorOf(modulus < 0n ? -modulus : modulus);
  let base = (value < 0n ? -value : value) % divisor;
  let result = 1n % divisor;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    chargeProduct(runtime, divisor, divisor);
    if ((rest & 1n) === 1n) result = (result * base) % divisor;
    base = (base * base) % divisor;
  }
  return value < 0n && (exponent & 1n) === 1n ? -result : result;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** .NET's hash of a BigInteger: an int's own value, and a mix of the words of a larger one. */
function hashOf(value: bigint): number {
  if (isSmall(value)) return Number(value);
  let hash = value < 0n ? -1 : 1;
  for (let rest = value < 0n ? -value : value; rest > 0n; rest >>= 32n)
    hash = Math.imul(hash ^ Number(BigInt.asIntN(32, rest)), 0x01_00_01_93);
  return hash;
}

function compare(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `Parse`'s and `TryParse`'s style, which .NET checks before it reads the text. */
function checkStyles(styles: number): void {
  if ((styles & ~2047) !== 0)
    fail('System.ArgumentException', 'An undefined NumberStyles value is being used.', 'style');
  if ((styles & NumberStyles.AllowHexSpecifier) !== 0 && (styles & ~515) !== 0)
    fail(
      'System.ArgumentException',
      'With the AllowHexSpecifier bit set in the enum bit field, the only other valid bits that can be combined into the enum value must be a subset of those in HexNumber.',
      'style'
    );
}

function parseArguments(call: NativeCall, args: Value[]): { text: Value; styles: number; culture: Culture } {
  const argument = (name: string): Value =>
    args[call.method.parameters.findIndex((parameter) => parameter.name === name)];
  const hasStyles = call.method.parameters.some((parameter) => parameter.name === 'style');
  const styles = hasStyles ? (argument('style') as number) : NumberStyles.Integer;
  checkStyles(styles);
  return { text: argument('value'), styles, culture: providerCulture(call.frame.runtime, argument('provider')) };
}

const binary =
  (operate: (a: bigint, b: bigint, runtime: Runtime) => bigint): NativeMethod =>
  (call, _receiver, [left, right]) =>
    newBigInteger(call, operate(bigIntegerValue(left as Value), bigIntegerValue(right as Value), call.frame.runtime));

const unary =
  (operate: (value: bigint) => bigint): NativeMethod =>
  (call, _receiver, [value]) =>
    newBigInteger(call, operate(bigIntegerValue(value as Value)));

const multiply = binary((a, b, runtime) => {
  chargeProduct(runtime, a, b);
  if (bitLength(a) + bitLength(b) > MAX_BITS + 1n) outOfMemory();
  return a * b;
});
const divide = binary((a, b, runtime) => {
  chargeProduct(runtime, a, b);
  return a / divisorOf(b);
});
const remainder = binary((a, b, runtime) => {
  chargeProduct(runtime, a, b);
  return a % divisorOf(b);
});
const add = binary((a, b) => a + b);
const subtract = binary((a, b) => a - b);
const negate = unary((value) => -value);

/** A comparison operator, whose operands may be a BigInteger, a long, or a ulong. */
const comparison =
  (test: (order: number) => boolean): NativeMethod =>
  (_call, _receiver, [left, right]) =>
    test(compare(operandValue(left as Value), operandValue(right as Value)));

function operandValue(value: Value): bigint {
  return typeof value === 'bigint' ? value : bigIntegerValue(value);
}

function setValue(receiver: Value, value: bigint): Value {
  (receiver as CsStruct).fields[0] = value;
  return undefined;
}

defineNatives({
  [`${BIG_INTEGER}..ctor`]: (call, receiver, [value]) =>
    setValue(receiver, valueFrom(value as Value, specialOf(call.method.parameters[0].type))),
  [`${BIG_INTEGER}.get_Zero`]: (call) => newBigInteger(call, 0n),
  [`${BIG_INTEGER}.get_One`]: (call) => newBigInteger(call, 1n),
  [`${BIG_INTEGER}.get_MinusOne`]: (call) => newBigInteger(call, -1n),
  [`${BIG_INTEGER}.get_IsZero`]: (_call, receiver) => bigIntegerValue(receiver) === 0n,
  [`${BIG_INTEGER}.get_IsOne`]: (_call, receiver) => bigIntegerValue(receiver) === 1n,
  [`${BIG_INTEGER}.get_IsEven`]: (_call, receiver) => (bigIntegerValue(receiver) & 1n) === 0n,
  [`${BIG_INTEGER}.get_IsPowerOfTwo`]: (_call, receiver) => {
    const value = bigIntegerValue(receiver);
    return value > 0n && (value & (value - 1n)) === 0n;
  },
  [`${BIG_INTEGER}.get_Sign`]: (_call, receiver) => compare(bigIntegerValue(receiver), 0n),
  [`${BIG_INTEGER}.Abs`]: unary((value) => (value < 0n ? -value : value)),
  [`${BIG_INTEGER}.Negate`]: negate,
  [`${BIG_INTEGER}.Add`]: add,
  [`${BIG_INTEGER}.Subtract`]: subtract,
  [`${BIG_INTEGER}.Multiply`]: multiply,
  [`${BIG_INTEGER}.Divide`]: divide,
  [`${BIG_INTEGER}.Remainder`]: remainder,
  [`${BIG_INTEGER}.DivRem(BigInteger, BigInteger, BigInteger)`]: (call, receiver, [dividend, divisor, result]) => {
    const quotient = divide(call, receiver, [dividend, divisor]);
    refOf(result as Value).set(remainder(call, receiver, [dividend, divisor]));
    return quotient;
  },
  [`${BIG_INTEGER}.DivRem(BigInteger, BigInteger)`]: (call, receiver, [left, right]) =>
    new CsStruct(call.method.returnType as NamedType, [
      divide(call, receiver, [left, right]),
      remainder(call, receiver, [left, right]),
    ]),
  [`${BIG_INTEGER}.Pow`]: (call, _receiver, [value, exponent]) => {
    if ((exponent as number) < 0) failNegative(call, 'exponent', exponent as number);
    return newBigInteger(call, power(call.frame.runtime, bigIntegerValue(value as Value), exponent as number));
  },
  [`${BIG_INTEGER}.ModPow`]: (call, _receiver, [value, exponent, modulus]) => {
    const power = bigIntegerValue(exponent as Value);
    if (power < 0n) failNegative(call, 'exponent', power);
    const result = modularPower(
      call.frame.runtime,
      bigIntegerValue(value as Value),
      power,
      bigIntegerValue(modulus as Value)
    );
    return newBigInteger(call, result);
  },
  [`${BIG_INTEGER}.GreatestCommonDivisor`]: binary((a, b, runtime) => {
    chargeProduct(runtime, a, b);
    return gcd(a, b);
  }),
  [`${BIG_INTEGER}.Min`]: binary((a, b) => (b < a ? b : a)),
  [`${BIG_INTEGER}.Max`]: binary((a, b) => (b > a ? b : a)),
  [`${BIG_INTEGER}.Compare`]: (_call, _receiver, [a, b]) =>
    compare(bigIntegerValue(a as Value), bigIntegerValue(b as Value)),
  [`${BIG_INTEGER}.Log(BigInteger)`]: (_call, _receiver, [value]) => logarithm(bigIntegerValue(value as Value), Math.E),
  [`${BIG_INTEGER}.Log(BigInteger, double)`]: (_call, _receiver, [value, baseValue]) =>
    logarithm(bigIntegerValue(value as Value), baseValue as number),
  [`${BIG_INTEGER}.Log10`]: (_call, _receiver, [value]) => logarithm(bigIntegerValue(value as Value), 10),
  [`${BIG_INTEGER}.CompareTo(object)`]: (_call, receiver, [other]) => {
    if (other === undefined) return 1;
    if (!isBigInteger(other as Value)) fail('System.ArgumentException', 'The parameter must be a BigInteger.', 'obj');
    return compare(bigIntegerValue(receiver), bigIntegerValue(other as Value));
  },
  [`${BIG_INTEGER}.CompareTo`]: (_call, receiver, [other]) =>
    compare(bigIntegerValue(receiver), operandValue(other as Value)),
  [`${BIG_INTEGER}.Equals(object)`]: (_call, receiver, [other]) =>
    isBigInteger(other as Value) && bigIntegerValue(other as Value) === bigIntegerValue(receiver),
  [`${BIG_INTEGER}.Equals`]: (_call, receiver, [other]) => operandValue(other as Value) === bigIntegerValue(receiver),
  [`${BIG_INTEGER}.GetHashCode`]: (_call, receiver) => hashOf(bigIntegerValue(receiver)),
  [`${BIG_INTEGER}.ToString()`]: (_call, receiver) => bigIntegerValue(receiver).toString(),
  [`${BIG_INTEGER}.ToString(IFormatProvider)`]: (call, receiver, [provider]) =>
    formatBigInteger(bigIntegerValue(receiver), undefined, providerCulture(call.frame.runtime, provider as Value)),
  [`${BIG_INTEGER}.ToString(string)`]: (call, receiver, [format]) =>
    formatBigInteger(
      bigIntegerValue(receiver),
      format as string | undefined,
      providerCulture(call.frame.runtime, undefined)
    ),
  [`${BIG_INTEGER}.ToString(string, IFormatProvider)`]: (call, receiver, [format, provider]) =>
    formatBigInteger(
      bigIntegerValue(receiver),
      format as string | undefined,
      providerCulture(call.frame.runtime, provider as Value)
    ),
  [`${BIG_INTEGER}.Parse`]: (call, _receiver, args) => {
    const { text, styles, culture } = parseArguments(call, args as Value[]);
    if (text === undefined) failNull('value');
    const parsed = parseBigIntegerText(text as string, styles, culture);
    if (parsed === undefined) fail('System.FormatException', 'The value could not be parsed.');
    return newBigInteger(call, parsed);
  },
  [`${BIG_INTEGER}.TryParse`]: (call, _receiver, args) => {
    const { text, styles, culture } = parseArguments(call, args as Value[]);
    const parsed = text === undefined ? undefined : parseBigIntegerText(text as string, styles, culture);
    refOf(args.at(-1) as Value).set(newBigInteger(call, parsed ?? 0n));
    return parsed !== undefined;
  },
  [`${BIG_INTEGER}.op_Implicit`]: (call, _receiver, [value]) => newBigInteger(call, BigInt(value as number | bigint)),
  [`${BIG_INTEGER}.op_Explicit`]: (call, _receiver, [value]) => {
    const from = specialOf(call.method.parameters[0].type);
    if (from !== undefined) return newBigInteger(call, valueFrom(value as Value, from));
    return convertedTo(bigIntegerValue(value as Value), specialOf(call.method.returnType) as string);
  },
  [`${BIG_INTEGER}.op_Addition`]: add,
  [`${BIG_INTEGER}.op_Subtraction`]: subtract,
  [`${BIG_INTEGER}.op_Multiply`]: multiply,
  [`${BIG_INTEGER}.op_Division`]: divide,
  [`${BIG_INTEGER}.op_Modulus`]: remainder,
  [`${BIG_INTEGER}.op_BitwiseAnd`]: binary((a, b) => a & b),
  [`${BIG_INTEGER}.op_BitwiseOr`]: binary((a, b) => a | b),
  [`${BIG_INTEGER}.op_ExclusiveOr`]: binary((a, b) => a ^ b),
  [`${BIG_INTEGER}.op_LeftShift`]: (call, _receiver, [value, shift]) =>
    newBigInteger(call, shiftLeft(bigIntegerValue(value as Value), shift as number)),
  [`${BIG_INTEGER}.op_RightShift`]: (call, _receiver, [value, shift]) =>
    newBigInteger(call, shiftLeft(bigIntegerValue(value as Value), -(shift as number))),
  [`${BIG_INTEGER}.op_UnsignedRightShift`]: (call, _receiver, [value, shift]) =>
    newBigInteger(call, unsignedShiftRight(bigIntegerValue(value as Value), shift as number)),
  [`${BIG_INTEGER}.op_UnaryNegation`]: negate,
  [`${BIG_INTEGER}.op_UnaryPlus`]: unary((value) => value),
  [`${BIG_INTEGER}.op_OnesComplement`]: unary((value) => ~value),
  [`${BIG_INTEGER}.op_Increment`]: unary((value) => value + 1n),
  [`${BIG_INTEGER}.op_Decrement`]: unary((value) => value - 1n),
  [`${BIG_INTEGER}.op_Equality`]: comparison((order) => order === 0),
  [`${BIG_INTEGER}.op_Inequality`]: comparison((order) => order !== 0),
  [`${BIG_INTEGER}.op_LessThan`]: comparison((order) => order < 0),
  [`${BIG_INTEGER}.op_LessThanOrEqual`]: comparison((order) => order <= 0),
  [`${BIG_INTEGER}.op_GreaterThan`]: comparison((order) => order > 0),
  [`${BIG_INTEGER}.op_GreaterThanOrEqual`]: comparison((order) => order >= 0),
});
