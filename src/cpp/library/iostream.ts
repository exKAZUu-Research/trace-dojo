import { isExactFloatPrefix, isSpaceByte, parseFloatPrefix, parseIntegerPrefix } from '../../c/library/numberParsing';
import { byteArray, byteAt } from '../bytes';
import { CppRuntimeError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { Frame } from '../runtime';
import {
  BOOL,
  CHAR,
  ClassInfo,
  classType,
  isCharType,
  isConstType,
  LONG,
  type Type,
  typeName,
  UINT,
  VOID,
} from '../types';
import { Ptr, Store, type Value } from '../values';
import { formatFloat, pointerText } from './formatting';
import type { Library } from './registry';
import { StringValue } from './string';
import {
  addMethod,
  asNumber,
  CONST_CHAR_PTR,
  constRef,
  native,
  nativeConstructor,
  readCString,
  signedChar,
} from './support';

/** The format flags of `std::ios_base`, with libc++'s values. */
export const FLAGS = {
  boolalpha: 0x1,
  dec: 0x2,
  fixed: 0x4,
  hex: 0x8,
  internal: 0x10,
  left: 0x20,
  oct: 0x40,
  right: 0x80,
  scientific: 0x1_00,
  showbase: 0x2_00,
  showpoint: 0x4_00,
  showpos: 0x8_00,
  skipws: 0x10_00,
  unitbuf: 0x20_00,
  uppercase: 0x40_00,
  adjustfield: 0x20 | 0x80 | 0x10,
  basefield: 0x2 | 0x40 | 0x8,
  floatfield: 0x1_00 | 0x4,
} as const;

/** A stream: standard output or error, or a string stream, with its formatting state. */
export class StreamValue extends Store {
  width = 0;
  precision = 6;
  fill = ' ';
  flags: number = FLAGS.skipws | FLAGS.dec;
  /** The text a string stream holds, as bytes. */
  buffer = '';
  /** Where reading continues in the buffer. */
  position = 0;
  /** Where writing continues in the buffer, overwriting what is there, as `basic_stringbuf`'s put area does. */
  writePosition = 0;
  failed = false;
  atEnd = false;

  constructor(readonly target: 'stdout' | 'stderr' | 'buffer') {
    super();
  }

  get length(): number {
    return 1;
  }

  get(): Value {
    return this;
  }

  set(): void {
    throw new Error('A stream cannot be assigned');
  }

  get isGood(): boolean {
    return !this.failed && !this.atEnd;
  }

  /** Writes unless the stream has failed or reached its end, as an output `sentry` allows. */
  write(frame: Frame, bytes: string): void {
    if (!this.isGood) return;
    if (this.target === 'buffer') {
      const at = this.writePosition;
      this.buffer = this.buffer.slice(0, at) + bytes + this.buffer.slice(at + bytes.length);
      this.writePosition += bytes.length;
      frame.runtime.reserve(Math.ceil(bytes.length / 8));
      if (this.buffer.length > 1_000_000) throw new CppRuntimeError('custom', '文字列が長すぎます。');
    } else {
      frame.runtime.write(this.target, bytes);
    }
  }

  /** Writes a formatted field, padded to the width, which the insertion then resets (C++20 [ostream.formatted]). */
  writeField(frame: Frame, text: string, internalAt = 0): void {
    if (!this.isGood) return;
    const width = this.width;
    this.width = 0;
    if (text.length >= width) {
      this.write(frame, text);
      return;
    }
    const padding = this.fill.repeat(width - text.length);
    const adjust = this.flags & FLAGS.adjustfield;
    if (adjust === FLAGS.left) this.write(frame, text + padding);
    else if (adjust === FLAGS.internal) this.write(frame, text.slice(0, internalAt) + padding + text.slice(internalAt));
    else this.write(frame, padding + text);
  }
}

/** The streams of `<iostream>` and `<sstream>`, and the manipulators of `<ios>` and `<iomanip>`. */
export class Streams {
  readonly ostream: ClassInfo;
  readonly istream: ClassInfo;
  readonly ostringstream: ClassInfo;
  readonly istringstream: ClassInfo;
  readonly stringstream: ClassInfo;
  readonly ios: ClassInfo;
  readonly manipulator: ClassInfo;

  constructor(private readonly library: Library) {
    this.ios = this.iosClass();
    this.manipulator = new ClassInfo('std::__manipulator', 'class');
    this.manipulator.isComplete = true;
    this.manipulator.library = { kind: 'manipulator', args: [], size: 16, align: 8 };
    this.manipulator.operations = { copy: (_frame, value) => value, assign: (_frame, _target, source) => source };
    this.ostream = this.streamClass('std::ostream', undefined, true, false);
    this.istream = this.streamClass('std::istream', undefined, false, true);
    this.ostringstream = this.streamClass('std::ostringstream', this.ostream, true, false);
    this.istringstream = this.streamClass('std::istringstream', this.istream, false, true);
    this.stringstream = this.streamClass('std::stringstream', this.ostream, true, true);
  }

  private iosClass(): ClassInfo {
    const cls = new ClassInfo('std::ios_base', 'class');
    cls.isComplete = true;
    cls.library = { kind: 'ios', args: [], size: 136, align: 8 };
    for (const [name, value] of Object.entries(FLAGS)) {
      cls.constants.set(name, (row) => ({ type: UINT, isLvalue: false, row, run: () => value, constant: value }));
    }
    cls.memberTypes.set('fmtflags', UINT);
    return cls;
  }

  private streamClass(name: string, base: ClassInfo | undefined, isOutput: boolean, isInput: boolean): ClassInfo {
    const cls = new ClassInfo(name, 'class');
    cls.isComplete = true;
    cls.isNoncopyable = true;
    cls.base = base;
    cls.library = {
      kind: name.replace('std::', ''),
      args: [],
      size: 160,
      align: 8,
      operator: (compiler, operator, operands, row) =>
        this.operator(compiler, cls, isOutput, isInput, operator, operands, row),
    };
    cls.operations = {
      copy: () => {
        throw new Error('A stream cannot be copied');
      },
      assign: () => {},
    };
    if (name.includes('stringstream')) {
      const make = (bytes: string): StreamValue => {
        const stream = new StreamValue('buffer');
        stream.buffer = bytes;
        return stream;
      };
      cls.constructors = [
        nativeConstructor(cls, [], () => make('')),
        nativeConstructor(
          cls,
          [constRef(this.library.stringType)],
          ([text]) => make(((text as Ptr).read() as StringValue).bytes),
          { isExplicit: true }
        ),
      ];
      addMethod(
        cls,
        native('str', [], this.library.stringType, (_args, { self }) => new StringValue((self as StreamValue).buffer), {
          isConst: true,
        })
      );
      addMethod(
        cls,
        native('str', [constRef(this.library.stringType)], VOID, ([text], { self }) => {
          const stream = self as StreamValue;
          stream.buffer = ((text as Ptr).read() as StringValue).bytes;
          stream.position = 0;
          stream.writePosition = 0;
          return;
        })
      );
    }
    this.commonMethods(cls, isOutput);
    return cls;
  }

  private commonMethods(cls: ClassInfo, isOutput: boolean): void {
    const refType: Type = { kind: 'reference', to: classType(cls) };
    const method = (
      name: string,
      params: Type[],
      ret: Type,
      run: (stream: StreamValue, args: unknown[], frame: Frame) => unknown,
      options = {}
    ): void => {
      addMethod(
        cls,
        native(name, params, ret, (args, { self: object, frame }) => run(self(object), args, frame), options)
      );
    };
    method('width', [], LONG, (stream) => BigInt(stream.width), { isConst: true });
    method('width', [LONG], LONG, (stream, [width]) => {
      const old = stream.width;
      stream.width = Number(width);
      return BigInt(old);
    });
    method('precision', [], LONG, (stream) => BigInt(stream.precision), { isConst: true });
    method('precision', [LONG], LONG, (stream, [precision]) => {
      const old = stream.precision;
      stream.precision = Number(precision);
      return BigInt(old);
    });
    method('fill', [], CHAR, (stream) => signedChar(byteAt(stream.fill)), { isConst: true });
    method('fill', [CHAR], CHAR, (stream, [char]) => {
      const old = stream.fill;
      stream.fill = String.fromCodePoint(asNumber(char) & 0xff);
      return signedChar(byteAt(old));
    });
    method('flags', [], UINT, (stream) => stream.flags, { isConst: true });
    method('flags', [UINT], UINT, (stream, [flags]) => {
      const old = stream.flags;
      stream.flags = asNumber(flags);
      return old;
    });
    method('setf', [UINT], UINT, (stream, [flags]) => {
      const old = stream.flags;
      stream.flags |= asNumber(flags);
      return old;
    });
    method('setf', [UINT, UINT], UINT, (stream, [flags, mask]) => {
      const old = stream.flags;
      stream.flags = (stream.flags & ~asNumber(mask)) | (asNumber(flags) & asNumber(mask));
      return old;
    });
    method('unsetf', [UINT], VOID, (stream, [flags]) => {
      stream.flags &= ~asNumber(flags);
    });
    method('good', [], BOOL, (stream) => (stream.isGood ? 1 : 0), { isConst: true });
    method('fail', [], BOOL, (stream) => (stream.failed ? 1 : 0), { isConst: true });
    method('bad', [], BOOL, () => 0, { isConst: true });
    method('eof', [], BOOL, (stream) => (stream.atEnd ? 1 : 0), { isConst: true });
    method('clear', [], VOID, (stream) => {
      stream.failed = false;
      stream.atEnd = false;
    });
    if (isOutput) {
      method('put', [CHAR], refType, (stream, [char], frame) => {
        stream.write(frame, String.fromCodePoint(asNumber(char) & 0xff));
        return selfRef(stream);
      });
      method('write', [CONST_CHAR_PTR, LONG], refType, (stream, [pointer, count], frame) => {
        const start = pointer as Ptr;
        let bytes = '';
        for (let index = 0; index < Number(count); index++)
          bytes += String.fromCodePoint(asNumber(start.offset(index).read()) & 0xff);
        stream.write(frame, bytes);
        return selfRef(stream);
      });
      method('flush', [], refType, (stream) => selfRef(stream));
    }
  }

  /** A manipulator as a value, which `<<` applies to the stream. */
  manipulatorExpr(row: number, apply: (stream: StreamValue, frame: Frame) => void, name: string): Expr {
    const value = new ManipulatorValue(apply, name);
    return { type: classType(this.manipulator), isLvalue: false, row, run: () => value };
  }

  /** Compiles `<<` and `>>` of streams, and a stream used as a condition. */
  // code-gauge-allow functionCognitiveComplexity 20 -- The stream operators dispatch on what they read or write.
  private operator(
    compiler: ExpressionCompiler,
    cls: ClassInfo,
    isOutput: boolean,
    isInput: boolean,
    operator: string,
    operands: Expr[],
    row: number
  ): Expr | undefined {
    const [left, right] = operands;
    if (operator === 'bool' || operator === '!') {
      const stream = compiler.rvalue(left).run;
      const negate = operator === '!';
      return {
        type: BOOL,
        isLvalue: false,
        row,
        run: (frame) => ((stream(frame) as StreamValue).failed !== negate ? 0 : 1),
      };
    }
    if (left.type.kind !== 'class' || !left.type.cls.isDerivedFrom(cls) || !right) return undefined;
    if (operator === '<<' && isOutput) return this.insertion(compiler, left, right, row);
    if (operator === '>>' && isInput) return this.extraction(compiler, left, right, row);
    if (operator === '<<' || operator === '>>') {
      return compiler.error(
        row,
        `演算子 ${operator} は ${typeName(left.type)} と ${typeName(right.type)} には使えません。`
      );
    }
    return undefined;
  }

  private insertion(compiler: ExpressionCompiler, left: Expr, right: Expr, row: number): Expr {
    const write = this.writer(compiler, right, row);
    const location = left.isLvalue ? left.run : compiler.materialize(left).run;
    return {
      type: left.type,
      isLvalue: true,
      row,
      run: (frame) => {
        const place = location(frame) as Ptr;
        write(frame, place.read() as StreamValue);
        return place;
      },
    };
  }

  /** How `<<` writes a value of the right operand's type. */
  // code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of value a stream writes.
  private writer(compiler: ExpressionCompiler, right: Expr, row: number): (frame: Frame, stream: StreamValue) => void {
    if (right.functions)
      return compiler.error(row, `関数 ${right.functions.name} の後に (...) を書いて呼び出してください。`);
    const type = right.type;
    if (type.kind === 'class' && type.cls === this.manipulator) {
      const run = right.run;
      return (frame, stream) => (run(frame) as ManipulatorValue).apply(stream, frame);
    }
    if (type.kind === 'class' && type.cls === this.library.stringClass) {
      const run = compiler.rvalue(right).run;
      return (frame, stream) => stream.writeField(frame, (run(frame) as StringValue).bytes);
    }
    const value = compiler.rvalue(right);
    const run = value.run;
    const valueType = value.type;
    if (valueType.kind === 'void') return compiler.error(row, '値を返さない関数（void）の結果は表示できません。');
    if (valueType.kind === 'int') {
      if (isCharType(valueType)) {
        return (frame, stream) => stream.writeField(frame, String.fromCodePoint(asNumber(run(frame)) & 0xff));
      }
      const isSigned = !['bool', 'uint', 'ulong', 'ullong', 'ushort', 'uchar'].includes(valueType.name);
      const bits = ['long', 'ulong', 'llong', 'ullong'].includes(valueType.name) ? 64 : 32;
      if (valueType.name === 'bool') {
        return (frame, stream) => {
          const flag = asNumber(run(frame)) !== 0;
          if (stream.flags & FLAGS.boolalpha) stream.writeField(frame, flag ? 'true' : 'false');
          else writeInteger(frame, stream, flag ? 1n : 0n, false, 32);
        };
      }
      return (frame, stream) => writeInteger(frame, stream, BigInt(run(frame) as number | bigint), isSigned, bits);
    }
    if (valueType.kind === 'float') return (frame, stream) => writeFloat(frame, stream, run(frame) as number);
    if (valueType.kind === 'nullptr') return (frame, stream) => stream.writeField(frame, 'nullptr');
    if (valueType.kind === 'pointer') {
      if (isCharType(valueType.to)) {
        return (frame, stream) => {
          const pointer = run(frame) as Ptr;
          if (pointer.isNull) throw new CppRuntimeError('nullAccess');
          stream.writeField(frame, readCString(pointer));
        };
      }
      return (frame, stream) => stream.writeField(frame, pointerText(run(frame) as Ptr));
    }
    return compiler.error(row, `演算子 << は std::ostream と ${typeName(type)} には使えません。`);
  }

  private extraction(compiler: ExpressionCompiler, left: Expr, right: Expr, row: number): Expr {
    if (!right.isLvalue || isConstType(right.type)) {
      return compiler.error(row, '>> の右には、値を入れられる変数を書いてください。');
    }
    const type = right.type;
    const target = right.run;
    let read: (stream: StreamValue) => Value | undefined;
    if (type.kind === 'class' && type.cls === this.library.stringClass) {
      return this.extractWith(compiler, left, row, (frame, stream) => {
        ((target(frame) as Ptr).read() as StringValue).bytes = readWord(stream);
      });
    }
    if (type.kind === 'int' && isCharType(type)) {
      read = (stream) => {
        if (stream.position < stream.buffer.length) return signedChar(byteAt(stream.buffer, stream.position++));
        stream.failed = true;
        stream.atEnd = true;
        return;
      };
    } else if (type.kind === 'int' && type.name === 'bool') {
      read = readBool;
    } else if (type.kind === 'int') {
      read = (stream) => readInteger(stream, type.name);
    } else if (type.kind === 'float') {
      read = (stream) => readFloat(stream, type.name === 'float');
    } else {
      return compiler.error(row, `演算子 >> は ${typeName(left.type)} と ${typeName(type)} には使えません。`);
    }
    return this.extractWith(compiler, left, row, (frame, stream) => {
      const value = read(stream);
      if (value !== undefined) (target(frame) as Ptr).write(value);
    });
  }

  /** A formatted extraction, which reads only when the input `sentry` lets it. */
  private extractWith(
    compiler: ExpressionCompiler,
    left: Expr,
    row: number,
    extract: (frame: Frame, stream: StreamValue) => void
  ): Expr {
    const location = left.isLvalue ? left.run : compiler.materialize(left).run;
    return {
      type: left.type,
      isLvalue: true,
      row,
      run: (frame) => {
        const place = location(frame) as Ptr;
        const stream = place.read() as StreamValue;
        if (inputSentry(stream)) extract(frame, stream);
        return place;
      },
    };
  }

  /** `std::getline(stream, s)` and `std::getline(stream, s, delimiter)`. */
  getline(): ReturnType<typeof native>[] {
    const stringRef: Type = { kind: 'reference', to: this.library.stringType };
    return [this.istream, this.istringstream, this.stringstream].map((cls) =>
      native(
        'getline',
        [{ kind: 'reference', to: classType(cls) }, stringRef, CHAR],
        { kind: 'reference', to: classType(cls) },
        readLine,
        { optional: 1 }
      )
    );
  }
}

const readLine = ([stream, text, delimiter]: unknown[]): Ptr => {
  const place = stream as Ptr;
  const source = place.read() as StreamValue;
  if (!source.isGood) {
    source.failed = true;
    return place;
  }
  const separator = delimiter === undefined ? '\n' : String.fromCodePoint(asNumber(delimiter) & 0xff);
  const target = (text as Ptr).read() as StringValue;
  const end = source.buffer.indexOf(separator, source.position);
  if (end === -1) {
    if (source.position >= source.buffer.length) source.failed = true;
    target.bytes = source.buffer.slice(source.position);
    source.position = source.buffer.length;
    source.atEnd = true;
  } else {
    target.bytes = source.buffer.slice(source.position, end);
    source.position = end + 1;
  }
  return place;
};

const self = (value: unknown): StreamValue => value as StreamValue;

const selfRef = (stream: StreamValue): Ptr => new Ptr(stream, 0);

/** A manipulator such as `std::endl` or `std::setw(3)`, which `<<` applies to a stream. */
export class ManipulatorValue extends Store {
  constructor(
    readonly apply: (stream: StreamValue, frame: Frame) => void,
    readonly name: string
  ) {
    super();
  }

  get length(): number {
    return 1;
  }

  get(): Value {
    return this;
  }

  set(): void {
    throw new Error('A manipulator cannot be assigned');
  }
}

/** Writes an integer as `num_put` does, with the stream's base, sign, and padding flags. */
function writeInteger(frame: Frame, stream: StreamValue, value: bigint, isSigned: boolean, bits: number): void {
  const base = stream.flags & FLAGS.basefield;
  const upper = (stream.flags & FLAGS.uppercase) !== 0;
  let text: string;
  let prefix = '';
  if (base === FLAGS.hex || base === FLAGS.oct) {
    const magnitude = BigInt.asUintN(bits, value);
    text = magnitude.toString(base === FLAGS.hex ? 16 : 8);
    if (stream.flags & FLAGS.showbase && magnitude !== 0n) prefix = base === FLAGS.hex ? '0x' : '0';
    if (upper) {
      text = text.toUpperCase();
      prefix = prefix.toUpperCase();
    }
  } else {
    const negative = isSigned && value < 0n;
    text = (negative ? -value : value).toString();
    if (negative) prefix = '-';
    else if (isSigned && stream.flags & FLAGS.showpos) prefix = '+';
  }
  stream.writeField(frame, prefix + text, prefix.length);
}

/** Writes a floating-point number as `num_put` does, with the stream's precision and float field. */
function writeFloat(frame: Frame, stream: StreamValue, value: number): void {
  const field = stream.flags & FLAGS.floatfield;
  const conversion =
    field === FLAGS.fixed ? 'f' : field === FLAGS.scientific ? 'e' : field === FLAGS.floatfield ? 'a' : 'g';
  const text = formatFloat(value, {
    conversion,
    precision: conversion === 'a' ? undefined : stream.precision,
    upper: (stream.flags & FLAGS.uppercase) !== 0,
    alternate: (stream.flags & FLAGS.showpoint) !== 0,
    sign: stream.flags & FLAGS.showpos ? '+' : '',
  });
  const signLength = /^[+-]/.test(text) ? 1 : 0;
  const internalAt = conversion === 'a' && /^[+-]?0x/i.test(text) ? signLength + 2 : signLength;
  stream.writeField(frame, text, internalAt);
}

/** The input `sentry`: fails unless the stream is good, then skips whitespace, failing at the end of the text. */
function inputSentry(stream: StreamValue): boolean {
  if (!stream.isGood) {
    stream.failed = true;
    return false;
  }
  if (stream.flags & FLAGS.skipws) {
    while (stream.position < stream.buffer.length && isSpaceByte(byteAt(stream.buffer, stream.position)))
      stream.position++;
    if (stream.position >= stream.buffer.length) {
      stream.failed = true;
      stream.atEnd = true;
      return false;
    }
  }
  return true;
}

/** Reads up to the next whitespace, or as many characters as the width allows, which it then resets. */
function readWord(stream: StreamValue): string {
  const limit = stream.width > 0 ? stream.width : Number.POSITIVE_INFINITY;
  stream.width = 0;
  const start = stream.position;
  while (stream.position - start < limit) {
    if (stream.position >= stream.buffer.length) {
      stream.atEnd = true;
      break;
    }
    if (isSpaceByte(byteAt(stream.buffer, stream.position))) break;
    stream.position++;
  }
  if (stream.position === start) stream.failed = true;
  return stream.buffer.slice(start, stream.position);
}

/** libc++'s `__num_get_base::__src`: the characters `num_get` gathers for integers, then `pP` for floating point. */
const INTEGER_ATOMS = '0123456789abcdefABCDEFxX+-';
const FLOAT_ATOMS = `${INTEGER_ATOMS}pP`;

const INTEGER_RANGES: Record<string, [bigint, bigint]> = {
  short: [-(2n ** 15n), 2n ** 15n - 1n],
  ushort: [0n, 2n ** 16n - 1n],
  int: [-(2n ** 31n), 2n ** 31n - 1n],
  uint: [0n, 2n ** 32n - 1n],
  long: [-(2n ** 63n), 2n ** 63n - 1n],
  ulong: [0n, 2n ** 64n - 1n],
  llong: [-(2n ** 63n), 2n ** 63n - 1n],
  ullong: [0n, 2n ** 64n - 1n],
};

/**
 * Reads an integer as libc++'s `num_get` does: it gathers the characters an integer of the stream's base may hold, and
 * fails storing 0 unless `strtoll` (`strtoull` for an unsigned type) converts all of them; a value out of range fails
 * storing the nearest limit, though an unsigned type wraps a negated value that fits.
 */
function readInteger(stream: StreamValue, name: string): Value {
  const base = numberBase(stream.flags);
  const text = gatherInteger(stream, base);
  const [min, max] = INTEGER_RANGES[name] ?? INTEGER_RANGES.int;
  const isUnsigned = min === 0n;
  const isNegated = isUnsigned && text.startsWith('-');
  const digits = isNegated ? text.slice(1) : text;
  const parsed = parseIntegerPrefix(byteArray(digits), base);
  let value: bigint;
  if (digits === '' || parsed.length !== digits.length) {
    stream.failed = true;
    value = 0n;
  } else if (parsed.value < min || parsed.value > max) {
    stream.failed = true;
    value = parsed.value > 0n ? max : min;
  } else {
    value = isNegated ? BigInt.asUintN(max.toString(2).length, -parsed.value) : parsed.value;
  }
  return ['long', 'ulong', 'llong', 'ullong'].includes(name) ? value : Number(value);
}

/** `ios_base::basefield` as `num_get` reads it: 0 (no base flag) takes the base from the number's prefix. */
function numberBase(flags: number): number {
  const field = flags & FLAGS.basefield;
  if (field === FLAGS.oct) return 8;
  if (field === FLAGS.hex) return 16;
  return field === 0 ? 0 : 10;
}

/** libc++'s `__stage2_int_loop`: a leading sign, digits of the base, and the `x` of a `0x` prefix in base 16. */
function gatherInteger(stream: StreamValue, base: number): string {
  let text = '';
  for (; stream.position < stream.buffer.length; stream.position++) {
    const char = stream.buffer[stream.position];
    if (text === '' && (char === '+' || char === '-')) {
      text += char;
      continue;
    }
    const atom = INTEGER_ATOMS.indexOf(char);
    if (atom === -1 || atom >= 24 || ((base === 8 || base === 10) && atom >= base)) break;
    if (base === 16 && atom >= 22 && !(text.length > 0 && text.length <= 2 && text.endsWith('0'))) break;
    text += char;
  }
  if (stream.position >= stream.buffer.length) stream.atEnd = true;
  return text;
}

/** Reads a `bool` as `num_get` does: a `long` that must be 0 or 1, or with `boolalpha` the word `true` or `false`. */
function readBool(stream: StreamValue): Value {
  if (stream.flags & FLAGS.boolalpha) {
    const index = scanKeyword(stream, ['true', 'false']);
    if (index === -1) stream.failed = true;
    return index === 0 ? 1 : 0;
  }
  const value = readInteger(stream, 'long') as bigint;
  if (value === 0n || value === 1n) return Number(value);
  // libc++ replaces the state with failbit alone, dropping an eofbit the number set.
  stream.failed = true;
  stream.atEnd = false;
  return 1;
}

/** libc++'s `__scan_keyword`: consumes characters while they may still spell a keyword, returning the one spelled. */
function scanKeyword(stream: StreamValue, keywords: string[]): number {
  const status = keywords.map(() => 'mightMatch');
  for (let index = 0; stream.position < stream.buffer.length && status.includes('mightMatch'); index++) {
    const char = stream.buffer[stream.position];
    let consumed = false;
    for (const [at, keyword] of keywords.entries()) {
      if (status[at] !== 'mightMatch') continue;
      if (keyword[index] !== char) {
        status[at] = 'doesNotMatch';
        continue;
      }
      consumed = true;
      if (keyword.length === index + 1) status[at] = 'matches';
    }
    if (!consumed) continue;
    stream.position++;
    const candidates = status.filter((state) => state !== 'doesNotMatch').length;
    for (const [at, keyword] of keywords.entries()) {
      if (candidates > 1 && status[at] === 'matches' && keyword.length !== index + 1) status[at] = 'doesNotMatch';
    }
  }
  if (stream.position >= stream.buffer.length) stream.atEnd = true;
  return status.indexOf('matches');
}

/**
 * Reads a floating-point number as libc++'s `num_get` does: it gathers the characters a number may hold and fails
 * storing 0 unless `strtod` converts all of them; a result out of range fails but stays stored.
 */
function readFloat(stream: StreamValue, isFloat: boolean): number {
  const text = gatherFloat(stream);
  const bytes = byteArray(text);
  const parsed = parseFloatPrefix(bytes);
  if (text === '' || parsed.length !== text.length) {
    stream.failed = true;
    return 0;
  }
  const value = isFloat ? Math.fround(parsed.value) : parsed.value;
  const isUnderflow =
    parsed.isNonzeroText &&
    Math.abs(value) < (isFloat ? 2 ** -126 : 2 ** -1022) &&
    !isExactFloatPrefix(bytes, parsed.length, value);
  if (!Number.isFinite(value) || isUnderflow) stream.failed = true;
  return value;
}

/**
 * Gathers the characters of a floating-point number as libc++'s `num_get` does, checking that a decimal digit or point
 * leads: a character that fails that check is gathered but stays unread.
 */
function gatherFloat(stream: StreamValue): string {
  let text = '';
  const scan: FloatScan = { inUnits: true, exponent: 'E' };
  let isLeadingParsed = false;
  for (; stream.position < stream.buffer.length; stream.position++) {
    const char = stream.buffer[stream.position];
    if (!acceptsFloatChar(scan, text, char)) break;
    text += char;
    if (!isLeadingParsed) {
      const lead = text[0] === '+' || text[0] === '-' ? text[1] : text[0];
      if (lead !== undefined) {
        if (!/[\d.]/.test(lead)) return text;
        isLeadingParsed = true;
      }
    }
  }
  if (stream.position >= stream.buffer.length) stream.atEnd = true;
  return text;
}

interface FloatScan {
  /** Whether no decimal point or exponent has come yet. */
  inUnits: boolean;
  /** The exponent letter: `E`, or `P` after an `x`; lowercased once it has come. */
  exponent: string;
}

/** libc++'s `__stage2_float_loop` for one character: whether the number takes it after `text`. */
function acceptsFloatChar(scan: FloatScan, text: string, char: string): boolean {
  if (char === '.') {
    if (!scan.inUnits) return false;
    scan.inUnits = false;
    return true;
  }
  if (!FLOAT_ATOMS.includes(char)) return false;
  if (char === '+' || char === '-') return text === '' || text.at(-1)?.toUpperCase() === scan.exponent.toUpperCase();
  if (char === 'x' || char === 'X') {
    scan.exponent = 'P';
  } else if (char.toUpperCase() === scan.exponent) {
    scan.exponent = scan.exponent.toLowerCase();
    scan.inUnits = false;
  }
  return true;
}
