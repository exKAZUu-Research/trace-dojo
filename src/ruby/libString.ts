// code-gauge-allow-file fileNcss 796 -- The libString module keeps one concern's cases together.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { foldCase } from './caseFold';
import {
  combinedStringEncoding,
  compareBytes,
  compareRubyStrings,
  compareStrings,
  inspect,
  rangeCovers,
  strInspect,
  symInspect,
  toIndex,
  toIndexExact,
  toRubyInt,
  toStr,
  toStrValue,
  toSValue,
} from './conversions';
import { def, sdef } from './define';
import {
  argumentError,
  frozenError,
  implicitConversionError,
  indexError,
  rangeError,
  rubyError,
  runtimeError,
  typeError,
} from './errors';
import { formatString } from './format';
import { hashDefault, hashGet, stringKeyEquals, stringKeyHash } from './hashes';
import { callBlock, callMethod, type Gen, invoke, nativeProc, requireBlock } from './interp';
import { makeEnumerator } from './libEnumerator';
import { parseFloatLenient, parseIntegerLenient } from './libNumeric';
import { NIL, RArray, RHash, type RProc, RRange, RString, RSymbol, type Value } from './objects';
import { rt, UnsupportedFeatureError, whileHeld } from './runtime';
import { successorBytes, transformInvalid } from './stringTransforms';
import {
  arr,
  classOf,
  isNil,
  joinStringCharacters,
  str,
  stringBytes,
  stringCharacterCount,
  stringCharacters,
  stringFromBytes,
  sym,
  truthy,
} from './values';

// Characters ----------------------------------------------------------------------------------------------------------

const SURROGATE = /[\uD800-\uDFFF]/;

/** The characters of a string, as Ruby counts them: by code point. */
export function charsOf(text: string): string[] {
  return SURROGATE.test(text) ? [...text] : text.split('');
}

export function charLength(text: string): number {
  return SURROGATE.test(text) ? [...text].length : text.length;
}

function modify(self: RString): void {
  if (self.frozen) throw frozenError(self, strInspect(self.s));
}

function setText(self: RString, text: string): void {
  modify(self);
  if (text.length > 1_000_000) throw rangeError('string size too big');
  rt().spend(Math.floor(text.length / 256));
  const value = str(text);
  self.s = value.s;
  self.rawBytes = value.rawBytes;
}

function setBytes(self: RString, bytes: Uint8Array, binary = self.binary): void {
  modify(self);
  rt().checkStringLength(bytes.length);
  const result = stringFromBytes(bytes, binary);
  self.s = result.s;
  self.binary = result.binary;
  self.rawBytes = result.rawBytes;
}

function textResult(self: RString, text: string): RString {
  const result = str(text);
  result.binary = self.binary;
  return result;
}

function* stringArg(value: Value): Gen<string> {
  return yield* toStr(value);
}

function* stringArgValue(value: Value): Gen<RString> {
  return yield* toStrValue(value);
}

function* patternText(value: Value, kind: 'characters' | 'regexp'): Gen<string> {
  const pattern = yield* stringArgValue(value);
  if (pattern.rawBytes && !pattern.binary) {
    if (kind === 'characters') throw argumentError('invalid byte sequence in UTF-8');
    throw rubyError(
      rt().c.RegexpError,
      `invalid multibyte character: /${inspectRawBytes(pattern.rawBytes).slice(1, -1)}/`
    );
  }
  return pattern.s;
}

function regexpUnsupported(value: Value): void {
  if (value instanceof RString || value instanceof RSymbol) return;
  if (typeof value === 'object' && value !== NIL && (value as { cls?: { name?: string } }).cls?.name === 'Regexp') {
    throw new UnsupportedFeatureError('正規表現');
  }
}

/** Resolves `str[index]`, `str[start, length]`, and `str[range]` to a start and a length, or undefined. */
function* substringRange(
  length: number | (() => number),
  args: Value[],
  firstIndex?: { number: number; integer: bigint }
): Gen<{ start: number; count: number } | undefined> {
  const [first, second] = args;
  if (second !== undefined) {
    let start = firstIndex?.number ?? (yield* toIndex(first));
    const count = yield* toIndex(second);
    const currentLength = typeof length === 'number' ? length : length();
    if (start < 0) start += currentLength;
    if (start < 0 || start > currentLength || count < 0) return undefined;
    return { start, count: Math.min(count, currentLength - start) };
  }
  if (first instanceof RRange) {
    const resolved = yield* rangeBounds(first, length);
    if (!resolved) return undefined;
    return resolved;
  }
  let index = yield* toIndex(first);
  const currentLength = typeof length === 'number' ? length : length();
  if (index < 0) index += currentLength;
  if (index < 0 || index >= currentLength) return undefined;
  return { start: index, count: 1 };
}

/** The start and length a range selects from a sequence of `length` items, as `[]` resolves it. */
export function* rangeBounds(
  range: RRange,
  length: number | (() => number)
): Gen<{ start: number; count: number } | undefined> {
  let start = range.begin === NIL ? 0 : yield* toIndex(range.begin);
  let end = range.end === NIL ? undefined : yield* toIndex(range.end);
  const currentLength = typeof length === 'number' ? length : length();
  end ??= currentLength;
  if (start < 0) start += currentLength;
  if (start < 0 || start > currentLength) return undefined;
  if (end < 0) end += currentLength;
  if (!range.exclusive && range.end !== NIL) end += 1;
  return { start, count: Math.max(0, Math.min(end, currentLength) - start) };
}

// Construction and conversion -----------------------------------------------------------------------------------------

def(
  'String',
  'initialize',
  [0, 1],
  function* (self: RString, args) {
    if (args.length > 0) {
      const source = yield* toStrValue(args[0]);
      setBytes(self, stringBytes(source), source.binary);
    }
    return NIL;
  },
  { visibility: 'private' }
);
sdef(
  'String',
  'new',
  [0, -1],
  function* (self, args, _block, keywords) {
    const value = new RString(self, '');
    const initialize = classOf(value).findMethod('initialize');
    if (initialize) yield* invoke(initialize, value, args, keywords, _block, false);
    return value;
  },
  { keywords: true }
);
def('String', ['to_s', 'to_str'], 0, (self: RString) =>
  self.cls === rt().c.String ? self : stringFromBytes(stringBytes(self), self.binary)
);
def('String', 'inspect', 0, (self: RString) =>
  str(self.rawBytes ? inspectRawBytes(self.rawBytes) : self.binary ? binaryInspect(self.s) : strInspect(self.s))
);
def('String', 'dump', 0, (self: RString) => {
  const quoted = self.rawBytes
    ? inspectRawBytes(self.rawBytes)
    : self.binary
      ? binaryInspect(self.s)
      : strInspect(self.s);
  return str(
    quoted.replaceAll(/[\u0080-\u{10FFFF}]/gu, (char) => {
      const point = char.codePointAt(0) as number;
      const hex = point.toString(16).toUpperCase();
      return point > 0xff_ff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
    })
  );
});

function inspectRawBytes(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '';
  let result = '"';
  const flush = (): void => {
    if (text) result += strInspect(text).slice(1, -1);
    text = '';
  };
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
    try {
      text += decoder.decode(bytes.slice(index, index + width));
      index += width;
    } catch {
      flush();
      result += `\\x${first.toString(16).toUpperCase().padStart(2, '0')}`;
      index++;
    }
  }
  flush();
  return `${result}"`;
}

/** A binary string's inspect, which shows the bytes from 128 on as `\xFF`. */
function binaryInspect(text: string): string {
  return strInspect(text).replaceAll(
    /[\u0080-\u00FF]/g,
    (char) => `\\x${(char.codePointAt(0) as number).toString(16).toUpperCase()}`
  );
}
def('String', ['to_sym', 'intern'], 0, (self: RString) => {
  if (self.rawBytes && !self.binary)
    throw rubyError(rt().c.EncodingError, `invalid symbol in encoding UTF-8 :${inspectRawBytes(self.rawBytes)}`);
  return sym(self.s);
});
def('String', 'to_i', [0, 1], function* (self: RString, args) {
  const base = args.length > 0 ? yield* toRubyInt(args[0]) : 10;
  if (base < 0 || base > 36 || base === 1) throw argumentError(`invalid radix ${base}`);
  return parseIntegerLenient(self.s, base);
});
def('String', 'to_f', 0, (self: RString) => parseFloatLenient(self.s));
def('String', 'to_c', 0, () => {
  throw new UnsupportedFeatureError('String#to_c（複素数）');
});
def('String', 'to_r', 0, () => {
  throw new UnsupportedFeatureError('String#to_r（有理数）');
});
def('String', 'hex', 0, (self: RString) => parseIntegerLenient(self.s, 16));
def('String', 'oct', 0, (self: RString) => parseIntegerLenient(self.s, 8));
def('String', ['length', 'size'], 0, (self: RString) => BigInt(stringCharacterCount(self)));
def('String', 'bytesize', 0, (self: RString) => BigInt(stringBytes(self).length));
def('String', 'empty?', 0, (self: RString) => self.s.length === 0);
def('String', 'hash', 0, (self: RString) => stringKeyHash(self));
def('String', ['==', '===', 'eql?'], 1, (self: RString, [other]) => stringKeyEquals(self, other));
def('String', '<=>', 1, (self: RString, [other]) => {
  if (!(other instanceof RString)) return NIL;
  return BigInt(compareRubyStrings(self, other));
});
def('String', 'casecmp', 1, function* (self: RString, [other]) {
  if (!(other instanceof RString)) {
    if (other instanceof RSymbol) throw implicitConversionError(other, 'String');
    return NIL;
  }
  return BigInt(compareBytes(foldAsciiBytes(self), foldAsciiBytes(other)));
});
def('String', 'casecmp?', 1, function* (self: RString, [other]) {
  if (!(other instanceof RString)) {
    if (other instanceof RSymbol) throw implicitConversionError(other, 'String');
    return NIL;
  }
  if ((self.rawBytes && !self.binary) || (other.rawBytes && !other.binary)) throw argumentError('input string invalid');
  return foldCase(self.s) === foldCase(other.s);
});

function foldAsciiBytes(value: RString): Uint8Array {
  return stringBytes(value).map((byte) => (byte >= 65 && byte <= 90 ? byte + 32 : byte));
}

def('String', '+', 1, function* (self: RString, [other]) {
  const source = yield* stringArgValue(other);
  const right = stringBytes(source);
  const left = stringBytes(self);
  const binary = combinedStringEncoding(
    self.binary,
    left.every((byte) => byte < 0x80),
    source
  );
  rt().checkStringLength(left.length + right.length);
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return stringFromBytes(joined, binary);
});
def('String', '*', 1, function* (self: RString, [count]) {
  const times = yield* toIndex(count);
  if (times < 0) throw argumentError('negative argument');
  const source = stringBytes(self);
  if (source.length === 0) return stringFromBytes(source, self.binary);
  if (source.length * times > 1_000_000) throw argumentError('argument too big');
  rt().spend(Math.floor((source.length * times) / 256));
  const repeated = new Uint8Array(source.length * times);
  for (let index = 0; index < times; index++) repeated.set(source, index * source.length);
  return stringFromBytes(repeated, self.binary);
});
def('String', '%', 1, function* (self: RString, [value]) {
  return yield* formatString(self, value instanceof RArray ? value.items : [value]);
});
def('String', '-@', 0, (self: RString) => {
  if (self.frozen) return self;
  const copy = stringFromBytes(stringBytes(self), self.binary);
  copy.frozen = true;
  return copy;
});
def('String', '+@', 0, (self: RString) => (self.frozen ? stringFromBytes(stringBytes(self), self.binary) : self));
def('String', ['<<', 'concat'], [0, -1], function* (self: RString, args) {
  modify(self);
  const converted: (RString | bigint)[] = [];
  for (const arg of args) {
    if (typeof arg === 'bigint') validateConcatCodepoint(arg, self.binary);
    converted.push(typeof arg === 'bigint' ? arg : yield* stringArgValue(arg));
  }
  const chunks: Uint8Array[] = [stringBytes(self)];
  let length = chunks[0].length;
  let binary = self.binary;
  let ascii = chunks[0].every((byte) => byte < 0x80);
  for (const arg of converted) {
    let chunk: Uint8Array;
    if (typeof arg === 'bigint') {
      validateConcatCodepoint(arg, binary);
      chunk =
        binary && arg <= 255n
          ? Uint8Array.of(Number(arg))
          : new TextEncoder().encode(String.fromCodePoint(Number(arg)));
    } else {
      binary = combinedStringEncoding(binary, ascii, arg);
      chunk = stringBytes(arg);
    }
    length += chunk.length;
    rt().checkStringLength(length);
    chunks.push(chunk);
    ascii &&= chunk.every((byte) => byte < 0x80);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const result = stringFromBytes(bytes, binary);
  self.s = result.s;
  self.binary = result.binary;
  self.rawBytes = result.rawBytes;
  return self;
});
function validateConcatCodepoint(value: bigint, binary: boolean): void {
  if (value < 0n) throw rangeError(`${value} out of char range`);
  if (value > 0x7f_ff_ff_ff_ff_ff_ff_ffn) throw rangeError('bignum out of char range');
  if (value > 0x10_ff_ffn || (binary && value > 255n)) throw rangeError(`${value} out of char range`);
  if (value >= 0xd8_00n && value <= 0xdf_ffn)
    throw rangeError(`invalid codepoint 0x${value.toString(16).toUpperCase()} in UTF-8`);
}
def('String', 'replace', 1, function* (self: RString, [other]) {
  modify(self);
  const source = yield* stringArgValue(other);
  setBytes(self, stringBytes(source), source.binary);
  return self;
});
def('String', 'clear', 0, (self: RString) => {
  setText(self, '');
  return self;
});
def('String', 'insert', 2, function* (self: RString, [index, other]) {
  const converted = yield* toIndexExact(index);
  let position = converted.number;
  const value = yield* stringArgValue(other);
  const chars = stringCharacters(self);
  const binary = combinedStringEncoding(
    self.binary,
    stringBytes(self).every((byte) => byte < 0x80),
    value
  );
  if (position < 0) position += chars.length + 1;
  if (position < 0 || position > chars.length) throw indexError(`index ${converted.integer} out of string`);
  chars.splice(position, 0, value);
  setBytes(self, stringBytes(joinStringCharacters(chars, binary)), binary);
  return self;
});
def('String', 'prepend', [0, -1], function* (self: RString, args) {
  modify(self);
  const values: RString[] = [];
  for (const arg of args) values.push(yield* stringArgValue(arg));
  let binary = self.binary;
  let ascii = stringBytes(self).every((byte) => byte < 0x80);
  for (const value of values) {
    binary = combinedStringEncoding(binary, ascii, value);
    ascii &&= stringBytes(value).every((byte) => byte < 0x80);
  }
  values.push(self);
  setBytes(self, stringBytes(joinStringCharacters(values, binary)), binary);
  return self;
});

// Access --------------------------------------------------------------------------------------------------------------

function* substring(self: RString, args: Value[]): Gen {
  const [first] = args;
  if (args.length === 1 && first instanceof RString)
    return !(first.rawBytes && !first.binary && !self.binary) && byteIndex(stringBytes(self), stringBytes(first)) >= 0
      ? stringFromBytes(stringBytes(first), self.binary)
      : NIL;
  regexpUnsupported(first);
  const range = yield* substringRange(() => stringCharacterCount(self), args);
  if (!range) return NIL;
  const chars = stringCharacters(self);
  if (args.length === 1 && !(first instanceof RRange) && range.count === 1) return chars[range.start];
  return joinStringCharacters(chars.slice(range.start, range.start + range.count), self.binary);
}

def('String', ['[]', 'slice'], [1, 2], (self: RString, args) => substring(self, args));
def('String', 'byteslice', [1, 2], function* (self: RString, args) {
  const range = yield* substringRange(() => stringBytes(self).length, args);
  const bytes = stringBytes(self);
  return range ? stringFromBytes(bytes.slice(range.start, range.start + range.count), self.binary) : NIL;
});
def('String', 'slice!', [1, 2], function* (self: RString, args) {
  modify(self);
  const [first] = args;
  if (args.length === 1 && first instanceof RString) {
    if (first.rawBytes && !first.binary && !self.binary) return NIL;
    const bytes = stringBytes(self);
    const found = byteIndex(bytes, stringBytes(first));
    if (found < 0) return NIL;
    setBytes(self, spliceBytes(bytes, found, stringBytes(first).length, new Uint8Array()));
    return stringFromBytes(stringBytes(first), self.binary);
  }
  regexpUnsupported(first);
  const range = yield* substringRange(() => stringCharacterCount(self), args);
  if (!range) return NIL;
  const chars = stringCharacters(self);
  const removed = chars.splice(range.start, range.count);
  setBytes(self, stringBytes(joinStringCharacters(chars, self.binary)));
  return args.length === 1 && !(first instanceof RRange) && range.count === 1
    ? removed[0]
    : joinStringCharacters(removed, self.binary);
});
// code-gauge-allow functionCognitiveComplexity 17 -- String assignment supports substring, index, and Range selectors with different bounds errors.
def('String', '[]=', [2, 3], function* (self: RString, args) {
  const value = yield* stringArgValue(args.at(-1) as Value);
  const selectors = args.slice(0, -1);
  const [first] = selectors;
  if (selectors.length === 1 && first instanceof RString) {
    const bytes = stringBytes(self);
    const position = first.rawBytes && !first.binary && !self.binary ? -1 : byteIndex(bytes, stringBytes(first));
    if (position === -1) throw indexError('string not matched');
    const binary = combinedStringEncoding(
      self.binary,
      bytes.every((byte) => byte < 0x80),
      value
    );
    setBytes(self, spliceBytes(bytes, position, stringBytes(first).length, stringBytes(value)), binary);
    return args.at(-1) as Value;
  }
  regexpUnsupported(first);
  let range: { start: number; count: number } | undefined;
  if (selectors.length === 1 && !(first instanceof RRange)) {
    const converted = yield* toIndexExact(first);
    const chars = stringCharacters(self);
    let index = converted.number;
    if (index < 0) index += chars.length;
    if (index < 0 || index >= chars.length) throw indexError(`index ${converted.integer} out of string`);
    range = { start: index, count: 1 };
  } else {
    const firstIndex = first instanceof RRange ? undefined : yield* toIndexExact(first);
    range = yield* substringRange(() => stringCharacterCount(self), selectors, firstIndex);
    if (!range) {
      if (first instanceof RRange) throw rangeError(`${yield* inspect(first)} out of range`);
      throw indexError(`index ${firstIndex?.integer} out of string`);
    }
  }
  const binary = combinedStringEncoding(
    self.binary,
    stringBytes(self).every((byte) => byte < 0x80),
    value
  );
  const chars = stringCharacters(self);
  chars.splice(range.start, range.count, value);
  setBytes(self, stringBytes(joinStringCharacters(chars, binary)), binary);
  return args.at(-1) as Value;
});

function byteIndex(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  const prefix = new Int32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index++) {
    if (index % 256 === 0) rt().spend();
    while (matched > 0 && needle[index] !== needle[matched]) matched = prefix[matched - 1];
    if (needle[index] === needle[matched]) matched++;
    prefix[index] = matched;
  }
  for (let index = 0, matched = 0; index < haystack.length; index++) {
    if (index % 256 === 0) rt().spend();
    while (matched > 0 && haystack[index] !== needle[matched]) matched = prefix[matched - 1];
    if (haystack[index] === needle[matched]) matched++;
    if (matched === needle.length) return index - needle.length + 1;
  }
  return -1;
}

function spliceBytes(bytes: Uint8Array, start: number, count: number, inserted: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes.length - count + inserted.length);
  result.set(bytes.subarray(0, start));
  result.set(inserted, start);
  result.set(bytes.subarray(start + count), start + inserted.length);
  return result;
}
def('String', 'chars', 0, (self: RString) => arr(stringCharacters(self)));
def('String', 'codepoints', 0, (self: RString) => {
  if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
  return arr(stringCharacters(self).map((char) => BigInt(char.s.codePointAt(0) as number)));
});
def('String', 'bytes', 0, (self: RString) => arr([...stringBytes(self)].map(BigInt)));
def('String', 'getbyte', 1, function* (self: RString, [index]) {
  let position = yield* toIndex(index);
  const bytes = stringBytes(self);
  if (position < 0) position += bytes.length;
  return position >= 0 && position < bytes.length ? BigInt(bytes[position]) : NIL;
});
def('String', 'each_char', 0, function* (self: RString, _args, block) {
  if (!block) return makeEnumerator(self, 'each_char', []);
  for (const char of stringCharacters(self)) yield* callBlock(block, [char], false);
  return self;
});
def('String', 'each_codepoint', 0, function* (self: RString, _args, block) {
  if (!block) return makeEnumerator(self, 'each_codepoint', []);
  if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
  for (const char of stringCharacters(self)) yield* callBlock(block, [BigInt(char.s.codePointAt(0) as number)], false);
  return self;
});
def('String', 'grapheme_clusters', 0, function* (self: RString, _args, block) {
  const values: Value[] = [];
  for (const value of graphemeSegments(self)) {
    rt().spend();
    if (block) yield* callBlock(block, [value], false);
    else values.push(value);
  }
  return block ? self : arr(values);
});

function* graphemeSegments(self: RString): Iterable<RString> {
  if (self.binary) {
    for (const byte of stringBytes(self)) yield stringFromBytes(Uint8Array.of(byte), true);
    return;
  }
  for (const { segment } of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(self.s))
    yield textResult(self, segment);
}
def('String', 'each_byte', 0, function* (self: RString, _args, block) {
  if (!block) return makeEnumerator(self, 'each_byte', []);
  for (const byte of stringBytes(self)) yield* callBlock(block, [BigInt(byte)], false);
  return self;
});
def('String', 'ord', 0, (self: RString) => {
  if (self.s.length === 0) throw argumentError('empty string');
  const first = stringCharacters(self)[0];
  if (first.rawBytes && !first.binary) throw argumentError('invalid byte sequence in UTF-8');
  return BigInt(first.s.codePointAt(0) as number);
});
def('String', 'chr', 0, (self: RString) => stringCharacters(self)[0] ?? str(''));
def('String', 'sum', [0, 1], function* (self: RString, args) {
  let total = 0n;
  for (const byte of stringBytes(self)) total += BigInt(byte);
  const bits = args.length > 0 ? BigInt(yield* toRubyInt(args[0])) : 16n;
  return bits > 0n && bits < 32n ? total & ((1n << bits) - 1n) : total;
});

function linesOf(text: string, separator: string | undefined, chomp: boolean): string[] {
  if (separator === undefined) return [text];
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  if (separator === '') {
    for (;;) {
      const boundary = text.indexOf('\n\n', start);
      if (boundary === -1) break;
      lines.push(text.slice(start, boundary + 2));
      start = boundary + 2;
      while (text[start] === '\n') start++;
    }
    if (start < text.length) lines.push(text.slice(start));
    return chomp ? lines.map((part) => part.replace(/\n+$/, '')) : lines;
  }
  for (;;) {
    const index = text.indexOf(separator, start);
    if (index === -1) break;
    lines.push(text.slice(start, chomp ? index : index + separator.length));
    start = index + separator.length;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function* lineOptions(
  args: Value[],
  keywords: RHash | undefined
): Gen<{ separator: string | undefined; chomp: boolean }> {
  const selected = args.length > 0 ? args[0] : (rt().globals.get('$/') ?? NIL);
  const separator = selected === NIL ? undefined : yield* stringArg(selected);
  let chomp = false;
  if (keywords) {
    const entry = yield* hashGet(keywords, sym('chomp'));
    chomp = entry ? truthy(entry.value) : false;
  }
  return { separator, chomp };
}

def(
  'String',
  'lines',
  [0, 1],
  function* (self: RString, args, _block, keywords) {
    const { separator, chomp } = yield* lineOptions(args, keywords);
    return arr(linesOf(self.s, separator, chomp).map((line) => textResult(self, line)));
  },
  { keywords: true }
);
def(
  'String',
  'each_line',
  [0, 1],
  function* (self: RString, args, block, keywords) {
    if (!block) return makeEnumerator(self, 'each_line', args, keywords);
    const { separator, chomp } = yield* lineOptions(args, keywords);
    for (const line of linesOf(self.s, separator, chomp)) yield* callBlock(block, [textResult(self, line)], false);
    return self;
  },
  { keywords: true }
);

// Searching -----------------------------------------------------------------------------------------------------------

def('String', 'include?', 1, function* (self: RString, [other]) {
  const target = yield* searchString(self, other);
  return !(target.rawBytes && !target.binary) && self.s.includes(target.s);
});

function* searchString(self: RString, value: Value): Gen<RString> {
  const target = yield* stringArgValue(value);
  combinedStringEncoding(
    self.binary,
    stringBytes(self).every((byte) => byte < 0x80),
    target
  );
  return target;
}
def('String', 'start_with?', [0, -1], function* (self: RString, args) {
  for (const arg of args) {
    regexpUnsupported(arg);
    if (self.s.startsWith(yield* stringArg(arg))) return true;
  }
  return false;
});
def('String', 'end_with?', [0, -1], function* (self: RString, args) {
  for (const arg of args) if (self.s.endsWith(yield* stringArg(arg))) return true;
  return false;
});
def('String', 'delete_prefix', 1, function* (self: RString, [prefix]) {
  const bytes = yield* withoutAffix(self, prefix, true);
  return stringFromBytes(bytes ?? stringBytes(self), self.binary);
});
def('String', 'delete_suffix', 1, function* (self: RString, [suffix]) {
  const bytes = yield* withoutAffix(self, suffix, false);
  return stringFromBytes(bytes ?? stringBytes(self), self.binary);
});
for (const [name, prefix] of [
  ['delete_prefix!', true],
  ['delete_suffix!', false],
] as const) {
  def('String', name, 1, function* (self: RString, [affix]) {
    modify(self);
    const bytes = yield* withoutAffix(self, affix, prefix);
    if (!bytes) return NIL;
    setBytes(self, bytes);
    return self;
  });
}

function* withoutAffix(self: RString, value: Value, prefix: boolean): Gen<Uint8Array | undefined> {
  const affix = yield* stringArgValue(value);
  const source = stringBytes(self);
  combinedStringEncoding(
    self.binary,
    source.every((byte) => byte < 0x80),
    affix
  );
  const target = stringBytes(affix);
  if (target.length === 0 || target.length > source.length) return undefined;
  const offset = prefix ? 0 : source.length - target.length;
  if (!target.every((byte, index) => byte === source[offset + index])) return undefined;
  return prefix ? source.slice(target.length) : source.slice(0, offset);
}

/** The code unit offset of a character position, for strings with characters outside the BMP. */
function unitOffset(text: string, position: number): number {
  if (!SURROGATE.test(text)) return position;
  return [...text].slice(0, position).join('').length;
}

function charPosition(text: string, offset: number): number {
  if (!SURROGATE.test(text)) return offset;
  return charLength(text.slice(0, offset));
}

def('String', 'index', [1, 2], function* (self: RString, args) {
  regexpUnsupported(args[0]);
  const target = yield* searchString(self, args[0]);
  const length = charLength(self.s);
  let start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  if (start < 0) start += length;
  if (start < 0 || start > length) return NIL;
  if (target.rawBytes && !target.binary) return NIL;
  const found = self.s.indexOf(target.s, unitOffset(self.s, start));
  return found === -1 ? NIL : BigInt(charPosition(self.s, found));
});
def('String', 'rindex', [1, 2], function* (self: RString, args) {
  regexpUnsupported(args[0]);
  const target = yield* searchString(self, args[0]);
  const length = charLength(self.s);
  let start = args.length > 1 ? yield* toIndex(args[1]) : length;
  if (start < 0) start += length;
  if (start < 0) return NIL;
  if (target.rawBytes && !target.binary) return NIL;
  const found = self.s.lastIndexOf(target.s, unitOffset(self.s, Math.min(start, length)));
  return found === -1 ? NIL : BigInt(charPosition(self.s, found));
});
def('String', 'count', [1, -1], function* (self: RString, args) {
  if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
  const sets: string[] = [];
  for (const arg of args) sets.push(yield* patternText(arg, 'characters'));
  const matches = characterSetMatcher(sets);
  return BigInt(charsOf(self.s).filter((char) => matches(char)).length);
});
def('String', 'delete', [1, -1], function* (self: RString, args) {
  if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
  if (self.s.length === 0) return stringFromBytes(stringBytes(self), self.binary);
  const sets: string[] = [];
  for (const arg of args) sets.push(yield* patternText(arg, 'characters'));
  const matches = characterSetMatcher(sets);
  return textResult(
    self,
    charsOf(self.s)
      .filter((char) => !matches(char))
      .join('')
  );
});
def('String', 'delete!', [1, -1], function* (self: RString, args) {
  if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
  if (self.s.length === 0) return NIL;
  modify(self);
  const sets: string[] = [];
  for (const arg of args) sets.push(yield* patternText(arg, 'characters'));
  const matches = characterSetMatcher(sets);
  const result = charsOf(self.s)
    .filter((char) => !matches(char))
    .join('');
  if (result === self.s) return NIL;
  setText(self, result);
  return self;
});

function squeeze(text: string, sets: string[]): string {
  const matches = sets.length > 0 ? characterSetMatcher(sets) : () => true;
  let result = '';
  let previous: string | undefined;
  for (const char of charsOf(text)) {
    if (char === previous && matches(char)) continue;
    result += char;
    previous = char;
  }
  return result;
}

def('String', 'squeeze', [0, -1], function* (self: RString, args) {
  if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
  const sets: string[] = [];
  for (const arg of args) sets.push(yield* patternText(arg, 'characters'));
  return textResult(self, squeeze(self.s, sets));
});
def('String', 'squeeze!', [0, -1], function* (self: RString, args) {
  if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
  modify(self);
  const sets: string[] = [];
  for (const arg of args) sets.push(yield* patternText(arg, 'characters'));
  const result = squeeze(self.s, sets);
  if (result === self.s) return NIL;
  setText(self, result);
  return self;
});

/** Expands a `tr`-style character set (`a-z`, `^abc`, `\\-`) into its characters and whether it is negated. */
function expandSet(spec: string): { chars: string[]; negated: boolean } {
  const chars = charsOf(spec);
  const negated = chars.length > 1 && chars[0] === '^';
  const items = negated ? chars.slice(1) : chars;
  const expanded: string[] = [];
  for (let index = 0; index < items.length; index++) {
    let char = items[index];
    if (char === '\\' && index + 1 < items.length) {
      expanded.push(items[++index]);
      continue;
    }
    if (items[index + 1] === '-' && index + 2 < items.length) {
      const from = char.codePointAt(0) as number;
      const to = items[index + 2].codePointAt(0) as number;
      if (from > to) {
        throw argumentError(`invalid range "${char}-${items[index + 2]}" in string transliteration`);
      }
      rt().spend(to - from + 1);
      rt().chargeSlots(to - from + 1);
      for (let code = from; code <= to; code++) expanded.push(String.fromCodePoint(code));
      index += 2;
      continue;
    }
    char = items[index];
    expanded.push(char);
  }
  return { chars: expanded, negated };
}

function characterSetMatcher(sets: string[]): (char: string) => boolean {
  const tests = sets.map((spec) => {
    const { chars, negated } = expandSet(spec);
    const set = new Set(chars);
    return (char: string): boolean => set.has(char) !== negated;
  });
  return (char) => tests.every((test) => test(char));
}

// code-gauge-allow functionCognitiveComplexity 19 -- Translation expands character sets and optionally squeezes adjacent replacements.
function translate(
  text: string,
  fromSpec: string,
  toSpec: string,
  squeezeRuns: boolean
): { text: string; matched: boolean } {
  const from = expandSet(fromSpec);
  const to = expandSet(toSpec).chars;
  let result = '';
  let previous: string | undefined;
  let matched = false;
  for (const char of charsOf(text)) {
    let replacement: string | undefined;
    if (from.negated) {
      if (!from.chars.includes(char)) replacement = to.at(-1) ?? '';
    } else {
      const position = from.chars.lastIndexOf(char);
      if (position !== -1) replacement = to.length === 0 ? '' : (to[position] ?? to.at(-1));
    }
    if (replacement === undefined) {
      result += char;
      previous = undefined;
      continue;
    }
    matched = true;
    if (squeezeRuns && replacement === previous) continue;
    result += replacement;
    previous = replacement;
  }
  return { text: result, matched };
}

for (const [name, squeezeRuns] of [
  ['tr', false],
  ['tr_s', true],
] as const) {
  def('String', name, 2, function* (self: RString, [from, to]) {
    if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
    if (self.s.length === 0) {
      if (!(from instanceof RString)) yield* stringArgValue(from);
      if (!(to instanceof RString)) yield* stringArgValue(to);
      return stringFromBytes(stringBytes(self), self.binary);
    }
    return textResult(
      self,
      translate(self.s, yield* patternText(from, 'characters'), yield* patternText(to, 'characters'), squeezeRuns).text
    );
  });
  def('String', `${name}!`, 2, function* (self: RString, [from, to]) {
    if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
    if (self.s.length === 0) {
      if (!(from instanceof RString)) yield* stringArgValue(from);
      if (!(to instanceof RString)) yield* stringArgValue(to);
      return NIL;
    }
    const source = yield* patternText(from, 'characters');
    const replacement = yield* patternText(to, 'characters');
    modify(self);
    const result = translate(self.s, source, replacement, squeezeRuns);
    if (!result.matched) return NIL;
    setText(self, result.text);
    return self;
  });
}

// Substitution --------------------------------------------------------------------------------------------------------

function expandReplacementValue(replacement: RString, match: RString, before: RString, after: RString): RString {
  const bytes = stringBytes(replacement);
  const chunks: Uint8Array[] = [];
  let length = 0;
  let binary = replacement.binary;
  let start = 0;
  const append = (part: Uint8Array): void => {
    length += part.length;
    if (length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
    chunks.push(part);
  };
  for (let index = 0; index + 1 < bytes.length; index++) {
    if (bytes[index] !== 92) continue;
    const code = bytes[index + 1];
    const source = code === 48 || code === 38 ? match : code === 39 ? after : code === 96 ? before : undefined;
    if (!source && code !== 92 && (code < 48 || code > 57)) continue;
    append(bytes.slice(start, index));
    if (source) {
      binary = combinedStringEncoding(
        binary,
        bytes.every((byte) => byte < 0x80),
        source
      );
      append(stringBytes(source));
    } else if (code === 92) append(Uint8Array.of(92));
    index++;
    start = index + 1;
  }
  append(bytes.slice(start));
  return stringFromBytes(joinChunks(chunks, length), binary);
}

// code-gauge-allow functionCognitiveComplexity 25 -- Substitution coordinates block and replacement-string forms across first/all matches.
// code-gauge-allow functionNcss 38 -- Substitution coordinates block and replacement-string forms across first/all matches.
function* substitute(
  self: RString,
  args: Value[],
  block: RProc | undefined,
  global: boolean,
  mutating = false
): Gen<{ value: RString; matched: boolean }> {
  const [pattern, replacement] = args;
  regexpUnsupported(pattern);
  const target = yield* patternText(pattern, 'regexp');
  if (replacement === undefined && !block) {
    if (global) throw new UnsupportedFeatureError('ブロックを渡さない gsub（Enumerator）');
    throw argumentError('wrong number of arguments (given 1, expected 2)');
  }
  let text = self.s;
  const source = stringBytes(self);
  const sourceLength = source.length;
  const sourceBinary = self.binary;
  const sourceAscii = source.every((byte) => byte < 0x80);
  let resultBinary = sourceBinary;
  let active = source;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const append = (bytes: Uint8Array): void => {
    length += bytes.length;
    if (length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
    rt().spend(Math.ceil(bytes.length / 256));
    chunks.push(bytes);
  };
  let position = 0;
  let positionByte = 0;
  let matched = false;
  for (;;) {
    const found = text.indexOf(target, position);
    if (found === -1) break;
    const raw = self.binary || self.rawBytes !== undefined;
    const foundByte = textByteLength(text.slice(0, found), raw);
    matched = true;
    const piece = yield* substitutionPiece(self, target, replacement, block, text, found, foundByte);
    if (stringBytes(self).length !== sourceLength) throw runtimeError('string modified');
    const modified = (global || mutating) && self.s !== text;
    if (global || mutating) {
      text = self.s;
      active = stringBytes(self);
    }
    append(active.slice(positionByte, foundByte));
    resultBinary = combinedStringEncoding(resultBinary, sourceAscii, piece);
    append(stringBytes(piece));
    positionByte = foundByte + textByteLength(target, raw);
    position = modified ? textIndexAtByte(text, positionByte, raw) : found + target.length;
    if (target.length === 0) {
      position = advanceEmptySubstitution(text, position, positionByte, active, raw, append);
      positionByte = textByteLength(text.slice(0, position), raw);
      if (position > text.length) break;
    }
    if (!global) break;
    rt().spend();
  }
  if (positionByte <= sourceLength) append(active.slice(positionByte));
  return { value: stringFromBytes(joinChunks(chunks, length), resultBinary), matched };
}

function advanceEmptySubstitution(
  text: string,
  position: number,
  positionByte: number,
  active: Uint8Array,
  raw: boolean,
  append: (bytes: Uint8Array) => void
): number {
  if (position >= text.length) return position + 1;
  const char = String.fromCodePoint(text.codePointAt(position) as number);
  append(active.slice(positionByte, textByteLength(text.slice(0, position + char.length), raw)));
  return position + char.length;
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function* substitutionPiece(
  self: RString,
  target: string,
  replacement: Value | undefined,
  block: RProc | undefined,
  text: string,
  found: number,
  foundByte: number
): Gen<RString> {
  if (replacement instanceof RHash) {
    const key = str(target);
    return yield* whileHeld(key, function* () {
      const entry = yield* hashGet(replacement, key);
      return yield* toSValue(entry ? entry.value : yield* hashDefault(replacement, key));
    });
  }
  if (replacement !== undefined) {
    const bytes = stringBytes(self);
    const matchLength = textByteLength(target, self.binary || self.rawBytes !== undefined);
    return expandReplacementValue(
      yield* stringArgValue(replacement),
      stringFromBytes(bytes.slice(foundByte, foundByte + matchLength), self.binary),
      stringFromBytes(bytes.slice(0, foundByte), self.binary),
      stringFromBytes(bytes.slice(foundByte + matchLength), self.binary)
    );
  }
  return yield* toSValue(yield* callBlock(block as RProc, [str(target)]));
}

def('String', 'sub', [1, 2], function* (self: RString, args, block) {
  return (yield* substitute(self, args, block, false)).value;
});
def('String', 'gsub', [1, 2], function* (self: RString, args, block) {
  return (yield* substitute(self, args, block, true)).value;
});
def('String', 'sub!', [1, 2], function* (self: RString, args, block) {
  modify(self);
  const result = yield* substitute(self, args, block, false, true);
  if (!result.matched) return NIL;
  setBytes(self, stringBytes(result.value), result.value.binary);
  return self;
});
def('String', 'gsub!', [1, 2], function* (self: RString, args, block) {
  modify(self);
  const result = yield* substitute(self, args, block, true, true);
  if (!result.matched) return NIL;
  setBytes(self, stringBytes(result.value), result.value.binary);
  return self;
});
def('String', 'scan', 1, function* (self: RString, [pattern], block) {
  if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
  regexpUnsupported(pattern);
  const target = yield* patternText(pattern, 'regexp');
  if (target.length === 0) return yield* scanEmpty(self, block);
  const found: Value[] = [];
  let text = self.s;
  const sourceLength = stringBytes(self).length;
  let position = 0;
  for (;;) {
    const index = text.indexOf(target, position);
    if (index === -1) break;
    const raw = self.binary || self.rawBytes !== undefined;
    const foundByte = textByteLength(text.slice(0, index), raw);
    const match = str(target);
    let modified = false;
    if (block) {
      yield* callBlock(block, [match], false);
      if (stringBytes(self).length !== sourceLength) throw runtimeError('string modified');
      modified = self.s !== text;
      text = self.s;
    } else found.push(match);
    const nextByte = foundByte + textByteLength(target, raw);
    position = modified ? textIndexAtByte(text, nextByte, raw) : index + target.length;
    if (position > text.length) break;
  }
  if (!block) return arr(found);
  return self;
});

function* scanEmpty(self: RString, block: RProc | undefined): Gen<Value> {
  const sourceLength = stringBytes(self).length;
  const found: Value[] = [];
  for (let offset = 0; offset <= sourceLength;) {
    const bytes = stringBytes(self);
    const first = bytes[offset];
    const width = self.binary || first < 0xc2 || first >= 0xf5 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
    const match = str('');
    if (block) {
      yield* callBlock(block, [match], false);
      if (stringBytes(self).length !== sourceLength) throw runtimeError('string modified');
    } else found.push(match);
    if (offset === sourceLength) break;
    offset += width;
    rt().spend();
  }
  return block ? self : arr(found);
}

function textByteLength(text: string, raw: boolean): number {
  return raw ? text.length : new TextEncoder().encode(text).length;
}

function textIndexAtByte(text: string, offset: number, raw: boolean): number {
  if (raw) return Math.min(offset, text.length);
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    if (bytes >= offset) return index;
    const point = text.codePointAt(index) as number;
    bytes += textByteLength(String.fromCodePoint(point), false);
    index += point > 0xff_ff ? 2 : 1;
    if (index % 256 === 0) rt().spend(256);
  }
  return text.length;
}
for (const name of ['match', 'match?', '=~']) {
  def('String', name, [1, 2], () => {
    throw new UnsupportedFeatureError('正規表現');
  });
}

// Case and whitespace -------------------------------------------------------------------------------------------------

function capitalize(text: string): string {
  const chars = charsOf(text);
  if (chars.length === 0) return text;
  return chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
}

function swapcase(text: string): string {
  return charsOf(text)
    .map((char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()))
    .join('');
}

const STRIP_CHARS = '\t\n\v\f\r \0';

function lstrip(text: string): string {
  let start = 0;
  while (start < text.length && STRIP_CHARS.slice(0, 6).includes(text[start])) start++;
  return text.slice(start);
}

function rstrip(text: string): string {
  let end = text.length;
  while (end > 0 && STRIP_CHARS.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

function chomp(text: string, separator: string | undefined): string {
  if (separator === undefined) return text;
  if (separator === '\n') {
    if (text.endsWith('\r\n')) return text.slice(0, -2);
    if (text.endsWith('\n') || text.endsWith('\r')) return text.slice(0, -1);
    return text;
  }
  if (separator === '') return text.replace(/(\r?\n)+$/, '');
  return text.endsWith(separator) ? text.slice(0, -separator.length) : text;
}

function chop(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  const chars = charsOf(text);
  return chars.slice(0, -1).join('');
}

const TRANSFORMS: [string, (text: string, args: string[]) => string, number][] = [
  ['upcase', (text) => text.toUpperCase(), 0],
  ['downcase', (text) => text.toLowerCase(), 0],
  ['capitalize', capitalize, 0],
  ['swapcase', swapcase, 0],
  ['strip', (text) => lstrip(rstrip(text)), 0],
  ['lstrip', lstrip, 0],
  ['rstrip', rstrip, 0],
  ['chomp', (text, args) => chomp(text, args[0]), 1],
  ['chop', chop, 0],
  ['succ', succ, 0],
  ['next', succ, 0],
];

for (const [name, transform, maxArgs] of TRANSFORMS) {
  def('String', name, [0, maxArgs], function* (self: RString, args) {
    const selected = name === 'chomp' && args.length === 0 ? [rt().globals.get('$/') ?? NIL] : args;
    if (self.rawBytes && !self.binary) return transformInvalid(self, name, yield* invalidSeparator(name, selected));
    if (self.binary && (name === 'succ' || name === 'next'))
      return stringFromBytes(successorBytes(stringBytes(self), true), true);
    if (name === 'chomp' && selected[0] === NIL) return stringFromBytes(stringBytes(self), self.binary);
    const strings: string[] = [];
    for (const arg of selected) strings.push(yield* stringArg(arg));
    return self.binary ? binaryTransform(self.s, name, strings, transform) : str(transform(self.s, strings));
  });
  def('String', `${name}!`, [0, maxArgs], function* (self: RString, args) {
    const selected = name === 'chomp' && args.length === 0 ? [rt().globals.get('$/') ?? NIL] : args;
    if (self.binary && (name === 'succ' || name === 'next')) {
      setBytes(self, successorBytes(stringBytes(self), true), true);
      return self;
    }
    if (self.rawBytes && !self.binary) {
      const result = transformInvalid(self, name, yield* invalidSeparator(name, selected));
      const before = stringBytes(self);
      const after = stringBytes(result);
      if (
        name !== 'succ' &&
        name !== 'next' &&
        before.length === after.length &&
        before.every((byte, index) => byte === after[index])
      ) {
        modify(self);
        return NIL;
      }
      setBytes(self, after);
      return self;
    }
    if (name === 'chomp' && selected[0] === NIL) {
      modify(self);
      return NIL;
    }
    const strings: string[] = [];
    for (const arg of selected) strings.push(yield* stringArg(arg));
    if (self.binary) {
      const result = binaryTransform(self.s, name, strings, transform);
      if (result.s === self.s && name !== 'succ' && name !== 'next') {
        modify(self);
        return NIL;
      }
      setBytes(self, stringBytes(result), true);
      return self;
    }
    const result = transform(self.s, strings);
    if (name === 'succ' || name === 'next') {
      setText(self, result);
      return self;
    }
    if (result === self.s) {
      modify(self);
      return NIL;
    }
    setText(self, result);
    return self;
  });
}

function binaryTransform(
  text: string,
  name: string,
  args: string[],
  transform: (text: string, args: string[]) => string
): RString {
  const result =
    name === 'upcase'
      ? asciiUpcase(text)
      : name === 'downcase'
        ? asciiDowncase(text)
        : name === 'capitalize'
          ? asciiUpcase(text.slice(0, 1)) + asciiDowncase(text.slice(1))
          : name === 'swapcase'
            ? text.replaceAll(/[a-zA-Z]/g, (char) => (char <= 'Z' ? char.toLowerCase() : char.toUpperCase()))
            : transform(text, args);
  const bytes = new Uint8Array(result.length);
  for (let index = 0; index < result.length; index++) bytes[index] = result.codePointAt(index) as number;
  return stringFromBytes(bytes, true);
}

function asciiUpcase(value: string): string {
  return value.replaceAll(/[a-z]/g, (char) => char.toUpperCase());
}

function asciiDowncase(value: string): string {
  return value.replaceAll(/[A-Z]/g, (char) => char.toLowerCase());
}

function* invalidSeparator(name: string, args: Value[]): Gen<RString | typeof NIL | undefined> {
  if (name !== 'chomp' || args.length === 0) return undefined;
  if (args[0] === NIL) return NIL;
  return yield* stringArgValue(args[0]);
}

def('String', 'reverse', 0, (self: RString) => joinStringCharacters(stringCharacters(self).toReversed(), self.binary));
def('String', 'reverse!', 0, (self: RString) => {
  const reversed = joinStringCharacters(stringCharacters(self).toReversed(), self.binary);
  setBytes(self, stringBytes(reversed), reversed.binary);
  return self;
});

const isSpace = (char: string): boolean => ' \t\n\v\f\r'.includes(char);

export function succ(text: string): string {
  return stringFromBytes(successorBytes(stringBytes(str(text)))).s;
}

// code-gauge-allow functionCognitiveComplexity 20 -- upto uses numeric-string width rules or String successor iteration with exclusive bounds.
def('String', 'upto', [1, 2], function* (self: RString, args, block) {
  if (!block) return makeEnumerator(self, 'upto', args);
  const end = yield* stringArgValue(args[0]);
  const last = end.s;
  const exclusive = args.length > 1 && truthy(args[1]);
  if (/^\d+$/.test(self.s) && /^\d+$/.test(last)) {
    const width = self.s.length;
    for (let value = BigInt(self.s); exclusive ? value < BigInt(last) : value <= BigInt(last); value++) {
      yield* callBlock(block, [str(String(value).padStart(width, '0'))], false);
    }
    return self;
  }
  const beginBytes = stringBytes(self);
  const endBytes = stringBytes(end);
  if (beginBytes.length === 1 && endBytes.length === 1 && beginBytes[0] < 128 && endBytes[0] < 128) {
    for (let byte = beginBytes[0]; exclusive ? byte < endBytes[0] : byte <= endBytes[0]; byte++)
      yield* callBlock(block, [stringFromBytes(Uint8Array.of(byte))], false);
    return self;
  }
  let current = stringFromBytes(stringBytes(self), self.binary);
  const limit = stringBytes(end);
  if (compareBytes(stringBytes(current), limit) > 0) return self;
  const afterEnd = successorBytes(limit, self.binary);
  for (;;) {
    const bytes = stringBytes(current);
    if (compareBytes(bytes, afterEnd) === 0 || (exclusive && compareBytes(bytes, limit) === 0)) break;
    yield* callBlock(block, [current], false);
    if (compareBytes(bytes, limit) === 0) break;
    const next = successorBytes(bytes, self.binary);
    if (next.length > limit.length || next.length === 0) break;
    current = stringFromBytes(next, self.binary);
    rt().spend();
  }
  return self;
});

function* justify(self: RString, args: Value[], kind: 'left' | 'right' | 'center'): Gen {
  const width = yield* toIndex(args[0]);
  const padding = args.length > 1 ? yield* stringArgValue(args[1]) : str(' ');
  const paddingChars = stringCharacters(padding);
  if (paddingChars.length === 0) throw argumentError('zero width padding');
  const chars = stringCharacters(self);
  const length = chars.length;
  const binary = combinedStringEncoding(
    self.binary,
    stringBytes(self).every((byte) => byte < 0x80),
    padding
  );
  if (width <= length) return stringFromBytes(stringBytes(self), self.binary);
  rt().checkStringLength(width);
  const total = width - length;
  const fill = (count: number): RString[] =>
    Array.from({ length: count }, (_, index) => paddingChars[index % paddingChars.length]);
  if (kind === 'left') return joinStringCharacters([...chars, ...fill(total)], binary);
  if (kind === 'right') return joinStringCharacters([...fill(total), ...chars], binary);
  const left = Math.floor(total / 2);
  return joinStringCharacters([...fill(left), ...chars, ...fill(total - left)], binary);
}

def('String', 'ljust', [1, 2], (self: RString, args) => justify(self, args, 'left'));
def('String', 'rjust', [1, 2], (self: RString, args) => justify(self, args, 'right'));
def('String', 'center', [1, 2], (self: RString, args) => justify(self, args, 'center'));

// Splitting -----------------------------------------------------------------------------------------------------------

def('String', 'split', [0, 2], function* (self: RString, args, block) {
  const [pattern = NIL, limitValue] = args;
  const limit = limitValue === undefined ? 0 : yield* toIndex(limitValue);
  if (limit === 1) {
    if (self.s.length === 0) return block ? self : arr([]);
    const value = stringFromBytes(stringBytes(self), self.binary);
    if (block) {
      yield* callBlock(block, [value], false);
      return self;
    }
    return arr([value]);
  }
  if (self.rawBytes && !self.binary) throw argumentError('invalid byte sequence in UTF-8');
  regexpUnsupported(pattern);
  const text = self.s;
  let parts: string[];
  if (isNil(pattern) || (pattern instanceof RString && pattern.s === ' ')) {
    parts = splitWhitespace(text, limit);
  } else {
    const separator = yield* patternText(pattern, 'characters');
    parts = separator === '' ? splitChars(text, limit) : splitString(text, separator, limit);
  }
  if (limit === 0) while (parts.length > 0 && parts.at(-1) === '') parts.pop();
  const values = parts.map((part) => str(part));
  if (!block) return arr(values);
  for (const value of values) yield* callBlock(block, [value], false);
  return self;
});

function splitWhitespace(text: string, limit: number): string[] {
  const parts: string[] = [];
  let index = 0;
  while (index < text.length && isSpace(text[index])) index++;
  while (index < text.length) {
    if (limit > 0 && parts.length === limit - 1) {
      parts.push(text.slice(index));
      return parts;
    }
    let end = index;
    while (end < text.length && !isSpace(text[end])) end++;
    parts.push(text.slice(index, end));
    index = end;
    while (index < text.length && isSpace(text[index])) index++;
  }
  return parts;
}

function splitChars(text: string, limit: number): string[] {
  const chars = charsOf(text);
  if (limit > 0 && chars.length > limit) return [...chars.slice(0, limit - 1), chars.slice(limit - 1).join('')];
  return chars;
}

function splitString(text: string, separator: string, limit: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (;;) {
    if (limit > 0 && parts.length === limit - 1) break;
    const index = text.indexOf(separator, start);
    if (index === -1) break;
    parts.push(text.slice(start, index));
    start = index + separator.length;
  }
  parts.push(text.slice(start));
  if (text.length === 0) return [];
  return parts;
}

def('String', 'partition', 1, function* (self: RString, [separator]) {
  regexpUnsupported(separator);
  const needle = yield* stringArgValue(separator);
  if (needle.rawBytes && !needle.binary) return arr([str(self.s), str(''), str('')]);
  const text = needle.s;
  const index = self.s.indexOf(text);
  if (index === -1) return arr([str(self.s), str(''), str('')]);
  return arr([str(self.s.slice(0, index)), str(text), str(self.s.slice(index + text.length))]);
});
def('String', 'rpartition', 1, function* (self: RString, [separator]) {
  regexpUnsupported(separator);
  const needle = yield* stringArgValue(separator);
  if (needle.rawBytes && !needle.binary) return arr([str(''), str(''), str(self.s)]);
  const text = needle.s;
  const index = self.s.lastIndexOf(text);
  if (index === -1) return arr([str(''), str(''), str(self.s)]);
  return arr([str(self.s.slice(0, index)), str(text), str(self.s.slice(index + text.length))]);
});
def('String', 'each_grapheme_cluster', 0, () => {
  throw new UnsupportedFeatureError('each_grapheme_cluster');
});
for (const name of [
  'encoding',
  'force_encoding',
  'encode',
  'unicode_normalize',
  'unpack',
  'unpack1',
  'crypt',
  'b',
  'scrub',
  'valid_encoding?',
]) {
  def('String', name, [0, -1], () => {
    throw new UnsupportedFeatureError(`String#${name}（文字コード）`);
  });
}
def('String', 'ascii_only?', 0, (self: RString) => !/[^\u0000-\u007F]/.test(self.s));
def('String', 'between?', 2, function* (self: RString, [min, max]) {
  return compareStrings(self.s, yield* stringArg(min)) >= 0 && compareStrings(self.s, yield* stringArg(max)) <= 0;
});

// Symbol --------------------------------------------------------------------------------------------------------------

def('Symbol', ['to_s', 'id2name', 'name'], 0, (self: RSymbol) => str(self.name));
def('Symbol', 'to_sym', 0, (self) => self);
def('Symbol', 'intern', 0, (self) => self);
def('Symbol', 'casecmp', 1, (self: RSymbol, [other]) =>
  other instanceof RSymbol
    ? BigInt(
        compareStrings(
          self.name.replaceAll(/[A-Z]/g, (char) => char.toLowerCase()),
          other.name.replaceAll(/[A-Z]/g, (char) => char.toLowerCase())
        )
      )
    : NIL
);
def('Symbol', 'casecmp?', 1, (self: RSymbol, [other]) =>
  other instanceof RSymbol ? foldCase(self.name) === foldCase(other.name) : NIL
);
def('Symbol', 'inspect', 0, (self: RSymbol) => str(symInspect(self.name)));
def('Symbol', ['length', 'size'], 0, (self: RSymbol) => BigInt(charLength(self.name)));
def('Symbol', 'empty?', 0, (self: RSymbol) => self.name.length === 0);
def('Symbol', ['==', '===', 'eql?', 'equal?'], 1, (self, [other]) => self === other);
def('Symbol', 'hash', 0, (self: RSymbol) => BigInt(self.name.length * 31 + (self.name.codePointAt(0) ?? 0)));
def('Symbol', '<=>', 1, (self: RSymbol, [other]) => {
  if (!(other instanceof RSymbol)) return NIL;
  return BigInt(compareStrings(self.name, other.name));
});
for (const [name, transform] of [
  ['upcase', (text: string) => text.toUpperCase()],
  ['downcase', (text: string) => text.toLowerCase()],
  ['capitalize', capitalize],
  ['swapcase', swapcase],
  ['succ', succ],
  ['next', succ],
] as const) {
  def('Symbol', name, 0, (self: RSymbol) => sym(transform(self.name)));
}
def('Symbol', ['[]', 'slice'], [1, 2], (self: RSymbol, args) => substring(str(self.name), args));
def('Symbol', 'start_with?', [0, -1], function* (self: RSymbol, args) {
  for (const arg of args) if (self.name.startsWith(yield* stringArg(arg))) return true;
  return false;
});
def('Symbol', 'end_with?', [0, -1], function* (self: RSymbol, args) {
  for (const arg of args) if (self.name.endsWith(yield* stringArg(arg))) return true;
  return false;
});
def('Symbol', 'to_proc', 0, (self: RSymbol) => symbolProc(self.name));

/** The lambda `&:name` passes: it calls the method `name` on its first argument. */
export function symbolProc(name: string): Value {
  return nativeProc(
    -2,
    (args, block) => {
      if (args.length === 0) throw argumentError('no receiver given');
      return callMethod(args[0], name, args.slice(1), undefined, block);
    },
    true
  );
}

export { requireBlock, rangeCovers, typeError };
