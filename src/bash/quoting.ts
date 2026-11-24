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

function isPrintable(c: string): boolean {
  const code = c.codePointAt(0) as number;
  if (code < 0x80) return code >= 0x20 && code < 0x7f;
  return !/^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]$/u.test(c);
}

export function ansicShouldQuote(text: string): boolean {
  return charactersOf(text).some((c) => !isPrintable(c));
}

/** Formats `text` as a `$'...'` literal, escaping control and non-printable characters. */
export function ansicQuote(text: string): string {
  const named: Record<string, string> = {
    '\u001B': 'E',
    '\u0007': 'a',
    '\v': 'v',
    '\b': 'b',
    '\f': 'f',
    '\n': 'n',
    '\r': 'r',
    '\t': 't',
  };
  let result = "$'";
  for (const c of text) {
    if (Object.hasOwn(named, c)) result += `\\${named[c]}`;
    else if (c === '\\' || c === "'") result += `\\${c}`;
    else if (isPrintable(c)) result += c;
    else {
      for (const byte of new TextEncoder().encode(c)) result += `\\${byte.toString(8).padStart(3, '0')}`;
    }
  }
  return `${result}'`;
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

/** Formats `text` for `${x@Q}` so the shell reads it back as the same value. */
export function quoteReusable(text: string): string {
  if (text === '') return "''";
  if (ansicShouldQuote(text)) return ansicQuote(text);
  return singleQuote(text);
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
