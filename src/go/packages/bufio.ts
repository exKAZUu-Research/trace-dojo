// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { decodeRune, encodeRune, RUNE_ERROR } from '../literals';
import { addMethod, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { GoPanic } from '../runtime';
import { BASIC, ERROR_TYPE, funcType, pointerTo, RUNE, sliceOf } from '../types';
import { Cell, GoStruct, Pointer, type Value } from '../values';
import { EOF, IO_READER, IO_WRITER } from './io';
import { BOOL, byteSlice, bytesOf, callMethod, INT, STRING } from './support';
import { isSpace } from './unicodeSupport';

// Writer: transcribed from Go's bufio.go, with a buffer of 4096 bytes by default ------------------------------------

const WRITER = namedType('bufio', 'Writer', { kind: 'struct', fields: [] });

interface WriterState {
  writer: Value;
  buffer: string;
  size: number;
  error: Value;
}

function writerOf(receiver: Value): WriterState {
  return ((receiver as Pointer).load() as GoStruct).native?.bufioWriter as WriterState;
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
  if (written < state.buffer.length && state.error === undefined) state.error = newError('short write');
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
  const state: WriterState = { writer, buffer: '', size: size <= 0 ? 4096 : size, error: undefined };
  return new Pointer(new Cell(new GoStruct([], { bufioWriter: state })), 'v');
}

// Scanner over a reader such as strings.Reader; standard input is not available here ------------------------------

const SCANNER = namedType('bufio', 'Scanner', { kind: 'struct', fields: [] });
const SPLIT_FUNC = namedType(
  'bufio',
  'SplitFunc',
  funcType([sliceOf(BASIC.uint8), BOOL], [INT, sliceOf(BASIC.uint8), ERROR_TYPE])
);

type Splitter = (data: string, atEOF: boolean) => [number, string | undefined];

interface ScannerState {
  reader: Value;
  data: string;
  eof: boolean;
  token: string;
  error: Value;
  split: Splitter;
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

function scannerOf(receiver: Value): ScannerState {
  return ((receiver as Pointer).load() as GoStruct).native?.scanner as ScannerState;
}

function scan(state: ScannerState): boolean {
  if (state.done) return false;
  state.scanned = true;
  for (;;) {
    const [advance, token] = state.split(state.data, state.eof);
    if (token !== undefined) {
      state.data = state.data.slice(advance);
      state.token = token;
      return true;
    }
    state.data = state.data.slice(advance);
    if (state.eof) {
      state.done = true;
      state.token = '';
      return false;
    }
    const buffer = byteSlice('\0'.repeat(4096));
    const [count, error] = callMethod(state.reader, 'Read', [buffer]) as [bigint, Value];
    state.data += bytesOf(buffer).slice(0, Number(count));
    if (error !== undefined) {
      state.eof = true;
      if (error !== EOF) state.error = error;
    }
  }
}

addMethod(SCANNER, 'Scan', fn([], [BOOL]), (receiver) => scan(scannerOf(receiver)), true);
addMethod(SCANNER, 'Text', fn([], [STRING]), (receiver) => scannerOf(receiver).token, true);
addMethod(SCANNER, 'Bytes', fn([], [sliceOf(BASIC.uint8)]), (receiver) => byteSlice(scannerOf(receiver).token), true);
addMethod(SCANNER, 'Err', fn([], [ERROR_TYPE]), (receiver) => scannerOf(receiver).error, true);
addMethod(SCANNER, 'Buffer', fn([sliceOf(BASIC.uint8), INT], []), () => {}, true);
addMethod(
  SCANNER,
  'Split',
  fn([SPLIT_FUNC], []),
  (receiver, [split]) => {
    const state = scannerOf(receiver);
    if (state.scanned) throw new GoPanic(newError('Split called after Scan'));
    const name = [...SPLITTERS.entries()].find(
      ([, splitter]) => (split as { splitter?: Splitter } | undefined)?.splitter === splitter
    )?.[0];
    if (!name) throw new GoPanic(newError('bufio.Scanner.Split: own split functions are not available here'));
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
  NewScanner: nativeFunction('NewScanner', fn([IO_READER], [pointerTo(SCANNER)]), ([reader]) => {
    const state: ScannerState = {
      reader,
      data: '',
      eof: false,
      token: '',
      error: undefined,
      split: scanLines,
      done: false,
      scanned: false,
    };
    return new Pointer(new Cell(new GoStruct([], { scanner: state })), 'v');
  }),
  ScanLines: splitFunction('ScanLines'),
  ScanWords: splitFunction('ScanWords'),
  ScanRunes: splitFunction('ScanRunes'),
  ScanBytes: splitFunction('ScanBytes'),
  MaxScanTokenSize: {
    kind: 'const',
    name: 'MaxScanTokenSize',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: 65_536n },
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
  'ErrTooLong',
]);
