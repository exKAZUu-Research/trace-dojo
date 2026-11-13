// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { assignFailure } from '../assignability';
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { decodeRune, encodeRune, RUNE_ERROR } from '../literals';
import {
  addMethod,
  currentRuntime,
  definePackage,
  fn,
  namedType,
  nativeFunction,
  opaqueType,
  typeEntity,
} from '../native';
import { GoPanic } from '../runtime';
import { BASIC, ERROR_TYPE, funcType, identical, type NamedType, pointerTo, RUNE, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import {
  EOF,
  ERR_NO_PROGRESS,
  ERR_SHORT_WRITE,
  IO_READER,
  IO_READER_FROM,
  IO_STRING_WRITER,
  IO_WRITER,
  libraryVariable,
  sameError,
} from './io';
import { BOOL, BYTES, callFunction, callMethod, INT, receiverStruct, spendFor, STRING, stringPanic } from './support';
import { fullRune } from './unicode';

const DEFAULT_BUF_SIZE = 4096;
const MIN_READ_BUFFER_SIZE = 16;
const MAX_CONSECUTIVE_EMPTY_READS = 100;
const MAX_SCAN_TOKEN_SIZE = 65_536;
const START_BUF_SIZE = 4096;

const ERR_BUFFER_FULL = newError('bufio: buffer full');
const ERR_NEGATIVE_COUNT = newError('bufio: negative count');
const ERR_INVALID_UNREAD_BYTE = newError('bufio: invalid use of UnreadByte');
const ERR_INVALID_UNREAD_RUNE = newError('bufio: invalid use of UnreadRune');
const ERR_NEGATIVE_READ = newError('bufio: reader returned negative count from Read');
const ERR_NEGATIVE_WRITE = newError('bufio: writer returned negative count from Write');
const ERR_TOO_LONG = newError('bufio.Scanner: token too long');
const ERR_NEGATIVE_ADVANCE = newError('bufio.Scanner: SplitFunc returns negative advance count');
const ERR_ADVANCE_TOO_FAR = newError('bufio.Scanner: SplitFunc returns advance count beyond input');
const ERR_BAD_READ_COUNT = newError('bufio.Scanner: Read returned impossible count');
const ERR_FINAL_TOKEN = newError('final token');

/**
 * A bufio type with Go's fields, transcribed with Go's methods, so that copying a value shares its buffer's backing
 * array as Go's slice semantics do.
 */
function structType(name: string, fields: [string, Type][]): NamedType {
  return opaqueType(
    namedType('bufio', name, {
      kind: 'struct',
      fields: fields.map(([fieldName, type]) => ({ name: fieldName, type, embedded: false })),
    })
  );
}

// Writer --------------------------------------------------------------------------------------------------------------

const WRITER = structType('Writer', [
  ['err', ERROR_TYPE],
  ['buf', BYTES],
  ['n', INT],
  ['wr', IO_WRITER],
]);
const WRITER_POINTER = pointerTo(WRITER);

/** The fields of a `*bufio.Writer`. */
class WriterFields {
  private readonly fields: Value[];

  constructor(receiver: Value) {
    this.fields = receiverStruct(receiver).fields;
  }

  get err(): Value {
    return this.fields[0];
  }

  set err(value: Value) {
    this.fields[0] = value;
  }

  get buf(): Value {
    return this.fields[1];
  }

  set buf(value: Value) {
    this.fields[1] = value;
  }

  get n(): number {
    return Number(this.fields[2] as bigint);
  }

  set n(value: number) {
    this.fields[2] = BigInt(value);
  }

  get wr(): Value {
    return this.fields[3];
  }

  set wr(value: Value) {
    this.fields[3] = value;
  }

  available(): number {
    return lengthOf(this.buf) - this.n;
  }

  flush(): Value {
    if (this.err !== undefined) return this.err;
    if (this.n === 0) return undefined;
    const [written, writeError] = callMethod(this.wr, 'Write', [sub(this.buf, 0, this.n)]) as [bigint, Value];
    const count = Number(written);
    let error = writeError;
    if (count < this.n && error === undefined) error = ERR_SHORT_WRITE;
    if (error !== undefined) {
      if (count > 0 && count < this.n) copyBytes(sub(this.buf, 0, this.n - count), sub(this.buf, count, this.n));
      this.n -= count;
      this.err = error;
      return error;
    }
    this.n = 0;
    return undefined;
  }

  /** `Write` and `WriteString`; a string goes straight to an underlying io.StringWriter when nothing is buffered. */
  write(data: Value): Value[] {
    let rest = data;
    let total = 0;
    const isString = typeof data === 'string';
    let stringWriter = isString;
    let checked = false;
    const restLength = (): number => (typeof rest === 'string' ? rest.length : lengthOf(rest));
    while (restLength() > this.available() && this.err === undefined) {
      let count: number;
      if (isString && this.n === 0 && !checked) {
        checked = true;
        stringWriter = implementsInterface(this.wr, IO_STRING_WRITER);
      }
      if (this.n === 0 && (isString ? stringWriter : true)) {
        const method = isString ? 'WriteString' : 'Write';
        const [written, error] = callMethod(this.wr, method, [rest]) as [bigint, Value];
        count = Number(written);
        this.err = error;
      } else {
        count = copyBytes(sub(this.buf, this.n), rest);
        this.n += count;
        this.flush();
      }
      total += count;
      rest = typeof rest === 'string' ? rest.slice(count) : sub(rest, count);
    }
    if (this.err !== undefined) return [BigInt(total), this.err];
    const count = copyBytes(sub(this.buf, this.n), rest);
    this.n += count;
    return [BigInt(total + count), undefined];
  }

  writeByte(byte: number): Value {
    if (this.err !== undefined) return this.err;
    if (this.available() <= 0 && this.flush() !== undefined) return this.err;
    (this.buf as Slice).set(this.n, BigInt(byte));
    this.n += 1;
    return undefined;
  }
}

addMethod(
  WRITER,
  'Write',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [bytes]) => new WriterFields(receiver).write(bytes),
  true
);
addMethod(
  WRITER,
  'WriteString',
  fn([STRING], [INT, ERROR_TYPE]),
  (receiver, [text]) => new WriterFields(receiver).write(text),
  true
);
addMethod(
  WRITER,
  'WriteByte',
  fn([BASIC.uint8], [ERROR_TYPE]),
  (receiver, [byte]) => new WriterFields(receiver).writeByte(Number(byte as bigint)),
  true
);
addMethod(
  WRITER,
  'WriteRune',
  fn([RUNE], [INT, ERROR_TYPE]),
  (receiver, [runeValue]) => {
    const writer = new WriterFields(receiver);
    const rune = Number(runeValue as bigint);
    if (rune >= 0 && rune < 0x80) {
      const error = writer.writeByte(rune);
      return error === undefined ? [1n, undefined] : [0n, error];
    }
    if (writer.err !== undefined) return [0n, writer.err];
    const encoded = encodeRune(rune);
    if (writer.available() < 4) {
      writer.flush();
      if (writer.err !== undefined) return [0n, writer.err];
      if (writer.available() < 4) return writer.write(encoded);
    }
    copyBytes(sub(writer.buf, writer.n), encoded);
    writer.n += encoded.length;
    return [BigInt(encoded.length), undefined];
  },
  true
);
addMethod(WRITER, 'Flush', fn([], [ERROR_TYPE]), (receiver) => new WriterFields(receiver).flush(), true);
addMethod(WRITER, 'Buffered', fn([], [INT]), (receiver) => BigInt(new WriterFields(receiver).n), true);
addMethod(WRITER, 'Available', fn([], [INT]), (receiver) => BigInt(new WriterFields(receiver).available()), true);
addMethod(
  WRITER,
  'AvailableBuffer',
  fn([], [BYTES]),
  (receiver) => {
    const writer = new WriterFields(receiver);
    return sub(sub(writer.buf, writer.n), 0, 0);
  },
  true
);
addMethod(WRITER, 'Size', fn([], [INT]), (receiver) => BigInt(lengthOf(new WriterFields(receiver).buf)), true);
addMethod(
  WRITER,
  'Reset',
  fn([IO_WRITER], []),
  (receiver, [target]) => {
    if (target instanceof Iface && identical(target.type, WRITER_POINTER) && target.value === receiver) return;
    const writer = new WriterFields(receiver);
    writer.buf ??= makeBytes(DEFAULT_BUF_SIZE);
    writer.err = undefined;
    writer.n = 0;
    writer.wr = target;
    return;
  },
  true
);
addMethod(
  WRITER,
  'ReadFrom',
  fn([IO_READER], [BASIC.int64, ERROR_TYPE]),
  (receiver, [reader]) => {
    const writer = new WriterFields(receiver);
    if (writer.err !== undefined) return [0n, writer.err];
    let total = 0;
    let error: Value;
    const readerFrom = implementsInterface(writer.wr, IO_READER_FROM);
    for (;;) {
      if (writer.available() === 0) {
        const flushError = writer.flush();
        if (flushError !== undefined) return [BigInt(total), flushError];
      }
      if (readerFrom && writer.n === 0) {
        const [count, readError] = callMethod(writer.wr, 'ReadFrom', [reader]) as [bigint, Value];
        writer.err = readError;
        return [BigInt(total) + count, readError];
      }
      let reads = 0;
      let count = 0;
      while (reads < MAX_CONSECUTIVE_EMPTY_READS) {
        currentRuntime().spend();
        [count, error] = readInto(reader, sub(writer.buf, writer.n));
        if (count !== 0 || error !== undefined) break;
        reads++;
      }
      if (reads === MAX_CONSECUTIVE_EMPTY_READS) return [BigInt(total), ERR_NO_PROGRESS];
      writer.n += count;
      total += count;
      if (error !== undefined) break;
    }
    if (sameError(error, EOF)) error = writer.available() === 0 ? writer.flush() : undefined;
    return [BigInt(total), error];
  },
  true
);

function implementsInterface(value: Value, type: Type): boolean {
  return value instanceof Iface && assignFailure(value.type, type) === undefined;
}

function readInto(reader: Value, buffer: Value): [number, Value] {
  const [count, error] = callMethod(reader, 'Read', [buffer]) as [bigint, Value];
  return [Number(count), error];
}

function newWriter(target: Value, size: number): Value {
  if (
    target instanceof Iface &&
    identical(target.type, WRITER_POINTER) &&
    lengthOf(new WriterFields(target.value).buf) >= size
  ) {
    return target.value;
  }
  return newStruct([undefined, makeBytes(size <= 0 ? DEFAULT_BUF_SIZE : size), 0n, target]);
}

function newStruct(fields: Value[]): Value {
  return new Pointer(new Cell(new GoStruct(fields)), 'v');
}

// Reader --------------------------------------------------------------------------------------------------------------

const READER = structType('Reader', [
  ['buf', BYTES],
  ['rd', IO_READER],
  ['r', INT],
  ['w', INT],
  ['err', ERROR_TYPE],
  ['lastByte', INT],
  ['lastRuneSize', INT],
]);
const READER_POINTER = pointerTo(READER);

/** The fields of a `*bufio.Reader`. */
class ReaderFields {
  private readonly fields: Value[];

  constructor(receiver: Value) {
    this.fields = receiverStruct(receiver).fields;
  }

  get buf(): Value {
    return this.fields[0];
  }

  get rd(): Value {
    return this.fields[1];
  }

  get r(): number {
    return Number(this.fields[2] as bigint);
  }

  set r(value: number) {
    this.fields[2] = BigInt(value);
  }

  get w(): number {
    return Number(this.fields[3] as bigint);
  }

  set w(value: number) {
    this.fields[3] = BigInt(value);
  }

  get err(): Value {
    return this.fields[4];
  }

  set err(value: Value) {
    this.fields[4] = value;
  }

  set lastByte(value: number) {
    this.fields[5] = BigInt(value);
  }

  get lastByte(): number {
    return Number(this.fields[5] as bigint);
  }

  set lastRuneSize(value: number) {
    this.fields[6] = BigInt(value);
  }

  get lastRuneSize(): number {
    return Number(this.fields[6] as bigint);
  }

  reset(buf: Value, rd: Value): void {
    this.fields.splice(0, 7, buf, rd, 0n, 0n, undefined, -1n, -1n);
  }

  buffered(): number {
    return this.w - this.r;
  }

  readErr(): Value {
    const error = this.err;
    this.err = undefined;
    return error;
  }

  fill(): void {
    if (this.r > 0) {
      copyBytes(this.buf, sub(this.buf, this.r, this.w));
      this.w -= this.r;
      this.r = 0;
    }
    if (this.w >= lengthOf(this.buf)) stringPanic('bufio: tried to fill full buffer');
    for (let tries = MAX_CONSECUTIVE_EMPTY_READS; tries > 0; tries--) {
      currentRuntime().spend();
      const [count, error] = readInto(this.rd, sub(this.buf, this.w));
      if (count < 0) negativeCountPanic(ERR_NEGATIVE_READ);
      this.w += count;
      if (error !== undefined) {
        this.err = error;
        return;
      }
      if (count > 0) return;
    }
    this.err = ERR_NO_PROGRESS;
  }

  readSlice(delim: number): [Value, Value] {
    let searched = 0;
    let line: Value;
    let error: Value;
    for (;;) {
      const found = indexByte(this.buf, this.r + searched, this.w, delim);
      if (found >= 0) {
        const end = this.r + searched + found + 1;
        line = sub(this.buf, this.r, end);
        this.r = end;
        break;
      }
      if (this.err !== undefined) {
        line = sub(this.buf, this.r, this.w);
        this.r = this.w;
        error = this.readErr();
        break;
      }
      if (this.buffered() >= lengthOf(this.buf)) {
        this.r = this.w;
        line = this.buf;
        error = ERR_BUFFER_FULL;
        break;
      }
      searched = this.w - this.r;
      this.fill();
    }
    const length = lengthOf(line);
    if (length > 0) {
      this.lastByte = byteAt(line, length - 1);
      this.lastRuneSize = -1;
    }
    return [line, error];
  }

  /** The text up to and including `delim`, which `ReadBytes` and `ReadString` collect across full buffers. */
  collect(delim: number): [string, Value] {
    let text = '';
    for (;;) {
      const [fragment, error] = this.readSlice(delim);
      currentRuntime().checkStringLength(text.length + lengthOf(fragment));
      text += textOf(fragment);
      if (!sameError(error, ERR_BUFFER_FULL)) return [text, error];
    }
  }

  writeBuf(writer: Value): [number, Value] {
    const [written, error] = callMethod(writer, 'Write', [sub(this.buf, this.r, this.w)]) as [bigint, Value];
    const count = Number(written);
    if (count < 0) negativeCountPanic(ERR_NEGATIVE_WRITE);
    this.r += count;
    return [count, error];
  }
}

function newReader(source: Value, size: number): Value {
  if (
    source instanceof Iface &&
    identical(source.type, READER_POINTER) &&
    lengthOf(new ReaderFields(source.value).buf) >= size
  ) {
    return source.value;
  }
  return newStruct([makeBytes(Math.max(size, MIN_READ_BUFFER_SIZE)), source, 0n, 0n, undefined, -1n, -1n]);
}

addMethod(READER, 'Size', fn([], [INT]), (receiver) => BigInt(lengthOf(new ReaderFields(receiver).buf)), true);
addMethod(READER, 'Buffered', fn([], [INT]), (receiver) => BigInt(new ReaderFields(receiver).buffered()), true);
addMethod(
  READER,
  'Reset',
  fn([IO_READER], []),
  (receiver, [source]) => {
    if (source instanceof Iface && identical(source.type, READER_POINTER) && source.value === receiver) return;
    const reader = new ReaderFields(receiver);
    reader.reset(reader.buf ?? makeBytes(DEFAULT_BUF_SIZE), source);
    return;
  },
  true
);
addMethod(
  READER,
  'Peek',
  fn([INT], [BYTES, ERROR_TYPE]),
  (receiver, [count]) => {
    const reader = new ReaderFields(receiver);
    let n = Number(count as bigint);
    if (n < 0) return [undefined, ERR_NEGATIVE_COUNT];
    reader.lastByte = -1;
    reader.lastRuneSize = -1;
    const size = lengthOf(reader.buf);
    while (reader.buffered() < n && reader.buffered() < size && reader.err === undefined) reader.fill();
    if (n > size) return [sub(reader.buf, reader.r, reader.w), ERR_BUFFER_FULL];
    let error: Value;
    const available = reader.buffered();
    if (available < n) {
      n = available;
      error = reader.readErr() ?? ERR_BUFFER_FULL;
    }
    return [sub(reader.buf, reader.r, reader.r + n), error];
  },
  true
);
addMethod(
  READER,
  'Discard',
  fn([INT], [INT, ERROR_TYPE]),
  (receiver, [count]) => {
    const reader = new ReaderFields(receiver);
    const n = Number(count as bigint);
    if (n < 0) return [0n, ERR_NEGATIVE_COUNT];
    if (n === 0) return [0n, undefined];
    reader.lastByte = -1;
    reader.lastRuneSize = -1;
    let remain = n;
    for (;;) {
      let skip = reader.buffered();
      if (skip === 0) {
        reader.fill();
        skip = reader.buffered();
      }
      skip = Math.min(skip, remain);
      reader.r += skip;
      remain -= skip;
      if (remain === 0) return [BigInt(n), undefined];
      if (reader.err !== undefined) return [BigInt(n - remain), reader.readErr()];
    }
  },
  true
);
addMethod(
  READER,
  'Read',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [p]) => {
    const reader = new ReaderFields(receiver);
    const length = lengthOf(p);
    if (length === 0) return reader.buffered() > 0 ? [0n, undefined] : [0n, reader.readErr()];
    if (reader.r === reader.w) {
      if (reader.err !== undefined) return [0n, reader.readErr()];
      if (length >= lengthOf(reader.buf)) {
        const [count, error] = readInto(reader.rd, p);
        reader.err = error;
        if (count < 0) negativeCountPanic(ERR_NEGATIVE_READ);
        if (count > 0) {
          reader.lastByte = byteAt(p, count - 1);
          reader.lastRuneSize = -1;
        }
        return [BigInt(count), reader.readErr()];
      }
      reader.r = 0;
      reader.w = 0;
      const [count, error] = readInto(reader.rd, reader.buf);
      reader.err = error;
      if (count < 0) negativeCountPanic(ERR_NEGATIVE_READ);
      if (count === 0) return [0n, reader.readErr()];
      reader.w += count;
    }
    const count = copyBytes(p, sub(reader.buf, reader.r, reader.w));
    reader.r += count;
    reader.lastByte = byteAt(reader.buf, reader.r - 1);
    reader.lastRuneSize = -1;
    return [BigInt(count), undefined];
  },
  true
);
addMethod(
  READER,
  'ReadByte',
  fn([], [BASIC.uint8, ERROR_TYPE]),
  (receiver) => {
    const reader = new ReaderFields(receiver);
    reader.lastRuneSize = -1;
    while (reader.r === reader.w) {
      if (reader.err !== undefined) return [0n, reader.readErr()];
      reader.fill();
    }
    const byte = byteAt(reader.buf, reader.r);
    reader.r += 1;
    reader.lastByte = byte;
    return [BigInt(byte), undefined];
  },
  true
);
addMethod(
  READER,
  'UnreadByte',
  fn([], [ERROR_TYPE]),
  (receiver) => {
    const reader = new ReaderFields(receiver);
    if (reader.lastByte < 0 || (reader.r === 0 && reader.w > 0)) return ERR_INVALID_UNREAD_BYTE;
    if (reader.r > 0) reader.r -= 1;
    else reader.w = 1;
    (reader.buf as Slice).set(reader.r, BigInt(reader.lastByte));
    reader.lastByte = -1;
    reader.lastRuneSize = -1;
    return;
  },
  true
);
addMethod(
  READER,
  'ReadRune',
  fn([], [RUNE, INT, ERROR_TYPE]),
  (receiver) => {
    const reader = new ReaderFields(receiver);
    while (
      reader.r + 4 > reader.w &&
      !fullRune(textOf(reader.buf, reader.r, Math.min(reader.w, reader.r + 4))) &&
      reader.err === undefined &&
      reader.buffered() < lengthOf(reader.buf)
    ) {
      reader.fill();
    }
    reader.lastRuneSize = -1;
    if (reader.r === reader.w) return [0n, 0n, reader.readErr()];
    const { rune, size } = runeAt(reader.buf, reader.r, reader.w);
    reader.r += size;
    reader.lastByte = byteAt(reader.buf, reader.r - 1);
    reader.lastRuneSize = size;
    return [BigInt(rune), BigInt(size), undefined];
  },
  true
);
addMethod(
  READER,
  'UnreadRune',
  fn([], [ERROR_TYPE]),
  (receiver) => {
    const reader = new ReaderFields(receiver);
    if (reader.lastRuneSize < 0 || reader.r < reader.lastRuneSize) return ERR_INVALID_UNREAD_RUNE;
    reader.r -= reader.lastRuneSize;
    reader.lastByte = -1;
    reader.lastRuneSize = -1;
    return;
  },
  true
);
addMethod(
  READER,
  'ReadSlice',
  fn([BASIC.uint8], [BYTES, ERROR_TYPE]),
  (receiver, [delim]) => new ReaderFields(receiver).readSlice(Number(delim as bigint)),
  true
);
addMethod(
  READER,
  'ReadLine',
  fn([], [BYTES, BOOL, ERROR_TYPE]),
  (receiver) => {
    const reader = new ReaderFields(receiver);
    let [line, error] = reader.readSlice(0x0a);
    let length = lengthOf(line);
    if (sameError(error, ERR_BUFFER_FULL)) {
      if (length > 0 && byteAt(line, length - 1) === 0x0d) {
        if (reader.r === 0) stringPanic('bufio: tried to rewind past start of buffer');
        reader.r -= 1;
        line = sub(line, 0, length - 1);
      }
      return [line, true, undefined];
    }
    if (length === 0) return [error === undefined ? line : undefined, false, error];
    error = undefined;
    if (byteAt(line, length - 1) === 0x0a) {
      const drop = length > 1 && byteAt(line, length - 2) === 0x0d ? 2 : 1;
      length -= drop;
      line = sub(line, 0, length);
    }
    return [line, false, error];
  },
  true
);
addMethod(
  READER,
  'ReadBytes',
  fn([BASIC.uint8], [BYTES, ERROR_TYPE]),
  (receiver, [delim]) => {
    const [text, error] = new ReaderFields(receiver).collect(Number(delim as bigint));
    const bytes = makeBytes(text.length);
    copyBytes(bytes, text);
    return [bytes, error];
  },
  true
);
addMethod(
  READER,
  'ReadString',
  fn([BASIC.uint8], [STRING, ERROR_TYPE]),
  (receiver, [delim]) => new ReaderFields(receiver).collect(Number(delim as bigint)),
  true
);
addMethod(
  READER,
  'WriteTo',
  fn([IO_WRITER], [BASIC.int64, ERROR_TYPE]),
  (receiver, [writer]) => {
    const reader = new ReaderFields(receiver);
    reader.lastByte = -1;
    reader.lastRuneSize = -1;
    let total = 0;
    if (reader.r < reader.w) {
      const [count, error] = reader.writeBuf(writer);
      total += count;
      if (error !== undefined) return [BigInt(total), error];
    }
    if (reader.buffered() < lengthOf(reader.buf)) reader.fill();
    while (reader.r < reader.w) {
      const [count, error] = reader.writeBuf(writer);
      total += count;
      if (error !== undefined) return [BigInt(total), error];
      reader.fill();
    }
    if (sameError(reader.err, EOF)) reader.err = undefined;
    return [BigInt(total), reader.readErr()];
  },
  true
);

// Scanner -------------------------------------------------------------------------------------------------------------

const SPLIT_FUNC = namedType('bufio', 'SplitFunc', funcType([BYTES, BOOL], [INT, BYTES, ERROR_TYPE]));

const SCANNER = structType('Scanner', [
  ['r', IO_READER],
  ['split', SPLIT_FUNC],
  ['maxTokenSize', INT],
  ['token', BYTES],
  ['buf', BYTES],
  ['start', INT],
  ['end', INT],
  ['err', ERROR_TYPE],
  ['empties', INT],
  ['scanCalled', BOOL],
  ['done', BOOL],
]);

/** The indexes of the Scanner's fields. */
const S = {
  R: 0,
  Split: 1,
  MaxTokenSize: 2,
  Token: 3,
  Buf: 4,
  Start: 5,
  End: 6,
  Err: 7,
  Empties: 8,
  ScanCalled: 9,
  Done: 10,
} as const;

function num(fields: Value[], index: number): number {
  return Number(fields[index] as bigint);
}

function setErr(fields: Value[], error: Value): void {
  if (fields[S.Err] === undefined || sameError(fields[S.Err], EOF)) fields[S.Err] = error;
}

// code-gauge-allow functionCognitiveComplexity 40 -- A transcription of Go's Scanner.Scan.
function scan(fields: Value[]): boolean {
  if (fields[S.Done]) return false;
  fields[S.ScanCalled] = true;
  const runtime = currentRuntime();
  for (;;) {
    runtime.spend();
    if (num(fields, S.End) > num(fields, S.Start) || fields[S.Err] !== undefined) {
      const [advanceValue, token, error] = callFunction(fields[S.Split], [
        sub(fields[S.Buf], num(fields, S.Start), num(fields, S.End)),
        fields[S.Err] !== undefined,
      ]) as [bigint, Value, Value];
      if (error !== undefined) {
        if (sameError(error, ERR_FINAL_TOKEN)) {
          fields[S.Token] = token;
          fields[S.Done] = true;
          return token !== undefined;
        }
        setErr(fields, error);
        return false;
      }
      const advance = Number(advanceValue);
      if (advance < 0) {
        setErr(fields, ERR_NEGATIVE_ADVANCE);
        return false;
      }
      if (advance > num(fields, S.End) - num(fields, S.Start)) {
        setErr(fields, ERR_ADVANCE_TOO_FAR);
        return false;
      }
      fields[S.Start] = BigInt(num(fields, S.Start) + advance);
      fields[S.Token] = token;
      if (token !== undefined) {
        if (fields[S.Err] === undefined || advance > 0) {
          fields[S.Empties] = 0n;
        } else {
          fields[S.Empties] = BigInt(num(fields, S.Empties) + 1);
          if (num(fields, S.Empties) > MAX_CONSECUTIVE_EMPTY_READS)
            stringPanic('bufio.Scan: too many empty tokens without progressing');
        }
        return true;
      }
    }
    if (fields[S.Err] !== undefined) {
      fields[S.Start] = 0n;
      fields[S.End] = 0n;
      return false;
    }
    const start = num(fields, S.Start);
    const size = lengthOf(fields[S.Buf]);
    if (start > 0 && (num(fields, S.End) === size || start > Math.floor(size / 2))) {
      copyBytes(fields[S.Buf], sub(fields[S.Buf], start, num(fields, S.End)));
      fields[S.End] = BigInt(num(fields, S.End) - start);
      fields[S.Start] = 0n;
    }
    if (num(fields, S.End) === size) {
      const maxTokenSize = num(fields, S.MaxTokenSize);
      if (size >= maxTokenSize) {
        setErr(fields, ERR_TOO_LONG);
        return false;
      }
      const newSize = Math.min(size === 0 ? START_BUF_SIZE : size * 2, maxTokenSize);
      const newBuf = makeBytes(newSize);
      copyBytes(newBuf, sub(fields[S.Buf], num(fields, S.Start), num(fields, S.End)));
      fields[S.Buf] = newBuf;
      fields[S.End] = BigInt(num(fields, S.End) - num(fields, S.Start));
      fields[S.Start] = 0n;
    }
    for (let loop = 0; ;) {
      runtime.spend();
      const end = num(fields, S.End);
      const space = lengthOf(fields[S.Buf]) - end;
      const [count, error] = readInto(fields[S.R], sub(fields[S.Buf], end));
      if (count < 0 || space < count) {
        setErr(fields, ERR_BAD_READ_COUNT);
        break;
      }
      fields[S.End] = BigInt(end + count);
      if (error !== undefined) {
        setErr(fields, error);
        break;
      }
      if (count > 0) {
        fields[S.Empties] = 0n;
        break;
      }
      loop++;
      if (loop > MAX_CONSECUTIVE_EMPTY_READS) {
        setErr(fields, ERR_NO_PROGRESS);
        break;
      }
    }
  }
}

addMethod(SCANNER, 'Scan', fn([], [BOOL]), (receiver) => scan(receiverStruct(receiver).fields), true);
addMethod(SCANNER, 'Text', fn([], [STRING]), (receiver) => textOf(receiverStruct(receiver).fields[S.Token]), true);
addMethod(SCANNER, 'Bytes', fn([], [BYTES]), (receiver) => receiverStruct(receiver).fields[S.Token], true);
addMethod(
  SCANNER,
  'Err',
  fn([], [ERROR_TYPE]),
  (receiver) => {
    const error = receiverStruct(receiver).fields[S.Err];
    return sameError(error, EOF) ? undefined : error;
  },
  true
);
addMethod(
  SCANNER,
  'Buffer',
  fn([BYTES, INT], []),
  (receiver, [buf, max]) => {
    const fields = receiverStruct(receiver).fields;
    if (fields[S.ScanCalled]) stringPanic('Buffer called after Scan');
    const slice = buf as Slice | undefined;
    fields[S.Buf] = slice && new Slice(slice.array, slice.offset, slice.capacity, slice.capacity);
    fields[S.MaxTokenSize] = max;
    return;
  },
  true
);
addMethod(
  SCANNER,
  'Split',
  fn([SPLIT_FUNC], []),
  (receiver, [split]) => {
    const fields = receiverStruct(receiver).fields;
    if (fields[S.ScanCalled]) stringPanic('Split called after Scan');
    fields[S.Split] = split;
    return;
  },
  true
);

type SplitResult = [bigint, Value, Value];

function scanBytes([data, atEOF]: Value[]): SplitResult {
  if (atEOF && lengthOf(data) === 0) return [0n, undefined, undefined];
  return [1n, sub(data, 0, 1), undefined];
}

function scanRunes([data, atEOF]: Value[]): SplitResult {
  const length = lengthOf(data);
  if (atEOF && length === 0) return [0n, undefined, undefined];
  if (byteAt(data, 0) < 0x80) return [1n, sub(data, 0, 1), undefined];
  const { size } = runeAt(data, 0, length);
  if (size > 1) return [BigInt(size), sub(data, 0, size), undefined];
  if (!atEOF && !fullRune(textOf(data, 0, Math.min(length, 4)))) return [0n, undefined, undefined];
  const errorRune = makeBytes(3);
  copyBytes(errorRune, encodeRune(RUNE_ERROR));
  return [1n, errorRune, undefined];
}

function dropCR(data: Value): Value {
  const length = lengthOf(data);
  return length > 0 && byteAt(data, length - 1) === 0x0d ? sub(data, 0, length - 1) : data;
}

function scanLines([data, atEOF]: Value[]): SplitResult {
  const length = lengthOf(data);
  if (atEOF && length === 0) return [0n, undefined, undefined];
  const newline = indexByte(data, 0, length, 0x0a);
  if (newline >= 0) return [BigInt(newline + 1), dropCR(sub(data, 0, newline)), undefined];
  if (atEOF) return [BigInt(length), dropCR(data), undefined];
  return [0n, undefined, undefined];
}

/** bufio's own isSpace, which unlike unicode.IsSpace leaves out U+180E-like format characters by listing ranges. */
function isScanSpace(rune: number): boolean {
  if (rune <= 0xff) return [0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0xa0].includes(rune);
  if (rune >= 0x20_00 && rune <= 0x20_0a) return true;
  return [0x16_80, 0x20_28, 0x20_29, 0x20_2f, 0x20_5f, 0x30_00].includes(rune);
}

function scanWords([data, atEOF]: Value[]): SplitResult {
  const length = lengthOf(data);
  let start = 0;
  while (start < length) {
    const { rune, size } = runeAt(data, start, length);
    if (!isScanSpace(rune)) break;
    start += size;
  }
  for (let at = start; at < length;) {
    const { rune, size } = runeAt(data, at, length);
    if (isScanSpace(rune)) return [BigInt(at + size), sub(data, start, at), undefined];
    at += size;
  }
  if (atEOF && length > start) return [BigInt(length), sub(data, start), undefined];
  return [BigInt(start), undefined, undefined];
}

function splitFunction(name: string, split: (args: Value[]) => SplitResult): Entity {
  return nativeFunction(name, SPLIT_FUNC.underlying as ReturnType<typeof fn>, split);
}

const members: Record<string, Entity> = {
  Writer: typeEntity(WRITER),
  Reader: typeEntity(READER),
  Scanner: typeEntity(SCANNER),
  SplitFunc: typeEntity(SPLIT_FUNC),
  NewWriter: nativeFunction('NewWriter', fn([IO_WRITER], [WRITER_POINTER]), ([writer]) =>
    newWriter(writer, DEFAULT_BUF_SIZE)
  ),
  NewWriterSize: nativeFunction('NewWriterSize', fn([IO_WRITER, INT], [WRITER_POINTER]), ([writer, size]) =>
    newWriter(writer, Number(size as bigint))
  ),
  NewReader: nativeFunction('NewReader', fn([IO_READER], [READER_POINTER]), ([reader]) =>
    newReader(reader, DEFAULT_BUF_SIZE)
  ),
  NewReaderSize: nativeFunction('NewReaderSize', fn([IO_READER, INT], [READER_POINTER]), ([reader, size]) =>
    newReader(reader, Number(size as bigint))
  ),
  NewScanner: nativeFunction('NewScanner', fn([IO_READER], [pointerTo(SCANNER)]), ([reader]) =>
    newStruct([
      reader,
      (members.ScanLines as { value: () => Value }).value(),
      BigInt(MAX_SCAN_TOKEN_SIZE),
      undefined,
      undefined,
      0n,
      0n,
      undefined,
      0n,
      false,
      false,
    ])
  ),
  ScanLines: splitFunction('ScanLines', scanLines),
  ScanWords: splitFunction('ScanWords', scanWords),
  ScanRunes: splitFunction('ScanRunes', scanRunes),
  ScanBytes: splitFunction('ScanBytes', scanBytes),
  MaxScanTokenSize: {
    kind: 'const',
    name: 'MaxScanTokenSize',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: BigInt(MAX_SCAN_TOKEN_SIZE) },
    span: { row: 0, column: 0 },
    used: true,
  },
  ...Object.fromEntries(
    (
      [
        ['ErrTooLong', ERR_TOO_LONG],
        ['ErrNegativeAdvance', ERR_NEGATIVE_ADVANCE],
        ['ErrAdvanceTooFar', ERR_ADVANCE_TOO_FAR],
        ['ErrBadReadCount', ERR_BAD_READ_COUNT],
        ['ErrFinalToken', ERR_FINAL_TOKEN],
        ['ErrBufferFull', ERR_BUFFER_FULL],
        ['ErrNegativeCount', ERR_NEGATIVE_COUNT],
        ['ErrInvalidUnreadByte', ERR_INVALID_UNREAD_BYTE],
        ['ErrInvalidUnreadRune', ERR_INVALID_UNREAD_RUNE],
      ] as const
    ).map(([name, value]) => [name, libraryVariable(name, ERROR_TYPE, value)])
  ),
};

/** `bufio.ReadWriter`, whose embedded Reader and Writer supply its methods. */
const READ_WRITER = namedType('bufio', 'ReadWriter', {
  kind: 'struct',
  fields: [
    { name: 'Reader', type: READER_POINTER, embedded: true },
    { name: 'Writer', type: WRITER_POINTER, embedded: true },
  ],
});
members.ReadWriter = typeEntity(READ_WRITER);
members.NewReadWriter = nativeFunction(
  'NewReadWriter',
  fn([READER_POINTER, WRITER_POINTER], [pointerTo(READ_WRITER)]),
  ([reader, writer]) => new Pointer(new Cell(new GoStruct([reader, writer])), 'v')
);

export const BUFIO_PACKAGE = definePackage('bufio', members);

// Byte slices ---------------------------------------------------------------------------------------------------------

function makeBytes(size: number): Slice {
  currentRuntime().allocate(size);
  return new Slice(
    Array.from({ length: size }, (): Value => 0n),
    0,
    size,
    size
  );
}

function lengthOf(bytes: Value): number {
  return (bytes as Slice | undefined)?.length ?? 0;
}

/** `bytes[lo:hi]`. */
function sub(bytes: Value, lo: number, hi = lengthOf(bytes)): Slice | undefined {
  const slice = bytes as Slice | undefined;
  if (!slice) return undefined;
  return new Slice(slice.array, slice.offset + lo, hi - lo, slice.capacity - lo);
}

function byteAt(bytes: Value, index: number): number {
  return Number((bytes as Slice).get(index) as bigint);
}

/** Go's `copy(dst, src)` for a byte slice or string source, which may overlap the destination. */
function copyBytes(dst: Value, src: Value): number {
  const target = dst as Slice | undefined;
  const count = Math.min(lengthOf(dst), typeof src === 'string' ? src.length : lengthOf(src));
  if (!target || count === 0) return 0;
  spendFor(count);
  if (typeof src === 'string') {
    for (let at = 0; at < count; at++) target.array[target.offset + at] = BigInt(src.charCodeAt(at));
  } else {
    const source = src as Slice;
    const values = source.array.slice(source.offset, source.offset + count);
    for (let at = 0; at < count; at++) target.array[target.offset + at] = values[at];
  }
  return count;
}

function textOf(bytes: Value, lo = 0, hi = lengthOf(bytes)): string {
  const slice = bytes as Slice | undefined;
  if (!slice) return '';
  spendFor(hi - lo);
  let text = '';
  for (let at = lo; at < hi; at++) text += String.fromCharCode(Number(slice.get(at) as bigint));
  return text;
}

function indexByte(bytes: Value, lo: number, hi: number, byte: number): number {
  const slice = bytes as Slice;
  const target = BigInt(byte);
  for (let at = lo; at < hi; at++) {
    if (slice.array[slice.offset + at] === target) {
      spendFor(at - lo);
      return at - lo;
    }
  }
  spendFor(hi - lo);
  return -1;
}

/** The first rune of `bytes[lo:hi]`, decoded as `utf8.DecodeRune` does. */
function runeAt(bytes: Value, lo: number, hi: number): { rune: number; size: number } {
  return decodeRune(textOf(bytes, lo, Math.min(hi, lo + 4)), 0);
}

function negativeCountPanic(error: Value): never {
  throw new GoPanic(error);
}
