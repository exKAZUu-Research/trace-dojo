// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { formatFloat } from '../floatFormat';
import { decodeRune, encodeRune, RUNE_ERROR } from '../literals';
import { isPrint, quote, quoteRune } from '../quote';
import type { Value } from '../values';
import { fullRune } from './unicode';
import { isSpace } from './unicodeSupport';

// Errors ------------------------------------------------------------------------------------------------------------

/** An error that the JSON and XML packages produce or pass along, which becomes a Go error value at the API boundary. */
export abstract class LibError {
  abstract message(): string;

  /** The error that `errors.Unwrap` returns. */
  unwrap(): LibError | undefined {
    return undefined;
  }
}

/** An error like the ones `errors.New` and `fmt.Errorf` make, with the error that a `%w` verb wraps. */
export class TextError extends LibError {
  constructor(
    readonly text: string,
    readonly wrapped?: LibError
  ) {
    super();
  }

  message(): string {
    return this.text;
  }

  override unwrap(): LibError | undefined {
    return this.wrapped;
  }
}

/** An error value of the program, such as one that a MarshalJSON method returns. */
export class GoValueError extends LibError {
  constructor(
    readonly value: Value,
    readonly text: string
  ) {
    super();
  }

  message(): string {
    return this.text;
  }
}

export const EOF_ERROR = new TextError('EOF');
export const UNEXPECTED_EOF = new TextError('unexpected EOF');
export const ERR_INVALID_UTF8 = new TextError('invalid UTF-8');
export const STRCONV_SYNTAX = new TextError('invalid syntax');
export const STRCONV_RANGE = new TextError('value out of range');

/** `jsonwire.InvalidTextError`. */
export class InvalidTextError extends LibError {
  constructor(
    readonly label: string,
    readonly what: string,
    readonly where: string
  ) {
    super();
  }

  message(): string {
    let what: string;
    const runes = runeCount(this.what);
    const needEscape = [...runeList(this.what)].some(
      ({ rune }) => rune === 0x60 || rune === RUNE_ERROR || isSpace(rune) || !isPrint(rune)
    );
    if (runes === 1) what = quoteRuneBytes(this.what, 0);
    else if (needEscape) what = quote(this.what);
    else what = `\`${this.what}\``;
    const text = `invalid ${this.label} ${what} ${this.where}`;
    return text.endsWith(' ') ? text.slice(0, -1) : text;
  }
}

function* runeList(bytes: string): Generator<{ rune: number; size: number }> {
  for (let at = 0; at < bytes.length;) {
    const decoded = decodeRune(bytes, at);
    yield decoded;
    at += decoded.size;
  }
}

function runeCount(bytes: string): number {
  return [...runeList(bytes)].length;
}

export function newInvalidCharacterError(b: string, at: number, where: string): InvalidTextError {
  const n = at < b.length ? decodeRune(b, at).size : 0;
  return new InvalidTextError('character', b.slice(at, at + n), where);
}

export function newInvalidEscapeSequenceError(what: string): InvalidTextError {
  if (what.length > 6) return new InvalidTextError('surrogate pair', what, 'in string');
  return new InvalidTextError('escape sequence', what, 'in string');
}

/** `jsonwire.QuoteRune`: the rune at `at` quoted, or its byte in hexadecimal when it is not valid UTF-8. */
export function quoteRuneBytes(b: string, at: number): string {
  if (at >= b.length) return quoteRune(RUNE_ERROR);
  const { rune, size } = decodeRune(b, at);
  if (rune === RUNE_ERROR && size === 1) return String.raw`'\x` + b.charCodeAt(at).toString(16) + "'";
  return quoteRune(rune);
}

// Decoding ----------------------------------------------------------------------------------------------------------

const ESCAPE_ASCII = (() => {
  const table = new Uint8Array(128);
  for (let c = 0; c < 0x20; c++) table[c] = 1;
  for (const c of '"&<>\\') table[c.charCodeAt(0)] = 1;
  return table;
})();

export function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
}

export function consumeWhitespace(b: string, at: number): number {
  let n = 0;
  while (at + n < b.length && isWhitespace(b.charCodeAt(at + n))) n++;
  return n;
}

/** Consumes the literal `lit` exactly, or returns 0. */
export function consumeExactLiteral(b: string, at: number, lit: string): number {
  return b.startsWith(lit, at) ? lit.length : 0;
}

/** `jsonwire.ConsumeLiteral`. */
export function consumeLiteral(b: string, at: number, lit: string): [number, LibError | undefined] {
  for (let i = 0; at + i < b.length && i < lit.length; i++) {
    if (b[at + i] !== lit[i]) {
      return [i, newInvalidCharacterError(b, at + i, `in literal ${lit} (expecting ${quoteRune(lit.charCodeAt(i))})`)];
    }
  }
  if (b.length - at < lit.length) return [b.length - at, UNEXPECTED_EOF];
  return [lit.length, undefined];
}

/** `jsonwire.ConsumeSimpleString`: a string without escapes or non-ASCII characters, or 0. */
export function consumeSimpleString(b: string, at: number): number {
  let n = 0;
  if (at < b.length && b[at] === '"') {
    n++;
    while (at + n < b.length) {
      const c = b.charCodeAt(at + n);
      if (c >= 0x80 || ESCAPE_ASCII[c] !== 0) break;
      n++;
    }
    if (at + n < b.length && b[at + n] === '"') return n + 1;
  }
  return 0;
}

/** Flags of a consumed string: whether it has escapes or invalid UTF-8 (non-verbatim). */
export interface StringFlags {
  nonVerbatim: boolean;
}

function noEscape(c: number): boolean {
  return c < 0x80 && c >= 0x20 && c !== 0x5c && c !== 0x22;
}

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function parseHex4(b: string, at: number): number | undefined {
  if (at + 4 > b.length) return undefined;
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const c = b.charCodeAt(at + i);
    if (!isHex(c)) return undefined;
    value = value * 16 + Number.parseInt(b[at + i], 16);
  }
  return value;
}

function isSurrogate(r: number): boolean {
  return r >= 0xd8_00 && r < 0xe0_00;
}

function decodeSurrogates(r1: number, r2: number): number {
  if (r1 >= 0xd8_00 && r1 < 0xdc_00 && r2 >= 0xdc_00 && r2 < 0xe0_00) {
    return (((r1 - 0xd8_00) << 10) | (r2 - 0xdc_00)) + 0x1_00_00;
  }
  return RUNE_ERROR;
}

function hasEscapedUTF16Prefix(b: string, at: number, lowerSurrogateHalf: boolean): boolean {
  for (let i = 0; at + i < b.length; i++) {
    const c = b[at + i];
    if (i === 0 && c !== '\\') return false;
    if (i === 1 && c !== 'u') return false;
    if (i === 2 && lowerSurrogateHalf && c !== 'd' && c !== 'D') return false;
    if (i === 3 && lowerSurrogateHalf && !/[c-fC-F]/.test(c)) return false;
    if (i >= 2 && i < 6 && !isHex(b.charCodeAt(at + i))) return false;
  }
  return true;
}

/**
 * `jsonwire.ConsumeStringResumable` over `b[at:]` with invalid UTF-8 allowed, as v1 allows it: the length consumed and
 * any error. `resumeOffset` continues a string whose start an earlier call consumed.
 */
export function consumeString(
  flags: StringFlags,
  b: string,
  at: number,
  resumeOffset: number
): [number, LibError | undefined] {
  let n = resumeOffset;
  if (n === 0) {
    if (at >= b.length) return [0, UNEXPECTED_EOF];
    if (b[at] !== '"') return [0, newInvalidCharacterError(b, at, `at start of string (expecting '"')`)];
    n = 1;
  }
  for (;;) {
    while (at + n < b.length && noEscape(b.charCodeAt(at + n))) n++;
    if (at + n >= b.length) return [n, UNEXPECTED_EOF];
    const c = b.charCodeAt(at + n);
    if (c === 0x22) return [n + 1, undefined];
    flags.nonVerbatim ||= c >= 0x80 ? decodeRune(b, at + n).size === 1 : true;
    let step: number | LibError;
    if (c >= 0x80) step = consumeNonASCII(b, at + n);
    else if (c === 0x5c) step = consumeEscape(b, at + n);
    else step = newInvalidCharacterError(b, at + n, 'in string (expecting non-control character)');
    if (step instanceof LibError) return [n, step];
    n += step;
  }
}

/** The length of the UTF-8 sequence at `pos`, one byte of an invalid one, or the end of input within a rune. */
function consumeNonASCII(b: string, pos: number): number | LibError {
  const { size } = decodeRune(b, pos);
  if (size > 1) return size;
  return fullRune(b.slice(pos, pos + 4)) ? 1 : UNEXPECTED_EOF;
}

/** The length of the escape sequence at `pos`, or why it is invalid or incomplete. */
function consumeEscape(b: string, pos: number): number | LibError {
  if (pos + 2 > b.length) return UNEXPECTED_EOF;
  const r = b[pos + 1];
  if (String.raw`/"\bfnrt`.includes(r)) return 2;
  if (r !== 'u') return newInvalidEscapeSequenceError(b.slice(pos, pos + 2));
  if (pos + 6 > b.length) {
    return hasEscapedUTF16Prefix(b, pos, false) ? UNEXPECTED_EOF : newInvalidEscapeSequenceError(b.slice(pos));
  }
  if (parseHex4(b, pos + 2) === undefined) return newInvalidEscapeSequenceError(b.slice(pos, pos + 6));
  return 6;
}

/** UTF-8 bytes of U+FFFD, which replaces invalid input. */
const REPLACEMENT = encodeRune(RUNE_ERROR);

/** `jsonwire.AppendUnquote` of the whole of `src`: the unquoted bytes and any error. */
export function unquote(src: string): [string, LibError | undefined] {
  if (src.length === 0) return ['', UNEXPECTED_EOF];
  if (src[0] !== '"') return ['', newInvalidCharacterError(src, 0, `at start of string (expecting '"')`)];
  let dst = '';
  let error: LibError | undefined;
  let i = 1;
  let n = 1;
  for (;;) {
    while (n < src.length && noEscape(src.charCodeAt(n))) n++;
    if (n >= src.length) return [dst + src.slice(i, n), UNEXPECTED_EOF];
    const c = src.charCodeAt(n);
    if (c === 0x22) {
      dst += src.slice(i, n);
      if (n + 1 < src.length) error = newInvalidCharacterError(src, n + 1, 'after string value');
      return [dst, error];
    }
    if (c >= 0x80 && decodeRune(src, n).size > 1) {
      n += decodeRune(src, n).size;
      continue;
    }
    dst += src.slice(i, n);
    let escape: Unescaped;
    if (c >= 0x80) {
      if (!fullRune(src.slice(n, n + 4))) return [dst, UNEXPECTED_EOF];
      escape = { text: REPLACEMENT, length: 1, err: ERR_INVALID_UTF8 };
    } else if (c === 0x5c) {
      escape = unquoteEscape(src, n);
    } else {
      return [dst, newInvalidCharacterError(src, n, 'in string (expecting non-control character)')];
    }
    dst += escape.text;
    if (escape.fatal) return [dst, escape.err];
    error = escape.err ?? error;
    n += escape.length;
    i = n;
  }
}

/** What an escape sequence unquotes to, its length, and any error, which ends unquoting when fatal. */
interface Unescaped {
  text: string;
  length: number;
  err?: LibError;
  fatal?: boolean;
}

function fail(err: LibError): Unescaped {
  return { text: '', length: 0, err, fatal: true };
}

function unquoteEscape(src: string, n: number): Unescaped {
  if (n + 2 > src.length) return fail(UNEXPECTED_EOF);
  const r = src[n + 1];
  const simple = SIMPLE_UNESCAPES[r];
  if (simple !== undefined) return { text: simple, length: 2 };
  if (r !== 'u') return fail(newInvalidEscapeSequenceError(src.slice(n, n + 2)));
  if (n + 6 > src.length) {
    return fail(hasEscapedUTF16Prefix(src, n, false) ? UNEXPECTED_EOF : newInvalidEscapeSequenceError(src.slice(n)));
  }
  const v1 = parseHex4(src, n + 2);
  if (v1 === undefined) return fail(newInvalidEscapeSequenceError(src.slice(n, n + 6)));
  if (!isSurrogate(v1)) return { text: encodeRune(v1), length: 6 };
  const m = n + 6;
  if (m + 6 > src.length) {
    if (hasEscapedUTF16Prefix(src, m, true)) return { text: REPLACEMENT, length: 6, err: UNEXPECTED_EOF, fatal: true };
    return { text: REPLACEMENT, length: 6, err: newInvalidEscapeSequenceError(src.slice(n)) };
  }
  const v2 = parseHex4(src, m + 2);
  const rune = src[m] === '\\' && src[m + 1] === 'u' && v2 !== undefined ? decodeSurrogates(v1, v2) : RUNE_ERROR;
  if (rune === RUNE_ERROR) {
    return { text: REPLACEMENT, length: 6, err: newInvalidEscapeSequenceError(src.slice(n, m + 6)) };
  }
  return { text: encodeRune(rune), length: 12 };
}

const SIMPLE_UNESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** `jsonwire.UnquoteMayCopy`. */
export function unquoteMayCopy(b: string, verbatim: boolean): string {
  if (verbatim) return b.slice(1, -1);
  return unquote(b)[0];
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** `jsonwire.ConsumeSimpleNumber`: an integer without a fraction or exponent that ends before the buffer does. */
export function consumeSimpleNumber(b: string, at: number): number {
  let n = 0;
  if (at < b.length) {
    const c = b.charCodeAt(at);
    if (c === 0x30) n++;
    else if (c >= 0x31 && c <= 0x39) {
      n++;
      while (at + n < b.length && isDigit(b.charCodeAt(at + n))) n++;
    } else return 0;
    if (at + n >= b.length || !'.eE'.includes(b[at + n])) return n;
  }
  return 0;
}

export const enum NumberState {
  Init,
  BeforeInteger,
  WithinInteger,
  BeforeFractional,
  WithinFractional,
  BeforeExponent,
  WithinExponent,
}

type NumberResult = [number, NumberState, LibError | undefined];

/**
 * `jsonwire.ConsumeNumberResumable` over `b[at:]`: the length consumed, the state to resume from when the input ends,
 * and any error.
 */
export function consumeNumberResumable(
  b: string,
  at: number,
  resumeOffset: number,
  initialState: NumberState
): NumberResult {
  let result: NumberResult = [resumeOffset, initialState, undefined];
  let stage = 0;
  if (initialState > NumberState.Init) {
    let [n, state] = result;
    if (
      state === NumberState.WithinInteger ||
      state === NumberState.WithinFractional ||
      state === NumberState.WithinExponent
    ) {
      n += countDigits(b, at + n);
      if (at + n >= b.length) return [n, state, undefined];
      state++;
    }
    if (state === NumberState.BeforeFractional) stage = 1;
    else if (state === NumberState.BeforeExponent) stage = 2;
    else if (state !== NumberState.BeforeInteger) return [n, state, undefined];
    result = [n, state, undefined];
  }
  if (stage === 0) result = consumeIntegerPart(b, at, result[0]);
  if (result[2]) return result;
  if (stage <= 1) result = consumeFractionPart(b, at, result[0], result[1]);
  if (result[2]) return result;
  return consumeExponentPart(b, at, result[0], result[1]);
}

function countDigits(b: string, from: number): number {
  let n = 0;
  while (from + n < b.length && isDigit(b.charCodeAt(from + n))) n++;
  return n;
}

function expectingDigit(b: string, pos: number): LibError {
  return newInvalidCharacterError(b, pos, 'in number (expecting digit)');
}

function consumeIntegerPart(b: string, at: number, resume: number): NumberResult {
  let n = resume;
  if (at < b.length && b[at] === '-') n++;
  if (at + n >= b.length) return [resume, NumberState.BeforeInteger, UNEXPECTED_EOF];
  const c = b.charCodeAt(at + n);
  if (c === 0x30) return [n + 1, NumberState.BeforeFractional, undefined];
  if (c >= 0x31 && c <= 0x39) return [n + 1 + countDigits(b, at + n + 1), NumberState.WithinInteger, undefined];
  return [n, NumberState.Init, expectingDigit(b, at + n)];
}

function consumeFractionPart(b: string, at: number, start: number, state: NumberState): NumberResult {
  if (at + start >= b.length || b[at + start] !== '.') return [start, state, undefined];
  const n = start + 1;
  if (at + n >= b.length) return [start, NumberState.BeforeFractional, UNEXPECTED_EOF];
  if (!isDigit(b.charCodeAt(at + n))) return [n, state, expectingDigit(b, at + n)];
  return [n + 1 + countDigits(b, at + n + 1), NumberState.WithinFractional, undefined];
}

function consumeExponentPart(b: string, at: number, start: number, state: NumberState): NumberResult {
  if (at + start >= b.length || (b[at + start] !== 'e' && b[at + start] !== 'E')) return [start, state, undefined];
  let n = start + 1;
  if (at + n < b.length && (b[at + n] === '-' || b[at + n] === '+')) n++;
  if (at + n >= b.length) return [start, NumberState.BeforeExponent, UNEXPECTED_EOF];
  if (!isDigit(b.charCodeAt(at + n))) return [n, state, expectingDigit(b, at + n)];
  return [n + 1 + countDigits(b, at + n + 1), NumberState.WithinExponent, undefined];
}

export function consumeNumber(b: string, at = 0): [number, LibError | undefined] {
  const [n, , error] = consumeNumberResumable(b, at, 0, NumberState.Init);
  return [n, error];
}

/** `jsonwire.ParseUint`: the value, and whether the text is a canonical decimal that fits in 64 bits. */
export function parseUintWire(b: string): [bigint, boolean] {
  let n = 0;
  let v = 0n;
  while (n < b.length && isDigit(b.charCodeAt(n))) {
    v = BigInt.asUintN(64, 10n * v + BigInt(b.charCodeAt(n) - 0x30));
    n++;
  }
  if (n === 0 || b.length !== n || (b[0] === '0' && b !== '0')) return [0n, false];
  if (n >= 20 && (b[0] !== '1' || v < 10_000_000_000_000_000_000n || n > 20)) return [(1n << 64n) - 1n, false];
  return [v, true];
}

// Encoding ----------------------------------------------------------------------------------------------------------

export interface EscapeFlags {
  escapeHTML: boolean;
  escapeJS: boolean;
}

/** `jsonwire.NeedEscape`. */
export function needEscape(src: string): boolean {
  for (let i = 0; i < src.length;) {
    const c = src.charCodeAt(i);
    if (c < 0x80) {
      if (ESCAPE_ASCII[c] > 0) return true;
      i++;
    } else {
      const { rune, size } = decodeRune(src, i);
      if (rune === RUNE_ERROR || rune === 0x20_28 || rune === 0x20_29) return true;
      i += size;
    }
  }
  return false;
}

const HEX = '0123456789abcdef';

function escapedUTF16(x: number): string {
  return `\\u${HEX[(x >> 12) & 15]}${HEX[(x >> 8) & 15]}${HEX[(x >> 4) & 15]}${HEX[x & 15]}`;
}

function escapedASCII(c: number): string {
  switch (c) {
    case 0x22: {
      return String.raw`\"`;
    }
    case 0x5c: {
      return String.raw`\\`;
    }
    case 0x08: {
      return String.raw`\b`;
    }
    case 0x0c: {
      return String.raw`\f`;
    }
    case 0x0a: {
      return String.raw`\n`;
    }
    case 0x0d: {
      return String.raw`\r`;
    }
    case 0x09: {
      return String.raw`\t`;
    }
    default: {
      return escapedUTF16(c);
    }
  }
}

/**
 * `jsonwire.AppendQuote` with invalid UTF-8 allowed (it becomes U+FFFD), as v1 options make it; the result is the
 * quoted string.
 */
export function quoteJSON(src: string, flags: EscapeFlags): string {
  let dst = '"';
  let i = 0;
  let n = 0;
  while (n < src.length) {
    const c = src.charCodeAt(n);
    if (c < 0x80) {
      n++;
      if (ESCAPE_ASCII[c] === 0) continue;
      if (!(c === 0x3c || c === 0x3e || c === 0x26) || flags.escapeHTML) {
        dst += src.slice(i, n - 1) + escapedASCII(c);
        i = n;
      }
    } else {
      const { rune, size } = decodeRune(src, n);
      n += size;
      if (rune !== RUNE_ERROR && rune !== 0x20_28 && rune !== 0x20_29) continue;
      if (rune === RUNE_ERROR && size === 1) {
        dst += `${src.slice(i, n - size)}ï¿½`;
        i = n;
      } else if ((rune === 0x20_28 || rune === 0x20_29) && flags.escapeJS) {
        dst += src.slice(i, n - size) + escapedUTF16(rune);
        i = n;
      }
    }
  }
  return `${dst + src.slice(i, n)}"`;
}

/** The raw-string-preserving reformat of `jsonwire.ReformatString`, which only escapes for HTML and JavaScript. */
export function reformatRawString(src: string, flags: EscapeFlags): string {
  let dst = '';
  let last = 0;
  for (let i = 0; i < src.length;) {
    const c = src.charCodeAt(i);
    if (c < 0x80) {
      if ((c === 0x3c || c === 0x3e || c === 0x26) && flags.escapeHTML) {
        dst += src.slice(last, i) + escapedASCII(c);
        last = i + 1;
      }
      i++;
    } else {
      const { rune, size } = decodeRune(src, i);
      if ((rune === 0x20_28 || rune === 0x20_29) && flags.escapeJS) {
        dst += src.slice(last, i) + escapedUTF16(rune);
        last = i + size;
      }
      i += size;
    }
  }
  return dst + src.slice(last);
}

/** `jsonwire.AppendFloat`: shortest digits, switching to exponents below 1e-6 and from 1e21. */
export function formatJSONFloat(value: number, bits: 32 | 64): string {
  const src = bits === 32 ? Math.fround(value) : value;
  const abs = Math.abs(src);
  const [small, large] = bits === 32 ? [Math.fround(1e-6), Math.fround(1e21)] : [1e-6, 1e21];
  const format = abs !== 0 && (abs < small || abs >= large) ? 'e' : 'f';
  let text = formatFloat(src, format, -1, bits);
  if (format === 'e') {
    const n = text.length;
    if (n >= 4 && text[n - 4] === 'e' && text[n - 3] === '-' && text[n - 2] === '0') {
      text = text.slice(0, n - 2) + text[n - 1];
    }
  }
  return text;
}
