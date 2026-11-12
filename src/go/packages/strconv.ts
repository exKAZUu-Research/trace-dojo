// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { formatFloat } from '../floatFormat';
import { decodeRune, encodeRune, RUNE_ERROR } from '../literals';
import { addMethod, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { canBackquote, isPrint, quote, quoteRune } from '../quote';
import { BASIC, ERROR_TYPE, pointerTo, RUNE } from '../types';
import { Cell, GoStruct, Iface, Pointer, type Value } from '../values';
import { BOOL, BYTES, byteSlice, bytesOf, errorText, FLOAT64, INT, STRING } from './support';

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
    const [func, num, error] = ((receiver as Pointer).load() as GoStruct).fields as [string, string, Value];
    return `strconv.${func}: parsing ${quote(num)}: ${errorText(error)}`;
  },
  true
);
addMethod(
  NUM_ERROR,
  'Unwrap',
  fn([], [ERROR_TYPE]),
  (receiver) => ((receiver as Pointer).load() as GoStruct).fields[2],
  true
);

function numError(func: string, num: string, error: Value): Value {
  return new Iface(pointerTo(NUM_ERROR), new Pointer(new Cell(new GoStruct([func, num, error])), 'v'));
}

function renamed(error: Value, func: string, num: string): Value {
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
function parseUint(text: string, baseArg: number, bitSizeArg: number, func: string): [bigint, Value] {
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

function parseInt(text: string, base: number, bitSizeArg: number, func: string): [bigint, Value] {
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

const SPECIAL_FLOATS: Record<string, number> = { inf: Infinity, infinity: Infinity, nan: Number.NaN };

// code-gauge-allow functionCognitiveComplexity 20 -- Go's float syntax: specials, decimal, and hexadecimal.
function parseFloat(text: string, bitSize: number): [number, Value] {
  const error = (kind: Value, value = 0): [number, Value] => [value, numError('ParseFloat', text, kind)];
  let s = text;
  let sign = 1;
  if (s[0] === '+' || s[0] === '-') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1);
  }
  const special = SPECIAL_FLOATS[s.toLowerCase()];
  if (special !== undefined && !(Number.isNaN(special) && text.length !== s.length)) return [sign * special, undefined];
  if (s.includes('_')) {
    if (!underscoreOK(text)) return error(ERR_SYNTAX);
    s = s.replaceAll('_', '');
  }
  let value: number;
  if (/^0[xX]/.test(s)) {
    const match = /^0[xX]([\dA-Fa-f]*)(?:\.([\dA-Fa-f]*))?[pP]([+-]?\d+)$/.exec(s);
    if (!match || (match[1] === '' && (match[2] ?? '') === '')) return error(ERR_SYNTAX);
    const digits = (match[1] ?? '') + (match[2] ?? '');
    const mantissa = BigInt(`0x${digits || '0'}`);
    const exponent = Number(match[3]) - 4 * (match[2] ?? '').length;
    value = Number(mantissa) * 2 ** exponent;
  } else {
    if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return error(ERR_SYNTAX);
    value = Number(s);
  }
  if (bitSize === 32) value = Math.fround(value);
  if (!Number.isFinite(value)) return error(ERR_RANGE, sign * Infinity);
  return [sign * value, undefined];
}

function formatInteger(value: bigint, base: number): string {
  if (base < 2 || base > 36) throw new Error('strconv: illegal AppendInt/FormatInt base');
  return value.toString(base);
}

/** `strconv.Unquote`: the value of a quoted Go string or rune literal, or ErrSyntax. */
function unquote(text: string): [string, Value] {
  if (text.length < 2) return ['', ERR_SYNTAX];
  const quoteChar = text[0];
  if (quoteChar !== text.at(-1)) return ['', ERR_SYNTAX];
  const body = text.slice(1, -1);
  if (quoteChar === '`') return body.includes('`') ? ['', ERR_SYNTAX] : [body.replaceAll('\r', ''), undefined];
  if (quoteChar !== '"' && quoteChar !== "'") return ['', ERR_SYNTAX];
  let result = '';
  for (let at = 0; at < body.length;) {
    const char = body[at];
    if (char === quoteChar || char === '\n') return ['', ERR_SYNTAX];
    if (char !== '\\') {
      const { size } = decodeRune(body, at);
      result += body.slice(at, at + size);
      at += size;
      continue;
    }
    const escape = /^\\(?:([abfnrtv\\'"])|([0-7]{3})|x([\dA-Fa-f]{2})|u([\dA-Fa-f]{4})|U([\dA-Fa-f]{8}))/.exec(
      body.slice(at)
    );
    if (!escape) return ['', ERR_SYNTAX];
    const [whole, simple, octal, hex, small, large] = escape;
    if (simple) {
      if ((simple === "'" && quoteChar === '"') || (simple === '"' && quoteChar === "'")) return ['', ERR_SYNTAX];
      result += String.fromCharCode(
        { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 }[simple as 'a'] ?? simple.charCodeAt(0)
      );
    } else if (octal || hex) {
      const byte = Number.parseInt(octal ?? hex, octal ? 8 : 16);
      if (byte > 255) return ['', ERR_SYNTAX];
      result += String.fromCharCode(byte);
    } else {
      const rune = Number.parseInt(small ?? large, 16);
      if (rune > 0x10_ff_ff || (rune >= 0xd8_00 && rune <= 0xdf_ff)) return ['', ERR_SYNTAX];
      result += encodeRune(rune);
    }
    at += whole.length;
  }
  if (quoteChar === "'") {
    const { rune, size } = decodeRune(result, 0);
    if (result.length === 0 || size !== result.length || (rune === RUNE_ERROR && size === 1)) return ['', ERR_SYNTAX];
  }
  return [result, undefined];
}

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
      formatFloat(
        // A bit size of 32 formats the value rounded to a float32, as Go converts it first.
        Number(bits as bigint) === 32 ? Math.fround(value as number) : (value as number),
        String.fromCharCode(Number(format as bigint)),
        Number(precision as bigint),
        Number(bits as bigint) === 32 ? 32 : 64
      )
  ),
  FormatBool: nativeFunction('FormatBool', fn([BOOL], [STRING]), ([value]) => String(value)),
  Quote: nativeFunction('Quote', fn([STRING], [STRING]), ([text]) => quote(text as string)),
  QuoteToASCII: nativeFunction('QuoteToASCII', fn([STRING], [STRING]), ([text]) => quote(text as string, '"', true)),
  QuoteRune: nativeFunction('QuoteRune', fn([RUNE], [STRING]), ([rune]) => quoteRune(Number(rune as bigint))),
  QuoteRuneToASCII: nativeFunction('QuoteRuneToASCII', fn([RUNE], [STRING]), ([rune]) =>
    quoteRune(Number(rune as bigint), true)
  ),
  Unquote: nativeFunction('Unquote', fn([STRING], [STRING, ERROR_TYPE]), ([text]) => unquote(text as string)),
  AppendInt: nativeFunction('AppendInt', fn([BYTES, BASIC.int64, INT], [BYTES]), ([bytes, value, base]) =>
    byteSlice(bytesOf(bytes) + formatInteger(value as bigint, Number(base as bigint)))
  ),
  AppendBool: nativeFunction('AppendBool', fn([BYTES, BOOL], [BYTES]), ([bytes, value]) =>
    byteSlice(bytesOf(bytes) + String(value))
  ),
  AppendQuote: nativeFunction('AppendQuote', fn([BYTES, STRING], [BYTES]), ([bytes, text]) =>
    byteSlice(bytesOf(bytes) + quote(text as string))
  ),
  AppendQuoteToASCII: nativeFunction('AppendQuoteToASCII', fn([BYTES, STRING], [BYTES]), ([bytes, text]) =>
    byteSlice(bytesOf(bytes) + quote(text as string, '"', true))
  ),
  AppendQuoteRune: nativeFunction('AppendQuoteRune', fn([BYTES, RUNE], [BYTES]), ([bytes, rune]) =>
    byteSlice(bytesOf(bytes) + quoteRune(Number(rune as bigint)))
  ),
  AppendUint: nativeFunction('AppendUint', fn([BYTES, BASIC.uint64, INT], [BYTES]), ([bytes, value, base]) =>
    byteSlice(bytesOf(bytes) + formatInteger(value as bigint, Number(base as bigint)))
  ),
  AppendFloat: nativeFunction(
    'AppendFloat',
    fn([BYTES, FLOAT64, BASIC.uint8, INT, INT], [BYTES]),
    ([bytes, value, format, precision, bits]) =>
      byteSlice(
        bytesOf(bytes) +
          formatFloat(
            value as number,
            String.fromCharCode(Number(format as bigint)),
            Number(precision as bigint),
            Number(bits as bigint) === 32 ? 32 : 64
          )
      )
  ),
  CanBackquote: nativeFunction('CanBackquote', fn([STRING], [BOOL]), ([text]) => canBackquote(text as string)),
  IsPrint: nativeFunction('IsPrint', fn([RUNE], [BOOL]), ([rune]) => isPrint(Number(rune as bigint))),
  // Graphic characters are the printable ones and the other spaces of category Zs.
  IsGraphic: nativeFunction('IsGraphic', fn([RUNE], [BOOL]), ([rune]) => {
    const code = Number(rune as bigint);
    return isPrint(code) || (code >= 0 && code <= 0x10_ff_ff && /^\p{Zs}$/u.test(String.fromCodePoint(code)));
  }),
};

export const STRCONV_PACKAGE = definePackage('strconv', members, [
  'ParseComplex',
  'FormatComplex',
  'UnquoteChar',
  'QuoteToGraphic',
  'QuotedPrefix',
]);
