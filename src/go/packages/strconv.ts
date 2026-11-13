// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { formatFloat } from '../floatFormat';
import { decodeRune, encodeRune, RUNE_ERROR } from '../literals';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { canBackquote, isGraphic, isPrint, quote, quoteChunks, quoteRune, quoteRuneChunks } from '../quote';
import { appendValues, moveToHeap } from '../sliceOps';
import { BASIC, ERROR_TYPE, pointerTo, RUNE } from '../types';
import { Cell, Complex, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import {
  appendBytes,
  BOOL,
  BYTES,
  errorText,
  FLOAT64,
  INT,
  receiverStruct,
  spendFor,
  STRING,
  stringPanic,
} from './support';

const ERR_SYNTAX = newError('invalid syntax');
const ERR_RANGE = newError('value out of range');

/** `*strconv.NumError`, with its exported fields Func, Num, and Err. */
const NUM_ERROR = namedType('strconv', 'NumError', {
  kind: 'struct',
  fields: [
    { name: 'Func', type: STRING, embedded: false },
    { name: 'Num', type: STRING, embedded: false },
    { name: 'Err', type: ERROR_TYPE, embedded: false },
  ],
});
addMethod(
  NUM_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => {
    const [func, num, error] = receiverStruct(receiver).fields as [string, string, Value];
    return `strconv.${func}: parsing ${quote(num)}: ${errorText(error)}`;
  },
  true
);
addMethod(NUM_ERROR, 'Unwrap', fn([], [ERROR_TYPE]), (receiver) => receiverStruct(receiver).fields[2], true);

function numError(func: string, num: string, error: Value): Value {
  return new Iface(pointerTo(NUM_ERROR), new Pointer(new Cell(new GoStruct([func, num, error])), 'v'));
}

export function renamed(error: Value, func: string, num: string): Value {
  const struct = ((error as Iface).value as Pointer).load() as GoStruct;
  struct.fields[0] = func;
  struct.fields[1] = num;
  return error;
}

function lower(char: string): string {
  return char.toLowerCase();
}

/** Whether underscores in a number literal separate digits as Go's syntax allows. */
function underscoreOK(text: string): boolean {
  let s = text;
  let saw = '^';
  let i = 0;
  if (s.length > 0 && (s[0] === '-' || s[0] === '+')) s = s.slice(1);
  let hex = false;
  if (s.length >= 2 && s[0] === '0' && 'bBoOxX'.includes(s[1])) {
    i = 2;
    saw = '0';
    hex = lower(s[1]) === 'x';
  }
  for (; i < s.length; i++) {
    const char = s[i];
    if ((char >= '0' && char <= '9') || (hex && lower(char) >= 'a' && lower(char) <= 'f')) {
      saw = '0';
      continue;
    }
    if (char === '_') {
      if (saw !== '0') return false;
      saw = '_';
      continue;
    }
    if (saw === '_') return false;
    saw = '!';
  }
  return saw !== '_';
}

// code-gauge-allow functionCognitiveComplexity 25 -- A transcription of Go's ParseUint.
export function parseUint(text: string, baseArg: number, bitSizeArg: number, func: string): [bigint, Value] {
  if (text === '') return [0n, numError(func, text, ERR_SYNTAX)];
  const base0 = baseArg === 0;
  let base = baseArg;
  let s = text;
  if (base === 0) {
    base = 10;
    if (s[0] === '0') {
      if (s.length >= 3 && lower(s[1]) === 'b') [base, s] = [2, s.slice(2)];
      else if (s.length >= 3 && lower(s[1]) === 'o') [base, s] = [8, s.slice(2)];
      else if (s.length >= 3 && lower(s[1]) === 'x') [base, s] = [16, s.slice(2)];
      else [base, s] = [8, s.slice(1)];
    }
  } else if (base < 2 || base > 36) {
    return [0n, numError(func, text, newError(`invalid base ${base}`))];
  }
  let bitSize = bitSizeArg;
  if (bitSize === 0) bitSize = 64;
  else if (bitSize < 0 || bitSize > 64) return [0n, numError(func, text, newError(`invalid bit size ${bitSize}`))];
  const maxValue = (1n << BigInt(bitSize)) - 1n;
  let value = 0n;
  let underscores = false;
  let overflow = false;
  for (const char of s) {
    let digit: number;
    if (char === '_' && base0) {
      underscores = true;
      continue;
    } else if (char >= '0' && char <= '9') digit = char.charCodeAt(0) - 48;
    else if (lower(char) >= 'a' && lower(char) <= 'z') digit = lower(char).charCodeAt(0) - 87;
    else return [0n, numError(func, text, ERR_SYNTAX)];
    if (digit >= base) return [0n, numError(func, text, ERR_SYNTAX)];
    if (overflow) continue;
    value = value * BigInt(base) + BigInt(digit);
    if (value > maxValue) overflow = true;
  }
  if (overflow) return [maxValue, numError(func, text, ERR_RANGE)];
  if (underscores && !underscoreOK(text)) return [0n, numError(func, text, ERR_SYNTAX)];
  return [value, undefined];
}

export function parseInt(text: string, base: number, bitSizeArg: number, func: string): [bigint, Value] {
  if (text === '') return [0n, numError(func, text, ERR_SYNTAX)];
  let s = text;
  let negative = false;
  if (s[0] === '+') s = s.slice(1);
  else if (s[0] === '-') {
    negative = true;
    s = s.slice(1);
  }
  const [unsigned, error] = parseUint(s, base, bitSizeArg, func);
  if (error !== undefined && (((error as Iface).value as Pointer).load() as GoStruct).fields[2] !== ERR_RANGE) {
    return [0n, renamed(error, func, text)];
  }
  const bitSize = bitSizeArg === 0 ? 64 : bitSizeArg;
  const cutoff = 1n << BigInt(bitSize - 1);
  if (!negative && unsigned >= cutoff) return [cutoff - 1n, numError(func, text, ERR_RANGE)];
  if (negative && unsigned > cutoff) return [-cutoff, numError(func, text, ERR_RANGE)];
  return [negative ? -unsigned : unsigned, undefined];
}

export function parseFloat(text: string, bitSize: number): [number, Value] {
  const [value, size, error] = parseFloatPrefix(text, bitSize);
  if (size !== text.length) return [0, numError('ParseFloat', text, ERR_SYNTAX)];
  return [value, error && numError('ParseFloat', text, error)];
}

// code-gauge-allow functionCognitiveComplexity 20 -- A transcription of Go's ParseComplex.
export function parseComplex(text: string, bitSize: number): [Complex, Value] {
  const size = bitSize === 64 ? 32 : 64;
  const syntaxError: [Complex, Value] = [new Complex(0, 0), numError('ParseComplex', text, ERR_SYNTAX)];
  let pending: Value;
  const result = (value: Complex): [Complex, Value] => [value, pending && numError('ParseComplex', text, pending)];
  let s = text;
  if (s.length >= 2 && s[0] === '(' && s.at(-1) === ')') s = s.slice(1, -1);
  const [re, reSize, reError] = parseFloatPrefix(s, size);
  if (reError === ERR_SYNTAX) return syntaxError;
  pending = reError;
  s = s.slice(reSize);
  if (s === '') return result(new Complex(re, 0));
  switch (s[0]) {
    case '+': {
      if (s.length > 1 && s[1] !== '+') s = s.slice(1);
      break;
    }
    case '-': {
      break;
    }
    case 'i': {
      if (s.length === 1) return result(new Complex(0, re));
      return syntaxError;
    }
    default: {
      return syntaxError;
    }
  }
  const [im, imSize, imError] = parseFloatPrefix(s, size);
  if (imError === ERR_SYNTAX) return syntaxError;
  pending = imError ?? pending;
  if (s.slice(imSize) !== 'i') return syntaxError;
  return result(new Complex(re, im));
}

/** Go's `parseFloatPrefix`: the float at the start of `s`, the bytes it spans, and ErrSyntax or ErrRange. */
function parseFloatPrefix(s: string, bitSize: number): [number, number, Value] {
  const bits = bitSize === 32 ? 32 : 64;
  const specialValue = special(s);
  if (specialValue) return [specialValue[0], specialValue[1], undefined];
  const syntax = readFloat(s);
  if (!syntax) return [0, 0, ERR_SYNTAX];
  const magnitude = floatOf(syntax.mantissa, syntax.exponent, syntax.hex, bits);
  const value = syntax.negative ? -magnitude : magnitude;
  return [value, syntax.size, Number.isFinite(value) ? undefined : ERR_RANGE];
}

function special(s: string): [number, number] | undefined {
  const first = lower(s[0] ?? '');
  if (first === 'n') return commonPrefixLengthIgnoreCase(s, 'nan') === 3 ? [Number.NaN, 3] : undefined;
  const signSize = first === '+' || first === '-' ? 1 : 0;
  if (signSize === 0 && first !== 'i') return undefined;
  let size = commonPrefixLengthIgnoreCase(s.slice(signSize), 'infinity');
  // Anything longer than "inf" is fine, but without the whole "infinity" only "inf" is consumed.
  if (size > 3 && size < 8) size = 3;
  if (size !== 3 && size !== 8) return undefined;
  return [first === '-' ? -Infinity : Infinity, signSize + size];
}

function commonPrefixLengthIgnoreCase(s: string, prefix: string): number {
  const length = Math.min(prefix.length, s.length);
  for (let index = 0; index < length; index++) {
    if (lower(s[index]) !== prefix[index]) return index;
  }
  return length;
}

/** A float's syntax: its value is `mantissa` × 10^`exponent`, or × 2^`exponent` when `hex`. */
interface FloatSyntax {
  mantissa: bigint;
  exponent: number;
  negative: boolean;
  hex: boolean;
  size: number;
}

/**
 * The significant digits that readFloat keeps, as Go's decimal type keeps 800: a value halfway between two floats
 * needs fewer, so the kept digits and whether any dropped digit is nonzero round as all the digits do.
 */
const MAX_KEPT_DIGITS = 800;

// code-gauge-allow functionCognitiveComplexity 45 -- A transcription of Go's readFloat.
function readFloat(s: string): FloatSyntax | undefined {
  let index = 0;
  let underscores = false;
  let negative = false;
  if (s[index] === '+') index++;
  else if (s[index] === '-') {
    index++;
    negative = true;
  }
  let hex = false;
  if (index + 2 < s.length && s[index] === '0' && lower(s[index + 1]) === 'x') {
    index += 2;
    hex = true;
  }
  let sawDot = false;
  let sawDigits = false;
  let digitCount = 0;
  let point = 0;
  let mantissa = 0n;
  let keptDigits = 0;
  let truncated = false;
  for (; index < s.length; index++) {
    const char = s[index];
    if (char === '_') {
      underscores = true;
      continue;
    }
    if (char === '.') {
      if (sawDot) break;
      sawDot = true;
      point = digitCount;
      continue;
    }
    const digit = digitValue(char, hex);
    if (digit < 0) break;
    sawDigits = true;
    if (digit === 0 && digitCount === 0) {
      point--;
      continue;
    }
    digitCount++;
    if (keptDigits < MAX_KEPT_DIGITS) {
      keptDigits++;
      mantissa = mantissa * (hex ? 16n : 10n) + BigInt(digit);
    } else if (digit !== 0) {
      truncated = true;
    }
  }
  spendFor(index);
  if (!sawDigits) return undefined;
  if (truncated) {
    // A nonzero digit after the kept ones stands for all the dropped digits.
    keptDigits++;
    mantissa = mantissa * (hex ? 16n : 10n) + 1n;
  }
  if (!sawDot) point = digitCount;
  if (hex) {
    point *= 4;
    keptDigits *= 4;
  }
  if (index < s.length && lower(s[index]) === (hex ? 'p' : 'e')) {
    index++;
    let sign = 1;
    if (s[index] === '+') index++;
    else if (s[index] === '-') {
      index++;
      sign = -1;
    }
    if (!(s[index] >= '0' && s[index] <= '9')) return undefined;
    let exponent = 0;
    for (; index < s.length && ((s[index] >= '0' && s[index] <= '9') || s[index] === '_'); index++) {
      if (s[index] === '_') {
        underscores = true;
        continue;
      }
      // Go stops accumulating a huge exponent, which then only needs to be out of range.
      if (exponent < 10_000) exponent = exponent * 10 + s.charCodeAt(index) - 48;
    }
    point += exponent * sign;
  } else if (hex) {
    return undefined;
  }
  if (underscores && !underscoreOK(s.slice(0, index))) return undefined;
  return { mantissa, exponent: point - keptDigits, negative, hex, size: index };
}

function digitValue(char: string, hex: boolean): number {
  if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48;
  if (hex && lower(char) >= 'a' && lower(char) <= 'f') return lower(char).charCodeAt(0) - 87;
  return -1;
}

const MAX_FLOAT32 = 3.4028234663852886e38;

/** The float of the given size nearest to `mantissa` × (2 or 10)^`exponent`, or Infinity when it overflows. */
function floatOf(mantissa: bigint, exponent: number, binary: boolean, bits: 32 | 64): number {
  if (mantissa === 0n) return 0;
  // Beyond these magnitudes every float overflows or underflows, so the exact powers need not be computed.
  const magnitude = (binary ? mantissa.toString(2) : mantissa.toString()).length + exponent;
  if (magnitude > (binary ? 2000 : 400)) return Infinity;
  if (magnitude < (binary ? -2000 : -400)) return 0;
  const power = (binary ? 2n : 10n) ** BigInt(Math.abs(exponent));
  return exponent >= 0 ? roundRatio(mantissa * power, 1n, bits) : roundRatio(mantissa, power, bits);
}

/** The float nearest to `numerator` / `denominator` (both positive), rounding ties to even, or Infinity on overflow. */
function roundRatio(numerator: bigint, denominator: bigint, bits: 32 | 64): number {
  const [mantissaBits, minExponent, maxValue] = bits === 64 ? [52, -1022, Number.MAX_VALUE] : [23, -126, MAX_FLOAT32];
  let exponent = numerator.toString(2).length - denominator.toString(2).length;
  const below =
    exponent >= 0 ? numerator < denominator << BigInt(exponent) : numerator << BigInt(-exponent) < denominator;
  if (below) exponent--;
  exponent = Math.max(exponent, minExponent);
  const shift = mantissaBits - exponent;
  const scaledNumerator = shift >= 0 ? numerator << BigInt(shift) : numerator;
  const scaledDenominator = shift >= 0 ? denominator : denominator << BigInt(-shift);
  let quotient = scaledNumerator / scaledDenominator;
  const twiceRemainder = (scaledNumerator % scaledDenominator) * 2n;
  if (twiceRemainder > scaledDenominator || (twiceRemainder === scaledDenominator && quotient % 2n === 1n)) quotient++;
  const value = Number(quotient) * 2 ** (exponent - mantissaBits);
  return value > maxValue ? Infinity : value;
}

function formatInteger(value: bigint, base: number): string {
  if (base < 2 || base > 36) stringPanic('strconv: illegal AppendInt/FormatInt base');
  return value.toString(base);
}

function formatFloatBits(value: number, format: string, precision: number, bitSize: number): string {
  if (bitSize !== 32 && bitSize !== 64) stringPanic('strconv: illegal AppendFloat bitSize');
  if (!'beEfgGxX'.includes(format) && Number.isFinite(value)) return `%${format}`;
  return formatFloat(bitSize === 32 ? Math.fround(value) : value, format, precision, bitSize);
}

function formatComplex(value: Complex, format: string, precision: number, bitSize: number): string {
  if (bitSize !== 64 && bitSize !== 128) stringPanic('invalid bitSize');
  const re = formatFloatBits(value.re, format, precision, bitSize / 2);
  const im = formatFloatBits(value.im, format, precision, bitSize / 2);
  return `(${re}${im[0] === '+' || im[0] === '-' ? '' : '+'}${im}i)`;
}

function appendChunks(destination: Value, chunks: string[]): Value {
  let slice = destination;
  for (const chunk of chunks) slice = appendBytes(slice, chunk);
  return slice;
}

/**
 * Splits FormatFloat's output into the pieces that Go's AppendFloat appends with one `append` call each,
 * which decide how the destination grows.
 */
function floatChunks(text: string, format: string): string[] {
  if (text === 'NaN' || text === '+Inf' || text === '-Inf' || !'bxXeEfgG'.includes(format)) return [text];
  const sign = text.startsWith('-') ? ['-'] : [];
  const body = text.slice(sign.length);
  if (format === 'b') {
    const [mantissa, exponent] = body.split('p');
    return [...sign, mantissa, 'p', exponent[0], exponent.slice(1)];
  }
  if (format === 'x' || format === 'X') {
    const at = body.search(/[pP]/);
    return [...sign, body.slice(0, 3), ...body.slice(3, at).split(''), body[at], body[at + 1], body.slice(at + 2)];
  }
  const at = body.search(/[eE]/);
  if (at < 0) return [...sign, ...body.split('')];
  // The significant digits after the first are appended at once and the padding zeros one by one.
  const fraction = body.slice(2, at);
  const digits = fraction.replace(/0+$/, '');
  const point = at > 1 ? ['.', digits, ...fraction.slice(digits.length).split('')] : [];
  return [...sign, body[0], ...point, body[at], body[at + 1], body.slice(at + 2)];
}

/**
 * Appends AppendFloat's pieces. Go's compiler gives fmtX, which formats 'x' and 'X', a 32-byte stack buffer for
 * its first append (the minus sign) to an empty destination, and moves the result to a heap array of the
 * length's size class on return.
 */
function appendFloatChunks(destination: Value, chunks: string[], format: string): Value {
  const slice = destination as Slice | undefined;
  if (!((format === 'x' || format === 'X') && chunks[0] === '-' && (slice?.capacity ?? 0) === 0)) {
    return appendChunks(destination, chunks);
  }
  const runtime = currentRuntime();
  const allocate = (count: number): void => runtime.allocate(count);
  const buffer = appendValues(slice, [45n], BASIC.uint8, () => 0n, allocate, 'static');
  return moveToHeap(appendChunks(buffer, chunks.slice(1)) as Slice, BASIC.uint8, () => 0n, allocate);
}

function appendQuoted(destination: Value, text: string, asciiOnly: boolean, graphicOnly: boolean): Value {
  const slice = destination as Slice | undefined;
  const length = slice?.length ?? 0;
  let buffer: Value = slice;
  // Go's appendQuotedWith preallocates room for the quotes and the unescaped text when the spare capacity lacks it.
  if ((slice?.capacity ?? 0) - length < text.length) {
    const capacity = length + text.length + 2;
    currentRuntime().allocate(capacity);
    const array = slice?.values() ?? [];
    while (array.length < capacity) array.push(0n);
    buffer = new Slice(array, 0, length, capacity);
  }
  return appendChunks(buffer, quoteChunks(text, '"', asciiOnly, graphicOnly));
}

/** `strconv.Unquote`: the value of a quoted Go string or rune literal, or ErrSyntax. */
export function unquoteLiteral(text: string): [string, Value] {
  const [value, rest, error] = unquote(text, true);
  return rest === '' ? [value, error] : ['', ERR_SYNTAX];
}

/** Go's `unquote`: the quoted literal at the start of `input` (unescaped when `unescape`), the rest, and any error. */
// code-gauge-allow functionCognitiveComplexity 30 -- A transcription of Go's unquote.
function unquote(input: string, unescape: boolean): [string, string, Value] {
  const failure: [string, string, Value] = ['', input, ERR_SYNTAX];
  if (input.length < 2) return failure;
  const quoteChar = input[0];
  const end = input.indexOf(quoteChar, 1) + 1;
  if (end === 0) return failure;
  if (quoteChar === '`') {
    return [unescape ? input.slice(1, end - 1).replaceAll('\r', '') : input.slice(0, end), input.slice(end), undefined];
  }
  if (quoteChar !== '"' && quoteChar !== "'") return failure;
  const literal = input.slice(0, end);
  if (!literal.includes('\\') && !literal.includes('\n')) {
    const body = literal.slice(1, -1);
    let valid: boolean;
    if (quoteChar === '"') valid = validUtf8(body);
    else {
      const { rune, size } = body === '' ? { rune: RUNE_ERROR, size: 0 } : decodeRune(body, 0);
      valid = size + 2 === end && (rune !== RUNE_ERROR || size !== 1);
    }
    if (valid) return [unescape ? body : literal, input.slice(end), undefined];
  }
  let rest = input.slice(1);
  let buffer = '';
  while (rest.length > 0 && rest[0] !== quoteChar) {
    const [rune, multibyte, tail, error] = unquoteChar(rest, quoteChar.charCodeAt(0));
    if (rest[0] === '\n' || error !== undefined) return failure;
    rest = tail;
    if (unescape) buffer += rune < 0x80 || !multibyte ? String.fromCharCode(rune) : encodeRune(rune);
    if (quoteChar === "'") break;
  }
  if (rest[0] !== quoteChar) return failure;
  rest = rest.slice(1);
  return [unescape ? buffer : input.slice(0, input.length - rest.length), rest, undefined];
}

function validUtf8(bytes: string): boolean {
  for (let index = 0; index < bytes.length;) {
    const { rune, size } = decodeRune(bytes, index);
    if (rune === RUNE_ERROR && size === 1) return false;
    index += size;
  }
  return true;
}

const SIMPLE_ESCAPES: Partial<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 };
const HEX_ESCAPE_DIGITS: Partial<Record<string, number>> = { x: 2, u: 4, U: 8 };

/** `strconv.UnquoteChar`: the first character of an escaped literal body, whether it needs multiple bytes, and the rest. */
// code-gauge-allow functionCognitiveComplexity 25 -- A transcription of Go's UnquoteChar.
export function unquoteChar(text: string, quoteByte: number): [number, boolean, string, Value] {
  const failure: [number, boolean, string, Value] = [0, false, '', ERR_SYNTAX];
  if (text === '') return failure;
  const first = text.charCodeAt(0);
  if (first === quoteByte && (quoteByte === 0x27 || quoteByte === 0x22)) return failure;
  if (first >= 0x80) {
    const { rune, size } = decodeRune(text, 0);
    return [rune, true, text.slice(size), undefined];
  }
  if (first !== 0x5c) return [first, false, text.slice(1), undefined];
  if (text.length <= 1) return failure;
  const kind = text[1];
  const rest = text.slice(2);
  const simple = SIMPLE_ESCAPES[kind];
  if (simple !== undefined) return [simple, false, rest, undefined];
  const count = HEX_ESCAPE_DIGITS[kind];
  if (count !== undefined) {
    const digits = rest.slice(0, count);
    if (digits.length < count || !/^[\dA-Fa-f]*$/.test(digits)) return failure;
    const value = Number.parseInt(digits, 16);
    if (kind === 'x') return [value, false, rest.slice(count), undefined];
    if (value > 0x10_ff_ff || (value >= 0xd8_00 && value <= 0xdf_ff)) return failure;
    return [value, true, rest.slice(count), undefined];
  }
  if (kind >= '0' && kind <= '7') {
    const digits = text.slice(1, 4);
    if (!/^[0-7]{3}$/.test(digits)) return failure;
    const value = Number.parseInt(digits, 8);
    return value > 255 ? failure : [value, false, text.slice(4), undefined];
  }
  if ((kind === "'" || kind === '"') && kind.charCodeAt(0) === quoteByte) return [quoteByte, false, rest, undefined];
  return failure;
}

const runeOf = (value: Value): number => Number(value as bigint);

const members: Record<string, Entity> = {
  NumError: typeEntity(NUM_ERROR),
  ErrSyntax: {
    kind: 'var',
    name: 'ErrSyntax',
    type: ERROR_TYPE,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => ERR_SYNTAX,
  },
  ErrRange: {
    kind: 'var',
    name: 'ErrRange',
    type: ERROR_TYPE,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => ERR_RANGE,
  },
  IntSize: {
    kind: 'const',
    name: 'IntSize',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: 64n },
    span: { row: 0, column: 0 },
    used: true,
  },
  Itoa: nativeFunction('Itoa', fn([INT], [STRING]), ([value]) => (value as bigint).toString()),
  Atoi: nativeFunction('Atoi', fn([STRING], [INT, ERROR_TYPE]), ([text]) => {
    const [value, error] = parseInt(text as string, 10, 0, 'Atoi');
    return [value, error];
  }),
  ParseInt: nativeFunction('ParseInt', fn([STRING, INT, INT], [BASIC.int64, ERROR_TYPE]), ([text, base, bits]) =>
    parseInt(text as string, Number(base as bigint), Number(bits as bigint), 'ParseInt')
  ),
  ParseUint: nativeFunction('ParseUint', fn([STRING, INT, INT], [BASIC.uint64, ERROR_TYPE]), ([text, base, bits]) =>
    parseUint(text as string, Number(base as bigint), Number(bits as bigint), 'ParseUint')
  ),
  ParseFloat: nativeFunction('ParseFloat', fn([STRING, INT], [FLOAT64, ERROR_TYPE]), ([text, bits]) =>
    parseFloat(text as string, Number(bits as bigint))
  ),
  ParseComplex: nativeFunction('ParseComplex', fn([STRING, INT], [BASIC.complex128, ERROR_TYPE]), ([text, bits]) =>
    parseComplex(text as string, Number(bits as bigint))
  ),
  ParseBool: nativeFunction('ParseBool', fn([STRING], [BOOL, ERROR_TYPE]), ([text]) => {
    if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(text as string)) return [true, undefined];
    if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(text as string)) return [false, undefined];
    return [false, numError('ParseBool', text as string, ERR_SYNTAX)];
  }),
  FormatInt: nativeFunction('FormatInt', fn([BASIC.int64, INT], [STRING]), ([value, base]) =>
    formatInteger(value as bigint, Number(base as bigint))
  ),
  FormatUint: nativeFunction('FormatUint', fn([BASIC.uint64, INT], [STRING]), ([value, base]) =>
    formatInteger(value as bigint, Number(base as bigint))
  ),
  FormatFloat: nativeFunction(
    'FormatFloat',
    fn([FLOAT64, BASIC.uint8, INT, INT], [STRING]),
    ([value, format, precision, bits]) =>
      formatFloatBits(value as number, String.fromCharCode(runeOf(format)), runeOf(precision), runeOf(bits))
  ),
  FormatComplex: nativeFunction(
    'FormatComplex',
    fn([BASIC.complex128, BASIC.uint8, INT, INT], [STRING]),
    ([value, format, precision, bits]) =>
      formatComplex(value as Complex, String.fromCharCode(runeOf(format)), runeOf(precision), runeOf(bits))
  ),
  FormatBool: nativeFunction('FormatBool', fn([BOOL], [STRING]), ([value]) => String(value as boolean)),
  Quote: nativeFunction('Quote', fn([STRING], [STRING]), ([text]) => quote(text as string)),
  QuoteToASCII: nativeFunction('QuoteToASCII', fn([STRING], [STRING]), ([text]) => quote(text as string, '"', true)),
  QuoteToGraphic: nativeFunction('QuoteToGraphic', fn([STRING], [STRING]), ([text]) =>
    quote(text as string, '"', false, true)
  ),
  QuoteRune: nativeFunction('QuoteRune', fn([RUNE], [STRING]), ([rune]) => quoteRune(runeOf(rune))),
  QuoteRuneToASCII: nativeFunction('QuoteRuneToASCII', fn([RUNE], [STRING]), ([rune]) => quoteRune(runeOf(rune), true)),
  QuoteRuneToGraphic: nativeFunction('QuoteRuneToGraphic', fn([RUNE], [STRING]), ([rune]) =>
    quoteRune(runeOf(rune), false, true)
  ),
  Unquote: nativeFunction('Unquote', fn([STRING], [STRING, ERROR_TYPE]), ([text]) => unquoteLiteral(text as string)),
  UnquoteChar: nativeFunction(
    'UnquoteChar',
    fn([STRING, BASIC.uint8], [RUNE, BOOL, STRING, ERROR_TYPE]),
    ([text, quoteByte]) => {
      const [rune, multibyte, tail, error] = unquoteChar(text as string, runeOf(quoteByte));
      return [BigInt(rune), multibyte, tail, error];
    }
  ),
  QuotedPrefix: nativeFunction('QuotedPrefix', fn([STRING], [STRING, ERROR_TYPE]), ([text]) => {
    const [prefix, , error] = unquote(text as string, false);
    return [prefix, error];
  }),
  CanBackquote: nativeFunction('CanBackquote', fn([STRING], [BOOL]), ([text]) => canBackquote(text as string)),
  IsPrint: nativeFunction('IsPrint', fn([RUNE], [BOOL]), ([rune]) => isPrint(runeOf(rune))),
  IsGraphic: nativeFunction('IsGraphic', fn([RUNE], [BOOL]), ([rune]) => isGraphic(runeOf(rune))),
  AppendInt: nativeFunction('AppendInt', fn([BYTES, BASIC.int64, INT], [BYTES]), ([bytes, value, base]) => {
    const text = formatInteger(value as bigint, runeOf(base));
    return appendChunks(bytes, text.startsWith('-') ? ['-', text.slice(1)] : [text]);
  }),
  AppendUint: nativeFunction('AppendUint', fn([BYTES, BASIC.uint64, INT], [BYTES]), ([bytes, value, base]) =>
    appendBytes(bytes, formatInteger(value as bigint, runeOf(base)))
  ),
  AppendFloat: nativeFunction(
    'AppendFloat',
    fn([BYTES, FLOAT64, BASIC.uint8, INT, INT], [BYTES]),
    ([bytes, value, format, precision, bits]) => {
      const formatChar = String.fromCharCode(runeOf(format));
      const text = formatFloatBits(value as number, formatChar, runeOf(precision), runeOf(bits));
      return appendFloatChunks(bytes, floatChunks(text, formatChar), formatChar);
    }
  ),
  AppendBool: nativeFunction('AppendBool', fn([BYTES, BOOL], [BYTES]), ([bytes, value]) =>
    appendBytes(bytes, String(value as boolean))
  ),
  AppendQuote: nativeFunction('AppendQuote', fn([BYTES, STRING], [BYTES]), ([bytes, text]) =>
    appendQuoted(bytes, text as string, false, false)
  ),
  AppendQuoteToASCII: nativeFunction('AppendQuoteToASCII', fn([BYTES, STRING], [BYTES]), ([bytes, text]) =>
    appendQuoted(bytes, text as string, true, false)
  ),
  AppendQuoteToGraphic: nativeFunction('AppendQuoteToGraphic', fn([BYTES, STRING], [BYTES]), ([bytes, text]) =>
    appendQuoted(bytes, text as string, false, true)
  ),
  AppendQuoteRune: nativeFunction('AppendQuoteRune', fn([BYTES, RUNE], [BYTES]), ([bytes, rune]) =>
    appendChunks(bytes, quoteRuneChunks(runeOf(rune)))
  ),
  AppendQuoteRuneToASCII: nativeFunction('AppendQuoteRuneToASCII', fn([BYTES, RUNE], [BYTES]), ([bytes, rune]) =>
    appendChunks(bytes, quoteRuneChunks(runeOf(rune), true))
  ),
  AppendQuoteRuneToGraphic: nativeFunction('AppendQuoteRuneToGraphic', fn([BYTES, RUNE], [BYTES]), ([bytes, rune]) =>
    appendChunks(bytes, quoteRuneChunks(runeOf(rune), false, true))
  ),
};

export const STRCONV_PACKAGE = definePackage('strconv', members);
