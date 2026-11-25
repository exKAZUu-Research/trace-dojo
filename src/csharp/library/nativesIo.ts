import {
  type FileHandle,
  FileSystemError,
  type OutputChannel,
  resolvePath,
  type TextReader,
} from '../../interpreter/programIo';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { exceptionText } from '../objects';
import { CsThrow, type ExceptionState } from '../runtime';
import { CsObject, type CsString, isString, stringText, type Value } from '../values';
import { iterate } from './iteration';
import { writeText } from './nativesCore';
import { evaluatorOf, fail, libraryType, newArray } from './support';

/** Where a TextWriter's text goes: the console, a file, or a string. */
interface WriterState {
  /** The writer's type name, which an ObjectDisposedException names. */
  readonly name: string;
  isClosed: boolean;
  write(text: string): void;
  flush(): void;
}

/** What a TextReader reads: standard input, a file, or a string. */
interface ReaderState {
  readonly name: string;
  readonly reader: TextReader;
  isClosed: boolean;
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
class FileWriter implements WriterState {
  readonly name = 'StreamWriter';
  isClosed = false;
  autoFlush = false;
  private chars = '';
  private pending = '';
  private pendingBytes = 0;

  constructor(private readonly handle: FileHandle) {}

  write(text: string): void {
    let rest = text;
    while (rest.length > 0) {
      // The buffer is encoded when it is full and more characters come, as StreamWriter.Write does it.
      if (this.chars.length === CHAR_BUFFER_SIZE) this.encodeChars();
      const taken = rest.slice(0, CHAR_BUFFER_SIZE - this.chars.length);
      this.chars += taken;
      rest = rest.slice(taken.length);
    }
    if (this.autoFlush) this.flush();
  }

  flush(): void {
    this.encodeChars();
    this.writePending();
  }

  private encodeChars(): void {
    if (this.chars === '') return;
    let chunk = this.chars;
    // The encoder keeps a high surrogate at the end for the low one that follows.
    const keepsSurrogate = /[\uD800-\uDBFF]$/u.test(chunk);
    if (keepsSurrogate) chunk = chunk.slice(0, -1);
    this.chars = keepsSurrogate ? this.chars.slice(-1) : '';
    const bytes = utf8Length(chunk);
    if (this.pendingBytes + bytes > BYTE_BUFFER_SIZE) this.writePending();
    if (bytes >= BYTE_BUFFER_SIZE) this.handle.write(chunk);
    else {
      this.pending += chunk;
      this.pendingBytes += bytes;
    }
  }

  private writePending(): void {
    if (this.pending === '') return;
    this.handle.write(this.pending);
    this.pending = '';
    this.pendingBytes = 0;
  }
}

function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    length += code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
  }
  return length;
}

// ---- Paths and errors ----

function valueText(value: Value): string {
  return stringText(value as string | CsString);
}

/** The path argument of a file operation, which may be neither null nor empty. */
function pathArgument(value: Value, paramName = 'path'): string {
  if (value === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', paramName);
  const path = valueText(value);
  if (path === '') fail('System.ArgumentException', 'The value cannot be an empty string.', paramName);
  return path;
}

function throwException(call: NativeCall, fullName: string, message: string, fileName?: string): never {
  const exception = call.frame.runtime.createException(fullName, message);
  if (fileName !== undefined) (exception.native as ExceptionState).fileName = fileName;
  throw new CsThrow(exception);
}

/** Throws the .NET exception of a failed file system operation, with the full path .NET's messages show. */
function failFileSystem(call: NativeCall, error: unknown, target: 'file' | 'directory' = 'file'): never {
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

function withFiles<T>(call: NativeCall, run: () => T, target: 'file' | 'directory' = 'file'): T {
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

const close: NativeMethod = (_call, receiver) => {
  const state = (receiver as CsObject).native as WriterState | ReaderState;
  if (state.isClosed) return;
  if ('flush' in state) state.flush();
  // The console's writers and reader stay open, as .NET's do.
  if (!(state instanceof ConsoleWriter) && state.name !== 'TextReader') state.isClosed = true;
};

const writing =
  (newline: boolean): NativeMethod =>
  (call, receiver, args) => {
    const writer = writerOf(call, receiver);
    writer.write(writeText(call, args as Value[]) + (newline ? '\n' : ''));
  };

function newWriter(call: NativeCall, typeName: string, state: WriterState): CsObject {
  const writer = new CsObject(libraryType(call, typeName), []);
  writer.native = state;
  return writer;
}

function openFileWriter(call: NativeCall, path: string, append: boolean): FileWriter {
  const files = call.frame.runtime.io.files;
  return new FileWriter(withFiles(call, () => files.open(path, { create: 'always', truncate: !append, append })));
}

function openFileReader(call: NativeCall, path: string): ReaderState {
  const io = call.frame.runtime.io;
  return { name: 'StreamReader', reader: withFiles(call, () => io.openReader(path)), isClosed: false };
}

function newReader(call: NativeCall, typeName: string, state: ReaderState): CsObject {
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
  'System.Console.get_Out': (call) => consoleObject(call, 'stdout'),
  'System.Console.get_Error': (call) => consoleObject(call, 'stderr'),
  'System.Console.get_In': (call) => consoleObject(call, 'stdin'),
  'System.Console.ReadLine': (call) => readLineOf(call.frame.runtime.io.stdin.reader),
  'System.Console.Read': (call) => readCharOf(call.frame.runtime.io.stdin.reader),

  'System.IO.TextWriter.Write': writing(false),
  'System.IO.TextWriter.WriteLine': writing(true),
  'System.IO.TextWriter.Flush': (call, receiver) => {
    writerOf(call, receiver).flush();
  },
  'System.IO.TextWriter.Close': close,
  'System.IO.TextWriter.Dispose': close,
  'System.IO.StreamWriter..ctor(string)': (call, receiver, [path]) => {
    (receiver as CsObject).native = openFileWriter(call, pathArgument(path as Value), false);
  },
  'System.IO.StreamWriter..ctor(string, bool)': (call, receiver, [path, append]) => {
    (receiver as CsObject).native = openFileWriter(call, pathArgument(path as Value), append as boolean);
  },
  'System.IO.StreamWriter.get_AutoFlush': (_call, receiver) => ((receiver as CsObject).native as FileWriter).autoFlush,
  'System.IO.StreamWriter.set_AutoFlush': (call, receiver, [value]) => {
    const writer = writerOf(call, receiver) as FileWriter;
    writer.autoFlush = value as boolean;
    if (writer.autoFlush) writer.flush();
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
  'System.IO.StreamReader..ctor': (call, receiver, [path]) => {
    (receiver as CsObject).native = openFileReader(call, pathArgument(path as Value));
  },
  'System.IO.StreamReader.get_EndOfStream': (call, receiver) => readerOf(call, receiver).reader.isAtEnd,
  'System.IO.StringReader..ctor': (call, receiver, [text]) => {
    if (text === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 's');
    const reader = call.frame.runtime.io.textReader(valueText(text as Value));
    (receiver as CsObject).native = { name: 'StringReader', reader, isClosed: false } satisfies ReaderState;
  },
});

// ---- File ----

function writeFile(call: NativeCall, path: string, text: string, append: boolean): void {
  const files = call.frame.runtime.io.files;
  withFiles(call, () => files.open(path, { create: 'always', truncate: !append, append }).write(text));
}

function linesText(call: NativeCall, lines: Value): string {
  if (lines === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'contents');
  return [...iterate(call, lines, 'contents')].map((line) => `${line === undefined ? '' : valueText(line)}\n`).join('');
}

function readFile(call: NativeCall, path: Value): string {
  const files = call.frame.runtime.io.files;
  return withFiles(call, () => files.readFile(pathArgument(path)));
}

function copyFile(call: NativeCall, from: Value, to: Value, overwrite: boolean): void {
  const files = call.frame.runtime.io.files;
  const source = pathArgument(from, 'sourceFileName');
  const target = pathArgument(to, 'destFileName');
  const text = withFiles(call, () => files.readFile(source));
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

function moveFile(call: NativeCall, from: Value, to: Value, overwrite: boolean): void {
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
  'System.IO.File.ReadAllText': (call, _receiver, [path]) => readFile(call, path as Value),
  'System.IO.File.ReadAllLines': (call, _receiver, [path]) =>
    stringArray(call, linesOf(call, readFile(call, path as Value))),
  'System.IO.File.ReadLines': (call, _receiver, [path]) =>
    stringArray(call, linesOf(call, readFile(call, path as Value))),
  'System.IO.File.WriteAllText': (call, _receiver, [path, text]) => {
    writeFile(call, pathArgument(path as Value), text === undefined ? '' : valueText(text as Value), false);
  },
  'System.IO.File.WriteAllLines': (call, _receiver, [path, lines]) => {
    writeFile(call, pathArgument(path as Value), linesText(call, lines as Value), false);
  },
  'System.IO.File.AppendAllText': (call, _receiver, [path, text]) => {
    writeFile(call, pathArgument(path as Value), text === undefined ? '' : valueText(text as Value), true);
  },
  'System.IO.File.AppendAllLines': (call, _receiver, [path, lines]) => {
    writeFile(call, pathArgument(path as Value), linesText(call, lines as Value), true);
  },
  'System.IO.File.Delete': (call, _receiver, [path]) => {
    const files = call.frame.runtime.io.files;
    const target = pathArgument(path as Value);
    // Deleting a file that is not there is no error, but a missing directory on its path is.
    if (files.kindOf(target) === undefined) {
      if (files.kindOf(resolvePath(`${resolvePath(target)}/..`)) !== 'directory')
        failFileSystem(call, new FileSystemError('ENOTDIR', target));
      return;
    }
    withFiles(call, () => files.remove(target, 'file'));
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
const ALL = Symbol('all entries');

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
  const files = call.frame.runtime.io.files;
  const directory = pathArgument(path);
  if (pattern === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'searchPattern');
  const search = pattern === ALL ? '*' : valueText(pattern);
  const names = withFiles(call, () => files.list(directory), 'directory');
  const joined = (name: string): string => (directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`);
  return stringArray(
    call,
    names.filter((name) => matchesPattern(name, search) && files.kindOf(joined(name)) === kind).map(joined)
  );
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

function directoryInfo(call: NativeCall, path: string): CsObject {
  const info = new CsObject(libraryType(call, 'System.IO.DirectoryInfo'), []);
  info.native = path;
  return info;
}

defineNatives({
  'System.IO.Directory.Exists': (call, _receiver, [path]) =>
    isString(path as Value) &&
    valueText(path as Value) !== '' &&
    call.frame.runtime.io.files.kindOf(valueText(path as Value)) === 'directory',
  'System.IO.Directory.CreateDirectory': (call, _receiver, [path]) => {
    const target = pathArgument(path as Value);
    withFiles(call, () => call.frame.runtime.io.files.createDirectory(target, true), 'directory');
    return directoryInfo(call, target);
  },
  'System.IO.Directory.Delete(string)': (call, _receiver, [path]) => {
    const target = pathArgument(path as Value);
    withFiles(call, () => call.frame.runtime.io.files.remove(target, 'directory'), 'directory');
  },
  'System.IO.Directory.Delete(string, bool)': (call, _receiver, [path, recursive]) => {
    const target = pathArgument(path as Value);
    const files = call.frame.runtime.io.files;
    withFiles(call, () => (recursive ? removeTree(call, target) : files.remove(target, 'directory')), 'directory');
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
  'System.IO.DirectoryInfo.get_Name': (_call, receiver) => fileNameOf(trimEnd((receiver as CsObject).native as string)),
  'System.IO.DirectoryInfo.get_FullName': (_call, receiver) => fullPathOf((receiver as CsObject).native as string),
  'System.IO.DirectoryInfo.get_Exists': (call, receiver) =>
    call.frame.runtime.io.files.kindOf((receiver as CsObject).native as string) === 'directory',
  'System.IO.DirectoryInfo.ToString': (_call, receiver) => (receiver as CsObject).native as string,
});

// ---- Path ----

function trimEnd(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, '') || '/' : path;
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extensionStart(path: string): number {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? dot : -1;
}

/** `Path.GetFullPath`, which keeps a final separator. */
function fullPathOf(path: string): string {
  const resolved = resolvePath(path);
  return path.endsWith('/') && resolved !== '/' ? `${resolved}/` : resolved;
}

function optionalText(value: Value): string | undefined {
  return value === undefined ? undefined : valueText(value);
}

function pathParts(call: NativeCall, args: Value[]): (string | undefined)[] {
  const params = call.method.parameters.at(-1)?.isParams;
  if (!params) return args.map(optionalText);
  const array = args[0];
  if (array === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'paths');
  return [...iterate(call, array, 'paths')].map(optionalText);
}

/** `Path.Combine`: a rooted part starts the path again; parts join with a separator unless one ends with it. */
const combine: NativeMethod = (call, _receiver, args) => {
  const parts = pathParts(call, args as Value[]);
  const names = call.method.parameters.map((parameter) => parameter.name);
  let path = '';
  for (const [index, part] of parts.entries()) {
    if (part === undefined)
      fail('System.ArgumentNullException', 'Value cannot be null.', names.length === 1 ? 'paths' : names[index]);
    if (part === '') continue;
    if (part.startsWith('/')) path = part;
    else path = path === '' || path.endsWith('/') ? `${path}${part}` : `${path}/${part}`;
  }
  return path;
};

/** `Path.Join`: parts join with one separator between them unless one already has it; null and empty parts drop. */
const join: NativeMethod = (call, _receiver, args) => {
  let path = '';
  for (const part of pathParts(call, args as Value[])) {
    if (part === undefined || part === '') continue;
    path = path === '' || path.endsWith('/') || part.startsWith('/') ? `${path}${part}` : `${path}/${part}`;
  }
  return path;
};

defineNatives({
  'System.IO.Path.Combine': combine,
  'System.IO.Path.Join': join,
  'System.IO.Path.GetFileName': (_call, _receiver, [path]) => {
    const text = optionalText(path as Value);
    return text === undefined ? undefined : fileNameOf(text);
  },
  'System.IO.Path.GetFileNameWithoutExtension': (_call, _receiver, [path]) => {
    const text = optionalText(path as Value);
    if (text === undefined) return;
    const name = fileNameOf(text);
    const dot = name.lastIndexOf('.');
    return dot === -1 ? name : name.slice(0, dot);
  },
  'System.IO.Path.GetExtension': (_call, _receiver, [path]) => {
    const text = optionalText(path as Value);
    if (text === undefined) return;
    const dot = extensionStart(text);
    return dot === -1 || dot === text.length - 1 ? '' : text.slice(dot);
  },
  'System.IO.Path.HasExtension': (_call, _receiver, [path]) => {
    const text = optionalText(path as Value);
    if (text === undefined) return false;
    const dot = extensionStart(text);
    return dot !== -1 && dot !== text.length - 1;
  },
  'System.IO.Path.GetDirectoryName': (_call, _receiver, [path]) => {
    const text = optionalText(path as Value);
    if (text === undefined || text === '' || /^\/+$/u.test(text)) return;
    const slash = text.lastIndexOf('/');
    if (slash === -1) return '';
    const directory = text.slice(0, slash).replace(/\/+$/u, '');
    // Repeated separators inside the directory collapse to one, as .NET normalizes them.
    return directory === '' ? '/' : directory.replaceAll(/\/{2,}/gu, '/');
  },
  'System.IO.Path.ChangeExtension': (_call, _receiver, [path, extension]) => {
    const text = optionalText(path as Value);
    if (text === undefined) return;
    const dot = extensionStart(text);
    const stem = dot === -1 ? text : text.slice(0, dot);
    const added = optionalText(extension as Value);
    if (added === undefined) return stem;
    if (added === '') return `${stem}.`;
    return added.startsWith('.') ? `${stem}${added}` : `${stem}.${added}`;
  },
  'System.IO.Path.IsPathRooted': (_call, _receiver, [path]) => optionalText(path as Value)?.startsWith('/') ?? false,
  'System.IO.Path.GetFullPath': (_call, _receiver, [path]) => fullPathOf(pathArgument(path as Value)),
});

// ---- Exceptions ----

defineNatives({
  'System.IO.FileNotFoundException.get_FileName': (_call, receiver) =>
    ((receiver as CsObject).native as ExceptionState).fileName,
  'System.IO.FileNotFoundException.ToString': (call, receiver) =>
    exceptionText(evaluatorOf(call), receiver as CsObject),
});
