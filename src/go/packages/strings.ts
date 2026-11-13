// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { LIMITS } from '../../interpreter/limits';
import { roundUpToSizeClass } from '../conversions';
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { decodeRune, encodeRune, RUNE_ERROR, runesOf } from '../literals';
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
import { grownCapacity } from '../sliceOps';
import { BASIC, ERROR_TYPE, funcType, pointerTo, RUNE, sliceOf, type StructType } from '../types';
import { Cell, GoStruct, type NativeState, Pointer, Slice, type Value } from '../values';
import { EOF, ERR_SHORT_WRITE, IO_WRITER, writeString } from './io';
import {
  BOOL,
  bytesOf,
  callFunction,
  INT,
  receiverStruct,
  sliceOfValues,
  sliceValues,
  spendFor,
  STRING,
  stringPanic,
} from './support';
import { SPECIAL_CASE, specialCaseMapper } from './unicodeRanges';
import { isSpace, mapRunes, simpleFold, toLower, toTitle, toUpper } from './unicodeSupport';

const STRINGS = sliceOf(STRING);
const RUNE_PREDICATE = funcType([RUNE], [BOOL]);
const BYTES = sliceOf(BASIC.uint8);

function index(s: string, sub: string): number {
  spendFor(s.length);
  return s.indexOf(sub);
}

function runeIndex(s: string, predicate: (rune: number) => boolean, fromEnd = false): number {
  spendFor(s.length);
  let found = -1;
  for (let at = 0; at < s.length;) {
    const { rune, size } = decodeRune(s, at);
    if (predicate(rune)) {
      if (!fromEnd) return at;
      found = at;
    }
    at += size;
  }
  return found;
}

function containsRune(chars: string, rune: number): boolean {
  spendFor(chars.length);
  return runesOf(chars).includes(rune);
}

function countSubstrings(s: string, sub: string): number {
  spendFor(s.length);
  if (sub === '') return runesOf(s).length + 1;
  let count = 0;
  let start = 0;
  for (;;) {
    const found = s.indexOf(sub, start);
    if (found === -1) return count;
    count++;
    start = found + sub.length;
  }
}

/** `strings.genSplit`: builds the slice with the capacity Go's `make([]string, min(n, len(s)+1))` allocates. */
function splitSlice(s: string, sep: string, after: boolean, limit: number): Value {
  if (limit === 0) return undefined;
  spendFor(s.length);
  const pieces = split(s, sep, after, limit);
  if (sep === '') return sliceOfValues(pieces);
  const count = limit < 0 ? countSubstrings(s, sep) + 1 : limit;
  const capacity = Math.min(count, s.length + 1);
  currentRuntime().allocate(capacity);
  const array: Value[] = [...pieces];
  while (array.length < capacity) array.push('');
  return new Slice(array, 0, pieces.length, capacity);
}

/** `strings.Split` and its variants: `after` keeps the separator, and `limit` caps the number of pieces. */
function split(s: string, sep: string, after: boolean, limit: number): string[] {
  if (limit === 0) return [];
  if (sep === '') {
    const pieces: string[] = [];
    let at = 0;
    while (at < s.length && (limit < 0 || pieces.length < limit - 1)) {
      const { size } = decodeRune(s, at);
      pieces.push(s.slice(at, at + size));
      at += size;
    }
    if (at < s.length) pieces.push(s.slice(at));
    return pieces;
  }
  const pieces: string[] = [];
  let start = 0;
  while (limit < 0 || pieces.length < limit - 1) {
    const found = s.indexOf(sep, start);
    if (found === -1) break;
    pieces.push(s.slice(start, after ? found + sep.length : found));
    start = found + sep.length;
  }
  pieces.push(s.slice(start));
  return pieces;
}

function fields(s: string, isSeparator: (rune: number) => boolean): string[] {
  spendFor(s.length);
  const pieces: string[] = [];
  let start = -1;
  for (let at = 0; at < s.length;) {
    const { rune, size } = decodeRune(s, at);
    if (isSeparator(rune)) {
      if (start >= 0) pieces.push(s.slice(start, at));
      start = -1;
    } else if (start < 0) {
      start = at;
    }
    at += size;
  }
  if (start >= 0) pieces.push(s.slice(start));
  return pieces;
}

function trimLeft(s: string, predicate: (rune: number) => boolean): string {
  spendFor(s.length);
  let at = 0;
  while (at < s.length) {
    const { rune, size } = decodeRune(s, at);
    if (!predicate(rune)) break;
    at += size;
  }
  return s.slice(at);
}

function trimRight(s: string, predicate: (rune: number) => boolean): string {
  spendFor(s.length);
  const runes: { rune: number; at: number }[] = [];
  for (let at = 0; at < s.length;) {
    const { rune, size } = decodeRune(s, at);
    runes.push({ rune, at });
    at += size;
  }
  let end = s.length;
  for (let index = runes.length - 1; index >= 0 && predicate(runes[index].rune); index--) end = runes[index].at;
  return s.slice(0, end);
}

function cutset(chars: string): (rune: number) => boolean {
  const set = new Set(runesOf(chars));
  return (rune) => set.has(rune);
}

function appendBounded(current: string, chunk: string): string {
  currentRuntime().checkStringLength(current.length + chunk.length);
  return current + chunk;
}

function replace(s: string, old: string, replacement: string, count: number): string {
  if (old === replacement || count === 0) return s;
  const runtime = currentRuntime();
  spendFor(s.length);
  let result = '';
  let start = 0;
  let replaced = 0;
  if (old === '') {
    // An empty old string matches at the start and after each rune.
    let at = 0;
    for (;;) {
      if (count >= 0 && replaced >= count) break;
      runtime.spend();
      result = appendBounded(result, replacement);
      replaced++;
      if (at >= s.length) return result;
      const { size } = decodeRune(s, at);
      result = appendBounded(result, s.slice(at, at + size));
      at += size;
    }
    return appendBounded(result, s.slice(at));
  }
  for (;;) {
    if (count >= 0 && replaced >= count) break;
    const found = s.indexOf(old, start);
    if (found === -1) break;
    runtime.spend();
    result = appendBounded(appendBounded(result, s.slice(start, found)), replacement);
    start = found + old.length;
    replaced++;
  }
  return appendBounded(result, s.slice(start));
}

export function equalFold(s: string, t: string): boolean {
  spendFor(Math.min(s.length, t.length));
  let sa = 0;
  let ta = 0;
  while (sa < s.length && ta < t.length) {
    const ds = decodeRune(s, sa);
    const dt = decodeRune(t, ta);
    sa += ds.size;
    ta += dt.size;
    let sr = ds.rune;
    let tr = dt.rune;
    if (sr === tr) continue;
    if (tr < sr) [sr, tr] = [tr, sr];
    if (tr < 0x80) {
      if (sr >= 0x41 && sr <= 0x5a && tr === sr + 0x20) continue;
      return false;
    }
    let r = simpleFold(sr);
    while (r !== sr && r < tr) r = simpleFold(r);
    if (r !== tr) return false;
  }
  return sa === s.length && ta === t.length;
}

/** The separators of words for `strings.Title`, as its isSeparator decides. */
export function isWordSeparator(rune: number): boolean {
  if (rune <= 0x7f) {
    const char = String.fromCodePoint(rune);
    return !/[\dA-Za-z_]/.test(char);
  }
  if (/^[\p{L}\p{Nd}]$/u.test(String.fromCodePoint(rune))) return false;
  return isSpace(rune);
}

function predicateOf(fnValue: Value): (rune: number) => boolean {
  return (rune) => callFunction(fnValue, [BigInt(rune)]) === true;
}

function stringList(values: string[]): Value {
  return sliceOfValues(values);
}

function bytesString(value: Value): string {
  return value as string;
}

// Builder -----------------------------------------------------------------------------------------------------------

/**
 * `strings.Builder`, whose text lives in `native` as a JavaScript string of bytes; its Go fields `addr` and `buf` are
 * projected from that state when fmt prints them.
 */
export const BUILDER = namedType('strings', 'Builder', { kind: 'struct', fields: [] });
(BUILDER.underlying as StructType).fields.push(
  { name: 'addr', type: pointerTo(BUILDER), embedded: false },
  { name: 'buf', type: BYTES, embedded: false }
);

interface BuilderState extends NativeState {
  builder: string;
  capacity: number;
  /** The pointer through which the builder was first written, which Go's copy check compares. */
  addr: Pointer | undefined;
}

function createBuilderState(builder = '', capacity = 0, addr?: Pointer): BuilderState {
  const state: BuilderState = {
    builder,
    capacity,
    addr,
    clone: () => createBuilderState(state.builder, state.capacity, state.addr),
    fieldValues: () => [
      state.addr,
      state.capacity === 0
        ? undefined
        : new Slice(
            Array.from({ length: state.capacity }, (_, at) =>
              BigInt(at < state.builder.length ? state.builder.charCodeAt(at) : 0)
            ),
            0,
            state.builder.length,
            state.capacity
          ),
    ],
  };
  return state;
}

function builderOf(receiver: Value): BuilderState {
  const struct = receiverStruct(receiver);
  struct.native ??= createBuilderState();
  return struct.native as BuilderState;
}

function copyCheck(receiver: Value, state: BuilderState): void {
  if (state.addr === undefined) state.addr = receiver as Pointer;
  else if (state.addr.load() !== (receiver as Pointer).load())
    stringPanic('strings: illegal use of non-zero Builder copied by value');
}

function roundUpByteCapacity(size: number): number {
  if (size <= 0) return 0;
  if (size <= 32_760) return roundUpToSizeClass(size);
  return Math.ceil(size / 8192) * 8192;
}

function appendToBuilder(receiver: Value, text: string): Value[] {
  const state = builderOf(receiver);
  copyCheck(receiver, state);
  const newLength = state.builder.length + text.length;
  currentRuntime().checkStringLength(newLength);
  if (newLength > state.capacity) state.capacity = grownCapacity(state.capacity, newLength, BASIC.uint8);
  state.builder += text;
  spendFor(text.length);
  return [BigInt(text.length), undefined];
}

addMethod(
  BUILDER,
  'WriteString',
  fn([STRING], [INT, ERROR_TYPE]),
  (receiver, [text]) => appendToBuilder(receiver, text as string),
  true
);
addMethod(
  BUILDER,
  'WriteByte',
  fn([BASIC.uint8], [ERROR_TYPE]),
  (receiver, [byte]) => {
    appendToBuilder(receiver, String.fromCharCode(Number(byte as bigint)));
    return;
  },
  true
);
addMethod(
  BUILDER,
  'WriteRune',
  fn([RUNE], [INT, ERROR_TYPE]),
  (receiver, [rune]) => appendToBuilder(receiver, encodeRune(Number(rune as bigint))),
  true
);
addMethod(
  BUILDER,
  'Write',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [bytes]) => appendToBuilder(receiver, bytesOf(bytes)),
  true
);
addMethod(BUILDER, 'String', fn([], [STRING]), (receiver) => builderOf(receiver).builder, true);
addMethod(BUILDER, 'Len', fn([], [INT]), (receiver) => BigInt(builderOf(receiver).builder.length), true);
addMethod(BUILDER, 'Cap', fn([], [INT]), (receiver) => BigInt(builderOf(receiver).capacity), true);
addMethod(
  BUILDER,
  'Reset',
  fn([], []),
  (receiver) => {
    const state = builderOf(receiver);
    state.addr = undefined;
    state.builder = '';
    state.capacity = 0;
    return;
  },
  true
);
addMethod(
  BUILDER,
  'Grow',
  fn([INT], []),
  (receiver, [count]) => {
    const state = builderOf(receiver);
    copyCheck(receiver, state);
    const requested = Number(count as bigint);
    if (requested < 0) stringPanic('strings.Builder.Grow: negative count');
    if (state.capacity - state.builder.length < requested) {
      const needed = 2 * state.capacity + requested;
      currentRuntime().checkStringLength(needed);
      spendFor(needed);
      state.capacity = roundUpByteCapacity(needed);
    }
    return;
  },
  true
);

// Reader ------------------------------------------------------------------------------------------------------------

export const READER = opaqueType(
  namedType('strings', 'Reader', {
    kind: 'struct',
    fields: [
      { name: 's', type: STRING, embedded: false },
      { name: 'i', type: BASIC.int64, embedded: false },
      { name: 'prevRune', type: INT, embedded: false },
    ],
  })
);

/** The fields `s`, `i` and `prevRune` of a `*strings.Reader`, read and written as Go's methods do. */
class ReaderFields {
  private readonly fields: Value[];

  constructor(receiver: Value) {
    this.fields = receiverStruct(receiver).fields;
  }

  get s(): string {
    return this.fields[0] as string;
  }

  get i(): number {
    return Number(this.fields[1] as bigint);
  }

  set i(value: number) {
    this.fields[1] = BigInt(value);
  }

  get prevRune(): number {
    return Number(this.fields[2] as bigint);
  }

  set prevRune(value: number) {
    this.fields[2] = BigInt(value);
  }
}

function newReader(s: string): Pointer {
  return new Pointer(new Cell(new GoStruct([s, 0n, -1n])), 'v');
}

/** Copies bytes of `text` from `from` into a byte slice, as Go's `copy(b, s[from:])`, returning the count. */
function copyInto(buffer: Value, text: string, from: number): number {
  const slice = buffer as Slice | undefined;
  const count = Math.min(slice?.length ?? 0, text.length - from);
  spendFor(count);
  for (let at = 0; at < count; at++) slice?.set(at, BigInt(text.charCodeAt(from + at)));
  return count;
}

addMethod(
  READER,
  'Read',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [buffer]) => {
    const r = new ReaderFields(receiver);
    if (r.i >= r.s.length) return [0n, EOF];
    r.prevRune = -1;
    const count = copyInto(buffer, r.s, r.i);
    r.i += count;
    return [BigInt(count), undefined];
  },
  true
);
addMethod(
  READER,
  'ReadAt',
  fn([BYTES, BASIC.int64], [INT, ERROR_TYPE]),
  (receiver, [buffer, offset]) => {
    const r = new ReaderFields(receiver);
    const off = offset as bigint;
    if (off < 0n) return [0n, newError('strings.Reader.ReadAt: negative offset')];
    if (off >= BigInt(r.s.length)) return [0n, EOF];
    const count = copyInto(buffer, r.s, Number(off));
    return [BigInt(count), count < ((buffer as Slice | undefined)?.length ?? 0) ? EOF : undefined];
  },
  true
);
addMethod(
  READER,
  'ReadByte',
  fn([], [BASIC.uint8, ERROR_TYPE]),
  (receiver) => {
    const r = new ReaderFields(receiver);
    r.prevRune = -1;
    if (r.i >= r.s.length) return [0n, EOF];
    const byte = r.s.charCodeAt(r.i);
    r.i += 1;
    return [BigInt(byte), undefined];
  },
  true
);
addMethod(
  READER,
  'UnreadByte',
  fn([], [ERROR_TYPE]),
  (receiver) => {
    const r = new ReaderFields(receiver);
    if (r.i <= 0) return newError('strings.Reader.UnreadByte: at beginning of string');
    r.prevRune = -1;
    r.i -= 1;
    return;
  },
  true
);
addMethod(
  READER,
  'ReadRune',
  fn([], [RUNE, INT, ERROR_TYPE]),
  (receiver) => {
    const r = new ReaderFields(receiver);
    if (r.i >= r.s.length) {
      r.prevRune = -1;
      return [0n, 0n, EOF];
    }
    r.prevRune = r.i;
    const { rune, size } = decodeRune(r.s, r.i);
    r.i += size;
    return [BigInt(rune), BigInt(size), undefined];
  },
  true
);
addMethod(
  READER,
  'UnreadRune',
  fn([], [ERROR_TYPE]),
  (receiver) => {
    const r = new ReaderFields(receiver);
    if (r.i <= 0) return newError('strings.Reader.UnreadRune: at beginning of string');
    if (r.prevRune < 0) return newError('strings.Reader.UnreadRune: previous operation was not ReadRune');
    r.i = r.prevRune;
    r.prevRune = -1;
    return;
  },
  true
);
addMethod(
  READER,
  'Seek',
  fn([BASIC.int64, INT], [BASIC.int64, ERROR_TYPE]),
  (receiver, [offset, whence]) => {
    const r = new ReaderFields(receiver);
    r.prevRune = -1;
    const base = [0n, BigInt(r.i), BigInt(r.s.length)][Number(whence as bigint)] as bigint | undefined;
    if (base === undefined) return [0n, newError('strings.Reader.Seek: invalid whence')];
    const position = BigInt.asIntN(64, base + (offset as bigint));
    if (position < 0n) return [0n, newError('strings.Reader.Seek: negative position')];
    receiverStruct(receiver).fields[1] = position;
    return [position, undefined];
  },
  true
);
addMethod(
  READER,
  'WriteTo',
  fn([IO_WRITER], [BASIC.int64, ERROR_TYPE]),
  (receiver, [writer]) => {
    const r = new ReaderFields(receiver);
    r.prevRune = -1;
    if (r.i >= r.s.length) return [0n, undefined];
    const rest = r.s.slice(r.i);
    spendFor(rest.length);
    const [written, error] = writeString(writer, rest);
    const count = Number(written);
    if (count > rest.length) stringPanic('strings.Reader.WriteTo: invalid WriteString count');
    r.i += count;
    return [BigInt(count), count !== rest.length && error === undefined ? ERR_SHORT_WRITE : error];
  },
  true
);
addMethod(
  READER,
  'Reset',
  fn([STRING], []),
  (receiver, [s]) => {
    receiverStruct(receiver).fields.splice(0, 3, s, 0n, -1n);
    return;
  },
  true
);
addMethod(
  READER,
  'Len',
  fn([], [INT]),
  (receiver) => {
    const r = new ReaderFields(receiver);
    return BigInt(Math.max(r.s.length - r.i, 0));
  },
  true
);
addMethod(READER, 'Size', fn([], [BASIC.int64]), (receiver) => BigInt(new ReaderFields(receiver).s.length), true);

// Replacer ----------------------------------------------------------------------------------------------------------

const REPLACER = namedType('strings', 'Replacer', { kind: 'struct', fields: [] });

/**
 * Replaces at each position the first old string, in argument order, that matches there, without overlaps. Every
 * comparison is charged, matching or not, since the work grows with the input length times the number of pairs.
 */
function replaceAllPairs(s: string, pairs: string[]): string {
  const runtime = currentRuntime();
  let result = '';
  let at = 0;
  let work = 0;
  const hasEmpty = pairs.some((value, index) => index % 2 === 0 && value === '');
  while (at <= s.length) {
    let matched = false;
    for (let pair = 0; pair < pairs.length; pair += 2) {
      const old = pairs[pair];
      work += 1 + (old.length >>> 4);
      if (old !== '' && s.startsWith(old, at)) {
        result = appendBounded(result, pairs[pair + 1]);
        at += old.length;
        matched = true;
        break;
      }
      if (old === '') {
        result = appendBounded(result, pairs[pair + 1]);
        break;
      }
    }
    if (work >= 1024) {
      runtime.spend(work);
      work = 0;
    }
    if (matched) continue;
    if (at >= s.length) break;
    const size = hasEmpty ? decodeRune(s, at).size : 1;
    result = appendBounded(result, s.slice(at, at + size));
    at += size;
  }
  runtime.spend(work + 1);
  return result;
}

addMethod(
  REPLACER,
  'Replace',
  fn([STRING], [STRING]),
  (receiver, [text]) => {
    const pairs = (receiverStruct(receiver).native?.pairs as string[] | undefined) ?? [];
    return replaceAllPairs(text as string, pairs);
  },
  true
);
addMethod(
  REPLACER,
  'WriteString',
  fn([IO_WRITER, STRING], [INT, ERROR_TYPE]),
  (receiver, [writer, text]) => {
    const pairs = (receiverStruct(receiver).native?.pairs as string[] | undefined) ?? [];
    return writeString(writer, replaceAllPairs(text as string, pairs));
  },
  true
);

// Package -----------------------------------------------------------------------------------------------------------

const s2 =
  (impl: (a: string, b: string) => Value | Value[]) =>
  ([a, b]: Value[]) =>
    impl(a as string, b as string);

const members: Record<string, Entity> = {
  Builder: typeEntity(BUILDER),
  Reader: typeEntity(READER),
  Replacer: typeEntity(REPLACER),
  Contains: nativeFunction(
    'Contains',
    fn([STRING, STRING], [BOOL]),
    s2((a, b) => index(a, b) >= 0)
  ),
  ContainsRune: nativeFunction('ContainsRune', fn([STRING, RUNE], [BOOL]), ([s, rune]) =>
    containsRune(s as string, Number(rune as bigint))
  ),
  ContainsAny: nativeFunction(
    'ContainsAny',
    fn([STRING, STRING], [BOOL]),
    s2((s, chars) => runeIndex(s, cutset(chars)) >= 0)
  ),
  ContainsFunc: nativeFunction(
    'ContainsFunc',
    fn([STRING, RUNE_PREDICATE], [BOOL]),
    ([s, f]) => runeIndex(s as string, predicateOf(f)) >= 0
  ),
  Count: nativeFunction(
    'Count',
    fn([STRING, STRING], [INT]),
    s2((s, sub) => BigInt(countSubstrings(s, sub)))
  ),
  Cut: nativeFunction(
    'Cut',
    fn([STRING, STRING], [STRING, STRING, BOOL]),
    s2((s, sep) => {
      const found = s.indexOf(sep);
      return found === -1 ? [s, '', false] : [s.slice(0, found), s.slice(found + sep.length), true];
    })
  ),
  CutLast: nativeFunction(
    'CutLast',
    fn([STRING, STRING], [STRING, STRING, BOOL]),
    s2((s, sep) => {
      const found = s.lastIndexOf(sep);
      return found === -1 ? [s, '', false] : [s.slice(0, found), s.slice(found + sep.length), true];
    })
  ),
  CutPrefix: nativeFunction(
    'CutPrefix',
    fn([STRING, STRING], [STRING, BOOL]),
    s2((s, prefix) => (s.startsWith(prefix) ? [s.slice(prefix.length), true] : [s, false]))
  ),
  CutSuffix: nativeFunction(
    'CutSuffix',
    fn([STRING, STRING], [STRING, BOOL]),
    s2((s, suffix) => (s.endsWith(suffix) ? [s.slice(0, s.length - suffix.length), true] : [s, false]))
  ),
  EqualFold: nativeFunction('EqualFold', fn([STRING, STRING], [BOOL]), s2(equalFold)),
  Fields: nativeFunction('Fields', fn([STRING], [STRINGS]), ([s]) => stringList(fields(s as string, isSpace))),
  FieldsFunc: nativeFunction('FieldsFunc', fn([STRING, RUNE_PREDICATE], [STRINGS]), ([s, f]) =>
    stringList(fields(s as string, predicateOf(f)))
  ),
  HasPrefix: nativeFunction(
    'HasPrefix',
    fn([STRING, STRING], [BOOL]),
    s2((s, prefix) => s.startsWith(prefix))
  ),
  HasSuffix: nativeFunction(
    'HasSuffix',
    fn([STRING, STRING], [BOOL]),
    s2((s, suffix) => s.endsWith(suffix))
  ),
  Index: nativeFunction(
    'Index',
    fn([STRING, STRING], [INT]),
    s2((s, sub) => BigInt(index(s, sub)))
  ),
  IndexByte: nativeFunction('IndexByte', fn([STRING, BASIC.uint8], [INT]), ([s, byte]) =>
    BigInt((s as string).indexOf(String.fromCharCode(Number(byte as bigint))))
  ),
  IndexRune: nativeFunction('IndexRune', fn([STRING, RUNE], [INT]), ([s, rune]) =>
    BigInt(runeIndex(s as string, (r) => r === Number(rune as bigint)))
  ),
  IndexAny: nativeFunction(
    'IndexAny',
    fn([STRING, STRING], [INT]),
    s2((s, chars) => BigInt(runeIndex(s, cutset(chars))))
  ),
  IndexFunc: nativeFunction('IndexFunc', fn([STRING, RUNE_PREDICATE], [INT]), ([s, f]) =>
    BigInt(runeIndex(s as string, predicateOf(f)))
  ),
  LastIndex: nativeFunction(
    'LastIndex',
    fn([STRING, STRING], [INT]),
    s2((s, sub) => BigInt(s.lastIndexOf(sub)))
  ),
  LastIndexByte: nativeFunction('LastIndexByte', fn([STRING, BASIC.uint8], [INT]), ([s, byte]) =>
    BigInt((s as string).lastIndexOf(String.fromCharCode(Number(byte as bigint))))
  ),
  LastIndexAny: nativeFunction(
    'LastIndexAny',
    fn([STRING, STRING], [INT]),
    s2((s, chars) => BigInt(runeIndex(s, cutset(chars), true)))
  ),
  LastIndexFunc: nativeFunction('LastIndexFunc', fn([STRING, RUNE_PREDICATE], [INT]), ([s, f]) =>
    BigInt(runeIndex(s as string, predicateOf(f), true))
  ),
  Join: nativeFunction('Join', fn([STRINGS, STRING], [STRING]), ([elements, sep]) => {
    const parts = sliceValues(elements) as string[];
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    const sepStr = sep as string;
    let total = BigInt(sepStr.length) * BigInt(parts.length - 1);
    for (const part of parts) total += BigInt(part.length);
    if (total > BigInt(LIMITS.maxStringLength)) currentRuntime().checkStringLength(LIMITS.maxStringLength + 1);
    spendFor(Number(total));
    return parts.join(sepStr);
  }),
  Map: nativeFunction('Map', fn([funcType([RUNE], [RUNE]), STRING], [STRING]), ([mapping, s]) =>
    mapRunes(s as string, (rune) => Number(callFunction(mapping, [BigInt(rune)]) as bigint))
  ),
  Repeat: nativeFunction('Repeat', fn([STRING, INT], [STRING]), ([s, count]) => {
    const times = count as bigint;
    if (times < 0n) stringPanic('strings: negative Repeat count');
    const text = s as string;
    if (times === 0n || text.length === 0) return '';
    const total = BigInt(text.length) * times;
    if (total >= 1n << 63n) stringPanic('strings: Repeat output length overflow');
    if (total > BigInt(LIMITS.maxStringLength)) currentRuntime().checkStringLength(LIMITS.maxStringLength + 1);
    const bytes = Number(total);
    spendFor(bytes);
    return text.repeat(Number(times));
  }),
  Replace: nativeFunction('Replace', fn([STRING, STRING, STRING, INT], [STRING]), ([s, old, replacement, count]) =>
    replace(s as string, old as string, replacement as string, Number(count as bigint))
  ),
  ReplaceAll: nativeFunction('ReplaceAll', fn([STRING, STRING, STRING], [STRING]), ([s, old, replacement]) =>
    replace(s as string, old as string, replacement as string, -1)
  ),
  NewReplacer: nativeFunction('NewReplacer', fn([STRINGS], [pointerTo(REPLACER)], true), ([pairs]) => {
    const values = sliceValues(pairs) as string[];
    if (values.length % 2 === 1) stringPanic('strings.NewReplacer: odd argument count');
    return new Pointer(new Cell(new GoStruct([], { pairs: values })), 'v');
  }),
  NewReader: nativeFunction('NewReader', fn([STRING], [pointerTo(READER)]), ([s]) => newReader(s as string)),
  Split: nativeFunction(
    'Split',
    fn([STRING, STRING], [STRINGS]),
    s2((s, sep) => splitSlice(s, sep, false, -1))
  ),
  SplitN: nativeFunction('SplitN', fn([STRING, STRING, INT], [STRINGS]), ([s, sep, n]) =>
    splitSlice(s as string, sep as string, false, Number(n as bigint))
  ),
  SplitAfter: nativeFunction(
    'SplitAfter',
    fn([STRING, STRING], [STRINGS]),
    s2((s, sep) => splitSlice(s, sep, true, -1))
  ),
  SplitAfterN: nativeFunction('SplitAfterN', fn([STRING, STRING, INT], [STRINGS]), ([s, sep, n]) =>
    splitSlice(s as string, sep as string, true, Number(n as bigint))
  ),
  ToLower: nativeFunction('ToLower', fn([STRING], [STRING]), ([s]) => mapRunes(s as string, toLower)),
  ToUpper: nativeFunction('ToUpper', fn([STRING], [STRING]), ([s]) => mapRunes(s as string, toUpper)),
  Title: nativeFunction('Title', fn([STRING], [STRING]), ([s]) => {
    let previous = 0x20;
    return mapRunes(s as string, (rune) => {
      const mapped = isWordSeparator(previous) ? toTitle(rune) : rune;
      previous = rune;
      return mapped;
    });
  }),
  ToTitle: nativeFunction('ToTitle', fn([STRING], [STRING]), ([s]) => mapRunes(s as string, toTitle)),
  ...Object.fromEntries(
    ['ToUpperSpecial', 'ToLowerSpecial', 'ToTitleSpecial'].map((name, kind) => [
      name,
      nativeFunction(name, fn([SPECIAL_CASE, STRING], [STRING]), ([special, s]) =>
        mapRunes(s as string, specialCaseMapper(special, kind))
      ),
    ])
  ),
  Trim: nativeFunction(
    'Trim',
    fn([STRING, STRING], [STRING]),
    s2((s, chars) => trimRight(trimLeft(s, cutset(chars)), cutset(chars)))
  ),
  TrimLeft: nativeFunction(
    'TrimLeft',
    fn([STRING, STRING], [STRING]),
    s2((s, chars) => trimLeft(s, cutset(chars)))
  ),
  TrimRight: nativeFunction(
    'TrimRight',
    fn([STRING, STRING], [STRING]),
    s2((s, chars) => trimRight(s, cutset(chars)))
  ),
  TrimSpace: nativeFunction('TrimSpace', fn([STRING], [STRING]), ([s]) =>
    trimRight(trimLeft(s as string, isSpace), isSpace)
  ),
  TrimPrefix: nativeFunction(
    'TrimPrefix',
    fn([STRING, STRING], [STRING]),
    s2((s, prefix) => (s.startsWith(prefix) ? s.slice(prefix.length) : s))
  ),
  TrimSuffix: nativeFunction(
    'TrimSuffix',
    fn([STRING, STRING], [STRING]),
    s2((s, suffix) => (suffix !== '' && s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s))
  ),
  TrimFunc: nativeFunction('TrimFunc', fn([STRING, RUNE_PREDICATE], [STRING]), ([s, f]) =>
    trimRight(trimLeft(s as string, predicateOf(f)), predicateOf(f))
  ),
  TrimLeftFunc: nativeFunction('TrimLeftFunc', fn([STRING, RUNE_PREDICATE], [STRING]), ([s, f]) =>
    trimLeft(s as string, predicateOf(f))
  ),
  TrimRightFunc: nativeFunction('TrimRightFunc', fn([STRING, RUNE_PREDICATE], [STRING]), ([s, f]) =>
    trimRight(s as string, predicateOf(f))
  ),
  Compare: nativeFunction(
    'Compare',
    fn([STRING, STRING], [INT]),
    s2((a, b) => (a < b ? -1n : a > b ? 1n : 0n))
  ),
  Clone: nativeFunction('Clone', fn([STRING], [STRING]), ([s]) => bytesString(s)),
  ToValidUTF8: nativeFunction(
    'ToValidUTF8',
    fn([STRING, STRING], [STRING]),
    s2((s, replacement) => {
      spendFor(s.length);
      let result = '';
      let invalid = false;
      for (let at = 0; at < s.length;) {
        const { rune, size } = decodeRune(s, at);
        if (rune === RUNE_ERROR && size === 1) {
          if (!invalid) result = appendBounded(result, replacement);
          invalid = true;
        } else {
          result = appendBounded(result, s.slice(at, at + size));
          invalid = false;
        }
        at += size;
      }
      return result;
    })
  ),
};

export const STRINGS_PACKAGE = definePackage(
  'strings',
  members,
  ['NewReader', 'Lines', 'SplitSeq', 'SplitAfterSeq', 'FieldsSeq', 'FieldsFuncSeq'].filter((name) => !(name in members))
);
