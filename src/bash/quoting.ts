/** Shell word quoting and ANSI-C backslash-escape tables shared by `declare -p`, `${x@Q}`, `printf`, `echo -e`, and `$'...'`. */

import { charactersOf } from './characters';

const BACKSLASH_QUOTED = new Set('\t\n !"$&\'()*,;<>?[\\]^`{|}');

/** Single-letter backslash escapes common to `echo -e`, `printf`, and `$'...'`. */
export const SIMPLE_ESCAPE_BYTES: Record<string, number> = {
  a: 7,
  b: 8,
  e: 27,
  E: 27,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '\\': 92,
};

/** Reads up to `maxDigits` digits in `radix` (8 or 16) starting at `start` in a string or byte array. */
export function readRadixDigits(
  source: string | readonly number[],
  start: number,
  maxDigits: number,
  radix: number
): { value: number; count: number } {
  let value = 0;
  let count = 0;
  while (count < maxDigits && start + count < source.length) {
    const code = typeof source === 'string' ? (source.codePointAt(start + count) as number) : source[start + count];
    const digit = Number.parseInt(String.fromCodePoint(code), radix);
    if (Number.isNaN(digit)) break;
    value = value * radix + digit;
    count++;
  }
  return { value, count };
}

const UTF8_ENCODER = new TextEncoder();
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const NAMED_ANSIC_ESCAPES: Record<string, string> = {
  '\u001B': 'E',
  '\u0007': 'a',
  '\v': 'v',
  '\b': 'b',
  '\f': 'f',
  '\n': 'n',
  '\r': 'r',
  '\t': 't',
};

export function quoteReusable(text: string): string {
  if (text === '') return "''";
  if (ansicShouldQuote(text)) return ansicQuote(text);
  return singleQuote(text);
}

export function ansicShouldQuote(text: string): boolean {
  return charactersOf(text).some((c) => !isPrintable(c));
}

/** Formats `text` as a `$'...'` literal, escaping control and non-printable characters. */
export function ansicQuote(text: string): string {
  return ansicQuoteBytes(UTF8_ENCODER.encode(text));
}

/** Formats raw UTF-8 `bytes` as a `$'...'` literal, octal-escaping incomplete or invalid byte sequences. */
export function ansicQuoteBytes(bytes: Uint8Array): string {
  let result = "$'";
  for (let i = 0; i < bytes.length;) {
    const decoded = decodeOneUtf8Char(bytes, i);
    if (decoded) {
      result += formatAnsicChar(decoded.char, bytes.subarray(i, i + decoded.length));
      i += decoded.length;
    } else {
      result += octalEscape(bytes[i]);
      i++;
    }
  }
  return `${result}'`;
}

function decodeOneUtf8Char(bytes: Uint8Array, start: number): { char: string; length: number } | undefined {
  const length = utf8SequenceLength(bytes[start]);
  if (length === 0 || start + length > bytes.length) return undefined;
  try {
    return { char: FATAL_UTF8_DECODER.decode(bytes.subarray(start, start + length)), length };
  } catch {
    return undefined;
  }
}

function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

function formatAnsicChar(c: string, rawBytes: Uint8Array): string {
  if (Object.hasOwn(NAMED_ANSIC_ESCAPES, c)) return `\\${NAMED_ANSIC_ESCAPES[c]}`;
  if (c === '\\' || c === "'") return `\\${c}`;
  if (isPrintable(c)) return c;
  let out = '';
  for (const byte of rawBytes) out += octalEscape(byte);
  return out;
}

function octalEscape(byte: number): string {
  return `\\${byte.toString(8).padStart(3, '0')}`;
}

function isPrintable(c: string): boolean {
  const code = c.codePointAt(0);
  if (code === undefined) return false;
  if (code < 0x80) return code >= 0x20 && code < 0x7f;
  return !/^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]$/u.test(c);
}

/** Formats `text` with single quotes, closing and escaping embedded `'` characters. */
export function singleQuote(text: string): string {
  if (text === "'") return String.raw`\'`;
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}

/** Formats `text` inside double quotes, escaping `\`, `` ` ``, `$`, and `"`. */
export function doubleQuote(text: string): string {
  return `"${text.replaceAll(/[\\`$"]/g, String.raw`\$&`)}"`;
}

/** Escapes shell metacharacters with backslashes for `printf %q`. */
export function backslashQuote(text: string, quoteTilde: boolean, quoteBlanks: boolean): string {
  let result = '';
  let previous = '';
  let first = true;
  for (const c of text) {
    if (BACKSLASH_QUOTED.has(c)) result += '\\';
    else if (c === '#' && first) result += '\\';
    else if (quoteTilde && c === '~' && (first || previous === ':' || previous === '=')) result += '\\';
    else if (quoteBlanks && (c === ' ' || c === '\t')) result += '\\';
    result += c;
    previous = c;
    first = false;
  }
  return result;
}

/** Whether `text` contains characters that unquoted shell syntax treats specially. */
export function containsShellMetas(text: string): boolean {
  const chars = charactersOf(text);
  return chars.some((c, i) => {
    if (' \t\n\'"\\|&;()<>!{}*[?]^$`'.includes(c)) return true;
    if (c === '~') return i === 0 || chars[i - 1] === '=' || chars[i - 1] === ':';
    return c === '#' && i === 0;
  });
}
