// `strftime` and `strptime` of the `time` and `datetime` modules in the C locale, as CPython 3.14 on macOS formats and
// parses them (CPython hands most directives to the C library's strftime, whose extensions differ by platform).
import { daysInMonth, fromIsoCalendar, fromOrdinal, isLeap, isoCalendar, toOrdinal } from './calendarMath';
import { FLAG } from './re/constants';
import { compileRegex } from './re/pattern';

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MONTH_NAMES = [
  '',
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

/** The fields of a C `struct tm`, with the year in full and Monday as weekday 0, plus what Python adds. */
export interface TimeFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Monday is 0. */
  weekday: number;
  /** January 1st is 1. */
  yearDay: number;
  /** The text of `%z` and `%:z`, which datetime objects format themselves. */
  offset?: { plain: string; colon: string };
  /** The text of `%Z`. */
  zone?: string;
  microsecond?: number;
  /** The seconds since the epoch of `%s`, or undefined when the C library's mktime fails. */
  epoch?: number;
}

const pad = (value: number, width: number, fill = '0'): string => String(value).padStart(width, fill);

/** The padding a flag (`-`, `_`, `0`) asks for, of the numeric conversions that honor one. */
type Padding = '' | '-' | '_' | '0';

/** Formats `fields` as `strftime(format)` does. */
export function strftime(format: string, fields: TimeFields): string {
  // oxlint-disable-next-line typescript/no-misused-spread -- strftime reads code points, as CPython's str does.
  const chars = [...format];
  let output = '';
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (char !== '%') {
      output += char;
      continue;
    }
    let padding: Padding = '';
    let next = index + 1;
    while (next < chars.length && '-_0EO'.includes(chars[next])) {
      if ('-_0'.includes(chars[next])) padding = chars[next] as Padding;
      next++;
    }
    if (next >= chars.length) {
      output += chars[next - 1];
      index = next - 1;
      continue;
    }
    const plain = next === index + 1;
    output += conversion(chars[next], fields, padding, plain, chars[next + 1]);
    if (plain && chars[next] === ':' && chars[next + 1] === 'z') next++;
    index = next;
  }
  return output;
}

const hour12 = (fields: TimeFields): number => (fields.hour % 12 === 0 ? 12 : fields.hour % 12);
const sundayWeekday = (fields: TimeFields): number => (fields.weekday + 1) % 7;
const isoFields = (fields: TimeFields): [number, number, number] => isoCalendar(fields.year, fields.month, fields.day);

/** The numeric directives: their value, width, and the fill that a padding flag may replace. */
const NUMERIC: Record<string, [(fields: TimeFields) => number, number, string]> = {
  C: [(fields) => Math.floor(fields.year / 100), 2, '0'],
  d: [(fields) => fields.day, 2, '0'],
  e: [(fields) => fields.day, 2, ' '],
  g: [(fields) => isoFields(fields)[0] % 100, 2, '0'],
  H: [(fields) => fields.hour, 2, '0'],
  I: [hour12, 2, '0'],
  j: [(fields) => fields.yearDay, 3, '0'],
  k: [(fields) => fields.hour, 2, ' '],
  l: [hour12, 2, ' '],
  m: [(fields) => fields.month, 2, '0'],
  M: [(fields) => fields.minute, 2, '0'],
  S: [(fields) => fields.second, 2, '0'],
  U: [(fields) => Math.floor((fields.yearDay - 1 + 7 - sundayWeekday(fields)) / 7), 2, '0'],
  V: [(fields) => isoFields(fields)[1], 2, '0'],
  W: [(fields) => Math.floor((fields.yearDay - 1 + 7 - fields.weekday) / 7), 2, '0'],
  y: [(fields) => ((fields.year % 100) + 100) % 100, 2, '0'],
};

/** The directives that the C library expands into other directives. */
const EXPANSIONS: Record<string, string> = {
  c: '%a %b %e %H:%M:%S %Y',
  D: '%m/%d/%y',
  x: '%m/%d/%y',
  r: '%I:%M:%S %p',
  R: '%H:%M',
  T: '%H:%M:%S',
  X: '%H:%M:%S',
  v: '%e-%b-%Y',
};

const TEXT: Record<string, (fields: TimeFields) => string> = {
  a: (fields) => DAY_NAMES[fields.weekday].slice(0, 3),
  A: (fields) => DAY_NAMES[fields.weekday],
  b: (fields) => MONTH_NAMES[fields.month].slice(0, 3),
  h: (fields) => MONTH_NAMES[fields.month].slice(0, 3),
  B: (fields) => MONTH_NAMES[fields.month],
  '+': (fields) => `${strftime('%a %b %e %H:%M:%S', fields)} ${fields.zone ?? ''} ${strftime('%Y', fields)}`,
  F: (fields) => `${pad(fields.year, 4)}-${pad(fields.month, 2)}-${pad(fields.day, 2)}`,
  G: (fields) => pad(isoFields(fields)[0], 4),
  n: () => '\n',
  t: () => '\t',
  p: (fields) => (fields.hour < 12 ? 'AM' : 'PM'),
  s: (fields) => (fields.epoch === undefined ? '-1' : String(fields.epoch)),
  u: (fields) => String(fields.weekday + 1),
  w: (fields) => String(sundayWeekday(fields)),
  Y: (fields) => pad(fields.year, 4),
  Z: (fields) => fields.zone ?? '',
};

function padded(value: number, width: number, fill: string, padding: Padding): string {
  if (padding === '-') return String(value);
  if (padding === '_') return pad(value, width, ' ');
  if (padding === '0') return pad(value, width, '0');
  return pad(value, width, fill);
}

/**
 * One directive. `plain` tells that no flag came between `%` and it: CPython replaces `%f`, `%z`, and `%:z` itself only
 * then, and hands the rest to the C library.
 */
function conversion(char: string, fields: TimeFields, padding: Padding, plain: boolean, following?: string): string {
  const numeric = NUMERIC[char];
  if (numeric) return padded(numeric[0](fields), numeric[1], numeric[2], padding);
  const expansion = EXPANSIONS[char];
  if (expansion) return strftime(expansion, fields);
  const text = TEXT[char];
  if (text) return text(fields);
  if (char === 'f') return plain && fields.microsecond !== undefined ? pad(fields.microsecond, 6) : 'f';
  if (char === 'z') return plain ? (fields.offset?.plain ?? '') : 'z';
  if (char === ':' && plain && following === 'z') return fields.offset?.colon ?? '';
  return char;
}

// strptime ----------------------------------------------------------------------------------------------------------

/** What `strptime` reads from a string, as CPython's `_strptime._strptime` returns it. */
export interface ParsedTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  yearDay: number;
  /** -1 when unknown, 0 when the zone is standard time. */
  isDst: number;
  zone?: string;
  /** The UTC offset in seconds, when the string had one. */
  gmtoff?: number;
  fraction: number;
  gmtoffFraction: number;
}

const DIRECTIVES: Record<string, string> = {
  d: String.raw`(?<d>3[0-1]|[1-2]\d|0[1-9]|[1-9]| [1-9])`,
  f: String.raw`(?<f>[0-9]{1,6})`,
  H: String.raw`(?<H>2[0-3]|[0-1]\d|\d| \d)`,
  k: String.raw`(?<H>2[0-3]|[0-1]\d|\d| \d)`,
  I: String.raw`(?<I>1[0-2]|0[1-9]|[1-9]| [1-9])`,
  l: String.raw`(?<I>1[0-2]|0[1-9]|[1-9]| [1-9])`,
  G: String.raw`(?<G>\d\d\d\d)`,
  j: String.raw`(?<j>36[0-6]|3[0-5]\d|[1-2]\d\d|0[1-9]\d|00[1-9]|[1-9]\d|0[1-9]|[1-9])`,
  m: String.raw`(?<m>1[0-2]|0[1-9]|[1-9])`,
  M: String.raw`(?<M>[0-5]\d|\d)`,
  S: String.raw`(?<S>6[0-1]|[0-5]\d|\d)`,
  U: String.raw`(?<U>5[0-3]|[0-4]\d|\d)`,
  W: String.raw`(?<W>5[0-3]|[0-4]\d|\d)`,
  w: String.raw`(?<w>[0-6])`,
  u: String.raw`(?<u>[1-7])`,
  V: String.raw`(?<V>5[0-3]|0[1-9]|[1-4]\d|\d)`,
  y: String.raw`(?<y>\d\d)`,
  Y: String.raw`(?<Y>\d\d\d\d)`,
  z: String.raw`(?<z>[+-]\d\d:?[0-5]\d(:?[0-5]\d(\.\d{1,6})?)?|Z)`,
  A: '(?<A>wednesday|thursday|saturday|tuesday|monday|friday|sunday)',
  a: '(?<a>mon|tue|wed|thu|fri|sat|sun)',
  B: '(?<B>september|february|november|december|january|october|august|march|april|june|july|may)',
  b: '(?<b>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)',
  p: '(?<p>am|pm)',
  P: '(?<p>am|pm)',
  Op: '(?<p>am|pm)',
  Z: '(?<Z>utc|gmt|jst)',
  '%': '%',
};
for (const key of ['Od', 'Om', 'Ow', 'Oy', 'OC', 'OH', 'OI', 'OM', 'OS', 'Oe']) DIRECTIVES[key] = '';
DIRECTIVES.e = DIRECTIVES.d;
DIRECTIVES.T = expand('%H:%M:%S');
DIRECTIVES.R = expand('%H:%M');
DIRECTIVES.r = expand('%I:%M:%S %p');
DIRECTIVES.X = expand('%H:%M:%S');
DIRECTIVES.x = expand('%m/%d/%y');
DIRECTIVES.c = expand('%a %b %d %H:%M:%S %Y');

const FULL_DAYS = DAY_NAMES.map((name) => name.toLowerCase());
const FULL_MONTHS = MONTH_NAMES.map((name) => name.toLowerCase());

/** The regular expression `TimeRE.pattern` builds for a format, throwing the KeyError's directive for a bad one. */
function expand(format: string): string {
  const escaped = format
    .replaceAll(/([\\.^$*+?(){}[\]|])/g, String.raw`\$1`)
    .replaceAll(/\s+/g, String.raw`\s+`)
    .replaceAll("'", "['ʼ]");
  return escaped.replaceAll(/%[-_0^#]*[0-9]*([OE]?\\?.?)/gs, (_, directive: string) => {
    const pattern = DIRECTIVES[directive];
    if (pattern === undefined) throw new BadDirective(directive);
    return pattern;
  });
}

class BadDirective extends Error {
  constructor(readonly directive: string) {
    super('bad directive');
  }
}

/** The ValueError message or the result of parsing `text` with `format`. */
export function strptime(text: string, format: string): ParsedTime | { error: string } {
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^(?:${expand(format)})`, 'iu');
  } catch (error) {
    if (error instanceof BadDirective) {
      const directive = error.directive.replace(String.raw`\s`, '');
      if (directive === '') return { error: `stray % in format '${format}'` };
      return { error: `'${directive.replace('\\', '')}' is a bad directive in format '${format}'` };
    }
    // A directive repeated defines a group twice, which CPython's `re` rejects with its PatternError.
    const cpythonPattern = expand(format)
      .replaceAll('(?<', '(?P<')
      .replace('(?P<Z>utc|gmt|jst)', '(?P<Z>jst|gmt|utc)')
      .replaceAll(String.raw`(\.\d{1,6})?)?|Z)`, String.raw`(\.\d{1,6})?)?|(?-i:Z))`);
    compileRegex(cpythonPattern, FLAG.IGNORECASE);
    throw error;
  }
  const found = pattern.exec(text);
  if (!found || found.groups?.z === 'z') {
    return { error: `time data ${quote(text)} does not match format ${quote(format)}` };
  }
  if (found[0].length !== text.length) return { error: `unconverted data remains: ${text.slice(found[0].length)}` };
  const groups = Object.fromEntries(
    Object.entries(found.groups ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return computeTime(groups);
}

/** A Python repr of a str, enough for the messages of strptime. */
function quote(text: string): string {
  return text.includes("'") && !text.includes('"')
    ? `"${text}"`
    : `'${text.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`)}'`;
}

interface Fields {
  isoYear?: number;
  year?: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  fraction: number;
  gmtoff?: number;
  gmtoffFraction: number;
  isoWeek?: number;
  weekOfYear?: number;
  weekStartsMonday?: boolean;
  weekday?: number;
  julian?: number;
  isDst: number;
}

/** How each group of the pattern sets the fields, as CPython's `_strptime` reads them one by one. */
const GROUP_READERS: Record<string, (fields: Fields, value: string, groups: Record<string, string>) => string | void> =
  {
    y: (fields, value) => {
      const year = Number(value);
      fields.year = year <= 68 ? year + 2000 : year + 1900;
    },
    Y: (fields, value) => {
      fields.year = Number(value);
    },
    G: (fields, value) => {
      fields.isoYear = Number(value);
    },
    m: (fields, value) => {
      fields.month = Number(value);
    },
    B: (fields, value) => {
      fields.month = FULL_MONTHS.findIndex((name) => name.startsWith(value.toLowerCase()));
    },
    d: (fields, value) => {
      fields.day = Number(value);
    },
    H: (fields, value) => {
      fields.hour = Number(value);
    },
    I: (fields, value, groups) => {
      const hour = Number(value);
      const ampm = (groups.p ?? '').toLowerCase();
      if (ampm === '' || ampm === 'am') fields.hour = hour === 12 ? 0 : hour;
      else fields.hour = hour === 12 ? hour : hour + 12;
    },
    M: (fields, value) => {
      fields.minute = Number(value);
    },
    S: (fields, value) => {
      fields.second = Number(value);
    },
    f: (fields, value) => {
      fields.fraction = Number(value.padEnd(6, '0'));
    },
    A: (fields, value) => {
      fields.weekday = FULL_DAYS.findIndex((name) => name.startsWith(value.toLowerCase()));
    },
    w: (fields, value) => {
      const weekday = Number(value);
      fields.weekday = weekday === 0 ? 6 : weekday - 1;
    },
    u: (fields, value) => {
      fields.weekday = Number(value) - 1;
    },
    j: (fields, value) => {
      fields.julian = Number(value);
    },
    U: (fields, value) => {
      fields.weekOfYear = Number(value);
      fields.weekStartsMonday = false;
    },
    W: (fields, value) => {
      fields.weekOfYear = Number(value);
      fields.weekStartsMonday = true;
    },
    V: (fields, value) => {
      fields.isoWeek = Number(value);
    },
    z: (fields, value) => readOffset(value, fields),
    Z: (fields) => {
      fields.isDst = 0;
    },
  };
GROUP_READERS.b = GROUP_READERS.B;
GROUP_READERS.a = GROUP_READERS.A;

function readGroups(groups: Record<string, string>): Fields | { error: string } {
  const fields: Fields = { month: 1, day: 1, hour: 0, minute: 0, second: 0, fraction: 0, gmtoffFraction: 0, isDst: -1 };
  for (const [key, value] of Object.entries(groups)) {
    const error = GROUP_READERS[key]?.(fields, value, groups);
    if (error) return { error };
  }
  return fields;
}

function readOffset(found: string, fields: Fields): string | undefined {
  if (found === 'Z') {
    fields.gmtoff = 0;
    return undefined;
  }
  let z = found;
  if (z[3] === ':') {
    z = z.slice(0, 3) + z.slice(4);
    if (z.length > 5) {
      if (z[5] !== ':') return `Inconsistent use of : in ${found}`;
      z = z.slice(0, 5) + z.slice(6);
    }
  }
  const seconds = Number(z.slice(1, 3)) * 3600 + Number(z.slice(3, 5)) * 60 + Number(z.slice(5, 7) || '0');
  const fraction = Number(z.slice(8).padEnd(6, '0'));
  const sign = z.startsWith('-') ? -1 : 1;
  fields.gmtoff = sign * seconds;
  fields.gmtoffFraction = sign * fraction;
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity 26 -- Follows how CPython's _strptime completes the date.
// code-gauge-allow functionNcss 33 -- Follows how CPython's _strptime completes the date.
function computeTime(groups: Record<string, string>): ParsedTime | { error: string } {
  const fields = readGroups(groups);
  if ('error' in fields) return fields;
  const error = isoDirectiveError(fields);
  if (error) return { error };
  const { julian: givenJulian, weekday: givenWeekday } = fields;
  let year = fields.year ?? (fields.month === 2 && fields.day === 29 ? 1904 : 1900);
  const leapYearFix = fields.year === undefined && fields.month === 2 && fields.day === 29;
  let { month, day } = fields;
  let julian = givenJulian;
  if (julian === undefined && givenWeekday !== undefined) {
    if (fields.weekOfYear !== undefined) {
      julian = julianFromWeek(year, fields.weekOfYear, givenWeekday, fields.weekStartsMonday === true);
    } else if (fields.isoYear !== undefined && fields.isoWeek !== undefined) {
      const date = fromIsoCalendar(fields.isoYear, fields.isoWeek, givenWeekday + 1);
      if (typeof date === 'string') return { error: date };
      [year, month, day] = date;
    }
    if (julian !== undefined && julian <= 0) {
      year--;
      julian += isLeap(year) ? 366 : 365;
    }
  }
  const dateError = checkDate(year, julian === undefined ? month : 1, julian === undefined ? day : 1);
  if (dateError) return { error: dateError };
  if (julian === undefined) {
    julian = toOrdinal(year, month, day) - toOrdinal(year, 1, 1) + 1;
  } else {
    [year, month, day] = fromOrdinal(julian - 1 + toOrdinal(year, 1, 1));
  }
  const weekday = givenWeekday ?? (toOrdinal(year, month, day) + 6) % 7;
  return {
    year: leapYearFix ? 1900 : year,
    month,
    day,
    hour: fields.hour,
    minute: fields.minute,
    second: fields.second,
    weekday,
    yearDay: julian,
    isDst: fields.isDst,
    zone: groups.Z,
    gmtoff: fields.gmtoff,
    fraction: fields.fraction,
    gmtoffFraction: fields.gmtoffFraction,
  };
}

function isoDirectiveError(fields: Fields): string | undefined {
  if (fields.isoYear !== undefined) {
    if (fields.julian !== undefined) {
      return "Day of the year directive '%j' is not compatible with ISO year directive '%G'. Use '%Y' instead.";
    }
    if (fields.isoWeek === undefined || fields.weekday === undefined) {
      return "ISO year directive '%G' must be used with the ISO week directive '%V' and a weekday directive ('%A', '%a', '%w', or '%u').";
    }
  } else if (fields.isoWeek !== undefined) {
    if (fields.year === undefined || fields.weekday === undefined) {
      return "ISO week directive '%V' must be used with the ISO year directive '%G' and a weekday directive ('%A', '%a', '%w', or '%u').";
    }
    return "ISO week directive '%V' is incompatible with the year directive '%Y'. Use the ISO year '%G' instead.";
  }
  return undefined;
}

function julianFromWeek(year: number, week: number, weekday: number, mondayFirst: boolean): number {
  let firstWeekday = (toOrdinal(year, 1, 1) + 6) % 7;
  let dayOfWeek = weekday;
  if (!mondayFirst) {
    firstWeekday = (firstWeekday + 1) % 7;
    dayOfWeek = (dayOfWeek + 1) % 7;
  }
  const week0Length = (7 - firstWeekday) % 7;
  if (week === 0) return 1 + dayOfWeek - firstWeekday;
  return 1 + week0Length + 7 * (week - 1) + dayOfWeek;
}

function checkDate(year: number, month: number, day: number): string | undefined {
  if (year < 1 || year > 9999) return `year must be in 1..9999, not ${year}`;
  if (day < 1 || day > daysInMonth(year, month)) {
    return `day ${day} must be in range 1..${daysInMonth(year, month)} for month ${month} in year ${year}`;
  }
  return undefined;
}
