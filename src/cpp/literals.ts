import { roundBinary } from '../c/library/binaryFloat';
import { compileError, unsupported } from './errors';
import type { Syntax } from './syntax';
import { type FloatType, intMax, type IntName, type IntType } from './types';

/** The value and type of an integer or floating-point literal, as clang++ reads it. */
export function numberLiteral(node: Syntax): { type: IntType | FloatType; value: number | bigint } {
  const text = node.text.replaceAll("'", '');
  const lower = text.toLowerCase();
  const isHex = lower.startsWith('0x');
  const isFloat = isHex ? lower.includes('p') : /[.e]/.test(lower) && !lower.startsWith('0b');
  if (isFloat) return floatLiteral(node, lower, isHex);
  const match = /^(0x[\da-f]+|0b[01]+|0[0-7]*|[1-9]\d*)([ul]*|z|uz|zu)$/.exec(lower);
  if (!match) return compileError(node.row, `${node.text} は数として読めません。`);
  const [, digits, suffix] = match;
  const value = parseInteger(digits);
  const isDecimal = !(digits.startsWith('0') && digits.length > 1);
  const type = integerLiteralType(value, suffix, isDecimal);
  if (!type) return compileError(node.row, `整数リテラル ${node.text} が大きすぎます。`);
  const wide = type === 'long' || type === 'ulong' || type === 'llong' || type === 'ullong';
  return { type: { kind: 'int', name: type }, value: wide ? value : Number(value) };
}

function parseInteger(digits: string): bigint {
  if (digits.startsWith('0b')) return BigInt(digits);
  if (digits.startsWith('0x')) return BigInt(digits);
  if (digits.length > 1 && digits.startsWith('0')) return BigInt(`0o${digits.slice(1)}`);
  return BigInt(digits);
}

/** The first type of the literal's list (C++20 [lex.icon]) that holds its value. */
function integerLiteralType(value: bigint, suffix: string, isDecimal: boolean): IntName | undefined {
  const isUnsigned = suffix.includes('u');
  const longs = suffix.replaceAll('u', '').length;
  if (suffix.includes('z')) return isUnsigned ? 'ulong' : 'long';
  let candidates: IntName[];
  if (isUnsigned)
    candidates = longs === 2 ? ['ullong'] : longs === 1 ? ['ulong', 'ullong'] : ['uint', 'ulong', 'ullong'];
  else if (isDecimal) candidates = longs === 2 ? ['llong'] : longs === 1 ? ['long', 'llong'] : ['int', 'long', 'llong'];
  else {
    candidates =
      longs === 2
        ? ['llong', 'ullong']
        : longs === 1
          ? ['long', 'ulong', 'llong', 'ullong']
          : ['int', 'uint', 'long', 'ulong', 'llong', 'ullong'];
  }
  const found = candidates.find((name) => value <= intMax(name));
  // clang++ reads a decimal literal too large for every signed type as unsigned long long, with a warning.
  if (!found && isDecimal && !isUnsigned && value <= intMax('ullong')) return 'ullong';
  return found;
}

function floatLiteral(node: Syntax, lower: string, isHex: boolean): { type: FloatType; value: number } {
  let body = lower;
  let name: FloatType['name'] = 'double';
  if (!isHex || /p[+-]?\d+[fl]$/.test(lower)) {
    if (body.endsWith('f')) {
      name = 'float';
      body = body.slice(0, -1);
    } else if (body.endsWith('l')) {
      name = 'ldouble';
      body = body.slice(0, -1);
    }
  }
  const value = isHex ? hexFloat(body, name === 'float') : name === 'float' ? decimalFloat(body) : Number(body);
  if (Number.isNaN(value)) return compileError(node.row, `${node.text} は数として読めません。`);
  return { type: { kind: 'float', name }, value };
}

function hexFloat(text: string, isFloat: boolean): number {
  const match = /^0x([\da-f]*)\.?([\da-f]*)p([+-]?\d+)$/.exec(text);
  if (!match) return Number.NaN;
  const [, whole, fraction, exponent] = match;
  const digits = whole + fraction;
  if (!digits) return Number.NaN;
  return roundBinary(BigInt(`0x${digits}`), 1n, Number(exponent) - 4 * fraction.length, isFloat);
}

function decimalFloat(text: string): number {
  const match = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(text);
  if (!match || !(match[1] || match[2])) return Number.NaN;
  const fraction = match[2] ?? '';
  const digits = (match[1] + fraction).replace(/^0+/, '');
  if (!digits) return 0;
  const power = Number(match[3] ?? 0) - fraction.length;
  const decimalExponent = power + digits.length - 1;
  if (decimalExponent > 38) return Number.POSITIVE_INFINITY;
  if (decimalExponent < -46) return 0;
  const coefficient = BigInt(digits);
  return power < 0
    ? roundBinary(coefficient, 10n ** BigInt(-power), 0, true)
    : roundBinary(coefficient * 10n ** BigInt(power), 1n, 0, true);
}

/** The bytes a character or string literal's content stands for, in UTF-8, with its escapes resolved. */
export function literalBytes(parts: readonly Syntax[]): string {
  let bytes = '';
  for (const part of parts) {
    if (!part.isNamed) continue;
    bytes += part.type.endsWith('escape_sequence') ? escapeBytes(part) : utf8(part.text);
  }
  return bytes;
}

/** Encodes text as UTF-8, as a string of character codes below 256. */
export function utf8(text: string): string {
  // oxlint-disable-next-line no-control-regex -- ASCII text encodes to itself.
  if (/^[\u0000-\u007F]*$/.test(text)) return text;
  return String.fromCodePoint(...new TextEncoder().encode(text));
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\u0007',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

function escapeBytes(part: Syntax): string {
  const body = part.text.slice(1);
  if (body in SIMPLE_ESCAPES) return SIMPLE_ESCAPES[body];
  // A backslash at the end of a line splices the lines (C++20 [lex.phases]), which the grammar reads as an escape.
  if (/^\r?\n$/.test(body)) return '';
  if (/^[0-7]{1,3}$/.test(body)) return numericEscape(part, body, 8);
  if (/^x[\da-fA-F]+$/.test(body)) return numericEscape(part, body.slice(1), 16);
  if (/^[uU]/.test(body)) {
    const point = /^u[\da-fA-F]{4}$|^U[\da-fA-F]{8}$/.test(body) ? Number.parseInt(body.slice(1), 16) : Number.NaN;
    if (!Number.isInteger(point) || point > 0x10_ff_ff || (point >= 0xd8_00 && point <= 0xdf_ff))
      return compileError(part.row, `${part.text} は有効な Unicode エスケープではありません。`);
    return utf8(String.fromCodePoint(point));
  }
  // clang++ warns of an unknown escape and keeps the character.
  return utf8(body);
}

function numericEscape(part: Syntax, digits: string, base: 8 | 16): string {
  const value = Number.parseInt(digits, base);
  if (value > Number(intMax('uchar'))) {
    return compileError(part.row, `${part.text} は、文字の値の範囲を超えています。`);
  }
  return String.fromCodePoint(value);
}

/** Rejects the prefixes of wide and Unicode literals, which the interpreter leaves out. */
export function checkLiteralPrefix(node: Syntax): void {
  const prefix = /^(u8|u|U|L)(?=['"])/.exec(node.text);
  if (prefix) unsupported(node.row, `接頭辞 ${prefix[1]} の付いた文字・文字列リテラル`);
}
