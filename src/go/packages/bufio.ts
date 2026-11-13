// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { decodeRune, encodeRune, RUNE_ERROR } from '../literals';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { nilPointerPanic } from '../runtimeErrors';
import { BASIC, ERROR_TYPE, funcType, pointerTo, RUNE, sliceOf } from '../types';
import { Cell, GoStruct, type NativeState, Pointer, type Slice, type Value } from '../values';
import { EOF, ERR_SHORT_WRITE, IO_READER, IO_WRITER } from './io';
import { BOOL, byteSlice, bytesOf, callMethod, INT, receiverStruct, STRING, stringPanic } from './support';
import { isSpace } from './unicodeSupport';

// Writer: transcribed from Go's bufio.go, with a buffer of 4096 bytes by default ------------------------------------

const WRITER = namedType('bufio', 'Writer', { kind: 'struct', fields: [] });

interface WriterState extends NativeState {
  writer: Value;
  buffer: string;
  size: number;
  error: Value;
}

function createWriterState(writer?: Value, size = 0, buffer = '', error?: Value): WriterState {
  const state: WriterState = {
    writer,
    buffer,
    size,
    error,
    clone: () => createWriterState(state.writer, state.size, state.buffer, state.error),
  };
  return state;
}

function writerOf(receiver: Value): WriterState {
  const struct = receiverStruct(receiver);
  struct.native ??= createWriterState();
  return struct.native as WriterState;
}

function writeThrough(state: WriterState, bytes: string): number {
  const [count, error] = callMethod(state.writer, 'Write', [byteSlice(bytes)]) as [bigint, Value];
  if (error !== undefined) state.error = error;
  return Number(count);
}

function flush(state: WriterState): Value {
  if (state.error !== undefined) return state.error;
  if (state.buffer.length === 0) return undefined;
  const written = writeThrough(state, state.buffer);
  if (written < state.buffer.length && state.error === undefined) state.error = ERR_SHORT_WRITE;
  state.buffer = state.error === undefined ? '' : state.buffer.slice(written);
  return state.error;
}

function write(state: WriterState, data: string): Value[] {
  let rest = data;
  let total = 0;
  while (rest.length > state.size - state.buffer.length && state.error === undefined) {
    let count: number;
    if (state.buffer.length === 0) {
      count = writeThrough(state, rest);
    } else {
      count = state.size - state.buffer.length;
      state.buffer += rest.slice(0, count);
      flush(state);
    }
    total += count;
    rest = rest.slice(count);
  }
  if (state.error !== undefined) return [BigInt(total), state.error];
  state.buffer += rest;
  return [BigInt(total + rest.length), undefined];
}

addMethod(
  WRITER,
  'Write',
  fn([sliceOf(BASIC.uint8)], [INT, ERROR_TYPE]),
  (receiver, [bytes]) => write(writerOf(receiver), bytesOf(bytes)),
  true
);
addMethod(
  WRITER,
  'WriteString',
  fn([STRING], [INT, ERROR_TYPE]),
  (receiver, [text]) => write(writerOf(receiver), text as string),
  true
);
addMethod(
  WRITER,
  'WriteByte',
  fn([BASIC.uint8], [ERROR_TYPE]),
  (receiver, [byte]) => write(writerOf(receiver), String.fromCharCode(Number(byte as bigint)))[1],
  true
);
addMethod(
  WRITER,
  'WriteRune',
  fn([RUNE], [INT, ERROR_TYPE]),
  (receiver, [rune]) => write(writerOf(receiver), encodeRune(Number(rune as bigint))),
  true
);
addMethod(WRITER, 'Flush', fn([], [ERROR_TYPE]), (receiver) => flush(writerOf(receiver)), true);
addMethod(WRITER, 'Buffered', fn([], [INT]), (receiver) => BigInt(writerOf(receiver).buffer.length), true);
addMethod(
  WRITER,
  'Available',
  fn([], [INT]),
  (receiver) => {
    const state = writerOf(receiver);
    return BigInt(state.size - state.buffer.length);
  },
  true
);
addMethod(WRITER, 'Size', fn([], [INT]), (receiver) => BigInt(writerOf(receiver).size), true);

function newWriter(writer: Value, size: number): Value {
  return new Pointer(new Cell(new GoStruct([], createWriterState(writer, size <= 0 ? 4096 : size))), 'v');
}

// Scanner over a reader such as strings.Reader; standard input is not available here ------------------------------

const SCANNER = namedType('bufio', 'Scanner', { kind: 'struct', fields: [] });
const SPLIT_FUNC = namedType(
  'bufio',
  'SplitFunc',
  funcType([sliceOf(BASIC.uint8), BOOL], [INT, sliceOf(BASIC.uint8), ERROR_TYPE])
);
const MAX_SCAN_TOKEN_SIZE = 65_536;
const START_BUF_SIZE = 4096;
const MAX_CONSECUTIVE_EMPTY_READS = 100;
const ERR_TOO_LONG = newError('bufio.Scanner: token too long');
const ERR_BAD_READ_COUNT = newError('bufio.Scanner: Read returned impossible count');
const ERR_NO_PROGRESS = newError('multiple Read calls return no data or error');

type Splitter = (data: string, atEOF: boolean) => [number, string | undefined];

interface ScannerState extends NativeState {
  reader: Value;
  data: string;
  bufLen: number;
  maxTokenSize: number;
  eof: boolean;
  token: string;
  error: Value;
  split: Splitter | undefined;
  done: boolean;
  scanned: boolean;
}

const scanLines: Splitter = (data, atEOF) => {
  if (atEOF && data.length === 0) return [0, undefined];
  const newline = data.indexOf('\n');
  if (newline !== -1) return [newline + 1, dropCR(data.slice(0, newline))];
  if (atEOF) return [data.length, dropCR(data)];
  return [0, undefined];
};

function dropCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

const scanWords: Splitter = (data, atEOF) => {
  let start = 0;
  while (start < data.length) {
    const { rune, size } = decodeRune(data, start);
    if (!isSpace(rune)) break;
    start += size;
  }
  for (let at = start; at < data.length;) {
    const { rune, size } = decodeRune(data, at);
    if (isSpace(rune)) return [at + size, data.slice(start, at)];
    at += size;
  }
  if (atEOF && data.length > start) return [data.length, data.slice(start)];
  return [start, undefined];
};

const scanRunes: Splitter = (data, atEOF) => {
  if (atEOF && data.length === 0) return [0, undefined];
  if (data.length === 0) return [0, undefined];
  const { rune, size } = decodeRune(data, 0);
  if (rune === RUNE_ERROR && size === 1 && !atEOF && data.length < 4) return [0, undefined];
  return [size, rune === RUNE_ERROR && size === 1 ? encodeRune(RUNE_ERROR) : data.slice(0, size)];
};

const scanBytes: Splitter = (data, atEOF) => {
  if (atEOF && data.length === 0) return [0, undefined];
  if (data.length === 0) return [0, undefined];
  return [1, data.slice(0, 1)];
};

const SPLITTERS = new Map<string, Splitter>([
  ['ScanLines', scanLines],
  ['ScanWords', scanWords],
  ['ScanRunes', scanRunes],
  ['ScanBytes', scanBytes],
]);

function createScannerState(reader?: Value, split?: Splitter, maxTokenSize = 0): ScannerState {
  const cloneFrom = (source: ScannerState): ScannerState => {
    const copy: ScannerState = {
      ...source,
      clone: () => cloneFrom(copy),
    };
    return copy;
  };
  const state: ScannerState = {
    reader,
    data: '',
    bufLen: 0,
    maxTokenSize,
    eof: false,
    token: '',
    error: undefined,
    split,
    done: false,
    scanned: false,
    clone: () => cloneFrom(state),
  };
  return state;
}

function scannerOf(receiver: Value): ScannerState {
  const struct = receiverStruct(receiver);
  struct.native ??= createScannerState();
  return struct.native as ScannerState;
}

function recordScannerError(state: ScannerState, error: Value): void {
  state.error ??= error;
}

function scan(state: ScannerState): boolean {
  if (state.done) return false;
  state.scanned = true;
  const runtime = currentRuntime();
  for (;;) {
    runtime.spend();
    if (state.data.length > 0 || state.eof) {
      if (!state.split) nilPointerPanic();
      const [advance, token] = state.split(state.data, state.eof);
      state.data = state.data.slice(advance);
      if (token !== undefined) {
        state.token = token;
        return true;
      }
    }
    if (state.eof) {
      state.done = true;
      state.token = '';
      return false;
    }
    if (state.data.length >= state.bufLen) {
      if (state.bufLen >= state.maxTokenSize) {
        recordScannerError(state, ERR_TOO_LONG);
        state.done = true;
        state.token = '';
        return false;
      }
      let newSize = state.bufLen * 2;
      if (newSize === 0) newSize = START_BUF_SIZE;
      newSize = Math.min(newSize, state.maxTokenSize);
      runtime.checkStringLength(newSize);
      state.bufLen = newSize;
    }
    for (let loop = 0; ;) {
      runtime.spend();
      const space = state.bufLen - state.data.length;
      const buffer = byteSlice('\0'.repeat(space));
      const [count, error] = callMethod(state.reader, 'Read', [buffer]) as [bigint, Value];
      const readCount = Number(count);
      if (readCount < 0 || readCount > space) {
        recordScannerError(state, ERR_BAD_READ_COUNT);
        state.eof = true;
        break;
      }
      state.data += bytesOf(buffer).slice(0, readCount);
      if (error !== undefined) {
        state.eof = true;
        if (error !== EOF) recordScannerError(state, error);
        break;
      }
      if (readCount > 0) break;
      loop++;
      if (loop > MAX_CONSECUTIVE_EMPTY_READS) {
        recordScannerError(state, ERR_NO_PROGRESS);
        state.eof = true;
        break;
      }
    }
  }
}

addMethod(SCANNER, 'Scan', fn([], [BOOL]), (receiver) => scan(scannerOf(receiver)), true);
addMethod(SCANNER, 'Text', fn([], [STRING]), (receiver) => scannerOf(receiver).token, true);
addMethod(SCANNER, 'Bytes', fn([], [sliceOf(BASIC.uint8)]), (receiver) => byteSlice(scannerOf(receiver).token), true);
addMethod(SCANNER, 'Err', fn([], [ERROR_TYPE]), (receiver) => scannerOf(receiver).error, true);
addMethod(
  SCANNER,
  'Buffer',
  fn([sliceOf(BASIC.uint8), INT], []),
  (receiver, [buf, max]) => {
    const state = scannerOf(receiver);
    if (state.scanned) stringPanic('Buffer called after Scan');
    const cap = (buf as Slice | undefined)?.capacity ?? 0;
    currentRuntime().checkStringLength(cap);
    state.bufLen = cap;
    state.maxTokenSize = Number(max as bigint);
    return;
  },
  true
);
addMethod(
  SCANNER,
  'Split',
  fn([SPLIT_FUNC], []),
  (receiver, [split]) => {
    const state = scannerOf(receiver);
    if (state.scanned) stringPanic('Split called after Scan');
    if (split === undefined) {
      state.split = undefined;
      return;
    }
    const name = [...SPLITTERS.entries()].find(
      ([, splitter]) => (split as { splitter?: Splitter } | undefined)?.splitter === splitter
    )?.[0];
    if (!name) stringPanic('bufio.Scanner.Split: own split functions are not available here');
    state.split = SPLITTERS.get(name) as Splitter;
    return;
  },
  true
);

function splitFunction(name: string): Entity {
  const splitter = SPLITTERS.get(name) as Splitter;
  const entity = nativeFunction(name, SPLIT_FUNC.underlying as ReturnType<typeof fn>, ([data, atEOF]) => {
    const [advance, token] = splitter(bytesOf(data), atEOF as boolean);
    return [BigInt(advance), token === undefined ? undefined : byteSlice(token), undefined];
  });
  const value = entity.kind === 'func' ? entity.value() : undefined;
  if (value) (value as unknown as { splitter: Splitter }).splitter = splitter;
  return entity;
}

const members: Record<string, Entity> = {
  Writer: typeEntity(WRITER),
  Scanner: typeEntity(SCANNER),
  SplitFunc: typeEntity(SPLIT_FUNC),
  NewWriter: nativeFunction('NewWriter', fn([IO_WRITER], [pointerTo(WRITER)]), ([writer]) => newWriter(writer, 4096)),
  NewWriterSize: nativeFunction('NewWriterSize', fn([IO_WRITER, INT], [pointerTo(WRITER)]), ([writer, size]) =>
    newWriter(writer, Number(size as bigint))
  ),
  NewScanner: nativeFunction(
    'NewScanner',
    fn([IO_READER], [pointerTo(SCANNER)]),
    ([reader]) =>
      new Pointer(new Cell(new GoStruct([], createScannerState(reader, scanLines, MAX_SCAN_TOKEN_SIZE))), 'v')
  ),
  ScanLines: splitFunction('ScanLines'),
  ScanWords: splitFunction('ScanWords'),
  ScanRunes: splitFunction('ScanRunes'),
  ScanBytes: splitFunction('ScanBytes'),
  ErrTooLong: {
    kind: 'var',
    name: 'ErrTooLong',
    type: ERROR_TYPE,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => ERR_TOO_LONG,
  },
  MaxScanTokenSize: {
    kind: 'const',
    name: 'MaxScanTokenSize',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: BigInt(MAX_SCAN_TOKEN_SIZE) },
    span: { row: 0, column: 0 },
    used: true,
  },
};

export const BUFIO_PACKAGE = definePackage('bufio', members, [
  'Reader',
  'NewReader',
  'NewReaderSize',
  'ReadWriter',
  'NewReadWriter',
]);
