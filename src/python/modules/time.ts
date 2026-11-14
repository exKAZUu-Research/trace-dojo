import {
  LOCAL_ZONE,
  monotonicNanoseconds,
  nanosecondsToSeconds,
  processNanoseconds,
  wallClockNanoseconds,
} from '../clock';
import { builtin } from '../define';
import { registerModule } from '../modules';
import { toIndex } from '../numbers';
import { currentRuntime } from '../runtimeContext';
import { blockingBuiltin, sleepWait } from '../threads';
import {
  intClass,
  isInstanceOf,
  newTuple,
  None,
  pyError,
  stringValue,
  tupleClass,
  typeError,
  typeName,
} from '../types';
import { PyTuple, type PyValue } from '../values';
import { toOrdinal } from './calendarMath';
import { cInt } from './datetimeArgs';
import { ctime, EPOCH_ORDINAL, fieldsOfTimestamp, localEpoch, parseStrptime, structTimeOf } from './datetimeDate';
import { PyStructTime, structTimeClass } from './structTime';
import { timeClocks } from './timeClocks';
import { strftime, type TimeFields } from './timeFormat';

function clock(name: string, read: () => bigint): [string, PyValue][] {
  return [
    [name, builtin(name, 'none', 0, 0, () => nanosecondsToSeconds(read()))],
    [`${name}_ns`, builtin(`${name}_ns`, 'none', 0, 0, () => read())],
  ];
}

registerModule('time', (runtime) => {
  return new Map<string, PyValue>([
    ...clock('time', () => wallClockNanoseconds(runtime)),
    ...clock('perf_counter', () => monotonicNanoseconds(runtime)),
    ...clock('monotonic', () => monotonicNanoseconds(runtime)),
    ...clock('process_time', () => processNanoseconds(runtime)),
    ...clock('thread_time', () => processNanoseconds(runtime)),
    [
      'sleep',
      blockingBuiltin('sleep', 'one', [1, 1], function* ([value]) {
        yield* sleepWait(sleepNanoseconds(value));
        return None;
      }),
    ],
    ['gmtime', builtin('gmtime', 'expected', 0, 1, ([value]) => brokenDownTime(value, false))],
    ['localtime', builtin('localtime', 'expected', 0, 1, ([value]) => brokenDownTime(value, true))],
    ['mktime', builtin('mktime', 'one', 1, 1, ([value]) => mktime(value))],
    ['asctime', builtin('asctime', 'expected', 0, 1, ([value]) => ctime(tupleFields(value, 'asctime'), false))],
    ['ctime', builtin('ctime', 'expected', 0, 1, ([value]) => ctime(localFields(value), false))],
    ['strftime', builtin('strftime', 'expected', 1, 2, ([format, value]) => formatTime(format, value))],
    [
      'strptime',
      builtin('strptime', 'expected', 1, 2, ([text, format]) => {
        const parsed = parseStrptime(text, format ?? '%a %b %d %H:%M:%S %Y', true);
        const items = [parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second];
        const fields = [...items, parsed.weekday, parsed.yearDay, parsed.isDst].map(BigInt);
        const offset = parsed.gmtoff === undefined ? None : BigInt(parsed.gmtoff);
        return new PyStructTime(fields, parsed.zone ?? None, offset);
      }),
    ],
    ['struct_time', structTimeClass],
    ['timezone', BigInt(-LOCAL_ZONE.offsetSeconds)],
    ['altzone', BigInt(-LOCAL_ZONE.offsetSeconds)],
    ['daylight', 0n],
    ['tzname', newTuple([LOCAL_ZONE.name, LOCAL_ZONE.name])],
    ...timeClocks(runtime),
  ]);
});

/**
 * The length of a sleep, rounded up to whole nanoseconds as CPython rounds timeouts. Sleeping waits in the running
 * thread, which advances the run's virtual clock instead of waiting when no other thread can run.
 */
function sleepNanoseconds(value: PyValue): bigint {
  let nanoseconds: bigint;
  if (isInstanceOf(value, intClass)) nanoseconds = toIndex(value) * 1_000_000_000n;
  else if (typeof value === 'number') {
    if (Number.isNaN(value)) throw pyError('ValueError', 'Invalid value NaN (not a number)');
    if (!Number.isFinite(value)) throw pyError('OverflowError', 'timestamp too large to convert to C _PyTime_t');
    nanoseconds = BigInt(Math.ceil(value * 1e9));
  } else throw typeError(`'${typeName(value)}' object cannot be interpreted as an integer or float`);
  if (nanoseconds < 0n) throw pyError('ValueError', 'sleep length must be non-negative');
  return nanoseconds;
}

/** The whole seconds of a timestamp argument, rounded toward negative infinity, or now when absent. */
function timestampSeconds(value: PyValue | undefined): bigint {
  if (value === undefined || value === None) return wallClockNanoseconds(currentRuntime()) / 1_000_000_000n;
  if (isInstanceOf(value, intClass)) return checkTimeT(toIndex(value));
  if (typeof value !== 'number') throw typeError(`'${typeName(value)}' object cannot be interpreted as an integer`);
  if (Number.isNaN(value)) throw pyError('ValueError', 'Invalid value NaN (not a number)');
  const floor = Math.floor(value);
  if (!Number.isFinite(floor) || Math.abs(floor) >= 2 ** 63) {
    throw pyError('OverflowError', 'timestamp out of range for platform time_t');
  }
  return BigInt(floor);
}

function checkTimeT(value: bigint): bigint {
  if (value >= 1n << 63n || value < -(1n << 63n)) {
    throw pyError('OverflowError', 'timestamp out of range for platform time_t');
  }
  return value;
}

function timestampFields(value: PyValue | undefined, local: boolean): TimeFields {
  const { year, month, day, hour, minute, second } = fieldsOfTimestamp(timestampSeconds(value), 0, local);
  const ordinal = toOrdinal(year, month, day);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: (ordinal + 6) % 7,
    yearDay: ordinal - toOrdinal(year, 1, 1) + 1,
  };
}

function brokenDownTime(value: PyValue | undefined, local: boolean): PyStructTime {
  const fields = structTimeOf(timestampFields(value, local), 0);
  return new PyStructTime(fields.items, local ? LOCAL_ZONE.name : 'UTC', BigInt(local ? LOCAL_ZONE.offsetSeconds : 0));
}

function localFields(value: PyValue | undefined): TimeFields {
  return timestampFields(value, true);
}

/** The fields of a time tuple argument, checked as CPython's `gettmarg` and `checktm` check them. */
function tupleFields(value: PyValue | undefined, name: string): TimeFields & { isDst: number } {
  if (value === undefined) return { ...localFields(undefined), isDst: 0 };
  if (!(value instanceof PyTuple) || !value.cls.isSubclassOf(tupleClass)) {
    throw typeError('Tuple or struct_time argument required');
  }
  if (value.items.length !== 9) throw typeError(`${name}(): illegal time tuple argument`);
  const [year, month, day, hour, minute, second, weekday, yearDay, isDst] = value.items.map(cInt);
  range(month !== 0 && (month < 1 || month > 12), 'month');
  range(day < 0 || day > 31, 'day of month');
  range(hour < 0 || hour > 23, 'hour');
  range(minute < 0 || minute > 59, 'minute');
  range(second < 0 || second > 61, 'seconds');
  const sundayWeekday = (((weekday + 1) % 7) + 7) % 7;
  range(yearDay !== 0 && (yearDay < 1 || yearDay > 366), 'day of year');
  return {
    year,
    month: Math.max(month, 1),
    day: Math.max(day, 1),
    hour,
    minute,
    second,
    weekday: (sundayWeekday + 6) % 7,
    yearDay: Math.max(yearDay, 1),
    isDst: Math.max(Math.min(isDst, 1), -1),
    zone: value instanceof PyStructTime && typeof value.zone === 'string' ? value.zone : undefined,
  };
}

function range(outside: boolean, what: string): void {
  if (outside) throw pyError('ValueError', `${what} out of range`);
}

function formatTime(format: PyValue, value: PyValue | undefined): string {
  const text = stringValue(format);
  if (text === undefined) throw typeError(`strftime() argument 1 must be str, not ${typeName(format)}`);
  const fields = tupleFields(value, 'strftime');
  const known = fields.isDst >= 0;
  return strftime(text, {
    ...fields,
    // macOS formats `%z` from the local zone and `%Z` from the struct's zone, both empty for an unknown DST flag.
    offset: { plain: known ? '+0900' : '', colon: ':z' },
    zone: fields.zone ?? (known ? LOCAL_ZONE.name : ''),
    epoch: localEpoch(fields),
  });
}

/** `mktime()`: the timestamp of local time fields, which may lie outside their ranges as C's mktime allows. */
function mktime(value: PyValue): number {
  if (!(value instanceof PyTuple) || !value.cls.isSubclassOf(tupleClass)) {
    throw typeError('Tuple or struct_time argument required');
  }
  if (value.items.length !== 9) throw typeError('mktime(): illegal time tuple argument');
  const [year, month, day, hour, minute, second] = value.items.map(cInt);
  const months = year * 12 + (month - 1);
  const normalizedYear = Math.floor(months / 12);
  const ordinal = toOrdinal(normalizedYear, months - normalizedYear * 12 + 1, 1) + day - 1;
  if (normalizedYear < 1900) throw pyError('OverflowError', 'mktime argument out of range');
  return (ordinal - EPOCH_ORDINAL) * 86_400 + hour * 3600 + minute * 60 + second - LOCAL_ZONE.offsetSeconds;
}
