// code-gauge-allow-file fileNcss 796 -- The libString module keeps one concern's cases together.
import {
  compareStrings,
  inspect,
  rangeCovers,
  strInspect,
  symInspect,
  toIndex,
  toInt,
  toS,
  toStr,
} from './conversions';
import { def, sdef } from './define';
import { argumentError, frozenError, implicitConversionError, indexError, rangeError, typeError } from './errors';
import { format } from './format';
import { hashGet } from './hashes';
import { callBlock, callMethod, type Gen, nativeProc, requireBlock } from './interp';
import { makeEnumerator } from './libEnumerator';
import { parseFloatLenient, parseIntegerLenient } from './libNumeric';
import { NIL, RArray, RHash, type RProc, RRange, RString, RSymbol, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, isNil, str, stringBytes, stringFromBytes, sym, truthy } from './values';

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
  self.s = text;
  self.rawBytes = undefined;
}

function* stringArg(value: Value): Gen<string> {
  if (value instanceof RSymbol) throw implicitConversionError(value, 'String');
  return yield* toStr(value);
}

function regexpUnsupported(value: Value): void {
  if (value instanceof RString || value instanceof RSymbol) return;
  if (typeof value === 'object' && value !== NIL && (value as { cls?: { name?: string } }).cls?.name === 'Regexp') {
    throw new UnsupportedFeatureError('正規表現');
  }
}

/** Resolves `str[index]`, `str[start, length]`, and `str[range]` to a start and a length, or undefined. */
function* substringRange(length: number, args: Value[]): Gen<{ start: number; count: number } | undefined> {
  const [first, second] = args;
  if (second !== undefined) {
    let start = yield* toIndex(first);
    const count = yield* toIndex(second);
    if (start < 0) start += length;
    if (start < 0 || start > length || count < 0) return undefined;
    return { start, count: Math.min(count, length - start) };
  }
  if (first instanceof RRange) {
    const resolved = yield* rangeBounds(first, length);
    if (!resolved) return undefined;
    return resolved;
  }
  let index = yield* toIndex(first);
  if (index < 0) index += length;
  if (index < 0 || index >= length) return undefined;
  return { start: index, count: 1 };
}

/** The start and length a range selects from a sequence of `length` items, as `[]` resolves it. */
export function* rangeBounds(range: RRange, length: number): Gen<{ start: number; count: number } | undefined> {
  let start = range.begin === NIL ? 0 : yield* toIndex(range.begin);
  let end = range.end === NIL ? length : yield* toIndex(range.end);
  if (start < 0) start += length;
  if (start < 0 || start > length) return undefined;
  if (end < 0) end += length;
  if (!range.exclusive && range.end !== NIL) end += 1;
  return { start, count: Math.max(0, Math.min(end, length) - start) };
}

// Construction and conversion -----------------------------------------------------------------------------------------

def(
  'String',
  'initialize',
  [0, 1],
  function* (self: RString, args) {
    if (args.length > 0) setText(self, yield* toStr(args[0]));
    return NIL;
  },
  { visibility: 'private' }
);
sdef(
  'String',
  'new',
  [0, 1],
  function* (self, args, _block, keywords) {
    void keywords;
    const value = new RString(self, args.length > 0 ? yield* toStr(args[0]) : '');
    return value;
  },
  { keywords: true }
);
def('String', ['to_s', 'to_str'], 0, (self: RString) => (self.cls === rt().c.String ? self : str(self.s)));
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
  const decoder = new TextDecoder('utf-8', { fatal: true });
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
def('String', ['to_sym', 'intern'], 0, (self: RString) => sym(self.s));
def('String', 'to_i', [0, 1], function* (self: RString, args) {
  const base = args.length > 0 ? Number(yield* toInt(args[0])) : 10;
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
def('String', ['length', 'size'], 0, (self: RString) => BigInt(charLength(self.s)));
def('String', 'bytesize', 0, (self: RString) => BigInt(stringBytes(self).length));
def('String', 'empty?', 0, (self: RString) => self.s.length === 0);
def('String', 'hash', 0, (self: RString) => {
  let hash = 7n;
  for (const byte of stringBytes(self)) hash = (hash * 31n + BigInt(byte)) % 2_305_843_009_213_693_951n;
  return hash;
});
def('String', ['==', '===', 'eql?'], 1, function* (self: RString, [other]) {
  if (other instanceof RString) {
    if (!self.rawBytes && !other.rawBytes) return self.s === other.s;
    const left = stringBytes(self);
    const right = stringBytes(other);
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  }
  return false;
});
def('String', '<=>', 1, (self: RString, [other]) => {
  if (!(other instanceof RString)) return NIL;
  return BigInt(compareStrings(self.s, other.s));
});
def('String', 'casecmp', 1, function* (self: RString, [other]) {
  if (!(other instanceof RString)) {
    if (other instanceof RSymbol) throw implicitConversionError(other, 'String');
    return NIL;
  }
  return BigInt(compareStrings(foldAscii(self.s), foldAscii(other.s)));
});
def('String', 'casecmp?', 1, function* (self: RString, [other]) {
  if (!(other instanceof RString)) {
    if (other instanceof RSymbol) throw implicitConversionError(other, 'String');
    return NIL;
  }
  return self.s.toLowerCase() === other.s.toLowerCase();
});

function foldAscii(text: string): string {
  return text.replaceAll(/[A-Z]/g, (char) => char.toLowerCase());
}

def('String', '+', 1, function* (self: RString, [other]) {
  const right = other instanceof RString ? stringBytes(other) : new TextEncoder().encode(yield* stringArg(other));
  const left = stringBytes(self);
  rt().checkStringLength(left.length + right.length);
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return stringFromBytes(joined);
});
def('String', '*', 1, function* (self: RString, [count]) {
  const times = yield* toIndex(count);
  if (times < 0) throw argumentError('negative argument');
  const source = stringBytes(self);
  if (source.length * times > 1_000_000) throw argumentError('argument too big');
  rt().spend(Math.floor((source.length * times) / 256));
  const repeated = new Uint8Array(source.length * times);
  for (let index = 0; index < times; index++) repeated.set(source, index * source.length);
  return stringFromBytes(repeated);
});
def('String', '%', 1, function* (self: RString, [value]) {
  return str(yield* format(self, value instanceof RArray ? value.items : [value]));
});
def('String', '-@', 0, (self: RString) => {
  if (self.frozen) return self;
  const copy = str(self.s);
  copy.frozen = true;
  return copy;
});
def('String', '+@', 0, (self: RString) => (self.frozen ? str(self.s) : self));
def('String', ['<<', 'concat'], [0, -1], function* (self: RString, args) {
  modify(self);
  const chunks: Uint8Array[] = [stringBytes(self)];
  let length = chunks[0].length;
  for (const arg of args) {
    let chunk: Uint8Array;
    if (typeof arg === 'bigint') {
      if (arg < 0n) throw rangeError(`${arg} out of char range`);
      if (arg > 0x7f_ff_ff_ff_ff_ff_ff_ffn) throw rangeError('bignum out of char range');
      if (arg > 0x10_ff_ffn) throw rangeError(`${arg} out of char range`);
      if (arg >= 0xd8_00n && arg <= 0xdf_ffn)
        throw rangeError(`invalid codepoint 0x${arg.toString(16).toUpperCase()} in UTF-8`);
      chunk = arg <= 255n ? Uint8Array.of(Number(arg)) : new TextEncoder().encode(String.fromCodePoint(Number(arg)));
    } else {
      chunk = arg instanceof RString ? stringBytes(arg) : new TextEncoder().encode(yield* stringArg(arg));
    }
    length += chunk.length;
    rt().checkStringLength(length);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const result = stringFromBytes(bytes);
  self.s = result.s;
  self.binary = result.binary;
  self.rawBytes = result.rawBytes;
  return self;
});
def('String', 'replace', 1, function* (self: RString, [other]) {
  modify(self);
  const source = other instanceof RString ? other : str(yield* stringArg(other));
  const result = stringFromBytes(stringBytes(source));
  self.s = result.s;
  self.binary = result.binary;
  self.rawBytes = result.rawBytes;
  return self;
});
def('String', 'clear', 0, (self: RString) => {
  setText(self, '');
  return self;
});
def('String', 'insert', 2, function* (self: RString, [index, other]) {
  const chars = charsOf(self.s);
  let position = yield* toIndex(index);
  const text = yield* stringArg(other);
  if (position < 0) position += chars.length + 1;
  if (position < 0 || position > chars.length) throw indexError(`index ${yield* toIndex(index)} out of string`);
  chars.splice(position, 0, text);
  setText(self, chars.join(''));
  return self;
});
def('String', 'prepend', [0, -1], function* (self: RString, args) {
  let prefix = '';
  for (const arg of args) prefix += yield* stringArg(arg);
  setText(self, prefix + self.s);
  return self;
});

// Access --------------------------------------------------------------------------------------------------------------

function* substring(self: RString, args: Value[]): Gen {
  const [first] = args;
  if (args.length === 1 && first instanceof RString) return self.s.includes(first.s) ? str(first.s) : NIL;
  regexpUnsupported(first);
  const chars = charsOf(self.s);
  const range = yield* substringRange(chars.length, args);
  if (!range) return NIL;
  if (args.length === 1 && !(first instanceof RRange) && range.count === 1) return str(chars[range.start]);
  return str(chars.slice(range.start, range.start + range.count).join(''));
}

def('String', ['[]', 'slice'], [1, 2], (self: RString, args) => substring(self, args));
def('String', 'slice!', [1, 2], function* (self: RString, args) {
  modify(self);
  const result = yield* substring(self, args);
  if (result === NIL) return NIL;
  const [first] = args;
  if (args.length === 1 && first instanceof RString) {
    setText(self, self.s.replace(first.s, ''));
    return result;
  }
  const chars = charsOf(self.s);
  const range = yield* substringRange(chars.length, args);
  if (range) chars.splice(range.start, range.count);
  setText(self, chars.join(''));
  return result;
});
// code-gauge-allow functionCognitiveComplexity 17 -- Ruby's method takes these argument forms, which the branches mirror.
def('String', '[]=', [2, 3], function* (self: RString, args) {
  const value = yield* stringArg(args.at(-1) as Value);
  const selectors = args.slice(0, -1);
  const [first] = selectors;
  const chars = charsOf(self.s);
  if (selectors.length === 1 && first instanceof RString) {
    const position = self.s.indexOf(first.s);
    if (position === -1) throw indexError('string not matched');
    setText(self, self.s.slice(0, position) + value + self.s.slice(position + first.s.length));
    return args.at(-1) as Value;
  }
  regexpUnsupported(first);
  let range: { start: number; count: number } | undefined;
  if (selectors.length === 1 && !(first instanceof RRange)) {
    let index = yield* toIndex(first);
    if (index < 0) index += chars.length;
    if (index < 0 || index >= chars.length) throw indexError(`index ${yield* toIndex(first)} out of string`);
    range = { start: index, count: 1 };
  } else {
    range = yield* substringRange(chars.length, selectors);
    if (!range) {
      if (first instanceof RRange) throw rangeError(`${yield* inspect(first)} out of range`);
      throw indexError(`index ${yield* toIndex(first)} out of string`);
    }
  }
  chars.splice(range.start, range.count, value);
  setText(self, chars.join(''));
  return args.at(-1) as Value;
});
def('String', 'chars', 0, (self: RString) => arr(charsOf(self.s).map((char) => str(char))));
def('String', 'codepoints', 0, (self: RString) =>
  arr(charsOf(self.s).map((char) => BigInt(char.codePointAt(0) as number)))
);
def('String', 'bytes', 0, (self: RString) => arr([...stringBytes(self)].map(BigInt)));
def('String', 'getbyte', 1, function* (self: RString, [index]) {
  const bytes = stringBytes(self);
  let position = yield* toIndex(index);
  if (position < 0) position += bytes.length;
  return position >= 0 && position < bytes.length ? BigInt(bytes[position]) : NIL;
});
def('String', 'each_char', 0, function* (self: RString, _args, block) {
  if (!block) return makeEnumerator(self, 'each_char', []);
  for (const char of charsOf(self.s)) yield* callBlock(block, [str(char)], false);
  return self;
});
def('String', 'each_byte', 0, function* (self: RString, _args, block) {
  if (!block) return makeEnumerator(self, 'each_byte', []);
  for (const byte of stringBytes(self)) yield* callBlock(block, [BigInt(byte)], false);
  return self;
});
def('String', 'ord', 0, (self: RString) => {
  if (self.s.length === 0) throw argumentError('empty string');
  return BigInt(self.s.codePointAt(0) as number);
});
def('String', 'chr', 0, (self: RString) => str(charsOf(self.s)[0] ?? ''));
def('String', 'sum', [0, 1], function* (self: RString, args) {
  let total = 0n;
  for (const byte of stringBytes(self)) total += BigInt(byte);
  const bits = args.length > 0 ? yield* toInt(args[0]) : 16n;
  return bits > 0n && bits < 32n ? total & ((1n << bits) - 1n) : total;
});

function linesOf(text: string, separator: string | undefined, chomp: boolean): string[] {
  if (text.length === 0) return [];
  if (separator === undefined) return [text];
  const lines: string[] = [];
  let start = 0;
  if (separator === '') {
    const parts = text.split(/(?<=\n\n)(?=[^\n])/);
    return chomp ? parts.map((part) => part.replace(/\n+$/, '')) : parts;
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
  const separator = args[0] === NIL ? undefined : args.length > 0 ? yield* stringArg(args[0]) : '\n';
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
    return arr(linesOf(self.s, separator, chomp).map((line) => str(line)));
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
    for (const line of linesOf(self.s, separator, chomp)) yield* callBlock(block, [str(line)], false);
    return self;
  },
  { keywords: true }
);

// Searching -----------------------------------------------------------------------------------------------------------

def('String', 'include?', 1, function* (self: RString, [other]) {
  return self.s.includes(yield* stringArg(other));
});
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
  const text = yield* stringArg(prefix);
  return str(self.s.startsWith(text) ? self.s.slice(text.length) : self.s);
});
def('String', 'delete_suffix', 1, function* (self: RString, [suffix]) {
  const text = yield* stringArg(suffix);
  return str(text && self.s.endsWith(text) ? self.s.slice(0, -text.length) : self.s);
});

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
  const target = yield* stringArg(args[0]);
  const length = charLength(self.s);
  let start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  if (start < 0) start += length;
  if (start < 0 || start > length) return NIL;
  const found = self.s.indexOf(target, unitOffset(self.s, start));
  return found === -1 ? NIL : BigInt(charPosition(self.s, found));
});
def('String', 'rindex', [1, 2], function* (self: RString, args) {
  regexpUnsupported(args[0]);
  const target = yield* stringArg(args[0]);
  const length = charLength(self.s);
  let start = args.length > 1 ? yield* toIndex(args[1]) : length;
  if (start < 0) start += length;
  if (start < 0) return NIL;
  const found = self.s.lastIndexOf(target, unitOffset(self.s, Math.min(start, length)));
  return found === -1 ? NIL : BigInt(charPosition(self.s, found));
});
def('String', 'count', [1, -1], function* (self: RString, args) {
  const sets: string[] = [];
  for (const arg of args) sets.push(yield* stringArg(arg));
  const matches = characterSetMatcher(sets);
  return BigInt(charsOf(self.s).filter((char) => matches(char)).length);
});
def('String', 'delete', [1, -1], function* (self: RString, args) {
  const sets: string[] = [];
  for (const arg of args) sets.push(yield* stringArg(arg));
  const matches = characterSetMatcher(sets);
  return str(
    charsOf(self.s)
      .filter((char) => !matches(char))
      .join('')
  );
});
def('String', 'delete!', [1, -1], function* (self: RString, args) {
  modify(self);
  const sets: string[] = [];
  for (const arg of args) sets.push(yield* stringArg(arg));
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
  const sets: string[] = [];
  for (const arg of args) sets.push(yield* stringArg(arg));
  return str(squeeze(self.s, sets));
});
def('String', 'squeeze!', [0, -1], function* (self: RString, args) {
  modify(self);
  const sets: string[] = [];
  for (const arg of args) sets.push(yield* stringArg(arg));
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

// code-gauge-allow functionCognitiveComplexity 19 -- Ruby's method takes these argument forms, which the branches mirror.
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
    return str(translate(self.s, yield* stringArg(from), yield* stringArg(to), squeezeRuns).text);
  });
  def('String', `${name}!`, 2, function* (self: RString, [from, to]) {
    modify(self);
    const result = translate(self.s, yield* stringArg(from), yield* stringArg(to), squeezeRuns);
    if (!result.matched) return NIL;
    setText(self, result.text);
    return self;
  });
}

// Substitution --------------------------------------------------------------------------------------------------------

/** The text a replacement string stands for, where `\0`, `\&`, `\\`, `\'`, and `` \` `` refer to the match. */
function expandReplacement(replacement: string, match: string, before: string, after: string): string {
  return replacement.replaceAll(/\\([0&\\'`\d])/g, (_whole, code: string) => {
    switch (code) {
      case '0':
      case '&': {
        return match;
      }
      case '\\': {
        return '\\';
      }
      case "'": {
        return after;
      }
      case '`': {
        return before;
      }
      default: {
        return '';
      }
    }
  });
}

// code-gauge-allow functionCognitiveComplexity 25 -- Ruby's method takes these argument forms, which the branches mirror.
// code-gauge-allow functionNcss 38 -- Ruby's method takes these argument forms, which the branches mirror.
function* substitute(
  self: RString,
  args: Value[],
  block: RProc | undefined,
  global: boolean
): Gen<{ text: string; matched: boolean }> {
  const [pattern, replacement] = args;
  regexpUnsupported(pattern);
  const target = yield* stringArg(pattern);
  if (replacement === undefined && !block) {
    if (global) throw new UnsupportedFeatureError('ブロックを渡さない gsub（Enumerator）');
    throw argumentError('wrong number of arguments (given 1, expected 2)');
  }
  const text = self.s;
  let result = '';
  let position = 0;
  let matched = false;
  for (;;) {
    const found = text.indexOf(target, position);
    if (found === -1) break;
    matched = true;
    let piece: string;
    if (replacement instanceof RHash) {
      const entry = yield* hashGet(replacement, str(target));
      piece = yield* toS(entry ? entry.value : replacement.defaultValue);
    } else if (replacement !== undefined) {
      piece = expandReplacement(
        yield* stringArg(replacement),
        target,
        text.slice(0, found),
        text.slice(found + target.length)
      );
    } else {
      piece = yield* toS(yield* callBlock(block as RProc, [str(target)]));
    }
    result += text.slice(position, found) + piece;
    position = found + target.length;
    if (target.length === 0) {
      if (found < text.length) {
        const char = String.fromCodePoint(text.codePointAt(found) as number);
        result += char;
        position = found + char.length;
      } else position = found + 1;
      if (position > text.length) break;
    }
    if (!global) break;
    rt().spend();
  }
  if (position <= text.length) result += text.slice(position);
  return { text: result, matched };
}

def('String', 'sub', [1, 2], function* (self: RString, args, block) {
  return str((yield* substitute(self, args, block, false)).text);
});
def('String', 'gsub', [1, 2], function* (self: RString, args, block) {
  return str((yield* substitute(self, args, block, true)).text);
});
def('String', 'sub!', [1, 2], function* (self: RString, args, block) {
  modify(self);
  const result = yield* substitute(self, args, block, false);
  if (!result.matched) return NIL;
  setText(self, result.text);
  return self;
});
def('String', 'gsub!', [1, 2], function* (self: RString, args, block) {
  modify(self);
  const result = yield* substitute(self, args, block, true);
  if (!result.matched) return NIL;
  setText(self, result.text);
  return self;
});
def('String', 'scan', 1, function* (self: RString, [pattern], block) {
  regexpUnsupported(pattern);
  const target = yield* stringArg(pattern);
  const found: Value[] = [];
  let position = 0;
  for (;;) {
    const index = self.s.indexOf(target, position);
    if (index === -1) break;
    found.push(str(target));
    position =
      index +
      (target.length === 0 && index < self.s.length
        ? String.fromCodePoint(self.s.codePointAt(index) as number).length
        : Math.max(target.length, 1));
    if (position > self.s.length) break;
  }
  if (!block) return arr(found);
  for (const item of found) yield* callBlock(block, [item], false);
  return self;
});
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
  if (separator === undefined) {
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
  ['reverse', (text) => charsOf(text).toReversed().join(''), 0],
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
    if (name === 'chomp' && args[0] === NIL) return str(self.s);
    const strings: string[] = [];
    for (const arg of args) strings.push(yield* stringArg(arg));
    return str(transform(self.s, strings));
  });
  def('String', `${name}!`, [0, maxArgs], function* (self: RString, args) {
    if (name === 'chomp' && args[0] === NIL) {
      modify(self);
      return NIL;
    }
    const strings: string[] = [];
    for (const arg of args) strings.push(yield* stringArg(arg));
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

/** The successor of a string: its rightmost alphanumeric character incremented, carrying leftward. */
const isAlnum = (char: string): boolean => /^[A-Za-z0-9]$/.test(char);
const isSpace = (char: string): boolean => ' \t\n\v\f\r'.includes(char);

// code-gauge-allow functionCognitiveComplexity 23 -- Ruby's method takes these argument forms, which the branches mirror.
// code-gauge-allow functionNcss 40 -- Ruby's method takes these argument forms, which the branches mirror.
export function succ(text: string): string {
  if (text.length === 0) return '';
  const chars = charsOf(text);
  let index = chars.length - 1;
  while (index >= 0 && !isAlnum(chars[index])) index--;
  if (index < 0) {
    let position = chars.length - 1;
    for (;;) {
      const code = chars[position].codePointAt(0) as number;
      if (code < 0x10_ff_ff) {
        chars[position] = String.fromCodePoint(code + 1);
        return chars.join('');
      }
      chars[position] = '\u0001';
      if (--position < 0) return `\u0001${chars.join('')}`;
    }
  }
  let carry = '';
  for (;;) {
    const char = chars[index];
    let next: string;
    if (char === 'z') [next, carry] = ['a', 'a'];
    else if (char === 'Z') [next, carry] = ['A', 'A'];
    else if (char === '9') [next, carry] = ['0', '1'];
    else {
      chars[index] = String.fromCodePoint((char.codePointAt(0) as number) + 1);
      return chars.join('');
    }
    chars[index] = next;
    let left = index - 1;
    while (left >= 0 && !isAlnum(chars[left])) left--;
    if (left < 0) {
      chars.splice(index, 0, carry);
      return chars.join('');
    }
    index = left;
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- Ruby's method takes these argument forms, which the branches mirror.
def('String', 'upto', [1, 2], function* (self: RString, args, block) {
  if (!block) return makeEnumerator(self, 'upto', args);
  const last = yield* stringArg(args[0]);
  const exclusive = args.length > 1 && truthy(args[1]);
  if (/^\d+$/.test(self.s) && /^\d+$/.test(last)) {
    const width = self.s.length;
    for (let value = BigInt(self.s); exclusive ? value < BigInt(last) : value <= BigInt(last); value++) {
      yield* callBlock(block, [str(String(value).padStart(width, '0'))], false);
    }
    return self;
  }
  let current = self.s;
  const lastLength = charLength(last);
  if (compareStrings(current, last) > 0 && charLength(current) >= lastLength) return self;
  for (;;) {
    if (exclusive && current === last) break;
    yield* callBlock(block, [str(current)], false);
    if (current === last || charLength(current) > lastLength) break;
    current = succ(current);
    if (charLength(current) > lastLength) break;
  }
  return self;
});

function* justify(self: RString, args: Value[], kind: 'left' | 'right' | 'center'): Gen {
  const width = yield* toIndex(args[0]);
  const padding = args.length > 1 ? yield* stringArg(args[1]) : ' ';
  if (padding.length === 0) throw argumentError('zero width padding');
  const length = charLength(self.s);
  if (width <= length) return str(self.s);
  rt().checkStringLength(width);
  const total = width - length;
  const fill = (count: number): string => {
    const chars = charsOf(padding);
    let text = '';
    for (let index = 0; index < count; index++) text += chars[index % chars.length];
    return text;
  };
  if (kind === 'left') return str(self.s + fill(total));
  if (kind === 'right') return str(fill(total) + self.s);
  const left = Math.floor(total / 2);
  return str(fill(left) + self.s + fill(total - left));
}

def('String', 'ljust', [1, 2], (self: RString, args) => justify(self, args, 'left'));
def('String', 'rjust', [1, 2], (self: RString, args) => justify(self, args, 'right'));
def('String', 'center', [1, 2], (self: RString, args) => justify(self, args, 'center'));

// Splitting -----------------------------------------------------------------------------------------------------------

def('String', 'split', [0, 2], function* (self: RString, args, block) {
  const [pattern = NIL, limitValue] = args;
  regexpUnsupported(pattern);
  const limit = limitValue === undefined ? 0 : yield* toIndex(limitValue);
  const text = self.s;
  let parts: string[];
  if (isNil(pattern) || (pattern instanceof RString && pattern.s === ' ')) {
    parts = splitWhitespace(text, limit);
  } else {
    const separator = yield* stringArg(pattern);
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
  const text = yield* stringArg(separator);
  const index = self.s.indexOf(text);
  if (index === -1) return arr([str(self.s), str(''), str('')]);
  return arr([str(self.s.slice(0, index)), str(text), str(self.s.slice(index + text.length))]);
});
def('String', 'rpartition', 1, function* (self: RString, [separator]) {
  regexpUnsupported(separator);
  const text = yield* stringArg(separator);
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
