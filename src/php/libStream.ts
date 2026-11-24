// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { resourceType } from './conversions';
import { throwError, warn } from './errors';
import { csvOptions, parseCsv, scanArguments } from './libScan';
import { defineAlias, defineConstant, defineFunction, defineRuntimeConstant } from './native';
import { toStr } from './operators';
import { rt } from './runtime';
import { formatPrintf } from './sprintf';
import {
  fileStream,
  fileSystemFailure,
  hostPath,
  memoryStream,
  newStreamResource,
  openStream,
  rawInput,
  readable,
  standardInputStream,
  standardOutputStream,
  type Stream,
  type StreamMode,
  takeResourceId,
  writable,
} from './streams';
import { UnsupportedFeatureError } from './unsupported';
import { PhpArray, type PhpObject, type Value } from './values';

const s = (value: Value): string => value as string;
const n = (value: Value): number => Number(value as bigint);

defineRuntimeConstant('STDIN', () => newStreamResource(standardInputStream(), 1));
defineRuntimeConstant('STDOUT', () => newStreamResource(standardOutputStream('stdout'), 2));
defineRuntimeConstant('STDERR', () => newStreamResource(standardOutputStream('stderr'), 3));

defineConstant('SEEK_SET', 0n);
defineConstant('SEEK_CUR', 1n);
defineConstant('SEEK_END', 2n);
defineConstant('LOCK_SH', 1n);
defineConstant('LOCK_EX', 2n);
defineConstant('LOCK_UN', 3n);
defineConstant('LOCK_NB', 4n);

defineFunction('get_resource_type(resource $resource): string', ({ args }) => resourceType(args[0] as PhpObject));
defineFunction('get_resource_id(resource $resource): int', ({ args }) => BigInt((args[0] as PhpObject).id));

// Opening ------------------------------------------------------------------------------------------------------------

defineFunction('fopen(string $filename, string $mode, bool $use_include_path = false, $context = null)', ({ args }) => {
  const stream = openPath('fopen', s(args[0]), s(args[1]));
  return stream ? newStreamResource(stream) : false;
});
defineFunction('tmpfile()', () => newStreamResource(memoryStream()));

/** What each first letter of an `fopen` mode opens a file for and how. */
const OPEN_MODES = {
  r: { create: 'never', truncate: false },
  w: { create: 'always', truncate: true },
  a: { create: 'always', truncate: false },
  x: { create: 'exclusive', truncate: false },
  c: { create: 'always', truncate: false },
} as const;

/** Opens a file or a `php://` stream as `fopen` does, warning and returning `undefined` when it cannot. */
export function openPath(functionName: string, path: string, modeText: string): Stream | undefined {
  const opened = openPathOrFailure(path, modeText);
  if (typeof opened !== 'string') return opened;
  warn(`${functionName}(${path}): Failed to open stream: ${opened}`);
  return undefined;
}

/** Opens a file or a `php://` stream, or returns why it cannot, as PHP words it after "Failed to open stream: ". */
export function openPathOrFailure(path: string, modeText: string): Stream | string {
  if (path === '') throwError('ValueError', 'Path cannot be empty');
  const special = phpStream(path);
  if (special) return special;
  const kind = modeText[0] as keyof typeof OPEN_MODES | undefined;
  if (kind === undefined || !Object.hasOwn(OPEN_MODES, kind)) return `\`${modeText}' is not a valid mode for fopen`;
  const plus = modeText.includes('+');
  const mode: StreamMode = { read: kind === 'r' || plus, write: kind !== 'r' || plus, append: kind === 'a' };
  const files = rt().io.files;
  const host = hostPath(path);
  if (kind === 'r' && files.kindOf(host) === 'directory') {
    throw new UnsupportedFeatureError('ディレクトリをファイルとして開くこと');
  }
  let stream: Stream | undefined;
  const failure = fileSystemFailure(() => {
    stream = fileStream(files.open(host, { ...OPEN_MODES[kind], append: false }), mode);
  });
  return failure ?? (stream as Stream);
}

function phpStream(path: string): Stream | undefined {
  const match = /^php:\/\/([^/]*)/i.exec(path);
  if (!match) return undefined;
  const name = (match[1] as string).toLowerCase();
  if (name === 'stdin' && path.length === match[0].length) return standardInputStream();
  if ((name === 'stdout' || name === 'output') && path.length === match[0].length) {
    return standardOutputStream(name);
  }
  if (name === 'stderr' && path.length === match[0].length) return standardOutputStream('stderr');
  if (name === 'memory' || name === 'temp') return memoryStream(name === 'temp');
  throw new UnsupportedFeatureError(`ストリーム ${path}`);
}

defineFunction('fclose(resource $stream): bool', ({ args }) => {
  openStream(args[0], 'fclose').isClosed = true;
  return true;
});

// Reading ------------------------------------------------------------------------------------------------------------

defineFunction('fgets(resource $stream, ?int $length = null): string|false', ({ args }) => {
  const stream = openStream(args[0], 'fgets');
  const length = args[1] === undefined || args[1] === null ? undefined : n(args[1]);
  if (length !== undefined && length <= 0) {
    throwError('ValueError', 'fgets(): Argument #2 ($length) must be greater than 0');
  }
  if (length === 1 || !readable(stream, 'fgets')) return false;
  return stream.readLine(length === undefined ? Infinity : length - 1) ?? false;
});
defineFunction('fgetc(resource $stream): string|false', ({ args }) => {
  const stream = openStream(args[0], 'fgetc');
  if (!readable(stream, 'fgetc')) return false;
  return stream.read(1) || false;
});
defineFunction('fread(resource $stream, int $length): string|false', ({ args }) => {
  const stream = openStream(args[0], 'fread');
  if (n(args[1]) <= 0) throwError('ValueError', 'fread(): Argument #2 ($length) must be greater than 0');
  if (!readable(stream, 'fread')) return false;
  return stream.read(n(args[1]));
});
defineFunction(
  'stream_get_contents(resource $stream, ?int $length = null, int $offset = -1): string|false',
  ({ args }) => {
    const stream = openStream(args[0], 'stream_get_contents');
    const length = args[1] === undefined || args[1] === null ? -1 : n(args[1]);
    if (length < -1) {
      throwError('ValueError', 'stream_get_contents(): Argument #2 ($length) must be greater than or equal to -1');
    }
    const offset = args[2] === undefined ? -1 : n(args[2]);
    if (offset >= 0 && offset !== stream.position) {
      if (!stream.isSeekable) throw new UnsupportedFeatureError('標準入力のシーク');
      stream.seek(offset);
    }
    if (!readable(stream, 'stream_get_contents')) return false;
    return length === -1 ? stream.readRest() : stream.read(length);
  }
);
defineFunction('stream_get_line(resource $stream, int $length, string $ending = ""): string|false', ({ args }) => {
  const stream = openStream(args[0], 'stream_get_line');
  const length = n(args[1]);
  if (length < 0) {
    throwError('ValueError', 'stream_get_line(): Argument #2 ($length) must be greater than or equal to 0');
  }
  if (!readable(stream, 'stream_get_line')) return false;
  return stream.readUntil(args[2] === undefined ? '' : s(args[2]), length || 8192, false) ?? false;
});
defineFunction('fscanf(resource $stream, string $format, mixed &...$vars): array|int|false|null', ({ args, refs }) => {
  const stream = openStream(args[0], 'fscanf');
  if (!readable(stream, 'fscanf')) return false;
  const line = stream.readLine();
  return line === undefined ? false : scanArguments(line, { args, refs });
});
defineFunction(
  String.raw`fgetcsv(resource $stream, ?int $length = null, string $separator = ",", string $enclosure = '"', string $escape = '\'): array|false`,
  ({ args }) => {
    const stream = openStream(args[0], 'fgetcsv');
    const length = args[1] === undefined || args[1] === null ? 0 : n(args[1]);
    if (length < 0)
      throwError('ValueError', 'fgetcsv(): Argument #2 ($length) must be between 0 and 9223372036854775807');
    const { separator, enclosure, escape } = csvOptions('fgetcsv', args, 2);
    if (!readable(stream, 'fgetcsv')) return false;
    const limit = length === 0 ? Infinity : length;
    const line = stream.readLine(limit);
    if (line === undefined) return false;
    return PhpArray.list(parseCsv(line, separator, enclosure, escape, () => stream.readLine(limit)));
  }
);
defineFunction('fpassthru(resource $stream): int', ({ args }) => {
  const stream = openStream(args[0], 'fpassthru');
  if (!readable(stream, 'fpassthru')) return 0n;
  const rest = stream.readRest();
  rt().echo(rest);
  return BigInt(rest.length);
});

defineFunction('readline(?string $prompt = null): string|false', ({ args }) => {
  const runtime = rt();
  if (typeof args[0] === 'string') runtime.echo(args[0]);
  const raw = rawInput();
  if (raw.offset >= raw.bytes.length) return false;
  const match = /[\n\r]/.exec(raw.bytes.slice(raw.offset));
  const end = match ? raw.offset + match.index : raw.bytes.length;
  const line = raw.bytes.slice(raw.offset, end);
  runtime.spend(Math.ceil((line.length + 1) / 64));
  // GNU readline edits the line as a terminal would, so it completes at a tab and moves at other control characters.
  // oxlint-disable-next-line no-control-regex -- These are the control characters that readline treats as commands.
  if (/[\u0000-\u001F\u007F]/.test(line)) throw new UnsupportedFeatureError('readline() への制御文字の入力');
  raw.offset = match ? end + 1 : end;
  // GNU readline echoes the line it reads when its input is not a terminal.
  runtime.echo(`${line}\n`);
  return line;
});

// Writing ------------------------------------------------------------------------------------------------------------

/** Writes to a stream as `fwrite` does, returning the number of bytes written or false when it cannot write. */
export function writeToStream(value: Value, data: string, functionName: string): bigint | false {
  const stream = openStream(value, functionName);
  if (data === '') return 0n;
  if (!writable(stream, functionName, data.length)) return false;
  stream.write(data);
  return BigInt(data.length);
}

defineFunction('fwrite(resource $stream, string $data, ?int $length = null): int|false', ({ args }) => {
  const data = s(args[1]);
  const length = args[2] === undefined || args[2] === null ? data.length : n(args[2]);
  return writeToStream(args[0], data.slice(0, Math.max(length, 0)), 'fwrite');
});
defineAlias('fputs', 'fwrite');
defineFunction('fprintf(resource $stream, string $format, mixed ...$values): int', ({ args }) => {
  openStream(args[0], 'fprintf');
  return BigInt(formatPrintf(s(args[1]), args.slice(2), (text) => writeToStream(args[0], text, 'fprintf')).length);
});
defineFunction(
  String.raw`fputcsv(resource $stream, array $fields, string $separator = ",", string $enclosure = '"', string $escape = '\', string $eol = PHP_EOL): int|false`,
  ({ args }) => {
    openStream(args[0], 'fputcsv');
    const { separator, enclosure, escape } = csvOptions('fputcsv', args, 2);
    const eol = args[5] === undefined ? '\n' : s(args[5]);
    return writeToStream(args[0], csvLine(args[1] as PhpArray, separator, enclosure, escape, eol), 'fputcsv');
  }
);

/** The line php_fputcsv writes for a record. */
export function csvLine(
  fields: PhpArray,
  separator: string,
  enclosure: string,
  escape: string | undefined,
  eol: string
): string {
  const texts = [...fields.iterValues()].map((field) => csvField(toStr(field), separator, enclosure, escape));
  return texts.join(separator) + eol;
}

/** A field as php_fputcsv writes it, enclosed when it holds a character that CSV readers would split at. */
function csvField(field: string, separator: string, enclosure: string, escape: string | undefined): string {
  const special = [separator, enclosure, '\n', '\r', '\t', ' ', ...(escape === undefined ? [] : [escape])];
  if (!special.some((char) => field.includes(char))) return field;
  let result = enclosure;
  let escaped = false;
  for (const char of field) {
    if (char === escape) escaped = true;
    else if (!escaped && char === enclosure) result += enclosure;
    else escaped = false;
    result += char;
  }
  return result + enclosure;
}

defineFunction(
  'error_log(string $message, int $message_type = 0, ?string $destination = null, ?string $additional_headers = null): bool',
  ({ args }) => {
    const type = args[1] === undefined ? 0n : (args[1] as bigint);
    const message = s(args[0]);
    if (type === 0n) rt().echoError(`${message}\n`);
    else if (type === 3n) {
      const stream = openPath('error_log', toStr(args[2] ?? ''), 'a');
      if (!stream) return false;
      takeResourceId();
      stream.write(message);
    } else throw new UnsupportedFeatureError(`error_log() の送り先（${type}）`);
    return true;
  }
);

// Positions ----------------------------------------------------------------------------------------------------------

defineFunction('feof(resource $stream): bool', ({ args }) => openStream(args[0], 'feof').eof);
defineFunction('ftell(resource $stream): int|false', ({ args }) => BigInt(openStream(args[0], 'ftell').position));
defineFunction('fseek(resource $stream, int $offset, int $whence = SEEK_SET): int', ({ args }) => {
  const stream = seekableStream(args[0], 'fseek');
  const offset = n(args[1]);
  const whence = args[2] === undefined ? 0 : n(args[2]);
  const base = [0, stream.position, stream.length][whence];
  if (base === undefined || base + offset < 0) return -1n;
  stream.seek(base + offset);
  return 0n;
});
defineFunction('rewind(resource $stream): bool', ({ args }) => {
  seekableStream(args[0], 'rewind').seek(0);
  return true;
});

function seekableStream(value: Value, functionName: string): Stream {
  const stream = openStream(value, functionName);
  if (!stream.isSeekable) throw new UnsupportedFeatureError('標準入出力のシーク');
  return stream;
}

defineFunction('ftruncate(resource $stream, int $size): bool', ({ args }) => {
  const stream = openStream(args[0], 'ftruncate');
  const size = n(args[1]);
  if (size < 0) throwError('ValueError', 'ftruncate(): Argument #2 ($size) must be greater than or equal to 0');
  if (!stream.mode.write || !stream.isSeekable) return false;
  stream.truncate(size);
  return true;
});
defineFunction('fflush(resource $stream): bool', ({ args }) => {
  openStream(args[0], 'fflush');
  return true;
});
defineFunction('flock(resource $stream, int $operation, &$would_block = null): bool', ({ args, refs }) => {
  openStream(args[0], 'flock');
  const operation = (args[1] as bigint) & 3n;
  if (operation === 0n) {
    throwError('ValueError', 'flock(): Argument #2 ($operation) must be one of LOCK_SH, LOCK_EX, or LOCK_UN');
  }
  refs[2]?.assign(0n);
  return true;
});
