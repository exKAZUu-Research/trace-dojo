// `datetime.tzinfo` and `datetime.timezone`, and how the other classes ask a tzinfo for its offset.
import { pyRepr } from '../conversions';
import { method } from '../define';
import { callValue, getAttribute } from '../objects';
import { isInstanceOf, None, NotImplemented, pyError, strClass, typeError, typeName } from '../types';
import { type Kwargs, PyInstance, type PyValue } from '../values';
import { datetimeClass, defineConstants, valueHash } from './datetimeClasses';
import { isTimedelta, newTimedelta, type PyTimedelta, timedeltaRepr } from './datetimeDelta';

const US_PER_DAY = 86_400_000_000n;

export const tzinfoClass = datetimeClass('tzinfo');
tzinfoClass.construct = (cls) => new PyInstance(cls);

export class PyTimezone extends PyInstance {
  constructor(
    readonly offset: PyTimedelta,
    readonly name: string | undefined
  ) {
    super(timezoneClass);
  }
}

export const timezoneClass = datetimeClass('timezone', tzinfoClass);
timezoneClass.isBaseType = false;

export function isTzinfo(value: PyValue): boolean {
  return isInstanceOf(value, tzinfoClass);
}

/** `timezone(offset)`, the UTC singleton for a zero offset without a name. */
export function newTimezone(offset: PyTimedelta, name?: string): PyTimezone {
  checkOffsetRange(offset);
  if (name === undefined && offset.totalMicroseconds === 0n) return UTC;
  return new PyTimezone(offset, name);
}

export const UTC = new PyTimezone(newTimedelta(0n), undefined);

timezoneClass.construct = (_cls, args, kwargs) => {
  const [offset, name] = timezoneArguments(args, kwargs);
  if (!isTimedelta(offset)) {
    throw typeError(`timezone() argument 1 must be datetime.timedelta, not ${typeName(offset)}`);
  }
  if (name !== undefined && typeof name !== 'string') {
    throw typeError(`timezone() argument 2 must be str, not ${typeName(name)}`);
  }
  checkOffsetRange(offset);
  return newTimezone(offset, name);
};

function timezoneArguments(args: PyValue[], kwargs: Kwargs): PyValue[] {
  const names = ['offset', 'name'];
  const total = args.length + (kwargs?.size ?? 0);
  if (total > 2) throw typeError(`timezone() takes at most 2 arguments (${total} given)`);
  const values: PyValue[] = [...args];
  for (const [key, value] of kwargs ?? []) {
    const index = names.indexOf(key);
    if (index === -1) throw typeError(`timezone() got an unexpected keyword argument '${key}'`);
    if (index < args.length)
      throw typeError(`argument for timezone() given by name ('${key}') and position (${index + 1})`);
    values[index] = value;
  }
  if (values[0] === undefined) throw typeError("timezone() missing required argument 'offset' (pos 1)");
  return values;
}

/** Rejects an offset of a day or more. */
export function checkOffsetRange(offset: PyTimedelta): void {
  const total = offset.totalMicroseconds;
  if (total <= -US_PER_DAY || total >= US_PER_DAY) {
    throw pyError(
      'ValueError',
      `offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not ${timedeltaRepr(offset)}`
    );
  }
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The `UTC±HH:MM` name of an offset, with seconds and microseconds when it has them. */
export function offsetName(offset: PyTimedelta, separator = ':', prefix = 'UTC'): string {
  let total = offset.totalMicroseconds;
  const sign = total < 0n ? '-' : '+';
  if (total < 0n) total = -total;
  const microseconds = Number(total % 1_000_000n);
  let seconds = Number(total / 1_000_000n);
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  let text = `${prefix}${sign}${pad(hours)}${separator}${pad(minutes)}`;
  if (seconds !== 0 || microseconds !== 0) text += `${separator}${pad(seconds)}`;
  if (microseconds !== 0) text += `.${String(microseconds).padStart(6, '0')}`;
  return text;
}

function zone(self: PyValue): PyTimezone {
  return self as PyTimezone;
}

function timezoneName(self: PyTimezone): string {
  if (self.name !== undefined) return self.name;
  if (self === UTC || self.offset.totalMicroseconds === 0n) return 'UTC';
  return offsetName(self.offset);
}

/** Checks the argument of a timezone's `utcoffset`, `dst`, or `tzname`, which must be a datetime or None. */
function checkDatetimeArgument(name: string, value: PyValue, isDatetime: (value: PyValue) => boolean): void {
  if (value !== None && !isDatetime(value)) {
    throw typeError(`${name}(dt) argument must be a datetime instance or None, not ${typeName(value)}`);
  }
}

/** Defines the methods that need the datetime class, which is defined after this module. */
// code-gauge-allow functionCognitiveComplexity 17 -- Defines the methods of timezone and tzinfo that need datetime.
// code-gauge-allow functionNcss 35 -- Defines the methods of timezone and tzinfo that need datetime.
export function defineTimezoneMethods(
  isDatetime: (value: PyValue) => boolean,
  addOffset: (dt: PyValue, microseconds: bigint) => PyValue,
  tzinfoOf: (dt: PyValue) => PyValue
): void {
  method(timezoneClass, 'utcoffset', 'one', 1, 1, (self, [dt]) => {
    checkDatetimeArgument('utcoffset', dt, isDatetime);
    return zone(self).offset;
  });
  method(timezoneClass, 'dst', 'one', 1, 1, (_self, [dt]) => {
    checkDatetimeArgument('dst', dt, isDatetime);
    return None;
  });
  method(timezoneClass, 'tzname', 'one', 1, 1, (self, [dt]) => {
    checkDatetimeArgument('tzname', dt, isDatetime);
    return timezoneName(zone(self));
  });
  method(timezoneClass, 'fromutc', 'one', 1, 1, (self, [dt]) => {
    if (!isDatetime(dt)) throw typeError('fromutc: argument must be a datetime');
    if (tzinfoOf(dt) !== self) throw pyError('ValueError', 'fromutc: dt.tzinfo is not self');
    return addOffset(dt, zone(self).offset.totalMicroseconds);
  });
  method(tzinfoClass, 'fromutc', 'one', 1, 1, (self, [dt]) => {
    if (!isDatetime(dt)) throw typeError('fromutc: argument must be a datetime');
    if (tzinfoOf(dt) !== self) throw pyError('ValueError', 'fromutc: dt.tzinfo is not self');
    const offset = callOffsetMethod(self, 'utcoffset', dt);
    if (offset === undefined) throw pyError('ValueError', 'fromutc: non-None utcoffset() result required');
    let dst = callOffsetMethod(self, 'dst', dt);
    if (dst === undefined) throw pyError('ValueError', 'fromutc: non-None dst() result required');
    const difference = offset.totalMicroseconds - dst.totalMicroseconds;
    let result = dt;
    if (difference !== 0n) {
      result = addOffset(dt, difference);
      dst = callOffsetMethod(self, 'dst', result);
      if (dst === undefined) {
        throw pyError('ValueError', 'fromutc: tz.dst() gave inconsistent results; cannot convert');
      }
    }
    return addOffset(result, dst.totalMicroseconds);
  });
}

method(timezoneClass, '__repr__', 'none', 0, 0, (self) => {
  const value = zone(self);
  if (value === UTC) return 'datetime.timezone.utc';
  const name = value.name === undefined ? '' : `, ${pyRepr(value.name)}`;
  return `datetime.timezone(${timedeltaRepr(value.offset)}${name})`;
});
method(timezoneClass, '__str__', 'none', 0, 0, (self) => timezoneName(zone(self)));
method(timezoneClass, '__eq__', 'one', 1, 1, (self, [other]) =>
  other instanceof PyTimezone ? zone(self).offset.totalMicroseconds === other.offset.totalMicroseconds : NotImplemented
);
valueHash(timezoneClass, (self) => {
  const offset = zone(self).offset;
  return BigInt(offset.days * 86_400 + offset.seconds) * 1_000_003n + BigInt(offset.microseconds);
});
defineConstants(timezoneClass, () => ({
  utc: UTC,
  min: new PyTimezone(newTimedelta(-(US_PER_DAY - 60_000_000n)), undefined),
  max: new PyTimezone(newTimedelta(US_PER_DAY - 60_000_000n), undefined),
}));

for (const name of ['utcoffset', 'dst', 'tzname'] as const) {
  method(tzinfoClass, name, 'one', 1, 1, () => {
    throw pyError('NotImplementedError', `a tzinfo subclass must implement ${name}()`);
  });
}

/**
 * Calls a tzinfo's `utcoffset` or `dst` for `argument`, checking the result as CPython does: None or a timedelta of
 * less than a day.
 */
export function callOffsetMethod(
  tzinfo: PyValue,
  name: 'utcoffset' | 'dst',
  argument: PyValue
): PyTimedelta | undefined {
  if (tzinfo === None) return undefined;
  if (tzinfo instanceof PyTimezone) return name === 'utcoffset' ? tzinfo.offset : undefined;
  const result = callValue(getAttribute(tzinfo, name), [argument]);
  if (result === None) return undefined;
  if (!isTimedelta(result)) {
    throw typeError(`tzinfo.${name}() must return None or timedelta, not '${typeName(result)}'`);
  }
  checkOffsetRange(result);
  return result;
}

export function callTzname(tzinfo: PyValue, argument: PyValue): PyValue {
  if (tzinfo === None) return None;
  if (tzinfo instanceof PyTimezone) return timezoneName(tzinfo);
  const result = callValue(getAttribute(tzinfo, 'tzname'), [argument]);
  if (result !== None && !isInstanceOf(result, strClass)) {
    throw typeError(`tzinfo.tzname() must return None or a string, not '${typeName(result)}'`);
  }
  return result;
}
