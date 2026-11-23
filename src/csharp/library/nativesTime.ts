import { MeteredText, type TextBudget } from '../meteredText';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { PendingException } from '../numeric';
import { CsBox, CsStruct, type Value } from '../values';
import { fail, failNull, failOutOfRange, libraryType, refOf } from './support';

/** DateTime and TimeSpan keep their ticks (100 ns) in their one field. */
const TICKS_PER_MILLISECOND = 10_000n;
const TICKS_PER_SECOND = 10_000_000n;
const TICKS_PER_MINUTE = 600_000_000n;
const TICKS_PER_HOUR = 36_000_000_000n;
const TICKS_PER_DAY = 864_000_000_000n;
const MAX_DATE_TICKS = 3_155_378_975_999_999_999n;
/** The offset of the reference machine's time zone (Japan), where `DateTime.Now` is local time. */
const LOCAL_OFFSET_TICKS = 9n * TICKS_PER_HOUR;
/** The ticks of 1970-01-01, where JavaScript's clock starts. */
const UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;

const DAY_NAMES = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
const SHORT_DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
const ENGLISH_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ENGLISH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ticksOf(value: Value): bigint {
  return (unboxedTime(value) as CsStruct).fields[0] as bigint;
}

/** A DateTime or TimeSpan, unboxed when an `object` overload receives it. */
function unboxedTime(value: Value): Value {
  return value instanceof CsBox ? value.value : value;
}

/** `Equals(object)` of DateTime and TimeSpan, true for the same type's value with the same ticks, boxed or not. */
function timeEquals(receiver: Value, other: Value): boolean {
  const value = unboxedTime(other);
  return (
    value instanceof CsStruct &&
    value.type.symbol === (receiver as CsStruct).type.symbol &&
    ticksOf(receiver) === ticksOf(value)
  );
}

/** `CompareTo(object)` of DateTime and TimeSpan, which puts null first and rejects other types. */
function timeCompare(receiver: Value, other: Value): number {
  if (other === undefined) return 1;
  const value = unboxedTime(other);
  const symbol = (receiver as CsStruct).type.symbol;
  if (!(value instanceof CsStruct) || value.type.symbol !== symbol)
    fail('System.ArgumentException', `Object must be of type ${symbol.name}.`);
  return compareTicks(ticksOf(receiver), ticksOf(value));
}

function dateTime(call: NativeCall, ticks: bigint): CsStruct {
  if (ticks < 0n || ticks > MAX_DATE_TICKS)
    fail(
      'System.ArgumentOutOfRangeException',
      'The added or subtracted value results in an un-representable DateTime.',
      'value'
    );
  return new CsStruct(libraryType(call, 'System.DateTime'), [ticks]);
}

function timeSpan(call: NativeCall, ticks: bigint): CsStruct {
  if (ticks > 9_223_372_036_854_775_807n || ticks < -9_223_372_036_854_775_808n)
    fail('System.OverflowException', 'TimeSpan overflowed because the duration is too long.');
  return new CsStruct(libraryType(call, 'System.TimeSpan'), [ticks]);
}

/** The days from 0001-01-01 to a date of the proleptic Gregorian calendar. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  // 719162 days separate 0001-01-01 from 1970-01-01, and 719468 separate 0000-03-01 from 1970-01-01.
  return era * 146_097 + dayOfEra - 719_468 + 719_162;
}

function civilFromDays(days: number): {
  year: number;
  month: number;
  day: number;
} {
  const z = days + 719_468 - 719_162;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  fraction: bigint;
  dayOfWeek: number;
  dayOfYear: number;
}

function partsOf(ticks: bigint): DateParts {
  const days = Number(ticks / TICKS_PER_DAY);
  const rest = ticks % TICKS_PER_DAY;
  const { year, month, day } = civilFromDays(days);
  return {
    year,
    month,
    day,
    hour: Number(rest / TICKS_PER_HOUR),
    minute: Number((rest % TICKS_PER_HOUR) / TICKS_PER_MINUTE),
    second: Number((rest % TICKS_PER_MINUTE) / TICKS_PER_SECOND),
    millisecond: Number((rest % TICKS_PER_SECOND) / TICKS_PER_MILLISECOND),
    fraction: rest % TICKS_PER_SECOND,
    dayOfWeek: (days + 1) % 7,
    dayOfYear: days - daysFromCivil(year, 1, 1) + 1,
  };
}

// code-gauge-allow functionParameterCount -- The values that the operation needs, which share no object.
function ticksFromParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0
): bigint {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    fail(
      'System.ArgumentOutOfRangeException',
      'Year, Month, and Day parameters describe an un-representable DateTime.'
    );
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59)
    fail(
      'System.ArgumentOutOfRangeException',
      'Hour, Minute, and Second parameters describe an un-representable DateTime.'
    );
  if (millisecond < 0 || millisecond > 999)
    fail('System.ArgumentOutOfRangeException', 'Valid values are between 0 and 999, inclusive.', 'millisecond');
  return (
    BigInt(daysFromCivil(year, month, day)) * TICKS_PER_DAY +
    BigInt(hour) * TICKS_PER_HOUR +
    BigInt(minute) * TICKS_PER_MINUTE +
    BigInt(second) * TICKS_PER_SECOND +
    BigInt(millisecond) * TICKS_PER_MILLISECOND
  );
}

function nowTicks(): bigint {
  return BigInt(Date.now()) * TICKS_PER_MILLISECOND + UNIX_EPOCH_TICKS + LOCAL_OFFSET_TICKS;
}

/** Rounds a double number of a unit to ticks as .NET's `TimeSpan.From*` and `DateTime.Add*` do. */
function ticksFromDouble(value: number, unit: bigint, parameter: string): bigint {
  if (Number.isNaN(value))
    fail('System.ArgumentException', 'TimeSpan does not accept floating point Not-a-Number values.');
  const ticks = value * Number(unit);
  if (!Number.isFinite(ticks) || Math.abs(ticks) > 9.223372036854776e18)
    fail('System.OverflowException', 'TimeSpan overflowed because the duration is too long.');
  void parameter;
  return BigInt(Math.round(ticks));
}

/** TimeSpan's `*` and `/` by a double: .NET rejects a NaN operand, and a NaN or infinite result as an overflow. */
function scaledTicks(ticks: number, operand: number, scale: (ticks: number, by: number) => number): bigint {
  if (Number.isNaN(operand))
    fail('System.ArgumentException', 'TimeSpan does not accept floating point Not-a-Number values.');
  const result = scale(ticks, operand);
  if (!Number.isFinite(result) || Math.abs(result) > 9.223372036854776e18)
    fail('System.OverflowException', 'TimeSpan overflowed because the duration is too long.');
  return BigInt(Math.round(result));
}

// ---- Formatting ----

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

const STANDARD_DATE_FORMATS: Record<string, string> = {
  d: 'yyyy/MM/dd',
  D: 'yyyy年M月d日 dddd',
  t: 'H:mm',
  T: 'H:mm:ss',
  f: 'yyyy年M月d日 dddd H:mm',
  F: 'yyyy年M月d日 dddd H:mm:ss',
  g: 'yyyy/MM/dd H:mm',
  G: 'yyyy/MM/dd H:mm:ss',
  M: 'M月d日',
  m: 'M月d日',
  Y: 'yyyy年M月',
  y: 'yyyy年M月',
  s: "yyyy'-'MM'-'dd'T'HH':'mm':'ss",
  u: "yyyy'-'MM'-'dd HH':'mm':'ss'Z'",
  o: "yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffff",
  O: "yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffff",
};

/** Formats a DateTime with a standard or custom format string, with the ja-JP culture's names. */
export function formatDateTime(budget: TextBudget, value: CsStruct, format: string | undefined): string {
  const parts = partsOf(ticksOf(value));
  const pattern =
    format === undefined || format === ''
      ? STANDARD_DATE_FORMATS.G
      : format.length === 1
        ? STANDARD_DATE_FORMATS[format]
        : format;
  if (format === 'r' || format === 'R')
    return `${ENGLISH_DAYS[parts.dayOfWeek].slice(0, 3)}, ${pad(parts.day, 2)} ${ENGLISH_MONTHS[parts.month - 1]} ${pad(parts.year, 4)} ${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)} GMT`;
  if (pattern === undefined)
    throw new PendingException('System.FormatException', 'Input string was not in a correct format.');
  return customDate(parts, pattern, new MeteredText(budget));
}

function customDate(parts: DateParts, pattern: string, result: MeteredText): string {
  let index = 0;
  // Where the run of equal characters at the index ends, kept while a literal consumes the run in parts.
  let runEnd = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (index >= runEnd || pattern[runEnd - 1] !== char) {
      runEnd = index + 1;
      while (pattern[runEnd] === char) runEnd++;
      result.read(runEnd - index);
    }
    const count = runEnd - index;
    const field = dateField(parts, char, count);
    if (field === undefined) {
      const literal = dateLiteral(pattern, index, count);
      result.read(literal.length);
      // .NET drops a `.` before `F` digits that all come out as zeros, so a whole second shows no point.
      if (!(literal.text === '.' && isEmptyOptionalFraction(parts, pattern, index + literal.length)))
        result.append(literal.text);
      index += literal.length;
    } else {
      result.append(field);
      index += count;
    }
  }
  return result.toString();
}

/** Whether the pattern has a run of `F` at the index whose digits are all zeros for the date. */
function isEmptyOptionalFraction(parts: DateParts, pattern: string, index: number): boolean {
  let end = index;
  while (pattern[end] === 'F') end++;
  return end > index && dateField(parts, 'F', end - index) === '';
}

/** The text of a run of `count` copies of a custom date format specifier, or undefined for a literal character. */
// code-gauge-allow functionCognitiveComplexity -- One case per custom date format specifier.
// code-gauge-allow functionNcss -- One case per custom date format specifier.
function dateField(parts: DateParts, char: string, count: number): string | undefined {
  switch (char) {
    case 'y': {
      return count <= 2 ? pad(parts.year % 100, count) : pad(parts.year, count);
    }
    case 'M': {
      return count <= 2 ? pad(parts.month, count) : `${parts.month}月`;
    }
    case 'd': {
      if (count <= 2) return pad(parts.day, count);
      return count === 3 ? SHORT_DAY_NAMES[parts.dayOfWeek] : DAY_NAMES[parts.dayOfWeek];
    }
    case 'H': {
      return pad(parts.hour, Math.min(count, 2));
    }
    case 'h': {
      return pad(parts.hour % 12 === 0 ? 12 : parts.hour % 12, Math.min(count, 2));
    }
    case 'm': {
      return pad(parts.minute, Math.min(count, 2));
    }
    case 's': {
      return pad(parts.second, Math.min(count, 2));
    }
    case 'f':
    case 'F': {
      const digits = parts.fraction.toString().padStart(7, '0').slice(0, count);
      return char === 'F' ? digits.replace(/0+$/, '') : digits;
    }
    case 't': {
      const designator = parts.hour < 12 ? '午前' : '午後';
      return count === 1 ? designator.charAt(0) : designator;
    }
    case 'K': {
      return '';
    }
    case 'g': {
      return '西暦';
    }
    case 'z': {
      if (count === 1) return '+9';
      return count === 2 ? '+09' : '+09:00';
    }
    default: {
      return undefined;
    }
  }
}

/** The text of the literal at an index of a custom date format and the length of the pattern it takes. */
function dateLiteral(pattern: string, index: number, count: number): { text: string; length: number } {
  const char = pattern[index];
  if (char === '/' || char === ':') return { text: char, length: 1 };
  if (char === "'" || char === '"') {
    const end = pattern.indexOf(char, index + 1);
    const close = end === -1 ? pattern.length : end;
    return { text: pattern.slice(index + 1, close), length: close - index + 1 };
  }
  if (char === '\\') return { text: pattern[index + 1] ?? '', length: 2 };
  // `%` marks the next character as a custom specifier, as in `%d`, which would otherwise be a standard format.
  if (char === '%') return { text: '', length: 1 };
  return { text: char.repeat(count), length: count };
}

/** Formats a TimeSpan: `[-][d.]hh:mm:ss[.fffffff]`, or with a custom format. */
export function formatTimeSpan(budget: TextBudget, value: CsStruct, format: string | undefined): string {
  const ticks = ticksOf(value);
  const negative = ticks < 0n;
  const magnitude = negative ? -ticks : ticks;
  const span: TimeSpanParts = {
    sign: negative ? '-' : '',
    days: magnitude / TICKS_PER_DAY,
    hours: Number((magnitude % TICKS_PER_DAY) / TICKS_PER_HOUR),
    minutes: Number((magnitude % TICKS_PER_HOUR) / TICKS_PER_MINUTE),
    seconds: Number((magnitude % TICKS_PER_MINUTE) / TICKS_PER_SECOND),
    fraction: magnitude % TICKS_PER_SECOND,
  };
  if (format === undefined || format === '' || format === 'c' || format === 't' || format === 'T') {
    const { sign, days, hours, minutes, seconds, fraction } = span;
    return `${sign}${days > 0n ? `${days}.` : ''}${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${fraction > 0n ? `.${fraction.toString().padStart(7, '0')}` : ''}`;
  }
  if (format === 'g') {
    const { sign, days, hours, minutes, seconds, fraction } = span;
    return `${sign}${days > 0n ? `${days}:` : ''}${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}${fraction > 0n ? `.${fraction.toString().padStart(7, '0').replace(/0+$/, '')}` : ''}`;
  }
  if (format === 'G') {
    const { sign, days, hours, minutes, seconds, fraction } = span;
    return `${sign}${days}:${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${fraction.toString().padStart(7, '0')}`;
  }
  return customTimeSpan(span, format, new MeteredText(budget));
}

interface TimeSpanParts {
  sign: string;
  days: bigint;
  hours: number;
  minutes: number;
  seconds: number;
  fraction: bigint;
}

function customTimeSpan(span: TimeSpanParts, format: string, result: MeteredText): string {
  // Where the run of equal characters at the index ends, kept while a literal consumes the run in parts.
  let runEnd = 0;
  for (let index = 0; index < format.length; index++) {
    const char = format[index];
    if (index >= runEnd || format[runEnd - 1] !== char) {
      runEnd = index + 1;
      while (format[runEnd] === char) runEnd++;
      result.read(runEnd - index);
    }
    const count = runEnd - index;
    const field = timeSpanField(span, char, count);
    if (field !== undefined) {
      result.append(field);
      index += count - 1;
    } else if (char === '\\') {
      result.append(format[index + 1] ?? '');
      index++;
    } else if (char === '%' && index + 1 < format.length) {
      // `%` marks the next character as a custom specifier, as in `%d`.
    } else if (char === "'") {
      const end = format.indexOf("'", index + 1);
      if (end === -1) throw new PendingException('System.FormatException', 'Input string was not in a correct format.');
      result.read(end - index);
      result.append(format.slice(index + 1, end));
      index = end;
    } else throw new PendingException('System.FormatException', 'Input string was not in a correct format.');
  }
  return result.toString();
}

function timeSpanField(span: TimeSpanParts, char: string, count: number): string | undefined {
  if (char === 'd') return span.days.toString().padStart(count, '0');
  if (char === 'h') return pad(span.hours, count);
  if (char === 'm') return pad(span.minutes, count);
  if (char === 's') return pad(span.seconds, count);
  if (char === 'f') return span.fraction.toString().padStart(7, '0').slice(0, count);
  // `F` shows the same digits without their trailing zeros.
  if (char === 'F') return span.fraction.toString().padStart(7, '0').slice(0, count).replace(/0+$/, '');
  return undefined;
}

// ---- Natives ----

const fromUnit =
  (unit: bigint): NativeMethod =>
  (call, _receiver, [value]) =>
    timeSpan(call, ticksFromDouble(value as number, unit, 'value'));

defineNatives({
  'System.TimeSpan..ctor(long)': (_call, receiver, [ticks]) => setTicks(receiver, ticks as bigint),
  'System.TimeSpan..ctor(int, int, int)': (_call, receiver, [h, m, s]) =>
    setTicks(
      receiver,
      BigInt(h as number) * TICKS_PER_HOUR +
        BigInt(m as number) * TICKS_PER_MINUTE +
        BigInt(s as number) * TICKS_PER_SECOND
    ),
  'System.TimeSpan..ctor(int, int, int, int)': (_call, receiver, [d, h, m, s]) =>
    setTicks(
      receiver,
      BigInt(d as number) * TICKS_PER_DAY +
        BigInt(h as number) * TICKS_PER_HOUR +
        BigInt(m as number) * TICKS_PER_MINUTE +
        BigInt(s as number) * TICKS_PER_SECOND
    ),
  'System.TimeSpan..ctor(int, int, int, int, int)': (_call, receiver, [d, h, m, s, ms]) =>
    setTicks(
      receiver,
      BigInt(d as number) * TICKS_PER_DAY +
        BigInt(h as number) * TICKS_PER_HOUR +
        BigInt(m as number) * TICKS_PER_MINUTE +
        BigInt(s as number) * TICKS_PER_SECOND +
        BigInt(ms as number) * TICKS_PER_MILLISECOND
    ),
  'System.TimeSpan.get_Ticks': (_call, receiver) => ticksOf(receiver),
  'System.TimeSpan.get_Days': (_call, receiver) => Number(ticksOf(receiver) / TICKS_PER_DAY),
  'System.TimeSpan.get_Hours': (_call, receiver) => Number((ticksOf(receiver) % TICKS_PER_DAY) / TICKS_PER_HOUR),
  'System.TimeSpan.get_Minutes': (_call, receiver) => Number((ticksOf(receiver) % TICKS_PER_HOUR) / TICKS_PER_MINUTE),
  'System.TimeSpan.get_Seconds': (_call, receiver) => Number((ticksOf(receiver) % TICKS_PER_MINUTE) / TICKS_PER_SECOND),
  'System.TimeSpan.get_Milliseconds': (_call, receiver) =>
    Number((ticksOf(receiver) % TICKS_PER_SECOND) / TICKS_PER_MILLISECOND),
  'System.TimeSpan.get_TotalDays': (_call, receiver) => Number(ticksOf(receiver)) / Number(TICKS_PER_DAY),
  'System.TimeSpan.get_TotalHours': (_call, receiver) => Number(ticksOf(receiver)) / Number(TICKS_PER_HOUR),
  'System.TimeSpan.get_TotalMinutes': (_call, receiver) => Number(ticksOf(receiver)) / Number(TICKS_PER_MINUTE),
  'System.TimeSpan.get_TotalSeconds': (_call, receiver) => Number(ticksOf(receiver)) / Number(TICKS_PER_SECOND),
  'System.TimeSpan.get_TotalMilliseconds': (_call, receiver) =>
    Number(ticksOf(receiver)) / Number(TICKS_PER_MILLISECOND),
  'System.TimeSpan.Add': (call, receiver, [other]) => timeSpan(call, ticksOf(receiver) + ticksOf(other as Value)),
  'System.TimeSpan.Subtract': (call, receiver, [other]) => timeSpan(call, ticksOf(receiver) - ticksOf(other as Value)),
  'System.TimeSpan.Negate': (call, receiver) => timeSpan(call, -ticksOf(receiver)),
  'System.TimeSpan.Duration': (call, receiver) =>
    timeSpan(call, ticksOf(receiver) < 0n ? -ticksOf(receiver) : ticksOf(receiver)),
  'System.TimeSpan.CompareTo': (_call, receiver, [other]) => timeCompare(receiver, other as Value),
  'System.TimeSpan.Equals': (_call, receiver, [other]) => timeEquals(receiver, other as Value),
  'System.TimeSpan.GetHashCode': (_call, receiver) =>
    Number(BigInt.asIntN(32, ticksOf(receiver) ^ (ticksOf(receiver) >> 32n))),
  'System.TimeSpan.ToString': (call, receiver, [format]) =>
    formatTimeSpan(call.frame.runtime, receiver as CsStruct, (format as string | undefined) ?? undefined),
  'System.TimeSpan.FromDays': fromUnit(TICKS_PER_DAY),
  'System.TimeSpan.FromHours': fromUnit(TICKS_PER_HOUR),
  'System.TimeSpan.FromMinutes': fromUnit(TICKS_PER_MINUTE),
  'System.TimeSpan.FromSeconds': fromUnit(TICKS_PER_SECOND),
  'System.TimeSpan.FromMilliseconds': fromUnit(TICKS_PER_MILLISECOND),
  'System.TimeSpan.FromTicks': (call, _receiver, [ticks]) => timeSpan(call, ticks as bigint),
  'System.TimeSpan.op_Addition': (call, _receiver, [a, b]) => timeSpan(call, ticksOf(a as Value) + ticksOf(b as Value)),
  'System.TimeSpan.op_Subtraction': (call, _receiver, [a, b]) =>
    timeSpan(call, ticksOf(a as Value) - ticksOf(b as Value)),
  'System.TimeSpan.op_UnaryNegation': (call, _receiver, [a]) => timeSpan(call, -ticksOf(a as Value)),
  'System.TimeSpan.op_Multiply': (call, _receiver, [a, factor]) =>
    timeSpan(
      call,
      scaledTicks(Number(ticksOf(a as Value)), factor as number, (ticks, by) => ticks * by)
    ),
  'System.TimeSpan.op_Division(TimeSpan, double)': (call, _receiver, [a, divisor]) =>
    timeSpan(
      call,
      scaledTicks(Number(ticksOf(a as Value)), divisor as number, (ticks, by) => ticks / by)
    ),
  'System.TimeSpan.op_Division(TimeSpan, TimeSpan)': (_call, _receiver, [a, b]) =>
    Number(ticksOf(a as Value)) / Number(ticksOf(b as Value)),
  ...comparisons('System.TimeSpan'),
});

function setTicks(receiver: Value, ticks: bigint): Value {
  (receiver as CsStruct).fields[0] = ticks;
  return undefined;
}

function compareTicks(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparisons(type: string): Record<string, NativeMethod> {
  const operators: [string, (order: number) => boolean][] = [
    ['op_Equality', (order) => order === 0],
    ['op_Inequality', (order) => order !== 0],
    ['op_LessThan', (order) => order < 0],
    ['op_LessThanOrEqual', (order) => order <= 0],
    ['op_GreaterThan', (order) => order > 0],
    ['op_GreaterThanOrEqual', (order) => order >= 0],
  ];
  return Object.fromEntries(
    operators.map(([name, test]) => [
      `${type}.${name}`,
      ((_call, _receiver, [a, b]) => test(compareTicks(ticksOf(a as Value), ticksOf(b as Value)))) as NativeMethod,
    ])
  );
}

const addUnit =
  (unit: bigint): NativeMethod =>
  (call, receiver, [value]) =>
    dateTime(call, ticksOf(receiver) + ticksFromDouble(value as number, unit, 'value'));

defineNatives({
  'System.DateTime..ctor(long)': (call, receiver, [ticks]) => {
    if ((ticks as bigint) < 0n || (ticks as bigint) > MAX_DATE_TICKS)
      failOutOfRange(call, 'ticks', 'Ticks must be between DateTime.MinValue.Ticks and DateTime.MaxValue.Ticks.');
    return setTicks(receiver, ticks as bigint);
  },
  'System.DateTime..ctor(int, int, int)': (_call, receiver, [y, m, d]) =>
    setTicks(receiver, ticksFromParts(y as number, m as number, d as number)),
  'System.DateTime..ctor(int, int, int, int, int, int)': (_call, receiver, [y, mo, d, h, mi, s]) =>
    setTicks(receiver, ticksFromParts(y as number, mo as number, d as number, h as number, mi as number, s as number)),
  'System.DateTime..ctor(int, int, int, int, int, int, int)': (_call, receiver, [y, mo, d, h, mi, s, ms]) =>
    setTicks(
      receiver,
      ticksFromParts(y as number, mo as number, d as number, h as number, mi as number, s as number, ms as number)
    ),
  'System.DateTime.get_Now': (call) => dateTime(call, nowTicks()),
  'System.DateTime.get_UtcNow': (call) => dateTime(call, nowTicks() - LOCAL_OFFSET_TICKS),
  'System.DateTime.get_Today': (call) => dateTime(call, (nowTicks() / TICKS_PER_DAY) * TICKS_PER_DAY),
  'System.DateTime.get_Date': (call, receiver) => dateTime(call, (ticksOf(receiver) / TICKS_PER_DAY) * TICKS_PER_DAY),
  'System.DateTime.get_Year': (_call, receiver) => partsOf(ticksOf(receiver)).year,
  'System.DateTime.get_Month': (_call, receiver) => partsOf(ticksOf(receiver)).month,
  'System.DateTime.get_Day': (_call, receiver) => partsOf(ticksOf(receiver)).day,
  'System.DateTime.get_Hour': (_call, receiver) => partsOf(ticksOf(receiver)).hour,
  'System.DateTime.get_Minute': (_call, receiver) => partsOf(ticksOf(receiver)).minute,
  'System.DateTime.get_Second': (_call, receiver) => partsOf(ticksOf(receiver)).second,
  'System.DateTime.get_Millisecond': (_call, receiver) => partsOf(ticksOf(receiver)).millisecond,
  'System.DateTime.get_Ticks': (_call, receiver) => ticksOf(receiver),
  'System.DateTime.get_DayOfWeek': (_call, receiver) => partsOf(ticksOf(receiver)).dayOfWeek,
  'System.DateTime.get_DayOfYear': (_call, receiver) => partsOf(ticksOf(receiver)).dayOfYear,
  'System.DateTime.get_TimeOfDay': (call, receiver) => timeSpan(call, ticksOf(receiver) % TICKS_PER_DAY),
  'System.DateTime.Add': (call, receiver, [span]) => dateTime(call, ticksOf(receiver) + ticksOf(span as Value)),
  'System.DateTime.AddDays': addUnit(TICKS_PER_DAY),
  'System.DateTime.AddHours': addUnit(TICKS_PER_HOUR),
  'System.DateTime.AddMinutes': addUnit(TICKS_PER_MINUTE),
  'System.DateTime.AddSeconds': addUnit(TICKS_PER_SECOND),
  'System.DateTime.AddMilliseconds': addUnit(TICKS_PER_MILLISECOND),
  'System.DateTime.AddTicks': (call, receiver, [ticks]) => dateTime(call, ticksOf(receiver) + (ticks as bigint)),
  'System.DateTime.AddMonths': (call, receiver, [months]) => addMonths(call, receiver, months as number),
  'System.DateTime.AddYears': (call, receiver, [years]) => addMonths(call, receiver, (years as number) * 12),
  'System.DateTime.Subtract(DateTime)': (call, receiver, [other]) =>
    timeSpan(call, ticksOf(receiver) - ticksOf(other as Value)),
  'System.DateTime.Subtract(TimeSpan)': (call, receiver, [span]) =>
    dateTime(call, ticksOf(receiver) - ticksOf(span as Value)),
  'System.DateTime.CompareTo': (_call, receiver, [other]) => timeCompare(receiver, other as Value),
  'System.DateTime.Compare': (_call, _receiver, [a, b]) => compareTicks(ticksOf(a as Value), ticksOf(b as Value)),
  'System.DateTime.Equals': (_call, receiver, [other]) => timeEquals(receiver, other as Value),
  'System.DateTime.GetHashCode': (_call, receiver) =>
    Number(BigInt.asIntN(32, ticksOf(receiver) ^ (ticksOf(receiver) >> 32n))),
  'System.DateTime.ToString': (call, receiver, [format]) =>
    formatDateTime(call.frame.runtime, receiver as CsStruct, (format as string | undefined) ?? undefined),
  'System.DateTime.ToShortDateString': (call, receiver) =>
    formatDateTime(call.frame.runtime, receiver as CsStruct, 'd'),
  'System.DateTime.ToLongDateString': (call, receiver) => formatDateTime(call.frame.runtime, receiver as CsStruct, 'D'),
  'System.DateTime.ToShortTimeString': (call, receiver) =>
    formatDateTime(call.frame.runtime, receiver as CsStruct, 't'),
  'System.DateTime.ToLongTimeString': (call, receiver) => formatDateTime(call.frame.runtime, receiver as CsStruct, 'T'),
  'System.DateTime.DaysInMonth': (_call, _receiver, [year, month]) => {
    if ((month as number) < 1 || (month as number) > 12)
      fail('System.ArgumentOutOfRangeException', 'Month must be between one and twelve.', 'month');
    return daysInMonth(year as number, month as number);
  },
  'System.DateTime.IsLeapYear': (_call, _receiver, [year]) => isLeapYear(year as number),
  'System.DateTime.Parse': (call, _receiver, [text]) => {
    if (text === undefined) failNull('s');
    const ticks = parseDate(text as string);
    if (ticks === undefined) fail('System.FormatException', dateTimeParseError(text as string));
    return dateTime(call, ticks);
  },
  'System.DateTime.TryParse': (call, _receiver, [text, result]) => {
    const ticks = text === undefined ? undefined : parseDate(text as string);
    refOf(result).set(dateTime(call, ticks ?? 0n));
    return ticks !== undefined;
  },
  'System.DateTime.op_Addition': (call, _receiver, [d, t]) => dateTime(call, ticksOf(d as Value) + ticksOf(t as Value)),
  'System.DateTime.op_Subtraction(DateTime, TimeSpan)': (call, _receiver, [d, t]) =>
    dateTime(call, ticksOf(d as Value) - ticksOf(t as Value)),
  'System.DateTime.op_Subtraction(DateTime, DateTime)': (call, _receiver, [a, b]) =>
    timeSpan(call, ticksOf(a as Value) - ticksOf(b as Value)),
  ...comparisons('System.DateTime'),
});

function addMonths(call: NativeCall, receiver: Value, months: number): Value {
  const ticks = ticksOf(receiver);
  const parts = partsOf(ticks);
  const total = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  if (year < 1 || year > 9999)
    fail(
      'System.ArgumentOutOfRangeException',
      'The added or subtracted value results in an un-representable DateTime.',
      'months'
    );
  const day = Math.min(parts.day, daysInMonth(year, month));
  return dateTime(call, BigInt(daysFromCivil(year, month, day)) * TICKS_PER_DAY + (ticks % TICKS_PER_DAY));
}

/** Parses the dates of the forms programs write: `2024/3/5`, `2024-03-05`, with an optional `H:m[:s[.fffffff]]`. */
function parseDate(text: string): bigint | undefined {
  // ja-JP also reads the long date, as `2024年3月5日 10時20分`.
  const normalized = text
    .replace(/^(\s*\d{4})年(\d{1,2})月(\d{1,2})日/, '$1/$2/$3')
    .replace(
      /(\d{1,2})時(\d{1,2})分(?:(\d{1,2})秒)?(\s*)$/,
      (_match, hour: string, minute: string, second: string | undefined, rest: string) =>
        `${hour}:${minute.padStart(2, '0')}${second === undefined ? '' : `:${second.padStart(2, '0')}`}${rest}`
    );
  const match =
    /^\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,7}))?)?)?\s*$/.exec(
      normalized
    );
  if (!match) return undefined;
  const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = ''] = match;
  try {
    const whole = ticksFromParts(
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    // A fraction of a second has up to seven digits, one per tick (100 ns).
    return whole + BigInt(fraction.padEnd(7, '0') || '0');
  } catch {
    return undefined;
  }
}

/** .NET's message for a string that DateTime.Parse rejects, which points at the first word it does not know. */
function dateTimeParseError(text: string): string {
  const word = /\p{L}/u.exec(text);
  if (!word) return `String '${text}' was not recognized as a valid DateTime.`;
  return `The string '${text}' was not recognized as a valid DateTime. There is an unknown word starting at index '${word.index}'.`;
}
