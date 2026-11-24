import { isFloatUnderflow, isSpaceByte, parseFloatPrefix } from '../../c/library/numberParsing';
import { ExecutionLimitError, LIMITS } from '../../interpreter/limits';
import { type FileHandle, FileSystemError } from '../../interpreter/programIo';
import { byteArray, byteAt } from '../bytes';
import { scalarValue } from '../conversions';
import { CppRuntimeError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { utf8 } from '../literals';
import { type Frame, holdAll } from '../runtime';
import {
  BOOL,
  CHAR,
  ClassInfo,
  classType,
  INT,
  isCharType,
  isConstType,
  LONG,
  type NativeFunction,
  pointerTo,
  referenceTo,
  sizeOf,
  type Type,
  typeName,
  UINT,
  VOID,
} from '../types';
import { NULL_PTR, type Ptr, Store, type Value } from '../values';
import { formatFloat, pointerText } from './formatting';
import type { LibraryClass } from './libraryClass';
import type { Library } from './registry';
import { makeString, StringValue } from './string';
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

export const OPEN_MODE = { app: 0x01, ate: 0x02, binary: 0x04, in: 0x08, out: 0x10, trunc: 0x20 } as const;
export const IO_STATE = { goodbit: 0, badbit: 1, eofbit: 2, failbit: 4 } as const;

const STREAM_SIZES = {
  ios_base: 136,
  ios: 152,
  ostream: 160,
  istream: 168,
  ostringstream: 264,
  istringstream: 272,
  stringstream: 280,
  ifstream: 576,
  ofstream: 568,
  fstream: 584,
} as const;

type StreamKind = Exclude<keyof typeof STREAM_SIZES, 'ios_base' | 'ios'>;

type StreamBaseKind = 'ios_base' | 'ios' | 'ostream' | 'istream';

const STREAM_BASES: Record<StreamKind, readonly StreamBaseKind[]> = {
  ostream: ['ios_base', 'ios'],
  istream: ['ios_base', 'ios'],
  ostringstream: ['ios_base', 'ios', 'ostream'],
  istringstream: ['ios_base', 'ios', 'istream'],
  stringstream: ['ios_base', 'ios', 'ostream', 'istream'],
  ifstream: ['ios_base', 'ios', 'istream'],
  ofstream: ['ios_base', 'ios', 'ostream'],
  fstream: ['ios_base', 'ios', 'ostream', 'istream'],
};

const IOS_OFFSETS: Record<StreamKind, number> = {
  ostream: 8,
  istream: 16,
  ostringstream: 112,
  istringstream: 120,
  stringstream: 128,
  ifstream: 424,
  ofstream: 416,
  fstream: 432,
};

/** A stream: standard output or error, or a string stream, with its formatting state. */
export class StreamValue extends Store {
  width = 0;
  precision = 6;
  fill = ' ';
  flags: number = FLAGS.skipws | FLAGS.dec;
  private content = new StringValue('');
  /** Where reading continues in the buffer. */
  position = 0;
  /** Where writing continues in the buffer, overwriting what is there, as `basic_stringbuf`'s put area does. */
  writePosition = 0;
  state: number = IO_STATE.goodbit;
  /** The number of characters the last unformatted input extracted (`gcount()`). */
  extracted = 0;
  tied = NULL_PTR;
  private readonly bases = new Map<StreamBaseKind, Ptr>();

  /** The file a file stream writes to, while it is open. */
  file: FileHandle | undefined;
  /** Whether a file stream has a file open. */
  isOpen = false;
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly kind: StreamKind,
    readonly target: 'stdout' | 'stderr' | 'buffer' | 'file',
    public mode: number = OPEN_MODE.in | OPEN_MODE.out
  ) {
    super();
  }

  /**
   * Opens a file as `basic_filebuf::open` does (C++20 [filebuf.members]): reading needs the file to exist, writing
   * creates it and empties it unless the mode appends or reads too; failing sets `failbit`.
   */
  openFile(frame: Frame, path: string, mode: number): void {
    const { files } = frame.runtime.io;
    if (this.isOpen) {
      this.state |= IO_STATE.failbit;
      return;
    }
    this.mode = mode;
    const reads = (mode & OPEN_MODE.in) !== 0;
    const writes = (mode & (OPEN_MODE.out | OPEN_MODE.app)) !== 0;
    try {
      const appends = (mode & OPEN_MODE.app) !== 0;
      const truncates = (mode & OPEN_MODE.trunc) !== 0 || (writes && !reads && !appends);
      if (writes)
        this.file = files.open(path, {
          create: reads && !truncates && !appends ? 'never' : 'always',
          truncate: truncates,
          append: appends,
        });
      this.startWith(reads ? utf8(files.readFile(path)) : '');
      this.position = 0;
      this.isOpen = true;
      this.state = IO_STATE.goodbit;
    } catch (error) {
      if (!(error instanceof FileSystemError)) throw error;
      this.state |= IO_STATE.failbit;
    }
  }

  closeFile(): boolean {
    if (!this.isOpen) {
      this.state |= IO_STATE.failbit;
      return false;
    }
    this.file?.write(this.decoder.decode());
    this.file = undefined;
    this.isOpen = false;
    return true;
  }

  override classView(location: Ptr, cls: ClassInfo): Ptr | undefined {
    const kind = cls.library?.kind;
    const complete = location.store instanceof StreamBaseStorage ? location.store.complete : location;
    if (kind === this.kind) return complete;
    const base = STREAM_BASES[this.kind].find((candidate) => candidate === kind);
    if (!base) return;
    let view = this.bases.get(base);
    if (!view) {
      const offset =
        kind === 'ios' || kind === 'ios_base'
          ? IOS_OFFSETS[this.kind]
          : (this.kind === 'stringstream' || this.kind === 'fstream') && kind === 'ostream'
            ? 16
            : 0;
      view = new StreamBaseStorage(complete, this, offset, sizeOf(classType(cls))).location(0);
      this.bases.set(base, view);
    }
    return view;
  }

  get length(): number {
    return 1;
  }

  override projectAddress(index: number, byteOffset: number): Ptr['address'] {
    return { store: this, index: index * STREAM_SIZES[this.kind] + byteOffset };
  }

  get buffer(): string {
    return this.content.bytes;
  }

  /** Starts the stream with the bytes it reads, before the program runs (standard input). */
  startWith(bytes: string): void {
    this.content = new StringValue(bytes);
  }

  resetBuffer(frame: Frame, bytes: string): void {
    this.content.replaceBytes(frame, bytes);
    this.position = 0;
    this.writePosition = this.mode & (OPEN_MODE.app | OPEN_MODE.ate) ? bytes.length : 0;
  }

  get(index: number): Value {
    if (index !== 0) throw new CppRuntimeError('outOfBounds');
    return this;
  }

  set(index: number): void {
    if (index !== 0) throw new CppRuntimeError('outOfBounds');
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
      this.content.replaceBytes(frame, this.buffer.slice(0, at) + bytes + this.buffer.slice(end), bytes.length);
      this.writePosition = end;
    } else if (this.target === 'file') {
      if (!this.file) {
        this.state |= IO_STATE.badbit;
        return;
      }
      this.file.write(this.decoder.decode(byteArray(bytes), { stream: true }));
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

class StreamBaseStorage extends Store {
  readonly length = 1;

  constructor(
    readonly complete: Ptr,
    private readonly stream: StreamValue,
    private readonly offset: number,
    private readonly size: number
  ) {
    super();
  }

  override get containingLocation(): Ptr {
    return this.complete;
  }

  override checkAlive(): void {
    this.complete.target();
  }

  override projectAddress(index: number, byteOffset: number): Ptr['address'] {
    const { store, index: completeIndex } = this.complete.address;
    return { store, index: completeIndex + this.offset + index * this.size + byteOffset };
  }

  get(index: number): Value {
    if (index !== 0) throw new CppRuntimeError('outOfBounds');
    return this.stream;
  }

  set(): void {
    throw new Error('A stream cannot be assigned');
  }
}

/** The streams of `<iostream>` and `<sstream>`, and the manipulators of `<ios>` and `<iomanip>`. */
export class Streams {
  readonly ostream: ClassInfo;
  readonly istream: ClassInfo;
  readonly ostringstream: ClassInfo;
  readonly istringstream: ClassInfo;
  readonly stringstream: ClassInfo;
  readonly ifstream: ClassInfo;
  readonly ofstream: ClassInfo;
  readonly fstream: ClassInfo;
  readonly iosBase: ClassInfo;
  readonly ios: ClassInfo;
  /** A manipulator that both `<<` and `>>` apply. */
  readonly manipulator: ClassInfo;
  /** A manipulator that only `<<` applies, such as `std::endl` or `std::setfill('*')`. */
  readonly outputManipulator: ClassInfo;

  constructor(private readonly library: Library) {
    this.iosBase = this.iosBaseClass();
    this.ios = streamInfo('ios', this.iosBase, {
      isVirtualBase: true,
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
    this.ifstream = this.fileStreamClass('ifstream', this.istream, false, true);
    this.ofstream = this.fileStreamClass('ofstream', this.ostream, true, false);
    this.fstream = this.fileStreamClass('fstream', this.ostream, true, true, [this.istream]);
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
    if (kind === 'istream') addInputMembers(cls);
    if (kind === 'ostream' || kind === 'istream') cls.isDefaultConstructorDeleted = true;
    else {
      const defaultMode = (isInput ? OPEN_MODE.in : 0) | (isOutput ? OPEN_MODE.out : 0);
      const requiredMode = isInput && isOutput ? 0 : defaultMode;
      const make = (frame: Frame, bytes: string, mode = defaultMode): StreamValue => {
        const stream = new StreamValue(kind, 'buffer', mode | requiredMode);
        stream.resetBuffer(frame, bytes);
        return stream;
      };
      cls.constructors = [
        nativeConstructor(cls, [], (_args, { frame }) => make(frame, '')),
        nativeConstructor(cls, [UINT], ([mode], { frame }) => make(frame, '', asNumber(mode)), { isExplicit: true }),
        nativeConstructor(
          cls,
          [constRef(this.library.stringType), UINT],
          ([text, mode], { frame }) =>
            make(frame, ((text as Ptr).read() as StringValue).bytes, mode === undefined ? defaultMode : asNumber(mode)),
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
        native('str', [constRef(this.library.stringType)], VOID, ([text], { self, frame }) => {
          (self as StreamValue).resetBuffer(frame, ((text as Ptr).read() as StringValue).bytes);
          return;
        })
      );
    }
    if (isOutput) this.addOutputMembers(cls);
    return cls;
  }

  /**
   * `std::ifstream`, `std::ofstream`, or `std::fstream` of `<fstream>`, which reads and writes a file of the run's
   * file system.
   */
  private fileStreamClass(
    kind: 'ifstream' | 'ofstream' | 'fstream',
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
      destroy: (_frame, value) => {
        const stream = value as StreamValue;
        if (stream.isOpen) stream.closeFile();
      },
    };
    const defaultMode = (isInput ? OPEN_MODE.in : 0) | (isOutput ? OPEN_MODE.out : 0);
    const requiredMode = kind === 'fstream' ? 0 : defaultMode;
    const open = (stream: StreamValue, frame: Frame, path: string, mode: unknown): void =>
      stream.openFile(frame, path, (mode === undefined ? defaultMode : asNumber(mode)) | requiredMode);
    const make = (frame: Frame, path?: string, mode?: unknown): StreamValue => {
      const stream = new StreamValue(kind, 'file', defaultMode);
      if (path !== undefined) open(stream, frame, path, mode);
      return stream;
    };
    const stringRef = constRef(this.library.stringType);
    cls.constructors = [
      nativeConstructor(cls, [], (_args, { frame }) => make(frame)),
      nativeConstructor(
        cls,
        [CONST_CHAR_PTR, UINT],
        ([path, mode], { frame }) => make(frame, pathOf(path, frame), mode),
        {
          isExplicit: true,
          optional: 1,
        }
      ),
      nativeConstructor(cls, [stringRef, UINT], ([path, mode], { frame }) => make(frame, stringPath(path), mode), {
        isExplicit: true,
        optional: 1,
      }),
    ];
    const method = bindStreamMethods(cls);
    method(
      'open',
      [CONST_CHAR_PTR, UINT],
      VOID,
      (stream, [path, mode], frame) => open(stream, frame, pathOf(path, frame), mode),
      { optional: 1 }
    );
    method(
      'open',
      [stringRef, UINT],
      VOID,
      (stream, [path, mode], frame) => open(stream, frame, stringPath(path), mode),
      { optional: 1 }
    );
    method('is_open', [], BOOL, (stream) => (stream.isOpen ? 1 : 0), { isConst: true });
    method('close', [], VOID, (stream) => {
      stream.closeFile();
    });
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
    const ostream = this.ostream ?? cls;
    const result = referenceTo(classType(ostream));
    const output = (
      name: string,
      params: Type[],
      run: (stream: StreamValue, args: unknown[], frame: Frame) => void
    ): void => {
      addMethod(
        cls,
        native(name, params, result, (args, { self: object, selfLocation, frame }) => {
          run(self(object), args, frame);
          return selfLocation?.forClass(ostream);
        })
      );
    };
    output('put', [CHAR], (stream, [char], frame) => {
      stream.write(frame, String.fromCodePoint(asNumber(char) & 0xff));
    });
    output('write', [CONST_CHAR_PTR, LONG], (stream, [pointer, count], frame) => {
      if (!stream.isGood) return;
      const start = pointer as Ptr;
      let bytes = '';
      for (let index = 0; index < Number(count); index++) {
        if (index % 64 === 0) frame.runtime.spend();
        bytes += String.fromCodePoint(asNumber(start.offset(index).read()) & 0xff);
      }
      stream.write(frame, bytes);
    });
    output('flush', [], () => {});
  }

  manipulatorType(isOutputOnly: boolean): Type {
    return classType(isOutputOnly ? this.outputManipulator : this.manipulator);
  }

  /** Compiles `<<` and `>>` of streams, and a stream used as a condition. */
  // code-gauge-allow functionCognitiveComplexity -- The stream operators dispatch on what they read or write.
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
    if (operator === '<<' && isOutput) {
      // C++20 deletes the insertions of the other character types and their strings into a narrow stream.
      const value =
        right.type.kind === 'array' ? right.type.of : right.type.kind === 'pointer' ? right.type.to : right.type;
      if (value.kind === 'int' && value.character)
        return compiler.error(
          row,
          `C++20 では、${typeName(right.type)} の値は ${typeName(left.type)} に << で出力できません。`
        );
      const named = this.namedManipulator(compiler, left, right, row, true);
      return named ?? this.streamResult(left, this.insertion(compiler, left, right, row), this.ostream);
    }
    if (operator === '>>' && isInput) {
      const named = this.namedManipulator(compiler, left, right, row, false);
      if (named) return named;
      const isManipulator = right.type.kind === 'class' && right.type.cls === this.manipulator;
      const result = isManipulator
        ? this.applyTo(compiler, left, right, row)
        : this.extraction(compiler, left, right, row);
      return this.streamResult(left, result, this.istream);
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
    const object = { ...compiler.materialize(stream), isXvalue: false };
    const resolved = compiler.resolve(candidate.displayName, [candidate], [object], undefined, row);
    return this.streamResult(
      stream,
      compiler.callExpr(resolved, [object], undefined, row),
      output ? this.ostream : this.istream,
      candidate.streamManipulator === 'both'
    );
  }

  private streamResult(stream: Expr, result: Expr, base: ClassInfo, allowsForwarding = true): Expr {
    const isXvalue = allowsForwarding && (!stream.isLvalue || stream.isXvalue === true);
    const cls = isXvalue && stream.type.kind === 'class' ? stream.type.cls : base;
    return {
      ...result,
      type: classType(cls),
      isLvalue: true,
      isXvalue,
      run: (frame) => (result.run(frame) as Ptr).forClass(cls),
    };
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
  // code-gauge-allow functionCognitiveComplexity -- One case per kind of value a stream writes.
  private writer(compiler: ExpressionCompiler, right: Expr, row: number): (frame: Frame, stream: StreamValue) => void {
    if (right.functions)
      return compiler.error(row, `関数 ${right.functions.name} の後に (...) を書いて呼び出してください。`);
    const type = right.type;
    if (type.kind === 'class' && [this.manipulator, this.outputManipulator].includes(type.cls)) {
      const run = compiler.rvalue(right).run;
      return (frame, stream) => (run(frame) as ManipulatorValue).apply(stream, frame);
    }
    if (type.kind === 'class' && type.cls === this.library.stringClass) {
      // A temporary string lives until the end of the full expression, as the reference parameter binding it does.
      const run = compiler.materialize(right).run;
      return (frame, stream) => stream.writeField(frame, ((run(frame) as Ptr).read() as StringValue).bytes);
    }
    const value = scalarValue(compiler, right);
    const run = value.run;
    const valueType = value.type;
    if (valueType.kind === 'void') return compiler.error(row, '値を返さない関数（void）の結果は表示できません。');
    if (valueType.kind === 'int' && valueType.enumeration?.isScoped)
      return compiler.error(row, `演算子 << は std::ostream と ${typeName(type)} には使えません。`);
    if (valueType.kind === 'int') {
      if (isCharType(valueType) && !valueType.enumeration) {
        return (frame, stream) => stream.writeField(frame, String.fromCodePoint(asNumber(run(frame)) & 0xff));
      }
      if (valueType.name === 'bool') return (frame, stream) => writeBool(frame, stream, asNumber(run(frame)) !== 0);
      const isSigned = !['uint', 'ulong', 'ullong', 'ushort', 'uchar'].includes(valueType.name);
      const bits = INTEGER_BITS[valueType.name] ?? 32;
      return (frame, stream) => writeInteger(frame, stream, BigInt(run(frame) as number | bigint), isSigned, bits);
    }
    if (valueType.kind === 'float') return (frame, stream) => writeFloat(frame, stream, Number(run(frame)));
    if (valueType.kind === 'nullptr') {
      return (frame, stream) => {
        run(frame);
        stream.writeField(frame, 'nullptr');
      };
    }
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
    if (type.kind === 'int' && type.enumeration)
      return compiler.error(row, `演算子 >> は ${typeName(left.type)} と ${typeName(type)} には使えません。`);
    let read: (stream: StreamValue, frame: Frame) => Value | undefined;
    if (type.kind === 'class' && type.cls === this.library.stringClass) {
      return this.extractWith(compiler, left, right, row, (stream, target, frame) => {
        (target.read() as StringValue).replaceBytes(frame, readWord(stream, frame));
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
      read = (stream, frame) => readInteger(stream, frame, type.name);
    } else if (type.kind === 'float') {
      read = (stream, frame) => readFloat(stream, frame, type.name === 'float');
    } else {
      return compiler.error(row, `演算子 >> は ${typeName(left.type)} と ${typeName(type)} には使えません。`);
    }
    return this.extractWith(compiler, left, right, row, (stream, target, frame) => {
      const value = read(stream, frame);
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
          if (inputSentry(stream, frame)) extract(stream, destination as Ptr, frame);
          return place;
        }),
    };
  }

  /** `std::getline(stream, s)` and `std::getline(stream, s, delimiter)`. */
  getline(): ReturnType<typeof native>[] {
    const stringRef: Type = { kind: 'reference', to: this.library.stringType };
    const input = new Set([this.istream, this.istringstream, this.stringstream, this.ifstream, this.fstream]);
    return [
      generic('getline', (args) => {
        const stream = args[0];
        const type = stream?.type;
        if (type?.kind !== 'class' || isConstType(type) || !input.has(type.cls)) return;
        // libc++'s `getline` takes and returns `basic_istream&` (or binds a temporary stream with `&&`).
        const base = classType(this.istream);
        const parameter = stream.isLvalue ? referenceTo(base) : constRef(base);
        return native('getline', [parameter, stringRef, CHAR], referenceTo(base), readLine, { optional: 1 });
      }),
    ];
  }
}

function streamInfo(
  kind: keyof typeof STREAM_SIZES,
  base?: ClassInfo,
  members?: Pick<LibraryClass, 'operator' | 'additionalPublicBases' | 'isVirtualBase'>
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

/** The end of the input that unformatted input functions return as an `int` (`EOF`). */
const END_OF_INPUT = -1;
/** `std::numeric_limits<std::streamsize>::max()`, the count `ignore` takes for no limit. */
const UNLIMITED = (1n << 63n) - 1n;

/**
 * The unformatted input functions of `std::istream` (C++20 [istream.unformatted]), whose `sentry` does not skip
 * whitespace.
 */
function addInputMembers(cls: ClassInfo): void {
  const istream = referenceTo(classType(cls));
  const charPointer = pointerTo(CHAR);
  const input = (
    name: string,
    params: Type[],
    ret: Type | 'self',
    run: (stream: StreamValue, args: unknown[], frame: Frame) => unknown,
    options: { optional?: number; isConst?: boolean } = {}
  ): void => {
    addMethod(
      cls,
      native(
        name,
        params,
        ret === 'self' ? istream : ret,
        (args, { self: object, selfLocation, frame }) => {
          const result = run(self(object), args, frame);
          return ret === 'self' ? selfLocation?.forClass(cls) : result;
        },
        options
      )
    );
  };
  input('get', [], INT, (stream) => (unformattedSentry(stream) ? (takeByte(stream) ?? fail(stream)) : END_OF_INPUT));
  input('get', [referenceTo(CHAR)], 'self', (stream, [target]) => {
    if (!unformattedSentry(stream)) return;
    const byte = takeByte(stream);
    if (byte === undefined) stream.state |= IO_STATE.failbit;
    else (target as Ptr).write(signedChar(byte));
  });
  input('get', [charPointer, LONG, CHAR], 'self', (stream, args, frame) => readInto(stream, args, frame, false), {
    optional: 1,
  });
  input('getline', [charPointer, LONG, CHAR], 'self', (stream, args, frame) => readInto(stream, args, frame, true), {
    optional: 1,
  });
  input('peek', [], INT, (stream) => {
    if (!unformattedSentry(stream)) return END_OF_INPUT;
    if (stream.position < stream.buffer.length) return byteAt(stream.buffer, stream.position);
    stream.state |= IO_STATE.eofbit;
    return END_OF_INPUT;
  });
  input(
    'ignore',
    [LONG, INT],
    'self',
    (stream, [count, delimiter], frame) => {
      if (!unformattedSentry(stream)) return;
      const limit = count === undefined ? 1n : BigInt(count as bigint);
      const separator = delimiter === undefined ? END_OF_INPUT : asNumber(delimiter);
      while (limit === UNLIMITED || BigInt(stream.extracted) < limit) {
        if (stream.extracted % 64 === 0) frame.runtime.spend();
        const byte = takeByte(stream);
        if (byte === undefined || byte === separator) break;
      }
    },
    { optional: 2 }
  );
  input('read', [charPointer, LONG], 'self', (stream, [pointer, count], frame) => {
    if (!unformattedSentry(stream)) return;
    for (let index = 0; index < Number(count); index++) {
      if (index % 64 === 0) frame.runtime.spend();
      const byte = takeByte(stream);
      if (byte === undefined) {
        stream.state |= IO_STATE.failbit;
        return;
      }
      (pointer as Ptr).offset(index).write(signedChar(byte));
    }
  });
  input('unget', [], 'self', stepBack);
  input('putback', [CHAR], 'self', stepBack);
  input('gcount', [], LONG, (stream) => BigInt(stream.extracted), { isConst: true });
  input('tellg', [], LONG, (stream, _args, frame) =>
    stream.failed || !seeks(stream, frame) ? -1n : BigInt(stream.position)
  );
  input('seekg', [LONG], 'self', (stream, [position], frame) => {
    stream.state &= ~IO_STATE.eofbit;
    if (stream.failed) return;
    if (!seeks(stream, frame)) {
      stream.state |= IO_STATE.failbit;
      return;
    }
    const target = Number(position);
    if (target < 0 || target > stream.buffer.length) stream.state |= IO_STATE.failbit;
    else stream.position = target;
  });
}

/** Whether an unformatted input may read the stream, setting `failbit` when it may not. */
function unformattedSentry(stream: StreamValue): boolean {
  stream.extracted = 0;
  if (stream.isGood && stream.mode & OPEN_MODE.in) return true;
  stream.state |= IO_STATE.failbit;
  return false;
}

function takeByte(stream: StreamValue): number | undefined {
  if (stream.position >= stream.buffer.length) {
    stream.state |= IO_STATE.eofbit;
    return undefined;
  }
  stream.extracted++;
  return byteAt(stream.buffer, stream.position++);
}

/** Reads characters into an array until the delimiter, which `getline` extracts and `get` leaves. */
function readInto(stream: StreamValue, args: unknown[], frame: Frame, extractsDelimiter: boolean): void {
  const [pointer, count, delimiter] = args;
  const target = pointer as Ptr;
  const limit = Number(count);
  const separator = delimiter === undefined ? 10 : asNumber(delimiter) & 0xff;
  let written = 0;
  let isFull = false;
  if (unformattedSentry(stream)) {
    for (;;) {
      if (written % 64 === 0) frame.runtime.spend();
      if (stream.position >= stream.buffer.length) {
        stream.state |= IO_STATE.eofbit;
        break;
      }
      const byte = byteAt(stream.buffer, stream.position);
      if (byte === separator) {
        if (extractsDelimiter) {
          stream.position++;
          stream.extracted++;
        }
        break;
      }
      if (written >= limit - 1) {
        isFull = true;
        break;
      }
      target.offset(written).write(signedChar(byte));
      written++;
      stream.position++;
      stream.extracted++;
    }
  }
  if (limit > 0) target.offset(written).write(0);
  if (stream.extracted === 0 || (extractsDelimiter && isFull)) stream.state |= IO_STATE.failbit;
}

function stepBack(stream: StreamValue): void {
  stream.state &= ~IO_STATE.eofbit;
  if (!unformattedSentry(stream)) return;
  if (stream.position > 0) stream.position--;
  else stream.state |= IO_STATE.badbit;
}

/** Whether a stream can seek, which libc++'s standard input cannot, wherever it comes from. */
function seeks(stream: StreamValue, frame: Frame): boolean {
  return stream !== frame.runtime.standardInput();
}

function fail(stream: StreamValue): number {
  stream.state |= IO_STATE.failbit;
  return END_OF_INPUT;
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
  frame.runtime.spend(Math.ceil(((end === -1 ? source.buffer.length : end + 1) - source.position) / 64));
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

/** A file's path as the program wrote it in UTF-8 bytes. */
function decodeBytes(bytes: string): string {
  return new TextDecoder().decode(byteArray(bytes));
}

function pathOf(path: unknown, frame: Frame): string {
  return decodeBytes(readCString(path as Ptr, frame.runtime));
}

function stringPath(path: unknown): string {
  return decodeBytes(((path as Ptr).read() as StringValue).bytes);
}

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

function chargeInput(frame: Frame, offset: number): void {
  if (offset % 64 === 0) frame.runtime.spend();
}

/** `std::ws`, which skips whitespace, reaching the end of the text without failing (C++20 [istream.manip]). */
export function skipWhitespace(stream: StreamValue, frame: Frame): void {
  if (!stream.isGood || !(stream.mode & OPEN_MODE.in)) {
    stream.state |= IO_STATE.failbit;
    return;
  }
  const start = stream.position;
  while (stream.position < stream.buffer.length && isSpaceByte(byteAt(stream.buffer, stream.position))) {
    chargeInput(frame, stream.position - start);
    stream.position++;
  }
  if (stream.position >= stream.buffer.length) stream.state |= IO_STATE.eofbit;
}

/** The input `sentry`: fails unless the stream is good, then skips whitespace, failing at the end of the text. */
function inputSentry(stream: StreamValue, frame: Frame): boolean {
  if (!stream.isGood || !(stream.mode & OPEN_MODE.in)) {
    stream.state |= IO_STATE.failbit;
    return false;
  }
  if (stream.flags & FLAGS.skipws) {
    const start = stream.position;
    while (stream.position < stream.buffer.length) {
      chargeInput(frame, stream.position - start);
      if (!isSpaceByte(byteAt(stream.buffer, stream.position))) break;
      stream.position++;
    }
    if (stream.position >= stream.buffer.length) {
      stream.state |= IO_STATE.failbit | IO_STATE.eofbit;
      return false;
    }
  }
  return true;
}

/** Reads up to the next whitespace, or as many characters as the width allows, which it then resets. */
function readWord(stream: StreamValue, frame: Frame): string {
  const limit = stream.width > 0 ? stream.width : Number.POSITIVE_INFINITY;
  stream.width = 0;
  const start = stream.position;
  while (stream.position - start < limit) {
    if (stream.position >= stream.buffer.length) {
      stream.state |= IO_STATE.eofbit;
      break;
    }
    chargeInput(frame, stream.position - start);
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
 * Reads an integer as libc++'s `num_get::__do_get_integral` does in one pass: after a sign, it detects the base from a
 * `0` or `0x` prefix when no base flag is set (and swallows a `0x` in hex), then accumulates the digits of that base;
 * no digit fails storing 0, and a value out of range fails storing the nearest limit, though an unsigned type wraps a
 * negated value.
 */
function readInteger(stream: StreamValue, frame: Frame, name: string): Value {
  const [min, max] = INTEGER_RANGES[name] ?? INTEGER_RANGES.int;
  const value = scanInteger(stream, frame, min, max);
  return ['long', 'ulong', 'llong', 'ullong'].includes(name) ? value : Number(value);
}

function scanInteger(stream: StreamValue, frame: Frame, min: bigint, max: bigint): bigint {
  const atEnd = (): boolean => stream.position >= stream.buffer.length;
  if (atEnd()) return stopScan(stream, IO_STATE.eofbit | IO_STATE.failbit, 0n);
  const isNegated = stream.buffer[stream.position] === '-';
  if (isNegated || stream.buffer[stream.position] === '+') stream.position++;
  if (atEnd()) return stopScan(stream, IO_STATE.eofbit | IO_STATE.failbit, 0n);
  const prefix = scanBasePrefix(stream, numberBase(stream.flags));
  if (!prefix) return stopScan(stream, IO_STATE.eofbit, 0n);
  const isUnsigned = min === 0n;
  const digits = accumulateDigits(stream, frame, prefix.base, isUnsigned ? max : max * 2n + 1n);
  const end = atEnd() ? IO_STATE.eofbit : IO_STATE.goodbit;
  if (!prefix.hasDigit && !digits.hasDigit) return stopScan(stream, end | IO_STATE.failbit, 0n);
  if (digits.overflowed) return stopScan(stream, end | IO_STATE.failbit, !isUnsigned && isNegated ? min : max);
  const { magnitude } = digits;
  if (!isNegated)
    return magnitude > max ? stopScan(stream, end | IO_STATE.failbit, max) : stopScan(stream, end, magnitude);
  if (isUnsigned) return stopScan(stream, end, BigInt.asUintN(max.toString(2).length, -magnitude));
  return magnitude > -min ? stopScan(stream, end | IO_STATE.failbit, min) : stopScan(stream, end, -magnitude);
}

function stopScan(stream: StreamValue, state: number, value: bigint): bigint {
  stream.state |= state;
  return value;
}

/**
 * Consumes a `0` or `0x` prefix when no base flag is set (detecting the base) or in hex, giving the base and whether
 * the `0` already counts as a digit, or undefined when the input ends after that `0`.
 */
function scanBasePrefix(stream: StreamValue, base: number): { base: number; hasDigit: boolean } | undefined {
  if ((base !== 0 && base !== 16) || stream.buffer[stream.position] !== '0')
    return { base: base || 10, hasDigit: false };
  stream.position++;
  if (stream.position >= stream.buffer.length) return;
  const next = stream.buffer[stream.position];
  if (next !== 'x' && next !== 'X') return { base: base || 8, hasDigit: true };
  stream.position++;
  return { base: 16, hasDigit: false };
}

/** Accumulates the digits of a base, noting a magnitude above `limit` (the unsigned range of the target type). */
function accumulateDigits(
  stream: StreamValue,
  frame: Frame,
  base: number,
  limit: bigint
): { magnitude: bigint; overflowed: boolean; hasDigit: boolean } {
  const start = stream.position;
  let magnitude = 0n;
  let overflowed = false;
  for (; stream.position < stream.buffer.length; stream.position++) {
    chargeInput(frame, stream.position - start);
    let digit = INTEGER_ATOMS.indexOf(stream.buffer[stream.position]);
    if (digit === -1 || digit >= 22) break;
    if (base === 16 && digit >= 16) digit -= 6;
    if (digit >= base) break;
    magnitude = magnitude * BigInt(base) + BigInt(digit);
    if (magnitude > limit) {
      overflowed = true;
      magnitude &= limit;
    }
  }
  return { magnitude, overflowed, hasDigit: stream.position > start };
}

/** `ios_base::basefield` as `num_get` reads it: 0 (no base flag) takes the base from the number's prefix. */
function numberBase(flags: number): number {
  const field = flags & FLAGS.basefield;
  if (field === FLAGS.oct) return 8;
  if (field === FLAGS.hex) return 16;
  return field === 0 ? 0 : 10;
}

/** Reads a `bool` as `num_get` does: a `long` that must be 0 or 1, or with `boolalpha` the word `true` or `false`. */
function readBool(stream: StreamValue, frame: Frame): Value {
  if (stream.flags & FLAGS.boolalpha) {
    const index = scanKeyword(stream, frame, ['true', 'false']);
    if (index === -1) stream.state |= IO_STATE.failbit;
    return index === 0 ? 1 : 0;
  }
  const value = readInteger(stream, frame, 'long') as bigint;
  if (value === 0n || value === 1n) return Number(value);
  // libc++ replaces the state with failbit alone, dropping an eofbit the number set.
  stream.state = IO_STATE.failbit;
  return 1;
}

/** libc++'s `__scan_keyword`: consumes characters while they may still spell a keyword, returning the one spelled. */
function scanKeyword(stream: StreamValue, frame: Frame, keywords: string[]): number {
  const status = keywords.map(() => 'mightMatch');
  for (let index = 0; stream.position < stream.buffer.length && status.includes('mightMatch'); index++) {
    chargeInput(frame, index);
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
function readFloat(stream: StreamValue, frame: Frame, isFloat: boolean): number {
  const text = gatherFloat(stream, frame);
  frame.runtime.spend(Math.ceil(text.length / 64));
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
function gatherFloat(stream: StreamValue, frame: Frame): string {
  let text = '';
  const scan: FloatScan = { inUnits: true, exponent: 'E' };
  let isLeadingParsed = false;
  const start = stream.position;
  for (; stream.position < stream.buffer.length; stream.position++) {
    chargeInput(frame, stream.position - start);
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
