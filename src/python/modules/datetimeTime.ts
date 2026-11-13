// The methods of `datetime.time`.
import { pyRepr, pyStr } from '../conversions';
import { method } from '../define';
import { None, NotImplemented, pyError, typeError } from '../types';
import type { Kwargs, PyValue } from '../values';
import { cInt, parseCArgs } from './datetimeArgs';
import { defineComparisons, defineConstants, defineGetters, signOf, valueHash } from './datetimeClasses';
import { formatArgument, localEpoch, parseStrptime, replaceArguments, strftimeArgument } from './datetimeDate';
import { hashOfMicroseconds, newTimedelta, type PyTimedelta } from './datetimeDelta';
import { parseIsoTimeOnly } from './datetimeIso';
import {
  isoTime,
  isTime,
  newTime,
  type PyTime,
  reprName,
  timeClass,
  type TimeOfDay,
  timeReprArguments,
  TIMESPECS,
} from './datetimeObjects';
import { callOffsetMethod, callTzname, newTimezone, offsetName } from './datetimeZone';
import { defineSlot } from './numberSupport';
import { strftime, type TimeFields } from './timeFormat';

const TIME_NAMES = ['hour', 'minute', 'second', 'microsecond', 'tzinfo', 'fold'] as const;

const time = (self: PyValue): PyTime => self as PyTime;

/** Reads the fields of a time from its constructor's or `replace()`'s arguments. */
export function timeFields(values: (PyValue | undefined)[], defaults: TimeOfDay): TimeOfDay {
  const integer = (index: number, fallback: number): number => {
    const value = values[index];
    return value === undefined ? fallback : cInt(value);
  };
  return {
    hour: integer(0, defaults.hour),
    minute: integer(1, defaults.minute),
    second: integer(2, defaults.second),
    microsecond: integer(3, defaults.microsecond),
    tzinfo: values[4] ?? defaults.tzinfo,
    fold: integer(5, defaults.fold),
  };
}

export const MIDNIGHT: TimeOfDay = { hour: 0, minute: 0, second: 0, microsecond: 0, tzinfo: None, fold: 0 };

timeClass.construct = (cls, args, kwargs) => {
  const values = parseCArgs({ names: TIME_NAMES, required: 0, positional: 5 }, args, kwargs, (value) => value);
  return newTime(timeFields(values, MIDNIGHT), cls);
};

/** The `+HH:MM` text of an offset, as isoformat and `%:z` write it, or '' for none. */
export function offsetText(offset: PyTimedelta | undefined, separator = ':'): string {
  return offset === undefined ? '' : offsetName(offset, separator, '');
}

/** The fields `strftime` reads for a time, on 1900-01-01 as CPython formats it. */
function timeStrftime(value: PyTime, format: string): string {
  const offset = callOffsetMethod(value.tzinfo, 'utcoffset', None);
  const zone = callTzname(value.tzinfo, None);
  const fields: TimeFields = {
    year: 1900,
    month: 1,
    day: 1,
    hour: value.hour,
    minute: value.minute,
    second: value.second,
    weekday: 0,
    yearDay: 1,
    microsecond: value.microsecond,
    offset: { plain: offsetText(offset, ''), colon: offsetText(offset) },
    zone: zone === None ? '' : pyStr(zone),
  };
  return strftime(format, { ...fields, epoch: localEpoch(fields) });
}

defineGetters(timeClass, {
  hour: (self) => BigInt(time(self).hour),
  minute: (self) => BigInt(time(self).minute),
  second: (self) => BigInt(time(self).second),
  microsecond: (self) => BigInt(time(self).microsecond),
  tzinfo: (self) => time(self).tzinfo,
  fold: (self) => BigInt(time(self).fold),
});
defineConstants(timeClass, () => ({
  min: newTime(MIDNIGHT),
  max: newTime({ ...MIDNIGHT, hour: 23, minute: 59, second: 59, microsecond: 999_999 }),
  resolution: newTimedelta(1n),
}));

method(timeClass, '__repr__', 'none', 0, 0, (self) => {
  const value = time(self);
  return `${reprName(value)}(${timeReprArguments(value, pyRepr, 2, true)})`;
});
method(
  timeClass,
  'isoformat',
  'takes',
  0,
  1,
  (self, args, kwargs) => timeIsoformat(time(self), args[0] ?? kwargs?.get('timespec') ?? 'auto'),
  { keywords: ['timespec'] }
);
method(timeClass, '__str__', 'none', 0, 0, (self) => timeIsoformat(time(self), 'auto'));
method(
  timeClass,
  'strftime',
  'takes',
  0,
  1,
  (self, args, kwargs) => timeStrftime(time(self), strftimeArgument(args, kwargs)),
  {
    keywords: ['format'],
  }
);
defineSlot(timeClass, '__format__', (self, [spec]) => {
  const text = formatArgument(spec);
  return text === '' ? pyStr(self) : timeStrftime(time(self), text);
});
method(timeClass, 'utcoffset', 'none', 0, 0, (self) => callOffsetMethod(time(self).tzinfo, 'utcoffset', None) ?? None);
method(timeClass, 'dst', 'none', 0, 0, (self) => callOffsetMethod(time(self).tzinfo, 'dst', None) ?? None);
method(timeClass, 'tzname', 'none', 0, 0, (self) => callTzname(time(self).tzinfo, None));
method(timeClass, 'replace', 'takes', 0, 6, (self, args, kwargs) => replaceTime(time(self), args, kwargs), {
  keywords: TIME_NAMES,
});
method(timeClass, '__replace__', 'takes', 0, 6, (self, args, kwargs) => replaceTime(time(self), args, kwargs), {
  keywords: TIME_NAMES,
});
method(timeClass, '__bool__', 'none', 0, 0, () => true);

function timeIsoformat(value: PyTime, timespec: PyValue): string {
  if (typeof timespec !== 'string') throw typeError('isoformat() argument 1 must be str');
  if (!TIMESPECS.includes(timespec)) throw pyError('ValueError', 'Unknown timespec value');
  return isoTime(value, timespec) + offsetText(callOffsetMethod(value.tzinfo, 'utcoffset', None));
}

function replaceTime(value: PyTime, args: PyValue[], kwargs: Kwargs): PyTime {
  const given = replaceArguments(TIME_NAMES, 5, args, kwargs);
  return newTime(
    timeFields(
      TIME_NAMES.map((name) => given.get(name)),
      value
    ),
    value.cls
  );
}

method(
  timeClass,
  'fromisoformat',
  'one',
  1,
  1,
  (cls, [text]) => {
    if (typeof text !== 'string') throw typeError('fromisoformat: argument must be str');
    const parsed = parseIsoTimeOnly(text);
    if (!parsed) throw pyError('ValueError', `Invalid isoformat string: ${pyRepr(text)}`);
    if (parsed.hour === 24) {
      if (parsed.minute !== 0 || parsed.second !== 0 || parsed.microsecond !== 0) {
        throw pyError('ValueError', `Invalid isoformat string: ${pyRepr(text)}`);
      }
      parsed.hour = 0;
    }
    const tzinfo =
      parsed.offset === undefined
        ? None
        : newTimezone(newTimedelta(BigInt(parsed.offset[0]) * 1_000_000n + BigInt(parsed.offset[1])));
    return newTime({ ...parsed, tzinfo, fold: 0 }, cls as never);
  },
  { binding: 'class' }
);
method(
  timeClass,
  'strptime',
  'expected',
  2,
  2,
  (cls, [text, format]) => {
    const parsed = parseStrptime(text, format);
    const tzinfo = parsedZone(parsed);
    return newTime(
      {
        hour: parsed.hour,
        minute: parsed.minute,
        second: parsed.second,
        microsecond: parsed.fraction,
        tzinfo,
        fold: 0,
      },
      cls as never
    );
  },
  { binding: 'class' }
);

/** The timezone of a parsed `%z`, named after a parsed `%Z`. */
export function parsedZone(parsed: ReturnType<typeof parseStrptime>): PyValue {
  if (parsed.gmtoff === undefined) return None;
  const offset = newTimedelta(BigInt(parsed.gmtoff) * 1_000_000n + BigInt(parsed.gmtoffFraction));
  return parsed.zone ? newTimezone(offset, parsed.zone) : newTimezone(offset);
}

/** The microseconds since midnight in UTC of an aware time, or of a naive one as it is. */
function utcMicroseconds(value: PyTime, offset: PyTimedelta | undefined): bigint {
  const local = BigInt(value.hour * 3600 + value.minute * 60 + value.second) * 1_000_000n + BigInt(value.microsecond);
  return offset === undefined ? local : local - offset.totalMicroseconds;
}

defineComparisons(timeClass, (self, other, name) => {
  if (!isTime(other)) return NotImplemented;
  const left = time(self);
  let leftOffset: PyTimedelta | undefined;
  let rightOffset: PyTimedelta | undefined;
  if (left.tzinfo !== other.tzinfo) {
    leftOffset = callOffsetMethod(left.tzinfo, 'utcoffset', None);
    rightOffset = callOffsetMethod(other.tzinfo, 'utcoffset', None);
    if ((leftOffset === undefined) !== (rightOffset === undefined)) {
      if (name === '__eq__' || name === '__ne__') return name === '__ne__';
      throw typeError("can't compare offset-naive and offset-aware times");
    }
  }
  return signOf(utcMicroseconds(left, leftOffset) - utcMicroseconds(other, rightOffset));
});
valueHash(timeClass, (self) => {
  const value = time(self);
  const offset = callOffsetMethod(value.tzinfo, 'utcoffset', None);
  return hashOfMicroseconds(utcMicroseconds(value, offset));
});
