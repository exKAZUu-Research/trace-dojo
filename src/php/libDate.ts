// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { createObject } from './classes';
import { dayOfWeek, dayOfYear, daysInMonth, isValidDate } from './dateCalendar';
import { DAY_NAMES, formatMoment, MONTH_NAMES } from './dateFormat';
import { localTime, type Moment, resolveParsed, updateMoment } from './dateMoment';
import { emptyRelative } from './dateParse';
import {
  clockMicroseconds,
  currentInstant,
  defaultZone,
  parseOrReject,
  setDefaultZone,
  sleptTime,
  timestampSeconds,
} from './dateSupport';
import { knownZoneId, UTC_ZONE, type Zone, zoneName } from './dateZone';
import { notice, throwError, warn } from './errors';
import {
  applyInterval,
  diffObjects,
  formatInterval,
  initializeDate,
  intervalFromDateString,
  modifyDate,
  momentFromFormat,
  momentOf,
  newDateObject,
  newZoneObject,
  zoneFromName,
  zoneOf,
} from './libDateTime';
import { defineConstant, defineFunction } from './native';
import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { PhpArray, type PhpClass, type PhpObject, type Value } from './values';

const MAX_TIMESTAMP = 2 ** 63;

function momentAt(timestamp: Value, zone: Zone): Moment {
  return timestamp === null || timestamp === undefined
    ? { sse: currentInstant().sse, us: 0, zone }
    : { sse: timestampSeconds(timestamp), us: 0, zone };
}

function intResult(moment: Moment): bigint | false {
  return Math.abs(moment.sse) >= MAX_TIMESTAMP ? false : BigInt(moment.sse);
}

// Current time ---------------------------------------------------------------------------------------------------------

defineFunction('time(): int', () => BigInt(currentInstant().sse));
defineFunction('microtime(bool $as_float = false): string|float', ({ args }) => {
  const now = clockMicroseconds();
  if (args[0] === true) return now / 1_000_000;
  return `${((now % 1_000_000) / 1_000_000).toFixed(8)} ${Math.floor(now / 1_000_000)}`;
});
defineFunction('hrtime(bool $as_number = false): array|int|float|false', ({ args }) => {
  const nanoseconds = BigInt(Math.round(performance.now() * 1_000_000 + sleptTime() * 1000));
  if (args[0] === true) return nanoseconds;
  return PhpArray.list([nanoseconds / 1_000_000_000n, nanoseconds % 1_000_000_000n]);
});

// Time zones -----------------------------------------------------------------------------------------------------------

defineFunction('date_default_timezone_get(): string', () => {
  const zone = defaultZone();
  return zone.type === 3 ? zone.id : 'UTC';
});
defineFunction('date_default_timezone_set(string $timezoneId): bool', ({ args }) => {
  const id = args[0] as string;
  if (!knownZoneId(id)) {
    notice(`date_default_timezone_set(): Timezone ID '${id}' is invalid`);
    return false;
  }
  setDefaultZone({ type: 3, id });
  return true;
});

// Formatting -----------------------------------------------------------------------------------------------------------

defineFunction('date(string $format, ?int $timestamp = null): string', ({ args }) =>
  formatMoment(momentAt(args[1] ?? null, defaultZone()), args[0] as string)
);
defineFunction('gmdate(string $format, ?int $timestamp = null): string', ({ args }) =>
  formatMoment(momentAt(args[1] ?? null, UTC_ZONE), args[0] as string)
);
const IDATE_FORMATS = new Set('BdhHiILmNostUwWyYzZ');
defineFunction('idate(string $format, ?int $timestamp = null): int|false', ({ args }) => {
  const format = args[0] as string;
  if (format.length !== 1) throwError('ValueError', 'idate(): Argument #1 ($format) must be one character');
  if (!IDATE_FORMATS.has(format))
    throwError('ValueError', 'idate(): Argument #1 ($format) must be a valid date format character');
  return BigInt(Number.parseInt(formatMoment(momentAt(args[1] ?? null, defaultZone()), format), 10));
});
defineFunction('getdate(?int $timestamp = null): array', ({ args }) => {
  const moment = momentAt(args[0] ?? null, defaultZone());
  const t = localTime(moment);
  const result = new PhpArray();
  const weekday = dayOfWeek(t.y, t.m, t.d);
  for (const [key, value] of [
    ['seconds', t.s],
    ['minutes', t.i],
    ['hours', t.h],
    ['mday', t.d],
    ['wday', weekday],
    ['mon', t.m],
    ['year', t.y],
    ['yday', dayOfYear(t.y, t.m, t.d)],
  ] as const)
    result.set(key, BigInt(value));
  result.set('weekday', DAY_NAMES[weekday]);
  result.set('month', MONTH_NAMES[t.m - 1]);
  result.set(0n, BigInt(moment.sse));
  return result;
});
defineFunction('localtime(?int $timestamp = null, bool $associative = false): array', ({ args }) => {
  const t = localTime(momentAt(args[0] ?? null, defaultZone()));
  const values = [t.s, t.i, t.h, t.d, t.m - 1, t.y - 1900, dayOfWeek(t.y, t.m, t.d), dayOfYear(t.y, t.m, t.d)];
  const keys = ['tm_sec', 'tm_min', 'tm_hour', 'tm_mday', 'tm_mon', 'tm_year', 'tm_wday', 'tm_yday', 'tm_isdst'];
  const list = [...values, t.dst ? 1 : 0].map(BigInt);
  if (args[1] !== true) return PhpArray.list(list);
  const result = new PhpArray();
  for (const [index, key] of keys.entries()) result.set(key, list[index]);
  return result;
});

// Building timestamps --------------------------------------------------------------------------------------------------

function makeTime(args: Value[], zone: Zone): bigint | false {
  const now = localTime({ sse: currentInstant().sse, us: 0, zone });
  const field = (index: number, fallback: number): number =>
    args[index] === null || args[index] === undefined ? fallback : Number(args[index] as bigint);
  let year = field(5, now.y);
  if (args[5] !== null && args[5] !== undefined) {
    if (year >= 0 && year < 70) year += 2000;
    else if (year >= 70 && year <= 100) year += 1900;
  }
  const fields = {
    h: field(0, now.h),
    i: field(1, now.i),
    s: field(2, now.s),
    m: field(3, now.m),
    d: field(4, now.d),
    y: year,
    us: 0,
  };
  return intResult(updateMoment(fields, emptyRelative(), false, zone));
}

const MKTIME_SIGNATURE =
  '(int $hour, ?int $minute = null, ?int $second = null, ?int $month = null, ?int $day = null, ?int $year = null): int|false';
defineFunction(`mktime${MKTIME_SIGNATURE}`, ({ args }) => makeTime(args, defaultZone()));
defineFunction(`gmmktime${MKTIME_SIGNATURE}`, ({ args }) => makeTime(args, UTC_ZONE));
defineFunction('checkdate(int $month, int $day, int $year): bool', ({ args }) => {
  const [month, day, year] = args.map((value) => Number(value as bigint));
  return year >= 1 && year <= 32_767 && isValidDate(year, month, day);
});
defineFunction('strtotime(string $datetime, ?int $baseTimestamp = null): int|false', ({ args }) => {
  const parsed = parseOrReject(args[0] as string);
  if (parsed.errors.length > 0) return false;
  return intResult(resolveParsed(parsed, momentAt(args[1] ?? null, defaultZone())));
});

// Calendar extension ---------------------------------------------------------------------------------------------------

for (const [name, value] of [
  ['CAL_GREGORIAN', 0n],
  ['CAL_JULIAN', 1n],
  ['CAL_JEWISH', 2n],
  ['CAL_FRENCH', 3n],
  ['CAL_NUM_CALS', 4n],
] as const)
  defineConstant(name, value);
defineFunction('cal_days_in_month(int $calendar, int $month, int $year): int', ({ args }) => {
  const calendar = args[0] as bigint;
  if (calendar < 0n || calendar > 3n)
    throwError('ValueError', 'cal_days_in_month(): Argument #1 ($calendar) must be a valid calendar ID');
  if (calendar !== 0n) throw new UnsupportedFeatureError('グレゴリオ暦以外の暦');
  const month = Number(args[1] as bigint);
  const year = Number(args[2] as bigint);
  if (month < 1 || month > 12 || year === 0 || year < -4713) throwError('ValueError', 'Invalid date');
  return BigInt(daysInMonth(year < 0 ? year + 1 : year, month));
});

// Procedural forms of the classes --------------------------------------------------------------------------------------

function dateClass(name: string): PhpClass {
  return rt().classes.get(name.toLowerCase()) as PhpClass;
}

for (const [name, className] of [
  ['date_create', 'DateTime'],
  ['date_create_immutable', 'DateTimeImmutable'],
] as const) {
  defineFunction(
    `${name}(string $datetime = "now", ?DateTimeZone $timezone = null): ${className}|false`,
    ({ args }) => {
      const object = createObject(dateClass(className));
      return initializeDate(object, (args[0] as string | undefined) ?? 'now', args[1] ?? null) ? false : object;
    }
  );
}
for (const [name, className] of [
  ['date_create_from_format', 'DateTime'],
  ['date_create_immutable_from_format', 'DateTimeImmutable'],
] as const) {
  defineFunction(
    `${name}(string $format, string $datetime, ?DateTimeZone $timezone = null): ${className}|false`,
    ({ args }) => {
      const moment = momentFromFormat(args[0] as string, args[1] as string, args[2] ?? null);
      return moment ? newDateObject(dateClass(className), moment) : false;
    }
  );
}
defineFunction('date_format(DateTimeInterface $object, string $format): string', ({ args }) =>
  formatMoment(momentOf(args[0] as PhpObject), args[1] as string)
);
defineFunction('date_modify(DateTime $object, string $modifier): DateTime|false', ({ args }) => {
  const object = args[0] as PhpObject;
  const result = modifyDate(momentOf(object), args[1] as string);
  if (typeof result === 'string') {
    warn(`date_modify(): ${result}`);
    return false;
  }
  setMomentOf(object, result);
  return object;
});
for (const [name, sign] of [
  ['date_add', 1],
  ['date_sub', -1],
] as const) {
  defineFunction(`${name}(DateTime $object, DateInterval $interval): DateTime`, ({ args }) => {
    const object = args[0] as PhpObject;
    setMomentOf(object, applyInterval(momentOf(object), args[1] as PhpObject, sign, name));
    return object;
  });
}
defineFunction(
  'date_diff(DateTimeInterface $baseObject, DateTimeInterface $targetObject, bool $absolute = false): DateInterval',
  ({ args }) => diffObjects(args[0] as PhpObject, args[1] as PhpObject, args[2] === true)
);
defineFunction('date_timestamp_get(DateTimeInterface $object): int', ({ args }) =>
  BigInt(momentOf(args[0] as PhpObject).sse)
);
defineFunction('date_timestamp_set(DateTime $object, int $timestamp): DateTime', ({ args }) => {
  const object = args[0] as PhpObject;
  setMomentOf(object, { ...momentOf(object), sse: timestampSeconds(args[1]), us: 0 });
  return object;
});
defineFunction('date_timezone_get(DateTimeInterface $object): DateTimeZone|false', ({ args }) =>
  newZoneObject(momentOf(args[0] as PhpObject).zone)
);
defineFunction('date_timezone_set(DateTime $object, DateTimeZone $timezone): DateTime', ({ args }) => {
  const object = args[0] as PhpObject;
  setMomentOf(object, { ...momentOf(object), zone: zoneOf(args[1] as PhpObject) });
  return object;
});
defineFunction('date_date_set(DateTime $object, int $year, int $month, int $day): DateTime', ({ args }) => {
  const object = args[0] as PhpObject;
  const moment = momentOf(object);
  const [y, m, d] = args.slice(1).map((value) => Number(value as bigint));
  setMomentOf(object, updateMoment({ ...localTime(moment), y, m, d }, emptyRelative(), false, moment.zone));
  return object;
});
defineFunction(
  'date_time_set(DateTime $object, int $hour, int $minute, int $second = 0, int $microsecond = 0): DateTime',
  ({ args }) => {
    const object = args[0] as PhpObject;
    const moment = momentOf(object);
    const [h, i, s = 0, us = 0] = args.slice(1).map((value) => Number(value as bigint));
    setMomentOf(object, updateMoment({ ...localTime(moment), h, i, s, us }, emptyRelative(), false, moment.zone));
    return object;
  }
);
defineFunction('timezone_open(string $timezone): DateTimeZone|false', ({ args }) => {
  const zone = zoneFromName(args[0] as string);
  if (typeof zone === 'string') {
    warn(`timezone_open(): ${zone}`);
    return false;
  }
  return newZoneObject(zone);
});
defineFunction('timezone_name_get(DateTimeZone $object): string', ({ args }) => {
  return zoneName(zoneOf(args[0] as PhpObject));
});
defineFunction('date_interval_create_from_date_string(string $datetime): DateInterval|false', ({ args }) => {
  const result = intervalFromDateString(args[0] as string);
  if (typeof result !== 'string') return result;
  warn(`date_interval_create_from_date_string(): ${result}`);
  return false;
});
defineFunction('date_interval_format(DateInterval $object, string $format): string', ({ args }) =>
  formatInterval(args[0] as PhpObject, args[1] as string)
);

function setMomentOf(object: PhpObject, moment: Moment): void {
  (object.internal as { moment: Moment }).moment = moment;
}
