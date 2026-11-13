import {
  type FileHandle,
  FileSystemError,
  type FileSystemErrorCode,
  type OpenMode,
  type TextReader,
} from '../interpreter/programIo';
import type { Collections } from './builtinCollections';
import { standardChannelOf } from './builtins';
import { defineInterface, type Registry } from './builtinSupport';
import { encodable, type Frame, throwBuiltin } from './runtime';
import { type ClassInfo, type ClassType, type JavaType, type MethodInfo } from './types';
import { type JavaObject, JavaString, type Value } from './values';

/** What the I/O classes share as they are defined. */
export interface IOContext {
  registry: Registry;
  objectClass: ClassInfo;
  stringType: JavaType;
  collections: Collections;
  /** `Stream` and the class of the streams it returns. */
  stream: ClassInfo;
  streamImpl: ClassInfo;
  /** `IOException`, which most of their methods declare. */
  ioException: ClassInfo;
  systemIn: JavaObject;
  systemOut: JavaObject;
  systemErr: JavaObject;
}

export function classOf(context: IOContext, name: string): ClassInfo {
  return context.registry.classes.get(name) as ClassInfo;
}

export function classType(cls: ClassInfo, ...args: JavaType[]): ClassType {
  return { kind: 'class', cls, args };
}

/** Declares that a method throws `IOException`, which callers must catch or declare. */
export function throwsIO(context: IOContext, method: MethodInfo): MethodInfo {
  method.thrownTypes = [context.ioException];
  return method;
}

export function defineIOInterface(
  context: IOContext,
  name: string,
  packageName: string,
  parent?: ClassInfo
): ClassInfo {
  const cls = defineInterface(context.registry, name, packageName);
  if (parent) {
    cls.interfaces.push(parent);
    cls.supertypes.push(parent.type as ClassType);
  }
  return cls;
}

/** The paths that `File` objects hold, as `getPath` returns them. */
export const filePaths = new WeakMap<JavaObject, string>();

/** The path of a file given by its name or as a `File`. */
export function filePathOf(frame: Frame, value: Value): string {
  if (value === undefined) return throwBuiltin(frame, 'NullPointerException');
  if (value instanceof JavaString) return value.value;
  return filePaths.get(value as JavaObject) as string;
}

/** The paths that `Path` objects hold, as `toString` returns them. */
export const pathTexts = new WeakMap<JavaObject, string>();

export function pathTextOf(frame: Frame, value: Value): string {
  if (value === undefined) return throwBuiltin(frame, 'NullPointerException');
  return pathTexts.get(value as JavaObject) as string;
}

/** What a reader, an input stream, or a scanner reads. */
export interface ReadSource {
  /** The text being read, which throws `IOException` once the source is closed. */
  reader(frame: Frame): TextReader;
  /** Whether a read would not block, which `Reader.ready` tells. */
  isReady(frame: Frame): boolean;
  /** Whether the source is standard input, which a console delivers a line at a time. */
  readonly isConsole?: boolean;
  close(frame: Frame): void;
}

/** The sources of builtin readers and of `System.in`. */
export const readSources = new WeakMap<JavaObject, ReadSource>();

export function readSourceOf(frame: Frame, value: Value): ReadSource {
  if (value === undefined) return throwBuiltin(frame, 'NullPointerException');
  return readSources.get(value as JavaObject) as ReadSource;
}

/** Reads a text, such as a string or an open file's contents as they are when read, until it is closed. */
export class TextSource implements ReadSource {
  private isClosed = false;

  /**
   * @param isAlwaysReady Whether the source is ready even at its end, as a `StringReader` is, unlike a file, which is
   * ready while bytes remain to read.
   */
  constructor(
    private readonly text: TextReader,
    private readonly isAlwaysReady = false
  ) {}

  isReady(frame: Frame): boolean {
    const text = this.reader(frame);
    return this.isAlwaysReady || !text.isAtEnd;
  }

  reader(frame: Frame): TextReader {
    if (this.isClosed) throwBuiltin(frame, 'IOException', 'Stream closed');
    return this.text;
  }

  close(): void {
    this.isClosed = true;
  }
}

/**
 * A reader's buffer, which reads ahead from its source when it first needs text and whenever it has read all it
 * holds, as `BufferedReader` and the decoder of `InputStreamReader` do: a chunk of `chunkSize` chars at a time, or a
 * line at a time from standard input, as from a console where each line arrives when it is entered. What it has read
 * ahead is its own, so that another reader of the source does not read it and a later write to a file does not change
 * it.
 */
export class ReadAheadSource implements ReadSource {
  private readonly text: TextReader;
  private isClosed = false;
  private buffered = '';

  readonly isConsole: boolean;

  constructor(
    frame: Frame,
    private readonly inner: ReadSource,
    private readonly chunkSize = BUFFER_SIZE
  ) {
    this.isConsole = inner.isConsole === true;
    this.text = frame.runtime.io.partReader(
      () => this.buffered,
      () => this.readMore(frame)
    );
  }

  reader(frame: Frame): TextReader {
    if (this.isClosed) throwBuiltin(frame, 'IOException', 'Stream closed');
    return this.text;
  }

  isReady(frame: Frame): boolean {
    const { position } = this.reader(frame);
    return position < this.buffered.length || this.inner.isReady(frame);
  }

  close(frame: Frame): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.inner.close(frame);
  }

  /** Reads the next part of the source into the buffer, keeping what remains unread, telling whether any came. */
  readMore(frame: Frame): boolean {
    const source = this.inner.reader(frame);
    if (source.isAtEnd) return false;
    const { text, position } = source;
    // A read takes what fits in the buffer, and from a console no more than the line entered.
    let end = Math.min(position + this.chunkSize, text.length);
    if (this.isConsole) {
      const terminator = /\r\n|[\n\r]/g;
      terminator.lastIndex = position;
      if (terminator.test(text)) end = Math.min(end, terminator.lastIndex);
    }
    source.position = end;
    const part = text.slice(position, end);
    // Read text no reader will read again is dropped, keeping the buffer within one string.
    const kept = this.buffered.slice(this.text.position);
    frame.runtime.allocateString(frame, kept.length + part.length, part.length);
    this.buffered = `${kept}${part}`;
    this.text.position = 0;
    return true;
  }
}

/** Standard input, which every reader of `System.in` shares, so that closing one closes it for all. */
export const STANDARD_INPUT: ReadSource = {
  reader: (frame) => {
    const { stdin } = frame.runtime.io;
    if (stdin.isClosed) throwBuiltin(frame, 'IOException', 'Stream closed');
    return stdin.reader;
  },
  // A console has the rest of the line entered ready, but the next line only once the program waits for it.
  isReady: (frame) => {
    const { text, position } = STANDARD_INPUT.reader(frame);
    return position > 0 && position < text.length && !/[\n\r]/.test(text[position - 1]);
  },
  close: (frame) => {
    frame.runtime.io.stdin.isClosed = true;
  },
  isConsole: true,
};

/** Which `write` overload wrote a text: one taking a string, an array of chars, or one char. */
export type WriteKind = 'string' | 'chars' | 'char';

/** Where a writer or an output stream sends what it writes. */
export interface Sink {
  write(frame: Frame, text: string, kind?: WriteKind): void;
  flush(frame: Frame): void;
  close(frame: Frame): void;
}

/** The sinks of builtin writers. */
export const writeSinks = new WeakMap<JavaObject, Sink>();

export function sinkOf(frame: Frame, value: Value): Sink {
  if (value === undefined) return throwBuiltin(frame, 'NullPointerException');
  return writeSinks.get(value as JavaObject) as Sink;
}

/**
 * The size of the buffers of `BufferedWriter` and of the encoder of `OutputStreamWriter`, whose text reaches its
 * destination only when they pass it on, flush, or close, so a program that never closes its writer loses its
 * output, as in Java.
 */
export const BUFFER_SIZE = 8192;

/**
 * A writer's stage, which passes on what is written until it is closed. The buffered stages port OpenJDK's
 * algorithms, so that their text reaches the next stage when Java's does.
 */
export class DirectSink implements Sink {
  protected pending = '';
  private isClosed = false;

  constructor(protected readonly target: Sink) {}

  write(frame: Frame, text: string, kind: WriteKind = 'string'): void {
    this.ensureOpen(frame);
    this.target.write(frame, text, kind);
  }

  flush(frame: Frame): void {
    this.ensureOpen(frame);
    this.passOn(frame);
    this.target.flush(frame);
  }

  close(frame: Frame): void {
    if (this.isClosed) return;
    try {
      this.passOn(frame);
    } finally {
      this.isClosed = true;
      this.target.close(frame);
    }
  }

  protected ensureOpen(frame: Frame): void {
    if (this.isClosed) throwBuiltin(frame, 'IOException', 'Stream closed');
  }

  /** Adds text to the buffer, which is a string the run builds, whatever capacity the program chose. */
  protected buffer(frame: Frame, text: string): void {
    frame.runtime.allocateString(frame, this.pending.length + text.length, text.length);
    this.pending += text;
  }

  protected passOn(frame: Frame): void {
    if (this.pending === '') return;
    const text = this.pending;
    this.pending = '';
    this.target.write(frame, text, 'chars');
  }
}

/** OpenJDK's `BufferedWriter`, whose `write` overloads fill its buffer of `capacity` chars by different rules. */
export class BufferedWriterSink extends DirectSink {
  constructor(
    target: Sink,
    private readonly capacity: number
  ) {
    super(target);
  }

  override write(frame: Frame, text: string, kind: WriteKind = 'string'): void {
    this.ensureOpen(frame);
    if (kind === 'char') {
      if (this.pending.length >= this.capacity) this.passOn(frame);
      this.buffer(frame, text);
      return;
    }
    // An array as large as the buffer bypasses it.
    if (kind === 'chars' && text.length >= this.capacity) {
      this.passOn(frame);
      this.target.write(frame, text, 'chars');
      return;
    }
    for (let offset = 0; offset < text.length;) {
      const end = offset + this.capacity - this.pending.length;
      this.buffer(frame, text.slice(offset, end));
      offset = end;
      if (this.pending.length >= this.capacity) this.passOn(frame);
    }
  }
}

/**
 * OpenJDK's `StreamEncoder`, which an `OutputStreamWriter` writes through, whose byte buffer passes on its bytes only
 * when it overflows. The buffer starts at 512 bytes and grows, after passing on what it holds, when one write may
 * encode to more, up to 8192: three bytes per char in UTF-8. These count chars, equal to the bytes of ASCII text,
 * since files hold text.
 */
export class EncoderSink extends DirectSink {
  private capacity = 512;

  override write(frame: Frame, text: string): void {
    this.ensureOpen(frame);
    const wanted = Math.min(text.length * 3, BUFFER_SIZE);
    if (wanted > this.capacity) {
      this.passOn(frame);
      this.capacity = wanted;
    }
    for (let offset = 0; offset < text.length;) {
      if (this.pending.length >= this.capacity) this.passOn(frame);
      const end = offset + this.capacity - this.pending.length;
      this.buffer(frame, text.slice(offset, end));
      offset = end;
    }
  }
}

/** The stages of a writer that `BufferedWriter`, `PrintWriter`, or `Files` builds over an output stream. */
export function bufferedEncoderSink(target: Sink): Sink {
  return new BufferedWriterSink(new EncoderSink(target), BUFFER_SIZE);
}

export function fileSink(handle: FileHandle): Sink {
  return {
    write: (_, text) => handle.write(encodable(text)),
    flush: () => {},
    close: () => {},
  };
}

/** Writes to `System.out` or `System.err`, which closing the sink closes as well. */
export function standardSink(stream: Value): Sink {
  return {
    write: (frame, text) => standardChannelOf(frame, stream).write(encodable(text)),
    flush: () => {},
    close: (frame) => {
      standardChannelOf(frame, stream).isClosed = true;
    },
  };
}

/** The reasons that `java.io` classes give after the path when they fail to open a file. */
const REASONS: Record<FileSystemErrorCode, string> = {
  ENOENT: 'No such file or directory',
  EEXIST: 'File exists',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  ENOTEMPTY: 'Directory not empty',
  EINVAL: 'Invalid argument',
};

/** Opens a file to read as `FileInputStream` does, which throws `FileNotFoundException` when it cannot. */
export function openFileReader(frame: Frame, path: string): TextReader {
  return withFileNotFound(frame, path, () => frame.runtime.io.openReader(path));
}

/** Opens a file to write as `FileOutputStream` does, which throws `FileNotFoundException` when it cannot. */
export function openFileWriter(frame: Frame, path: string, append: boolean): FileHandle {
  return withFileNotFound(frame, path, () =>
    frame.runtime.io.files.open(path, { create: 'always', truncate: !append, append })
  );
}

function withFileNotFound<T>(frame: Frame, path: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    return throwBuiltin(frame, 'FileNotFoundException', `${path} (${REASONS[error.code]})`);
  }
}

/** Runs a file system call, throwing the exception `java.nio.file.Files` throws for its failure. */
export function withNioErrors<T>(frame: Frame, path: string, run: () => T, other?: string): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    const files = other === undefined ? path : `${path} -> ${other}`;
    switch (error.code) {
      case 'ENOENT': {
        return throwBuiltin(frame, 'NoSuchFileException', files);
      }
      case 'EEXIST': {
        return throwBuiltin(frame, 'FileAlreadyExistsException', other ?? path);
      }
      case 'ENOTEMPTY': {
        return throwBuiltin(frame, 'DirectoryNotEmptyException', other ?? path);
      }
      default: {
        return throwBuiltin(frame, 'FileSystemException', `${files}: ${REASONS[error.code]}`);
      }
    }
  }
}

/** How `Files` opens a file to write with the options it is given, or with none. */
export function openModeOf(frame: Frame, options: readonly string[]): OpenMode {
  if (options.length === 0) return { create: 'always', truncate: true, append: false };
  const has = (name: string): boolean => options.includes(name);
  if (has('READ')) throwBuiltin(frame, 'IllegalArgumentException', 'READ not allowed');
  const append = has('APPEND');
  if (append && has('TRUNCATE_EXISTING')) {
    throwBuiltin(frame, 'IllegalArgumentException', 'APPEND + TRUNCATE_EXISTING not allowed');
  }
  const create = has('CREATE_NEW') ? 'exclusive' : has('CREATE') ? 'always' : 'never';
  return { create, truncate: has('TRUNCATE_EXISTING'), append };
}

/** The number of bytes that a text takes in UTF-8, in which files hold it. */
export function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    length += code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
  }
  return length;
}

/**
 * A path as `java.io.File` and `java.nio.file.Path` keep it, without repeated or trailing slashes, which the program
 * reads back from `getPath` and `toString`.
 */
export function normalizeSlashes(path: string): string {
  const collapsed = path.replaceAll(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

/** The last name of a path, or the whole path when it has one name. */
export function lastNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The path without its last name, or `undefined` for a path of one name or the root. */
export function parentPathOf(path: string): string | undefined {
  const index = path.lastIndexOf('/');
  if (index === -1 || path === '/') return undefined;
  return index === 0 ? '/' : path.slice(0, index);
}

/** The absolute path that `getAbsolutePath` and `toAbsolutePath` return, which they do not normalize. */
export function absolutePathOf(path: string): string {
  if (path.startsWith('/')) return path;
  return path === '' ? '/' : `/${path}`;
}
