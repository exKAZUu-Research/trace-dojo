/** Bash's ways of quoting a string so that the shell reads it back as the same word (`lib/sh/shquote.c`). */

import { charactersOf } from './characters';

/** The characters `sh_backslash_quote` escapes, as Bash's `bstab`. */
const BACKSLASH_QUOTED = new Set('\t\n !"$&\'()*,;<>?[\\]^`{|}');

/** Whether a character is printable as `iswprint` judges it, which `$'...'` quoting needs not escape. */
function isPrintable(c: string): boolean {
  const code = c.codePointAt(0) as number;
  if (code < 0x80) return code >= 0x20 && code < 0x7f;
  return !/^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]$/u.test(c);
}

export function ansicShouldQuote(text: string): boolean {
  return charactersOf(text).some((c) => !isPrintable(c));
}

/** `$'...'` quoting, as Bash's `ansic_quote`. */
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
    if (named[c]) result += `\\${named[c]}`;
    else if (c === '\\' || c === "'") result += `\\${c}`;
    else if (isPrintable(c)) result += c;
    else {
      for (const byte of new TextEncoder().encode(c)) result += `\\${byte.toString(8).padStart(3, '0')}`;
    }
  }
  return `${result}'`;
}

/** `'...'` quoting, which closes and reopens the quotes around each `'`, as Bash's `sh_single_quote`. */
export function singleQuote(text: string): string {
  if (text === "'") return String.raw`\'`;
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}

/** `"..."` quoting, as Bash's `sh_double_quote`. */
export function doubleQuote(text: string): string {
  return `"${text.replaceAll(/[\\`$"]/g, String.raw`\$&`)}"`;
}

/** Backslash quoting, as Bash's `sh_backslash_quote` with the flags that `printf %q` passes. */
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

/** `${x@Q}`'s quoting: `''` for nothing, `$'...'` for unprintable characters, and `'...'` otherwise. */
export function quoteReusable(text: string): string {
  if (text === '') return "''";
  if (ansicShouldQuote(text)) return ansicQuote(text);
  return singleQuote(text);
}

/** Whether a string holds characters that the shell would read specially, as Bash's `sh_contains_shell_metas`. */
export function containsShellMetas(text: string): boolean {
  const chars = charactersOf(text);
  return chars.some((c, i) => {
    if (' \t\n\'"\\|&;()<>!{}*[?]^$`'.includes(c)) return true;
    if (c === '~') return i === 0 || chars[i - 1] === '=' || chars[i - 1] === ':';
    return c === '#' && i === 0;
  });
}
