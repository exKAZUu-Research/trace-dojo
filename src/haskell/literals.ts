import { compileError as syntaxError, unsupportedError } from './errors';
import type { Span } from './syntax';

/** The ASCII control characters' names in escapes, by code point. */
export const ASCII_NAMES = [
  'NUL',
  'SOH',
  'STX',
  'ETX',
  'EOT',
  'ENQ',
  'ACK',
  'BEL',
  'BS',
  'HT',
  'LF',
  'VT',
  'FF',
  'CR',
  'SO',
  'SI',
  'DLE',
  'DC1',
  'DC2',
  'DC3',
  'DC4',
  'NAK',
  'SYN',
  'ETB',
  'CAN',
  'EM',
  'SUB',
  'ESC',
  'FS',
  'GS',
  'RS',
  'US',
  'SP',
];

const SINGLE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '\\': 92,
  '"': 34,
  "'": 39,
};

const MAX_CODE_POINT = 0x10_ff_ff;

export function parseIntegerLiteral(text: string, span: Span): bigint {
  if (text.includes('_')) throw unsupportedError(span, '数の区切りの _（NumericUnderscores）');
  if (/^0[bB]/.test(text)) throw unsupportedError(span, '2進数のリテラル（BinaryLiterals）');
  if (/^0[oO]/.test(text)) return BigInt(`0o${text.slice(2)}`);
  if (/^0[xX]/.test(text)) return BigInt(`0x${text.slice(2)}`);
  if (!/^\d+$/.test(text)) throw syntaxError(span, '書き方に誤りがあります。');
  return BigInt(text);
}

export function parseFloatLiteral(text: string, span: Span): number {
  if (text.includes('_')) throw unsupportedError(span, '数の区切りの _（NumericUnderscores）');
  if (/^0[xX]/.test(text)) throw unsupportedError(span, '16進数の小数のリテラル（HexFloatLiterals）');
  if (!/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) throw syntaxError(span, '書き方に誤りがあります。');
  return Number(text);
}

export function parseCharLiteral(text: string, span: Span): string {
  const body = text.slice(1, -1);
  const { chars, end } = readChars(body, span, false);
  if (chars.length !== 1 || end !== body.length)
    throw syntaxError(span, '文字のリテラルには、1文字だけを書いてください。');
  return chars[0];
}

export function parseStringLiteral(text: string, span: Span): string[] {
  if (text.startsWith('"""')) throw unsupportedError(span, '複数行の文字列（MultilineStrings）');
  const body = text.slice(1, -1);
  return readChars(body, span, true).chars;
}

/** Reads the characters of a literal's body, each one code point, resolving escapes and string gaps. */
function readChars(body: string, span: Span, isString: boolean): { chars: string[]; end: number } {
  const chars: string[] = [];
  let index = 0;
  while (index < body.length) {
    const char = String.fromCodePoint(body.codePointAt(index) as number);
    if (char !== '\\') {
      chars.push(graphicChar(char, span));
      index += char.length;
      continue;
    }
    index++;
    const next = body[index];
    if (next === undefined) throw syntaxError(span, '文字のエスケープの書き方に誤りがあります。');
    if (isString && /\s/.test(next)) {
      // A string gap: a backslash, white space, and a backslash, which stand for nothing.
      const close = body.indexOf('\\', index);
      if (close === -1 || !/^\s*$/.test(body.slice(index, close))) {
        throw syntaxError(span, String.raw`文字列の継続（\ と \ の間）の書き方に誤りがあります。`);
      }
      index = close + 1;
      continue;
    }
    if (isString && next === '&') {
      index++;
      continue;
    }
    const { code, length } = readEscape(body, index, span);
    chars.push(String.fromCodePoint(code));
    index += length;
  }
  return { chars, end: index };
}

function graphicChar(char: string, span: Span): string {
  if (!/^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]$/u.test(char)) throw syntaxError(span, '文字の書き方に誤りがあります。');
  return char;
}

// code-gauge-allow functionCognitiveComplexity 23 -- One branch per escape form of the Haskell report.
function readEscape(body: string, index: number, span: Span): { code: number; length: number } {
  const next = body[index];
  if (next in SINGLE_ESCAPES) return { code: SINGLE_ESCAPES[next], length: 1 };
  if (next === '^') {
    const control = body.codePointAt(index + 1) ?? 0;
    if (control >= 64 && control <= 95) return { code: control - 64, length: 2 };
    throw syntaxError(span, '文字のエスケープの書き方に誤りがあります。');
  }
  const numeric = /^(?:(\d+)|o([0-7]+)|x([\dA-Fa-f]+))/.exec(body.slice(index));
  if (numeric) {
    const code = numeric[1]
      ? Number.parseInt(numeric[1], 10)
      : numeric[2]
        ? Number.parseInt(numeric[2], 8)
        : Number.parseInt(numeric[3], 16);
    if (code > MAX_CODE_POINT) throw syntaxError(span, '文字のコードが大きすぎます。');
    return { code, length: numeric[0].length };
  }
  // The longest name wins, so that `\SOH` is not read as `\SO` followed by `H`.
  let best: { code: number; length: number } | undefined;
  for (const [code, name] of ASCII_NAMES.entries()) {
    if (body.startsWith(name, index) && (!best || name.length > best.length)) {
      best = { code: name === 'SP' ? 32 : code, length: name.length };
    }
  }
  if (body.startsWith('DEL', index)) best = { code: 127, length: 3 };
  if (best) return best;
  throw syntaxError(span, '文字のエスケープの書き方に誤りがあります。');
}
