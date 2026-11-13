// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
/*
 * Formatting and parsing of Go's time package (Go 1.27.3: format.go and format_rfc3339.go) transcribed to TypeScript.
 * Original code: Copyright The Go Authors, BSD license (see the Go distribution's LICENSE file).
 */
import { decodeRune } from '../literals';
import {
  absDate,
  absSec,
  addSec,
  clockOf,
  daysBefore,
  daysIn,
  daysOf,
  fixedZone,
  HAS_MONOTONIC,
  HOUR,
  i64,
  isLeap,
  locabs,
  LOCAL_LOCATION,
  type Location,
  LONG_DAY_NAMES,
  LONG_MONTH_NAMES,
  lookup,
  lookupName,
  makeDate,
  MINUTE,
  nsec,
  SECOND,
  setLoc,
  type Time,
  u64,
  UTC_LOCATION,
  weekdayOf,
  yearYday,
} from './goTime';

const SHORT_DAY_NAMES = LONG_DAY_NAMES.map((name) => name.slice(0, 3));
const SHORT_MONTH_NAMES = LONG_MONTH_NAMES.map((name) => name.slice(0, 3));

export const LAYOUTS = {
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

// Formatting ------------------------------------------------------------------------------------------------------

const STD_NEED_DATE = 1 << 8;
const STD_NEED_YDAY = 1 << 9;
const STD_NEED_CLOCK = 1 << 10;
const STD_ARG_SHIFT = 16;
const STD_SEPARATOR_SHIFT = 28;
const STD_MASK = (1 << STD_ARG_SHIFT) - 1;

const STD_LONG_MONTH = 1 + STD_NEED_DATE;
const STD_MONTH = 2 + STD_NEED_DATE;
const STD_NUM_MONTH = 3 + STD_NEED_DATE;
const STD_ZERO_MONTH = 4 + STD_NEED_DATE;
const STD_LONG_WEEK_DAY = 5 + STD_NEED_DATE;
const STD_WEEK_DAY = 6 + STD_NEED_DATE;
const STD_DAY = 7 + STD_NEED_DATE;
const STD_UNDER_DAY = 8 + STD_NEED_DATE;
const STD_ZERO_DAY = 9 + STD_NEED_DATE;
const STD_UNDER_YEAR_DAY = 10 + STD_NEED_YDAY;
const STD_ZERO_YEAR_DAY = 11 + STD_NEED_YDAY;
const STD_HOUR = 12 + STD_NEED_CLOCK;
const STD_HOUR12 = 13 + STD_NEED_CLOCK;
const STD_ZERO_HOUR12 = 14 + STD_NEED_CLOCK;
const STD_MINUTE = 15 + STD_NEED_CLOCK;
const STD_ZERO_MINUTE = 16 + STD_NEED_CLOCK;
const STD_SECOND = 17 + STD_NEED_CLOCK;
const STD_ZERO_SECOND = 18 + STD_NEED_CLOCK;
const STD_LONG_YEAR = 19 + STD_NEED_DATE;
const STD_YEAR = 20 + STD_NEED_DATE;
const STD_PM = 21 + STD_NEED_CLOCK;
const STD_LOWER_PM = 22 + STD_NEED_CLOCK;
const STD_TZ = 23;
const STD_ISO8601_TZ = 24;
const STD_ISO8601_SECONDS_TZ = 25;
const STD_ISO8601_SHORT_TZ = 26;
const STD_ISO8601_COLON_TZ = 27;
const STD_ISO8601_COLON_SECONDS_TZ = 28;
const STD_NUM_TZ = 29;
const STD_NUM_SECONDS_TZ = 30;
const STD_NUM_SHORT_TZ = 31;
const STD_NUM_COLON_TZ = 32;
const STD_NUM_COLON_SECONDS_TZ = 33;
const STD_FRAC_SECOND0 = 34;
const STD_FRAC_SECOND9 = 35;

const STD_0X = [STD_ZERO_MONTH, STD_ZERO_DAY, STD_ZERO_HOUR12, STD_ZERO_MINUTE, STD_ZERO_SECOND, STD_YEAR];

const ISO_ZONES = new Set([
  STD_ISO8601_TZ,
  STD_ISO8601_COLON_TZ,
  STD_ISO8601_SECONDS_TZ,
  STD_ISO8601_SHORT_TZ,
  STD_ISO8601_COLON_SECONDS_TZ,
]);
const NUM_ZONES = new Set([
  STD_NUM_TZ,
  STD_NUM_COLON_TZ,
  STD_NUM_SECONDS_TZ,
  STD_NUM_SHORT_TZ,
  STD_NUM_COLON_SECONDS_TZ,
]);

const startsWithLowerCase = (text: string): boolean => text.length > 0 && text[0] >= 'a' && text[0] <= 'z';
const isDigit = (text: string, index: number): boolean =>
  index < text.length && text[index] >= '0' && text[index] <= '9';

const ZONE_CHUNKS: [string, string, number][] = [
  ['-', '-070000', STD_NUM_SECONDS_TZ],
  ['-', '-07:00:00', STD_NUM_COLON_SECONDS_TZ],
  ['-', '-0700', STD_NUM_TZ],
  ['-', '-07:00', STD_NUM_COLON_TZ],
  ['-', '-07', STD_NUM_SHORT_TZ],
  ['Z', 'Z070000', STD_ISO8601_SECONDS_TZ],
  ['Z', 'Z07:00:00', STD_ISO8601_COLON_SECONDS_TZ],
  ['Z', 'Z0700', STD_ISO8601_TZ],
  ['Z', 'Z07:00', STD_ISO8601_COLON_TZ],
  ['Z', 'Z07', STD_ISO8601_SHORT_TZ],
];

// code-gauge-allow functionCognitiveComplexity 60 -- A transcription of format.go's nextStdChunk switch.
function nextStdChunk(layout: string): [string, number, string] {
  for (let i = 0; i < layout.length; i++) {
    const c = layout[i];
    const at = (text: string): boolean => layout.startsWith(text, i);
    switch (c) {
      case 'J': {
        if (at('Jan')) {
          if (at('January')) return [layout.slice(0, i), STD_LONG_MONTH, layout.slice(i + 7)];
          if (!startsWithLowerCase(layout.slice(i + 3))) return [layout.slice(0, i), STD_MONTH, layout.slice(i + 3)];
        }
        break;
      }
      case 'M': {
        if (at('Mon')) {
          if (at('Monday')) return [layout.slice(0, i), STD_LONG_WEEK_DAY, layout.slice(i + 6)];
          if (!startsWithLowerCase(layout.slice(i + 3))) {
            return [layout.slice(0, i), STD_WEEK_DAY, layout.slice(i + 3)];
          }
        }
        if (at('MST')) return [layout.slice(0, i), STD_TZ, layout.slice(i + 3)];
        break;
      }
      case '0': {
        if (i + 1 < layout.length && layout[i + 1] >= '1' && layout[i + 1] <= '6') {
          return [layout.slice(0, i), STD_0X[layout.charCodeAt(i + 1) - 49], layout.slice(i + 2)];
        }
        if (at('002')) return [layout.slice(0, i), STD_ZERO_YEAR_DAY, layout.slice(i + 3)];
        break;
      }
      case '1': {
        if (at('15')) return [layout.slice(0, i), STD_HOUR, layout.slice(i + 2)];
        return [layout.slice(0, i), STD_NUM_MONTH, layout.slice(i + 1)];
      }
      case '2': {
        if (at('2006')) return [layout.slice(0, i), STD_LONG_YEAR, layout.slice(i + 4)];
        return [layout.slice(0, i), STD_DAY, layout.slice(i + 1)];
      }
      case '_': {
        if (at('_2')) {
          if (at('_2006')) return [layout.slice(0, i + 1), STD_LONG_YEAR, layout.slice(i + 5)];
          return [layout.slice(0, i), STD_UNDER_DAY, layout.slice(i + 2)];
        }
        if (at('__2')) return [layout.slice(0, i), STD_UNDER_YEAR_DAY, layout.slice(i + 3)];
        break;
      }
      case '3': {
        return [layout.slice(0, i), STD_HOUR12, layout.slice(i + 1)];
      }
      case '4': {
        return [layout.slice(0, i), STD_MINUTE, layout.slice(i + 1)];
      }
      case '5': {
        return [layout.slice(0, i), STD_SECOND, layout.slice(i + 1)];
      }
      case 'P': {
        if (at('PM')) return [layout.slice(0, i), STD_PM, layout.slice(i + 2)];
        break;
      }
      case 'p': {
        if (at('pm')) return [layout.slice(0, i), STD_LOWER_PM, layout.slice(i + 2)];
        break;
      }
      case '-':
      case 'Z': {
        for (const [first, text, std] of ZONE_CHUNKS) {
          if (first === c && at(text)) return [layout.slice(0, i), std, layout.slice(i + text.length)];
        }
        break;
      }
      case '.':
      case ',': {
        if (i + 1 < layout.length && (layout[i + 1] === '0' || layout[i + 1] === '9')) {
          const ch = layout[i + 1];
          let j = i + 1;
          while (j < layout.length && layout[j] === ch) j++;
          if (!isDigit(layout, j)) {
            const code = ch === '9' ? STD_FRAC_SECOND9 : STD_FRAC_SECOND0;
            return [layout.slice(0, i), stdFracSecond(code, j - (i + 1), c), layout.slice(j)];
          }
        }
        break;
      }
    }
  }
  return [layout, 0, ''];
}

function stdFracSecond(code: number, n: number, c: string): number {
  const base = code | ((n & 0xf_ff) << STD_ARG_SHIFT);
  return c === '.' ? base : base | (1 << STD_SEPARATOR_SHIFT);
}

const digitsLen = (std: number): number => (std >> STD_ARG_SHIFT) & 0xf_ff;
const separator = (std: number): string => (std >> STD_SEPARATOR_SHIFT === 0 ? '.' : ',');

/** `appendInt`: x in decimal, zero-padded to `width` digits after any minus sign. */
function appendInt(x: bigint, width: number): string {
  const negative = x < 0n;
  const digits = String(negative ? u64(-x) : x);
  return `${negative ? '-' : ''}${digits.padStart(width, '0')}`;
}

function appendNano(nanosec: bigint, std: number): string {
  const trim = (std & STD_MASK) === STD_FRAC_SECOND9;
  const n = digitsLen(std);
  if (trim && (n === 0 || nanosec === 0n)) return '';
  const dot = separator(std);
  let b = `${dot}${appendInt(nanosec, 9)}`;
  if (n < 9) b = b.slice(0, b.length - 9 + n);
  if (trim) {
    b = b.replace(/0+$/, '');
    if (b.endsWith(dot)) b = b.slice(0, -1);
  }
  return b;
}

export function monthString(m: bigint): string {
  if (m >= 1n && m <= 12n) return LONG_MONTH_NAMES[Number(m) - 1];
  return `%!Month(${u64(m)})`;
}

export function weekdayString(d: bigint): string {
  if (d >= 0n && d <= 6n) return LONG_DAY_NAMES[Number(d)];
  return `%!Weekday(${u64(d)})`;
}

/** `Time.Format`. */
export function format(t: Time, layout: string): string {
  if (layout === LAYOUTS.RFC3339) return formatRfc3339(t, false);
  if (layout === LAYOUTS.RFC3339Nano) return formatRfc3339(t, true);
  return appendFormat(t, layout);
}

// code-gauge-allow functionCognitiveComplexity 60 -- A transcription of format.go's appendFormat switch.
function appendFormat(t: Time, layoutValue: string): string {
  const { name, offset, abs } = locabs(t);
  const days = daysOf(abs);
  let layout = layoutValue;
  let b = '';
  let ymd: { year: bigint; month: bigint; day: bigint } | undefined;
  let yday: bigint | undefined;
  let hms: { hour: bigint; min: bigint; sec: bigint } | undefined;
  while (layout !== '') {
    const [prefix, std, suffix] = nextStdChunk(layout);
    b += prefix;
    if (std === 0) break;
    layout = suffix;
    if (!ymd && (std & STD_NEED_DATE) !== 0) ymd = absDate(days);
    if (yday === undefined && (std & STD_NEED_YDAY) !== 0) yday = yearYday(days).yday;
    if (!hms && (std & STD_NEED_CLOCK) !== 0) hms = clockOf(abs);
    const { year, month, day } = ymd ?? { year: 0n, month: 0n, day: 0n };
    const { hour, min, sec: s } = hms ?? { hour: 0n, min: 0n, sec: 0n };
    const code = std & STD_MASK;
    switch (code) {
      case STD_YEAR: {
        b += appendInt((year < 0n ? -year : year) % 100n, 2);
        break;
      }
      case STD_LONG_YEAR: {
        b += appendInt(year, 4);
        break;
      }
      case STD_MONTH: {
        b += monthString(month).slice(0, 3);
        break;
      }
      case STD_LONG_MONTH: {
        b += monthString(month);
        break;
      }
      case STD_NUM_MONTH: {
        b += appendInt(month, 0);
        break;
      }
      case STD_ZERO_MONTH: {
        b += appendInt(month, 2);
        break;
      }
      case STD_WEEK_DAY: {
        b += weekdayString(weekdayOf(days)).slice(0, 3);
        break;
      }
      case STD_LONG_WEEK_DAY: {
        b += weekdayString(weekdayOf(days));
        break;
      }
      case STD_DAY: {
        b += appendInt(day, 0);
        break;
      }
      case STD_UNDER_DAY: {
        b += `${day < 10n ? ' ' : ''}${appendInt(day, 0)}`;
        break;
      }
      case STD_ZERO_DAY: {
        b += appendInt(day, 2);
        break;
      }
      case STD_UNDER_YEAR_DAY: {
        const value = yday ?? 0n;
        b += `${value < 100n ? (value < 10n ? '  ' : ' ') : ''}${appendInt(value, 0)}`;
        break;
      }
      case STD_ZERO_YEAR_DAY: {
        b += appendInt(yday ?? 0n, 3);
        break;
      }
      case STD_HOUR: {
        b += appendInt(hour, 2);
        break;
      }
      case STD_HOUR12:
      case STD_ZERO_HOUR12: {
        const hr = hour % 12n === 0n ? 12n : hour % 12n;
        b += appendInt(hr, code === STD_HOUR12 ? 0 : 2);
        break;
      }
      case STD_MINUTE:
      case STD_ZERO_MINUTE: {
        b += appendInt(min, code === STD_MINUTE ? 0 : 2);
        break;
      }
      case STD_SECOND:
      case STD_ZERO_SECOND: {
        b += appendInt(s, code === STD_SECOND ? 0 : 2);
        break;
      }
      case STD_PM: {
        b += hour >= 12n ? 'PM' : 'AM';
        break;
      }
      case STD_LOWER_PM: {
        b += hour >= 12n ? 'pm' : 'am';
        break;
      }
      case STD_TZ: {
        if (name !== '') {
          b += name;
          break;
        }
        let minutes = offset / 60n;
        if (minutes < 0n) {
          b += '-';
          minutes = -minutes;
        } else {
          b += '+';
        }
        b += appendInt(minutes / 60n, 2) + appendInt(minutes % 60n, 2);
        break;
      }
      case STD_FRAC_SECOND0:
      case STD_FRAC_SECOND9: {
        b += appendNano(nsec(t), std);
        break;
      }
      default: {
        if (ISO_ZONES.has(std) || NUM_ZONES.has(std)) b += formatZone(std, offset);
      }
    }
  }
  return b;
}

function formatZone(std: number, offset: bigint): string {
  if (offset === 0n && ISO_ZONES.has(std)) return 'Z';
  let minutes = offset / 60n;
  let absOffset = offset;
  let b: string;
  if (minutes < 0n) {
    b = '-';
    minutes = -minutes;
    absOffset = -absOffset;
  } else {
    b = '+';
  }
  b += appendInt(minutes / 60n, 2);
  const colon = [STD_ISO8601_COLON_TZ, STD_NUM_COLON_TZ, STD_ISO8601_COLON_SECONDS_TZ, STD_NUM_COLON_SECONDS_TZ];
  if (colon.includes(std)) b += ':';
  if (std !== STD_NUM_SHORT_TZ && std !== STD_ISO8601_SHORT_TZ) b += appendInt(minutes % 60n, 2);
  if (
    [STD_ISO8601_SECONDS_TZ, STD_NUM_SECONDS_TZ, STD_NUM_COLON_SECONDS_TZ, STD_ISO8601_COLON_SECONDS_TZ].includes(std)
  ) {
    if (std === STD_NUM_COLON_SECONDS_TZ || std === STD_ISO8601_COLON_SECONDS_TZ) b += ':';
    b += appendInt(absOffset % 60n, 2);
  }
  return b;
}

function formatRfc3339(t: Time, nanos: boolean): string {
  const { offset, abs } = locabs(t);
  const { year, month, day } = absDate(daysOf(abs));
  const { hour, min, sec: s } = clockOf(abs);
  let b = `${appendInt(year, 4)}-${appendInt(month, 2)}-${appendInt(day, 2)}T`;
  b += `${appendInt(hour, 2)}:${appendInt(min, 2)}:${appendInt(s, 2)}`;
  if (nanos) b += appendNano(nsec(t), stdFracSecond(STD_FRAC_SECOND9, 9, '.'));
  if (offset === 0n) return `${b}Z`;
  let minutes = offset / 60n;
  if (minutes < 0n) {
    b += '-';
    minutes = -minutes;
  } else {
    b += '+';
  }
  return `${b}${appendInt(minutes / 60n, 2)}:${appendInt(minutes % 60n, 2)}`;
}

/** `appendStrictRFC3339`, for MarshalJSON and MarshalText: the text, or the error message. */
export function strictRfc3339(t: Time): { text: string; error?: string } {
  const text = formatRfc3339(t, true);
  if (text[4] !== '-') return { text, error: 'year outside of range [0,9999]' };
  if (!text.endsWith('Z')) {
    const c = text.at(-6) ?? '';
    const hour = Number(text.slice(-5, -3));
    if ((c >= '0' && c <= '9') || hour >= 24) return { text, error: 'timezone hour outside of range [0,23]' };
  }
  return { text };
}

/** `Time.String`. */
export function timeString(t: Time): string {
  let s = format(t, '2006-01-02 15:04:05.999999999 -0700 MST');
  if ((t.wall & HAS_MONOTONIC) !== 0n) {
    let m2 = u64(t.ext);
    let sign = '+';
    if (t.ext < 0n) {
      sign = '-';
      m2 = u64(-m2);
    }
    let m1 = m2 / SECOND;
    m2 %= SECOND;
    const m0 = m1 / SECOND;
    m1 %= SECOND;
    s += ` m=${sign}${m0 === 0n ? '' : String(m0)}${appendInt(m1, m0 === 0n ? 0 : 9)}.${appendInt(m2, 9)}`;
  }
  return s;
}

/** `Time.GoString`. */
export function goString(t: Time): string {
  const abs = absSec(t);
  const { year, month, day } = absDate(daysOf(abs));
  const { hour, min, sec: s } = clockOf(abs);
  const monthText = month >= 1n && month <= 12n ? `, time.${LONG_MONTH_NAMES[Number(month) - 1]}` : String(month);
  const location = t.loc ?? UTC_LOCATION;
  const locationText =
    location === UTC_LOCATION
      ? 'time.UTC'
      : location === LOCAL_LOCATION
        ? 'time.Local'
        : `time.Location(${quote(location.name)})`;
  return `time.Date(${year}${monthText}, ${day}, ${hour}, ${min}, ${s}, ${nsec(t)}, ${locationText})`;
}

/** format.go's `quote`, which escapes the bytes of non-ASCII runes as \x sequences. */
export function quote(s: string): string {
  let buf = '"';
  for (let i = 0; i < s.length;) {
    const { rune, size } = decodeRune(s, i);
    if (rune >= 0x80 || rune < 0x20) {
      const width = rune === 0xff_fd && !s.startsWith('ï¿½', i) ? 1 : size;
      for (let j = 0; j < width; j++)
        buf += `\\x${s
          .charCodeAt(i + j)
          .toString(16)
          .padStart(2, '0')}`;
    } else {
      if (rune === 0x22 || rune === 0x5c) buf += '\\';
      buf += s[i];
    }
    i += size;
  }
  return `${buf}"`;
}

// Parsing ---------------------------------------------------------------------------------------------------------

/** A `time.ParseError`'s fields. */
export interface ParseError {
  layout: string;
  value: string;
  layoutElem: string;
  valueElem: string;
  message: string;
}

export type ParseResult = { time: Time } | { error: ParseError };

const BAD = Symbol('bad');

function match(s1: string, s2: string): boolean {
  for (let i = 0; i < s1.length; i++) {
    let c1 = s1.charCodeAt(i);
    let c2 = s2.charCodeAt(i);
    if (c1 !== c2) {
      c1 |= 32;
      c2 |= 32;
      if (c1 !== c2 || c1 < 97 || c1 > 122) return false;
    }
  }
  return true;
}

function lookupTable(table: string[], value: string): [number, string] | typeof BAD {
  for (const [index, name] of table.entries()) {
    if (value.length >= name.length && match(value.slice(0, name.length), name)) {
      return [index, value.slice(name.length)];
    }
  }
  return BAD;
}

function leadingInt(s: string): [bigint, string] | typeof BAD {
  let x = 0n;
  let i = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) break;
    if (x > (1n << 63n) / 10n) return BAD;
    x = x * 10n + BigInt(c - 48);
    if (x > 1n << 63n) return BAD;
  }
  return [x, s.slice(i)];
}

function atoi(text: string): bigint | typeof BAD {
  let s = text;
  let neg = false;
  if (s.length > 0 && (s[0] === '-' || s[0] === '+')) {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  const result = leadingInt(s);
  if (result === BAD || result[1].length > 0) return BAD;
  const x = i64(result[0]);
  return neg ? i64(-x) : x;
}

function getnum(s: string, fixed: boolean): [bigint, string] | typeof BAD {
  if (!isDigit(s, 0)) return BAD;
  if (!isDigit(s, 1)) {
    if (fixed) return BAD;
    return [BigInt(s.charCodeAt(0) - 48), s.slice(1)];
  }
  return [BigInt((s.charCodeAt(0) - 48) * 10 + s.charCodeAt(1) - 48), s.slice(2)];
}

function getnum3(s: string, fixed: boolean): [bigint, string] | typeof BAD {
  let n = 0;
  let i = 0;
  for (; i < 3 && isDigit(s, i); i++) n = n * 10 + s.charCodeAt(i) - 48;
  if (i === 0 || (fixed && i !== 3)) return BAD;
  return [BigInt(n), s.slice(i)];
}

const cutspace = (s: string): string => s.replace(/^ +/, '');

/** Consumes the layout's literal prefix from the value; on a mismatch, the value keeps what was consumed so far. */
function skip(valueText: string, prefixText: string): { value: string; ok: boolean } {
  let value = valueText;
  let prefix = prefixText;
  while (prefix.length > 0) {
    if (prefix[0] === ' ') {
      if (value.length > 0 && value[0] !== ' ') return { value, ok: false };
      prefix = cutspace(prefix);
      value = cutspace(value);
      continue;
    }
    if (value.length === 0 || value[0] !== prefix[0]) return { value, ok: false };
    prefix = prefix.slice(1);
    value = value.slice(1);
  }
  return { value, ok: true };
}

const commaOrPeriod = (c: string | undefined): boolean => c === '.' || c === ',';

function parseNanoseconds(valueText: string, nbytesValue: number): { ns: bigint; range?: string } | typeof BAD {
  if (!commaOrPeriod(valueText[0])) return BAD;
  let value = valueText;
  let nbytes = nbytesValue;
  if (nbytes > 10) {
    value = value.slice(0, 10);
    nbytes = 10;
  }
  let ns = atoi(value.slice(1, nbytes));
  if (ns === BAD) return BAD;
  if (ns < 0n) return { ns, range: 'fractional second' };
  for (let i = 0; i < 10 - nbytes; i++) ns *= 10n;
  return { ns };
}

function parseTimeZone(value: string): number | undefined {
  if (value.length < 3) return;
  if (value.startsWith('ChST') || value.startsWith('MeST')) return 4;
  if (value.startsWith('GMT')) return parseGmt(value);
  if (value[0] === '+' || value[0] === '-') {
    const length = parseSignedOffset(value);
    return length > 0 ? length : undefined;
  }
  let nUpper = 0;
  for (; nUpper < 6 && nUpper < value.length; nUpper++) {
    const c = value[nUpper];
    if (c < 'A' || c > 'Z') break;
  }
  if (nUpper === 5 && value[4] === 'T') return 5;
  if (nUpper === 4 && (value[3] === 'T' || value.startsWith('WITA'))) return 4;
  if (nUpper === 3) return 3;
  return;
}

function parseGmt(value: string): number {
  const rest = value.slice(3);
  return rest.length === 0 ? 3 : 3 + parseSignedOffset(rest);
}

function parseSignedOffset(value: string): number {
  if (value[0] !== '-' && value[0] !== '+') return 0;
  const result = leadingInt(value.slice(1));
  if (result === BAD || result[1] === value.slice(1)) return 0;
  if (result[0] > 23n) return 0;
  return value.length - result[1].length;
}

/** `time.Parse` (local = Local) and `time.ParseInLocation` (both locations = loc). */
export function parse(layout: string, value: string, defaultLocation: Location, local: Location): ParseResult {
  if (layout === LAYOUTS.RFC3339 || layout === LAYOUTS.RFC3339Nano) {
    const t = parseRfc3339(value, local);
    if (t) return { time: t };
  }
  return parseLayout(layout, value, defaultLocation, local);
}

interface ParseState {
  year: bigint;
  month: bigint;
  day: bigint;
  yday: bigint;
  hour: bigint;
  min: bigint;
  sec: bigint;
  nsec: bigint;
  z: Location | undefined;
  zoneOffset: bigint;
  zoneName: string;
  amSet: boolean;
  pmSet: boolean;
  range: string;
}

// code-gauge-allow functionCognitiveComplexity 40 -- A transcription of format.go's parse.
function parseLayout(layoutValue: string, valueText: string, defaultLocation: Location, local: Location): ParseResult {
  const failure = (layoutElem: string, valueElem: string, message: string): ParseResult => ({
    error: { layout: layoutValue, value: valueText, layoutElem, valueElem, message },
  });
  let layout = layoutValue;
  let value = valueText;
  const state: ParseState = {
    year: 0n,
    month: -1n,
    day: -1n,
    yday: -1n,
    hour: 0n,
    min: 0n,
    sec: 0n,
    nsec: 0n,
    z: undefined,
    zoneOffset: -1n,
    zoneName: '',
    amSet: false,
    pmSet: false,
    range: '',
  };
  for (;;) {
    const [prefix, std, suffix] = nextStdChunk(layout);
    const stdstr = layout.slice(prefix.length, layout.length - suffix.length);
    const skipped = skip(value, prefix);
    value = skipped.value;
    if (!skipped.ok) return failure(prefix, value, '');
    if (std === 0) {
      if (value.length > 0) return failure('', value, `: extra text: ${quote(value)}`);
      break;
    }
    layout = suffix;
    const hold = value;
    const next = parseElement(std, value, layout, state);
    if (next !== BAD) value = next;
    if (state.range !== '') return failure(stdstr, value, `: ${state.range} out of range`);
    if (next === BAD) return failure(stdstr, hold, '');
  }
  return finishParse(state, value, defaultLocation, local, failure);
}

// code-gauge-allow functionCognitiveComplexity 80 -- A transcription of the element switch of format.go's parse.
function parseElement(std: number, valueText: string, layout: string, state: ParseState): string | typeof BAD {
  let value = valueText;
  const take = (result: [bigint, string] | typeof BAD, set: (n: bigint) => void): string | typeof BAD => {
    if (result === BAD) return BAD;
    set(result[0]);
    return result[1];
  };
  switch (std & STD_MASK) {
    case STD_YEAR: {
      if (value.length < 2) return BAD;
      const year = atoi(value.slice(0, 2));
      if (year === BAD) return BAD;
      state.year = year >= 69n ? year + 1900n : year + 2000n;
      return value.slice(2);
    }
    case STD_LONG_YEAR: {
      if (value.length < 4 || !isDigit(value, 0)) return BAD;
      const year = atoi(value.slice(0, 4));
      if (year === BAD) return BAD;
      state.year = year;
      return value.slice(4);
    }
    case STD_MONTH:
    case STD_LONG_MONTH: {
      const result = lookupTable(std === STD_MONTH ? SHORT_MONTH_NAMES : LONG_MONTH_NAMES, value);
      if (result === BAD) return BAD;
      state.month = BigInt(result[0] + 1);
      return result[1];
    }
    case STD_NUM_MONTH:
    case STD_ZERO_MONTH: {
      return take(getnum(value, std === STD_ZERO_MONTH), (month) => {
        state.month = month;
        if (month <= 0n || month > 12n) state.range = 'month';
      });
    }
    case STD_WEEK_DAY:
    case STD_LONG_WEEK_DAY: {
      const result = lookupTable(std === STD_WEEK_DAY ? SHORT_DAY_NAMES : LONG_DAY_NAMES, value);
      return result === BAD ? BAD : result[1];
    }
    case STD_DAY:
    case STD_UNDER_DAY:
    case STD_ZERO_DAY: {
      if (std === STD_UNDER_DAY && value[0] === ' ') value = value.slice(1);
      return take(getnum(value, std === STD_ZERO_DAY), (day) => {
        state.day = day;
      });
    }
    case STD_UNDER_YEAR_DAY:
    case STD_ZERO_YEAR_DAY: {
      for (let i = 0; i < 2; i++) if (std === STD_UNDER_YEAR_DAY && value[0] === ' ') value = value.slice(1);
      return take(getnum3(value, std === STD_ZERO_YEAR_DAY), (yday) => {
        state.yday = yday;
      });
    }
    case STD_HOUR: {
      return take(getnum(value, false), (hour) => {
        state.hour = hour;
        if (hour < 0n || hour >= 24n) state.range = 'hour';
      });
    }
    case STD_HOUR12:
    case STD_ZERO_HOUR12: {
      return take(getnum(value, std === STD_ZERO_HOUR12), (hour) => {
        state.hour = hour;
        if (hour < 0n || hour > 12n) state.range = 'hour';
      });
    }
    case STD_MINUTE:
    case STD_ZERO_MINUTE: {
      return take(getnum(value, std === STD_ZERO_MINUTE), (min) => {
        state.min = min;
        if (min < 0n || min >= 60n) state.range = 'minute';
      });
    }
    case STD_SECOND:
    case STD_ZERO_SECOND: {
      return parseSecond(std, value, layout, state);
    }
    case STD_PM:
    case STD_LOWER_PM: {
      if (value.length < 2) return BAD;
      const p = value.slice(0, 2);
      const [pm, am] = std === STD_PM ? ['PM', 'AM'] : ['pm', 'am'];
      if (p === pm) state.pmSet = true;
      else if (p === am) state.amSet = true;
      else return BAD;
      return value.slice(2);
    }
    case STD_ISO8601_TZ:
    case STD_ISO8601_SHORT_TZ:
    case STD_ISO8601_COLON_TZ:
    case STD_ISO8601_SECONDS_TZ:
    case STD_ISO8601_COLON_SECONDS_TZ: {
      if (value[0] === 'Z') {
        state.z = UTC_LOCATION;
        return value.slice(1);
      }
      return parseNumericZone(std, value, state);
    }
    case STD_NUM_TZ:
    case STD_NUM_SHORT_TZ:
    case STD_NUM_COLON_TZ:
    case STD_NUM_SECONDS_TZ:
    case STD_NUM_COLON_SECONDS_TZ: {
      return parseNumericZone(std, value, state);
    }
    case STD_TZ: {
      if (value.startsWith('UTC')) {
        state.z = UTC_LOCATION;
        return value.slice(3);
      }
      const n = parseTimeZone(value);
      if (n === undefined) return BAD;
      state.zoneName = value.slice(0, n);
      return value.slice(n);
    }
    case STD_FRAC_SECOND0: {
      const ndigit = 1 + digitsLen(std);
      if (value.length < ndigit) return BAD;
      const result = parseNanoseconds(value, ndigit);
      if (result === BAD) return BAD;
      state.nsec = result.ns;
      if (result.range) state.range = result.range;
      return value.slice(ndigit);
    }
    case STD_FRAC_SECOND9: {
      if (value.length < 2 || !commaOrPeriod(value[0]) || value[1] < '0' || value[1] > '9') return value;
      let i = 0;
      while (i + 1 < value.length && value[i + 1] >= '0' && value[i + 1] <= '9') i++;
      const result = parseNanoseconds(value, 1 + i);
      if (result === BAD) return BAD;
      state.nsec = result.ns;
      if (result.range) state.range = result.range;
      return value.slice(1 + i);
    }
  }
  return value;
}

function parseSecond(std: number, valueText: string, layout: string, state: ParseState): string | typeof BAD {
  const result = getnum(valueText, std === STD_ZERO_SECOND);
  if (result === BAD) return BAD;
  let value = result[1];
  state.sec = result[0];
  if (state.sec < 0n || state.sec >= 60n) {
    state.range = 'second';
    return value;
  }
  if (value.length >= 2 && commaOrPeriod(value[0]) && isDigit(value, 1)) {
    const nextStd = nextStdChunk(layout)[1] & STD_MASK;
    if (nextStd === STD_FRAC_SECOND0 || nextStd === STD_FRAC_SECOND9) return value;
    let n = 2;
    while (n < value.length && isDigit(value, n)) n++;
    const fraction = parseNanoseconds(value, n);
    if (fraction === BAD) return BAD;
    state.nsec = fraction.ns;
    if (fraction.range) state.range = fraction.range;
    value = value.slice(n);
  }
  return value;
}

function parseNumericZone(std: number, value: string, state: ParseState): string | typeof BAD {
  let parts: [string, string, string, string, string];
  if (std === STD_ISO8601_COLON_TZ || std === STD_NUM_COLON_TZ) {
    if (value.length < 6 || value[3] !== ':') return BAD;
    parts = [value.slice(0, 1), value.slice(1, 3), value.slice(4, 6), '00', value.slice(6)];
  } else if (std === STD_NUM_SHORT_TZ || std === STD_ISO8601_SHORT_TZ) {
    if (value.length < 3) return BAD;
    parts = [value.slice(0, 1), value.slice(1, 3), '00', '00', value.slice(3)];
  } else if (std === STD_ISO8601_COLON_SECONDS_TZ || std === STD_NUM_COLON_SECONDS_TZ) {
    if (value.length < 9 || value[3] !== ':' || value[6] !== ':') return BAD;
    parts = [value.slice(0, 1), value.slice(1, 3), value.slice(4, 6), value.slice(7, 9), value.slice(9)];
  } else if (std === STD_ISO8601_SECONDS_TZ || std === STD_NUM_SECONDS_TZ) {
    if (value.length < 7) return BAD;
    parts = [value.slice(0, 1), value.slice(1, 3), value.slice(3, 5), value.slice(5, 7), value.slice(7)];
  } else {
    if (value.length < 5) return BAD;
    parts = [value.slice(0, 1), value.slice(1, 3), value.slice(3, 5), '00', value.slice(5)];
  }
  const [sign, hourText, minText, secondsText, rest] = parts;
  let hr = 0n;
  let mm = 0n;
  let ss = 0n;
  let bad = false;
  const hourResult = getnum(hourText, true);
  if (hourResult === BAD) bad = true;
  else {
    hr = hourResult[0];
    const minResult = getnum(minText, true);
    if (minResult === BAD) bad = true;
    else {
      mm = minResult[0];
      const secondsResult = getnum(secondsText, true);
      if (secondsResult === BAD) bad = true;
      else ss = secondsResult[0];
    }
  }
  if (hr > 24n) state.range = 'time zone offset hour';
  if (mm > 60n) state.range = 'time zone offset minute';
  if (ss > 60n) state.range = 'time zone offset second';
  state.zoneOffset = (hr * 60n + mm) * 60n + ss;
  if (sign === '-') state.zoneOffset = -state.zoneOffset;
  else if (sign !== '+') bad = true;
  // A range error takes precedence over a malformed offset, with the value after the offset, as in Go.
  return bad && state.range === '' ? BAD : rest;
}

function finishParse(
  state: ParseState,
  value: string,
  defaultLocation: Location,
  local: Location,
  failure: (layoutElem: string, valueElem: string, message: string) => ParseResult
): ParseResult {
  if (state.pmSet && state.hour < 12n) state.hour += 12n;
  else if (state.amSet && state.hour === 12n) state.hour = 0n;
  const { year } = state;
  if (state.yday >= 0n) {
    let d = 0n;
    let m = 0n;
    let yday = state.yday;
    if (isLeap(year)) {
      if (yday === 31n + 29n) {
        m = 2n;
        d = 29n;
      } else if (yday > 31n + 29n) {
        yday--;
      }
    }
    if (yday < 1n || yday > 365n) return failure('', value, ': day-of-year out of range');
    if (m === 0n) {
      m = (yday - 1n) / 31n + 1n;
      if (daysBefore(m + 1n) < yday) m++;
      d = yday - daysBefore(m);
    }
    if (state.month >= 0n && state.month !== m) return failure('', value, ': day-of-year does not match month');
    state.month = m;
    if (state.day >= 0n && state.day !== d) return failure('', value, ': day-of-year does not match day');
    state.day = d;
  } else {
    if (state.month < 0n) state.month = 1n;
    if (state.day < 0n) state.day = 1n;
  }
  if (state.day < 1n || state.day > daysIn(state.month, year)) return failure('', value, ': day out of range');
  const dateIn = (location: Location): Time =>
    makeDate(year, state.month, state.day, state.hour, state.min, state.sec, state.nsec, location);
  if (state.z) return { time: dateIn(state.z) };
  if (state.zoneOffset !== -1n) {
    const t = dateIn(UTC_LOCATION);
    addSec(t, -state.zoneOffset);
    const { name, offset } = lookup(local);
    if (offset === state.zoneOffset && (state.zoneName === '' || name === state.zoneName)) {
      setLoc(t, local);
      return { time: t };
    }
    setLoc(t, fixedZone(state.zoneName, state.zoneOffset));
    return { time: t };
  }
  if (state.zoneName !== '') {
    const t = dateIn(UTC_LOCATION);
    const localOffset = lookupName(local, state.zoneName);
    if (localOffset !== undefined) {
      addSec(t, -localOffset);
      setLoc(t, local);
      return { time: t };
    }
    let offset = 0n;
    if (state.zoneName.length > 3 && state.zoneName.startsWith('GMT')) {
      offset = (atoi(state.zoneName.slice(3)) as bigint) * 3600n;
    }
    setLoc(t, fixedZone(state.zoneName, offset));
    return { time: t };
  }
  return { time: dateIn(defaultLocation) };
}

function parseRfc3339(s: string, local: Location): Time | undefined {
  let ok = true;
  const parseUint = (text: string, min: bigint, max: bigint): bigint => {
    let x = 0n;
    for (const c of text) {
      if (c < '0' || c > '9') {
        ok = false;
        return min;
      }
      x = x * 10n + BigInt(c.charCodeAt(0) - 48);
    }
    if (x < min || max < x) {
      ok = false;
      return min;
    }
    return x;
  };
  if (s.length < 19) return;
  const year = parseUint(s.slice(0, 4), 0n, 9999n);
  const month = parseUint(s.slice(5, 7), 1n, 12n);
  const day = parseUint(s.slice(8, 10), 1n, daysIn(month, year));
  const hour = parseUint(s.slice(11, 13), 0n, 23n);
  const min = parseUint(s.slice(14, 16), 0n, 59n);
  const second = parseUint(s.slice(17, 19), 0n, 59n);
  if (!ok || !(s[4] === '-' && s[7] === '-' && s[10] === 'T' && s[13] === ':' && s[16] === ':')) return;
  let rest = s.slice(19);
  let ns = 0n;
  if (rest.length >= 2 && rest[0] === '.' && isDigit(rest, 1)) {
    let n = 2;
    while (n < rest.length && isDigit(rest, n)) n++;
    const fraction = parseNanoseconds(rest, n);
    if (fraction !== BAD) ns = fraction.ns;
    rest = rest.slice(n);
  }
  const t = makeDate(year, month, day, hour, min, second, ns, UTC_LOCATION);
  if (rest.length !== 1 || rest[0] !== 'Z') {
    if (rest.length !== 6) return;
    const hr = parseUint(rest.slice(1, 3), 0n, 23n);
    const mm = parseUint(rest.slice(4, 6), 0n, 59n);
    if (!ok || !((rest[0] === '-' || rest[0] === '+') && rest[3] === ':')) return;
    let zoneOffset = (hr * 60n + mm) * 60n;
    if (rest[0] === '-') zoneOffset = -zoneOffset;
    addSec(t, -zoneOffset);
    setLoc(t, lookup(local).offset === zoneOffset ? local : fixedZone('', zoneOffset));
  }
  return t;
}

/** `parseStrictRFC3339`, for UnmarshalJSON and UnmarshalText. */
export function parseStrictRfc3339(text: string): ParseResult {
  const t = parseRfc3339(text, LOCAL_LOCATION);
  if (t) return { time: t };
  return parse(LAYOUTS.RFC3339, text, UTC_LOCATION, LOCAL_LOCATION);
}

const UNIT_MAP = new Map<string, bigint>([
  ['ns', 1n],
  ['us', 1000n],
  ['Âµs', 1000n],
  ['Î¼s', 1000n],
  ['ms', 1_000_000n],
  ['s', SECOND],
  ['m', MINUTE],
  ['h', HOUR],
]);

function leadingFraction(s: string): [bigint, number, string] {
  let x = 0n;
  let scale = 1;
  let overflow = false;
  let i = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) break;
    if (overflow) continue;
    if (x > ((1n << 63n) - 1n) / 10n) {
      overflow = true;
      continue;
    }
    const y = x * 10n + BigInt(c - 48);
    if (y > 1n << 63n) {
      overflow = true;
      continue;
    }
    x = y;
    scale *= 10;
  }
  return [x, scale, s.slice(i)];
}

/** `time.ParseDuration`: the duration, or the message of its error. */
// code-gauge-allow functionCognitiveComplexity 30 -- A transcription of format.go's ParseDuration.
export function parseDuration(orig: string): { duration: bigint } | { error: string } {
  const invalid = { error: `time: invalid duration ${quote(orig)}` };
  let s = orig;
  let d = 0n;
  let neg = false;
  if (s !== '' && (s[0] === '-' || s[0] === '+')) {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  if (s === '0') return { duration: 0n };
  if (s === '') return invalid;
  while (s !== '') {
    let f = 0n;
    let scale = 1;
    if (!(s[0] === '.' || (s[0] >= '0' && s[0] <= '9'))) return invalid;
    const pl = s.length;
    const whole = leadingInt(s);
    if (whole === BAD) return invalid;
    let v = whole[0];
    s = whole[1];
    const pre = pl !== s.length;
    let post = false;
    if (s !== '' && s[0] === '.') {
      s = s.slice(1);
      const before = s.length;
      [f, scale, s] = leadingFraction(s);
      post = before !== s.length;
    }
    if (!pre && !post) return invalid;
    let i = 0;
    while (i < s.length && !(s[i] === '.' || (s[i] >= '0' && s[i] <= '9'))) i++;
    if (i === 0) return { error: `time: missing unit in duration ${quote(orig)}` };
    const u = s.slice(0, i);
    s = s.slice(i);
    const unit = UNIT_MAP.get(u);
    if (unit === undefined) return { error: `time: unknown unit ${quote(u)} in duration ${quote(orig)}` };
    if (v > (1n << 63n) / unit) return invalid;
    v *= unit;
    if (f > 0n) {
      v = u64(v + floatToUint64(Number(f) * (Number(unit) / scale)));
      if (v > 1n << 63n) return invalid;
    }
    d = u64(d + v);
    if (d > 1n << 63n) return invalid;
  }
  if (neg) return { duration: i64(-d) };
  if (d > (1n << 63n) - 1n) return invalid;
  return { duration: d };
}

function floatToUint64(x: number): bigint {
  return BigInt(Math.trunc(x));
}
