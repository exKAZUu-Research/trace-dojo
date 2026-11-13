import { bytesLikeData, latin1Text } from './bytesValues';
import { complexRepr, newComplex } from './complexNumbers';
import { pyRepr } from './conversions';
import { method } from './define';
import { formatComplex } from './formatComplex';
import { frexp, hashFloat, hashInt } from './hashing';
import { argument, checkArgs } from './nativeArgs';
import {
  exactDecimal,
  fixedText,
  floatRepr,
  floatToInt,
  intToFloat,
  intToString,
  parseFloatText,
  parseIntText,
  roundDecimal,
  toAsciiDigits,
  toIndex,
} from './numbers';
import { bindValue, callValue, isTruthy, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import { stripNumberSpace, strRepr } from './strings';
import {
  argumentTypeName,
  boolClass,
  complexClass,
  floatClass,
  intClass,
  newTuple,
  None,
  pyError,
  typeError,
  typeName,
  unbox,
  valueError,
} from './types';
import { PyComplex, PyInstance, type PyValue } from './values';

// int ---------------------------------------------------------------------------------------------------------------

intClass.construct = (cls, args, kwargs) => {
  // Called with keywords, int parses its arguments as a keyword parser does.
  const style = kwargs && kwargs.size > 0 ? 'takes' : 'expected';
  checkArgs({ qualified: 'int', min: 0, max: 2, style, keywords: ['base'], named: 1 }, args, kwargs);
  const value = args[0];
  const base = argument(args, kwargs, 1, 'base');
  if (value === undefined) {
    if (base !== undefined) throw typeError('int() missing string argument');
    return 0n;
  }
  if (base !== undefined) {
    const radix = Number(toIndex(base));
    if (radix !== 0 && (radix < 2 || radix > 36)) throw valueError('int() base must be >= 2 and <= 36, or 0');
    const text = unbox(value);
    if (typeof text === 'string') return parseIntOrThrow(text, radix);
    const data = bytesLikeData(value);
    if (data === undefined) throw typeError("int() can't convert non-string with explicit base");
    return parseIntOrThrow(latin1Text(data), radix, pyRepr(value));
  }
  void cls;
  return toInt(value);
};

/** `int(value)` for a value without a base. */
// code-gauge-allow functionCognitiveComplexity 21 -- Follows int() for each kind of argument.
export function toInt(value: PyValue): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return floatToInt(value);
  if (typeof value === 'string') return parseIntOrThrow(value, 10);
  const data = bytesLikeData(value);
  if (data !== undefined) return parseIntOrThrow(latin1Text(data), 10, pyRepr(value));
  for (const name of ['__int__', '__index__']) {
    const special = lookupSpecial(value, name);
    if (special === undefined) continue;
    const result = callValue(bindValue(special, value), []);
    if (typeof result === 'bigint') return result;
    if (typeof result === 'boolean') return result ? 1n : 0n;
    throw typeError(`${name} returned non-int (type ${typeName(result)})`);
  }
  if (value instanceof PyInstance && typeof value.primitive === 'string') return parseIntOrThrow(value.primitive, 10);
  throw typeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(value)}'`);
}

function parseIntOrThrow(text: string, base: number, shown?: string): bigint {
  const result = parseIntText(text, base);
  if (result === undefined)
    throw valueError(
      `invalid literal for int() with base ${base}: ${shown ?? strRepr(text.length > 200 ? `${text.slice(0, 200)}` : text)}`
    );
  return result;
}

const intLike = (self: PyValue): bigint => (typeof self === 'boolean' ? (self ? 1n : 0n) : (self as bigint));

method(intClass, '__repr__', 'none', 0, 0, (self) => intToString(intLike(self)));
method(intClass, '__hash__', 'none', 0, 0, (self) => hashInt(intLike(self)));
method(intClass, '__index__', 'none', 0, 0, (self) => intLike(self));
method(intClass, '__int__', 'none', 0, 0, (self) => intLike(self));
method(intClass, '__float__', 'none', 0, 0, (self) => intToFloat(intLike(self)));
method(intClass, '__bool__', 'none', 0, 0, (self) => intLike(self) !== 0n);
method(intClass, '__abs__', 'none', 0, 0, (self) => {
  const value = intLike(self);
  return value < 0n ? -value : value;
});
method(intClass, 'bit_length', 'none', 0, 0, (self) => {
  const value = intLike(self);
  return value === 0n ? 0n : BigInt((value < 0n ? -value : value).toString(2).length);
});
method(intClass, 'bit_count', 'none', 0, 0, (self) => {
  const value = intLike(self);
  return BigInt((value < 0n ? -value : value).toString(2).replaceAll('0', '').length);
});
method(intClass, 'as_integer_ratio', 'none', 0, 0, (self) => newTuple([intLike(self), 1n]));
method(intClass, 'is_integer', 'none', 0, 0, () => true);
method(intClass, 'conjugate', 'none', 0, 0, (self) => intLike(self));
method(intClass, '__round__', 'expected', 0, 1, (self, [digits]) => roundInt(intLike(self), digits));

/** `round(n, digits)` for an int, rounding halves to even. */
export function roundInt(value: bigint, digits: PyValue | undefined): bigint {
  if (digits === undefined || digits === None) return value;
  const places = toIndex(digits);
  if (places >= 0n) return value;
  const magnitude = value < 0n ? -value : value;
  // A value with fewer digits than the rounding unit's zeros rounds to zero, which needs no huge power of ten.
  if (BigInt(magnitude.toString(16).length * 4) * 30_103n < -places * 100_000n - 100_000n) return 0n;
  currentRuntime().chargeBits(-places * 4n);
  const unit = 10n ** -places;
  const remainder = ((value % unit) + unit) % unit;
  const down = value - remainder;
  const twice = remainder * 2n;
  if (twice > unit || (twice === unit && (down / unit) % 2n !== 0n)) return down + unit;
  return down;
}

// bool --------------------------------------------------------------------------------------------------------------

boolClass.construct = (_cls, args, kwargs) => {
  checkArgs({ qualified: 'bool', min: 0, max: 1, style: 'expected' }, args, kwargs);
  return args.length === 0 ? false : isTruthy(args[0]);
};
method(boolClass, '__repr__', 'none', 0, 0, (self) => (self ? 'True' : 'False'));

// float -------------------------------------------------------------------------------------------------------------

floatClass.construct = (_cls, args, kwargs) => {
  checkArgs({ qualified: 'float', min: 0, max: 1, style: 'expected' }, args, kwargs);
  return args.length === 0 ? 0 : toFloat(args[0]);
};

/** `float(value)`. */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows float() for each kind of argument.
// code-gauge-allow functionNcss 31 -- Follows float() for each kind of argument.
export function toFloat(value: PyValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return intToFloat(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const result = parseFloatText(value);
    if (result === undefined) throw valueError(`could not convert string to float: ${strRepr(value)}`);
    return result;
  }
  const data = bytesLikeData(value);
  if (data !== undefined) {
    const result = parseFloatText(latin1Text(data));
    if (result === undefined) throw valueError(`could not convert string to float: ${pyRepr(value)}`);
    return result;
  }
  for (const name of ['__float__', '__index__']) {
    const special = lookupSpecial(value, name);
    if (special === undefined) continue;
    const result = callValue(bindValue(special, value), []);
    if (typeof result === 'number') return result;
    if (name === '__index__' && (typeof result === 'bigint' || typeof result === 'boolean')) return toFloat(result);
    throw typeError(`${typeName(value)}.${name} returned non-float (type ${typeName(result)})`);
  }
  if (value instanceof PyInstance && typeof value.primitive === 'string') return toFloat(value.primitive);
  throw typeError(`float() argument must be a string or a real number, not '${typeName(value)}'`);
}

method(floatClass, '__repr__', 'none', 0, 0, (self) => floatRepr(self as number));
method(floatClass, '__hash__', 'none', 0, 0, (self) => hashFloat(self as number));
method(floatClass, '__float__', 'none', 0, 0, (self) => self);
method(floatClass, '__int__', 'none', 0, 0, (self) => floatToInt(self as number));
method(floatClass, '__trunc__', 'none', 0, 0, (self) => floatToInt(self as number));
method(floatClass, '__bool__', 'none', 0, 0, (self) => (self as number) !== 0);
method(floatClass, '__abs__', 'none', 0, 0, (self) => Math.abs(self as number));
method(floatClass, 'is_integer', 'none', 0, 0, (self) => Number.isInteger(self as number));
method(floatClass, 'conjugate', 'none', 0, 0, (self) => self);
method(floatClass, 'as_integer_ratio', 'none', 0, 0, (self) => floatRatio(self as number));
method(floatClass, '__round__', 'expected', 0, 1, (self, [digits]) => roundFloat(self as number, digits));

/** `float.as_integer_ratio()`: the exact fraction in lowest terms. */
function floatRatio(value: number): PyValue {
  if (Number.isNaN(value)) throw valueError('cannot convert NaN to integer ratio');
  if (!Number.isFinite(value)) throw pyError('OverflowError', 'cannot convert Infinity to integer ratio');
  let { mantissa, exponent } = frexp(value);
  for (let index = 0; index < 300 && mantissa !== Math.floor(mantissa); index++) {
    mantissa *= 2;
    exponent--;
  }
  let numerator = BigInt(mantissa);
  let denominator = 1n;
  if (exponent > 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator);
  if (divisor > 1n) {
    numerator /= divisor;
    denominator /= divisor;
  }
  return newTuple([numerator, denominator]);
}

const GCD_SMALL_INT = 1n << 64n;
const GCD_BITS_PER_OPERATION = 1 << 13;

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  if (x < GCD_SMALL_INT && y < GCD_SMALL_INT) {
    while (y) [x, y] = [y, x % y];
    return x;
  }
  const bits = Math.max(x.toString(16).length, y.toString(16).length) * 4;
  let work = 0;
  while (y) {
    work += bits;
    if (work >= GCD_BITS_PER_OPERATION) {
      currentRuntime().spend(Math.floor(work / GCD_BITS_PER_OPERATION));
      work %= GCD_BITS_PER_OPERATION;
    }
    [x, y] = [y, x % y];
  }
  return x;
}

/** `round(x, digits)` for a float: to an int halving to even, or to a float rounded correctly at `digits`. */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows float.__round__, including its exact halfway cases.
export function roundFloat(value: number, digits: PyValue | undefined): PyValue {
  if (digits === undefined || digits === None) {
    if (Number.isNaN(value)) throw valueError('cannot convert float NaN to integer');
    if (!Number.isFinite(value)) throw pyError('OverflowError', 'cannot convert float infinity to integer');
    const floor = Math.floor(value);
    const difference = value - floor;
    const rounded = difference > 0.5 || (difference === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
    return BigInt(rounded);
  }
  const places = Number(toIndex(digits));
  if (!Number.isFinite(value) || value === 0) return value;
  if (places > 400) return value;
  if (places < -400) return Object.is(value, -0) || value < 0 ? -0 : 0;
  const decimal = exactDecimal(value);
  const rounded = roundDecimal(decimal, decimal.point + places);
  const text = rounded.digits === '0' ? '0' : fixedText(rounded, Math.max(places, 0));
  const result = Number(text) * Math.sign(value);
  if (!Number.isFinite(result)) throw pyError('OverflowError', 'rounded value too large to represent');
  return result === 0 ? (value < 0 ? -0 : 0) : result;
}

// complex -----------------------------------------------------------------------------------------------------------

complexClass.construct = (_cls, args, kwargs) => {
  checkArgs(
    { qualified: 'complex', min: 0, max: 2, style: 'takes', keywords: ['real', 'imag'], named: 2 },
    args,
    kwargs
  );
  const real = argument(args, kwargs, 0, 'real') ?? false;
  const imag = argument(args, kwargs, 1, 'imag');
  if (imag === undefined) return complexOf(real);
  const a = namedPart(real, 'real');
  const b = namedPart(imag, 'imag');
  // A part combines with the other argument only when that one is complex: adding a zero would drop the sign of -0.0.
  return newComplex(b.isComplex ? a.real - b.imag : a.real, a.isComplex ? b.real + a.imag : b.real);
};

interface ComplexPart {
  real: number;
  imag: number;
  isComplex: boolean;
}

/** `complex(value)`: a string is parsed, and any other value converts as a number. */
function complexOf(value: PyValue): PyComplex {
  if (typeof value === 'string') return parseComplex(value);
  const part = complexPartOf(value, true);
  if (!part) throw typeError(`complex() argument must be a string or a number, not ${typeName(value)}`);
  return newComplex(part.real, part.imag);
}

function namedPart(value: PyValue, name: 'real' | 'imag'): ComplexPart {
  const part = typeof value === 'string' ? undefined : complexPartOf(value, name === 'real');
  if (!part) throw typeError(`complex() argument '${name}' must be a real number, not ${typeName(value)}`);
  return part;
}

/** The number an argument of `complex()` stands for, or undefined for no number; only `real` is asked `__complex__`. */
function complexPartOf(value: PyValue, asksComplexMethod: boolean): ComplexPart | undefined {
  if (value instanceof PyComplex) return { real: value.real, imag: value.imag, isComplex: true };
  const special = asksComplexMethod ? lookupSpecial(value, '__complex__') : undefined;
  if (special !== undefined) {
    const result = callValue(bindValue(special, value), []);
    if (!(result instanceof PyComplex)) {
      throw typeError(`__complex__ returned non-complex (type ${typeName(result)})`);
    }
    return { real: result.real, imag: result.imag, isComplex: true };
  }
  const isReal =
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    lookupSpecial(value, '__float__') !== undefined ||
    lookupSpecial(value, '__index__') !== undefined;
  return isReal ? { real: toFloat(value), imag: 0, isComplex: false } : undefined;
}

function parseComplex(text: string): PyComplex {
  // A part accepts what float() accepts: Unicode decimal digits and single underscores between digits.
  const body = stripNumberSpace(stripNumberSpace(toAsciiDigits(text)).replace(/^\((.*)\)$/, '$1'));
  // The digits before and after the point are told apart by the point, so that a long number is not matched in every
  // split of its digits.
  const digits = String.raw`\d(?:_?\d)*`;
  const exponent = String.raw`(?:[eE][+-]?${digits})?`;
  const unsigned = `(?:${digits}(?:\\.(?:${digits})?)?${exponent}|\\.${digits}${exponent}|inf(?:inity)?|nan)`;
  const number = `[+-]?${unsigned}`;
  const full = new RegExp(`^(${number})([+-]${unsigned}?)[jJ]$`, 'i');
  const imaginaryOnly = new RegExp(`^(${number}|[+-])?[jJ]$`, 'i');
  const realOnly = new RegExp(`^${number}$`, 'i');
  let match = full.exec(body);
  if (match) return newComplex(parseFloatText(match[1]) ?? Number.NaN, imagPart(match[2]));
  match = imaginaryOnly.exec(body);
  if (match) return newComplex(0, imagPart(match[1] ?? '+'));
  if (realOnly.test(body)) return newComplex(parseFloatText(body) ?? Number.NaN, 0);
  // CPython checks the underscores first and reports a string it cannot read with them in its own words.
  if (text.includes('_')) throw valueError(`could not convert string to complex: ${pyRepr(text)}`);
  throw valueError('complex() arg is a malformed string');
}

function imagPart(text: string): number {
  if (text === '+' || text === '') return 1;
  if (text === '-') return -1;
  return parseFloatText(text) ?? Number.NaN;
}

method(complexClass, '__repr__', 'none', 0, 0, (self) => complexRepr(self as PyComplex));
method(complexClass, '__format__', 'one', 1, 1, (self, [spec]) => {
  if (typeof spec !== 'string') throw typeError(`__format__() argument must be str, not ${argumentTypeName(spec)}`);
  return formatComplex(self as PyComplex, spec);
});
method(complexClass, 'conjugate', 'none', 0, 0, (self) =>
  newComplex((self as PyComplex).real, -(self as PyComplex).imag)
);
method(
  complexClass,
  '__bool__',
  'none',
  0,
  0,
  (self) => (self as PyComplex).real !== 0 || (self as PyComplex).imag !== 0
);

export { pyRepr };
