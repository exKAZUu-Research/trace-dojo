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
    case 'G':
    case 'F': {
      return enumText(type, value);
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
        'Format String can be only "G", "g", "X", "x", "F", "f", "D" or "d".'
      );
    }
  }
}

/** Parses a floating-point number as `double.Parse` does with the culture's symbols, or returns undefined. */
export function parseNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === CULTURE.nan || trimmed === 'NaN') return Number.NaN;
  // ja-JP spells infinity `∞`, so `Infinity` does not parse.
  if (trimmed === CULTURE.positiveInfinity || trimmed === `+${CULTURE.positiveInfinity}`)
    return Number.POSITIVE_INFINITY;
  if (trimmed === CULTURE.negativeInfinity) return Number.NEGATIVE_INFINITY;
  if (!/^[+-]?(\d{1,3}(,\d{3})+|\d*)(\.\d*)?([eE][+-]?\d+)?$/.test(trimmed) || !/\d/.test(trimmed)) return undefined;
  return Number(trimmed.replaceAll(',', ''));
}

export { unboxed };
