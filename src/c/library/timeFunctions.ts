import type { Value } from '../arith';
import type { NativeFunction, Runtime } from '../runtime';
import { asAddress, asSize, cString, readBytes, readCString, writeBytes } from './support';

/**
 * The time every run sees: 2026-01-01 00:00:00 UTC. A real program sees the moment it runs, which a trace cannot
 * reproduce, so a fixed time keeps runs repeatable (`srand(time(NULL))` included).
 */
export const FIXED_TIME = 1_767_225_600n;

/** The layout of macOS's `struct tm`: nine ints, then `long tm_gmtoff` and `char *tm_zone`. */
const TM_SIZE = 56;
const GMTOFF_OFFSET = 40;
const ZONE_OFFSET = 48;

interface BrokenDown {
  second: number;
  minute: number;
  hour: number;
  day: number;
  month: number;
  year: number;
  weekday: number;
  yearDay: number;
}

const DAY = 86_400;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
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

/** Breaks a time into its UTC calendar fields, which `localtime` gives too since a run's time zone is UTC. */
function breakDown(time: number): BrokenDown {
  const days = Math.floor(time / DAY);
  const seconds = time - days * DAY;
  const date = new Date(days * DAY * 1000);
  const year = date.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1) / 1000 / DAY;
  return {
    second: seconds % 60,
    minute: Math.floor(seconds / 60) % 60,
    hour: Math.floor(seconds / 3600),
    day: date.getUTCDate(),
    month: date.getUTCMonth(),
    year: year - 1900,
    weekday: (((days + 4) % 7) + 7) % 7,
    yearDay: days - yearStart,
  };
}

function readTm(runtime: Runtime, address: number): BrokenDown {
  const field = (index: number): number =>
    new DataView(readBytes(runtime, address + index * 4, 4).buffer).getInt32(0, true);
  return {
    get second() {
      return field(0);
    },
    get minute() {
      return field(1);
    },
    get hour() {
      return field(2);
    },
    get day() {
      return field(3);
    },
    get month() {
      return field(4);
    },
    get year() {
      return field(5);
    },
    get weekday() {
      return field(6);
    },
    get yearDay() {
      return field(7);
    },
  };
}

function writeTm(runtime: Runtime, address: number, fields: BrokenDown): void {
  const bytes = new Uint8Array(TM_SIZE);
  const view = new DataView(bytes.buffer);
  const values = [
    fields.second,
    fields.minute,
    fields.hour,
    fields.day,
    fields.month,
    fields.year,
    fields.weekday,
    fields.yearDay,
    0,
  ];
  for (const [index, value] of values.entries()) view.setInt32(index * 4, value, true);
  view.setBigInt64(GMTOFF_OFFSET, 0n, true);
  const zone = runtime.stringLiteral(cString('UTC')).base;
  view.setUint32(ZONE_OFFSET, zone % 2 ** 32, true);
  view.setUint32(ZONE_OFFSET + 4, Math.floor(zone / 2 ** 32), true);
  writeBytes(runtime, address, bytes);
}

/** The seconds since the epoch of calendar fields, normalizing out-of-range fields as `mktime` does. */
function toTime(fields: BrokenDown): number {
  return Date.UTC(fields.year + 1900, fields.month, fields.day, fields.hour, fields.minute, fields.second) / 1000;
}

/** The static `struct tm` and string that `localtime`, `gmtime`, `asctime`, and `ctime` return, as libc's are. */
function staticBlock(runtime: Runtime, key: keyof Runtime['timeBuffers'], size: number): number {
  let block = runtime.timeBuffers[key];
  if (!block) {
    block = runtime.allocate(size, 'data');
    runtime.timeBuffers[key] = block;
  }
  return block.base;
}

function pad(value: number, width: number, filler = '0'): string {
  return String(value).padStart(width, filler);
}

function asctimeText(fields: BrokenDown): string {
  return `${WEEKDAYS[fields.weekday]?.slice(0, 3) ?? '???'} ${MONTHS[fields.month]?.slice(0, 3) ?? '???'} ${pad(fields.day, 2, ' ')} ${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)} ${fields.year + 1900}\n`;
}

/** The ISO 8601 week-based year and week of a date, which `%G`, `%g`, and `%V` show. */
function isoWeek(fields: BrokenDown): { year: number; week: number } {
  const year = fields.year + 1900;
  const weekday = (fields.weekday + 6) % 7;
  const thursday = fields.yearDay - weekday + 3;
  if (thursday < 0) {
    const previousDays = (year - 1) % 4 === 0 && ((year - 1) % 100 !== 0 || (year - 1) % 400 === 0) ? 366 : 365;
    return isoWeek({ ...fields, year: fields.year - 1, yearDay: fields.yearDay + previousDays });
  }
  const days = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365;
  if (thursday >= days) return { year: year + 1, week: 1 };
  return { year, week: Math.floor(thursday / 7) + 1 };
}

/** The `strftime` conversions in the C locale; this interpreter leaves any other one as it is. */
const CONVERSIONS: Record<string, (fields: BrokenDown) => string> = {
  a: (fields) => WEEKDAYS[fields.weekday]?.slice(0, 3) ?? '?',
  A: (fields) => WEEKDAYS[fields.weekday] ?? '?',
  b: (fields) => MONTHS[fields.month]?.slice(0, 3) ?? '?',
  h: (fields) => MONTHS[fields.month]?.slice(0, 3) ?? '?',
  B: (fields) => MONTHS[fields.month] ?? '?',
  c: (fields) => asctimeText(fields).trimEnd(),
  C: (fields) => pad(Math.floor((fields.year + 1900) / 100), 2),
  d: (fields) => pad(fields.day, 2),
  D: (fields) => monthDayYear(fields),
  x: (fields) => monthDayYear(fields),
  e: (fields) => pad(fields.day, 2, ' '),
  F: (fields) => `${fields.year + 1900}-${pad(fields.month + 1, 2)}-${pad(fields.day, 2)}`,
  g: (fields) => pad(isoWeek(fields).year % 100, 2),
  G: (fields) => String(isoWeek(fields).year),
  H: (fields) => pad(fields.hour, 2),
  I: (fields) => pad(hour12(fields), 2),
  j: (fields) => pad(fields.yearDay + 1, 3),
  k: (fields) => pad(fields.hour, 2, ' '),
  l: (fields) => pad(hour12(fields), 2, ' '),
  m: (fields) => pad(fields.month + 1, 2),
  M: (fields) => pad(fields.minute, 2),
  n: () => '\n',
  p: (fields) => (fields.hour < 12 ? 'AM' : 'PM'),
  r: (fields) =>
    `${pad(hour12(fields), 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)} ${fields.hour < 12 ? 'AM' : 'PM'}`,
  R: (fields) => `${pad(fields.hour, 2)}:${pad(fields.minute, 2)}`,
  s: (fields) => String(toTime(fields)),
  S: (fields) => pad(fields.second, 2),
  t: () => '\t',
  T: (fields) => hourMinuteSecond(fields),
  X: (fields) => hourMinuteSecond(fields),
  u: (fields) => String(fields.weekday === 0 ? 7 : fields.weekday),
  U: (fields) => pad(Math.floor((fields.yearDay + 7 - fields.weekday) / 7), 2),
  V: (fields) => pad(isoWeek(fields).week, 2),
  w: (fields) => String(fields.weekday),
  W: (fields) => pad(Math.floor((fields.yearDay + 7 - ((fields.weekday + 6) % 7)) / 7), 2),
  y: (fields) => pad((fields.year + 1900) % 100, 2),
  Y: (fields) => String(fields.year + 1900),
  z: () => '+0000',
  Z: () => 'UTC',
  '%': () => '%',
};

function hour12(fields: BrokenDown): number {
  return fields.hour % 12 === 0 ? 12 : fields.hour % 12;
}

function monthDayYear(fields: BrokenDown): string {
  return `${pad(fields.month + 1, 2)}/${pad(fields.day, 2)}/${pad((fields.year + 1900) % 100, 2)}`;
}

function hourMinuteSecond(fields: BrokenDown): string {
  return `${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)}`;
}

function strftime(format: string, fields: BrokenDown): string {
  let text = '';
  for (let index = 0; index < format.length; index++) {
    const char = format[index];
    if (char !== '%' || index + 1 >= format.length) {
      text += char;
      continue;
    }
    const letter = format[++index];
    text += CONVERSIONS[letter]?.(fields) ?? `%${letter}`;
  }
  return text;
}

function timeArgument(runtime: Runtime, value: Value | undefined): number {
  const bytes = readBytes(runtime, asAddress(value), 8);
  return Number(new DataView(bytes.buffer).getBigInt64(0, true));
}

function brokenDownTime(runtime: Runtime, value: Value | undefined, key: 'gmtime' | 'localtime'): number {
  const address = staticBlock(runtime, key, TM_SIZE);
  writeTm(runtime, address, breakDown(timeArgument(runtime, value)));
  return address;
}

function returnString(runtime: Runtime, text: string): number {
  const address = staticBlock(runtime, 'text', 64);
  writeBytes(runtime, address, cString(text));
  return address;
}

export const TIME_FUNCTIONS: Record<string, NativeFunction> = {
  time: (runtime, [pointer]) => {
    const address = asAddress(pointer);
    if (address !== 0) {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigInt64(0, FIXED_TIME, true);
      writeBytes(runtime, address, bytes);
    }
    return FIXED_TIME;
  },
  // No time passes in a run, so the processor time a program measures is always 0.
  clock: () => 0n,
  difftime: (_runtime, [end, start]) => Number(end as bigint) - Number(start as bigint),
  mktime: (runtime, [pointer]) => {
    const time = toTime(readTm(runtime, asAddress(pointer)));
    writeTm(runtime, asAddress(pointer), breakDown(time));
    return BigInt(time);
  },
  gmtime: (runtime, [pointer]) => brokenDownTime(runtime, pointer, 'gmtime'),
  localtime: (runtime, [pointer]) => brokenDownTime(runtime, pointer, 'localtime'),
  asctime: (runtime, [pointer]) => returnString(runtime, asctimeText(readTm(runtime, asAddress(pointer)))),
  ctime: (runtime, [pointer]) => returnString(runtime, asctimeText(breakDown(timeArgument(runtime, pointer)))),
  strftime: (runtime, [buffer, size, format, pointer]) => {
    const text = strftime(
      new TextDecoder().decode(readCString(runtime, asAddress(format))),
      readTm(runtime, asAddress(pointer))
    );
    const bytes = new TextEncoder().encode(text);
    if (bytes.length + 1 > asSize(size)) return 0n;
    writeBytes(runtime, asAddress(buffer), Uint8Array.from([...bytes, 0]));
    return BigInt(bytes.length);
  },
};
