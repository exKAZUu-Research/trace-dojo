import { madeString } from '../capacity';
import { normalize } from '../infer';
import { strSliceBytes } from '../interpreter';
// code-gauge-allow-file fileNcss 488 -- One native per method of the standard library.
import { described, fieldsPart, listPart, numberPart, tuplePart } from '../iterDebug';
import { RustPanic } from '../runtime';
import { CHAR, REF_STR, shallow, type Type } from '../types';
import {
  DONE,
  FnValue,
  isPlace,
  type IterValue,
  type RangeValue,
  sliceItems,
  StructValue,
  UNIT_VALUE,
  type Value,
} from '../values';
import { checkVecCapacity, withStringCapacity } from './capacityNatives';
import { arrayIter } from './iterators';
import { parseFloatText, parseInteger } from './numbers';
import {
  linesIter,
  matchesIter,
  type PatternKind,
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

function str(value: Value): string {
  return deref(value) as string;
}

export function byteLength(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
  }
  return length;
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
  const p = deref(pattern);
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
  const p = deref(pattern);
  if (p instanceof FnValue) return { kind: 'predicate', matches: (char) => call(ctx, p, [char]) as boolean };
  if (typeof p === 'string') {
    return normalize(shallow(ctx.typeArgs[0])).kind === 'char' ? { kind: 'char', char: p } : { kind: 'str', needle: p };
  }
  const type = normalize(shallow(ctx.typeArgs[0]));
  const target = type.kind === 'ref' ? normalize(shallow(type.target)) : type;
  const searcher =
    type.kind !== 'ref' ? 'CharArraySearcher' : target.kind === 'array' ? 'CharArrayRefSearcher' : 'CharSliceSearcher';
  return { kind: 'chars', chars: sliceItems(p) as string[], searcher };
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
  if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) {
    panic(ctx, `assertion failed: self.is_char_boundary(${name})`);
  }
  return new TextDecoder().decode(bytes.slice(0, offset));
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

function strIter(items: string[]): IterValue {
  return arrayIter(items);
}

function isWhitespace(char: string): boolean {
  return /^[\s\u0085]$/u.test(char) && char !== '​';
}

function trimWith(text: string, start: boolean, end: boolean, test: (char: string) => boolean): string {
  const chars = [...text];
  let from = 0;
  let to = chars.length;
  if (start) while (from < to && test(chars[from])) from++;
  if (end) while (to > from && test(chars[to - 1])) to--;
  return chars.slice(from, to).join('');
}

function charTest(ctx: NativeContext, pattern: Value): (char: string) => boolean {
  const p = deref(pattern);
  if (p instanceof FnValue) return (char) => call(ctx, p, [char]) as boolean;
  if (typeof p === 'string' && [...p].length === 1) return (char) => char === p;
  if (Array.isArray(p)) return (char) => (p as string[]).includes(char);
  return () => false;
}

function trimMatches(ctx: NativeContext, text: string, pattern: Value, start: boolean, end: boolean): string {
  const p = deref(pattern);
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
  const p = deref(pattern);
  if (typeof p === 'string') return text.startsWith(p) ? p.length : undefined;
  const first = [...text][0];
  return first !== undefined && charTest(ctx, pattern)(first) ? first.length : undefined;
}

function endsWith(ctx: NativeContext, text: string, pattern: Value): number | undefined {
  const p = deref(pattern);
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
  const r = deref(range) as RangeValue | undefined;
  if (!r || (r.start === undefined && r.end === undefined)) return { start: 0, end: length };
  const start = r.start === undefined ? 0 : Number(r.start as bigint);
  const end = r.end === undefined ? length : Number(r.end as bigint) + (r.inclusive ? 1 : 0);
  return { start, end };
}

const strNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  len: ([s]) => BigInt(byteLength(str(s))),
  is_empty: ([s]) => str(s).length === 0,
  chars: ([s]) => strIter([...str(s)]),
  bytes: ([s]) => arrayIter(Array.from(encoder.encode(str(s)), BigInt)),
  char_indices: ([s]) => {
    const text = str(s);
    const items: Value[] = [];
    let offset = 0;
    for (const char of text) {
      items.push([BigInt(offset), char]);
      offset += byteLength(char);
    }
    const iter = arrayIter(items);
    // `CharIndices` shows the byte offset of its next `char` and the `Chars` of the rest.
    return described(iter, (show) => {
      const rest = (iter.rest?.() ?? []) as [bigint, string][];
      const chars = tuplePart('Chars', [
        listPart(
          rest.map(([, char]) => char),
          CHAR,
          show
        ),
      ]);
      return fieldsPart('CharIndices', [
        ['front_offset', numberPart(rest[0]?.[0] ?? offset)],
        ['iter', chars],
      ]);
    });
  },
  as_bytes: ([s]) => Array.from(encoder.encode(str(s)), BigInt),
  trim: ([s]) => trimWith(str(s), true, true, isWhitespace),
  trim_start: ([s]) => trimWith(str(s), true, false, isWhitespace),
  trim_end: ([s]) => trimWith(str(s), false, true, isWhitespace),
  trim_matches: ([s, p], ctx) => trimMatches(ctx, str(s), p, true, true),
  trim_start_matches: ([s, p], ctx) => trimMatches(ctx, str(s), p, true, false),
  trim_end_matches: ([s, p], ctx) => trimMatches(ctx, str(s), p, false, true),
  strip_prefix: ([s, p], ctx) => {
    const text = str(s);
    const length = startsWith(ctx, text, p);
    return option(ctx, length === undefined ? undefined : text.slice(length), length !== undefined);
  },
  strip_suffix: ([s, p], ctx) => {
    const text = str(s);
    const length = endsWith(ctx, text, p);
    return option(ctx, length === undefined ? undefined : text.slice(0, text.length - length), length !== undefined);
  },
  split_whitespace: ([s]) => splitWhitespaceIter(str(s), isWhitespace),
  split_ascii_whitespace: ([s]) => splitAsciiWhitespaceIter(str(s)),
  lines: ([s]) => linesIter(str(s)),
  split: ([s, p], ctx) => splitIter(str(s), patternOf(ctx, p), 'Split'),
  rsplit: ([s, p], ctx) => splitIter(str(s), patternOf(ctx, p), 'RSplit'),
  split_inclusive: ([s, p], ctx) => splitIter(str(s), patternOf(ctx, p), 'SplitInclusive'),
  split_terminator: ([s, p], ctx) => splitIter(str(s), patternOf(ctx, p), 'SplitTerminator'),
  splitn: ([s, n, p], ctx) => splitNIter(str(s), patternOf(ctx, p), Number(n as bigint), false),
  rsplitn: ([s, n, p], ctx) => splitNIter(str(s), patternOf(ctx, p), Number(n as bigint), true),
  split_once: ([s, p], ctx) => {
    const text = str(s);
    const found = patternMatcher(ctx, p)(text, 0);
    if (!found) return none(ctx);
    return some(ctx, [text.slice(0, found.index), text.slice(found.index + found.length)]);
  },
  rsplit_once: ([s, p], ctx) => {
    const text = str(s);
    const match = patternMatcher(ctx, p);
    let last: { index: number; length: number } | undefined;
    for (let found = match(text, 0); found; found = match(text, found.index + Math.max(found.length, 1))) {
      ctx.runtime.spend();
      last = found;
    }
    if (!last) return none(ctx);
    return some(ctx, [text.slice(0, last.index), text.slice(last.index + last.length)]);
  },
  split_at: ([s, mid], ctx) => {
    const text = str(s);
    const offset = Number(mid as bigint);
    // `str::split_at` reports its panics inside the library, unlike slicing with `&s[..mid]`.
    let head: string;
    try {
      head = strSliceBytes(text, 0, offset, ctx.span);
    } catch (error) {
      if (error instanceof RustPanic) libraryPanic(ctx, error.message, 'core/src/str/mod.rs:862:21');
      throw error;
    }
    return [head, text.slice(head.length)];
  },
  contains: ([s, p], ctx) => patternMatcher(ctx, p)(str(s), 0) !== undefined,
  starts_with: ([s, p], ctx) => startsWith(ctx, str(s), p) !== undefined,
  ends_with: ([s, p], ctx) => endsWith(ctx, str(s), p) !== undefined,
  find: ([s, p], ctx) => {
    const text = str(s);
    const found = patternMatcher(ctx, p)(text, 0);
    return option(ctx, found && BigInt(byteOffset(text, found.index)), found !== undefined);
  },
  rfind: ([s, p], ctx) => {
    const text = str(s);
    const match = patternMatcher(ctx, p);
    let last: { index: number } | undefined;
    for (let found = match(text, 0); found; found = match(text, found.index + 1)) {
      ctx.runtime.spend();
      last = found;
    }
    return option(ctx, last && BigInt(byteOffset(text, last.index)), last !== undefined);
  },
  matches: ([s, p], ctx) => matchesIter(str(s), patternOf(ctx, p), false),
  match_indices: ([s, p], ctx) => matchesIter(str(s), patternOf(ctx, p), true),
  replace: ([s, from, to], ctx) => replaceN(ctx, str(s), from, str(to), Number.POSITIVE_INFINITY),
  replacen: ([s, from, to, count], ctx) => replaceN(ctx, str(s), from, str(to), Number(count as bigint)),
  to_uppercase: ([s]) => upper(str(s)),
  to_lowercase: ([s]) => lower(str(s)),
  to_ascii_uppercase: ([s]) => str(s).replaceAll(/[a-z]/g, (c) => c.toUpperCase()),
  to_ascii_lowercase: ([s]) => str(s).replaceAll(/[A-Z]/g, (c) => c.toLowerCase()),
  make_ascii_uppercase: ([s]) => {
    const place = placeOf(s);
    place.set((place.get() as string).replaceAll(/[a-z]/g, (c) => c.toUpperCase()));
    return UNIT_VALUE;
  },
  make_ascii_lowercase: ([s]) => {
    const place = placeOf(s);
    place.set((place.get() as string).replaceAll(/[A-Z]/g, (c) => c.toLowerCase()));
    return UNIT_VALUE;
  },
  eq_ignore_ascii_case: ([a, b]) =>
    str(a).replaceAll(/[A-Z]/g, (c) => c.toLowerCase()) === str(b).replaceAll(/[A-Z]/g, (c) => c.toLowerCase()),
  repeat: ([s, n], ctx) => {
    const count = Number(n as bigint);
    ctx.runtime.allocateString(str(s).length * count);
    return str(s).repeat(count);
  },
  parse: ([s], ctx) => parse(ctx, str(s)),
  to_owned: ([s]) => str(s),
  into_string: ([s]) => str(s),
  is_char_boundary: ([s, i]) => {
    const bytes = encoder.encode(str(s));
    const index = Number(i as bigint);
    if (index === 0 || index === bytes.length) return true;
    if (index > bytes.length) return false;
    return (bytes[index] & 0xc0) !== 0x80;
  },
  get: ([s, range], ctx) => {
    const text = str(s);
    const { start, end } = rangeBounds(range, byteLength(text));
    try {
      return some(ctx, strSliceBytes(text, start, end, ctx.span));
    } catch {
      return none(ctx);
    }
  },
  is_ascii: ([s]) => /^[\u0000-\u007F]*$/.test(str(s)),
};

function replaceN(ctx: NativeContext, text: string, from: Value, to: string, count: number): string {
  const match = patternMatcher(ctx, from);
  let result = '';
  let position = 0;
  let replaced = 0;
  while (replaced < count) {
    const found = match(text, position);
    if (!found) break;
    // Each match is charged, as the pieces between short matches are too short to be charged by their length.
    ctx.runtime.spend();
    result = appended(ctx, result, text.slice(position, found.index) + to);
    if (found.length === 0) {
      if (found.index >= text.length) {
        position = text.length;
        replaced++;
        break;
      }
      const char = String.fromCodePoint(text.codePointAt(found.index)!);
      result = appended(ctx, result, char);
      position = found.index + char.length;
    } else {
      position = found.index + found.length;
    }
    replaced++;
  }
  return result + text.slice(position);
}

const stringNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  new: () => '',
  with_capacity: ([capacity], ctx) => {
    checkVecCapacity(ctx, 0, capacity, 1);
    return madeString('', Number(capacity as bigint));
  },
  from_iter: ([iter], ctx) => {
    const iterator = deref(iter) as IterValue;
    let text = '';
    for (let item = iterator.next(); item !== DONE; item = iterator.next()) {
      ctx.runtime.spend();
      text = appended(ctx, text, deref(item) as string);
    }
    return text;
  },
  from_utf8_lossy: ([bytes]) => new TextDecoder().decode(Uint8Array.from(sliceItems(deref(bytes)) as bigint[], Number)),
  from_utf8: ([bytes], ctx) => {
    const values = deref(bytes) as bigint[];
    const array = Uint8Array.from(values, Number);
    try {
      return ok(ctx, new TextDecoder('utf-8', { fatal: true }).decode(array));
    } catch {
      const { validUpTo, errorLen } = utf8Error(array);
      return err(ctx, new StructValue(ctx.interp.program.adtDef('Utf8Error'), [[...values], validUpTo, errorLen]));
    }
  },
  push_str: ([self, s]) => {
    const place = placeOf(self);
    place.set((place.get() as string) + str(s));
    return UNIT_VALUE;
  },
  push: ([self, c]) => {
    const place = placeOf(self);
    place.set((place.get() as string) + (c as string));
    return UNIT_VALUE;
  },
  pop: ([self], ctx) => {
    const place = placeOf(self);
    const chars = [...(place.get() as string)];
    const last = chars.pop();
    place.set(chars.join(''));
    return option(ctx, last, last !== undefined);
  },
  insert: ([self, idx, c], ctx) => {
    const place = placeOf(self);
    const text = place.get() as string;
    const head = headAtBoundary(ctx, text, Number(idx as bigint), 'idx');
    place.set(head + (c as string) + text.slice(head.length));
    return UNIT_VALUE;
  },
  insert_str: ([self, idx, s], ctx) => {
    const place = placeOf(self);
    const text = place.get() as string;
    const head = headAtBoundary(ctx, text, Number(idx as bigint), 'idx');
    place.set(head + str(s) + text.slice(head.length));
    return UNIT_VALUE;
  },
  remove: ([self, idx], ctx) => {
    const place = placeOf(self);
    const text = place.get() as string;
    const offset = Number(idx as bigint);
    const rest = strSliceBytes(text, offset, undefined, ctx.span);
    if (rest.length === 0) panic(ctx, 'cannot remove a char from the end of a string');
    const head = text.slice(0, text.length - rest.length);
    const char = String.fromCodePoint(rest.codePointAt(0)!);
    place.set(head + rest.slice(char.length));
    return char;
  },
  truncate: ([self, len], ctx) => {
    const place = placeOf(self);
    const text = place.get() as string;
    const length = Number(len as bigint);
    if (length < byteLength(text)) place.set(headAtBoundary(ctx, text, length, 'new_len'));
    return UNIT_VALUE;
  },
  clear: ([self]) => {
    placeOf(self).set('');
    return UNIT_VALUE;
  },
  as_str: ([self]) => str(self),
  as_mut_str: ([self]) => self,
  into_bytes: ([self]) => Array.from(encoder.encode(str(self)), BigInt),
  into_boxed_str: ([self]) => str(self),
  retain: ([self, f], ctx) => {
    const place = placeOf(self);
    place.set([...(place.get() as string)].filter((char) => call(ctx, f, [char]) as boolean).join(''));
    return UNIT_VALUE;
  },
  drain: ([self, range], ctx) => {
    const place = placeOf(self);
    const text = place.get() as string;
    const { start, end } = rangeBounds(range, byteLength(text));
    headAtBoundary(ctx, text, start ?? 0, 'start');
    headAtBoundary(ctx, text, end ?? byteLength(text), 'end');
    const removed = strSliceBytes(text, start, end, ctx.span);
    const head = strSliceBytes(text, 0, start, ctx.span);
    place.set(head + text.slice(head.length + removed.length));
    const iter = strIter([...removed]);
    return described(iter, (show) =>
      tuplePart('Drain', [(indent) => show((iter.rest?.() ?? []).join(''), REF_STR, indent)])
    );
  },
  split_off: ([self, at], ctx) => {
    const place = placeOf(self);
    const text = place.get() as string;
    const head = headAtBoundary(ctx, text, Number(at as bigint), 'at');
    place.set(head);
    return text.slice(head.length);
  },
  replace_range: ([self, range, with_], ctx) => {
    const place = placeOf(self);
    const text = place.get() as string;
    const { start, end } = rangeBounds(range, byteLength(text));
    const head = strSliceBytes(text, 0, start, ctx.span);
    const middle = strSliceBytes(text, start, end, ctx.span);
    place.set(head + str(with_) + text.slice(head.length + middle.length));
    return UNIT_VALUE;
  },
  extend: ([self, iter], ctx) => {
    const place = placeOf(self);
    let text = place.get() as string;
    const iterator = deref(iter) as IterValue;
    for (;;) {
      ctx.runtime.spend();
      const item = iterator.next();
      if (item === DONE) break;
      text = appended(ctx, text, deref(item) as string);
    }
    place.set(text);
    return UNIT_VALUE;
  },
};

/** A string a native builds piece by piece, with a piece added, checked before it is built. */
function appended(ctx: NativeContext, text: string, piece: string): string {
  ctx.runtime.allocateString(text.length + piece.length, piece.length);
  return text + piece;
}

function charCode(value: Value): number {
  return (deref(value) as string).codePointAt(0)!;
}

function char(value: Value): string {
  return deref(value) as string;
}

const charNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  is_alphabetic: ([c]) => /^\p{Alphabetic}$/u.test(char(c)),
  is_numeric: ([c]) => /^[\p{Nd}\p{Nl}\p{No}]$/u.test(char(c)),
  is_alphanumeric: ([c]) => /^[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]$/u.test(char(c)),
  is_whitespace: ([c]) => isWhitespace(char(c)),
  is_uppercase: ([c]) => /^\p{Uppercase}$/u.test(char(c)),
  is_lowercase: ([c]) => /^\p{Lowercase}$/u.test(char(c)),
  is_control: ([c]) => /^\p{Cc}$/u.test(char(c)),
  is_digit: ([c, radix], ctx) => digitOf(ctx, char(c), Number(radix as bigint)) !== undefined,
  is_ascii: ([c]) => charCode(c) < 0x80,
  is_ascii_digit: ([c]) => /^[0-9]$/.test(char(c)),
  is_ascii_hexdigit: ([c]) => /^[0-9a-fA-F]$/.test(char(c)),
  is_ascii_alphabetic: ([c]) => /^[a-zA-Z]$/.test(char(c)),
  is_ascii_alphanumeric: ([c]) => /^[a-zA-Z0-9]$/.test(char(c)),
  is_ascii_uppercase: ([c]) => /^[A-Z]$/.test(char(c)),
  is_ascii_lowercase: ([c]) => /^[a-z]$/.test(char(c)),
  is_ascii_punctuation: ([c]) => /^[!-/:-@[-`{-~]$/.test(char(c)),
  is_ascii_whitespace: ([c]) => /^[ \t\n\f\r]$/.test(char(c)),
  is_ascii_graphic: ([c]) => charCode(c) > 0x20 && charCode(c) < 0x7f,
  is_ascii_control: ([c]) => charCode(c) < 0x20 || charCode(c) === 0x7f,
  to_ascii_uppercase: ([c]) => (/^[a-z]$/.test(char(c)) ? char(c).toUpperCase() : char(c)),
  to_ascii_lowercase: ([c]) => (/^[A-Z]$/.test(char(c)) ? char(c).toLowerCase() : char(c)),
  make_ascii_uppercase: ([c]) => {
    const place = placeOf(c);
    const value = place.get() as string;
    place.set(/^[a-z]$/.test(value) ? value.toUpperCase() : value);
    return UNIT_VALUE;
  },
  make_ascii_lowercase: ([c]) => {
    const place = placeOf(c);
    const value = place.get() as string;
    place.set(/^[A-Z]$/.test(value) ? value.toLowerCase() : value);
    return UNIT_VALUE;
  },
  eq_ignore_ascii_case: ([a, b]) =>
    char(a).replace(/[A-Z]/, (x) => x.toLowerCase()) === char(b).replace(/[A-Z]/, (x) => x.toLowerCase()),
  to_uppercase: ([c]) => caseIter('ToUppercase', char(c).toUpperCase()),
  to_lowercase: ([c]) => caseIter('ToLowercase', char(c).toLowerCase()),
  to_digit: ([c, radix], ctx) => {
    const digit = digitOf(ctx, char(c), Number(radix as bigint));
    return option(ctx, digit === undefined ? undefined : BigInt(digit), digit !== undefined);
  },
  len_utf8: ([c]) => BigInt(byteLength(char(c))),
  len_utf16: ([c]) => BigInt(char(c).length),
  from_u32: ([i], ctx) => fromU32(ctx, i),
  from_digit: ([num, radix], ctx) => fromDigit(ctx, num, radix),
};

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

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const [name, native] of Object.entries(strNatives)) natives[`str::${name}`] = native;
for (const [name, native] of Object.entries(withStringCapacity(stringNatives))) natives[`String::${name}`] = native;
for (const [name, native] of Object.entries(charNatives)) natives[`char::${name}`] = native;
// `u8`'s ASCII methods behave as `char`'s on the byte's code point.
const byteChar = (byte: Value): string => String.fromCodePoint(Number(deref(byte) as bigint));
for (const name of Object.keys(charNatives).filter((key) => key.includes('ascii'))) {
  natives[`u8::${name}`] = (args, ctx) => {
    if (name.startsWith('make_')) {
      const place = placeOf(args[0]);
      place.set(BigInt(char(charNatives[name.replace('make_', 'to_')]([byteChar(place.get())], ctx)).codePointAt(0)!));
      return UNIT_VALUE;
    }
    const result = charNatives[name](args.map(byteChar), ctx);
    return typeof result === 'string' ? BigInt(result.codePointAt(0)!) : result;
  };
}
natives['FromStr::from_str'] = ([s], ctx) => parse(ctx, str(s));
natives['String::len'] = strNatives.len;
natives['String::is_empty'] = strNatives.is_empty;
natives['std::char::from_u32'] = ([i], ctx) => fromU32(ctx, i);
natives['std::char::from_digit'] = ([num, radix], ctx) => fromDigit(ctx, num, radix);
define(natives);

export function isStrType(type: Type): boolean {
  return normalize(shallow(type)).kind === 'str';
}

export { charIndex, isPlace };
