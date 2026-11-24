/** Proleptic Gregorian calendar arithmetic, transcribed from timelib's tm2unixtime.c and dow.c. */

export const SECONDS_PER_DAY = 86_400;
const DAYS_PER_ERA = 146_097;
const YEARS_PER_ERA = 400;

/** The broken-down fields of a time, which may be out of range until normalized. */
export interface CivilFields {
  y: number;
  m: number;
  d: number;
  h: number;
  i: number;
  s: number;
  us: number;
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** The number of days from 1970-01-01 to the date, for an in-range month and any day. */
export function epochDays(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / YEARS_PER_ERA);
  const yearOfEra = y - era * YEARS_PER_ERA;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * DAYS_PER_ERA + dayOfEra - 719_468;
}

export function dateFromEpochDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719_468;
  const era = Math.floor(z / DAYS_PER_ERA);
  const dayOfEra = z - era * DAYS_PER_ERA;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const d = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yearOfEra + era * YEARS_PER_ERA + (m <= 2 ? 1 : 0), m, d };
}

/** The day of the week, 0 for Sunday. */
export function dayOfWeek(year: number, month: number, day: number): number {
  return (((epochDays(year, month, day) + 4) % 7) + 7) % 7;
}

/** The zero-based day of the year. */
export function dayOfYear(year: number, month: number, day: number): number {
  return epochDays(year, month, day) - epochDays(year, 1, 1);
}

/** The ISO 8601 week-numbering year and week of a date. */
export function isoWeek(year: number, month: number, day: number): { year: number; week: number } {
  const isoDay = dayOfWeek(year, month, day) || 7;
  const thursday = epochDays(year, month, day) - isoDay + 4;
  const thursdayYear = dateFromEpochDays(thursday).y;
  return { year: thursdayYear, week: Math.floor((thursday - epochDays(thursdayYear, 1, 1)) / 7) + 1 };
}

/** Transcribes timelib_daynr_from_weeknr: the day offset from January 1 of an ISO week date. */
export function dayFromIsoWeek(year: number, week: number, day: number): number {
  const dow = dayOfWeek(year, 1, 1);
  const day1 = 0 - (dow > 4 ? dow - 7 : dow);
  return day1 + (week - 1) * 7 + day;
}

export function isValidDate(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function isValidTime(h: number, i: number, s: number): boolean {
  return h >= 0 && h <= 23 && i >= 0 && i <= 59 && s >= 0 && s <= 59;
}

/** Moves the overflow of `value` beyond [start, end) into `carry`, as timelib's do_range_limit does. */
export function rangeLimit(start: number, end: number, adjust: number, value: number, carry: number): [number, number] {
  if (value < start) {
    const borrow = Math.trunc((start - value - 1) / adjust) + 1;
    carry -= borrow;
    value += adjust * borrow;
  }
  if (value >= end) {
    carry += Math.trunc(value / adjust);
    value -= adjust * Math.trunc(value / adjust);
  }
  return [value, carry];
}

/** Transcribes timelib_do_normalize, which carries out-of-range fields into the larger ones. */
export function normalizeFields(t: CivilFields): void {
  [t.us, t.s] = rangeLimit(0, 1_000_000, 1_000_000, t.us, t.s);
  [t.s, t.i] = rangeLimit(0, 60, 60, t.s, t.i);
  [t.i, t.h] = rangeLimit(0, 60, 60, t.i, t.h);
  [t.h, t.d] = rangeLimit(0, 24, 24, t.h, t.d);
  [t.m, t.y] = rangeLimit(1, 13, 12, t.m, t.y);
  const date = dateFromEpochDays(epochDays(t.y, t.m, 1) + t.d - 1);
  t.y = date.y;
  t.m = date.m;
  t.d = date.d;
}

/** The seconds since the epoch of fields read as UTC, after normalizing them. */
export function fieldsToSeconds(t: CivilFields): number {
  normalizeFields(t);
  return epochDays(t.y, t.m, t.d) * SECONDS_PER_DAY + t.h * 3600 + t.i * 60 + t.s;
}

export function secondsToFields(seconds: number, us = 0): CivilFields {
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const rest = seconds - days * SECONDS_PER_DAY;
  const { y, m, d } = dateFromEpochDays(days);
  return { y, m, d, h: Math.floor(rest / 3600), i: Math.floor((rest % 3600) / 60), s: rest % 60, us };
}
