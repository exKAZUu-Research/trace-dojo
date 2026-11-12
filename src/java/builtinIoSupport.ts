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

/** Standard input, which every reader of `System.in` shares, so that closing one closes it for all. */
export const STANDARD_INPUT: ReadSource = {
  reader: (frame) => {
    const { stdin } = frame.runtime.io;
    if (stdin.isClosed) throwBuiltin(frame, 'IOException', 'Stream closed');
    return stdin.reader;
  },
  isReady: (frame) => !STANDARD_INPUT.reader(frame).isAtEnd,
  close: (frame) => {
    frame.runtime.io.stdin.isClosed = true;
  },
};

/** Where a writer or an output stream sends what it writes. */
export interface Sink {
  write(frame: Frame, text: string): void;
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
 * The size of the buffers of `BufferedWriter` and of the encoder of `OutputStreamWriter`. Their text reaches its
 * destination only when they fill up, flush, or close, so a program that never closes its writer loses its output,
 * as in Java. The encoder's buffer counts bytes, which these buffers count as characters, alike for ASCII text.
 */
export const BUFFER_SIZE = 8192;

/** Holds what is written in a buffer of `capacity` characters until it fills or is flushed; a capacity of 0 holds nothing. */
export class BufferedSink implements Sink {
  private pending = '';
  private isClosed = false;

  constructor(
    private readonly target: Sink,
    private readonly capacity: number
  ) {}

  /** Fills the buffer, passing on each full buffer and keeping the rest, as `BufferedWriter.write(String)` does. */
  write(frame: Frame, text: string): void {
    this.ensureOpen(frame);
    if (this.capacity === 0) {
      this.target.write(frame, text);
      return;
    }
    // The buffered text is a string the run builds, whatever capacity the program chose.
    frame.runtime.allocateString(frame, Math.min(this.pending.length + text.length, this.capacity), text.length);
    for (let offset = 0; offset < text.length;) {
      const end = offset + this.capacity - this.pending.length;
      this.pending += text.slice(offset, end);
      offset = end;
      if (this.pending.length >= this.capacity) this.drain(frame);
    }
  }

  flush(frame: Frame): void {
    this.ensureOpen(frame);
    this.drain(frame);
    this.target.flush(frame);
  }

  close(frame: Frame): void {
    if (this.isClosed) return;
    try {
      this.drain(frame);
    } finally {
      this.isClosed = true;
      this.target.close(frame);
    }
  }

  private ensureOpen(frame: Frame): void {
    if (this.isClosed) throwBuiltin(frame, 'IOException', 'Stream closed');
  }

  private drain(frame: Frame): void {
    if (this.pending === '') return;
    const text = this.pending;
    this.pending = '';
    this.target.write(frame, text);
  }
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
