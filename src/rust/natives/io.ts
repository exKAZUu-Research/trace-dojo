import { FileSystemError, type FileSystemErrorCode, type TextReader } from '../../interpreter/programIo';
import { DEFAULT_SPEC } from '../fmt';
import { normalize } from '../infer';
import { shallow } from '../types';
import { decodeUtf8 } from '../utf8';
import {
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
  code?: FileSystemErrorCode;
  kind: string;
  message?: string;
}

/** The text, the code, and the kind of each error, as Rust reports them on macOS. */
const OS_ERRORS: Record<FileSystemErrorCode, [string, number, string]> = {
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
  return payload.message ?? payload.kind;
}

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

/** `BufRead::lines`: each line without its `\n` (or `\r\n`), as `Ok`. */
function linesOf(ctx: NativeContext, reader: TextReader): IterValue {
  return new IterValue(() => {
    const line = readLine(ctx, reader);
    if (line === undefined) return DONE;
    return ok(ctx, line.endsWith('\r\n') ? line.slice(0, -2) : line.endsWith('\n') ? line.slice(0, -1) : line);
  });
}

function readerOf(value: Value): TextReader {
  const { reader } = stream(value);
  if (!reader) throw new Error('A stream without a reader');
  return reader;
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

function fileName(path: string): string | undefined {
  const name = path.replace(/\/+$/, '').split('/').at(-1);
  return name === undefined || name === '' || name === '..' || name === '.' ? undefined : name;
}

function options(value: Value): OpenOptionsValue {
  return deref(value) as unknown as OpenOptionsValue;
}

define({
  'std::io::stdin': (_args, ctx) => new IoStream(ctx.runtime.io.stdin.reader, undefined),
  'Stdin::lock': ([self]) => stream(self),
  'Stdin::read_line': ([self, buf], ctx) => {
    const line = readLine(ctx, readerOf(self));
    return ok(ctx, BigInt(line === undefined ? 0 : appendText(ctx, buf, line)));
  },
  'Stdin::lines': ([self], ctx) => linesOf(ctx, readerOf(self)),
  'std::io::Read::read_to_string': ([self, buf], ctx) => {
    const rest = readerOf(self).readRest();
    return ok(ctx, BigInt(appendText(ctx, buf, rest)));
  },
  'std::io::Read::read_to_end': ([self, buf], ctx) => {
    const bytes = new TextEncoder().encode(readerOf(self).readRest());
    const items = placeOf(buf).get() as Value[];
    ctx.runtime.allocate(bytes.length);
    for (const byte of bytes) items.push(BigInt(byte));
    return ok(ctx, BigInt(bytes.length));
  },
  'std::io::BufRead::read_line': ([self, buf], ctx) => {
    const line = readLine(ctx, readerOf(self));
    return ok(ctx, BigInt(line === undefined ? 0 : appendText(ctx, buf, line)));
  },
  'std::io::BufRead::lines': ([self], ctx) => linesOf(ctx, readerOf(self)),
  'std::io::read_to_string': ([reader], ctx) => ok(ctx, readerOf(reader).readRest()),
  'BufReader<_>::new': ([inner]) => inner,
  'BufWriter<_>::new': ([inner]) => inner,
  'Error::new': ([kind, error], ctx) =>
    ioError(ctx, {
      kind: ctx.interp.program.adtDef('IoErrorKind').variants[(deref(kind) as EnumValue).variant].name,
      message: ctx.interp.formatter.display(error, ctx.typeArgs[0], DEFAULT_SPEC),
    }),
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

/** Writes text to a file a stream writes to, for `write!` and `Write::write_all` on a file. */
export function writeToStream(target: Value, text: string): void {
  const { writer } = stream(target);
  if (!writer) throw new Error('A stream without a writer');
  writer.write(text);
}

/** Whether a type is one whose `Write` impl writes to a file: a `File`, or a `BufWriter` of one. */
export function writesFile(type: Parameters<typeof normalize>[0]): boolean {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  if (t.kind !== 'adt') return false;
  if (t.def.builtin === 'File') return true;
  return t.def.builtin === 'BufWriter' && t.args.length > 0 && writesFile(t.args[0]);
}
