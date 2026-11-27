import { FileSystemError, type FileSystemErrorCode, type TextReader } from '../../interpreter/programIo';
import { DEFAULT_SPEC } from '../fmt';
import { normalize } from '../infer';
import type { Program } from '../items';
import { outputStream, shallow } from '../types';
import { decodeUtf8 } from '../utf8';
import {
  BufferedWriter,
  DONE,
  EnumValue,
  IoStream,
  IterValue,
  type Place,
  sliceItems,
  type SliceView,
  StringValue,
  StructValue,
  textOf,
  UNIT_VALUE,
  type Value,
} from '../values';
import { define, deref, err, type NativeContext, ok, placeOf } from './support';

/** The options of `OpenOptions`, which `open` reads. */
class OpenOptionsValue {
  read = false;
  write = false;
  append = false;
  truncate = false;
  create = false;
  createNew = false;
}

/** What an `io::Error` holds: the POSIX code of a file system's failure, or the kind and message the program gave. */
export interface IoErrorPayload {
  code?: OsErrorCode;
  kind: string;
  message?: string;
}

/** A file system's failure, or a write to a handle opened only for reading (`EBADF`). */
type OsErrorCode = FileSystemErrorCode | 'EBADF';

/** The text, the code, and the kind of each error, as Rust reports them on macOS. */
const OS_ERRORS: Record<OsErrorCode, [string, number, string]> = {
  EBADF: ['Bad file descriptor', 9, 'Uncategorized'],
  ENOENT: ['No such file or directory', 2, 'NotFound'],
  EEXIST: ['File exists', 17, 'AlreadyExists'],
  EISDIR: ['Is a directory', 21, 'IsADirectory'],
  ENOTDIR: ['Not a directory', 20, 'NotADirectory'],
  ENOTEMPTY: ['Directory not empty', 66, 'DirectoryNotEmpty'],
  EINVAL: ['Invalid argument', 22, 'InvalidInput'],
};

/** `io::Error`'s `Display`. */
export function ioErrorDisplay(value: Value): string {
  const payload = ioErrorPayload(value);
  if (payload.code) {
    const [text, code] = OS_ERRORS[payload.code];
    return `${text} (os error ${code})`;
  }
  return payload.message ?? ioErrorKindDisplay(payload.kind);
}

/** `io::ErrorKind`'s `Display`, by the variant's name. */
export function ioErrorKindDisplay(kind: string): string {
  return ERROR_KIND_TEXT[kind] ?? kind;
}

const ERROR_KIND_TEXT: Record<string, string> = {
  NotFound: 'entity not found',
  PermissionDenied: 'permission denied',
  ConnectionRefused: 'connection refused',
  ConnectionReset: 'connection reset',
  HostUnreachable: 'host unreachable',
  NetworkUnreachable: 'network unreachable',
  ConnectionAborted: 'connection aborted',
  NotConnected: 'not connected',
  AddrInUse: 'address in use',
  AddrNotAvailable: 'address not available',
  NetworkDown: 'network down',
  BrokenPipe: 'broken pipe',
  AlreadyExists: 'entity already exists',
  WouldBlock: 'operation would block',
  NotADirectory: 'not a directory',
  IsADirectory: 'is a directory',
  DirectoryNotEmpty: 'directory not empty',
  ReadOnlyFilesystem: 'read-only filesystem or storage medium',
  StaleNetworkFileHandle: 'stale network file handle',
  InvalidInput: 'invalid input parameter',
  InvalidData: 'invalid data',
  TimedOut: 'timed out',
  WriteZero: 'write zero',
  StorageFull: 'no storage space',
  NotSeekable: 'seek on unseekable file',
  QuotaExceeded: 'quota exceeded',
  FileTooLarge: 'file too large',
  ResourceBusy: 'resource busy',
  ExecutableFileBusy: 'executable file busy',
  Deadlock: 'deadlock',
  CrossesDevices: 'cross-device link or rename',
  TooManyLinks: 'too many links',
  InvalidFilename: 'invalid filename',
  ArgumentListTooLong: 'argument list too long',
  Interrupted: 'operation interrupted',
  Unsupported: 'unsupported',
  UnexpectedEof: 'unexpected end of file',
  OutOfMemory: 'out of memory',
  Other: 'other error',
  Uncategorized: 'uncategorized error',
};

/** `io::Error`'s `Debug`. */
export function ioErrorDebug(value: Value, indent: number | undefined): string {
  const payload = ioErrorPayload(value);
  const fields: [string, string][] = payload.code
    ? [
        ['code', String(OS_ERRORS[payload.code][1])],
        ['kind', payload.kind],
        ['message', JSON.stringify(OS_ERRORS[payload.code][0])],
      ]
    : [
        ['kind', payload.kind],
        ['error', JSON.stringify(payload.message ?? '')],
      ];
  // An error made from a kind alone (`io::Error::from(kind)`) shows the kind.
  if (!payload.code && payload.message === undefined) {
    return indent === undefined
      ? `Kind(${payload.kind})`
      : `Kind(\n${'    '.repeat(indent + 1)}${payload.kind},\n${'    '.repeat(indent)})`;
  }
  const name = payload.code ? 'Os' : 'Custom';
  if (indent === undefined) return `${name} { ${fields.map(([key, text]) => `${key}: ${text}`).join(', ')} }`;
  const pad = '    '.repeat(indent + 1);
  return `${name} {\n${fields.map(([key, text]) => `${pad}${key}: ${text},\n`).join('')}${'    '.repeat(indent)}}`;
}

function ioErrorPayload(value: Value): IoErrorPayload {
  return (deref(value) as StructValue).fields[0] as unknown as IoErrorPayload;
}

function ioError(ctx: NativeContext, payload: IoErrorPayload): Value {
  return new StructValue(ctx.interp.program.adtDef('IoError'), [payload as unknown as Value]);
}

/** Runs a file system operation, giving `Ok` of its value or `Err` of the `io::Error` its failure is. */
function attempt(ctx: NativeContext, run: () => Value): Value {
  try {
    return ok(ctx, run());
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    return err(ctx, ioError(ctx, { code: error.code, kind: OS_ERRORS[error.code][2] }));
  }
}

function pathOf(value: Value): string {
  return textOf(deref(value));
}

/** Bytes or text to write, as text: what `&str`, `String`, `&[u8]`, and `Vec<u8>` hold. */
function textToWrite(value: Value): string {
  const target = deref(value);
  if (typeof target === 'string' || target instanceof StringValue) return textOf(target);
  const bytes = sliceItems(target as Value[] | SliceView);
  return decodeUtf8(Uint8Array.from(bytes, (byte) => Number(byte as bigint)));
}

function stream(value: Value): IoStream {
  return deref(value) as IoStream;
}

function appendText(ctx: NativeContext, target: Value, text: string): number {
  const place = placeOf(target);
  const current = textOf(place.get());
  ctx.runtime.allocateString(current.length + text.length, text.length);
  place.set(current + text);
  return new TextEncoder().encode(text).length;
}

/** The next line of a reader, with its `\n` when it has one, or undefined at the end. */
function readLine(ctx: NativeContext, reader: TextReader): string | undefined {
  if (reader.isAtEnd) return undefined;
  const { text } = reader;
  const end = text.indexOf('\n', reader.position);
  const next = end === -1 ? text.length : end + 1;
  const line = text.slice(reader.position, next);
  reader.position = next;
  ctx.runtime.spend(Math.ceil((line.length + 1) / 64));
  return line;
}

/**
 * `BufRead::lines`: each line without its `\n` (or `\r\n`), as `Ok`; from a file opened only for writing, an `Err` at
 * every call, as each read fails.
 */
function linesOf(ctx: NativeContext, source: Value): IterValue {
  const { reader } = stream(source);
  return new IterValue(() => {
    if (!reader) return err(ctx, badDescriptor(ctx.interp.program));
    const line = readLine(ctx, reader);
    if (line === undefined) return DONE;
    return ok(ctx, line.endsWith('\r\n') ? line.slice(0, -2) : line.endsWith('\n') ? line.slice(0, -1) : line);
  });
}

/** Reads from a stream, giving `Ok` of what `read` gives, or the `Err` of a file opened only for writing. */
function reading(ctx: NativeContext, source: Value, read: (reader: TextReader) => Value): Value {
  const { reader } = stream(source);
  return reader ? ok(ctx, read(reader)) : err(ctx, badDescriptor(ctx.interp.program));
}

function readLineInto(ctx: NativeContext, reader: TextReader, buf: Value): Value {
  const line = readLine(ctx, reader);
  return BigInt(line === undefined ? 0 : appendText(ctx, buf, line));
}

/** The `io::Error` of a read from a file opened only for writing, or of a write to one opened only for reading. */
function badDescriptor(program: Program): Value {
  return new StructValue(program.adtDef('IoError'), [{ code: 'EBADF', kind: 'Uncategorized' } as unknown as Value]);
}

function openFile(ctx: NativeContext, path: string, options: OpenOptionsValue): Value {
  return attempt(ctx, () => {
    const { files } = ctx.runtime.io;
    const writes = options.write || options.append;
    if (!writes) return new IoStream(ctx.runtime.io.openReader(path), undefined);
    const create = options.createNew ? 'exclusive' : options.create ? 'always' : 'never';
    const handle = files.open(path, { create, truncate: options.truncate, append: options.append });
    return new IoStream(options.read ? ctx.runtime.io.openReader(path) : undefined, handle);
  });
}

function joinPath(base: string, part: string): string {
  if (part.startsWith('/') || base === '') return part;
  return base.endsWith('/') ? `${base}${part}` : `${base}/${part}`;
}

/** The last component of a path, skipping `.` components after the first as `Path::components` does. */
function fileName(path: string): string | undefined {
  const name = path.split('/').findLast((part, index) => part !== '' && (part !== '.' || index === 0));
  return name === undefined || name === '..' || name === '.' ? undefined : name;
}

function options(value: Value): OpenOptionsValue {
  return deref(value) as unknown as OpenOptionsValue;
}

define({
  'std::io::stdin': (_args, ctx) => new IoStream(ctx.runtime.io.stdin.reader, undefined),
  'Stdin::lock': ([self]) => stream(self),
  'Stdin::read_line': ([self, buf], ctx) => reading(ctx, self, (reader) => readLineInto(ctx, reader, buf)),
  'Stdin::lines': ([self], ctx) => linesOf(ctx, self),
  'std::io::Read::read_to_string': ([self, buf], ctx) =>
    reading(ctx, self, (reader) => BigInt(appendText(ctx, buf, reader.readRest()))),
  'std::io::Read::read_to_end': ([self, buf], ctx) =>
    reading(ctx, self, (reader) => {
      const bytes = new TextEncoder().encode(reader.readRest());
      const items = placeOf(buf).get() as Value[];
      ctx.runtime.allocate(bytes.length);
      for (const byte of bytes) items.push(BigInt(byte));
      return BigInt(bytes.length);
    }),
  'std::io::BufRead::read_line': ([self, buf], ctx) => reading(ctx, self, (reader) => readLineInto(ctx, reader, buf)),
  'std::io::BufRead::lines': ([self], ctx) => linesOf(ctx, self),
  'std::io::read_to_string': ([reader], ctx) => reading(ctx, reader, (source) => source.readRest()),
  'BufReader<_>::new': ([inner]) => inner,
  'BufWriter<_>::new': ([inner], ctx) => {
    // Its drop passes on what it holds.
    ctx.interp.dropper.activate();
    const { program } = ctx.interp;
    const { runtime } = ctx;
    const stream = outputStream(ctx.typeArgs[0]);
    return new BufferedWriter((text) => {
      if (!stream) return writeToStream(program, inner, text);
      runtime.write(stream, text);
      return;
    });
  },
  'Error::new': ([kind, error], ctx) =>
    ioError(ctx, {
      kind: ctx.interp.program.adtDef('IoErrorKind').variants[(deref(kind) as EnumValue).variant].name,
      message: ctx.interp.formatter.display(error, ctx.typeArgs[0], DEFAULT_SPEC),
    }),
  'Error::from': ([kind], ctx) =>
    ioError(ctx, { kind: ctx.interp.program.adtDef('IoErrorKind').variants[(deref(kind) as EnumValue).variant].name }),
  'Error::other': ([error], ctx) =>
    ioError(ctx, { kind: 'Other', message: ctx.interp.formatter.display(error, ctx.typeArgs[0], DEFAULT_SPEC) }),
  'Error::kind': ([self], ctx) => {
    const def = ctx.interp.program.adtDef('IoErrorKind');
    const name = ioErrorPayload(self).kind;
    return new EnumValue(
      def,
      Math.max(
        0,
        def.variants.findIndex((variant) => variant.name === name)
      ),
      []
    );
  },
  'File::open': ([path], ctx) => openFile(ctx, pathOf(path), Object.assign(new OpenOptionsValue(), { read: true })),
  'File::create': ([path], ctx) =>
    openFile(ctx, pathOf(path), Object.assign(new OpenOptionsValue(), { write: true, create: true, truncate: true })),
  'File::create_new': ([path], ctx) =>
    openFile(ctx, pathOf(path), Object.assign(new OpenOptionsValue(), { write: true, createNew: true })),
  'File::options': () => new OpenOptionsValue() as unknown as Value,
  'OpenOptions::new': () => new OpenOptionsValue() as unknown as Value,
  'OpenOptions::read': ([self, flag]) => setOption(self, 'read', flag),
  'OpenOptions::write': ([self, flag]) => setOption(self, 'write', flag),
  'OpenOptions::append': ([self, flag]) => setOption(self, 'append', flag),
  'OpenOptions::truncate': ([self, flag]) => setOption(self, 'truncate', flag),
  'OpenOptions::create': ([self, flag]) => setOption(self, 'create', flag),
  'OpenOptions::create_new': ([self, flag]) => setOption(self, 'createNew', flag),
  'OpenOptions::open': ([self, path], ctx) => openFile(ctx, pathOf(path), options(self)),
  'std::fs::read_to_string': ([path], ctx) => attempt(ctx, () => ctx.runtime.io.files.readFile(pathOf(path))),
  'std::fs::read': ([path], ctx) =>
    attempt(ctx, () => Array.from(new TextEncoder().encode(ctx.runtime.io.files.readFile(pathOf(path))), BigInt)),
  'std::fs::write': ([path, contents], ctx) =>
    attempt(ctx, () => {
      ctx.runtime.io.files
        .open(pathOf(path), { create: 'always', truncate: true, append: false })
        .write(textToWrite(contents));
      return UNIT_VALUE;
    }),
  'std::fs::remove_file': ([path], ctx) =>
    attempt(ctx, () => {
      ctx.runtime.io.files.remove(pathOf(path), 'file');
      return UNIT_VALUE;
    }),
  'std::fs::create_dir': ([path], ctx) =>
    attempt(ctx, () => {
      ctx.runtime.io.files.createDirectory(pathOf(path), false);
      return UNIT_VALUE;
    }),
  'std::fs::create_dir_all': ([path], ctx) =>
    attempt(ctx, () => {
      ctx.runtime.io.files.createDirectory(pathOf(path), true);
      return UNIT_VALUE;
    }),
  'std::fs::remove_dir': ([path], ctx) =>
    attempt(ctx, () => {
      ctx.runtime.io.files.remove(pathOf(path), 'directory');
      return UNIT_VALUE;
    }),
  'std::fs::rename': ([from, to], ctx) =>
    attempt(ctx, () => {
      ctx.runtime.io.files.rename(pathOf(from), pathOf(to));
      return UNIT_VALUE;
    }),
  'std::fs::copy': ([from, to], ctx) =>
    attempt(ctx, () => {
      const { files } = ctx.runtime.io;
      const text = files.readFile(pathOf(from));
      files.open(pathOf(to), { create: 'always', truncate: true, append: false }).write(text);
      return BigInt(new TextEncoder().encode(text).length);
    }),
  'std::fs::exists': ([path], ctx) => attempt(ctx, () => ctx.runtime.io.files.kindOf(pathOf(path)) !== undefined),
  'Path::new': ([s]) => pathOf(s),
  'Path::exists': ([self], ctx) => ctx.runtime.io.files.kindOf(pathOf(self)) !== undefined,
  'Path::is_file': ([self], ctx) => ctx.runtime.io.files.kindOf(pathOf(self)) === 'file',
  'Path::is_dir': ([self], ctx) => ctx.runtime.io.files.kindOf(pathOf(self)) === 'directory',
  'Path::to_str': ([self], ctx) => some(ctx, pathOf(self)),
  'Path::display': ([self]) => pathOf(self),
  'Path::join': ([self, part]) => joinPath(pathOf(self), pathOf(part)),
  'Path::file_name': ([self], ctx) => option(ctx, fileName(pathOf(self))),
  'Path::extension': ([self], ctx) => {
    const name = fileName(pathOf(self));
    const dot = name?.lastIndexOf('.') ?? -1;
    return option(ctx, name && dot > 0 ? name.slice(dot + 1) : undefined);
  },
  'Path::to_path_buf': ([self]) => pathOf(self),
  'PathBuf::new': () => '',
  'PathBuf::from': ([s]) => pathOf(s),
  'PathBuf::push': ([self, part]) => {
    const place = placeOf(self);
    place.set(joinPath(pathOf(place.get()), pathOf(part)));
    return UNIT_VALUE;
  },
  'PathBuf::as_path': ([self]) => pathOf(self),
  'PathBuf::exists': ([self], ctx) => ctx.runtime.io.files.kindOf(pathOf(self)) !== undefined,
  'PathBuf::to_str': ([self], ctx) => some(ctx, pathOf(self)),
  'PathBuf::display': ([self]) => pathOf(self),
  'PathBuf::join': ([self, part]) => joinPath(pathOf(self), pathOf(part)),
});

function setOption(self: Value, key: keyof OpenOptionsValue, flag: Value): Value {
  const place = self as Place;
  (options(place) as unknown as Record<string, boolean>)[key] = flag as boolean;
  return place;
}

function some(ctx: NativeContext, value: Value): Value {
  return new EnumValue(ctx.interp.program.adtDef('Option'), 1, [value]);
}

function option(ctx: NativeContext, value: Value | undefined): Value {
  return value === undefined
    ? new EnumValue(ctx.interp.program.adtDef('Option'), 0, [])
    : new EnumValue(ctx.interp.program.adtDef('Option'), 1, [value]);
}

/**
 * Writes text to a file a stream writes to, for `write!` and `Write::write_all` on a file, giving the `io::Error` of a
 * file opened only for reading.
 */
export function writeToStream(program: Program, target: Value, text: string): Value | undefined {
  const { writer } = stream(target);
  // Writing nothing makes no call to the system, so it cannot fail.
  if (text === '') return undefined;
  if (!writer) return badDescriptor(program);
  writer.write(text);
  return undefined;
}

/** How a type's `Write` impl writes: to a file, through a `BufWriter`'s buffer, or not at all. */
export function writeTarget(type: Parameters<typeof normalize>[0]): 'file' | 'buffered' | undefined {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  if (t.kind !== 'adt') return undefined;
  if (t.def.builtin === 'File') return 'file';
  if (t.def.builtin !== 'BufWriter' || t.args.length === 0) return undefined;
  return writeTarget(t.args[0]) === 'file' || outputStream(t.args[0]) ? 'buffered' : undefined;
}
