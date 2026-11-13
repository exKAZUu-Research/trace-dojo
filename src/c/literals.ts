import { CompileError } from '../interpreter/diagnostics';
import { type Scalar, toInt32 } from './arith';
import { type CType, DOUBLE, FLOAT, INT, INT_PROPERTIES, type IntName, LDOUBLE } from './types';
import { unsupported } from './unsupported';

/** The type and value of a number literal, as C17's rules for integer constants choose the type. */
export function parseNumber(text: string, row: number): { type: CType; value: Scalar } {
  const fail = (): never => {
    throw new CompileError([{ row, message: `数「${text}」の書き方に誤りがあります。` }]);
  };
  if (/^0[bB]/.test(text)) unsupported(row, '2進数のリテラル（0b...）');
  if (text.includes("'")) fail();
  const isHex = /^0[xX]/.test(text);
  if (isHex ? /[pP]/.test(text) : /[.eE]/.test(text)) {
    if (isHex) unsupported(row, '16進数の浮動小数点数のリテラル');
    return parseFloating(text, fail);
  }
  return parseInteger(text, row, isHex, fail);
}

function parseFloating(text: string, fail: () => never): { type: CType; value: Scalar } {
  const match = /^(\d*\.?\d*(?:[eE][+-]?\d+)?)([fFlL]?)$/.exec(text);
  if (!match || !/\d/.test(match[1]) || /[eE]$/.test(match[1])) return fail();
  const value = Number(match[1]);
  const suffix = match[2].toLowerCase();
  if (suffix === 'f') return { type: FLOAT, value: Math.fround(value) };
  return { type: suffix === 'l' ? LDOUBLE : DOUBLE, value };
}

// code-gauge-allow functionCognitiveComplexity 17 -- C suffix and radix rules choose from one ordered set of integer types; splitting them obscures that selection.
function parseInteger(text: string, row: number, isHex: boolean, fail: () => never): { type: CType; value: Scalar } {
  const match = /^(0[xX][\da-fA-F]+|\d+)([uUlL]*)$/.exec(text);
  if (!match) return fail();
  const [, digits, rawSuffix] = match;
  const suffix = rawSuffix.toLowerCase();
  if (!['', 'u', 'l', 'ul', 'lu', 'll', 'ull', 'llu'].includes(suffix)) fail();
  if (rawSuffix.includes('lL') || rawSuffix.includes('Ll')) fail();
  if (suffix.includes('ll')) unsupported(row, 'long long（LL の付いた数）');
  const isOctal = !isHex && digits.length > 1 && digits.startsWith('0');
  if (isOctal && /[89]/.test(digits)) fail();
  const value = BigInt(isOctal ? `0o${digits.slice(1)}` : digits);
  for (const name of integerCandidates(suffix.includes('u'), suffix.includes('l'), !isHex && !isOctal)) {
    if (value <= INT_PROPERTIES[name].max) {
      const type: CType = { kind: 'int', name };
      return { type, value: INT_PROPERTIES[name].size === 8 ? value : Number(value) };
    }
  }
  // clang gives a decimal literal too large for long long the type unsigned long long, with a warning.
  if (value <= INT_PROPERTIES.ullong.max) return { type: { kind: 'int', name: 'ulong' }, value };
  throw new CompileError([{ row, message: `数「${text}」は大きすぎて、どの整数の型にも入りません。` }]);
}

/** The types an integer constant may have, in the order C17 tries them. */
function integerCandidates(unsigned: boolean, long: boolean, isDecimal: boolean): IntName[] {
  if (unsigned) return long ? ['ulong', 'ullong'] : ['uint', 'ulong', 'ullong'];
  if (isDecimal) return long ? ['long', 'llong'] : ['int', 'long', 'llong'];
  return long ? ['long', 'ulong', 'llong', 'ullong'] : ['int', 'uint', 'long', 'ulong', 'llong', 'ullong'];
}

const SIMPLE_ESCAPES: Record<string, number> = {
  n: 10,
  t: 9,
  r: 13,
  '\\': 92,
  "'": 39,
  '"': 34,
  '?': 63,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
  e: 27,
};

/** The bytes of a literal's body, with escapes decoded and other characters in UTF-8. */
// code-gauge-allow functionCognitiveComplexity 21 -- Escape forms share the literal byte cursor and diagnostics; keep the decoding alternatives together.
// code-gauge-allow functionNcss 41 -- Escape forms share the literal byte cursor and diagnostics; keep the decoding alternatives together.
function decodeBody(body: string, row: number): number[] {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < body.length;) {
    const char = body[index];
    if (char !== '\\') {
      const codePoint = body.codePointAt(index) as number;
      const text = String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(text));
      index += text.length;
      continue;
    }
    const next = body[index + 1];
    if (next in SIMPLE_ESCAPES) {
      bytes.push(SIMPLE_ESCAPES[next]);
      index += 2;
      continue;
    }
    if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1))?.[0] as string;
      const value = Number.parseInt(octal, 8);
      if (value > 255) throw new CompileError([{ row, message: '8進数のエスケープシーケンスの値が大きすぎます。' }]);
      bytes.push(value);
      index += 1 + octal.length;
      continue;
    }
    if (next === 'x') {
      const hex = /^[\da-fA-F]+/.exec(body.slice(index + 2))?.[0];
      if (!hex) throw new CompileError([{ row, message: String.raw`\x の後には16進数を書いてください。` }]);
      const value = Number.parseInt(hex, 16);
      if (hex.replace(/^0+/, '').length > 2)
        throw new CompileError([{ row, message: '16進数のエスケープシーケンスの値が大きすぎます。' }]);
      bytes.push(value);
      index += 2 + hex.length;
      continue;
    }
    if (next === 'u' || next === 'U') unsupported(row, String.raw`ユニバーサル文字名（\u・\U）`);
    // clang warns about an unknown escape and keeps the character after the backslash.
    const codePoint = body.codePointAt(index + 1) as number;
    const text = String.fromCodePoint(codePoint);
    bytes.push(...encoder.encode(text));
    index += 1 + text.length;
  }
  return bytes;
}

function checkPrefix(text: string, row: number, what: string): string {
  const prefix = /^(u8|u|U|L)/.exec(text)?.[0];
  if (prefix) unsupported(row, prefix === 'u8' ? `u8 の付いた${what}` : `ワイド文字（${prefix} の付いた${what}）`);
  return text;
}

/** The value of a character constant, which has the type int in C. */
export function decodeCharLiteral(text: string, row: number): number {
  checkPrefix(text, row, '文字定数');
  const bytes = decodeBody(text.slice(1, -1), row);
  if (bytes.length === 0) throw new CompileError([{ row, message: "空の文字定数（''）は書けません。" }]);
  if (bytes.length === 1) return (bytes[0] << 24) >> 24;
  if (bytes.length > 4) throw new CompileError([{ row, message: '文字定数が長すぎます。' }]);
  // clang gives a multi-character constant the value of its bytes, the first one highest.
  let value = 0;
  for (const byte of bytes) value = toInt32((value << 8) | byte);
  return value;
}

/** The bytes of adjacent string literals joined into one, with the terminating null character. */
export function decodeStringLiteral(parts: string[], row: number): Uint8Array {
  const bytes: number[] = [];
  for (const part of parts) {
    checkPrefix(part, row, '文字列');
    bytes.push(...decodeBody(part.slice(1, -1), row));
  }
  bytes.push(0);
  return Uint8Array.from(bytes);
}

export { INT };
