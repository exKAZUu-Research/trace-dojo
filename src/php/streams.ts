import { type FileHandle, FileSystemError, type FileSystemErrorCode, resolvePath } from '../interpreter/programIo';
import { dec, enc, stringToBytes } from './bytes';
import { notice, throwError } from './errors';
import { rt, type Runtime } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { PhpClass, PhpObject, type Value } from './values';

/** How many bytes PHP's streams read from a file descriptor at once. */
export const CHUNK_SIZE = 8192;

const streamClass = new PhpClass('(stream)');

export function isStream(value: Value): value is PhpObject {
  return value instanceof PhpObject && value.cls === streamClass;
}

/** The bytes a stream reads and writes. */
interface ByteStore {
  readonly length: number;
  /** The stored bytes, after pulling at least `wanted` bytes past `offset` from a source that arrives in parts. */
  bytes(offset: number, wanted: number): string;
  write(offset: number, data: string): void;
  truncate(length: number): void;
}

/** What a stream is open for, as its `fopen` mode says. */
export interface StreamMode {
  read: boolean;
  write: boolean;
  /** Whether every write goes to the end of the file. */
  append: boolean;
}

/** An open stream, which PHP's `fopen`, `opendir`, and its standard streams return as a resource. */
export class Stream {
  isClosed = false;
  /** Whether a read reached the end, which `feof` reports until a seek. */
  eof = false;
  /** Where the next read starts. */
  offset = 0;
  /** The position `ftell` reports, which a write in append mode advances from where it was, as PHP counts it. */
  position = 0;
  /** The entries an `opendir` handle reads, and how many it has read. */
  directory?: { names: string[]; index: number };

  constructor(
    readonly mode: StreamMode,
    private readonly store?: ByteStore,
    /** The standard stream that writes go to, for a stream that only writes there. */
    readonly sink?: 'stdout' | 'output' | 'stderr',
    readonly isSeekable = true
  ) {}

  get length(): number {
    return this.store?.length ?? 0;
  }

  /** Reads up to `count` bytes, reaching the end when fewer remain. */
  read(count: number): string {
    const bytes = this.storeOf().bytes(this.offset, count);
    const chunk = bytes.slice(this.offset, this.offset + count);
    if (chunk.length < count) this.eof = true;
    this.advance(chunk.length);
    return chunk;
  }

  /** Reads a line with its `\n`, or `limit` bytes of it, or `undefined` at the end. */
  readLine(limit = Infinity): string | undefined {
    return this.readUntil('\n', limit, true);
  }

  /**
   * Reads up to the first `ending`, or `limit` bytes, keeping the ending when `keepEnding` and otherwise skipping it,
   * or returns `undefined` at the end.
   */
  // code-gauge-allow functionCognitiveComplexity -- Pulls standard input in chunks until the ending, the limit, or the end.
  readUntil(ending: string, limit: number, keepEnding: boolean): string | undefined {
    const store = this.storeOf();
    for (let wanted = CHUNK_SIZE; ; wanted *= 2) {
      rt().spend();
      const bytes = store.bytes(this.offset, wanted);
      const found = ending === '' ? -1 : bytes.indexOf(ending, this.offset);
      if (found !== -1 && found - this.offset < limit) {
        const end = keepEnding ? Math.min(found + ending.length, this.offset + limit) : found;
        const line = bytes.slice(this.offset, end);
        this.advance(keepEnding ? line.length : line.length + ending.length);
        return line;
      }
      if (bytes.length >= this.offset + limit) return this.read(limit);
      if (bytes.length < this.offset + wanted) {
        this.eof = true;
        if (this.offset >= bytes.length) return undefined;
        return this.read(bytes.length - this.offset);
      }
    }
  }

  readRest(): string {
    const bytes = this.storeOf().bytes(this.offset, Infinity);
    rt().spend(Math.ceil((bytes.length - this.offset + 1) / 64));
    const rest = this.read(Math.max(bytes.length - this.offset, 0));
    this.eof = true;
    return rest;
  }

  write(data: string): void {
    // PHP writes to standard output past the output buffers, which only `php://output` goes through.
    if (this.sink === 'stdout' || this.sink === 'output') rt().echo(data, this.sink === 'output');
    else if (this.sink === 'stderr') rt().echoError(data);
    else {
      const store = this.storeOf();
      const at = this.mode.append ? store.length : this.offset;
      store.write(at, data);
      this.offset = at + data.length;
      this.position += data.length;
    }
  }

  truncate(length: number): void {
    this.storeOf().truncate(length);
  }

  seek(position: number): void {
    this.offset = position;
    this.position = position;
    this.eof = false;
  }

  private advance(count: number): void {
    this.offset += count;
    this.position += count;
  }

  private storeOf(): ByteStore {
    if (!this.store) throw new UnsupportedFeatureError('このストリームの読み書き');
    return this.store;
  }
}

/** The input a run's standard input streams pull from in chunks, as each reads from file descriptor 0. */
interface RawInput {
  bytes: string;
  offset: number;
}

interface StreamState {
  nextResourceId: number;
  /** The directory that relative paths start from, as an absolute path without a trailing slash except the root. */
  cwd: string;
  rawInput?: RawInput;
}

const states = new WeakMap<Runtime, StreamState>();

function stateOf(): StreamState {
  const runtime = rt();
  let state = states.get(runtime);
  if (!state) {
    // PHP's CLI predefines STDIN, STDOUT, and STDERR as resources 1 to 3 and holds resource 4 itself.
    state = { nextResourceId: 5, cwd: '/' };
    states.set(runtime, state);
  }
  return state;
}

/** Standard input, which `readline` reads byte by byte and each stream on it reads in chunks. */
export function rawInput(): RawInput {
  const state = stateOf();
  state.rawInput ??= { bytes: enc(rt().io.stdin.reader.readRest()), offset: 0 };
  return state.rawInput;
}

/** Reserves the next resource id, which every stream PHP opens takes, including those its functions open inside. */
export function takeResourceId(): number {
  return stateOf().nextResourceId++;
}

export function newStreamResource(stream: Stream, id = takeResourceId()): PhpObject {
  const object = new PhpObject(streamClass, id);
  object.internal = stream;
  return object;
}

/** The stream of a resource argument, which must still be open. */
export function openStream(value: Value, functionName: string, parameter = '$stream'): Stream {
  const stream = (value as PhpObject).internal as Stream;
  if (stream.isClosed) {
    throwError('TypeError', `${functionName}(): Argument #1 (${parameter}) must be an open stream resource`);
  }
  return stream;
}

/** Reports a read from a stream not open for reading, as the failed read(2) of PHP's buffer fill does. */
export function readable(stream: Stream, functionName: string): boolean {
  if (stream.mode.read) return true;
  notice(`${functionName}(): Read of ${CHUNK_SIZE} bytes failed with errno=9 Bad file descriptor`);
  return false;
}

export function writable(stream: Stream, functionName: string, length: number): boolean {
  if (stream.mode.write) return true;
  notice(`${functionName}(): Write of ${length} bytes failed with errno=9 Bad file descriptor`);
  return false;
}

export function standardInputStream(): Stream {
  return new Stream({ read: true, write: false, append: false }, new InputStore(), undefined, false);
}

export function standardOutputStream(sink: 'stdout' | 'output' | 'stderr'): Stream {
  return new Stream({ read: false, write: true, append: false }, undefined, sink, false);
}

export function directoryStream(names: string[]): Stream {
  const stream = new Stream({ read: false, write: false, append: false }, undefined, undefined, false);
  stream.directory = { names, index: 0 };
  return stream;
}

export function memoryStream(): Stream {
  return new Stream({ read: true, write: true, append: false }, new MemoryStore());
}

export function fileStream(handle: FileHandle, mode: StreamMode): Stream {
  return new Stream(mode, new FileStore(handle));
}

/** A chunk of standard input at a time, as a stream's buffer reads it. */
class InputStore implements ByteStore {
  private buffer = '';

  get length(): number {
    return this.buffer.length;
  }

  bytes(offset: number, wanted: number): string {
    const raw = rawInput();
    while (this.buffer.length < offset + wanted && raw.offset < raw.bytes.length) {
      rt().spend();
      const chunk = raw.bytes.slice(raw.offset, raw.offset + CHUNK_SIZE);
      raw.offset += chunk.length;
      this.buffer += chunk;
    }
    return this.buffer;
  }

  write(): void {
    throw new UnsupportedFeatureError('標準入力への書き込み');
  }

  truncate(): void {
    throw new UnsupportedFeatureError('標準入力への書き込み');
  }
}

class MemoryStore implements ByteStore {
  private data = '';

  get length(): number {
    return this.data.length;
  }

  bytes(): string {
    return this.data;
  }

  write(offset: number, data: string): void {
    rt().spend(Math.ceil((data.length + 1) / 64));
    this.data = spliced(this.data, offset, data);
  }

  truncate(length: number): void {
    this.data = resized(this.data, length);
  }
}

/** A file of the run's file system, whose text PHP reads and writes as its UTF-8 bytes. */
class FileStore implements ByteStore {
  private cachedText?: string;
  private cachedBytes = '';

  constructor(private readonly handle: FileHandle) {}

  get length(): number {
    return this.current().length;
  }

  bytes(): string {
    return this.current();
  }

  write(offset: number, data: string): void {
    const bytes = this.current();
    const text = offset === bytes.length ? decodeStrict(data) : undefined;
    if (text === undefined) this.replace(spliced(bytes, offset, data));
    else {
      this.handle.writeAt(this.handle.content.length, text);
      this.remember(bytes + data);
    }
  }

  truncate(length: number): void {
    this.replace(resized(this.current(), length));
  }

  private current(): string {
    const text = this.handle.content;
    if (text !== this.cachedText) {
      rt().spend(Math.ceil((text.length + 1) / 64));
      this.cachedText = text;
      this.cachedBytes = enc(text);
    }
    return this.cachedBytes;
  }

  private replace(bytes: string): void {
    this.handle.truncate(0);
    this.handle.writeAt(0, fileText(bytes));
    this.remember(bytes);
  }

  private remember(bytes: string): void {
    this.cachedText = this.handle.content;
    this.cachedBytes = bytes;
  }
}

/** Bytes with `data` written at `offset`, past a gap of NUL bytes when the offset lies past their end. */
function spliced(bytes: string, offset: number, data: string): string {
  return bytes.slice(0, offset).padEnd(offset, '\0') + data + bytes.slice(offset + data.length);
}

function resized(bytes: string, length: number): string {
  return length <= bytes.length ? bytes.slice(0, length) : bytes.padEnd(length, '\0');
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeStrict(bytes: string): string | undefined {
  // oxlint-disable-next-line no-control-regex -- ASCII bytes decode to themselves.
  if (/^[\u0000-\u007F]*$/.test(bytes)) return bytes;
  try {
    return strictDecoder.decode(stringToBytes(bytes));
  } catch {
    return undefined;
  }
}

/** The text a file holds for bytes a program writes, which must be UTF-8 since files hold text. */
export function fileText(bytes: string): string {
  const text = decodeStrict(bytes);
  if (text === undefined) throw new UnsupportedFeatureError('UTF-8 として正しくない内容のファイル');
  return text;
}

/** The text of a PHP path, as the run's file system names it, from the current directory. */
export function hostPath(path: string): string {
  if (path.includes('\0')) throw new UnsupportedFeatureError('NUL 文字を含むパス');
  const text = dec(path);
  if (/^[A-Za-z][\w+.-]*:\/\//.test(text) || text.startsWith('data:')) {
    throw new UnsupportedFeatureError(`ファイル以外の URL（${text}）`);
  }
  const { cwd } = stateOf();
  return text.startsWith('/') || cwd === '/' ? text : `${cwd}/${text}`;
}

export function currentDirectory(): string {
  return stateOf().cwd;
}

export function changeDirectory(path: string): void {
  stateOf().cwd = resolvePath(path);
}

const ERROR_MESSAGES: Record<FileSystemErrorCode, string> = {
  ENOENT: 'No such file or directory',
  EEXIST: 'File exists',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  ENOTEMPTY: 'Directory not empty',
  EINVAL: 'Invalid argument',
};

/** Runs a file system operation, returning the message of the error it fails with, as `strerror` writes it. */
export function fileSystemFailure(operation: () => void): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    if (error instanceof FileSystemError) return ERROR_MESSAGES[error.code];
    throw error;
  }
}
