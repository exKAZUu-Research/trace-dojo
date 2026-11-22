import { concatStrings, madeString, stringByteLength, stringCapacity, StringGrowth, vecCapacity } from '../capacity';
import { charEscapeDebug, escapeDebug } from '../fmt';
import { normalize } from '../infer';
import { strSliceBytes } from '../interpreter';
// code-gauge-allow-file fileNcss 488 -- One native per method of the standard library.
import { described, tuplePart } from '../iterDebug';
import { cloneValue } from '../ops';
import { RustPanic } from '../runtime';
import { REF_STR, shallow, type Type } from '../types';
import { decodeUtf8, utf8Length as byteLength, utf8Reader } from '../utf8';
import {
  FnValue,
  isPlace,
  type IterValue,
  sliceItems,
  SliceView,
  StringValue,
  StructValue,
  textOf,
  UNIT_VALUE,
  type Value,
} from '../values';
import { checkVecCapacity, intoStringBytes, repeatedLength, withStringCapacity } from './capacityNatives';
import { arrayIter } from './iterators';
import { parseFloatText, parseInteger } from './numbers';
import { checkedRangeBounds, numericBounds } from './ranges';
import { appendText, collectString, extendString } from './stringBuilder';
import { byteCursor, charCursor, finalScalarStart } from './stringCursors';
import {
  linesIter,
  matchesIter,
  type PatternKind,
  searcherOf,
  splitAsciiWhitespaceIter,
  splitIter,
  splitNIter,
  splitWhitespaceIter,
} from './strSplit';
import {
  call,
  define,
  deref,
  err,
  libraryPanic,
  type NativeContext,
  none,
  ok,
  option,
  panic,
  placeOf,
  some,
} from './support';

const encoder = new TextEncoder();

function patternValue(value: Value): Value {
  const pattern = deref(value);
  return pattern instanceof StringValue ? pattern.text : pattern;
}

/** The byte offset in UTF-8 of a UTF-16 index. */
function byteOffset(text: string, index: number): number {
  return byteLength(text.slice(0, index));
}

/** The UTF-16 index of a byte offset, which must be at a character boundary. */
function charIndex(text: string, offset: number): number {
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    if (bytes >= offset) return index;
    bytes += byteLength(char);
    index += char.length;
  }
  return index;
}

/** A matcher of the patterns `str` methods take: a char, a string, chars, or a closure over chars. */
// code-gauge-allow functionCognitiveComplexity 23 -- One native per method of the standard library.
function patternMatcher(
  ctx: NativeContext,
  pattern: Value
): (text: string, from: number) => { index: number; length: number } | undefined {
  const p = patternValue(pattern);
  if (p instanceof FnValue) {
    return (text, from) => {
      for (let index = from; index < text.length;) {
        const char = String.fromCodePoint(text.codePointAt(index)!);
        if (call(ctx, p, [char])) return { index, length: char.length };
        index += char.length;
      }
      return;
    };
  }
  if (Array.isArray(p) || (typeof p === 'object' && p !== null && 'base' in p)) {
    const chars = new Set(
      (Array.isArray(p)
        ? p
        : (p as { base: Value[]; start: number; end: number }).base.slice(
            (p as { start: number }).start,
            (p as { end: number }).end
          )) as string[]
    );
    return (text, from) => {
      for (let index = from; index < text.length;) {
        const char = String.fromCodePoint(text.codePointAt(index)!);
        if (chars.has(char)) return { index, length: char.length };
        index += char.length;
      }
      return;
    };
  }
  const needle = p as string;
  if (needle === '') return matchEmpty;
  return (text, from) => {
    const index = text.indexOf(needle, from);
    return index === -1 ? undefined : { index, length: needle.length };
  };
}

/** The searcher std picks for a pattern, by the pattern's type. */
function patternOf(ctx: NativeContext, pattern: Value): PatternKind {
  const p = patternValue(pattern);
  if (p instanceof FnValue) return predicatePattern(ctx, p);
  if (typeof p === 'string') {
    return normalize(shallow(ctx.typeArgs[0])).kind === 'char' ? { kind: 'char', char: p } : { kind: 'str', needle: p };
  }
  const type = normalize(shallow(ctx.typeArgs[0]));
  const target = type.kind === 'ref' ? normalize(shallow(type.target)) : type;
  const searcher =
    type.kind !== 'ref' ? 'CharArraySearcher' : target.kind === 'array' ? 'CharArrayRefSearcher' : 'CharSliceSearcher';
  return { kind: 'chars', chars: sliceItems(p) as string[], searcher };
}

function predicatePattern(ctx: NativeContext, predicate: FnValue): Extract<PatternKind, { kind: 'predicate' }> {
  return {
    kind: 'predicate',
    value: predicate,
    matches: (char) => call(ctx, predicate, [char]) as boolean,
    fork: () => predicatePattern(ctx, cloneValue(ctx.typeArgs[0], predicate) as FnValue),
  };
}

/** The empty pattern matches at every char boundary up to the end, where `indexOf` would match forever. */
function matchEmpty(text: string, from: number): { index: number; length: number } | undefined {
  if (from > text.length) return;
  const insidePair = from > 0 && from < text.length && /[\uDC00-\uDFFF]/.test(text[from]);
  return { index: insidePair ? from + 1 : from, length: 0 };
}

/** The text before a byte offset, which `String`'s methods assert is at a character boundary. */
function headAtBoundary(ctx: NativeContext, text: string, offset: number, name: string): string {
  const bytes = encoder.encode(text);
  if (!isCharBoundary(bytes, offset)) {
    panic(ctx, `assertion failed: self.is_char_boundary(${name})`);
  }
  return decodeUtf8(bytes.subarray(0, offset));
}

function isCharBoundary(bytes: Uint8Array, offset: number): boolean {
  return offset === bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) !== 0x80);
}

/**
 * Where UTF-8 decoding fails, as `Utf8Error` reports it: the valid prefix's length, and the invalid sequence's length,
 * or undefined when the bytes end in the middle of a sequence.
 */
function utf8Error(bytes: Uint8Array): { validUpTo: number; errorLen: number | undefined } {
  let index = 0;
  while (index < bytes.length) {
    const width = sequenceWidth(bytes[index]);
    if (width === 0) return { validUpTo: index, errorLen: 1 };
    for (let offset = 1; offset < width; offset++) {
      if (index + offset >= bytes.length) return { validUpTo: index, errorLen: undefined };
      const [low, high] = offset === 1 ? secondByteRange(bytes[index]) : [0x80, 0xbf];
      const byte = bytes[index + offset];
      if (byte < low || byte > high) return { validUpTo: index, errorLen: offset };
    }
    index += width;
  }
  return { validUpTo: index, errorLen: undefined };
}

/** How many bytes a UTF-8 sequence that starts with `first` takes, or 0 when no sequence starts with it. */
function sequenceWidth(first: number): number {
  if (first < 0x80) return 1;
  if (first >= 0xc2 && first <= 0xdf) return 2;
  if (first >= 0xe0 && first <= 0xef) return 3;
  return first >= 0xf0 && first <= 0xf4 ? 4 : 0;
}

/** The bytes that may follow a sequence's first byte, which exclude overlong forms and surrogates. */
function secondByteRange(first: number): [number, number] {
  if (first === 0xe0) return [0xa0, 0xbf];
  if (first === 0xed) return [0x80, 0x9f];
  if (first === 0xf0) return [0x90, 0xbf];
  if (first === 0xf4) return [0x80, 0x8f];
  return [0x80, 0xbf];
}

function isWhitespace(char: string): boolean {
  return /^\p{White_Space}$/u.test(char);
}

function trimWith(text: string, start: boolean, end: boolean, test: (char: string) => boolean): string {
  const chars = [...text];
  let from = 0;
  let to = chars.length;
  if (start) while (from < to && test(chars[from])) from++;
  const firstUntested = start && from < to ? from + 1 : from;
  if (end) while (to > firstUntested && test(chars[to - 1])) to--;
  return chars.slice(from, to).join('');
}

function charTest(ctx: NativeContext, pattern: Value): (char: string) => boolean {
  const p = patternValue(pattern);
  if (p instanceof FnValue) return (char) => call(ctx, p, [char]) as boolean;
  if (typeof p === 'string' && [...p].length === 1) return (char) => char === p;
  if (Array.isArray(p) || p instanceof SliceView) {
    const chars = sliceItems(p);
    return (char) => chars.includes(char);
  }
  return () => false;
}

function trimMatches(ctx: NativeContext, text: string, pattern: Value, start: boolean, end: boolean): string {
  const p = patternValue(pattern);
  if (typeof p === 'string' && [...p].length !== 1) {
    let result = text;
    if (p === '') return result;
    if (start) while (result.startsWith(p)) result = result.slice(p.length);
    if (end) while (result.endsWith(p)) result = result.slice(0, -p.length);
    return result;
  }
  return trimWith(text, start, end, charTest(ctx, pattern));
}

function startsWith(ctx: NativeContext, text: string, pattern: Value): number | undefined {
  const p = patternValue(pattern);
  if (typeof p === 'string') return text.startsWith(p) ? p.length : undefined;
  const first = [...text][0];
  return first !== undefined && charTest(ctx, pattern)(first) ? first.length : undefined;
}

function endsWith(ctx: NativeContext, text: string, pattern: Value): number | undefined {
  const p = patternValue(pattern);
  if (typeof p === 'string') return text.endsWith(p) ? p.length : undefined;
  const last = [...text].at(-1);
  return last !== undefined && charTest(ctx, pattern)(last) ? last.length : undefined;
}

function upper(text: string): string {
  return text.toUpperCase();
}

function lower(text: string): string {
  // Rust lowercases a final capital sigma as ς only at a word's end, as JS does.
  return text.toLowerCase();
}

/** `str::parse`, by the target type. */
function parse(ctx: NativeContext, text: string): Value {
  const target = normalize(shallow(ctx.typeArgs[0]));
  switch (target.kind) {
    case 'int': {
      return parseInteger(ctx, text, target.name, 10);
    }
    case 'float': {
      return parseFloatText(ctx, text, target.name === 'f32');
    }
    case 'bool': {
      if (text === 'true') return ok(ctx, true);
      if (text === 'false') return ok(ctx, false);
      return err(ctx, new StructValue(ctx.interp.program.adtDef('ParseBoolError'), []));
    }
    case 'char': {
      const chars = [...text];
      if (chars.length === 1) return ok(ctx, chars[0]);
      return err(
        ctx,
        new StructValue(ctx.interp.program.adtDef('ParseCharError'), [
          chars.length === 0 ? 'EmptyString' : 'TooManyChars',
        ])
      );
    }
    default: {
      return ok(ctx, text);
    }
  }
}

function rangeBounds(range: Value, length: number): { start: number; end: number } {
  const [start, end] = numericBounds(range, BigInt(length));
  return { start: Number(start), end: Number(end) };
}

const strNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  len: ([s]) => BigInt(stringByteLength(s)),
  is_empty: ([s]) => textOf(s).length === 0,
  chars: ([s]) => charCursor(textOf(s)),
  bytes: ([s]) => byteCursor(textOf(s)),
  char_indices: ([s]) => charCursor(textOf(s), true),
  as_bytes: ([s], ctx) => utf8Reader.bytesView(textOf(s), ctx.runtime),
  trim: ([s]) => trimWith(textOf(s), true, true, isWhitespace),
  trim_start: ([s]) => trimWith(textOf(s), true, false, isWhitespace),
  trim_end: ([s]) => trimWith(textOf(s), false, true, isWhitespace),
  trim_matches: ([s, p], ctx) => trimMatches(ctx, textOf(s), p, true, true),
  trim_start_matches: ([s, p], ctx) => trimMatches(ctx, textOf(s), p, true, false),
  trim_end_matches: ([s, p], ctx) => trimMatches(ctx, textOf(s), p, false, true),
  strip_prefix: ([s, p], ctx) => {
    const text = textOf(s);
    const length = startsWith(ctx, text, p);
    return option(ctx, length === undefined ? undefined : text.slice(length), length !== undefined);
  },
  strip_suffix: ([s, p], ctx) => {
    const text = textOf(s);
    const length = endsWith(ctx, text, p);
    return option(ctx, length === undefined ? undefined : text.slice(0, text.length - length), length !== undefined);
  },
  split_whitespace: ([s]) => splitWhitespaceIter(textOf(s), isWhitespace),
  split_ascii_whitespace: ([s]) => splitAsciiWhitespaceIter(textOf(s)),
  lines: ([s]) => linesIter(textOf(s)),
  split: ([s, p], ctx) => splitIter(textOf(s), patternOf(ctx, p), 'Split'),
  rsplit: ([s, p], ctx) => splitIter(textOf(s), patternOf(ctx, p), 'RSplit'),
  split_inclusive: ([s, p], ctx) => splitIter(textOf(s), patternOf(ctx, p), 'SplitInclusive'),
  split_terminator: ([s, p], ctx) => splitIter(textOf(s), patternOf(ctx, p), 'SplitTerminator'),
  rsplit_terminator: ([s, p], ctx) => splitIter(textOf(s), patternOf(ctx, p), 'RSplitTerminator'),
  splitn: ([s, n, p], ctx) => splitNIter(textOf(s), patternOf(ctx, p), n as bigint, false),
  rsplitn: ([s, n, p], ctx) => splitNIter(textOf(s), patternOf(ctx, p), n as bigint, true),
  split_once: ([s, p], ctx) => splitOnce(ctx, textOf(s), p, false),
  rsplit_once: ([s, p], ctx) => splitOnce(ctx, textOf(s), p, true),
  split_at: ([s, mid], ctx) => {
    const text = textOf(s);
    // `str::split_at` reports its panics inside the library, unlike slicing with `&s[..mid]`.
    let head: string;
    try {
      head = strSliceBytes(text, 0, mid as bigint, ctx.span);
    } catch (error) {
      if (error instanceof RustPanic) libraryPanic(ctx, error.message, 'core/src/str/mod.rs:862:21');
      throw error;
    }
    return [head, text.slice(head.length)];
  },
  contains: ([s, p], ctx) => patternMatcher(ctx, p)(textOf(s), 0) !== undefined,
  starts_with: ([s, p], ctx) => startsWith(ctx, textOf(s), p) !== undefined,
  ends_with: ([s, p], ctx) => endsWith(ctx, textOf(s), p) !== undefined,
  find: ([s, p], ctx) => {
    const text = textOf(s);
    const found = patternMatcher(ctx, p)(text, 0);
    return option(ctx, found && BigInt(byteOffset(text, found.index)), found !== undefined);
  },
  rfind: ([s, p], ctx) => {
    const found = searcherOf(textOf(s), patternOf(ctx, p)).nextMatchBack();
    return found ? some(ctx, BigInt(found[0])) : none(ctx);
  },
  matches: ([s, p], ctx) => matchesIter(textOf(s), patternOf(ctx, p), false),
  rmatches: ([s, p], ctx) => matchesIter(textOf(s), patternOf(ctx, p), false, true),
  match_indices: ([s, p], ctx) => matchesIter(textOf(s), patternOf(ctx, p), true),
  rmatch_indices: ([s, p], ctx) => matchesIter(textOf(s), patternOf(ctx, p), true, true),
  replace: ([s, from, to], ctx) => replaceN(ctx, textOf(s), from, textOf(to), Number.POSITIVE_INFINITY),
  replacen: ([s, from, to, count], ctx) => replaceN(ctx, textOf(s), from, textOf(to), Number(count as bigint)),
  to_uppercase: ([s]) => upper(textOf(s)),
  to_lowercase: ([s]) => lower(textOf(s)),
  to_ascii_uppercase: ([s]) => textOf(s).replaceAll(/[a-z]/g, (c) => c.toUpperCase()),
  to_ascii_lowercase: ([s]) => textOf(s).replaceAll(/[A-Z]/g, (c) => c.toLowerCase()),
  make_ascii_uppercase: ([s]) => {
    const place = placeOf(s);
    place.set(
      madeString(
        textOf(place).replaceAll(/[a-z]/g, (c) => c.toUpperCase()),
        stringCapacity(place)
      )
    );
    return UNIT_VALUE;
  },
  make_ascii_lowercase: ([s]) => {
    const place = placeOf(s);
    place.set(
      madeString(
        textOf(place).replaceAll(/[A-Z]/g, (c) => c.toLowerCase()),
        stringCapacity(place)
      )
    );
    return UNIT_VALUE;
  },
  eq_ignore_ascii_case: ([a, b]) =>
    textOf(a).replaceAll(/[A-Z]/g, (c) => c.toLowerCase()) === textOf(b).replaceAll(/[A-Z]/g, (c) => c.toLowerCase()),
  repeat: ([s, n], ctx) => {
    const text = textOf(s);
    const bytes = repeatedLength(ctx, byteLength(text), n as bigint);
    checkVecCapacity(ctx, 0, bytes, 1);
    if (bytes === 0n) return '';
    const count = Number(n as bigint);
    ctx.runtime.allocateString(text.length * count, undefined, bytes);
    return text.repeat(count);
  },
  parse: ([s], ctx) => parse(ctx, textOf(s)),
  to_owned: ([s]) => textOf(s),
  into_string: ([s]) => textOf(s),
  is_char_boundary: ([s, i], ctx) => isCharBoundary(ctx.runtime.utf8.of(textOf(s)), Number(i as bigint)),
  get: ([s, range], ctx) => {
    const text = textOf(s);
    const { start, end } = rangeBounds(range, byteLength(text));
    try {
      return some(ctx, strSliceBytes(text, start, end, ctx.span));
    } catch {
      return none(ctx);
    }
  },
  is_ascii: ([s]) => /^[\u0000-\u007F]*$/.test(textOf(s)),
};

function splitOnce(ctx: NativeContext, text: string, pattern: Value, reverse: boolean): Value {
  const searcher = searcherOf(text, patternOf(ctx, pattern));
  const found = reverse ? searcher.nextMatchBack() : searcher.nextMatch();
  if (!found) return none(ctx);
  return some(ctx, [decodeUtf8(searcher.bytes.subarray(0, found[0])), decodeUtf8(searcher.bytes.subarray(found[1]))]);
}

// code-gauge-allow functionNcss 33 -- The search cursor and the copied suffix differ for empty matches.
function replaceN(ctx: NativeContext, text: string, from: Value, to: string, count: number): StringValue {
  const pattern = patternValue(from);
  const fromBytes = typeof pattern === 'string' ? byteLength(pattern) : undefined;
  const toBytes = byteLength(to);
  const inputBytes = byteLength(text);
  if (count === Number.POSITIVE_INFINITY && typeof pattern === 'string' && fromBytes === 1 && toBytes === 1) {
    return madeString(
      text.replaceAll(pattern, () => to),
      inputBytes,
      inputBytes
    );
  }
  const capacity = Number.isFinite(count) ? 32 : fromBytes !== undefined && fromBytes <= toBytes ? inputBytes : 0;
  const growth = new StringGrowth(capacity);
  const match = patternMatcher(ctx, from);
  let result = '';
  const add = (piece: string): void => {
    result = appendText(ctx, result, piece);
    growth.write(piece);
  };
  let position = 0;
  let end = 0;
  for (let replaced = 0; replaced < count; replaced++) {
    const found = match(text, position);
    if (!found) break;
    ctx.runtime.spend();
    add(text.slice(end, found.index));
    add(to);
    end = found.index + found.length;
    if (found.length > 0) position = end;
    else if (end === text.length) break;
    else position = end + String.fromCodePoint(text.codePointAt(end)!).length;
  }
  add(text.slice(end));
  return growth.finish(result);
}

const stringNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  new: () => '',
  with_capacity: ([capacity], ctx) => {
    checkVecCapacity(ctx, 0, capacity, 1);
    return madeString('', Number(capacity as bigint));
  },
  from_iter: ([iter], ctx) => collectString(ctx, deref(iter) as IterValue, ctx.typeArgs[0], ctx.typeArgs[1]),
  from_utf8: ([bytes], ctx) => {
    const values = deref(bytes) as bigint[];
    const array = Uint8Array.from(values, Number);
    try {
      return ok(ctx, madeString(decodeUtf8(array, true), vecCapacity(values, values.length, 1)));
    } catch {
      return err(ctx, new StructValue(ctx.interp.program.adtDef('FromUtf8Error'), [values, utf8Failure(ctx, array)]));
    }
  },
  push_str: pushString,
  push: pushString,
  pop: ([self], ctx) => {
    const place = placeOf(self);
    const value = place.get();
    const text = textOf(value);
    const end = text.length;
    if (end === 0) return none(ctx);
    const start = finalScalarStart(text, end);
    const last = text.slice(start);
    const remaining = stringByteLength(value) - byteLength(last);
    place.set(madeString(text.slice(0, start), stringCapacity(value), remaining));
    return some(ctx, last);
  },
  insert: ([self, idx, c], ctx) => {
    const place = placeOf(self);
    const text = textOf(place);
    const head = headAtBoundary(ctx, text, Number(idx as bigint), 'idx');
    place.set(head + (c as string) + text.slice(head.length));
    return UNIT_VALUE;
  },
  insert_str: ([self, idx, s], ctx) => {
    const place = placeOf(self);
    const text = textOf(place);
    const head = headAtBoundary(ctx, text, Number(idx as bigint), 'idx');
    place.set(head + textOf(s) + text.slice(head.length));
    return UNIT_VALUE;
  },
  remove: ([self, idx], ctx) => {
    const place = placeOf(self);
    const text = textOf(place);
    const rest = strSliceBytes(text, idx as bigint, undefined, ctx.span);
    if (rest.length === 0) panic(ctx, 'cannot remove a char from the end of a string');
    const head = text.slice(0, text.length - rest.length);
    const char = String.fromCodePoint(rest.codePointAt(0)!);
    place.set(head + rest.slice(char.length));
    return char;
  },
  truncate: ([self, len], ctx) => {
    const place = placeOf(self);
    const text = textOf(place);
    const length = Number(len as bigint);
    if (length < byteLength(text)) place.set(headAtBoundary(ctx, text, length, 'new_len'));
    return UNIT_VALUE;
  },
  clear: ([self]) => {
    placeOf(self).set('');
    return UNIT_VALUE;
  },
  as_str: ([self]) => textOf(self),
  as_mut_str: ([self]) => self,
  into_bytes: ([self], ctx) => intoStringBytes(self, ctx),
  into_boxed_str: ([self]) => textOf(self),
  retain: ([self, f], ctx) => {
    const place = placeOf(self);
    place.set([...textOf(place)].filter((char) => call(ctx, f, [char]) as boolean).join(''));
    return UNIT_VALUE;
  },
  drain: ([self, range], ctx) => {
    const place = placeOf(self);
    const text = textOf(place);
    const bytes = encoder.encode(text);
    const [start, end] = stringRange(ctx, bytes, range, 'drain');
    const removed = decodeUtf8(bytes.subarray(start, end));
    place.set(decodeUtf8(bytes.subarray(0, start)) + decodeUtf8(bytes.subarray(end)));
    return described(charCursor(removed), (show, _item, target) =>
      tuplePart('Drain', [(indent, sink) => show((target.rest?.() ?? []).join(''), REF_STR, indent, sink)])
    );
  },
  split_off: ([self, at], ctx) => {
    const place = placeOf(self);
    const text = textOf(place);
    const head = headAtBoundary(ctx, text, Number(at as bigint), 'at');
    place.set(head);
    return text.slice(head.length);
  },
  replace_range: ([self, range, with_], ctx) => {
    const place = placeOf(self);
    const bytes = encoder.encode(textOf(place));
    const [start, end] = stringRange(ctx, bytes, range, 'replace');
    place.set(decodeUtf8(bytes.subarray(0, start)) + textOf(with_) + decodeUtf8(bytes.subarray(end)));
    return UNIT_VALUE;
  },
  extend: ([self, iter], ctx) => {
    const place = placeOf(self);
    place.set(extendString(ctx, place, deref(iter) as IterValue, ctx.typeArgs[0], ctx.typeArgs[1]));
    return UNIT_VALUE;
  },
};

function pushString([self, text]: Value[]): Value {
  const place = placeOf(self);
  place.set(concatStrings(place, text));
  return UNIT_VALUE;
}

function stringRange(
  ctx: NativeContext,
  bytes: Uint8Array,
  range: Value,
  method: 'drain' | 'replace'
): [number, number] {
  const [start, end] = checkedRangeBounds(ctx, range, bytes.length);
  for (const [point, offset] of [
    ['start', start],
    ['end', end],
  ] as const) {
    if (isCharBoundary(bytes, offset)) continue;
    panic(
      ctx,
      method === 'drain'
        ? `assertion failed: self.is_char_boundary(${point})`
        : `${point} of range should be a character boundary`
    );
  }
  return [start, end];
}

function charCode(value: Value): number {
  return (deref(value) as string).codePointAt(0)!;
}

const charNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  is_alphabetic: ([c]) => /^\p{Alphabetic}$/u.test(textOf(c)),
  is_numeric: ([c]) => /^[\p{Nd}\p{Nl}\p{No}]$/u.test(textOf(c)),
  is_alphanumeric: ([c]) => /^[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]$/u.test(textOf(c)),
  is_whitespace: ([c]) => isWhitespace(textOf(c)),
  is_uppercase: ([c]) => /^\p{Uppercase}$/u.test(textOf(c)),
  is_lowercase: ([c]) => /^\p{Lowercase}$/u.test(textOf(c)),
  is_control: ([c]) => /^\p{Cc}$/u.test(textOf(c)),
  is_digit: ([c, radix], ctx) => digitOf(ctx, textOf(c), Number(radix as bigint)) !== undefined,
  is_ascii: ([c]) => charCode(c) < 0x80,
  is_ascii_digit: ([c]) => /^[0-9]$/.test(textOf(c)),
  is_ascii_hexdigit: ([c]) => /^[0-9a-fA-F]$/.test(textOf(c)),
  is_ascii_alphabetic: ([c]) => /^[a-zA-Z]$/.test(textOf(c)),
  is_ascii_alphanumeric: ([c]) => /^[a-zA-Z0-9]$/.test(textOf(c)),
  is_ascii_uppercase: ([c]) => /^[A-Z]$/.test(textOf(c)),
  is_ascii_lowercase: ([c]) => /^[a-z]$/.test(textOf(c)),
  is_ascii_punctuation: ([c]) => /^[!-/:-@[-`{-~]$/.test(textOf(c)),
  is_ascii_whitespace: ([c]) => /^[ \t\n\f\r]$/.test(textOf(c)),
  is_ascii_graphic: ([c]) => charCode(c) > 0x20 && charCode(c) < 0x7f,
  is_ascii_control: ([c]) => charCode(c) < 0x20 || charCode(c) === 0x7f,
  to_ascii_uppercase: ([c]) => (/^[a-z]$/.test(textOf(c)) ? textOf(c).toUpperCase() : textOf(c)),
  to_ascii_lowercase: ([c]) => (/^[A-Z]$/.test(textOf(c)) ? textOf(c).toLowerCase() : textOf(c)),
  make_ascii_uppercase: ([c]) => {
    const place = placeOf(c);
    const value = textOf(place);
    place.set(/^[a-z]$/.test(value) ? value.toUpperCase() : value);
    return UNIT_VALUE;
  },
  make_ascii_lowercase: ([c]) => {
    const place = placeOf(c);
    const value = textOf(place);
    place.set(/^[A-Z]$/.test(value) ? value.toLowerCase() : value);
    return UNIT_VALUE;
  },
  eq_ignore_ascii_case: ([a, b]) =>
    textOf(a).replace(/[A-Z]/, (x) => x.toLowerCase()) === textOf(b).replace(/[A-Z]/, (x) => x.toLowerCase()),
  to_uppercase: ([c]) => caseIter('ToUppercase', textOf(c).toUpperCase()),
  to_lowercase: ([c]) => caseIter('ToLowercase', textOf(c).toLowerCase()),
  escape_default: ([c]) => {
    const text = textOf(c);
    const code = text.codePointAt(0)!;
    const escaped = ['\\', '"', "'", '\t', '\r', '\n'].includes(text)
      ? escapeDebug(text, text === "'")
      : code < 32 || code >= 127
        ? `\\u{${code.toString(16)}}`
        : text;
    return escapedChar('EscapeDefault', escaped);
  },
  escape_unicode: ([c]) => escapedChar('EscapeUnicode', `\\u{${textOf(c).codePointAt(0)!.toString(16)}}`),
  to_digit: ([c, radix], ctx) => {
    const digit = digitOf(ctx, textOf(c), Number(radix as bigint));
    return option(ctx, digit === undefined ? undefined : BigInt(digit), digit !== undefined);
  },
  len_utf8: ([c]) => BigInt(byteLength(textOf(c))),
  len_utf16: ([c]) => BigInt(textOf(c).length),
  from_u32: ([i], ctx) => fromU32(ctx, i),
  from_digit: ([num, radix], ctx) => fromDigit(ctx, num, radix),
};

function escapedChar(name: string, escaped: string): IterValue {
  return described(
    arrayIter(escaped.split('')),
    (_show, _item, target) => (indent) => charEscapeDebug(name, target, indent)
  );
}

function digitOf(ctx: NativeContext, c: string, radix: number): number | undefined {
  if (radix < 2 || radix > 36) {
    libraryPanic(
      ctx,
      'to_digit: invalid radix -- radix must be in the range 2 to 36 inclusive',
      'core/src/char/methods.rs:407:9'
    );
  }
  if (!/^[0-9a-zA-Z]$/.test(c)) return undefined;
  const digit = Number.parseInt(c, 36);
  return digit < radix ? digit : undefined;
}

function fromU32(ctx: NativeContext, value: Value): Value {
  const code = Number(value as bigint);
  if (code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) return none(ctx);
  return some(ctx, String.fromCodePoint(code));
}

function fromDigit(ctx: NativeContext, num: Value, radix: Value): Value {
  const base = Number(radix as bigint);
  if (base > 36) libraryPanic(ctx, 'from_digit: radix is too high (maximum 36)', 'core/src/char/convert.rs:332:9');
  const digit = Number(num as bigint);
  if (digit >= base) return none(ctx);
  return some(ctx, digit.toString(36));
}

/** `char::to_uppercase`'s iterator, named as std's type, which also displays as the text it yields. */
function caseIter(name: 'ToUppercase' | 'ToLowercase', text: string): Value {
  const iter = arrayIter([...text]);
  Object.assign(iter, { name });
  return iter;
}

function recoverUtf8(ctx: NativeContext, error: StructValue): StringValue {
  const [values, detail] = error.fields as [bigint[], StructValue];
  const bytes = Uint8Array.from(values, Number);
  let offset = Number(detail.fields[0] as bigint);
  const growth = new StringGrowth(bytes.length, offset);
  while (offset < bytes.length) {
    ctx.runtime.spend();
    const { validUpTo, errorLen } = utf8Error(bytes.subarray(offset));
    growth.writeBytes(validUpTo);
    offset += validUpTo;
    if (offset === bytes.length) break;
    growth.writeBytes(3);
    offset = errorLen === undefined ? bytes.length : offset + errorLen;
  }
  return growth.finish(decodeUtf8(bytes));
}

function utf8Failure(ctx: NativeContext, bytes: Uint8Array): StructValue {
  const { validUpTo, errorLen } = utf8Error(bytes);
  const length = errorLen === undefined ? none(ctx) : some(ctx, BigInt(errorLen));
  return new StructValue(ctx.interp.program.adtDef('Utf8Error'), [BigInt(validUpTo), length]);
}

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const [name, native] of Object.entries(strNatives)) natives[`str::${name}`] = native;
natives['std::str::from_utf8'] = ([value], ctx) => {
  const bytes = Uint8Array.from(sliceItems(deref(value)) as bigint[], Number);
  try {
    return ok(ctx, decodeUtf8(bytes, true));
  } catch {
    return err(ctx, utf8Failure(ctx, bytes));
  }
};
for (const [name, native] of Object.entries(withStringCapacity(stringNatives))) natives[`String::${name}`] = native;
natives['FromUtf8Error::as_bytes'] = ([self]) => (deref(self) as StructValue).fields[0];
natives['FromUtf8Error::into_bytes'] = natives['FromUtf8Error::as_bytes'];
natives['FromUtf8Error::into_utf8_lossy'] = ([self], ctx) => recoverUtf8(ctx, deref(self) as StructValue);
natives['FromUtf8Error::utf8_error'] = ([self]) => (deref(self) as StructValue).fields[1];
natives['Utf8Error::valid_up_to'] = ([self]) => (deref(self) as StructValue).fields[0];
natives['Utf8Error::error_len'] = ([self]) => (deref(self) as StructValue).fields[1];
natives['Write::write_str'] = (args, ctx) => {
  natives['String::push_str'](args, ctx);
  return ok(ctx, UNIT_VALUE);
};
natives['Write::write_char'] = (args, ctx) => {
  natives['String::push'](args, ctx);
  return ok(ctx, UNIT_VALUE);
};
for (const [name, native] of Object.entries(charNatives)) natives[`char::${name}`] = native;
// `u8`'s ASCII methods behave as `char`'s on the byte's code point.
const byteChar = (byte: Value): string => String.fromCodePoint(Number(deref(byte) as bigint));
for (const name of Object.keys(charNatives).filter((key) => key.includes('ascii'))) {
  natives[`u8::${name}`] = (args, ctx) => {
    if (name.startsWith('make_')) {
      const place = placeOf(args[0]);
      place.set(
        BigInt(textOf(charNatives[name.replace('make_', 'to_')]([byteChar(place.get())], ctx)).codePointAt(0)!)
      );
      return UNIT_VALUE;
    }
    const result = charNatives[name](args.map(byteChar), ctx);
    return typeof result === 'string' ? BigInt(result.codePointAt(0)!) : result;
  };
}
natives['FromStr::from_str'] = ([s], ctx) => parse(ctx, textOf(s));
natives['String::len'] = strNatives.len;
natives['String::is_empty'] = strNatives.is_empty;
natives['std::char::from_u32'] = ([i], ctx) => fromU32(ctx, i);
natives['std::char::from_digit'] = ([num, radix], ctx) => fromDigit(ctx, num, radix);
define(natives);

export function isStrType(type: Type): boolean {
  return normalize(shallow(type)).kind === 'str';
}

export { charIndex, isPlace };
