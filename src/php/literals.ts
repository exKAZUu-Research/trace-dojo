// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { codePointBytes, enc } from './bytes';

export function parseIntegerLiteral(text: string): bigint | number {
  const clean = text.replaceAll('_', '');
  let value: bigint;
  if (/^0[xX]/.test(clean)) value = BigInt(clean);
  else if (/^0[bB]/.test(clean)) value = BigInt(clean);
  else if (/^0[oO]/.test(clean)) value = BigInt(`0o${clean.slice(2)}`);
  else if (/^0\d/.test(clean)) value = BigInt(`0o${clean.slice(1)}`);
  else value = BigInt(clean);
  if (value > 9_223_372_036_854_775_807n) {
    if (/^0[xXbBoO]|^0\d/.test(clean)) return Number(value);
    return Number.parseFloat(clean);
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
function decodeEscape(text: string, doubleQuoted: boolean): string {
  const body = text.slice(1);
  if (body === '"') return doubleQuoted ? '"' : String.raw`\"`;
  if (body in SIMPLE_ESCAPES) return SIMPLE_ESCAPES[body];
  if (/^[0-7]{1,3}$/.test(body)) return String.fromCharCode(Number.parseInt(body, 8) & 0xff);
  if (/^x[0-9A-Fa-f]{1,2}$/.test(body)) return String.fromCharCode(Number.parseInt(body.slice(1), 16));
  const unicode = /^u\{([0-9A-Fa-f]+)\}$/.exec(body);
  if (unicode) return codePointBytes(Number.parseInt(unicode[1], 16));
  return enc(text);
}

/** Decodes the escapes of a literal part of a double-quoted string or heredoc into bytes. */
export function decodeLiteral(raw: string, doubleQuoted: boolean): string {
  let result = '';
  let last = 0;
  for (const match of raw.matchAll(/\\(u\{[0-9A-Fa-f]+\}|x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|[ntrvef\\$"])/g)) {
    result += enc(raw.slice(last, match.index)) + decodeEscape(match[0], doubleQuoted);
    last = match.index + match[0].length;
  }
  return result + enc(raw.slice(last));
}
