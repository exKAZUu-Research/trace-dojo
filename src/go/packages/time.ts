import type { Entity } from '../entities';
import { newError } from '../errorValues';
import {
  addMethod,
  blockingFunction,
  currentRuntime,
  definePackage,
  fn,
  namedType,
  nativeFunction,
  typeEntity,
} from '../native';
import { GoPanic } from '../runtime';
import { type Goroutine, makeChannel, scheduler } from '../scheduler';
import { BASIC, type NamedType, pointerTo, type Type } from '../types';
import { type Channel, type GoFunc, GoStruct, Pointer, type Value } from '../values';
import { BOOL, ERROR_TYPE, INT, STRING } from './support';

// Durations -----------------------------------------------------------------------------------------------------------

const DURATION = namedType('time', 'Duration', BASIC.int64);
const NANOSECOND = 1n;
const MICROSECOND = 1000n;
const MILLISECOND = 1_000_000n;
const SECOND = 1_000_000_000n;
const MINUTE = 60n * SECOND;
const HOUR = 60n * MINUTE;
const MIN_DURATION = -(1n << 63n);
const MAX_DURATION = (1n << 63n) - 1n;

/** Go's fmtFrac: the fraction of `value` with `precision` digits, without trailing zeros. */
function fractionText(value: bigint, precision: number): [string, bigint] {
  let digits = '';
  let printing = false;
  let rest = value;
  for (let index = 0; index < precision; index++) {
    const digit = rest % 10n;
    printing ||= digit !== 0n;
    if (printing) digits = String(digit) + digits;
    rest /= 10n;
  }
  return [printing ? `.${digits}` : '', rest];
}

/** Duration.String: `72h3m0.5s`, with units below a second for short durations. */
export function durationString(duration: bigint): string {
  const negative = duration < 0n;
  let value = negative ? -duration : duration;
  let text: string;
  if (value < SECOND) {
    if (value === 0n) return '0s';
    let precision: number;
    let unit: string;
    if (value < MICROSECOND) {
      precision = 0;
      unit = 'ns';
    } else if (value < MILLISECOND) {
      precision = 3;
      // The micro sign U+00B5 in UTF-8.
      unit = 'Âµs';
    } else {
      precision = 6;
      unit = 'ms';
    }
    const [fraction, whole] = fractionText(value, precision);
    text = `${whole}${fraction}${unit}`;
  } else {
    const [fraction, whole] = fractionText(value, 9);
    value = whole;
    text = `${value % 60n}${fraction}s`;
    value /= 60n;
    if (value > 0n) {
      text = `${value % 60n}m${text}`;
      value /= 60n;
      if (value > 0n) text = `${value}h${text}`;
    }
  }
  return negative ? `-${text}` : text;
}

const durationOf = (value: Value): bigint => value as bigint;
const floatUnits = (duration: bigint, unit: bigint): number =>
  Number(duration / unit) + Number(duration % unit) / Number(unit);

addMethod(DURATION, 'String', fn([], [STRING]), (receiver) => durationString(durationOf(receiver)));
addMethod(DURATION, 'Nanoseconds', fn([], [BASIC.int64]), (receiver) => durationOf(receiver));
addMethod(DURATION, 'Microseconds', fn([], [BASIC.int64]), (receiver) => durationOf(receiver) / MICROSECOND);
addMethod(DURATION, 'Milliseconds', fn([], [BASIC.int64]), (receiver) => durationOf(receiver) / MILLISECOND);
addMethod(DURATION, 'Seconds', fn([], [BASIC.float64]), (receiver) => floatUnits(durationOf(receiver), SECOND));
addMethod(DURATION, 'Minutes', fn([], [BASIC.float64]), (receiver) => floatUnits(durationOf(receiver), MINUTE));
addMethod(DURATION, 'Hours', fn([], [BASIC.float64]), (receiver) => floatUnits(durationOf(receiver), HOUR));
addMethod(DURATION, 'Truncate', fn([DURATION], [DURATION]), (receiver, [unit]) => {
  const duration = durationOf(receiver);
  const m = durationOf(unit);
  return m <= 0n ? duration : duration - (duration % m);
});
addMethod(DURATION, 'Round', fn([DURATION], [DURATION]), (receiver, [unit]) =>
  roundDuration(durationOf(receiver), durationOf(unit))
);
addMethod(DURATION, 'Abs', fn([], [DURATION]), (receiver) => {
  const duration = durationOf(receiver);
  if (duration >= 0n) return duration;
  return duration === MIN_DURATION ? MAX_DURATION : -duration;
});

function roundDuration(duration: bigint, m: bigint): bigint {
  if (m <= 0n) return duration;
  let r = duration % m;
  const lessThanHalf = (x: bigint): boolean => x + x < m;
  if (duration < 0n) {
    r = -r;
    if (lessThanHalf(r)) return duration + r;
    const rounded = duration - m + r;
    return rounded < duration ? rounded : MIN_DURATION;
  }
  if (lessThanHalf(r)) return duration - r;
  const rounded = duration + m - r;
  return rounded > duration ? rounded : MAX_DURATION;
}

const UNITS = new Map<string, bigint>([
  ['ns', NANOSECOND],
  ['us', MICROSECOND],
  ['Âµs', MICROSECOND],
  ['Î¼s', MICROSECOND],
  ['ms', MILLISECOND],
  ['s', SECOND],
  ['m', MINUTE],
  ['h', HOUR],
]);

/** time.ParseDuration, as Go's: a sequence of decimal numbers with units, such as `1h15m30.5s`. */
// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes Go's ParseDuration.
function parseDuration(original: string): [bigint, Value] {
  const invalid = (): [bigint, Value] => [0n, newError(`time: invalid duration "${original}"`)];
  let text = original;
  let negative = false;
  if (text.startsWith('-') || text.startsWith('+')) {
    negative = text.startsWith('-');
    text = text.slice(1);
  }
  if (text === '0') return [0n, undefined];
  if (text === '') return invalid();
  let total = 0n;
  while (text !== '') {
    if (!/^[.\d]/.test(text)) return invalid();
    const whole = /^\d*/.exec(text)?.[0] ?? '';
    text = text.slice(whole.length);
    let fraction = '';
    let hasFraction = false;
    if (text.startsWith('.')) {
      fraction = /^\d*/.exec(text.slice(1))?.[0] ?? '';
      text = text.slice(1 + fraction.length);
      hasFraction = fraction.length > 0;
    }
    if (whole === '' && !hasFraction) return invalid();
    const unitText = /^[^.\d]*/.exec(text)?.[0] ?? '';
    if (unitText === '') return [0n, newError(`time: missing unit in duration "${original}"`)];
    text = text.slice(unitText.length);
    const unit = UNITS.get(unitText);
    if (unit === undefined) return [0n, newError(`time: unknown unit "${unitText}" in duration "${original}"`)];
    let value = BigInt(whole || '0');
    if (value > (1n << 63n) / unit) return invalid();
    value *= unit;
    if (hasFraction) {
      let digits = 0n;
      let scale = 1;
      for (const digit of fraction) {
        if (digits > ((1n << 63n) - 1n) / 10n) break;
        digits = digits * 10n + BigInt(digit);
        scale *= 10;
      }
      value += BigInt(Math.trunc(Number(digits) * (Number(unit) / scale)));
      if (value > 1n << 63n) return invalid();
    }
    total += value;
    if (total > 1n << 63n) return invalid();
  }
  if (negative) return [-total, undefined];
  if (total > MAX_DURATION) return invalid();
  return [total, undefined];
}

// Locations and times -------------------------------------------------------------------------------------------------

interface Location {
  name: string;
  /** The fixed offset east of UTC in seconds; the local zone looks its offset up for each instant. */
  offset?: number;
}

const UTC_LOCATION: Location = { name: 'UTC', offset: 0 };
const LOCAL_LOCATION: Location = { name: 'Local' };

/** Abbreviations that Go's zone database gives and JavaScript does not. */
const ZONE_ABBREVIATIONS: Record<string, string> = {
  'Asia/Tokyo': 'JST',
  'Asia/Seoul': 'KST',
  'Asia/Shanghai': 'CST',
  UTC: 'UTC',
  'Etc/UTC': 'UTC',
};

/** The offset and the zone's abbreviation at an instant. */
function zoneAt(location: Location, unixSeconds: number): { offset: number; name: string } {
  if (location.offset !== undefined) return { offset: location.offset, name: location.name };
  const millis = Math.max(Math.min(unixSeconds * 1000, 8.64e15), -8.64e15);
  const date = new Date(millis);
  const offset = -date.getTimezoneOffset() * 60;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const known = ZONE_ABBREVIATIONS[zone];
  if (known) return { offset, name: known };
  const short =
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  return { offset, name: /^GMT[+-]|^UTC[+-]/.test(short) || short === '' ? '' : short === 'GMT' ? 'UTC' : short };
}

const LOCATION = namedType('time', 'Location', { kind: 'struct', fields: [] });
const locationPointer = (location: Location): Pointer =>
  new Pointer({ v: new GoStruct([], { location }) } as never, 'v');
const UTC_POINTER = locationPointer(UTC_LOCATION);
const LOCAL_POINTER = locationPointer(LOCAL_LOCATION);
const locationOf = (value: Value): Location => {
  if (!(value instanceof Pointer)) return UTC_LOCATION;
  return ((value.load() as GoStruct).native?.location as Location | undefined) ?? UTC_LOCATION;
};
addMethod(LOCATION, 'String', fn([], [STRING]), (receiver) => locationOf(receiver).name, true);

/** `time.Time`: nanoseconds since the Unix epoch, its location, and a reading of the program's virtual clock. */
interface Instant {
  wall: bigint;
  location: Location;
  /** Nanoseconds of virtual time since the program started, which `Sub` prefers, as Go's monotonic clock. */
  monotonic?: bigint;
}

const TIME = namedType('time', 'Time', { kind: 'struct', fields: [] });
/** January 1 of year 1, which the zero Time is. */
const ZERO_WALL = -62_135_596_800n * SECOND;
const ZERO_INSTANT: Instant = { wall: ZERO_WALL, location: UTC_LOCATION };

const instantOf = (value: Value): Instant =>
  ((value as GoStruct).native?.instant as Instant | undefined) ?? ZERO_INSTANT;
const timeValue = (instant: Instant): GoStruct => new GoStruct([], { instant });

function floorDivide(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

/** The calendar fields of a time in its location. */
interface Fields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  nanosecond: number;
  weekday: number;
  yearDay: number;
  offset: number;
  zone: string;
}

function fieldsOf(instant: Instant): Fields {
  const seconds = floorDivide(instant.wall, SECOND);
  const nanosecond = Number(instant.wall - seconds * SECOND);
  const { offset, name } = zoneAt(instant.location, Number(seconds));
  const date = new Date(Number(seconds + BigInt(offset)) * 1000);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const start = new Date(yearStart);
  start.setUTCFullYear(date.getUTCFullYear());
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    nanosecond,
    weekday: date.getUTCDay(),
    yearDay: Math.floor((date.getTime() - start.getTime()) / 86_400_000) + 1,
    offset,
    zone: name,
  };
}

/** time.Date: normalizes out-of-range fields as Go does, then finds the instant in the location. */
function dateInstant(fields: number[], location: Location): Instant {
  const [year, month, day, hour, minute, second, nanosecond] = fields;
  const extraSeconds = Math.floor(nanosecond / 1e9);
  const nanos = nanosecond - extraSeconds * 1e9;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second + extraSeconds, 0);
  let seconds = Math.floor(date.getTime() / 1000);
  if (location.offset !== undefined) seconds -= location.offset;
  else {
    // The local offset depends on the instant, which depends on the offset: Go adjusts once, as here.
    const guess = seconds - zoneAt(location, seconds).offset;
    seconds -= zoneAt(location, guess).offset;
  }
  return { wall: BigInt(seconds) * SECOND + BigInt(nanos), location };
}

/** The virtual time since the program started, which `time.Sleep` advances without waiting. */
function virtualNow(): bigint {
  const running = currentRuntime().scheduler;
  return BigInt((running as { now?: number } | undefined)?.now ?? 0);
}

const programStarts = new WeakMap<object, bigint>();

function now(): Instant {
  const runtime = currentRuntime();
  let start = programStarts.get(runtime);
  if (start === undefined) {
    start = BigInt(Date.now()) * MILLISECOND;
    programStarts.set(runtime, start);
  }
  const elapsed = virtualNow();
  return { wall: start + elapsed, location: LOCAL_LOCATION, monotonic: elapsed + 1n };
}

function subtract(a: Instant, b: Instant): bigint {
  const difference =
    a.monotonic !== undefined && b.monotonic !== undefined ? a.monotonic - b.monotonic : a.wall - b.wall;
  if (difference > MAX_DURATION) return MAX_DURATION;
  if (difference < MIN_DURATION) return MIN_DURATION;
  return difference;
}

function compareInstants(a: Instant, b: Instant): number {
  const difference =
    a.monotonic !== undefined && b.monotonic !== undefined ? a.monotonic - b.monotonic : a.wall - b.wall;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

// Formatting ----------------------------------------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function pad(value: number, width: number, filler = '0'): string {
  const text = String(Math.abs(value)).padStart(width, filler);
  return value < 0 ? `-${text}` : text;
}

type Chunk =
  | 'longMonth'
  | 'month'
  | 'numMonth'
  | 'zeroMonth'
  | 'longWeekDay'
  | 'weekDay'
  | 'day'
  | 'underDay'
  | 'zeroDay'
  | 'underYearDay'
  | 'zeroYearDay'
  | 'hour'
  | 'hour12'
  | 'zeroHour12'
  | 'minute'
  | 'zeroMinute'
  | 'second'
  | 'zeroSecond'
  | 'longYear'
  | 'year'
  | 'PM'
  | 'pm'
  | 'TZ'
  | 'ISO8601TZ'
  | 'ISO8601SecondsTZ'
  | 'ISO8601ShortTZ'
  | 'ISO8601ColonTZ'
  | 'ISO8601ColonSecondsTZ'
  | 'numTZ'
  | 'numSecondsTz'
  | 'numShortTZ'
  | 'numColonTZ'
  | 'numColonSecondsTZ'
  | { fraction: '0' | '9'; digits: number; separator: string };

const ZERO_CHUNKS: Chunk[] = ['zeroMonth', 'zeroDay', 'zeroHour12', 'zeroMinute', 'zeroSecond', 'year'];
const startsWithLowerCase = (text: string): boolean => /^[a-z]/.test(text);

/** Go's nextStdChunk: the text before the first element of a layout, the element, and the text after it. */
// code-gauge-allow functionCognitiveComplexity 60 -- Transcribes Go's nextStdChunk, one case per layout element.
function nextChunk(layout: string): [string, Chunk | undefined, string] {
  for (let i = 0; i < layout.length; i++) {
    const rest = layout.slice(i);
    const before = layout.slice(0, i);
    switch (layout[i]) {
      case 'J': {
        if (rest.startsWith('January')) return [before, 'longMonth', layout.slice(i + 7)];
        if (rest.startsWith('Jan') && !startsWithLowerCase(layout.slice(i + 3)))
          return [before, 'month', layout.slice(i + 3)];
        break;
      }
      case 'M': {
        if (rest.startsWith('Monday')) return [before, 'longWeekDay', layout.slice(i + 6)];
        if (rest.startsWith('Mon') && !startsWithLowerCase(layout.slice(i + 3)))
          return [before, 'weekDay', layout.slice(i + 3)];
        if (rest.startsWith('MST')) return [before, 'TZ', layout.slice(i + 3)];
        break;
      }
      case '0': {
        const next = layout[i + 1];
        if (next >= '1' && next <= '6') return [before, ZERO_CHUNKS[Number(next) - 1], layout.slice(i + 2)];
        if (rest.startsWith('002')) return [before, 'zeroYearDay', layout.slice(i + 3)];
        break;
      }
      case '1': {
        if (layout[i + 1] === '5') return [before, 'hour', layout.slice(i + 2)];
        return [before, 'numMonth', layout.slice(i + 1)];
      }
      case '2': {
        if (rest.startsWith('2006')) return [before, 'longYear', layout.slice(i + 4)];
        return [before, 'day', layout.slice(i + 1)];
      }
      case '_': {
        if (layout[i + 1] === '2') {
          if (layout.slice(i + 1, i + 5) === '2006') return [layout.slice(0, i + 1), 'longYear', layout.slice(i + 5)];
          return [before, 'underDay', layout.slice(i + 2)];
        }
        if (rest.startsWith('__2')) return [before, 'underYearDay', layout.slice(i + 3)];
        break;
      }
      case '3':
      case '4':
      case '5': {
        const chunk = (['hour12', 'minute', 'second'] as const)[Number(layout[i]) - 3];
        return [before, chunk, layout.slice(i + 1)];
      }
      case 'P': {
        if (layout[i + 1] === 'M') return [before, 'PM', layout.slice(i + 2)];
        break;
      }
      case 'p': {
        if (layout[i + 1] === 'm') return [before, 'pm', layout.slice(i + 2)];
        break;
      }
      case '-': {
        for (const [text, chunk] of [
          ['-070000', 'numSecondsTz'],
          ['-07:00:00', 'numColonSecondsTZ'],
          ['-0700', 'numTZ'],
          ['-07:00', 'numColonTZ'],
          ['-07', 'numShortTZ'],
        ] as const) {
          if (rest.startsWith(text)) return [before, chunk, layout.slice(i + text.length)];
        }
        break;
      }
      case 'Z': {
        for (const [text, chunk] of [
          ['Z070000', 'ISO8601SecondsTZ'],
          ['Z07:00:00', 'ISO8601ColonSecondsTZ'],
          ['Z0700', 'ISO8601TZ'],
          ['Z07:00', 'ISO8601ColonTZ'],
          ['Z07', 'ISO8601ShortTZ'],
        ] as const) {
          if (rest.startsWith(text)) return [before, chunk, layout.slice(i + text.length)];
        }
        break;
      }
      case '.':
      case ',': {
        const digit = layout[i + 1];
        if (digit === '0' || digit === '9') {
          let j = i + 1;
          while (j < layout.length && layout[j] === digit) j++;
          if (!/\d/.test(layout[j] ?? '')) {
            return [before, { fraction: digit, digits: j - (i + 1), separator: layout[i] }, layout.slice(j)];
          }
        }
        break;
      }
      default: {
        break;
      }
    }
  }
  return [layout, undefined, ''];
}

function zoneText(offset: number, chunk: Chunk): string {
  if (typeof chunk === 'string' && chunk.startsWith('ISO8601') && offset === 0) return 'Z';
  const minutes = Math.trunc(offset / 60);
  const absolute = Math.abs(minutes);
  let text = minutes < 0 ? '-' : '+';
  text += pad(Math.floor(absolute / 60), 2);
  if (
    chunk === 'ISO8601ColonTZ' ||
    chunk === 'numColonTZ' ||
    chunk === 'ISO8601ColonSecondsTZ' ||
    chunk === 'numColonSecondsTZ'
  )
    text += ':';
  if (chunk !== 'numShortTZ' && chunk !== 'ISO8601ShortTZ') text += pad(absolute % 60, 2);
  if (chunk === 'ISO8601ColonSecondsTZ' || chunk === 'numColonSecondsTZ') text += `:${pad(Math.abs(offset) % 60, 2)}`;
  if (chunk === 'ISO8601SecondsTZ' || chunk === 'numSecondsTz') text += pad(Math.abs(offset) % 60, 2);
  return text;
}

// code-gauge-allow functionCognitiveComplexity 40 -- One case per layout element, as Go's appendFormat.
function formatChunk(chunk: Chunk, fields: Fields): string {
  if (typeof chunk === 'object') {
    const digits = pad(fields.nanosecond, 9).slice(0, chunk.digits);
    if (chunk.fraction === '0') return chunk.separator + digits;
    const trimmed = pad(fields.nanosecond, 9).slice(0, chunk.digits).replace(/0+$/, '');
    return trimmed === '' ? '' : chunk.separator + trimmed;
  }
  const hour12 = fields.hour % 12 === 0 ? 12 : fields.hour % 12;
  switch (chunk) {
    case 'year': {
      return pad(((fields.year % 100) + 100) % 100, 2);
    }
    case 'longYear': {
      return pad(fields.year, 4);
    }
    case 'month': {
      return MONTH_NAMES[fields.month - 1].slice(0, 3);
    }
    case 'longMonth': {
      return MONTH_NAMES[fields.month - 1];
    }
    case 'numMonth': {
      return String(fields.month);
    }
    case 'zeroMonth': {
      return pad(fields.month, 2);
    }
    case 'weekDay': {
      return WEEKDAY_NAMES[fields.weekday].slice(0, 3);
    }
    case 'longWeekDay': {
      return WEEKDAY_NAMES[fields.weekday];
    }
    case 'day': {
      return String(fields.day);
    }
    case 'underDay': {
      return pad(fields.day, 2, ' ');
    }
    case 'zeroDay': {
      return pad(fields.day, 2);
    }
    case 'underYearDay': {
      return pad(fields.yearDay, 3, ' ');
    }
    case 'zeroYearDay': {
      return pad(fields.yearDay, 3);
    }
    case 'hour': {
      return pad(fields.hour, 2);
    }
    case 'hour12': {
      return String(hour12);
    }
    case 'zeroHour12': {
      return pad(hour12, 2);
    }
    case 'minute': {
      return String(fields.minute);
    }
    case 'zeroMinute': {
      return pad(fields.minute, 2);
    }
    case 'second': {
      return String(fields.second);
    }
    case 'zeroSecond': {
      return pad(fields.second, 2);
    }
    case 'PM': {
      return fields.hour >= 12 ? 'PM' : 'AM';
    }
    case 'pm': {
      return fields.hour >= 12 ? 'pm' : 'am';
    }
    case 'TZ': {
      if (fields.zone !== '') return fields.zone;
      const minutes = Math.trunc(fields.offset / 60);
      return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60), 2)}${pad(Math.abs(minutes) % 60, 2)}`;
    }
    default: {
      return zoneText(fields.offset, chunk);
    }
  }
}

/** Time.Format: replaces each element of the layout by the time's field. */
function format(instant: Instant, layout: string): string {
  const fields = fieldsOf(instant);
  let text = '';
  let rest = layout;
  while (rest !== '') {
    const [before, chunk, after] = nextChunk(rest);
    text += before;
    if (chunk === undefined) break;
    text += formatChunk(chunk, fields);
    rest = after;
  }
  return text;
}

function timeString(instant: Instant): string {
  const text = format(instant, '2006-01-02 15:04:05.999999999 -0700 MST');
  if (instant.monotonic === undefined) return text;
  const monotonic = instant.monotonic;
  const sign = monotonic < 0n ? '-' : '+';
  const absolute = monotonic < 0n ? -monotonic : monotonic;
  return `${text} m=${sign}${absolute / SECOND}.${pad(Number(absolute % SECOND), 9)}`;
}

// Time methods ---------------------------------------------------------------------------------------------------------

const WEEKDAY = namedType('time', 'Weekday', BASIC.int);
const MONTH = namedType('time', 'Month', BASIC.int);
for (const [type, names, offset] of [
  [WEEKDAY, WEEKDAY_NAMES, 0],
  [MONTH, MONTH_NAMES, 1],
] as const) {
  addMethod(type, 'String', fn([], [STRING]), (receiver) => {
    const index = Number(receiver as bigint) - offset;
    return names[index] ?? `%!${type.name}(${String(receiver)})`;
  });
}

const timeMethods: [string, Type[], Type[], (instant: Instant, args: Value[]) => Value | Value[]][] = [
  ['String', [], [STRING], (instant) => timeString(instant)],
  ['Format', [STRING], [STRING], (instant, [layout]) => format(instant, layout as string)],
  ['Year', [], [INT], (instant) => BigInt(fieldsOf(instant).year)],
  ['Month', [], [MONTH], (instant) => BigInt(fieldsOf(instant).month)],
  ['Day', [], [INT], (instant) => BigInt(fieldsOf(instant).day)],
  ['Hour', [], [INT], (instant) => BigInt(fieldsOf(instant).hour)],
  ['Minute', [], [INT], (instant) => BigInt(fieldsOf(instant).minute)],
  ['Second', [], [INT], (instant) => BigInt(fieldsOf(instant).second)],
  ['Nanosecond', [], [INT], (instant) => BigInt(fieldsOf(instant).nanosecond)],
  ['Weekday', [], [WEEKDAY], (instant) => BigInt(fieldsOf(instant).weekday)],
  ['YearDay', [], [INT], (instant) => BigInt(fieldsOf(instant).yearDay)],
  [
    'Date',
    [],
    [INT, MONTH, INT],
    (instant) => {
      const fields = fieldsOf(instant);
      return [BigInt(fields.year), BigInt(fields.month), BigInt(fields.day)];
    },
  ],
  [
    'Clock',
    [],
    [INT, INT, INT],
    (instant) => {
      const fields = fieldsOf(instant);
      return [BigInt(fields.hour), BigInt(fields.minute), BigInt(fields.second)];
    },
  ],
  ['Unix', [], [BASIC.int64], (instant) => floorDivide(instant.wall, SECOND)],
  ['UnixMilli', [], [BASIC.int64], (instant) => floorDivide(instant.wall, MILLISECOND)],
  ['UnixMicro', [], [BASIC.int64], (instant) => floorDivide(instant.wall, MICROSECOND)],
  ['UnixNano', [], [BASIC.int64], (instant) => instant.wall],
  ['IsZero', [], [BOOL], (instant) => instant.wall === ZERO_WALL],
  [
    'Add',
    [DURATION],
    [TIME],
    (instant, [duration]) =>
      timeValue({
        wall: instant.wall + durationOf(duration),
        location: instant.location,
        monotonic: instant.monotonic === undefined ? undefined : instant.monotonic + durationOf(duration),
      }),
  ],
  ['Sub', [TIME], [DURATION], (instant, [other]) => subtract(instant, instantOf(other))],
  ['Before', [TIME], [BOOL], (instant, [other]) => compareInstants(instant, instantOf(other)) < 0],
  ['After', [TIME], [BOOL], (instant, [other]) => compareInstants(instant, instantOf(other)) > 0],
  ['Equal', [TIME], [BOOL], (instant, [other]) => compareInstants(instant, instantOf(other)) === 0],
  ['Compare', [TIME], [INT], (instant, [other]) => BigInt(compareInstants(instant, instantOf(other)))],
  ['UTC', [], [TIME], (instant) => timeValue({ wall: instant.wall, location: UTC_LOCATION })],
  ['Local', [], [TIME], (instant) => timeValue({ wall: instant.wall, location: LOCAL_LOCATION })],
  [
    'In',
    [pointerTo(LOCATION)],
    [TIME],
    (instant, [location]) => timeValue({ wall: instant.wall, location: locationOf(location) }),
  ],
  [
    'Location',
    [],
    [pointerTo(LOCATION)],
    (instant) =>
      instant.location === UTC_LOCATION
        ? UTC_POINTER
        : instant.location === LOCAL_LOCATION
          ? LOCAL_POINTER
          : locationPointer(instant.location),
  ],
  [
    'AddDate',
    [INT, INT, INT],
    [TIME],
    (instant, [years, months, days]) => {
      const fields = fieldsOf(instant);
      return timeValue(
        dateInstant(
          [
            fields.year + Number(years as bigint),
            fields.month + Number(months as bigint),
            fields.day + Number(days as bigint),
            fields.hour,
            fields.minute,
            fields.second,
            fields.nanosecond,
          ],
          instant.location
        )
      );
    },
  ],
  [
    'Truncate',
    [DURATION],
    [TIME],
    (instant, [unit]) => {
      const m = durationOf(unit);
      if (m <= 0n) return timeValue({ wall: instant.wall, location: instant.location });
      // Go rounds relative to the zero time.
      const since = instant.wall - ZERO_WALL;
      return timeValue({ wall: instant.wall - (((since % m) + m) % m), location: instant.location });
    },
  ],
  [
    'Round',
    [DURATION],
    [TIME],
    (instant, [unit]) => {
      const m = durationOf(unit);
      if (m <= 0n) return timeValue({ wall: instant.wall, location: instant.location });
      const since = instant.wall - ZERO_WALL;
      const r = ((since % m) + m) % m;
      const wall = r + r < m ? instant.wall - r : instant.wall + m - r;
      return timeValue({ wall, location: instant.location });
    },
  ],
];
for (const [name, params, results, impl] of timeMethods) {
  addMethod(TIME, name, fn(params, results), (receiver, args) => impl(instantOf(receiver), args));
}

// Timers --------------------------------------------------------------------------------------------------------------

const RECEIVE_TIME: Type = { kind: 'chan', dir: 'receive', element: TIME };
/** `time.Timer` and `time.Ticker`, whose field C delivers the times they fire at. */
const TIMER = namedType('time', 'Timer', {
  kind: 'struct',
  fields: [{ name: 'C', type: RECEIVE_TIME, embedded: false }],
});
const TICKER = namedType('time', 'Ticker', {
  kind: 'struct',
  fields: [{ name: 'C', type: RECEIVE_TIME, embedded: false }],
});

interface TimerState {
  pending?: ReturnType<ReturnType<typeof scheduler>['addTimer']>;
  channel?: Channel;
  period?: bigint;
  task?: Value;
}

/** Sends the time to a timer's channel unless a value waits there already, as a ticker drops ticks no one takes. */
function deliver(channel: Channel): void {
  if (channel.buffer.length > 0) return;
  const receiver = channel.receivers.shift() as
    | { goroutine: Goroutine; select?: { done: boolean }; index: number }
    | undefined;
  const value = timeValue(now());
  if (receiver && !(receiver.select && receiver.select.done)) {
    if (receiver.select) receiver.select.done = true;
    scheduler().ready(receiver.goroutine, { index: receiver.index, value, ok: true });
    return;
  }
  if (receiver) {
    deliver(channel);
    return;
  }
  channel.buffer.push(value);
}

function arm(state: TimerState, delay: bigint): void {
  const running = scheduler();
  state.pending = running.addTimer(
    Number(delay),
    () => {
      state.pending = undefined;
      if (state.task !== undefined) {
        const task = state.task as GoFunc;
        running.spawn(function* () {
          return task.resume ? yield* task.resume([]) : task.call([]);
        });
        return;
      }
      deliver(state.channel as Channel);
      if (state.period !== undefined) arm(state, state.period);
    },
    state.channel
  );
}

function newTimer(delay: bigint, period?: bigint, task?: Value): Pointer {
  const channel = task === undefined ? makeChannel(1, () => timeValue(ZERO_INSTANT)) : undefined;
  const state: TimerState = { channel, period, task };
  arm(state, delay);
  return new Pointer({ v: new GoStruct([channel], { timer: state }) } as never, 'v');
}

const timerStateOf = (receiver: Value): TimerState =>
  ((receiver as Pointer).load() as GoStruct).native?.timer as TimerState;

/** Stops a timer, discarding a time it sent that no one took, as Go 1.23 does; tells whether it was pending. */
function stopTimer(state: TimerState): boolean {
  const wasPending = state.pending !== undefined && scheduler().removeTimer(state.pending);
  state.pending = undefined;
  if (state.channel) state.channel.buffer.length = 0;
  return wasPending;
}

for (const type of [TIMER, TICKER]) {
  addMethod(
    type,
    'Stop',
    fn([], type === TIMER ? [BOOL] : []),
    (receiver) => {
      const stopped = stopTimer(timerStateOf(receiver));
      return type === TIMER ? stopped : undefined;
    },
    true
  );
}
addMethod(
  TIMER,
  'Reset',
  fn([DURATION], [BOOL]),
  (receiver, [delay]) => {
    const state = timerStateOf(receiver);
    const wasPending = stopTimer(state);
    arm(state, durationOf(delay));
    return wasPending;
  },
  true
);
addMethod(
  TICKER,
  'Reset',
  fn([DURATION], []),
  (receiver, [period]) => {
    const state = timerStateOf(receiver);
    stopTimer(state);
    state.period = positivePeriod(durationOf(period), 'Ticker.Reset');
    arm(state, state.period);
    return;
  },
  true
);

function positivePeriod(period: bigint, name: string): bigint {
  if (period <= 0n) throw new GoPanic(newError(`non-positive interval for ${name}`));
  return period;
}

// Package -------------------------------------------------------------------------------------------------------------

function constant(name: string, type: NamedType | Type, value: bigint | string): Entity {
  return {
    kind: 'const',
    name,
    type,
    value: typeof value === 'string' ? { kind: 'string', value } : { kind: 'int', value },
    span: { row: 0, column: 0 },
    used: true,
  };
}

function libraryVariable(name: string, type: Type, value: Value): Entity {
  return {
    kind: 'var',
    name,
    type,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => value,
  };
}

const LAYOUTS: Record<string, string> = {
  Layout: "01/02 03:04:05PM '06 -0700",
  ANSIC: 'Mon Jan _2 15:04:05 2006',
  UnixDate: 'Mon Jan _2 15:04:05 MST 2006',
  RubyDate: 'Mon Jan 02 15:04:05 -0700 2006',
  RFC822: '02 Jan 06 15:04 MST',
  RFC822Z: '02 Jan 06 15:04 -0700',
  RFC850: 'Monday, 02-Jan-06 15:04:05 MST',
  RFC1123: 'Mon, 02 Jan 2006 15:04:05 MST',
  RFC1123Z: 'Mon, 02 Jan 2006 15:04:05 -0700',
  RFC3339: '2006-01-02T15:04:05Z07:00',
  RFC3339Nano: '2006-01-02T15:04:05.999999999Z07:00',
  Kitchen: '3:04PM',
  Stamp: 'Jan _2 15:04:05',
  StampMilli: 'Jan _2 15:04:05.000',
  StampMicro: 'Jan _2 15:04:05.000000',
  StampNano: 'Jan _2 15:04:05.000000000',
  DateTime: '2006-01-02 15:04:05',
  DateOnly: '2006-01-02',
  TimeOnly: '15:04:05',
};

const members: Record<string, Entity> = {
  Time: typeEntity(TIME),
  Duration: typeEntity(DURATION),
  Weekday: typeEntity(WEEKDAY),
  Month: typeEntity(MONTH),
  Location: typeEntity(LOCATION),
  Timer: typeEntity(TIMER),
  Ticker: typeEntity(TICKER),
  ...Object.fromEntries(WEEKDAY_NAMES.map((name, index) => [name, constant(name, WEEKDAY, BigInt(index))])),
  ...Object.fromEntries(MONTH_NAMES.map((name, index) => [name, constant(name, MONTH, BigInt(index + 1))])),
  Nanosecond: constant('Nanosecond', DURATION, NANOSECOND),
  Microsecond: constant('Microsecond', DURATION, MICROSECOND),
  Millisecond: constant('Millisecond', DURATION, MILLISECOND),
  Second: constant('Second', DURATION, SECOND),
  Minute: constant('Minute', DURATION, MINUTE),
  Hour: constant('Hour', DURATION, HOUR),
  ...Object.fromEntries(
    Object.entries(LAYOUTS).map(([name, layout]) => [name, constant(name, BASIC.untypedString, layout)])
  ),
  UTC: libraryVariable('UTC', pointerTo(LOCATION), UTC_POINTER),
  Local: libraryVariable('Local', pointerTo(LOCATION), LOCAL_POINTER),
  Now: nativeFunction('Now', fn([], [TIME]), () => timeValue(now())),
  Since: nativeFunction('Since', fn([TIME], [DURATION]), ([start]) => subtract(now(), instantOf(start))),
  Until: nativeFunction('Until', fn([TIME], [DURATION]), ([end]) => subtract(instantOf(end), now())),
  Unix: nativeFunction('Unix', fn([BASIC.int64, BASIC.int64], [TIME]), ([seconds, nanos]) =>
    timeValue({ wall: (seconds as bigint) * SECOND + (nanos as bigint), location: LOCAL_LOCATION })
  ),
  UnixMilli: nativeFunction('UnixMilli', fn([BASIC.int64], [TIME]), ([millis]) =>
    timeValue({ wall: (millis as bigint) * MILLISECOND, location: LOCAL_LOCATION })
  ),
  Date: nativeFunction(
    'Date',
    fn([INT, MONTH, INT, INT, INT, INT, INT, pointerTo(LOCATION)], [TIME]),
    ([year, month, day, hour, minute, second, nanosecond, location]) => {
      if (location === undefined) throw new GoPanic(newError('time: missing Location in call to Date'));
      return timeValue(
        dateInstant(
          [year, month, day, hour, minute, second, nanosecond].map((field) => Number(field as bigint)),
          locationOf(location)
        )
      );
    }
  ),
  FixedZone: nativeFunction('FixedZone', fn([STRING, INT], [pointerTo(LOCATION)]), ([name, offset]) =>
    locationPointer({ name: name as string, offset: Number(offset as bigint) })
  ),
  ParseDuration: nativeFunction('ParseDuration', fn([STRING], [DURATION, ERROR_TYPE]), ([text]) =>
    parseDuration(text as string)
  ),
  Sleep: blockingFunction('Sleep', fn([DURATION], []), function* ([duration]) {
    yield* scheduler().sleep(Number(durationOf(duration)));
    return;
  }),
  After: nativeFunction(
    'After',
    fn([DURATION], [RECEIVE_TIME]),
    ([delay]) => (newTimer(durationOf(delay)).load() as GoStruct).fields[0]
  ),
  NewTimer: nativeFunction('NewTimer', fn([DURATION], [pointerTo(TIMER)]), ([delay]) => newTimer(durationOf(delay))),
  AfterFunc: nativeFunction('AfterFunc', fn([DURATION, fn([], [])], [pointerTo(TIMER)]), ([delay, task]) =>
    newTimer(durationOf(delay), undefined, task)
  ),
  NewTicker: nativeFunction('NewTicker', fn([DURATION], [pointerTo(TICKER)]), ([period]) =>
    newTimer(positivePeriod(durationOf(period), 'NewTicker'), durationOf(period))
  ),
  Tick: nativeFunction('Tick', fn([DURATION], [RECEIVE_TIME]), ([period]) =>
    durationOf(period) <= 0n
      ? undefined
      : (newTimer(durationOf(period), durationOf(period)).load() as GoStruct).fields[0]
  ),
};

export const TIME_PACKAGE = definePackage('time', members, [
  'UnixMicro',
  'Parse',
  'ParseInLocation',
  'LoadLocation',
  'ParseError',
]);
