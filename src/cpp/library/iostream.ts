import { isFloatUnderflow, isSpaceByte, parseFloatPrefix, parseIntegerPrefix } from '../../c/library/numberParsing';
import { ExecutionLimitError, LIMITS } from '../../interpreter/limits';
import { byteArray, byteAt } from '../bytes';
import { scalarValue } from '../conversions';
import { CppRuntimeError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { type Frame, holdAll } from '../runtime';
import {
  BOOL,
  CHAR,
  ClassInfo,
  classType,
  isCharType,
  isConstType,
  LONG,
  type NativeFunction,
  pointerTo,
  referenceTo,
  type Type,
  typeName,
  UINT,
  VOID,
} from '../types';
import { NULL_PTR, type Ptr, Store, type Value } from '../values';
import { formatFloat, pointerText } from './formatting';
import type { LibraryClass } from './libraryClass';
import type { Library } from './registry';
import type { StringValue } from './string';
import { makeString } from './string';
import {
  addMethod,
  asNumber,
  CONST_CHAR_PTR,
  constRef,
  generic,
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

const OPEN_MODE = { app: 0x01, ate: 0x02, binary: 0x04, in: 0x08, out: 0x10, trunc: 0x20 } as const;
const IO_STATE = { goodbit: 0, badbit: 1, eofbit: 2, failbit: 4 } as const;

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
  state: number = IO_STATE.goodbit;
  tied = NULL_PTR;

  constructor(
    readonly target: 'stdout' | 'stderr' | 'buffer',
    readonly mode = OPEN_MODE.in | OPEN_MODE.out
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
    throw new Error('A stream cannot be assigned');
  }

  get isGood(): boolean {
    return this.state === IO_STATE.goodbit;
  }

  get failed(): boolean {
    return (this.state & (IO_STATE.failbit | IO_STATE.badbit)) !== 0;
  }

  /** Writes unless the stream has failed or reached its end, as an output `sentry` allows. */
  write(frame: Frame, bytes: string, formatted = false): void {
    if (!this.isGood || bytes.length === 0) return;
    if (this.target === 'buffer') {
      if (!(this.mode & OPEN_MODE.out)) {
        this.state |= formatted ? IO_STATE.badbit | IO_STATE.failbit : IO_STATE.badbit;
        return;
      }
      const at = this.writePosition;
      const end = at + bytes.length;
      if (end > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
      frame.runtime.reserve(Math.ceil(bytes.length / 8));
      this.buffer = this.buffer.slice(0, at) + bytes + this.buffer.slice(end);
      this.writePosition = end;
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
      this.write(frame, text, true);
      return;
    }
    this.checkFormattedSize(frame, width);
    const padding = this.fill.repeat(width - text.length);
    const adjust = this.flags & FLAGS.adjustfield;
    if (adjust === FLAGS.left) this.write(frame, text + padding, true);
    else if (adjust === FLAGS.internal)
      this.write(frame, text.slice(0, internalAt) + padding + text.slice(internalAt), true);
    else this.write(frame, padding + text, true);
  }
  checkFormattedSize(frame: Frame, length: number): void {
    if (this.target === 'buffer') {
      if (this.writePosition + length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
    } else if (length > LIMITS.maxOutputLength) {
      throw new ExecutionLimitError('output');
    }
    frame.runtime.spend(Math.ceil(length / 64));
  }
}

const STREAM_SIZES = {
  ios_base: 136,
  ios: 152,
  ostream: 160,
  istream: 168,
  ostringstream: 264,
  istringstream: 272,
  stringstream: 280,
} as const;

type StreamKind = Exclude<keyof typeof STREAM_SIZES, 'ios_base' | 'ios'>;

/** The streams of `<iostream>` and `<sstream>`, and the manipulators of `<ios>` and `<iomanip>`. */
export class Streams {
  readonly ostream: ClassInfo;
  readonly istream: ClassInfo;
  readonly ostringstream: ClassInfo;
  readonly istringstream: ClassInfo;
  readonly stringstream: ClassInfo;
  readonly iosBase: ClassInfo;
  readonly ios: ClassInfo;
  /** A manipulator that both `<<` and `>>` apply. */
  readonly manipulator: ClassInfo;
  /** A manipulator that only `<<` applies, such as `std::endl` or `std::setfill('*')`. */
  readonly outputManipulator: ClassInfo;

  constructor(private readonly library: Library) {
    this.iosBase = this.iosBaseClass();
    this.ios = streamInfo('ios', this.iosBase, {
      operator: (compiler, operator, operands, row) =>
        this.operator(compiler, this.ios, false, false, operator, operands, row),
    });
    this.ios.isDefaultConstructorDeleted = true;
    this.manipulator = manipulatorClass('std::__manipulator');
    this.outputManipulator = manipulatorClass('std::__output_manipulator');
    this.ostream = this.streamClass('ostream', this.ios, true, false);
    this.istream = this.streamClass('istream', this.ios, false, true);
    this.ostringstream = this.streamClass('ostringstream', this.ostream, true, false);
    this.istringstream = this.streamClass('istringstream', this.istream, false, true);
    this.stringstream = this.streamClass('stringstream', this.ostream, true, true, [this.istream]);
    this.commonMethods();
  }

  private iosBaseClass(): ClassInfo {
    const cls = streamInfo('ios_base');
    cls.isDefaultConstructorDeleted = true;
    for (const [name, value] of Object.entries({ ...FLAGS, ...OPEN_MODE, ...IO_STATE })) {
      cls.constants.set(name, (row) => ({ type: UINT, isLvalue: false, row, run: () => value, constant: value }));
    }
    cls.memberTypes.set('fmtflags', UINT);
    cls.memberTypes.set('openmode', UINT);
    cls.memberTypes.set('iostate', UINT);
    addMethod(
      cls,
      native(
        'sync_with_stdio',
        [BOOL],
        BOOL,
        ([synchronize], { frame }) => {
          const previous = frame.runtime.isStdioSynchronized;
          frame.runtime.isStdioSynchronized = synchronize === undefined || synchronize !== 0;
          return previous ? 1 : 0;
        },
        { owner: cls, isStatic: true, optional: 1 }
      )
    );
    return cls;
  }

  private streamClass(
    kind: StreamKind,
    base: ClassInfo,
    isOutput: boolean,
    isInput: boolean,
    additionalPublicBases?: readonly ClassInfo[]
  ): ClassInfo {
    const cls = streamInfo(kind, base, {
      additionalPublicBases,
      operator: (compiler, operator, operands, row) =>
        this.operator(compiler, cls, isOutput, isInput, operator, operands, row),
    });
    cls.operations = {
      copy: () => {
        throw new Error('A stream cannot be copied');
      },
      assign: () => {},
    };
    if (kind === 'ostream' || kind === 'istream') cls.isDefaultConstructorDeleted = true;
    else {
      const defaultMode = (isInput ? OPEN_MODE.in : 0) | (isOutput ? OPEN_MODE.out : 0);
      const requiredMode = isInput && isOutput ? 0 : defaultMode;
      const make = (bytes: string, mode = defaultMode): StreamValue => {
        const stream = new StreamValue('buffer', mode | requiredMode);
        setStreamBuffer(stream, bytes);
        return stream;
      };
      cls.constructors = [
        nativeConstructor(cls, [], () => make('')),
        nativeConstructor(cls, [UINT], ([mode]) => make('', asNumber(mode)), { isExplicit: true }),
        nativeConstructor(
          cls,
          [constRef(this.library.stringType), UINT],
          ([text, mode]) =>
            make(((text as Ptr).read() as StringValue).bytes, mode === undefined ? defaultMode : asNumber(mode)),
          { isExplicit: true, optional: 1 }
        ),
      ];
      addMethod(
        cls,
        native(
          'str',
          [],
          this.library.stringType,
          (_args, { self, frame }) => makeString(frame, (self as StreamValue).buffer),
          {
            isConst: true,
          }
        )
      );
      addMethod(
        cls,
        native('str', [constRef(this.library.stringType)], VOID, ([text], { self }) => {
          setStreamBuffer(self as StreamValue, ((text as Ptr).read() as StringValue).bytes);
          return;
        })
      );
    }
    if (isOutput) this.addOutputMembers(cls);
    return cls;
  }

  private commonMethods(): void {
    const method = bindStreamMethods(this.ios);
    const format = bindStreamMethods(this.iosBase);
    const ostreamPointer = pointerTo(classType(this.ostream));
    method('tie', [], ostreamPointer, (stream) => stream.tied, { isConst: true });
    method('tie', [ostreamPointer], ostreamPointer, (stream, [next]) => {
      const previous = stream.tied;
      stream.tied = next as Ptr;
      return previous;
    });
    format('width', [], LONG, (stream) => BigInt(stream.width), { isConst: true });
    format('width', [LONG], LONG, (stream, [width]) => {
      const old = stream.width;
      stream.width = Number(width);
      return BigInt(old);
    });
    format('precision', [], LONG, (stream) => BigInt(stream.precision), { isConst: true });
    format('precision', [LONG], LONG, (stream, [precision]) => {
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
    format('flags', [], UINT, (stream) => stream.flags, { isConst: true });
    format('flags', [UINT], UINT, (stream, [flags]) => {
      const old = stream.flags;
      stream.flags = asNumber(flags);
      return old;
    });
    format('setf', [UINT], UINT, (stream, [flags]) => {
      const old = stream.flags;
      stream.flags |= asNumber(flags);
      return old;
    });
    format('setf', [UINT, UINT], UINT, (stream, [flags, mask]) => {
      const old = stream.flags;
      stream.flags = (stream.flags & ~asNumber(mask)) | (asNumber(flags) & asNumber(mask));
      return old;
    });
    format('unsetf', [UINT], VOID, (stream, [flags]) => {
      stream.flags &= ~asNumber(flags);
    });
    method('good', [], BOOL, (stream) => (stream.isGood ? 1 : 0), { isConst: true });
    method('fail', [], BOOL, (stream) => (stream.failed ? 1 : 0), { isConst: true });
    method('bad', [], BOOL, (stream) => (stream.state & IO_STATE.badbit ? 1 : 0), { isConst: true });
    method('eof', [], BOOL, (stream) => (stream.state & IO_STATE.eofbit ? 1 : 0), { isConst: true });
    method('rdstate', [], UINT, (stream) => stream.state, { isConst: true });
    method(
      'clear',
      [UINT],
      VOID,
      (stream, [state]) => {
        stream.state = state === undefined ? IO_STATE.goodbit : asNumber(state);
      },
      { optional: 1 }
    );
    method('setstate', [UINT], VOID, (stream, [state]) => {
      stream.state |= asNumber(state);
    });
  }

  private addOutputMembers(cls: ClassInfo): void {
    const result = referenceTo(classType(this.ostream ?? cls));
    const output = (
      name: string,
      params: Type[],
      run: (stream: StreamValue, args: unknown[], frame: Frame) => void
    ): void => {
      addMethod(
        cls,
        native(name, params, result, (args, { self: object, selfLocation, frame }) => {
          run(self(object), args, frame);
          return selfLocation;
        })
      );
    };
    output('put', [CHAR], (stream, [char], frame) => {
      stream.write(frame, String.fromCodePoint(asNumber(char) & 0xff));
    });
    output('write', [CONST_CHAR_PTR, LONG], (stream, [pointer, count], frame) => {
      const start = pointer as Ptr;
      let bytes = '';
      for (let index = 0; index < Number(count); index++)
        bytes += String.fromCodePoint(asNumber(start.offset(index).read()) & 0xff);
      stream.write(frame, bytes);
    });
    output('flush', [], () => {});
  }

  manipulatorType(isOutputOnly: boolean): Type {
    return classType(isOutputOnly ? this.outputManipulator : this.manipulator);
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
    if (((operator === '<<' && isOutput) || (operator === '>>' && isInput)) && isConstType(left.type))
      return compiler.error(row, `const の ${typeName(left.type)} には演算子 ${operator} を使えません。`);
    if (operator === '<<' && isOutput)
      return this.namedManipulator(compiler, left, right, row, true) ?? this.insertion(compiler, left, right, row);
    if (operator === '>>' && isInput) {
      const named = this.namedManipulator(compiler, left, right, row, false);
      if (named) return named;
      const isManipulator = right.type.kind === 'class' && right.type.cls === this.manipulator;
      return isManipulator ? this.applyTo(compiler, left, right, row) : this.extraction(compiler, left, right, row);
    }
    if (operator === '<<' || operator === '>>') {
      return compiler.error(
        row,
        `演算子 ${operator} は ${typeName(left.type)} と ${typeName(right.type)} には使えません。`
      );
    }
    return undefined;
  }

  private namedManipulator(
    compiler: ExpressionCompiler,
    stream: Expr,
    operand: Expr,
    row: number,
    output: boolean
  ): Expr | undefined {
    const candidate = operand.functions?.candidates.find(
      (fn) => fn.streamManipulator === 'both' || (output && fn.streamManipulator === 'output')
    );
    if (!candidate) return;
    const resolved = compiler.resolve(candidate.displayName, [candidate], [stream], undefined, row);
    return { ...compiler.callExpr(resolved, [stream], undefined, row), type: stream.type };
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
    if (type.kind === 'class' && [this.manipulator, this.outputManipulator].includes(type.cls)) {
      const run = compiler.rvalue(right).run;
      return (frame, stream) => (run(frame) as ManipulatorValue).apply(stream, frame);
    }
    if (type.kind === 'class' && type.cls === this.library.stringClass) {
      const run = compiler.rvalue(right).run;
      return (frame, stream) => stream.writeField(frame, (run(frame) as StringValue).bytes);
    }
    const value = scalarValue(compiler, right);
    const run = value.run;
    const valueType = value.type;
    if (valueType.kind === 'void') return compiler.error(row, '値を返さない関数（void）の結果は表示できません。');
    if (valueType.kind === 'int') {
      if (isCharType(valueType)) {
        return (frame, stream) => stream.writeField(frame, String.fromCodePoint(asNumber(run(frame)) & 0xff));
      }
      if (valueType.name === 'bool') return (frame, stream) => writeBool(frame, stream, asNumber(run(frame)) !== 0);
      const isSigned = !['uint', 'ulong', 'ullong', 'ushort', 'uchar'].includes(valueType.name);
      const bits = INTEGER_BITS[valueType.name] ?? 32;
      return (frame, stream) => writeInteger(frame, stream, BigInt(run(frame) as number | bigint), isSigned, bits);
    }
    if (valueType.kind === 'float') return (frame, stream) => writeFloat(frame, stream, Number(run(frame)));
    if (valueType.kind === 'nullptr') return (frame, stream) => stream.writeField(frame, 'nullptr');
    if (valueType.kind === 'pointer') {
      if (isCharType(valueType.to)) {
        return (frame, stream) => {
          const pointer = run(frame) as Ptr;
          if (pointer.isNull) throw new CppRuntimeError('nullAccess');
          stream.writeField(frame, readCString(pointer, frame.runtime));
        };
      }
      return (frame, stream) => writePointer(frame, stream, run(frame) as Ptr);
    }
    return compiler.error(row, `演算子 << は std::ostream と ${typeName(type)} には使えません。`);
  }

  private extraction(compiler: ExpressionCompiler, left: Expr, right: Expr, row: number): Expr {
    if (!right.isLvalue || isConstType(right.type)) {
      return compiler.error(row, '>> の右には、値を入れられる変数を書いてください。');
    }
    const type = right.type;
    let read: (stream: StreamValue) => Value | undefined;
    if (type.kind === 'class' && type.cls === this.library.stringClass) {
      return this.extractWith(compiler, left, right, row, (stream, target, frame) => {
        (target.read() as StringValue).replaceBytes(frame, readWord(stream));
      });
    }
    if (type.kind === 'int' && isCharType(type)) {
      read = (stream) => {
        if (stream.position < stream.buffer.length) {
          const byte = byteAt(stream.buffer, stream.position++);
          return type.name === 'uchar' ? byte : signedChar(byte);
        }
        stream.state |= IO_STATE.failbit | IO_STATE.eofbit;
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
    return this.extractWith(compiler, left, right, row, (stream, target) => {
      const value = read(stream);
      if (value !== undefined) target.write(value);
    });
  }

  /** `stream >> manipulator`, which applies the manipulator without the input `sentry`. */
  private applyTo(compiler: ExpressionCompiler, left: Expr, manipulator: Expr, row: number): Expr {
    const location = left.isLvalue ? left.run : compiler.materialize(left).run;
    const run = compiler.rvalue(manipulator).run;
    return {
      type: left.type,
      isLvalue: true,
      row,
      run: (frame) => {
        const place = location(frame) as Ptr;
        (run(frame) as ManipulatorValue).apply(place.read() as StreamValue, frame);
        return place;
      },
    };
  }

  /** A formatted extraction, which reads only when the input `sentry` lets it. */
  private extractWith(
    compiler: ExpressionCompiler,
    left: Expr,
    right: Expr,
    row: number,
    extract: (stream: StreamValue, target: Ptr, frame: Frame) => void
  ): Expr {
    const location = left.isLvalue ? left.run : compiler.materialize(left).run;
    return {
      type: left.type,
      isLvalue: true,
      row,
      run: (frame) =>
        holdAll(frame, [location, right.run], ([receiver, destination]) => {
          const place = receiver as Ptr;
          const stream = place.read() as StreamValue;
          if (inputSentry(stream)) extract(stream, destination as Ptr, frame);
          return place;
        }),
    };
  }

  /** `std::getline(stream, s)` and `std::getline(stream, s, delimiter)`. */
  getline(): ReturnType<typeof native>[] {
    const stringRef: Type = { kind: 'reference', to: this.library.stringType };
    const input = new Set([this.istream, this.istringstream, this.stringstream]);
    return [
      generic('getline', (args) => {
        const stream = args[0];
        const type = stream?.type;
        if (type?.kind !== 'class' || isConstType(type) || !input.has(type.cls)) return;
        const parameter = stream.isLvalue ? referenceTo(type) : constRef(type);
        return native('getline', [parameter, stringRef, CHAR], referenceTo(type), readLine, { optional: 1 });
      }),
    ];
  }
}

function streamInfo(
  kind: keyof typeof STREAM_SIZES,
  base?: ClassInfo,
  members?: Pick<LibraryClass, 'operator' | 'additionalPublicBases'>
): ClassInfo {
  const cls = new ClassInfo(`std::${kind}`, 'class');
  cls.isComplete = true;
  cls.isNoncopyable = true;
  cls.isAssignmentDeleted = true;
  cls.base = base;
  cls.library = { kind, args: [], size: STREAM_SIZES[kind], align: 8, ...members };
  return cls;
}

function bindStreamMethods(cls: ClassInfo) {
  return (
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
}

function setStreamBuffer(stream: StreamValue, bytes: string): void {
  stream.buffer = bytes;
  stream.position = 0;
  stream.writePosition = stream.mode & (OPEN_MODE.app | OPEN_MODE.ate) ? bytes.length : 0;
}

const readLine: NativeFunction = ([stream, text, delimiter], { frame }) => {
  const place = stream as Ptr;
  const source = place.read() as StreamValue;
  if (!source.isGood || !(source.mode & OPEN_MODE.in)) {
    source.state |= IO_STATE.failbit;
    return place;
  }
  const separator = delimiter === undefined ? '\n' : String.fromCodePoint(asNumber(delimiter) & 0xff);
  const target = (text as Ptr).read() as StringValue;
  const end = source.buffer.indexOf(separator, source.position);
  if (end === -1) {
    if (source.position >= source.buffer.length) source.state |= IO_STATE.failbit;
    target.replaceBytes(frame, source.buffer.slice(source.position));
    source.position = source.buffer.length;
    source.state |= IO_STATE.eofbit;
  } else {
    target.replaceBytes(frame, source.buffer.slice(source.position, end));
    source.position = end + 1;
  }
  return place;
};

const self = (value: unknown): StreamValue => value as StreamValue;

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

function manipulatorClass(name: string): ClassInfo {
  const cls = new ClassInfo(name, 'class');
  cls.isComplete = true;
  cls.library = { kind: 'manipulator', args: [], size: 16, align: 8 };
  cls.operations = {
    copyIsNoexcept: true,
    copy: (_frame, value) => copyManipulator(value),
    assign: (_frame, _target, source) => copyManipulator(source),
  };
  return cls;
}

function copyManipulator(value: Value): ManipulatorValue {
  const { apply, name } = value as ManipulatorValue;
  return new ManipulatorValue(apply, name);
}

/** The width of an integer type `<<` writes in hex or oct: libc++ passes a `short` as `unsigned short`. */
const INTEGER_BITS: Record<string, number> = { short: 16, ushort: 16, long: 64, ulong: 64, llong: 64, ullong: 64 };

/** libc++'s `num_put::do_put(bool)`, which copies a `boolalpha` word as is, so the width neither pads it nor resets. */
function writeBool(frame: Frame, stream: StreamValue, flag: boolean): void {
  if (stream.flags & FLAGS.boolalpha) stream.write(frame, flag ? 'true' : 'false', true);
  else writeInteger(frame, stream, flag ? 1n : 0n, false, 32);
}

/** libc++ writes a pointer as an integer with `showbase`, which gives a null pointer no `0x`. */
function writePointer(frame: Frame, stream: StreamValue, pointer: Ptr): void {
  const text = pointer.isNull ? '0' : pointerText(pointer);
  stream.writeField(frame, text, paddingPoint(text));
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
  stream.writeField(frame, prefix + text, paddingPoint(prefix + text));
}

/** Writes a floating-point number as `num_put` does, with the stream's precision and float field. */
function writeFloat(frame: Frame, stream: StreamValue, value: number): void {
  if (!stream.isGood) return;
  const field = stream.flags & FLAGS.floatfield;
  const conversion =
    field === FLAGS.fixed ? 'f' : field === FLAGS.scientific ? 'e' : field === FLAGS.floatfield ? 'a' : 'g';
  const alternate = (stream.flags & FLAGS.showpoint) !== 0;
  let precision = conversion === 'a' || stream.precision < 0 ? undefined : stream.precision;
  if (precision !== undefined && Number.isFinite(value)) {
    if (conversion === 'g' && !alternate) {
      // A binary64 value is an integer times 2^-1074 at worst; further digits only pad the rounded number.
      precision = Math.min(precision, 1074);
      frame.runtime.spend(Math.ceil(precision / 64));
    } else stream.checkFormattedSize(frame, precision);
  }
  const text = formatFloat(value, {
    conversion,
    precision,
    upper: (stream.flags & FLAGS.uppercase) !== 0,
    alternate,
    sign: stream.flags & FLAGS.showpos ? '+' : '',
  });
  stream.writeField(frame, text, paddingPoint(text));
}

/** libc++'s `__num_put_base::__identify_padding` for `internal`: after a sign, or else after a `0x` prefix. */
function paddingPoint(text: string): number {
  if (/^[+-]/.test(text)) return 1;
  return /^0x/i.test(text) ? 2 : 0;
}

/** The input `sentry`: fails unless the stream is good, then skips whitespace, failing at the end of the text. */
function inputSentry(stream: StreamValue): boolean {
  if (!stream.isGood || !(stream.mode & OPEN_MODE.in)) {
    stream.state |= IO_STATE.failbit;
    return false;
  }
  if (stream.flags & FLAGS.skipws) {
    while (stream.position < stream.buffer.length && isSpaceByte(byteAt(stream.buffer, stream.position)))
      stream.position++;
    if (stream.position >= stream.buffer.length) {
      stream.state |= IO_STATE.failbit | IO_STATE.eofbit;
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
      stream.state |= IO_STATE.eofbit;
      break;
    }
    if (isSpaceByte(byteAt(stream.buffer, stream.position))) break;
    stream.position++;
  }
  if (stream.position === start) stream.state |= IO_STATE.failbit;
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
    stream.state |= IO_STATE.failbit;
    value = 0n;
  } else if (parsed.value < min || parsed.value > max) {
    stream.state |= IO_STATE.failbit;
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
  if (stream.position >= stream.buffer.length) stream.state |= IO_STATE.eofbit;
  return text;
}

/** Reads a `bool` as `num_get` does: a `long` that must be 0 or 1, or with `boolalpha` the word `true` or `false`. */
function readBool(stream: StreamValue): Value {
  if (stream.flags & FLAGS.boolalpha) {
    const index = scanKeyword(stream, ['true', 'false']);
    if (index === -1) stream.state |= IO_STATE.failbit;
    return index === 0 ? 1 : 0;
  }
  const value = readInteger(stream, 'long') as bigint;
  if (value === 0n || value === 1n) return Number(value);
  // libc++ replaces the state with failbit alone, dropping an eofbit the number set.
  stream.state = IO_STATE.failbit;
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
  if (stream.position >= stream.buffer.length) stream.state |= IO_STATE.eofbit;
  return status.indexOf('matches');
}

/**
 * Reads a floating-point number as libc++'s `num_get` does: it gathers the characters a number may hold and fails
 * storing 0 unless `strtod` converts all of them; a result out of range fails but stays stored.
 */
function readFloat(stream: StreamValue, isFloat: boolean): number {
  const text = gatherFloat(stream);
  const bytes = byteArray(text);
  const parsed = parseFloatPrefix(bytes, undefined, isFloat);
  if (text === '' || parsed.length !== text.length) {
    stream.state |= IO_STATE.failbit;
    return 0;
  }
  const { value } = parsed;
  if (!Number.isFinite(value) || isFloatUnderflow(bytes, parsed, value, isFloat)) stream.state |= IO_STATE.failbit;
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
  if (stream.position >= stream.buffer.length) stream.state |= IO_STATE.eofbit;
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
