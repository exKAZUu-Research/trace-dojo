import {
  combinedStringEncoding,
  floatToInt,
  formatFloat,
  inspectValue,
  toInt,
  toRubyInt,
  toStrValue,
  toSValue,
} from './conversions';
import { argumentError, floatDomainError, rangeError, rubyError, typeError } from './errors';
import { rubyDtoa } from './floatFormat';
import { hashGet } from './hashes';
import { callMethod, type Gen, respondsTo } from './interp';
import { kernelFloat, kernelInteger } from './libNumeric';
import { NIL, RHash, RString, RSymbol, type Value } from './objects';
import { rt } from './runtime';
import { joinStringCharacters, realClassOf, stringBytes, stringCharacters, stringFromBytes } from './values';

interface Spec {
  minus: boolean;
  plus: boolean;
  space: boolean;
  zero: boolean;
  sharp: boolean;
  width?: number;
  precision?: number;
}

/** Formats as `format`/`sprintf` and `String#%` do. */
export function* format(formatValue: Value, args: Value[]): Gen<string> {
  return (yield* formatString(formatValue, args)).s;
}

export function* formatString(formatValue: Value, args: Value[]): Gen<RString> {
  const { parts, binary } = yield* formatParts(formatValue, args);
  const chunks = parts.map(stringBytes);
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  rt().checkStringLength(length);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return stringFromBytes(bytes, binary);
}

function* formatParts(formatValue: Value, args: Value[]): Gen<{ parts: RString[]; binary: boolean }> {
  const source = yield* toStrValue(formatValue);
  const templateBytes = stringBytes(source);
  const template = new TextDecoder('latin1').decode(templateBytes);
  let result = '';
  let literal: number[] = [];
  const parts: RString[] = [];
  let binary = source.binary;
  let ascii = true;
  const flush = (): void => {
    if (literal.length > 0) {
      const value = stringFromBytes(Uint8Array.from(literal), source.binary);
      parts.push(value);
      ascii &&= stringBytes(value).every((byte) => byte < 0x80);
      result += value.s;
      rt().checkStringLength(result.length);
    }
    literal = [];
  };
  const append = (part: string | RString): void => {
    flush();
    const value = part instanceof RString ? part : stringFromBytes(encodeCodePoints(part));
    binary = combinedStringEncoding(binary, ascii, value);
    parts.push(value);
    ascii &&= stringBytes(value).every((byte) => byte < 0x80);
    result += part instanceof RString ? part.s : part;
    rt().checkStringLength(result.length);
  };
  let next = 0;
  let argumentMode: 'none' | 'numbered' | 'unnumbered' | 'named' = 'none';
  let hashArg: RHash | undefined;
  const takeArg = (): Value => {
    if (argumentMode === 'numbered') throw argumentError(`unnumbered(${next + 1}) mixed with numbered`);
    if (argumentMode === 'named') throw argumentError(`unnumbered(${next + 1}) mixed with named`);
    argumentMode = 'unnumbered';
    if (next >= args.length) throw argumentError('too few arguments');
    return args[next++];
  };
  const numberedArg = (digits: string): Value => {
    if (argumentMode === 'unnumbered') throw argumentError(`numbered(${Number(digits)}) after unnumbered(${next})`);
    if (argumentMode === 'named') throw argumentError(`numbered(${Number(digits)}) after named`);
    argumentMode = 'numbered';
    const value = args[Number(digits) - 1];
    if (value === undefined) throw argumentError(`invalid index - ${digits}$`);
    return value;
  };
  const namedArg = function* (name: string): Gen {
    if (argumentMode === 'unnumbered') throw argumentError(`named{${name}} after unnumbered(${next})`);
    if (argumentMode === 'numbered') throw argumentError(`named{${name}} after numbered`);
    argumentMode = 'named';
    hashArg ??= args.length === 1 && args[0] instanceof RHash ? args[0] : undefined;
    if (!hashArg) throw argumentError('one hash required');
    const entry = yield* hashGet(hashArg, RSymbol.of(name));
    if (!entry) {
      throw rubyError(rt().c.KeyError, `key<${name}> not found`);
    }
    return entry.value;
  };
  const nameAt = (start: number, end: number): string =>
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(templateBytes.subarray(start, end));
  for (let index = 0; index < template.length; index++) {
    const char = template[index];
    if (char !== '%') {
      literal.push(templateBytes[index]);
      continue;
    }
    index++;
    if (index >= template.length) throw argumentError('incomplete format specifier; use %% (double %) instead');
    if (template[index] === '%') {
      literal.push(0x25);
      continue;
    }
    const spec: Spec = { minus: false, plus: false, space: false, zero: false, sharp: false };
    let value: Value | undefined;
    let braceSubstitution = false;
    for (;;) {
      const flag = template[index];
      if (flag === '-') spec.minus = true;
      else if (flag === '+') spec.plus = true;
      else if (flag === ' ') spec.space = true;
      else if (flag === '0') spec.zero = true;
      else if (flag === '#') spec.sharp = true;
      else if (flag === '<' || flag === '{') {
        const close = template.indexOf(flag === '<' ? '>' : '}', index);
        if (close === -1) throw argumentError('malformed name - unmatched parenthesis');
        const name = nameAt(index + 1, close);
        const named = yield* namedArg(name);
        index = close;
        if (flag === '{') {
          append(padStringValue(yield* toSValue(named), spec));
          braceSubstitution = true;
          break;
        }
        value = named;
      } else break;
      index++;
    }
    if (braceSubstitution) continue;
    let digits = /^\d+/.exec(template.slice(index))?.[0];
    if (digits && template[index + digits.length] === '$') {
      value = numberedArg(digits);
      index += digits.length + 1;
      digits = /^\d+/.exec(template.slice(index))?.[0];
    }
    if (template[index] === '*') {
      index++;
      const selected = /^(\d+)\$/.exec(template.slice(index));
      const width = yield* toRubyInt(selected ? numberedArg(selected[1]) : takeArg());
      if (width < 0) spec.minus = true;
      spec.width = Math.abs(width);
      if (selected) index += selected[0].length;
    } else if (digits) {
      spec.width = Number(digits);
      index += digits.length;
    }
    if (template[index] === '.') {
      index++;
      if (template[index] === '*') {
        index++;
        const selected = /^(\d+)\$/.exec(template.slice(index));
        const precision = yield* toRubyInt(selected ? numberedArg(selected[1]) : takeArg());
        spec.precision = precision < 0 ? undefined : precision;
        if (selected) index += selected[0].length;
      } else {
        const precision = /^\d*/.exec(template.slice(index))?.[0] ?? '';
        spec.precision = Number(precision || '0');
        index += precision.length;
      }
    }
    if (template[index] === '<') {
      const close = template.indexOf('>', index);
      value = yield* namedArg(nameAt(index + 1, close));
      index = close + 1;
    }
    const type = template[index];
    if (type === undefined) throw argumentError('incomplete format specifier; use %% (double %) instead');
    rt().checkStringLength(Math.max(spec.width ?? 0, spec.precision ?? 0));
    const arg = (): Value => value ?? takeArg();
    append(yield* directive(type, spec, arg));
  }
  flush();
  return { parts, binary };
}

function encodeCodePoints(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const point = text.codePointAt(index) as number;
    if (point > 0xff_ff) index++;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x8_00) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x1_00_00) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    else
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f)
      );
  }
  return Uint8Array.from(bytes);
}

// code-gauge-allow functionNcss 37 -- Ruby's format directives and flags are dispatched together.
function* directive(type: string, spec: Spec, arg: () => Value): Gen<string | RString> {
  switch (type) {
    case 'd':
    case 'i':
    case 'u': {
      return formatInteger(yield* intArg(arg()), 10, spec, '');
    }
    case 'b':
    case 'B': {
      const value = yield* intArg(arg());
      return formatInteger(value, 2, spec, spec.sharp && value !== 0n ? `0${type}` : '');
    }
    case 'o': {
      return formatInteger(yield* intArg(arg()), 8, spec, spec.sharp ? '0' : '');
    }
    case 'x':
    case 'X': {
      const value = yield* intArg(arg());
      const text = formatInteger(value, 16, spec, spec.sharp && value !== 0n ? `0${type}` : '');
      return type === 'X' ? text.toUpperCase() : text;
    }
    case 'f':
    case 'e':
    case 'E':
    case 'g':
    case 'G':
    case 'a':
    case 'A': {
      return formatFloatDirective(type, yield* floatArg(arg()), spec);
    }
    case 's': {
      return padStringValue(yield* toSValue(arg()), spec);
    }
    case 'p': {
      const inspected = yield* inspectValue(arg());
      return padStringValue(inspected.binary ? exportBinaryInspect(inspected) : inspected, spec);
    }
    case 'c': {
      return yield* characterDirective(arg(), spec);
    }
    case '\n':
    case '\0': {
      return `%${type}`;
    }
    default: {
      throw argumentError(`malformed format string - %${type}`);
    }
  }
}

function* characterDirective(value: Value, spec: Spec): Gen<string | RString> {
  let string = value instanceof RString ? value : undefined;
  if (!string && respondsTo(value, 'to_str', true)) {
    const converted = yield* callMethod(value, 'to_str', [], undefined, undefined, { fcall: true });
    if (converted instanceof RString) string = converted;
    else if (converted !== NIL) {
      const name = realClassOf(value).name;
      throw typeError(`can't convert ${name} to String (${name}#to_str gives ${realClassOf(converted).name})`);
    }
  }
  if (string)
    return padStringValue(stringCharacters(string)[0] ?? stringFromBytes(new Uint8Array()), {
      ...spec,
      precision: undefined,
    });
  const point = yield* toInt(value);
  if (point < -0x80_00_00_00_00_00_00_00n || point > 0x7f_ff_ff_ff_ff_ff_ff_ffn)
    throw rangeError("bignum too big to convert into 'long'");
  if (point < -2_147_483_648n) throw rangeError(`integer ${point} too small to convert to 'int'`);
  if (point > 2_147_483_647n) throw rangeError(`integer ${point} too big to convert to 'int'`);
  if (point < 0n || point > 0x10_ff_ffn) throw argumentError('invalid character');
  return pad(String.fromCodePoint(Number(point)), spec, false);
}

function padStringValue(value: RString, spec: Spec): RString {
  const chars = stringCharacters(value);
  const selected = spec.precision === undefined ? chars : chars.slice(0, spec.precision);
  const content = stringBytes(joinStringCharacters(selected, value.binary));
  const padding = Math.max(0, (spec.width ?? 0) - selected.length);
  rt().checkStringLength(content.length + padding);
  const bytes = new Uint8Array(content.length + padding);
  bytes.fill(0x20);
  bytes.set(content, spec.minus ? 0 : padding);
  return stringFromBytes(bytes, value.binary);
}

export function exportBinaryInspect(value: RString): RString {
  const bytes = stringBytes(value);
  if (bytes.every((byte) => byte < 0x80)) return value;
  let text = '';
  const escapes: Record<number, string> = {
    0: String.raw`\0`,
    7: String.raw`\a`,
    8: String.raw`\b`,
    9: String.raw`\t`,
    10: String.raw`\n`,
    11: String.raw`\v`,
    12: String.raw`\f`,
    13: String.raw`\r`,
    27: String.raw`\e`,
    127: String.raw`\c?`,
  };
  for (const [index, byte] of bytes.entries()) {
    if (index % 256 === 0) rt().spend(256);
    text +=
      escapes[byte] ??
      (byte < 32 || byte >= 128
        ? `\\x${byte.toString(16).toUpperCase().padStart(2, '0')}`
        : String.fromCodePoint(byte));
  }
  rt().checkStringLength(text.length);
  return stringFromBytes(new TextEncoder().encode(text));
}

function* intArg(value: Value): Gen<bigint> {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw floatDomainError(formatFloat(value));
    }
    return floatToInt(value);
  }
  if (value instanceof RString) {
    return (yield* kernelInteger([value], undefined)) as bigint;
  }
  if (value === NIL) throw typeError("can't convert nil into Integer");
  const converted = yield* callMethod(value, 'to_i', [], undefined, undefined, { fcall: true });
  if (typeof converted === 'bigint') return converted;
  throw typeError(`can't convert ${realClassOf(value).name} into Integer`);
}

function* floatArg(value: Value): Gen<number> {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof RString) {
    return (yield* kernelFloat(value, undefined)) as number;
  }
  if (value === NIL) throw typeError("can't convert nil into Float");
  const converted = yield* callMethod(value, 'to_f', [], undefined, undefined, { fcall: true });
  if (typeof converted === 'number') return converted;
  throw typeError(`can't convert ${realClassOf(value).name} into Float`);
}

function signOf(negative: boolean, spec: Spec): string {
  if (negative) return '-';
  if (spec.plus) return '+';
  if (spec.space) return ' ';
  return '';
}

// code-gauge-allow functionCognitiveComplexity 30 -- Ruby's format directives and flags.
function formatInteger(value: bigint, base: number, spec: Spec, prefix: string): string {
  const negative = value < 0n;
  let digits: string;
  let sign: string;
  if (negative && base !== 10 && !spec.plus && !spec.space) {
    digits = twosComplement(value, base);
    sign = '';
    if (spec.precision !== undefined && digits.length < spec.precision) {
      const fill = base === 2 ? '1' : base === 8 ? '7' : 'f';
      digits = fill.repeat(spec.precision - digits.length + 2) + digits.slice(2);
    }
  } else {
    digits = (negative ? -value : value).toString(base);
    sign = signOf(negative, spec);
    if (spec.precision !== undefined) digits = digits.padStart(spec.precision, '0');
  }
  if (prefix === '0' && digits.startsWith('0')) prefix = '';
  const body = prefix + digits;
  const width = spec.width ?? 0;
  if (spec.zero && !spec.minus && spec.precision === undefined && sign.length + body.length < width) {
    if (digits.startsWith('..')) {
      const fill = base === 2 ? '1' : base === 8 ? '7' : 'f';
      return sign + prefix + digits.slice(2).padStart(width - sign.length - prefix.length, fill);
    }
    return sign + prefix + digits.padStart(width - sign.length - prefix.length, '0');
  }
  return pad(sign + body, spec, false);
}

/** Ruby's notation for a negative number in base 2, 8, or 16 without a sign: `..f01` for -255. */
function twosComplement(value: bigint, base: number): string {
  const bitsPerDigit = base === 2 ? 1 : base === 8 ? 3 : 4;
  const magnitude = -value;
  const bits = magnitude === 1n ? 0 : (magnitude - 1n).toString(2).length;
  const digits = Math.max(1, Math.ceil((bits + 1) / bitsPerDigit));
  rt().checkStringLength(digits + 2);
  rt().spend(Math.ceil(digits / 256));
  let text = ((1n << BigInt((digits + 1) * bitsPerDigit)) + value).toString(base);
  const fill = base === 2 ? '1' : base === 8 ? '7' : 'f';
  while (text.length > 1 && text[0] === fill && text[1] === fill) text = text.slice(1);
  return `..${text}`;
}

function formatFloatDirective(type: string, value: number, spec: Spec): string {
  const negative = value < 0 || Object.is(value, -0);
  const sign = signOf(negative, spec);
  if (!Number.isFinite(value)) {
    const text = Number.isNaN(value) ? 'NaN' : 'Inf';
    return pad(sign + text, { ...spec, zero: false }, false);
  }
  const magnitude = Math.abs(value);
  let body: string;
  const lower = type.toLowerCase();
  if (lower === 'f') {
    body = fixedDigits(magnitude, spec.precision ?? 6);
    if (spec.sharp && (spec.precision ?? 6) === 0) body += '.';
  } else if (lower === 'e') {
    body = exponentText(magnitude, spec.precision ?? 6, spec.sharp);
  } else if (lower === 'g') {
    body = generalText(magnitude, spec.precision ?? 6, spec.sharp);
  } else {
    body = hexFloat(magnitude, spec.precision);
    if (spec.sharp && !body.includes('.')) body = body.replace('p', '.p');
  }
  if (type === 'E' || type === 'G' || type === 'A') body = body.toUpperCase();
  const width = spec.width ?? 0;
  if (spec.zero && !spec.minus && sign.length + body.length < width) {
    return sign + body.padStart(width - sign.length, '0');
  }
  return pad(sign + body, spec, false);
}

/** `%.*f` digits of a non-negative value, as Ruby's vfprintf lays out what `dtoa` gives in mode 3. */
function fixedDigits(value: number, precision: number): string {
  if (value === 0) return precision > 0 ? `0.${'0'.repeat(precision)}` : '0';
  const { digits, decpt } = rubyDtoa(value, 3, precision);
  let integer: string;
  let fraction: string;
  if (decpt <= 0) {
    integer = '0';
    fraction = '0'.repeat(-decpt) + digits;
  } else {
    integer = digits.slice(0, decpt).padEnd(decpt, '0');
    fraction = digits.slice(decpt);
  }
  fraction = fraction.slice(0, precision).padEnd(precision, '0');
  return precision > 0 ? `${integer}.${fraction}` : integer;
}

function exponentDigits(value: number, significant: number): { digits: string; exponent: number } {
  if (value === 0) return { digits: '0', exponent: 0 };
  const { digits, decpt } = rubyDtoa(value, 2, significant);
  return { digits: digits || '0', exponent: decpt - 1 };
}

function exponentText(value: number, precision: number, sharp: boolean): string {
  const { digits, exponent } = exponentDigits(value, precision + 1);
  const padded = digits.padEnd(precision + 1, '0');
  const mantissa = precision > 0 ? `${padded[0]}.${padded.slice(1)}` : `${padded[0]}${sharp ? '.' : ''}`;
  return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

function generalText(value: number, precision: number, sharp: boolean): string {
  const significant = precision === 0 ? 1 : precision;
  const { digits, exponent } = exponentDigits(value, significant);
  if (exponent < -4 || exponent >= significant) {
    let body = sharp ? digits.padEnd(significant, '0') : digits;
    body = body.length > 1 ? `${body[0]}.${body.slice(1)}` : body + (sharp ? '.' : '');
    return `${body}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  const decimals = Math.max(0, significant - 1 - exponent);
  let text = fixedFromDigits(digits, exponent + 1, sharp ? decimals : Math.max(0, digits.length - exponent - 1));
  if (sharp && !text.includes('.')) text += '.';
  return text;
}

function fixedFromDigits(digits: string, decpt: number, decimals: number): string {
  let integer: string;
  let fraction: string;
  if (decpt <= 0) {
    integer = '0';
    fraction = '0'.repeat(-decpt) + digits;
  } else {
    integer = digits.slice(0, decpt).padEnd(decpt, '0');
    fraction = digits.slice(decpt);
  }
  fraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return decimals > 0 ? `${integer}.${fraction}` : integer;
}

function hexFloat(value: number, precision: number | undefined): string {
  if (value === 0) return `0x0${precision ? `.${'0'.repeat(precision)}` : ''}p+0`;
  let exponent = Math.min(1023, Math.floor(Math.log2(value)));
  let mantissa = value / 2 ** exponent;
  while (mantissa < 1) {
    mantissa *= 2;
    exponent--;
  }
  if (mantissa >= 2) {
    mantissa /= 2;
    exponent++;
  }
  if (precision !== undefined && precision <= 13 && mantissa === 2 - Number.EPSILON) {
    const next = exponent + 1;
    return `0x1${precision ? `.${'0'.repeat(precision)}` : ''}p${next < 0 ? '-' : '+'}${Math.abs(next)}`;
  }
  let fraction = '';
  let rest = mantissa - 1;
  while (rest > 0 && fraction.length < 13) {
    rest *= 16;
    const digit = Math.floor(rest);
    fraction += digit.toString(16);
    rest -= digit;
  }
  if (precision !== undefined) {
    const digits = Math.min(precision, 13);
    const scale = 16 ** digits;
    const scaled = mantissa * scale;
    const whole = Math.floor(scaled);
    const remainder = scaled - whole;
    let rounded = whole + (remainder > 0.5 || (remainder === 0.5 && whole % 2 === 1) ? 1 : 0);
    if (rounded === 2 * scale) {
      rounded = scale;
      exponent++;
    }
    fraction = precision === 0 ? '' : (rounded - scale).toString(16).padStart(digits, '0').padEnd(precision, '0');
  }
  return `0x1${fraction ? `.${fraction}` : ''}p${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
}

function pad(text: string, spec: Spec, zero: boolean): string {
  const width = spec.width ?? 0;
  const length = [...text].length;
  if (length >= width) return text;
  const fill = (zero ? '0' : ' ').repeat(width - length);
  return spec.minus ? text + fill : fill + text;
}
