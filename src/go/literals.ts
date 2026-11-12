// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
/** Go strings are byte sequences, which these strings hold as code units 0–255 so that `len` and indexing count bytes. */
export function utf8Encode(text: string): string {
  let bytes = '';
  for (const char of text) bytes += encodeRune(char.codePointAt(0) as number);
  return bytes;
}

export const RUNE_ERROR = 0xff_fd;
const MAX_RUNE = 0x10_ff_ff;

/** The UTF-8 bytes of a rune, where invalid runes (surrogates, values out of range) encode U+FFFD as Go does. */
export function encodeRune(rune: number): string {
  let code = rune;
  if (code < 0 || code > MAX_RUNE || (code >= 0xd8_00 && code <= 0xdf_ff)) code = RUNE_ERROR;
  if (code < 0x80) return String.fromCharCode(code);
  if (code < 0x8_00) return String.fromCharCode(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
  if (code < 0x1_00_00) {
    return String.fromCharCode(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return String.fromCharCode(
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 0x3f),
    0x80 | ((code >> 6) & 0x3f),
    0x80 | (code & 0x3f)
  );
}

/** Decodes the rune starting at `index` of a byte string as `utf8.DecodeRuneInString` does. */
export function decodeRune(bytes: string, index: number): { rune: number; size: number } {
  const first = bytes.charCodeAt(index);
  if (first < 0x80) return { rune: first, size: 1 };
  const continuation = (offset: number): number => {
    const byte = bytes.charCodeAt(index + offset);
    return byte >= 0x80 && byte <= 0xbf ? byte & 0x3f : -1;
  };
  const invalid = { rune: RUNE_ERROR, size: 1 };
  if (first >= 0xc2 && first <= 0xdf) {
    const b1 = continuation(1);
    return b1 < 0 ? invalid : { rune: ((first & 0x1f) << 6) | b1, size: 2 };
  }
  if (first >= 0xe0 && first <= 0xef) {
    const second = bytes.charCodeAt(index + 1);
    if (first === 0xe0 && second < 0xa0) return invalid;
    if (first === 0xed && second > 0x9f) return invalid;
    const b1 = continuation(1);
    const b2 = b1 < 0 ? -1 : continuation(2);
    return b2 < 0 ? invalid : { rune: ((first & 0x0f) << 12) | (b1 << 6) | b2, size: 3 };
  }
  if (first >= 0xf0 && first <= 0xf4) {
    const second = bytes.charCodeAt(index + 1);
    if (first === 0xf0 && second < 0x90) return invalid;
    if (first === 0xf4 && second > 0x8f) return invalid;
    const b1 = continuation(1);
    const b2 = b1 < 0 ? -1 : continuation(2);
    const b3 = b2 < 0 ? -1 : continuation(3);
    return b3 < 0 ? invalid : { rune: ((first & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3, size: 4 };
  }
  return invalid;
}

/** The runes of a byte string, decoding invalid bytes as U+FFFD one byte at a time, as `range` does. */
export function runesOf(bytes: string): number[] {
  const runes: number[] = [];
  for (let index = 0; index < bytes.length;) {
    const { rune, size } = decodeRune(bytes, index);
    runes.push(rune);
    index += size;
  }
  return runes;
}

/** Text for display, decoding a byte string's UTF-8 with U+FFFD for invalid bytes. */
export function utf8Decode(bytes: string): string {
  // ASCII needs no decoding, which keeps printing common output cheap.
  if (!/[\u0080-ÿ]/.test(bytes)) return bytes;
  return runesOf(bytes)
    .map((rune) => String.fromCodePoint(rune))
    .join('');
}

type Fail = (message: string) => Error;

/** The bytes of an interpreted string literal, including its quotes. */
export function decodeStringLiteral(text: string, fail: Fail): string {
  let bytes = '';
  const body = text.slice(1, -1);
  for (let index = 0; index < body.length;) {
    const char = body[index];
    if (char !== '\\') {
      const code = body.codePointAt(index) as number;
      bytes += encodeRune(code);
      index += code > 0xff_ff ? 2 : 1;
      continue;
    }
    const escape = readEscape(body, index, '"', fail);
    bytes += escape.isByte ? String.fromCharCode(escape.value) : encodeRune(escape.value);
    index = escape.end;
  }
  return bytes;
}

/** The rune of a rune literal, including its quotes. */
/** The bytes of a raw string literal: its text between the backquotes, without carriage returns, in UTF-8. */
export function decodeRawStringLiteral(text: string): string {
  return utf8Encode(text.slice(1, -1).replaceAll('\r', ''));
}

export function decodeRuneLiteral(text: string, fail: Fail): number {
  const body = text.slice(1, -1);
  if (body.length === 0) throw fail("空のルーンのリテラル（''）は書けません。");
  if (body[0] === '\\') {
    const escape = readEscape(body, 0, "'", fail);
    if (escape.end !== body.length) throw fail('ルーンのリテラルには1文字だけを書いてください。');
    return escape.value;
  }
  const code = body.codePointAt(0) as number;
  if ((code > 0xff_ff ? 2 : 1) !== body.length) throw fail('ルーンのリテラルには1文字だけを書いてください。');
  return code;
}

const SIMPLE_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 };

function readEscape(
  body: string,
  index: number,
  quote: string,
  fail: Fail
): { value: number; end: number; isByte: boolean } {
  const kind = body[index + 1];
  if (kind in SIMPLE_ESCAPES) return { value: SIMPLE_ESCAPES[kind], end: index + 2, isByte: false };
  if (kind === quote) return { value: quote.charCodeAt(0), end: index + 2, isByte: false };
  const digits = (count: number, pattern: RegExp, radix: number): number => {
    const text = body.slice(index + 2, index + 2 + count);
    if (text.length !== count || !pattern.test(text)) throw fail('エスケープシーケンスの書き方に誤りがあります。');
    return Number.parseInt(text, radix);
  };
  if (kind >= '0' && kind <= '7') {
    const text = body.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/.test(text)) throw fail('エスケープシーケンスの書き方に誤りがあります。');
    const value = Number.parseInt(text, 8);
    if (value > 255) throw fail('8進数のエスケープシーケンスは 255 までです。');
    return { value, end: index + 4, isByte: true };
  }
  if (kind === 'x') return { value: digits(2, /^[\dA-Fa-f]{2}$/, 16), end: index + 4, isByte: true };
  if (kind === 'u' || kind === 'U') {
    const count = kind === 'u' ? 4 : 8;
    const value = digits(count, /^[\dA-Fa-f]+$/, 16);
    if (value > MAX_RUNE || (value >= 0xd8_00 && value <= 0xdf_ff)) {
      throw fail('エスケープシーケンスが Unicode の文字を表していません。');
    }
    return { value, end: index + 2 + count, isByte: false };
  }
  throw fail('知らないエスケープシーケンスです。');
}
