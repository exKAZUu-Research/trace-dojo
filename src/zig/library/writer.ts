import { LIMITS } from '../../interpreter/limits';
import { checkOutputSize } from '../allocation';
import { byteValues } from '../builtins';
import type { FormatOutput } from '../fmt';
import type { Frame } from '../runtime';
import type { StructType } from '../types';
import { ErrorValue, NativeHandle, Slice, type Value, ZArray, ZStruct } from '../values';
import { nativeStruct } from './native';

export const WRITER: StructType = nativeStruct('Io.Writer', {}, [], {
  kind: 'writer',
  args: [],
  storageSlots: 5,
  byteSize: 32,
});

export interface WriterState extends Record<string, unknown> {
  fd: number | undefined;
  buffer: Slice;
  end: number;
  capacity: number;
  growth?: NativeHandle;
}

export class CountingFormatOutput implements FormatOutput {
  length = 0;
  readonly prefix: number[] = [];

  constructor(private readonly frame: Frame) {}

  push(...bytes: number[]): number {
    this.frame.runtime.spend(bytes.length);
    for (const byte of bytes) if (this.prefix.length < 64) this.prefix.push(byte);
    this.length += bytes.length;
    return this.length;
  }

  checkSize(length: number): void {
    const extra = Math.max(0, length - this.length);
    this.frame.runtime.spend(extra > LIMITS.maxOperations - this.frame.runtime.budget.spent ? extra : 0);
  }
}

export function discardingWriter(): WriterState {
  return {
    fd: undefined,
    buffer: new Slice(new ZArray(Array.from({ length: 64 }, () => 0xaan)), 0, 64),
    end: 0,
    capacity: 64,
    growth: new NativeHandle('discardingWriter', {
      count: 0,
      drain: (frame: Frame, state: WriterState, bytes: readonly number[]) => {
        frame.runtime.spend(state.end + bytes.length);
        discardWritten(state, bytes.length, bytes);
      },
    }),
  };
}

export function isDiscardingWriter(state: WriterState): boolean {
  return state.growth?.kind === 'discardingWriter';
}

export function discardedBytes(state: WriterState): number {
  return ((state.growth as NativeHandle).state.count as number) + state.end;
}

export function writeCounted(frame: Frame, state: WriterState, output: CountingFormatOutput): void {
  if (state.end + output.length > state.capacity) frame.runtime.spend(state.end);
  discardWritten(state, output.length, output.prefix);
}

export function discardRepeated(frame: Frame, state: WriterState, bytes: readonly number[], count: number): void {
  const length = bytes.length * count;
  frame.runtime.spend(length + (length + state.end > state.capacity ? state.end : 0));
  const prefix =
    length + state.end <= state.capacity ? Array.from({ length }, (_, index) => bytes[index % bytes.length]) : [];
  discardWritten(state, length, prefix);
}

function discardWritten(state: WriterState, length: number, prefix: readonly number[]): void {
  if (state.end + length > state.capacity) {
    const data = (state.growth as NativeHandle).state;
    data.count = (data.count as number) + state.end + length;
    state.end = 0;
    return;
  }
  for (let index = 0; index < length; index++) state.buffer.set(state.end + index, BigInt(prefix[index]));
  state.end += length;
}

export function writerValue(state: WriterState): ZStruct {
  return new ZStruct([state.fd, state.buffer, state.end, state.capacity, state.growth]);
}

export function writerState(value: Value): WriterState {
  const header = value as ZStruct;
  const state = {} as WriterState;
  for (const [index, name] of ['fd', 'buffer', 'end', 'capacity', 'growth'].entries()) {
    Object.defineProperty(state, name, {
      enumerable: true,
      get: () => header.slots[index],
      set: (value: Value) => {
        header.slots[index] = value;
      },
    });
  }
  return state;
}

export function bufferedBytes(frame: Frame, state: WriterState): number[] {
  return writerBytes(frame, new Slice(state.buffer.target, state.buffer.start, state.end));
}

export function writerBytes(frame: Frame, value: Value): number[] {
  return byteValues(value, (cost) => frame.runtime.spend(cost * 2)).map(Number);
}

export function bufferingWriter(): WriterState {
  return { fd: undefined, buffer: new Slice(new ZArray([]), 0, 0), end: 0, capacity: Infinity };
}

export function writeTo(frame: Frame, state: WriterState, bytes: readonly number[]): Value {
  frame.runtime.spend();
  const end = state.end + bytes.length;
  if (end > state.capacity && state.growth) {
    const drain = state.growth.state.drain as
      | ((frame: Frame, writer: WriterState, bytes: readonly number[]) => Value)
      | undefined;
    if (drain) return drain(frame, state, bytes);
    const grow = state.growth.state.grow as (frame: Frame, writer: WriterState, end: number) => boolean;
    if (!grow(frame, state, end)) return ErrorValue.of('WriteFailed');
  }
  if (end > state.capacity) {
    if (state.fd === undefined) {
      const available = Math.max(0, state.capacity - state.end);
      frame.runtime.spend(available);
      for (let index = 0; index < available; index++) state.buffer.set(state.end + index, BigInt(bytes[index]));
      state.end += available;
      return ErrorValue.of('WriteFailed');
    }
    frame.runtime.spend(state.end + bytes.length);
    frame.runtime.writeOutput(state.fd, [...bufferedBytes(frame, state), ...bytes]);
    state.end = 0;
    return undefined;
  }
  if (!Number.isFinite(state.capacity)) checkOutputSize(end);
  frame.runtime.spend(bytes.length);
  for (const [index, byte] of bytes.entries()) state.buffer.set(state.end + index, BigInt(byte));
  state.end = end;
  return undefined;
}

export function flushWriter(frame: Frame, state: WriterState): void {
  if (state.fd === undefined) return;
  frame.runtime.writeOutput(state.fd, bufferedBytes(frame, state));
  state.end = 0;
}
