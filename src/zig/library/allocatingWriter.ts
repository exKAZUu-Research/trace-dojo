import type { Frame } from '../runtime';
import { U8 } from '../types';
import { NativeHandle, Slice, ZArray } from '../values';
import { growCapacity } from './arrayList';
import { type AllocatorState, ERROR_OUT_OF_MEMORY, freeMemory, reserveNativeAllocation } from './heap';
import type { WriterState } from './writer';

export function allocatingWriter(frame: Frame, allocator: AllocatorState, capacity: number): WriterState | undefined {
  const state: WriterState = {
    fd: undefined,
    buffer: new Slice(new ZArray([]), 0, 0),
    end: 0,
    capacity: 0,
    growth: new NativeHandle('allocatingWriter', {
      grow: (frame: Frame, writer: WriterState, end: number) =>
        resizeWriter(frame, allocator, writer, growCapacity(end + 1, U8)),
    }),
  };
  return resizeWriter(frame, allocator, state, capacity) ? state : undefined;
}

export function ownWriterSlice(
  frame: Frame,
  allocator: AllocatorState,
  state: WriterState
): Slice | typeof ERROR_OUT_OF_MEMORY {
  if (state.end === 0) {
    const result = new Slice(state.buffer.target, state.buffer.start, 0);
    freeWriter(allocator, state);
    return result;
  }
  if (!resizeWriter(frame, allocator, state, state.end)) return ERROR_OUT_OF_MEMORY;
  const result = new Slice(state.buffer.target, state.buffer.start, state.end);
  clearWriter(state);
  return result;
}

export function freeWriter(allocator: AllocatorState, state: WriterState): void {
  if (state.capacity > 0) freeMemory(allocator, state.buffer.target);
  clearWriter(state);
}

function resizeWriter(frame: Frame, allocator: AllocatorState, state: WriterState, capacity: number): boolean {
  if (capacity === state.capacity) return true;
  const complete = reserveNativeAllocation(
    frame,
    allocator,
    capacity,
    U8,
    state.capacity > 0 ? state.buffer.target : undefined
  );
  if (!complete) return false;
  const copied = Math.min(state.end, capacity);
  frame.runtime.spend(copied * 2 + capacity);
  const values = Array.from({ length: capacity }, (_, index) => (index < copied ? state.buffer.get(index) : 0xaan));
  const storage = new ZArray(values);
  complete(storage, copied);
  state.buffer = new Slice(storage, 0, capacity);
  state.capacity = capacity;
  return true;
}

function clearWriter(state: WriterState): void {
  state.buffer = new Slice(new ZArray([]), 0, 0);
  state.end = 0;
  state.capacity = 0;
}
