import { checkOutputSize } from './allocation';
// code-gauge-allow-file fileNcss -- Keeps format parsing and rendering with their shared specifiers.
/**
 * Zig's formatted printing (`std.Io.Writer.print` and `printValue`), transcribed so that output matches byte for byte.
 * Formatting works on bytes, as Zig's strings are bytes.
 */
import { checked, indexOutOfBounds, PANIC, panic } from './arith';
import { activeUnionIndex, physicalUnion } from './bufferMemory';
import {
  type AnyFloat,
  asBigFloat,
  type BigFloat,
  type Decimal,
  type FloatBits,
  FORMATS,
  shortestDecimal,
} from './floats';
import { spendMemory } from './memoryAccounting';
import { POINTER_OPERATIONS, pointerShapeOf } from './semaBase';
import { type EnumType, type StructField, type Type, typeName, type UnionType, USIZE } from './types';
import { decodeIdentifierBytes, decodeUtf8, encodeIdentifierText } from './utf8';
import {
  type EnumLiteral,
  ErrorValue,
  NULL,
  Pointer,
  Slice,
  Some,
  type Value,
  type ZArray,
  type ZStruct,
  type ZUnion,
} from './values';

export type Alignment = 'left' | 'center' | 'right';

export interface Options {
  fill: number;
  alignment: Alignment;
  width?: bigint;
  precision?: bigint;
}

/** A width or precision: a number, or the index of the argument that gives it. */
export type Specifier = { kind: 'none' } | { kind: 'number'; value: bigint } | { kind: 'arg'; index: number };

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

type TemplateSegment =
  | Extract<Segment, { kind: 'literal' }>
  | ({ kind: 'placeholder' } & ReturnType<typeof parsePlaceholder>);

export interface FormatOutput {
  readonly length: number;
  push: (...bytes: number[]) => number;
  checkSize?: (length: number) => void;
  writeView?: (length: number, get: (index: number) => number, source?: Slice) => void;
  writeChunks?: (length: number, get: (index: number) => number, chunkSize: number) => void;
  repeat?: (byte: number, count: bigint) => void;
}

export interface FormatTemplate {
  readonly segments: readonly TemplateSegment[];
  readonly length: number;
  readonly text: string;
}

// code-gauge-allow functionNcss -- Binds placeholder selectors and options against one call’s arguments.
export function parseFormat(
  template: FormatTemplate,
  argNames: readonly string[],
  spend: (cost?: number) => void = () => {}
): Segment[] {
  const segments: Segment[] = [];
  spend(argNames.length);
  const nameIndexes = new Map(argNames.map((name, index) => [name, index]));
  const used = new Set<number>();
  let nextArg = 0;
  const argIndex = (spec: ParsedSpecifier): number | undefined => {
    if (spec.kind === 'none') return undefined;
    if (spec.kind === 'number') return Number(spec.value);
    spend(spec.name.length + 1);
    const found = nameIndexes.get(spec.name);
    if (found === undefined) throw new FormatError(`no argument with name '${spec.name}'`);
    return found;
  };
  const next = (position: number | undefined): number => {
    const chosen = position ?? nextArg++;
    if (chosen >= argNames.length) throw new FormatError('too few arguments');
    used.add(chosen);
    return chosen;
  };
  for (const placeholder of template.segments) {
    spend();
    if (placeholder.kind === 'literal') {
      segments.push(placeholder);
      continue;
    }
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
    const text = template.text;
    throw new FormatError(missing === 1 ? `unused argument in '${text}'` : `${missing} unused arguments in '${text}'`);
  }
  return segments;
}

// code-gauge-allow functionCognitiveComplexity -- Scans escaped braces and placeholders while preserving literal write boundaries.
// code-gauge-allow functionNcss -- Keeps the format lexer and its literal accumulation together.
export function parseFormatTemplate(format: Uint8Array, spend: (cost?: number) => void): FormatTemplate {
  const segments: TemplateSegment[] = [];
  let literal: number[] = [];
  let index = 0;
  for (;;) {
    while (index < format.length && format[index] !== 0x7b && format[index] !== 0x7d) {
      spend();
      literal.push(format[index++]);
    }
    spend();
    if (index + 1 < format.length && format[index + 1] === format[index]) {
      literal.push(format[index]);
      index += 2;
      continue;
    }
    if (literal.length > 0) {
      segments.push({ kind: 'literal', bytes: literal });
      literal = [];
    }
    if (index >= format.length) break;
    if (format[index] === 0x7d) throw new FormatError('missing opening {');
    index++;
    const begin = index;
    while (index < format.length && format[index] !== 0x7d) {
      spend();
      index++;
    }
    if (index >= format.length) throw new FormatError('missing closing }');
    const placeholder = parsePlaceholder(format.subarray(begin, index), spend);
    index++;
    segments.push({ kind: 'placeholder', ...placeholder });
  }
  let text: string | undefined;
  return {
    segments,
    length: format.length,
    get text() {
      if (text === undefined) {
        spend(format.length);
        text = decodeUtf8(format);
      }
      return text;
    },
  };
}

type ParsedSpecifier = { kind: 'none' } | { kind: 'number'; value: bigint } | { kind: 'named'; name: string };

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
function parsePlaceholder(
  bytes: Uint8Array,
  spend: (cost?: number) => void
): {
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
      while (i < bytes.length && bytes[i] !== 0x5d) {
        spend();
        i++;
      }
      const name = decodeIdentifierBytes(bytes.subarray(start, i), spend);
      if (peek(0) !== 0x5d) throw new FormatError('Expected closing ]');
      i++;
      return { kind: 'named', name };
    }
    let value: bigint | undefined;
    while (peek(0) !== undefined && (peek(0) as number) >= 0x30 && (peek(0) as number) <= 0x39) {
      spend();
      value = (value ?? 0n) * 10n + BigInt((peek(0) as number) - 0x30);
      if (value > (1n << 64n) - 1n) throw new FormatError('format option overflows usize');
      i++;
    }
    return value === undefined ? { kind: 'none' } : { kind: 'number', value };
  };
  const arg = parseSpecifier();
  const specStart = i;
  while (i < bytes.length && bytes[i] !== 0x3a) {
    spend();
    i++;
  }
  spend(i - specStart);
  const spec = decodeUtf8(bytes.subarray(specStart, i));
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
  enumFields(type: EnumType): ReadonlyMap<bigint, { name: string; value: bigint }>;
  unionFields(type: UnionType): { name: string; type: Type }[];
}

/** The specifiers that Zig's `printValue` applies to each element of a vector. */
const VECTOR_SPECIFIERS = new Set(['d', 'b', 'o', 'x', 'X']);

/** Reports the compile errors `printValue` gives for a specifier and a type, as Zig does before running. */
export function checkFormat(spec: string, type: Type, info: TypeInfo, hasOptions: boolean, depth = MAX_DEPTH): void {
  const invalid = (): never => {
    throw new FormatError(`invalid format string '${spec}' for type '${typeName(type)}'`);
  };
  const kind = type.kind;
  if (kind === 'enum') info.enumFields(type);
  if (type.kind === 'array' && type.isVector && spec !== 'any' && spec !== '') {
    // Zig prints a vector element by element only for the number specifiers.
    if (!VECTOR_SPECIFIERS.has(spec)) invalid();
    checkFormat(spec, type.child, info, hasOptions, depth);
    return;
  }
  const special = SPECIAL_SPECIFIERS.get(spec);
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
        if (kind === 'union') info.unionFields(type);
        if (kind === 'error_set' || kind === 'enum' || kind === 'enum_literal' || (kind === 'union' && type.tagType))
          return;
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
      // A vector formats its elements with the specifier, as `{ 1, 2 }`.
      if (!isAny && !type.isVector)
        throw new FormatError('cannot format array without a specifier (i.e. {s} or {any})');
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
    // A many-item or C pointer prints up to where std.mem.span ends it: its sentinel, or C's 0.
    // Zig spans it as a `[:0]const u8`, so another sentinel does not do.
    if (type.size === 'many' || type.size === 'c') return isU8(type.child) && sentinelOf(type) === 0n;
    return type.child.kind === 'array' && isU8(type.child.child);
  }
  return type.kind === 'array' && isU8(type.child);
}

/** Where `std.mem.span` ends an unbounded pointer: at its sentinel, and a C pointer at 0. */
function sentinelOf(type: Extract<Type, { kind: 'pointer' }>): Value | undefined {
  const { span } = POINTER_OPERATIONS[pointerShapeOf(type)];
  if (span === 'always') return 0n;
  return span === 'sentinel' ? type.sentinel?.value : undefined;
}

// Printing ------------------------------------------------------------------------------------------------------------

/** Appends a value printed as `printValue(spec, options, value)` does. */
export function printValue(
  out: FormatOutput,
  spec: string,
  options: Options,
  value: Value,
  type: Type,
  info: TypeInfo,
  depth = MAX_DEPTH
): void {
  const kind = type.kind;
  const special = SPECIAL_SPECIFIERS.get(spec);
  if (special) return special.print(out, value, type, options);
  if (spec.length === 1) {
    switch (spec) {
      case '*': {
        if (kind === 'pointer' || kind === 'optional') {
          appendBytes(out, utf8(`${typeName(type.child)}@`));
          printInt(out, addressOf(value), USIZE, 16, false, { fill: 32, alignment: 'right' });
          return;
        }
        break;
      }
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
        // A vector prints each element in the base, as an aggregate does below.
        if (kind === 'array' && type.isVector) break;
        // A byte string in hexadecimal, which Zig asserts has no width or precision.
        forbidOptions(options);
        const bytes = stringBytes(value, type);
        checkFormatSize(out, out.length + bytes.length * 2);
        for (const byte of bytes) for (const digit of hexDigits(byte, upper)) out.push(digit);
        return;
      }
      case 's': {
        return alignBuffer(out, stringBytes(value, type), options);
      }
      case 'e':
      case 'E': {
        return printFloat(out, value as AnyFloat, floatBits(type), 'scientific', options);
      }
      case 't': {
        if (kind === 'error_set') return alignBuffer(out, utf8((value as ErrorValue).name), options);
        if (kind === 'enum_literal') return alignBuffer(out, utf8((value as EnumLiteral).name), options);
        if (kind === 'union')
          return alignBuffer(out, utf8(info.unionFields(type)[activeUnionIndex(value as ZUnion)].name), options);
        const name = enumName(value as bigint, type as EnumType, info);
        if (name === undefined) panic(PANIC.invalidEnum);
        return alignBuffer(out, utf8(name), options);
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
      appendBytes(out, utf8(`error.${(value as ErrorValue).name}`));
      return;
    }
    case 'enum': {
      forbidOptions(options);
      const name = enumName(value as bigint, type, info);
      if (name !== undefined) appendBytes(out, utf8(`.${name}`));
      else appendBytes(out, utf8(`@fromBackingInt(${value as bigint})`));
      return;
    }
    case 'union': {
      if (depth === 0) {
        appendBytes(out, utf8('.{ ... }'));
        return;
      }
      const fields = info.unionFields(type);
      if (type.tagType) {
        const union = value as ZUnion;
        const field = fields[activeUnionIndex(union)];
        appendBytes(out, utf8(`.{ .${field.name} = `));
        printValue(out, ANY, options, union.slots[0], field.type, info, depth - 1);
        appendBytes(out, utf8(' }'));
        return;
      }
      if (type.layout === 'auto') {
        appendBytes(out, utf8('.{ ... }'));
        return;
      }
      const union = physicalUnion(type, value as ZUnion);
      appendBytes(out, utf8('.{'));
      for (const [index, field] of fields.entries()) {
        appendBytes(out, utf8(`${index === 0 ? ' ' : ', '}.${field.name} = `));
        printValue(out, ANY, options, union.fieldView!(index).slots[0], field.type, info, depth - 1);
      }
      appendBytes(out, utf8(' }'));
      return;
    }
    case 'struct': {
      if (depth === 0) {
        appendBytes(out, utf8('.{ ... }'));
        return;
      }
      const fields = info.structFields(type);
      const struct = value as ZStruct;
      appendBytes(out, utf8('.{'));
      for (const [index, field] of fields.entries()) {
        appendBytes(out, utf8(index === 0 ? ' ' : ', '));
        if (!type.isTuple) appendBytes(out, utf8(`.${field.name} = `));
        const fieldValue = field.comptimeValue ? field.comptimeValue.value : struct.slots[index];
        printValue(out, ANY, options, fieldValue, field.type, info, depth - 1);
      }
      appendBytes(out, utf8(' }'));
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
        appendBytes(out, utf8(`${typeName(child)}@`));
        printInt(out, addressOf(value), USIZE, 16, false, options);
        return;
      }
      // An unbounded pointer has no length to print elements to, so it prints as its address.
      if (type.size === 'many' || type.size === 'c') {
        appendBytes(out, utf8(`${typeName(type.child)}@`));
        printInt(out, addressOf(value), USIZE, 16, false, options);
        return;
      }
      if (depth === 0) {
        appendBytes(out, utf8('{ ... }'));
        return;
      }
      const slice = value as Slice;
      appendBytes(out, utf8('{ '));
      for (let index = 0; index < slice.length; index++) {
        printValue(out, spec, options, slice.get(index), type.child, info, depth - 1);
        if (index !== slice.length - 1) appendBytes(out, utf8(', '));
      }
      appendBytes(out, utf8(' }'));
      return;
    }
    case 'array': {
      if (depth === 0) {
        appendBytes(out, utf8('{ ... }'));
        return;
      }
      const array = value as ZArray;
      appendBytes(out, utf8('{ '));
      for (let index = 0; index < type.length; index++) {
        printValue(out, spec, options, array.get(index), type.child, info, depth - 1);
        if (index < type.length - 1n) appendBytes(out, utf8(', '));
      }
      appendBytes(out, utf8(' }'));
      return;
    }
    case 'type': {
      return alignBuffer(out, utf8(typeName(value as Type)), options);
    }
    case 'enum_literal': {
      appendBytes(out, utf8(`.${(value as EnumLiteral).name}`));
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

/** The interpreter prints zero for all addresses so grading output stays deterministic across runs. */
function addressOf(value: Value): bigint {
  void value;
  return 0n;
}

/** Specifiers for strings and byte counts, which `printValue` handles before the others. */
const SPECIAL_SPECIFIERS = new Map<
  string,
  { accepts: (type: Type) => boolean; print: (out: FormatOutput, value: Value, type: Type, options: Options) => void }
>([
  [
    'q',
    {
      accepts: isByteString,
      print: (out, value, type) => {
        const bytes = stringBytes(value, type);
        checkFormatSize(out, out.length + bytes.length + 2);
        out.push(0x22);
        appendEscapedString(out, bytes);
        out.push(0x22);
      },
    },
  ],
  [
    'B',
    {
      accepts: (type) => type.kind === 'int' || type.kind === 'comptime_int',
      print: (out, value, _type, options) => printByteSize(out, value as bigint, false, options),
    },
  ],
  [
    'Bi',
    {
      accepts: (type) => type.kind === 'int' || type.kind === 'comptime_int',
      print: (out, value, _type, options) => printByteSize(out, value as bigint, true, options),
    },
  ],
  [
    'b64',
    {
      accepts: isByteString,
      print: (out, value, type, options) => {
        forbidOptions(options);
        const bytes = base64Bytes(stringBytes(value, type));
        checkFormatSize(out, out.length + bytes.length);
        appendBuffer(out, bytes, 4);
      },
    },
  ],
]);

/** `std.zig.stringEscape`: escapes quotes, backslashes, control characters, and invalid or special UTF-8. */
function appendEscapedString(out: FormatOutput, bytes: ByteView): void {
  const hex = (byte: number): void => {
    appendBytes(out, utf8(String.raw`\x`));
    alignBuffer(out, utf8(byte.toString(16)), { fill: 0x30, alignment: 'right', width: 2n });
  };
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes.get(index);
    const named = ESCAPES[byte];
    if (named) appendBytes(out, utf8(named));
    else if (byte < 0x20 || byte === 0x7f) hex(byte);
    else if (byte < 0x80) out.push(byte);
    else {
      const { length, escape, sequence } = utf8Sequence(bytes, index, byte);
      if (escape) for (const each of sequence) hex(each);
      else appendBytes(out, sequence);
      index += length;
      continue;
    }
    checkFormatSize(out, out.length);
    index++;
  }
}

const ESCAPES: Record<number, string> = {
  0x09: String.raw`\t`,
  0x0a: String.raw`\n`,
  0x0d: String.raw`\r`,
  0x5c: String.raw`\\`,
  0x22: String.raw`\"`,
};

const quotedUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function utf8Sequence(
  bytes: ByteView,
  index: number,
  byte: number
): { length: number; escape: boolean; sequence: readonly number[] } {
  const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
  const sequence = [
    byte,
    ...Array.from({ length: Math.min(width - 1, bytes.length - index - 1) }, (_, offset) =>
      bytes.get(index + offset + 1)
    ),
  ];
  try {
    const point = quotedUtf8Decoder.decode(new Uint8Array(sequence)).codePointAt(0);
    return {
      length: sequence.length,
      escape: point !== undefined && [0xfe_ff, 0x85, 0x20_28, 0x20_29].includes(point),
      sequence,
    };
  } catch {
    return { length: 1, escape: true, sequence: [byte] };
  }
}

function printByteSize(out: FormatOutput, value: bigint, binary: boolean, options: Options): void {
  if (value === 0n) return alignBuffer(out, utf8('0B'), options);
  const log2 = value.toString(2).length - 1;
  // `std.math.log2(1000)` is 9, the integer part.
  const magnitude = Math.min(Math.floor(log2 / (binary ? 10 : 9)), 8);
  const base = binary ? 1024 : 1000;
  const bufferSize = 53 + 3;
  const text =
    magnitude === 0
      ? value.toString()
      : formatDecimal(shortestDecimal(Number(value) / base ** magnitude, 64), options.precision, bufferSize);
  if (text === undefined) return panic('attempt to unwrap error: BufferTooSmall');
  const suffix = magnitude === 0 ? 'B' : `${(binary ? ' KMGTPEZY' : ' kMGTPEZY')[magnitude]}${binary ? 'iB' : 'B'}`;
  if (text.length + suffix.length > bufferSize) indexOutOfBounds(text.length + suffix.length, bufferSize);
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
  return info.enumFields(type).get(value)?.name;
}

interface ByteView extends Iterable<number> {
  readonly length: number;
  readonly get: (index: number) => number;
  readonly source?: Slice;
}

export function stringBytes(value: Value, type?: Type): ByteView {
  const end = type?.kind === 'pointer' && type.size !== 'one' && type.size !== 'slice' ? sentinelOf(type) : undefined;
  const source =
    end === undefined
      ? value instanceof Pointer
        ? (value.load() as ZArray)
        : (value as Slice | ZArray)
      : sentinelSlice(value as Pointer, end);
  return byteView(
    source.length,
    (index) => {
      spendMemory();
      return Number(source.get(index));
    },
    source instanceof Slice ? source : new Slice(source, source.offset, source.lengthValue)
  );
}

/** The bytes from a many-item or C pointer up to the value that ends them. */
function sentinelSlice(pointer: Pointer, end: Value): Slice {
  const { target, index } = pointer;
  let length = 0;
  while (index + length < target.slots.length && target.slots[index + length] !== end) {
    spendMemory();
    length++;
  }
  return new Slice(target, index, length);
}

// code-gauge-allow functionCognitiveComplexity -- Streams three input bytes per quartet with bounded lazy reads and explicit padding.
function base64Bytes(source: ByteView): ByteView {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let group = -1,
    a = 0,
    b = 0,
    c = 0;
  return byteView(Math.ceil(source.length / 3) * 4, (index) => {
    const start = Math.floor(index / 4) * 3;
    if (start !== group) {
      group = start;
      a = source.get(start);
      b = start + 1 < source.length ? source.get(start + 1) : 0;
      c = start + 2 < source.length ? source.get(start + 2) : 0;
    }
    switch (index % 4) {
      case 0: {
        return alphabet.codePointAt(a >> 2)!;
      }
      case 1: {
        return alphabet.codePointAt(((a & 3) << 4) | (b >> 4))!;
      }
      case 2: {
        return start + 1 < source.length ? alphabet.codePointAt(((b & 15) << 2) | (c >> 6))! : 0x3d;
      }
      default: {
        return start + 2 < source.length ? alphabet.codePointAt(c & 63)! : 0x3d;
      }
    }
  });
}

function byteView(length: number, get: (index: number) => number, source?: Slice): ByteView {
  return {
    length,
    get,
    source,
    *[Symbol.iterator]() {
      for (let index = 0; index < length; index++) yield get(index);
    },
  };
}

export function utf8(text: string): number[] {
  spendMemory(text.length);
  return encodeIdentifierText(text);
}

function hexDigits(byte: number, upper: boolean): number[] {
  const text = byte.toString(16).padStart(2, '0');
  return utf8(upper ? text.toUpperCase() : text);
}

export function alignBuffer(out: FormatOutput, buffer: readonly number[] | ByteView, options: Options): void {
  const length = BigInt(buffer.length);
  const width = options.width ?? length;
  const padding = width > length ? width - length : 0n;
  checkFormatSize(out, out.length + buffer.length + Number(padding));
  if (padding === 0n) {
    appendBuffer(out, buffer);
    return;
  }
  const fill = (count: bigint): void => {
    if (out.repeat) out.repeat(options.fill, count);
    else for (let index = 0; index < Number(count); index++) out.push(options.fill);
  };
  switch (options.alignment) {
    case 'left': {
      appendBuffer(out, buffer);
      fill(padding);
      break;
    }
    case 'center': {
      fill(padding / 2n);
      appendBuffer(out, buffer);
      fill((padding + 1n) / 2n);
      break;
    }
    default: {
      fill(padding);
      appendBuffer(out, buffer);
    }
  }
}

function printUnicodeCodepoint(out: FormatOutput, codepoint: number): void {
  if (codepoint >= 0xd8_00 && codepoint <= 0xdf_ff) {
    out.push(0xef, 0xbf, 0xbd);
    return;
  }
  if (codepoint > 0x10_ff_ff) {
    out.push(0xef, 0xbf, 0xbd);
    return;
  }
  appendBytes(out, utf8(String.fromCodePoint(codepoint)));
}

/** `printInt`: integers print with their type's signedness, a comptime_int as `usize` or `isize` when it fits. */
export function printInt(
  out: FormatOutput,
  value: bigint,
  type: Type,
  base: number,
  upper: boolean,
  options: Options
): void {
  const magnitude = value < 0n ? -value : value;
  const digits = magnitude.toString(base);
  spendMemory(digits.length);
  const paddedSigned = type.kind === 'int' && type.signed && options.width !== undefined && options.width !== 0n;
  const sign = value < 0n ? 0x2d : paddedSigned ? 0x2b : undefined;
  const prefix = sign === undefined ? 0 : 1;
  alignBuffer(
    out,
    byteView(digits.length + prefix, (index) => {
      if (sign !== undefined && index === 0) return sign;
      const digit = digits.codePointAt(index - prefix)!;
      return upper && digit >= 0x61 ? digit - 0x20 : digit;
    }),
    options
  );
}

// Floats --------------------------------------------------------------------------------------------------------------

/** `printFloat`: `std.fmt.float.render` in decimal or scientific mode, then aligned. */
export function printFloat(
  out: FormatOutput,
  value: AnyFloat,
  bits: FloatBits,
  mode: 'decimal' | 'scientific',
  options: Options
): void {
  const decimal = shortestDecimal(value, bits);
  const text =
    mode === 'scientific'
      ? formatScientific(decimal, options.precision)
      : formatDecimal(decimal, options.precision, FLOAT_BUFFER_SIZE);
  alignBuffer(out, utf8(text ?? '(float)'), options);
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
// code-gauge-allow functionCognitiveComplexity -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function roundDecimal(decimal: Decimal, mode: 'decimal' | 'scientific', precision: bigint): Decimal {
  let roundDigit = 0n;
  let output = decimal.mantissa;
  let exponent = decimal.exponent;
  const olength = decimalLength(output);
  if (mode === 'decimal') {
    if (decimal.exponent > 0) {
      roundDigit = checked(BigInt(olength - 1 + decimal.exponent) + precision, USIZE);
    } else {
      const minExpRequired = BigInt(-decimal.exponent);
      const required = checked(precision + BigInt(olength), USIZE);
      if (required > minExpRequired) roundDigit = required - minExpRequired;
    }
  } else {
    roundDigit = checked(1n + precision, USIZE);
  }
  if (roundDigit < olength) {
    for (let index = Number(roundDigit) + 1; index < olength; index++) {
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
function formatScientific(input: Decimal, requested: bigint | undefined): string | undefined {
  if (input.special) return special(input);
  const decimal = requested === undefined ? input : roundDecimal(input, 'scientific', requested);
  if (requested !== undefined && checked(8n + requested, USIZE) > FLOAT_BUFFER_SIZE) return undefined;
  const precision = requested === undefined ? undefined : Number(requested);
  const digits = decimal.mantissa.toString();
  const olength = digits.length;
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

/** `std.fmt.float.formatDecimal`. */
function formatDecimal(input: Decimal, requested: bigint | undefined, bufferSize: number): string | undefined {
  if (input.special) return special(input);
  const decimal = requested === undefined ? input : roundDecimal(input, 'decimal', requested);
  const digits = decimal.mantissa.toString();
  const olength = digits.length;
  const prefix = BigInt(Math.abs(decimal.exponent) + olength);
  const requestedBytes = requested ?? 0n;
  const needed = checked(
    2n + (decimal.exponent >= 0 ? prefix + requestedBytes : requestedBytes > prefix ? requestedBytes : prefix),
    USIZE
  );
  if (needed > bufferSize) return undefined;
  const text = renderDecimal(decimal, digits, requested);
  if (text.length > bufferSize) indexOutOfBounds(text.length, bufferSize);
  return text;
}

// code-gauge-allow functionCognitiveComplexity -- Handles each of the native renderer's decimal point positions.
function renderDecimal(decimal: Decimal, digits: string, requested: bigint | undefined): string {
  const precision = requested === undefined ? undefined : Number(requested);
  const olength = digits.length;
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
// code-gauge-allow functionCognitiveComplexity -- Keeps the fixed-buffer checks with finite and special encodings.
function printFloatHex(out: FormatOutput, value: AnyFloat, bits: FloatBits, upper: boolean, options: Options): void {
  const big = asBigFloat(value);
  const bufferSize = 50;
  if (big.kind === 'finite' && options.precision !== undefined && options.precision > bufferSize) {
    checked(BigInt(big.sign ? 5 : 4) + options.precision, USIZE);
    panic('attempt to unwrap error: WriteFailed');
  }
  const precision = options.precision === undefined ? undefined : Number(options.precision);
  let text = big.sign ? '-' : '';
  if (big.kind === 'nan') text += upper ? 'NAN' : 'nan';
  else if (big.kind === 'inf') text += upper ? 'INF' : 'inf';
  else if (big.isZero) {
    const zeros = precision === undefined ? '.0' : precision > 0 ? `.${'0'.repeat(precision)}` : '';
    text += `0x0${zeros}p0`;
  } else text += hexFloatDigits(big, bits, upper, precision);
  if (text.length > bufferSize) panic('attempt to unwrap error: WriteFailed');
  alignBuffer(out, utf8(text), options);
}

/** The digits and exponent of `Writer.printFloatHex` for a finite nonzero float, rounded to a precision if given. */
// code-gauge-allow functionNcss -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
// code-gauge-allow functionCognitiveComplexity -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
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

function appendBuffer(out: FormatOutput, bytes: readonly number[] | ByteView, chunkSize?: number): void {
  const get = 'get' in bytes ? bytes.get : (index: number): number => bytes[index];
  if (chunkSize && out.writeChunks) out.writeChunks(bytes.length, get, chunkSize);
  else if (out.writeView) out.writeView(bytes.length, get, 'source' in bytes ? bytes.source : undefined);
  else for (let index = 0; index < bytes.length; index++) out.push(get(index));
}

function appendBytes(out: FormatOutput, bytes: readonly number[]): void {
  checkFormatSize(out, out.length + bytes.length);
  appendBuffer(out, bytes);
}

function checkFormatSize(out: FormatOutput, length: number): void {
  if (out.checkSize) out.checkSize(length);
  else checkOutputSize(length);
}
