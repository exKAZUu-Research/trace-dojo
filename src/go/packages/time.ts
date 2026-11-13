import type { Entity } from '../entities';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { BASIC, type NamedType, type Type } from '../types';
import { GoStruct, type NativeState, type Value } from '../values';
import { BOOL, INT, STRING } from './support';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
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

function enumType(name: string, names: string[], offset: number): NamedType {
  const type = namedType('time', name, BASIC.int);
  addMethod(type, 'String', fn([], [STRING]), (receiver) => {
    const index = Number(receiver as bigint) - offset;
    return names[index] ?? `%!${name}(${String(receiver)})`;
  });
  return type;
}

const WEEKDAY = enumType('Weekday', WEEKDAY_NAMES, 0);
const MONTH = enumType('Month', MONTH_NAMES, 1);

/** `time.Time`, holding the instant in milliseconds and the nanoseconds since the program started, for `m=`. */
const TIME = namedType('time', 'Time', { kind: 'struct', fields: [] });

interface Instant {
  millis: number;
  monotonic: number;
}

interface TimeState extends NativeState {
  instant: Instant;
}

function createTimeState(millis: number, monotonic: number): TimeState {
  const state: TimeState = {
    instant: { millis, monotonic },
    clone: () => createTimeState(millis, monotonic),
  };
  return state;
}

const instantOf = (receiver: Value): Instant | undefined =>
  (receiver as GoStruct | undefined)?.native?.instant as Instant | undefined;

const component = (name: string, zero: number, read: (date: Date) => number, type: Type = INT): void => {
  addMethod(TIME, name, fn([], [type]), (receiver) => {
    const instant = instantOf(receiver);
    return BigInt(instant ? read(new Date(instant.millis)) : zero);
  });
};
component('Year', 1, (date) => date.getFullYear());
component('Month', 1, (date) => date.getMonth() + 1, MONTH);
component('Day', 1, (date) => date.getDate());
component('Hour', 0, (date) => date.getHours());
component('Minute', 0, (date) => date.getMinutes());
component('Second', 0, (date) => date.getSeconds());
component('Nanosecond', 0, (date) => date.getMilliseconds() * 1_000_000);
component('Weekday', 1, (date) => date.getDay(), WEEKDAY);
component(
  'YearDay',
  1,
  (date) => Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 1).getTime()) / 86_400_000) + 1
);
addMethod(TIME, 'IsZero', fn([], [BOOL]), (receiver) => instantOf(receiver) === undefined);

/** Time.String: `2009-11-10 23:00:00.123 +0900 JST m=+0.000123456`, or `0001-01-01 00:00:00 +0000 UTC` for zero. */
addMethod(TIME, 'String', fn([], [STRING]), (receiver) => {
  const instant = instantOf(receiver);
  if (!instant) return '0001-01-01 00:00:00 +0000 UTC';
  const date = new Date(instant.millis);
  const fraction = date.getMilliseconds() === 0 ? '' : `.${pad(date.getMilliseconds(), 3).replace(/0+$/, '')}`;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const zone =
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value ?? 'UTC';
  const name = /^GMT[+-]/.test(zone)
    ? `${sign}${pad(Math.floor(Math.abs(offset) / 60))}`
    : zone === 'GMT'
      ? 'UTC'
      : zone;
  const monotonic = (instant.monotonic / 1e9).toFixed(9);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${fraction} ${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)} ${name} m=+${monotonic}`;
});

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function constants(type: NamedType, names: string[], offset: number): Record<string, Entity> {
  return Object.fromEntries(
    names.map((name, index) => [
      name,
      {
        kind: 'const',
        name,
        type,
        value: { kind: 'int', value: BigInt(index + offset) },
        span: { row: 0, column: 0 },
        used: true,
      } satisfies Entity,
    ])
  );
}

const started = new WeakMap<object, number>();

const members: Record<string, Entity> = {
  Time: typeEntity(TIME),
  Weekday: typeEntity(WEEKDAY),
  Month: typeEntity(MONTH),
  ...constants(WEEKDAY, WEEKDAY_NAMES, 0),
  ...constants(MONTH, MONTH_NAMES, 1),
  Now: nativeFunction('Now', fn([], [TIME]), () => {
    const runtime = currentRuntime();
    const now = performance.now();
    if (!started.has(runtime)) started.set(runtime, now);
    const monotonic = Math.round((now - (started.get(runtime) as number)) * 1e6) + 1;
    return new GoStruct([], createTimeState(Date.now(), monotonic));
  }),
};

export const TIME_PACKAGE = definePackage('time', members, [
  'Duration',
  'Nanosecond',
  'Microsecond',
  'Millisecond',
  'Second',
  'Minute',
  'Hour',
  'Sleep',
  'Since',
  'Until',
  'Date',
  'Unix',
  'UnixMilli',
  'UnixMicro',
  'Parse',
  'ParseDuration',
  'ParseInLocation',
  'LoadLocation',
  'FixedZone',
  'Local',
  'UTC',
  'Location',
  'Tick',
  'Ticker',
  'NewTicker',
  'Timer',
  'NewTimer',
  'After',
  'AfterFunc',
  'Layout',
  'ANSIC',
  'UnixDate',
  'RubyDate',
  'RFC822',
  'RFC822Z',
  'RFC850',
  'RFC1123',
  'RFC1123Z',
  'RFC3339',
  'RFC3339Nano',
  'Kitchen',
  'Stamp',
  'StampMilli',
  'StampMicro',
  'StampNano',
  'DateTime',
  'DateOnly',
  'TimeOnly',
  'ParseError',
]);
