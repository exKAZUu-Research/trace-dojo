import { formatFixed, formatGeneral, formatHex, formatScientific } from '../../c/library/floatFormat';
import { CppRuntimeError } from '../errors';
import type { Runtime } from '../runtime';
import { intMax, type IntName, intRank, isCharType, isWide, type Type } from '../types';
import { Ptr, type Value } from '../values';
import { type CStringReadObserver, readCString } from './support';

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
// code-gauge-allow functionCognitiveComplexity -- The parser advances a single cursor through flags, width, precision, and the conversion.
// code-gauge-allow functionNcss -- The parser and argument cursor share the loop that emits each formatted field.
export function formatPrintf(
  format: string,
  args: PrintfArgument[],
  runtime: Runtime,
  observeRead?: CStringReadObserver
): string {
  let out = '';
  let next = 0;
  const take = (): PrintfArgument => {
    const arg = args[next++];
    if (!arg) throw new CppRuntimeError('formatArgumentMissing');
    return arg;
  };
  let index = 0;
  const readFieldSize = (): number | undefined => {
    if (format[index] === '*') {
      index++;
      return Number(integerOf(take(), 'int'));
    }
    const digits = /^\d+/.exec(format.slice(index))?.[0];
    if (digits === undefined) return undefined;
    index += digits.length;
    return Number(digits);
  };
  while (index < format.length) {
    const char = format[index++];
    if (char !== '%') {
      out += char;
      continue;
    }
    const spec: Spec = { flags: '', length: '', conversion: '' };
    while (index < format.length && '-+ #0'.includes(format[index])) spec.flags += format[index++];
    const width = readFieldSize();
    if (width !== undefined) {
      if (width < 0) spec.flags += '-';
      spec.width = Math.abs(width);
    }
    if (format[index] === '.') {
      index++;
      const precision = readFieldSize() ?? 0;
      if (precision >= 0) spec.precision = precision;
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
    runtime.spend(Math.max(spec.width ?? 0, spec.precision ?? 0));
    const field = convert(spec, take, out.length, runtime, observeRead);
    if (field !== undefined) out += pad(spec, field);
  }
  return out;
}

function integerOf(arg: PrintfArgument, expected: IntName, allowCorresponding = false): bigint {
  if (arg.type.kind !== 'int') throw new CppRuntimeError('formatArgumentType');
  const actual = arg.type.name;
  const value = BigInt(arg.value as number | bigint);
  if (actual === expected) return value;
  if (allowCorresponding && intRank(actual) === intRank(expected) && value >= 0n && value <= intMax(expected))
    return value;
  throw new CppRuntimeError('formatArgumentType');
}

// code-gauge-allow functionNcss -- A single dispatch shares conversion logic across specifiers with the same argument type.
function convert(
  spec: Spec,
  take: () => PrintfArgument,
  count: number,
  runtime: Runtime,
  observeRead?: CStringReadObserver
): string | undefined {
  const { conversion, length } = spec;
  switch (conversion) {
    case 'd':
    case 'i': {
      const value = readFormattedInteger(take(), length, true);
      return integerField(spec, value < 0n ? -value : value, value < 0n ? '-' : signOf(spec), 10, '');
    }
    case 'u':
    case 'o':
    case 'x':
    case 'X': {
      return unsignedIntegerField(spec, readFormattedInteger(take(), length, false));
    }
    case 'c': {
      if (length === 'l') throw new CppRuntimeError('custom', 'ワイド文字（%lc）は、この採点環境では使えません。');
      return String.fromCodePoint(Number(BigInt.asUintN(8, integerOf(take(), 'int'))));
    }
    case 's': {
      if (length === 'l') throw new CppRuntimeError('custom', 'ワイド文字列（%ls）は、この採点環境では使えません。');
      const arg = take();
      if (!(arg.value instanceof Ptr) || arg.type.kind !== 'pointer' || !isCharType(arg.type.to))
        throw new CppRuntimeError('formatArgumentType');
      return readCString(arg.value, runtime, spec.precision, observeRead);
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
      return floatField(spec, take());
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

const INTEGER_FORMAT_TYPES = new Map<string, readonly [IntName, IntName]>([
  ['', ['int', 'uint']],
  ['hh', ['schar', 'uchar']],
  ['h', ['short', 'ushort']],
  ['l', ['long', 'ulong']],
  ['ll', ['llong', 'ullong']],
  ['j', ['long', 'ulong']],
  ['z', ['long', 'ulong']],
  ['t', ['long', 'ulong']],
  ['q', ['llong', 'ullong']],
]);

function readFormattedInteger(arg: PrintfArgument, length: string, signed: boolean): bigint {
  const types = INTEGER_FORMAT_TYPES.get(length);
  if (!types) throw new CppRuntimeError('formatArgumentType');
  const name = types[signed ? 0 : 1];
  const promoted = intRank(name) < intRank('int') ? 'int' : name;
  return narrow(integerOf(arg, promoted, true), length, signed, isWide({ kind: 'int', name }));
}

function writeCount(arg: PrintfArgument, length: string, count: number): void {
  const type = arg.type.kind === 'pointer' ? arg.type.to : undefined;
  if (
    type?.kind !== 'int' ||
    type.name !== INTEGER_FORMAT_TYPES.get(length)?.[0] ||
    type.isConst ||
    !(arg.value instanceof Ptr)
  )
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
  return `0x${(pointer?.modeledAddress() ?? 0n).toString(16)}`;
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

function unsignedIntegerField(spec: Spec, value: bigint): string {
  const { conversion } = spec;
  const base = conversion === 'o' ? 8 : conversion === 'u' ? 10 : 16;
  const upper = conversion === 'X';
  const prefix = spec.flags.includes('#') && value !== 0n && base === 16 ? (upper ? '0X' : '0x') : '';
  return integerField(spec, value, '', base, prefix, upper);
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

function floatField(spec: Spec, arg: PrintfArgument): string {
  const expected = spec.length === 'L' ? 'ldouble' : 'double';
  if (arg.type.kind !== 'float' || arg.type.name !== expected) throw new CppRuntimeError('formatArgumentType');
  const value = Number(arg.value);
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
