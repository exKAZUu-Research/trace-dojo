// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { resolvePath } from '../interpreter/programIo';
import { enc } from './bytes';
import { callMethod } from './callables';
import { findClass, instantiate } from './classes';
import { deprecated, throwError } from './errors';
import { basenameOf, dirnameOf } from './libFileSystem';
import { csvOptions, parseCsv, scanArguments } from './libScan';
import { csvLine, openPathOrFailure } from './libStream';
import { defineClass, type NativeMethod } from './native';
import { nativeDebugInfoMethod } from './output';
import { rt } from './runtime';
import { hostPath, memoryStream, readable, type Stream, takeResourceId, writable } from './streams';
import { UnsupportedFeatureError } from './unsupported';
import { PhpArray, type PhpClass, type PhpObject, type Value } from './values';

const s = (value: Value): string => value as string;
const n = (value: Value): number => Number(value as bigint);

const DROP_NEW_LINE = 1;
const READ_AHEAD = 2;
const SKIP_EMPTY = 4;
const READ_CSV = 8;
const NOT_CONSTRUCTED = 'The parent constructor was not called: the object is in an invalid state';

/** A file that an SplFileObject opened, with the line it holds, as spl_filesystem_object keeps it. */
interface OpenFile {
  stream: Stream;
  openMode: string;
  /** The line last read, which `current` returns; `undefined` when none is held. */
  line: string | undefined;
  /** The value `current` returns instead of the line: the fields of a CSV line, or what `getCurrentLine` returned. */
  value: Value | undefined;
  lineNumber: number;
  flags: number;
  maxLineLength: number;
  delimiter: string;
  enclosure: string;
  escape: string | undefined;
  /** Whether the program never chose the escape character, which PHP 8.4 deprecates relying on. */
  escapeIsDefault: boolean;
}

/** The state of an SplFileInfo, which its constructor sets: the path as given and the directory part of it. */
class FileInfoState {
  fileName: string | undefined;
  path = '';
  fileClass = 'SplFileObject';
  infoClass = 'SplFileInfo';
  file: OpenFile | undefined;

  /** The name after the directory part, as `getFilename` returns it. */
  get baseName(): string {
    const fileName = this.fileName ?? '';
    return this.path.length > 0 && this.path.length < fileName.length ? fileName.slice(this.path.length + 1) : fileName;
  }

  debugEntries(): [string, Value][] {
    const entries: [string, Value][] = [['\0SplFileInfo\0pathName', this.fileName ?? '']];
    if (this.fileName !== undefined) entries.push(['\0SplFileInfo\0fileName', this.baseName]);
    if (this.file) {
      entries.push(
        ['\0SplFileObject\0openMode', this.file.openMode],
        ['\0SplFileObject\0delimiter', this.file.delimiter],
        ['\0SplFileObject\0enclosure', this.file.enclosure]
      );
    }
    return entries;
  }
}

function stateOf(object: PhpObject): FileInfoState {
  return object.internal as FileInfoState;
}

function initializedState(object: PhpObject): FileInfoState & { fileName: string } {
  const state = stateOf(object);
  if (state.fileName === undefined) throwError('Error', 'Object not initialized');
  return state as FileInfoState & { fileName: string };
}

function fileOf(object: PhpObject): OpenFile {
  const { file } = stateOf(object);
  if (!file) throwError('Error', NOT_CONSTRUCTED);
  return file;
}

/** Sets the path of an SplFileInfo as spl_filesystem_info_set_filename splits it. */
function setFileName(state: FileInfoState, path: string): void {
  let length = path.length;
  while (length > 1 && path[length - 1] === '/') length--;
  state.fileName = path.slice(0, length);
  while (length > 1 && path[length - 1] !== '/') length--;
  state.path = path.slice(0, Math.max(length - 1, 0));
}

/** What a path names, where a stream URL such as `php://temp` names nothing that `stat` finds. */
function kindOf(path: string): 'file' | 'directory' | undefined {
  if (path === '' || path.includes('\0') || /^[A-Za-z][\w+.-]*:\/\//.test(path)) return undefined;
  return rt().io.files.kindOf(hostPath(path));
}

/** Creates an object of a class derived from SplFileInfo by calling its constructor, as PHP's helpers do. */
function create(className: string, args: Value[]): PhpObject {
  return instantiate(findClass(className) as PhpClass, () => args.map((v) => ({ v })), rt().row, undefined);
}

const unsupportedInfo = (name: string): NativeMethod => ({
  signature: `${name}(): mixed`,
  impl: () => {
    throw new UnsupportedFeatureError(`OS に依存するファイルの情報（SplFileInfo::${name}）`);
  },
});

const infoMethods: NativeMethod[] = [
  {
    signature: '__construct(string $filename)',
    impl: ({ thisObj, args }) => {
      setFileName(stateOf(thisObj), s(args[0]));
      return null;
    },
  },
  { signature: 'getPath(): string', impl: ({ thisObj }) => initializedState(thisObj).path },
  { signature: 'getFilename(): string', impl: ({ thisObj }) => initializedState(thisObj).baseName },
  {
    signature: 'getExtension(): string',
    impl: ({ thisObj }) => {
      const name = basenameOf(initializedState(thisObj).baseName);
      const dot = name.lastIndexOf('.');
      return dot === -1 ? '' : name.slice(dot + 1);
    },
  },
  {
    signature: 'getBasename(string $suffix = ""): string',
    impl: ({ thisObj, args }) =>
      basenameOf(initializedState(thisObj).baseName, args[0] === undefined ? '' : s(args[0])),
  },
  { signature: 'getPathname(): string', impl: ({ thisObj }) => stateOf(thisObj).fileName ?? '' },
  { signature: '__toString(): string', impl: ({ thisObj }) => stateOf(thisObj).fileName ?? '' },
  {
    signature: 'getSize(): int|false',
    impl: ({ thisObj }) => {
      const { fileName } = initializedState(thisObj);
      const kind = kindOf(fileName);
      if (kind === undefined) throwError('RuntimeException', `SplFileInfo::getSize(): stat failed for ${fileName}`);
      if (kind === 'directory') return 4096n;
      return BigInt(enc(rt().io.files.readFile(hostPath(fileName))).length);
    },
  },
  {
    signature: 'getType(): string|false',
    impl: ({ thisObj }) => {
      const { fileName } = initializedState(thisObj);
      const kind = kindOf(fileName);
      if (kind === undefined) throwError('RuntimeException', `SplFileInfo::getType(): Lstat failed for ${fileName}`);
      return kind === 'file' ? 'file' : 'dir';
    },
  },
  { signature: 'isFile(): bool', impl: ({ thisObj }) => kindOf(initializedState(thisObj).fileName) === 'file' },
  { signature: 'isDir(): bool', impl: ({ thisObj }) => kindOf(initializedState(thisObj).fileName) === 'directory' },
  { signature: 'isReadable(): bool', impl: ({ thisObj }) => kindOf(initializedState(thisObj).fileName) !== undefined },
  { signature: 'isWritable(): bool', impl: ({ thisObj }) => kindOf(initializedState(thisObj).fileName) !== undefined },
  { signature: 'isLink(): bool', impl: ({ thisObj }) => (initializedState(thisObj), false) },
  {
    signature: 'getRealPath(): string|false',
    impl: ({ thisObj }) => {
      const { fileName } = initializedState(thisObj);
      return kindOf(fileName || '.') === undefined ? false : enc(resolvePath(hostPath(fileName || '.')));
    },
  },
  {
    signature: 'getFileInfo(?string $class = null): SplFileInfo',
    impl: ({ thisObj, args }) => {
      const state = initializedState(thisObj);
      return create(infoClassArgument(args[0], state.infoClass, 'getFileInfo'), [state.fileName]);
    },
  },
  {
    signature: 'getPathInfo(?string $class = null): ?SplFileInfo',
    impl: ({ thisObj, args }) => {
      const state = initializedState(thisObj);
      if (state.fileName === '') return null;
      return create(infoClassArgument(args[0], state.infoClass, 'getPathInfo'), [dirnameOf(state.fileName)]);
    },
  },
  {
    signature: 'openFile(string $mode = "r", bool $useIncludePath = false, $context = null): SplFileObject',
    impl: ({ thisObj, args }) => {
      const state = initializedState(thisObj);
      return create(state.fileClass, [state.fileName, args[0] ?? 'r']);
    },
  },
  {
    signature: 'setFileClass(string $class = SplFileObject::class): void',
    impl: ({ thisObj, args }) => {
      stateOf(thisObj).fileClass = derivedClass(args[0] ?? 'SplFileObject', 'SplFileObject', 'setFileClass');
      return null;
    },
  },
  {
    signature: 'setInfoClass(string $class = SplFileInfo::class): void',
    impl: ({ thisObj, args }) => {
      stateOf(thisObj).infoClass = derivedClass(args[0] ?? 'SplFileInfo', 'SplFileInfo', 'setInfoClass');
      return null;
    },
  },
  nativeDebugInfoMethod,
  ...['getPerms', 'getInode', 'getOwner', 'getGroup', 'getATime', 'getMTime', 'getCTime', 'isExecutable'].map(
    unsupportedInfo
  ),
  unsupportedInfo('getLinkTarget'),
];

function infoClassArgument(value: Value | undefined, fallback: string, method: string): string {
  return value === undefined || value === null ? fallback : derivedClass(value, 'SplFileInfo', method);
}

function derivedClass(value: Value, base: string, method: string): string {
  const cls = findClass(s(value));
  const baseClass = findClass(base) as PhpClass;
  if (!cls || (cls !== baseClass && !cls.isSubclassOf(baseClass))) {
    throwError(
      'TypeError',
      `SplFileInfo::${method}(): Argument #1 ($class) must be a class name derived from ${base}${method.startsWith('get') ? ' or null' : ''}, ${s(value)} given`
    );
  }
  return cls.name;
}

defineClass({
  name: 'SplFileInfo',
  interfaces: ['Stringable'],
  methods: infoMethods,
  createInternal: () => new FileInfoState(),
});

// Reading lines, as spl_directory.c does ----------------------------------------------------------------------------

function freeLine(file: OpenFile): void {
  file.line = undefined;
  file.value = undefined;
}

/** Reads the next line into the file, or fails at the end, throwing unless `silent`. */
function readLineInto(state: FileInfoState, file: OpenFile, silent: boolean, lineAdd: number, csv: boolean): boolean {
  freeLine(file);
  if (file.stream.eof) {
    if (!silent) throwError('RuntimeException', `Cannot read from file ${state.fileName ?? ''}`);
    return false;
  }
  const limit = file.maxLineLength > 0 ? file.maxLineLength : Infinity;
  const read = readable(file.stream, 'SplFileObject::fgets') ? file.stream.readLine(limit) : undefined;
  let line = read ?? '';
  if (!csv && (file.flags & DROP_NEW_LINE) !== 0 && line.endsWith('\n')) {
    line = line.slice(0, line.endsWith('\r\n') ? -2 : -1);
  }
  file.line = line;
  file.lineNumber += lineAdd;
  return true;
}

function readNext(state: FileInfoState, file: OpenFile, silent: boolean, csv: boolean): boolean {
  return readLineInto(state, file, silent, file.line === undefined ? 0 : 1, csv);
}

function isLineEmpty(file: OpenFile): boolean {
  if (file.line === undefined) return file.value === undefined;
  return (
    file.line.length === 0 ||
    ((file.flags & READ_CSV) !== 0 &&
      (file.flags & DROP_NEW_LINE) !== 0 &&
      (file.line === '\n' || file.line === '\r\n'))
  );
}

function readCsv(
  state: FileInfoState,
  file: OpenFile,
  control: Pick<OpenFile, 'delimiter' | 'enclosure' | 'escape'>,
  silent: boolean
): boolean {
  do {
    if (!readNext(state, file, silent, true)) return false;
  } while (isLineEmpty(file) && (file.flags & SKIP_EMPTY) !== 0);
  const fields = parseCsv(file.line ?? '', control.delimiter, control.enclosure, control.escape, () =>
    file.stream.readLine()
  );
  file.value = PhpArray.list(fields);
  return true;
}

function readCurrentLine(object: PhpObject, state: FileInfoState, file: OpenFile, silent: boolean): boolean {
  if ((file.flags & READ_CSV) !== 0) return readCsv(state, file, file, silent);
  const method = object.cls.findMethod('getcurrentline');
  if (method?.fn.kind === 'native') return readNext(state, file, silent, false);
  freeLine(file);
  if (file.stream.eof) {
    if (!silent) throwError('RuntimeException', `Cannot read from file ${state.fileName ?? ''}`);
    return false;
  }
  const result = callMethod(object, 'getCurrentLine', []);
  if (file.line !== undefined || file.value !== undefined) file.lineNumber++;
  freeLine(file);
  if (typeof result === 'string') file.line = result;
  else file.value = result;
  return true;
}

function readLineSkipping(object: PhpObject, state: FileInfoState, file: OpenFile, silent: boolean): boolean {
  let read = readCurrentLine(object, state, file, silent);
  while ((file.flags & SKIP_EMPTY) !== 0 && read && isLineEmpty(file)) {
    freeLine(file);
    read = readCurrentLine(object, state, file, silent);
  }
  return read;
}

function rewindFile(object: PhpObject, state: FileInfoState, file: OpenFile): void {
  if (!file.stream.isSeekable) throwError('RuntimeException', `Cannot rewind file ${state.fileName ?? ''}`);
  file.stream.seek(0);
  freeLine(file);
  file.lineNumber = 0;
  if ((file.flags & READ_AHEAD) !== 0) readLineSkipping(object, state, file, true);
}

/** The CSV control a method's arguments choose from `args[first]` on, falling back to the file's own. */
function csvControl(
  method: string,
  file: OpenFile,
  args: Value[],
  first: number
): Pick<OpenFile, 'delimiter' | 'enclosure' | 'escape'> {
  if (args[first + 2] === undefined && file.escapeIsDefault) {
    deprecated(
      `SplFileObject::${method}(): the $escape parameter must be provided, as its default value will change, either explicitly or via SplFileObject::setCsvControl()`
    );
  }
  const values: Value[] = [...args];
  values[first] ??= file.delimiter;
  values[first + 1] ??= file.enclosure;
  values[first + 2] ??= file.escape ?? '';
  const { separator, enclosure, escape } = csvOptions(`SplFileObject::${method}`, values, first);
  return { delimiter: separator, enclosure, escape };
}

// SplFileObject --------------------------------------------------------------------------------------------------------

function openFile(object: PhpObject, path: string, mode: string, stream: Stream | string): void {
  if (typeof stream === 'string') {
    throwError('RuntimeException', `SplFileObject::__construct(${path}): Failed to open stream: ${stream}`);
  }
  takeResourceId();
  const state = stateOf(object);
  setFileName(state, path);
  state.file = {
    stream,
    openMode: mode,
    line: undefined,
    value: undefined,
    lineNumber: 0,
    flags: 0,
    maxLineLength: 0,
    delimiter: ',',
    enclosure: '"',
    escape: '\\',
    escapeIsDefault: true,
  };
}

const fileMethods: NativeMethod[] = [
  {
    signature: '__construct(string $filename, string $mode = "r", bool $useIncludePath = false, $context = null)',
    impl: ({ thisObj, args }) => {
      const path = s(args[0]);
      const mode = args[1] === undefined ? 'r' : s(args[1]);
      if (kindOf(path) === 'directory') throwError('LogicException', 'Cannot use SplFileObject with directories');
      openFile(thisObj, path, mode, openPathOrFailure(path, mode));
      return null;
    },
  },
  {
    signature: 'rewind(): void',
    impl: ({ thisObj }) => {
      rewindFile(thisObj, stateOf(thisObj), fileOf(thisObj));
      return null;
    },
  },
  { signature: 'eof(): bool', impl: ({ thisObj }) => fileOf(thisObj).stream.eof },
  {
    signature: 'valid(): bool',
    impl: ({ thisObj }) => {
      const file = fileOf(thisObj);
      if ((file.flags & READ_AHEAD) !== 0) return file.line !== undefined || file.value !== undefined;
      return !file.stream.eof;
    },
  },
  ...['fgets(): string', 'getCurrentLine(): string', '__toString(): string'].map((signature): NativeMethod => ({
    signature,
    impl: ({ thisObj }) => {
      const file = fileOf(thisObj);
      readLineInto(stateOf(thisObj), file, false, 1, false);
      return file.line ?? '';
    },
  })),
  {
    signature: 'current(): string|array|false',
    impl: ({ thisObj }) => {
      const file = fileOf(thisObj);
      if (file.line === undefined && file.value === undefined) readLineSkipping(thisObj, stateOf(thisObj), file, true);
      if (file.line !== undefined && ((file.flags & READ_CSV) === 0 || file.value === undefined)) return file.line;
      return file.value ?? false;
    },
  },
  { signature: 'key(): int', impl: ({ thisObj }) => BigInt(fileOf(thisObj).lineNumber) },
  {
    signature: 'next(): void',
    impl: ({ thisObj }) => {
      const file = fileOf(thisObj);
      freeLine(file);
      if ((file.flags & READ_AHEAD) !== 0) readLineSkipping(thisObj, stateOf(thisObj), file, true);
      file.lineNumber++;
      return null;
    },
  },
  {
    signature: 'seek(int $line): void',
    impl: ({ thisObj, args }) => {
      const file = fileOf(thisObj);
      const state = stateOf(thisObj);
      const target = n(args[0]);
      if (target < 0) {
        throwError('ValueError', 'SplFileObject::seek(): Argument #1 ($line) must be greater than or equal to 0');
      }
      rewindFile(thisObj, state, file);
      for (let index = 0; index < target; index++) {
        rt().spend();
        if (!readLineSkipping(thisObj, state, file, true)) return null;
      }
      if (target > 0 && (file.flags & READ_AHEAD) === 0) {
        file.lineNumber++;
        freeLine(file);
      }
      return null;
    },
  },
  {
    signature: 'fgetc(): string|false',
    impl: ({ thisObj }) => {
      const file = fileOf(thisObj);
      freeLine(file);
      if (!readable(file.stream, 'SplFileObject::fgetc')) return false;
      const char = file.stream.read(1);
      if (char === '\n') file.lineNumber++;
      return char || false;
    },
  },
  {
    signature: 'fread(int $length): string|false',
    impl: ({ thisObj, args }) => {
      const file = fileOf(thisObj);
      if (n(args[0]) <= 0) {
        throwError('ValueError', 'SplFileObject::fread(): Argument #1 ($length) must be greater than 0');
      }
      if (!readable(file.stream, 'SplFileObject::fread')) return false;
      return file.stream.read(n(args[0]));
    },
  },
  {
    signature: String.raw`fgetcsv(string $separator = ",", string $enclosure = '"', string $escape = '\'): array|false`,
    impl: ({ thisObj, args }) => {
      const file = fileOf(thisObj);
      const control = csvControl('fgetcsv', file, args, 0);
      return readCsv(stateOf(thisObj), file, control, true) ? (file.value as Value) : false;
    },
  },
  {
    signature: String.raw`fputcsv(array $fields, string $separator = ",", string $enclosure = '"', string $escape = '\', string $eol = PHP_EOL): int|false`,
    impl: ({ thisObj, args }) => {
      const file = fileOf(thisObj);
      const { delimiter, enclosure, escape } = csvControl('fputcsv', file, args, 1);
      const eol = args[4] === undefined ? '\n' : s(args[4]);
      return writeFile(file, csvLine(args[0] as PhpArray, delimiter, enclosure, escape, eol), 'fputcsv');
    },
  },
  {
    signature: String.raw`setCsvControl(string $separator = ",", string $enclosure = '"', string $escape = '\'): void`,
    impl: ({ thisObj, args }) => {
      const file = fileOf(thisObj);
      const { separator, enclosure, escape } = csvOptions('SplFileObject::setCsvControl', args, 0);
      file.delimiter = separator;
      file.enclosure = enclosure;
      file.escape = escape;
      file.escapeIsDefault = args[2] === undefined;
      return null;
    },
  },
  {
    signature: 'getCsvControl(): array',
    impl: ({ thisObj }) => {
      const file = fileOf(thisObj);
      return PhpArray.list([file.delimiter, file.enclosure, file.escape ?? '']);
    },
  },
  {
    signature: 'fwrite(string $data, int $length = 0): int|false',
    impl: ({ thisObj, args }) => {
      const data = s(args[0]);
      const length = args[1] === undefined ? data.length : Math.min(Math.max(n(args[1]), 0), data.length);
      return writeFile(fileOf(thisObj), data.slice(0, length), 'fwrite');
    },
  },
  { signature: 'ftell(): int|false', impl: ({ thisObj }) => BigInt(fileOf(thisObj).stream.position) },
  {
    signature: 'fseek(int $offset, int $whence = SEEK_SET): int',
    impl: ({ thisObj, args }) => {
      const file = fileOf(thisObj);
      freeLine(file);
      const base = [0, file.stream.position, file.stream.length][args[1] === undefined ? 0 : n(args[1])];
      if (!file.stream.isSeekable || base === undefined || base + n(args[0]) < 0) return -1n;
      file.stream.seek(base + n(args[0]));
      return 0n;
    },
  },
  {
    signature: 'ftruncate(int $size): bool',
    impl: ({ thisObj, args }) => {
      const file = fileOf(thisObj);
      if (!file.stream.isSeekable) throwError('LogicException', `Can't truncate file ${stateOf(thisObj).fileName}`);
      if (!file.stream.mode.write) return false;
      file.stream.truncate(n(args[0]));
      return true;
    },
  },
  {
    signature: 'fpassthru(): int',
    impl: ({ thisObj }) => {
      const file = fileOf(thisObj);
      if (!readable(file.stream, 'SplFileObject::fpassthru')) return 0n;
      const rest = file.stream.readRest();
      rt().echo(rest);
      return BigInt(rest.length);
    },
  },
  {
    signature: 'fscanf(string $format, mixed &...$vars): array|int|null',
    impl: ({ thisObj, args, refs }) => {
      const file = fileOf(thisObj);
      readNext(stateOf(thisObj), file, false, false);
      return scanArguments(file.line ?? '', { args: [null, ...args], refs: [undefined, ...refs] });
    },
  },
  { signature: 'fflush(): bool', impl: ({ thisObj }) => (fileOf(thisObj), true) },
  {
    signature: 'flock(int $operation, &$wouldBlock = null): bool',
    impl: ({ thisObj, refs }) => {
      fileOf(thisObj);
      refs[1]?.assign(0n);
      return true;
    },
  },
  {
    signature: 'setFlags(int $flags): void',
    impl: ({ thisObj, args }) => {
      fileOf(thisObj).flags = n(args[0]);
      return null;
    },
  },
  { signature: 'getFlags(): int', impl: ({ thisObj }) => BigInt(fileOf(thisObj).flags) },
  {
    signature: 'setMaxLineLen(int $maxLength): void',
    impl: ({ thisObj, args }) => {
      if (n(args[0]) < 0) {
        throwError(
          'ValueError',
          'SplFileObject::setMaxLineLen(): Argument #1 ($maxLength) must be greater than or equal to 0'
        );
      }
      fileOf(thisObj).maxLineLength = n(args[0]);
      return null;
    },
  },
  { signature: 'getMaxLineLen(): int', impl: ({ thisObj }) => BigInt(fileOf(thisObj).maxLineLength) },
  { signature: 'hasChildren(): false', impl: () => false },
  { signature: 'getChildren(): null', impl: () => null },
  {
    signature: 'fstat(): array',
    impl: () => {
      throw new UnsupportedFeatureError('OS に依存するファイルの情報（SplFileObject::fstat）');
    },
  },
];

function writeFile(file: OpenFile, data: string, method: string): bigint | false {
  if (data === '') return 0n;
  if (!writable(file.stream, `SplFileObject::${method}`, data.length)) return false;
  file.stream.write(data);
  return BigInt(data.length);
}

defineClass({
  name: 'SplFileObject',
  parent: 'SplFileInfo',
  interfaces: ['RecursiveIterator', 'SeekableIterator', 'Iterator', 'Traversable'],
  consts: {
    DROP_NEW_LINE: BigInt(DROP_NEW_LINE),
    READ_AHEAD: BigInt(READ_AHEAD),
    SKIP_EMPTY: BigInt(SKIP_EMPTY),
    READ_CSV: BigInt(READ_CSV),
  },
  methods: fileMethods,
  createInternal: () => new FileInfoState(),
});

defineClass({
  name: 'SplTempFileObject',
  parent: 'SplFileObject',
  methods: [
    {
      signature: '__construct(int $maxMemory = 2097152)',
      impl: ({ thisObj, args }) => {
        const maxMemory = args[0] === undefined ? undefined : n(args[0]);
        const name =
          maxMemory === undefined ? 'php://temp' : maxMemory < 0 ? 'php://memory' : `php://temp/maxmemory:${maxMemory}`;
        openFile(thisObj, name, 'wb', memoryStream(maxMemory === undefined || maxMemory >= 0));
        stateOf(thisObj).path = '';
        return null;
      },
    },
  ],
  createInternal: () => new FileInfoState(),
});
