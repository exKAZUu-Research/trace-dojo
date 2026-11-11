import { bindValue, callValue, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import { pyError, typeError, typeName, valueError } from './types';
import { PyInstance, type PyValue } from './values';

/** The limit of decimal digits an int may convert to or from, which sys.set_int_max_str_digits changes (0: none). */
export const DEFAULT_MAX_STR_DIGITS = 4300;

const maxStrDigits = (): number => currentRuntime().intMaxStrDigits;

// Conversions -------------------------------------------------------------------------------------------------------

/** Converts an int to a float, raising OverflowError as CPython does for ints beyond the float range. */
export function intToFloat(value: bigint): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw pyError('OverflowError', 'int too large to convert to float');
  return result;
}

/** A number as a float, for arithmetic mixing ints and floats. */
export function asFloat(value: bigint | number | boolean): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return intToFloat(value);
}

export function floatToInt(value: number): bigint {
  if (Number.isNaN(value)) throw valueError('cannot convert float NaN to integer');
  if (!Number.isFinite(value)) throw pyError('OverflowError', 'cannot convert float infinity to integer');
  return BigInt(Math.trunc(value));
}

export function describeIntegerIndex(value: PyValue): string {
  return `'${typeName(value)}' object cannot be interpreted as an integer`;
}

/** Interprets a value as an integer index, as `operator.index()` does. */
// code-gauge-allow functionCognitiveComplexity 17 -- Follows operator.index for each kind of value.
export function toIndex(value: PyValue, describe: (value: PyValue) => string = describeIntegerIndex): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (value instanceof PyInstance) {
    const index = lookupSpecial(value, '__index__');
    if (index !== undefined) {
      const result = callValue(bindValue(index, value), []);
      if (typeof result === 'bigint') return result;
      if (typeof result === 'boolean') return result ? 1n : 0n;
      throw typeError(`__index__ returned non-int (type ${typeName(result)})`);
    }
  }
  throw typeError(describe(value));
}

export function intToString(value: bigint): string {
  const text = value.toString();
  const digits = value < 0n ? text.length - 1 : text.length;
  const limit = maxStrDigits();
  if (limit > 0 && digits > limit) {
    throw valueError(
      `Exceeds the limit (${limit} digits) for integer string conversion; use sys.set_int_max_str_digits() to increase the limit`
    );
  }
  return text;
}

/** Parses a string as `int(text, base)` does, returning undefined when it is not a valid literal. */
// code-gauge-allow functionNcss 36 -- Follows the grammar of int() literals.
// code-gauge-allow functionCognitiveComplexity 22 -- Follows the grammar of int() literals.
export function parseIntText(text: string, base: number): bigint | undefined {
  let body = text.trim().replaceAll(/^[\s]+|[\s]+$/gu, '');
  let negative = false;
  if (body.startsWith('+') || body.startsWith('-')) {
    negative = body.startsWith('-');
    body = body.slice(1);
  }
  let radix = base;
  const prefix = /^0([xob])/i.exec(body);
  if (prefix) {
    const prefixBase = { x: 16, o: 8, b: 2 }[prefix[1].toLowerCase() as 'x' | 'o' | 'b'];
    if (base === 0 || base === prefixBase) {
      radix = prefixBase;
      body = body.slice(2);
      if (body.startsWith('_')) body = body.slice(1);
    }
  }
  if (radix === 0) {
    radix = 10;
    if (/^0+[1-9]/.test(body.replaceAll('_', ''))) return undefined;
  }
  if (body === '' || body.startsWith('_') || body.endsWith('_') || body.includes('__')) return undefined;
  const digits = body.replaceAll('_', '');
  const valid = new RegExp(`^[${'0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix)}]+$`, 'i');
  const normalized = toAsciiDigits(digits);
  if (!valid.test(normalized)) return undefined;
  const limit = maxStrDigits();
  if (radix === 10 && limit > 0 && normalized.length > limit) {
    throw valueError(
      `Exceeds the limit (${limit} digits) for integer string conversion: value has ${normalized.length} digits; use sys.set_int_max_str_digits() to increase the limit`
    );
  }
  let result = 0n;
  const bigRadix = BigInt(radix);
  if (radix === 10) result = BigInt(normalized);
  else for (const digit of normalized.toLowerCase()) result = result * bigRadix + BigInt(Number.parseInt(digit, radix));
  return negative ? -result : result;
}

/** Converts Unicode decimal digits, which int() and float() accept, to ASCII digits. */
function toAsciiDigits(text: string): string {
  return text.replaceAll(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0) as number;
    if (code < 0x80) return digit;
    // Every decimal digit block runs from 0 to 9, so the digit is its offset from the block's zero.
    for (let zero = code; zero > code - 10; zero--) {
      if (!/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) return String(code - zero);
    }
    return digit;
  });
}

/** Parses a string as `float(text)` does, returning undefined when it is not a valid float. */
export function parseFloatText(text: string): number | undefined {
  const body = toAsciiDigits(text.trim());
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(body);
  if (special) {
    const value = special[2].toLowerCase() === 'nan' ? Number.NaN : Number.POSITIVE_INFINITY;
    return special[1] === '-' ? -value : value;
  }
  if (!/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/.test(body))
    return undefined;
  return Number(body.replaceAll('_', ''));
}

// Arithmetic --------------------------------------------------------------------------------------------------------

export function floorDivInt(a: bigint, b: bigint): bigint {
  if (b === 0n) throw pyError('ZeroDivisionError', 'division by zero');
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

export function modInt(a: bigint, b: bigint): bigint {
  if (b === 0n) throw pyError('ZeroDivisionError', 'division by zero');
  const remainder = a % b;
  return remainder !== 0n && remainder < 0n !== b < 0n ? remainder + b : remainder;
}

/** Divides floats as CPython's float divmod does, returning the floored quotient and the remainder. */
export function divmodFloat(a: number, b: number): [number, number] {
  if (b === 0) throw pyError('ZeroDivisionError', 'division by zero');
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod) {
    if (b < 0 !== mod < 0) {
      mod += b;
      div -= 1;
    }
  } else {
    mod = b < 0 || Object.is(b, -0) ? -0 : 0;
  }
  let floorDiv: number;
  if (div) {
    floorDiv = Math.floor(div);
    if (div - floorDiv > 0.5) floorDiv += 1;
  } else {
    const quotient = a / b;
    floorDiv = quotient < 0 || Object.is(quotient, -0) ? -0 : 0;
  }
  return [floorDiv, mod];
}

/** Divides two ints, rounding correctly to the nearest float as CPython does. */
export function trueDivideInt(a: bigint, b: bigint): number {
  if (b === 0n) throw pyError('ZeroDivisionError', 'division by zero');
  const limit = 1n << 53n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  if (absA <= limit && absB <= limit) return Number(a) / Number(b);
  const negative = a < 0n !== b < 0n;
  // Scales the quotient to 55 or more significant bits, then lets the conversion of an exact ratio round it.
  const shift = BigInt(absB.toString(2).length - absA.toString(2).length + 55);
  const numerator = shift > 0n ? absA << shift : absA;
  const denominator = shift < 0n ? absB << -shift : absB;
  let quotient = numerator / denominator;
  // A sticky bit keeps an inexact quotient from rounding as if it were exact.
  if (numerator % denominator !== 0n) quotient |= 1n;
  const exponent = -Number(shift);
  const result = scaleByPowerOfTwo(quotient, exponent);
  if (!Number.isFinite(result)) throw pyError('OverflowError', 'integer division result too large for a float');
  return negative ? -result : result;
}

/** Computes `mantissa * 2 ** exponent` rounded once to the nearest float, halves to even, handling subnormals. */
export function scaleToFloat(mantissa: bigint, exponent: number): number {
  if (mantissa < 0n) return -scaleToFloat(-mantissa, exponent);
  if (mantissa === 0n) return 0;
  return scaleByPowerOfTwo(mantissa, exponent);
}

/** A finite double as an exact integer mantissa times a power of two. */
export function exactBinary(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n);
  let mantissa = bits & ((1n << 52n) - 1n);
  if (biased !== 0) mantissa |= 1n << 52n;
  const exponent = biased === 0 ? -1074 : biased - 1075;
  return { mantissa: value < 0 ? -mantissa : mantissa, exponent };
}

function scaleByPowerOfTwo(mantissa: bigint, exponent: number): number {
  const bits = mantissa.toString(2).length;
  const lowestBit = Math.max(bits + exponent - 53, -1074);
  const drop = lowestBit - exponent;
  let value = mantissa;
  if (drop > 0) {
    const bigDrop = BigInt(drop);
    const half = 1n << (bigDrop - 1n);
    const remainder = value & ((1n << bigDrop) - 1n);
    value >>= bigDrop;
    if (remainder > half || (remainder === half && (value & 1n) === 1n)) value += 1n;
    return Number(value) * 2 ** lowestBit;
  }
  return Number(value) * 2 ** exponent;
}

// Formatting --------------------------------------------------------------------------------------------------------

/** A finite non-negative number as significant decimal digits and the position of the decimal point. */
export interface Decimal {
  /** Digits without leading zeros, or "0" for zero. */
  digits: string;
  /** Where the decimal point goes: the value is 0.digits × 10^point. */
  point: number;
}

/** The exact decimal expansion of a finite double's magnitude. */
export function exactDecimal(value: number): Decimal {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return { digits: '0', point: 1 };
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude);
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n);
  let mantissa = bits & ((1n << 52n) - 1n);
  let exponent = biased - 1075;
  if (biased === 0) exponent = -1074;
  else mantissa |= 1n << 52n;
  let text: string;
  let point: number;
  if (exponent >= 0) {
    text = (mantissa << BigInt(exponent)).toString();
    point = text.length;
  } else {
    text = (mantissa * 5n ** BigInt(-exponent)).toString();
    point = text.length + exponent;
  }
  const stripped = text.replace(/0+$/, '');
  const leading = stripped.length - stripped.replace(/^0+/, '').length;
  return { digits: stripped.slice(leading) || '0', point: point - leading };
}

/** The shortest decimal digits that read back as the same double, as `repr()` uses. */
export function shortestDecimal(value: number): Decimal {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return { digits: '0', point: 1 };
  const [mantissa, exponent] = magnitude.toExponential().split('e');
  return { digits: mantissa.replace('.', ''), point: Number(exponent) + 1 };
}

/** Rounds a decimal to `count` significant digits, halves to even, as correctly rounded formatting does. */
export function roundDecimal({ digits, point }: Decimal, count: number): Decimal {
  if (digits === '0') return { digits: '0', point: 1 };
  if (count >= digits.length) return { digits, point };
  if (count < 0) return { digits: '0', point: point - count };
  const kept = digits.slice(0, count);
  const rest = digits.slice(count);
  const first = rest[0];
  const exactHalf = first === '5' && /^0*$/.test(rest.slice(1));
  const lastKept = count > 0 ? Number(kept.at(-1)) : 0;
  const roundsUp = first > '5' || (first === '5' && !exactHalf) || (exactHalf && lastKept % 2 === 1);
  if (!roundsUp) return kept === '' ? { digits: '0', point: point - count } : { digits: kept, point };
  if (kept === '') return { digits: '1', point: point + 1 };
  const incremented = (BigInt(kept) + 1n).toString();
  if (incremented.length > kept.length) return { digits: incremented.slice(0, -1), point: point + 1 };
  return { digits: incremented, point };
}

/** Writes a decimal in fixed-point notation with `decimals` digits after the point. */
export function fixedText(value: Decimal, decimals: number): string {
  const rounded = roundDecimal(value, value.point + decimals);
  const isZero = rounded.digits === '0';
  const digits = isZero ? '' : rounded.digits;
  const point = isZero ? 0 : rounded.point;
  const integer = point > 0 ? digits.slice(0, point).padEnd(point, '0') || '0' : '0';
  const fraction = point >= 0 ? digits.slice(point) : '0'.repeat(-point) + digits;
  const fractionText = fraction.padEnd(decimals, '0').slice(0, decimals);
  return decimals > 0 ? `${integer}.${fractionText}` : integer;
}

/** Writes a decimal in exponent notation with `decimals` digits after the point. */
export function exponentText(value: Decimal, decimals: number, marker = 'e'): string {
  const rounded = roundDecimal(value, decimals + 1);
  const digits = rounded.digits === '0' ? '0'.repeat(decimals + 1) : rounded.digits.padEnd(decimals + 1, '0');
  const exponent = rounded.digits === '0' ? 0 : rounded.point - 1;
  const mantissa = decimals > 0 ? `${digits[0]}.${digits.slice(1)}` : digits[0];
  return `${mantissa}${marker}${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

/** `repr()` of a float. */
export function floatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const decimal = shortestDecimal(value);
  return sign + reprDigits(decimal);
}

/** Writes the shortest digits as repr does: fixed for points in (-4, 16], exponent notation otherwise. */
export function reprDigits({ digits, point }: Decimal): string {
  if (point <= -4 || point > 16) {
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const exponent = point - 1;
    return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${digits}${'0'.repeat(point - digits.length)}.0`;
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}
