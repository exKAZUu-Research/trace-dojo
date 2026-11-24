import { dayOfWeek, dayOfYear, daysInMonth, isLeapYear, isoWeek } from './dateCalendar';
import { type LocalTime, localTime, type Moment } from './dateMoment';
import { formatOffset, type Zone, zoneAbbreviation, zoneName } from './dateZone';

export const DAY_NAMES = 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday'.split(' ');
export const MONTH_NAMES =
  'January February March April May June July August September October November December'.split(' ');

const pad = (value: number, width: number): string =>
  `${value < 0 ? '-' : ''}${String(Math.abs(value)).padStart(width, '0')}`;

function englishSuffix(day: number): string {
  if (day >= 10 && day <= 19) return 'th';
  return ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th';
}

/** Whether `p` shows a zone as `Z`: the UTC zone, the abbreviations UTC and Z, and the offset +00:00. */
function isUtcLike(zone: Zone): boolean {
  if (zone.type === 1) return zone.offset === 0;
  if (zone.type === 2) return ['UTC', 'Z'].includes(zone.abbr.toUpperCase()) && !zone.dst;
  return zone.id.toUpperCase() === 'UTC';
}

type Formatter = (t: LocalTime, moment: Moment) => string;

const weekday = (t: LocalTime): number => dayOfWeek(t.y, t.m, t.d);

const FORMATTERS: Record<string, Formatter> = {
  d: (t) => pad(t.d, 2),
  D: (t) => DAY_NAMES[weekday(t)].slice(0, 3),
  j: (t) => String(t.d),
  l: (t) => DAY_NAMES[weekday(t)],
  S: (t) => englishSuffix(t.d),
  w: (t) => String(weekday(t)),
  N: (t) => String(weekday(t) || 7),
  z: (t) => String(dayOfYear(t.y, t.m, t.d)),
  W: (t) => pad(isoWeek(t.y, t.m, t.d).week, 2),
  o: (t) => String(isoWeek(t.y, t.m, t.d).year),
  F: (t) => MONTH_NAMES[t.m - 1],
  m: (t) => pad(t.m, 2),
  M: (t) => MONTH_NAMES[t.m - 1].slice(0, 3),
  n: (t) => String(t.m),
  t: (t) => String(daysInMonth(t.y, t.m)),
  L: (t) => (isLeapYear(t.y) ? '1' : '0'),
  y: (t) => pad(Math.abs(t.y % 100), 2),
  Y: (t) => pad(t.y, 4),
  x: (t) => (t.y >= 10_000 ? `+${t.y}` : pad(t.y, 4)),
  X: (t) => (t.y >= 0 ? `+${pad(t.y, 4)}` : pad(t.y, 4)),
  a: (t) => (t.h >= 12 ? 'pm' : 'am'),
  A: (t) => (t.h >= 12 ? 'PM' : 'AM'),
  B: (_t, moment) => {
    let beat = ((moment.sse % 86_400) + 3600) * 10;
    if (beat < 0) beat += 864_000;
    return pad(Math.trunc(beat / 864) % 1000, 3);
  },
  g: (t) => String(t.h % 12 || 12),
  G: (t) => String(t.h),
  h: (t) => pad(t.h % 12 || 12, 2),
  H: (t) => pad(t.h, 2),
  i: (t) => pad(t.i, 2),
  s: (t) => pad(t.s, 2),
  u: (t) => pad(t.us, 6),
  v: (t) => pad(Math.trunc(t.us / 1000), 3),
  e: (_t, moment) => zoneName(moment.zone),
  I: (t) => (t.dst ? '1' : '0'),
  O: (t) => formatOffset(t.offset, false),
  P: (t) => formatOffset(t.offset, true),
  p: (t, moment) => (isUtcLike(moment.zone) ? 'Z' : formatOffset(t.offset, true)),
  T: (_t, moment) => zoneAbbreviation(moment.zone, moment.sse),
  Z: (t) => String(t.offset),
  c: (_t, moment) => formatMoment(moment, String.raw`Y-m-d\TH:i:sP`),
  r: (_t, moment) => formatMoment(moment, 'D, d M Y H:i:s O'),
  U: (_t, moment) => String(moment.sse),
};

/** Formats a moment as PHP's date_format does for `date()` and DateTimeInterface::format. */
export function formatMoment(moment: Moment, format: string): string {
  const t = localTime(moment);
  let text = '';
  for (let index = 0; index < format.length; index++) {
    const c = format[index];
    if (c === '\\') {
      index++;
      text += format[index] ?? '\0';
      continue;
    }
    const formatter = FORMATTERS[c];
    text += formatter ? formatter(t, moment) : c;
  }
  return text;
}
