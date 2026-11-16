import { isSpaceByte, parseFloatPrefix, parseIntegerPrefix } from '../../c/library/numberParsing';
import { byteArray, byteAt } from '../bytes';
import { CppRuntimeError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { Eval, Frame } from '../runtime';
import type { Syntax } from '../syntax';
import {
  BOOL,
  CHAR,
  ClassInfo,
  classType,
  DOUBLE,
  FLOAT,
  INT,
  isCharType,
  LDOUBLE,
  LLONG,
  LONG,
  pointerTo,
  SIZE_T,
  type Type,
  UINT,
  ULLONG,
  ULONG,
  VOID,
  withConst,
} from '../types';
import { NULL_PTR, Ptr, Store, type Value } from '../values';
import { formatFloat } from './formatting';
import { randomAccessIterator } from './iterators';
import type { Library } from './registry';
import {
  addMethod,
  asNumber,
  CONST_CHAR_PTR,
  constRef,
  cStringStore,
  native,
  nativeConstructor,
  readCString,
  signedChar,
  throwLibrary,
} from './support';

/** The value of a `std::string`: its bytes, as a string of character codes below 256. */
export class StringValue extends Store {
  constructor(public bytes: string) {
    super();
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

export function decodeUtf8(bytes: string): string {
  // oxlint-disable-next-line no-control-regex -- ASCII text decodes to itself.
  if (/^[\u0000-\u007F]*$/.test(bytes)) return bytes;
  return new TextDecoder().decode(byteArray(bytes));
}

const NPOS = 0xff_ff_ff_ff_ff_ff_ff_ffn;
const MAX_SIZE = 0x7f_ff_ff_ff_ff_ff_ff_f7n;

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
    size: 24,
    align: 8,
    operator: (compiler, operator, operands, row) => stringOperator(compiler, library, cls, operator, operands, row),
    listInitializer: (compiler, elements, row) => charList(compiler, elements, row),
  };
  cls.constructors = [
    nativeConstructor(cls, [], () => make('')),
    nativeConstructor(cls, [CONST_CHAR_PTR], ([pointer]) => {
      if ((pointer as Ptr).isNull) throw new CppRuntimeError('nullAccess');
      return make(readCString(pointer as Ptr));
    }),
    nativeConstructor(cls, [SIZE_T, CHAR], ([count, char], { frame }) => {
      if (BigInt(count as bigint) > MAX_SIZE) return lengthError(frame);
      return make(checkLength(frame, charOf(char).repeat(asNumber(count))));
    }),
    nativeConstructor(
      cls,
      [ref, SIZE_T, SIZE_T],
      ([source, start, count], { frame }) => {
        const bytes = textOf(source);
        const begin = position(start, 0n);
        if (begin > BigInt(bytes.length)) return outOfRange(frame);
        return make(bytes.slice(Number(begin), Number(begin) + clampedLength(count, bytes.length - Number(begin))));
      },
      { optional: 1 }
    ),
    nativeConstructor(cls, [CONST_CHAR_PTR, SIZE_T], ([pointer, count]) => {
      const store = (pointer as Ptr).target();
      let bytes = '';
      for (let index = 0; index < asNumber(count); index++) bytes += charOf(store.get((pointer as Ptr).index + index));
      return make(bytes);
    }),
    nativeConstructor(cls, [classType(constIterator), classType(constIterator)], ([first, last]) =>
      make(rangeBytes(first as Ptr, last as Ptr))
    ),
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
      native(name, params, ret, (args, { self, frame }) => run(self as StringValue, args, frame), options)
    );
  };
  for (const name of ['size', 'length']) method(name, [], SIZE_T, (s) => BigInt(s.bytes.length), { isConst: true });
  method('max_size', [], SIZE_T, () => MAX_SIZE, { isConst: true });
  method('capacity', [], SIZE_T, (s) => BigInt(capacityOf(s.bytes.length)), { isConst: true });
  method('reserve', [SIZE_T], VOID, () => {}, { optional: 1 });
  method('shrink_to_fit', [], VOID, () => {});
  method('empty', [], BOOL, (s) => (s.bytes.length === 0 ? 1 : 0), { isConst: true });
  method('clear', [], VOID, (s) => {
    s.bytes = '';
  });
  const element = (s: StringValue, index: unknown, frame: Frame, checked: boolean): Ptr => {
    const at = BigInt(index as bigint);
    if (at >= BigInt(s.bytes.length)) {
      if (checked) return outOfRange(frame);
      if (at === BigInt(s.bytes.length)) return new Ptr(cStringStore(''), 0);
      throw new CppRuntimeError('outOfBounds');
    }
    return new Ptr(s, Number(at));
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
        return new Ptr(s, 0);
      },
      { isConst }
    );
    method(
      'back',
      [],
      charRef,
      (s) => {
        if (s.bytes.length === 0) throw new CppRuntimeError('emptyContainer');
        return new Ptr(s, s.bytes.length - 1);
      },
      { isConst }
    );
    method('begin', [], classType(isConst ? constIterator : iterator), (s) => new Ptr(s, 0), { isConst });
    method('end', [], classType(isConst ? constIterator : iterator), (s) => new Ptr(s, s.bytes.length), { isConst });
    method(
      'rbegin',
      [],
      classType(isConst ? constReverseIterator : reverseIterator),
      (s) => new Ptr(s, s.bytes.length),
      { isConst }
    );
    method('rend', [], classType(isConst ? constReverseIterator : reverseIterator), (s) => new Ptr(s, 0), { isConst });
  }
  method('cbegin', [], classType(constIterator), (s) => new Ptr(s, 0), { isConst: true });
  method('cend', [], classType(constIterator), (s) => new Ptr(s, s.bytes.length), { isConst: true });
  method('crbegin', [], classType(constReverseIterator), (s) => new Ptr(s, s.bytes.length), { isConst: true });
  method('crend', [], classType(constReverseIterator), (s) => new Ptr(s, 0), { isConst: true });
  method('push_back', [CHAR], VOID, (s, [char], frame) => {
    s.bytes = checkLength(frame, s.bytes + charOf(char));
  });
  method('pop_back', [], VOID, (s) => {
    if (s.bytes.length === 0) throw new CppRuntimeError('emptyContainer');
    s.bytes = s.bytes.slice(0, -1);
  });
  const refType = { kind: 'reference', to: type } as Type;
  for (const sourceType of [ref, CONST_CHAR_PTR]) {
    method('append', [sourceType], refType, (s, [text], frame) => {
      s.bytes = checkLength(frame, s.bytes + textOf(text));
      return self(s);
    });
    method('assign', [sourceType], refType, (s, [text]) => {
      s.bytes = textOf(text);
      return self(s);
    });
  }
  method('append', [SIZE_T, CHAR], refType, (s, [count, char], frame) => {
    s.bytes = checkLength(frame, s.bytes + charOf(char).repeat(asNumber(count)));
    return self(s);
  });
  method('assign', [SIZE_T, CHAR], refType, (s, [count, char], frame) => {
    s.bytes = checkLength(frame, charOf(char).repeat(asNumber(count)));
    return self(s);
  });
  method(
    'append',
    [ref, SIZE_T, SIZE_T],
    refType,
    (s, [text, start, count], frame) => {
      const bytes = textOf(text);
      const begin = position(start, 0n);
      if (begin > BigInt(bytes.length)) return outOfRange(frame);
      s.bytes = checkLength(
        frame,
        s.bytes + bytes.slice(Number(begin), Number(begin) + clampedLength(count, bytes.length - Number(begin)))
      );
      return self(s);
    },
    { optional: 1 }
  );
  method(
    'substr',
    [SIZE_T, SIZE_T],
    type,
    (s, [start, count], frame) => {
      const begin = position(start, 0n);
      if (begin > BigInt(s.bytes.length)) return outOfRange(frame);
      return make(s.bytes.slice(Number(begin), Number(begin) + clampedLength(count, s.bytes.length - Number(begin))));
    },
    { isConst: true, optional: 2 }
  );
  const search = (
    name: string,
    find: (bytes: string, needle: string, start: bigint) => number,
    defaultStart: bigint
  ): void => {
    for (const needleType of [ref, CONST_CHAR_PTR]) {
      method(
        name,
        [needleType, SIZE_T],
        SIZE_T,
        (s, [needle, start]) => found(find(s.bytes, textOf(needle), position(start, defaultStart))),
        { isConst: true, optional: 1 }
      );
    }
    method(
      name,
      [CHAR, SIZE_T],
      SIZE_T,
      (s, [char, start]) => found(find(s.bytes, charOf(char), position(start, defaultStart))),
      { isConst: true, optional: 1 }
    );
    method(
      name,
      [CONST_CHAR_PTR, SIZE_T, SIZE_T],
      SIZE_T,
      (s, [needle, start, count]) => {
        const bytes = readCString(needle as Ptr).slice(0, asNumber(count));
        return found(find(s.bytes, bytes, position(start, defaultStart)));
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
  search('find_first_of', firstOf(true), 0n);
  search('find_first_not_of', firstOf(false), 0n);
  search('find_last_of', lastOf(true), NPOS);
  search('find_last_not_of', lastOf(false), NPOS);
  for (const otherType of [ref, CONST_CHAR_PTR]) {
    method('compare', [otherType], INT, (s, [other]) => compareBytes(s.bytes, textOf(other)), { isConst: true });
    method(
      'compare',
      [SIZE_T, SIZE_T, otherType],
      INT,
      (s, [start, count, other], frame) => {
        const begin = position(start, 0n);
        if (begin > BigInt(s.bytes.length)) return outOfRange(frame);
        const part = s.bytes.slice(Number(begin), Number(begin) + clampedLength(count, s.bytes.length - Number(begin)));
        return compareBytes(part, textOf(other));
      },
      { isConst: true }
    );
    method('starts_with', [otherType], BOOL, (s, [other]) => (s.bytes.startsWith(textOf(other)) ? 1 : 0), {
      isConst: true,
    });
    method('ends_with', [otherType], BOOL, (s, [other]) => (s.bytes.endsWith(textOf(other)) ? 1 : 0), {
      isConst: true,
    });
  }
  method('starts_with', [CHAR], BOOL, (s, [char]) => (s.bytes.startsWith(charOf(char)) ? 1 : 0), { isConst: true });
  method('ends_with', [CHAR], BOOL, (s, [char]) => (s.bytes.endsWith(charOf(char)) ? 1 : 0), { isConst: true });
  const edit = (s: StringValue, start: unknown, count: unknown, replacement: string, frame: Frame): Ptr => {
    const begin = position(start, 0n);
    if (begin > BigInt(s.bytes.length)) return outOfRange(frame);
    const from = Number(begin);
    const length = clampedLength(count, s.bytes.length - from);
    s.bytes = checkLength(frame, s.bytes.slice(0, from) + replacement + s.bytes.slice(from + length));
    return self(s);
  };
  for (const sourceType of [ref, CONST_CHAR_PTR]) {
    method('insert', [SIZE_T, sourceType], refType, (s, [start, text], frame) =>
      edit(s, start, 0n, textOf(text), frame)
    );
    method('replace', [SIZE_T, SIZE_T, sourceType], refType, (s, [start, count, text], frame) =>
      edit(s, start, count, textOf(text), frame)
    );
  }
  method('insert', [SIZE_T, SIZE_T, CHAR], refType, (s, [start, count, char], frame) =>
    edit(s, start, 0n, charOf(char).repeat(asNumber(count)), frame)
  );
  method('replace', [SIZE_T, SIZE_T, SIZE_T, CHAR], refType, (s, [start, count, n, char], frame) =>
    edit(s, start, count, charOf(char).repeat(asNumber(n)), frame)
  );
  method('erase', [SIZE_T, SIZE_T], refType, (s, [start, count], frame) => edit(s, start ?? 0n, count, '', frame), {
    optional: 2,
  });
  method('insert', [classType(constIterator), CHAR], classType(iterator), (s, [at, char], frame) => {
    const index = (at as Ptr).index;
    s.bytes = checkLength(frame, s.bytes.slice(0, index) + charOf(char) + s.bytes.slice(index));
    return new Ptr(s, index);
  });
  method('erase', [classType(constIterator)], classType(iterator), (s, [at]) => {
    const index = (at as Ptr).index;
    if (index >= s.bytes.length) throw new CppRuntimeError('invalidIterator');
    s.bytes = s.bytes.slice(0, index) + s.bytes.slice(index + 1);
    return new Ptr(s, index);
  });
  method('erase', [classType(constIterator), classType(constIterator)], classType(iterator), (s, [first, last]) => {
    const from = (first as Ptr).index;
    const to = (last as Ptr).index;
    if (from > to) throw new CppRuntimeError('invalidRange');
    s.bytes = s.bytes.slice(0, from) + s.bytes.slice(to);
    return new Ptr(s, from);
  });
  method(
    'resize',
    [SIZE_T, CHAR],
    VOID,
    (s, [count, char], frame) => {
      const length = asNumber(count);
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
    [s.bytes, target.bytes] = [target.bytes, s.bytes];
  });
  for (const name of ['c_str', 'data']) {
    method(name, [], CONST_CHAR_PTR, (s) => new Ptr(cStringStore(s.bytes), 0), { isConst: true });
  }
  method(
    'copy',
    [pointerTo(CHAR), SIZE_T, SIZE_T],
    SIZE_T,
    (s, [destination, count, start], frame) => {
      const begin = position(start, 0n);
      if (begin > BigInt(s.bytes.length)) return outOfRange(frame);
      const bytes = s.bytes.slice(Number(begin), Number(begin) + clampedLength(count, s.bytes.length - Number(begin)));
      const target = destination as Ptr;
      for (let index = 0; index < bytes.length; index++) target.offset(index).write(signedChar(byteAt(bytes, index)));
      return BigInt(bytes.length);
    },
    { isConst: true, optional: 1 }
  );
  return cls;
}

const make = (bytes: string): StringValue => new StringValue(bytes);

const checkLength = (frame: Frame, bytes: string): string => {
  frame.runtime.reserve(Math.ceil(bytes.length / 8));
  if (bytes.length > 1_000_000) throw new CppRuntimeError('custom', '文字列が長すぎます。');
  return bytes;
};

const self = (value: StringValue): Ptr => new Ptr(new SelfBox(value), 0);

const firstOf =
  (inSet: boolean) =>
  (bytes: string, set: string, start: bigint): number => {
    for (let index = start > BigInt(bytes.length) ? bytes.length : Number(start); index < bytes.length; index++) {
      if (set.includes(bytes[index]) === inSet) return index;
    }
    return -1;
  };

const lastOf =
  (inSet: boolean) =>
  (bytes: string, set: string, start: bigint): number => {
    for (let index = start >= BigInt(bytes.length) ? bytes.length - 1 : Number(start); index >= 0; index--) {
      if (set.includes(bytes[index]) === inSet) return index;
    }
    return -1;
  };

const compareBytes = (a: string, b: string): number => {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = byteAt(a, index) - byteAt(b, index);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

/** A store that holds one object, for a member function that returns `*this` by reference. */
class SelfBox extends Store {
  constructor(readonly value: StringValue) {
    super();
  }

  get length(): number {
    return 1;
  }

  get(): Value {
    return this.value;
  }

  set(_index: number, value: Value): void {
    this.value.bytes = (value as StringValue).bytes;
  }
}

/** The capacity libc++'s string has for a length: 22 in its short form, then rounded up to a multiple of 16, less 1. */
function capacityOf(length: number): number {
  if (length <= 22) return 22;
  return Math.ceil((length + 1) / 16) * 16 - 1;
}

function rangeBytes(first: Ptr, last: Ptr): string {
  if (first.store !== last.store || first.index > last.index) throw new CppRuntimeError('invalidRange');
  let bytes = '';
  for (let index = first.index; index < last.index; index++) bytes += charOf(first.store?.get(index));
  return bytes;
}

/** `std::string s = {'a', 'b'}`, which takes characters; other lists use the constructors. */
function charList(compiler: ExpressionCompiler, elements: Syntax[], row: number): Eval<Value> | undefined {
  if (elements.length === 0) return undefined;
  const values: Expr[] = [];
  for (const element of elements) {
    if (element.type === 'initializer_list') return undefined;
    const expr = compiler.compileExpression(element);
    if (!isCharType(compiler.rvalue(expr).type)) return undefined;
    values.push(compiler.convert(expr, CHAR, row));
  }
  return (frame) => new StringValue(values.map((value) => charOf(value.run(frame))).join(''));
}

/** The operators of `std::string`: `+`, `+=`, `=`, comparisons, and `[]`. */
// code-gauge-allow functionCognitiveComplexity 30 -- One case per operator, each with its operand forms.
function stringOperator(
  compiler: ExpressionCompiler,
  library: Library,
  cls: ClassInfo,
  operator: string,
  operands: Expr[],
  row: number
): Expr | undefined {
  const type = classType(cls);
  const [left, right] = operands;
  const isString = (expr: Expr): boolean => expr.type.kind === 'class' && expr.type.cls === cls;
  const textRun = (expr: Expr): Eval<string> | undefined => {
    if (isString(expr)) {
      const run = compiler.rvalue(expr).run;
      return (frame) => (run(frame) as StringValue).bytes;
    }
    const value = compiler.rvalue(expr);
    if (value.type.kind === 'pointer' && isCharType(value.type.to)) {
      const run = value.run;
      return (frame) => readCString(run(frame) as Ptr);
    }
    if (value.type.kind === 'class' && library.isStringLike(value.type)) return undefined;
    return undefined;
  };
  const charRun = (expr: Expr): Eval<string> | undefined => {
    const value = compiler.rvalue(expr);
    if (value.type.kind !== 'int' || isString(expr)) return undefined;
    const converted = compiler.convert(value, CHAR, row).run;
    return (frame) => charOf(converted(frame));
  };
  switch (operator) {
    case '+': {
      if (!right) return undefined;
      const a = textRun(left) ?? (isString(right) ? charRun(left) : undefined);
      const b = textRun(right) ?? (isString(left) ? charRun(right) : undefined);
      if (!a || !b || (!isString(left) && !isString(right))) return undefined;
      return {
        type,
        isLvalue: false,
        row,
        isTemporaryObject: true,
        run: (frame) => {
          const bytes = a(frame) + b(frame);
          frame.runtime.reserve(Math.ceil(bytes.length / 8));
          return new StringValue(bytes);
        },
      };
    }
    case '+=':
    case '=': {
      if (!isString(left)) return undefined;
      compiler.checkAssignable(left, row, operator);
      const source = textRun(right) ?? charRun(right);
      if (!source) return undefined;
      const location = left.run;
      const append = operator === '+=';
      return {
        type: left.type,
        isLvalue: true,
        row,
        run: (frame) => {
          const bytes = source(frame);
          const place = location(frame) as Ptr;
          const target = place.read() as StringValue;
          target.bytes = append ? target.bytes + bytes : bytes;
          return place;
        },
      };
    }
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (!right) return undefined;
      const a = textRun(left);
      const b = textRun(right);
      if (!a || !b) return undefined;
      const test = COMPARE[operator];
      return { type: BOOL, isLvalue: false, row, run: (frame) => (test(a(frame), b(frame)) ? 1 : 0) };
    }
    case '[]': {
      if (!isString(left)) return undefined;
      const index = compiler.convert(right, SIZE_T, row).run;
      const object = left.isLvalue ? left.run : compiler.materialize(left).run;
      const elementType = left.type.kind === 'class' && left.type.isConst ? withConst(CHAR) : CHAR;
      return {
        type: elementType,
        isLvalue: true,
        row,
        run: (frame) => {
          const target = (object(frame) as Ptr).read() as StringValue;
          const at = Number(index(frame) as bigint);
          if (at === target.bytes.length) return new Ptr(cStringStore(''), 0);
          if (at < 0 || at > target.bytes.length) throw new CppRuntimeError('outOfBounds');
          return new Ptr(target, at);
        },
      };
    }
    default: {
      return undefined;
    }
  }
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
          const bytes = textOf(text);
          const parsed = parseFloatPrefix(byteArray(bytes));
          if (parsed.length === 0)
            return throwLibrary(frame, library.exception('invalid_argument'), `${name}: no conversion`);
          let value = parsed.value;
          if (resultType === FLOAT) value = Math.fround(value);
          const overflow = !Number.isFinite(value) && !parsed.isInfinityText;
          const underflow = value === 0 && parsed.isNonzeroText;
          if (overflow || underflow)
            return throwLibrary(frame, library.exception('out_of_range'), `${name}: out of range`);
          if (index instanceof Ptr && !index.isNull) index.write(BigInt(parsed.length));
          return value;
        },
        { optional: 1 }
      )
    );
  }
  add(
    native(
      'swap',
      [
        { kind: 'reference', to: type },
        { kind: 'reference', to: type },
      ],
      VOID,
      ([a, b]) => {
        const x = (a as Ptr).read() as StringValue;
        const y = (b as Ptr).read() as StringValue;
        [x.bytes, y.bytes] = [y.bytes, x.bytes];
        return;
      }
    )
  );
  return functions;
}

export { isSpaceByte, NULL_PTR };
