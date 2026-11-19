import { formatFixed, formatGeneral, formatHex, formatScientific } from '../../c/library/floatFormat';
import { CppRuntimeError } from '../errors';
import { type IntName, isCharType, isWide, type Type } from '../types';
import { Ptr, type Value } from '../values';
import { readCString } from './support';

/** A conversion of `printf`, or what a stream's flags ask of `num_put`. */
export interface FloatFormat {
  conversion: 'f' | 'e' | 'g' | 'a';
  precision?: number;
  upper?: boolean;
  alternate?: boolean;
  sign?: '' | '+' | ' ';
}

/** Formats a double as macOS's libc does for a printf conversion, with its sign but without padding. */
export function formatFloat(value: number, format: FloatFormat): string {
  const { conversion, upper = false, alternate = false } = format;
  const negative = value < 0 || Object.is(value, -0);
  const sign = negative ? '-' : (format.sign ?? '');
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude)) {
    const text = Number.isNaN(magnitude) ? 'nan' : 'inf';
    // macOS prints no sign for a NaN.
    return (Number.isNaN(magnitude) ? '' : sign) + (upper ? text.toUpperCase() : text);
  }
  let body: string;
  switch (conversion) {
    case 'f': {
      body = formatFixed(magnitude, format.precision ?? 6);
      if (alternate && !body.includes('.')) body += '.';
      break;
    }
    case 'e': {
      body = formatScientific(magnitude, format.precision ?? 6, alternate);
      break;
    }
    case 'g': {
      body = formatGeneral(magnitude, format.precision ?? 6, alternate);
      break;
    }
    default: {
      body = formatHex(magnitude, format.precision, alternate);
    }
  }
  return sign + (upper ? body.toUpperCase() : body);
}

interface Spec {
  flags: string;
  width?: number;
  precision?: number;
  length: string;
  conversion: string;
}

/** An argument of `printf` after the default argument promotions, with its type. */
export interface PrintfArgument {
  value: Value;
  type: Type;
}

/** Formats `printf`'s format string and arguments into bytes, as macOS's libc does. */
export function formatPrintf(format: string, args: PrintfArgument[], spend: (cost: number) => void): string {
  let out = '';
  let next = 0;
  const take = (): PrintfArgument => {
    const arg = args[next++];
    if (!arg) throw new CppRuntimeError('formatArgumentMissing');
    return arg;
  };
  let index = 0;
  while (index < format.length) {
    const char = format[index++];
    if (char !== '%') {
      out += char;
      continue;
    }
    const spec: Spec = { flags: '', length: '', conversion: '' };
    while (index < format.length && '-+ #0'.includes(format[index])) spec.flags += format[index++];
    if (format[index] === '*') {
      index++;
      const width = Number(integerOf(take(), false));
      if (width < 0) {
        spec.flags += '-';
        spec.width = -width;
      } else spec.width = width;
    } else {
      const digits = /^\d*/.exec(format.slice(index))?.[0] ?? '';
      index += digits.length;
      if (digits) spec.width = Number(digits);
    }
    if (format[index] === '.') {
      index++;
      if (format[index] === '*') {
        index++;
        const precision = Number(integerOf(take(), false));
        if (precision >= 0) spec.precision = precision;
      } else {
        const digits = /^\d*/.exec(format.slice(index))?.[0] ?? '';
        index += digits.length;
        spec.precision = Number(digits || '0');
      }
    }
    const modifier = ['hh', 'h', 'll', 'l', 'j', 'z', 't', 'L', 'q'].find((candidate) =>
      format.startsWith(candidate, index)
    );
    if (modifier) {
      spec.length = modifier;
      index += modifier.length;
    }
    if (index >= format.length) break;
    spec.conversion = format[index++];
    spend(Math.max(spec.width ?? 0, spec.precision ?? 0));
    const field = convert(spec, take, out.length);
    if (field !== undefined) out += pad(spec, field);
  }
  return out;
}

function integerOf(arg: PrintfArgument, wide: boolean): bigint {
  if (arg.type.kind !== 'int') throw new CppRuntimeError('formatArgumentType');
  const size = ['long', 'ulong', 'llong', 'ullong'].includes(arg.type.name) ? 8 : 4;
  if (wide && size < 8) throw new CppRuntimeError('formatArgumentType');
  return BigInt(arg.value as number | bigint);
}

// code-gauge-allow functionNcss 40 -- One case per printf conversion.
function convert(spec: Spec, take: () => PrintfArgument, count: number): string | undefined {
  const { conversion, length } = spec;
  const wide = ['l', 'll', 'j', 'z', 't', 'q'].includes(length);
  switch (conversion) {
    case 'd':
    case 'i': {
      const value = narrow(integerOf(take(), wide), length, true, wide);
      return integerField(spec, value < 0n ? -value : value, value < 0n ? '-' : signOf(spec), 10, '');
    }
    case 'u':
    case 'o':
    case 'x':
    case 'X': {
      const value = narrow(integerOf(take(), wide), length, false, wide);
      const base = conversion === 'o' ? 8 : conversion === 'u' ? 10 : 16;
      const prefix = spec.flags.includes('#') && value !== 0n && base === 16 ? (conversion === 'X' ? '0X' : '0x') : '';
      return integerField(spec, value, '', base, prefix, conversion === 'X');
    }
    case 'c': {
      if (length === 'l') throw new CppRuntimeError('custom', 'ワイド文字（%lc）は、この採点環境では使えません。');
      return String.fromCodePoint(Number(BigInt.asUintN(8, integerOf(take(), false))));
    }
    case 's': {
      if (length === 'l') throw new CppRuntimeError('custom', 'ワイド文字列（%ls）は、この採点環境では使えません。');
      const arg = take();
      if (!(arg.value instanceof Ptr) || arg.type.kind !== 'pointer' || !isCharType(arg.type.to))
        throw new CppRuntimeError('formatArgumentType');
      return readCString(arg.value, spec.precision);
    }
    case 'p': {
      const arg = take();
      if (arg.type.kind !== 'pointer' && arg.type.kind !== 'nullptr') throw new CppRuntimeError('formatArgumentType');
      return pointerText(arg.value as Ptr);
    }
    case 'f':
    case 'F':
    case 'e':
    case 'E':
    case 'g':
    case 'G':
    case 'a':
    case 'A': {
      const arg = take();
      if (arg.type.kind !== 'float') throw new CppRuntimeError('formatArgumentType');
      return floatField(spec, arg.value as number);
    }
    case '%': {
      return '%';
    }
    case 'n': {
      writeCount(take(), length, count);
      return undefined;
    }
    default: {
      // macOS's printf prints an unknown conversion's character as it is.
      return conversion;
    }
  }
}

const COUNT_TYPES: Record<string, IntName> = {
  '': 'int',
  hh: 'schar',
  h: 'short',
  l: 'long',
  ll: 'llong',
  j: 'long',
  z: 'long',
  t: 'long',
  q: 'llong',
};

function writeCount(arg: PrintfArgument, length: string, count: number): void {
  const type = arg.type.kind === 'pointer' ? arg.type.to : undefined;
  if (type?.kind !== 'int' || type.name !== COUNT_TYPES[length] || type.isConst || !(arg.value instanceof Ptr))
    throw new CppRuntimeError('formatArgumentType');
  const wide = isWide(type);
  const value = narrow(BigInt(count), length, true, wide);
  arg.value.write(wide ? value : Number(value));
}

/**
 * The text of a pointer's value. The addresses of the real program depend on where its memory is, which the
 * interpreter cannot reproduce, so a pointer shows a made-up address that tells apart the objects it points to.
 */
export function pointerText(pointer: Ptr | undefined): string {
  if (!pointer || pointer.isNull) return '0x0';
  const { store, index } = pointer.address;
  const base = 0x6_00_00_00_00 + (store?.id ?? 0) * 0x1_00;
  return `0x${(base + index * 4).toString(16)}`;
}

function signOf(spec: Spec): string {
  if (spec.flags.includes('+')) return '+';
  if (spec.flags.includes(' ')) return ' ';
  return '';
}

function narrow(value: bigint, length: string, signed: boolean, wide: boolean): bigint {
  let bits = wide ? 64 : 32;
  if (length === 'hh') bits = 8;
  if (length === 'h') bits = 16;
  return signed ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
}

function integerField(
  spec: Spec,
  magnitude: bigint,
  sign: string,
  base: number,
  prefix: string,
  upper = false
): string {
  let digits = magnitude.toString(base);
  if (upper) digits = digits.toUpperCase();
  if (spec.precision !== undefined)
    digits = spec.precision === 0 && magnitude === 0n ? '' : digits.padStart(spec.precision, '0');
  if (base === 8 && spec.flags.includes('#') && !digits.startsWith('0')) digits = `0${digits}`;
  const lead = sign + prefix;
  const width = spec.width ?? 0;
  if (spec.flags.includes('0') && !spec.flags.includes('-') && spec.precision === undefined) {
    return lead + digits.padStart(width - lead.length, '0');
  }
  return lead + digits;
}

function floatField(spec: Spec, value: number): string {
  const lower = spec.conversion.toLowerCase() as FloatFormat['conversion'];
  const text = formatFloat(value, {
    conversion: lower,
    precision: spec.precision,
    upper: spec.conversion !== lower,
    alternate: spec.flags.includes('#'),
    sign: signOf(spec) as FloatFormat['sign'],
  });
  const width = spec.width ?? 0;
  if (spec.flags.includes('0') && !spec.flags.includes('-') && Number.isFinite(value)) {
    const sign = /^[+ -]/.test(text) ? text[0] : '';
    const body = text.slice(sign.length);
    if (lower === 'a') return sign + body.slice(0, 2) + body.slice(2).padStart(width - sign.length - 2, '0');
    return sign + body.padStart(width - sign.length, '0');
  }
  return text;
}

function pad(spec: Spec, text: string): string {
  const width = spec.width ?? 0;
  if (text.length >= width) return text;
  if (spec.flags.includes('-')) return text.padEnd(width, ' ');
  return text.padStart(width, spec.flags.includes('0') && ['s', 'c', '%'].includes(spec.conversion) ? '0' : ' ');
}
