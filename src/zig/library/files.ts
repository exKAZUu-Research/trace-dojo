import { FileSystemError, type FileSystemErrorCode } from '../../interpreter/programIo';
import { type Frame, UnavailableOperation } from '../runtime';
import { known, type NativeCall, runtime, type SemaApi, type TExpr } from '../semaBase';
import {
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
} from '../types';
import { ErrorValue, NULL, type Pointer, Slice, type Value, ZStruct } from '../values';
import { allocatingWriter, freeWriter, ownWriterSlice } from './allocatingWriter';
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
import { writeTo } from './writer';

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

/**
 * `std.Io.Reader`, whose value holds the caller's buffer, which a piece it returns is copied into, and the descriptor
 * it reads through, whose text programIo reads.
 */
export const READER: StructType = nativeStruct('Io.Reader', {}, [], {
  kind: 'reader',
  args: [],
  storageSlots: 2,
  byteSize: 40,
});

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

/** A reader's value: the caller's buffer and the descriptor it reads. */
export function readerValue(buffer: Slice, descriptor: number): ZStruct {
  return new ZStruct([buffer, BigInt(descriptor)]);
}

const READ_ERROR = errorSetOf(['ReadFailed', 'EndOfStream']);
const DELIMITER_ERROR = errorSetOf(['ReadFailed', 'EndOfStream', 'StreamTooLong']);
export const LIMITED_ALLOC_ERROR = errorSetOf(['OutOfMemory', 'ReadFailed', 'StreamTooLong']);
export const SLICE = sliceOf(U8, false);

/** A failure of a reader, which its method returns as the Zig error of that name. */
class ReadError extends Error {
  constructor(readonly error: string) {
    super(error);
    this.name = 'ReadError';
  }
}

/**
 * The next piece of the input up to the delimiter, copied into the start of the reader's buffer: with the delimiter
 * when `through`, and read past it when `take`. At the end of the input the piece is the rest, or `undefined` when
 * none is left. A piece longer than the buffer, or a rest without the delimiter that fills it, fails with
 * `StreamTooLong`, as Zig's buffered reader does.
 */
function delimitedPiece(
  frame: Frame,
  reader: ZStruct,
  delimiter: number,
  options: { through: boolean; take: 'none' | 'piece' | 'delimiter' }
): Slice | undefined {
  const [buffer, descriptor] = reader.slots as [Slice, bigint];
  const input = frame.runtime.inputReader(Number(descriptor));
  if (!input) throw new ReadError('ReadFailed');
  // The run's input is text, which a delimiter byte that is not ASCII cannot split.
  if (delimiter >= 0x80) throw new UnavailableOperation('io:nonAsciiDelimiter');
  const separator = String.fromCodePoint(delimiter);
  const peeked = input.peekThrough(separator);
  if (peeked === '') return undefined;
  const found = peeked.endsWith(separator);
  const bytes = new TextEncoder().encode(peeked);
  // Zig fills the whole buffer before it can tell a missing delimiter from the end of the input.
  if (found ? bytes.length > buffer.length : bytes.length >= buffer.length) throw new ReadError('StreamTooLong');
  const pieceText = found && !options.through ? peeked.slice(0, -1) : peeked;
  const piece = found && !options.through ? bytes.subarray(0, -1) : bytes;
  frame.runtime.spend(piece.length);
  for (const [index, byte] of piece.entries()) buffer.set(index, BigInt(byte));
  if (options.take === 'piece') input.skip(pieceText.length);
  if (options.take === 'delimiter') input.skip(peeked.length);
  return new Slice(buffer.target, buffer.start, piece.length);
}

/** A delimiter method of `std.Io.Reader`, which reads through the reader its receiver points to. */
function delimiterMethod(
  name: string,
  result: Type,
  read: (frame: Frame, reader: ZStruct, delimiter: number) => Value
): () => Member {
  return receiverMethod(
    `Reader.${name}`,
    pointerTo(READER, false),
    (sema, call) => receiverAddress(sema, call, READER),
    [U8],
    result,
    (frame, target, [delimiter]) => read(frame, (target as Pointer).load() as ZStruct, Number(delimiter as bigint))
  );
}

addMembers(READER, {
  Error: typeMember(() => READ_ERROR),
  DelimiterError: typeMember(() => DELIMITER_ERROR),
  LimitedAllocError: typeMember(() => LIMITED_ALLOC_ERROR),
  // Zig's exclusive take leaves the delimiter to the next read.
  takeDelimiterExclusive: delimiterMethod(
    'takeDelimiterExclusive',
    errorUnionOf(DELIMITER_ERROR, SLICE),
    (frame, reader, delimiter) =>
      delimitedPiece(frame, reader, delimiter, { through: false, take: 'piece' }) ?? ErrorValue.of('EndOfStream')
  ),
  takeDelimiterInclusive: delimiterMethod(
    'takeDelimiterInclusive',
    errorUnionOf(DELIMITER_ERROR, SLICE),
    (frame, reader, delimiter) => {
      const piece = delimitedPiece(frame, reader, delimiter, { through: true, take: 'none' });
      const last = piece && piece.length > 0 ? piece.get(piece.length - 1) : undefined;
      // Zig's inclusive take needs the delimiter, which the rest of the input lacks.
      if (!piece || last !== BigInt(delimiter)) return ErrorValue.of('EndOfStream');
      return delimitedPiece(frame, reader, delimiter, { through: true, take: 'delimiter' }) as Slice;
    }
  ),
  takeDelimiter: delimiterMethod(
    'takeDelimiter',
    errorUnionOf(errorSetOf(['ReadFailed', 'StreamTooLong']), optionalOf(SLICE)),
    (frame, reader, delimiter) =>
      delimitedPiece(frame, reader, delimiter, { through: false, take: 'delimiter' }) ?? NULL
  ),
});

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
