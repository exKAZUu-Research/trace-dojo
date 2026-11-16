import { checkOutputSize } from '../allocation';
import type { Frame } from '../runtime';
import type { StructType } from '../types';
import { ErrorValue, Slice, type Value, ZArray } from '../values';
import { nativeStruct } from './native';

export const WRITER: StructType = nativeStruct('Io.Writer', {});

export interface WriterState extends Record<string, unknown> {
  fd: number | undefined;
  buffer: Slice;
  end: number;
  capacity: number;
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
  if (end > state.capacity) {
    if (state.fd === undefined) return ErrorValue.of('WriteFailed');
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
