import { formatFloat, inspect, toS, toStr } from './conversions';
import { argumentError, floatDomainError, rubyError, typeError } from './errors';
import { rubyDtoa } from './floatFormat';
import { hashGet } from './hashes';
import { callMethod, type Gen } from './interp';
import { kernelFloat, kernelInteger } from './libNumeric';
import { NIL, RHash, RString, RSymbol, type Value } from './objects';
import { rt } from './runtime';
import { realClassOf } from './values';

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
  const template = yield* toStr(formatValue);
  let result = '';
  let next = 0;
  let hashArg: RHash | undefined;
  const takeArg = (): Value => {
    if (next >= args.length) throw argumentError('too few arguments');
    return args[next++];
  };
  const namedArg = function* (name: string): Gen {
    hashArg ??= args.length === 1 && args[0] instanceof RHash ? args[0] : undefined;
    if (!hashArg) throw argumentError('one hash required');
    const entry = yield* hashGet(hashArg, RSymbol.of(name));
    if (!entry) {
      throw rubyError(rt().c.KeyError, `key<${name}> not found`);
    }
    return entry.value;
  };
  for (let index = 0; index < template.length; index++) {
    const char = template[index];
    if (char !== '%') {
      result += char;
      continue;
    }
    index++;
    if (index >= template.length) throw argumentError('incomplete format specifier; use %% (double %) instead');
    if (template[index] === '%') {
      result += '%';
      continue;
    }
    const spec: Spec = { minus: false, plus: false, space: false, zero: false, sharp: false };
    let value: Value | undefined;
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
        const name = template.slice(index + 1, close);
        const named = yield* namedArg(name);
        index = close;
        if (flag === '{') {
          result += pad(yield* toS(named), spec, false);
          value = undefined;
          break;
        }
        value = named;
      } else break;
      index++;
    }
    if (template[index - 1] === '}' && value === undefined && template[index - 1 - 0] === '}') {
      index--;
      continue;
    }
    let digits = /^\d+/.exec(template.slice(index))?.[0];
    if (digits && template[index + digits.length] === '$') {
      value = args[Number(digits) - 1];
      if (value === undefined) throw argumentError(`invalid index - ${digits}$`);
      index += digits.length + 1;
      digits = /^\d+/.exec(template.slice(index))?.[0];
    }
    if (template[index] === '*') {
      const width = Number(yield* intArg(takeArg()));
      if (width < 0) spec.minus = true;
      spec.width = Math.abs(width);
      index++;
    } else if (digits) {
      spec.width = Number(digits);
      index += digits.length;
    }
    if (template[index] === '.') {
      index++;
      if (template[index] === '*') {
        spec.precision = Number(yield* intArg(takeArg()));
        index++;
      } else {
        const precision = /^\d*/.exec(template.slice(index))?.[0] ?? '';
        spec.precision = Number(precision || '0');
        index += precision.length;
      }
    }
    if (template[index] === '<') {
      const close = template.indexOf('>', index);
      value = yield* namedArg(template.slice(index + 1, close));
      index = close + 1;
    }
    const type = template[index];
    if (type === undefined) throw argumentError('incomplete format specifier; use %% (double %) instead');
    const arg = (): Value => value ?? takeArg();
    result += yield* directive(type, spec, arg);
  }
  return result;
}

// code-gauge-allow functionNcss 43 -- Ruby's format directives and flags.
function* directive(type: string, spec: Spec, arg: () => Value): Gen<string> {
  switch (type) {
    case 'd':
    case 'i':
    case 'u': {
      return formatInteger(yield* intArg(arg()), 10, spec, '');
    }
    case 'b':
    case 'B': {
      return formatInteger(yield* intArg(arg()), 2, spec, spec.sharp ? `0${type}` : '');
    }
    case 'o': {
      return formatInteger(yield* intArg(arg()), 8, spec, spec.sharp ? '0' : '');
    }
    case 'x':
    case 'X': {
      const text = formatInteger(yield* intArg(arg()), 16, spec, spec.sharp ? `0${type}` : '');
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
      let text = yield* toS(arg());
      if (spec.precision !== undefined) text = [...text].slice(0, spec.precision).join('');
      return pad(text, spec, false);
    }
    case 'p': {
      let text = yield* inspect(arg());
      if (spec.precision !== undefined) text = [...text].slice(0, spec.precision).join('');
      return pad(text, spec, false);
    }
    case 'c': {
      const value = arg();
      let text: string;
      text = value instanceof RString ? ([...value.s][0] ?? '') : String.fromCodePoint(Number(yield* intArg(value)));
      return pad(text, spec, false);
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

function* intArg(value: Value): Gen<bigint> {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw floatDomainError(formatFloat(value));
    }
    return BigInt(Math.floor(value));
  }
  if (value instanceof RString) {
    return (yield* kernelInteger([value], undefined)) as bigint;
  }
  if (value === NIL) throw typeError("can't convert nil into Integer");
  const converted = yield* callMethod(value, 'to_i', []);
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
  const converted = yield* callMethod(value, 'to_f', []);
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
  const bitsPerDigit = base === 2 ? 1n : base === 8 ? 3n : 4n;
  let digits = 1n;
  while (-value > (1n << (digits * bitsPerDigit)) / 2n) digits++;
  let text = ((1n << ((digits + 1n) * bitsPerDigit)) + value).toString(base);
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
  let exponent = Math.floor(Math.log2(value));
  let mantissa = value / 2 ** exponent;
  if (mantissa >= 2) {
    mantissa /= 2;
    exponent++;
  }
  let fraction = '';
  let rest = mantissa - 1;
  while (rest > 0 && fraction.length < 13) {
    rest *= 16;
    const digit = Math.floor(rest);
    fraction += digit.toString(16);
    rest -= digit;
  }
  if (precision !== undefined) fraction = fraction.slice(0, precision).padEnd(precision, '0');
  return `0x1${fraction ? `.${fraction}` : ''}p${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
}

function pad(text: string, spec: Spec, zero: boolean): string {
  const width = spec.width ?? 0;
  const length = [...text].length;
  if (length >= width) return text;
  const fill = (zero ? '0' : ' ').repeat(width - length);
  return spec.minus ? text + fill : fill + text;
}
