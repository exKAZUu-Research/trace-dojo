import {
  type CivilFields,
  dayOfWeek,
  daysInMonth,
  epochDays,
  fieldsToSeconds,
  normalizeFields,
  rangeLimit,
  secondsToFields,
} from './dateCalendar';
import {
  emptyRelative,
  type ParsedTime,
  type Relative,
  SPECIAL_DAY_OF_WEEK_IN_MONTH,
  SPECIAL_LAST_DAY_OF_WEEK_IN_MONTH,
  SPECIAL_WEEKDAY,
} from './dateParse';
import { localToInstant, type Zone, zoneInfo } from './dateZone';

/** A point in time with the zone it is shown in: the state of a DateTime object. */
export interface Moment {
  /** Whole seconds since the Unix epoch. */
  sse: number;
  /** Microseconds, 0 to 999999. */
  us: number;
  zone: Zone;
}

export interface LocalTime extends CivilFields {
  offset: number;
  dst: boolean;
}

export function localTime(moment: Moment): LocalTime {
  const info = zoneInfo(moment.zone, moment.sse);
  return { ...secondsToFields(moment.sse + info.offset, moment.us), offset: info.offset, dst: info.dst };
}

/** Transcribes timelib_update_ts: applies the relative part to the fields and finds the instant in the zone. */
export function updateMoment(fields: CivilFields, relative: Relative, haveRelative: boolean, zone: Zone): Moment {
  const t: CivilFields = {
    y: fields.y,
    m: fields.m,
    d: fields.d,
    h: fields.h,
    i: fields.i,
    s: fields.s,
    us: fields.us,
  };
  const rel = { ...relative };
  adjustSpecialEarly(t, rel);
  adjustRelative(t, rel, haveRelative);
  if (rel.special?.type === SPECIAL_WEEKDAY) adjustSpecialWeekday(t, rel.special.amount);
  normalizeFields(t);
  return { sse: localToInstant(zone, fieldsToSeconds(t)), us: t.us, zone };
}

function adjustSpecialEarly(t: CivilFields, rel: Relative): void {
  if (rel.special?.type === SPECIAL_DAY_OF_WEEK_IN_MONTH) {
    t.d = 1;
    t.m += rel.m;
    rel.m = 0;
  } else if (rel.special?.type === SPECIAL_LAST_DAY_OF_WEEK_IN_MONTH) {
    t.d = 1;
    t.m += rel.m + 1;
    rel.m = 0;
  }
  firstOrLastDay(t, rel);
  normalizeFields(t);
}

function firstOrLastDay(t: CivilFields, rel: Relative): void {
  if (rel.firstLast === 1) t.d = 1;
  else if (rel.firstLast === 2) {
    t.d = 0;
    t.m++;
  }
}

function adjustRelative(t: CivilFields, rel: Relative, haveRelative: boolean): void {
  if (rel.haveWeekday) adjustForWeekday(t, rel);
  normalizeFields(t);
  if (haveRelative) {
    t.us += rel.us;
    t.s += rel.s;
    t.i += rel.i;
    t.h += rel.h;
    t.d += rel.d;
    t.m += rel.m;
    t.y += rel.y;
  }
  firstOrLastDay(t, rel);
  normalizeFields(t);
}

function adjustForWeekday(t: CivilFields, rel: Relative): void {
  const currentDow = dayOfWeek(t.y, t.m, t.d);
  if (rel.weekdayBehavior === 2) {
    let weekday = rel.weekday;
    if (currentDow === 0 && weekday !== 0) weekday -= 7;
    if (weekday === 0 && currentDow !== 0) weekday = 7;
    t.d += weekday - currentDow;
    return;
  }
  let difference = rel.weekday - currentDow;
  if ((rel.d < 0 && difference < 0) || (rel.d >= 0 && difference <= -rel.weekdayBehavior)) difference += 7;
  if (rel.weekday >= 0) t.d += difference;
  else t.d -= 7 - (Math.abs(rel.weekday) - currentDow);
}

// code-gauge-allow functionNcss -- Transcribes timelib's do_adjust_special_weekday branch by branch.
function adjustSpecialWeekday(t: CivilFields, count: number): void {
  normalizeFields(t);
  const dow = dayOfWeek(t.y, t.m, t.d);
  t.d += Math.trunc(count / 5) * 7;
  const rem = count % 5;
  if (count > 0) {
    if (rem === 0) {
      if (dow === 0) t.d -= 2;
      else if (dow === 6) t.d -= 1;
    } else if (dow === 6) t.d += 1;
    else if (dow + rem > 5) t.d += 2;
  } else if (rem === 0) {
    if (dow === 6) t.d += 2;
    else if (dow === 0) t.d += 1;
  } else if (dow === 0) t.d -= 1;
  else if (dow + rem < 1) t.d -= 2;
  t.d += rem;
}

/**
 * The moment a parsed string means relative to `now`, as timelib_fill_holes and timelib_update_ts make it.
 * `overrideTime` keeps the time fields `now` has for a date without time, as createFromFormat does.
 */
export function resolveParsed(parsed: ParsedTime, now: Moment, overrideTime = false): Moment {
  const base = localTime(parsed.zone?.type === 3 ? { ...now, zone: parsed.zone } : now);
  const p = { ...parsed };
  if (!overrideTime && p.haveDate && !p.haveTime) p.h = p.i = p.s = p.us = 0;
  const anySet = [p.y, p.m, p.d, p.h, p.i, p.s].some((value) => value !== undefined);
  const fields: CivilFields = {
    y: p.y ?? base.y,
    m: p.m ?? base.m,
    d: p.d ?? base.d,
    h: p.h ?? base.h,
    i: p.i ?? base.i,
    s: p.s ?? base.s,
    us: p.us ?? (anySet ? 0 : base.us),
  };
  return updateMoment(fields, p.relative, p.haveRelative, p.zone ?? now.zone);
}

/** Transcribes php_date_modify, which keeps the fields a string leaves unset. */
export function modifyMoment(moment: Moment, parsed: ParsedTime): Moment {
  const t: CivilFields = localTime(moment);
  if (parsed.y !== undefined) t.y = parsed.y;
  if (parsed.m !== undefined) t.m = parsed.m;
  if (parsed.d !== undefined) t.d = parsed.d;
  if (parsed.h !== undefined) {
    t.h = parsed.h;
    t.i = parsed.i ?? 0;
    t.s = parsed.i === undefined ? 0 : (parsed.s ?? 0);
  }
  if (parsed.us !== undefined) t.us = parsed.us;
  const isTimestamp =
    parsed.y === 1970 &&
    parsed.m === 1 &&
    parsed.d === 1 &&
    parsed.h === 0 &&
    parsed.i === 0 &&
    parsed.s === 0 &&
    parsed.us === 0 &&
    parsed.haveZone > 0 &&
    parsed.zone?.type === 1 &&
    parsed.zone.offset === 0;
  const zone: Zone = isTimestamp ? { type: 1, offset: 0 } : moment.zone;
  return updateMoment(t, parsed.relative, parsed.haveRelative, zone);
}

/** The fields of a DateInterval (timelib_rel_time) that adding and subtracting use. */
export interface IntervalFields {
  y: number;
  m: number;
  d: number;
  h: number;
  i: number;
  s: number;
  us: number;
  invert: boolean;
}

/** Transcribes timelib_add_wall and timelib_sub_wall, which add hours, minutes, and seconds as elapsed time. */
export function addWall(moment: Moment, interval: IntervalFields, sign: 1 | -1): Moment {
  const bias = (interval.invert ? -1 : 1) * sign;
  let result = moment;
  if (interval.y || interval.m || interval.d) {
    const rel = { ...emptyRelative(), y: interval.y * bias, m: interval.m * bias, d: interval.d * bias };
    result = updateMoment(localTime(moment), rel, true, moment.zone);
  }
  let [us, s] = [interval.us, interval.s];
  if (us !== 0) [us, s] = rangeLimit(0, 1_000_000, 1_000_000, us, s);
  const sse = result.sse + bias * (interval.h * 3600 + interval.i * 60 + s);
  if (us === 0) return { ...result, sse };
  const t = localTime({ ...result, sse });
  t.us += us * bias;
  return updateMoment(t, emptyRelative(), false, moment.zone);
}

export function compareMoments(a: Moment, b: Moment): number {
  return Math.sign(a.sse - b.sse) || Math.sign(a.us - b.us);
}

function sameZone(a: Moment, b: Moment): boolean {
  if (a.zone.type !== b.zone.type) return false;
  if (a.zone.type === 3 && b.zone.type === 3) return a.zone.id === b.zone.id;
  return zoneInfo(a.zone, a.sse).offset === zoneInfo(b.zone, b.sse).offset;
}

export interface DiffResult extends IntervalFields {
  days: number;
}

/** Transcribes timelib_diff, leaving out its corrections for daylight saving changes between the two times. */
// code-gauge-allow functionNcss -- Transcribes timelib_diff and its timelib_do_rel_normalize in order.
export function diffMoments(first: Moment, second: Moment): DiffResult {
  let invert = false;
  let [one, two] = [first, second];
  const sameId = one.zone.type === 3 && two.zone.type === 3 && one.zone.id === two.zone.id;
  let a = localTime(one);
  let b = localTime(two);
  const later = sameId ? compareFields(a, b) > 0 : compareMoments(one, two) > 0;
  if (later) {
    [one, two, a, b] = [two, one, b, a];
    invert = true;
  }
  const rt = { y: b.y - a.y, m: b.m - a.m, d: b.d - a.d, h: b.h - a.h, i: b.i - a.i, s: b.s - a.s, us: b.us - a.us };
  if (!sameId) rt.s -= b.offset - a.offset;
  const days = diffDays(one, two, a, b);
  const base = invert ? a : b;
  [rt.us, rt.s] = rangeLimit(0, 1_000_000, 1_000_000, rt.us, rt.s);
  [rt.s, rt.i] = rangeLimit(0, 60, 60, rt.s, rt.i);
  [rt.i, rt.h] = rangeLimit(0, 60, 60, rt.i, rt.h);
  [rt.h, rt.d] = rangeLimit(0, 24, 24, rt.h, rt.d);
  [rt.m, rt.y] = rangeLimit(0, 12, 12, rt.m, rt.y);
  let [year, month] = [base.y, base.m];
  while (rt.d < 0) {
    if (invert) {
      rt.d += daysInMonth(year, month);
      rt.m--;
      [month, year] = month === 12 ? [1, year + 1] : [month + 1, year];
    } else {
      [month, year] = month === 1 ? [12, year - 1] : [month - 1, year];
      rt.d += daysInMonth(year, month);
      rt.m--;
    }
  }
  [rt.m, rt.y] = rangeLimit(0, 12, 12, rt.m, rt.y);
  return { ...rt, invert, days };
}

function compareFields(a: CivilFields, b: CivilFields): number {
  for (const key of ['y', 'm', 'd', 'h', 'i', 's', 'us'] as const) if (a[key] !== b[key]) return a[key] - b[key];
  return 0;
}

function diffDays(one: Moment, two: Moment, a: LocalTime, b: LocalTime): number {
  if (!sameZone(one, two)) return Math.abs(Math.trunc((one.sse - two.sse) / 86_400));
  const [earliest, latest] = compareMoments(one, two) < 0 ? [a, b] : [b, a];
  let days = Math.abs(epochDays(a.y, a.m, a.d) - epochDays(b.y, b.m, b.d));
  if (hours(latest) < hours(earliest) && days > 0) days--;
  return days;
}

function hours(t: CivilFields): number {
  return t.h + t.i / 60 + t.s / 3600 + t.us / 3_600_000_000;
}
