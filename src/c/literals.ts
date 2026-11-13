import { CompileError } from '../interpreter/diagnostics';
import { type Scalar, toInt32 } from './arith';
import { parseFloatPrefix } from './library/numberParsing';
import { type CType, DOUBLE, FLOAT, INT, INT_PROPERTIES, type IntName, LDOUBLE } from './types';
import { unsupported } from './unsupported';

/** The type and value of a number literal, as C17's rules for integer constants choose the type. */
export function parseNumber(text: string, row: number): { type: CType; value: Scalar } {
  const fail = (): never => {
    throw new CompileError([{ row, message: `数「${text}」の書き方に誤りがあります。` }]);
  };
  if (text.includes("'")) fail();
  const isHex = /^0[xX]/.test(text);
  if (isHex ? /[pP]/.test(text) : /[.eE]/.test(text) && !/^0[bB]/.test(text)) {
    return isHex ? parseHexFloating(text, fail) : parseFloating(text, fail);
  }
  return parseInteger(text, row, isHex, fail);
}

/** A hexadecimal floating constant, such as `0x1.8p3`, whose binary exponent `p` C requires. */
function parseHexFloating(text: string, fail: () => never): { type: CType; value: Scalar } {
  const match = /^(0[xX](?:[\da-fA-F]+\.?[\da-fA-F]*|\.[\da-fA-F]+)[pP][+-]?\d+)([fFlL]?)$/.exec(text);
  if (!match) return fail();
  const { value } = parseFloatPrefix(new TextEncoder().encode(match[1]));
  const suffix = match[2].toLowerCase();
  if (suffix === 'f') return { type: FLOAT, value: Math.fround(value) };
  return { type: suffix === 'l' ? LDOUBLE : DOUBLE, value };
}

function parseFloating(text: string, fail: () => never): { type: CType; value: Scalar } {
  const match = /^(\d*\.?\d*(?:[eE][+-]?\d+)?)([fFlL]?)$/.exec(text);
  if (!match || !/\d/.test(match[1]) || /[eE]$/.test(match[1])) return fail();
  const value = Number(match[1]);
  const suffix = match[2].toLowerCase();
  if (suffix === 'f') return { type: FLOAT, value: Math.fround(value) };
  return { type: suffix === 'l' ? LDOUBLE : DOUBLE, value };
}

function parseInteger(text: string, row: number, isHex: boolean, fail: () => never): { type: CType; value: Scalar } {
  const match = /^(0[xX][\da-fA-F]+|0[bB][01]+|\d+)([uUlL]*)$/.exec(text);
  if (!match) return fail();
  const [, digits, rawSuffix] = match;
  const suffix = rawSuffix.toLowerCase();
  if (!['', 'u', 'l', 'ul', 'lu', 'll', 'ull', 'llu'].includes(suffix)) fail();
  if (rawSuffix.includes('lL') || rawSuffix.includes('Ll')) fail();
  const isBinary = /^0[bB]/.test(digits);
  const isOctal = !isHex && !isBinary && digits.length > 1 && digits.startsWith('0');
  if (isOctal && /[89]/.test(digits)) fail();
  const value = BigInt(isOctal ? `0o${digits.slice(1)}` : digits);
  const length = suffix.includes('ll') ? 2 : suffix.includes('l') ? 1 : 0;
  for (const name of integerCandidates(suffix.includes('u'), length, !isHex && !isOctal && !isBinary)) {
    if (value <= INT_PROPERTIES[name].max) {
      const type: CType = { kind: 'int', name };
      return { type, value: INT_PROPERTIES[name].size === 8 ? value : Number(value) };
    }
  }
  // clang gives a decimal literal too large for long long the type unsigned long long, with a warning.
  if (value <= INT_PROPERTIES.ullong.max) return { type: { kind: 'int', name: 'ulong' }, value };
  throw new CompileError([{ row, message: `数「${text}」は大きすぎて、どの整数の型にも入りません。` }]);
}

/** The types an integer constant may have, in the order C17 tries them; `long` counts the `l`s of its suffix. */
function integerCandidates(unsigned: boolean, long: number, isDecimal: boolean): IntName[] {
  const all: IntName[] =
    isDecimal && !unsigned ? ['int', 'long', 'llong'] : ['int', 'uint', 'long', 'ulong', 'llong', 'ullong'];
  const rank = ['int', 'long', 'llong'][long];
  const start = all.findIndex((name) => name.replace(/^u/, '') === rank);
  return all.slice(start).filter((name) => !unsigned || name.startsWith('u'));
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
    if (next === 'u' || next === 'U') {
      const digits = next === 'u' ? 4 : 8;
      const hex = body.slice(index + 2, index + 2 + digits);
      if (!new RegExp(`^[\\da-fA-F]{${digits}}$`).test(hex)) {
        throw new CompileError([{ row, message: `\\${next} の後には16進数を${digits}桁書いてください。` }]);
      }
      const codePoint = Number.parseInt(hex, 16);
      const allowed = codePoint >= 0xa0 || codePoint === 0x24 || codePoint === 0x40 || codePoint === 0x60;
      if (!allowed || (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff) || codePoint > 0x10_ff_ff) {
        throw new CompileError([{ row, message: `ユニバーサル文字名「\\${next}${hex}」では、この文字は書けません。` }]);
      }
      bytes.push(...encoder.encode(String.fromCodePoint(codePoint)));
      index += 2 + digits;
      continue;
    }
    // clang warns about an unknown escape and keeps the character after the backslash.
    const codePoint = body.codePointAt(index + 1) as number;
    const text = String.fromCodePoint(codePoint);
    bytes.push(...encoder.encode(text));
    index += 1 + text.length;
  }
  return bytes;
}

/** The body of a literal without its quotes, rejecting the prefixes of wide characters, which need wchar.h. */
function literalBody(text: string, row: number, what: string): string {
  const prefix = /^(u8|u|U|L)/.exec(text)?.[0];
  // A u8 string holds UTF-8, as every string does here; a u8 character constant is C23's.
  if (prefix === 'u8' && what === '文字列') return text.slice(3, -1);
  if (prefix) unsupported(row, prefix === 'u8' ? `u8 の付いた${what}` : `ワイド文字（${prefix} の付いた${what}）`);
  return text.slice(1, -1);
}

/** The value of a character constant, which has the type int in C. */
export function decodeCharLiteral(text: string, row: number): number {
  const bytes = decodeBody(literalBody(text, row, '文字定数'), row);
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
    bytes.push(...decodeBody(literalBody(part, row, '文字列'), row));
  }
  bytes.push(0);
  return Uint8Array.from(bytes);
}

export { INT };
