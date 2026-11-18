// code-gauge-allow-file fileNcss 884 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/text-encoding-identifier-case -- mbstring names its encodings in this case.
// oxlint-disable typescript/no-misused-spread -- PHP splits strings into bytes or code points, never into grapheme clusters.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { inflateRawSync } from 'node:zlib';

import { eastAsianWidth } from 'get-east-asian-width';

import { codePointBytes, dec, enc, lower } from './bytes';
import { encodingValidator, extraEncodingReader } from './detectionReaders';
import { deprecated, throwError, warn } from './errors';
import { padUnits } from './libString';
import { encodingNames } from './multibyteEncodingNames';
import { defineConstant, defineFunction } from './native';
import { toStr } from './operators';
import { rt } from './runtime';
import { foldSimple } from './unicodeSimpleCaseFold';
import { UnsupportedFeatureError } from './unsupported';
import { type NativeFunction, PhpArray, type Value } from './values';

defineConstant('MB_CASE_UPPER', 0n);
defineConstant('MB_CASE_LOWER', 1n);
defineConstant('MB_CASE_TITLE', 2n);
defineConstant('MB_CASE_FOLD', 3n);
defineConstant('MB_CASE_UPPER_SIMPLE', 4n);
defineConstant('MB_CASE_LOWER_SIMPLE', 5n);
defineConstant('MB_CASE_TITLE_SIMPLE', 6n);
defineConstant('MB_CASE_FOLD_SIMPLE', 7n);

const s = (value: Value): string => value as string;
const n = (value: Value): number => Number(value as bigint);
const chars = (value: Value): string[] => {
  const text = s(value);
  const parts: string[] = [];
  for (let index = 0; index < text.length;) {
    const [, length] = decodeUtf8At(text, index);
    parts.push(text.slice(index, index + length));
    index += length;
  }
  return parts;
};

function checkEncoding(name: string, args: Value[], position: number, parameter = 'encoding'): void {
  const encoding = args[position - 1];
  if (typeof encoding === 'string' && !encodingNames.has(lower(encoding))) {
    throwError(
      'ValueError',
      `${name}(): Argument #${position} ($${parameter}) must be a valid encoding, "${encoding}" given`
    );
  }
}

defineUtf8Function('mb_strlen(string $string, ?string $encoding = null): int', ({ args }) => {
  checkEncoding('mb_strlen', args, 2);
  return BigInt(chars(args[0]).length);
});
defineUtf8Function(
  'mb_substr(string $string, int $start, ?int $length = null, ?string $encoding = null): string',
  ({ args }) => {
    checkEncoding('mb_substr', args, 4);
    const list = chars(args[0]);
    let start = n(args[1]);
    if (start < 0) start = Math.max(list.length + start, 0);
    if (start > list.length) return '';
    let end = list.length;
    if (args[2] !== undefined && args[2] !== null) {
      const length = n(args[2]);
      end = length < 0 ? Math.max(list.length + length, start) : Math.min(start + length, list.length);
    }
    return encodeCodes(UTF8.decode(list.slice(start, end).join('')), UTF8);
  }
);
defineFunction('mb_strtoupper(string $string, ?string $encoding = null): string', ({ args }) => {
  return convertCase(args, 2, 'mb_strtoupper', (text) => text.toUpperCase());
});
defineFunction('mb_strtolower(string $string, ?string $encoding = null): string', ({ args }) => {
  return convertCase(args, 2, 'mb_strtolower', (text) => wordCase(text, 'lower'));
});
defineUtf8Function('mb_str_split(string $string, int $length = 1, ?string $encoding = null): array', ({ args }) => {
  const list: string[] = [];
  const text = s(args[0]);
  for (let index = 0; index < text.length;) {
    const lead = text.charCodeAt(index);
    const size = lead < 0xc2 || lead > 0xf4 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    list.push(text.slice(index, index + size));
    index += size;
  }
  const length = args[1] === undefined ? 1 : n(args[1]);
  if (length < 1) throwError('ValueError', 'mb_str_split(): Argument #2 ($length) must be greater than 0');
  checkEncoding('mb_str_split', args, 3);
  const parts: string[] = [];
  for (let index = 0; index < list.length; index += length) parts.push(list.slice(index, index + length).join(''));
  return PhpArray.list(parts);
});

function mbSearch(args: Value[], reverse: boolean, insensitive: boolean, name: string): Value {
  const codec = encodingArgument(args, 4, name);
  const searchable = (value: Value): string =>
    !insensitive && codec === UTF8 ? s(value) : searchableUtf8(codec.decode(s(value)), insensitive);
  const haystack = searchable(args[0]);
  const needle = searchable(args[1]);
  const offset = args[2] === undefined ? 0 : n(args[2]);
  const pointer = utf8Offset(haystack, offset);
  if (pointer === undefined)
    throwError('ValueError', `${name}(): Argument #3 ($offset) must be contained in argument #1 ($haystack)`);
  const start = reverse && offset < 0 ? 0 : pointer;
  const end =
    reverse && offset < 0
      ? (utf8Offset(haystack, charOffset(needle, needle.length), pointer) ?? haystack.length)
      : haystack.length;
  const found = searchBytes(haystack, needle, start, end - needle.length, reverse);
  return found === false ? false : BigInt(charOffset(haystack, Number(found)));
}

// code-gauge-allow functionCognitiveComplexity 27 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function utf8Offset(text: string, offset: number, start = 0): number | undefined {
  let position = offset < 0 ? text.length : start;
  while (offset !== 0) {
    rt().spend();
    if (offset < 0) {
      if (position <= start) return;
      if (!isContinuation(text.charCodeAt(--position))) offset++;
    } else {
      if (position >= text.length) return;
      const lead = text.charCodeAt(position);
      position += lead < 0xc2 || lead > 0xf4 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
      offset--;
    }
  }
  return Math.min(position, text.length);
}

// code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function searchBytes(text: string, needle: string, start: number, limit: number, last: boolean): bigint | false {
  if (needle.length === 0) return BigInt(last ? limit : start);
  if (limit < start) return false;
  const prefix = new Uint32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index++) {
    rt().spend();
    while (matched > 0 && needle[index] !== needle[matched]) {
      rt().spend();
      matched = prefix[matched - 1];
    }
    if (needle[index] === needle[matched]) matched++;
    prefix[index] = matched;
  }
  let found: bigint | false = false;
  for (let index = start, matched = 0; index < limit + needle.length; index++) {
    rt().spend();
    while (matched > 0 && text[index] !== needle[matched]) {
      rt().spend();
      matched = prefix[matched - 1];
    }
    if (text[index] === needle[matched]) matched++;
    if (matched === needle.length) {
      found = BigInt(index - needle.length + 1);
      if (!last) return found;
      matched = prefix[matched - 1];
    }
  }
  return found;
}

defineFunction(
  'mb_strpos(string $haystack, string $needle, int $offset = 0, ?string $encoding = null): int|false',
  ({ args }) => mbSearch(args, false, false, 'mb_strpos')
);
defineFunction(
  'mb_strrpos(string $haystack, string $needle, int $offset = 0, ?string $encoding = null): int|false',
  ({ args }) => mbSearch(args, true, false, 'mb_strrpos')
);
defineFunction(
  'mb_stripos(string $haystack, string $needle, int $offset = 0, ?string $encoding = null): int|false',
  ({ args }) => mbSearch(args, false, true, 'mb_stripos')
);
defineFunction('mb_substr_count(string $haystack, string $needle, ?string $encoding = null): int', ({ args }) => {
  if (s(args[1]) === '') throwError('ValueError', 'mb_substr_count(): Argument #2 ($needle) must not be empty');
  const codec = encodingArgument(args, 3, 'mb_substr_count');
  const haystack = searchableUtf8(codec.decode(s(args[0])), false);
  const needle = searchableUtf8(codec.decode(s(args[1])), false);
  if (needle.length === 0) throwError('ValueError', 'mb_substr_count(): Argument #2 ($needle) must not be empty');
  let count = 0n;
  let start = 0;
  while (start <= haystack.length - needle.length) {
    const found = searchBytes(haystack, needle, start, haystack.length - needle.length, false);
    if (found === false) break;
    count++;
    start = Number(found) + needle.length;
  }
  return count;
});
defineUtf8Function(
  'mb_str_pad(string $string, int $length, string $pad_string = " ", int $pad_type = STR_PAD_RIGHT, ?string $encoding = null): string',
  ({ args }) => {
    checkEncoding('mb_str_pad', args, 5);
    return padUnits('mb_str_pad', chars(args[0]), args, args[2] === undefined ? [' '] : chars(args[2]));
  }
);
defineUtf8Function('mb_strwidth(string $string, ?string $encoding = null): int', ({ args }) => {
  checkEncoding('mb_strwidth', args, 2);
  let width = 0;
  for (const char of dec(s(args[0]))) width += eastAsianWidth(char.codePointAt(0) as number) === 2 ? 2 : 1;
  return BigInt(width);
});
defineFunction('mb_convert_case(string $string, int $mode, ?string $encoding = null): string', ({ args }) => {
  checkEncoding('mb_convert_case', args, 3);
  const convert = CASE_MODES[n(args[1])] as ((text: string) => string) | undefined;
  if (!convert)
    throwError('ValueError', 'mb_convert_case(): Argument #2 ($mode) must be one of the MB_CASE_* constants');
  return convertCase(args, 3, 'mb_convert_case', convert);
});
defineFunction('mb_internal_encoding(?string $encoding = null): string|bool', ({ args }) => {
  checkEncoding('mb_internal_encoding', args, 1);
  if (typeof args[0] !== 'string') return rt().mbEncoding;
  rt().mbEncoding = codecFor(args[0], 'mb_internal_encoding').name;
  return true;
});
defineFunction('mb_ucfirst(string $string, ?string $encoding = null): string', ({ args }) => {
  return convertFirst(args, 'mb_ucfirst', titleFull);
});
defineFunction('mb_lcfirst(string $string, ?string $encoding = null): string', ({ args }) => {
  return convertFirst(args, 'mb_lcfirst', (text) => text.toLowerCase());
});

function convertFirst(args: Value[], name: string, convert: (text: string) => string): string {
  const codec = encodingArgument(args, 2, name);
  const text = s(args[0]);
  const codes = codec.decode(text);
  const singleByte = codec.name === 'ASCII' || codec.name === 'ISO-8859-1';
  const first = singleByte ? text.slice(0, 1) : encodeCodes(codes.slice(0, 1), codec);
  const head = convertCase([first, codec.name], 2, name, convert);
  if (first === head) return text;
  const rest = singleByte ? text.slice(1) : encodeCodes(codes.slice(1), codec);
  return head + rest;
}

function convertCase(args: Value[], position: number, name: string, convert: (text: string) => string): string {
  const codec = encodingArgument(args, position, name);
  const text = codec
    .decode(s(args[0]))
    .map((code) => (code === BAD ? '\uDC00' : String.fromCodePoint(code)))
    .join('');
  const codes = [...convert(text)].map((char) => (char === '\uDC00' ? BAD : (char.codePointAt(0) as number)));
  return encodeCodes(codes, codec);
}

/** The conversions of `mb_convert_case` by the value of their MB_CASE_* constant. */
const CASE_MODES: readonly ((text: string) => string)[] = [
  (text) => text.toUpperCase(),
  (text) => wordCase(text, 'lower'),
  (text) => wordCase(text, 'title'),
  (text) => mapChars(text, foldFull),
  (text) => mapChars(text, upperSimple),
  (text) => mapChars(text, lowerSimple),
  (text) => wordCase(text, 'title-simple'),
  (text) => mapChars(text, foldSimple),
];
const CASED = /\p{Cased}/u;
const CASE_IGNORABLE = /\p{Case_Ignorable}/u;
const GEORGIAN = /^[\u10D0-\u10FA\u10FD-\u10FF]$/;
// The characters whose titlecase in Unicode's UnicodeData.txt and SpecialCasing.txt differs from their uppercase.
const TITLE_EXCEPTIONS = new Map<string, string>([
  ...[...'ßﬀﬁﬂﬃﬄﬅﬆﬓﬔﬕﬖﬗև'].map((char): [string, string] => {
    const [first, ...rest] = [...char.toUpperCase()];
    return [char, first + rest.join('').toLowerCase()];
  }),
  ...[...'ǄǅǆǇǈǉǊǋǌǱǲǳ'].map((char, index): [string, string] => [char, 'ǅǅǅǈǈǈǋǋǋǲǲǲ'[index]]),
  ...Array.from({ length: 0x30 }, (_, index): [string, string] => [
    String.fromCodePoint(0x1f_80 + index),
    String.fromCodePoint((0x1f_80 + index) | 8),
  ]),
  ...[...'ᾳᾼῃῌῳῼ'].map((char, index): [string, string] => [char, 'ᾼᾼῌῌῼῼ'[index]]),
  ['ᾲ', 'Ὰ\u0345'],
  ['ᾴ', 'Ά\u0345'],
  ['ῂ', 'Ὴ\u0345'],
  ['ῄ', 'Ή\u0345'],
  ['ῲ', 'Ὼ\u0345'],
  ['ῴ', 'Ώ\u0345'],
  ['ᾷ', 'Α\u0342\u0345'],
  ['ῇ', 'Η\u0342\u0345'],
  ['ῷ', 'Ω\u0342\u0345'],
]);

// code-gauge-allow functionCognitiveComplexity 24 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function wordCase(text: string, mode: 'lower' | 'title' | 'title-simple'): string {
  const simple = mode === 'title-simple';
  const list = [...text];
  const following = new Uint8Array(list.length);
  let after = false;
  if (!simple)
    for (let index = list.length - 1; index >= 0; index--) {
      rt().spend();
      following[index] = Number(after);
      if (!CASE_IGNORABLE.test(list[index])) after = CASED.test(list[index]);
    }
  let afterCased = false;
  let sigmaBefore = false;
  let result = '';
  for (const [index, char] of list.entries()) {
    rt().spend();
    if (simple) result += afterCased ? lowerSimple(char) : titleSimple(char);
    else if (mode !== 'lower' && !afterCased) result += titleFull(char);
    else result += char === 'Σ' && sigmaBefore && !following[index] ? 'ς' : char.toLowerCase();
    if (!CASE_IGNORABLE.test(char)) {
      sigmaBefore = CASED.test(char);
      if (char !== '\uDC00') afterCased = sigmaBefore;
    }
  }
  return result;
}

function titleFull(char: string): string {
  return TITLE_EXCEPTIONS.get(char) ?? (GEORGIAN.test(char) ? char : char.toUpperCase());
}

function titleSimple(char: string): string {
  const title = titleFull(char);
  return isOneChar(title) ? title : char;
}

function upperSimple(char: string): string {
  const upper = char.toUpperCase();
  if (isOneChar(upper)) return upper;
  const title = TITLE_EXCEPTIONS.get(char) ?? char;
  return isOneChar(title) ? title : char;
}

function lowerSimple(char: string): string {
  return [...char.toLowerCase()][0];
}

/** The full case folding of a character, which lowercases all but Cherokee and the dotless i. */
function foldFull(char: string): string {
  const code = char.codePointAt(0) as number;
  if (code >= 0xab_70 && code <= 0xab_bf) return String.fromCodePoint(code - 0xab_70 + 0x13_a0);
  if (code >= 0x13_f8 && code <= 0x13_fd) return String.fromCodePoint(code - 8);
  if ((code >= 0x13_a0 && code <= 0x13_f5) || char === 'ı') return char;
  return char.toLowerCase().toUpperCase().toLowerCase();
}

function mapChars(text: string, convert: (char: string) => string): string {
  let result = '';
  for (const char of text) result += convert(char);
  return result;
}

function isOneChar(text: string): boolean {
  return text.length === 1 || (text.length === 2 && (text.codePointAt(0) as number) > 0xff_ff);
}

const TRIM_DEFAULTS = [
  0x20, 0x0c, 0x0a, 0x0d, 0x09, 0x0b, 0x00, 0xa0, 0x16_80, 0x20_00, 0x20_01, 0x20_02, 0x20_03, 0x20_04, 0x20_05,
  0x20_06, 0x20_07, 0x20_08, 0x20_09, 0x20_0a, 0x20_28, 0x20_29, 0x20_2f, 0x20_5f, 0x30_00, 0x85, 0x18_0e,
];

for (const [name, mode] of [
  ['mb_trim', 3],
  ['mb_ltrim', 1],
  ['mb_rtrim', 2],
] as const) {
  defineFunction(
    `${name}(string $string, ?string $characters = null, ?string $encoding = null): string`,
    ({ args }) => {
      const codec = encodingArgument(args, 3, name);
      const characters = args[1] === undefined || args[1] === null ? TRIM_DEFAULTS : codec.decode(s(args[1]));
      if (characters.length === 0) return s(args[0]);
      return trimCodes(s(args[0]), new Set(characters), mode, codec);
    }
  );
}

interface Codec {
  name: string;
  decode: (bytes: string) => number[];
  /** The bytes of a code point, or undefined when the encoding cannot represent it. */
  encode: (code: number) => string | undefined;
}

/** Trims the characters of `set` from the left (mode bit 1) and the right (mode bit 2) as trim_each_wchar does. */
function trimCodes(text: string, set: Set<number>, mode: number, codec: Codec): string {
  const codes = codec.decode(text);
  let left = 0;
  let right = codes.length;
  if (mode & 1) while (left < right && set.has(codes[left])) left++;
  if (mode & 2) while (right > left && set.has(codes[right - 1])) right--;
  if (left === 0 && right === codes.length) return text;
  return encodeCodes(codes.slice(left, right), codec);
}

defineFunction('mb_chr(int $codepoint, ?string $encoding = null): string|false', ({ args }) => {
  checkEncoding('mb_chr', args, 2);
  const code = n(args[0]);
  if (code < 0 || code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) return false;
  return encodingArgument(args, 2, 'mb_chr').encode(code) ?? false;
});
defineFunction('mb_ord(string $string, ?string $encoding = null): int|false', ({ args }) => {
  const text = s(args[0]);
  if (text === '') throwError('ValueError', 'mb_ord(): Argument #1 ($string) must not be empty');
  checkEncoding('mb_ord', args, 2);
  const code = encodingArgument(args, 2, 'mb_ord').decode(text)[0];
  return code === BAD || code === undefined ? false : BigInt(code);
});

// Searching and cutting, which decode strings as mbstring's UTF-8 decoder does -----------------------------------------

defineFunction(
  'mb_strripos(string $haystack, string $needle, int $offset = 0, ?string $encoding = null): int|false',
  ({ args }) => mbSearch(args, true, true, 'mb_strripos')
);
for (const [name, reverse, insensitive] of [
  ['mb_strstr', false, false],
  ['mb_strrchr', true, false],
  ['mb_stristr', false, true],
  ['mb_strrichr', true, true],
] as const) {
  defineFunction(
    `${name}(string $haystack, string $needle, bool $before_needle = false, ?string $encoding = null): string|false`,
    ({ args }) => {
      const codec = encodingArgument(args, 4, name);
      const codes = codec.decode(s(args[0]));
      // mbstring searches UTF-8 text as it is, and converts other text to UTF-8 first.
      const searchable = (text: string, decoded: number[]): string =>
        codec === UTF8 && !insensitive ? text : searchableUtf8(decoded, insensitive);
      const haystack = searchable(s(args[0]), codes);
      const needle = searchable(s(args[1]), codec.decode(s(args[1])));
      const found = reverse ? haystack.lastIndexOf(needle) : haystack.indexOf(needle);
      if (found === -1) return false;
      const position = charOffset(haystack, found);
      return encodeCodes(args[2] === true ? codes.slice(0, position) : codes.slice(position), codec);
    }
  );
}

/** The code point mbstring decodes an invalid byte sequence to, which it writes as the substitute character. */
const BAD = -1;

/**
 * The UTF-8 text mbstring searches, simply case-folded when `insensitive`, with each invalid sequence as a byte that
 * matches no UTF-8 text.
 */
function searchableUtf8(codes: number[], insensitive: boolean): string {
  let result = '';
  for (const code of codes) {
    const char = String.fromCodePoint(Math.max(code, 0));
    result += code === BAD ? '\u00FF' : enc(insensitive ? foldSimple(char) : char);
  }
  return result;
}

/** How many characters come before a byte offset of UTF-8 text, counting the bytes that do not continue a sequence. */
function charOffset(text: string, offset: number): number {
  let count = 0;
  for (let index = 0; index < offset; index++) {
    if ((index & 127) === 0) rt().spend(2);
    const byte = text.charCodeAt(index);
    if (byte < 0x80 || byte > 0xbf) count++;
  }
  return count;
}

defineFunction(
  'mb_strimwidth(string $string, int $start, int $width, string $trim_marker = "", ?string $encoding = null): string',
  ({ args }) => {
    const codec = encodingArgument(args, 5, 'mb_strimwidth');
    const text = s(args[0]);
    const codes = codec.decode(text);
    let from = n(args[1]);
    let width = n(args[2]);
    if (from !== 0) {
      if (from < 0) from += codes.length;
      if (from < 0 || from > codes.length)
        throwError('ValueError', 'mb_strimwidth(): Argument #2 ($start) is out of range');
    }
    if (width < 0) {
      deprecated('mb_strimwidth(): passing a negative integer to argument #3 ($width) is deprecated');
      width += codesWidth(codes) - codesWidth(codes.slice(0, Math.max(from, 0)));
      if (width < 0) throwError('ValueError', 'mb_strimwidth(): Argument #3 ($width) is out of range');
    }
    return trimToWidth(codes, text, from, width, args[3] === undefined ? '' : s(args[3]), codec);
  }
);

/** Cuts characters from `from` to a display width as mb_trim_string does, ending a cut string with the marker. */
function trimToWidth(codes: number[], text: string, from: number, width: number, marker: string, codec: Codec): string {
  let remaining = width;
  const rest = codes.slice(from);
  const cut = rest.findIndex((code) => {
    const fits = charWidth(code) <= remaining;
    remaining -= charWidth(code);
    return !fits;
  });
  if (cut === -1) return from === 0 && !codes.includes(BAD) ? text : encodeCodes(rest, codec);
  const markerWidth = codesWidth(codec.decode(marker));
  if (width <= markerWidth) return marker;
  let available = width - markerWidth;
  let end = 0;
  while (end < rest.length && charWidth(rest[end]) <= available) available -= charWidth(rest[end++]);
  return encodeCodes(rest.slice(0, end), codec) + marker;
}

function codesWidth(codes: number[]): number {
  return codes.reduce((sum, code) => sum + charWidth(code), 0);
}

function charWidth(code: number): number {
  return code !== BAD && eastAsianWidth(code) === 2 ? 2 : 1;
}

// Encodings ----------------------------------------------------------------------------------------------------------

/**
 * Decodes UTF-8 as mbstring's mb_utf8_to_wchar does: an invalid sequence decodes to one {@link BAD}, which takes the
 * lead byte and the continuation bytes that could still have completed it.
 */
function decodeUtf8(bytes: string): number[] {
  const codes: number[] = [];
  for (let index = 0; index < bytes.length;) {
    if ((codes.length & 127) === 0) rt().spend(2);
    const [code, length] = decodeUtf8At(bytes, index);
    codes.push(code);
    index += length;
  }
  return codes;
}

/** The code point of the sequence at `index` and how many bytes the decoder takes for it. */
function decodeUtf8At(bytes: string, index: number): [number, number] {
  const lead = bytes.charCodeAt(index);
  if (lead < 0x80) return [lead, 1];
  const length = lead < 0xc2 || lead > 0xf4 ? 1 : lead <= 0xdf ? 2 : lead <= 0xef ? 3 : 4;
  if (length === 1) return [BAD, 1];
  const secondValid = isValidSecondByte(lead, bytes.charCodeAt(index + 1));
  if (bytes.length - index < length) return [BAD, 1 + truncatedTail(bytes, index + 1, lead, length, secondValid)];
  if (!secondValid) return [BAD, 1];
  let valid = 2;
  while (valid < length && isContinuation(bytes.charCodeAt(index + valid))) valid++;
  if (valid < length) return [BAD, valid];
  let code = lead & (0xff >> (length + 1));
  for (let offset = 1; offset < length; offset++) code = (code << 6) | (bytes.charCodeAt(index + offset) & 0x3f);
  return [code, length];
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Whether a byte can follow a lead byte, which rules out overlong forms, surrogates, and code points past U+10FFFF. */
function isValidSecondByte(lead: number, second: number): boolean {
  if (!isContinuation(second)) return false;
  if (lead === 0xe0 || lead === 0xf0) return second >= (lead === 0xe0 ? 0xa0 : 0x90);
  if (lead === 0xed || lead === 0xf4) return second < (lead === 0xed ? 0xa0 : 0x90);
  return true;
}

/** How many continuation bytes after the lead byte a truncated sequence takes, as far as they could still be valid. */
function truncatedTail(bytes: string, start: number, lead: number, length: number, secondValid: boolean): number {
  if (length === 3 && secondValid) return isContinuation(bytes.charCodeAt(start + 1)) ? 2 : 1;
  if (length !== 4 || !(secondValid || (lead >= 0xf1 && lead <= 0xf3))) return 0;
  let count = 0;
  while (isContinuation(bytes.charCodeAt(start + count))) count++;
  return count;
}

const byteCodec = (name: string, max: number): Codec => ({
  name,
  decode: (bytes) => {
    const codes: number[] = [];
    for (let index = 0; index < bytes.length; index++) {
      if ((index & 127) === 0) rt().spend(2);
      const byte = bytes.charCodeAt(index);
      codes.push(byte < max ? byte : BAD);
    }
    return codes;
  },
  encode: (code) => (code >= 0 && code < max ? String.fromCharCode(code) : undefined),
});
const UTF8: Codec = {
  name: 'UTF-8',
  decode: decodeUtf8,
  encode: (code) =>
    code < 0 || code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff) ? undefined : codePointBytes(code),
};
const utf16Codec = (name: string, littleEndian?: boolean): Codec => ({
  name,
  decode: (bytes) => decodeUtf16(bytes, littleEndian),
  encode: (code) => (code < 0 || code > 0x10_ff_ff ? undefined : utf16Units(code, littleEndian === true)),
});
const utf32Codec = (name: string, littleEndian?: boolean): Codec => ({
  name,
  decode: (bytes) => decodeUtf32(bytes, littleEndian),
  encode: (code) => (code < 0 || code > 0x10_ff_ff ? undefined : wordBytes(code, 4, littleEndian === true)),
});

/** The encodings `mb_convert_encoding` and its kin convert between here, by their lowercased names and aliases. */
const CODECS = new Map<string, Codec>();
for (const [codec, aliases] of [
  [UTF8, 'utf8'],
  [
    byteCodec('ASCII', 0x80),
    'ANSI_X3.4-1968 iso-ir-6 ANSI_X3.4-1986 ISO_646.irv:1991 US-ASCII ISO646-US us IBM367 IBM-367 cp367 csASCII',
  ],
  [byteCodec('ISO-8859-1', 0x1_00), 'ISO8859-1 latin1'],
  [utf16Codec('UTF-16'), 'utf16'],
  [utf16Codec('UTF-16BE', false), ''],
  [utf16Codec('UTF-16LE', true), ''],
  [utf32Codec('UTF-32'), 'utf32'],
  [utf32Codec('UTF-32BE', false), ''],
  [utf32Codec('UTF-32LE', true), ''],
] as const) {
  for (const name of [codec.name, ...aliases.split(' ').filter(Boolean)]) CODECS.set(lower(name), codec);
}

function utf16Units(code: number, littleEndian: boolean): string {
  const units = code < 0x1_00_00 ? [code] : [((code - 0x1_00_00) >> 10) | 0xd8_00, (code & 0x3_ff) | 0xdc_00];
  return units.map((unit) => wordBytes(unit, 2, littleEndian)).join('');
}

function wordBytes(word: number, size: number, littleEndian: boolean): string {
  const bytes = Array.from({ length: size }, (_, index) =>
    String.fromCharCode((word >>> (8 * (size - 1 - index))) & 0xff)
  );
  return (littleEndian ? bytes.toReversed() : bytes).join('');
}

/** Decodes UTF-16 as mb_utf16_to_wchar does; without a byte order, a BOM decides it, and big-endian is the default. */
// code-gauge-allow functionNcss 38 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionCognitiveComplexity 25 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function decodeUtf16(bytes: string, littleEndian: boolean | undefined): number[] {
  let index = 0;
  let little = littleEndian ?? false;
  if (littleEndian === undefined && bytes.length >= 2) {
    const bom = (bytes.charCodeAt(0) << 8) | bytes.charCodeAt(1);
    if (bom === 0xff_fe || bom === 0xfe_ff) index = 2;
    little = bom === 0xff_fe;
  }
  const word = (at: number): number =>
    little
      ? bytes.charCodeAt(at) | (bytes.charCodeAt(at + 1) << 8)
      : (bytes.charCodeAt(at) << 8) | bytes.charCodeAt(at + 1);
  const end = index + ((bytes.length - index) & ~1);
  const codes: number[] = [];
  for (let chunk = 0; index < end; chunk++) {
    if ((chunk & 127) === 0) rt().spend(2);
    const unit = word(index);
    index += 2;
    if (unit >= 0xdc_00 && unit <= 0xdf_ff) codes.push(BAD);
    else if (unit < 0xd8_00 || unit > 0xdb_ff) codes.push(unit);
    else if (index >= end) codes.push(BAD);
    else {
      const next = word(index);
      index += 2;
      if (next >= 0xdc_00 && next <= 0xdf_ff) codes.push((((unit & 0x3_ff) << 10) | (next & 0x3_ff)) + 0x1_00_00);
      else if (next >= 0xd8_00 && next <= 0xdb_ff) {
        codes.push(BAD);
        index -= 2;
      } else codes.push(BAD, next);
    }
  }
  if (index < bytes.length) codes.push(BAD);
  return codes;
}

/** Decodes UTF-32 as mb_utf32_to_wchar does, which reads a BOM like UTF-16 and takes 1–3 trailing bytes as one error. */
function decodeUtf32(bytes: string, littleEndian: boolean | undefined): number[] {
  let index = 0;
  let little = littleEndian ?? false;
  const word = (at: number, inLittle: boolean): number => {
    const units = [0, 1, 2, 3].map((offset) => bytes.charCodeAt(at + offset));
    return (inLittle ? units.toReversed() : units).reduce((value, byte) => value * 256 + byte, 0);
  };
  if (littleEndian === undefined && bytes.length >= 4) {
    const bom = word(0, false);
    if (bom === 0xff_fe_00_00 || bom === 0xfe_ff) index = 4;
    little = bom === 0xff_fe_00_00;
  }
  const codes: number[] = [];
  for (; index + 4 <= bytes.length; index += 4) {
    if ((codes.length & 127) === 0) rt().spend(2);
    const code = word(index, little);
    codes.push(code < 0x11_00_00 && (code < 0xd8_00 || code > 0xdf_ff) ? code : BAD);
  }
  if (index < bytes.length) codes.push(BAD);
  return codes;
}

/** How mbstring writes what an encoding cannot hold: `mb_substitute_character()` sets it for each run. */
interface Substitution {
  mode: 'char' | 'none' | 'long' | 'entity';
  char: number;
  /** How many conversion errors `mb_convert_encoding` and `mb_scrub` met, which `mb_check_encoding()` reads. */
  errors: number;
}

const substitutions = new WeakMap<object, Substitution>();

function substitution(): Substitution {
  const current = substitutions.get(rt()) ?? { mode: 'char', char: 0x3f, errors: 0 };
  substitutions.set(rt(), current);
  return current;
}

/** Encodes code points, writing each one the encoding cannot hold as mb_illegal_output does; `tally` counts those. */
function encodeCodes(codes: number[], codec: Codec, tally?: { errors: number }): string {
  let result = '';
  for (const code of codes) {
    const encoded = (code === BAD ? undefined : codec.encode(code)) ?? illegalOutput(code, codec, tally);
    rt().ensureStringFits(result.length + encoded.length);
    result += encoded;
  }
  return result;
}

/** The substitute for a code point an encoding cannot hold, or for invalid input, as `mb_substitute_character()` sets it. */
function illegalOutput(code: number, codec: Codec, tally: { errors: number } | undefined): string {
  const { mode, char } = substitution();
  if (tally) tally.errors++;
  if (mode === 'none') return '';
  const hex = code.toString(16).toUpperCase();
  const marker =
    code === BAD || mode === 'char' ? String.fromCodePoint(char) : mode === 'long' ? `U+${hex}` : `&#x${hex};`;
  let result = '';
  for (const markerChar of marker) {
    const bytes = codec.encode(markerChar.codePointAt(0) as number);
    if (bytes !== undefined) result += bytes;
    else if (mode === 'char' && char !== 0x3f) {
      // mbstring retries a substitute character the encoding cannot hold with `?`, which counts as another error.
      if (tally) tally.errors++;
      result += codec.encode(0x3f) ?? '';
    }
  }
  return result;
}

defineFunction('mb_substitute_character(string|int|null $substitute_character = null): string|int|bool', ({ args }) => {
  const current = substitution();
  const value = args[0];
  if (value === undefined || value === null) return current.mode === 'char' ? BigInt(current.char) : current.mode;
  if (typeof value === 'string') {
    const mode = lower(value);
    if (mode !== 'none' && mode !== 'long' && mode !== 'entity') {
      throwError(
        'ValueError',
        'mb_substitute_character(): Argument #1 ($substitute_character) must be "none", "long", "entity" or a valid codepoint'
      );
    }
    current.mode = mode;
    return true;
  }
  const code = Number(value as bigint);
  if (code < 0 || code >= 0x11_00_00 || (code >= 0xd8_00 && code <= 0xdf_ff)) {
    throwError('ValueError', 'mb_substitute_character(): Argument #1 ($substitute_character) is not a valid codepoint');
  }
  current.mode = 'char';
  current.char = code;
  return true;
});

/** The codec of an encoding name that mbstring knows, which stops the program for an encoding this grader lacks. */
function codecFor(name: string, functionName: string): Codec {
  const codec = CODECS.get(lower(name));
  if (!codec) throw new UnsupportedFeatureError(`文字コード ${name} の変換（${functionName}）`);
  return codec;
}

/** The codec of an `$encoding` argument, which is UTF-8 when it is null. */
function encodingArgument(args: Value[], position: number, functionName: string): Codec {
  checkEncoding(functionName, args, position);
  const name = args[position - 1];
  return codecFor(typeof name === 'string' ? name : rt().mbEncoding, functionName);
}

defineFunction('mb_scrub(string $string, ?string $encoding = null): string', ({ args }) => {
  const codec = encodingArgument(args, 2, 'mb_scrub');
  return encodeCodes(codec.decode(s(args[0])), codec, substitution());
});
defineFunction('mb_check_encoding(array|string|null $value = null, ?string $encoding = null): bool', ({ args }) => {
  const codec = encodingArgument(args, 2, 'mb_check_encoding');
  const value = args[0];
  if (value === undefined || value === null) {
    deprecated('mb_check_encoding(): Calling mb_check_encoding() without argument is deprecated');
    return substitution().errors === 0;
  }
  return checkValue(value, codec, new Set());
});

function checkValue(value: Value, codec: Codec, visiting: Set<PhpArray>): boolean {
  rt().spend();
  if (typeof value === 'string') return !codec.decode(value).includes(BAD);
  if (!(value instanceof PhpArray)) return value === null || typeof value !== 'object';
  if (visiting.has(value)) {
    warn('mb_check_encoding(): Cannot not handle circular references');
    return false;
  }
  visiting.add(value);
  for (const [key, item] of value.entries()) {
    if ((typeof key === 'string' && !checkValue(key, codec, visiting)) || !checkValue(item, codec, visiting)) {
      visiting.delete(value);
      return false;
    }
  }
  visiting.delete(value);
  return true;
}

defineFunction(
  'mb_convert_encoding(array|string $string, string $to_encoding, array|string|null $from_encoding = null): array|string|false',
  ({ args }) => {
    checkEncoding('mb_convert_encoding', args, 2, 'to_encoding');
    const to = codecFor(s(args[1]), 'mb_convert_encoding');
    const from =
      args[2] === undefined || args[2] === null
        ? [rt().mbEncoding]
        : encodingList(args[2], 'mb_convert_encoding', 3, 'from_encoding', false);
    const convert = (text: string): string => {
      const name = from.length === 1 ? from[0] : guessEncoding(text, from.map(encodingReader), false)?.name;
      const source = codecFor(name ?? from[0], 'mb_convert_encoding');
      return encodeCodes(source.decode(text), to, substitution());
    };
    const input = args[0];
    return input instanceof PhpArray ? convertArray(input, convert, new Set()) : convert(s(input));
  }
);

/** Converts the string keys and values of an array as php_mb_convert_encoding_recursive does. */
function convertArray(array: PhpArray, convert: (text: string) => string, visiting: Set<PhpArray>): Value {
  if (visiting.has(array)) {
    warn('mb_convert_encoding(): Cannot convert recursively referenced values');
    return null;
  }
  visiting.add(array);
  const result = new PhpArray();
  for (const [key, value] of array.entries()) {
    let converted: Value;
    if (typeof value === 'string') converted = convert(value);
    else if (value instanceof PhpArray) converted = convertArray(value, convert, visiting) ?? new PhpArray();
    else if (value !== null && typeof value === 'object') {
      warn('mb_convert_encoding(): Object is not supported');
      continue;
    } else converted = value;
    result.set(typeof key === 'string' ? convert(key) : key, converted);
  }
  visiting.delete(array);
  return result;
}

/** The byte encodings that mbstring drops from a list of candidate text encodings. */
const NON_ENCODINGS = new Set(
  lower('BASE64 UUENCODE x-uuencode HTML-ENTITIES HTML Quoted-Printable qprint 7bit 8bit binary').split(' ')
);

/** Resolves encoding lists before selecting a reader or a conversion codec. */
// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function encodingList(
  value: Value,
  functionName: string,
  position: number,
  parameter: string,
  removesNonEncodings: boolean
): string[] {
  const isArray = value instanceof PhpArray;
  const parts =
    !isArray && s(value) !== ''
      ? s(value)
          .replace(/^"(.+)"$/s, '$1')
          .split(',')
      : [];
  const input = isArray ? value.iterValues() : parts;
  const inputSize = isArray ? value.size : parts.length;
  const names: string[] = [];
  let includedAuto = false;
  for (const item of input) {
    rt().spend();
    const name = isArray ? toStr(item) : s(item).replaceAll(/^[ \t]+|[ \t]+$/g, '');
    if (lower(name) === 'auto') {
      if (!includedAuto) names.push(...DETECT_ORDER);
      includedAuto = true;
    } else if (name === '' && !isArray) {
      // mbstring's lookup by name and length finds ASCII for an empty name in a comma-separated list.
      names.push('ASCII');
    } else if (NON_ENCODINGS.has(lower(name)) && (removesNonEncodings || inputSize > 1)) continue;
    else {
      const canonical = encodingNames.get(lower(name));
      if (canonical) {
        names.push(canonical);
        continue;
      }
      throwError(
        'ValueError',
        `${functionName}(): Argument #${position} ($${parameter}) contains invalid encoding "${name}"`
      );
    }
  }
  if (inputSize === 0 || (names.length === 0 && !removesNonEncodings)) {
    throwError(
      'ValueError',
      `${functionName}(): Argument #${position} ($${parameter}) must specify at least one encoding`
    );
  }
  return names;
}

/** The default order of `mb_detect_encoding`, which `auto` also names, for mbstring's neutral language. */
const DETECT_ORDER = ['ASCII', 'UTF-8'];

defineFunction(
  'mb_detect_encoding(string $string, array|string|null $encodings = null, bool $strict = false): string|false',
  ({ args }) => {
    const text = s(args[0]);
    const candidates =
      args[1] === undefined || args[1] === null
        ? DETECT_ORDER
        : encodingList(args[1], 'mb_detect_encoding', 2, 'encodings', true);
    if (candidates.length === 0) return false;
    const strict = args[2] === true;
    if (!strict && candidates.length === 1) return candidates[0];
    if (candidates.length === 1 && candidates[0] === 'UTF-8' && !decodeUtf8(text).includes(BAD)) return 'UTF-8';
    return guessEncoding(text, candidates.map(encodingReader), strict)?.name ?? false;
  }
);

type EncodingReader = Pick<Codec, 'name' | 'decode'> & { validate?: (bytes: string) => boolean };
const detectionReaders = new Map<string, EncodingReader>();

function encodingReader(name: string): EncodingReader {
  const codec = CODECS.get(lower(name));
  if (codec) return codec;
  let reader = detectionReaders.get(name);
  if (!reader) {
    const special = extraEncodingReader(name, decodeUtf8, (bytes) => decodeUtf16(bytes, false));
    const decoder = special ? undefined : legacyTextDecoder(name);
    if (!special && !decoder) throw new UnsupportedFeatureError(`文字コード ${name} の判定（mb_detect_encoding）`);
    reader = {
      name,
      decode: special ?? ((text) => decodeLegacy(text, decoder!)),
      validate: encodingValidator(name, (bytes) => decodeUtf16(bytes, false)),
    };
    detectionReaders.set(name, reader);
  }
  return reader;
}

function legacyTextDecoder(name: string): TextDecoder | undefined {
  let label = name;
  if (/^(?:SJIS|CP932)/.test(name)) label = 'shift_jis';
  else if (/^(?:EUC-JP|eucJP|CP51932)/.test(name)) label = 'euc-jp';
  else if (/^(?:ISO-2022-JP|JIS|CP5022)/.test(name)) label = 'iso-2022-jp';
  else if (name === 'BIG-5' || name === 'CP950') label = 'big5';
  else if (name === 'EUC-CN' || name === 'CP936') label = 'gbk';
  else if (name === 'UHC') label = 'euc-kr';
  try {
    return new TextDecoder(label, { ignoreBOM: true });
  } catch {
    return undefined;
  }
}

function decodeLegacy(text: string, decoder: TextDecoder): number[] {
  rt().spend(Math.ceil(text.length / 64));
  return Array.from(decoder.decode(Buffer.from(text, 'latin1')), (char) =>
    char === '\uFFFD' ? BAD : (char.codePointAt(0) as number)
  );
}

/**
 * Picks the encoding that reads a string with the fewest demerits as mb_guess_encoding_for_strings does: invalid input
 * costs 1000 (or rules a candidate out when strict), and a rare code point costs more than a common one.
 */
// code-gauge-allow functionCognitiveComplexity 22 -- Maintains candidate weighting, validation and strict rejection in one pass.
function guessEncoding(text: string, candidates: EncodingReader[], strict: boolean): EncodingReader | undefined {
  if (candidates.length === 1) {
    const [codec] = candidates;
    const valid = !strict || (codec.validate?.(text) ?? !codec.decode(text).includes(BAD));
    return valid ? codec : undefined;
  }
  if (text === '') return candidates[0];
  let best: { codec: EncodingReader; demerits: number } | undefined;
  for (const [index, codec] of candidates.entries()) {
    rt().spend();
    const invalid = codec.validate?.(text) === false;
    if (strict && invalid) continue;
    const codes = codec.decode(withoutBom(text, codec));
    if (strict && codes.includes(BAD)) continue;
    const multiplier = 1 + (0.3 * index) / candidates.length;
    let score = invalid ? 500 : 0;
    for (let code = 0; code < codes.length; code++) {
      if ((code & 127) === 0) rt().spend(2);
      score += codeDemerits(codes[code]);
    }
    const demerits = Math.floor(score * Math.fround(multiplier));
    if (!best || demerits < best.demerits) best = { codec, demerits };
  }
  return best?.codec;
}

function withoutBom(text: string, codec: EncodingReader): string {
  const bom = { 'UTF-8': 'ï»¿', 'UTF-16BE': 'þÿ', 'UTF-16LE': 'ÿþ' }[codec.name];
  return bom !== undefined && text.startsWith(bom) ? text.slice(bom.length) : text;
}

/**
 * One bit for each code point up to U+FFFF that mbstring's rare_cp_bitvec.h marks as rare, as that table's
 * little-endian 32-bit words compressed with raw DEFLATE.
 */
const RARE_CODE_POINTS = inflateRawSync(
  Buffer.from(
    [
      '7Vl9cFvVlbdn0y3slppAdkNJjNm0fLQkuCUU2rqJdnbZmJaC2AkhLdlEDWkJTewobEgUW5YutG7pbgYMi7chdRIxmy8gxGJxHBEr0h02Jk6InZ',
      'esP0QsS48Q2yKW9G4dW3qW7rv37HmSnMDSP8pMme3s+MzYmvvePef+zjm/c87TE5wFKLosTwFK8Y2XL1xVoq8H3YCVUWN9593G0/AppWjiY6s/',
      'K7m1qGha0R8un7RYXLiBf5vfh0+v/ynx/5Ht/bGlEI3N+Cc/C/ufdXyn5P9Y9KeK3iLng5fybeA/BuL3M+GTjADgnyk8OZWhz1Qms1p8eQSc+2',
      'R9F/+vCTHVP6ZkSv4U5Mnn64uu7B55PjRtzuwjME79Xzkx58r6sHP2tZ8zOvZ/Z6mYVXfda87md31lPSvT1SH7vodpaMbtHnLe6b7BmN3bRpdc',
      '2LznDLxK5qlxFUpsUVUYeudin2qLcJuqpkYEdwvO19a3fxhfVj+tfefxZUPv2q/Rm+8RHa/bDj54Z7bm9Kk3Fp7e8IsDocqafuJ4T8wc/925BU',
      'tS4RlrIXzHdlkmxivEN578VvHIrY57Nm0ZUmubdo45xp6a9+TPi77eueeKh2YunPbL3W9OrBjmsvdY8y3/mrGsGY3O3V5jK32JnywXGqwrd9F9',
      'Tt1yVRy0R0fZcbJrfqiM7lq7x62rwe3lm2DBKw6gDtb/uNcglhDo0s44Fy0Xw+83+R5ucTuiaX/trLprX3cSOK9zaPHh2PMxIsGd+S1EIOnsBC',
      'Ne3cZTaiDEHfPgiE5d8d6F7JtvhO3LPWtrX6h+a+2dX+CPtO0b+HK2ZYcahFZ65idxzzA4loD+WJQcYFQA94dLCM5DHIhjaibphVYBOgyZVySO',
      'sQfu3ZeKRpf8hBS93PKr0r9kF2d+affOG7969YF+O6u+4qWrI97jduHKQNWY6NLNsSeORIMhQst1hKhCDC8JczTnJK6qcc/0gyt9L2g7/6ts5l',
      '3RKFPIqL6r6Cbnoq9aQmVydMK37CK72/m+c9GmG1zLX4XmxZ6mt+uGOj9Yf0QcXh3Zaq1I1OkR23t0izK7FsMR6s8cvfc3q5SI13no8S3D6lhk',
      'zXen7R4Vdeqq1TohbG8ku+HQQuAtCW4f9FPnRBYozPqa/Iu3amnFnE11jW+nHZ87OE/LTP+PE8OR+2fVz/nbq3/w05IaEfjH9n+GWU2l0fIngp',
      'ax4aq28QcnNnC5vG0stY2F37Pd7AWF+m/jcTdxwfgGeZoqv+y//Xsvxv1B9uGuIIl3Hl1F71TXlTa2sO/LDXseqrbe7+6KOAhc37mAV9wWIytW',
      'gHfspy+Gvd9t9v/MWAAVhxhYBO0Ksg/mpnusSy1/1xV+c8GR8oEVhiUpVpy8uNgCjAwz1f6Ow7rpmyAypPNFbdD+okFJBBy2ihV9oPUuq3XTs1',
      'z1cAYqxp7H/DJqU/ZLTEGQ6RCSaWSRmuF6IJWJTOCVuowu8HlFA9TQddRQcQPjFH4MvIkk06S45vygb5RKQe5btX3m36eEAzPpvskx/y673Cxs',
      '1yZ427bRxJsbv9SiT0teUH1nsn0dQnf6VO5/5qr5oxfoYbsMv65uvKkurDXHAtlky5JR2/OP9e6+P94WC9M0ELD0iaAS3kC5NdbV1FUVX3jYFY',
      'OL50YXuiD5mNcjoTlIWBJSMA5hN3MIP90YWYweUWARqS/dWQKHmwR8Xj+eccOT5R3IPKFOBNBhOAAHrAFQmTPuAiYCugy7PCp4qSp1OFn6kkWD',
      'jTUifNZA9tfaqRiRtQHjWdEJ1FcJ/+m1KJRgXfan7Smhw8bsWDYsIKoC3eqSup8/g7RW/yaWCVJHSlIHSBWcwFqoxeT7mu6eBy+q9mRXeGxYWi',
      'pcmaG7wwdsmZPjnGsCQjp5dRSCnPlJ2Jf5xW3pVg5UOD3fufXm1RXxZjEIRNZZXjOIsa81BqUK5RbbhfRqAHK++698JKM0YBJGglFQVdiHJfas',
      'y03E+P7IWJSDm3BBQVAd9hsGLYuuILWdZQAWv5g+3ptxl7tkX3QrONP0ico2LH2eKq8ZUr/xgOfb4LSO0Xl9NlrjSydTQQ3idMkrIQBbwL3UAS',
      'IkYB3WcjLgAoIOunS4QVdASKaHIOXcZPVHAsA987CZHDrVvW50syOd2c+i9HDwBSGIfiGrXrgGNmR+m65ielJi7fpcnlau+MW2dBe3Uva1tdN/',
      '+PnrzxQtnr7ogecCz/Rr25r7Af6JZw4/ApHXmD8peCTijbulkEONygr03/ew/7y3DZxzymYO0f8+/u14xUEv3X8/7O5v2nyQgyN1BFraweNLf1',
      '064ag09GVtEd2t98f0sl+vLYf4bIFYsXrW+7nOu6g1NUBs1Xd7iBBHqVlqTcahzIjc6EBvD1OsipqzrrjOALtdbAuoJRqoFB1rjUWA65DE0tFY',
      'Slep12x1G3mvYlP0DFZUmFE7MJ2uxMvLo6oiIGUZw0Cq4AZL55eJDjsmcIqZ4u6GjYxCa1YuQ5IQQgI2EQSv7EbOIUV5EOcAMN6qojKHgL5TWX',
      '2md9gtukJ+Bpifs06lMwmxASdkOdYfgkUCOzlZ4PBxwh3hXxsZwDEis21LHw6F98QBTvne+PffJW1doWD9u9lqovtjlq0b2z7023sNDQLgghFq',
      'X6NKdPDEdXdcUf/D5c9f/Q/3/lvPNadX7uqshkCb5Jnz2OGZ7tn841sWPZrV9718kp1UH/HNLC76wY3nbtn75sv6FyEyprp0GaOxmFicrF3K4W',
      'fSwzNdEP9ACK/Cna5lAJFVOHGOIkyA3+jiaAhq4K6GHUAsc0cqnzFmfMU3Y+JfvhdMTGvqdg+88aNHp1+kZ/f+6NpFB/p2LPv+oDMFLRWRceEX',
      'qojaVC64IGb/eyeudu8vdZMU90IMZF1R3SkdYwc7FCwPRjUgGNEk9EFAA8UhSjGqLKxrzAzRzYgExzImigKqY7cxv9i5M5Nf8WhYMsCVnrXChK',
      'P0ukCvr4dKhXv8bZ3DMvO0RdXdsIMBWUjSqSHZbWRSEPdo4vr7Tg8EEtXgf9rxxWPR0NsTf93vmX9qcFN23qEvWHfsGau9w3f7Np8XK9Pg0n9g',
      'QuwDdSlIaVIkpjNLcqvjhZH1WlKVg7REOUQcpcVXHr/zXU2aHsFd3MYbQhfSWJiIXOdUbbhurSftF/DcEDwL/SFQkfbUJKCbRsG2IVyy+6bb7C',
      '7e5SaaQmLSJBpFt5eBYCcI49ifITfETf8zk19ucYyouFHkbjKhAmMSZEyhVBUxc7tOJeCkwHygiZwNs2lcMgbzG216WagGwAt9ywEcxAPQEbNc',
      'aMSqwLN08xgfjGWRhJywPpmZemr+05Eqo+htzWoYMoRZhypZf06zG4/L9iQjULWmUdEYPgCrimY3Saj8yppJSGZmX5NpppnqPeaqSjZu0awDCd',
      'mh5M02oE3UY5JETT3NOmqgFeSLBlFTIeFuRDO4hTGzRJF4I5URyO0UjxvT3kH1hIyalgYvtnfkVp2aqZftOS9zvDX1DKkqw1ZEVoCE0JhITGyP',
      'mztlz5Y/r3wiIdsLj6wNj1lb8SKixmNB2ftAr2Y+S4HU5DjLK5grEwsjQkqp7LXmnB62TqCVGMalELNEusNcFV4NJaTK8rVUOEhh+uTrK03mdK',
      'rwBE3BVRT9+xYaUyQReW/r8FglFyxh+q5N6knEKQqQcjvNg0z1QCFKc41GjNJEvpngvcZ8lCpNEIM5vVw9YxpRteGYdbkmU3nTudBp5uOjieye',
      'ZxdZIwipK28Ivc1UIUDNNiBzaSxEF6Nk5Bhi9CQL3rIcTiUPWWm2jiayxzpycZF508dwhzCwJZvHwsDH3qohpdhHLrDLwUpAyPqcyaV2JXc6NN',
      'xsPWKmEU0jeIQUMZmVs6mbW6rkQxdyAKPMVJB9yilrLrrDlYFB2dmBFDZHdC5KXUy79F6vSkYmEydzHDTJXkhjfpdIuI0CNZRXKrebkNZhIHFn',
      'e8kreLHh9pLZmhxWnluUMqkvkXxmQKwil1QF0yHyq4cU7b5iM1inKt+aK+vNhDeb1WESutEsLk2eyh80IwZIPrxn5siM0iV6J0xOMPzIBbIq23',
      'hiDSYcJumN5xXA5/lCUsYlLuVckQPsY681GdgLejWv5yFpk1xqz0GaPLavEDOWt/0RSBJS+CkKlZowevLeXoI0bDISK84qC3r5WsEcwWTFaeZ0',
      'M/sLmBWHPhTonTAm038JkjUHSeb04pM+kDwk++UmoJpNoCo7nt850NCc59JklOx5SIpxSS8fJZMFBNPRx/JTzVSXJqUUmIQUzVWqnOTSR73FVZ',
      'dGkOzISJLrGlq1yFcHbsHqR0jGQBKN4Wpq6kzJlEzJ/5NfcIw/4Pfh3/ubi9lH/wc=',
    ].join(''),
    'base64'
  )
);

function codeDemerits(code: number): number {
  if (code === BAD) return 1000;
  if (code > 0xff_ff) return 40;
  if (code >= 0x21 && code <= 0x2f) return 6;
  return (RARE_CODE_POINTS[code >> 3] >> (code & 7)) & 1 ? 30 : 1;
}

// Japanese kana and width conversion ---------------------------------------------------------------------------------

const KANA_HAN2ZEN_KATAKANA = 0x10;

const KANA_GLUE = 0x1_00_00;

defineFunction('mb_convert_kana(string $string, string $mode = "KV", ?string $encoding = null): string', ({ args }) => {
  const mode = args[1] === undefined ? KANA_HAN2ZEN_KATAKANA | KANA_GLUE : kanaMode(s(args[1]));
  const codec = encodingArgument(args, 3, 'mb_convert_kana');
  const codes = codec.decode(s(args[0]));
  const converted: number[] = [];
  for (let index = 0; index < codes.length; index++) {
    const [code, consumed, second] = convertKana(codes[index], codes[index + 1] ?? 0, mode);
    converted.push(code);
    if (second !== undefined) converted.push(second);
    if (consumed) index++;
  }
  return encodeCodes(converted, codec);
});

/** The mode letters of `mb_convert_kana` by their bit, from bit 0; `A` and `a` also set the bits of `R` and `N`. */
const KANA_FLAGS = 'ARNSKHMCarnskhmcV';
const KANA_HAN2ZEN_ALL = 0x1;
const KANA_HAN2ZEN_HIRAGANA = 0x20;
const KANA_HIRA2KATA = 0x80;
const KANA_ZEN2HAN_ALL = 0x1_00;
const KANA_ZEN2HAN_KATAKANA = 0x10_00;
const KANA_ZEN2HAN_HIRAGANA = 0x20_00;
const KANA_KATA2HIRA = 0x80_00;
/** Reads the mode letters as PHP_FUNCTION(mb_convert_kana) does, refusing pairs of conversions that undo each other. */
// code-gauge-allow functionCognitiveComplexity 29 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function kanaMode(letters: string): number {
  let mode = 0;
  for (const letter of letters) {
    const bit = KANA_FLAGS.indexOf(letter);
    if (bit === -1)
      throwError('ValueError', `mb_convert_kana(): Argument #2 ($mode) contains invalid flag: '${letter}'`);
    mode |= 1 << bit;
    if (letter === 'A' || letter === 'a') mode |= (letter === 'A' ? 0x6 : 0x6_00) | (1 << bit);
  }
  let clash = ((mode & 0xff_00) >> 8) & mode;
  if (clash) {
    let bit = 0;
    while ((clash & 1) === 0) {
      clash >>= 1;
      bit++;
    }
    let first = KANA_FLAGS[bit];
    let second = KANA_FLAGS[bit + 8];
    if ((first === 'R' || first === 'N') && mode & KANA_HAN2ZEN_ALL) first = 'A';
    if ((second === 'r' || second === 'n') && mode & KANA_ZEN2HAN_ALL) second = 'a';
    kanaFlagClash(first, second);
  }
  if (mode & KANA_HAN2ZEN_HIRAGANA && mode & KANA_HAN2ZEN_KATAKANA) kanaFlagClash('H', 'K');
  const toHalf = mode & KANA_ZEN2HAN_HIRAGANA ? 'h' : mode & KANA_ZEN2HAN_KATAKANA ? 'k' : undefined;
  if (toHalf && mode & KANA_HIRA2KATA) kanaFlagClash(toHalf, 'C');
  if (toHalf && mode & KANA_KATA2HIRA) kanaFlagClash(toHalf, 'c');
  return mode;
}

function kanaFlagClash(first: string, second: string): never {
  throwError('ValueError', `mb_convert_kana(): Argument #2 ($mode) must not combine '${first}' and '${second}' flags`);
}

/**
 * Converts one code point as mb_convert_kana_codepoint does, returning the result, whether it took `next` too (to join
 * a halfwidth voiced sound mark), and a second code point (for a halfwidth kana with its sound mark). The conversions
 * apply in mb_convert_kana_codepoint's order, and the first that applies decides.
 */
function convertKana(code: number, next: number, mode: number): [number, boolean, number?] {
  const halfwidthKana = halfToFull(code, next, mode);
  if (halfwidthKana) return halfwidthKana;
  for (const convert of [symbolToFull, fullToHalf, kanaToHalf, swapKana, symbolToHalf]) {
    const converted = convert(code, mode);
    if (converted) return [converted[0], false, converted[1]];
  }
  return [code, false];
}

const SYMBOLS_TO_FULL = new Map([
  [0x5c, 0xff_e5],
  [0xa5, 0xff_e5],
  [0x7e, 0xff_e3],
  [0x20_3e, 0xff_e3],
  [0x27, 0x20_19],
  [0x22, 0x20_1d],
]);

function symbolToFull(code: number, mode: number): [number] | undefined {
  if (!(mode & 0x40)) return undefined;
  const symbol = SYMBOLS_TO_FULL.get(code);
  return symbol === undefined ? undefined : [symbol];
}

function fullToHalf(code: number, mode: number): [number] | undefined {
  const all = (mode & KANA_ZEN2HAN_ALL) !== 0;
  if (all && code >= 0xff_01 && code <= 0xff_5d && code !== 0xff_02 && code !== 0xff_07 && code !== 0xff_3c) {
    return [code - 0xfe_e0];
  }
  const letter = (code >= 0xff_21 && code <= 0xff_3a) || (code >= 0xff_41 && code <= 0xff_5a);
  if ((mode & 0x2_00 && letter) || (mode & 0x4_00 && code >= 0xff_10 && code <= 0xff_19)) return [code - 0xfe_e0];
  if (mode & 0x8_00 && code === 0x30_00) return [0x20];
  return all && code === 0x22_12 ? [0x2d] : undefined;
}

const ZEN_SYMBOLS_TO_HAN = new Map([
  [0x30_01, 0xff_64],
  [0x30_02, 0xff_61],
  [0x30_0c, 0xff_62],
  [0x30_0d, 0xff_63],
  [0x30_9b, 0xff_9e],
  [0x30_9c, 0xff_9f],
  [0x30_fc, 0xff_70],
  [0x30_fb, 0xff_65],
]);

const ZEN_TO_HAN_BYTES = Buffer.from(
  '6700710068007200690073006a0074006b0075007600769e7700779e7800789e7900799e7a007a9e7b007b9e7c007c9e7d007d9e7e007e9e7f007f9e8000809e8100819e6f008200829e8300839e8400849e850086008700880089008a008a9e8a9f8b008b9e8b9f8c008c9e8c9f8d008d9e8d9f8e008e9e8e9f8f0090009100920093006c0094006d0095006e0096009700980099009a009b009c009c007200740066009d00739e',
  'hex'
);

const ZEN_TO_HAN = Array.from({ length: ZEN_TO_HAN_BYTES.length / 2 }, (_, index) => [
  ZEN_TO_HAN_BYTES[2 * index],
  ZEN_TO_HAN_BYTES[2 * index + 1],
]);

function kanaToHalf(code: number, mode: number): [number, number?] | undefined {
  if (!(mode & (KANA_ZEN2HAN_KATAKANA | KANA_ZEN2HAN_HIRAGANA))) return undefined;
  let kana: number | undefined;
  if (mode & KANA_ZEN2HAN_KATAKANA && code >= 0x30_a1 && code <= 0x30_f4) kana = code - 0x30_a1;
  else if (mode & KANA_ZEN2HAN_HIRAGANA && code >= 0x30_41 && code <= 0x30_93) kana = code - 0x30_41;
  if (kana !== undefined) {
    const [first, mark] = ZEN_TO_HAN[kana];
    return [0xff_00 + first, mark ? 0xff_00 + mark : undefined];
  }
  const symbol = ZEN_SYMBOLS_TO_HAN.get(code);
  return symbol === undefined ? undefined : [symbol];
}

function swapKana(code: number, mode: number): [number] | undefined {
  if (mode & KANA_HIRA2KATA && ((code >= 0x30_41 && code <= 0x30_93) || code === 0x30_9d || code === 0x30_9e)) {
    return [code + 0x60];
  }
  if (mode & KANA_KATA2HIRA && ((code >= 0x30_a1 && code <= 0x30_f3) || code === 0x30_fd || code === 0x30_fe)) {
    return [code - 0x60];
  }
  return undefined;
}

const SYMBOLS_TO_HALF = new Map([
  [0xff_e5, 0x5c],
  [0xff_3c, 0x5c],
  [0xff_e3, 0x7e],
  [0x20_3e, 0x7e],
  [0x20_18, 0x27],
  [0x20_19, 0x27],
  [0x20_1c, 0x22],
  [0x20_1d, 0x22],
]);

function symbolToHalf(code: number, mode: number): [number] | undefined {
  if (!(mode & 0x40_00)) return undefined;
  const symbol = SYMBOLS_TO_HALF.get(code);
  return symbol === undefined ? undefined : [symbol];
}

// The tables of PHP's mbfilter_cjk.c: the low byte of the fullwidth kana (from U+3000) for each halfwidth one from
// U+FF60, and the halfwidth kana and sound mark (from U+FF00, 0 for none) for each fullwidth one from U+30A1 or U+3041.
const HAN_TO_ZEN_KATAKANA = Buffer.from(
  '00020c0d01fbf2a1a3a5a7a9e3e5e7c3fca2a4a6a8aaabadafb1b3b5b7b9bbbdbfc1c4c6c8cacbcccdcecfd2d5d8dbdedfe0e1e2e4e6e8e9eaebecedeff39b9c',
  'hex'
);

const HAN_TO_ZEN_HIRAGANA = Buffer.from(
  '00020c0d01fb92414345474983858763fc424446484a4b4d4f51535557595b5d5f616466686a6b6c6d6e6f7275787b7e7f808182848688898a8b8c8d8f939b9c',
  'hex'
);

/** The halfwidth-to-fullwidth conversions of mb_convert_kana_codepoint, which come before the others. */
// code-gauge-allow functionCognitiveComplexity 29 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function halfToFull(code: number, next: number, mode: number): [number, boolean] | undefined {
  const ascii = code >= 0x21 && code <= 0x7d && code !== 0x22 && code !== 0x27 && code !== 0x5c;
  if (mode & KANA_HAN2ZEN_ALL && ascii) return [code + 0xfe_e0, false];
  if (mode & 0x2 && ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))) return [code + 0xfe_e0, false];
  if (mode & 0x4 && code >= 0x30 && code <= 0x39) return [code + 0xfe_e0, false];
  if (mode & 0x8 && code === 0x20) return [0x30_00, false];
  if (!(mode & (KANA_HAN2ZEN_KATAKANA | KANA_HAN2ZEN_HIRAGANA)) || code < 0xff_61 || code > 0xff_9f) return undefined;
  const katakana = (mode & KANA_HAN2ZEN_KATAKANA) !== 0;
  const table = katakana ? HAN_TO_ZEN_KATAKANA : HAN_TO_ZEN_HIRAGANA;
  const index = code - 0xff_60;
  if (mode & KANA_GLUE && next >= 0xff_61 && next <= 0xff_9f) {
    const voiced = (index >= 22 && index <= 36) || (index >= 42 && index <= 46);
    if (next === 0xff_9e && voiced) return [0x30_01 + table[index], true];
    if (next === 0xff_9e && index === 19 && katakana) return [0x30_f4, true];
    if (next === 0xff_9f && index >= 42 && index <= 46) return [0x30_02 + table[index], true];
  }
  return [0x30_00 + table[index], false];
}

// code-gauge-allow functionCognitiveComplexity 25 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function defineUtf8Function(signature: string, impl: NativeFunction['impl']): void {
  const name = signature.slice(0, signature.indexOf('('));
  const parameters = signature.slice(signature.indexOf('(') + 1, signature.indexOf(')')).split(',');
  const position = parameters.findIndex((param) => param.includes('$encoding')) + 1;
  defineFunction(signature, (context) => {
    if (
      (name === 'mb_str_split' && Number(context.args[1] ?? 1n) < 1) ||
      (name === 'mb_substr_count' && context.args[1] === '') ||
      (name === 'mb_ord' && context.args[0] === '')
    )
      return impl(context);
    const codec = encodingArgument(context.args, position, name);
    if (codec === UTF8) return impl(context);
    const args = context.args.map((value, index) =>
      typeof value === 'string' && index !== position - 1 ? encodeCodes(codec.decode(value), UTF8) : value
    );
    args[position - 1] = 'UTF-8';
    const result = impl({ ...context, args });
    const convert = (value: Value): Value => {
      if (typeof value === 'string') return encodeCodes(UTF8.decode(value), codec);
      if (value instanceof PhpArray) {
        for (const [key, item] of value.entries()) value.set(key, convert(item));
      }
      return value;
    };
    return convert(result);
  });
}
