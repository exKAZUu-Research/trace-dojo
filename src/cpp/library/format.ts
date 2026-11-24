import { formatFixed, formatGeneral, formatHex, formatScientific } from '../../c/library/floatFormat';
import { byteArray } from '../bytes';
import type { ExpressionCompiler } from '../expressionCompiler';
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
  const compiler = (): ExpressionCompiler => library.compiler;
  const format = generic('format', (args) => {
    const [formatString, ...values] = args;
    if (!formatString) return;
    const kinds = values.map((value) => argumentKind(value.type));
    if (formatString.literalBytes === undefined) {
      if (!isStringType(formatString.type)) return;
      return compiler().error(
        formatString.row,
        'std::format の書式には文字列リテラルを書いてください（実行時に決まる書式は std::vformat に渡してください）。'
      );
    }
    const unformattable = values.find((value) => argumentKind(value.type) === undefined);
    if (unformattable)
      return compiler().unsupported(
        formatString.row,
        `${typeName(unformattable.type)} 型の値の std::format（std::formatter の特殊化）`
      );
    let pieces: FormatPiece[];
    try {
      pieces = parseFormat(formatString.literalBytes, kinds as ArgumentKind[]);
    } catch (error) {
      if (error instanceof FormatError)
        return compiler().error(formatString.row, `std::format の書式が正しくありません: ${error.message}`);
      throw error;
    }
    const readers = values.map((value) => argumentReader(value.type));
    return native(
      'format',
      [CONST_CHAR_PTR, ...values.map((value) => constRef(unqualified(nonReference(value.type))))],
      library.stringType,
      ([, ...locations], { frame }) => {
        const formatted = writeFormat(
          pieces,
          locations.map((location, index) => (readers[index] as Reader)(location as Ptr, frame))
        );
        frame.runtime.spend(Math.ceil(formatted.length / 64));
        return makeString(frame, formatted);
      }
    );
  });
  const formattedSize = generic('formatted_size', (args) => {
    const instance = format.instantiate?.(args, undefined);
    if (!instance?.native) return;
    const run = instance.native;
    return native(
      'formatted_size',
      instance.params.map((param) => param.type),
      LONG,
      (values, context) => {
        const text = run(values, context) as StringValue;
        return BigInt(text.bytes.length);
      }
    );
  });
  const formatArgs = new ClassInfo('std::format_args', 'class');
  formatArgs.isComplete = true;
  formatArgs.library = { kind: 'format_args', args: [], size: 16, align: 8 };
  formatArgs.operations = {
    copyIsNoexcept: true,
    copy: (_frame, source) => {
      const copy = new CObject(formatArgs, []);
      storedArguments.set(copy, storedArguments.get(source as CObject) ?? []);
      return copy;
    },
    assign: (_frame, target, source) => {
      storedArguments.set(target as CObject, storedArguments.get(source as CObject) ?? []);
    },
  };
  const formatArgsType = classType(formatArgs);
  const makeFormatArgs = generic('make_format_args', (args) => {
    const kinds = args.map((value) => argumentKind(value.type));
    if (kinds.includes(undefined)) return;
    const readers = args.map((value) => argumentReader(value.type));
    return native(
      'make_format_args',
      args.map((value) => constRef(unqualified(nonReference(value.type)))),
      formatArgsType,
      (locations, { frame }) => {
        const object = new CObject(formatArgs, []);
        storedArguments.set(
          object,
          locations.map((location, index) => (readers[index] as Reader)(location as Ptr, frame))
        );
        return object;
      }
    );
  });
  const vformatFunction = native(
    'vformat',
    [constRef(library.stringType), constRef(formatArgsType)],
    library.stringType,
    ([text, store], { frame }) => {
      const bytes = stringBytes((text as Ptr).read(), frame);
      const values = storedArguments.get((store as Ptr).read() as CObject) ?? [];
      let pieces: FormatPiece[];
      try {
        pieces = parseFormat(
          bytes,
          values.map((value) => value.kind)
        );
      } catch (error) {
        if (error instanceof FormatError) return throwLibrary(frame, library.exception('format_error'), error.message);
        throw error;
      }
      return makeString(frame, writeFormat(pieces, values));
    }
  );
  // libc++ declares `std::vformat` as a function template, for its overloads that take a locale.
  const vformat = generic('vformat', (args) => (args.length === 2 ? vformatFunction : undefined));
  return {
    functions: new Map([
      ['format', [format]],
      ['formatted_size', [formattedSize]],
      ['make_format_args', [makeFormatArgs]],
      ['vformat', [vformat]],
    ]),
    formatArgs,
  };
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
// code-gauge-allow functionCognitiveComplexity -- The parser walks the string once, handling escapes and fields.
function parseFormat(text: string, kinds: readonly ArgumentKind[]): FormatPiece[] {
  const pieces: FormatPiece[] = [];
  let literal = '';
  let next = 0;
  let isManual: boolean | undefined;
  const argumentId = (written: string): number => {
    if (written === '') {
      if (isManual) throw new FormatError('引数の番号を書く場合と書かない場合を混ぜることはできません。');
      isManual = false;
      return next++;
    }
    if (!/^\d+$/.test(written)) throw new FormatError(`引数の番号 ${written} が正しくありません。`);
    if (isManual === false) throw new FormatError('引数の番号を書く場合と書かない場合を混ぜることはできません。');
    isManual = true;
    return Number(written);
  };
  const checkArgument = (index: number): ArgumentKind => {
    const kind = kinds[index];
    if (kind === undefined) throw new FormatError(`${index} 番の引数がありません。`);
    return kind;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '}') {
      if (text[index + 1] !== '}') throw new FormatError('} は }} と書いてください。');
      literal += '}';
      index++;
      continue;
    }
    if (char !== '{') {
      literal += char;
      continue;
    }
    if (text[index + 1] === '{') {
      literal += '{';
      index++;
      continue;
    }
    const close = findFieldEnd(text, index + 1);
    const field = text.slice(index + 1, close);
    const colon = field.indexOf(':');
    const id = argumentId(colon === -1 ? field : field.slice(0, colon));
    const kind = checkArgument(id);
    const spec = parseSpec(colon === -1 ? '' : field.slice(colon + 1), kind, (written) => {
      const nested = argumentId(written);
      if (checkArgument(nested) !== 'integer') throw new FormatError('幅や精度の引数は整数にしてください。');
      return nested;
    });
    if (literal) pieces.push(literal);
    literal = '';
    pieces.push({ arg: id, spec });
    index = close;
  }
  if (literal) pieces.push(literal);
  return pieces;
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

// code-gauge-allow functionCognitiveComplexity -- The specification's parts follow one another in a fixed order.
function parseSpec(written: string, kind: ArgumentKind, nestedId: (written: string) => number): FormatSpec {
  const characters = [...decode(written)];
  let at = 0;
  const spec: FormatSpec = { fill: ' ', sign: '-', alternate: false, zero: false, type: '' };
  if (isAlign(characters[1])) {
    if (characters[0] === '{' || characters[0] === '}') throw new FormatError('埋める文字に { や } は使えません。');
    spec.fill = characters[0] as string;
    spec.align = characters[1];
    at = 2;
  } else if (isAlign(characters[0])) {
    spec.align = characters[0];
    at = 1;
  }
  const char = (): string | undefined => characters[at];
  if (char() === '+' || char() === '-' || char() === ' ') spec.sign = characters[at++] as FormatSpec['sign'];
  if (char() === '#') {
    spec.alternate = true;
    at++;
  }
  if (char() === '0') {
    spec.zero = true;
    at++;
  }
  const number = (): number | { arg: number } | undefined => {
    if (char() === '{') {
      const close = characters.indexOf('}', at);
      if (close === -1) throw new FormatError('{ に対応する } がありません。');
      const id = nestedId(characters.slice(at + 1, close).join(''));
      at = close + 1;
      return { arg: id };
    }
    let digits = '';
    while (char() !== undefined && /\d/.test(char() as string)) digits += characters[at++];
    return digits === '' ? undefined : Number(digits);
  };
  spec.width = number();
  if (char() === '.') {
    at++;
    spec.precision = number();
    if (spec.precision === undefined) throw new FormatError('. の後に精度を書いてください。');
    if (kind !== 'float' && kind !== 'string') throw new FormatError('精度は浮動小数点数と文字列にしか書けません。');
  }
  if (char() === 'L') at++;
  if (char() !== undefined) spec.type = characters[at++] as string;
  if (at < characters.length) throw new FormatError(`書式 ${written} が正しくありません。`);
  if (spec.type && !TYPES[kind].includes(spec.type)) throw new FormatError(`型 ${spec.type} はこの引数に使えません。`);
  const asString =
    kind === 'string' ||
    (kind === 'char' && (spec.type === '' || spec.type === 'c')) ||
    (kind === 'bool' && (spec.type === '' || spec.type === 's'));
  if (asString && (spec.sign !== '-' || spec.alternate || spec.zero))
    throw new FormatError('符号・#・0 は数として書く値にしか使えません。');
  return spec;
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
  if (
    kind === 'string' ||
    (kind === 'char' && (spec.type === '' || spec.type === 'c')) ||
    (kind === 'bool' && (spec.type === '' || spec.type === 's'))
  ) {
    let text: string;
    if (kind === 'string') text = arg.value as string;
    else if (kind === 'bool') text = arg.value ? 'true' : 'false';
    else text = String.fromCodePoint(Number(BigInt.asUintN(8, arg.value as bigint)));
    if (precision !== undefined) text = truncateColumns(text, precision);
    return pad(text, width, spec.align ?? '<', spec.fill);
  }
  if (kind === 'pointer') return pad(pointerText(arg.value as Ptr), width, spec.align ?? '>', spec.fill);
  let sign = '';
  let prefix = '';
  let digits: string;
  if (kind === 'float') {
    const value = arg.value as number;
    sign = arg.isNegative ? '-' : spec.sign === '-' ? '' : spec.sign;
    digits = floatDigits(Math.abs(value), spec, precision, arg.isFloat32 === true);
    if (!Number.isFinite(value)) {
      return pad(sign + digits, width, spec.align ?? '>', spec.fill);
    }
  } else {
    let value = kind === 'bool' ? (arg.value ? 1n : 0n) : (arg.value as bigint);
    if (kind === 'char' && value < 0n) value = BigInt.asUintN(8, value);
    if (spec.type === 'c') {
      if (value < 0n || value > 255n) throw new FormatError('文字として書ける値ではありません。');
      return pad(String.fromCodePoint(Number(value)), width, spec.align ?? '<', spec.fill);
    }
    const negative = value < 0n;
    const magnitude = negative ? -value : value;
    sign = negative ? '-' : spec.sign === '-' ? '' : spec.sign;
    const base = { b: 2, B: 2, o: 8, x: 16, X: 16 }[spec.type] ?? 10;
    digits = magnitude.toString(base);
    if (spec.type === 'X') digits = digits.toUpperCase();
    if (spec.alternate) {
      if (spec.type === 'b' || spec.type === 'B') prefix = `0${spec.type}`;
      else if (spec.type === 'x' || spec.type === 'X') prefix = `0${spec.type}`;
      else if (spec.type === 'o' && magnitude !== 0n) prefix = '0';
    }
  }
  if (spec.zero && spec.align === undefined) {
    const length = columns(sign + prefix + digits);
    return sign + prefix + '0'.repeat(Math.max(0, width - length)) + digits;
  }
  return pad(sign + prefix + digits, width, spec.align ?? '>', spec.fill);
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
