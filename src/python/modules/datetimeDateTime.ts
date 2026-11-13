// The methods of `datetime.datetime`.
import { LOCAL_ZONE } from '../clock';
import { pyRepr, pyStr } from '../conversions';
import { method } from '../define';
import { trueDivideInt } from '../numbers';
import { callValue, getAttribute } from '../objects';
import { strLength } from '../strings';
import { None, NotImplemented, pyError, typeError, typeName } from '../types';
import type { Kwargs, PyClass, PyValue } from '../values';
import { dayOfYear, MAX_ORDINAL, MAXYEAR, toOrdinal, weekdayOf } from './calendarMath';
import { cInt, parseCArgs } from './datetimeArgs';
import { defineComparisons, defineConstants, defineGetters, signOf, valueHash } from './datetimeClasses';
import {
  ctime,
  dateStrftime,
  EPOCH_ORDINAL,
  fieldsOfMicroseconds,
  fieldsOfTimestamp,
  formatArgument,
  localEpoch,
  now,
  parseStrptime,
  replaceArguments,
  splitTimestamp,
  strftimeArgument,
  structTimeOf,
  US_PER_DAY,
  yearRangeError,
} from './datetimeDate';
import { hashOfMicroseconds, isTimedelta, newTimedelta, type PyTimedelta } from './datetimeDelta';
import { parseIsoDateTime } from './datetimeIso';
import {
  checkTzinfo,
  dateClass,
  datetimeTypeClass,
  isDate,
  isDateTime,
  isoDate,
  isoTime,
  isTime,
  newDate,
  newDateTime,
  newTime,
  type PyDate,
  type PyDateTime,
  reprName,
  type TimeOfDay,
  timeReprArguments,
  TIMESPECS,
} from './datetimeObjects';
import { MIDNIGHT, offsetText, parsedZone, timeFields } from './datetimeTime';
import { callOffsetMethod, callTzname, defineTimezoneMethods, newTimezone } from './datetimeZone';
import { defineSlot } from './numberSupport';
import { strftime, type TimeFields } from './timeFormat';

const NAMES = ['year', 'month', 'day', 'hour', 'minute', 'second', 'microsecond', 'tzinfo', 'fold'] as const;

const datetime = (self: PyValue): PyDateTime => self as PyDateTime;

datetimeTypeClass.construct = (cls, args, kwargs) => {
  const values = parseCArgs({ names: NAMES, required: 3, positional: 8 }, args, kwargs, (value) => value);
  const [year, month, day] = values.slice(0, 3).map((value) => cInt(value as PyValue));
  return newDateTime({ year, month, day, ...timeFields(values.slice(3), MIDNIGHT) }, cls);
};

// Conversions -------------------------------------------------------------------------------------------------------

/** The microseconds since 0001-01-01 of a datetime's fields, ignoring its time zone. */
function microsecondsOf(value: PyDateTime): bigint {
  const days = BigInt(toOrdinal(value.year, value.month, value.day) - 1);
  const seconds = BigInt(value.hour * 3600 + value.minute * 60 + value.second);
  return days * US_PER_DAY + seconds * 1_000_000n + BigInt(value.microsecond);
}

function fromMicroseconds(total: bigint, tzinfo: PyValue, cls: PyClass = datetimeTypeClass, fold = 0): PyDateTime {
  return newDateTime({ ...fieldsOfMicroseconds(total), tzinfo, fold }, cls);
}

function utcoffsetOf(value: PyDateTime): PyTimedelta | undefined {
  return callOffsetMethod(value.tzinfo, 'utcoffset', value);
}

/** A datetime of a timestamp: local and naive without a tzinfo, else converted by the tzinfo's `fromutc`. */
function fromTimestamp(cls: PyValue, seconds: bigint, microsecond: number, tzinfo: PyValue): PyValue {
  checkTzinfo(tzinfo);
  const fields = fieldsOfTimestamp(seconds, microsecond, tzinfo === None);
  const result = newDateTime({ ...fields, tzinfo, fold: 0 }, cls as PyClass);
  return tzinfo === None ? result : callFromutc(tzinfo, result);
}

function callFromutc(tzinfo: PyValue, value: PyDateTime): PyValue {
  return callValue(getAttribute(tzinfo, 'fromutc'), [value]);
}

const LOCAL_TIMEZONE = (): PyValue =>
  newTimezone(newTimedelta(BigInt(LOCAL_ZONE.offsetSeconds) * 1_000_000n), LOCAL_ZONE.name);

/**
 * Rejects a naive datetime whose local time CPython's `local_to_seconds` cannot solve, because converting it to and
 * from UTC passes a year beyond the calendar.
 */
function checkLocalRange(value: PyDateTime): void {
  const offset = BigInt(LOCAL_ZONE.offsetSeconds) * 1_000_000n;
  const total = microsecondsOf(value);
  if (total - offset < 0n) throw yearRangeError(0);
  if (total + offset >= BigInt(MAX_ORDINAL) * US_PER_DAY) throw yearRangeError(MAXYEAR + 1);
}

function fieldsForStrftime(value: PyDateTime): TimeFields {
  const { year, month, day, hour, minute, second, microsecond } = value;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    microsecond,
    weekday: weekdayOf(year, month, day),
    yearDay: dayOfYear(year, month, day),
  };
}

function datetimeStrftime(value: PyDateTime, format: string): string {
  const fields = fieldsForStrftime(value);
  const offset = utcoffsetOf(value);
  const zone = callTzname(value.tzinfo, value);
  return strftime(format, {
    ...fields,
    offset: { plain: offsetText(offset, ''), colon: offsetText(offset) },
    zone: zone === None ? '' : pyStr(zone),
    epoch: localEpoch(fields),
  });
}

function isoformat(value: PyDateTime, args: PyValue[], kwargs: Kwargs): string {
  const [separator, timespec] = parseCArgs(
    { names: ['sep', 'timespec'], required: 0, name: 'isoformat' },
    args,
    kwargs,
    (each) => each
  );
  const sep = separator ?? 'T';
  if (typeof sep !== 'string' || strLength(sep) !== 1) {
    const shown = typeof sep === 'string' ? `a string of length ${strLength(sep)}` : typeName(sep);
    throw typeError(`isoformat() argument 1 must be a unicode character, not ${shown}`);
  }
  const spec = timespec ?? 'auto';
  if (typeof spec !== 'string') throw typeError(`isoformat() argument 2 must be str, not ${typeName(spec)}`);
  if (!TIMESPECS.includes(spec)) throw pyError('ValueError', 'Unknown timespec value');
  return `${isoDate(value)}${sep}${isoTime(value, spec)}${offsetText(utcoffsetOf(value))}`;
}

// Attributes and text -----------------------------------------------------------------------------------------------

defineGetters(datetimeTypeClass, {
  hour: (self) => BigInt(datetime(self).hour),
  minute: (self) => BigInt(datetime(self).minute),
  second: (self) => BigInt(datetime(self).second),
  microsecond: (self) => BigInt(datetime(self).microsecond),
  tzinfo: (self) => datetime(self).tzinfo,
  fold: (self) => BigInt(datetime(self).fold),
});
defineConstants(datetimeTypeClass, () => ({
  min: newDateTime({ year: 1, month: 1, day: 1, ...MIDNIGHT }),
  max: newDateTime({
    year: 9999,
    month: 12,
    day: 31,
    hour: 23,
    minute: 59,
    second: 59,
    microsecond: 999_999,
    tzinfo: None,
    fold: 0,
  }),
  resolution: newTimedelta(1n),
}));

method(datetimeTypeClass, '__repr__', 'none', 0, 0, (self) => {
  const value = datetime(self);
  return `${reprName(value)}(${value.year}, ${value.month}, ${value.day}, ${timeReprArguments(value, pyRepr, 2)})`;
});
method(datetimeTypeClass, '__str__', 'none', 0, 0, (self) => isoformat(datetime(self), [' '], undefined));
method(datetimeTypeClass, 'isoformat', 'takes', 0, 2, (self, args, kwargs) => isoformat(datetime(self), args, kwargs), {
  keywords: ['sep', 'timespec'],
});
method(datetimeTypeClass, 'ctime', 'none', 0, 0, (self) => ctime(fieldsForStrftime(datetime(self))));
method(
  dateClass,
  'strftime',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    const format = strftimeArgument(args, kwargs);
    return isDateTime(self) ? datetimeStrftime(self, format) : dateStrftime(self as PyDate, format);
  },
  { keywords: ['format'] }
);
defineSlot(datetimeTypeClass, '__format__', (self, [spec]) => {
  const text = formatArgument(spec);
  return text === '' ? pyStr(self) : datetimeStrftime(datetime(self), text);
});
method(datetimeTypeClass, 'utcoffset', 'none', 0, 0, (self) => utcoffsetOf(datetime(self)) ?? None);
method(datetimeTypeClass, 'dst', 'none', 0, 0, (self) => callOffsetMethod(datetime(self).tzinfo, 'dst', self) ?? None);
method(datetimeTypeClass, 'tzname', 'none', 0, 0, (self) => callTzname(datetime(self).tzinfo, self));
method(datetimeTypeClass, 'date', 'none', 0, 0, (self) => {
  const { year, month, day } = datetime(self);
  return newDate(year, month, day);
});
method(datetimeTypeClass, 'time', 'none', 0, 0, (self) => newTime({ ...timeOf(datetime(self)), tzinfo: None }));
method(datetimeTypeClass, 'timetz', 'none', 0, 0, (self) => newTime(timeOf(datetime(self))));

function timeOf(value: PyDateTime): TimeOfDay {
  const { hour, minute, second, microsecond, tzinfo, fold } = value;
  return { hour, minute, second, microsecond, tzinfo, fold };
}

method(datetimeTypeClass, 'timetuple', 'none', 0, 0, (self) => {
  const value = datetime(self);
  const dst = value.tzinfo === None ? undefined : callOffsetMethod(value.tzinfo, 'dst', value);
  const isDst = value.tzinfo === None || dst === undefined ? -1 : dst.totalMicroseconds === 0n ? 0 : 1;
  return structTimeOf(fieldsForStrftime(value), isDst);
});
method(datetimeTypeClass, 'utctimetuple', 'none', 0, 0, (self) => {
  const value = datetime(self);
  const offset = utcoffsetOf(value);
  const utc = offset === undefined ? value : fromMicroseconds(microsecondsOf(value) - offset.totalMicroseconds, None);
  return structTimeOf(fieldsForStrftime(utc), 0);
});
method(datetimeTypeClass, 'timestamp', 'none', 0, 0, (self) => {
  const value = datetime(self);
  const offset = utcoffsetOf(value);
  const epoch = BigInt(EPOCH_ORDINAL - 1) * US_PER_DAY;
  if (offset !== undefined) return trueDivideInt(microsecondsOf(value) - offset.totalMicroseconds - epoch, 1_000_000n);
  checkLocalRange(value);
  const seconds = (microsecondsOf(value) - BigInt(value.microsecond)) / 1_000_000n - BigInt(LOCAL_ZONE.offsetSeconds);
  return Number(seconds - epoch / 1_000_000n) + value.microsecond / 1e6;
});
method(
  datetimeTypeClass,
  'replace',
  'takes',
  0,
  9,
  (self, args, kwargs) => replaceDateTime(datetime(self), args, kwargs),
  {
    keywords: NAMES,
  }
);
method(
  datetimeTypeClass,
  '__replace__',
  'takes',
  0,
  9,
  (self, args, kwargs) => replaceDateTime(datetime(self), args, kwargs),
  { keywords: NAMES }
);

function replaceDateTime(value: PyDateTime, args: PyValue[], kwargs: Kwargs): PyDateTime {
  const given = replaceArguments(NAMES, 8, args, kwargs);
  const integer = (name: 'year' | 'month' | 'day'): number => {
    const replacement = given.get(name);
    return replacement === undefined ? value[name] : cInt(replacement);
  };
  const time = timeFields(
    NAMES.slice(3).map((name) => given.get(name)),
    value
  );
  return newDateTime({ year: integer('year'), month: integer('month'), day: integer('day'), ...time }, value.cls);
}

method(
  datetimeTypeClass,
  'astimezone',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    const value = datetime(self);
    const tzinfo = args[0] ?? kwargs?.get('tz') ?? None;
    checkTzinfo(tzinfo);
    if (value.tzinfo === None) checkLocalRange(value);
    const own = value.tzinfo === None ? LOCAL_TIMEZONE() : value.tzinfo;
    if (own === tzinfo) return value;
    const offset =
      callOffsetMethod(own, 'utcoffset', value) ?? newTimedelta(BigInt(LOCAL_ZONE.offsetSeconds) * 1_000_000n);
    const utc = microsecondsOf(value) - offset.totalMicroseconds;
    if (tzinfo === None) {
      return fromMicroseconds(utc + BigInt(LOCAL_ZONE.offsetSeconds) * 1_000_000n, LOCAL_TIMEZONE(), value.cls);
    }
    return callFromutc(tzinfo, fromMicroseconds(utc, tzinfo, value.cls));
  },
  { keywords: ['tz'] }
);

// Class methods -----------------------------------------------------------------------------------------------------

function classMethod(
  name: string,
  min: number,
  max: number,
  run: (cls: PyValue, args: PyValue[], kwargs: Kwargs) => PyValue,
  keywords?: string[]
): void {
  method(datetimeTypeClass, name, keywords ? 'takes' : 'expected', min, max, run, { binding: 'class', keywords });
}

classMethod(
  'now',
  0,
  1,
  (cls, args, kwargs) => {
    const tzinfo = args[0] ?? kwargs?.get('tz') ?? None;
    checkTzinfo(tzinfo);
    const [seconds, microsecond] = now();
    return fromTimestamp(cls, seconds, microsecond, tzinfo);
  },
  ['tz']
);
classMethod('today', 0, 0, (cls) => {
  const [seconds, microsecond] = now();
  return fromTimestamp(cls, seconds, microsecond, None);
});
classMethod('utcnow', 0, 0, (cls) => {
  const [seconds, microsecond] = now();
  return newDateTime({ ...fieldsOfTimestamp(seconds, microsecond, false), tzinfo: None, fold: 0 }, cls as PyClass);
});
classMethod(
  'fromtimestamp',
  1,
  2,
  (cls, args, kwargs) => {
    const [timestamp, tzinfo] = parseCArgs(
      { names: ['timestamp', 'tz'], required: 1, name: 'fromtimestamp' },
      args,
      kwargs,
      (value) => value
    );
    const [seconds, microsecond] = splitTimestamp(timestamp as PyValue);
    return fromTimestamp(cls, seconds, microsecond, tzinfo ?? None);
  },
  ['timestamp', 'tz']
);
classMethod('utcfromtimestamp', 1, 1, (cls, [timestamp]) => {
  const [seconds, microsecond] = splitTimestamp(timestamp);
  return newDateTime({ ...fieldsOfTimestamp(seconds, microsecond, false), tzinfo: None, fold: 0 }, cls as PyClass);
});
classMethod(
  'combine',
  2,
  3,
  (cls, args, kwargs) => {
    const [date, time, tzinfo] = parseCArgs(
      { names: ['date', 'time', 'tzinfo'], required: 2, name: 'combine' },
      args,
      kwargs,
      (value) => value
    );
    if (!isDate(date as PyValue))
      throw typeError(`combine() argument 1 must be datetime.date, not ${typeName(date as PyValue)}`);
    if (!isTime(time as PyValue))
      throw typeError(`combine() argument 2 must be datetime.time, not ${typeName(time as PyValue)}`);
    const { year, month, day } = date as PyDateTime;
    const clock = timeOf(time as unknown as PyDateTime);
    return newDateTime({ year, month, day, ...clock, tzinfo: tzinfo ?? clock.tzinfo }, cls as PyClass);
  },
  ['date', 'time', 'tzinfo']
);
classMethod('fromisoformat', 1, 1, (cls, [text]) => {
  if (typeof text !== 'string') throw typeError('fromisoformat: argument must be str');
  const parsed = parseIsoDateTime(text);
  if (!parsed) throw pyError('ValueError', `Invalid isoformat string: ${pyRepr(text)}`);
  let [year, month, day] = parsed.date;
  const { time } = parsed;
  let { hour } = time;
  if (hour === 24) {
    if (time.minute !== 0 || time.second !== 0 || time.microsecond !== 0) {
      throw pyError('ValueError', 'minute, second, and microsecond must be 0 when hour is 24');
    }
    hour = 0;
    [year, month, day] = nextDay(year, month, day);
  }
  const tzinfo =
    time.offset === undefined
      ? None
      : newTimezone(newTimedelta(BigInt(time.offset[0]) * 1_000_000n + BigInt(time.offset[1])));
  return newDateTime({ year, month, day, ...time, hour, tzinfo, fold: 0 }, cls as PyClass);
});

function nextDay(year: number, month: number, day: number): [number, number, number] {
  const ordinal = toOrdinal(year, month, day);
  const fields = fieldsOfMicroseconds(BigInt(ordinal) * US_PER_DAY);
  return [fields.year, fields.month, fields.day];
}

classMethod('strptime', 2, 2, (cls, [text, format]) => {
  const parsed = parseStrptime(text, format);
  const { year, month, day, hour, minute, second, fraction } = parsed;
  return newDateTime(
    { year, month, day, hour, minute, second, microsecond: fraction, tzinfo: parsedZone(parsed), fold: 0 },
    cls as PyClass
  );
});

// Arithmetic and comparison -----------------------------------------------------------------------------------------

function shift(value: PyDateTime, microseconds: bigint): PyDateTime {
  return fromMicroseconds(microsecondsOf(value) + microseconds, value.tzinfo, value.cls);
}

method(datetimeTypeClass, '__add__', 'one', 1, 1, (self, [other]) =>
  isTimedelta(other) ? shift(datetime(self), other.totalMicroseconds) : NotImplemented
);
method(datetimeTypeClass, '__radd__', 'one', 1, 1, (self, [other]) =>
  isTimedelta(other) ? shift(datetime(self), other.totalMicroseconds) : NotImplemented
);
method(datetimeTypeClass, '__sub__', 'one', 1, 1, (self, [other]) => {
  const left = datetime(self);
  if (isTimedelta(other)) return shift(left, -other.totalMicroseconds);
  if (!isDateTime(other)) return NotImplemented;
  return newTimedelta(utcDifference(left, other, 'subtract'));
});

/** `left - right` in microseconds, through UTC when their time zones differ. */
function utcDifference(left: PyDateTime, right: PyDateTime, action: 'subtract' | 'compare'): bigint {
  const difference = microsecondsOf(left) - microsecondsOf(right);
  if (left.tzinfo === right.tzinfo) return difference;
  const leftOffset = utcoffsetOf(left);
  const rightOffset = utcoffsetOf(right);
  if ((leftOffset === undefined) !== (rightOffset === undefined)) {
    throw typeError(`can't ${action} offset-naive and offset-aware datetimes`);
  }
  return difference - (leftOffset?.totalMicroseconds ?? 0n) + (rightOffset?.totalMicroseconds ?? 0n);
}

defineComparisons(datetimeTypeClass, (self, other, name) => {
  if (!isDateTime(other)) return NotImplemented;
  const left = datetime(self);
  if (name === '__eq__' || name === '__ne__') {
    const naive = (utcoffsetOf(left) === undefined) !== (utcoffsetOf(other) === undefined);
    if (naive && left.tzinfo !== other.tzinfo) return name === '__ne__';
  }
  return signOf(utcDifference(left, other, 'compare'));
});
valueHash(datetimeTypeClass, (self) => {
  const value = datetime(self);
  // CPython asks for the offset of the fold-0 time, so that both folds of a time hash alike, and counts days from 1.
  const local = microsecondsOf(value);
  const offset = utcoffsetOf(value.fold === 0 ? value : fromMicroseconds(local, value.tzinfo));
  return hashOfMicroseconds(local + US_PER_DAY - (offset?.totalMicroseconds ?? 0n));
});

defineTimezoneMethods(
  isDateTime,
  (dt, microseconds) => shift(datetime(dt), microseconds),
  (dt) => datetime(dt).tzinfo
);
