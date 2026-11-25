import { formatFixed, formatGeneral, formatHex, formatScientific } from '../../c/library/floatFormat';
import { byteArray } from '../bytes';
import type { Expr } from '../expr';
import { floatSignBit } from '../floatSign';
import { utf8 } from '../literals';
import type { Frame } from '../runtime';
import {
  ClassInfo,
  classType,
  type FunctionInfo,
  isCharType,
  LONG,
  nonReference,
  type Type,
  typeName,
  unqualified,
} from '../types';
import { CObject, Ptr, type Store, type Value } from '../values';
import { pointerText } from './formatting';
import type { Library } from './registry';
import { makeString, type StringValue } from './string';
import { CONST_CHAR_PTR, constRef, generic, native, readCString, throwLibrary } from './support';

/** How `std::format` writes an argument, which its type decides. */
type ArgumentKind = 'integer' | 'char' | 'bool' | 'float' | 'string' | 'pointer';

/** An argument of `std::format`, read when the call runs. */
interface FormatArgument {
  kind: ArgumentKind;
  /** The value: a bigint for an integer or a character, a number for a floating-point number, bytes for a string. */
  value: bigint | number | string | Ptr | boolean;
  isFloat32?: boolean;
  /** Whether a floating-point number's sign bit is set, which a negative zero and a NaN may have. */
  isNegative?: boolean;
}

/** The arguments `std::make_format_args` stored, by the object it made. */
const storedArguments = new WeakMap<CObject, FormatArgument[]>();

/** The standard format specification of a replacement field (C++20 [format.string.std]). */
interface FormatSpec {
  fill: string;
  align?: '<' | '>' | '^';
  sign: '-' | '+' | ' ';
  alternate: boolean;
  zero: boolean;
  width?: number | { arg: number };
  precision?: number | { arg: number };
  type: string;
}

/** A replacement field or the text between them. */
type FormatPiece = string | { arg: number; spec: FormatSpec };

/** Why a format string is invalid, which `std::format` diagnoses when it is compiled. */
class FormatError extends Error {}

/** `std::format`, `std::vformat`, `std::make_format_args`, and `std::formatted_size` of `<format>`. */
export function formatFunctions(library: Library): { functions: Map<string, FunctionInfo[]>; formatArgs: ClassInfo } {
  const format = generic('format', (args) => formatInstance(library, args));
  const formattedSize = generic('formatted_size', (args) => {
    const instance = format.instantiate?.(args, undefined);
    if (!instance?.native) return;
    const run = instance.native;
    return native(
      'formatted_size',
      instance.params.map((param) => param.type),
      LONG,
      (values, context) => BigInt((run(values, context) as StringValue).bytes.length)
    );
  });
  const formatArgs = formatArgsClass();
  return {
    functions: new Map([
      ['format', [format]],
      ['formatted_size', [formattedSize]],
      ['make_format_args', [makeFormatArgs(formatArgs)]],
      ['vformat', [vformat(library, formatArgs)]],
    ]),
    formatArgs,
  };
}

/** The `std::format` for a call's arguments, whose literal format string it checks as it compiles. */
function formatInstance(library: Library, args: readonly Expr[]): FunctionInfo | undefined {
  const compiler = library.compiler;
  const [formatString, ...values] = args;
  if (!formatString) return;
  if (formatString.literalBytes === undefined) {
    if (!isStringType(formatString.type)) return;
    return compiler.error(
      formatString.row,
      'std::format の書式には文字列リテラルを書いてください（実行時に決まる書式は std::vformat に渡してください）。'
    );
  }
  const unformattable = values.find((value) => argumentKind(value.type) === undefined);
  if (unformattable)
    return compiler.unsupported(
      formatString.row,
      `${typeName(unformattable.type)} 型の値の std::format（std::formatter の特殊化）`
    );
  let pieces: FormatPiece[];
  try {
    pieces = parseFormat(
      formatString.literalBytes,
      values.map((value) => argumentKind(value.type) as ArgumentKind)
    );
  } catch (error) {
    if (error instanceof FormatError)
      return compiler.error(formatString.row, `std::format の書式が正しくありません: ${error.message}`);
    throw error;
  }
  const read = argumentsReader(values);
  return native(
    'format',
    [CONST_CHAR_PTR, ...argumentParams(values)],
    library.stringType,
    ([, ...locations], { frame }) => {
      const formatted = writeFormat(pieces, read(locations, frame));
      frame.runtime.spend(Math.ceil(formatted.length / 64));
      return makeString(frame, formatted);
    }
  );
}

/** `std::format_args`, which holds what `std::make_format_args` read. */
function formatArgsClass(): ClassInfo {
  const cls = new ClassInfo('std::format_args', 'class');
  cls.isComplete = true;
  cls.library = { kind: 'format_args', args: [], size: 16, align: 8 };
  cls.operations = {
    copyIsNoexcept: true,
    copy: (_frame, source) => {
      const copy = new CObject(cls, []);
      storedArguments.set(copy, storedArguments.get(source as CObject) ?? []);
      return copy;
    },
    assign: (_frame, target, source) => {
      storedArguments.set(target as CObject, storedArguments.get(source as CObject) ?? []);
    },
  };
  return cls;
}

function makeFormatArgs(formatArgs: ClassInfo): FunctionInfo {
  return generic('make_format_args', (args) => {
    if (args.some((value) => argumentKind(value.type) === undefined)) return;
    const read = argumentsReader(args);
    return native('make_format_args', argumentParams(args), classType(formatArgs), (locations, { frame }) => {
      const object = new CObject(formatArgs, []);
      storedArguments.set(object, read(locations, frame));
      return object;
    });
  });
}

/** `std::vformat`, which reads its format string when it runs, throwing `std::format_error` for a wrong one. */
function vformat(library: Library, formatArgs: ClassInfo): FunctionInfo {
  const run = native(
    'vformat',
    [constRef(library.stringType), constRef(classType(formatArgs))],
    library.stringType,
    ([text, store], { frame }) => {
      const bytes = stringBytes((text as Ptr).read(), frame);
      const values = storedArguments.get((store as Ptr).read() as CObject) ?? [];
      try {
        return makeString(
          frame,
          writeFormat(
            parseFormat(
              bytes,
              values.map((value) => value.kind)
            ),
            values
          )
        );
      } catch (error) {
        if (error instanceof FormatError) return throwLibrary(frame, library.exception('format_error'), error.message);
        throw error;
      }
    }
  );
  // libc++ declares `std::vformat` as a function template, for its overloads that take a locale.
  return generic('vformat', (args) => (args.length === 2 ? run : undefined));
}

function argumentParams(values: readonly Expr[]): Type[] {
  return values.map((value) => constRef(unqualified(nonReference(value.type))));
}

function argumentsReader(values: readonly Expr[]): (locations: unknown[], frame: Frame) => FormatArgument[] {
  const readers = values.map((value) => argumentReader(value.type));
  return (locations, frame) => locations.map((location, index) => (readers[index] as Reader)(location as Ptr, frame));
}

type Reader = (location: Ptr, frame: Frame) => FormatArgument;

function isStringType(type: Type): boolean {
  const plain = unqualified(nonReference(type));
  return plain.kind === 'class' && plain.cls.library?.kind === 'string';
}

/** How `std::format` writes a value of a type, or undefined when the library has no formatter for it. */
function argumentKind(type: Type): ArgumentKind | undefined {
  const plain = unqualified(nonReference(type));
  if (plain.kind === 'int') {
    if (plain.name === 'bool') return 'bool';
    if (plain.enumeration) return undefined;
    if (plain.name === 'char' || isCharType(plain)) return plain.character ? undefined : 'char';
    return 'integer';
  }
  if (plain.kind === 'float') return 'float';
  if (plain.kind === 'array' || plain.kind === 'pointer') {
    const element = plain.kind === 'array' ? plain.of : plain.to;
    const elementType = unqualified(element);
    if (elementType.kind === 'int' && elementType.name === 'char' && !elementType.character) return 'string';
    if (plain.kind === 'pointer' && elementType.kind === 'void') return 'pointer';
    return undefined;
  }
  if (plain.kind === 'nullptr') return 'pointer';
  if (plain.kind === 'class' && plain.cls.library?.kind === 'string') return 'string';
  // The library's C++ source defines `std::string_view`.
  if (plain.kind === 'class' && plain.cls.name === 'string_view' && plain.cls.namespace?.name === 'std')
    return 'string';
  return undefined;
}

function argumentReader(type: Type): Reader {
  const plain = unqualified(nonReference(type));
  const kind = argumentKind(plain) as ArgumentKind;
  return (location, frame) => {
    const value = location.read();
    switch (kind) {
      case 'integer':
      case 'char': {
        return { kind, value: BigInt(value as number | bigint) };
      }
      case 'bool': {
        return { kind, value: value !== 0 };
      }
      case 'float': {
        const number = value as number;
        return {
          kind,
          value: Number(number),
          isFloat32: plain.kind === 'float' && plain.name === 'float',
          isNegative: floatSignBit(value),
        };
      }
      case 'pointer': {
        return { kind, value: plain.kind === 'nullptr' ? new Ptr(undefined, 0) : (value as Ptr) };
      }
      default: {
        return { kind, value: stringBytes(plain.kind === 'array' ? new Ptr(value as Store, 0) : value, frame) };
      }
    }
  };
}

/** The bytes of a string argument: a `std::string`, a `std::string_view`, or a null-terminated array. */
function stringBytes(value: Value | Ptr, frame: Frame): string {
  if (value instanceof Ptr) return readCString(value, frame.runtime);
  if (value instanceof CObject) {
    const [data, size] = value.values;
    let bytes = '';
    for (let index = 0; index < Number(size); index++)
      bytes += String.fromCodePoint(Number((data as Ptr).offset(index).read()) & 0xff);
    return bytes;
  }
  return (value as StringValue).bytes;
}

// Parsing ----------------------------------------------------------------------------------------------------------

/** Parses a format string, checking each field against the argument it formats. */
function parseFormat(text: string, kinds: readonly ArgumentKind[]): FormatPiece[] {
  const pieces: FormatPiece[] = [];
  const ids = new ArgumentIds(kinds);
  let literal = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    const isEscape = (char === '{' || char === '}') && text[index + 1] === char;
    if (char === '}' && !isEscape) throw new FormatError('} は }} と書いてください。');
    if (char !== '{' || isEscape) {
      literal += char;
      if (isEscape) index++;
      continue;
    }
    const close = findFieldEnd(text, index + 1);
    if (literal) pieces.push(literal);
    literal = '';
    pieces.push(parseField(text.slice(index + 1, close), ids));
    index = close;
  }
  if (literal) pieces.push(literal);
  return pieces;
}

/** A replacement field (`0:>8`): the argument it formats and how. */
function parseField(field: string, ids: ArgumentIds): FormatPiece {
  const colon = field.indexOf(':');
  const id = ids.next(colon === -1 ? field : field.slice(0, colon));
  const spec = parseSpec(colon === -1 ? '' : field.slice(colon + 1), ids.kindOf(id), (written) => {
    const nested = ids.next(written);
    if (ids.kindOf(nested) !== 'integer') throw new FormatError('幅や精度の引数は整数にしてください。');
    return nested;
  });
  return { arg: id, spec };
}

/** The arguments the fields of a format string name, all by automatic numbering or all by their numbers. */
class ArgumentIds {
  private following = 0;
  private isManual: boolean | undefined;

  constructor(private readonly kinds: readonly ArgumentKind[]) {}

  next(written: string): number {
    const isManual = written !== '';
    if (this.isManual === !isManual)
      throw new FormatError('引数の番号を書く場合と書かない場合を混ぜることはできません。');
    this.isManual = isManual;
    if (!isManual) return this.following++;
    if (!/^\d+$/.test(written)) throw new FormatError(`引数の番号 ${written} が正しくありません。`);
    return Number(written);
  }

  kindOf(index: number): ArgumentKind {
    const kind = this.kinds[index];
    if (kind === undefined) throw new FormatError(`${index} 番の引数がありません。`);
    return kind;
  }
}

function findFieldEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}') {
      if (depth === 0) return index;
      depth--;
    }
  }
  throw new FormatError('{ に対応する } がありません。');
}

const TYPES: Record<ArgumentKind, string> = {
  integer: 'bBcdoxX',
  char: 'bBcdoxX',
  bool: 'sbBdoxX',
  float: 'aAeEfFgG',
  string: 's',
  pointer: 'p',
};

function parseSpec(written: string, kind: ArgumentKind, nestedId: (written: string) => number): FormatSpec {
  const reader = new SpecReader([...decode(written)], nestedId);
  const spec: FormatSpec = { fill: ' ', sign: '-', alternate: false, zero: false, type: '', ...reader.fillAndAlign() };
  const sign = reader.take(['+', '-', ' ']);
  if (sign) spec.sign = sign as FormatSpec['sign'];
  spec.alternate = reader.take(['#']) !== undefined;
  spec.zero = reader.take(['0']) !== undefined;
  spec.width = reader.count();
  if (reader.take(['.'])) {
    spec.precision = reader.count();
    if (spec.precision === undefined) throw new FormatError('. の後に精度を書いてください。');
    if (kind !== 'float' && kind !== 'string') throw new FormatError('精度は浮動小数点数と文字列にしか書けません。');
  }
  reader.take(['L']);
  spec.type = reader.rest();
  if (spec.type.length > 1) throw new FormatError(`書式 ${written} が正しくありません。`);
  if (spec.type && !TYPES[kind].includes(spec.type)) throw new FormatError(`型 ${spec.type} はこの引数に使えません。`);
  if (writesText(kind, spec.type) && (spec.sign !== '-' || spec.alternate || spec.zero))
    throw new FormatError('符号・#・0 は数として書く値にしか使えません。');
  return spec;
}

/** Whether a field writes its argument as text: a string, or a character or a Boolean without an integer type. */
function writesText(kind: ArgumentKind, type: string): boolean {
  if (kind === 'string') return true;
  if (kind === 'char') return type === '' || type === 'c';
  return kind === 'bool' && (type === '' || type === 's');
}

/** Reads a format specification's parts in their order. */
class SpecReader {
  private at = 0;

  constructor(
    private readonly characters: readonly string[],
    private readonly nestedId: (written: string) => number
  ) {}

  fillAndAlign(): Pick<FormatSpec, 'fill' | 'align'> | undefined {
    const [first, second] = this.characters;
    if (isAlign(second)) {
      if (first === '{' || first === '}') throw new FormatError('埋める文字に { や } は使えません。');
      this.at = 2;
      return { fill: first as string, align: second };
    }
    if (!isAlign(first)) return undefined;
    this.at = 1;
    return { fill: ' ', align: first };
  }

  take(options: readonly string[]): string | undefined {
    const char = this.characters[this.at];
    if (char === undefined || !options.includes(char)) return undefined;
    this.at++;
    return char;
  }

  /** A width or a precision: digits, or a nested field (`{}`) that names an argument. */
  count(): number | { arg: number } | undefined {
    if (this.characters[this.at] === '{') {
      const close = this.characters.indexOf('}', this.at);
      if (close === -1) throw new FormatError('{ に対応する } がありません。');
      const id = this.nestedId(this.characters.slice(this.at + 1, close).join(''));
      this.at = close + 1;
      return { arg: id };
    }
    let digits = '';
    while (/^\d$/.test(this.characters[this.at] ?? '')) digits += this.characters[this.at++];
    return digits === '' ? undefined : Number(digits);
  }

  rest(): string {
    const rest = this.characters.slice(this.at).join('');
    this.at = this.characters.length;
    return rest;
  }
}

function isAlign(char: string | undefined): char is '<' | '>' | '^' {
  return char === '<' || char === '>' || char === '^';
}

// Writing ----------------------------------------------------------------------------------------------------------

function writeFormat(pieces: readonly FormatPiece[], args: readonly FormatArgument[]): string {
  let out = '';
  for (const piece of pieces)
    out += typeof piece === 'string' ? piece : formatField(piece.spec, args[piece.arg] as FormatArgument, args);
  return out;
}

function resolveCount(
  count: number | { arg: number } | undefined,
  args: readonly FormatArgument[]
): number | undefined {
  if (count === undefined || typeof count === 'number') return count;
  const value = (args[count.arg] as FormatArgument).value as bigint;
  if (value < 0n) throw new FormatError('幅や精度は 0 以上にしてください。');
  return Number(value);
}

function formatField(spec: FormatSpec, arg: FormatArgument, args: readonly FormatArgument[]): string {
  const width = resolveCount(spec.width, args) ?? 0;
  const precision = resolveCount(spec.precision, args);
  const { kind } = arg;
  if (writesText(kind, spec.type)) {
    const text = textOf(arg);
    return pad(precision === undefined ? text : truncateColumns(text, precision), width, spec.align ?? '<', spec.fill);
  }
  if (kind === 'pointer') return pad(pointerText(arg.value as Ptr), width, spec.align ?? '>', spec.fill);
  const number = kind === 'float' ? floatParts(spec, arg, precision) : integerParts(spec, arg);
  if (typeof number === 'string') return pad(number, width, spec.align ?? '<', spec.fill);
  const { sign, prefix, digits, isFinite } = number;
  // The `0` option pads after the sign and the prefix, unless an alignment is given or the number is not finite.
  if (spec.zero && spec.align === undefined && isFinite) {
    const length = columns(sign + prefix + digits);
    return sign + prefix + '0'.repeat(Math.max(0, width - length)) + digits;
  }
  return pad(sign + prefix + digits, width, spec.align ?? '>', spec.fill);
}

/** The text of a string, a character, or a Boolean that a field writes as text. */
function textOf(arg: FormatArgument): string {
  if (arg.kind === 'string') return arg.value as string;
  if (arg.kind === 'bool') return arg.value ? 'true' : 'false';
  return String.fromCodePoint(Number(BigInt.asUintN(8, arg.value as bigint)));
}

interface NumberParts {
  sign: string;
  prefix: string;
  digits: string;
  isFinite: boolean;
}

function signOf(isNegative: boolean, spec: FormatSpec): string {
  if (isNegative) return '-';
  return spec.sign === '-' ? '' : spec.sign;
}

function floatParts(spec: FormatSpec, arg: FormatArgument, precision: number | undefined): NumberParts {
  const value = arg.value as number;
  return {
    sign: signOf(arg.isNegative === true, spec),
    prefix: '',
    digits: floatDigits(Math.abs(value), spec, precision, arg.isFloat32 === true),
    isFinite: Number.isFinite(value),
  };
}

/** The parts of an integer, a character, or a Boolean written as a number, or the character the `c` type writes. */
function integerParts(spec: FormatSpec, arg: FormatArgument): NumberParts | string {
  let value = arg.kind === 'bool' ? (arg.value ? 1n : 0n) : (arg.value as bigint);
  if (arg.kind === 'char' && value < 0n) value = BigInt.asUintN(8, value);
  if (spec.type === 'c') {
    if (value < 0n || value > 255n) throw new FormatError('文字として書ける値ではありません。');
    return String.fromCodePoint(Number(value));
  }
  const magnitude = value < 0n ? -value : value;
  const base = { b: 2, B: 2, o: 8, x: 16, X: 16 }[spec.type] ?? 10;
  const digits = magnitude.toString(base);
  let prefix = '';
  if (spec.alternate && base !== 10) prefix = base === 8 ? (magnitude === 0n ? '' : '0') : `0${spec.type}`;
  return {
    sign: signOf(value < 0n, spec),
    prefix,
    digits: spec.type === 'X' ? digits.toUpperCase() : digits,
    isFinite: true,
  };
}

// code-gauge-allow functionCognitiveComplexity -- One branch per presentation type of a floating-point number.
function floatDigits(value: number, spec: FormatSpec, precision: number | undefined, isFloat32: boolean): string {
  const upper = spec.type === spec.type.toUpperCase() && spec.type !== '';
  if (!Number.isFinite(value)) {
    const text = Number.isNaN(value) ? 'nan' : 'inf';
    return upper ? text.toUpperCase() : text;
  }
  let text: string;
  switch (spec.type.toLowerCase()) {
    case 'f': {
      text = formatFixed(value, precision ?? 6);
      if (spec.alternate && !text.includes('.')) text += '.';
      break;
    }
    case 'e': {
      text = formatScientific(value, precision ?? 6, spec.alternate);
      break;
    }
    case 'g': {
      text = formatGeneral(value, precision ?? 6, spec.alternate);
      break;
    }
    case 'a': {
      text = formatHex(value, precision, false).replace(/^0x/, '');
      if (spec.alternate && !text.includes('.')) text = text.replace('p', '.p');
      break;
    }
    default: {
      text = precision === undefined ? shortest(value, isFloat32) : formatGeneral(value, precision, spec.alternate);
      if (spec.alternate && !text.includes('.')) text = text.replace(/(e|$)/, '.$1');
    }
  }
  return upper ? text.toUpperCase() : text;
}

/**
 * The shortest digits that read back as the number, as `std::to_chars` writes them without a format: in fixed
 * notation unless scientific is shorter (MSVC's algorithm, which libc++ uses).
 */
function shortest(value: number, isFloat32: boolean): string {
  if (value === 0) return '0';
  let scientific = value.toExponential();
  if (isFloat32) {
    for (let digits = 1; digits <= 9; digits++) {
      const candidate = value.toExponential(digits - 1);
      if (Math.fround(Number(candidate)) === value) {
        scientific = candidate;
        break;
      }
    }
  }
  const [mantissa, exponentText] = scientific.split('e') as [string, string];
  const significand = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  const exponent = Number(exponentText);
  const length = significand.length;
  // The exponent of the last digit, which the range of fixed notation is decided by.
  const last = exponent - (length - 1);
  const [lower, upper] = length === 1 ? [-3, 4] : [-(length + 3), 5];
  if (lower <= last && last <= upper) {
    if (last >= 0) return significand + '0'.repeat(last);
    const point = length + last;
    if (point > 0) return `${significand.slice(0, point)}.${significand.slice(point)}`;
    return `0.${'0'.repeat(-point)}${significand}`;
  }
  const body = length === 1 ? significand : `${significand[0]}.${significand.slice(1)}`;
  return `${body}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

/** The ranges of the code points two columns wide (C++20 [format.string.std]p11). */
const WIDE_RANGES: readonly [number, number][] = [
  [0x11_00, 0x11_5f],
  [0x23_29, 0x23_2a],
  [0x2e_80, 0x30_3e],
  [0x30_40, 0xa4_cf],
  [0xac_00, 0xd7_a3],
  [0xf9_00, 0xfa_ff],
  [0xfe_10, 0xfe_19],
  [0xfe_30, 0xfe_6f],
  [0xff_00, 0xff_60],
  [0xff_e0, 0xff_e6],
  [0x1_f3_00, 0x1_f6_4f],
  [0x1_f9_00, 0x1_f9_ff],
  [0x2_00_00, 0x2_ff_fd],
  [0x3_00_00, 0x3_ff_fd],
];

function codePointColumns(codePoint: number): number {
  return WIDE_RANGES.some(([low, high]) => low <= codePoint && codePoint <= high) ? 2 : 1;
}

/** The columns a UTF-8 text takes, which its width and precision count. */
function columns(bytes: string): number {
  let total = 0;
  for (const char of decode(bytes)) total += codePointColumns(char.codePointAt(0) as number);
  return total;
}

function decode(bytes: string): string {
  return new TextDecoder().decode(byteArray(bytes));
}

function truncateColumns(bytes: string, limit: number): string {
  let total = 0;
  let kept = '';
  for (const char of decode(bytes)) {
    const width = codePointColumns(char.codePointAt(0) as number);
    if (total + width > limit) break;
    total += width;
    kept += char;
  }
  return utf8(kept);
}

function pad(text: string, width: number, align: '<' | '>' | '^', fill: string): string {
  const missing = Math.max(0, width - columns(text));
  if (missing === 0) return text;
  const fillBytes = utf8(fill);
  const before = align === '<' ? 0 : align === '>' ? missing : Math.floor(missing / 2);
  return fillBytes.repeat(before) + text + fillBytes.repeat(missing - before);
}
