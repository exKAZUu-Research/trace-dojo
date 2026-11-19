import type { CompileError } from '../interpreter/diagnostics';

type Fail = (message: string) => CompileError;

const LONG_MAX = 2n ** 63n - 1n;
const ULONG_MAX = 2n ** 64n - 1n;

/** Reads an integer literal such as `1_000`, `0xFF`, `3L`, or `2u`, whose type the compiler decides from its value. */
// code-gauge-allow functionCognitiveComplexity 17 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
export function parseIntegerLiteral(
  text: string,
  fail: Fail,
  allowsBinary: boolean
): { kind: 'integer'; text: string; value: bigint; suffix: '' | 'L' | 'u' | 'uL'; isHex: boolean } {
  const match = /^(0[xX][\dA-Fa-f_]+|0[bB][01_]+|[\d_]+)([uU]?L?|l)?$/.exec(text);
  if (!match) throw fail('数の書き方に誤りがあります。');
  const [, digitsText, suffixText = ''] = match;
  if (suffixText === 'l') throw fail('Long の数には、小文字の l ではなく大文字の L を付けてください。');
  if (/^0[bB]/.test(digitsText) && !allowsBinary) throw fail('2進数のリテラルは、この採点環境では使えません。');
  const body = digitsText.replace(/^0[xXbB]/, '');
  if (body.startsWith('_') || body.endsWith('_') || body === '') throw fail('数の書き方に誤りがあります。');
  if (/^0\d/.test(digitsText)) throw fail('0 で始まる10進数は書けません。');
  const value = BigInt(digitsText.replaceAll('_', ''));
  const suffix =
    suffixText.toLowerCase() === 'ul' ? 'uL' : suffixText.toLowerCase() === 'u' ? 'u' : suffixText === 'L' ? 'L' : '';
  if (value > (suffix === 'u' || suffix === 'uL' ? ULONG_MAX : LONG_MAX)) throw fail('数が大きすぎます。');
  return { kind: 'integer', text, value, suffix, isHex: /^0[xX]/.test(digitsText) };
}

/** Reads a floating-point literal such as `1.5`, `.5`, `1e3`, or `2.5f`. */
export function parseRealLiteral(
  text: string,
  fail: Fail
): { kind: 'real'; text: string; value: number; isFloat: boolean } {
  const match = /^((?:[\d_]*\.[\d_]+|[\d_]+)(?:[eE][+-]?[\d_]+)?)([fF])?$/.exec(text);
  if (!match || /(^|[.eE+-])_|_($|[.eE])/.test(match[1])) throw fail('数の書き方に誤りがあります。');
  const isFloat = match[2] !== undefined;
  const parsed = Number(match[1].replaceAll('_', ''));
  const value = isFloat ? Math.fround(parsed) : parsed;
  if (!Number.isFinite(value)) throw fail('数が大きすぎます。');
  return { kind: 'real', text, value, isFloat };
}

/** Reads a character literal, which holds one UTF-16 code unit, as Kotlin's `Char` does. */
export function decodeCharLiteral(text: string, fail: Fail): number {
  const body = text.slice(1, -1);
  const decoded = body.startsWith('\\') ? decodeEscape(body, fail) : body;
  if (decoded.length !== 1)
    throw fail(decoded.length === 0 ? '空の文字リテラルは書けません。' : '文字リテラルには1文字だけ書けます。');
  // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units.
  return decoded.charCodeAt(0);
}

const SIMPLE_ESCAPES: Record<string, string> = {
  t: '\t',
  b: '\b',
  n: '\n',
  r: '\r',
  "'": "'",
  '"': '"',
  '\\': '\\',
  $: '$',
};

/** Decodes an escape sequence of a character or string literal. */
export function decodeEscape(text: string, fail: Fail): string {
  if (text.startsWith(String.raw`\u`)) {
    if (!/^\\u[\dA-Fa-f]{4}$/.test(text)) throw fail(String.raw`\u のあとには16進数を4桁書いてください。`);
    // oxlint-disable-next-line unicorn/prefer-code-point -- A \u escape writes one UTF-16 code unit, which may be half a surrogate pair.
    return String.fromCharCode(Number.parseInt(text.slice(2), 16));
  }
  const escaped = SIMPLE_ESCAPES[text.slice(1)];
  if (text.length !== 2 || escaped === undefined) throw fail(`${text} というエスケープはありません。`);
  return escaped;
}

/** The value of an integer literal, which may also stand for a `Long`, `Short`, `Byte`, or unsigned value. */
export interface IntegerLiteral {
  value: bigint;
  isUnsigned: boolean;
  isLong: boolean;
}

/** Whether an integer literal's value fits the integer class `className`, to which it may convert. */
export function literalFits(literal: IntegerLiteral, className: string): boolean {
  const { value, isUnsigned, isLong } = literal;
  const ranges: Record<string, [bigint, bigint, boolean]> = {
    Byte: [-128n, 127n, false],
    Short: [-32_768n, 32_767n, false],
    Int: [-(2n ** 31n), 2n ** 31n - 1n, false],
    Long: [-(2n ** 63n), 2n ** 63n - 1n, false],
    UByte: [0n, 255n, true],
    UShort: [0n, 65_535n, true],
    UInt: [0n, 2n ** 32n - 1n, true],
    ULong: [0n, 2n ** 64n - 1n, true],
  };
  const range = ranges[className];
  if (!range || range[2] !== isUnsigned) return false;
  if (isLong && className !== 'Long' && className !== 'ULong') return false;
  return value >= range[0] && value <= range[1];
}
