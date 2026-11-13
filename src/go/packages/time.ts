// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import type { Runtime } from '../runtime';
import { nilPointerPanic } from '../runtimeErrors';
import { BASIC, pointerTo, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, type Value } from '../values';
import * as goTime from './goTime';
import * as timeFormat from './goTimeFormat';
import {
  appendBytes,
  BOOL,
  BYTES,
  byteSlice,
  bytesOf,
  ERROR_TYPE,
  FLOAT64,
  INT,
  spendFor,
  STRING,
  stringPanic,
} from './support';

const INT64 = BASIC.int64;

const LOCATION = namedType('time', 'Location', { kind: 'struct', fields: [] });
const LOCATION_POINTER = pointerTo(LOCATION);
export const TIME = namedType('time', 'Time', {
  kind: 'struct',
  fields: [
    { name: 'wall', type: BASIC.uint64, embedded: false },
    { name: 'ext', type: INT64, embedded: false },
    { name: 'loc', type: LOCATION_POINTER, embedded: false },
  ],
});
export const DURATION = namedType('time', 'Duration', INT64);
const MONTH = namedType('time', 'Month', INT);
const WEEKDAY = namedType('time', 'Weekday', INT);

// Locations -------------------------------------------------------------------------------------------------------

const locationPointers = new WeakMap<goTime.Location, Pointer>();

function pointerOf(location: goTime.Location): Pointer {
  let pointer = locationPointers.get(location);
  if (!pointer) {
    pointer = new Pointer(new Cell(new GoStruct([], { location })), 'v');
    locationPointers.set(location, pointer);
  }
  return pointer;
}

const UTC_POINTER = pointerOf(goTime.UTC_LOCATION);
const LOCAL_POINTER = pointerOf(goTime.LOCAL_LOCATION);

/** The location a `*time.Location` points to; a program's own zero Location reads as UTC with an empty name. */
function locationOf(pointer: Value): goTime.Location {
  if (!(pointer instanceof Pointer)) nilPointerPanic();
  const struct = pointer.load() as GoStruct;
  struct.native ??= { location: { name: '' } };
  const location = struct.native.location as goTime.Location;
  if (!locationPointers.has(location)) locationPointers.set(location, pointer);
  return location;
}

addMethod(LOCATION, 'String', fn([], [STRING]), (receiver) => locationOf(receiver).name, true);

// Time values -----------------------------------------------------------------------------------------------------

export function timeOf(value: Value): goTime.Time {
  const [wall, ext, loc] = (value as GoStruct).fields;
  return { wall: wall as bigint, ext: ext as bigint, loc: loc === undefined ? undefined : locationOf(loc) };
}

export function timeValue(t: goTime.Time): GoStruct {
  return new GoStruct([t.wall, t.ext, t.loc ? pointerOf(t.loc) : undefined]);
}

/** Defines a value method of Time from a function of the receiver's time and the arguments. */
function timeMethod(
  name: string,
  params: Type[],
  results: Type[],
  impl: (t: goTime.Time, args: Value[]) => Value[] | Value
): void {
  addMethod(TIME, name, fn(params, results), (receiver, args) => impl(timeOf(receiver), args));
}

const components: [string, Type, (t: goTime.Time) => bigint][] = [
  ['Year', INT, (t) => goTime.date(t).year],
  ['Month', MONTH, (t) => goTime.date(t).month],
  ['Day', INT, (t) => goTime.date(t).day],
  ['Hour', INT, (t) => goTime.clock(t).hour],
  ['Minute', INT, (t) => goTime.clock(t).min],
  ['Second', INT, (t) => goTime.clock(t).sec],
  ['Nanosecond', INT, goTime.nanosecond],
  ['Weekday', WEEKDAY, goTime.weekday],
  ['YearDay', INT, (t) => goTime.yearDayOf(t).yday],
  ['Unix', INT64, goTime.unixSeconds],
  ['UnixMilli', INT64, (t) => goTime.unixScaled(t, 1000n)],
  ['UnixMicro', INT64, (t) => goTime.unixScaled(t, 1_000_000n)],
  ['UnixNano', INT64, (t) => goTime.unixScaled(t, goTime.SECOND)],
];
for (const [name, type, read] of components) timeMethod(name, [], [type], (t) => read(t));

timeMethod('Date', [], [INT, MONTH, INT], (t) => {
  const { year, month, day } = goTime.date(t);
  return [year, month, day];
});
timeMethod('Clock', [], [INT, INT, INT], (t) => {
  const { hour, min, sec } = goTime.clock(t);
  return [hour, min, sec];
});
timeMethod('ISOWeek', [], [INT, INT], goTime.isoWeek);
timeMethod('IsZero', [], [BOOL], goTime.isZero);
timeMethod('IsDST', [], [BOOL], () => false);
timeMethod('After', [TIME], [BOOL], (t, [u]) => goTime.compare(t, timeOf(u)) > 0);
timeMethod('Before', [TIME], [BOOL], (t, [u]) => goTime.compare(t, timeOf(u)) < 0);
timeMethod('Equal', [TIME], [BOOL], (t, [u]) => goTime.compare(t, timeOf(u)) === 0);
timeMethod('Compare', [TIME], [INT], (t, [u]) => BigInt(goTime.compare(t, timeOf(u))));
timeMethod('Sub', [TIME], [DURATION], (t, [u]) => goTime.sub(t, timeOf(u)));
timeMethod('Add', [DURATION], [TIME], (t, [d]) => timeValue(goTime.add(t, d as bigint)));
timeMethod('AddDate', [INT, INT, INT], [TIME], (t, [years, months, days]) =>
  timeValue(goTime.addDate(t, years as bigint, months as bigint, days as bigint))
);
timeMethod('Truncate', [DURATION], [TIME], (t, [d]) => timeValue(goTime.truncate(t, d as bigint)));
timeMethod('Round', [DURATION], [TIME], (t, [d]) => timeValue(goTime.round(t, d as bigint)));
timeMethod('UTC', [], [TIME], (t) => timeValue(goTime.inLocation(t, goTime.UTC_LOCATION)));
timeMethod('Local', [], [TIME], (t) => timeValue(goTime.inLocation(t, goTime.LOCAL_LOCATION)));
timeMethod('In', [LOCATION_POINTER], [TIME], (t, [loc]) => {
  if (loc === undefined) stringPanic('time: missing Location in call to Time.In');
  return timeValue(goTime.inLocation(t, locationOf(loc)));
});
timeMethod('Location', [], [LOCATION_POINTER], (t) => pointerOf(t.loc ?? goTime.UTC_LOCATION));
timeMethod('Zone', [], [STRING, INT], (t) => {
  const { name, offset } = goTime.zone(t);
  return [name, offset];
});
// Fixed zones never change, so the zone in effect has no bounds, which Go reports as zero Times.
timeMethod('ZoneBounds', [], [TIME, TIME], () => [timeValue(ZERO_TIME), timeValue(ZERO_TIME)]);
timeMethod('Format', [STRING], [STRING], (t, [layout]) => {
  spendFor((layout as string).length);
  return timeFormat.format(t, layout as string);
});
timeMethod('AppendFormat', [BYTES, STRING], [BYTES], (t, [bytes, layout]) =>
  appendBytes(bytes, timeFormat.format(t, layout as string))
);
timeMethod('String', [], [STRING], timeFormat.timeString);
timeMethod('GoString', [], [STRING], timeFormat.goString);

const ZERO_TIME: goTime.Time = { wall: 0n, ext: 0n, loc: undefined };

// Encodings ------------------------------------------------------------------------------------------------------

function marshalText(t: goTime.Time, prefix: string): Value[] {
  const { text, error } = timeFormat.strictRfc3339(t);
  return error === undefined ? [byteSlice(text)] : [undefined, newError(`${prefix}${error}`)];
}

timeMethod('MarshalText', [], [BYTES, ERROR_TYPE], (t) => marshalText(t, 'Time.MarshalText: '));
timeMethod('AppendText', [BYTES], [BYTES, ERROR_TYPE], (t, [bytes]) => {
  const { text, error } = timeFormat.strictRfc3339(t);
  return error === undefined
    ? [appendBytes(bytes, text), undefined]
    : [undefined, newError(`Time.AppendText: ${error}`)];
});
timeMethod('MarshalJSON', [], [BYTES, ERROR_TYPE], (t) => {
  const { text, error } = timeFormat.strictRfc3339(t);
  return error === undefined ? [byteSlice(`"${text}"`)] : [undefined, newError(`Time.MarshalJSON: ${error}`)];
});

const byte = (value: bigint, shift: bigint): string => String.fromCodePoint(Number(BigInt.asUintN(8, value >> shift)));

/** `Time.AppendBinary`'s bytes, or its error message. */
function binaryOf(t: goTime.Time): { bytes: string } | { error: string } {
  let version = 1;
  let offsetMin = -1n;
  let offsetSec = 0n;
  if (t.loc !== undefined) {
    let { offset } = goTime.zone(t);
    if (offset % 60n !== 0n) {
      version = 2;
      offsetSec = offset % 60n;
    }
    offset /= 60n;
    if (offset < -32_768n || offset === -1n || offset > 32_767n) {
      return { error: 'Time.MarshalBinary: unexpected zone offset' };
    }
    offsetMin = offset;
  }
  const s = goTime.sec(t);
  const ns = goTime.nanosecond(t);
  let bytes = String.fromCodePoint(version);
  for (let shift = 56n; shift >= 0n; shift -= 8n) bytes += byte(s, shift);
  for (let shift = 24n; shift >= 0n; shift -= 8n) bytes += byte(ns, shift);
  bytes += byte(offsetMin, 8n) + byte(offsetMin, 0n);
  if (version === 2) bytes += byte(offsetSec, 0n);
  return { bytes };
}

const marshalBinary = (t: goTime.Time): Value[] => {
  const result = binaryOf(t);
  return 'bytes' in result ? [byteSlice(result.bytes)] : [undefined, newError(result.error)];
};
timeMethod('MarshalBinary', [], [BYTES, ERROR_TYPE], marshalBinary);
timeMethod('GobEncode', [], [BYTES, ERROR_TYPE], marshalBinary);
timeMethod('AppendBinary', [BYTES], [BYTES, ERROR_TYPE], (t, [bytes]) => {
  const result = binaryOf(t);
  return 'bytes' in result ? [appendBytes(bytes, result.bytes), undefined] : [bytes, newError(result.error)];
});

function unmarshalBinary(data: string): goTime.Time | string {
  if (data.length === 0) return 'Time.UnmarshalBinary: no data';
  const version = data.charCodeAt(0);
  if (version !== 1 && version !== 2) return 'Time.UnmarshalBinary: unsupported version';
  if (data.length !== (version === 2 ? 16 : 15)) return 'Time.UnmarshalBinary: invalid length';
  const read = (from: number, count: number): bigint => {
    let value = 0n;
    for (let index = from; index < from + count; index++) value = (value << 8n) | BigInt(data.charCodeAt(index));
    return value;
  };
  const sec = BigInt.asIntN(64, read(1, 8));
  const ns = BigInt.asIntN(32, read(9, 4));
  let offset = BigInt.asIntN(16, read(13, 2)) * 60n;
  if (version === 2) offset += BigInt.asIntN(8, read(15, 1));
  const t: goTime.Time = { wall: BigInt.asUintN(64, ns), ext: sec, loc: undefined };
  if (offset === -60n) return t;
  const location = offset === 0n ? goTime.LOCAL_LOCATION : goTime.fixedZone('', offset);
  return goTime.inLocation(t, location);
}

/** Defines a pointer method that decodes bytes into the Time and returns the error value. */
function unmarshalMethod(name: string, decode: (receiver: Pointer, data: string) => Value): void {
  addMethod(
    TIME,
    name,
    fn([BYTES], [ERROR_TYPE]),
    (receiver, [data]) => {
      if (!(receiver instanceof Pointer)) nilPointerPanic();
      return decode(receiver, bytesOf(data));
    },
    true
  );
}

function decodeBinary(receiver: Pointer, data: string): Value {
  const result = unmarshalBinary(data);
  if (typeof result === 'string') return newError(result);
  receiver.store(timeValue(result));
  return;
}

/** Decodes text into the Time, which a failed parse leaves zero, as Go assigns parse's results. */
function decodeRfc3339(receiver: Pointer, text: string): Value {
  const [time, error] = parseResult(timeFormat.parseStrictRfc3339(text));
  receiver.store(time);
  return error;
}

unmarshalMethod('UnmarshalBinary', decodeBinary);
unmarshalMethod('GobDecode', decodeBinary);
unmarshalMethod('UnmarshalText', decodeRfc3339);
unmarshalMethod('UnmarshalJSON', (receiver, data) => {
  if (data === 'null') return;
  if (data.length < 2 || !data.startsWith('"') || !data.endsWith('"')) {
    return newError('Time.UnmarshalJSON: input is not a JSON string');
  }
  return decodeRfc3339(receiver, data.slice(1, -1));
});

// Durations, months, and weekdays ---------------------------------------------------------------------------------

const durationMethods: [string, Type[], Type, (d: bigint, args: Value[]) => Value][] = [
  ['String', [], STRING, goTime.durationString],
  ['Nanoseconds', [], INT64, (d) => d],
  ['Microseconds', [], INT64, (d) => d / 1000n],
  ['Milliseconds', [], INT64, (d) => d / 1_000_000n],
  ['Seconds', [], FLOAT64, (d) => goTime.durationUnits(d, goTime.SECOND)],
  ['Minutes', [], FLOAT64, (d) => goTime.durationUnits(d, goTime.MINUTE)],
  ['Hours', [], FLOAT64, (d) => goTime.durationUnits(d, goTime.HOUR)],
  ['Truncate', [DURATION], DURATION, (d, [m]) => ((m as bigint) <= 0n ? d : d - (d % (m as bigint)))],
  ['Round', [DURATION], DURATION, (d, [m]) => goTime.durationRound(d, m as bigint)],
  ['Abs', [], DURATION, (d) => (d >= 0n ? d : d === goTime.MIN_DURATION ? goTime.MAX_DURATION : -d)],
];
for (const [name, params, result, impl] of durationMethods) {
  addMethod(DURATION, name, fn(params, [result]), (receiver, args) => impl(receiver as bigint, args));
}
addMethod(MONTH, 'String', fn([], [STRING]), (receiver) => timeFormat.monthString(receiver as bigint));
addMethod(WEEKDAY, 'String', fn([], [STRING]), (receiver) => timeFormat.weekdayString(receiver as bigint));

// Errors ----------------------------------------------------------------------------------------------------------

const PARSE_ERROR = namedType('time', 'ParseError', {
  kind: 'struct',
  fields: ['Layout', 'Value', 'LayoutElem', 'ValueElem', 'Message'].map((name) => ({
    name,
    type: STRING,
    embedded: false,
  })),
});

function parseErrorMessage(error: timeFormat.ParseError): string {
  if (error.message === '') {
    return `parsing time ${timeFormat.quote(error.value)} as ${timeFormat.quote(error.layout)}: cannot parse ${timeFormat.quote(error.valueElem)} as ${timeFormat.quote(error.layoutElem)}`;
  }
  return `parsing time ${timeFormat.quote(error.value)}${error.message}`;
}

addMethod(
  PARSE_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => {
    if (!(receiver instanceof Pointer)) nilPointerPanic();
    const [layout, value, layoutElem, valueElem, message] = (receiver.load() as GoStruct).fields as string[];
    return parseErrorMessage({ layout, value, layoutElem, valueElem, message });
  },
  true
);

function parseResult(result: timeFormat.ParseResult): Value[] {
  if ('time' in result) return [timeValue(result.time), undefined];
  const { layout, value, layoutElem, valueElem, message } = result.error;
  const error = new GoStruct([layout, value, layoutElem, valueElem, message]);
  return [timeValue(ZERO_TIME), new Iface(pointerTo(PARSE_ERROR), new Pointer(new Cell(error), 'v'))];
}

const PARSE_DURATION_ERROR = namedType('time', 'parseDurationError', {
  kind: 'struct',
  fields: [{ name: 'message', type: STRING, embedded: false }],
});
addMethod(
  PARSE_DURATION_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => {
    if (!(receiver instanceof Pointer)) nilPointerPanic();
    return (receiver.load() as GoStruct).fields[0];
  },
  true
);

// The clock -------------------------------------------------------------------------------------------------------

/** The clock of a run, where `time.Sleep` moves time forward at once instead of waiting. */
interface Clock {
  startMilliseconds: number;
  startUnixNanos: bigint;
  slept: bigint;
}

const clocks = new WeakMap<Runtime, Clock>();

function clockOf(runtime: Runtime): Clock {
  let clock = clocks.get(runtime);
  if (!clock) {
    clock = { startMilliseconds: performance.now(), startUnixNanos: BigInt(Date.now()) * 1_000_000n, slept: 0n };
    clocks.set(runtime, clock);
  }
  return clock;
}

/** The monotonic clock, counted from 1 when the program first reads it, as Go counts from its start. */
function monotonic(clock: Clock): bigint {
  return BigInt(Math.round((performance.now() - clock.startMilliseconds) * 1e6)) + clock.slept + 1n;
}

export function now(): goTime.Time {
  const clock = clockOf(currentRuntime());
  const mono = monotonic(clock);
  // The wall clock of darwin, where Go reads it through the C library, counts microseconds.
  const wall = clock.startUnixNanos + mono - 1n;
  return goTime.now(wall - (wall % 1000n), mono);
}

// Package members -------------------------------------------------------------------------------------------------

function constant(name: string, type: Type, value: bigint | string): Entity {
  return {
    kind: 'const',
    name,
    type,
    value: typeof value === 'string' ? { kind: 'string', value } : { kind: 'int', value },
    span: { row: 0, column: 0 },
    used: true,
  };
}

function locationVariable(name: string, pointer: Pointer): Entity {
  return {
    kind: 'var',
    name,
    type: LOCATION_POINTER,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => pointer,
  };
}

const DURATION_UNITS: [string, bigint][] = [
  ['Nanosecond', 1n],
  ['Microsecond', 1000n],
  ['Millisecond', 1_000_000n],
  ['Second', goTime.SECOND],
  ['Minute', goTime.MINUTE],
  ['Hour', goTime.HOUR],
];

const members: Record<string, Entity> = {
  Time: typeEntity(TIME),
  Duration: typeEntity(DURATION),
  Month: typeEntity(MONTH),
  Weekday: typeEntity(WEEKDAY),
  Location: typeEntity(LOCATION),
  ParseError: typeEntity(PARSE_ERROR),
  UTC: locationVariable('UTC', UTC_POINTER),
  Local: locationVariable('Local', LOCAL_POINTER),
  ...Object.fromEntries(DURATION_UNITS.map(([name, value]) => [name, constant(name, DURATION, value)])),
  ...Object.fromEntries(goTime.LONG_DAY_NAMES.map((name, index) => [name, constant(name, WEEKDAY, BigInt(index))])),
  ...Object.fromEntries(goTime.LONG_MONTH_NAMES.map((name, index) => [name, constant(name, MONTH, BigInt(index + 1))])),
  ...Object.fromEntries(
    Object.entries(timeFormat.LAYOUTS).map(([name, layout]) => [name, constant(name, BASIC.untypedString, layout)])
  ),
  Now: nativeFunction('Now', fn([], [TIME]), () => timeValue(now())),
  Since: nativeFunction('Since', fn([TIME], [DURATION]), ([value]) => {
    const t = timeOf(value);
    if (goTime.hasMonotonic(t)) return goTime.subMono(monotonic(clockOf(currentRuntime())), t.ext);
    return goTime.sub(now(), t);
  }),
  Until: nativeFunction('Until', fn([TIME], [DURATION]), ([value]) => {
    const t = timeOf(value);
    if (goTime.hasMonotonic(t)) return goTime.subMono(t.ext, monotonic(clockOf(currentRuntime())));
    return goTime.sub(t, now());
  }),
  Sleep: nativeFunction('Sleep', fn([DURATION], []), ([d]) => {
    const runtime = currentRuntime();
    runtime.spend();
    if ((d as bigint) > 0n) clockOf(runtime).slept += d as bigint;
    return;
  }),
  Unix: nativeFunction('Unix', fn([INT64, INT64], [TIME]), ([sec, nsec]) =>
    timeValue(goTime.unix(sec as bigint, nsec as bigint))
  ),
  UnixMilli: nativeFunction('UnixMilli', fn([INT64], [TIME]), ([msec]) => {
    const value = msec as bigint;
    return timeValue(goTime.unix(value / 1000n, (value % 1000n) * 1_000_000n));
  }),
  UnixMicro: nativeFunction('UnixMicro', fn([INT64], [TIME]), ([usec]) => {
    const value = usec as bigint;
    return timeValue(goTime.unix(value / 1_000_000n, (value % 1_000_000n) * 1000n));
  }),
  Date: nativeFunction(
    'Date',
    fn([INT, MONTH, INT, INT, INT, INT, INT, LOCATION_POINTER], [TIME]),
    ([year, month, day, hour, min, sec, nsec, loc]) => {
      if (loc === undefined) stringPanic('time: missing Location in call to Date');
      const values = [year, month, day, hour, min, sec, nsec] as bigint[];
      return timeValue(
        goTime.makeDate(values[0], values[1], values[2], values[3], values[4], values[5], values[6], locationOf(loc))
      );
    }
  ),
  FixedZone: nativeFunction('FixedZone', fn([STRING, INT], [LOCATION_POINTER]), ([name, offset]) =>
    pointerOf(goTime.fixedZone(name as string, offset as bigint))
  ),
  Parse: nativeFunction('Parse', fn([STRING, STRING], [TIME, ERROR_TYPE]), ([layout, value]) => {
    spendFor((layout as string).length + (value as string).length);
    return parseResult(timeFormat.parse(layout as string, value as string, goTime.UTC_LOCATION, goTime.LOCAL_LOCATION));
  }),
  ParseInLocation: nativeFunction(
    'ParseInLocation',
    fn([STRING, STRING, LOCATION_POINTER], [TIME, ERROR_TYPE]),
    ([layout, value, loc]) => {
      spendFor((layout as string).length + (value as string).length);
      const location = locationOf(loc);
      return parseResult(timeFormat.parse(layout as string, value as string, location, location));
    }
  ),
  ParseDuration: nativeFunction('ParseDuration', fn([STRING], [DURATION, ERROR_TYPE]), ([text]) => {
    spendFor((text as string).length);
    const result = timeFormat.parseDuration(text as string);
    if ('duration' in result) return [result.duration, undefined];
    const error = new Pointer(new Cell(new GoStruct([result.error])), 'v');
    return [0n, new Iface(pointerTo(PARSE_DURATION_ERROR), error)];
  }),
};

/** The time package, without what needs the time zone database files or goroutines and channels. */
export const TIME_PACKAGE = definePackage('time', members, [
  'LoadLocation',
  'LoadLocationFromTZData',
  'Tick',
  'Ticker',
  'NewTicker',
  'Timer',
  'NewTimer',
  'After',
  'AfterFunc',
]);
