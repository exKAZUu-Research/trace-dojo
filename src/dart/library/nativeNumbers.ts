import { formatDouble } from '../format';
import { doubleModulo, intModulo, intRemainder, numericBinary, shiftLeft, truncateToInt, wrap } from '../operators';
import type { Runtime } from '../runtime';
import type { Value } from '../values';
import { define, defineAll, intArg, named, numArg, stringArg } from './nativeSupport';

const MAX_INT = 9_223_372_036_854_775_807n;

function toDouble(value: bigint | number): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

/** `num.compareTo`, which orders -0.0 before 0.0 and NaN after every number. */
export function compareNumbers(a: bigint | number, b: bigint | number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
  if (Number.isNaN(b)) return -1;
  if (Object.is(a, -0)) return Object.is(b, -0) ? 0 : -1;
  return Object.is(b, -0) ? 1 : 0;
}

/**
 * The VM's hash of a number: an int multiplied by 0x2d51 in 128 bits with the halves folded together, an integral
 * double as the int it equals, and any other double as the bits of its representation.
 */
export function numberHash(value: bigint | number): bigint {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Math.abs(value) < 2 ** 63) return intHash(BigInt(value));
    // The VM folds the bits of a double that is not an int and keeps them in its small-integer range.
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    return (bits ^ (bits >> 32n)) & 0x3f_ff_ff_ff_ff_ff_ff_ffn;
  }
  return intHash(value);
}

function intHash(value: bigint): bigint {
  const product = BigInt.asUintN(64, value) * 0x2d_51n;
  let hash = BigInt.asUintN(64, product) ^ (product >> 64n);
  hash ^= hash >> 32n;
  return hash & 0x3f_ff_ff_ffn;
}

function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

function toIntChecked(runtime: Runtime, value: number): bigint {
  return truncateToInt(runtime, value);
}

function checkDigits(runtime: Runtime, digits: Value, min: number, max: number, name: string): number {
  const count = Number(intArg(runtime, digits, name));
  if (count < min || count > max) runtime.throwError('RangeError', 'range', [digits, BigInt(min), BigInt(max), name]);
  return count;
}

function nonFiniteText(value: number): string | undefined {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return undefined;
}

export function toStringAsFixed(runtime: Runtime, value: number, digits: Value): string {
  const count = checkDigits(runtime, digits, 0, 20, 'fractionDigits');
  const special = nonFiniteText(value);
  if (special) return special;
  if (Math.abs(value) >= 1e21) return formatDouble(value);
  const text = value.toFixed(count);
  return Object.is(value, -0) || (value < 0 && !text.startsWith('-')) ? `-${text}` : text;
}

function toStringAsExponential(runtime: Runtime, value: number, digits: Value): string {
  const count = digits === undefined ? undefined : checkDigits(runtime, digits, 0, 20, 'fractionDigits');
  const special = nonFiniteText(value);
  if (special) return special;
  const text = count === undefined ? value.toExponential() : value.toExponential(count);
  return Object.is(value, -0) ? `-${text}` : text;
}

function toStringAsPrecision(runtime: Runtime, value: number, digits: Value): string {
  const count = checkDigits(runtime, digits, 1, 21, 'precision');
  const special = nonFiniteText(value);
  if (special) return special;
  const text = value.toPrecision(count);
  return Object.is(value, -0) ? `-${text}` : text;
}

const DOUBLE_PATTERN = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity|NaN)$/;

export function parseDouble(text: string): number | undefined {
  const trimmed = text.trim();
  if (!DOUBLE_PATTERN.test(trimmed)) return undefined;
  if (trimmed.endsWith('NaN')) return Number.NaN;
  return Number(trimmed);
}

// code-gauge-allow functionCognitiveComplexity 18 -- Verify the whole digit sequence while capping the accumulator.
function parseInt(
  runtime: Runtime,
  text: string,
  radix: number | undefined
): bigint | 'Negative' | 'Positive' | undefined {
  runtime.spend(1 + text.length / 64);
  let rest = text.trim();
  let negative = false;
  if (rest.startsWith('-') || rest.startsWith('+')) {
    negative = rest.startsWith('-');
    rest = rest.slice(1);
  }
  let base = radix ?? 10;
  if (radix === undefined && /^0[xX]/.test(rest)) {
    base = 16;
    rest = rest.slice(2);
  }
  if (rest.length === 0) return undefined;
  const unsignedHex = base === 16 && radix === undefined && !negative;
  const bound = unsignedHex ? 0xff_ff_ff_ff_ff_ff_ff_ffn : negative ? MAX_INT + 1n : MAX_INT;
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
  const bigBase = BigInt(base);
  let result = 0n;
  for (const char of rest.toLowerCase()) {
    const digit = digits.indexOf(char);
    if (digit === -1) return undefined;
    if (result <= bound) result = result * bigBase + BigInt(digit);
  }
  if (result > bound) return negative ? 'Negative' : 'Positive';
  return negative ? -result : wrap(result);
}

function tryParseInt(runtime: Runtime, text: string, radix?: number): bigint | undefined {
  const result = parseInt(runtime, text, radix);
  return typeof result === 'bigint' ? result : undefined;
}

function checkRadix(runtime: Runtime, radix: Value): number | undefined {
  if (radix === undefined) return undefined;
  const value = Number(intArg(runtime, radix, 'radix'));
  if (value < 2 || value > 36) runtime.throwError('RangeError', '', [`Radix ${value} not in range 2..36`]);
  return value;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n % modulus;
  let current = ((base % modulus) + modulus) % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * current) % modulus;
    current = (current * current) % modulus;
    remaining >>= 1n;
  }
  return result;
}

export function modInverse(runtime: Runtime, value: bigint, modulus: bigint): bigint {
  if (modulus <= 0n) runtime.throwError('RangeError', 'range', [modulus, 1n, undefined, 'modulus']);
  if (modulus === 1n) return 0n;
  let [oldR, r] = [((value % modulus) + modulus) % modulus, modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  if (oldR !== 1n) runtime.throwError('Exception', '', ['Not coprime']);
  return ((oldS % modulus) + modulus) % modulus;
}

export function bitLength(value: bigint): number {
  const magnitude = value < 0n ? ~value : value;
  return magnitude === 0n ? 0 : magnitude.toString(2).length;
}

function sign(value: bigint | number): Value {
  if (typeof value === 'bigint') return value > 0n ? 1n : value < 0n ? -1n : 0n;
  if (Number.isNaN(value) || value === 0) return value;
  return value > 0 ? 1 : -1;
}

function clamp(runtime: Runtime, value: bigint | number, lower: Value, upper: Value): Value {
  const low = numArg(runtime, lower, 'lowerLimit');
  const high = numArg(runtime, upper, 'upperLimit');
  if (compareNumbers(low, high) > 0) runtime.throwError('ArgumentError', '', [lower]);
  if (typeof value === 'number' && Number.isNaN(value)) return value;
  if (compareNumbers(value, low) < 0) return low;
  if (compareNumbers(value, high) > 0) return high;
  return value;
}

defineAll(['num.==', 'int.==', 'double.=='], (runtime, self, [other]) => runtime.equals(self, other));
defineAll(['num.hashCode', 'int.hashCode', 'double.hashCode'], (_runtime, self) => numberHash(self as bigint | number));
defineAll(['num.compareTo', 'int.compareTo', 'double.compareTo'], (runtime, self, [other]) =>
  BigInt(compareNumbers(self as bigint | number, numArg(runtime, other, 'other')))
);
for (const operator of ['+', '-', '*', '/', '~/', '<', '<=', '>', '>=']) {
  defineAll([`num.${operator}`, `int.${operator}`, `double.${operator}`], (runtime, self, [other]) =>
    numericBinary(runtime, operator, self as bigint | number, numArg(runtime, other, 'other'))
  );
}
defineAll(['num.%', 'int.%', 'double.%'], (runtime, self, [other]) => {
  const right = numArg(runtime, other, 'other');
  if (typeof self === 'bigint' && typeof right === 'bigint') return intModulo(runtime, self, right);
  return doubleModulo(toDouble(self as bigint | number), toDouble(right));
});
defineAll(['num.remainder', 'int.remainder', 'double.remainder'], (runtime, self, [other]) => {
  const right = numArg(runtime, other, 'other');
  if (typeof self === 'bigint' && typeof right === 'bigint') return intRemainder(runtime, self, right);
  return toDouble(self as bigint | number) % toDouble(right);
});
for (const operator of ['&', '|', '^', '<<', '>>', '>>>']) {
  define(`int.${operator}`, (runtime, self, [other]) =>
    numericBinary(runtime, operator, self as bigint, intArg(runtime, other, 'other'))
  );
}
define('int.~', (_runtime, self) => ~(self as bigint));
defineAll(['num.unary-', 'int.unary-', 'double.unary-'], (_runtime, self) =>
  typeof self === 'bigint' ? wrap(-self) : -(self as number)
);
defineAll(
  ['num.isNaN', 'int.isNaN', 'double.isNaN'],
  (_runtime, self) => typeof self === 'number' && Number.isNaN(self)
);
defineAll(['num.isNegative', 'int.isNegative', 'double.isNegative'], (_runtime, self) =>
  typeof self === 'bigint' ? self < 0n : (self as number) < 0 || Object.is(self, -0)
);
defineAll(
  ['num.isInfinite', 'int.isInfinite', 'double.isInfinite'],
  (_runtime, self) => typeof self === 'number' && !Number.isFinite(self) && !Number.isNaN(self)
);
defineAll(
  ['num.isFinite', 'int.isFinite', 'double.isFinite'],
  (_runtime, self) => typeof self === 'bigint' || Number.isFinite(self)
);
defineAll(['num.abs', 'int.abs', 'double.abs'], (_runtime, self) =>
  typeof self === 'bigint' ? wrap(self < 0n ? -self : self) : Math.abs(self as number)
);
defineAll(['num.sign', 'int.sign', 'double.sign'], (_runtime, self) => sign(self as bigint | number));
for (const [name, round] of [
  ['round', roundHalfAway],
  ['floor', Math.floor],
  ['ceil', Math.ceil],
  ['truncate', Math.trunc],
] as const) {
  defineAll([`num.${name}`, `int.${name}`, `double.${name}`], (runtime, self) =>
    typeof self === 'bigint' ? self : toIntChecked(runtime, round(self as number))
  );
  defineAll([`num.${name}ToDouble`, `int.${name}ToDouble`, `double.${name}ToDouble`], (_runtime, self) => {
    if (typeof self === 'bigint') return Number(self);
    const value = self as number;
    if (!Number.isFinite(value)) return value;
    const result = round(value);
    // Rounding keeps the sign of a zero result, as -0.0 shows.
    return result === 0 && (value < 0 || Object.is(value, -0)) ? -0 : result;
  });
}
defineAll(['num.clamp', 'int.clamp', 'double.clamp'], (runtime, self, [lower, upper]) =>
  clamp(runtime, self as bigint | number, lower, upper)
);
defineAll(['num.toInt', 'int.toInt', 'double.toInt'], (runtime, self) =>
  typeof self === 'bigint' ? self : toIntChecked(runtime, Math.trunc(self as number))
);
defineAll(['num.toDouble', 'int.toDouble', 'double.toDouble'], (_runtime, self) => toDouble(self as bigint | number));
defineAll(['num.toStringAsFixed', 'int.toStringAsFixed', 'double.toStringAsFixed'], (runtime, self, [digits]) =>
  toStringAsFixed(runtime, toDouble(self as bigint | number), digits)
);
defineAll(
  ['num.toStringAsExponential', 'int.toStringAsExponential', 'double.toStringAsExponential'],
  (runtime, self, [digits]) => toStringAsExponential(runtime, toDouble(self as bigint | number), digits)
);
defineAll(
  ['num.toStringAsPrecision', 'int.toStringAsPrecision', 'double.toStringAsPrecision'],
  (runtime, self, [digits]) => toStringAsPrecision(runtime, toDouble(self as bigint | number), digits)
);
defineAll(['num.toString', 'int.toString', 'double.toString'], (_runtime, self) =>
  typeof self === 'bigint' ? self.toString() : formatDouble(self as number)
);
define('int.toRadixString', (runtime, self, [radix]) => {
  const value = Number(intArg(runtime, radix, 'radix'));
  if (value < 2 || value > 36) runtime.throwError('RangeError', 'range', [radix, 2n, 36n, 'radix']);
  return (self as bigint).toString(value);
});
define('int.isEven', (_runtime, self) => ((self as bigint) & 1n) === 0n);
define('int.isOdd', (_runtime, self) => ((self as bigint) & 1n) === 1n);
define('int.bitLength', (_runtime, self) => BigInt(bitLength(self as bigint)));
define(
  'int.toUnsigned',
  (runtime, self, [width]) => (self as bigint) & wrap(shiftLeft(runtime, 1n, intArg(runtime, width, 'width')) - 1n)
);
define('int.toSigned', (runtime, self, [width]) => {
  const value = self as bigint;
  const signMask = shiftLeft(runtime, 1n, wrap(intArg(runtime, width, 'width') - 1n));
  return wrap((value & wrap(signMask - 1n)) - (value & signMask));
});
define('int.gcd', (runtime, self, [other]) => gcd(self as bigint, intArg(runtime, other, 'other')));
define('int.modPow', (runtime, self, [exponent, modulus]) => {
  const e = intArg(runtime, exponent, 'exponent');
  const m = intArg(runtime, modulus, 'modulus');
  if (e < 0n) runtime.throwError('RangeError', 'range', [exponent, 0n, undefined, 'exponent']);
  if (m <= 0n) runtime.throwError('RangeError', 'range', [modulus, 1n, undefined, 'modulus']);
  return modPow(self as bigint, e, m);
});
define('int.modInverse', (runtime, self, [modulus]) =>
  modInverse(runtime, self as bigint, intArg(runtime, modulus, 'modulus'))
);
define('int.fromEnvironment', (_runtime, _self, _args, namedArgs) => named(namedArgs, 'defaultValue', 0n));

function throwFormat(runtime: Runtime, message: string, source: string, offset?: bigint): never {
  runtime.throwError('FormatException', '', [message, source, offset]);
}

define('int.parse', (runtime, _self, [source], namedArgs) => {
  const text = stringArg(runtime, source, 'source');
  const radix = checkRadix(runtime, named(namedArgs, 'radix', undefined));
  const result = parseInt(runtime, text, radix);
  const onError = named(namedArgs, 'onError', undefined);
  if (typeof result === 'bigint') return result;
  if (onError !== undefined) {
    return runtime.callValue(onError, { positional: [text], named: undefined }, [], runtime.userCallRow);
  }
  if (result !== undefined) throwFormat(runtime, `${result} input exceeds the limit of integer`, text);
  if (text.trim().length === 0 && radix === undefined) throwFormat(runtime, 'Invalid number', text, 0n);
  throwFormat(runtime, `Invalid radix-${radix ?? 10} number`, text, 0n);
});
define('int.tryParse', (runtime, _self, [source], namedArgs) =>
  tryParseInt(runtime, stringArg(runtime, source, 'source'), checkRadix(runtime, named(namedArgs, 'radix', undefined)))
);
define('double.parse', (runtime, _self, [source]) => {
  const text = stringArg(runtime, source, 'source');
  const result = parseDouble(text);
  if (result === undefined) throwFormat(runtime, 'Invalid double', text);
  return result;
});
define('double.tryParse', (runtime, _self, [source]) => parseDouble(stringArg(runtime, source, 'source')));
define('num.parse', (runtime, _self, [source]) => {
  const text = stringArg(runtime, source, 'input');
  const result = tryParseInt(runtime, text) ?? parseDouble(text);
  if (result === undefined) runtime.throwError('FormatException', '', [text]);
  return result;
});
define('num.tryParse', (runtime, _self, [source]) => {
  const text = stringArg(runtime, source, 'input');
  return tryParseInt(runtime, text) ?? parseDouble(text);
});

// bool

define('bool.hashCode', (_runtime, self) => (self ? 1231n : 1237n));
define('bool.&', (_runtime, self, [other]) => (self as boolean) && (other as boolean));
define('bool.|', (_runtime, self, [other]) => (self as boolean) || (other as boolean));
define('bool.^', (_runtime, self, [other]) => self !== other);
define('bool.toString', (_runtime, self) => (self ? 'true' : 'false'));
function parseBool(text: string, caseSensitive: boolean): boolean | undefined {
  const value = caseSensitive ? text : text.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
define('bool.parse', (runtime, _self, [source], namedArgs) => {
  const text = stringArg(runtime, source, 'source');
  const result = parseBool(text, named(namedArgs, 'caseSensitive', true) as boolean);
  if (result === undefined) throwFormat(runtime, 'Invalid boolean', text);
  return result;
});
define('bool.tryParse', (runtime, _self, [source], namedArgs) =>
  parseBool(stringArg(runtime, source, 'source'), named(namedArgs, 'caseSensitive', true) as boolean)
);

export { MAX_INT, toDouble };
