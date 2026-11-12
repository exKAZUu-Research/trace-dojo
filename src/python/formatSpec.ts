import { complexRepr } from './complexNumbers';
import {
  type Decimal,
  exactDecimal,
  exponentText,
  fixedText,
  intToFloat,
  intToString,
  reprDigits,
  roundDecimal,
  shortestDecimal,
  toAsciiDigits,
} from './numbers';
import { currentRuntime } from './runtimeContext';
import { iterStr, strLength } from './strings';
import { pyError, typeName, valueError } from './types';
import { PyComplex, type PyValue } from './values';

type Align = '<' | '>' | '=' | '^';
type Separator = ',' | '_';

interface Spec {
  fill: string;
  align: Align;
  sign?: '+' | '-' | ' ';
  coerceZero: boolean;
  alternate: boolean;
  width: number;
  grouping?: Separator;
  fractionGrouping?: Separator;
  precision?: number;
  type?: string;
}

/** What a type's formatter assumes for the parts a specification leaves out. */
interface Defaults {
  align: '<' | '>';
  type?: string;
}

const MAX_SSIZE = (1n << 63n) - 1n;
const MAX_C_INT = 2 ** 31 - 1;

/** Reads a format specification as CPython's `parse_internal_render_format_spec` does. */
function parseSpec(text: string, value: PyValue, defaults: Defaults): Spec {
  const reader = new SpecReader(iterStr(text));
  const spec: Spec = { fill: ' ', coerceZero: false, alternate: false, width: 0, ...defaults };
  const given = reader.readFillAndAlign(spec);
  spec.sign = reader.take('+- ') as Spec['sign'];
  spec.coerceZero = reader.take('z') !== undefined;
  spec.alternate = reader.take('#') !== undefined;
  // A `0` after an explicit fill character belongs to the width.
  if (given !== 'fill' && reader.take('0') !== undefined) {
    spec.fill = '0';
    if (given === undefined && defaults.align === '>') spec.align = '=';
  }
  spec.width = reader.readCount() ?? 0;
  currentRuntime().buildString(spec.width);
  spec.grouping = reader.readSeparator();
  if (reader.take('.') !== undefined) {
    spec.precision = reader.readCount();
    spec.fractionGrouping = reader.readSeparator();
    if (spec.precision === undefined && !spec.fractionGrouping) throw valueError('Format specifier missing precision');
  }
  if (reader.remaining > 1) {
    throw valueError(`Invalid format specifier '${text}' for object of type '${typeName(value)}'`);
  }
  spec.type = reader.take() ?? defaults.type;
  checkSeparators(spec);
  return spec;
}

class SpecReader {
  private index = 0;

  constructor(private readonly chars: string[]) {}

  get remaining(): number {
    return this.chars.length - this.index;
  }

  /** Takes the next character if it is one of the options, or whatever it is without options. */
  take(options?: string): string | undefined {
    const ch = this.chars[this.index];
    if (ch === undefined || (options !== undefined && !options.includes(ch))) return undefined;
    this.index++;
    return ch;
  }

  /** Reads the fill character and the alignment, telling which of them are given: both, or the alignment alone. */
  readFillAndAlign(spec: Spec): 'fill' | 'align' | undefined {
    const hasFill = '<>=^'.includes(this.chars[1] ?? 'x');
    if (hasFill) spec.fill = this.chars[this.index++];
    const align = this.take('<>=^') as Align | undefined;
    spec.align = align ?? spec.align;
    return hasFill ? 'fill' : align && 'align';
  }

  /** A width or precision, which CPython reads into a Py_ssize_t. */
  readCount(): number | undefined {
    let digits = '';
    while (/\p{Nd}/u.test(this.chars[this.index] ?? '')) digits += this.chars[this.index++];
    if (!digits) return undefined;
    digits = toAsciiDigits(digits);
    if (digits.length > 18 && BigInt(digits) > MAX_SSIZE) throw valueError('Too many decimal digits in format string');
    return Number(digits);
  }

  readSeparator(): Separator | undefined {
    const comma = this.take(',');
    const underscore = this.take('_');
    if ((comma && underscore) || (underscore && this.chars[this.index] === ',')) {
      throw valueError(`Cannot specify both ',' and '_'.`);
    }
    return (comma ?? underscore) as Separator | undefined;
  }
}

function checkSeparators(spec: Spec): void {
  const type = spec.type ?? '';
  const isAllowed = 'deEfFgG%'.includes(type) || (spec.grouping === '_' && 'boxX'.includes(type));
  if (spec.grouping && !isAllowed) throw invalidSeparator(spec.grouping, type);
  if (type === 'n' && spec.fractionGrouping) throw invalidSeparator(spec.fractionGrouping, type);
}

function invalidSeparator(separator: Separator, type: string): Error {
  return valueError(`Cannot specify '${separator}' with '${typeCode(type)}'.`);
}

function unknownType(type: string, value: PyValue): Error {
  return valueError(`Unknown format code '${typeCode(type)}' for object of type '${typeName(value)}'`);
}

/** A presentation type as CPython's messages show it, which escape what is not printable ASCII. */
function typeCode(type: string): string {
  const code = type.codePointAt(0) as number;
  return code > 32 && code < 128 ? type : `\\x${code.toString(16)}`;
}

/** Formats a builtin value with a format specification, as its `__format__` does. */
export function formatValue(value: PyValue, text: string, fallback: (value: PyValue) => string): string {
  if (typeof value === 'boolean' && text === '') return value ? 'True' : 'False';
  if (typeof value === 'bigint' || typeof value === 'boolean') return formatInt(value, text);
  if (typeof value === 'number') return formatFloat(value, parseSpec(text, value, { align: '>' }), value);
  if (typeof value === 'string') return text === '' ? value : formatStr(value, text);
  if (value instanceof PyComplex && text === '') return complexRepr(value);
  if (text !== '') throw valueError(`unsupported format string passed to ${typeName(value)}.__format__`);
  return fallback(value);
}

function formatStr(value: string, specText: string): string {
  const spec = parseSpec(specText, value, { align: '<', type: 's' });
  if (spec.type !== 's') throw unknownType(spec.type as string, value);
  if (spec.sign) {
    throw valueError(`${spec.sign === ' ' ? 'Space' : 'Sign'} not allowed in string format specifier`);
  }
  if (spec.coerceZero) throw valueError('Negative zero coercion (z) not allowed in string format specifier');
  if (spec.alternate) throw valueError('Alternate form (#) not allowed in string format specifier');
  if (spec.align === '=') throw valueError("'=' alignment not allowed in string format specifier");
  const text = spec.precision === undefined ? value : iterStr(value).slice(0, spec.precision).join('');
  return pad(text, '', spec);
}

function formatInt(original: bigint | boolean, specText: string): string {
  const spec = parseSpec(specText, original, { align: '>', type: 'd' });
  const type = spec.type as string;
  const value = BigInt(original);
  if ('eEfFgG%'.includes(type)) return formatFloat(intToFloat(value), spec, original);
  if (!'bcdoxXn'.includes(type)) throw unknownType(type, original);
  if (spec.precision !== undefined) throw valueError('Precision not allowed in integer format specifier');
  if (spec.coerceZero) throw valueError('Negative zero coercion (z) not allowed in integer format specifier');
  if (type === 'c') return formatCharacter(value, spec);
  const radix = { b: 2, o: 8, x: 16, X: 16 }[type as 'b'] ?? 10;
  const magnitude = value < 0n ? -value : value;
  let digits = radix === 10 ? intToString(magnitude) : magnitude.toString(radix);
  if (type === 'X') digits = digits.toUpperCase();
  const prefix = spec.alternate && radix !== 10 ? `0${type}` : '';
  return finishNumber(value < 0n, prefix, digits, '', spec, radix === 10 ? 3 : 4);
}

function formatCharacter(value: bigint, spec: Spec): string {
  if (spec.sign) throw valueError("Sign not allowed with integer format specifier 'c'");
  if (spec.alternate) throw valueError("Alternate form (#) not allowed with integer format specifier 'c'");
  if (value > MAX_SSIZE || value < -MAX_SSIZE - 1n) {
    throw pyError('OverflowError', 'Python int too large to convert to C long');
  }
  if (value < 0n || value > 0x10_ff_ffn) throw pyError('OverflowError', '%c arg not in range(0x110000)');
  return pad(String.fromCodePoint(Number(value)), '', spec);
}

/** @param original The value being formatted, which is an int for a float presentation type of an int. */
function formatFloat(value: number, spec: Spec, original: PyValue): string {
  const type = spec.type;
  if (type !== undefined && !'eEfFgGn%'.includes(type)) throw unknownType(type, original);
  chargePrecision(spec.precision);
  const scaled = type === '%' ? value * 100 : value;
  const suffix = type === '%' ? '%' : '';
  const upper = type !== undefined && 'EFG'.includes(type);
  if (!Number.isFinite(scaled)) {
    const text = Number.isNaN(scaled) ? 'nan' : 'inf';
    return finishNumber(scaled < 0, '', '', (upper ? text.toUpperCase() : text) + suffix, spec, 3);
  }
  const body = finiteText(scaled, spec, upper);
  const isNegative = (scaled < 0 || Object.is(scaled, -0)) && !(spec.coerceZero && /^[0.]*(?:e.*)?$/i.test(body));
  const [integer, fraction, rest] = splitNumber(body);
  const groupedFraction = spec.fractionGrouping ? group(fraction, spec.fractionGrouping, 3, true) : fraction;
  return finishNumber(isNegative, '', integer, groupedFraction + rest + suffix, spec, 3);
}

/** The digits of a finite float in the presentation type of a specification, without a sign. */
// code-gauge-allow functionCognitiveComplexity 17 -- One case per float presentation type.
function finiteText(value: number, spec: Spec, upper: boolean): string {
  const { type, precision, alternate } = spec;
  const decimal = exactDecimal(value);
  if (type === 'f' || type === 'F' || type === '%') {
    return fixedText(decimal, precision ?? 6) + (alternate && (precision ?? 6) === 0 ? '.' : '');
  }
  if (type === 'e' || type === 'E') {
    const text = exponentText(decimal, precision ?? 6, type === 'E' ? 'E' : 'e');
    return alternate && precision === 0 ? text.replace(/e|E/, (marker) => `.${marker}`) : text;
  }
  if (type === undefined && precision === undefined) {
    const text = reprDigits(shortestDecimal(value));
    return alternate && !text.includes('.') ? text.replace('e', '.e') : text;
  }
  return generalText(decimal, precision ?? 6, alternate, type === undefined, upper);
}

function chargePrecision(precision: number | undefined): void {
  if (precision === undefined) return;
  if (precision > MAX_C_INT) throw valueError('precision too big');
  currentRuntime().buildString(precision);
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

/** Splits a formatted number into its integer digits, its decimal point and fraction digits, and the rest. */
function splitNumber(body: string): [string, string, string] {
  const match = /^(\d*)(\.?\d*)(.*)$/.exec(body) as RegExpExecArray;
  return [match[1], match[2], match[3]];
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
  const isDigits = integer !== '';
  if (spec.align === '=' && spec.fill === '0' && separator && isDigits) {
    const available = spec.width - sign.length - prefix.length - strLength(rest);
    let count = integer.length;
    while (count + Math.floor((count - 1) / groupSize) < available) count++;
    return sign + prefix + group(integer.padStart(count, '0'), separator, groupSize) + rest;
  }
  const grouped = separator && isDigits ? group(integer, separator, groupSize) : integer;
  return pad(grouped + rest, sign + prefix, spec);
}

/** Separates groups of digits, counted from the right, or from the left for the digits of a fraction. */
function group(digits: string, separator: string, size: number, fromLeft = false): string {
  // The digits to separate: those after an optional point, or the ones the text ends with.
  const [run, body] = (fromLeft ? /^\.?(\d*)/ : /(\w*)$/).exec(digits) as unknown as [string, string];
  const start = fromLeft ? run.length - body.length : digits.length - body.length;
  const first = fromLeft ? size : body.length % size || size;
  const groups = [body.slice(0, first)];
  for (let index = first; index < body.length; index += size) groups.push(body.slice(index, index + size));
  return digits.slice(0, start) + groups.join(separator) + digits.slice(start + body.length);
}

function pad(body: string, signAndPrefix: string, spec: Spec): string {
  const length = strLength(body) + strLength(signAndPrefix);
  const missing = spec.width - length;
  if (missing <= 0) return signAndPrefix + body;
  const fill = spec.fill;
  switch (spec.align) {
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
