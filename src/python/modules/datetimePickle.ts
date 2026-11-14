// The pickling of the datetime types: their reductions to the byte states of CPython's `_datetime`, and the
// constructors that take those states back.
import { bytesLikeData, latin1Bytes, newBytes, PyBytes } from '../bytesValues';
import { method } from '../define';
import { toIndex } from '../numbers';
import { callValue, getAttributeOrUndefined } from '../objects';
import { objectState } from '../reduction';
import { classOf, newTuple, None, unbox } from '../types';
import type { Kwargs, PyClass, PyValue } from '../values';
import { type PyTimedelta, timedeltaClass } from './datetimeDelta';
import {
  dateClass,
  datetimeTypeClass,
  newDate,
  newDateTime,
  newTime,
  type PyDate,
  type PyDateTime,
  type PyTime,
  timeClass,
} from './datetimeObjects';
import { type PyTimezone, timezoneClass, tzinfoClass } from './datetimeZone';

type Construct = (cls: PyClass, args: PyValue[], kwargs: Kwargs) => PyValue;

/** The bytes of a pickled state: bytes, or the latin-1 text protocols 0 and 1 may give. */
function stateBytes(value: PyValue | undefined, size: number): Uint8Array | undefined {
  if (value instanceof PyBytes) {
    const data = bytesLikeData(value) as Uint8Array;
    return data.length === size ? data : undefined;
  }
  const text = unbox(value as PyValue);
  // oxlint-disable-next-line eslint/no-control-regex -- A latin-1 state may hold any code point below 0x100.
  if (typeof text !== 'string' || text.length !== size || !/^[\u0000-\u00FF]*$/.test(text)) {
    return undefined;
  }
  return latin1Bytes(text);
}

const microseconds = (data: Uint8Array, at: number): number => (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];

function wrapConstruct(cls: PyClass, fromState: (cls: PyClass, args: PyValue[]) => PyValue | undefined): void {
  const original = cls.construct as Construct;
  cls.construct = (target, args, kwargs) => {
    if (kwargs === undefined || kwargs.size === 0) {
      const restored = fromState(target, args);
      if (restored !== undefined) return restored;
    }
    return original(target, args, kwargs);
  };
}

wrapConstruct(dateClass, (cls, args) => {
  if (args.length !== 1) return;
  const data = stateBytes(args[0], 4);
  if (!data || data[2] < 1 || data[2] > 12) return;
  return newDate((data[0] << 8) | data[1], data[2], data[3], cls);
});

wrapConstruct(timeClass, (cls, args) => {
  if (args.length === 0 || args.length > 2) return;
  const data = stateBytes(args[0], 6);
  if (!data || (data[0] & 0x7f) >= 24) return;
  return newTime(
    {
      hour: data[0] & 0x7f,
      minute: data[1],
      second: data[2],
      microsecond: microseconds(data, 3),
      tzinfo: args[1] ?? None,
      fold: data[0] >> 7,
    },
    cls
  );
});

wrapConstruct(datetimeTypeClass, (cls, args) => {
  if (args.length === 0 || args.length > 2) return;
  const data = stateBytes(args[0], 10);
  if (!data || (data[2] & 0x7f) < 1 || (data[2] & 0x7f) > 12) return;
  return newDateTime(
    {
      year: (data[0] << 8) | data[1],
      month: data[2] & 0x7f,
      day: data[3],
      hour: data[4],
      minute: data[5],
      second: data[6],
      microsecond: microseconds(data, 7),
      tzinfo: args[1] ?? None,
      fold: data[2] >> 7,
    },
    cls
  );
});

function dateState(value: PyDate): number[] {
  return [value.year >> 8, value.year & 0xff, value.month, value.day];
}

function timeState(value: PyTime | PyDateTime): number[] {
  const us = value.microsecond;
  return [value.hour, value.minute, value.second, us >> 16, (us >> 8) & 0xff, us & 0xff];
}

function withTzinfo(cls: PyClass, state: number[], tzinfo: PyValue): PyValue {
  const data = newBytes(Uint8Array.from(state));
  return newTuple([cls, newTuple(tzinfo === None ? [data] : [data, tzinfo])]);
}

method(dateClass, '__reduce__', 'none', 0, 0, (self) =>
  newTuple([classOf(self), newTuple([newBytes(Uint8Array.from(dateState(self as PyDate)))])])
);

function timeReduce(self: PyValue, protocol: number): PyValue {
  const value = self as PyTime;
  const state = timeState(value);
  if (protocol > 3 && value.fold) state[0] |= 0x80;
  return withTzinfo(classOf(self), state, value.tzinfo);
}

function datetimeReduce(self: PyValue, protocol: number): PyValue {
  const value = self as PyDateTime;
  const state = [...dateState(value), ...timeState(value)];
  if (protocol > 3 && value.fold) state[2] |= 0x80;
  return withTzinfo(classOf(self), state, value.tzinfo);
}

for (const [cls, reduce] of [
  [timeClass, timeReduce],
  [datetimeTypeClass, datetimeReduce],
] as const) {
  method(cls, '__reduce_ex__', 'one', 1, 1, (self, [protocol]) => reduce(self, Number(toIndex(protocol))));
  method(cls, '__reduce__', 'none', 0, 0, (self) => reduce(self, 2));
}

method(timedeltaClass, '__reduce__', 'none', 0, 0, (self) => {
  const value = self as PyTimedelta;
  return newTuple([classOf(self), newTuple([BigInt(value.days), BigInt(value.seconds), BigInt(value.microseconds)])]);
});

method(tzinfoClass, '__reduce__', 'none', 0, 0, (self) => {
  const getinitargs = getAttributeOrUndefined(self, '__getinitargs__');
  const args = getinitargs === undefined ? newTuple([]) : callValue(getinitargs, []);
  return newTuple([classOf(self), args, objectState(self, false)]);
});

method(timezoneClass, '__getinitargs__', 'none', 0, 0, (self) => {
  const zone = self as PyTimezone;
  return newTuple(zone.name === undefined ? [zone.offset] : [zone.offset, zone.name]);
});
