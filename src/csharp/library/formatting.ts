import type { Evaluator } from '../evaluator';
import { CULTURE, formatNumber, type NumericKind } from '../format';
import { PendingException } from '../numeric';
import { enumText, stringOf, unboxed } from '../objects';
import type { Frame } from '../runtime';
import { type NamedType, nullableUnderlying, type Type } from '../types';
import { CsBox, CsStruct, type Value } from '../values';
import { formatDateTime, formatTimeSpan } from './nativesTime';

const NUMERIC_KINDS: Record<string, NumericKind> = {
  sbyte: 'integer',
  byte: 'integer',
  short: 'integer',
  ushort: 'integer',
  int: 'integer',
  uint: 'integer',
  long: 'integer',
  ulong: 'integer',
  char: 'integer',
  float: 'float',
  double: 'double',
  decimal: 'decimal',
};

/** The widths of the integral types other than `int`'s 32 bits, which `X` shows negative numbers in. */
const INTEGER_BITS: Partial<Record<string, number>> = { sbyte: 8, byte: 8, short: 16, ushort: 16, long: 64, ulong: 64 };

/**
 * Formats a value with a format string, as an interpolation hole or a composite format item does: numbers, enums,
 * dates, and times by the format, and anything else by its `ToString()`.
 */
// code-gauge-allow functionCognitiveComplexity 24 -- Each branch handles one case of the C# rule that the function applies.
export function formatValue(
  evaluator: Evaluator,
  value: Value,
  type: Type,
  format: string | undefined,
  frame: Frame
): string {
  if (value === undefined) return '';
  let actualType = nullableUnderlying(type) ?? type;
  let inner: Value = value;
  if (value instanceof CsBox) {
    actualType = value.type;
    inner = value.value;
  }
  if (format === undefined) return stringOf(evaluator, value, type, frame);
  if (actualType.kind === 'named') {
    const special = actualType.symbol.special;
    if (special === 'char' || special === 'bool' || special === 'string')
      return stringOf(evaluator, inner, actualType, frame);
    const kind = special ? NUMERIC_KINDS[special] : undefined;
    if (kind) return formatNumber(inner as number, kind, format, special ? (INTEGER_BITS[special] ?? 32) : 32);
    if (actualType.symbol.kind === 'enum') return formatEnum(actualType, inner, format);
    if (inner instanceof CsStruct) {
      const name = actualType.symbol.fullName;
      if (name === 'System.DateTime') return formatDateTime(inner, format);
      if (name === 'System.TimeSpan') return formatTimeSpan(inner, format);
    }
  }
  return stringOf(evaluator, value, type, frame);
}

function formatEnum(type: NamedType, value: Value, format: string): string {
  switch (format.toUpperCase()) {
    case 'G': {
      return enumText(type, value);
    }
    case 'F': {
      return flagsText(type, value);
    }
    case 'D': {
      return String(value);
    }
    case 'X': {
      const underlying = (type.symbol.enumUnderlying as NamedType).symbol.special;
      const digits =
        underlying === 'long' || underlying === 'ulong'
          ? 16
          : underlying === 'short' || underlying === 'ushort'
            ? 4
            : underlying === 'byte' || underlying === 'sbyte'
              ? 2
              : 8;
      const bits = digits * 4;
      return BigInt.asUintN(bits, BigInt(value as number))
        .toString(16)
        .toUpperCase()
        .padStart(digits, '0');
    }
    default: {
      throw new PendingException(
        'System.FormatException',
        'Format string can be only "G", "g", "X", "x", "F", "f", "D" or "d".'
      );
    }
  }
}

/**
 * An enum value as `ToString("F")` gives it: its member's name, or the names of the members whose bits make it up, as
 * `Red, Green`, even without `[Flags]`, or its number when no members make it up.
 */
function flagsText(type: NamedType, value: Value): string {
  const exact = enumText(type, value);
  const number = BigInt(value as number | bigint);
  if (exact !== String(value) || number === 0n) return exact;
  const members = type.symbol.fields
    .filter((field) => field.isConst && BigInt(field.constantValue as number | bigint) !== 0n)
    .map((field) => ({ name: field.name, bits: BigInt(field.constantValue as number | bigint) }))
    .toSorted((a, b) => (a.bits < b.bits ? 1 : a.bits > b.bits ? -1 : 0));
  let rest = number;
  const names: string[] = [];
  for (const member of members) {
    if ((rest & member.bits) !== member.bits) continue;
    rest &= ~member.bits;
    names.unshift(member.name);
  }
  return rest === 0n ? names.join(', ') : String(value);
}

/**
 * A number's text without the white space that .NET's number parsing skips: only tab to carriage return and the
 * space, not the other Unicode spaces such as U+3000, with trailing NUL characters too.
 */
export function trimNumberText(text: string): string {
  return text.replace(/^[\t-\r ]+/, '').replace(/[\t-\r \0]+$/, '');
}

/** Parses a floating-point number as `double.Parse` does with the culture's symbols, or returns undefined. */
export function parseNumber(text: string): number | undefined {
  const trimmed = trimNumberText(text);
  // .NET compares the culture's symbols ignoring case.
  if (trimmed.toLowerCase() === CULTURE.nan.toLowerCase()) return Number.NaN;
  // ja-JP spells infinity `∞`, so `Infinity` does not parse.
  if (trimmed === CULTURE.positiveInfinity || trimmed === `+${CULTURE.positiveInfinity}`)
    return Number.POSITIVE_INFINITY;
  if (trimmed === CULTURE.negativeInfinity) return Number.NEGATIVE_INFINITY;
  const normalized = normalizeNumberText(trimmed, true);
  return normalized === undefined ? undefined : Number(normalized);
}

/**
 * A number's text, without white space and group separators, if it follows .NET's grammar for `double.Parse`
 * (`isFloat`, with an exponent) or `decimal.Parse` (with a trailing sign instead). A group separator may follow any
 * digit before the decimal point, in groups of any size.
 */
export function normalizeNumberText(text: string, isFloat: boolean): string | undefined {
  let body = trimNumberText(text);
  let sign = '';
  if (/^[+-]/.test(body)) {
    sign = body[0];
    body = body.slice(1);
  } else if (!isFloat && /[+-]$/.test(body)) {
    sign = body.at(-1) as string;
    body = body.slice(0, -1);
  }
  const match = /^(\d[\d,]*|)(\.\d*)?([eE][+-]?\d+)?$/.exec(body);
  if (!match || (match[3] && !isFloat) || !/\d/.test(match[1] + (match[2] ?? ''))) return undefined;
  return `${sign === '-' ? '-' : ''}${match[1].replaceAll(',', '')}${match[2] ?? ''}${match[3] ?? ''}`;
}

export { unboxed };
