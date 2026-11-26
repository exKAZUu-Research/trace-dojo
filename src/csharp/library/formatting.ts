import { type Culture, providerCulture } from '../cultures';
import type { Evaluator } from '../evaluator';
import { formatNumber, type NumericKind } from '../format';
import { PendingException } from '../numeric';
import { enumText, environmentOf, flagsText, stringOf, unboxed } from '../objects';
import type { Frame } from '../runtime';
import { type NamedType, nullableUnderlying, type Type } from '../types';
import { CsBox, type CsString, CsStruct, stringText, type Value } from '../values';
import { formatDateOrTimeOnly } from './nativesDateOnly';
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
 * Formats a value with a format string and a format provider, as an interpolation hole or a composite format item
 * does: numbers, enums, dates, and times by the format and the provider's culture, a program's `IFormattable` by its
 * `ToString(format, provider)`, and anything else by its `ToString()`.
 */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
export function formatValue(
  evaluator: Evaluator,
  value: Value,
  type: Type,
  format: string | undefined,
  frame: Frame,
  provider?: Value
): string {
  if (value === undefined) return '';
  let actualType = nullableUnderlying(type) ?? type;
  let inner: Value = value;
  if (value instanceof CsBox) {
    actualType = value.type;
    inner = value.value;
  }
  const formatted = formatProgramFormattable(evaluator, value, format, provider, frame);
  if (formatted !== undefined) return formatted;
  if (format === undefined && provider === undefined) return stringOf(evaluator, value, type, frame);
  if (actualType.kind === 'named') {
    const special = actualType.symbol.special;
    if (special === 'char' || special === 'bool' || special === 'string')
      return stringOf(evaluator, inner, actualType, frame);
    const culture = providerCulture(evaluator.runtime, provider);
    const kind = special ? NUMERIC_KINDS[special] : undefined;
    if (kind) return formatNumber(inner as number, kind, format, culture, special ? (INTEGER_BITS[special] ?? 32) : 32);
    if (actualType.symbol.kind === 'enum' && format !== undefined) return formatEnum(actualType, inner, format);
    const time = inner instanceof CsStruct ? formatTime(evaluator, inner, format, culture) : undefined;
    if (time !== undefined) return time;
  }
  return stringOf(evaluator, value, type, frame);
}

/** The text of a DateTime, TimeSpan, DateOnly, or TimeOnly in a format, undefined for another struct. */
function formatTime(
  evaluator: Evaluator,
  value: CsStruct,
  format: string | undefined,
  culture: Culture
): string | undefined {
  switch (value.type.symbol.fullName) {
    case 'System.DateTime': {
      return formatDateTime(evaluator.runtime, value, format, culture);
    }
    case 'System.TimeSpan': {
      return formatTimeSpan(evaluator.runtime, value, format);
    }
    case 'System.DateOnly':
    case 'System.TimeOnly': {
      return formatDateOrTimeOnly(evaluator.runtime, value, format, culture);
    }
    default: {
      return undefined;
    }
  }
}

/**
 * The text of a value of the program's type that implements `IFormattable`, from its `ToString(format, provider)`,
 * which composite formatting calls instead of `ToString()`; undefined for any other value.
 */
function formatProgramFormattable(
  evaluator: Evaluator,
  value: Value,
  format: string | undefined,
  provider: Value,
  frame: Frame
): string | undefined {
  const runtime = evaluator.runtime;
  const type = runtime.runtimeTypeOf(value);
  if (type?.kind !== 'named' || type.symbol.isLibrary) return undefined;
  const method = runtime.library.typeNamed('System.IFormattable').methods[0];
  const implementation = runtime.dispatch(method, value);
  if (implementation === method) return undefined;
  const environment = environmentOf(evaluator, implementation, value);
  const result = evaluator.invoke(frame, implementation, value, [format, provider], undefined, environment);
  return result === undefined ? '' : stringText(result as string | CsString);
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

export { unboxed };
