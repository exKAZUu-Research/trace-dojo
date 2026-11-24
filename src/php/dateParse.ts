// code-gauge-allow-file fileNcss -- Transcribes timelib's date string scanner, whose rules belong together.
import { dayFromIsoWeek, isValidDate, isValidTime } from './dateCalendar';
import { knownZoneId, type Zone } from './dateZone';

/** timelib's relative part of a parsed time (timelib_rel_time). */
export interface Relative {
  y: number;
  m: number;
  d: number;
  h: number;
  i: number;
  s: number;
  us: number;
  weekday: number;
  weekdayBehavior: number;
  haveWeekday: boolean;
  /** `weekday`/`weekdays` units (1), or the nth (2) or last (3) weekday of a month. */
  special: { type: number; amount: number } | undefined;
  /** `first day of` (1) or `last day of` (2). */
  firstLast: 0 | 1 | 2;
}

export const SPECIAL_WEEKDAY = 1;
export const SPECIAL_DAY_OF_WEEK_IN_MONTH = 2;
export const SPECIAL_LAST_DAY_OF_WEEK_IN_MONTH = 3;

export interface ParseMessage {
  position: number;
  character: string;
  message: string;
}

/** The result of timelib_strtotime: fields left undefined are the unset ones `fill` takes from the base time. */
export interface ParsedTime {
  y?: number;
  m?: number;
  d?: number;
  h?: number;
  i?: number;
  s?: number;
  us?: number;
  zone?: Zone;
  haveTime: number;
  haveDate: boolean;
  haveZone: number;
  haveRelative: boolean;
  relative: Relative;
  errors: ParseMessage[];
  warnings: ParseMessage[];
  /** The position of a word that only PHP's abbreviation table could tell to be a time zone or not. */
  unknownAbbreviation?: number;
}

export function emptyRelative(): Relative {
  return {
    y: 0,
    m: 0,
    d: 0,
    h: 0,
    i: 0,
    s: 0,
    us: 0,
    weekday: 0,
    weekdayBehavior: 0,
    haveWeekday: false,
    special: undefined,
    firstLast: 0,
  };
}

// Regular expressions -------------------------------------------------------------------------------------------------

/** A case-insensitive alternation of words, longest first, as re2c's longest match would pick among them. */
function words(...list: string[]): string {
  return `(?:${list
    .toSorted((a, b) => b.length - a.length)
    .map((word) => [...word].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join(''))
    .join('|')})`;
}

const space = String.raw`(?:[ \t]+|(?:\xc2\xa0)+|(?:\xe2\x80\xaf)+)`;
const frac = String.raw`\.[0-9]+`;
const hour24 = '(?:2[0-4]|[01][0-9]|[0-9])';
const hour24lz = '(?:2[0-4]|[01][0-9])';
const hour12 = '(?:1[0-2]|0?[1-9])';
const minute = '(?:[0-5][0-9]|[0-9])';
const minutelz = '[0-5][0-9]';
const second = '(?:60|[0-5][0-9]|[0-9])';
const secondlz = '(?:60|[0-5][0-9])';
const meridian = String.raw`[AaPp]\.?[Mm]\.?[\0\t ]`;
const tz = String.raw`(?:[A-Z][a-z]+(?:[_/-][A-Za-z]+)+|\(?[A-Za-z]{1,6}\)?)`;
const tzcorrection = `(?:GMT)?[+-](?:${hour24lz}:${minutelz}:${secondlz}|${hour24lz}${minutelz}${secondlz}|${hour24}(?::?${minute})?)`;
const month = '(?:1[0-2]|0?[0-9])';
const day = '(?:3[01]|[0-2]?[0-9])(?:st|nd|rd|th)?';
const year = '[0-9]{1,4}';
const year2 = '[0-9]{2}';
const year4 = '[0-9]{4}';
const dayofyear = '(?:36[0-6]|3[0-5][0-9]|[12][0-9][0-9]|0[1-9][0-9]|00[1-9])';
const weekofyear = '(?:5[0-3]|[1-4][0-9]|0[1-9])';
const monthlz = '(?:1[0-2]|0[0-9])';
const daylz = '(?:3[01]|[12][0-9]|0[0-9])';
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dayfulls = words(...DAY_NAMES.map((name) => `${name}s`));
const dayfull = words(...DAY_NAMES);
const dayabbr = words(...DAY_NAMES.map((name) => name.slice(0, 3)));
const daytext = `(?:${dayfulls}|${dayfull}|${words('weekdays', 'weekday')}|${dayabbr})`;
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const monthfull = words(...MONTH_NAMES);
const monthabbr = words(...MONTH_NAMES.map((name) => name.slice(0, 3)), 'sept');
const monthroman = '(?:XII|XI|IX|X|VIII|VII|VI|IV|V|III|II|I)';
const monthtext = `(?:${monthfull}|${monthabbr}|${monthroman})`;
const timeshort12 = `${hour12}[:.]${minutelz}${space}?${meridian}`;
const timelong12 = `${hour12}[:.]${minute}[:.]${secondlz}${space}?${meridian}`;
const timeshort24 = `[tT]?${hour24}[:.]${minute}`;
const timelong24 = `[tT]?${hour24}[:.]${minute}[:.]${second}`;
const iso8601normtz = `[tT]?${hour24}[:.]${minute}[:.]${secondlz}${space}?(?:${tzcorrection}|${tz})`;
const datenoyear = String.raw`${monthtext}[ .\t-]*${day}(?:[,.stndrh\t ]+|\0)`;
const reltextnumber = words(
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eight',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth'
);
const reltexttext = words('next', 'last', 'previous', 'this');
const reltextunit = `(?:${words(
  ...[
    'msec',
    'millisecond',
    '\u00C2\u00B5sec',
    'microsecond',
    'usec',
    'sec',
    'second',
    'min',
    'minute',
    'hour',
    'day',
    'fortnight',
    'forthnight',
    'month',
    'year',
  ].flatMap((unit) => [`${unit}s`, unit]),
  'ms',
  '\u00C2\u00B5s',
  'weeks'
)}|${daytext})`;

type Action = (token: Cursor, state: ParsedTime, position: number) => void;

class Cursor {
  p = 0;
  constructor(readonly s: string) {}
  c(): string {
    return this.s[this.p] ?? '\0';
  }
}

/** The scanner's rules in timelib's order, which breaks ties between equally long matches. */
const RULES: [RegExp, Action][] = [];

function rule(source: string, action: Action): void {
  RULES.push([new RegExp(source, 'y'), action]);
}

class ScanAbort extends Error {}

function addError(state: ParsedTime, position: number, token: string, message: string): void {
  state.errors.push({ position, character: token[0] ?? '\0', message });
}

function haveTime(state: ParsedTime, token: Cursor, position: number): void {
  if (state.haveTime) {
    addError(state, position, token.s, 'Double time specification');
    throw new ScanAbort();
  }
  state.haveTime = 1;
  state.h = state.i = state.s = state.us = 0;
}

function unhaveTime(state: ParsedTime): void {
  state.haveTime = 0;
  state.h = state.i = state.s = state.us = 0;
}

function haveDate(state: ParsedTime, token: Cursor, position: number): void {
  if (state.haveDate) {
    addError(state, position, token.s, 'Double date specification');
    throw new ScanAbort();
  }
  state.haveDate = true;
}

function haveZone(state: ParsedTime, token: Cursor, position: number): void {
  if (state.haveZone) {
    const message = { position, character: token.s[0], message: 'Double timezone specification' };
    (state.haveZone > 1 ? state.errors : state.warnings).push(message);
    state.haveZone++;
    throw new ScanAbort();
  }
  state.haveZone++;
}

function haveWeekdayRelative(state: ParsedTime): void {
  state.haveRelative = true;
  state.relative.haveWeekday = true;
}

function getNumber(token: Cursor, maxLength: number): { value: number | undefined; length: number } {
  while (token.c() < '0' || token.c() > '9') {
    if (token.p >= token.s.length) return { value: undefined, length: 0 };
    token.p++;
  }
  const begin = token.p;
  while (token.c() >= '0' && token.c() <= '9' && token.p - begin < maxLength) token.p++;
  return { value: Number(token.s.slice(begin, token.p)), length: token.p - begin };
}

const nr = (token: Cursor, maxLength: number): number | undefined => getNumber(token, maxLength).value;

/** Reads a year, turning a two-digit one into 19xx or 20xx as TIMELIB_PROCESS_YEAR does. */
function processedYear(token: Cursor, maxLength: number): number | undefined {
  const { value, length } = getNumber(token, maxLength);
  if (value === undefined || length >= 4 || value >= 100) return value;
  return value + (value < 70 ? 2000 : 1900);
}

function fraction(token: Cursor): number | undefined {
  while (token.c() !== '.' && token.c() !== ':' && (token.c() < '0' || token.c() > '9')) {
    if (token.p >= token.s.length) return undefined;
    token.p++;
  }
  const begin = token.p;
  while (token.c() === '.' || token.c() === ':' || (token.c() >= '0' && token.c() <= '9')) token.p++;
  return Math.trunc(Number(`0.${token.s.slice(begin + 1, token.p)}`) * 1_000_000);
}

function signedNumber(state: ParsedTime, token: Cursor, maxLength: number, position: number): number {
  while ((token.c() < '0' || token.c() > '9') && token.c() !== '+' && token.c() !== '-') {
    if (token.p >= token.s.length) {
      addError(state, position, token.s, 'Found unexpected data');
      return 0;
    }
    token.p++;
  }
  let sign = 1;
  while (token.c() === '+' || token.c() === '-') {
    if (token.c() === '-') sign = -sign;
    token.p++;
  }
  while (token.c() < '0' || token.c() > '9') {
    if (token.p >= token.s.length) {
      addError(state, position, token.s, 'Found unexpected data');
      return 0;
    }
    token.p++;
  }
  const begin = token.p;
  while (token.c() >= '0' && token.c() <= '9' && token.p - begin < maxLength) token.p++;
  return sign * Number(token.s.slice(begin, token.p));
}

function skipDaySuffix(token: Cursor): void {
  if (/^[ \t]/.test(token.c())) return;
  if (/^(?:nd|rd|st|th)/i.test(token.s.slice(token.p))) token.p += 2;
}

function readWord(token: Cursor): string {
  const begin = token.p;
  while (/[A-Za-z]/.test(token.c())) token.p++;
  return token.s.slice(begin, token.p).toLowerCase();
}

const ROMAN_MONTHS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'];

function lookupMonth(token: Cursor): number {
  const word = readWord(token);
  const index = MONTH_NAMES.findIndex((name) => name === word || name.slice(0, 3) === word);
  if (index !== -1) return index + 1;
  if (word === 'sept') return 9;
  return ROMAN_MONTHS.indexOf(word) + 1;
}

function getMonth(token: Cursor): number {
  while (' \t-./'.includes(token.c()) && token.p < token.s.length) token.p++;
  return lookupMonth(token);
}

const RELATIVE_TEXTS: Record<string, [number, number]> = {
  first: [1, 0],
  next: [1, 0],
  second: [2, 0],
  third: [3, 0],
  fourth: [4, 0],
  fifth: [5, 0],
  sixth: [6, 0],
  seventh: [7, 0],
  eight: [8, 0],
  eighth: [8, 0],
  ninth: [9, 0],
  tenth: [10, 0],
  eleventh: [11, 0],
  twelfth: [12, 0],
  last: [-1, 0],
  previous: [-1, 0],
  this: [0, 1],
};

/** Reads a word like `next` or `third`, returning its amount and weekday behavior. */
function relativeText(token: Cursor): [number, number] {
  while (' \t-/'.includes(token.c()) && token.p < token.s.length) token.p++;
  return RELATIVE_TEXTS[readWord(token)] ?? [0, 0];
}

function eatSpaces(token: Cursor): void {
  for (;;) {
    if (token.c() === ' ' || token.c() === '\t') token.p++;
    else if (token.s.startsWith('\u00E2\u0080\u00AF', token.p)) token.p += 3;
    else if (token.s.startsWith('\u00C2\u00A0', token.p)) token.p += 2;
    else return;
  }
}

type RelativeUnit = ['us' | 's' | 'i' | 'h' | 'd' | 'm' | 'y' | 'weekday' | 'special', number];

function relativeUnit(word: string): RelativeUnit | undefined {
  const lower = word.toLowerCase();
  const dayIndex = DAY_NAMES.findIndex((name) => lower === name || lower === `${name}s` || lower === name.slice(0, 3));
  if (dayIndex !== -1) return ['weekday', dayIndex];
  if (lower === 'weekday' || lower === 'weekdays') return ['special', SPECIAL_WEEKDAY];
  const singular = lower.endsWith('s') && lower !== 'ms' && lower !== '\u00C2\u00B5s' ? lower.slice(0, -1) : lower;
  const units: Record<string, RelativeUnit> = {
    ms: ['us', 1000],
    msec: ['us', 1000],
    millisecond: ['us', 1000],
    '\u00C2\u00B5s': ['us', 1],
    usec: ['us', 1],
    '\u00C2\u00B5sec': ['us', 1],
    microsecond: ['us', 1],
    sec: ['s', 1],
    second: ['s', 1],
    min: ['i', 1],
    minute: ['i', 1],
    hour: ['h', 1],
    day: ['d', 1],
    week: ['d', 7],
    fortnight: ['d', 14],
    forthnight: ['d', 14],
    month: ['m', 1],
    year: ['y', 1],
  };
  return units[singular];
}

/** Transcribes timelib_set_relative, which reads a unit and adds `amount` of it. */
function setRelative(token: Cursor, amount: number, behavior: number, state: ParsedTime, keepTime: boolean): void {
  const begin = token.p;
  while (token.p < token.s.length && !' ,\t;:/.-()'.includes(token.c())) token.p++;
  const unit = relativeUnit(token.s.slice(begin, token.p));
  if (!unit) return;
  const [field, multiplier] = unit;
  const relative = state.relative;
  if (field === 'weekday') {
    haveWeekdayRelative(state);
    if (!keepTime) unhaveTime(state);
    relative.d += (amount > 0 ? amount - 1 : amount) * 7;
    relative.weekday = multiplier;
    relative.weekdayBehavior = behavior;
  } else if (field === 'special') {
    state.haveRelative = true;
    if (!keepTime) unhaveTime(state);
    relative.special = { type: multiplier, amount };
  } else {
    relative[field] += amount * multiplier;
  }
}

function meridianAdjust(token: Cursor, hour: number): number {
  while (!'AaPp'.includes(token.c())) token.p++;
  const adjust = token.c() === 'a' || token.c() === 'A' ? (hour === 12 ? -12 : 0) : hour === 12 ? 0 : 12;
  token.p++;
  if (token.c() === '.') token.p++;
  if (token.c() === 'm' || token.c() === 'M') token.p++;
  if (token.c() === '.') token.p++;
  return adjust;
}

/** Transcribes timelib_parse_tz_cor: the seconds of an offset's digits, or undefined when they are malformed. */
// code-gauge-allow functionNcss -- Transcribes timelib_parse_tz_cor, one case per offset length.
function offsetDigits(token: Cursor): { seconds: number | undefined; outOfRange: boolean } {
  const begin = token.p;
  while (/[0-9:]/.test(token.c()) && token.p < token.s.length) token.p++;
  const text = token.s.slice(begin, token.p);
  const int = (from: number, to?: number): number => Number.parseInt(text.slice(from, to), 10) || 0;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  switch (text.length) {
    case 1:
    case 2: {
      hours = int(0);
      break;
    }
    case 3:
    case 4: {
      if (text[1] === ':') [hours, minutes] = [int(0, 1), int(2)];
      else if (text[2] === ':') [hours, minutes] = [int(0, 2), int(3)];
      else [hours, minutes] = [Math.trunc(int(0) / 100), int(0) % 100];
      break;
    }
    case 5: {
      if (text[2] !== ':') return { seconds: undefined, outOfRange: false };
      [hours, minutes] = [int(0, 2), int(3)];
      break;
    }
    case 6: {
      [hours, minutes, seconds] = [int(0, 2), int(2, 4), int(4)];
      break;
    }
    case 8: {
      if (text[2] !== ':' || text[5] !== ':') return { seconds: undefined, outOfRange: false };
      [hours, minutes, seconds] = [int(0, 2), int(3, 5), int(6)];
      break;
    }
    default: {
      return { seconds: undefined, outOfRange: false };
    }
  }
  return { seconds: hours * 3600 + minutes * 60 + seconds, outOfRange: minutes > 59 || seconds > 59 };
}

/** The result of timelib's parse_zone; `unknown` marks a word only PHP's abbreviation table could judge. */
export type ZoneParse =
  | { kind: 'zone'; zone: Zone; outOfRange: boolean }
  | { kind: 'notFound' }
  | { kind: 'unknownAbbreviation' };

/** Transcribes timelib's parse_zone, reading an offset, an abbreviation, or an identifier at the cursor. */
// code-gauge-allow functionCognitiveComplexity -- Transcribes timelib's parse_zone in its order of checks.
function parseZoneAt(token: Cursor): ZoneParse {
  let parens = 0;
  while (token.c() === ' ' || token.c() === '\t' || token.c() === '(') {
    if (token.c() === '(') parens++;
    token.p++;
  }
  if (/^GMT[+-]/.test(token.s.slice(token.p))) token.p += 3;
  let result: ZoneParse;
  if (token.c() === '+' || token.c() === '-') {
    const sign = token.c() === '-' ? -1 : 1;
    token.p++;
    const { seconds, outOfRange } = offsetDigits(token);
    result =
      seconds === undefined
        ? { kind: 'notFound' }
        : { kind: 'zone', zone: { type: 1, offset: sign * seconds }, outOfRange };
  } else {
    const begin = token.p;
    while (/[A-Za-z0-9/_+-]/.test(token.c()) && token.p < token.s.length) token.p++;
    result = zoneFromWord(token.s.slice(begin, token.p));
  }
  while (parens > 0 && token.c() === ')') {
    token.p++;
    parens--;
  }
  return result;
}

function zoneFromWord(word: string): ZoneParse {
  if (word.length < 6) {
    if (word === 'UTC') return { kind: 'zone', zone: { type: 3, id: 'UTC' }, outOfRange: false };
    const lower = word.toLowerCase();
    if (lower === 'utc' || lower === 'gmt' || lower === 'z')
      return { kind: 'zone', zone: { type: 2, abbr: word.toUpperCase(), offset: 0, dst: false }, outOfRange: false };
    if (/^[A-Za-z]+$/.test(word)) return { kind: 'unknownAbbreviation' };
  }
  return knownZoneId(word) ? { kind: 'zone', zone: { type: 3, id: word }, outOfRange: false } : { kind: 'notFound' };
}

/** Parses the time zone name DateTimeZone's constructor takes, as timezone_initialize does. */
export function parseZoneName(name: string): ZoneParse & { rest: string } {
  const token = new Cursor(name);
  const result = parseZoneAt(token);
  return { ...result, rest: name.slice(token.p) };
}

function scannerZone(state: ParsedTime, token: Cursor, position: number): void {
  const result = parseZoneAt(token);
  if (result.kind === 'zone') {
    state.zone = result.zone;
    if (result.outOfRange)
      state.warnings.push({ position, character: token.s[0], message: 'The parsed timezone offset was invalid' });
  } else if (result.kind === 'notFound') {
    addError(state, position, token.s, 'The timezone could not be found in the database');
  } else {
    state.unknownAbbreviation ??= position;
  }
}

/** Reads hours, minutes, seconds, and a fraction separated by `:` or `.`, as the 24-hour rules do. */
function readClock(token: Cursor, state: ParsedTime, fractionAfterColon: boolean): void {
  state.h = nr(token, 2);
  if (token.c() === ':' || token.c() === '.') {
    state.i = nr(token, 2);
    if (token.c() === ':' || token.c() === '.') {
      state.s = nr(token, 2);
      if (token.c() === '.' || (fractionAfterColon && token.c() === ':')) state.us = fraction(token);
    }
  }
}

// Rules ---------------------------------------------------------------------------------------------------------------

rule(words('yesterday'), (_token, state) => {
  state.haveRelative = true;
  unhaveTime(state);
  state.relative.d = -1;
});
rule(words('now'), () => {});
rule(words('noon'), (token, state, position) => {
  unhaveTime(state);
  haveTime(state, token, position);
  state.h = 12;
});
rule(words('midnight', 'today'), (_token, state) => unhaveTime(state));
rule(words('tomorrow'), (_token, state) => {
  state.haveRelative = true;
  unhaveTime(state);
  state.relative.d = 1;
});
const timestampAction =
  (withFraction: boolean): Action =>
  (token, state, position) => {
    state.haveRelative = true;
    state.haveDate = false;
    unhaveTime(state);
    haveZone(state, token, position);
    const negative = token.s[1] === '-';
    const seconds = signedNumber(state, token, 24, position);
    let us = 0;
    if (withFraction) {
      const begin = token.p;
      const digits = token.s.slice(begin + 1);
      us = digits ? Number(digits) * 10 ** (6 - digits.length) : 0;
      if (negative) us = -us;
    }
    Object.assign(state, { y: 1970, m: 1, d: 1, h: 0, i: 0, s: 0, us: 0 });
    state.relative.s += seconds;
    state.relative.us = us;
    state.zone = { type: 1, offset: 0 };
  };
rule('@-?[0-9]+', timestampAction(false));
rule(String.raw`@-?[0-9]+\.[0-9]{0,6}`, timestampAction(true));
rule(words('first day of', 'last day of'), (token, state) => {
  state.haveRelative = true;
  state.relative.firstLast = token.c() === 'l' || token.c() === 'L' ? 2 : 1;
});
rule(`${words('back of ', 'front of ')}${hour24}(?:${space}?${meridian})?`, () => {
  throw new UnsupportedDateString();
});
rule(
  `(?:${reltextnumber}|${reltexttext})${space}(?:${dayfulls}|${dayfull}|${dayabbr})${space}${words('of')}`,
  (token, state) => {
    state.haveRelative = true;
    const [amount, behavior] = relativeText(token);
    eatSpaces(token);
    if (amount > 0) {
      state.relative.special = { type: SPECIAL_DAY_OF_WEEK_IN_MONTH, amount: 0 };
      setRelative(token, amount, 1, state, false);
    } else {
      state.relative.special = { type: SPECIAL_LAST_DAY_OF_WEEK_IN_MONTH, amount: 0 };
      setRelative(token, amount, behavior, state, false);
    }
  }
);
rule(`(?:${timelong12}|${timeshort12}|${hour12}${space}?${meridian})`, (token, state, position) => {
  haveTime(state, token, position);
  state.h = nr(token, 2);
  if (token.c() === ':' || token.c() === '.') {
    state.i = nr(token, 2);
    if (token.c() === ':' || token.c() === '.') state.s = nr(token, 2);
  }
  eatSpaces(token);
  state.h = (state.h ?? 0) + meridianAdjust(token, state.h ?? 0);
});
rule(`${hour12}:${minutelz}:${secondlz}[:.][0-9]+${meridian}`, (token, state, position) => {
  haveTime(state, token, position);
  readClock(token, state, true);
  eatSpaces(token);
  state.h = (state.h ?? 0) + meridianAdjust(token, state.h ?? 0);
});
rule(`(?:${timelong24}${frac}|${timelong24}|${timeshort24}|[tT]${hour24})`, (token, state, position) => {
  haveTime(state, token, position);
  readClock(token, state, false);
});
rule(`[tT]?${hour24lz}${minutelz}`, (token, state, position) => {
  if (state.haveTime === 0) {
    state.h = nr(token, 2);
    state.i = nr(token, 2);
    state.s = 0;
  } else if (state.haveTime === 1) {
    state.y = nr(token, 4);
  } else {
    addError(state, position, token.s, 'Double time specification');
    return;
  }
  state.haveTime++;
});
rule(`[tT]?${hour24lz}${minutelz}${secondlz}`, (token, state, position) => {
  haveTime(state, token, position);
  state.h = nr(token, 2);
  state.i = nr(token, 2);
  state.s = nr(token, 2);
});
rule(`${month}/${day}(?:/${year})?`, (token, state, position) => {
  haveDate(state, token, position);
  state.m = nr(token, 2);
  state.d = nr(token, 2);
  if (token.c() === '/') state.y = processedYear(token, 4);
});
rule(
  `(?:[+-]?${year4}-${monthlz}-${daylz}|${year4}/${monthlz}/${daylz}/?|${year4}/${month}/${day})`,
  (token, state, position) => {
    haveDate(state, token, position);
    state.y = signedNumber(state, token, 4, position);
    state.m = nr(token, 2);
    state.d = nr(token, 2);
  }
);
rule(`${year2}-${monthlz}-${daylz}`, (token, state, position) => {
  haveDate(state, token, position);
  state.y = processedYear(token, 4);
  state.m = nr(token, 2);
  state.d = nr(token, 2);
});
rule(`[+-][0-9]{5,19}-${monthlz}-${daylz}`, (token, state, position) => {
  haveDate(state, token, position);
  state.y = signedNumber(state, token, 19, position);
  state.m = nr(token, 2);
  state.d = nr(token, 2);
});
rule(`${year4}-${month}`, (token, state, position) => {
  haveDate(state, token, position);
  state.y = processedYear(token, 4);
  state.m = nr(token, 2);
  state.d = 1;
});
rule(`${year}-${month}-${day}`, (token, state, position) => {
  haveDate(state, token, position);
  state.y = processedYear(token, 4);
  state.m = nr(token, 2);
  state.d = nr(token, 2);
});
rule(String.raw`${day}[ \t.-]*${monthtext}[ \t.-]*${year}`, (token, state, position) => {
  haveDate(state, token, position);
  state.d = nr(token, 2);
  skipDaySuffix(token);
  state.m = getMonth(token);
  state.y = processedYear(token, 4);
});
rule(String.raw`${day}[.\t-]${month}[.-]${year4}`, (token, state, position) => {
  haveDate(state, token, position);
  state.d = nr(token, 2);
  state.m = nr(token, 2);
  state.y = nr(token, 4);
});
rule(String.raw`${day}[.\t]${month}\.${year2}`, (token, state, position) => {
  haveDate(state, token, position);
  state.d = nr(token, 2);
  state.m = nr(token, 2);
  state.y = processedYear(token, 2);
});
rule(String.raw`${monthtext}[ .\t-]*${year4}`, (token, state, position) => {
  haveDate(state, token, position);
  state.m = getMonth(token);
  state.y = processedYear(token, 4);
  state.d = 1;
});
rule(String.raw`${year4}[ .\t-]*${monthtext}`, (token, state, position) => {
  haveDate(state, token, position);
  state.y = processedYear(token, 4);
  state.m = getMonth(token);
  state.d = 1;
});
rule(String.raw`(?:${monthtext}[ .\t-]*${day}[,.stndrh\t ]+${year}|${datenoyear})`, (token, state, position) => {
  haveDate(state, token, position);
  state.m = getMonth(token);
  state.d = nr(token, 2);
  state.y = processedYear(token, 4);
});
rule(String.raw`${day}[ .\t-]*${monthtext}`, (token, state, position) => {
  haveDate(state, token, position);
  state.d = nr(token, 2);
  skipDaySuffix(token);
  state.m = getMonth(token);
});
rule(`${year4}${monthlz}${daylz}`, (token, state, position) => {
  haveDate(state, token, position);
  state.y = nr(token, 4);
  state.m = nr(token, 2);
  state.d = nr(token, 2);
});
rule(
  [
    `${year4}-${monthlz}-${daylz}T${hour24lz}:${minutelz}:${secondlz}${frac}(?:${tzcorrection})?`,
    `${year4}${monthlz}${daylz}T${hour24}:${minutelz}:${secondlz}`,
    `${year4}${monthlz}${daylz}[tT]${hour24}${minutelz}${secondlz}`,
    `${year4}-${month}-${day}T${hour24}:${minute}:${second}`,
    `${year4}:${monthlz}:${daylz} ${hour24lz}:${minutelz}:${secondlz}`,
  ].join('|'),
  (token, state, position) => {
    haveTime(state, token, position);
    haveDate(state, token, position);
    state.y = nr(token, 4);
    state.m = nr(token, 2);
    state.d = nr(token, 2);
    state.h = nr(token, 2);
    state.i = nr(token, 2);
    state.s = nr(token, 2);
    if (token.c() === '.') {
      state.us = fraction(token);
      if (token.p < token.s.length) scannerZone(state, token, position);
    }
  }
);
rule(`${year4}[.-]?${dayofyear}`, (token, state, position) => {
  haveDate(state, token, position);
  state.y = processedYear(token, 4);
  state.d = nr(token, 3);
  state.m = 1;
});
rule(`${year4}-?W${weekofyear}(?:-?[0-7])?`, (token, state, position) => {
  haveDate(state, token, position);
  state.haveRelative = true;
  state.y = nr(token, 4);
  const week = nr(token, 2) ?? 1;
  const weekday = nr(token, 1) ?? 1;
  state.m = 1;
  state.d = 1;
  state.relative.d = dayFromIsoWeek(state.y ?? 0, week, weekday);
});
rule(`${monthabbr}-${daylz}-${year}`, (token, state, position) => {
  haveDate(state, token, position);
  state.m = getMonth(token);
  state.d = nr(token, 2);
  state.y = processedYear(token, 4);
});
rule(`${year}-${monthabbr}-${daylz}`, (token, state, position) => {
  haveDate(state, token, position);
  state.y = processedYear(token, 4);
  state.m = getMonth(token);
  state.d = nr(token, 2);
});
rule(
  `${day}/${monthabbr}/${year4}:${hour24lz}:${minutelz}:${secondlz}${space}${tzcorrection}`,
  (token, state, position) => {
    haveTime(state, token, position);
    haveDate(state, token, position);
    state.d = nr(token, 2);
    state.m = getMonth(token);
    state.y = nr(token, 4);
    state.h = nr(token, 2);
    state.i = nr(token, 2);
    state.s = nr(token, 2);
    eatSpaces(token);
    scannerZone(state, token, position);
  }
);
rule(year4, (token, state) => {
  state.y = nr(token, 4);
});
rule(words('ago'), (_token, state) => {
  const relative = state.relative;
  for (const field of ['y', 'm', 'd', 'h', 'i', 's'] as const) relative[field] = -relative[field];
  relative.weekday = -relative.weekday;
  if (relative.weekday === 0) relative.weekday = -7;
  if (relative.special?.type === SPECIAL_WEEKDAY) relative.special.amount = -relative.special.amount;
});
rule(daytext, (token, state) => {
  haveWeekdayRelative(state);
  unhaveTime(state);
  state.relative.weekday = relativeUnit(token.s)?.[1] ?? 0;
  if (state.relative.weekdayBehavior !== 2) state.relative.weekdayBehavior = 1;
});
rule(`${reltexttext}${space}${words('week')}`, (token, state) => {
  state.haveRelative = true;
  while (token.p < token.s.length) {
    const [amount, behavior] = relativeText(token);
    eatSpaces(token);
    setRelative(token, amount, behavior, state, false);
    state.relative.weekdayBehavior = 2;
    if (!state.relative.haveWeekday) {
      haveWeekdayRelative(state);
      state.relative.weekday = 1;
    }
  }
});
rule(`(?:${reltextnumber}|${reltexttext})${space}${reltextunit}`, (token, state) => {
  state.haveRelative = true;
  while (token.p < token.s.length) {
    const [amount, behavior] = relativeText(token);
    eatSpaces(token);
    setRelative(token, amount, behavior, state, false);
  }
});
rule(`(?:${monthfull}|${monthabbr})`, (token, state, position) => {
  haveDate(state, token, position);
  state.m = lookupMonth(token);
});
rule(`(?:${tzcorrection}|${tz})`, (token, state, position) => {
  haveZone(state, token, position);
  eatSpaces(token);
  scannerZone(state, token, position);
});
rule(`${datenoyear}(?:${timelong12}|${timeshort12})`, (token, state, position) => {
  haveDate(state, token, position);
  state.m = getMonth(token);
  state.d = nr(token, 2);
  haveTime(state, token, position);
  readClock(token, state, false);
  state.h = (state.h ?? 0) + meridianAdjust(token, state.h ?? 0);
});
rule(`${datenoyear}(?:${iso8601normtz}|${timelong24}|${timeshort24})`, (token, state, position) => {
  haveDate(state, token, position);
  state.m = getMonth(token);
  state.d = nr(token, 2);
  haveTime(state, token, position);
  state.h = nr(token, 2);
  state.i = nr(token, 2);
  if (token.c() === ':') {
    state.s = nr(token, 2);
    if (token.c() === '.') state.us = fraction(token);
  }
  if (token.p < token.s.length && token.c() !== '\0') scannerZone(state, token, position);
});
rule(`[+-]*[ \\t]*[0-9]{1,13}${space}?(?:${reltextunit}|${words('week')})`, (token, state, position) => {
  state.haveRelative = true;
  while (token.p < token.s.length) {
    const amount = signedNumber(state, token, 24, position);
    eatSpaces(token);
    setRelative(token, amount, 1, state, true);
  }
});
rule(`[.,]|${space}|[\\0\\n]`, () => {});

/** Input that PHP accepts but this grader does not interpret. */
export class UnsupportedDateString extends Error {}

/** Transcribes timelib_strtotime, the scanner behind strtotime, `new DateTime`, and `modify`. */
// code-gauge-allow functionCognitiveComplexity -- Runs the scanner as timelib_strtotime does, picking the longest rule at each position.
export function parseDateString(input: string): ParsedTime {
  const state: ParsedTime = {
    haveTime: 0,
    haveDate: false,
    haveZone: 0,
    haveRelative: false,
    relative: emptyRelative(),
    errors: [],
    warnings: [],
  };
  const text = input.replace(/^[ \t\n\v\f\r]+/, '').replace(/[ \t\n\v\f\r]+$/, '');
  if (text === '') {
    state.errors.push({ position: 0, character: '\0', message: 'Empty string' });
    return state;
  }
  const padded = `${text}\0`;
  let position = 0;
  while (position < text.length) {
    let best: [number, Action] | undefined;
    for (const [pattern, action] of RULES) {
      pattern.lastIndex = position;
      const match = pattern.exec(padded);
      if (match && match[0].length > 0 && (!best || match[0].length > best[0])) best = [match[0].length, action];
    }
    if (!best) {
      state.errors.push({ position, character: text[position], message: 'Unexpected character' });
      position++;
      continue;
    }
    const token = padded.slice(position, position + best[0]).replace(/\0$/, '');
    try {
      best[1](new Cursor(token), state, position);
    } catch (error) {
      if (!(error instanceof ScanAbort)) throw error;
    }
    position += best[0];
  }
  if (state.haveTime && !isValidTime(state.h ?? 0, state.i ?? 0, state.s ?? 0))
    state.warnings.push({ position: text.length, character: '\0', message: 'The parsed time was invalid' });
  if (state.haveDate && !isValidDate(state.y ?? 0, state.m ?? 0, state.d ?? 0))
    state.warnings.push({ position: text.length, character: '\0', message: 'The parsed date was invalid' });
  return state;
}
