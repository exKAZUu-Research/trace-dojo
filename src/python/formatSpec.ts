import { complexRepr } from './complexNumbers';
import {
  type Decimal,
  exactDecimal,
  exponentText,
  fixedText,
  intToString,
  reprDigits,
  roundDecimal,
  shortestDecimal,
} from './numbers';
import { iterStr, strLength } from './strings';
import { typeName, valueError } from './types';
import { PyComplex, type PyValue } from './values';

interface Spec {
  fill: string;
  align?: '<' | '>' | '=' | '^';
  sign?: '+' | '-' | ' ';
  coerceZero: boolean;
  alternate: boolean;
  zeroPad: boolean;
  width: number;
  grouping?: ',' | '_';
  precision?: number;
  type?: string;
}

// code-gauge-allow functionNcss 47 -- Follows the grammar of the format specification mini-language.
// code-gauge-allow functionCognitiveComplexity 24 -- Follows the grammar of the format specification mini-language.
function parseSpec(text: string, value: PyValue): Spec {
  const spec: Spec = { fill: ' ', coerceZero: false, alternate: false, zeroPad: false, width: 0 };
  const chars = iterStr(text);
  let index = 0;
  if (chars.length >= 2 && '<>=^'.includes(chars[1])) {
    spec.fill = chars[0];
    spec.align = chars[1] as Spec['align'];
    index = 2;
  } else if (chars.length > 0 && '<>=^'.includes(chars[0])) {
    spec.align = chars[0] as Spec['align'];
    index = 1;
  }
  if ('+- '.includes(chars[index] ?? 'x')) spec.sign = chars[index++] as Spec['sign'];
  if (chars[index] === 'z') {
    spec.coerceZero = true;
    index++;
  }
  if (chars[index] === '#') {
    spec.alternate = true;
    index++;
  }
  if (chars[index] === '0') {
    spec.zeroPad = true;
    index++;
  }
  let width = '';
  while (/\d/.test(chars[index] ?? '')) width += chars[index++];
  spec.width = width ? Number(width) : 0;
  if (chars[index] === ',' || chars[index] === '_') {
    spec.grouping = chars[index++] as ',' | '_';
    if (chars[index] === ',' || chars[index] === '_') throw valueError(`Cannot specify both ',' and '_'.`);
  }
  if (chars[index] === '.') {
    index++;
    let precision = '';
    while (/\d/.test(chars[index] ?? '')) precision += chars[index++];
    if (!precision) throw valueError('Format specifier missing precision');
    spec.precision = Number(precision);
  }
  if (chars.length - index > 1) {
    throw valueError(`Invalid format specifier '${text}' for object of type '${typeName(value)}'`);
  }
  if (index < chars.length) spec.type = chars[index];
  if (spec.zeroPad && spec.align === undefined) {
    spec.fill = '0';
    spec.align = '=';
  }
  return spec;
}

/** Formats a builtin value with a format specification, as its `__format__` does. */
export function formatValue(value: PyValue, text: string, fallback: (value: PyValue) => string): string {
  if (typeof value === 'boolean' && text === '') return value ? 'True' : 'False';
  if (typeof value === 'bigint' || typeof value === 'boolean') return formatInt(BigInt(value), parseSpec(text, value));
  if (typeof value === 'number') return formatFloat(value, parseSpec(text, value));
  if (typeof value === 'string') return formatStr(value, parseSpec(text, value));
  if (value instanceof PyComplex && text === '') return complexRepr(value);
  if (text !== '') throw valueError(`unsupported format string passed to ${typeName(value)}.__format__`);
  return fallback(value);
}

function formatStr(value: string, spec: Spec): string {
  if (spec.type !== undefined && spec.type !== 's') {
    throw valueError(`Unknown format code '${spec.type}' for object of type 'str'`);
  }
  if (spec.sign) throw valueError('Sign not allowed in string format specifier');
  if (spec.alternate) throw valueError('Alternate form (#) not allowed in string format specifier');
  if (spec.coerceZero) throw valueError('Negative zero coercion (z) not allowed in format specifier');
  if (spec.grouping) throw valueError(`Cannot specify '${spec.grouping}' with 's'.`);
  if (spec.align === '=') throw valueError("'=' alignment not allowed in string format specifier");
  const text = spec.precision === undefined ? value : iterStr(value).slice(0, spec.precision).join('');
  return pad(text, '', spec, '<');
}

// code-gauge-allow functionCognitiveComplexity 20 -- One case per integer presentation type.
function formatInt(value: bigint, spec: Spec): string {
  const type = spec.type ?? 'd';
  if ('eEfFgG%'.includes(type)) return formatFloat(Number(value), spec);
  if (!'bcdoxXn'.includes(type)) throw valueError(`Unknown format code '${type}' for object of type 'int'`);
  if (spec.precision !== undefined) throw valueError('Precision not allowed in integer format specifier');
  if (spec.coerceZero) throw valueError('Negative zero coercion (z) not allowed in integer format specifier');
  if (type === 'c') {
    if (spec.sign) throw valueError("Sign not allowed with integer format specifier 'c'");
    if (value < 0n || value > 0x10_ff_ffn) throw new RangeError('%c arg not in range(0x110000)');
    return pad(String.fromCodePoint(Number(value)), '', spec, '>');
  }
  if (spec.grouping === ',' && type !== 'd') throw valueError(`Cannot specify ',' with '${type}'.`);
  if (type === 'n' && spec.grouping) throw valueError(`Cannot specify '${spec.grouping}' with 'n'.`);
  const radix = { b: 2, o: 8, x: 16, X: 16 }[type as 'b'] ?? 10;
  const magnitude = value < 0n ? -value : value;
  let digits = radix === 10 ? intToString(magnitude) : magnitude.toString(radix);
  if (type === 'X') digits = digits.toUpperCase();
  const prefix = spec.alternate && radix !== 10 ? `0${type}` : '';
  return finishNumber(value < 0n, prefix, digits, '', spec, radix === 10 ? 3 : 4);
}

// code-gauge-allow functionNcss 33 -- One case per float presentation type.
// code-gauge-allow functionCognitiveComplexity 30 -- One case per float presentation type.
function formatFloat(value: number, spec: Spec): string {
  const type = spec.type;
  if (type !== undefined && !'eEfFgGn%'.includes(type)) {
    throw valueError(`Unknown format code '${type}' for object of type 'float'`);
  }
  if (type === 'n' && spec.grouping) throw valueError(`Cannot specify '${spec.grouping}' with 'n'.`);
  let negative = value < 0 || Object.is(value, -0);
  const upper = type !== undefined && 'EFG'.includes(type);
  if (!Number.isFinite(value)) {
    const text = Number.isNaN(value) ? 'nan' : 'inf';
    negative = value < 0;
    return finishNumber(negative, '', upper ? text.toUpperCase() : text, '', spec, 3);
  }
  const scaled = type === '%' ? value * 100 : value;
  const decimal = exactDecimal(scaled);
  let body: string;
  if (type === 'f' || type === 'F' || type === '%') {
    body = fixedText(decimal, spec.precision ?? 6);
    if (spec.alternate && (spec.precision ?? 6) === 0) body += '.';
  } else if (type === 'e' || type === 'E') {
    body = exponentText(decimal, spec.precision ?? 6, type === 'E' ? 'E' : 'e');
    if (spec.alternate && spec.precision === 0) body = body.replace(/e|E/, (marker) => `.${marker}`);
  } else if (type === undefined && spec.precision === undefined) {
    body = reprDigits(shortestDecimal(scaled));
  } else {
    body = generalText(decimal, spec.precision ?? 6, spec.alternate, type === undefined, upper);
  }
  if (spec.coerceZero && negative && /^[0.]*(?:e[+-]\d+)?$/i.test(body.replace(/e.*$/i, ''))) negative = false;
  const [integer, fraction] = splitNumber(body);
  return finishNumber(negative, '', integer, fraction + (type === '%' ? '%' : ''), spec, 3);
}

/** The 'g' presentation, and the default one with a precision, which keeps at least one fractional digit. */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows the rules of the g presentation type.
function generalText(
  decimal: Decimal,
  precision: number,
  alternate: boolean,
  isDefault: boolean,
  upper: boolean
): string {
  const significant = precision === 0 ? 1 : precision;
  const rounded = roundDecimal(decimal, significant);
  const exponent = rounded.digits === '0' ? 0 : rounded.point - 1;
  const limit = isDefault ? significant - 1 : significant;
  let text: string;
  if (exponent >= -4 && exponent < limit) {
    text = fixedText(decimal, Math.max(significant - 1 - exponent, 0));
    if (!alternate) text = stripZeros(text);
    if (isDefault && !text.includes('.')) text += '.0';
  } else {
    text = exponentText(decimal, significant - 1, upper ? 'E' : 'e');
    if (!alternate)
      text = text.replace(
        /^(\d+)(\.\d*?)0*(e|E)/,
        (_, head: string, fraction: string, marker: string) => `${head}${fraction === '.' ? '' : fraction}${marker}`
      );
  }
  if (alternate && !text.includes('.')) text = text.replace(/^(\d+)/, '$1.');
  return upper ? text.toUpperCase() : text;
}

function stripZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/\.?0+$/, '');
}

/** Splits a formatted number into its integer digits and the rest (fraction and exponent). */
function splitNumber(body: string): [string, string] {
  const match = /^(\d*)(.*)$/.exec(body) as RegExpExecArray;
  return [match[1], match[2]];
}

/** Adds the sign, prefix, grouping, and padding to the digits of a number. */
function finishNumber(
  negative: boolean,
  prefix: string,
  integer: string,
  rest: string,
  spec: Spec,
  groupSize: number
): string {
  const sign = negative ? '-' : spec.sign === '+' ? '+' : spec.sign === ' ' ? ' ' : '';
  const separator = spec.grouping;
  const isDigits = /^\d+$/.test(integer) || /^[0-9a-fA-F]+$/.test(integer);
  if (spec.align === '=' && spec.fill === '0' && separator && isDigits) {
    const available = spec.width - sign.length - prefix.length - strLength(rest);
    let count = integer.length;
    while (count + Math.floor((count - 1) / groupSize) < available) count++;
    return sign + prefix + group(integer.padStart(count, '0'), separator, groupSize) + rest;
  }
  const grouped = separator && isDigits ? group(integer, separator, groupSize) : integer;
  return pad(grouped + rest, sign + prefix, spec, '>');
}

function group(digits: string, separator: string, size: number): string {
  let result = '';
  for (let end = digits.length; end > 0; end -= size) {
    const start = Math.max(0, end - size);
    result = digits.slice(start, end) + (result ? separator + result : '');
  }
  return result;
}

function pad(body: string, signAndPrefix: string, spec: Spec, defaultAlign: '<' | '>'): string {
  const length = strLength(body) + strLength(signAndPrefix);
  const missing = spec.width - length;
  if (missing <= 0) return signAndPrefix + body;
  const align = spec.align ?? defaultAlign;
  const fill = spec.fill;
  switch (align) {
    case '<': {
      return signAndPrefix + body + fill.repeat(missing);
    }
    case '>': {
      return fill.repeat(missing) + signAndPrefix + body;
    }
    case '=': {
      return signAndPrefix + fill.repeat(missing) + body;
    }
    default: {
      const left = Math.floor(missing / 2);
      return fill.repeat(left) + signAndPrefix + body + fill.repeat(missing - left);
    }
  }
}
