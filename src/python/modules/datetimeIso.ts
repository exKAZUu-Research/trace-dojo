// The parsers of `fromisoformat`, following `_datetimemodule.c`: each returns undefined for a string CPython reports as
// an invalid isoformat string, and leaves the range checks to the constructors.
import { fromIsoCalendar } from './calendarMath';

/** A cursor over the UTF-8 bytes CPython parses, as characters: non-ASCII ones never match a digit or separator. */
type Chars = readonly string[];

function utf8Units(text: string): Chars {
  const units: string[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    const length = code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
    units.push(char, ...Array.from<string>({ length: length - 1 }).fill('￿'));
  }
  return units;
}

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';

/** Reads `count` digits at `position`, or undefined when one is missing. */
function digits(chars: Chars, position: number, count: number): number | undefined {
  let value = 0;
  for (let index = 0; index < count; index++) {
    const char = chars[position + index];
    if (!isDigit(char)) return undefined;
    value = value * 10 + Number(char);
  }
  return value;
}

export function parseIsoDate(text: string): [number, number, number] | undefined {
  const chars = utf8Units(text);
  if (chars.length !== 7 && chars.length !== 8 && chars.length !== 10) return undefined;
  return parseDate(chars, chars.length);
}

// code-gauge-allow functionCognitiveComplexity 20 -- Follows parse_isoformat_date of _datetimemodule.c.
// code-gauge-allow functionNcss 32 -- Follows parse_isoformat_date of _datetimemodule.c.
function parseDate(chars: Chars, length: number): [number, number, number] | undefined {
  const year = digits(chars, 0, 4);
  if (year === undefined) return undefined;
  let position = 4;
  const separated = chars[position] === '-';
  if (separated) position++;
  if (chars[position] === 'W') {
    position++;
    const week = digits(chars, position, 2);
    if (week === undefined) return undefined;
    position += 2;
    let day = 1;
    if (position < length) {
      if (separated && chars[position++] !== '-') return undefined;
      const parsed = digits(chars, position, 1);
      if (parsed === undefined) return undefined;
      day = parsed;
    }
    const result = fromIsoCalendar(year, week, day);
    return typeof result === 'string' ? undefined : result;
  }
  const month = digits(chars, position, 2);
  if (month === undefined) return undefined;
  position += 2;
  if (separated && chars[position++] !== '-') return undefined;
  const day = digits(chars, position, 2);
  return day === undefined ? undefined : [year, month, day];
}

export interface IsoTime {
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
  /** The UTC offset in seconds and microseconds, when the string has one. */
  offset?: [number, number];
}

interface Clock {
  values: [number, number, number, number];
  /** Whether text other than the end of the string follows. */
  more: boolean;
}

// code-gauge-allow functionNcss 35 -- Follows parse_hh_mm_ss_ff of _datetimemodule.c.
// code-gauge-allow functionCognitiveComplexity 23 -- Follows parse_hh_mm_ss_ff of _datetimemodule.c.
function parseClock(chars: Chars, start: number, end: number): Clock | undefined {
  const values: Clock['values'] = [0, 0, 0, 0];
  let position = start;
  let separated = true;
  for (let index = 0; index < 3; index++) {
    const value = digits(chars, position, 2);
    if (value === undefined) return undefined;
    values[index] = value;
    position += 2;
    const char = chars[position++];
    if (index === 0) separated = char === ':';
    if (position >= end) return { values, more: char !== undefined };
    if (separated && char === ':') {
      if (index === 2) return undefined;
      continue;
    }
    if (char === '.' || char === ',') {
      if (index < 2) return undefined;
      break;
    }
    if (separated) return undefined;
    // Without separators the next component follows at once; after the seconds it is their fraction, as in CPython.
    position--;
  }
  const count = Math.min(end - position, 6);
  const microsecond = digits(chars, position, count);
  if (microsecond === undefined) return undefined;
  values[3] = microsecond * 10 ** (6 - count);
  position += count;
  while (isDigit(chars[position])) position++;
  return { values, more: chars[position] !== undefined };
}

/** Parses the time part of an isoformat, including the time zone. */
export function parseIsoTime(chars: Chars, start: number): IsoTime | undefined {
  const end = chars.length;
  let zone = start;
  while (zone < end && !'Z+-'.includes(chars[zone])) zone++;
  if (zone === start && start === end) return undefined;
  const clock = parseClock(chars, start, zone);
  if (!clock) return undefined;
  const [hour, minute, second, microsecond] = clock.values;
  const time: IsoTime = { hour, minute, second, microsecond };
  if (zone === end) return clock.more ? undefined : time;
  if (chars[zone] === 'Z') return zone + 1 === end ? { ...time, offset: [0, 0] } : undefined;
  const sign = chars[zone] === '-' ? -1 : 1;
  const offset = parseClock(chars, zone + 1, end);
  if (!offset || offset.more) return undefined;
  const [zoneHour, zoneMinute, zoneSecond, zoneMicrosecond] = offset.values;
  return { ...time, offset: [sign * (zoneHour * 3600 + zoneMinute * 60 + zoneSecond), sign * zoneMicrosecond] };
}

export function parseIsoTimeOnly(text: string): IsoTime | undefined {
  const chars = utf8Units(text);
  return parseIsoTime(chars, chars[0] === 'T' ? 1 : 0);
}

/** Where the time starts in a datetime's isoformat, as `_find_isoformat_datetime_separator` decides. */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows _find_isoformat_datetime_separator of CPython.
function separatorPosition(chars: Chars): number {
  const length = chars.length;
  if (length === 7) return 7;
  if (chars[4] === '-') {
    if (chars[5] !== 'W') return 10;
    if (length > 8 && chars[8] === '-') {
      if (length === 9) return -1;
      if (length > 10 && isDigit(chars[10])) return 8;
      return 10;
    }
    return 8;
  }
  if (chars[4] !== 'W') return 8;
  let index = 7;
  while (index < length && isDigit(chars[index])) index++;
  if (index < 9) return index;
  return index % 2 === 0 ? 7 : 8;
}

export function parseIsoDateTime(text: string): { date: [number, number, number]; time: IsoTime } | undefined {
  const chars = utf8Units(text);
  if (chars.length < 7) return undefined;
  const separator = separatorPosition(chars);
  if (separator < 0) return undefined;
  const date = parseDate(chars, separator);
  if (!date) return undefined;
  if (chars.length <= separator) return { date, time: { hour: 0, minute: 0, second: 0, microsecond: 0 } };
  const time = parseIsoTime(chars, separator + 1);
  return time && { date, time };
}
