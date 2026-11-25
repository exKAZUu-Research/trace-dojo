import { FileSystemError, type FileSystemErrorCode } from '../../interpreter/programIo';
import { PANIC, panic } from '../arith';
import type { Frame } from '../runtime';
import { known, type NativeCall, runtime, type SemaApi, type TExpr } from '../semaBase';
import {
  BOOL,
  CONST_U8_SLICE,
  type EnumType,
  errorSetOf,
  errorUnionOf,
  fnType,
  optionalOf,
  pointerTo,
  sliceOf,
  type StructType,
  type Type,
  U8,
  USIZE,
  VOID,
} from '../types';
import { ErrorValue, NULL, type Pointer, Slice, type Value, ZStruct } from '../values';
import { allocatingWriter, freeWriter, ownWriterSlice } from './allocatingWriter';
import { allocatorArg } from './common';
import { allocatorState, ERROR_OUT_OF_MEMORY } from './heap';
import {
  addMembers,
  compileArgs,
  expectArgs,
  fnMember,
  type Member,
  nativeStruct,
  receiverAddress,
  typeMember,
} from './native';
import { WRITER, writerState, writeTo } from './writer';

/**
 * `std.Io`'s Reader and Limit, which read standard input and files from the run's virtual file system, which Java's
 * programs share. They cover what learners' programs use; the members of Zig's library they leave out report
 * 「使えません」.
 */

// std.Io.Limit --------------------------------------------------------------------------------------------------------

export const UNLIMITED = (1n << 64n) - 1n;

/** `std.Io.Limit`, a count of bytes or `.unlimited`. */
export const LIMIT: EnumType = {
  kind: 'enum',
  namespace: { name: 'Io.Limit', decls: new Map() },
  tagType: USIZE,
  fields: [
    { name: 'nothing', value: 0n },
    { name: 'unlimited', value: UNLIMITED },
  ],
  exhaustive: false,
};

addMembers(LIMIT, {
  limited: fnMember(
    'std.Io.Limit.limited',
    (sema, call) => {
      const [count] = compileArgs(sema, expectArgs(sema, call, 1, 'std.Io.Limit.limited'), [USIZE]);
      return count.known ? known(LIMIT, count.value, call.span) : { ...count, type: LIMIT };
    },
    () => ({ type: fnType([USIZE], LIMIT) })
  ),
});

export function limitOf(value: Value): number {
  const limit = value as bigint;
  return limit >= BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(limit);
}

// std.Io.Reader -------------------------------------------------------------------------------------------------------

/** `std.Io.Reader`, whose value holds its buffer, the part of it read, and the descriptor it reads from. */
export const READER: StructType = nativeStruct(
  'Io.Reader',
  {},
  [
    { name: 'buffer', type: sliceOf(U8, false), hasDefault: false },
    { name: 'seek', type: USIZE, hasDefault: false },
    { name: 'end', type: USIZE, hasDefault: false },
  ],
  { kind: 'reader', args: [], storageSlots: 4, byteSize: 40 }
);

/** `std.Io.File.Reader`, whose `interface` field is the `std.Io.Reader` to read through. */
export const FILE_READER: StructType = nativeStruct(
  'Io.File.Reader',
  {},
  [{ name: 'interface', type: READER, hasDefault: false }],
  {
    kind: 'fileReader',
    args: [],
    storageSlots: 0,
    byteSize: 72,
  }
);

/** A reader's value: its buffer, the read and filled ends of it, and its descriptor, none for `Reader.fixed`. */
export function readerValue(buffer: Slice, descriptor: number | undefined, end = 0): ZStruct {
  return new ZStruct([buffer, 0n, BigInt(end), descriptor === undefined ? undefined : BigInt(descriptor)]);
}

/** A failure of a reader, which its method returns as the Zig error of that name. */
export class ReadError extends Error {
  constructor(readonly error: string) {
    super(error);
    this.name = 'ReadError';
  }
}

/** The reader that a method's receiver points to, as Zig's Reader functions see it. */
export class ReaderView {
  constructor(
    private readonly header: ZStruct,
    private readonly frame: Frame
  ) {}

  get buffer(): Slice {
    return this.header.slots[0] as Slice;
  }
  get seek(): number {
    return Number(this.header.slots[1] as bigint);
  }
  set seek(value: number) {
    this.header.slots[1] = BigInt(value);
  }
  get end(): number {
    return Number(this.header.slots[2] as bigint);
  }
  set end(value: number) {
    this.header.slots[2] = BigInt(value);
  }
  get descriptor(): number | undefined {
    const value = this.header.slots[3];
    return value === undefined ? undefined : Number(value as bigint);
  }

  /** The buffer from `start` up to `end`, which the caller sees as a slice of the reader's buffer. */
  part(start: number, end: number): Slice {
    return new Slice(this.buffer.target, this.buffer.start + start, end - start);
  }

  byte(index: number): number {
    return Number(this.buffer.get(index) as bigint);
  }

  /** Reads into `destination` at most its length, as Zig's readVec does: none at the end. */
  read(destination: Slice): number {
    const descriptor = this.descriptor;
    if (descriptor === undefined) return 0;
    const bytes = this.frame.runtime.readInput(descriptor, destination.length);
    if (!bytes) throw new ReadError('ReadFailed');
    for (const [index, byte] of bytes.entries()) destination.set(index, BigInt(byte));
    return bytes.length;
  }

  readMore(): void {
    const n = this.read(this.part(this.end, this.buffer.length));
    if (n === 0) throw new ReadError('EndOfStream');
    this.end += n;
  }

  rebase(capacity: number): void {
    if (this.buffer.length - this.seek >= capacity) return;
    if (this.descriptor === undefined) throw new ReadError('EndOfStream');
    if (capacity > this.buffer.length) panic(PANIC.unreachable);
    const data = Array.from({ length: this.end - this.seek }, (_, index) => this.buffer.get(this.seek + index));
    for (const [index, value] of data.entries()) this.buffer.set(index, value);
    this.seek = 0;
    this.end = data.length;
  }

  fill(n: number): void {
    if (this.seek + n <= this.end) return;
    this.rebase(n);
    while (this.end < this.seek + n) this.readMore();
  }

  fillMore(): void {
    this.rebase(this.end - this.seek + 1);
    this.readMore();
  }

  toss(n: number): void {
    this.seek += n;
    if (this.seek > this.end) panic(PANIC.unreachable);
  }

  take(n: number): Slice {
    this.fill(n);
    const result = this.part(this.seek, this.seek + n);
    this.seek += n;
    return result;
  }

  /** The bytes up to and including the delimiter, which must fit in the buffer. */
  peekDelimiterInclusive(delimiter: number): Slice {
    const found = (from: number): number | undefined => {
      for (let index = from; index < this.end; index++) {
        this.frame.runtime.spend();
        if (this.byte(index) === delimiter) return index;
      }
      return undefined;
    };
    let end = found(this.seek);
    while (end === undefined) {
      const content = this.end - this.seek;
      if (this.buffer.length - content === 0) break;
      this.fillMore();
      end = found(this.seek + content);
    }
    if (end !== undefined) return this.part(this.seek, end + 1);
    const descriptor = this.descriptor;
    if (descriptor === undefined || this.frame.runtime.inputAtEnd(descriptor)) throw new ReadError('EndOfStream');
    throw new ReadError('StreamTooLong');
  }

  /** The bytes before the delimiter, or the rest at the end of the input. */
  peekDelimiterExclusive(delimiter: number): Slice {
    try {
      const result = this.peekDelimiterInclusive(delimiter);
      return this.part(this.seek, this.seek + result.length - 1);
    } catch (error) {
      if (!(error instanceof ReadError) || error.error !== 'EndOfStream' || this.end === this.seek) throw error;
      return this.part(this.seek, this.end);
    }
  }

  readSliceShort(destination: Slice): number {
    let i = 0;
    while (i < destination.length) {
      if (this.buffer.length === 0) {
        const n = this.read(new Slice(destination.target, destination.start + i, destination.length - i));
        if (n === 0) return i;
        i += n;
        continue;
      }
      if (this.seek === this.end && !this.fillMoreOrEnd()) return i;
      const n = Math.min(destination.length - i, this.end - this.seek);
      for (let index = 0; index < n; index++) destination.set(i + index, this.buffer.get(this.seek + index));
      this.seek += n;
      i += n;
    }
    return i;
  }

  /** Reads the rest of the input as `appendRemaining` does: at most `limit` bytes, failing when it reaches them. */
  remaining(limit: number): number[] {
    const bytes: number[] = [];
    let left = limit;
    const spare = new Slice({ slots: Array.from({ length: 4096 }, () => 0n) }, 0, 4096);
    while (left !== 0) {
      let chunk: number[];
      if (this.buffer.length === 0) {
        const n = this.read(new Slice(spare.target, 0, Math.min(spare.length, left)));
        if (n === 0) return bytes;
        chunk = Array.from({ length: n }, (_, index) => Number(spare.get(index) as bigint));
      } else {
        if (this.seek === this.end && !this.fillMoreOrEnd()) return bytes;
        const n = Math.min(this.end - this.seek, left);
        chunk = Array.from({ length: n }, (_, index) => this.byte(this.seek + index));
        this.seek += n;
      }
      this.frame.runtime.spend(chunk.length);
      bytes.push(...chunk);
      left -= chunk.length;
    }
    throw new ReadError('StreamTooLong');
  }

  /** Fills more of the buffer, telling whether the input had more. */
  fillMoreOrEnd(): boolean {
    try {
      this.fillMore();
      return true;
    } catch (error) {
      if (error instanceof ReadError && error.error === 'EndOfStream') return false;
      throw error;
    }
  }

  /** Whether a read has met the end of the input and nothing is left in the buffer, as File.Reader.atEnd tells. */
  atEnd(): boolean {
    const descriptor = this.descriptor;
    return this.end === this.seek && descriptor !== undefined && this.frame.runtime.sawInputEnd(descriptor);
  }
}

export const READ_FAILED = errorSetOf(['ReadFailed']);
const READ_ERROR = errorSetOf(['ReadFailed', 'EndOfStream']);
const DELIMITER_ERROR = errorSetOf(['ReadFailed', 'EndOfStream', 'StreamTooLong']);
const STREAM_REMAINING_ERROR = errorSetOf(['ReadFailed', 'WriteFailed']);
export const LIMITED_ALLOC_ERROR = errorSetOf(['OutOfMemory', 'ReadFailed', 'StreamTooLong']);

/** A method of `std.Io.Reader`, which runs `body` on the reader its receiver points to. */
function readerMethod(
  name: string,
  params: readonly Type[],
  result: Type,
  body: (reader: ReaderView, values: Value[], frame: Frame) => Value
): () => Member {
  return receiverMethod(
    `Reader.${name}`,
    pointerTo(READER, false),
    (sema, call) => receiverAddress(sema, call, READER),
    params,
    result,
    (frame, target, values) => body(new ReaderView((target as Pointer).load() as ZStruct, frame), values, frame)
  );
}

export const SLICE = sliceOf(U8, false);

addMembers(READER, {
  Error: typeMember(() => READ_ERROR),
  ShortError: typeMember(() => READ_FAILED),
  DelimiterError: typeMember(() => DELIMITER_ERROR),
  StreamRemainingError: typeMember(() => STREAM_REMAINING_ERROR),
  LimitedAllocError: typeMember(() => LIMITED_ALLOC_ERROR),
  fixed: fnMember(
    'std.Io.Reader.fixed',
    (sema, call) => {
      const [bytes] = compileArgs(sema, expectArgs(sema, call, 1, 'std.Io.Reader.fixed'), [CONST_U8_SLICE]);
      const evaluate = bytes.eval;
      return runtime(
        READER,
        (frame) => {
          const slice = evaluate(frame) as Slice;
          return readerValue(slice, undefined, slice.length);
        },
        call.span
      );
    },
    () => ({ type: fnType([CONST_U8_SLICE], READER) })
  ),
  buffered: readerMethod('buffered', [], SLICE, (r) => r.part(r.seek, r.end)),
  bufferedLen: readerMethod('bufferedLen', [], USIZE, (r) => BigInt(r.end - r.seek)),
  toss: readerMethod('toss', [USIZE], VOID, (r, [n]) => {
    r.toss(Number(n as bigint));
    return;
  }),
  tossBuffered: readerMethod('tossBuffered', [], VOID, (r) => {
    r.seek = r.end;
    return;
  }),
  peek: readerMethod('peek', [USIZE], errorUnionOf(READ_ERROR, SLICE), (r, [n]) => {
    r.fill(Number(n as bigint));
    return r.part(r.seek, r.seek + Number(n as bigint));
  }),
  take: readerMethod('take', [USIZE], errorUnionOf(READ_ERROR, SLICE), (r, [n]) => r.take(Number(n as bigint))),
  peekByte: readerMethod('peekByte', [], errorUnionOf(READ_ERROR, U8), (r) => {
    r.fill(1);
    return BigInt(r.byte(r.seek));
  }),
  takeByte: readerMethod('takeByte', [], errorUnionOf(READ_ERROR, U8), (r) => {
    r.fill(1);
    const byte = r.byte(r.seek);
    r.seek += 1;
    return BigInt(byte);
  }),
  readSliceShort: readerMethod('readSliceShort', [SLICE], errorUnionOf(READ_FAILED, USIZE), (r, [buffer]) =>
    BigInt(r.readSliceShort(buffer as Slice))
  ),
  readSliceAll: readerMethod('readSliceAll', [SLICE], errorUnionOf(READ_ERROR, VOID), (r, [buffer]) => {
    if (r.readSliceShort(buffer as Slice) !== (buffer as Slice).length) throw new ReadError('EndOfStream');
    return;
  }),
  peekDelimiterInclusive: readerMethod('peekDelimiterInclusive', [U8], errorUnionOf(DELIMITER_ERROR, SLICE), (r, [d]) =>
    r.peekDelimiterInclusive(Number(d as bigint))
  ),
  takeDelimiterInclusive: readerMethod(
    'takeDelimiterInclusive',
    [U8],
    errorUnionOf(DELIMITER_ERROR, SLICE),
    (r, [d]) => {
      const result = r.peekDelimiterInclusive(Number(d as bigint));
      r.toss(result.length);
      return result;
    }
  ),
  peekDelimiterExclusive: readerMethod('peekDelimiterExclusive', [U8], errorUnionOf(DELIMITER_ERROR, SLICE), (r, [d]) =>
    r.peekDelimiterExclusive(Number(d as bigint))
  ),
  takeDelimiterExclusive: readerMethod(
    'takeDelimiterExclusive',
    [U8],
    errorUnionOf(DELIMITER_ERROR, SLICE),
    (r, [d]) => {
      const result = r.peekDelimiterExclusive(Number(d as bigint));
      r.toss(result.length);
      return result;
    }
  ),
  takeDelimiter: readerMethod(
    'takeDelimiter',
    [U8],
    errorUnionOf(errorSetOf(['ReadFailed', 'StreamTooLong']), optionalOf(SLICE)),
    (r, [d]) => {
      try {
        const inclusive = r.peekDelimiterInclusive(Number(d as bigint));
        r.toss(inclusive.length);
        return r.part(r.seek - inclusive.length, r.seek - 1);
      } catch (error) {
        if (!(error instanceof ReadError) || error.error !== 'EndOfStream') throw error;
        if (r.end === r.seek) return NULL;
        const rest = r.part(r.seek, r.end);
        r.toss(rest.length);
        return rest;
      }
    }
  ),
  discardRemaining: readerMethod('discardRemaining', [], errorUnionOf(READ_FAILED, USIZE), (r) =>
    BigInt(r.remaining(Number.POSITIVE_INFINITY).length)
  ),
  streamRemaining: fnMember('Reader.streamRemaining', (sema, call) => streamRemaining(sema, call)),
  allocRemaining: fnMember('Reader.allocRemaining', (sema, call) => allocRemaining(sema, call)),
});

/** `r.streamRemaining(w)`: writes the rest of the input to a writer, returning how many bytes it wrote. */
function streamRemaining(sema: SemaApi, call: NativeCall): TExpr {
  const pointer = receiverAddress(sema, call, READER);
  const [writer] = compileArgs(sema, expectArgs(sema, call, 1, 'streamRemaining'), [pointerTo(WRITER, false)]);
  const [evaluateReader, evaluateWriter] = [pointer.eval, writer.eval];
  return runtime(
    errorUnionOf(STREAM_REMAINING_ERROR, USIZE),
    (frame) => {
      const reader = new ReaderView((evaluateReader(frame) as Pointer).load() as ZStruct, frame);
      const target = evaluateWriter(frame) as Pointer;
      return attempt(() => {
        const bytes = reader.remaining(Number.POSITIVE_INFINITY);
        const written = writeTo(frame, writerState(target.load(), target), bytes);
        return written instanceof ErrorValue ? written : BigInt(bytes.length);
      });
    },
    call.span
  );
}

/** `r.allocRemaining(gpa, limit)`: the rest of the input in memory from the allocator, which reaching the limit fails. */
function allocRemaining(sema: SemaApi, call: NativeCall): TExpr {
  const pointer = receiverAddress(sema, call, READER);
  const [allocatorExpression, limitExpression] = expectArgs(sema, call, 2, 'allocRemaining');
  const allocator = allocatorArg(sema, allocatorExpression);
  const [limit] = compileArgs(sema, [limitExpression], [LIMIT]);
  const evaluators = [pointer, allocator, limit].map((arg) => arg.eval);
  return runtime(
    errorUnionOf(LIMITED_ALLOC_ERROR, SLICE),
    (frame) => {
      const [target, gpa, count] = evaluators.map((evaluate) => evaluate(frame));
      const reader = new ReaderView((target as Pointer).load() as ZStruct, frame);
      // Zig's allocRemaining reads one byte past the limit, failing only when there is more.
      const bound = (count as bigint) === UNLIMITED ? Number.POSITIVE_INFINITY : limitOf(count) + 1;
      return attempt(() => ownBytes(frame, gpa, reader.remaining(bound)));
    },
    call.span
  );
}

/** Bytes in memory that the allocator gives, as the caller then owns. */
export function ownBytes(frame: Frame, allocatorValue: Value, bytes: readonly number[]): Value {
  const allocator = allocatorState(allocatorValue);
  const writer = allocatingWriter(frame, allocator, bytes.length);
  if (!writer) return ERROR_OUT_OF_MEMORY;
  const written = writeTo(frame, writer, bytes);
  if (written instanceof ErrorValue) {
    freeWriter(allocator, writer);
    return ERROR_OUT_OF_MEMORY;
  }
  return ownWriterSlice(frame, allocator, writer);
}

addMembers(FILE_READER, {
  atEnd: fnMember(
    'File.Reader.atEnd',
    (sema, call) => {
      const pointer = receiverAddress(sema, call, FILE_READER, false);
      expectArgs(sema, call, 0, 'atEnd');
      const evaluate = pointer.eval;
      return runtime(
        BOOL,
        (frame) => new ReaderView(((evaluate(frame) as Pointer).load() as ZStruct).slots[0] as ZStruct, frame).atEnd(),
        call.span
      );
    },
    () => ({ type: fnType([pointerTo(FILE_READER, true)], BOOL), receiver: true })
  ),
});

/** The errors that the virtual file system's failures give. */
export const FILE_SYSTEM_ERROR_NAMES: Record<FileSystemErrorCode, string> = {
  ENOENT: 'FileNotFound',
  EEXIST: 'PathAlreadyExists',
  EISDIR: 'IsDir',
  ENOTDIR: 'NotDir',
  ENOTEMPTY: 'DirNotEmpty',
  EINVAL: 'BadPathName',
};

/**
 * A method of a native library type: it compiles the receiver and the arguments to the parameter types and runs `run`
 * with their values, failing with the Zig error that a file system or reader failure gives.
 */
export function receiverMethod(
  name: string,
  receiverType: Type,
  receiver: (sema: SemaApi, call: NativeCall) => TExpr,
  params: readonly Type[] | (() => readonly Type[]),
  result: Type,
  run: (frame: Frame, receiver: Value, values: Value[]) => Value
): () => Member {
  const paramTypes = typeof params === 'function' ? params : () => params;
  return fnMember(
    name,
    (sema, call) => {
      const evaluators = [
        receiver(sema, call),
        ...compileArgs(sema, expectArgs(sema, call, paramTypes().length, name), paramTypes()),
      ].map((arg) => arg.eval);
      return runtime(
        result,
        (frame) => {
          const [target, ...values] = evaluators.map((evaluate) => evaluate(frame));
          frame.runtime.spend();
          return attempt(() => run(frame, target, values));
        },
        call.span
      );
    },
    () => ({ type: fnType([receiverType, ...paramTypes()], result), receiver: true })
  );
}

/** Runs a file system operation, giving the Zig error that a failure of it returns. */
export function attempt(run: () => Value): Value {
  try {
    return run();
  } catch (error) {
    if (error instanceof FileSystemError) return ErrorValue.of(FILE_SYSTEM_ERROR_NAMES[error.code]);
    if (error instanceof ReadError) return ErrorValue.of(error.error);
    throw error;
  }
}

let ioType: Type | undefined;

export function IO_TYPE(): Type {
  if (!ioType) throw new Error('std.Io is not configured');
  return ioType;
}

/** Records the `std.Io` type, which the native members take as their `io` argument. */
export function configureIo(io: Type): void {
  ioType = io;
}
