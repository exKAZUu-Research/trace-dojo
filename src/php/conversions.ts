import { warn } from './errors';
import { trimmedSignificantDigits } from './strings';
import { INT_MAX, INT_MIN, type Key, PhpArray, type PhpObject, type Value } from './values';

/** Formats a float as PHP's `echo` does, with 14 significant digits (`precision=14`). */
export function formatFloat(value: number, precision = 14): string {
  if (Number.isNaN(value)) return 'NAN';
  if (!Number.isFinite(value)) return value > 0 ? 'INF' : '-INF';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const { digits, exponent } = trimmedSignificantDigits(value, precision);
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
  return Number.isFinite(value) && value >= -9.223372036854776e18 && value < 9.223372036854776e18;
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
// code-gauge-allow duplicateLines 17 -- Mirrors toStr, as PHP converts each type to bool and to string by separate rules.
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
      if (Number.isNaN(value)) warn('unexpected NAN value was coerced to bool');
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

/** The names of the scalar types, as `gettype` and error messages write them. */
const SCALAR_TYPE_NAMES = {
  boolean: { gettype: 'boolean', debug: 'bool' },
  bigint: { gettype: 'integer', debug: 'int' },
  number: { gettype: 'double', debug: 'float' },
  string: { gettype: 'string', debug: 'string' },
} as const;

/** The PHP type name of a value, as `gettype` reports it. */
export function getType(value: Value): string {
  if (value === null) return 'NULL';
  if (typeof value !== 'object') return SCALAR_TYPE_NAMES[typeof value as keyof typeof SCALAR_TYPE_NAMES].gettype;
  if (value instanceof PhpArray) return 'array';
  return value.cls.name === '(stream)' ? 'resource' : 'object';
}

/** The type name in error messages and `get_debug_type`. */
export function debugType(value: Value): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return SCALAR_TYPE_NAMES[typeof value as keyof typeof SCALAR_TYPE_NAMES].debug;
  if (value instanceof PhpArray) return 'array';
  const object = value as PhpObject;
  if (object.cls.name === '(stream)') return 'resource (stream)';
  return object.cls.name;
}

/**
 * The name of a value in messages about the value rather than its type ("true given", "on false"), which PHP's
 * zend_zval_value_name writes as `debugType` does except for the booleans.
 */
export function valueName(value: Value): string {
  const name = typeof value === 'boolean' ? String(value) : debugType(value);
  return name === 'resource (stream)' ? 'resource' : name;
}

/** Compares two strings as PHP's `strcmp` does, by bytes. */
export function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sign(value: number | bigint): number {
  if (typeof value === 'bigint') return value < 0n ? -1 : value > 0n ? 1 : 0;
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

/** Compares two numbers as PHP does: two ints exactly, an int with a float as two floats; NaN is never less. */
export function compareNumbers(a: bigint | number, b: bigint | number): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return 1;
  return x < y ? -1 : x > y ? 1 : 0;
}
