// The methods of `datetime.date`, and the conversions between timestamps and calendar fields they share.
import { LOCAL_ZONE, wallClockNanoseconds } from '../clock';
import { pyRepr, pyStr } from '../conversions';
import { method } from '../define';
import { tupleHash } from '../hashing';
import { floorDivInt } from '../numbers';
import { currentRuntime } from '../runtimeContext';
import {
  intClass,
  isInstanceOf,
  None,
  NotImplemented,
  pyError,
  stringValue,
  typeError,
  typeName,
  unbox,
} from '../types';
import type { Kwargs, PyClass, PyValue } from '../values';
import {
  dayOfYear,
  fromIsoCalendar,
  fromOrdinal,
  isoCalendar,
  MAX_ORDINAL,
  toOrdinal,
  weekdayOf,
} from './calendarMath';
import { makeNamedTupleClass } from './collections';
import { cInt, parseCArgs } from './datetimeArgs';
import { defineComparisons, defineConstants, defineGetters, valueHash } from './datetimeClasses';
import { isTimedelta, newTimedelta } from './datetimeDelta';
import { parseIsoDate } from './datetimeIso';
import {
  dateClass,
  datetimeTypeClass,
  isDate,
  isDateTime,
  isoDate,
  newDate,
  newDateTime,
  type PyDate,
  reprName,
} from './datetimeObjects';
import { defineSlot } from './numberSupport';
import { PyStructTime } from './structTime';
import { DAY_NAMES, MONTH_NAMES, strftime, strptime, type TimeFields } from './timeFormat';

export const US_PER_DAY = 86_400_000_000n;
export const EPOCH_ORDINAL = 719_163;

const date = (self: PyValue): PyDate => self as PyDate;

dateClass.construct = (cls, args, kwargs) => {
  const [year, month, day] = parseCArgs({ names: ['year', 'month', 'day'], required: 3 }, args, kwargs, cInt);
  return newDate(year as number, month as number, day as number, cls);
};

// Timestamps --------------------------------------------------------------------------------------------------------

/** Splits a timestamp into whole seconds and microseconds, rounding halves to even as `_PyTime_ObjectToTimeval` does. */
export function splitTimestamp(value: PyValue): [bigint, number] {
  const numeric = unbox(value);
  if (isInstanceOf(value, intClass)) {
    const seconds = typeof numeric === 'boolean' ? BigInt(numeric) : (numeric as bigint);
    checkTimeT(seconds);
    return [seconds, 0];
  }
  if (typeof numeric !== 'number') throw typeError(`argument must be int or float, not ${typeName(value)}`);
  if (Number.isNaN(numeric)) throw pyError('ValueError', 'Invalid value NaN (not a number)');
  let whole = Math.trunc(numeric);
  let fraction = roundHalfEven((numeric - whole) * 1e6);
  if (fraction >= 1e6) {
    fraction -= 1e6;
    whole += 1;
  } else if (fraction < 0) {
    fraction += 1e6;
    whole -= 1;
  }
  if (!Number.isFinite(whole) || Math.abs(whole) >= 2 ** 63) {
    throw pyError('OverflowError', 'timestamp out of range for platform time_t');
  }
  return [BigInt(whole), fraction];
}

function checkTimeT(seconds: bigint): void {
  if (seconds >= 1n << 63n || seconds < -(1n << 63n)) {
    throw pyError('OverflowError', 'timestamp out of range for platform time_t');
  }
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference > 0.5) return floor + 1;
  if (difference < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The calendar fields of a count of microseconds since 0001-01-01, raising OverflowError outside the calendar. */
export function fieldsOfMicroseconds(total: bigint): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
} {
  const days = total >= 0n ? total / US_PER_DAY : -((-total + US_PER_DAY - 1n) / US_PER_DAY);
  const ordinal = Number(days) + 1;
  if (ordinal < 1 || ordinal > MAX_ORDINAL) throw pyError('OverflowError', 'date value out of range');
  const rest = Number(total - days * US_PER_DAY);
  const [year, month, day] = fromOrdinal(ordinal);
  const seconds = Math.floor(rest / 1e6);
  return {
    year,
    month,
    day,
    hour: Math.floor(seconds / 3600),
    minute: Math.floor(seconds / 60) % 60,
    second: seconds % 60,
    microsecond: rest % 1e6,
  };
}

/** The local or UTC calendar fields of a timestamp, as `localtime()` and `gmtime()` compute them. */
export function fieldsOfTimestamp(
  seconds: bigint,
  microsecond: number,
  local: boolean
): ReturnType<typeof fieldsOfMicroseconds> {
  const shifted = seconds + BigInt(local ? LOCAL_ZONE.offsetSeconds : 0);
  const days = Number(floorDivInt(shifted, 86_400n)) + EPOCH_ORDINAL;
  if (days < 1 || days > MAX_ORDINAL) throw yearRangeError(fromOrdinal(days)[0]);
  return fieldsOfMicroseconds((shifted + BigInt(EPOCH_ORDINAL - 1) * 86_400n) * 1_000_000n + BigInt(microsecond));
}

export function yearRangeError(year: number): Error {
  return pyError('ValueError', `year must be in 1..9999, not ${year}`);
}

/** The current time as whole seconds since the epoch and microseconds, read from the run's clock. */
export function now(): [bigint, number] {
  const nanoseconds = wallClockNanoseconds(currentRuntime());
  const microseconds = nanoseconds / 1000n;
  return [microseconds / 1_000_000n, Number(microseconds % 1_000_000n)];
}

// Formatting --------------------------------------------------------------------------------------------------------

/** The fields `strftime` reads for a date at midnight. */
export function dateFields(value: PyDate): TimeFields {
  const { year, month, day } = value;
  return {
    year,
    month,
    day,
    hour: 0,
    minute: 0,
    second: 0,
    weekday: weekdayOf(year, month, day),
    yearDay: dayOfYear(year, month, day),
  };
}

/** The seconds since the epoch of local time fields, as macOS's `mktime` computes `%s`, failing before 1900. */
export function localEpoch(fields: TimeFields): number | undefined {
  if (fields.year < 1900) return undefined;
  const days = toOrdinal(fields.year, fields.month, fields.day) - EPOCH_ORDINAL;
  return days * 86_400 + fields.hour * 3600 + fields.minute * 60 + fields.second - LOCAL_ZONE.offsetSeconds;
}

/** Reads the format of a `strftime` method. */
export function strftimeArgument(args: PyValue[], kwargs: Kwargs): string {
  const [format] = parseCArgs({ names: ['format'], required: 1, name: 'strftime' }, args, kwargs, (value) => value);
  const text = stringValue(format as PyValue);
  if (text === undefined) throw typeError(`strftime() argument 1 must be str, not ${typeName(format as PyValue)}`);
  return text;
}

export function formatArgument(spec: PyValue): string {
  if (typeof spec !== 'string') throw typeError(`__format__() argument 1 must be str, not ${typeName(spec)}`);
  return spec;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The text of `ctime()`, whose year datetime pads to four digits and `time.asctime` does not. */
export function ctime(fields: TimeFields, padYear = true): string {
  const { year, month, day, hour, minute, second, weekday } = fields;
  return `${DAY_NAMES[weekday].slice(0, 3)} ${MONTH_NAMES[month].slice(0, 3)} ${String(day).padStart(2, ' ')} ${pad(hour)}:${pad(minute)}:${pad(second)} ${padYear ? String(year).padStart(4, '0') : year}`;
}

export function structTimeOf(fields: TimeFields, isDst: number): PyStructTime {
  const { year, month, day, hour, minute, second, weekday, yearDay } = fields;
  return new PyStructTime([year, month, day, hour, minute, second, weekday, yearDay, isDst].map(BigInt));
}

export const isoCalendarDateClass = makeNamedTupleClass('IsoCalendarDate', ['year', 'week', 'weekday'], 'datetime');
method(isoCalendarDateClass, '__repr__', 'none', 0, 0, (self) => {
  const [year, week, weekday] = (self as unknown as { items: PyValue[] }).items;
  return `datetime.IsoCalendarDate(year=${pyStr(year)}, week=${pyStr(week)}, weekday=${pyStr(weekday)})`;
});

/** Reads the keyword or positional replacements of `replace()`, as Argument Clinic does. */
export function replaceArguments(
  names: readonly string[],
  positional: number,
  args: PyValue[],
  kwargs: Kwargs
): Map<string, PyValue> {
  const total = args.length + (kwargs?.size ?? 0);
  if (args.length > positional) {
    throw typeError(
      `replace() takes at most ${positional} positional argument${positional === 1 ? '' : 's'} (${args.length} given)`
    );
  }
  if (total > names.length) throw typeError(`replace() takes at most ${names.length} arguments (${total} given)`);
  const values = new Map<string, PyValue>();
  for (const [index, value] of args.entries()) values.set(names[index], value);
  for (const [key, value] of kwargs ?? []) {
    const index = names.indexOf(key);
    if (index === -1) throw typeError(`replace() got an unexpected keyword argument '${key}'`);
    if (index < args.length)
      throw typeError(`argument for replace() given by name ('${key}') and position (${index + 1})`);
    values.set(key, value);
  }
  return values;
}

// Methods -----------------------------------------------------------------------------------------------------------

defineGetters(dateClass, {
  year: (self) => BigInt(date(self).year),
  month: (self) => BigInt(date(self).month),
  day: (self) => BigInt(date(self).day),
});
defineConstants(dateClass, () => ({
  min: newDate(1, 1, 1),
  max: newDate(9999, 12, 31),
  resolution: newTimedelta(US_PER_DAY),
}));

method(dateClass, '__repr__', 'none', 0, 0, (self) => {
  const value = date(self);
  return `${reprName(value)}(${value.year}, ${value.month}, ${value.day})`;
});
method(dateClass, 'isoformat', 'none', 0, 0, (self) => isoDate(date(self)));
method(dateClass, '__str__', 'none', 0, 0, (self) => isoDate(date(self)));
method(dateClass, 'ctime', 'none', 0, 0, (self) => ctime(dateFields(date(self))));
method(
  dateClass,
  'strftime',
  'takes',
  0,
  1,
  (self, args, kwargs) => dateStrftime(date(self), strftimeArgument(args, kwargs)),
  {
    keywords: ['format'],
  }
);
defineSlot(dateClass, '__format__', (self, [spec]) => {
  const text = formatArgument(spec);
  return text === '' ? pyStr(self) : dateStrftime(date(self), text);
});
method(dateClass, 'timetuple', 'none', 0, 0, (self) => structTimeOf(dateFields(date(self)), -1));
method(dateClass, 'toordinal', 'none', 0, 0, (self) => {
  const { year, month, day } = date(self);
  return BigInt(toOrdinal(year, month, day));
});
method(dateClass, 'weekday', 'none', 0, 0, (self) => {
  const { year, month, day } = date(self);
  return BigInt(weekdayOf(year, month, day));
});
method(dateClass, 'isoweekday', 'none', 0, 0, (self) => {
  const { year, month, day } = date(self);
  return BigInt(weekdayOf(year, month, day) + 1);
});
method(dateClass, 'isocalendar', 'none', 0, 0, (self) => {
  const { year, month, day } = date(self);
  return currentRuntime().instantiate(isoCalendarDateClass, isoCalendar(year, month, day).map(BigInt), undefined);
});
method(dateClass, 'replace', 'takes', 0, 3, (self, args, kwargs) => replaceDate(date(self), args, kwargs), {
  keywords: ['year', 'month', 'day'],
});
method(dateClass, '__replace__', 'takes', 0, 3, (self, args, kwargs) => replaceDate(date(self), args, kwargs), {
  keywords: ['year', 'month', 'day'],
});

function replaceDate(value: PyDate, args: PyValue[], kwargs: Kwargs): PyDate {
  const values = replaceArguments(['year', 'month', 'day'], 3, args, kwargs);
  const field = (name: 'year' | 'month' | 'day'): number => {
    const given = values.get(name);
    return given === undefined ? value[name] : cInt(given);
  };
  return newDate(field('year'), field('month'), field('day'), value.cls);
}

export function dateStrftime(value: PyDate, format: string): string {
  const fields = dateFields(value);
  return strftime(format, {
    ...fields,
    microsecond: 0,
    offset: { plain: '', colon: '' },
    zone: '',
    epoch: localEpoch(fields),
  });
}

// Class methods -----------------------------------------------------------------------------------------------------

/** A date of `cls`, at midnight when `cls` is a datetime class. */
function newOfClass(cls: PyValue, year: number, month: number, day: number): PyDate {
  const type = cls as PyClass;
  if (type.isSubclassOf(datetimeTypeClass)) {
    return newDateTime(
      { year, month, day, hour: 0, minute: 0, second: 0, microsecond: 0, tzinfo: None, fold: 0 },
      type
    );
  }
  return newDate(year, month, day, type);
}

method(
  dateClass,
  'today',
  'none',
  0,
  0,
  (cls) => {
    const [seconds, microsecond] = now();
    const { year, month, day } = fieldsOfTimestamp(seconds, microsecond, true);
    return newOfClass(cls, year, month, day);
  },
  { binding: 'class' }
);
method(
  dateClass,
  'fromtimestamp',
  'one',
  1,
  1,
  (cls, [timestamp]) => {
    const [seconds, microsecond] = splitTimestamp(timestamp);
    const { year, month, day } = fieldsOfTimestamp(seconds, microsecond, true);
    return newOfClass(cls, year, month, day);
  },
  { binding: 'class' }
);
method(
  dateClass,
  'fromordinal',
  'one',
  1,
  1,
  (cls, [ordinal]) => {
    const value = cInt(ordinal);
    if (value < 1) throw pyError('ValueError', 'ordinal must be >= 1');
    if (value > MAX_ORDINAL) throw pyError('ValueError', `year ${fromOrdinalYear(value)} is out of range`);
    const [year, month, day] = fromOrdinal(value);
    return newOfClass(cls, year, month, day);
  },
  { binding: 'class' }
);

function fromOrdinalYear(ordinal: number): number {
  return Math.floor((ordinal - 1) / 365.2425) + 1;
}

method(
  dateClass,
  'fromisoformat',
  'one',
  1,
  1,
  (cls, [rawText]) => {
    const text = stringValue(rawText);
    if (text === undefined) throw typeError('fromisoformat: argument must be str');
    const parsed = parseIsoDate(text);
    if (!parsed) throw pyError('ValueError', `Invalid isoformat string: ${pyRepr(rawText)}`);
    return newOfClass(cls, ...parsed);
  },
  { binding: 'class' }
);
method(
  dateClass,
  'fromisocalendar',
  'takes',
  3,
  3,
  (cls, args, kwargs) => {
    const [year, week, day] = parseCArgs(
      { names: ['year', 'week', 'day'], required: 3, name: 'fromisocalendar' },
      args,
      kwargs,
      cInt
    ) as number[];
    const result = fromIsoCalendar(year, week, day);
    if (typeof result === 'string') throw pyError('ValueError', result);
    return newOfClass(cls, ...result);
  },
  { binding: 'class', keywords: ['year', 'week', 'day'] }
);
method(
  dateClass,
  'strptime',
  'expected',
  2,
  2,
  (cls, [text, format]) => {
    const parsed = parseStrptime(text, format);
    return newOfClass(cls, parsed.year, parsed.month, parsed.day);
  },
  { binding: 'class' }
);

/** Runs `strptime`, raising its errors as CPython's `_strptime` does. */
export function parseStrptime(
  text: PyValue,
  format: PyValue,
  fromPython = false
): Exclude<ReturnType<typeof strptime>, { error: string }> {
  for (const [index, value] of [text, format].entries()) {
    if (stringValue(value) !== undefined) continue;
    // `time.strptime` checks its arguments in Python, and the datetime classes in C.
    throw typeError(
      fromPython
        ? `strptime() argument ${index} must be str, not <class '${typeName(value)}'>`
        : `strptime() argument ${index + 1} must be str, not ${typeName(value)}`
    );
  }
  const parsed = strptime(stringValue(text) as string, stringValue(format) as string);
  if ('error' in parsed) throw pyError('ValueError', parsed.error);
  return parsed;
}

// Arithmetic and comparison -----------------------------------------------------------------------------------------

function ordinalOf(value: PyDate): number {
  return toOrdinal(value.year, value.month, value.day);
}

function shiftDate(value: PyDate, days: number): PyDate {
  const ordinal = ordinalOf(value) + days;
  if (ordinal < 1 || ordinal > MAX_ORDINAL) throw pyError('OverflowError', 'date value out of range');
  const [year, month, day] = fromOrdinal(ordinal);
  return newDate(year, month, day, value.cls);
}

method(dateClass, '__add__', 'one', 1, 1, (self, [other]) =>
  isTimedelta(other) && !isDateTime(self) ? shiftDate(date(self), other.days) : NotImplemented
);
method(dateClass, '__radd__', 'one', 1, 1, (self, [other]) =>
  isTimedelta(other) && !isDateTime(self) ? shiftDate(date(self), other.days) : NotImplemented
);
method(dateClass, '__sub__', 'one', 1, 1, (self, [other]) => {
  if (isDateTime(self)) return NotImplemented;
  if (isTimedelta(other)) return shiftDate(date(self), -other.days);
  if (isDate(other) && !isDateTime(other)) {
    return newTimedelta(BigInt(ordinalOf(date(self)) - ordinalOf(other)) * US_PER_DAY);
  }
  return NotImplemented;
});

defineComparisons(dateClass, (self, other) => {
  if (isDateTime(self) || !isDate(other) || isDateTime(other)) return NotImplemented;
  return Math.sign(ordinalOf(date(self)) - ordinalOf(other));
});
valueHash(dateClass, (self) => {
  const { year, month, day } = date(self);
  return tupleHash([BigInt(year), BigInt(month), BigInt(day)]);
});
