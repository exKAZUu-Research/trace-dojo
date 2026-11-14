import type { Scalar, Value } from '../arith';
import { CRuntimeError } from '../errors';
import type { Runtime } from '../runtime';
import { storerOf } from '../runtime';
import { CHAR, type CType, INT, INT_PROPERTIES, LONG, SHORT } from '../types';
import { unsupportedMessage } from '../unsupported';
import { formatFixed, formatGeneral, formatHex, formatScientific } from './floatFormat';
import { readCString, startsWithAt } from './support';

interface Spec {
  flags: string;
  width?: number;
  precision?: number;
  length: string;
  conversion: string;
}

/** Reads the variadic arguments of a call in order, checking each against what its conversion reads. */
class Arguments {
  private index = 0;

  constructor(
    private readonly values: Value[],
    private readonly types: CType[]
  ) {}

  private next(): { value: Value; type: CType } {
    if (this.index >= this.values.length) throw new CRuntimeError('formatArgumentMissing');
    const value = this.values[this.index];
    const type = this.types[this.index];
    this.index++;
    return { value, type };
  }

  /** An integer of `bits` bits, as the conversion reads it from an argument's slot. */
  integer(bits: 32 | 64): bigint {
    const { value, type } = this.next();
    if (type.kind !== 'int') throw new CRuntimeError('formatArgumentType');
    const size = INT_PROPERTIES[type.name].size;
    // An argument narrower than what the conversion reads leaves the rest of its slot undefined.
    if (bits === 64 && size < 8) throw new CRuntimeError('formatArgumentType');
    return BigInt(value as Scalar);
  }

  double(): number {
    const { value, type } = this.next();
    if (type.kind !== 'float') throw new CRuntimeError('formatArgumentType');
    return value as number;
  }

  pointer(): number {
    const { value, type } = this.next();
    if (type.kind !== 'pointer') throw new CRuntimeError('formatArgumentType');
    return value as number;
  }
}

/** Formats a `printf` format string and its arguments into bytes, as macOS's libc does. */
// code-gauge-allow functionCognitiveComplexity 17 -- Format parsing and byte/text field emission share argument and output positions; keep their ordered traversal together.
export function formatPrintf(runtime: Runtime, format: Uint8Array, values: Value[], types: CType[]): number[] {
  const out: number[] = [];
  const args = new Arguments(values, types);
  let index = 0;
  const pushText = (text: string): void => {
    for (const char of text) out.push(char.codePointAt(0) ?? 0);
  };
  while (index < format.length) {
    const byte = format[index++];
    if (byte !== 0x25) {
      out.push(byte);
      continue;
    }
    const spec: Spec = { flags: '', length: '', conversion: '' };
    index = readSpec(format, index, spec, args);
    if (index >= format.length) break;
    spec.conversion = String.fromCodePoint(format[index++]);
    runtime.spend(Math.max(spec.width ?? 0, /[diuoxXfFeEgGaA]/.test(spec.conversion) ? (spec.precision ?? 0) : 0));
    const field = convert(runtime, spec, args, out.length);
    if (field === undefined) continue;
    if (typeof field === 'string') pushText(pad(spec, field));
    else for (const byte of padBytes(spec, field)) out.push(byte);
  }
  return out;
}

// code-gauge-allow functionCognitiveComplexity 18 -- Flags, dynamic width, precision, and modifiers are one sequential format-specifier grammar.
// code-gauge-allow functionNcss 33 -- Flags, dynamic width, precision, and modifiers are one sequential format-specifier grammar.
function readSpec(format: Uint8Array, start: number, spec: Spec, args: Arguments): number {
  let index = start;
  while (index < format.length && '-+ #0'.includes(String.fromCodePoint(format[index]))) {
    spec.flags += String.fromCodePoint(format[index++]);
  }
  if (format[index] === 0x2a) {
    index++;
    const width = Number(BigInt.asIntN(32, args.integer(32)));
    if (width < 0) {
      spec.flags += '-';
      spec.width = -width;
    } else spec.width = width;
  } else {
    const digits = readDigits(format, index);
    index += digits.length;
    if (digits) spec.width = Number(digits);
  }
  if (format[index] === 0x2e) {
    index++;
    if (format[index] === 0x2a) {
      index++;
      const precision = Number(BigInt.asIntN(32, args.integer(32)));
      if (precision >= 0) spec.precision = precision;
    } else {
      const digits = readDigits(format, index);
      index += digits.length;
      spec.precision = Number(digits || '0');
    }
  }
  const modifier = LENGTH_MODIFIERS.find((candidate) => startsWithAt(format, index, candidate));
  if (modifier) {
    spec.length = modifier;
    index += modifier.length;
  }
  return index;
}

const LENGTH_MODIFIERS = ['hh', 'h', 'll', 'l', 'j', 'z', 't', 'L', 'q'];

function readDigits(format: Uint8Array, start: number): string {
  let digits = '';
  for (let index = start; index < format.length && format[index] >= 0x30 && format[index] <= 0x39; index++) {
    digits += String.fromCodePoint(format[index]);
  }
  return digits;
}

// code-gauge-allow functionNcss 48 -- One case per printf conversion; helpers already isolate numeric and string formatting.
function convert(runtime: Runtime, spec: Spec, args: Arguments, written: number): string | Uint8Array | undefined {
  const { conversion, length } = spec;
  const wide = ['l', 'll', 'j', 'z', 't', 'q'].includes(length) || 'DOU'.includes(conversion);
  switch (conversion) {
    case 'd':
    case 'i':
    case 'D': {
      let value = args.integer(wide ? 64 : 32);
      value = narrow(value, length, true, wide);
      return integerField(spec, value < 0n ? -value : value, value < 0n ? '-' : signOf(spec), 10, '');
    }
    case 'u':
    case 'o':
    case 'x':
    case 'X':
    case 'U':
    case 'O': {
      return unsignedField(spec, narrow(args.integer(wide ? 64 : 32), length, false, wide));
    }
    case 'c': {
      if (length === 'l') throw new CRuntimeError('custom', unsupportedMessage('ワイド文字（%lc）'));
      const value = Number(BigInt.asUintN(8, args.integer(32)));
      return Uint8Array.of(value);
    }
    case 's': {
      if (length === 'l') throw new CRuntimeError('custom', unsupportedMessage('ワイド文字列（%ls）'));
      return stringField(runtime, spec, args.pointer());
    }
    case 'p': {
      const address = args.pointer();
      return integerField({ ...spec, flags: spec.flags.replace('#', '') }, BigInt(address), '', 16, '0x');
    }
    case 'f':
    case 'F':
    case 'e':
    case 'E':
    case 'g':
    case 'G':
    case 'a':
    case 'A': {
      return floatField(spec, args.double());
    }
    case 'n': {
      storeWritten(runtime, length, args.pointer(), written);
      return undefined;
    }
    case '%': {
      return '%';
    }
    case 'C':
    case 'S': {
      throw new CRuntimeError('custom', unsupportedMessage(`ワイド文字（%${conversion}）`));
    }
    default: {
      // macOS's printf prints an unknown conversion's character as it is.
      return conversion;
    }
  }
}

function unsignedField(spec: Spec, value: bigint): string {
  const { conversion } = spec;
  const base = conversion === 'o' || conversion === 'O' ? 8 : conversion === 'x' || conversion === 'X' ? 16 : 10;
  let prefix = '';
  if (spec.flags.includes('#') && value !== 0n && base === 16) prefix = conversion === 'X' ? '0X' : '0x';
  return integerField(spec, value, '', base, prefix, conversion === 'X');
}

function stringField(runtime: Runtime, spec: Spec, address: number): string | Uint8Array {
  if (address === 0) {
    const text = '(null)';
    return spec.precision === undefined ? text : text.slice(0, spec.precision);
  }
  return readCString(runtime, address, spec.precision);
}

function storeWritten(runtime: Runtime, length: string, address: number, written: number): void {
  const type = length === 'hh' ? CHAR : length === 'h' ? SHORT : length === '' ? INT : LONG;
  storerOf(type)(runtime, address, INT_PROPERTIES[type.name].size === 8 ? BigInt(written) : written);
}

function signOf(spec: Spec): string {
  if (spec.flags.includes('+')) return '+';
  if (spec.flags.includes(' ')) return ' ';
  return '';
}

/** Narrows an argument to the width that the length modifier names, as the conversion converts it. */
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
  if (spec.precision !== undefined) {
    digits = spec.precision === 0 && magnitude === 0n ? '' : digits.padStart(spec.precision, '0');
  }
  if (base === 8 && spec.flags.includes('#') && !digits.startsWith('0')) digits = `0${digits}`;
  const body = digits;
  const lead = sign + prefix;
  const width = spec.width ?? 0;
  if (spec.flags.includes('0') && !spec.flags.includes('-') && spec.precision === undefined) {
    return lead + body.padStart(width - lead.length, '0');
  }
  return lead + body;
}

// code-gauge-allow functionCognitiveComplexity 18 -- Format variants share sign, alternate-form, case, and padding rules; retain that coordination together.
// code-gauge-allow functionNcss 36 -- Format variants share sign, alternate-form, case, and padding rules; retain that coordination together.
function floatField(spec: Spec, value: number): string {
  const { conversion } = spec;
  const upper = conversion === conversion.toUpperCase();
  const negative = value < 0 || Object.is(value, -0);
  const sign = negative ? '-' : signOf(spec);
  const magnitude = Math.abs(value);
  const alternate = spec.flags.includes('#');
  if (!Number.isFinite(magnitude)) {
    const text = Number.isNaN(magnitude) ? 'nan' : 'inf';
    // macOS prints no sign for a NaN.
    const shownSign = Number.isNaN(magnitude) ? '' : sign;
    return shownSign + (upper ? text.toUpperCase() : text);
  }
  let body: string;
  switch (conversion.toLowerCase()) {
    case 'f': {
      body = formatFixed(magnitude, spec.precision ?? 6);
      if (alternate && !body.includes('.')) body += '.';
      break;
    }
    case 'e': {
      body = formatScientific(magnitude, spec.precision ?? 6, alternate);
      break;
    }
    case 'g': {
      body = formatGeneral(magnitude, spec.precision ?? 6, alternate);
      break;
    }
    default: {
      body = formatHex(magnitude, spec.precision, alternate);
      break;
    }
  }
  if (upper) body = body.toUpperCase();
  const width = spec.width ?? 0;
  if (spec.flags.includes('0') && !spec.flags.includes('-')) {
    if (conversion.toLowerCase() === 'a') {
      const prefix = body.slice(0, 2);
      return sign + prefix + body.slice(2).padStart(width - sign.length - 2, '0');
    }
    return sign + body.padStart(width - sign.length, '0');
  }
  return sign + body;
}

function pad(spec: Spec, text: string): string {
  const width = spec.width ?? 0;
  if (text.length >= width) return text;
  return spec.flags.includes('-')
    ? text.padEnd(width, ' ')
    : text.padStart(width, spec.flags.includes('0') && ['s', 'c', '%'].includes(spec.conversion) ? '0' : ' ');
}

function padBytes(spec: Spec, bytes: Uint8Array): Uint8Array {
  const width = spec.width ?? 0;
  const padding = Math.max(width - bytes.length, 0);
  const result = new Uint8Array(bytes.length + padding).fill(
    spec.flags.includes('0') && !spec.flags.includes('-') ? 0x30 : 0x20
  );
  result.set(bytes, spec.flags.includes('-') ? 0 : padding);
  return result;
}
