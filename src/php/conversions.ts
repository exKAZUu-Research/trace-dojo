import { lower } from './bytes';
import { INT_MAX, INT_MIN, type Key, PhpArray, PhpObject, type Value } from './values';

/** Formats a float as PHP's `echo` does, with 14 significant digits (`precision=14`). */
export function formatFloat(value: number, precision = 14): string {
  if (Number.isNaN(value)) return 'NAN';
  if (!Number.isFinite(value)) return value > 0 ? 'INF' : '-INF';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const [digits, exponent] = decimalDigits(value, precision);
  return layoutDigits(value < 0, digits, exponent + 1, precision, 'E', false);
}

/** Formats a float as `var_dump` and `json_encode` do, with the shortest digits that read back (`serialize_precision=-1`). */
export function formatFloatRepr(value: number, exponentChar = 'E', zeroFraction = false): string {
  if (Number.isNaN(value)) return 'NAN';
  if (!Number.isFinite(value)) return value > 0 ? 'INF' : '-INF';
  if (value === 0) return `${Object.is(value, -0) ? '-0' : '0'}${zeroFraction ? '.0' : ''}`;
  const [digits, exponent] = shortestDigits(value);
  const text = layoutDigits(value < 0, digits, exponent + 1, 17, exponentChar, true);
  if (zeroFraction && !/[.eEN]/.test(text)) return `${text}.0`;
  return text;
}

/** The significant digits of `|value|` rounded to `precision`, without trailing zeros, and the decimal exponent. */
function decimalDigits(value: number, precision: number): [string, number] {
  const text = Math.abs(value).toExponential(precision - 1);
  const [mantissa, exponentText] = text.split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  return [digits, Number(exponentText)];
}

function shortestDigits(value: number): [string, number] {
  const text = Math.abs(value).toExponential();
  const [mantissa, exponentText] = text.split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  return [digits, Number(exponentText)];
}

/** Lays out digits as `zend_gcvt` does: exponential when the point falls before -3 or after `precision` digits. */
function layoutDigits(
  negative: boolean,
  digits: string,
  decpt: number,
  precision: number,
  exponentChar: string,
  _shortest: boolean
): string {
  const sign = negative ? '-' : '';
  if (decpt < -3 || decpt > precision) {
    const exponent = decpt - 1;
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : `${digits}.0`;
    return `${sign}${mantissa}${exponentChar}${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  if (digits.length <= decpt) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/** Whether a number is a whole float in the integer range, which converts to an int without loss. */
export function floatFitsInt(value: number): boolean {
  return Number.isFinite(value) && value >= -9.223_372_036_854_776e18 && value < 9.223_372_036_854_776e18;
}

/** Converts a float to an int as PHP does since 8.1: out of range or non-finite values become 0 on 64-bit... */
export function floatToInt(value: number): bigint {
  if (!Number.isFinite(value)) return 0n;
  if (!floatFitsInt(value)) {
    // PHP 8 on 64-bit platforms wraps out-of-range floats modulo 2^64 (zend_dval_to_lval_cap is not used).
    return 0n;
  }
  return BigInt(Math.trunc(value));
}

/** Wraps an integer that left the 64-bit range, for bitwise operations. */
export function wrapInt(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

/** The result of an integer operation, or the float PHP produces when it overflows. */
export function intOrFloat(value: bigint): bigint | number {
  if (value > INT_MAX || value < INT_MIN) return Number(value);
  return value;
}

export interface NumericPrefix {
  /** The number the string starts with. */
  value: bigint | number;
  /** Whether the whole string is numeric (allowing surrounding whitespace). */
  whole: boolean;
}

const NUMERIC = /^[ \t\n\r\v\f]*([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?)[ \t\n\r\v\f]*$/;
const NUMERIC_PREFIX = /^[ \t\n\r\v\f]*([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?)/;

/** Parses a numeric string as PHP does, or undefined when it does not even start with a number. */
export function numericPrefix(text: string): NumericPrefix | undefined {
  const whole = NUMERIC.exec(text);
  const match = whole ?? NUMERIC_PREFIX.exec(text);
  if (!match) return undefined;
  return { value: parseNumber(match[1]), whole: whole !== null };
}

/** Whether a string is numeric, as `is_numeric` and comparisons decide. */
export function isNumericString(text: string): boolean {
  return NUMERIC.test(text);
}

function parseNumber(text: string): bigint | number {
  if (/^[+-]?\d+$/.test(text)) {
    const value = BigInt(text);
    if (value <= INT_MAX && value >= INT_MIN) return value;
    return Number(text);
  }
  return Number(text);
}

/** The number a numeric string holds, or undefined when it is not wholly numeric. */
export function numericValue(text: string): bigint | number | undefined {
  const match = NUMERIC.exec(text);
  return match ? parseNumber(match[1]) : undefined;
}

/** Converts a value to an array key, as PHP does for `$a[$key]`. */
export function normalizeKeyString(text: string): Key {
  if (/^(0|-?[1-9]\d*)$/.test(text) && text.length <= 20) {
    const value = BigInt(text);
    if (value <= INT_MAX && value >= INT_MIN && text !== '-0') return value;
  }
  return text;
}

/** Converts to bool as PHP does. */
export function toBool(value: Value): boolean {
  if (value === null) return false;
  switch (typeof value) {
    case 'boolean': {
      return value;
    }
    case 'bigint': {
      return value !== 0n;
    }
    case 'number': {
      return value !== 0;
    }
    case 'string': {
      return value !== '' && value !== '0';
    }
  }
  if (value instanceof PhpArray) return value.size > 0;
  return true;
}

/** Converts an integer to its decimal text. */
export function intToString(value: bigint): string {
  return value.toString();
}

/** The PHP type name of a value, as `gettype` reports it. */
export function getType(value: Value): string {
  if (value === null) return 'NULL';
  switch (typeof value) {
    case 'boolean': {
      return 'boolean';
    }
    case 'bigint': {
      return 'integer';
    }
    case 'number': {
      return 'double';
    }
    case 'string': {
      return 'string';
    }
  }
  if (value instanceof PhpArray) return 'array';
  return (value as PhpObject).cls.name === '(stream)' ? 'resource' : 'object';
}

/** The type name in error messages and `get_debug_type`. */
export function debugType(value: Value): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': {
      return 'bool';
    }
    case 'bigint': {
      return 'int';
    }
    case 'number': {
      return 'float';
    }
    case 'string': {
      return 'string';
    }
  }
  if (value instanceof PhpArray) return 'array';
  const object = value as PhpObject;
  if (object.cls.name === '(stream)') return 'resource (stream)';
  return object.cls.isAnonymous ? anonymousDebugName(object) : object.cls.name;
}

/** The type name in "Unsupported operand types" and similar messages, which name objects by class too. */
export function zendTypeName(value: Value): string {
  return debugType(value);
}

function anonymousDebugName(object: PhpObject): string {
  const parent = object.cls.parent;
  if (parent) return `${parent.name}@anonymous`;
  const iface = object.cls.ownInterfaces[0];
  return iface ? `${iface.name}@anonymous` : 'class@anonymous';
}

/** Compares two strings as PHP's `strcmp` does, by bytes. */
export function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Case-insensitive name comparison for functions, classes, and methods. */
export function sameName(a: string, b: string): boolean {
  return lower(a) === lower(b);
}

export function sign(value: number | bigint): number {
  if (typeof value === 'bigint') return value < 0n ? -1 : value > 0n ? 1 : 0;
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

/** Compares two numbers of either kind exactly, as PHP compares an int with a float. */
export function compareNumbers(a: bigint | number, b: bigint | number): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return 1;
  if (typeof a === 'bigint' && Number.isFinite(y) && Number.isInteger(y)) {
    const big = BigInt(y);
    return a < big ? -1 : a > big ? 1 : 0;
  }
  if (typeof b === 'bigint' && Number.isFinite(x) && Number.isInteger(x)) {
    const big = BigInt(x);
    return big < b ? -1 : big > b ? 1 : 0;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}
