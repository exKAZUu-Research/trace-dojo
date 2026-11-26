import { FileSystemError, type OutputChannel, resolvePath, type TextReader } from '../../interpreter/programIo';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { exceptionText } from '../objects';
import { CsThrow, type ExceptionState } from '../runtime';
import { CsObject, isString, type Value } from '../values';
import { type ConsoleRedirection, forwardTo, redirectionOf } from './consoleRedirection';
import { checkLock, holdLock } from './fileLocks';
import { iterate } from './iteration';
import { writeText } from './nativesCore';
import { fullPathOf, pathArgument, valueText } from './nativesPath';
import { evaluatorOf, fail, failNull, libraryType, newArray } from './support';

/** Where a TextWriter's text goes: the console, a file, a stream, or a string. */
interface WriterState {
  /** The writer's type name, which an ObjectDisposedException names. */
  readonly name: string;
  isClosed: boolean;
  write(text: string, call: NativeCall): void;
  flush(call: NativeCall): void;
  /** Releases what the writer holds open, once it is closed. */
  onClose?: (call: NativeCall) => void;
}

/** What a TextReader reads: standard input, a file, a stream, or a string. */
export interface ReaderState {
  readonly name: string;
  readonly reader: TextReader;
  isClosed: boolean;
  onClose?: (call: NativeCall) => void;
}

/** Where a StreamWriter's encoded text goes: a file's text, or the bytes of a stream. */
export interface TextSink {
  write(text: string, call: NativeCall): void;
  flush?(call: NativeCall): void;
}

class ConsoleWriter implements WriterState {
  readonly name = 'TextWriter';
  isClosed = false;

  constructor(private readonly channel: OutputChannel) {}

  write(text: string): void {
    this.channel.write(text);
  }

  flush(): void {}
}

class StringWriterState implements WriterState {
  readonly name = 'StringWriter';
  isClosed = false;
  text = '';

  write(text: string): void {
    this.text += text;
  }

  flush(): void {}
}

/** The characters a StreamWriter holds before it encodes them, and the bytes its FileStream holds before it writes. */
const CHAR_BUFFER_SIZE = 1024;
const BYTE_BUFFER_SIZE = 4096;

/**
 * A StreamWriter on a file. .NET's StreamWriter holds 1024 characters and hands them to its FileStream, which writes
 * once it would hold more than 4096 bytes, so what the file shows before `Flush` or `Dispose` follows those sizes,
 * and what a program never flushes is lost when it ends.
 */
export class FileWriter implements WriterState {
  readonly name = 'StreamWriter';
  isClosed = false;
  autoFlush = false;
  onClose?: (call: NativeCall) => void;
  private chars = '';
  private pending = '';
  private pendingBytes = 0;

  /**
   * @param ownsBuffer Whether the writer holds the bytes its FileStream would, for a file it opened by its path; a
   * stream given to it holds its bytes itself.
   * @param preamble Whether the text starts with a byte order mark, as Encoding.UTF8 writes one at the stream's start.
   */
  constructor(
    private readonly sink: TextSink,
    private readonly ownsBuffer: boolean,
    preamble: boolean
  ) {
    // The mark goes out with the first flush, even of no text, as .NET writes it.
    if (preamble) this.pending = BYTE_ORDER_MARK;
    this.pendingBytes = this.pending === '' ? 0 : 3;
  }

  write(text: string, call: NativeCall): void {
    let rest = text;
    while (rest.length > 0) {
      // The buffer is encoded when it is full and more characters come, as StreamWriter.Write does it.
      if (this.chars.length === CHAR_BUFFER_SIZE) this.encodeChars(call);
      const taken = rest.slice(0, CHAR_BUFFER_SIZE - this.chars.length);
      this.chars += taken;
      rest = rest.slice(taken.length);
    }
    if (this.autoFlush) this.flush(call);
  }

  flush(call: NativeCall): void {
    this.encodeChars(call);
    this.writePending(call);
    this.sink.flush?.(call);
  }

  private encodeChars(call: NativeCall): void {
    if (this.chars === '') return;
    let chunk = this.chars;
    // The encoder keeps a high surrogate at the end for the low one that follows.
    const keepsSurrogate = /[\uD800-\uDBFF]$/u.test(chunk);
    if (keepsSurrogate) chunk = chunk.slice(0, -1);
    this.chars = keepsSurrogate ? this.chars.slice(-1) : '';
    const bytes = utf8Length(chunk);
    if (!this.ownsBuffer || this.pendingBytes + bytes > BYTE_BUFFER_SIZE) this.writePending(call);
    if (!this.ownsBuffer || bytes >= BYTE_BUFFER_SIZE) this.sink.write(chunk, call);
    else {
      this.pending += chunk;
      this.pendingBytes += bytes;
    }
  }

  private writePending(call: NativeCall): void {
    if (this.pending === '') return;
    this.sink.write(this.pending, call);
    this.pending = '';
    this.pendingBytes = 0;
  }
}

/** U+FEFF, whose UTF-8 bytes at a file's start mark it as UTF-8 and which .NET's readers skip there. */
export const BYTE_ORDER_MARK = '\uFEFF';

export function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    length += code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
  }
  return length;
}

// ---- Errors ----

export function throwException(call: NativeCall, fullName: string, message: string, fileName?: string): never {
  const exception = call.frame.runtime.createException(fullName, message);
  if (fileName !== undefined) (exception.native as ExceptionState).fileName = fileName;
  throw new CsThrow(exception);
}

/** Throws the .NET exception of a failed file system operation, with the full path .NET's messages show. */
export function failFileSystem(call: NativeCall, error: unknown, target: 'file' | 'directory' = 'file'): never {
  if (!(error instanceof FileSystemError)) throw error;
  const full = resolvePath(error.path);
  const files = call.frame.runtime.io.files;
  switch (error.code) {
    case 'ENOENT': {
      if (target === 'file' && files.kindOf(resolvePath(`${full}/..`)) === 'directory')
        throwException(call, 'System.IO.FileNotFoundException', `Could not find file '${full}'.`, full);
      return throwException(
        call,
        'System.IO.DirectoryNotFoundException',
        `Could not find a part of the path '${full}'.`
      );
    }
    case 'ENOTDIR': {
      return throwException(
        call,
        'System.IO.DirectoryNotFoundException',
        `Could not find a part of the path '${full}'.`
      );
    }
    case 'EISDIR': {
      return throwException(call, 'System.UnauthorizedAccessException', `Access to the path '${full}' is denied.`);
    }
    case 'EEXIST': {
      return throwException(call, 'System.IO.IOException', `The file '${full}' already exists.`);
    }
    case 'ENOTEMPTY': {
      return throwException(call, 'System.IO.IOException', `Directory not empty : '${full}'`);
    }
    case 'EINVAL': {
      return throwException(call, 'System.IO.IOException', `Invalid argument : '${full}'`);
    }
  }
}

export function withFiles<T>(call: NativeCall, run: () => T, target: 'file' | 'directory' = 'file'): T {
  try {
    return run();
  } catch (error) {
    return failFileSystem(call, error, target);
  }
}

// ---- Writers and readers ----

function writerOf(call: NativeCall, receiver: Value): WriterState {
  const state = (receiver as CsObject).native as WriterState;
  if (state.isClosed)
    throwException(
      call,
      'System.ObjectDisposedException',
      `Cannot write to a closed TextWriter.\nObject name: '${state.name}'.`
    );
  return state;
}

function readerOf(call: NativeCall, receiver: Value): ReaderState {
  const state = (receiver as CsObject).native as ReaderState;
  if (state.isClosed)
    throwException(
      call,
      'System.ObjectDisposedException',
      `Cannot read from a closed TextReader.\nObject name: '${state.name}'.`
    );
  return state;
}

const close: NativeMethod = (call, receiver) => {
  const state = (receiver as CsObject).native as WriterState | ReaderState;
  if (state.isClosed) return;
  if ('flush' in state) state.flush(call);
  // The console's writers and reader stay open, as .NET's do.
  if (state instanceof ConsoleWriter || state.name === 'TextReader') return;
  state.isClosed = true;
  state.onClose?.(call);
};

const writing =
  (newline: boolean): NativeMethod =>
  (call, receiver, args) => {
    const writer = writerOf(call, receiver);
    writer.write(writeText(call, args as Value[]) + (newline ? '\n' : ''), call);
  };

export function newWriter(call: NativeCall, typeName: string, state: WriterState): CsObject {
  const writer = new CsObject(libraryType(call, typeName), []);
  writer.native = state;
  return writer;
}

/**
 * A StreamWriter on a file it opens by its path, sharing the file with readers and writers that share it too, and
 * starting with a byte order mark when `encoding` is given (the library's one Encoding, UTF-8) and the file is empty.
 */
export function openFileWriter(call: NativeCall, path: string, append: boolean, encoding?: Value): FileWriter {
  const files = call.frame.runtime.io.files;
  checkLock(call, path, 'shared');
  const handle = withFiles(call, () => files.open(path, { create: 'always', truncate: !append, append }));
  const writer = new FileWriter(handle, true, encoding !== undefined && handle.text === '');
  writer.onClose = holdLock(handle.file, 'shared');
  return writer;
}

/** A StreamReader on a file it opens by its path, which skips a byte order mark at the file's start. */
export function openFileReader(call: NativeCall, path: string): ReaderState {
  const io = call.frame.runtime.io;
  checkLock(call, path, 'shared');
  const reader = withFiles(call, () => io.openReader(path));
  if (reader.position === 0 && reader.text.startsWith(BYTE_ORDER_MARK)) reader.position = 1;
  const file = io.files.fileOf(path);
  return { name: 'StreamReader', reader, isClosed: false, onClose: file && holdLock(file, 'shared') };
}

export function newReader(call: NativeCall, typeName: string, state: ReaderState): CsObject {
  const reader = new CsObject(libraryType(call, typeName), []);
  reader.native = state;
  return reader;
}

const consoleWriters = new WeakMap<object, Record<string, CsObject>>();

/** `Console.Out`, `Console.Error`, and `Console.In`, one object each per run. */
function consoleObject(call: NativeCall, which: 'stdout' | 'stderr' | 'stdin'): CsObject {
  const runtime = call.frame.runtime;
  let objects = consoleWriters.get(runtime);
  if (!objects) {
    objects = {};
    consoleWriters.set(runtime, objects);
  }
  objects[which] ??=
    which === 'stdin'
      ? newReader(call, 'System.IO.TextReader', {
          name: 'TextReader',
          reader: runtime.io.stdin.reader,
          isClosed: false,
        })
      : newWriter(call, 'System.IO.TextWriter', new ConsoleWriter(runtime.io[which]));
  return objects[which];
}

/** `Console.SetOut`, `SetError`, or `SetIn`, after which Console's members use the given writer or reader. */
const redirect =
  (which: keyof ConsoleRedirection, paramName: string): NativeMethod =>
  (call, _receiver, [target]) => {
    if (target === undefined) failNull(paramName);
    redirectionOf(call)[which] = target as CsObject;
    return;
  };

function readLineOf(reader: TextReader): string | undefined {
  return reader.readLine();
}

function readCharOf(reader: TextReader): number {
  const char = reader.read();
  return char === undefined ? -1 : (char.codePointAt(0) as number);
}

function peekCharOf(reader: TextReader): number {
  // Peek returns a UTF-16 code unit, as a .NET char is one.
  // oxlint-disable-next-line unicorn/prefer-code-point
  return reader.isAtEnd ? -1 : reader.text.charCodeAt(reader.position);
}

/** The lines of a text as `ReadLine` reads them: a final line terminator ends the last line. */
function linesOf(call: NativeCall, text: string): string[] {
  const reader = call.frame.runtime.io.textReader(text);
  const lines: string[] = [];
  for (let line = reader.readLine(); line !== undefined; line = reader.readLine()) lines.push(line);
  return lines;
}

function stringArray(call: NativeCall, values: string[]): Value {
  return newArray(call, libraryType(call, 'System.String'), values);
}

defineNatives({
  'System.Console.get_Out': (call) => redirectionOf(call).out ?? consoleObject(call, 'stdout'),
  'System.Console.get_Error': (call) => redirectionOf(call).error ?? consoleObject(call, 'stderr'),
  'System.Console.get_In': (call) => redirectionOf(call).in ?? consoleObject(call, 'stdin'),
  'System.Console.SetOut': redirect('out', 'newOut'),
  'System.Console.SetError': redirect('error', 'newError'),
  'System.Console.SetIn': redirect('in', 'newIn'),
  'System.Console.ReadLine': (call, _receiver, args) => {
    const redirected = redirectionOf(call).in;
    if (redirected) return forwardTo(call, redirected, 'System.IO.TextReader', args);
    return readLineOf(call.frame.runtime.io.stdin.reader);
  },
  'System.Console.Read': (call, _receiver, args) => {
    const redirected = redirectionOf(call).in;
    if (redirected) return forwardTo(call, redirected, 'System.IO.TextReader', args);
    return readCharOf(call.frame.runtime.io.stdin.reader);
  },

  'System.IO.TextWriter.Write': writing(false),
  'System.IO.TextWriter.WriteLine': writing(true),
  'System.IO.TextWriter.Flush': (call, receiver) => {
    writerOf(call, receiver).flush(call);
  },
  'System.IO.TextWriter.Close': close,
  'System.IO.TextWriter.Dispose': close,
  'System.IO.StreamWriter..ctor(string)': (call, receiver, [path]) => {
    (receiver as CsObject).native = openFileWriter(call, pathArgument(path as Value), false);
  },
  'System.IO.StreamWriter..ctor(string, bool)': (call, receiver, [path, append]) => {
    (receiver as CsObject).native = openFileWriter(call, pathArgument(path as Value), append as boolean);
  },
  'System.IO.StreamWriter..ctor(string, bool, Encoding?)': (call, receiver, args) => {
    const [path, append] = args as Value[];
    const target = pathArgument(path as Value);
    // A null encoding is UTF-8 without a byte order mark, as for the overloads without one.
    (receiver as CsObject).native = openFileWriter(call, target, append as boolean, args[2] as Value);
  },
  'System.IO.StreamWriter.get_AutoFlush': (_call, receiver) => ((receiver as CsObject).native as FileWriter).autoFlush,
  'System.IO.StreamWriter.set_AutoFlush': (call, receiver, [value]) => {
    const writer = writerOf(call, receiver) as FileWriter;
    writer.autoFlush = value as boolean;
    if (writer.autoFlush) writer.flush(call);
  },
  'System.IO.StringWriter..ctor': (_call, receiver) => {
    (receiver as CsObject).native = new StringWriterState();
  },
  'System.IO.StringWriter.ToString': (_call, receiver) => ((receiver as CsObject).native as StringWriterState).text,

  'System.IO.TextReader.ReadLine': (call, receiver) => readLineOf(readerOf(call, receiver).reader),
  'System.IO.TextReader.Read': (call, receiver) => readCharOf(readerOf(call, receiver).reader),
  'System.IO.TextReader.Peek': (call, receiver) => peekCharOf(readerOf(call, receiver).reader),
  'System.IO.TextReader.ReadToEnd': (call, receiver) => readerOf(call, receiver).reader.readRest(),
  'System.IO.TextReader.Close': close,
  'System.IO.TextReader.Dispose': close,
  'System.IO.StreamReader..ctor(string)': (call, receiver, [path]) => {
    (receiver as CsObject).native = openFileReader(call, pathArgument(path as Value));
  },
  'System.IO.StreamReader..ctor(string, Encoding?)': (call, receiver, args) => {
    (receiver as CsObject).native = openFileReader(call, pathArgument(args[0] as Value));
  },
  'System.IO.StreamReader.get_EndOfStream': (call, receiver) => readerOf(call, receiver).reader.isAtEnd,
  'System.IO.StringReader..ctor': (call, receiver, [text]) => {
    if (text === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 's');
    const reader = call.frame.runtime.io.textReader(valueText(text as Value));
    (receiver as CsObject).native = { name: 'StringReader', reader, isClosed: false } satisfies ReaderState;
  },
});

// ---- File ----

/** Writes a text to a file, after a byte order mark when `encoding` is given and the file is empty. */
function writeFile(call: NativeCall, path: string, text: string, append: boolean, encoding?: Value): void {
  const files = call.frame.runtime.io.files;
  checkLock(call, path, 'shared');
  const handle = withFiles(call, () => files.open(path, { create: 'always', truncate: !append, append }));
  handle.write(encoding !== undefined && handle.text === '' ? `${BYTE_ORDER_MARK}${text}` : text);
}

/**
 * The encoding argument of an overload that takes one, which can only be Encoding.UTF8, the library's one encoding,
 * or `undefined` for an overload without one.
 */
export function encodingArgument(call: NativeCall, args: readonly unknown[], index: number): Value {
  if (call.method.parameters.length <= index) return undefined;
  const encoding = args[index] as Value;
  if (encoding === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'encoding');
  return encoding;
}

function textArgument(value: Value): string {
  return value === undefined ? '' : valueText(value);
}

function linesText(call: NativeCall, lines: Value): string {
  if (lines === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'contents');
  return [...iterate(call, lines, 'contents')].map((line) => `${line === undefined ? '' : valueText(line)}\n`).join('');
}

/** The text of a file, without the byte order mark that .NET's readers skip at its start. */
function readFile(call: NativeCall, path: Value, args: readonly unknown[] = []): string {
  const files = call.frame.runtime.io.files;
  const target = pathArgument(path);
  encodingArgument(call, args, 1);
  checkLock(call, target, 'shared');
  const text = withFiles(call, () => files.readFile(target));
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
}

/** Deletes a file, where a file that is not there is no error, but a missing directory on its path is. */
export function deleteFile(call: NativeCall, target: string): void {
  const files = call.frame.runtime.io.files;
  if (files.kindOf(target) === undefined) {
    if (files.kindOf(resolvePath(`${resolvePath(target)}/..`)) !== 'directory')
      failFileSystem(call, new FileSystemError('ENOTDIR', target));
    return;
  }
  withFiles(call, () => files.remove(target, 'file'));
}

export function copyFile(call: NativeCall, from: Value, to: Value, overwrite: boolean): void {
  const files = call.frame.runtime.io.files;
  const source = pathArgument(from, 'sourceFileName');
  const target = pathArgument(to, 'destFileName');
  checkLock(call, source, 'shared');
  const text = withFiles(call, () => files.readFile(source));
  checkLock(call, target, 'exclusive');
  const existing = files.kindOf(target);
  if (existing === 'directory')
    throwException(
      call,
      'System.IO.IOException',
      `The target file '${resolvePath(target)}' is a directory, not a file.`
    );
  if (existing === 'file' && !overwrite) failFileSystem(call, new FileSystemError('EEXIST', target));
  writeFile(call, target, text, false);
}

export function moveFile(call: NativeCall, from: Value, to: Value, overwrite: boolean): void {
  const files = call.frame.runtime.io.files;
  const source = pathArgument(from, 'sourceFileName');
  const target = pathArgument(to, 'destFileName');
  const kind = files.kindOf(source);
  if (kind !== 'file') failFileSystem(call, new FileSystemError(kind === 'directory' ? 'EISDIR' : 'ENOENT', source));
  const existing = files.kindOf(target);
  if (existing === 'directory' || (existing === 'file' && !overwrite))
    failFileSystem(call, new FileSystemError('EEXIST', target));
  withFiles(call, () => files.rename(source, target));
}

defineNatives({
  'System.IO.File.Exists': (call, _receiver, [path]) =>
    isString(path as Value) &&
    valueText(path as Value) !== '' &&
    call.frame.runtime.io.files.kindOf(valueText(path as Value)) === 'file',
  'System.IO.File.ReadAllText': (call, _receiver, args) => readFile(call, args[0] as Value, args),
  'System.IO.File.ReadAllLines': (call, _receiver, args) =>
    stringArray(call, linesOf(call, readFile(call, args[0] as Value, args))),
  'System.IO.File.ReadLines': (call, _receiver, args) =>
    stringArray(call, linesOf(call, readFile(call, args[0] as Value, args))),
  'System.IO.File.WriteAllText': (call, _receiver, args) => {
    const [path, text] = args as Value[];
    const target = pathArgument(path);
    writeFile(call, target, textArgument(text), false, encodingArgument(call, args, 2));
  },
  'System.IO.File.WriteAllLines': (call, _receiver, args) => {
    const [path, lines] = args as Value[];
    const target = pathArgument(path);
    const text = linesText(call, lines);
    writeFile(call, target, text, false, encodingArgument(call, args, 2));
  },
  'System.IO.File.AppendAllText': (call, _receiver, args) => {
    const [path, text] = args as Value[];
    const target = pathArgument(path);
    writeFile(call, target, textArgument(text), true, encodingArgument(call, args, 2));
  },
  'System.IO.File.AppendAllLines': (call, _receiver, args) => {
    const [path, lines] = args as Value[];
    const target = pathArgument(path);
    const text = linesText(call, lines);
    writeFile(call, target, text, true, encodingArgument(call, args, 2));
  },
  'System.IO.File.Delete': (call, _receiver, [path]) => {
    deleteFile(call, pathArgument(path as Value));
  },
  'System.IO.File.Copy(string, string)': (call, _receiver, [from, to]) => {
    copyFile(call, from as Value, to as Value, false);
  },
  'System.IO.File.Copy(string, string, bool)': (call, _receiver, [from, to, overwrite]) => {
    copyFile(call, from as Value, to as Value, overwrite as boolean);
  },
  'System.IO.File.Move(string, string)': (call, _receiver, [from, to]) => {
    moveFile(call, from as Value, to as Value, false);
  },
  'System.IO.File.Move(string, string, bool)': (call, _receiver, [from, to, overwrite]) => {
    moveFile(call, from as Value, to as Value, overwrite as boolean);
  },
  'System.IO.File.OpenText': (call, _receiver, [path]) =>
    newReader(call, 'System.IO.StreamReader', openFileReader(call, pathArgument(path as Value))),
  'System.IO.File.CreateText': (call, _receiver, [path]) =>
    newWriter(call, 'System.IO.StreamWriter', openFileWriter(call, pathArgument(path as Value), false)),
  'System.IO.File.AppendText': (call, _receiver, [path]) =>
    newWriter(call, 'System.IO.StreamWriter', openFileWriter(call, pathArgument(path as Value), true)),
});

// ---- Directory ----

/** The pattern of the overloads without one, which list every entry. */
export const ALL = Symbol('all entries');

/** Whether a name matches a search pattern of `*` and `?` wildcards, where `*.*` matches every name, as in .NET. */
function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '*.*') return true;
  const expression = pattern
    .replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${expression}$`, 'u').test(name);
}

function entriesOf(call: NativeCall, path: Value, pattern: Value | typeof ALL, kind: 'file' | 'directory'): Value {
  return stringArray(call, entryPaths(call, pathArgument(path), pattern, kind));
}

/** The paths of a directory's entries of a kind, or of either kind, whose names match a search pattern. */
export function entryPaths(
  call: NativeCall,
  directory: string,
  pattern: Value | typeof ALL,
  kind?: 'file' | 'directory'
): string[] {
  const files = call.frame.runtime.io.files;
  if (pattern === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'searchPattern');
  const search = pattern === ALL ? '*' : valueText(pattern);
  const names = withFiles(call, () => files.list(directory), 'directory');
  const joined = (name: string): string => (directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`);
  return names
    .filter((name) => matchesPattern(name, search) && (kind === undefined || files.kindOf(joined(name)) === kind))
    .map(joined);
}

/**
 * A FileInfo or DirectoryInfo: the path as the program gave it, which `ToString` shows, its full path, and what it
 * last found there, which .NET reads on first use and after `Refresh` or an operation of its own that changes it.
 */
export interface FileSystemInfoState {
  readonly kind: 'file' | 'directory';
  originalPath: string;
  fullPath: string;
  /** What the path named when last read, `undefined` for nothing, or `'unread'` before the next read. */
  found: 'file' | 'directory' | undefined | 'unread';
  /** The length in bytes of the file found, when one was. */
  length?: number;
}

export function fileSystemInfo(call: NativeCall, kind: 'file' | 'directory', originalPath: string): CsObject {
  const info = new CsObject(libraryType(call, kind === 'file' ? 'System.IO.FileInfo' : 'System.IO.DirectoryInfo'), []);
  info.native = {
    kind,
    originalPath,
    fullPath: fullPathOf(originalPath),
    found: 'unread',
  } satisfies FileSystemInfoState;
  return info;
}

export function deleteDirectory(call: NativeCall, target: string, recursive: boolean): void {
  const files = call.frame.runtime.io.files;
  withFiles(call, () => (recursive ? removeTree(call, target) : files.remove(target, 'directory')), 'directory');
}

function removeTree(call: NativeCall, path: string): void {
  const files = call.frame.runtime.io.files;
  for (const name of files.list(path)) {
    const child = `${path}/${name}`;
    if (files.kindOf(child) === 'directory') removeTree(call, child);
    else files.remove(child, 'file');
  }
  files.remove(path, 'directory');
}

defineNatives({
  'System.IO.Directory.Exists': (call, _receiver, [path]) =>
    isString(path as Value) &&
    valueText(path as Value) !== '' &&
    call.frame.runtime.io.files.kindOf(valueText(path as Value)) === 'directory',
  'System.IO.Directory.CreateDirectory': (call, _receiver, [path]) => {
    const target = pathArgument(path as Value);
    withFiles(call, () => call.frame.runtime.io.files.createDirectory(target, true), 'directory');
    return fileSystemInfo(call, 'directory', target);
  },
  'System.IO.Directory.Delete(string)': (call, _receiver, [path]) => {
    deleteDirectory(call, pathArgument(path as Value), false);
  },
  'System.IO.Directory.Delete(string, bool)': (call, _receiver, [path, recursive]) => {
    deleteDirectory(call, pathArgument(path as Value), recursive as boolean);
  },
  'System.IO.Directory.GetFiles(string)': (call, _receiver, [path]) => entriesOf(call, path as Value, ALL, 'file'),
  'System.IO.Directory.GetFiles(string, string)': (call, _receiver, [path, pattern]) =>
    entriesOf(call, path as Value, pattern as Value, 'file'),
  'System.IO.Directory.GetDirectories(string)': (call, _receiver, [path]) =>
    entriesOf(call, path as Value, ALL, 'directory'),
  'System.IO.Directory.GetDirectories(string, string)': (call, _receiver, [path, pattern]) =>
    entriesOf(call, path as Value, pattern as Value, 'directory'),
  'System.IO.Directory.EnumerateFiles(string)': (call, _receiver, [path]) =>
    entriesOf(call, path as Value, ALL, 'file'),
  'System.IO.Directory.EnumerateFiles(string, string)': (call, _receiver, [path, pattern]) =>
    entriesOf(call, path as Value, pattern as Value, 'file'),
  'System.IO.Directory.EnumerateDirectories(string)': (call, _receiver, [path]) =>
    entriesOf(call, path as Value, ALL, 'directory'),
  'System.IO.Directory.EnumerateDirectories(string, string)': (call, _receiver, [path, pattern]) =>
    entriesOf(call, path as Value, pattern as Value, 'directory'),
  'System.IO.Directory.GetCurrentDirectory': () => '/',
});

// ---- Exceptions ----

defineNatives({
  'System.IO.FileNotFoundException.get_FileName': (_call, receiver) =>
    ((receiver as CsObject).native as ExceptionState).fileName,
  'System.IO.FileNotFoundException.ToString': (call, receiver) =>
    exceptionText(evaluatorOf(call), receiver as CsObject),
});
