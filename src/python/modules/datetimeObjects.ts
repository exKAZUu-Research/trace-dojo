// The instances of `datetime.date`, `datetime.time`, and `datetime.datetime`, and the checks their constructors make.
import { None, pyError, typeError, typeName } from '../types';
import { type PyClass, PyInstance, type PyValue } from '../values';
import { daysInMonth, MAXYEAR, MINYEAR } from './calendarMath';
import { datetimeClass } from './datetimeClasses';
import { isTzinfo } from './datetimeZone';

export class PyDate extends PyInstance {
  constructor(
    cls: PyClass,
    readonly year: number,
    readonly month: number,
    readonly day: number
  ) {
    super(cls);
  }
}

export interface TimeOfDay {
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
  tzinfo: PyValue;
  fold: number;
}

export class PyDateTime extends PyDate implements TimeOfDay {
  // code-gauge-allow functionParameterCount 10 -- Mirrors the fields of a datetime.
  constructor(
    cls: PyClass,
    year: number,
    month: number,
    day: number,
    readonly hour: number,
    readonly minute: number,
    readonly second: number,
    readonly microsecond: number,
    readonly tzinfo: PyValue,
    readonly fold: number
  ) {
    super(cls, year, month, day);
  }
}

export class PyTime extends PyInstance implements TimeOfDay {
  // code-gauge-allow functionParameterCount 7 -- Mirrors the fields of a time.
  constructor(
    cls: PyClass,
    readonly hour: number,
    readonly minute: number,
    readonly second: number,
    readonly microsecond: number,
    readonly tzinfo: PyValue,
    readonly fold: number
  ) {
    super(cls);
  }
}

export const dateClass = datetimeClass('date');
export const timeClass = datetimeClass('time');
export const datetimeTypeClass = datetimeClass('datetime', dateClass);

export function isDate(value: PyValue): value is PyDate {
  return value instanceof PyDate;
}

export function isDateTime(value: PyValue): value is PyDateTime {
  return value instanceof PyDateTime;
}

export function isTime(value: PyValue): value is PyTime {
  return value instanceof PyTime;
}

export function checkDateFields(year: number, month: number, day: number): void {
  if (year < MINYEAR || year > MAXYEAR)
    throw pyError('ValueError', `year must be in ${MINYEAR}..${MAXYEAR}, not ${year}`);
  if (month < 1 || month > 12) throw pyError('ValueError', `month must be in 1..12, not ${month}`);
  const last = daysInMonth(year, month);
  if (day < 1 || day > last) {
    throw pyError('ValueError', `day ${day} must be in range 1..${last} for month ${month} in year ${year}`);
  }
}

export function checkTimeFields(hour: number, minute: number, second: number, microsecond: number, fold: number): void {
  if (hour < 0 || hour > 23) throw pyError('ValueError', `hour must be in 0..23, not ${hour}`);
  if (minute < 0 || minute > 59) throw pyError('ValueError', `minute must be in 0..59, not ${minute}`);
  if (second < 0 || second > 59) throw pyError('ValueError', `second must be in 0..59, not ${second}`);
  if (microsecond < 0 || microsecond > 999_999) {
    throw pyError('ValueError', `microsecond must be in 0..999999, not ${microsecond}`);
  }
  if (fold !== 0 && fold !== 1) throw pyError('ValueError', `fold must be either 0 or 1, not ${fold}`);
}

export function checkTzinfo(tzinfo: PyValue): void {
  if (tzinfo !== None && !isTzinfo(tzinfo)) {
    throw typeError(`tzinfo argument must be None or of a tzinfo subclass, not type '${typeName(tzinfo)}'`);
  }
}

/** The name a repr starts with: `datetime.date` for the builtin class, the class's own name for a subclass. */
export function reprName(value: PyInstance): string {
  return value.cls.typeName ?? value.cls.name;
}

export function newDate(year: number, month: number, day: number, cls: PyClass = dateClass): PyDate {
  checkDateFields(year, month, day);
  return new PyDate(cls, year, month, day);
}

/** A datetime from fields, raising OverflowError for a date beyond the calendar as arithmetic does. */
export function newDateTime(
  fields: { year: number; month: number; day: number } & TimeOfDay,
  cls: PyClass = datetimeTypeClass
): PyDateTime {
  const { year, month, day, hour, minute, second, microsecond, tzinfo, fold } = fields;
  checkDateFields(year, month, day);
  checkTimeFields(hour, minute, second, microsecond, fold);
  checkTzinfo(tzinfo);
  return new PyDateTime(cls, year, month, day, hour, minute, second, microsecond, tzinfo, fold);
}

export function newTime(fields: TimeOfDay, cls: PyClass = timeClass): PyTime {
  const { hour, minute, second, microsecond, tzinfo, fold } = fields;
  checkTimeFields(hour, minute, second, microsecond, fold);
  checkTzinfo(tzinfo);
  return new PyTime(cls, hour, minute, second, microsecond, tzinfo, fold);
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

export const TIMESPECS = ['auto', 'hours', 'minutes', 'seconds', 'milliseconds', 'microseconds'];

/** The `HH:MM:SS.ffffff` part of an isoformat, as `timespec` asks for it. */
export function isoTime(time: TimeOfDay, timespec: string): string {
  const { hour, minute, second, microsecond } = time;
  const spec = timespec === 'auto' ? (microsecond === 0 ? 'seconds' : 'microseconds') : timespec;
  switch (spec) {
    case 'hours': {
      return pad(hour);
    }
    case 'minutes': {
      return `${pad(hour)}:${pad(minute)}`;
    }
    case 'seconds': {
      return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
    }
    case 'milliseconds': {
      return `${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(Math.floor(microsecond / 1000), 3)}`;
    }
    case 'microseconds': {
      return `${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(microsecond, 6)}`;
    }
    default: {
      throw pyError('ValueError', 'Unknown timespec value');
    }
  }
}

export function isoDate(date: PyDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

/** The arguments of a time's or datetime's repr after the date: `3, 4, 5` and then `fold` and `tzinfo`. */
export function timeReprArguments(time: TimeOfDay, repr: (value: PyValue) => string, minimum: number): string {
  const values = [time.hour, time.minute, time.second, time.microsecond];
  let count = 4;
  while (count > minimum && values[count - 1] === 0) count--;
  let text = values.slice(0, count).join(', ');
  if (time.fold !== 0) text += `, fold=${time.fold}`;
  if (time.tzinfo !== None) text += `, tzinfo=${repr(time.tzinfo)}`;
  return text;
}
