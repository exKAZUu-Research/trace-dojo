import { convertScalar, type Scalar } from '../../c/arith';
import { isFloatUnderflow, isSpaceByte, parseFloatPrefix, parseIntegerPrefix } from '../../c/library/numberParsing';
import { LIMITS } from '../../interpreter/limits';
import { byteArray, byteAt } from '../bytes';
import { scalarValue } from '../conversions';
import { CppRuntimeError } from '../errors';
import { type Expr, type Initializer, initializerWithConstancy, type LibraryConstant } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { type Eval, type Frame, holdAll } from '../runtime';
import type { Syntax } from '../syntax';
import {
  type ArithmeticType,
  BOOL,
  CHAR,
  ClassInfo,
  classType,
  DOUBLE,
  FLOAT,
  INT,
  isArithmetic,
  isCharType,
  isConstType,
  LDOUBLE,
  LLONG,
  LONG,
  pointerTo,
  SIZE_T,
  type Type,
  typeName,
  UINT,
  ULLONG,
  ULONG,
  unqualified,
  VOID,
  withConst,
} from '../types';
import { endLifetime, NULL_PTR, Ptr, Store, type Value } from '../values';
import { formatFloat } from './formatting';
import { randomAccessIterator } from './iterators';
import type { Library } from './registry';
import {
  addMethod,
  asNumber,
  checkByteWrite,
  CONST_CHAR_PTR,
  constRef,
  native,
  nativeConstructor,
  readCString,
  rejectOverlappingBytes,
  signedChar,
  throwLibrary,
} from './support';
import { typeKey } from './templates';

/** The capacity of libc++'s short string, which keeps its characters in the object. */
const SHORT_CAPACITY = 22;

/** The value of a `std::string`: its bytes, as a string of character codes below 256. */
export class StringValue extends Store {
  private room: number;
  private stored: string;
  private buffer?: StringBuffer;
  private objectLocation?: Ptr;

  constructor(bytes: string) {
    super();
    checkStringLength(bytes.length);
    this.stored = bytes;
    this.room = fittingCapacity(bytes.length);
  }

  get capacity(): number {
    return this.room;
  }

  set capacity(capacity: number) {
    if (capacity === this.room) return;
    this.invalidateBuffer();
    this.room = capacity;
  }

  get bytes(): string {
    return this.stored;
  }

  /** Replaces the bytes, growing the capacity to at least twice the old one when they do not fit, as libc++ does. */
  set bytes(bytes: string) {
    checkStringLength(bytes.length);
    if (bytes.length > this.capacity) this.capacity = fittingCapacity(Math.max(bytes.length, 2 * this.capacity));
    this.stored = bytes;
  }

  /** Takes the bytes and the buffer of another string, as the move constructor and assignment do. */
  moveFrom(source: StringValue): void {
    if (source === this) return;
    this.invalidateBuffer();
    this.stored = source.stored;
    this.room = source.room;
    if (source.room > SHORT_CAPACITY) {
      this.buffer = source.buffer;
      if (this.buffer) this.buffer.owner = this;
      source.buffer = undefined;
    } else {
      source.invalidateBuffer();
    }
    source.stored = '';
    source.room = SHORT_CAPACITY;
  }

  characterBuffer(): Store {
    return (this.buffer ??= new StringBuffer(this));
  }

  bindLocation(location: Ptr): void {
    this.objectLocation = location;
  }

  override get containingLocation(): Ptr | undefined {
    if (this.capacity <= SHORT_CAPACITY) return this.objectLocation;
  }

  private invalidateBuffer(): void {
    endLifetime(this.buffer);
    this.buffer = undefined;
  }

  children(): Iterable<Value> {
    return this.buffer ? [this.buffer] : [];
  }

  get length(): number {
    return this.bytes.length;
  }

  get(index: number): Value {
    this.checkAlive();
    if (index < 0 || index >= this.bytes.length) throw new CppRuntimeError('outOfBounds');
    return signedChar(byteAt(this.bytes, index));
  }

  set(index: number, value: Value): void {
    this.checkAlive();
    if (index < 0 || index >= this.bytes.length) throw new CppRuntimeError('outOfBounds');
    this.bytes = this.bytes.slice(0, index) + String.fromCodePoint(Number(value) & 0xff) + this.bytes.slice(index + 1);
  }

  /** The text the bytes encode in UTF-8, for the trace. */
  get text(): string {
    return decodeUtf8(this.bytes);
  }
}

class StringBuffer extends Store {
  constructor(public owner: StringValue) {
    super();
  }

  override get containingLocation(): Ptr | undefined {
    return this.owner.containingLocation;
  }

  get length(): number {
    return this.owner.length + 1;
  }

  override get iteratorLength(): number {
    return this.owner.length;
  }

  get(index: number): Value {
    this.checkAlive();
    if (index === this.owner.length) return 0;
    return this.owner.get(index);
  }

  set(index: number, value: Value): void {
    this.checkAlive();
    if (index === this.owner.length && value === 0) return;
    this.owner.set(index, value);
  }
}

export function decodeUtf8(bytes: string): string {
  // oxlint-disable-next-line no-control-regex -- ASCII text decodes to itself.
  if (/^[\u0000-\u007F]*$/.test(bytes)) return bytes;
  return new TextDecoder().decode(byteArray(bytes));
}

const NPOS = 0xff_ff_ff_ff_ff_ff_ff_ffn;
const MAX_SIZE = 0x7f_ff_ff_ff_ff_ff_ff_f6n;
/** The longest string that the interpreter makes, which is far shorter than `max_size()`. */
const MAX_LENGTH = LIMITS.maxStringLength;

/** Reads the bytes of an argument that is a `std::string` (by reference) or a `const char*`. */
function textOf(value: unknown): string {
  if (value instanceof Ptr) {
    const target = value.store instanceof StringValue && value.index === 0 ? value.store : value.read();
    if (target instanceof StringValue) return target.bytes;
    return readCString(value);
  }
  return (value as StringValue).bytes;
}

function charOf(value: unknown): string {
  return String.fromCodePoint(asNumber(value) & 0xff);
}

/** A position argument, as `size_t`; `npos` and other huge values stay huge. */
function position(value: unknown, fallback: bigint): bigint {
  return value === undefined ? fallback : BigInt(value as bigint | number);
}

function clampedLength(value: unknown, available: number): number {
  const length = position(value, NPOS);
  return length > BigInt(available) ? available : Number(length);
}

function found(index: number): bigint {
  return index < 0 ? NPOS : BigInt(index);
}

/** Defines `std::string` and the free functions of `<string>`. */
export function stringClass(library: Library): ClassInfo {
  const cls = new ClassInfo('std::string', 'class');
  cls.isComplete = true;
  const type = classType(cls);
  const ref = constRef(type);
  const outOfRange = (frame: Frame): never => throwLibrary(frame, library.exception('out_of_range'), 'basic_string');
  const lengthError = (frame: Frame): never => throwLibrary(frame, library.exception('length_error'), 'basic_string');
  const iterator = randomAccessIterator(library.iterators, 'std::string', CHAR, false, false);
  const constIterator = randomAccessIterator(library.iterators, 'std::string', CHAR, true, false);
  const reverseIterator = randomAccessIterator(library.iterators, 'std::string', CHAR, false, true);
  const constReverseIterator = randomAccessIterator(library.iterators, 'std::string', CHAR, true, true);
  cls.memberTypes.set('iterator', classType(iterator));
  cls.memberTypes.set('const_iterator', classType(constIterator));
  cls.memberTypes.set('reverse_iterator', classType(reverseIterator));
  cls.memberTypes.set('const_reverse_iterator', classType(constReverseIterator));
  cls.memberTypes.set('size_type', SIZE_T);
  cls.memberTypes.set('value_type', CHAR);
  cls.constants.set('npos', (row) => ({
    type: withConst(SIZE_T),
    isLvalue: false,
    row,
    run: () => NPOS,
    constant: NPOS,
  }));
  cls.library = {
    kind: 'string',
    args: [],
    allowsConstantCopy: true,
    size: 24,
    align: 8,
    operator: (compiler, operator, operands, row) => stringOperator(compiler, cls, operator, operands, row),
    listInitializer: (compiler, elements, row) => charList(compiler, elements, row),
    listElementType: CHAR,
  };
  const substring = (frame: Frame, bytes: string, start: unknown, count: unknown): string => {
    const begin = position(start, 0n);
    if (begin > BigInt(bytes.length)) return outOfRange(frame);
    return bytes.slice(Number(begin), Number(begin) + clampedLength(count, bytes.length - Number(begin)));
  };
  /**
   * A count of characters a call asks for, besides `kept` characters it keeps, which throws `std::length_error` when
   * the string would exceed `max_size()`, as libc++ does.
   */
  const requestedLength = (frame: Frame, count: unknown, kept = 0): number => {
    const length = BigInt(count as bigint);
    if (length > MAX_SIZE - BigInt(kept)) return lengthError(frame);
    if (length > MAX_LENGTH) throw new CppRuntimeError('custom', '文字列が長すぎます。');
    return Number(length);
  };
  const repeated = (frame: Frame, count: unknown, char: unknown, kept = 0): string =>
    checkLength(frame, charOf(char).repeat(requestedLength(frame, count, kept)));
  cls.constructors = [
    nativeConstructor(cls, [], () => make(''), { libraryConstant: () => ({ stringLength: 0 }) }),
    nativeConstructor(cls, [CONST_CHAR_PTR], ([pointer]) => make(readCString(pointer as Ptr)), {
      libraryConstant: ([source]) => shortString(literalStringLength(source?.literalBytes)),
    }),
    nativeConstructor(cls, [SIZE_T, CHAR], ([count, char], { frame }) => make(repeated(frame, count, char)), {
      libraryConstant: ([count]) => shortString(count?.constant),
    }),
    nativeConstructor(
      cls,
      [ref, SIZE_T, SIZE_T],
      ([source, start, count], { frame }) => make(substring(frame, textOf(source), start, count)),
      { optional: 1 }
    ),
    nativeConstructor(cls, [CONST_CHAR_PTR, SIZE_T], ([pointer, count]) => make(pointerBytes(pointer as Ptr, count)), {
      libraryConstant: ([source, count]) => {
        if (source?.literalBytes !== undefined && Number(count?.constant) <= source.literalBytes.length + 1)
          return shortString(count?.constant);
      },
    }),
    {
      ...nativeConstructor(cls, [], () => {}),
      instantiate: (args) => {
        const iterator = args.length === 2 ? inputIterator(args, 0) : undefined;
        if (!iterator) return;
        return {
          ...nativeConstructor(cls, [iterator.type, iterator.type], ([first, last], { frame }) =>
            make(rangeBytes(frame, first as Ptr, last as Ptr, iterator))
          ),
          isTemplate: true,
        };
      },
      isTemplate: true,
    },
  ];
  cls.operations = {
    copy: (_frame, source) => make((source as StringValue).bytes),
    assign: (_frame, target, source) => {
      (target as StringValue).bytes = (source as StringValue).bytes;
    },
  };
  const method = (
    name: string,
    params: Type[],
    ret: Type,
    run: (self: StringValue, args: unknown[], frame: Frame) => unknown,
    options: { isConst?: boolean; optional?: number } = {}
  ): void => {
    addMethod(
      cls,
      native(
        name,
        params,
        ret,
        (args, { self, selfLocation, frame }) => {
          const result = run(self as StringValue, args, frame);
          return ret.kind === 'reference' && result === self ? selfLocation : result;
        },
        options
      )
    );
  };
  /** A member function template that takes an input iterator range after `params`, such as `append(first, last)`. */
  const rangeMethod = (
    name: string,
    params: Type[],
    ret: Type,
    run: (s: StringValue, args: unknown[], bytes: string, frame: Frame) => unknown
  ): void => {
    addMethod(cls, {
      ...native(name, [], VOID, () => {}),
      instantiate: (args) => {
        const iterator = args.length === params.length + 2 ? inputIterator(args, params.length) : undefined;
        if (!iterator) return;
        const fn = native(
          name,
          [...params, iterator.type, iterator.type],
          ret,
          (callArgs, { self, selfLocation, frame }) => {
            const [first, last] = callArgs.slice(params.length) as Ptr[];
            const result = run(self as StringValue, callArgs, rangeBytes(frame, first, last, iterator), frame);
            return ret.kind === 'reference' && result === self ? selfLocation : result;
          },
          { owner: cls }
        );
        return { ...fn, isTemplate: true };
      },
      isTemplate: true,
    });
  };
  for (const name of ['size', 'length']) method(name, [], SIZE_T, (s) => BigInt(s.bytes.length), { isConst: true });
  method('max_size', [], SIZE_T, () => MAX_SIZE, { isConst: true });
  method('capacity', [], SIZE_T, (s) => BigInt(s.capacity), { isConst: true });
  method('reserve', [SIZE_T], VOID, (s, [count], frame) => {
    const length = requestedLength(frame, count);
    if (length > s.capacity) s.capacity = fittingCapacity(length);
  });
  method('shrink_to_fit', [], VOID, (s) => {
    s.capacity = fittingCapacity(s.bytes.length);
  });
  method('empty', [], BOOL, (s) => (s.bytes.length === 0 ? 1 : 0), { isConst: true });
  method('clear', [], VOID, (s) => {
    s.bytes = '';
  });
  const element = (s: StringValue, index: unknown, frame: Frame, checked: boolean): Ptr => {
    const at = BigInt(index as bigint);
    if (at >= BigInt(s.bytes.length)) {
      if (checked) return outOfRange(frame);
      if (at === BigInt(s.bytes.length)) return new Ptr(s.characterBuffer(), Number(at));
      throw new CppRuntimeError('outOfBounds');
    }
    return new Ptr(s.characterBuffer(), Number(at));
  };
  for (const isConst of [false, true]) {
    const charRef = { kind: 'reference', to: isConst ? withConst(CHAR) : CHAR } as Type;
    method('at', [SIZE_T], charRef, (s, [index], frame) => element(s, index, frame, true), { isConst });
    method(
      'front',
      [],
      charRef,
      (s) => {
        if (s.bytes.length === 0) throw new CppRuntimeError('emptyContainer');
        return new Ptr(s.characterBuffer(), 0);
      },
      { isConst }
    );
    method(
      'back',
      [],
      charRef,
      (s) => {
        if (s.bytes.length === 0) throw new CppRuntimeError('emptyContainer');
        return new Ptr(s.characterBuffer(), s.bytes.length - 1);
      },
      { isConst }
    );
    method('begin', [], classType(isConst ? constIterator : iterator), (s) => s.characterBuffer().location(0), {
      isConst,
    });
    method(
      'end',
      [],
      classType(isConst ? constIterator : iterator),
      (s) => s.characterBuffer().location(s.bytes.length),
      { isConst }
    );
    method(
      'rbegin',
      [],
      classType(isConst ? constReverseIterator : reverseIterator),
      (s) => s.characterBuffer().location(s.bytes.length),
      { isConst }
    );
    method(
      'rend',
      [],
      classType(isConst ? constReverseIterator : reverseIterator),
      (s) => s.characterBuffer().location(0),
      { isConst }
    );
  }
  method('cbegin', [], classType(constIterator), (s) => s.characterBuffer().location(0), { isConst: true });
  method('cend', [], classType(constIterator), (s) => s.characterBuffer().location(s.bytes.length), { isConst: true });
  method('crbegin', [], classType(constReverseIterator), (s) => s.characterBuffer().location(s.bytes.length), {
    isConst: true,
  });
  method('crend', [], classType(constReverseIterator), (s) => s.characterBuffer().location(0), { isConst: true });
  method('push_back', [CHAR], VOID, (s, [char], frame) => {
    s.bytes = checkLength(frame, s.bytes + charOf(char));
  });
  method('pop_back', [], VOID, (s) => {
    if (s.bytes.length === 0) throw new CppRuntimeError('emptyContainer');
    s.bytes = s.bytes.slice(0, -1);
  });
  method(
    'substr',
    [SIZE_T, SIZE_T],
    type,
    (s, [start, count], frame) => make(substring(frame, s.bytes, start, count)),
    { isConst: true, optional: 2 }
  );
  const search = (
    name: string,
    find: (bytes: string, needle: string, start: bigint, frame: Frame) => number,
    defaultStart: bigint
  ): void => {
    for (const needleType of [ref, CONST_CHAR_PTR]) {
      method(
        name,
        [needleType, SIZE_T],
        SIZE_T,
        (s, [needle, start], frame) => found(find(s.bytes, textOf(needle), position(start, defaultStart), frame)),
        { isConst: true, optional: 1 }
      );
    }
    method(
      name,
      [CHAR, SIZE_T],
      SIZE_T,
      (s, [char, start], frame) => found(find(s.bytes, charOf(char), position(start, defaultStart), frame)),
      { isConst: true, optional: 1 }
    );
    method(
      name,
      [CONST_CHAR_PTR, SIZE_T, SIZE_T],
      SIZE_T,
      (s, [needle, start, count], frame) => {
        const bytes = pointerBytes(needle as Ptr, count);
        return found(find(s.bytes, bytes, position(start, defaultStart), frame));
      },
      { isConst: true }
    );
  };
  search(
    'find',
    (bytes, needle, start) => (start > BigInt(bytes.length) ? -1 : bytes.indexOf(needle, Number(start))),
    0n
  );
  search(
    'rfind',
    (bytes, needle, start) => {
      const from = start > BigInt(bytes.length) ? bytes.length : Number(start);
      return bytes.lastIndexOf(needle, from);
    },
    NPOS
  );
  search('find_first_of', searchCharacterSet(false, true), 0n);
  search('find_first_not_of', searchCharacterSet(false, false), 0n);
  search('find_last_of', searchCharacterSet(true, true), NPOS);
  search('find_last_not_of', searchCharacterSet(true, false), NPOS);
  const compareMethod = (params: Type[], run: (s: StringValue, args: unknown[], frame: Frame) => number): void =>
    method('compare', params, INT, run, { isConst: true });
  for (const otherType of [ref, CONST_CHAR_PTR]) {
    compareMethod([otherType], (s, [other]) => compareBytes(s.bytes, textOf(other)));
    compareMethod([SIZE_T, SIZE_T, otherType], (s, [start, count, other], frame) =>
      compareBytes(substring(frame, s.bytes, start, count), textOf(other))
    );
    method('starts_with', [otherType], BOOL, (s, [other]) => (s.bytes.startsWith(textOf(other)) ? 1 : 0), {
      isConst: true,
    });
    method('ends_with', [otherType], BOOL, (s, [other]) => (s.bytes.endsWith(textOf(other)) ? 1 : 0), {
      isConst: true,
    });
  }
  compareMethod([SIZE_T, SIZE_T, CONST_CHAR_PTR, SIZE_T], (s, [start, count, other, n], frame) =>
    compareBytes(substring(frame, s.bytes, start, count), pointerBytes(other as Ptr, n))
  );
  method(
    'compare',
    [SIZE_T, SIZE_T, ref, SIZE_T, SIZE_T],
    INT,
    (s, [start, count, other, otherStart, otherCount], frame) => {
      const viewSubstring = (bytes: string, from: unknown, length: unknown): string =>
        position(from, 0n) > BigInt(bytes.length)
          ? throwLibrary(frame, library.exception('out_of_range'), 'string_view::substr')
          : substring(frame, bytes, from, length);
      return compareBytes(viewSubstring(s.bytes, start, count), viewSubstring(textOf(other), otherStart, otherCount));
    },
    { isConst: true, optional: 1 }
  );
  method('starts_with', [CHAR], BOOL, (s, [char]) => (s.bytes.startsWith(charOf(char)) ? 1 : 0), { isConst: true });
  method('ends_with', [CHAR], BOOL, (s, [char]) => (s.bytes.endsWith(charOf(char)) ? 1 : 0), { isConst: true });
  const refType: Type = { kind: 'reference', to: type };
  const iteratorType = classType(iterator);
  const constIteratorType = classType(constIterator);
  const edit = (s: StringValue, start: unknown, count: unknown, replacement: string, frame: Frame): StringValue => {
    const begin = position(start, 0n);
    if (begin > BigInt(s.bytes.length)) return outOfRange(frame);
    const from = Number(begin);
    const length = clampedLength(count, s.bytes.length - from);
    s.bytes = checkLength(frame, s.bytes.slice(0, from) + replacement + s.bytes.slice(from + length));
    return s;
  };
  /** The forms of the characters `append`, `assign`, `insert`, and `replace` put in: `(str)`, `(s, n)`, `(n, c)`, ... */
  const sources: {
    params: Type[];
    optional?: number;
    bytes: (args: unknown[], frame: Frame, kept: number) => string;
  }[] = [
    { params: [ref], bytes: ([text]) => textOf(text) },
    { params: [CONST_CHAR_PTR], bytes: ([text]) => textOf(text) },
    { params: [CONST_CHAR_PTR, SIZE_T], bytes: ([pointer, count]) => pointerBytes(pointer as Ptr, count) },
    { params: [SIZE_T, CHAR], bytes: ([count, char], frame, kept) => repeated(frame, count, char, kept) },
  ];
  const substringSource = {
    params: [ref, SIZE_T, SIZE_T],
    optional: 1,
    bytes: ([text, start, count]: unknown[], frame: Frame) => substring(frame, textOf(text), start, count),
  };
  /** Where each function puts the characters, as the span of the string they replace. */
  const targets: { name: string; params: Type[]; span: (s: StringValue, args: unknown[]) => [unknown, unknown] }[] = [
    { name: 'append', params: [], span: (s) => [BigInt(s.bytes.length), 0n] },
    { name: 'assign', params: [], span: () => [0n, NPOS] },
    { name: 'insert', params: [SIZE_T], span: (_s, [start]) => [start, 0n] },
    { name: 'replace', params: [SIZE_T, SIZE_T], span: (_s, [start, count]) => [start, count] },
    {
      name: 'replace',
      params: [constIteratorType, constIteratorType],
      span: (s, [first, last]) => {
        const [from, to] = iteratorSpan(s, first, last);
        return [BigInt(from), BigInt(to - from)];
      },
    },
  ];
  for (const target of targets) {
    const isIteratorSpan = target.params[0] === constIteratorType;
    for (const source of isIteratorSpan ? sources : [...sources, substringSource]) {
      const at = target.params.length;
      method(
        target.name,
        [...target.params, ...source.params],
        refType,
        (s, args, frame) => {
          const [start, count] = target.span(s, args);
          const kept = s.bytes.length - clampedLength(count, Math.max(0, s.bytes.length - Number(position(start, 0n))));
          return edit(s, start, count, source.bytes(args.slice(at), frame, kept), frame);
        },
        { optional: source.optional }
      );
    }
    rangeMethod(target.name, target.params, refType, (s, args, bytes, frame) => {
      const [start, count] = target.span(s, args);
      return edit(s, start, count, bytes, frame);
    });
  }
  method('insert', [constIteratorType, CHAR], iteratorType, (s, [at, char], frame) =>
    insertAt(s, at, charOf(char), frame)
  );
  method('insert', [constIteratorType, SIZE_T, CHAR], iteratorType, (s, [at, count, char], frame) =>
    insertAt(s, at, repeated(frame, count, char, s.bytes.length), frame)
  );
  rangeMethod('insert', [constIteratorType], iteratorType, (s, [at], bytes, frame) => insertAt(s, at, bytes, frame));
  method('erase', [SIZE_T, SIZE_T], refType, (s, [start, count], frame) => edit(s, start ?? 0n, count, '', frame), {
    optional: 2,
  });
  method('erase', [constIteratorType], iteratorType, (s, [at]) => {
    const index = iteratorIndex(s, at);
    if (index >= s.bytes.length) throw new CppRuntimeError('invalidIterator');
    s.bytes = s.bytes.slice(0, index) + s.bytes.slice(index + 1);
    return s.characterBuffer().location(index);
  });
  method('erase', [constIteratorType, constIteratorType], iteratorType, (s, [first, last]) => {
    const [from, to] = iteratorSpan(s, first, last);
    s.bytes = s.bytes.slice(0, from) + s.bytes.slice(to);
    return s.characterBuffer().location(from);
  });
  method(
    'resize',
    [SIZE_T, CHAR],
    VOID,
    (s, [count, char], frame) => {
      const length = requestedLength(frame, count);
      const fill = char === undefined ? '\0' : charOf(char);
      s.bytes = checkLength(
        frame,
        length <= s.bytes.length ? s.bytes.slice(0, length) : s.bytes + fill.repeat(length - s.bytes.length)
      );
    },
    { optional: 1 }
  );
  method('swap', [{ kind: 'reference', to: type }], VOID, (s, [other]) => {
    const target = (other as Ptr).read() as StringValue;
    const moved = new StringValue('');
    moved.moveFrom(s);
    s.moveFrom(target);
    target.moveFrom(moved);
  });
  for (const name of ['c_str', 'data']) {
    method(name, [], CONST_CHAR_PTR, (s) => new Ptr(s.characterBuffer(), 0), { isConst: true });
  }
  method('data', [], pointerTo(CHAR), (s) => new Ptr(s.characterBuffer(), 0));
  method(
    'copy',
    [pointerTo(CHAR), SIZE_T, SIZE_T],
    SIZE_T,
    (s, [destination, count, start], frame) => {
      const begin = position(start, 0n);
      if (begin > BigInt(s.bytes.length)) return outOfRange(frame);
      const from = Number(begin);
      const length = clampedLength(count, s.bytes.length - from);
      const target = destination as Ptr;
      rejectOverlappingBytes(target, length, s.characterBuffer().location(from), length);
      checkByteWrite(target, length);
      const bytes = s.bytes.slice(from, from + length);
      for (let index = 0; index < bytes.length; index++) target.offset(index).write(signedChar(byteAt(bytes, index)));
      return BigInt(bytes.length);
    },
    { isConst: true, optional: 1 }
  );
  return cls;
}

const make = (bytes: string): StringValue => new StringValue(bytes);

const checkLength = (frame: Frame, bytes: string): string => {
  checkStringLength(bytes.length);
  frame.runtime.reserve(Math.ceil(bytes.length / 8));
  return bytes;
};

function checkStringLength(length: number): void {
  if (length > MAX_LENGTH) throw new CppRuntimeError('custom', '文字列が長すぎます。');
}

function appendBytes(frame: Frame, left: string, right: string): string {
  checkStringLength(left.length + right.length);
  frame.runtime.reserve(Math.ceil((left.length + right.length) / 8));
  return left + right;
}

const isPlainChar = (type: Type): boolean => type.kind === 'int' && type.name === 'char';

const insertAt = (s: StringValue, at: unknown, bytes: string, frame: Frame): Ptr => {
  const index = iteratorIndex(s, at);
  s.bytes = checkLength(frame, s.bytes.slice(0, index) + bytes + s.bytes.slice(index));
  return s.characterBuffer().location(index);
};

const searchCharacterSet =
  (reverse: boolean, inSet: boolean) =>
  (bytes: string, set: string, start: bigint, frame: Frame): number => {
    const first = reverse
      ? start >= BigInt(bytes.length)
        ? bytes.length - 1
        : Number(start)
      : start >= BigInt(bytes.length)
        ? bytes.length
        : Number(start);
    if (first < 0 || first >= bytes.length) return -1;
    const contains = new Uint8Array(256);
    for (let index = 0; index < set.length; index++) {
      if (index % 64 === 0) frame.runtime.spend();
      contains[byteAt(set, index)] = 1;
    }
    const step = reverse ? -1 : 1;
    for (let index = first; index >= 0 && index < bytes.length; index += step) {
      if ((index - first) % 64 === 0) frame.runtime.spend();
      if ((contains[byteAt(bytes, index)] === 1) === inSet) return index;
    }
    return -1;
  };

/** Compares as `char_traits<char>::compare` does with `memcmp`, which returns the difference of the unequal bytes. */
const compareBytes = (a: string, b: string): number => {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = byteAt(a, index) - byteAt(b, index);
    if (difference !== 0) return difference;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

/**
 * The capacity libc++'s string allocates for a length: the short form's, or room for the length and the terminating
 * null character rounded up to a multiple of 8, less the null character; a room of 24 becomes 25, which tells it from
 * the short form's.
 */
function fittingCapacity(length: number): number {
  if (length <= SHORT_CAPACITY) return SHORT_CAPACITY;
  const room = Math.ceil((length + 1) / 8) * 8;
  return (room === SHORT_CAPACITY + 2 ? room + 1 : room) - 1;
}

function pointerBytes(pointer: Ptr, count: unknown): string {
  let bytes = '';
  for (let index = 0; index < asNumber(count); index++) bytes += charOf(pointer.offset(index).read());
  return bytes;
}

interface CharacterInputIterator {
  type: Type;
  element: ArithmeticType;
  isReverse: boolean;
}

function inputIterator(args: Expr[], at: number): CharacterInputIterator | undefined {
  const [first, second] = args.slice(at, at + 2).map((arg) => decay(arg.type));
  if (!first || !second || typeKey(first) !== typeKey(second)) return undefined;
  const element =
    first.kind === 'pointer'
      ? first.to
      : first.kind === 'class' && first.cls.library?.kind === 'iterator'
        ? first.cls.library.args[0]
        : undefined;
  if (!element || !isArithmetic(element)) return undefined;
  return { type: first, element, isReverse: first.kind === 'class' && first.cls.library?.isReverse === true };
}

const decay = (type: Type): Type => (type.kind === 'array' ? pointerTo(type.of) : unqualified(type));

function rangeBytes(frame: Frame, first: Ptr, last: Ptr, { element, isReverse }: CharacterInputIterator): string {
  const length = first.rangeLength(last, isReverse);
  checkStringLength(length);
  frame.runtime.spend(Math.ceil(length / 64));
  if (length === 0) return '';
  const store = first.target();
  const start = first.index;
  let bytes = '';
  for (let offset = 0; offset < length; offset++) {
    const value = store.get(isReverse ? start - 1 - offset : start + offset) as Scalar;
    bytes += charOf(convertScalar(value, element, CHAR));
  }
  return bytes;
}

/** The position of an iterator into the string it belongs to. */
function iteratorIndex(s: StringValue, iterator: unknown): number {
  const pointer = iterator as Ptr;
  if (pointer.store !== s.characterBuffer() || pointer.index > s.bytes.length)
    throw new CppRuntimeError('invalidIterator');
  return pointer.index;
}

function iteratorSpan(s: StringValue, first: unknown, last: unknown): [number, number] {
  const from = iteratorIndex(s, first);
  const to = iteratorIndex(s, last);
  if (from > to) throw new CppRuntimeError('invalidRange');
  return [from, to];
}

/**
 * `std::string s = {'a', 'b'}`, whose `initializer_list<char>` constructor wins whenever every element is arithmetic, so
 * `std::string{66}` holds "B" and a narrowing element is an error; other lists use the other constructors.
 */
function charList(compiler: ExpressionCompiler, elements: readonly Syntax[], row: number): Initializer | undefined {
  if (elements.length === 0 || elements.some((element) => element.type === 'initializer_list')) return undefined;
  const values = elements.map((element) => compiler.rvalue(compiler.compileExpression(element)));
  if (!values.every((value) => isArithmetic(value.type))) return undefined;
  for (const value of values) {
    if (narrowsToChar(value)) {
      compiler.error(
        row,
        `{...} の中では、${typeName(value.type)} 型の値を char 型に縮めて変換できません（縮小変換）。`
      );
    }
  }
  const runs = values.map((value) => compiler.convert(value, CHAR, row).run);
  const constantStringLength =
    elements.length <= SHORT_CAPACITY && values.every((value) => value.constant !== undefined)
      ? elements.length
      : undefined;
  return initializerWithConstancy(
    (frame) => new StringValue(runs.map((run) => charOf(run(frame))).join('')),
    constantStringLength !== undefined,
    { constantStringLength }
  );
}

function shortString(count: number | bigint | undefined): Exclude<LibraryConstant, true> | undefined {
  if (count !== undefined && count >= 0 && count <= SHORT_CAPACITY) return { stringLength: Number(count) };
}

function literalStringLength(bytes: string | undefined): number | undefined {
  if (bytes === undefined) return;
  const terminator = bytes.indexOf('\0');
  return terminator === -1 ? bytes.length : terminator;
}

/** Whether converting a value to `char` narrows it (C++20 [dcl.init.list]). */
function narrowsToChar(value: Expr): boolean {
  const type = value.type;
  if (type.kind !== 'int') return true;
  if (value.constant !== undefined) return BigInt(value.constant) < -128n || BigInt(value.constant) > 127n;
  return type.name !== 'char' && type.name !== 'schar' && type.name !== 'bool';
}

interface TextOperand {
  kind: 'string' | 'pointer' | 'character';
  run: Eval<unknown>;
}

function stringObject(value: unknown): StringValue {
  return (value as Ptr).read() as StringValue;
}

function operandBytes(frame: Frame, operand: TextOperand, value: unknown): string {
  switch (operand.kind) {
    case 'string': {
      return stringObject(value).bytes;
    }
    case 'pointer': {
      return readCString(value as Ptr, undefined, frame.runtime);
    }
    case 'character': {
      return charOf(value);
    }
  }
}

function concatenation(a: TextOperand, b: TextOperand, reused: number): Eval<StringValue> {
  return (frame) =>
    frame.unsequencedOperands(a.run, b.run, (left, right) => {
      const bytes = appendBytes(frame, operandBytes(frame, a, left), operandBytes(frame, b, right));
      const result = new StringValue(reused < 0 ? bytes : '');
      if (reused >= 0) {
        result.moveFrom(stringObject(reused === 0 ? left : right));
        result.bytes = bytes;
      }
      return result;
    });
}

/** The operators of `std::string`: `+`, `+=`, `=`, comparisons, and `[]`. */
// code-gauge-allow functionCognitiveComplexity 30 -- One case per operator, each with its operand forms.
function stringOperator(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  operator: string,
  operands: Expr[],
  row: number
): Expr | undefined {
  const type = classType(cls);
  const [left, right] = operands;
  const isString = (expr: Expr): boolean => expr.type.kind === 'class' && expr.type.cls === cls;
  const canMoveString = (expr: Expr): boolean =>
    isString(expr) && !isConstType(expr.type) && (!expr.isLvalue || expr.isXvalue === true);
  const textOperand = (expr: Expr): TextOperand | undefined => {
    if (isString(expr)) return { kind: 'string', run: compiler.objectOf(expr) };
    const { type, run } = compiler.rvalue(expr);
    if (type.kind === 'pointer' && isCharType(type.to)) return { kind: 'pointer', run };
  };
  // Concatenation deduces char from both operands, while assignment converts arithmetic values to char.
  const characterOperand = (expr: Expr, accepts: (type: Type) => boolean): TextOperand | undefined => {
    const value = compiler.rvalue(expr);
    if (accepts(value.type)) return { kind: 'character', run: compiler.convert(value, CHAR, row).run };
  };
  switch (operator) {
    case '+': {
      if (!right) return undefined;
      if (!isString(left) && !isString(right)) return undefined;
      const a = textOperand(left) ?? characterOperand(left, isPlainChar);
      const b = textOperand(right) ?? characterOperand(right, isPlainChar);
      if (!a || !b) return undefined;
      // A temporary string operand gives its buffer to the result, as libc++ appends to it or inserts into it.
      const reused = operands.findIndex(canMoveString);
      const constantStringLength = shortConcatenationLength(left, right);
      return {
        type,
        isLvalue: false,
        row,
        isTemporaryObject: true,
        constantInitialization: constantStringLength !== undefined,
        constantStringLength,
        run: concatenation(a, b, reused),
      };
    }
    case '+=':
    case '=': {
      if (!isString(left)) return undefined;
      compiler.checkAssignable(left, row, operator);
      const append = operator === '+=';
      const moves = !append && canMoveString(right);
      const location = left.run;
      const source = textOperand(right) ?? characterOperand(scalarValue(compiler, right), isArithmetic);
      if (!source) return undefined;
      return {
        type: left.type,
        isLvalue: true,
        row,
        run: (frame) =>
          holdAll(frame, [source.run, location], ([operand, receiver]) => {
            const place = receiver as Ptr;
            const target = stringObject(place);
            if (moves) {
              const string = stringObject(operand);
              if (target !== string) target.moveFrom(string);
            } else {
              const bytes = operandBytes(frame, source, operand);
              target.bytes = append ? appendBytes(frame, target.bytes, bytes) : checkLength(frame, bytes);
            }
            return place;
          }),
      };
    }
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (!right) return undefined;
      const a = textOperand(left);
      const b = textOperand(right);
      if (!a || !b) return undefined;
      const test = COMPARE[operator];
      return {
        type: BOOL,
        isLvalue: false,
        row,
        run: (frame) =>
          frame.unsequencedOperands(a.run, b.run, (left, right) =>
            test(operandBytes(frame, a, left), operandBytes(frame, b, right)) ? 1 : 0
          ),
      };
    }
    case '[]': {
      if (!isString(left)) return undefined;
      const index = compiler.convert(right, SIZE_T, row).run;
      const elementType = left.type.kind === 'class' && left.type.isConst ? withConst(CHAR) : CHAR;
      return {
        type: elementType,
        isLvalue: true,
        row,
        run: compiler.subscriptObject(left, index, (_frame, receiver, operand) => {
          const target = receiver as StringValue;
          const at = Number(operand);
          if (at < 0 || at > target.bytes.length) throw new CppRuntimeError('outOfBounds');
          return new Ptr(target.characterBuffer(), at);
        }),
      };
    }
    default: {
      return undefined;
    }
  }
}

function shortConcatenationLength(left: Expr, right: Expr): number | undefined {
  const a = stringOperandLength(left);
  const b = stringOperandLength(right);
  if (a !== undefined && b !== undefined) return shortString(a + b)?.stringLength;
}

function stringOperandLength(expr: Expr): number | undefined {
  if (isPlainChar(expr.type)) return expr.constant === undefined ? undefined : 1;
  return expr.constantStringLength ?? literalStringLength(expr.literalBytes);
}

const COMPARE: Record<string, (a: string, b: string) => boolean> = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

/** The free functions of `<string>`: `std::to_string` and `std::stoi` and the like. */
export function stringFunctions(library: Library, cls: ClassInfo): Map<string, ReturnType<typeof native>[]> {
  const type = classType(cls);
  const ref = constRef(type);
  const functions = new Map<string, ReturnType<typeof native>[]>();
  const add = (fn: ReturnType<typeof native>): void => {
    functions.set(fn.name, [...(functions.get(fn.name) ?? []), fn]);
  };
  for (const argType of [INT, LONG, LLONG, UINT, ULONG, ULLONG]) {
    add(native('to_string', [argType], type, ([value]) => new StringValue(String(value))));
  }
  for (const argType of [FLOAT, DOUBLE, LDOUBLE]) {
    add(
      native(
        'to_string',
        [argType],
        type,
        ([value]) => new StringValue(formatFloat(value as number, { conversion: 'f', precision: 6 }))
      )
    );
  }
  const integerParsers: [string, Type, bigint, bigint, boolean][] = [
    ['stoi', INT, -(2n ** 31n), 2n ** 31n - 1n, true],
    ['stol', LONG, -(2n ** 63n), 2n ** 63n - 1n, true],
    ['stoll', LLONG, -(2n ** 63n), 2n ** 63n - 1n, true],
    ['stoul', ULONG, 0n, 2n ** 64n - 1n, false],
    ['stoull', ULLONG, 0n, 2n ** 64n - 1n, false],
  ];
  for (const [name, resultType, min, max, isSigned] of integerParsers) {
    add(
      native(
        name,
        [ref, pointerTo(SIZE_T), INT],
        resultType,
        ([text, index, base], { frame }) => {
          const bytes = textOf(text);
          const parsed = parseIntegerPrefix(byteArray(bytes), base === undefined ? 10 : asNumber(base));
          if (parsed.length === 0)
            return throwLibrary(frame, library.exception('invalid_argument'), `${name}: no conversion`);
          let value = parsed.value;
          // strtol and strtoll saturate (and report ERANGE) beyond the 64-bit range; strtoul wraps negative values.
          if (isSigned ? value < -(2n ** 63n) || value > 2n ** 63n - 1n : parsed.magnitude > 2n ** 64n - 1n) {
            return throwLibrary(frame, library.exception('out_of_range'), `${name}: out of range`);
          }
          if (!isSigned) value = BigInt.asUintN(64, value);
          if (value < min || value > max)
            return throwLibrary(frame, library.exception('out_of_range'), `${name}: out of range`);
          if (index instanceof Ptr && !index.isNull) index.write(BigInt(parsed.length));
          return resultType === INT ? Number(value) : value;
        },
        { optional: 2 }
      )
    );
  }
  const floatParsers: [string, Type][] = [
    ['stof', FLOAT],
    ['stod', DOUBLE],
    ['stold', LDOUBLE],
  ];
  for (const [name, resultType] of floatParsers) {
    add(
      native(
        name,
        [ref, pointerTo(SIZE_T)],
        resultType,
        ([text, index], { frame }) => {
          const bytes = byteArray(textOf(text));
          const isFloat = resultType === FLOAT;
          const parsed = parseFloatPrefix(bytes, undefined, isFloat);
          if (parsed.length === 0)
            return throwLibrary(frame, library.exception('invalid_argument'), `${name}: no conversion`);
          const { value } = parsed;
          const overflow = !Number.isFinite(value) && !parsed.isInfinityText;
          if (overflow || isFloatUnderflow(bytes, parsed, value, isFloat))
            return throwLibrary(frame, library.exception('out_of_range'), `${name}: out of range`);
          if (index instanceof Ptr && !index.isNull) index.write(BigInt(parsed.length));
          return value;
        },
        { optional: 1 }
      )
    );
  }
  return functions;
}

export { isSpaceByte, NULL_PTR };
