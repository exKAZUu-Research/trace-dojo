import { complexRepr, newComplex } from './complexNumbers';
import { pyRepr } from './conversions';
import { method } from './define';
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
  toIndex,
} from './numbers';
import { bindValue, callValue, isTruthy, lookupSpecial } from './objects';
import { strRepr } from './strings';
import {
  boolClass,
  complexClass,
  floatClass,
  intClass,
  newTuple,
  None,
  pyError,
  typeError,
  typeName,
  valueError,
} from './types';
import { PyComplex, PyInstance, type PyValue } from './values';

// int ---------------------------------------------------------------------------------------------------------------

intClass.construct = (cls, args, kwargs) => {
  checkArgs({ qualified: 'int', min: 0, max: 2, style: 'expected', keywords: ['base'] }, args, kwargs);
  const value = args[0];
  const base = argument(args, kwargs, 1, 'base');
  if (value === undefined) {
    if (base !== undefined) throw typeError('int() missing string argument');
    return 0n;
  }
  if (base !== undefined) {
    const radix = Number(toIndex(base));
    if (radix !== 0 && (radix < 2 || radix > 36)) throw valueError('int() base must be >= 2 and <= 36, or 0');
    if (typeof value !== 'string') throw typeError("int() can't convert non-string with explicit base");
    return parseIntOrThrow(value, radix);
  }
  void cls;
  return toInt(value);
};

/** `int(value)` for a value without a base. */
// code-gauge-allow functionCognitiveComplexity 18 -- Follows int() for each kind of argument.
export function toInt(value: PyValue): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return floatToInt(value);
  if (typeof value === 'string') return parseIntOrThrow(value, 10);
  for (const name of ['__int__', '__index__', '__trunc__']) {
    const special = lookupSpecial(value, name);
    if (special === undefined) continue;
    const result = callValue(bindValue(special, value), []);
    if (typeof result === 'bigint') return result;
    if (typeof result === 'boolean') return result ? 1n : 0n;
    throw typeError(`${name} returned non-int (type ${typeName(result)})`);
  }
  if (value instanceof PyInstance && value.enumValue !== undefined && typeof value.enumValue === 'bigint')
    return value.enumValue;
  throw typeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(value)}'`);
}

function parseIntOrThrow(text: string, base: number): bigint {
  const result = parseIntText(text, base);
  if (result === undefined)
    throw valueError(
      `invalid literal for int() with base ${base}: ${strRepr(text.length > 200 ? `${text.slice(0, 200)}` : text)}`
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
method(intClass, 'to_bytes', 'expected', 0, 3, () => {
  throw valueError('int.to_bytes() はこの採点環境では使えません。');
});

/** `round(n, digits)` for an int, rounding halves to even. */
export function roundInt(value: bigint, digits: PyValue | undefined): bigint {
  if (digits === undefined || digits === None) return value;
  const places = toIndex(digits);
  if (places >= 0n) return value;
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
// code-gauge-allow functionCognitiveComplexity 17 -- Follows float() for each kind of argument.
export function toFloat(value: PyValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return intToFloat(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const result = parseFloatText(value);
    if (result === undefined) throw valueError(`could not convert string to float: ${strRepr(value)}`);
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

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
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
  checkArgs({ qualified: 'complex', min: 0, max: 2, style: 'takes', keywords: ['real', 'imag'] }, args, kwargs);
  const real = argument(args, kwargs, 0, 'real') ?? 0n;
  const imag = argument(args, kwargs, 1, 'imag') ?? 0n;
  if (typeof real === 'string') return parseComplex(real);
  const [a, b] = toParts(real);
  const [c, d] = toParts(imag);
  return newComplex(a - d, b + c);
};

function toParts(value: PyValue): [number, number] {
  return value instanceof PyComplex ? [value.real, value.imag] : [toFloatStrict(value), 0];
}

function toFloatStrict(value: PyValue): number {
  if (typeof value === 'string') throw typeError("complex() second arg can't be a string");
  return toFloat(value);
}

function parseComplex(text: string): PyComplex {
  const body = text
    .trim()
    .replace(/^\((.*)\)$/, '$1')
    .trim();
  const number = String.raw`[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|inf|nan)`;
  const full = new RegExp(
    `^(${number})([+-](?:\\d+\\.?\\d*(?:[eE][+-]?\\d+)?|\\.\\d+(?:[eE][+-]?\\d+)?|inf|nan)?)[jJ]$`,
    'i'
  );
  const imaginaryOnly = new RegExp(`^(${number})?[jJ]$`, 'i');
  const realOnly = new RegExp(`^${number}$`, 'i');
  let match = full.exec(body);
  if (match) return newComplex(Number(match[1]), imagPart(match[2]));
  match = imaginaryOnly.exec(body);
  if (match) return newComplex(0, imagPart(match[1] ?? '+'));
  if (realOnly.test(body)) return newComplex(parseFloatText(body) ?? Number.NaN, 0);
  throw valueError('complex() arg is a malformed string');
}

function imagPart(text: string): number {
  if (text === '+' || text === '') return 1;
  if (text === '-') return -1;
  return parseFloatText(text) ?? Number.NaN;
}

method(complexClass, '__repr__', 'none', 0, 0, (self) => complexRepr(self as PyComplex));
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
