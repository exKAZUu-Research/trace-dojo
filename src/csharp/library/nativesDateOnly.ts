import { type Culture, INVARIANT, providerCulture } from '../cultures';
import type { TextBudget } from '../meteredText';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { CsStruct, type Value } from '../values';
import { exactFailureMessage, parseExactDate } from './exactDateParsing';
import {
  civilFromDays,
  comparisons,
  daysFromCivil,
  daysInMonth,
  formatDateTime,
  parseDate,
  partsOf,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  TICKS_PER_MILLISECOND,
  TICKS_PER_MINUTE,
  TICKS_PER_SECOND,
  ticksFromDouble,
  ticksFromParts,
  ticksOf,
  timeCompare,
  timeEquals,
  timeSpan,
  WHITE_SPACE_STYLES,
} from './nativesTime';
import { fail, failNull, failOutOfRange, libraryType, refOf, unsupportedCall } from './support';

/**
 * DateOnly, which keeps the days since 0001-01-01 in its one field, and TimeOnly, which keeps the ticks since
 * midnight. They format and parse as a DateTime of their date at midnight, or of their time on 0001-01-01, does, with
 * .NET's checks that a format or a string has no part of the other.
 */

const DATE_ONLY = 'System.DateOnly';
const TIME_ONLY = 'System.TimeOnly';
/** `DateOnly.MaxValue.DayNumber`, 9999-12-31. */
const MAX_DAY_NUMBER = 3_652_058;

function dayNumberOf(value: Value): number {
  return Number(ticksOf(value));
}

function dateOnly(call: NativeCall, dayNumber: number): CsStruct {
  return new CsStruct(libraryType(call, DATE_ONLY), [dayNumber]);
}

function timeOnly(call: NativeCall, ticks: bigint): CsStruct {
  return new CsStruct(libraryType(call, TIME_ONLY), [ticks]);
}

/** A DateTime of ticks, which formatting reads as DateTime's. */
function asDateTime(call: NativeCall, ticks: bigint): CsStruct {
  return new CsStruct(libraryType(call, 'System.DateTime'), [ticks]);
}

function dayFromParts(year: number, month: number, day: number): number {
  return Number(ticksFromParts(year, month, day) / TICKS_PER_DAY);
}

/** A DateOnly the days after another, which .NET rejects past either end. */
function addedDays(call: NativeCall, dayNumber: number, days: number): CsStruct {
  const result = dayNumber + days;
  if (result < 0 || result > MAX_DAY_NUMBER)
    fail('System.ArgumentOutOfRangeException', 'Value to add was out of range.', 'value');
  return dateOnly(call, result);
}

function addedMonths(call: NativeCall, dayNumber: number, months: number, paramName: string): CsStruct {
  const { year, month, day } = civilFromDays(dayNumber);
  const total = year * 12 + (month - 1) + months;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  if (newYear < 1 || newYear > 9999)
    fail(
      'System.ArgumentOutOfRangeException',
      'The added or subtracted value results in an un-representable DateTime.',
      paramName
    );
  return dateOnly(call, daysFromCivil(newYear, newMonth, Math.min(day, daysInMonth(newYear, newMonth))));
}

// ---- Formatting ----

const DATE_ONLY_STANDARD: Record<string, string | undefined> = {
  o: "yyyy'-'MM'-'dd",
  O: "yyyy'-'MM'-'dd",
  r: 'ddd, dd MMM yyyy',
  R: 'ddd, dd MMM yyyy',
};
const TIME_ONLY_STANDARD: Record<string, string | undefined> = {
  o: "HH':'mm':'ss'.'fffffff",
  O: "HH':'mm':'ss'.'fffffff",
  r: "HH':'mm':'ss",
  R: "HH':'mm':'ss",
};

/** The specifiers that each type's custom formats reject, as .NET's `IsValidCustomDateOnlyFormat` and the like do. */
const DATE_ONLY_INVALID = new Set(['h', 'H', 'm', 's', 'f', 'F', 't', 'z', 'K', ':']);
const TIME_ONLY_INVALID = new Set(['d', 'M', 'y', '/', 'z', 'k']);

const INVALID_FORMAT = 'Input string was not in a correct format.';

// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the .NET rule that the function applies.
function checkCustomFormat(format: string, invalid: ReadonlySet<string>): void {
  for (let index = 0; index < format.length; index++) {
    const char = format[index];
    if (char === '\\' || char === '%') {
      if (index === format.length - 1) fail('System.FormatException', INVALID_FORMAT);
      if (char === '\\') index++;
    } else if (char === "'" || char === '"') {
      const close = format.indexOf(char, index + 1);
      if (close === -1)
        fail('System.FormatException', `Cannot find a matching quote character for the character '${char}'.`);
      index = close;
    } else if (invalid.has(char)) {
      fail('System.FormatException', INVALID_FORMAT);
    }
  }
}

/**
 * The text of a DateOnly or TimeOnly, which formats as the DateTime of its ticks does, by a format its type allows, as
 * its `ToString(format, provider)` and an interpolation hole or composite format item write it.
 */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the .NET rule that the function applies.
export function formatDateOrTimeOnly(
  budget: TextBudget,
  value: CsStruct,
  format: string | undefined,
  provider: Culture
): string {
  const kind = value.type.symbol.fullName === DATE_ONLY ? 'date' : 'time';
  const ticks = kind === 'date' ? BigInt(dayNumberOf(value)) * TICKS_PER_DAY : ticksOf(value);
  const text = format || (kind === 'date' ? 'd' : 't');
  const standard = kind === 'date' ? DATE_ONLY_STANDARD : TIME_ONLY_STANDARD;
  let culture = provider;
  let pattern = text;
  if (text.length === 1) {
    const allowed = kind === 'date' ? 'dDmMyY' : 'tT';
    if (standard[text] !== undefined) {
      pattern = standard[text];
      if (text === 'r' || text === 'R') culture = INVARIANT;
    } else if (!allowed.includes(text)) {
      fail('System.FormatException', INVALID_FORMAT);
    }
  } else {
    checkCustomFormat(text, kind === 'date' ? DATE_ONLY_INVALID : TIME_ONLY_INVALID);
  }
  // Formatting reads the ticks from the struct's one field, as a DateTime's.
  return formatDateTime(budget, new CsStruct(value.type, [ticks]), pattern, culture);
}

function formatNatives(type: string, kind: 'date' | 'time'): Record<string, NativeMethod> {
  const [long, short] =
    kind === 'date' ? ['ToLongDateString', 'ToShortDateString'] : ['ToLongTimeString', 'ToShortTimeString'];
  const [longFormat, shortFormat] = kind === 'date' ? ['D', 'd'] : ['T', 't'];
  return {
    [`${type}.ToString()`]: (call, receiver) => onlyText(call, receiver, undefined),
    [`${type}.ToString(string?)`]: (call, receiver, [format]) => onlyText(call, receiver, format as Value),
    [`${type}.ToString(IFormatProvider?)`]: (call, receiver, [provider]) =>
      onlyText(call, receiver, undefined, provider as Value),
    [`${type}.ToString(string?, IFormatProvider?)`]: (call, receiver, [format, provider]) =>
      onlyText(call, receiver, format as Value, provider as Value),
    [`${type}.${long}`]: (call, receiver) => onlyText(call, receiver, longFormat),
    [`${type}.${short}`]: (call, receiver) => onlyText(call, receiver, shortFormat),
  };
}

function onlyText(call: NativeCall, receiver: Value, format: Value, provider?: Value): string {
  return formatDateOrTimeOnly(
    call.frame.runtime,
    receiver as CsStruct,
    (format as string | undefined) ?? undefined,
    providerCulture(call.frame.runtime, provider)
  );
}

// ---- Parsing ----

/** The string, the format, and the culture of a `Parse`, `ParseExact`, or `TryParse*` call, by the parameters' names. */
function parseArguments(
  call: NativeCall,
  args: Value[]
): { text: string | undefined; format: string | undefined; culture: Culture } {
  const argument = (name: string): Value =>
    args[call.method.parameters.findIndex((parameter) => parameter.name === name)];
  const styles = (argument('style') as number | undefined) ?? 0;
  if ((styles & ~WHITE_SPACE_STYLES) !== 0) unsupportedCall(call, 'DateTimeStyles の AllowWhiteSpaces 以外の指定');
  return {
    text: argument('s') as string | undefined,
    format: argument('format') as string | undefined,
    culture: providerCulture(call.frame.runtime, argument('provider')),
  };
}

/** The day number of a string, or the message of the FormatException .NET throws for it. */
function parseDateOnly(text: string, culture: Culture): number | string {
  const ticks = parseDate(text, culture);
  if (ticks === undefined) return `String '${text}' was not recognized as a valid DateOnly.`;
  // A time after a space is a part DateOnly rejects; .NET's ISO 8601 reading of a `T` time keeps no trace of it.
  if (/\d\s+\d{1,2}[:時]/.test(text)) return `String '${text}' contains parts which are not specific to the DateOnly.`;
  return Number(ticks / TICKS_PER_DAY);
}

const DESIGNATORS = '(AM|PM|午前|午後)';
const TIME_PATTERN = new RegExp(
  String.raw`^\s*(?:${DESIGNATORS}\s*)?(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,7}))?)?\s*${DESIGNATORS}?\s*$`,
  'i'
);

/** The ticks of a time of day `H:m[:s[.fffffff]]` with an optional designator, or the FormatException's message. */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the .NET rule that the function applies.
function parseTimeOnly(text: string, culture: Culture): bigint | string {
  const normalized = text.replace(
    /(\d{1,2})時(\d{1,2})分(?:(\d{1,2})秒)?/,
    (_match, hour: string, minute: string, second?: string) =>
      `${hour}:${minute}${second === undefined ? '' : `:${second}`}`
  );
  const match = TIME_PATTERN.exec(normalized);
  if (match) {
    const [, before, hourText, minute, second = '0', fraction = '', after] = match;
    const designator = (before ?? after)?.toUpperCase();
    let hour = Number(hourText);
    if (hour <= (designator === undefined ? 23 : 12) && Number(minute) <= 59 && Number(second) <= 59) {
      if (designator !== undefined) hour = (hour % 12) + (designator === 'PM' || designator === '午後' ? 12 : 0);
      return (
        BigInt(hour) * TICKS_PER_HOUR +
        BigInt(minute) * TICKS_PER_MINUTE +
        BigInt(second) * TICKS_PER_SECOND +
        BigInt(fraction.padEnd(7, '0') || '0')
      );
    }
  }
  if (parseDate(text, culture) !== undefined)
    return `String '${text}' contains parts which are not specific to the TimeOnly.`;
  return `String '${text}' was not recognized as a valid TimeOnly.`;
}

/** The ticks a format reads from a string, whose date or time .NET keeps as the type needs, or the message. */
function parseExactTicks(text: string, format: string, culture: Culture, typeName: string): bigint | string {
  const result = parseExactDate(text, format, culture, { leading: false, trailing: false, inner: false });
  if ('kind' in result) {
    if (result.kind === 'badDateTime') return `String '${text}' was not recognized as a valid ${typeName}.`;
    return exactFailureMessage(text, result);
  }
  const { year = 1, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = result;
  if (year > 9999 || month > 12 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59)
    return `String '${text}' was not recognized as a valid ${typeName}.`;
  return ticksFromParts(year, month, day, hour, minute, second) + BigInt(result.fraction);
}

// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the .NET rule that the function applies.
function parseNatives<T>(
  type: string,
  parse: (text: string, culture: Culture) => T | string,
  parseExact: (text: string, format: string, culture: Culture) => T | string,
  make: (call: NativeCall, value: T | undefined) => Value
): Record<string, NativeMethod> {
  const parsed = (call: NativeCall, args: Value[], isExact: boolean): T | string => {
    const { text, format, culture } = parseArguments(call, args);
    if (text === undefined) failNull('s');
    if (!isExact) return parse(text, culture);
    if (format === undefined) failNull('format');
    return parseExact(text, format, culture);
  };
  const strict =
    (isExact: boolean): NativeMethod =>
    (call, _receiver, args) => {
      const result = parsed(call, args as Value[], isExact);
      if (typeof result === 'string') fail('System.FormatException', result);
      return make(call, result);
    };
  const lenient =
    (isExact: boolean): NativeMethod =>
    (call, _receiver, args) => {
      const { text, format } = parseArguments(call, args as Value[]);
      const result =
        text === undefined || (isExact && format === undefined) ? '' : parsed(call, args as Value[], isExact);
      const isParsed = typeof result !== 'string';
      refOf(args.at(-1) as Value).set(make(call, isParsed ? result : undefined));
      return isParsed;
    };
  return {
    [`${type}.Parse`]: strict(false),
    [`${type}.ParseExact`]: strict(true),
    [`${type}.TryParse`]: lenient(false),
    [`${type}.TryParseExact`]: lenient(true),
  };
}

// ---- DateOnly ----

defineNatives({
  'System.DateOnly..ctor': (_call, receiver, [year, month, day]) => {
    (receiver as CsStruct).fields[0] = dayFromParts(year as number, month as number, day as number);
    return;
  },
  'System.DateOnly.get_MinValue': (call) => dateOnly(call, 0),
  'System.DateOnly.get_MaxValue': (call) => dateOnly(call, MAX_DAY_NUMBER),
  'System.DateOnly.FromDayNumber': (call, _receiver, [dayNumber]) => {
    const days = dayNumber as number;
    if (days < 0 || days > MAX_DAY_NUMBER)
      failOutOfRange(call, 'dayNumber', 'Day number must be between 0 and DateOnly.MaxValue.DayNumber.', String(days));
    return dateOnly(call, days);
  },
  'System.DateOnly.FromDateTime': (call, _receiver, [value]) =>
    dateOnly(call, Number(ticksOf(value as Value) / TICKS_PER_DAY)),
  'System.DateOnly.get_Year': (_call, receiver) => civilFromDays(dayNumberOf(receiver)).year,
  'System.DateOnly.get_Month': (_call, receiver) => civilFromDays(dayNumberOf(receiver)).month,
  'System.DateOnly.get_Day': (_call, receiver) => civilFromDays(dayNumberOf(receiver)).day,
  'System.DateOnly.get_DayOfWeek': (_call, receiver) => (dayNumberOf(receiver) + 1) % 7,
  'System.DateOnly.get_DayOfYear': (_call, receiver) =>
    partsOf(BigInt(dayNumberOf(receiver)) * TICKS_PER_DAY).dayOfYear,
  'System.DateOnly.get_DayNumber': (_call, receiver) => dayNumberOf(receiver),
  'System.DateOnly.AddDays': (call, receiver, [days]) => addedDays(call, dayNumberOf(receiver), days as number),
  'System.DateOnly.AddMonths': (call, receiver, [months]) =>
    addedMonths(call, dayNumberOf(receiver), months as number, 'months'),
  'System.DateOnly.AddYears': (call, receiver, [years]) =>
    addedMonths(call, dayNumberOf(receiver), (years as number) * 12, 'value'),
  'System.DateOnly.ToDateTime': (call, receiver, [time]) =>
    asDateTime(call, BigInt(dayNumberOf(receiver)) * TICKS_PER_DAY + ticksOf(time as Value)),
  'System.DateOnly.Deconstruct': (_call, receiver, [year, month, day]) => {
    const parts = civilFromDays(dayNumberOf(receiver));
    refOf(year).set(parts.year);
    refOf(month).set(parts.month);
    refOf(day).set(parts.day);
    return;
  },
  'System.DateOnly.CompareTo': (_call, receiver, [other]) => timeCompare(receiver, other as Value),
  'System.DateOnly.Equals': (_call, receiver, [other]) => timeEquals(receiver, other as Value),
  'System.DateOnly.GetHashCode': (_call, receiver) => dayNumberOf(receiver),
  ...formatNatives(DATE_ONLY, 'date'),
  ...parseNatives<number>(
    DATE_ONLY,
    parseDateOnly,
    (text, format, culture) => {
      const ticks = parseExactTicks(text, format, culture, 'DateOnly');
      return typeof ticks === 'string' ? ticks : Number(ticks / TICKS_PER_DAY);
    },
    (call, dayNumber) => dateOnly(call, dayNumber ?? 0)
  ),
  ...comparisons(DATE_ONLY),
});

// ---- TimeOnly ----

/** TimeOnly's ticks plus others, wrapped into a day, with the whole days it wrapped by. */
function wrapped(ticks: bigint): { ticks: bigint; days: number } {
  let days = ticks / TICKS_PER_DAY;
  let rest = ticks % TICKS_PER_DAY;
  if (rest < 0n) {
    days--;
    rest += TICKS_PER_DAY;
  }
  return { ticks: rest, days: Number(days) };
}

function checkTimeTicks(call: NativeCall, ticks: bigint): bigint {
  if (ticks < 0n || ticks >= TICKS_PER_DAY)
    failOutOfRange(call, 'ticks', 'Ticks must be between 0 and and TimeOnly.MaxValue.Ticks.');
  return ticks;
}

function timeFromParts(hour: number, minute: number, second = 0, millisecond = 0): bigint {
  return ticksFromParts(1, 1, 1, hour, minute, second, millisecond);
}

const addTime =
  (unit: bigint | undefined): NativeMethod =>
  (call, receiver, [value, wrappedDays]) => {
    const added = unit === undefined ? ticksOf(value as Value) : ticksFromDouble(value as number, unit, 'product');
    const result = wrapped(ticksOf(receiver) + added);
    if (wrappedDays !== undefined) refOf(wrappedDays).set(result.days);
    return timeOnly(call, result.ticks);
  };

const setTime = (receiver: Value, ticks: bigint): Value => {
  (receiver as CsStruct).fields[0] = ticks;
  return undefined;
};

defineNatives({
  'System.TimeOnly..ctor(int, int)': (_call, receiver, [h, m]) =>
    setTime(receiver, timeFromParts(h as number, m as number)),
  'System.TimeOnly..ctor(int, int, int)': (_call, receiver, [h, m, s]) =>
    setTime(receiver, timeFromParts(h as number, m as number, s as number)),
  'System.TimeOnly..ctor(int, int, int, int)': (_call, receiver, [h, m, s, ms]) =>
    setTime(receiver, timeFromParts(h as number, m as number, s as number, ms as number)),
  'System.TimeOnly..ctor(long)': (call, receiver, [ticks]) => setTime(receiver, checkTimeTicks(call, ticks as bigint)),
  'System.TimeOnly.get_MinValue': (call) => timeOnly(call, 0n),
  'System.TimeOnly.get_MaxValue': (call) => timeOnly(call, TICKS_PER_DAY - 1n),
  'System.TimeOnly.FromDateTime': (call, _receiver, [value]) => timeOnly(call, ticksOf(value as Value) % TICKS_PER_DAY),
  'System.TimeOnly.FromTimeSpan': (call, _receiver, [span]) =>
    timeOnly(call, checkTimeTicks(call, ticksOf(span as Value))),
  'System.TimeOnly.get_Hour': (_call, receiver) => Number(ticksOf(receiver) / TICKS_PER_HOUR),
  'System.TimeOnly.get_Minute': (_call, receiver) => Number((ticksOf(receiver) % TICKS_PER_HOUR) / TICKS_PER_MINUTE),
  'System.TimeOnly.get_Second': (_call, receiver) => Number((ticksOf(receiver) % TICKS_PER_MINUTE) / TICKS_PER_SECOND),
  'System.TimeOnly.get_Millisecond': (_call, receiver) =>
    Number((ticksOf(receiver) % TICKS_PER_SECOND) / TICKS_PER_MILLISECOND),
  'System.TimeOnly.get_Ticks': (_call, receiver) => ticksOf(receiver),
  'System.TimeOnly.Add': addTime(undefined),
  'System.TimeOnly.AddHours': addTime(TICKS_PER_HOUR),
  'System.TimeOnly.AddMinutes': addTime(TICKS_PER_MINUTE),
  'System.TimeOnly.IsBetween': (_call, receiver, [start, end]) => {
    const time = ticksOf(receiver);
    const [from, to] = [ticksOf(start as Value), ticksOf(end as Value)];
    return from <= to ? from <= time && to > time : from <= time || to > time;
  },
  'System.TimeOnly.ToTimeSpan': (call, receiver) => timeSpan(call, ticksOf(receiver)),
  'System.TimeOnly.Deconstruct': (_call, receiver, args) => {
    const ticks = ticksOf(receiver);
    const parts = [
      ticks / TICKS_PER_HOUR,
      (ticks % TICKS_PER_HOUR) / TICKS_PER_MINUTE,
      (ticks % TICKS_PER_MINUTE) / TICKS_PER_SECOND,
      (ticks % TICKS_PER_SECOND) / TICKS_PER_MILLISECOND,
    ];
    for (const [index, arg] of args.entries()) refOf(arg).set(Number(parts[index]));
    return;
  },
  'System.TimeOnly.CompareTo': (_call, receiver, [other]) => timeCompare(receiver, other as Value),
  'System.TimeOnly.Equals': (_call, receiver, [other]) => timeEquals(receiver, other as Value),
  'System.TimeOnly.GetHashCode': (_call, receiver) =>
    Number(BigInt.asIntN(32, ticksOf(receiver) ^ (ticksOf(receiver) >> 32n))),
  'System.TimeOnly.op_Subtraction': (call, _receiver, [a, b]) => {
    const difference = ticksOf(a as Value) - ticksOf(b as Value);
    return timeSpan(call, difference < 0n ? TICKS_PER_DAY + difference : difference);
  },
  ...formatNatives(TIME_ONLY, 'time'),
  ...parseNatives<bigint>(
    TIME_ONLY,
    parseTimeOnly,
    (text, format, culture) => {
      const ticks = parseExactTicks(text, format, culture, 'TimeOnly');
      return typeof ticks === 'string' ? ticks : ticks % TICKS_PER_DAY;
    },
    (call, ticks) => timeOnly(call, ticks ?? 0n)
  ),
  ...comparisons(TIME_ONLY),
});
