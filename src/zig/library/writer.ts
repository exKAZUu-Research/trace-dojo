import { checkOutputSize } from '../allocation';
import { indexOutOfBounds, PANIC, panic } from '../arith';
import type { FormatOutput } from '../fmt';
import { MemoryFault } from '../memoryFault';
import type { Frame } from '../runtime';
import { sliceOf, type StructType, U8, USIZE } from '../types';
import {
  ErrorValue,
  isUndefinedMemory,
  NativeHandle,
  Pointer,
  registerNativeReferences,
  Slice,
  storageOverlaps,
  type Value,
  ZArray,
  ZStruct,
} from '../values';
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
  flushAfterFormat?: boolean;
}

export class WriterWriteError extends Error {
  constructor(readonly value: ErrorValue) {
    super(value.name);
    this.name = 'WriterWriteError';
  }
}

export class WriterFormatOutput implements FormatOutput {
  length = 0;

  constructor(
    private readonly frame: Frame,
    private readonly destination: WriterState
  ) {}

  push(...bytes: number[]): number {
    this.writeView(bytes.length, (index) => bytes[index]);
    return this.length;
  }

  writeView(length: number, get: (index: number) => number, source?: Slice): void {
    if (length === 0) return;
    const state = this.destination;
    if (!isDiscardingWriter(state)) {
      const result = writeTo(this.frame, state, { length, get, source });
      if (result instanceof ErrorValue) throw new WriterWriteError(result);
      this.length += length;
      return;
    }
    const end = writerEndAfter(state, BigInt(length));
    if (end <= state.capacity) copyWriteBytes(this.frame, state, { length, get, source }, length);
    else {
      this.frame.runtime.spend(length);
      discardOverflow(state, length);
    }
    this.length += length;
  }

  writeChunks(length: number, get: (index: number) => number, chunkSize: number): void {
    if (length === 0) return;
    const state = this.destination;
    if (!isDiscardingWriter(state)) {
      for (let start = 0; start < length; start += chunkSize)
        this.writeView(Math.min(chunkSize, length - start), (index) => get(start + index));
      return;
    }
    const initialEnd = writerEnd(state);
    writerEndAfter(state, BigInt(Math.min(length, chunkSize)));
    if (initialEnd + BigInt(length) <= BigInt(state.capacity)) return this.writeView(length, get);
    this.frame.runtime.spend(length);
    const firstFit = Math.max(0, Math.floor((state.capacity - Number(initialEnd)) / chunkSize));
    const remaining = length - (firstFit + 1) * chunkSize;
    const cycle = Math.floor(state.capacity / chunkSize) + 1;
    const finalLength = ((remaining / chunkSize) % cycle) * chunkSize;
    addDiscarded(state, initialEnd + BigInt(length - finalLength));
    for (let index = 0; index < finalLength; index++)
      state.buffer.set(index, BigInt(get(length - finalLength + index)));
    state.end = finalLength;
    this.length += length;
  }

  repeat(byte: number, count: bigint): void {
    if (count === 0n) return;
    const result = writeRepeated(this.frame, this.destination, [byte], count);
    if (result instanceof ErrorValue) throw new WriterWriteError(result);
    this.length += Number(count);
  }

  checkSize(length: number): void {
    if (this.destination.flushAfterFormat) checkOutputSize(length);
  }
}

export function discardingWriter(): WriterState {
  return {
    fd: undefined,
    buffer: new Slice(new ZArray(Array.from({ length: 64 }, () => 0xaan)), 0, 64),
    end: 0,
    capacity: 64,
    growth: new NativeHandle('discardingWriter', {
      count: 0n,
      drain: (frame: Frame, state: WriterState, bytes: readonly number[]) => {
        frame.runtime.spend(bytes.length);
        discardOverflow(state, bytes.length);
      },
    }),
  };
}

export function isDiscardingWriter(state: WriterState): boolean {
  return state.growth?.kind === 'discardingWriter';
}

export function discardedBytes(state: WriterState): bigint {
  const result = ((state.growth as NativeHandle).state.count as bigint) + writerEnd(state);
  if (result > (1n << 64n) - 1n) panic(PANIC.overflow);
  return result;
}

function discardRepeated(frame: Frame, state: WriterState, bytes: WriteBytes): void {
  const length = Number(bytes.length);
  if (length === 0) return;
  if (writerEndAfter(state, BigInt(bytes.length)) <= state.capacity) {
    copyWriteBytes(frame, state, bytes, length);
    return;
  }
  frame.runtime.spend(length);
  discardOverflow(state, length);
}

function discardOverflow(state: WriterState, length: number): void {
  addDiscarded(state, writerEnd(state) + BigInt(length));
  state.end = 0;
}

function addDiscarded(state: WriterState, length: bigint): void {
  const data = (state.growth as NativeHandle).state;
  const count = (data.count as bigint) + length;
  if (count > (1n << 64n) - 1n) panic(PANIC.overflow);
  data.count = count;
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
  registerNativeReferences(state, () => [{ value: header, type: WRITER }]);
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

export function writerBytes(frame: Frame, value: Slice): number[] {
  const bytes = value.readBytes((cost) => frame.runtime.spend(cost));
  frame.runtime.spend(bytes.length);
  return [...bytes];
}

export function bufferingWriter(): WriterState {
  return { fd: undefined, buffer: new Slice(new ZArray([]), 0, 0), end: 0, capacity: Infinity };
}

type WriteBytes =
  | readonly number[]
  | { length: number | bigint; get: (index: number) => number; source?: Slice; splat?: boolean };

export function writeSlice(frame: Frame, state: WriterState, slice: Slice): Value {
  return writeTo(frame, state, sliceBytes(frame, slice));
}

export function writeRepeated(
  frame: Frame,
  state: WriterState,
  bytes: readonly number[] | Slice,
  count: bigint
): Value {
  const data =
    bytes instanceof Slice
      ? sliceBytes(frame, bytes, count)
      : { length: BigInt(bytes.length) * count, get: (index: number) => bytes[index % bytes.length] };
  if (isDiscardingWriter(state)) {
    discardRepeated(frame, state, data);
    return;
  }
  return writeTo(frame, state, data);
}

function sliceBytes(frame: Frame, source: Slice, count?: bigint): WriteBytes {
  if (source.lengthValue !== 0n && isUndefinedMemory(source)) throw new MemoryFault();
  const get = (index: number): number => {
    frame.runtime.spend();
    return Number(source.get(count === undefined ? index : index % source.length));
  };
  return { length: source.lengthValue * (count ?? 1n), get, source, splat: count !== undefined };
}

export function writeTo(frame: Frame, state: WriterState, bytes: WriteBytes): Value {
  const length = Number(bytes.length);
  frame.runtime.spend();
  const end = writerEndAfter(state, BigInt(bytes.length));
  if (end > state.capacity && state.growth) {
    const drain = state.growth.state.drain as
      | ((frame: Frame, writer: WriterState, bytes: readonly number[]) => Value)
      | undefined;
    if (drain) return drain(frame, state, materializeBytes(frame, bytes));
    const grow = state.growth.state.grow as (frame: Frame, writer: WriterState, end: number) => boolean;
    if (!grow(frame, state, end)) return ErrorValue.of('WriteFailed');
  }
  if (end > state.capacity) {
    if (state.fd === undefined) {
      const available = writerRemaining(state);
      copyWriteBytes(frame, state, bytes, available, true);
      return ErrorValue.of('WriteFailed');
    }
    checkOutputSize(end);
    frame.runtime.spend(state.end + length);
    frame.runtime.writeOutput(state.fd, [...bufferedBytes(frame, state), ...materializeBytes(frame, bytes)]);
    state.end = 0;
    return undefined;
  }
  if (!Number.isFinite(state.capacity)) frame.runtime.reserveStorage(length);
  copyWriteBytes(frame, state, bytes, length);
  if (!Number.isFinite(state.capacity))
    state.buffer = new Slice(state.buffer.target, state.buffer.start, Math.max(state.buffer.length, end));
  return undefined;
}

function copyWriteBytes(frame: Frame, state: WriterState, bytes: WriteBytes, length: number, drained = false): void {
  if (length === 0) return;
  const get = 'get' in bytes ? bytes.get : (index: number): number => bytes[index];
  const source = 'get' in bytes ? bytes.source : undefined;
  if (!source) {
    copyWriterChunk(frame, state, length, get);
    return;
  }
  if (source.length === 1 && (drained || ('get' in bytes && bytes.splat))) {
    const byte = get(0);
    copyWriterChunk(frame, state, length, () => byte);
    return;
  }
  const destination = state.buffer;
  for (let offset = 0; offset < length; offset += source.length) {
    const size = Math.min(source.length, length - offset);
    if (storageOverlaps(destination.target, destination.start + state.end, source.target, source.start, size, 1))
      panic(PANIC.memcpyAlias);
    copyWriterChunk(frame, state, size, (index) => get(offset + index));
  }
}

function copyWriterChunk(frame: Frame, state: WriterState, length: number, get: (index: number) => number): void {
  const buffer = state.buffer;
  const start = state.end;
  frame.runtime.spend(length);
  for (let index = 0; index < length; index++) buffer.set(start + index, BigInt(get(index)));
  state.end = start + length;
}

function materializeBytes(frame: Frame, bytes: WriteBytes): readonly number[] {
  if (!('get' in bytes)) return bytes;
  const length = Number(bytes.length);
  frame.runtime.spend(length);
  return Array.from({ length }, (_, index) => bytes.get(index));
}

export function flushWriter(frame: Frame, state: WriterState): void {
  if (isDiscardingWriter(state)) {
    frame.runtime.spend();
    addDiscarded(state, writerEnd(state));
    state.end = 0;
    return;
  }
  if (state.fd === undefined) return;
  checkOutputSize(state.end);
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
