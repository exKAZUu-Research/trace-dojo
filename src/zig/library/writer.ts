import { checkOutputSize } from '../allocation';
import type { Frame } from '../runtime';
import type { StructType } from '../types';
import { ErrorValue, type NativeHandle, Slice, type Value, ZArray, ZStruct } from '../values';
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

export function bufferedBytes(state: WriterState): number[] {
  return state.buffer.target.slots.slice(state.buffer.start, state.buffer.start + state.end).map(Number);
}

export function bufferingWriter(): WriterState {
  return { fd: undefined, buffer: new Slice(new ZArray([]), 0, 0), end: 0, capacity: Infinity };
}

export function writeTo(frame: Frame, state: WriterState, bytes: readonly number[]): Value {
  frame.runtime.spend();
  const end = state.end + bytes.length;
  if (end > state.capacity && state.growth) {
    const grow = state.growth.state.grow as (frame: Frame, writer: WriterState, end: number) => boolean;
    if (!grow(frame, state, end)) return ErrorValue.of('WriteFailed');
  }
  if (end > state.capacity) {
    if (state.fd === undefined) {
      const available = Math.max(0, state.capacity - state.end);
      for (let index = 0; index < available; index++) state.buffer.set(state.end + index, BigInt(bytes[index]));
      state.end += available;
      return ErrorValue.of('WriteFailed');
    }
    frame.runtime.writeOutput(state.fd, [...bufferedBytes(state), ...bytes]);
    state.end = 0;
    return undefined;
  }
  if (!Number.isFinite(state.capacity)) checkOutputSize(end);
  for (const [index, byte] of bytes.entries()) state.buffer.set(state.end + index, BigInt(byte));
  state.end = end;
  return undefined;
}

export function flushWriter(frame: Frame, state: WriterState): void {
  if (state.fd === undefined) return;
  frame.runtime.writeOutput(state.fd, bufferedBytes(state));
  state.end = 0;
}
