// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { codePointBytes, enc } from './bytes';

export function decodeSingleQuoted(raw: string): string {
  return enc(raw.replaceAll(/\\([\\'])/g, '$1'));
}

export function parseIntegerLiteral(text: string): bigint | number {
  const clean = text.replaceAll('_', '');
  let value: bigint;
  if (/^0[xX]/.test(clean)) value = BigInt(clean);
  else if (/^0[bB]/.test(clean)) value = BigInt(clean);
  else if (/^0[oO]/.test(clean)) value = BigInt(`0o${clean.slice(2)}`);
  else if (/^0\d/.test(clean)) value = BigInt(`0o${clean.slice(1)}`);
  else value = BigInt(clean);
  if (value > 9_223_372_036_854_775_807n) {
    if (/^0[xXbBoO]|^0\d/.test(clean)) return accumulateDigits(clean);
    return Number.parseFloat(clean);
  }
  return value;
}

/**
 * The float an overflowing hexadecimal, octal, or binary literal becomes: PHP adds its digits one by one in floating
 * point (zend_hex_strtod and its siblings), whose rounding can differ from the exact value's.
 */
function accumulateDigits(literal: string): number {
  const radix = /^0[xX]/.test(literal) ? 16 : /^0[bB]/.test(literal) ? 2 : 8;
  const digits = literal.replace(/^0[xXbBoO]?/, '');
  let value = 0;
  for (const digit of digits) {
    // zend_bin_strtod and zend_oct_strtod add the character code and then subtract '0', rounding twice.
    value =
      radix === 16 ? value * radix + Number.parseInt(digit, 16) : value * radix + (digit.codePointAt(0) as number) - 48;
  }
  return value;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  v: '\v',
  e: '\u001B',
  f: '\f',
  '\\': '\\',
  $: '$',
};

/** Decodes one escape sequence of a double-quoted string or heredoc, as bytes. */
function decodeEscape(
  text: string,
  doubleQuoted: boolean,
  onOverflow?: (escape: string) => void,
  invalidUnicode?: (message: string) => void
): string {
  const body = text.slice(1);
  if (body === '"') return doubleQuoted ? '"' : String.raw`\"`;
  if (body in SIMPLE_ESCAPES) return SIMPLE_ESCAPES[body];
  if (/^[0-7]{1,3}$/.test(body)) {
    const code = Number.parseInt(body, 8);
    if (code > 0xff) onOverflow?.(text);
    return String.fromCharCode(code & 0xff);
  }
  if (/^x[0-9A-Fa-f]{1,2}$/.test(body)) return String.fromCharCode(Number.parseInt(body.slice(1), 16));
  if (body.startsWith('u{')) {
    if (!body.endsWith('}')) invalidUnicode?.('Invalid UTF-8 codepoint escape sequence');
    else {
      const value = Number.parseInt(body.slice(2, -1), 16);
      if (value <= 0x10_ff_ff) return codePointBytes(value);
      invalidUnicode?.('Invalid UTF-8 codepoint escape sequence: Codepoint too large');
    }
  }
  return enc(text);
}

/**
 * Decodes the escapes of a literal part of a double-quoted string or heredoc into bytes, reporting octal escapes past
 * a byte, which PHP warns about.
 */
export function decodeLiteral(
  raw: string,
  doubleQuoted: boolean,
  onOverflow?: (escape: string, offset: number) => void,
  invalidUnicode?: (message: string, offset: number) => void
): string {
  let result = '';
  let last = 0;
  for (const match of raw.matchAll(/\\(?:u\{(?:[0-9A-Fa-f]+\})?|x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|[ntrvef\\$"])/g)) {
    result +=
      enc(raw.slice(last, match.index)) +
      decodeEscape(
        match[0],
        doubleQuoted,
        (escape) => onOverflow?.(escape, match.index),
        (message) => invalidUnicode?.(message, match.index)
      );
    last = match.index + match[0].length;
  }
  return result + enc(raw.slice(last));
}
