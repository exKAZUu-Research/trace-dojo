import type { FileHandle, OpenMode } from '../../interpreter/programIo';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { type CsArray, CsObject, type Value } from '../values';
import { checkLock, holdLock, type LockMode } from './fileLocks';
import {
  BYTE_ORDER_MARK,
  type FileSystemInfoState,
  FileWriter,
  type ReaderState,
  throwException,
  withFiles,
} from './nativesIo';
import { fullPathOf, pathArgument } from './nativesPath';
import { fail, libraryType, newArray, unsupportedCall } from './support';

/**
 * FileStream and the byte operations of File: a file holds text, which they read and write as its UTF-8 bytes. Bytes
 * that do not decode as UTF-8 have no text to store, so writing them is rejected as unusable, as the grader compares
 * the files a program leaves as text.
 */

const FILE_MODE = { CreateNew: 1, Create: 2, Open: 3, OpenOrCreate: 4, Truncate: 5, Append: 6 } as const;
const FILE_MODE_NAMES = ['', 'CreateNew', 'Create', 'Open', 'OpenOrCreate', 'Truncate', 'Append'];
const FILE_ACCESS = { Read: 1, Write: 2, ReadWrite: 3 } as const;
const FILE_ACCESS_NAMES = ['', 'Read', 'Write', 'ReadWrite'];
const FILE_SHARE_NONE = 0;
const FILE_SHARE_READ = 1;
const FILE_SHARE_INHERITABLE = 16;
/** FileShare's largest value besides Inheritable, ReadWrite | Delete. */
const FILE_SHARE_ALL = 7;
const SEEK_ORIGIN = { Begin: 0, Current: 1, End: 2 } as const;

/** The bytes a FileStream holds before it writes them, as .NET's buffer does. */
const BUFFER_SIZE = 4096;

const INVALID_BYTES = 'UTF-8 として正しくないバイト列のファイルへの書き込み';

const encoder = new TextEncoder();

/** The text of bytes that are UTF-8, keeping a byte order mark as a character, or `undefined` for other bytes. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/** How many bytes at the end begin a character that the bytes do not complete. */
function incompleteTailLength(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return back < needed ? back : 0;
  }
  return 0;
}

/** What the Stream members read and write: a FileStream's file, or the console's input or output. */
export interface StreamState {
  readonly name: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canSeek: boolean;
  isClosed: boolean;
  position: number;
  readonly length: number;
  read(call: NativeCall, count: number): Uint8Array;
  write(call: NativeCall, bytes: readonly number[]): void;
  writeByte(call: NativeCall, byte: number): void;
  flush(call: NativeCall, isClosing: boolean): void;
  seek(call: NativeCall, offset: number, origin: number): number;
  close(call: NativeCall): void;
}

/** An open FileStream, which reads and writes its file's bytes at its position. */
class FileStreamState implements StreamState {
  readonly canSeek = true;
  position = 0;
  isClosed = false;
  /** The bytes written but not yet stored, from a position of the file. */
  private pending: { at: number; bytes: number[] } | undefined;
  /** The file's text and its bytes when last encoded, which reads reuse while the text stays the same. */
  private encoded: { text: string; bytes: Uint8Array } | undefined;

  constructor(
    readonly name: string,
    private readonly handle: FileHandle,
    readonly canRead: boolean,
    readonly canWrite: boolean,
    /** Where a stream opened to append starts, before which it cannot seek. */
    private readonly appendStart: number | undefined,
    private readonly release: () => void
  ) {
    if (appendStart !== undefined) this.position = appendStart;
  }

  storedBytes(): Uint8Array {
    const text = this.handle.text;
    if (this.encoded?.text !== text) this.encoded = { text, bytes: encoder.encode(text) };
    return this.encoded.bytes;
  }

  /** The length, counting the bytes written but not yet stored, as .NET's buffered stream does. */
  get length(): number {
    const stored = this.storedBytes().length;
    return this.pending ? Math.max(stored, this.pending.at + this.pending.bytes.length) : stored;
  }

  read(call: NativeCall, count: number): Uint8Array {
    this.flush(call, false);
    const bytes = this.storedBytes();
    if (this.position >= bytes.length) return new Uint8Array(0);
    const read = bytes.subarray(this.position, Math.min(bytes.length, this.position + count));
    this.position += read.length;
    return read;
  }

  /**
   * Writes bytes as .NET's buffered stream does: they fill the buffer, which is written once full, and what remains
   * is written at once when it would fill the buffer by itself, or else held.
   */
  write(call: NativeCall, bytes: readonly number[]): void {
    const buffer = this.bufferAtPosition(call);
    let rest = bytes;
    if (buffer.length > 0) {
      const room = BUFFER_SIZE - buffer.length;
      buffer.push(...rest.slice(0, room));
      this.position += Math.min(room, rest.length);
      if (room >= rest.length) return;
      rest = rest.slice(room);
      this.flush(call, false);
    }
    // A character that the written buffer began is held still, before the rest.
    this.bufferAtPosition(call).push(...rest);
    this.position += rest.length;
    if (rest.length >= BUFFER_SIZE) this.flush(call, false);
  }

  /** Writes a byte, which .NET's buffered stream adds after writing its buffer once it holds all but one byte. */
  writeByte(call: NativeCall, byte: number): void {
    if (this.bufferAtPosition(call).length >= BUFFER_SIZE - 1) this.flush(call, false);
    this.bufferAtPosition(call).push(byte);
    this.position++;
  }

  /** The bytes held to write at the position, after writing those held for elsewhere. */
  private bufferAtPosition(call: NativeCall): number[] {
    const { pending } = this;
    if (pending && pending.at + pending.bytes.length === this.position) return pending.bytes;
    this.flush(call, false);
    this.pending = { at: this.position, bytes: [] };
    return this.pending.bytes;
  }

  /**
   * Stores the bytes written so far. A character the bytes have only begun waits for the rest while the stream stays
   * open, since a later write may complete it.
   */
  flush(call: NativeCall, isClosing: boolean): void {
    const { pending } = this;
    if (!pending || pending.bytes.length === 0) {
      this.pending = undefined;
      return;
    }
    const stored = this.storedBytes();
    const end = Math.max(stored.length, pending.at + pending.bytes.length);
    const bytes = new Uint8Array(end);
    bytes.set(stored);
    bytes.set(pending.bytes, pending.at);
    const endsWithPending = pending.at + pending.bytes.length === end;
    const kept = isClosing || !endsWithPending ? 0 : Math.min(incompleteTailLength(bytes), pending.bytes.length);
    const text = decodeUtf8(bytes.subarray(0, end - kept));
    if (text === undefined) unsupportedCall(call, INVALID_BYTES);
    this.handle.replace(text);
    this.pending = kept > 0 ? { at: end - kept, bytes: pending.bytes.slice(-kept) } : undefined;
  }

  seek(call: NativeCall, offset: number, origin: number): number {
    this.flush(call, false);
    const base = origin === SEEK_ORIGIN.Begin ? 0 : origin === SEEK_ORIGIN.Current ? this.position : this.length;
    const target = base + offset;
    // Unix's lseek refuses a negative position, which .NET reports with the file's path.
    if (target < 0) throwException(call, 'System.IO.IOException', `Invalid argument : '${this.name}'`);
    if (this.appendStart !== undefined && target < this.appendStart)
      throwException(
        call,
        'System.IO.IOException',
        'Unable seek backward to overwrite data that previously existed in a file opened in Append mode.'
      );
    this.position = target;
    return target;
  }

  close(call: NativeCall): void {
    if (this.isClosed) return;
    this.flush(call, true);
    this.isClosed = true;
    this.release();
  }
}

// ---- Opening ----

function enumName(names: readonly string[], value: number): string {
  return names[value] ?? String(value);
}

/** Opens a FileStream as .NET's constructor does, checking the arguments, then the file's locks, then the file. */
function openStream(call: NativeCall, path: Value, mode: number, access: number, share: number): FileStreamState {
  const target = pathArgument(path);
  const shareWithoutInheritance = share & ~FILE_SHARE_INHERITABLE;
  let badArgument: string | undefined;
  if (mode < FILE_MODE.CreateNew || mode > FILE_MODE.Append) badArgument = 'mode';
  else if (access < FILE_ACCESS.Read || access > FILE_ACCESS.ReadWrite) badArgument = 'access';
  else if (shareWithoutInheritance < 0 || shareWithoutInheritance > FILE_SHARE_ALL) badArgument = 'share';
  if (badArgument) fail('System.ArgumentOutOfRangeException', 'Enum value was out of legal range.', badArgument);
  const canWrite = (access & FILE_ACCESS.Write) !== 0;
  const canRead = (access & FILE_ACCESS.Read) !== 0;
  if (!canWrite && mode !== FILE_MODE.Open && mode !== FILE_MODE.OpenOrCreate)
    fail(
      'System.ArgumentException',
      `Combining FileMode: ${enumName(FILE_MODE_NAMES, mode)} with FileAccess: ${enumName(FILE_ACCESS_NAMES, access)} is invalid.`,
      'access'
    );
  if (canRead && mode === FILE_MODE.Append)
    fail('System.ArgumentException', 'Append access can be requested only in write-only mode.', 'access');
  const lock: LockMode = share === FILE_SHARE_NONE ? 'exclusive' : 'shared';
  // A new file has no lock to check, and CreateNew fails first on a file that exists.
  if (mode !== FILE_MODE.CreateNew) checkLock(call, target, lock);
  const files = call.frame.runtime.io.files;
  const handle = withFiles(call, () => files.open(target, openModeOf(mode)));
  const appendStart = mode === FILE_MODE.Append ? encoder.encode(handle.text).length : undefined;
  return new FileStreamState(fullPathOf(target), handle, canRead, canWrite, appendStart, holdLock(handle.file, lock));
}

function openModeOf(mode: number): OpenMode {
  switch (mode) {
    case FILE_MODE.CreateNew: {
      return { create: 'exclusive', truncate: false, append: false };
    }
    case FILE_MODE.Create: {
      return { create: 'always', truncate: true, append: false };
    }
    case FILE_MODE.Open: {
      return { create: 'never', truncate: false, append: false };
    }
    case FILE_MODE.Truncate: {
      return { create: 'never', truncate: true, append: false };
    }
    default: {
      return { create: 'always', truncate: false, append: false };
    }
  }
}

function newStream(call: NativeCall, state: FileStreamState): CsObject {
  const stream = new CsObject(libraryType(call, 'System.IO.FileStream'), []);
  stream.native = state;
  return stream;
}

/** The access of `File.Open` and the FileStream constructor without one, which only appending limits to writing. */
function defaultAccess(mode: Value): number {
  return mode === FILE_MODE.Append ? FILE_ACCESS.Write : FILE_ACCESS.ReadWrite;
}

/** The opening natives of FileInfo, which open the file by its full path, and of File and FileStream, by a path. */
const openers = {
  open:
    (share: number): NativeMethod =>
    (call, _receiver, [path, mode, access, given]) =>
      newStream(
        call,
        openStream(
          call,
          path as Value,
          mode as number,
          (access as number | undefined) ?? defaultAccess(mode as Value),
          (given as number | undefined) ?? share
        )
      ),
  fixed:
    (mode: number, access: number, share: number): NativeMethod =>
    (call, _receiver, [path]) =>
      newStream(call, openStream(call, path as Value, mode, access, share)),
};

function infoStateOf(receiver: Value): FileSystemInfoState {
  return (receiver as CsObject).native as FileSystemInfoState;
}

/** A FileInfo's opener, which opens its full path and makes the object look at the file again, as .NET does. */
const infoOpener =
  (opener: NativeMethod, invalidates = false): NativeMethod =>
  (call, receiver, args) => {
    const stream = opener(call, undefined, [infoStateOf(receiver).fullPath, ...args]);
    if (invalidates) infoStateOf(receiver).found = 'unread';
    return stream;
  };

defineNatives({
  'System.IO.FileStream..ctor': (call, receiver, [path, mode, access, share]) => {
    (receiver as CsObject).native = openStream(
      call,
      path as Value,
      mode as number,
      (access as number | undefined) ?? defaultAccess(mode as Value),
      (share as number | undefined) ?? FILE_SHARE_READ
    );
  },
  'System.IO.File.Open': openers.open(FILE_SHARE_NONE),
  'System.IO.File.OpenRead': openers.fixed(FILE_MODE.Open, FILE_ACCESS.Read, FILE_SHARE_READ),
  'System.IO.File.OpenWrite': openers.fixed(FILE_MODE.OpenOrCreate, FILE_ACCESS.Write, FILE_SHARE_NONE),
  'System.IO.File.Create': openers.fixed(FILE_MODE.Create, FILE_ACCESS.ReadWrite, FILE_SHARE_NONE),
  'System.IO.FileInfo.Open': infoOpener(openers.open(FILE_SHARE_NONE)),
  'System.IO.FileInfo.OpenRead': infoOpener(openers.fixed(FILE_MODE.Open, FILE_ACCESS.Read, FILE_SHARE_READ)),
  'System.IO.FileInfo.OpenWrite': infoOpener(openers.fixed(FILE_MODE.OpenOrCreate, FILE_ACCESS.Write, FILE_SHARE_NONE)),
  'System.IO.FileInfo.Create': infoOpener(
    openers.fixed(FILE_MODE.Create, FILE_ACCESS.ReadWrite, FILE_SHARE_NONE),
    true
  ),
});

// ---- Stream members ----

/** The stream of a receiver, failing with .NET's message for the member when it is closed. */
function openStateOf(call: NativeCall, receiver: Value, closedMessage = 'Cannot access a closed file.'): StreamState {
  const state = (receiver as CsObject).native as StreamState;
  if (state.isClosed) throwException(call, 'System.ObjectDisposedException', closedMessage);
  return state;
}

const CLOSED_STREAM = 'Cannot access a closed Stream.';

function checkCanRead(state: StreamState): void {
  if (!state.canRead) fail('System.NotSupportedException', 'Stream does not support reading.');
}

function checkCanWrite(state: StreamState): void {
  if (!state.canWrite) fail('System.NotSupportedException', 'Stream does not support writing.');
}

/** Checks the buffer, offset, and count of Read and Write, as Stream.ValidateBufferArguments does. */
function bufferArguments(buffer: Value, offset: number, count: number): CsArray {
  if (buffer === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'buffer');
  if (offset < 0) fail('System.ArgumentOutOfRangeException', 'Non-negative number required.', 'offset');
  const array = buffer as CsArray;
  if (count < 0 || count > array.values.length - offset)
    fail(
      'System.ArgumentOutOfRangeException',
      'Offset and length were out of bounds for the array or count is greater than the number of elements from index to the end of the source collection.',
      'count'
    );
  return array;
}

const closing: NativeMethod = (call, receiver) => {
  ((receiver as CsObject).native as StreamState).close(call);
};

defineNatives({
  'System.IO.Stream.get_CanRead': (_call, receiver) => {
    const state = (receiver as CsObject).native as StreamState;
    return !state.isClosed && state.canRead;
  },
  'System.IO.Stream.get_CanWrite': (_call, receiver) => {
    const state = (receiver as CsObject).native as StreamState;
    return !state.isClosed && state.canWrite;
  },
  'System.IO.Stream.get_CanSeek': (_call, receiver) => {
    const state = (receiver as CsObject).native as StreamState;
    return !state.isClosed && state.canSeek;
  },
  'System.IO.Stream.get_Length': (call, receiver) => BigInt(openStateOf(call, receiver).length),
  'System.IO.Stream.get_Position': (call, receiver) => BigInt(openStateOf(call, receiver).position),
  'System.IO.Stream.set_Position': (call, receiver, [value]) => {
    const position = Number(value as bigint);
    if (position < 0) fail('System.ArgumentOutOfRangeException', 'Non-negative number required.', 'value');
    openStateOf(call, receiver).seek(call, position, SEEK_ORIGIN.Begin);
  },
  'System.IO.Stream.ReadByte': (call, receiver) => {
    const state = openStateOf(call, receiver, CLOSED_STREAM);
    checkCanRead(state);
    const [byte] = state.read(call, 1);
    return byte ?? -1;
  },
  'System.IO.Stream.WriteByte': (call, receiver, [value]) => {
    const state = openStateOf(call, receiver, CLOSED_STREAM);
    checkCanWrite(state);
    state.writeByte(call, value as number);
  },
  'System.IO.Stream.Read': (call, receiver, [buffer, offset, count]) => {
    const array = bufferArguments(buffer as Value, offset as number, count as number);
    const state = openStateOf(call, receiver);
    checkCanRead(state);
    const bytes = state.read(call, count as number);
    for (const [index, byte] of bytes.entries()) array.values[(offset as number) + index] = byte;
    return bytes.length;
  },
  'System.IO.Stream.Write': (call, receiver, [buffer, offset, count]) => {
    const array = bufferArguments(buffer as Value, offset as number, count as number);
    const state = openStateOf(call, receiver);
    checkCanWrite(state);
    state.write(call, array.values.slice(offset as number, (offset as number) + (count as number)) as number[]);
  },
  'System.IO.Stream.Seek': (call, receiver, [offset, origin]) => {
    const from = origin as number;
    if (from < SEEK_ORIGIN.Begin || from > SEEK_ORIGIN.End)
      fail('System.ArgumentException', 'Invalid seek origin.', 'origin');
    return BigInt(openStateOf(call, receiver).seek(call, Number(offset as bigint), from));
  },
  'System.IO.Stream.Flush': (call, receiver) => {
    openStateOf(call, receiver).flush(call, false);
  },
  'System.IO.Stream.Close': closing,
  'System.IO.Stream.Dispose': closing,
  'System.IO.FileStream.get_Name': (_call, receiver) => ((receiver as CsObject).native as FileStreamState).name,
});

// ---- Readers and writers on streams ----

function streamArgument(stream: Value): StreamState {
  if (stream === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'stream');
  return (stream as CsObject).native as StreamState;
}

/** A StreamWriter on a stream, which closes the stream when it is closed, as .NET's does by default. */
const streamWriter: NativeMethod = (call, receiver, args) => {
  const state = streamArgument(args[0] as Value);
  const encoding = args[1] as Value;
  if (state.isClosed || !state.canWrite) fail('System.ArgumentException', 'Stream was not writable.');
  const sink = {
    write: (text: string, writeCall: NativeCall) => {
      state.write(writeCall, [...encoder.encode(text)]);
    },
    flush: (flushCall: NativeCall) => {
      state.flush(flushCall, false);
    },
  };
  // .NET's StreamWriter writes the byte order mark at a seekable stream's start, and always to another stream.
  const writer = new FileWriter(sink, false, encoding !== undefined && (!state.canSeek || state.position === 0));
  writer.onClose = (closeCall) => {
    state.close(closeCall);
  };
  (receiver as CsObject).native = writer;
};

/**
 * A StreamReader on a stream, which reads the rest of the stream when it needs more text, skips a byte order mark at
 * the start of what it reads, and closes the stream when it is closed.
 */
const streamReader: NativeMethod = (call, receiver, args) => {
  const state = streamArgument(args[0] as Value);
  if (state.isClosed || !state.canRead) fail('System.ArgumentException', 'Stream was not readable.');
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let text: string | undefined;
  const refill = (): boolean => {
    const bytes = state.isClosed ? new Uint8Array(0) : state.read(call, Number.MAX_SAFE_INTEGER);
    if (bytes.length === 0) return false;
    const chunk = decoder.decode(bytes, { stream: true });
    text = text === undefined && chunk.startsWith(BYTE_ORDER_MARK) ? chunk.slice(1) : (text ?? '') + chunk;
    return true;
  };
  const reader = call.frame.runtime.io.partReader(() => text ?? '', refill);
  (receiver as CsObject).native = {
    name: 'StreamReader',
    reader,
    isClosed: false,
    onClose: (closeCall) => {
      state.close(closeCall);
    },
  } satisfies ReaderState;
};

defineNatives({
  'System.IO.StreamWriter..ctor(Stream)': streamWriter,
  'System.IO.StreamWriter..ctor(Stream, Encoding?)': streamWriter,
  'System.IO.StreamReader..ctor(Stream)': streamReader,
  'System.IO.StreamReader..ctor(Stream, Encoding?)': streamReader,
});

// ---- File's bytes ----

function bytesArgument(bytes: Value): CsArray {
  if (bytes === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'bytes');
  return bytes as CsArray;
}

function writeBytes(call: NativeCall, path: Value, bytes: Value, append: boolean): void {
  const target = pathArgument(path);
  const array = bytesArgument(bytes);
  const text = decodeUtf8(Uint8Array.from(array.values as number[]));
  if (text === undefined) unsupportedCall(call, INVALID_BYTES);
  checkLock(call, target, 'shared');
  const files = call.frame.runtime.io.files;
  withFiles(call, () => files.open(target, { create: 'always', truncate: !append, append }).write(text));
}

defineNatives({
  'System.IO.File.ReadAllBytes': (call, _receiver, [path]) => {
    const target = pathArgument(path as Value);
    checkLock(call, target, 'shared');
    const files = call.frame.runtime.io.files;
    const bytes = encoder.encode(withFiles(call, () => files.readFile(target)));
    return newArray(call, libraryType(call, 'System.Byte'), [...bytes]);
  },
  'System.IO.File.WriteAllBytes': (call, _receiver, [path, bytes]) => {
    writeBytes(call, path as Value, bytes as Value, false);
  },
  'System.IO.File.AppendAllBytes': (call, _receiver, [path, bytes]) => {
    writeBytes(call, path as Value, bytes as Value, true);
  },
});
