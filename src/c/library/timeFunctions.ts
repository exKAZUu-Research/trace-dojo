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
  const view = new DataView(readBytes(runtime, address, 36).buffer);
  const field = (index: number): number => view.getInt32(index * 4, true);
  return {
    second: field(0),
    minute: field(1),
    hour: field(2),
    day: field(3),
    month: field(4),
    year: field(5),
    weekday: field(6),
    yearDay: field(7),
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
function staticBlock(runtime: Runtime, key: 'tm' | 'text', size: number): number {
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
  return `${WEEKDAYS[fields.weekday].slice(0, 3)} ${MONTHS[fields.month].slice(0, 3)} ${pad(fields.day, 2, ' ')} ${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)} ${fields.year + 1900}\n`;
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

/** One `strftime` conversion in the C locale, or undefined for one this interpreter leaves as it is. */
// code-gauge-allow functionCognitiveComplexity 30 -- One case per conversion, as the C standard lists them.
function conversion(letter: string, fields: BrokenDown): string | undefined {
  const hour12 = fields.hour % 12 === 0 ? 12 : fields.hour % 12;
  switch (letter) {
    case 'a': {
      return WEEKDAYS[fields.weekday].slice(0, 3);
    }
    case 'A': {
      return WEEKDAYS[fields.weekday];
    }
    case 'b':
    case 'h': {
      return MONTHS[fields.month].slice(0, 3);
    }
    case 'B': {
      return MONTHS[fields.month];
    }
    case 'c': {
      return asctimeText(fields).trimEnd();
    }
    case 'C': {
      return pad(Math.floor((fields.year + 1900) / 100), 2);
    }
    case 'd': {
      return pad(fields.day, 2);
    }
    case 'D':
    case 'x': {
      return `${pad(fields.month + 1, 2)}/${pad(fields.day, 2)}/${pad((fields.year + 1900) % 100, 2)}`;
    }
    case 'e': {
      return pad(fields.day, 2, ' ');
    }
    case 'F': {
      return `${fields.year + 1900}-${pad(fields.month + 1, 2)}-${pad(fields.day, 2)}`;
    }
    case 'g': {
      return pad(isoWeek(fields).year % 100, 2);
    }
    case 'G': {
      return String(isoWeek(fields).year);
    }
    case 'H': {
      return pad(fields.hour, 2);
    }
    case 'I': {
      return pad(hour12, 2);
    }
    case 'j': {
      return pad(fields.yearDay + 1, 3);
    }
    case 'k': {
      return pad(fields.hour, 2, ' ');
    }
    case 'l': {
      return pad(hour12, 2, ' ');
    }
    case 'm': {
      return pad(fields.month + 1, 2);
    }
    case 'M': {
      return pad(fields.minute, 2);
    }
    case 'n': {
      return '\n';
    }
    case 'p': {
      return fields.hour < 12 ? 'AM' : 'PM';
    }
    case 'r': {
      return `${pad(hour12, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)} ${fields.hour < 12 ? 'AM' : 'PM'}`;
    }
    case 'R': {
      return `${pad(fields.hour, 2)}:${pad(fields.minute, 2)}`;
    }
    case 's': {
      return String(toTime(fields));
    }
    case 'S': {
      return pad(fields.second, 2);
    }
    case 't': {
      return '\t';
    }
    case 'T':
    case 'X': {
      return `${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)}`;
    }
    case 'u': {
      return String(fields.weekday === 0 ? 7 : fields.weekday);
    }
    case 'U': {
      return pad(Math.floor((fields.yearDay + 7 - fields.weekday) / 7), 2);
    }
    case 'V': {
      return pad(isoWeek(fields).week, 2);
    }
    case 'w': {
      return String(fields.weekday);
    }
    case 'W': {
      return pad(Math.floor((fields.yearDay + 7 - ((fields.weekday + 6) % 7)) / 7), 2);
    }
    case 'y': {
      return pad((fields.year + 1900) % 100, 2);
    }
    case 'Y': {
      return String(fields.year + 1900);
    }
    case 'z': {
      return '+0000';
    }
    case 'Z': {
      return 'UTC';
    }
    case '%': {
      return '%';
    }
  }
  return undefined;
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
    text += conversion(letter, fields) ?? `%${letter}`;
  }
  return text;
}

function timeArgument(runtime: Runtime, value: Value | undefined): number {
  const bytes = readBytes(runtime, asAddress(value), 8);
  return Number(new DataView(bytes.buffer).getBigInt64(0, true));
}

function brokenDownTime(runtime: Runtime, value: Value | undefined): number {
  const address = staticBlock(runtime, 'tm', TM_SIZE);
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
  gmtime: (runtime, [pointer]) => brokenDownTime(runtime, pointer),
  localtime: (runtime, [pointer]) => brokenDownTime(runtime, pointer),
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
