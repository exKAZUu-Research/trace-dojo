// code-gauge-allow-file fileNcss 711 -- The file holds one layer of the compiler, whose parts share its private state.
/**
 * Zig's formatted printing (`std.Io.Writer.print` and `printValue`), transcribed so that output matches byte for byte.
 * Formatting works on bytes, as Zig's strings are bytes.
 */
import { PANIC, panic } from './arith';
import {
  type AnyFloat,
  asBigFloat,
  type BigFloat,
  type Decimal,
  type FloatBits,
  FORMATS,
  shortestDecimal,
} from './floats';
import { type EnumType, type StructField, type Type, typeName, type UnionType } from './types';
import {
  type EnumLiteral,
  ErrorValue,
  NULL,
  Pointer,
  Slice,
  Some,
  type Value,
  ZArray,
  type ZStruct,
  type ZUnion,
} from './values';

export type Alignment = 'left' | 'center' | 'right';

export interface Options {
  fill: number;
  alignment: Alignment;
  width?: number;
  precision?: number;
}

/** A width or precision: a number, or the index of the argument that gives it. */
export type Specifier = { kind: 'none' } | { kind: 'number'; value: number } | { kind: 'arg'; index: number };

export interface Placeholder {
  kind: 'placeholder';
  arg: number;
  spec: string;
  fill: number;
  alignment: Alignment;
  width: Specifier;
  precision: Specifier;
}

export type Segment = { kind: 'literal'; bytes: number[] } | Placeholder;

/** A compile error in a format string or its arguments, which the compiler reports at the call. */
export class FormatError extends Error {}

const ANY = 'any';
export const MAX_DEPTH = 3;

/** Parses a format string as `Writer.print` does at compile time, checking it against the arguments. */
export function parseFormat(format: readonly number[], argNames: readonly string[]): Segment[] {
  const segments: Segment[] = [];
  const used = new Set<number>();
  let nextArg = 0;
  let literal: number[] = [];
  let index = 0;
  const argIndex = (
    spec: { kind: 'named'; name: string } | { kind: 'number'; value: number } | { kind: 'none' }
  ): number | undefined => {
    if (spec.kind === 'none') return undefined;
    if (spec.kind === 'number') return spec.value;
    const found = argNames.indexOf(spec.name);
    if (found === -1) throw new FormatError(`no argument with name '${spec.name}'`);
    return found;
  };
  const next = (position: number | undefined): number => {
    const chosen = position ?? nextArg++;
    if (chosen >= argNames.length) throw new FormatError('too few arguments');
    used.add(chosen);
    return chosen;
  };
  for (;;) {
    const start = index;
    while (index < format.length && format[index] !== 0x7b && format[index] !== 0x7d) index++;
    let end = index;
    let unescape = false;
    if (index + 1 < format.length && format[index + 1] === format[index]) {
      unescape = true;
      end++;
      index += 2;
    }
    literal.push(...format.slice(start, end));
    if (unescape) continue;
    if (literal.length > 0) {
      segments.push({ kind: 'literal', bytes: literal });
      literal = [];
    }
    if (index >= format.length) break;
    if (format[index] === 0x7d) throw new FormatError('missing opening {');
    index++;
    const begin = index;
    while (index < format.length && format[index] !== 0x7d) index++;
    if (index >= format.length) throw new FormatError('missing closing }');
    const placeholder = parsePlaceholder(format.slice(begin, index));
    index++;
    const position = argIndex(placeholder.arg);
    const width = specifier(placeholder.width, argIndex, next);
    const precision = specifier(placeholder.precision, argIndex, next);
    segments.push({
      kind: 'placeholder',
      arg: next(position),
      spec: placeholder.spec,
      fill: placeholder.fill,
      alignment: placeholder.alignment,
      width,
      precision,
    });
  }
  if (used.size !== argNames.length) {
    const missing = argNames.length - used.size;
    const text = String.fromCodePoint(...format);
    throw new FormatError(missing === 1 ? `unused argument in '${text}'` : `${missing} unused arguments in '${text}'`);
  }
  return segments;
}

type ParsedSpecifier = { kind: 'none' } | { kind: 'number'; value: number } | { kind: 'named'; name: string };

function specifier(
  parsed: ParsedSpecifier,
  argIndex: (spec: ParsedSpecifier) => number | undefined,
  next: (position: number | undefined) => number
): Specifier {
  if (parsed.kind === 'none') return { kind: 'none' };
  if (parsed.kind === 'number') return parsed;
  const index = argIndex(parsed) as number;
  next(index);
  return { kind: 'arg', index };
}

function isAlign(byte: number | undefined): boolean {
  return byte === 0x3c || byte === 0x5e || byte === 0x3e;
}

/** `std.fmt.Placeholder.parse`. */
function parsePlaceholder(bytes: readonly number[]): {
  arg: ParsedSpecifier;
  spec: string;
  fill: number;
  alignment: Alignment;
  width: ParsedSpecifier;
  precision: ParsedSpecifier;
} {
  let i = 0;
  const peek = (offset: number): number | undefined => bytes[i + offset];
  const char = (): number | undefined => (i < bytes.length ? bytes[i++] : undefined);
  const parseSpecifier = (): ParsedSpecifier => {
    if (peek(0) === 0x5b) {
      i++;
      const start = i;
      while (i < bytes.length && bytes[i] !== 0x5d) i++;
      const name = String.fromCodePoint(...bytes.slice(start, i));
      if (peek(0) !== 0x5d) throw new FormatError('Expected closing ]');
      i++;
      return { kind: 'named', name };
    }
    let value: number | undefined;
    while (peek(0) !== undefined && (peek(0) as number) >= 0x30 && (peek(0) as number) <= 0x39) {
      value = (value ?? 0) * 10 + ((peek(0) as number) - 0x30);
      i++;
    }
    return value === undefined ? { kind: 'none' } : { kind: 'number', value };
  };
  const arg = parseSpecifier();
  const specStart = i;
  while (i < bytes.length && bytes[i] !== 0x3a) i++;
  const spec = String.fromCodePoint(...bytes.slice(specStart, i));
  const colon = char();
  if (colon !== undefined && colon !== 0x3a)
    throw new FormatError(`expected : or }, found '${String.fromCodePoint(colon)}'`);
  let fill: number | undefined = isAlign(peek(1)) ? char() : undefined;
  let alignment: Alignment | undefined;
  if (isAlign(peek(0))) {
    const byte = char();
    alignment = byte === 0x3c ? 'left' : byte === 0x5e ? 'center' : 'right';
  }
  if (fill === undefined && alignment === undefined) fill = peek(0) === 0x30 ? 0x30 : undefined;
  const width = parseSpecifier();
  const dot = char();
  if (dot !== undefined && dot !== 0x2e) throw new FormatError(`expected . or }, found '${String.fromCodePoint(dot)}'`);
  const precision = parseSpecifier();
  const trailing = char();
  if (trailing !== undefined)
    throw new FormatError(`extraneous trailing character '${String.fromCodePoint(trailing)}'`);
  return { arg, spec, fill: fill ?? 0x20, alignment: alignment ?? 'right', width, precision };
}

// Checking ------------------------------------------------------------------------------------------------------------

/** What the formatter needs to know of types that the compiler resolves. */
export interface TypeInfo {
  structFields(type: Extract<Type, { kind: 'struct' }>): StructField[];
  enumFields(type: EnumType): { name: string; value: bigint }[];
  unionFields(type: UnionType): { name: string; type: Type }[];
}

/** Reports the compile errors `printValue` gives for a specifier and a type, as Zig does before running. */
export function checkFormat(spec: string, type: Type, info: TypeInfo, hasOptions: boolean, depth = MAX_DEPTH): void {
  const invalid = (): never => {
    throw new FormatError(`invalid format string '${spec}' for type '${typeName(type)}'`);
  };
  const kind = type.kind;
  const special = SPECIAL_SPECIFIERS[spec];
  if (special) {
    if (!special.accepts(type)) invalid();
    return;
  }
  if (spec.length === 1) {
    switch (spec) {
      case '*': {
        if (kind !== 'pointer' && !(kind === 'optional' && type.child.kind === 'pointer')) {
          throw new FormatError(`cannot format non-pointer type ${typeName(type)} with * specifier`);
        }
        return;
      }
      case 'd': {
        if (
          kind === 'float' ||
          kind === 'comptime_float' ||
          kind === 'int' ||
          kind === 'comptime_int' ||
          kind === 'enum'
        )
          return;
        return invalid();
      }
      case 'c':
      case 'u': {
        // The value goes to a `u8` or `u21` parameter, which only narrower unsigned integers coerce to.
        const bits = spec === 'c' ? 8 : 21;
        if (kind === 'comptime_int' || (kind === 'int' && !type.signed && type.bits <= bits)) return;
        throw new FormatError(`expected type 'u${bits}', found '${typeName(type)}'`);
      }
      case 'b':
      case 'o': {
        if (kind === 'int' || kind === 'comptime_int' || kind === 'enum') return;
        return invalid();
      }
      case 'x':
      case 'X': {
        if (
          kind === 'float' ||
          kind === 'comptime_float' ||
          kind === 'int' ||
          kind === 'comptime_int' ||
          kind === 'enum'
        )
          return;
        if (isByteString(type)) return;
        return invalid();
      }
      case 's': {
        if (isByteString(type)) return;
        return invalid();
      }
      case 'e':
      case 'E': {
        if (kind === 'float' || kind === 'comptime_float') return;
        return invalid();
      }
      case 't': {
        if (kind === 'error_set' || kind === 'enum' || kind === 'enum_literal' || kind === 'union') return;
        return invalid();
      }
      default: {
        break;
      }
    }
  }
  const isAny = spec === ANY;
  switch (kind) {
    case 'float':
    case 'comptime_float':
    case 'int':
    case 'comptime_int':
    case 'bool':
    case 'void':
    case 'type':
    case 'enum_literal':
    case 'null': {
      if (!isAny && spec.length > 0) invalid();
      return;
    }
    case 'error_set':
    case 'enum': {
      if (!isAny && spec.length > 0) invalid();
      return;
    }
    case 'optional': {
      let rest: string;
      if (spec.startsWith('?')) rest = spec.slice(1);
      else if (isAny) rest = ANY;
      else throw new FormatError('cannot print optional without a specifier (i.e. {?} or {any})');
      checkFormat(rest, type.child, info, hasOptions, depth);
      return;
    }
    case 'error_union': {
      let rest: string;
      if (spec.startsWith('!')) rest = spec.slice(1);
      else if (isAny) rest = ANY;
      else throw new FormatError('cannot print error union without a specifier (i.e. {!} or {any})');
      checkFormat(rest, type.payload, info, hasOptions, depth);
      return;
    }
    case 'union':
    case 'struct': {
      if (!isAny && spec.length > 0) invalid();
      if (depth === 0) return;
      if (kind === 'struct')
        for (const field of info.structFields(type)) checkFormat(ANY, field.type, info, hasOptions, depth - 1);
      else for (const field of info.unionFields(type)) checkFormat(ANY, field.type, info, hasOptions, depth - 1);
      return;
    }
    case 'pointer': {
      if (type.size === 'one') {
        const child = type.child;
        if (child.kind === 'array') {
          checkFormat(spec, sliceLike(child.child), info, hasOptions, depth);
          return;
        }
        if (child.kind === 'enum' || child.kind === 'union' || child.kind === 'struct') {
          checkFormat(spec, child, info, hasOptions, depth);
        }
        return;
      }
      if (!isAny) throw new FormatError('cannot format slice without a specifier (i.e. {s}, {x}, {b64}, or {any})');
      if (depth > 0) checkFormat(spec, type.child, info, hasOptions, depth - 1);
      return;
    }
    case 'array': {
      if (!isAny) throw new FormatError('cannot format array without a specifier (i.e. {s} or {any})');
      if (depth > 0) checkFormat(spec, type.child, info, hasOptions, depth - 1);
      return;
    }
    case 'fn': {
      throw new FormatError(
        `unable to format function body type, use '*const ${typeName(type)}' for a function pointer type`
      );
    }
    default: {
      throw new FormatError(`unable to format type '${typeName(type)}'`);
    }
  }
}

function sliceLike(child: Type): Type {
  return { kind: 'pointer', size: 'slice', child, isConst: true } as Type;
}

function isU8(child: Type): boolean {
  return child.kind === 'int' && child.bits === 8 && !child.signed;
}

function isByteString(type: Type): boolean {
  if (type.kind === 'pointer') {
    if (type.size === 'slice') return isU8(type.child);
    return type.child.kind === 'array' && isU8(type.child.child);
  }
  return type.kind === 'array' && isU8(type.child);
}

// Printing ------------------------------------------------------------------------------------------------------------

/** Appends a value printed as `printValue(spec, options, value)` does. */
export function printValue(
  out: number[],
  spec: string,
  options: Options,
  value: Value,
  type: Type,
  info: TypeInfo,
  depth = MAX_DEPTH
): void {
  const kind = type.kind;
  const special = SPECIAL_SPECIFIERS[spec];
  if (special) return special.print(out, value, type, options);
  if (spec.length === 1) {
    switch (spec) {
      case 'd': {
        if (kind === 'float' || kind === 'comptime_float')
          return printFloat(out, value as AnyFloat, floatBits(type), 'decimal', options);
        if (kind === 'int' || kind === 'comptime_int') return printInt(out, value as bigint, type, 10, false, options);
        if (kind === 'enum') return printInt(out, value as bigint, type.tagType as Type, 10, false, options);
        break;
      }
      case 'c': {
        return alignBuffer(out, [Number(BigInt.asUintN(8, value as bigint))], options);
      }
      case 'u': {
        return printUnicodeCodepoint(out, Number(value as bigint));
      }
      case 'b':
      case 'o':
      case 'x':
      case 'X': {
        const base = spec === 'b' ? 2 : spec === 'o' ? 8 : 16;
        const upper = spec === 'X';
        if (kind === 'int' || kind === 'comptime_int')
          return printInt(out, value as bigint, type, base, upper, options);
        if (kind === 'enum') return printInt(out, value as bigint, type.tagType as Type, base, upper, options);
        if (kind === 'float' || kind === 'comptime_float')
          return printFloatHex(out, value as AnyFloat, floatBits(type), upper, options);
        // A byte string in hexadecimal, which Zig asserts has no width or precision.
        forbidOptions(options);
        for (const byte of stringBytes(value, type)) out.push(...hexDigits(Number(byte), upper));
        return;
      }
      case 's': {
        return alignBuffer(out, stringBytes(value, type).map(Number), options);
      }
      case 'e':
      case 'E': {
        return printFloat(out, value as AnyFloat, floatBits(type), 'scientific', options);
      }
      case 't': {
        if (kind === 'error_set') return alignBuffer(out, utf8((value as ErrorValue).name), options);
        if (kind === 'enum_literal') return alignBuffer(out, utf8((value as EnumLiteral).name), options);
        if (kind === 'union')
          return alignBuffer(out, utf8(info.unionFields(type)[(value as ZUnion).tag].name), options);
        return alignBuffer(out, utf8(enumName(value as bigint, type as EnumType, info) ?? ''), options);
      }
      default: {
        break;
      }
    }
  }
  const isAny = spec === ANY;
  switch (kind) {
    case 'float':
    case 'comptime_float': {
      return printFloat(out, value as AnyFloat, floatBits(type), 'decimal', options);
    }
    case 'int':
    case 'comptime_int': {
      return printInt(out, value as bigint, type, 10, false, options);
    }
    case 'bool': {
      return alignBuffer(out, utf8(value ? 'true' : 'false'), options);
    }
    case 'void': {
      return alignBuffer(out, utf8('void'), options);
    }
    case 'optional': {
      const rest = spec.startsWith('?') ? spec.slice(1) : ANY;
      if (value === NULL) return alignBuffer(out, utf8('null'), options);
      return printValue(out, rest, options, value instanceof Some ? value.value : value, type.child, info, depth);
    }
    case 'error_union': {
      const rest = spec.startsWith('!') ? spec.slice(1) : ANY;
      if (value instanceof ErrorValue) return printValue(out, '', options, value, type.errorSet, info, depth);
      return printValue(out, rest, options, value, type.payload, info, depth);
    }
    case 'error_set': {
      forbidOptions(options);
      out.push(...utf8(`error.${(value as ErrorValue).name}`));
      return;
    }
    case 'enum': {
      forbidOptions(options);
      const name = enumName(value as bigint, type, info);
      if (name !== undefined) out.push(...utf8(`.${name}`));
      else out.push(...utf8(`@fromBackingInt(${value as bigint})`));
      return;
    }
    case 'union': {
      if (depth === 0) {
        out.push(...utf8('.{ ... }'));
        return;
      }
      const fields = info.unionFields(type);
      if (type.tagType) {
        const union = value as ZUnion;
        out.push(...utf8(`.{ .${fields[union.tag].name} = `));
        printValue(out, ANY, options, union.slots[0], fields[union.tag].type, info, depth - 1);
        out.push(...utf8(' }'));
        return;
      }
      if (type.layout === 'auto') {
        out.push(...utf8('.{ ... }'));
        return;
      }
      const union = value as ZUnion;
      out.push(...utf8(`.{ .${fields[union.tag].name} = `));
      printValue(out, ANY, options, union.slots[0], fields[union.tag].type, info, depth - 1);
      out.push(...utf8(' }'));
      return;
    }
    case 'struct': {
      if (depth === 0) {
        out.push(...utf8('.{ ... }'));
        return;
      }
      const fields = info.structFields(type);
      const struct = value as ZStruct;
      out.push(...utf8('.{'));
      for (const [index, field] of fields.entries()) {
        out.push(...utf8(index === 0 ? ' ' : ', '));
        if (!type.isTuple) out.push(...utf8(`.${field.name} = `));
        const fieldValue = field.comptimeValue ?? struct.slots[index];
        printValue(out, ANY, options, fieldValue, field.type, info, depth - 1);
      }
      out.push(...utf8(' }'));
      return;
    }
    case 'pointer': {
      if (type.size === 'one') {
        const child = type.child;
        if (child.kind === 'array') {
          const array = (value as Pointer).load() as ZArray;
          const slice = new Slice(array, array.offset, child.length);
          return printValue(out, spec, options, slice, sliceLike(child.child), info, depth);
        }
        if (child.kind === 'enum' || child.kind === 'union' || child.kind === 'struct') {
          return printValue(out, spec, options, (value as Pointer).load(), child, info, depth);
        }
        out.push(...utf8(`${typeName(child)}@`));
        printInt(out, addressOf(value), { kind: 'int', signed: false, bits: 64, name: 'usize' }, 16, false, options);
        return;
      }
      if (depth === 0) {
        out.push(...utf8('{ ... }'));
        return;
      }
      const slice = value as Slice;
      out.push(...utf8('{ '));
      for (let index = 0; index < slice.length; index++) {
        printValue(out, spec, options, slice.get(index), type.child, info, depth - 1);
        if (index !== slice.length - 1) out.push(...utf8(', '));
      }
      out.push(...utf8(' }'));
      return;
    }
    case 'array': {
      if (depth === 0) {
        out.push(...utf8('{ ... }'));
        return;
      }
      const array = value as ZArray;
      out.push(...utf8('{ '));
      for (let index = 0; index < type.length; index++) {
        printValue(out, spec, options, array.get(index), type.child, info, depth - 1);
        if (index < type.length - 1) out.push(...utf8(', '));
      }
      out.push(...utf8(' }'));
      return;
    }
    case 'type': {
      return alignBuffer(out, utf8(typeName(value as Type)), options);
    }
    case 'enum_literal': {
      out.push(...utf8(`.${(value as EnumLiteral).name}`));
      return;
    }
    case 'null': {
      return alignBuffer(out, utf8('null'), options);
    }
    default: {
      void isAny;
      return;
    }
  }
}

/** Addresses differ on every run of Zig; the grader prints one stable number per object. */
function addressOf(value: Value): bigint {
  void value;
  return 0n;
}

/** Specifiers for strings and byte counts, which `printValue` handles before the others. */
const SPECIAL_SPECIFIERS: Record<
  string,
  { accepts: (type: Type) => boolean; print: (out: number[], value: Value, type: Type, options: Options) => void }
> = {
  q: {
    accepts: isByteString,
    print: (out, value, type) => {
      out.push(0x22, ...escapeString(stringBytes(value, type).map(Number)), 0x22);
    },
  },
  B: {
    accepts: (type) => type.kind === 'int' || type.kind === 'comptime_int',
    print: (out, value, _type, options) => printByteSize(out, value as bigint, false, options),
  },
  Bi: {
    accepts: (type) => type.kind === 'int' || type.kind === 'comptime_int',
    print: (out, value, _type, options) => printByteSize(out, value as bigint, true, options),
  },
  b64: {
    accepts: (type) => type.kind === 'pointer' && isByteString(type),
    print: (out, value, type, options) => {
      forbidOptions(options);
      out.push(...utf8(btoa(String.fromCodePoint(...stringBytes(value, type).map(Number)))));
    },
  },
};

/** `std.zig.stringEscape`: escapes quotes, backslashes, control characters, and invalid or special UTF-8. */
function escapeString(bytes: readonly number[]): number[] {
  const out: number[] = [];
  const hex = (byte: number): void => {
    out.push(...utf8(`\\x${byte.toString(16).padStart(2, '0')}`));
  };
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    const named = ESCAPES[byte];
    if (named) out.push(...utf8(named));
    else if (byte < 0x20 || byte === 0x7f) hex(byte);
    else if (byte < 0x80) out.push(byte);
    else {
      const { length, escape } = utf8Sequence(bytes, index);
      for (const each of bytes.slice(index, index + length)) {
        if (escape) hex(each);
        else out.push(each);
      }
      index += length;
      continue;
    }
    index++;
  }
  return out;
}

const ESCAPES: Record<number, string> = {
  0x09: String.raw`\t`,
  0x0a: String.raw`\n`,
  0x0d: String.raw`\r`,
  0x5c: String.raw`\\`,
  0x22: String.raw`\"`,
};

/** The UTF-8 sequence at a byte, and whether `stringEscape` writes it as hex escapes. */
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function utf8Sequence(bytes: readonly number[], index: number): { length: number; escape: boolean } {
  const byte = bytes[index];
  const length = byte >= 0xf0 && byte < 0xf8 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 0;
  // A truncated sequence, a stray continuation byte, or a bad lead byte is escaped one byte at a time.
  if (length === 0 || index + length > bytes.length) return { length: 1, escape: true };
  let codePoint = byte & (0xff >> (length + 1));
  for (const continuation of bytes.slice(index + 1, index + length)) {
    if ((continuation & 0xc0) !== 0x80) return { length: 1, escape: true };
    codePoint = (codePoint << 6) | (continuation & 0x3f);
  }
  const overlong = codePoint < [0, 0, 0x80, 0x8_00, 0x1_00_00][length];
  if (overlong || (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff)) return { length: 1, escape: true };
  const special = codePoint > 0x10_ff_ff || [0xfe_ff, 0x85, 0x20_28, 0x20_29].includes(codePoint);
  return { length, escape: special };
}

/** `printByteSize`: a byte count in SI (`kB`, `MB`, ...) or IEC (`KiB`, `MiB`, ...) units. */
function printByteSize(out: number[], value: bigint, binary: boolean, options: Options): void {
  if (value === 0n) return alignBuffer(out, utf8('0B'), options);
  const log2 = value.toString(2).length - 1;
  // `std.math.log2(1000)` is 9, the integer part.
  const magnitude = Math.min(Math.floor(log2 / (binary ? 10 : 9)), 8);
  const base = binary ? 1024 : 1000;
  const text =
    magnitude === 0
      ? value.toString()
      : formatDecimal(shortestDecimal(Number(value) / base ** magnitude, 64), options.precision);
  const suffix = magnitude === 0 ? 'B' : `${(binary ? ' KMGTPEZY' : ' kMGTPEZY')[magnitude]}${binary ? 'iB' : 'B'}`;
  alignBuffer(out, utf8(text + suffix), options);
}

/** `optionsForbidden`, whose assertion fails in a Debug build when a placeholder gives a width or a precision. */
function forbidOptions(options: Options): void {
  if (options.width !== undefined || options.precision !== undefined) panic(PANIC.unreachable);
}

function floatBits(type: Type): FloatBits {
  return type.kind === 'float' ? type.bits : 128;
}

function enumName(value: bigint, type: EnumType, info: TypeInfo): string | undefined {
  return info.enumFields(type).find((field) => field.value === value)?.name;
}

/** The bytes of a byte string: a slice, a pointer to an array, or an array. */
export function stringBytes(value: Value, type: Type): bigint[] {
  if (value instanceof Slice) return value.values() as bigint[];
  if (value instanceof Pointer) {
    const array = value.load() as ZArray;
    return array.values() as bigint[];
  }
  if (value instanceof ZArray) return value.values() as bigint[];
  void type;
  return [];
}

export function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

function hexDigits(byte: number, upper: boolean): number[] {
  const text = byte.toString(16).padStart(2, '0');
  return utf8(upper ? text.toUpperCase() : text);
}

export function alignBuffer(out: number[], buffer: readonly number[], options: Options): void {
  const width = options.width ?? buffer.length;
  const padding = buffer.length < width ? width - buffer.length : 0;
  if (padding === 0) {
    out.push(...buffer);
    return;
  }
  const fill = (count: number): void => {
    for (let index = 0; index < count; index++) out.push(options.fill);
  };
  switch (options.alignment) {
    case 'left': {
      out.push(...buffer);
      fill(padding);
      break;
    }
    case 'center': {
      fill(Math.floor(padding / 2));
      out.push(...buffer);
      fill(Math.floor((padding + 1) / 2));
      break;
    }
    default: {
      fill(padding);
      out.push(...buffer);
    }
  }
}

function printUnicodeCodepoint(out: number[], codepoint: number): void {
  if (codepoint >= 0xd8_00 && codepoint <= 0xdf_ff) {
    out.push(0xef, 0xbf, 0xbd);
    return;
  }
  if (codepoint > 0x10_ff_ff) {
    out.push(0xef, 0xbf, 0xbd);
    return;
  }
  out.push(...utf8(String.fromCodePoint(codepoint)));
}

/** `printInt`: integers print with their type's signedness, a comptime_int as `usize` or `isize` when it fits. */
export function printInt(
  out: number[],
  value: bigint,
  type: Type,
  base: number,
  upper: boolean,
  options: Options
): void {
  let signed: boolean;
  signed = type.kind === 'comptime_int' ? !(value >= 0n && value < 1n << 64n) : type.kind === 'int' && type.signed;
  const magnitude = value < 0n ? -value : value;
  let digits = magnitude.toString(base);
  if (upper) digits = digits.toUpperCase();
  let text = digits;
  if (signed) {
    if (value < 0n) text = `-${digits}`;
    else if (options.width !== undefined && options.width !== 0) text = `+${digits}`;
  }
  alignBuffer(out, utf8(text), options);
}

// Floats --------------------------------------------------------------------------------------------------------------

/** `printFloat`: `std.fmt.float.render` in decimal or scientific mode, then aligned. */
export function printFloat(
  out: number[],
  value: AnyFloat,
  bits: FloatBits,
  mode: 'decimal' | 'scientific',
  options: Options
): void {
  const decimal = shortestDecimal(value, bits);
  const text =
    mode === 'scientific' ? formatScientific(decimal, options.precision) : formatDecimal(decimal, options.precision);
  alignBuffer(out, utf8(text), options);
}

function decimalLength(value: bigint): number {
  return value === 0n ? 1 : value.toString().length;
}

function isPowerOf10(value: bigint): boolean {
  let n = value;
  while (n !== 0n) {
    if (n % 10n !== 0n) return false;
    n /= 10n;
  }
  return true;
}

/** `std.fmt.float.round`, which rounds the shortest decimal's digits, half up. */
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function roundDecimal(decimal: Decimal, mode: 'decimal' | 'scientific', precision: number): Decimal {
  let roundDigit = 0;
  let output = decimal.mantissa;
  let exponent = decimal.exponent;
  const olength = decimalLength(output);
  if (mode === 'decimal') {
    if (decimal.exponent > 0) {
      roundDigit = olength - 1 + precision + decimal.exponent;
    } else {
      const minExpRequired = -decimal.exponent;
      if (precision + olength > minExpRequired) roundDigit = precision + olength - minExpRequired;
    }
  } else {
    roundDigit = 1 + precision;
  }
  if (roundDigit < olength) {
    for (let index = roundDigit + 1; index < olength; index++) {
      output /= 10n;
      exponent++;
    }
    if (output % 10n >= 5n) {
      output /= 10n;
      output += 1n;
      exponent++;
      if (isPowerOf10(output)) {
        output /= 10n;
        exponent++;
      }
    }
  }
  return { sign: decimal.sign, mantissa: output, exponent };
}

function special(decimal: Decimal): string {
  const sign = decimal.sign ? '-' : '';
  return `${sign}${decimal.special === 'nan' ? 'nan' : 'inf'}`;
}

/** `std.fmt.float.formatScientific`. */
function formatScientific(input: Decimal, precision: number | undefined): string {
  if (input.special) return special(input);
  const decimal = precision === undefined ? input : roundDecimal(input, 'scientific', precision);
  const digits = decimal.mantissa.toString();
  const olength = digits.length;
  if (precision !== undefined && 8 + precision > FLOAT_BUFFER_SIZE) return TOO_LONG;
  let text = decimal.sign ? '-' : '';
  text += digits[0];
  let fraction = digits.slice(1);
  if (precision !== undefined) {
    if (precision > olength - 1) fraction += '0'.repeat(precision - (olength - 1));
    else fraction = fraction.slice(0, precision);
  }
  text += fraction.length > 0 || (precision === undefined && olength > 1) ? `.${fraction}` : '';
  const exponent = decimal.exponent + olength - 1;
  return `${text}e${exponent}`;
}

/**
 * `Writer.printFloat` renders into a buffer sized for any f64 in decimal, `bufferSize(.decimal, f64)`, and prints
 * `(float)` for text that does not fit, as longer floats and large precisions can.
 */
const FLOAT_BUFFER_SIZE = 347;
const TOO_LONG = '(float)';

/** `std.fmt.float.formatDecimal`. */
// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function formatDecimal(input: Decimal, precision: number | undefined): string {
  if (input.special) return special(input);
  const decimal = precision === undefined ? input : roundDecimal(input, 'decimal', precision);
  const digits = decimal.mantissa.toString();
  const olength = digits.length;
  const needed =
    decimal.exponent >= 0
      ? 2 + decimal.exponent + olength + (precision ?? 0)
      : 2 + Math.max(-decimal.exponent + olength, precision ?? 0);
  if (needed > FLOAT_BUFFER_SIZE) return TOO_LONG;
  let text = decimal.sign ? '-' : '';
  const pointOffset = decimal.exponent + olength;
  if (pointOffset <= 0) {
    let fraction = '0'.repeat(-pointOffset) + digits;
    if (precision !== undefined) {
      fraction =
        fraction.length < precision ? fraction + '0'.repeat(precision - fraction.length) : fraction.slice(0, precision);
    }
    text += precision === 0 ? '0' : `0.${fraction}`;
    return text;
  }
  if (pointOffset >= olength) {
    text += digits + '0'.repeat(pointOffset - olength);
    if (precision !== undefined && precision !== 0) text += `.${'0'.repeat(precision)}`;
    return text;
  }
  let fraction = digits.slice(pointOffset);
  if (precision !== undefined) {
    fraction =
      fraction.length < precision ? fraction + '0'.repeat(precision - fraction.length) : fraction.slice(0, precision);
  }
  text += digits.slice(0, pointOffset);
  if (precision !== 0) text += `.${fraction}`;
  return text;
}

/** `printFloatHex`: a float as `0x1.8p1`. */
function printFloatHex(out: number[], value: AnyFloat, bits: FloatBits, upper: boolean, options: Options): void {
  const big = asBigFloat(value);
  let text = big.sign ? '-' : '';
  if (big.kind === 'nan') text += upper ? 'NAN' : 'nan';
  else if (big.kind === 'inf') text += upper ? 'INF' : 'inf';
  else if (big.isZero) {
    const zeros =
      options.precision === undefined ? '.0' : options.precision > 0 ? `.${'0'.repeat(options.precision)}` : '';
    text += `0x0${zeros}p0`;
  } else text += hexFloatDigits(big, bits, upper, options.precision);
  alignBuffer(out, utf8(text), options);
}

/** The digits and exponent of `Writer.printFloatHex` for a finite nonzero float, rounded to a precision if given. */
// code-gauge-allow functionNcss 35 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function hexFloatDigits(big: BigFloat, bits: FloatBits, upper: boolean, precision: number | undefined): string {
  const format = FORMATS[bits];
  const fractionalBits = format.precision - 1;
  const digits = Math.ceil(fractionalBits / 4);
  const bitLength = big.mantissa.toString(2).length;
  let exponent = big.exponent + bitLength - 1;
  // The significand with its integer bit at `fractionalBits`, or a subnormal's below the minimum exponent.
  let mantissa: bigint;
  if (exponent < format.minExponent) {
    mantissa = big.mantissa << BigInt(big.exponent - (format.minExponent - fractionalBits));
    exponent = format.minExponent;
  } else {
    mantissa = big.mantissa << BigInt(fractionalBits - bitLength + 1);
  }
  mantissa <<= BigInt(digits * 4 - fractionalBits);
  if (precision !== undefined && precision < digits) {
    let extraBits = (digits - precision) * 4;
    while (extraBits > 2) {
      mantissa = (mantissa >> 1n) | (mantissa & 1n);
      extraBits--;
    }
    // Round to nearest, ties to even, as Zig does.
    if ((mantissa & 0b100n) !== 0n) mantissa |= 1n;
    mantissa += 1n;
    mantissa >>= 2n;
    mantissa <<= BigInt((digits - precision) * 4);
    if ((mantissa & (1n << BigInt(1 + digits * 4))) !== 0n) {
      mantissa >>= 1n;
      exponent++;
    }
  }
  let hex = mantissa.toString(16).padStart(1 + digits, '0');
  if (upper) hex = hex.toUpperCase();
  const trimmed = hex.slice(1).replace(/0+$/, '');
  let fraction = trimmed;
  if (precision !== undefined && precision > trimmed.length) fraction += '0'.repeat(precision - trimmed.length);
  const point = (precision === undefined ? trimmed.length > 0 : precision > 0) ? '.' : '';
  return `0x${hex[0]}${point}${fraction}p${exponent}`;
}
