/*
 * The computations of Go's time package (Go 1.27.3: time.go, format.go, format_rfc3339.go, and the parts of
 * zoneinfo.go that fixed zones use) transcribed to TypeScript over bigints that wrap as Go's integers do. Original
 * code: Copyright The Go Authors, BSD license (see the Go distribution's LICENSE file).
 */

/** A time zone: UTC and Local have no zone and read as UTC; a FixedZone has one zone. */
export interface Location {
  name: string;
  zone?: { name: string; offset: bigint };
}

/** A `time.Time`: Go's wall and ext words and its location, where undefined stands for UTC. */
export interface Time {
  wall: bigint;
  ext: bigint;
  loc: Location | undefined;
}

export const UTC_LOCATION: Location = { name: 'UTC' };
/** The interpreter fixes the local time zone to UTC, as Go has it when the TZ environment variable is "" or "UTC". */
export const LOCAL_LOCATION: Location = { name: 'UTC' };

let readLocal = (): Location => LOCAL_LOCATION;

/** The location the `time.Local` variable holds now, which a program may assign. */
export function currentLocal(): Location {
  return readLocal();
}

/** Installs how `currentLocal` reads the `time.Local` variable of the running program. */
export function setLocalReader(read: () => Location): void {
  readLocal = read;
}

export const i64 = (x: bigint): bigint => BigInt.asIntN(64, x);
export const u64 = (x: bigint): bigint => BigInt.asUintN(64, x);
const u32 = (x: bigint): bigint => BigInt.asUintN(32, x);
const i32 = (x: bigint): bigint => BigInt.asIntN(32, x);

export const HAS_MONOTONIC = 1n << 63n;
const NSEC_MASK = (1n << 30n) - 1n;
const NSEC_SHIFT = 30n;
const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3600n;
const SECONDS_PER_DAY = 86_400n;
const MARCH_THRU_DECEMBER = 306n;
const ABSOLUTE_YEARS = 292_277_022_400n;
const ABSOLUTE_TO_INTERNAL = -((ABSOLUTE_YEARS * 3_652_425n) / 10_000n + MARCH_THRU_DECEMBER) * SECONDS_PER_DAY;
const INTERNAL_TO_ABSOLUTE = -ABSOLUTE_TO_INTERNAL;
const UNIX_TO_INTERNAL = (1969n * 365n + 1969n / 4n - 1969n / 100n + 1969n / 400n) * SECONDS_PER_DAY;
const INTERNAL_TO_UNIX = -UNIX_TO_INTERNAL;
const ABSOLUTE_TO_UNIX = ABSOLUTE_TO_INTERNAL + INTERNAL_TO_UNIX;
const WALL_TO_INTERNAL = (1884n * 365n + 1884n / 4n - 1884n / 100n + 1884n / 400n) * SECONDS_PER_DAY;
const MIN_WALL = WALL_TO_INTERNAL;
const ALPHA = -(1n << 63n);
const OMEGA = (1n << 63n) - 1n;

export const MIN_DURATION = -(1n << 63n);
export const MAX_DURATION = (1n << 63n) - 1n;
export const SECOND = 1_000_000_000n;
export const MINUTE = 60n * SECOND;
export const HOUR = 60n * MINUTE;

export const LONG_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const LONG_MONTH_NAMES = [
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

// Locations -------------------------------------------------------------------------------------------------------

const unnamedFixedZones = new Map<bigint, Location>();

/** `time.FixedZone`, which shares the zones of whole hours from -12 to +14 without a name, as Go does. */
export function fixedZone(name: string, offset: bigint): Location {
  const hour = offset / 60n / 60n;
  if (name === '' && -12n <= hour && hour <= 14n && hour * 60n * 60n === offset) {
    let location = unnamedFixedZones.get(hour);
    if (!location) {
      location = { name: '', zone: { name: '', offset: hour * 3600n } };
      unnamedFixedZones.set(hour, location);
    }
    return location;
  }
  return { name, zone: { name, offset } };
}

/** `Location.lookup`: the zone name, offset, and the bounds of the zone in effect, which are always unbounded here. */
export function lookup(location: Location | undefined): { name: string; offset: bigint; start: bigint; end: bigint } {
  const zone = location?.zone;
  if (!zone) return { name: 'UTC', offset: 0n, start: ALPHA, end: OMEGA };
  return { name: zone.name, offset: zone.offset, start: ALPHA, end: OMEGA };
}

export function lookupName(location: Location, name: string): bigint | undefined {
  return location.zone?.name === name ? location.zone.offset : undefined;
}

// Time internals --------------------------------------------------------------------------------------------------

export function nsec(t: Time): bigint {
  return t.wall & NSEC_MASK;
}

export function sec(t: Time): bigint {
  if ((t.wall & HAS_MONOTONIC) !== 0n) return WALL_TO_INTERNAL + (u64(t.wall << 1n) >> (NSEC_SHIFT + 1n));
  return t.ext;
}

function unixSec(t: Time): bigint {
  return i64(sec(t) + INTERNAL_TO_UNIX);
}

export function addSec(t: Time, d: bigint): void {
  if ((t.wall & HAS_MONOTONIC) !== 0n) {
    const s = u64(t.wall << 1n) >> (NSEC_SHIFT + 1n);
    const dsec = i64(s + d);
    if (0n <= dsec && dsec <= (1n << 33n) - 1n) {
      t.wall = (t.wall & NSEC_MASK) | (dsec << NSEC_SHIFT) | HAS_MONOTONIC;
      return;
    }
    stripMono(t);
  }
  const sum = i64(t.ext + d);
  if (sum > t.ext === d > 0n) t.ext = sum;
  else if (d > 0n) t.ext = OMEGA;
  else t.ext = -OMEGA;
}

export function setLoc(t: Time, location: Location | undefined): void {
  stripMono(t);
  t.loc = location === UTC_LOCATION ? undefined : location;
}

function stripMono(t: Time): void {
  if ((t.wall & HAS_MONOTONIC) !== 0n) {
    t.ext = sec(t);
    t.wall &= NSEC_MASK;
  }
}

function copy(t: Time): Time {
  return { wall: t.wall, ext: t.ext, loc: t.loc };
}

export function hasMonotonic(t: Time): boolean {
  return (t.wall & HAS_MONOTONIC) !== 0n;
}

// Absolute dates --------------------------------------------------------------------------------------------------

function dateToAbsDays(year: bigint, month: bigint, day: bigint): bigint {
  let amonth = u32(month);
  const janFeb = amonth < 3n ? 1n : 0n;
  amonth = u32(amonth + 12n * janFeb);
  const y = u64(u64(year) - janFeb + ABSOLUTE_YEARS);
  const ayday = u32(979n * amonth - 2919n) >> 5n;
  const century = y / 100n;
  const cyear = u32(y % 100n);
  const cday = u32(1461n * cyear) / 4n;
  const centuryDays = u64(146_097n * century) / 4n;
  return u64(centuryDays + u64(i64(u32(cday + ayday)) + day - 1n));
}

function splitDays(days: bigint): { century: bigint; cyear: bigint; ayday: bigint } {
  const d = u64(4n * days + 3n);
  const century = d / 146_097n;
  const cd = u32(d % 146_097n) | 3n;
  const product = 2_939_745n * cd;
  return { century, cyear: product >> 32n, ayday: (product & 0xff_ff_ff_ffn) / 2_939_745n / 4n };
}

function splitYday(ayday: bigint): { amonth: bigint; mday: bigint } {
  const d = u32(2141n * ayday + 197_913n);
  return { amonth: d >> 16n, mday: 1n + (d & 0xff_ffn) / 2141n };
}

const janFebOf = (ayday: bigint): bigint => (ayday >= MARCH_THRU_DECEMBER ? 1n : 0n);

function yearOf(century: bigint, cyear: bigint, janFeb: bigint): bigint {
  return i64(i64(u64(century * 100n - ABSOLUTE_YEARS)) + cyear + janFeb);
}

function leapOf(century: bigint, cyear: bigint): bigint {
  const y4ok = cyear % 4n === 0n ? 1n : 0n;
  const y100ok = cyear === 0n ? 0n : 1n;
  const y400ok = century % 4n === 0n ? 1n : 0n;
  return y4ok & (y100ok | y400ok);
}

export function absDate(days: bigint): { year: bigint; month: bigint; day: bigint } {
  const { century, cyear, ayday } = splitDays(days);
  const { amonth, mday } = splitYday(ayday);
  const janFeb = janFebOf(ayday);
  return { year: yearOf(century, cyear, janFeb), month: amonth - janFeb * 12n, day: mday };
}

export function yearYday(days: bigint): { year: bigint; yday: bigint } {
  const { century, cyear, ayday } = splitDays(days);
  const janFeb = janFebOf(ayday);
  const leap = leapOf(century, cyear);
  return { year: yearOf(century, cyear, janFeb), yday: ayday + 60n + (leap & ~janFeb) - 365n * janFeb };
}

export function weekdayOf(days: bigint): bigint {
  return u64(days + 3n) % 7n;
}

export function clockOf(abs: bigint): { hour: bigint; min: bigint; sec: bigint } {
  let s = abs % SECONDS_PER_DAY;
  const hour = s / SECONDS_PER_HOUR;
  s -= hour * SECONDS_PER_HOUR;
  const min = s / SECONDS_PER_MINUTE;
  s -= min * SECONDS_PER_MINUTE;
  return { hour, min, sec: s };
}

export function locabs(t: Time): { name: string; offset: bigint; abs: bigint } {
  const { name, offset } = lookup(t.loc);
  return { name, offset, abs: u64(i64(unixSec(t) + offset) + (UNIX_TO_INTERNAL + INTERNAL_TO_ABSOLUTE)) };
}

export function absSec(t: Time): bigint {
  return locabs(t).abs;
}

export const daysOf = (abs: bigint): bigint => abs / SECONDS_PER_DAY;

// Time accessors and arithmetic -----------------------------------------------------------------------------------

export function isZero(t: Time): boolean {
  return t.wall === 0n && t.ext === 0n;
}

export function compare(t: Time, u: Time): number {
  let tc: bigint;
  let uc: bigint;
  if ((t.wall & u.wall & HAS_MONOTONIC) !== 0n) {
    tc = t.ext;
    uc = u.ext;
  } else {
    tc = sec(t);
    uc = sec(u);
    if (tc === uc) {
      tc = nsec(t);
      uc = nsec(u);
    }
  }
  return tc < uc ? -1 : tc > uc ? 1 : 0;
}

export function date(t: Time): { year: bigint; month: bigint; day: bigint } {
  return absDate(daysOf(absSec(t)));
}

export function yearDayOf(t: Time): { year: bigint; yday: bigint } {
  return yearYday(daysOf(absSec(t)));
}

export function weekday(t: Time): bigint {
  return weekdayOf(daysOf(absSec(t)));
}

export function isoWeek(t: Time): [bigint, bigint] {
  const days = daysOf(absSec(t));
  const thu = u64(days + (4n - (weekdayOf(u64(days - 1n)) + 1n)));
  const { year, yday } = yearYday(thu);
  return [year, (yday - 1n) / 7n + 1n];
}

export function clock(t: Time): { hour: bigint; min: bigint; sec: bigint } {
  return clockOf(absSec(t));
}

export function nanosecond(t: Time): bigint {
  return nsec(t);
}

export function add(time: Time, d: bigint): Time {
  const t = copy(time);
  let dsec = d / SECOND;
  let ns = i32(nsec(t) + i32(d % SECOND));
  if (ns >= SECOND) {
    dsec++;
    ns -= SECOND;
  } else if (ns < 0n) {
    dsec--;
    ns += SECOND;
  }
  t.wall = (t.wall & ~NSEC_MASK & ((1n << 64n) - 1n)) | ns;
  addSec(t, dsec);
  if ((t.wall & HAS_MONOTONIC) !== 0n) {
    const te = i64(t.ext + d);
    if ((d < 0n && te > t.ext) || (d > 0n && te < t.ext)) stripMono(t);
    else t.ext = te;
  }
  return t;
}

export function sub(t: Time, u: Time): bigint {
  if ((t.wall & u.wall & HAS_MONOTONIC) !== 0n) return subMono(t.ext, u.ext);
  const d = i64(i64(i64(sec(t) - sec(u)) * SECOND) + (nsec(t) - nsec(u)));
  if (compare(add(u, d), t) === 0) return d;
  return compare(t, u) < 0 ? MIN_DURATION : MAX_DURATION;
}

export function subMono(t: bigint, u: bigint): bigint {
  const d = i64(t - u);
  if (d < 0n && t > u) return MAX_DURATION;
  if (d > 0n && t < u) return MIN_DURATION;
  return d;
}

export function addDate(t: Time, years: bigint, months: bigint, days: bigint): Time {
  const { year, month, day } = date(t);
  const { hour, min, sec: s } = clock(t);
  return makeDate(
    i64(year + years),
    i64(month + months),
    i64(day + days),
    hour,
    min,
    s,
    nsec(t),
    t.loc ?? UTC_LOCATION
  );
}

export function daysIn(month: bigint, year: bigint): bigint {
  if (month === 2n) return isLeap(year) ? 29n : 28n;
  return 30n + ((month + (month >> 3n)) & 1n);
}

export function daysBefore(month: bigint): bigint {
  const adjust = month >= 3n ? -2n : 0n;
  return (214n * month - 211n) / 7n + adjust;
}

export function isLeap(year: bigint): boolean {
  const mask = year % 25n === 0n ? 0xfn : 3n;
  return (year & mask) === 0n;
}

/** Monotonic readings, for `time.Now`: the wall clock in Unix nanoseconds and the program's monotonic clock. */
export function now(unixNanos: bigint, mono: bigint): Time {
  const s = unixNanos / SECOND - (unixNanos % SECOND < 0n ? 1n : 0n);
  const ns = unixNanos - s * SECOND;
  const wallSec = s + UNIX_TO_INTERNAL - MIN_WALL;
  const loc = currentLocal();
  if (u64(wallSec) >> 33n !== 0n) return { wall: ns, ext: wallSec + MIN_WALL, loc };
  return { wall: HAS_MONOTONIC | (wallSec << NSEC_SHIFT) | ns, ext: mono, loc };
}

export function unix(secValue: bigint, nsecValue: bigint): Time {
  let s = secValue;
  let ns = nsecValue;
  if (ns < 0n || ns >= SECOND) {
    const n = ns / SECOND;
    s = i64(s + n);
    ns -= n * SECOND;
    if (ns < 0n) {
      ns += SECOND;
      s = i64(s - 1n);
    }
  }
  return unixTime(s, ns);
}

function unixTime(s: bigint, ns: bigint): Time {
  return { wall: u64(i32(ns)), ext: i64(s + UNIX_TO_INTERNAL), loc: currentLocal() };
}

export function unixSeconds(t: Time): bigint {
  return unixSec(t);
}

export function unixScaled(t: Time, perSecond: bigint): bigint {
  return i64(i64(unixSec(t) * perSecond) + nsec(t) / (SECOND / perSecond));
}

export function inLocation(time: Time, location: Location | undefined): Time {
  const t = copy(time);
  setLoc(t, location);
  return t;
}

export function zone(t: Time): { name: string; offset: bigint } {
  return lookup(t.loc);
}

function norm(hi: bigint, lo: bigint, base: bigint): [bigint, bigint] {
  let h = hi;
  let l = lo;
  if (l < 0n) {
    const n = i64((-l - 1n) / base + 1n);
    h = i64(h - n);
    l = i64(l + n * base);
  }
  if (l >= base) {
    const n = l / base;
    h = i64(h + n);
    l = i64(l - n * base);
  }
  return [h, l];
}

/** `time.Date`, given a non-nil location. */
export function makeDate(
  yearValue: bigint,
  monthValue: bigint,
  dayValue: bigint,
  hourValue: bigint,
  minValue: bigint,
  secValue: bigint,
  nsecValue: bigint,
  location: Location
): Time {
  const [year, m] = norm(yearValue, i64(monthValue - 1n), 12n);
  let [s, ns] = norm(secValue, nsecValue, SECOND);
  let min: bigint;
  [min, s] = norm(minValue, s, 60n);
  let hour: bigint;
  [hour, min] = norm(hourValue, min, 60n);
  let day: bigint;
  [day, hour] = norm(dayValue, hour, 24n);
  let unixValue = i64(
    i64(i64(dateToAbsDays(year, m + 1n, day)) * SECONDS_PER_DAY) +
      i64(hour * SECONDS_PER_HOUR + min * SECONDS_PER_MINUTE + s) +
      ABSOLUTE_TO_UNIX
  );
  const { offset } = lookup(location);
  if (offset !== 0n) unixValue = i64(unixValue - offset);
  const t = unixTime(unixValue, ns);
  setLoc(t, location);
  return t;
}

export function truncate(time: Time, d: bigint): Time {
  const t = copy(time);
  stripMono(t);
  if (d <= 0n) return t;
  const { r } = div(t, d);
  return add(t, -r);
}

export function round(time: Time, d: bigint): Time {
  const t = copy(time);
  stripMono(t);
  if (d <= 0n) return t;
  const { r } = div(t, d);
  if (lessThanHalf(r, d)) return add(t, -r);
  return add(t, i64(d - r));
}

function div(t: Time, d: bigint): { r: bigint } {
  let neg = false;
  let ns = nsec(t);
  let s = sec(t);
  if (s < 0n) {
    neg = true;
    s = -s;
    ns = -ns;
    if (ns < 0n) {
      ns += SECOND;
      s--;
    }
  }
  let r: bigint;
  if (d < SECOND && SECOND % (d + d) === 0n) r = ns % d;
  else if (d % SECOND === 0n) r = (s % (d / SECOND)) * SECOND + ns;
  // Go computes the remainder of the 128-bit nanosecond count by shifts; the exact bigint remainder is the same.
  else r = (u64(s) * SECOND + ns) % d;
  if (neg && r !== 0n) r = d - r;
  return { r };
}

function lessThanHalf(x: bigint, y: bigint): boolean {
  return u64(u64(x) + u64(x)) < u64(y);
}

// Durations -------------------------------------------------------------------------------------------------------

/** `Duration.String`, as UTF-8 bytes. */
export function durationString(d: bigint): string {
  let u = u64(d);
  const neg = d < 0n;
  if (neg) u = u64(-u);
  let text: string;
  if (u < SECOND) {
    if (u === 0n) return '0s';
    let prec: number;
    let unit: string;
    if (u < 1000n) {
      prec = 0;
      unit = 'ns';
    } else if (u < 1_000_000n) {
      prec = 3;
      unit = 'Âµs';
    } else {
      prec = 6;
      unit = 'ms';
    }
    const [fraction, rest] = fmtFrac(u, prec);
    text = `${rest}${fraction}${unit}`;
  } else {
    const [fraction, rest] = fmtFrac(u, 9);
    text = `${rest % 60n}${fraction}s`;
    let v = rest / 60n;
    if (v > 0n) {
      text = `${v % 60n}m${text}`;
      v /= 60n;
      if (v > 0n) text = `${v}h${text}`;
    }
  }
  return neg ? `-${text}` : text;
}

function fmtFrac(value: bigint, prec: number): [string, bigint] {
  let v = value;
  let digits = '';
  let print = false;
  for (let i = 0; i < prec; i++) {
    const digit = v % 10n;
    print ||= digit !== 0n;
    if (print) digits = `${digit}${digits}`;
    v /= 10n;
  }
  return [print ? `.${digits}` : '', v];
}

export function durationRound(d: bigint, m: bigint): bigint {
  if (m <= 0n) return d;
  let r = d % m;
  if (d < 0n) {
    r = -r;
    if (lessThanHalf(r, m)) return d + r;
    const d1 = i64(d - m + r);
    return d1 < d ? d1 : MIN_DURATION;
  }
  if (lessThanHalf(r, m)) return d - r;
  const d1 = i64(d + m - r);
  return d1 > d ? d1 : MAX_DURATION;
}

/** `Duration.Seconds`, `Minutes`, and `Hours`: the whole units plus the rest divided in floating point. */
export function durationUnits(d: bigint, unit: bigint): number {
  return Number(d / unit) + Number(d % unit) / Number(unit);
}
