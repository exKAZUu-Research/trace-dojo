// The proleptic Gregorian calendar of `datetime`, as CPython's `_datetimemodule.c` computes it.

export const MINYEAR = 1;
export const MAXYEAR = 9999;
/** The ordinal of 9999-12-31. */
export const MAX_ORDINAL = 3_652_059;

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

export function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month];
}

function daysBeforeMonth(year: number, month: number): number {
  return DAYS_BEFORE_MONTH[month] + (month > 2 && isLeap(year) ? 1 : 0);
}

function daysBeforeYear(year: number): number {
  const y = year - 1;
  return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

/** The day number of a date, 0001-01-01 being day 1. */
export function toOrdinal(year: number, month: number, day: number): number {
  return daysBeforeYear(year) + daysBeforeMonth(year, month) + day;
}

/** The date of a day number, 0001-01-01 being day 1, extending the calendar beyond the years datetime supports. */
export function fromOrdinal(ordinal: number): [number, number, number] {
  let n = ordinal - 1;
  const n400 = Math.floor(n / 146_097);
  n -= n400 * 146_097;
  let year = n400 * 400 + 1;
  const n100 = Math.floor(n / 36_524);
  n %= 36_524;
  const n4 = Math.floor(n / 1461);
  n %= 1461;
  const n1 = Math.floor(n / 365);
  n %= 365;
  year += n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) return [year - 1, 12, 31];
  let month = (n + 50) >> 5;
  let preceding = daysBeforeMonth(year, month);
  if (preceding > n) {
    month--;
    preceding -= daysInMonth(year, month);
  }
  return [year, month, n - preceding + 1];
}

/** The day of the week, Monday being 0. */
export function weekdayOf(year: number, month: number, day: number): number {
  return (toOrdinal(year, month, day) + 6) % 7;
}

/** The ordinal of the Monday that starts ISO week 1 of `year`. */
function isoWeek1Monday(year: number): number {
  const first = toOrdinal(year, 1, 1);
  const weekday = (first + 6) % 7;
  let monday = first - weekday;
  if (weekday > 3) monday += 7;
  return monday;
}

/** The ISO year, week, and weekday (Monday being 1) of a date. */
export function isoCalendar(year: number, month: number, day: number): [number, number, number] {
  let isoYear = year;
  let week1 = isoWeek1Monday(isoYear);
  const today = toOrdinal(year, month, day);
  let week = Math.floor((today - week1) / 7);
  let weekday = (today - week1) % 7;
  if (weekday < 0) weekday += 7;
  if (week < 0) {
    isoYear--;
    week1 = isoWeek1Monday(isoYear);
    week = Math.floor((today - week1) / 7);
    weekday = (today - week1) % 7;
  } else if (week >= 52 && today >= isoWeek1Monday(isoYear + 1)) {
    isoYear++;
    week = 0;
  }
  return [isoYear, week + 1, weekday + 1];
}

/** The date of an ISO year, week, and weekday, or the message of the ValueError they raise. */
export function fromIsoCalendar(year: number, week: number, weekday: number): [number, number, number] | string {
  if (year < MINYEAR || year > MAXYEAR) return `Year is out of range: ${year}`;
  if (week <= 0 || week >= 53) {
    const first = weekdayOf(year, 1, 1);
    if (!(week === 53 && (first === 3 || (first === 2 && isLeap(year))))) return `Invalid week: ${week}`;
  }
  if (weekday <= 0 || weekday >= 8) return `Invalid weekday: ${weekday} (range is [1, 7])`;
  const ordinal = isoWeek1Monday(year) + (week - 1) * 7 + (weekday - 1);
  if (ordinal < 1 || ordinal > MAX_ORDINAL) return `Year is out of range: ${year}`;
  return fromOrdinal(ordinal);
}

/** The day of the year, 1 being January 1st. */
export function dayOfYear(year: number, month: number, day: number): number {
  return daysBeforeMonth(year, month) + day;
}
