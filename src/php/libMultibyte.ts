// code-gauge-allow-file fileNcss -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/text-encoding-identifier-case -- mbstring names its encodings in this case.
// oxlint-disable typescript/no-misused-spread -- PHP splits strings into bytes or code points, never into grapheme clusters.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { eastAsianWidth } from 'get-east-asian-width';

import { codePointBytes, dec, enc, lower, stringToBytes } from './bytes';
import { deprecated, throwError, warn } from './errors';
import { type PaddingCharacters, padString } from './libString';
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

defineFunction('mb_strlen(string $string, ?string $encoding = null): int', ({ args }) => {
  const codec = encodingArgument(args, 2, 'mb_strlen');
  return BigInt(paddingCharacters(s(args[0]), codec).length);
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

// code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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

// code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
defineFunction(
  'mb_str_pad(string $string, int $length, string $pad_string = " ", int $pad_type = STR_PAD_RIGHT, ?string $encoding = null): string',
  ({ args }) => {
    const codec = encodingArgument(args, 5, 'mb_str_pad');
    return padString('mb_str_pad', args, (bytes) => paddingCharacters(bytes, codec));
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

// code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
  unitWidth?: number;
  decode: (bytes: string) => number[];
  /** The bytes of a code point, or undefined when the encoding cannot represent it. */
  encode: (code: number) => string | undefined;
}

function paddingCharacters(bytes: string, codec: Codec): PaddingCharacters {
  const width = codec.unitWidth;
  if (width)
    return {
      length: Math.floor(bytes.length / width),
      prefix: (count) => bytes.slice(0, count * width),
    };
  const codes = codec.decode(bytes);
  return {
    length: codes.length,
    prefix: (count) => encodeCodes(codes.slice(0, count), codec),
  };
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
  unitWidth: 1,
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
  unitWidth: 4,
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
// code-gauge-allow functionNcss -- Keeps pending high surrogates with byte-order and malformed-input checks.
// code-gauge-allow functionCognitiveComplexity -- Keeps pending high surrogates with byte-order and malformed-input checks.
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
// code-gauge-allow functionCognitiveComplexity -- Resolves supplied encoding names in order through one validation path.
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

type EncodingReader = Pick<Codec, 'name' | 'decode'>;
const detectionReaders = new Map<string, EncodingReader>();

/** The codecs that read mbstring's fixed-width Unicode encodings, by their keys in `CODECS`. */
const UNICODE_READERS: Record<string, string> = {
  'UCS-2': 'utf-16',
  'UCS-2BE': 'utf-16be',
  'UCS-2LE': 'utf-16le',
  'UCS-4': 'utf-32',
  'UCS-4BE': 'utf-32be',
  'UCS-4LE': 'utf-32le',
};

/** The WHATWG encodings whose host decoders read mbstring's encodings of other names. */
const DECODER_LABELS: Record<string, string> = {
  SJIS: 'shift_jis',
  'SJIS-win': 'shift_jis',
  CP932: 'shift_jis',
  'EUC-JP': 'euc-jp',
  'eucJP-win': 'euc-jp',
  CP51932: 'euc-jp',
  JIS: 'iso-2022-jp',
  'ISO-2022-JP': 'iso-2022-jp',
  'EUC-CN': 'gbk',
  CP936: 'gbk',
  GB18030: 'gb18030',
  'BIG-5': 'big5',
  CP950: 'big5',
  'EUC-KR': 'euc-kr',
  UHC: 'euc-kr',
};

function encodingReader(name: string): EncodingReader {
  const codec = CODECS.get(lower(name));
  if (codec) return codec;
  let reader = detectionReaders.get(name);
  if (!reader) {
    const unicode = CODECS.get(UNICODE_READERS[name]);
    const decoder = unicode ? undefined : legacyTextDecoder(DECODER_LABELS[name] ?? name);
    if (!unicode && !decoder) throw new UnsupportedFeatureError(`文字コード ${name} の判定（mb_detect_encoding）`);
    reader = { name, decode: unicode?.decode ?? ((text) => decodeLegacy(text, decoder as TextDecoder)) };
    detectionReaders.set(name, reader);
  }
  return reader;
}

function legacyTextDecoder(label: string): TextDecoder | undefined {
  try {
    const decoder = new TextDecoder(label, { ignoreBOM: true });
    // The host reads names that only look like one of its labels (such as UCS-2) as UTF-8 or UTF-16.
    return decoder.encoding.startsWith('utf-') ? undefined : decoder;
  } catch {
    return undefined;
  }
}

function decodeLegacy(text: string, decoder: TextDecoder): number[] {
  rt().spend(Math.ceil(text.length / 64));
  return Array.from(decoder.decode(stringToBytes(text)), (char) =>
    char === '\uFFFD' ? BAD : (char.codePointAt(0) as number)
  );
}

/**
 * Picks the encoding that reads a string with the fewest demerits as mb_guess_encoding_for_strings does: invalid input
 * costs 1000 (or rules a candidate out when strict), and a rare code point costs more than a common one.
 */
// code-gauge-allow functionCognitiveComplexity -- Maintains candidate weighting, validation and strict rejection in one pass.
function guessEncoding(text: string, candidates: EncodingReader[], strict: boolean): EncodingReader | undefined {
  if (candidates.length === 1) {
    const [codec] = candidates;
    return !strict || !codec.decode(text).includes(BAD) ? codec : undefined;
  }
  if (text === '') return candidates[0];
  let best: { codec: EncodingReader; demerits: number } | undefined;
  for (const [index, codec] of candidates.entries()) {
    rt().spend();
    const codes = codec.decode(withoutBom(text, codec));
    if (strict && codes.includes(BAD)) continue;
    const multiplier = 1 + (0.3 * index) / candidates.length;
    let score = 0;
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
 * little-endian 32-bit words in Base64.
 */
const RARE_CODE_POINTS = Uint8Array.from(
  atob(
    [
      '/9n//wAAAAAAAAAAAAAAgP////8BIAAAAAAAAAAAAAAND/dw//f8/2He/HDMN/yB////////////////////////////////////////////////',
      '////////////////APj///////////////8AAw8oAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////////',
      '/////////////wEAAAAAAAD/AAAAeOD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/////////////////////////////////////',
      '////////////////////////////////////////////////AAAAAAAAAAAAAAAAAAAAAP//////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '/////////////////////////////////////wEAAAAAAAB4AAAA/v//////////////////////////////////////////////////////////',
      '/////////////////////////////////////////////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '///////////////////////3gAC4f+O+//////////8A/P///+///f///////////////////////wAAAAD/////AAAAAAAAAAAAAAAAAAD///v/',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '///////////+////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////AAAAAP////8BAAAAAAAAAAAAgOEAAAAAAAAAAAAAAAD///////8BAAAAAAAAAAAAAID/////////////',
      '////////////////////////////////////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////dJCEAAnT6pDXBCIcvP/0v7skySIJhNt7',
      'HBMF/MerOlf9G3wYqnuuyrcf1GH2bddvp1a/1xQun3/je34e/BzVur9V6Xil0f+pfy3f69//D1/e3/3898xTt99f3ftf39/16v37fv37+2uExOjr',
      'W4QExJ7IW+XKbxL3rkT9x6xftFA0+nnQzrA+0HODrddHedp/d9j9F/Tw4T1V9dsUa//bMpz+H/30O/0xdDgB6ih3RHaL5d96m57zd/OALXSCADDM',
      'pQhUFz4EhaSy+F7m+/7Vxq4nivk/avHeLJx5Xx2Y+8sv/e7/bi99v6d79z8N6//uYvHvyH+jM9cfv6NrpX73376cL3b/Pah3/79379por/x/P9f/',
      '9/5v7/v7/bPy2+Cbt1azfnfe9rt6G3wTrHt//+P3+/+zt///97fvf/7/fvma/93/7XvM//zrbbr79d+91/t3Lf+8979969U+7zWw229dn2t6kW24',
      'azQM+1q6p9wj+rOd377/tb/RZOuf5v93Vf/3Zt5/re+//f/7u9sPf///+/v///Pf+e2v/7X9//f/5f//+/v+/v//Tkin9d7eVWR/AKCzhh0L7/IX',
      'GaSeICkQrdpv720ImBDdr8hv/X35/2zz/c33/v////283r7Xf78v9//d/9//5/7///3//+/////////r39/rnxG0YbeR7p7CHxc23t7vz3/x96MA',
      'JXtGKT/XH/7x+Ldb8u83e+B7RnYefV2p/65Tn5vBfOXM4nC8/bln3ZdPO+x8991f2L+Lzxx6//e319r5w0iWY8/dr3u2aIvm3/PdajwEpPH9fN9j',
      'Z/d/f++m3fpztj7/+7Ps+2/ku797+Pr/v/8bKv4KuHq/OyJ2fJTB9ncFtC3u+RGiyebdTRuEIkAQTGUPef29UcRy/xubHd4vcb4/8+ZsuvRQ+HP7',
      '/l268/WZ79vYXyav/8+/uyv7635/ff/0c/7Qv8+F2i5Jk+u7vu/oo75/68zDY780324dlLPvSv5zpVRtT01+zd13f/8azD37Oyvnf15e/6/zZZPb',
      'rzyuu2n8Pf87tu//P/2/zb7v4iz21E9XP0LN27I9vC/cXvw/7f1ey/JTP//vf+bv32/Fd092Nf/9+X/Mk+7kb5P8v3/d/3dfO17W/+7VW3p+v9n7',
      '35/77//f/v//++e7/t5fz6v+/+//vu/3/9f+9v//99/5+/e99fnd+O/3/3z59/3//v/u//vv//f3///73///9+/7v/9g//ubf+32fwF54+S38b/+',
      '/X9LY5wXQ/X9d////34ldzM2b/54/V8T7Pu6mfHssnUZs/cE7enft9H61sf993u33/u7hw0z8em/uW/+26zfdSV82+6u57367bNV8V+QZtWkTeu6',
      '59u/9v9//z/W/b7P23O/+0/nzZvNbOs+uX3n//Lh8T59/+1mr5/+/66+f+/t//X/9P/bfu93/bu/dd1T/+//v//v3f73V54P/7mb/f8H98j5fv90',
      'L8f/3f/93/i9/77v/63/rU+9/9/ve+t9/+/9vff+232f3/+vv9/+9//LHZg/7v91ef3b2fz7//96b7/96v56vfyN/cz/v7dH/7GvP8+/f//3/tr2',
      'b/X99/91+vP62/3/3t//v5d9/ve7+4fv///fIef5vr939f6/d//+3/97/++zvz//7///atPUUPLfb+3N2/Pm/j87ffnlN9utX/nL9Pv77v3/1/d/',
      'qfH/vvvvu3/bt/mDK/a1+/+//XufOigmZzvrrv3k/3/+fD+q/H/8p7Xn/x3Pv/s/X+n2Z///f+PTFbd/+c+P////6r7e/9/f/6f///2NfX5//fSr',
      '3fPe+/9+f/v9v//9v/f/q/z8vx/eXn96zB///z+7/RH01fl+L33+1t6X/3v2v3FHug9///v1L3nl3zFOnzn/e0/zvy3WX795t/bt9b7u/+u/VajX',
      '//9fvX5Xd//91/3/bv3//+29ff9/7///fff/HvfP//3+7/fX//V7dk+73b3/+58tf///ts7TbvF4d/b5q+/ev7m+kf39f/fp+t/pEv9z+Zr2bO/3',
      '7f7/97e3fZ+1+8+7/Zn2zftPv+8qaxFYBxrRAFMRRk6OvYfa7pmu2v//XPv5uVr/3arvu+39+93dr+t+/v3+5ZTPXv///7dWu+Ovuv97Ih8X5b/S',
      'yDnrO7Svv6tN/6Tam3i0+/939bz/s8T/n7f2MP57/8P+/Pdbut33fvfa5/cfiGsv/+sc/X////y/f3C7+/f7zb9P9dx/X203n3/9/cO//+9/5pv8',
      'tvnq/nV3f+//ub////d52X3r9+//ffn/54v/3w/u/9+//X/3tefd//v3/+3///vu7/X337+v/////3X71c9fz/f59///2++/b//v979h////Xd7f',
      'z/3/9T/z/f//3/9+/z/MI3/3/53469///////37T/3Xvv/+1+v5b7v3/f39/vV/9vv+v/tPf/7/7///7vvf7///v+7Xf/9//+/+9957PZ9HV5n79',
      'zde77//X/f/Ze8/M7f/n3Hv/+vvf+7v37/+/f/97+389d7f7f/t324j8+f+3///++rpXVtfbpev//863sJXw7V/N176Eyvptf/e75z+Xdbrou2/V',
      '/O7/vf99/+q/b2rf/vv3/8kYMgiEWF2QEEVIktQS0GGjzG3/vbr++/nj//3/7/efeGAnRmL696egy+/L31q3FwEATCDhJ6ayoPcO/93z3333/ue/',
      '5+f9U+16V/v/af6f+/nN/+vi/f2vz/t7fVv//91j+/v+w/t/+///lvf9w9f/ef82j53/fz8s6keH/BQktxT4iUm+7ASb037csFliEfK/2aZZE0at',
      '1p1bSuR79f+zO930/bv93/3eX9/7/fv9f9/+///F69/Tqx1+f/X7r//n//58AHzO9//f//+dz7/3/++/7v9/9/v/7f/W/73u/893/R3/+//v2/fu',
      '7//++rom+///1//3///fv//7r///v/////7/fvn////////+/7/b/u//+f//9/pP//h3HRi91bfUv/7P+5+7uszm/vmBP9/3fv+d7/9/Pn/29eX+',
      '0/z59f/rn+79GkvQ3L3sbf+7gXcOxt7XwfgW2p8zzuR2+i22DE+dpfN6Mrcumbevf//7/Pv+u634/af/31f//v7f////5/fvP+2Xd5HqcO7t3/7k',
      'vw/Ptn93HQEJyDTK7v73/++//zb7X/uP1+n2//3+///f9/u/348Ya5/2u/3/juX/jf/a1//f/X//v/P9//9+v97/X3PbD6QlK299+81+f+7Pf+f+',
      'v/v//7//9/9b//3vyX/v+/9///////3//7/////5/////v/////2///f+////X//////7/3f/+/v/v/+58+/v9/95////f/3v/7/d////d/97/v/',
      '/3////9/7////3///////f///zOUX/cf13n//6//1l3//3d/n///x+c/6ZT/fv///7/3//7//7f/8/r/vf/7f+/W/vn/////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '//////////////////////////////////////////////////////////9s/ADB7k/8/P7X7/7//2z+hOHub/xo/sTt73//bGqUz+7v/e7/38/u',
      'b/3+///Phk/57P7v7////+7+9u/u//9s/NTv////bP6Ui+5P3Oz+x8////////+P7k/87v/f7/5/3v7//8/uT/H8/9/P///97v/e7////+x+lO/v',
      '//zu/+/v7u///v//7+pH3f///8/uT/1o/ATF7k/87P7e/////+TyxMfuT/zs/szu////7PrU4/7//v///+/u7//8/t/P5k/9/v/v7////+7+/u/v',
      '7/3s+Jzr////7P7UiwZHcez+xO////////+PZk+17P7U7+7//O7//8+mTtXu/v/v///+7v707////+z+1O////7+///v73/9/v7+z6ZP/f7//8/m',
      'T/js/sTn7m/8/////////+z2x+fub/z+////////7P7f7/////7//+/////////P7/f9/////////+7+/P////9s/vTv7s//7v7ez+5POOz+xM/+',
      'f/3////P7k987P7Uz+5P/O7//c/uT/3u////////7v7+7+7//ez+1O////7////P7v//7P7ez+5Pvf///8/uT/0s/JTF7k/4/v7f/////+z+lMfu',
      'T/zs/kfv////5P7U7////////+/vf//u//+Pxk9d7v71/////+7+/+/u7//u/vb/////bP5EjUZP3ez+xM3+3//////P5k/5bP7Ez+5f3P7//4/u',
      'T/3+/+/v///+7v787/7//2z81O3////+///v7///7v7+z+7//////8+uT/Hs+sbH7m/8/v/+/////2z+xu////38/9b/////7v/c////////////',
      '///+/9/P7u///////////////+/////u/vz/////7P/XT45P3Oz+xM/uT/3+//+PJk+87P7E7+5v/O7+/4/uT93u/9/v////7v/3z+5P/Wz+VOn/',
      '//7u/t7v7k/9/v7Wz85P/f///8/mR73k/szH7u/9///f/////+z+ze/u/////////v//bP7d7/////7//+/+7//+///P7u/9/v//7////+7/////',
      '//3sfvzv////7P7Uz6hHnOz+xM9uT13u///PxA+o7P7Ujy4PHO7+5s+ORvXs/sfP/u/97P7+z+5P/ez+1M/uz/zs/v3P7k/97P5Uz+5LAe7+/s/O',
      'R7gs/oTP7k/8rv/f7/7//+z6lM/ub/3u/s7v////7P4U5/9//f7/3+/u7//u/9/P7k/9/v/v7////+z+/u/u7//s/tz/////bPqUyWpP/Oz/xO//',
      '///////P7s/9/v//7////v///8/uf/X8////////7v7+/////ez+3O///////////////v//7/9v/////8/uz3ms/oTP7k/87v7f/////+z+xM/u',
      'b/3u/+/v////7P7W7+7//////+/v///+///P7k/9/v/v7/////7/9e/v//3s/t7/////7PzUz+5P/ez+xO/////////P5k/87P7U7+5P/v7//8/u',
      'T/3s/t/v///9/v7/7////+z+1O/u//3+/9/P7m///v7+z+7P/f///8/uT/3s/MTP7k/9/v///////+z+xM/uT/3u/+/v/v//7P7U6/////7//+//',
      'f//+///P7m/9/v/v7////+7+3+/v7/1s+vTv/v//7P7cj65P3Oz+xM/////////P7m/87P7U7+7P/P7//8/ub/3+////////7v//7/5//+z61u//',
      '//3////v/v///v7e7+7P/////8/uT/3s3tTP7k/8/v/f/////+z+1M/uT/3s/sTv////7P7Uze5//fz/98/uf/3+///P7m397v7+z+7//ez+9O/u',
      '7/1s/Nzt7s//7P70////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
      '////////////////////////////////////////////////////////////////////////////////////////APz/////////////////////',
      '////////////////AQAAAAAAAAAAAAAAAAAAAAAAAAD//////////9////8=',
    ].join('')
  ),
  (char) => char.charCodeAt(0)
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
// code-gauge-allow functionCognitiveComplexity -- Validates and combines conversion flags before their shared dispatch.
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

const ZEN_TO_HAN_BYTES = hexBytes(
  '6700710068007200690073006a0074006b0075007600769e7700779e7800789e7900799e7a007a9e7b007b9e7c007c9e7d007d9e7e007e9e7f007f9e8000809e8100819e6f008200829e8300839e8400849e850086008700880089008a008a9e8a9f8b008b9e8b9f8c008c9e8c9f8d008d9e8d9f8e008e9e8e9f8f0090009100920093006c0094006d0095006e0096009700980099009a009b009c009c007200740066009d00739e'
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
const HAN_TO_ZEN_KATAKANA = hexBytes(
  '00020c0d01fbf2a1a3a5a7a9e3e5e7c3fca2a4a6a8aaabadafb1b3b5b7b9bbbdbfc1c4c6c8cacbcccdcecfd2d5d8dbdedfe0e1e2e4e6e8e9eaebecedeff39b9c'
);

const HAN_TO_ZEN_HIRAGANA = hexBytes(
  '00020c0d01fb92414345474983858763fc424446484a4b4d4f51535557595b5d5f616466686a6b6c6d6e6f7275787b7e7f808182848688898a8b8c8d8f939b9c'
);

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

/** The halfwidth-to-fullwidth conversions of mb_convert_kana_codepoint, which come before the others. */
// code-gauge-allow functionCognitiveComplexity -- Returns the converted scalar together with whether the following mark was consumed.
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

// code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
