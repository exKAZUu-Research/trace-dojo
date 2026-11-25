import { compileError as syntaxError } from './errors';
import type { FeatureGates } from './features';
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
const STRING_GAP_WHITESPACE = /^[\t\n\v\f\r ]+$/;
const WHITESPACE_ONLY = /^[\t\n\v\f\r ]*$/;
const LEADING_WHITESPACE = /^[\t\n\v\f\r ]*/;

export type NumberLiteralOptions = FeatureGates<'convert'>;

export type NumberLiteral = { kind: 'int'; value: bigint } | { kind: 'frac'; value: number; text: string };

/**
 * Reads a number literal. A fractional literal keeps an exact decimal text, which fractional types convert from; a
 * hexadecimal one is written out in decimal, which its binary exponent always allows.
 */
export function parseNumberLiteral(source: string, span: Span, options: NumberLiteralOptions): NumberLiteral {
  let text = source;
  if (text.includes('_')) {
    if (!options.allows('numericUnderscores')) {
      throw syntaxError(span, '数の区切りの _ を使うには、NumericUnderscores の拡張が要ります。');
    }
    text = text.replaceAll('_', '');
  }
  if (/^0[bB]/.test(text)) {
    if (!options.allows('binaryLiterals'))
      throw syntaxError(span, '2進数のリテラルを使うには、BinaryLiterals の拡張が要ります。');
    if (!/^0[bB][01]+$/.test(text)) throw syntaxError(span, '書き方に誤りがあります。');
    return { kind: 'int', value: BigInt(`0b${text.slice(2)}`) };
  }
  if (/^0[oO][0-7]+$/.test(text)) return { kind: 'int', value: BigInt(`0o${text.slice(2)}`) };
  if (/^0[xX][\dA-Fa-f]+$/.test(text)) return { kind: 'int', value: BigInt(`0x${text.slice(2)}`) };
  if (/^0[xX]/.test(text)) {
    if (!options.allows('hexFloatLiterals')) {
      throw syntaxError(span, '16進数の小数を使うには、HexFloatLiterals の拡張が要ります。');
    }
    text = hexFloatToDecimal(text, span);
  }
  if (/^\d+$/.test(text)) return { kind: 'int', value: BigInt(text) };
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw syntaxError(span, '書き方に誤りがあります。');
  if (options.allows('numDecimals')) {
    const fraction = match[2] ?? '';
    const exponent = Number(match[3] ?? '0') - fraction.length;
    const digits = `${match[1]}${fraction}`.replace(/^0+(?=\d)/, '');
    if (exponent >= 0 && exponent < 100_000) return { kind: 'int', value: BigInt(digits) * 10n ** BigInt(exponent) };
    if (exponent < 0 && /^0+$/.test(digits.slice(exponent)))
      return { kind: 'int', value: BigInt(digits.slice(0, exponent) || '0') };
  }
  return { kind: 'frac', value: Number(text), text };
}

function hexFloatToDecimal(text: string, span: Span): string {
  const match = /^0[xX]([\dA-Fa-f]+)(?:\.([\dA-Fa-f]+))?(?:[pP]([+-]?\d+))?$/.exec(text);
  if (!match) throw syntaxError(span, '書き方に誤りがあります。');
  const fraction = match[2] ?? '';
  const mantissa = BigInt(`0x${match[1]}${fraction}`);
  const exponent = Number(match[3] ?? '0') - 4 * fraction.length;
  if (Math.abs(exponent) > 100_000) throw syntaxError(span, '数のリテラルが大きすぎます。');
  if (exponent >= 0) return `${mantissa * 2n ** BigInt(exponent)}.0`;
  const scaled = (mantissa * 5n ** BigInt(-exponent)).toString().padStart(-exponent + 1, '0');
  return `${scaled.slice(0, exponent)}.${scaled.slice(exponent)}`;
}

export function parseCharLiteral(text: string, span: Span): string {
  const body = literalBody(text, "'", span);
  const chars = readChars(body, span, false);
  if (chars.length !== 1) throw syntaxError(span, '文字のリテラルには、1文字だけを書いてください。');
  return chars[0];
}

export function parseStringLiteral(text: string, span: Span, multiline = false): string[] {
  if (text.startsWith('"""')) {
    if (!multiline) throw syntaxError(span, '複数行の文字列を使うには、MultilineStrings の拡張が要ります。');
    return readMultilineString(text, span);
  }
  const body = literalBody(text, '"', span);
  return readChars(body, span, true);
}

/**
 * Reads a `"""` string as GHC's MultilineStrings does (GHC.Parser.String's `lexMultilineString`): on the source text,
 * before it reads escapes, it collapses string gaps, splits lines, expands leading tabs, removes the indentation the
 * lines after the first share, empties those lines of only whitespace, and drops a leading and a trailing newline.
 */
function readMultilineString(text: string, span: Span): string[] {
  if (text.length < 6 || !text.endsWith('"""')) throw syntaxError(span, 'リテラルの区切りの書き方に誤りがあります。');
  const lines = collapseGaps(text.slice(3, -3), span)
    .split(/\r\n|[\n\r\f]/)
    .map((line) => line.replace(/^[\t ]+/, (indent) => expandTabs(indent)));
  const indents = lines
    .slice(1)
    .filter((line) => !WHITESPACE_ONLY.test(line))
    .map((line) => LEADING_WHITESPACE.exec(line)![0].length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  const trimmed = lines.map((line, index) => {
    if (index === 0) return line;
    const dedented = line.slice(common);
    return WHITESPACE_ONLY.test(dedented) ? '' : dedented;
  });
  let joined = trimmed.join('\n');
  if (joined.startsWith('\n')) joined = joined.slice(1);
  if (joined.endsWith('\n')) joined = joined.slice(0, -1);
  return readChars(escapeBareQuotes(joined), span, true);
}

/**
 * Replaces each string gap with `\&`, which keeps a numeric escape before it from taking the digits after it, and
 * leaves the escapes `\\` and `\^\` whole, whose backslashes open no gap.
 */
function collapseGaps(body: string, span: Span): string {
  let result = '';
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char !== '\\') {
      result += char;
      index++;
    } else if (STRING_GAP_WHITESPACE.test(body[index + 1] ?? '')) {
      const close = body.indexOf('\\', index + 1);
      if (close === -1 || !STRING_GAP_WHITESPACE.test(body.slice(index + 1, close))) {
        throw syntaxError(span, String.raw`文字列の継続（\ と \ の間）の書き方に誤りがあります。`);
      }
      result += String.raw`\&`;
      index = close + 1;
    } else {
      const length = body.startsWith(String.raw`\\`, index) ? 2 : body.startsWith('\\^\\', index) ? 3 : 1;
      result += body.slice(index, index + length);
      index += length;
    }
  }
  return result;
}

/** Escapes the quotes, newlines, and tabs a multiline string holds as they are, which an ordinary string cannot. */
function escapeBareQuotes(body: string): string {
  let result = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '\\') {
      result += body.slice(index, index + 2);
      index++;
    } else
      result += char === '"' ? String.raw`\"` : char === '\n' ? String.raw`\n` : char === '\t' ? String.raw`\t` : char;
  }
  return result;
}

function expandTabs(indent: string): string {
  let column = 0;
  for (const char of indent) column = char === '\t' ? column + 8 - (column % 8) : column + 1;
  return ' '.repeat(column);
}

function literalBody(text: string, quote: string, span: Span): string {
  if (text.length < 2 || !text.startsWith(quote) || !text.endsWith(quote))
    throw syntaxError(span, 'リテラルの区切りの書き方に誤りがあります。');
  return text.slice(1, -1);
}

function readChars(body: string, span: Span, isString: boolean): string[] {
  const chars: string[] = [];
  let index = 0;
  while (index < body.length) {
    const char = String.fromCodePoint(body.codePointAt(index) as number);
    if (char !== '\\') {
      chars.push(graphicChar(char, span, isString));
      index += char.length;
      continue;
    }
    index++;
    const next = body[index];
    if (next === undefined) throw syntaxError(span, '文字のエスケープの書き方に誤りがあります。');
    if (isString && STRING_GAP_WHITESPACE.test(next)) {
      const close = body.indexOf('\\', index);
      if (close === -1 || !STRING_GAP_WHITESPACE.test(body.slice(index, close))) {
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
  return chars;
}

function graphicChar(char: string, span: Span, isString: boolean): string {
  if (char === (isString ? '"' : "'") || !/^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]$/u.test(char))
    throw syntaxError(span, '文字の書き方に誤りがあります。');
  return char;
}

// code-gauge-allow functionCognitiveComplexity -- One branch per escape form of the Haskell report.
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
