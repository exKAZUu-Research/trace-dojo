import { LIMITS } from '../../interpreter/limits';
import { checkOutputSize } from '../allocation';
import { indexOutOfBounds, PANIC, panic } from '../arith';
import { byteValues } from '../builtins';
import type { FormatOutput } from '../fmt';
import type { Frame } from '../runtime';
import { sliceOf, type StructType, U8, USIZE } from '../types';
import { ErrorValue, NativeHandle, Pointer, Slice, type Value, ZArray, ZStruct } from '../values';
import { nativeStruct } from './native';

export const WRITER: StructType = nativeStruct(
  'Io.Writer',
  {},
  [
    { name: 'buffer', type: sliceOf(U8, false), hasDefault: false },
    { name: 'end', type: USIZE, hasDefault: false },
  ],
  {
    kind: 'writer',
    args: [],
    storageSlots: 3,
    byteSize: 32,
  }
);

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

  writeView(length: number, get: (index: number) => number): void {
    this.frame.runtime.spend(length);
    const prefix = Math.min(length, 64 - this.prefix.length);
    for (let index = 0; index < prefix; index++) this.prefix.push(get(index));
    this.length += length;
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

const headers = new WeakMap<WriterState, ZStruct>();
const states = new WeakMap<ZStruct, WriterState>();
const pointers = new WeakMap<WriterState, Pointer>();

export function writerPointer(state: WriterState): Pointer {
  let pointer = pointers.get(state);
  if (!pointer) {
    pointer = new Pointer({ slots: [writerValue(state)] }, 0);
    pointers.set(state, pointer);
  }
  return pointer;
}

export function writerValue(state: WriterState): ZStruct {
  const cached = headers.get(state);
  if (cached) return cached;
  const header = new ZStruct([state.buffer, BigInt(state.end), state.fd, state.capacity, state.growth]);
  bindWriterState(state, header);
  return header;
}

export function writerState(value: Value, pointer?: Pointer): WriterState {
  const header = value as ZStruct;
  let state = states.get(header);
  if (!state) {
    state = {} as WriterState;
    bindWriterState(state, header);
  }
  if (pointer) pointers.set(state, pointer);
  return state;
}

function bindWriterState(state: WriterState, header: ZStruct): void {
  headers.set(state, header);
  states.set(header, state);
  for (const [index, name] of ['buffer', 'end', 'fd', 'capacity', 'growth'].entries()) {
    Object.defineProperty(state, name, {
      enumerable: true,
      configurable: true,
      get: () =>
        name === 'end'
          ? Number(header.slots[index] as bigint)
          : name === 'capacity' && header.slots[index] !== Infinity
            ? (header.slots[0] as Slice).length
            : header.slots[index],
      set: (value: Value) => {
        header.slots[index] = name === 'end' ? BigInt(value as number) : value;
      },
    });
  }
}

export function bufferedSlice(state: WriterState): Slice {
  const end = writerEnd(state);
  const buffer = state.buffer;
  if (end > buffer.lengthValue) indexOutOfBounds(end, buffer.lengthValue);
  return new Slice(buffer.target, buffer.start, end);
}

export function writeByteTo(frame: Frame, state: WriterState, byte: number): Value {
  if (writerEnd(state) > state.buffer.lengthValue) panic(PANIC.overflow);
  return writeTo(frame, state, [byte]);
}

export function bufferedBytes(frame: Frame, state: WriterState): number[] {
  return writerBytes(frame, bufferedSlice(state));
}

export function writerBytes(frame: Frame, value: Value): number[] {
  return byteValues(value, (cost) => frame.runtime.spend(cost * 2)).map(Number);
}

export function bufferingWriter(): WriterState {
  return { fd: undefined, buffer: new Slice(new ZArray([]), 0, 0), end: 0, capacity: Infinity };
}

// code-gauge-allow functionNcss 31 -- Keeps growth, drain, and buffered writes in their observable order.
export function writeTo(frame: Frame, state: WriterState, bytes: readonly number[]): Value {
  frame.runtime.spend();
  const end = writerEndAfter(state, BigInt(bytes.length));
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
      const available = writerRemaining(state);
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
  if (!Number.isFinite(state.capacity))
    state.buffer = new Slice(state.buffer.target, state.buffer.start, Math.max(state.buffer.length, end));
  return undefined;
}

export function flushWriter(frame: Frame, state: WriterState): void {
  if (isDiscardingWriter(state)) {
    frame.runtime.spend(state.end);
    const data = (state.growth as NativeHandle).state;
    data.count = (data.count as number) + state.end;
    state.end = 0;
    return;
  }
  if (state.fd === undefined) return;
  frame.runtime.writeOutput(state.fd, bufferedBytes(frame, state));
  state.end = 0;
}

export function writerEndAfter(state: WriterState, length: bigint): number {
  const end = writerEnd(state) + length;
  if (end > (1n << 64n) - 1n) panic(PANIC.overflow);
  return Number(end);
}

export function writerRemaining(state: WriterState): number {
  const end = writerEnd(state);
  const length = state.buffer.lengthValue;
  if (end > length) panic(`start index ${end} is larger than end index ${length}`);
  return Number(length - end);
}

function writerEnd(state: WriterState): bigint {
  return (headers.get(state)?.slots[1] as bigint | undefined) ?? BigInt(state.end);
}
