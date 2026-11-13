// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { LIMITS } from '../../interpreter/limits';
import { roundUpToSizeClass } from '../conversions';
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { decodeRune, encodeRune, RUNE_ERROR, runesOf } from '../literals';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { GoPanic } from '../runtime';
import { boundsPanic } from '../runtimeErrors';
import { grownCapacity } from '../sliceOps';
import { BASIC, ERROR_TYPE, funcType, pointerTo, RUNE, sliceOf } from '../types';
import { Cell, GoStruct, Pointer, Slice, type Value } from '../values';
import { EOF, ERR_SHORT_WRITE, IO_READER, IO_WRITER } from './io';
import { equalFold, isWordSeparator } from './strings';
import {
  BOOL,
  BYTES,
  bytesOf,
  callFunction,
  callMethod,
  INT,
  receiverStruct,
  sliceOfValues,
  sliceValues,
  spendFor,
  STRING,
  stringPanic,
} from './support';
import { isSpace, toLower, toTitle, toUpper } from './unicodeSupport';

// Go's bytes.go, bytes/buffer.go, and bytes/reader.go, transcribed so that results share the input's array, and are
// nil or have the capacity, as Go's do.

type Bytes = Slice | undefined;
type Predicate = (rune: number) => boolean;

const BYTE_SLICES = sliceOf(BYTES);
const RUNE_PREDICATE = funcType([RUNE], [BOOL]);
const INT64 = BASIC.int64;
const SMALL_BUFFER_SIZE = 64;
const MIN_READ = 512;
const UTF_MAX = 4;

/** `s[low:high:max]`, which keeps a nil slice nil. */
function sub(s: Value, low: number, high: number, max?: number): Bytes {
  const slice = s as Bytes;
  if (!slice) return undefined;
  return new Slice(slice.array, slice.offset + low, high - low, (max ?? slice.capacity) - low);
}

/** A new array holding the bytes, with the capacity Go gives it. */
function newBytes(text: string, capacity = text.length): Slice {
  currentRuntime().allocate(capacity);
  const array: Value[] = Array.from({ length: capacity }, (_, index) =>
    BigInt(index < text.length ? text.charCodeAt(index) : 0)
  );
  return new Slice(array, 0, text.length, capacity);
}

/** `append([]byte(nil), text...)`. */
function appendToNil(text: string): Bytes {
  return text === '' ? undefined : newBytes(text, grownCapacity(0, text.length, BASIC.uint8, false));
}

/** `append([]byte{}, text...)`, which stays non-nil when empty. */
function appendToEmpty(text: string): Slice {
  return appendToNil(text) ?? newBytes('');
}

/** Appends to a byte slice made with `make([]byte, 0, capacity)` as successive `append` calls grow it. */
class ByteAppender {
  text = '';

  constructor(private capacity: number) {}

  push(chunk: string): void {
    const length = this.text.length + chunk.length;
    currentRuntime().checkStringLength(length);
    if (length > this.capacity) this.capacity = grownCapacity(this.capacity, length, BASIC.uint8, false);
    this.text += chunk;
  }

  result(): Slice {
    return newBytes(this.text, this.capacity);
  }
}

function predicateOf(fnValue: Value): Predicate {
  return (rune) => callFunction(fnValue, [BigInt(rune)]) === true;
}

function cutset(chars: string): Predicate {
  const set = new Set(runesOf(chars));
  return (rune) => set.has(rune);
}

function decodeLastRune(s: string, end: number): { rune: number; size: number } {
  const last = s.charCodeAt(end - 1);
  if (last < 0x80) return { rune: last, size: 1 };
  const limit = Math.max(end - UTF_MAX, 0);
  let start = end - 2;
  while (start >= limit && (s.charCodeAt(start) & 0xc0) === 0x80) start--;
  start = Math.max(start, 0);
  const decoded = decodeRune(s.slice(start, end), 0);
  return start + decoded.size === end ? decoded : { rune: RUNE_ERROR, size: 1 };
}

function indexFunc(s: string, f: Predicate, truth: boolean): number {
  spendFor(s.length);
  for (let at = 0; at < s.length;) {
    const { rune, size } = decodeRune(s, at);
    if (f(rune) === truth) return at;
    at += size;
  }
  return -1;
}

function lastIndexFunc(s: string, f: Predicate, truth: boolean): number {
  spendFor(s.length);
  for (let at = s.length; at > 0;) {
    const { rune, size } = decodeLastRune(s, at);
    at -= size;
    if (f(rune) === truth) return at;
  }
  return -1;
}

function countSubstrings(s: string, sep: string): number {
  spendFor(s.length);
  if (sep === '') return runesOf(s).length + 1;
  let count = 0;
  for (let found = s.indexOf(sep); found !== -1; found = s.indexOf(sep, found + sep.length)) count++;
  return count;
}

function indexRune(s: string, rune: number): number {
  if (rune === RUNE_ERROR) return indexFunc(s, (r) => r === RUNE_ERROR, true);
  if (rune < 0 || rune > 0x10_ff_ff || (rune >= 0xd8_00 && rune <= 0xdf_ff)) return -1;
  return s.indexOf(encodeRune(rune));
}

/** `bytes.genSplit`, whose pieces have their capacity cut at their end. */
function split(sValue: Value, sep: string, after: boolean, limit: number): Value {
  if (limit === 0) return undefined;
  const s = bytesOf(sValue);
  spendFor(s.length);
  if (sep === '') return explode(sValue, s, limit);
  const capacity = Math.min(limit < 0 ? countSubstrings(s, sep) + 1 : limit, s.length + 1);
  currentRuntime().allocate(capacity);
  const pieces: Value[] = [];
  let start = 0;
  while (pieces.length < capacity - 1) {
    const found = s.indexOf(sep, start);
    if (found === -1) break;
    const end = after ? found + sep.length : found;
    pieces.push(sub(sValue, start, end, end));
    start = found + sep.length;
  }
  pieces.push(sub(sValue, start, s.length));
  return withCapacity(pieces, capacity);
}

/** The slices in an array of `make([][]byte, capacity)`, whose unused elements are nil. */
function withCapacity(pieces: Value[], capacity: number): Slice {
  return new Slice(
    [...pieces, ...Array.from({ length: capacity - pieces.length }, (): Value => undefined)],
    0,
    pieces.length,
    capacity
  );
}

function explode(sValue: Value, s: string, limit: number): Slice {
  const capacity = limit <= 0 || limit > s.length ? s.length : limit;
  currentRuntime().allocate(capacity);
  const pieces: Value[] = [];
  let at = 0;
  while (at < s.length) {
    if (pieces.length + 1 >= capacity) {
      pieces.push(sub(sValue, at, s.length));
      break;
    }
    const { size } = decodeRune(s, at);
    pieces.push(sub(sValue, at, at + size, at + size));
    at += size;
  }
  return withCapacity(pieces, capacity);
}

function fields(sValue: Value, isSeparator: Predicate): Slice {
  const s = bytesOf(sValue);
  spendFor(s.length);
  const pieces: Value[] = [];
  let start = -1;
  for (let at = 0; at < s.length;) {
    const { rune, size } = decodeRune(s, at);
    if (isSeparator(rune)) {
      if (start >= 0) pieces.push(sub(sValue, start, at, at));
      start = -1;
    } else if (start < 0) {
      start = at;
    }
    at += size;
  }
  if (start >= 0) pieces.push(sub(sValue, start, s.length, s.length));
  return sliceOfValues(pieces);
}

function trimLeftFunc(sValue: Value, f: Predicate): Bytes {
  const at = indexFunc(bytesOf(sValue), f, false);
  return at === -1 ? undefined : sub(sValue, at, (sValue as Slice).length);
}

function trimRightFunc(sValue: Value, f: Predicate): Bytes {
  const s = bytesOf(sValue);
  let at = lastIndexFunc(s, f, false);
  at += at >= 0 && s.charCodeAt(at) >= 0x80 ? decodeRune(s, at).size : 1;
  return sub(sValue, 0, at);
}

function trimFunc(sValue: Value, f: Predicate): Bytes {
  return trimRightFunc(trimLeftFunc(sValue, f), f);
}

/** The end of `s` without the trailing runes in the cut set. */
function trimmedEnd(s: string, chars: string): number {
  const inSet = cutset(chars);
  let end = s.length;
  while (end > 0) {
    const { rune, size } = decodeLastRune(s, end);
    if (!inSet(rune)) break;
    end -= size;
  }
  return end;
}

/** The start of `s[:end]` without the leading runes in the cut set. */
function trimmedStart(s: string, end: number, chars: string): number {
  const inSet = cutset(chars);
  const text = s.slice(0, end);
  let start = 0;
  while (start < end) {
    const { rune, size } = decodeRune(text, start);
    if (!inSet(rune)) break;
    start += size;
  }
  return start;
}

/** `bytes.trimLeft*`, which returns nil for an empty result. */
function nonEmpty(sValue: Value, start: number, end: number): Bytes {
  return start === end ? undefined : sub(sValue, start, end);
}

const ASCII_SPACES = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

function trimSpace(sValue: Value): Bytes {
  const s = bytesOf(sValue);
  spendFor(s.length);
  for (let low = 0; low < s.length; low++) {
    const c = s.charCodeAt(low);
    if (c >= 0x80) return trimFunc(sub(sValue, low, s.length), isSpace);
    if (ASCII_SPACES.has(c)) continue;
    for (let high = s.length - 1; high >= low; high--) {
      const d = s.charCodeAt(high);
      if (d >= 0x80) return trimFunc(sub(sValue, low, high + 1), isSpace);
      if (!ASCII_SPACES.has(d)) return sub(sValue, low, high + 1);
    }
  }
  return undefined;
}

/** `bytes.Map`, which grows its result from the capacity of the input as `append` does. */
function mapBytes(s: string, mapping: (rune: number) => number): Slice {
  spendFor(s.length);
  const appender = new ByteAppender(s.length);
  for (let at = 0; at < s.length;) {
    const { rune, size } = decodeRune(s, at);
    const mapped = mapping(rune);
    if (mapped >= 0) appender.push(encodeRune(mapped));
    at += size;
  }
  return appender.result();
}

/** `bytes.ToUpper` and `bytes.ToLower`, which copy ASCII input even when nothing changes. */
function changeCase(
  s: string,
  target: RegExp,
  convertAscii: (s: string) => string,
  map: (rune: number) => number
): Slice {
  spendFor(s.length);
  if (!/^[\0-\u007F]*$/.test(s)) return mapBytes(s, map);
  return target.test(s) ? newBytes(convertAscii(s)) : appendToEmpty(s);
}

function replace(s: string, old: string, replacement: string, limit: number): Bytes {
  const matches = limit === 0 ? 0 : countSubstrings(s, old);
  if (matches === 0) return appendToNil(s);
  const count = limit < 0 || matches < limit ? matches : limit;
  const length = s.length + count * (replacement.length - old.length);
  currentRuntime().checkStringLength(length);
  spendFor(length);
  let result = '';
  let start = 0;
  if (old === '') {
    result = replacement;
    for (let replaced = 1; replaced < count; replaced++) {
      const { size } = decodeRune(s, start);
      result += s.slice(start, start + size) + replacement;
      start += size;
    }
  } else {
    for (let replaced = 0; replaced < count; replaced++) {
      const found = s.indexOf(old, start);
      result += s.slice(start, found) + replacement;
      start = found + old.length;
    }
  }
  return newBytes(result + s.slice(start));
}

function toValidUTF8(s: string, replacement: string): Slice {
  spendFor(s.length);
  const appender = new ByteAppender(s.length + replacement.length);
  let invalid = false;
  for (let at = 0; at < s.length;) {
    const c = s.charCodeAt(at);
    if (c < 0x80) {
      at++;
      invalid = false;
      appender.push(s[at - 1]);
      continue;
    }
    const { size } = decodeRune(s, at);
    if (size === 1) {
      at++;
      if (!invalid) {
        invalid = true;
        appender.push(replacement);
      }
      continue;
    }
    invalid = false;
    appender.push(s.slice(at, at + size));
    at += size;
  }
  return appender.result();
}

function join(elements: Value, sepValue: Value): Bytes {
  const parts = sliceValues(elements).map((part) => bytesOf(part));
  if (parts.length === 0) return newBytes('');
  if (parts.length === 1) return appendToNil(parts[0]);
  const sep = bytesOf(sepValue);
  const total = sep.length * (parts.length - 1) + parts.reduce((sum, part) => sum + part.length, 0);
  currentRuntime().checkStringLength(total);
  spendFor(total);
  return newBytes(parts.join(sep));
}

function repeat(bValue: Value, countValue: Value): Slice {
  const count = countValue as bigint;
  if (count === 0n) return newBytes('');
  if (count < 0n) stringPanic('bytes: negative Repeat count');
  const b = bytesOf(bValue);
  const total = BigInt(b.length) * count;
  if (total >= 1n << 63n) stringPanic('bytes: Repeat output length overflow');
  if (b.length === 0) return newBytes('');
  if (total > BigInt(LIMITS.maxStringLength)) currentRuntime().checkStringLength(LIMITS.maxStringLength + 1);
  spendFor(Number(total));
  return newBytes(b.repeat(Number(count)));
}

function title(s: string): Slice {
  let previous = 0x20;
  return mapBytes(s, (rune) => {
    const mapped = isWordSeparator(previous) ? toTitle(rune) : rune;
    previous = rune;
    return mapped;
  });
}

function compare(a: string, b: string): bigint {
  if (a === b) return 0n;
  return a < b ? -1n : 1n;
}

// Buffer ------------------------------------------------------------------------------------------------------------

const READ_OP = namedType('bytes', 'readOp', BASIC.int8);
const OP_READ = -1;
const OP_INVALID = 0;

/** `bytes.Buffer`, with Go's fields so that copies share the array and fmt prints them as Go does. */
const BUFFER = namedType('bytes', 'Buffer', {
  kind: 'struct',
  fields: [
    { name: 'buf', type: BYTES, embedded: false },
    { name: 'off', type: INT, embedded: false },
    { name: 'lastRead', type: READ_OP, embedded: false },
  ],
});
const ERR_TOO_LARGE = newError('bytes.Buffer: too large');
const ERR_NEGATIVE_READ = newError('bytes.Buffer: reader returned negative count from Read');
const ERR_UNREAD_BYTE = newError('bytes.Buffer: UnreadByte: previous operation was not a successful read');

/** Indexes `s[low:high]` with Go's checks. */
function checkedSub(s: Bytes, low: number, high: number): Bytes {
  const capacity = s?.capacity ?? 0;
  if (high < 0) boundsPanic(`slice bounds out of range [:${high}]`);
  if (high > capacity) boundsPanic(`slice bounds out of range [:${high}] with capacity ${capacity}`);
  if (low < 0 || low > high) boundsPanic(`slice bounds out of range [${low}:${high}]`);
  return sub(s, low, high);
}

class BufferView {
  constructor(private readonly struct: GoStruct) {}

  get buf(): Bytes {
    return this.struct.fields[0] as Bytes;
  }

  set buf(value: Bytes) {
    this.struct.fields[0] = value;
  }

  get off(): number {
    return Number(this.struct.fields[1] as bigint);
  }

  set off(value: number) {
    this.struct.fields[1] = BigInt(value);
  }

  get lastRead(): number {
    return Number(this.struct.fields[2] as bigint);
  }

  set lastRead(value: number) {
    this.struct.fields[2] = BigInt(value);
  }

  get length(): number {
    return this.buf?.length ?? 0;
  }

  get capacity(): number {
    return this.buf?.capacity ?? 0;
  }

  len(): number {
    return this.length - this.off;
  }

  empty(): boolean {
    return this.length <= this.off;
  }

  /** `b.buf[low:high]`, the bytes of the buffer without copying them. */
  view(low: number, high = this.length): Bytes {
    return checkedSub(this.buf, low, high);
  }

  text(low = this.off, high = this.length): string {
    return bytesOf(this.view(low, high));
  }

  resize(length: number): void {
    this.buf = sub(this.buf, 0, length);
  }

  reset(): void {
    this.resize(0);
    this.off = 0;
    this.lastRead = OP_INVALID;
  }

  tryGrowByReslice(n: number): number | undefined {
    const length = this.length;
    if (n > this.capacity - length) return undefined;
    this.resize(length + n);
    return length;
  }

  grow(n: number): number {
    const m = this.len();
    if (m === 0 && this.off !== 0) this.reset();
    const resliced = this.tryGrowByReslice(n);
    if (resliced !== undefined) return resliced;
    if (this.buf === undefined && n <= SMALL_BUFFER_SIZE) {
      this.buf = new Slice(newBytes('', SMALL_BUFFER_SIZE).array, 0, n, SMALL_BUFFER_SIZE);
      return 0;
    }
    const buf = this.buf as Slice;
    const capacity = this.capacity;
    if (n <= Math.trunc(capacity / 2) - m) {
      for (let index = 0; index < m; index++) {
        buf.array[buf.offset + index] = buf.array[buf.offset + this.off + index];
      }
    } else {
      this.buf = growSlice(this.view(this.off, this.length), this.off + n);
    }
    this.off = 0;
    this.resize(m + n);
    return m;
  }

  write(bytes: () => string): number {
    this.lastRead = OP_INVALID;
    const length = bytes().length;
    spendFor(length);
    const at = this.tryGrowByReslice(length) ?? this.grow(length);
    // The source is read after growing, as Go's copy reads a slice that may share the buffer's array.
    this.store(at, bytes());
    return length;
  }

  store(at: number, text: string): void {
    const buf = this.buf as Slice;
    for (let index = 0; index < text.length; index++) {
      buf.array[buf.offset + at + index] = BigInt(text.charCodeAt(index));
    }
  }

  readSlice(delim: number): [Bytes, Value] {
    const found = this.text().indexOf(String.fromCharCode(delim));
    const end = found === -1 ? this.length : this.off + found + 1;
    const line = this.view(this.off, end);
    this.off = end;
    this.lastRead = OP_READ;
    return [line, found === -1 ? EOF : undefined];
  }
}

function growSlice(b: Bytes, n: number): Slice {
  const length = b?.length ?? 0;
  const needed = Math.max(length + n, 2 * (b?.capacity ?? 0));
  currentRuntime().checkStringLength(needed);
  return newBytes(bytesOf(b), grownCapacity(0, needed, BASIC.uint8, false));
}

function bufferOf(receiver: Value): BufferView {
  return new BufferView(receiverStruct(receiver));
}

function bufferMethod(
  name: string,
  params: Parameters<typeof fn>[0],
  results: Parameters<typeof fn>[1],
  impl: (buffer: BufferView, args: Value[]) => Value | Value[]
): void {
  addMethod(BUFFER, name, fn(params, results), (receiver, args) => impl(bufferOf(receiver), args), true);
}

bufferMethod('Bytes', [], [BYTES], (b) => b.view(b.off));
bufferMethod('AvailableBuffer', [], [BYTES], (b) => b.view(b.length));
addMethod(
  BUFFER,
  'String',
  fn([], [STRING]),
  (receiver) => (receiver === undefined ? '<nil>' : bufferOf(receiver).text()),
  true
);
bufferMethod('Peek', [INT], [BYTES, ERROR_TYPE], (b, [count]) => {
  const n = Number(count as bigint);
  if (b.len() < n) return [b.view(b.off), EOF];
  return [b.view(b.off, b.off + n), undefined];
});
bufferMethod('Len', [], [INT], (b) => BigInt(b.len()));
bufferMethod('Cap', [], [INT], (b) => BigInt(b.capacity));
bufferMethod('Available', [], [INT], (b) => BigInt(b.capacity - b.length));
bufferMethod('Truncate', [INT], [], (b, [count]) => {
  const n = Number(count as bigint);
  if (n === 0) {
    b.reset();
    return;
  }
  b.lastRead = OP_INVALID;
  if (n < 0 || n > b.len()) stringPanic('bytes.Buffer: truncation out of range');
  b.resize(b.off + n);
  return;
});
bufferMethod('Reset', [], [], (b) => {
  b.reset();
  return;
});
bufferMethod('Grow', [INT], [], (b, [count]) => {
  const n = Number(count as bigint);
  if (n < 0) stringPanic('bytes.Buffer.Grow: negative count');
  currentRuntime().checkStringLength(b.length + n);
  b.resize(b.grow(n));
  return;
});
bufferMethod('Write', [BYTES], [INT, ERROR_TYPE], (b, [p]) => [BigInt(b.write(() => bytesOf(p))), undefined]);
bufferMethod('WriteString', [STRING], [INT, ERROR_TYPE], (b, [s]) => [BigInt(b.write(() => s as string)), undefined]);
bufferMethod('WriteByte', [BASIC.uint8], [ERROR_TYPE], (b, [c]) => {
  b.write(() => String.fromCharCode(Number(c as bigint)));
  return;
});
bufferMethod('WriteRune', [RUNE], [INT, ERROR_TYPE], (b, [r]) => {
  const rune = Number(r as bigint);
  if (rune >= 0 && rune < 0x80) {
    b.write(() => String.fromCharCode(rune));
    return [1n, undefined];
  }
  b.lastRead = OP_INVALID;
  const at = b.tryGrowByReslice(UTF_MAX) ?? b.grow(UTF_MAX);
  const encoded = encodeRune(rune);
  b.store(at, encoded);
  b.resize(at + encoded.length);
  return [BigInt(encoded.length), undefined];
});
bufferMethod('ReadFrom', [IO_READER], [INT64, ERROR_TYPE], (b, [reader]) => {
  b.lastRead = OP_INVALID;
  const runtime = currentRuntime();
  let total = 0n;
  for (;;) {
    runtime.spend();
    const at = b.grow(MIN_READ);
    b.resize(at);
    const [count, error] = callMethod(reader, 'Read', [b.view(at, b.capacity)]) as [bigint, Value];
    if (count < 0n) throw new GoPanic(ERR_NEGATIVE_READ);
    b.resize(at + Number(count));
    total += count;
    if (error === EOF) return [total, undefined];
    if (error !== undefined) return [total, error];
  }
});
bufferMethod('WriteTo', [IO_WRITER], [INT64, ERROR_TYPE], (b, [writer]) => {
  b.lastRead = OP_INVALID;
  const length = b.len();
  if (length > 0) {
    const [count, error] = callMethod(writer, 'Write', [b.view(b.off)]) as [bigint, Value];
    const written = Number(count);
    if (written > length) stringPanic('bytes.Buffer.WriteTo: invalid Write count');
    b.off += written;
    if (error !== undefined) return [count, error];
    if (written !== length) return [count, ERR_SHORT_WRITE];
  }
  b.reset();
  return [BigInt(length), undefined];
});
bufferMethod('Read', [BYTES], [INT, ERROR_TYPE], (b, [p]) => {
  b.lastRead = OP_INVALID;
  const target = p as Bytes;
  if (b.empty()) {
    b.reset();
    return [0n, (target?.length ?? 0) === 0 ? undefined : EOF];
  }
  const n = Math.min(target?.length ?? 0, b.len());
  const text = b.text(b.off, b.off + n);
  for (let index = 0; index < n; index++) target?.set(index, BigInt(text.charCodeAt(index)));
  b.off += n;
  if (n > 0) b.lastRead = OP_READ;
  return [BigInt(n), undefined];
});
bufferMethod('Next', [INT], [BYTES], (b, [count]) => {
  b.lastRead = OP_INVALID;
  const n = Math.min(Number(count as bigint), b.len());
  const data = b.view(b.off, b.off + n);
  b.off += n;
  if (n > 0) b.lastRead = OP_READ;
  return data;
});
bufferMethod('ReadByte', [], [BASIC.uint8, ERROR_TYPE], (b) => {
  if (b.empty()) {
    b.reset();
    return [0n, EOF];
  }
  const c = (b.buf as Slice).get(b.off);
  b.off++;
  b.lastRead = OP_READ;
  return [c, undefined];
});
bufferMethod('ReadRune', [], [RUNE, INT, ERROR_TYPE], (b) => {
  if (b.empty()) {
    b.reset();
    return [0n, 0n, EOF];
  }
  const { rune, size } = decodeRune(b.text(b.off, Math.min(b.off + UTF_MAX, b.length)), 0);
  b.off += size;
  b.lastRead = size;
  return [BigInt(rune), BigInt(size), undefined];
});
bufferMethod('UnreadRune', [], [ERROR_TYPE], (b) => {
  if (b.lastRead <= OP_INVALID) {
    return newError('bytes.Buffer: UnreadRune: previous operation was not a successful ReadRune');
  }
  if (b.off >= b.lastRead) b.off -= b.lastRead;
  b.lastRead = OP_INVALID;
  return;
});
bufferMethod('UnreadByte', [], [ERROR_TYPE], (b) => {
  if (b.lastRead === OP_INVALID) return ERR_UNREAD_BYTE;
  b.lastRead = OP_INVALID;
  if (b.off > 0) b.off--;
  return;
});
bufferMethod('ReadBytes', [BASIC.uint8], [BYTES, ERROR_TYPE], (b, [delim]) => {
  const [line, error] = b.readSlice(Number(delim as bigint));
  return [appendToNil(bytesOf(line)), error];
});
bufferMethod('ReadString', [BASIC.uint8], [STRING, ERROR_TYPE], (b, [delim]) => {
  const [line, error] = b.readSlice(Number(delim as bigint));
  return [bytesOf(line), error];
});

function newBuffer(buf: Bytes): Pointer {
  return new Pointer(new Cell(new GoStruct([buf, 0n, 0n])), 'v');
}

// Reader ------------------------------------------------------------------------------------------------------------

const READER = namedType('bytes', 'Reader', {
  kind: 'struct',
  fields: [
    { name: 's', type: BYTES, embedded: false },
    { name: 'i', type: INT64, embedded: false },
    { name: 'prevRune', type: INT, embedded: false },
  ],
});

class ReaderView {
  constructor(private readonly struct: GoStruct) {}

  get s(): Bytes {
    return this.struct.fields[0] as Bytes;
  }

  get size(): number {
    return this.s?.length ?? 0;
  }

  get i(): number {
    return Number(this.struct.fields[1] as bigint);
  }

  set i(value: number) {
    this.struct.fields[1] = BigInt(value);
  }

  set prevRune(value: number) {
    this.struct.fields[2] = BigInt(value);
  }

  get prevRune(): number {
    return Number(this.struct.fields[2] as bigint);
  }

  /** Copies `s[from:]` into `target`, returning the count. */
  copyTo(target: Bytes, from: number): number {
    const n = Math.min(target?.length ?? 0, this.size - from);
    const text = bytesOf(sub(this.s, from, from + n));
    for (let index = 0; index < n; index++) target?.set(index, BigInt(text.charCodeAt(index)));
    return n;
  }
}

function readerMethod(
  name: string,
  params: Parameters<typeof fn>[0],
  results: Parameters<typeof fn>[1],
  impl: (reader: ReaderView, args: Value[]) => Value | Value[]
): void {
  addMethod(
    READER,
    name,
    fn(params, results),
    (receiver, args) => impl(new ReaderView(receiverStruct(receiver)), args),
    true
  );
}

readerMethod('Len', [], [INT], (r) => BigInt(Math.max(r.size - r.i, 0)));
readerMethod('Size', [], [INT64], (r) => BigInt(r.size));
readerMethod('Read', [BYTES], [INT, ERROR_TYPE], (r, [b]) => {
  if (r.i >= r.size) return [0n, EOF];
  r.prevRune = -1;
  const n = r.copyTo(b as Bytes, r.i);
  r.i += n;
  return [BigInt(n), undefined];
});
readerMethod('ReadAt', [BYTES, INT64], [INT, ERROR_TYPE], (r, [b, offset]) => {
  const off = Number(offset as bigint);
  if (off < 0) return [0n, newError('bytes.Reader.ReadAt: negative offset')];
  if (off >= r.size) return [0n, EOF];
  const n = r.copyTo(b as Bytes, off);
  return [BigInt(n), n < ((b as Bytes)?.length ?? 0) ? EOF : undefined];
});
readerMethod('ReadByte', [], [BASIC.uint8, ERROR_TYPE], (r) => {
  r.prevRune = -1;
  if (r.i >= r.size) return [0n, EOF];
  const c = (r.s as Slice).get(r.i);
  r.i++;
  return [c, undefined];
});
readerMethod('UnreadByte', [], [ERROR_TYPE], (r) => {
  if (r.i <= 0) return newError('bytes.Reader.UnreadByte: at beginning of slice');
  r.prevRune = -1;
  r.i--;
  return;
});
readerMethod('ReadRune', [], [RUNE, INT, ERROR_TYPE], (r) => {
  if (r.i >= r.size) {
    r.prevRune = -1;
    return [0n, 0n, EOF];
  }
  r.prevRune = r.i;
  const { rune, size } = decodeRune(bytesOf(sub(r.s, r.i, Math.min(r.i + UTF_MAX, r.size))), 0);
  r.i += size;
  return [BigInt(rune), BigInt(size), undefined];
});
readerMethod('UnreadRune', [], [ERROR_TYPE], (r) => {
  if (r.i <= 0) return newError('bytes.Reader.UnreadRune: at beginning of slice');
  if (r.prevRune < 0) return newError('bytes.Reader.UnreadRune: previous operation was not ReadRune');
  r.i = r.prevRune;
  r.prevRune = -1;
  return;
});
readerMethod('Seek', [INT64, INT], [INT64, ERROR_TYPE], (r, [offset, whence]) => {
  r.prevRune = -1;
  const bases = [0n, BigInt(r.i), BigInt(r.size)];
  const base = bases[Number(whence as bigint)] as bigint | undefined;
  if (base === undefined || (whence as bigint) < 0n) return [0n, newError('bytes.Reader.Seek: invalid whence')];
  const position = base + (offset as bigint);
  if (position < 0n) return [0n, newError('bytes.Reader.Seek: negative position')];
  r.i = Number(position);
  return [position, undefined];
});
readerMethod('WriteTo', [IO_WRITER], [INT64, ERROR_TYPE], (r, [writer]) => {
  r.prevRune = -1;
  if (r.i >= r.size) return [0n, undefined];
  const length = r.size - r.i;
  const [count, error] = callMethod(writer, 'Write', [sub(r.s, r.i, r.size)]) as [bigint, Value];
  const written = Number(count);
  if (written > length) stringPanic('bytes.Reader.WriteTo: invalid Write count');
  r.i += written;
  return [count, written !== length && error === undefined ? ERR_SHORT_WRITE : error];
});
addMethod(
  READER,
  'Reset',
  fn([BYTES], []),
  (receiver, [b]) => {
    const struct = receiverStruct(receiver);
    struct.fields.splice(0, 3, b, 0n, -1n);
    return;
  },
  true
);

// Package -----------------------------------------------------------------------------------------------------------

const b2 =
  (impl: (a: string, b: string) => Value | Value[]) =>
  ([a, b]: Value[]): Value | Value[] =>
    impl(bytesOf(a), bytesOf(b));

function cut(s: Value, sepValue: Value, found: number): Value[] {
  if (found < 0) return [s, undefined, false];
  const sep = bytesOf(sepValue);
  return [sub(s, 0, found), sub(s, found + sep.length, (s as Bytes)?.length ?? 0), true];
}

const members: Record<string, Entity> = {
  Buffer: typeEntity(BUFFER),
  Reader: typeEntity(READER),
  MinRead: {
    kind: 'const',
    name: 'MinRead',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: BigInt(MIN_READ) },
    span: { row: 0, column: 0 },
    used: true,
  },
  ErrTooLarge: {
    kind: 'var',
    name: 'ErrTooLarge',
    type: ERROR_TYPE,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => ERR_TOO_LARGE,
  },
  NewBuffer: nativeFunction('NewBuffer', fn([BYTES], [pointerTo(BUFFER)]), ([buf]) => newBuffer(buf as Bytes)),
  NewBufferString: nativeFunction('NewBufferString', fn([STRING], [pointerTo(BUFFER)]), ([s]) => {
    const text = s as string;
    // The capacity of `[]byte(s)` on the heap; Go keeps it exact or on the stack only when the buffer does not escape.
    return newBuffer(newBytes(text, roundUpToSizeClass(text.length)));
  }),
  NewReader: nativeFunction(
    'NewReader',
    fn([BYTES], [pointerTo(READER)]),
    ([b]) => new Pointer(new Cell(new GoStruct([b, 0n, -1n])), 'v')
  ),
  Clone: nativeFunction('Clone', fn([BYTES], [BYTES]), ([b]) =>
    b === undefined ? undefined : appendToEmpty(bytesOf(b))
  ),
  Compare: nativeFunction('Compare', fn([BYTES, BYTES], [INT]), b2(compare)),
  Equal: nativeFunction(
    'Equal',
    fn([BYTES, BYTES], [BOOL]),
    b2((a, b) => a === b)
  ),
  EqualFold: nativeFunction('EqualFold', fn([BYTES, BYTES], [BOOL]), b2(equalFold)),
  Contains: nativeFunction(
    'Contains',
    fn([BYTES, BYTES], [BOOL]),
    b2((b, sub) => b.includes(sub))
  ),
  ContainsAny: nativeFunction(
    'ContainsAny',
    fn([BYTES, STRING], [BOOL]),
    ([b, chars]) => indexFunc(bytesOf(b), cutset(chars as string), true) >= 0
  ),
  ContainsRune: nativeFunction(
    'ContainsRune',
    fn([BYTES, RUNE], [BOOL]),
    ([b, r]) => indexRune(bytesOf(b), Number(r as bigint)) >= 0
  ),
  ContainsFunc: nativeFunction(
    'ContainsFunc',
    fn([BYTES, RUNE_PREDICATE], [BOOL]),
    ([b, f]) => indexFunc(bytesOf(b), predicateOf(f), true) >= 0
  ),
  Count: nativeFunction(
    'Count',
    fn([BYTES, BYTES], [INT]),
    b2((s, sep) => BigInt(countSubstrings(s, sep)))
  ),
  Cut: nativeFunction('Cut', fn([BYTES, BYTES], [BYTES, BYTES, BOOL]), ([s, sep]) =>
    cut(s, sep, bytesOf(s).indexOf(bytesOf(sep)))
  ),
  CutLast: nativeFunction('CutLast', fn([BYTES, BYTES], [BYTES, BYTES, BOOL]), ([s, sep]) =>
    cut(s, sep, bytesOf(s).lastIndexOf(bytesOf(sep)))
  ),
  CutPrefix: nativeFunction('CutPrefix', fn([BYTES, BYTES], [BYTES, BOOL]), ([s, prefix]) => {
    const text = bytesOf(s);
    const head = bytesOf(prefix);
    return text.startsWith(head) ? [sub(s, head.length, text.length), true] : [s, false];
  }),
  CutSuffix: nativeFunction('CutSuffix', fn([BYTES, BYTES], [BYTES, BOOL]), ([s, suffix]) => {
    const text = bytesOf(s);
    const tail = bytesOf(suffix);
    return text.endsWith(tail) ? [sub(s, 0, text.length - tail.length), true] : [s, false];
  }),
  Fields: nativeFunction('Fields', fn([BYTES], [BYTE_SLICES]), ([s]) => fields(s, isSpace)),
  FieldsFunc: nativeFunction('FieldsFunc', fn([BYTES, RUNE_PREDICATE], [BYTE_SLICES]), ([s, f]) =>
    fields(s, predicateOf(f))
  ),
  HasPrefix: nativeFunction(
    'HasPrefix',
    fn([BYTES, BYTES], [BOOL]),
    b2((s, prefix) => s.startsWith(prefix))
  ),
  HasSuffix: nativeFunction(
    'HasSuffix',
    fn([BYTES, BYTES], [BOOL]),
    b2((s, suffix) => s.endsWith(suffix))
  ),
  Index: nativeFunction(
    'Index',
    fn([BYTES, BYTES], [INT]),
    b2((s, sep) => BigInt(s.indexOf(sep)))
  ),
  IndexAny: nativeFunction('IndexAny', fn([BYTES, STRING], [INT]), ([s, chars]) =>
    BigInt(indexFunc(bytesOf(s), cutset(chars as string), true))
  ),
  IndexByte: nativeFunction('IndexByte', fn([BYTES, BASIC.uint8], [INT]), ([s, c]) =>
    BigInt(bytesOf(s).indexOf(String.fromCharCode(Number(c as bigint))))
  ),
  IndexFunc: nativeFunction('IndexFunc', fn([BYTES, RUNE_PREDICATE], [INT]), ([s, f]) =>
    BigInt(indexFunc(bytesOf(s), predicateOf(f), true))
  ),
  IndexRune: nativeFunction('IndexRune', fn([BYTES, RUNE], [INT]), ([s, r]) =>
    BigInt(indexRune(bytesOf(s), Number(r as bigint)))
  ),
  LastIndex: nativeFunction(
    'LastIndex',
    fn([BYTES, BYTES], [INT]),
    b2((s, sep) => BigInt(s.lastIndexOf(sep)))
  ),
  LastIndexAny: nativeFunction('LastIndexAny', fn([BYTES, STRING], [INT]), ([s, chars]) =>
    BigInt(lastIndexFunc(bytesOf(s), cutset(chars as string), true))
  ),
  LastIndexByte: nativeFunction('LastIndexByte', fn([BYTES, BASIC.uint8], [INT]), ([s, c]) =>
    BigInt(bytesOf(s).lastIndexOf(String.fromCharCode(Number(c as bigint))))
  ),
  LastIndexFunc: nativeFunction('LastIndexFunc', fn([BYTES, RUNE_PREDICATE], [INT]), ([s, f]) =>
    BigInt(lastIndexFunc(bytesOf(s), predicateOf(f), true))
  ),
  Join: nativeFunction('Join', fn([BYTE_SLICES, BYTES], [BYTES]), ([s, sep]) => join(s, sep)),
  Map: nativeFunction('Map', fn([funcType([RUNE], [RUNE]), BYTES], [BYTES]), ([mapping, s]) =>
    mapBytes(bytesOf(s), (rune) => Number(callFunction(mapping, [BigInt(rune)]) as bigint))
  ),
  Repeat: nativeFunction('Repeat', fn([BYTES, INT], [BYTES]), ([b, count]) => repeat(b, count)),
  Replace: nativeFunction('Replace', fn([BYTES, BYTES, BYTES, INT], [BYTES]), ([s, old, replacement, n]) =>
    replace(bytesOf(s), bytesOf(old), bytesOf(replacement), Number(n as bigint))
  ),
  ReplaceAll: nativeFunction('ReplaceAll', fn([BYTES, BYTES, BYTES], [BYTES]), ([s, old, replacement]) =>
    replace(bytesOf(s), bytesOf(old), bytesOf(replacement), -1)
  ),
  Runes: nativeFunction('Runes', fn([BYTES], [sliceOf(RUNE)]), ([s]) => sliceOfValues(runesOf(bytesOf(s)).map(BigInt))),
  Split: nativeFunction('Split', fn([BYTES, BYTES], [BYTE_SLICES]), ([s, sep]) => split(s, bytesOf(sep), false, -1)),
  SplitN: nativeFunction('SplitN', fn([BYTES, BYTES, INT], [BYTE_SLICES]), ([s, sep, n]) =>
    split(s, bytesOf(sep), false, Number(n as bigint))
  ),
  SplitAfter: nativeFunction('SplitAfter', fn([BYTES, BYTES], [BYTE_SLICES]), ([s, sep]) =>
    split(s, bytesOf(sep), true, -1)
  ),
  SplitAfterN: nativeFunction('SplitAfterN', fn([BYTES, BYTES, INT], [BYTE_SLICES]), ([s, sep, n]) =>
    split(s, bytesOf(sep), true, Number(n as bigint))
  ),
  Title: nativeFunction('Title', fn([BYTES], [BYTES]), ([s]) => title(bytesOf(s))),
  ToLower: nativeFunction('ToLower', fn([BYTES], [BYTES]), ([s]) =>
    changeCase(bytesOf(s), /[A-Z]/, (text) => text.toLowerCase(), toLower)
  ),
  ToUpper: nativeFunction('ToUpper', fn([BYTES], [BYTES]), ([s]) =>
    changeCase(bytesOf(s), /[a-z]/, (text) => text.toUpperCase(), toUpper)
  ),
  ToTitle: nativeFunction('ToTitle', fn([BYTES], [BYTES]), ([s]) => mapBytes(bytesOf(s), toTitle)),
  ToValidUTF8: nativeFunction('ToValidUTF8', fn([BYTES, BYTES], [BYTES]), ([s, replacement]) =>
    toValidUTF8(bytesOf(s), bytesOf(replacement))
  ),
  Trim: nativeFunction('Trim', fn([BYTES, STRING], [BYTES]), ([s, chars]) => {
    const text = bytesOf(s);
    if (text.length === 0) return;
    if (chars === '') return s;
    const end = trimmedEnd(text, chars as string);
    return nonEmpty(s, trimmedStart(text, end, chars as string), end);
  }),
  TrimLeft: nativeFunction('TrimLeft', fn([BYTES, STRING], [BYTES]), ([s, chars]) => {
    const text = bytesOf(s);
    if (text.length === 0) return;
    if (chars === '') return s;
    return nonEmpty(s, trimmedStart(text, text.length, chars as string), text.length);
  }),
  TrimRight: nativeFunction('TrimRight', fn([BYTES, STRING], [BYTES]), ([s, chars]) => {
    const text = bytesOf(s);
    if (text.length === 0 || chars === '') return s;
    return sub(s, 0, trimmedEnd(text, chars as string));
  }),
  TrimFunc: nativeFunction('TrimFunc', fn([BYTES, RUNE_PREDICATE], [BYTES]), ([s, f]) => trimFunc(s, predicateOf(f))),
  TrimLeftFunc: nativeFunction('TrimLeftFunc', fn([BYTES, RUNE_PREDICATE], [BYTES]), ([s, f]) =>
    trimLeftFunc(s, predicateOf(f))
  ),
  TrimRightFunc: nativeFunction('TrimRightFunc', fn([BYTES, RUNE_PREDICATE], [BYTES]), ([s, f]) =>
    trimRightFunc(s, predicateOf(f))
  ),
  TrimPrefix: nativeFunction('TrimPrefix', fn([BYTES, BYTES], [BYTES]), ([s, prefix]) => {
    const text = bytesOf(s);
    const head = bytesOf(prefix);
    return text.startsWith(head) ? sub(s, head.length, text.length) : s;
  }),
  TrimSuffix: nativeFunction('TrimSuffix', fn([BYTES, BYTES], [BYTES]), ([s, suffix]) => {
    const text = bytesOf(s);
    const tail = bytesOf(suffix);
    return text.endsWith(tail) ? sub(s, 0, text.length - tail.length) : s;
  }),
  TrimSpace: nativeFunction('TrimSpace', fn([BYTES], [BYTES]), ([s]) => trimSpace(s)),
};

export const BYTES_PACKAGE = definePackage('bytes', members, [
  'Lines',
  'SplitSeq',
  'SplitAfterSeq',
  'FieldsSeq',
  'FieldsFuncSeq',
  'ToUpperSpecial',
  'ToLowerSpecial',
  'ToTitleSpecial',
]);
