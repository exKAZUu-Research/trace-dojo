import { CppRuntimeError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { type Eval, type Frame, holdAll } from '../runtime';
import type { Syntax } from '../syntax';
import {
  BOOL,
  ClassInfo,
  classType,
  isConstType,
  pointerTo,
  referenceTo,
  SIZE_T,
  type Type,
  typeName,
  unqualified,
  VOID,
  withConst,
} from '../types';
import { Ptr, type Value } from '../values';
import { SequenceValue } from './containerValues';
import { type ElementOperations, elementOperations, equalTo, lessThan } from './elements';
import { elementLocation, randomAccessIterator } from './iterators';
import type { Library } from './registry';
import { addMethod, asNumber, constRef, native, nativeConstructor, throwLibrary } from './support';
import { typeKey } from './templates';

export type SequenceKind = 'vector' | 'deque' | 'array' | 'list';

const MAX_ELEMENTS = 1_000_000;

/** `std::vector<T>`, `std::deque<T>`, `std::list<T>`, or `std::array<T, N>`, whose objects are `SequenceValue`s. */
export function sequenceClass(library: Library, kind: SequenceKind, element: Type, fixedLength?: number): ClassInfo {
  const name =
    kind === 'array' ? `std::array<${typeName(element)}, ${fixedLength}>` : `std::${kind}<${typeName(element)}>`;
  const key = `${kind}<${typeKey(element)}${kind === 'array' ? `,${fixedLength}` : ''}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  if (element.kind === 'reference') library.compiler.error(0, `${name} の要素を参照にはできません。`);
  if (element.kind === 'void') library.compiler.error(0, `${name} の要素を void にはできません。`);
  const cls = new ClassInfo(name, 'class');
  cls.isComplete = true;
  library.instances.set(key, cls);
  let elementOps: ElementOperations | undefined;
  const ops = (): ElementOperations => {
    elementOps ??= elementOperations(library.compiler, element, 0);
    return elementOps;
  };
  const container = name;
  const iterator = randomAccessIterator(library.iterators, container, element, false, false);
  const constIterator = randomAccessIterator(library.iterators, container, element, true, false);
  const reverseIterator = randomAccessIterator(library.iterators, container, element, false, true);
  const constReverseIterator = randomAccessIterator(library.iterators, container, element, true, true);
  cls.memberTypes.set('value_type', element);
  cls.memberTypes.set('size_type', SIZE_T);
  cls.memberTypes.set('iterator', classType(iterator));
  cls.memberTypes.set('const_iterator', classType(constIterator));
  cls.memberTypes.set('reverse_iterator', classType(reverseIterator));
  cls.memberTypes.set('const_reverse_iterator', classType(constReverseIterator));
  const outOfRange = (frame: Frame): never =>
    throwLibrary(frame, library.exception('out_of_range'), kind === 'array' ? 'array::at' : kind);
  const make = (items: Value[]): SequenceValue => {
    const value = new SequenceValue(items, element, kind !== 'list');
    value.capacity = items.length;
    return value;
  };
  /** Grows a vector's storage as libc++ does, copying and destroying the elements when that has effects. */
  const grow = (frame: Frame, sequence: SequenceValue, size: number, beforeMove?: () => void): void => {
    if (kind !== 'vector' || size <= sequence.capacity) {
      beforeMove?.();
      return;
    }
    sequence.capacity = Math.max(2 * sequence.capacity, size);
    beforeMove?.();
    const { hasEffects, copy, destroy } = ops();
    if (!hasEffects) return;
    const old = sequence.items;
    sequence.items = old.map((item) => copy(frame, item));
    if (destroy) for (const item of old) destroy(frame, item);
  };
  const destroyAll = (frame: Frame, items: Value[]): void => {
    const destroy = ops().destroy;
    if (destroy) for (let index = items.length - 1; index >= 0; index--) destroy(frame, items[index]);
  };
  cls.library = {
    kind,
    args: [element],
    size: kind === 'array' ? 0 : kind === 'deque' ? 48 : 24,
    align: 8,
    operator: (compiler, operator, operands, row) =>
      sequenceOperator(compiler, cls, element, kind, operator, operands, row),
    listInitializer: (compiler, elements, row) =>
      sequenceList(compiler, element, elements, row, make, fixedLength, ops),
    memberCall: (compiler, object, member, args, row) =>
      emplacement(compiler, library, object, member, args, row, element, kind, ops, grow),
    constructingMembers:
      kind === 'array'
        ? []
        : kind === 'vector'
          ? ['emplace_back', 'emplace']
          : ['emplace_back', 'emplace', 'emplace_front'],
  };
  cls.operations = {
    copy: (frame, source) => {
      const items = (source as SequenceValue).items;
      reserve(frame, items.length);
      return make(items.map((item) => ops().copy(frame, item)));
    },
    assign: (frame, target, source) => {
      const to = target as SequenceValue;
      const from = source as SequenceValue;
      if (to === from) return;
      const old = to.items;
      if (kind === 'vector' && from.items.length > to.capacity) to.capacity = from.items.length;
      to.items = from.items.map((item) => ops().copy(frame, item));
      destroyAll(frame, old);
    },
    destroy: (frame, value) => destroyAll(frame, (value as SequenceValue).items),
  };
  if (kind === 'array') {
    cls.memberTypes.set('size_type', SIZE_T);
    cls.constants.set('\0length', (row) => ({
      type: SIZE_T,
      isLvalue: false,
      row,
      run: () => BigInt(fixedLength ?? 0),
    }));
    cls.constructors = [
      nativeConstructor(cls, [], (_args, { frame }) =>
        make(Array.from({ length: fixedLength ?? 0 }, () => ops().make(frame)))
      ),
    ];
  } else {
    cls.constructors = [
      nativeConstructor(cls, [], () => make([])),
      nativeConstructor(
        cls,
        [SIZE_T],
        ([count], { frame }) => {
          const n = asNumber(count);
          reserve(frame, n);
          return make(Array.from({ length: n }, () => ops().make(frame)));
        },
        { isExplicit: true }
      ),
      nativeConstructor(cls, [SIZE_T, constRef(element)], ([count, value], { frame }) => {
        const n = asNumber(count);
        reserve(frame, n);
        const source = (value as Ptr).read();
        return make(Array.from({ length: n }, () => ops().copy(frame, source)));
      }),
      nativeConstructor(cls, [classType(constIterator), classType(constIterator)], ([first, last], { frame }) => {
        const from = first as Ptr;
        const to = last as Ptr;
        if (from.store !== to.store || from.index > to.index) throw new CppRuntimeError('invalidRange');
        const items: Value[] = [];
        for (let index = from.index; index < to.index; index++) items.push(ops().copy(frame, from.store?.get(index)));
        return make(items);
      }),
    ];
  }
  sequenceMethods(library, cls, element, kind, ops, make, grow, reserve, outOfRange, destroyAll, fixedLength);
  return cls;
}

const reserve = (frame: Frame, count: number): void => {
  if (count > MAX_ELEMENTS) throw new CppRuntimeError('custom', 'コンテナの要素が多すぎます。');
  frame.runtime.reserve(count);
};

// code-gauge-allow functionNcss 150 -- The member functions of the sequence containers, which share their storage.
function sequenceMethods(
  library: Library,
  cls: ClassInfo,
  element: Type,
  kind: SequenceKind,
  ops: () => ElementOperations,
  make: (items: Value[]) => SequenceValue,
  grow: (frame: Frame, sequence: SequenceValue, size: number, beforeMove?: () => void) => void,
  reserve: (frame: Frame, count: number) => void,
  outOfRange: (frame: Frame) => never,
  destroyAll: (frame: Frame, items: Value[]) => void,
  fixedLength: number | undefined
): void {
  const type = classType(cls);
  const iterator = classType(cls.memberTypes.get('iterator') as never as ClassInfo) as never as Type;
  const types = {
    iterator: cls.memberTypes.get('iterator') as Type,
    constIterator: cls.memberTypes.get('const_iterator') as Type,
    reverseIterator: cls.memberTypes.get('reverse_iterator') as Type,
    constReverseIterator: cls.memberTypes.get('const_reverse_iterator') as Type,
  };
  void iterator;
  const method = (
    name: string,
    params: Type[],
    ret: Type,
    run: (self: SequenceValue, args: unknown[], frame: Frame) => unknown,
    options: { isConst?: boolean; optional?: number } = {}
  ): void => {
    addMethod(
      cls,
      native(name, params, ret, (args, { self, frame }) => run(self as SequenceValue, args, frame), options)
    );
  };
  method('size', [], SIZE_T, (self) => BigInt(self.items.length), { isConst: true });
  method(
    'max_size',
    [],
    SIZE_T,
    () => (kind === 'array' ? BigInt(fixedLength ?? 0) : 0x7_ff_ff_ff_ff_ff_ff_ffn / BigInt(Math.max(1, 4))),
    { isConst: true }
  );
  method('empty', [], BOOL, (self) => (self.items.length === 0 ? 1 : 0), { isConst: true });
  for (const isConst of [false, true]) {
    const ref = referenceTo(isConst ? withConst(element) : element);
    if (kind !== 'list') {
      method(
        'at',
        [SIZE_T],
        ref,
        (self, [index], frame) => {
          const at = BigInt(index as bigint);
          if (at >= BigInt(self.items.length)) return outOfRange(frame);
          return new Ptr(self, Number(at));
        },
        { isConst }
      );
    }
    method(
      'front',
      [],
      ref,
      (self) => {
        nonEmpty(self);
        return new Ptr(self, 0);
      },
      { isConst }
    );
    method(
      'back',
      [],
      ref,
      (self) => {
        nonEmpty(self);
        return new Ptr(self, self.items.length - 1);
      },
      { isConst }
    );
    method('begin', [], isConst ? types.constIterator : types.iterator, (self) => new Ptr(self, 0), { isConst });
    method('end', [], isConst ? types.constIterator : types.iterator, (self) => new Ptr(self, self.items.length), {
      isConst,
    });
    method(
      'rbegin',
      [],
      isConst ? types.constReverseIterator : types.reverseIterator,
      (self) => new Ptr(self, self.items.length),
      { isConst }
    );
    method('rend', [], isConst ? types.constReverseIterator : types.reverseIterator, (self) => new Ptr(self, 0), {
      isConst,
    });
    if (kind === 'vector' || kind === 'array') {
      method('data', [], pointerTo(isConst ? withConst(element) : element), (self) => new Ptr(self, 0), { isConst });
    }
  }
  method('cbegin', [], types.constIterator, (self) => new Ptr(self, 0), { isConst: true });
  method('cend', [], types.constIterator, (self) => new Ptr(self, self.items.length), { isConst: true });
  method('crbegin', [], types.constReverseIterator, (self) => new Ptr(self, self.items.length), { isConst: true });
  method('crend', [], types.constReverseIterator, (self) => new Ptr(self, 0), { isConst: true });
  method('swap', [referenceTo(type)], VOID, (self, [other]) => {
    const target = (other as Ptr).read() as SequenceValue;
    [self.items, target.items] = [target.items, self.items];
    [self.capacity, target.capacity] = [target.capacity, self.capacity];
  });
  if (kind === 'array') {
    method('fill', [constRef(element)], VOID, (self, [value], frame) => {
      const source = (value as Ptr).read();
      self.items = self.items.map((item) => ops().assign(frame, item, source));
    });
    return;
  }
  method('clear', [], VOID, (self, _args, frame) => {
    const old = self.items;
    self.items = [];
    destroyAll(frame, old);
  });
  const pushBack = (self: SequenceValue, value: Value, frame: Frame): void => {
    reserve(frame, 1);
    grow(frame, self, self.items.length + 1);
    self.items.push(value);
  };
  method('push_back', [constRef(element)], VOID, (self, [value], frame) => {
    const copy = ops().copy(frame, (value as Ptr).read());
    if (kind === 'vector' && self.items.length + 1 > self.capacity) {
      grow(frame, self, self.items.length + 1);
      self.items.push(copy);
    } else pushBack(self, copy, frame);
  });
  method('pop_back', [], VOID, (self, _args, frame) => {
    nonEmpty(self);
    const removed = self.items.pop() as Value;
    ops().destroy?.(frame, removed);
  });
  if (kind === 'deque' || kind === 'list') {
    method('push_front', [constRef(element)], VOID, (self, [value], frame) => {
      reserve(frame, 1);
      self.items.unshift(ops().copy(frame, (value as Ptr).read()));
    });
    method('pop_front', [], VOID, (self, _args, frame) => {
      nonEmpty(self);
      const removed = self.items.shift() as Value;
      ops().destroy?.(frame, removed);
    });
  }
  if (kind === 'vector') {
    method('capacity', [], SIZE_T, (self) => BigInt(self.capacity), { isConst: true });
    method('reserve', [SIZE_T], VOID, (self, [count], frame) => {
      const n = asNumber(count);
      if (BigInt(count as bigint) > 0x3f_ff_ff_ff_ff_ff_ff_ffn)
        throwLibrary(frame, library.exception('length_error'), 'vector');
      if (n > self.capacity) {
        self.capacity = n;
        const { hasEffects, copy, destroy } = ops();
        if (hasEffects) {
          const old = self.items;
          self.items = old.map((item) => copy(frame, item));
          if (destroy) for (const item of old) destroy(frame, item);
        }
      }
    });
    method('shrink_to_fit', [], VOID, (self) => {
      self.capacity = self.items.length;
    });
  }
  if (kind !== 'list') {
    // operator[] is an operator; the members below take positions and iterators.
  }
  const insertAt = (self: SequenceValue, index: number, values: Value[], frame: Frame): Ptr => {
    reserve(frame, values.length);
    grow(frame, self, self.items.length + values.length);
    self.items.splice(index, 0, ...values);
    return new Ptr(self, index);
  };
  method('insert', [types.constIterator, constRef(element)], types.iterator, (self, [at, value], frame) =>
    insertAt(self, positionOf(self, at), [ops().copy(frame, (value as Ptr).read())], frame)
  );
  method(
    'insert',
    [types.constIterator, SIZE_T, constRef(element)],
    types.iterator,
    (self, [at, count, value], frame) => {
      const source = (value as Ptr).read();
      const n = asNumber(count);
      reserve(frame, n);
      return insertAt(
        self,
        positionOf(self, at),
        Array.from({ length: n }, () => ops().copy(frame, source)),
        frame
      );
    }
  );
  method(
    'insert',
    [types.constIterator, types.constIterator, types.constIterator],
    types.iterator,
    (self, [at, first, last], frame) => {
      const from = first as Ptr;
      const to = last as Ptr;
      if (from.store !== to.store || from.index > to.index) throw new CppRuntimeError('invalidRange');
      const values: Value[] = [];
      for (let index = from.index; index < to.index; index++) values.push(ops().copy(frame, from.store?.get(index)));
      return insertAt(self, positionOf(self, at), values, frame);
    }
  );
  method('erase', [types.constIterator], types.iterator, (self, [at], frame) => {
    const index = positionOf(self, at);
    if (index >= self.items.length) throw new CppRuntimeError('invalidIterator');
    const [removed] = self.items.splice(index, 1);
    ops().destroy?.(frame, removed);
    return new Ptr(self, index);
  });
  method('erase', [types.constIterator, types.constIterator], types.iterator, (self, [first, last], frame) => {
    const from = positionOf(self, first);
    const to = positionOf(self, last);
    if (from > to) throw new CppRuntimeError('invalidRange');
    const removed = self.items.splice(from, to - from);
    destroyAll(frame, removed);
    return new Ptr(self, from);
  });
  method('resize', [SIZE_T], VOID, (self, [count], frame) => {
    const n = asNumber(count);
    if (n < self.items.length) destroyAll(frame, self.items.splice(n));
    else {
      reserve(frame, n - self.items.length);
      grow(frame, self, n);
      while (self.items.length < n) self.items.push(ops().make(frame));
    }
  });
  method('resize', [SIZE_T, constRef(element)], VOID, (self, [count, value], frame) => {
    const n = asNumber(count);
    const source = (value as Ptr).read();
    if (n < self.items.length) destroyAll(frame, self.items.splice(n));
    else {
      reserve(frame, n - self.items.length);
      grow(frame, self, n);
      while (self.items.length < n) self.items.push(ops().copy(frame, source));
    }
  });
  method('assign', [SIZE_T, constRef(element)], VOID, (self, [count, value], frame) => {
    const n = asNumber(count);
    reserve(frame, n);
    const source = (value as Ptr).read();
    const old = self.items;
    if (kind === 'vector' && n > self.capacity) self.capacity = n;
    self.items = Array.from({ length: n }, () => ops().copy(frame, source));
    destroyAll(frame, old);
  });
  if (kind === 'list') listMethods(cls, element, ops, method, destroyAll);
  void make;
}

const nonEmpty = (self: SequenceValue): void => {
  if (self.items.length === 0) throw new CppRuntimeError('emptyContainer');
};

const positionOf = (self: SequenceValue, at: unknown): number => {
  const pointer = at as Ptr;
  if (pointer.store !== self || pointer.index < 0 || pointer.index > self.items.length)
    throw new CppRuntimeError('invalidIterator');
  return pointer.index;
};

function listMethods(
  cls: ClassInfo,
  element: Type,
  ops: () => ElementOperations,
  method: (
    name: string,
    params: Type[],
    ret: Type,
    run: (self: SequenceValue, args: unknown[], frame: Frame) => unknown,
    options?: { isConst?: boolean }
  ) => void,
  destroyAll: (frame: Frame, items: Value[]) => void
): void {
  const less = lessThan(element);
  const equal = equalTo(element);
  method('remove', [constRef(element)], SIZE_T, (self, [value], frame) => {
    if (!equal) throw new CppRuntimeError('custom', `${typeName(element)} の値は == で比べられません。`);
    const target = (value as Ptr).read();
    const kept = self.items.filter((item) => !equal(item, target));
    const removed = self.items.filter((item) => equal(item, target));
    self.items = kept;
    destroyAll(frame, removed);
    return BigInt(removed.length);
  });
  method('reverse', [], VOID, (self) => {
    self.items.reverse();
  });
  method('sort', [], VOID, (self) => {
    if (!less) throw new CppRuntimeError('custom', `${typeName(element)} の値は < で比べられません。`);
    // list::sort is a stable merge sort.
    self.items = self.items
      .map((item, index): { item: Value; index: number } => ({ item, index }))
      .toSorted((a, b) => less(a.item, b.item) || a.index - b.index)
      .map(({ item }) => item);
  });
  method('unique', [], SIZE_T, (self, _args, frame) => {
    if (!equal) throw new CppRuntimeError('custom', `${typeName(element)} の値は == で比べられません。`);
    const kept: Value[] = [];
    const removed: Value[] = [];
    for (const item of self.items) {
      if (kept.length > 0 && equal(kept.at(-1), item)) removed.push(item);
      else kept.push(item);
    }
    self.items = kept;
    destroyAll(frame, removed);
    return BigInt(removed.length);
  });
  void cls;
  void ops;
}

/** The operators of the sequence containers: `[]`, `=` from a list, and the comparisons. */
function sequenceOperator(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  element: Type,
  kind: SequenceKind,
  operator: string,
  operands: Expr[],
  row: number
): Expr | undefined {
  const [left, right] = operands;
  const isSelf = (expr: Expr | undefined): boolean => expr?.type.kind === 'class' && expr.type.cls === cls;
  if (operator === '[]' && isSelf(left) && kind !== 'list') {
    const index = compiler.convert(right, SIZE_T, row).run;
    const object = left.isLvalue ? left.run : compiler.materialize(left).run;
    const type = isConstType(left.type) ? withConst(element) : element;
    return {
      type,
      isLvalue: true,
      row,
      run: (frame) => {
        const target = (object(frame) as Ptr).read() as SequenceValue;
        const at = Number(index(frame) as bigint);
        if (at < 0 || at >= target.items.length) throw new CppRuntimeError('outOfBounds');
        return new Ptr(target, at);
      },
    };
  }
  if (['==', '!=', '<', '<=', '>', '>='].includes(operator) && isSelf(left) && isSelf(right)) {
    const compare = operator === '==' || operator === '!=' ? equalTo(element) : lessThan(element);
    if (!compare)
      return compiler.error(
        row,
        `${typeName(element)} の値は ${operator === '==' || operator === '!=' ? '==' : '<'} で比べられません。`
      );
    const a = compiler.rvalue(left).run;
    const b = compiler.rvalue(right).run;
    return {
      type: BOOL,
      isLvalue: false,
      row,
      run: (frame) =>
        compareSequences(operator, (a(frame) as SequenceValue).items, (b(frame) as SequenceValue).items, element)
          ? 1
          : 0,
    };
  }
  return undefined;
}

function compareSequences(operator: string, a: Value[], b: Value[], element: Type): boolean {
  if (operator === '==' || operator === '!=') {
    const equal = equalTo(element) as (x: Value, y: Value) => boolean;
    const same = a.length === b.length && a.every((item, index) => equal(item, b[index]));
    return operator === '==' ? same : !same;
  }
  const less = lessThan(element) as (x: Value, y: Value) => number;
  let order = 0;
  for (let index = 0; index < Math.min(a.length, b.length) && order === 0; index++) order = less(a[index], b[index]);
  if (order === 0) order = a.length - b.length;
  switch (operator) {
    case '<': {
      return order < 0;
    }
    case '<=': {
      return order <= 0;
    }
    case '>': {
      return order > 0;
    }
    default: {
      return order >= 0;
    }
  }
}

/**
 * `std::vector<int> v = {1, 2, 3}`: the elements of an `std::initializer_list`, which the container copies, and
 * `std::array<int, 3> a = {1, 2, 3}`, which initializes the elements as an aggregate does.
 */
function sequenceList(
  compiler: ExpressionCompiler,
  element: Type,
  elements: Syntax[],
  row: number,
  make: (items: Value[]) => SequenceValue,
  fixedLength: number | undefined,
  ops: () => ElementOperations
): Eval<Value> | undefined {
  if (fixedLength !== undefined) {
    if (elements.length > fixedLength)
      return compiler.error(row, `std::array の要素は ${fixedLength} 個なので、初期値が多すぎます。`);
    const inits = elements.map((node) => compiler.elementInitializer(element, node));
    const zero = compiler.valueInitialized(element, row).run as Eval<Value>;
    return (frame) =>
      holdAll(frame, inits, (values) =>
        make(
          Array.from({ length: fixedLength }, (_, index) =>
            index < values.length ? (values[index] as Value) : zero(frame)
          )
        )
      );
  }
  // A list of one or two sizes is still an initializer list of elements when the elements can take them.
  let inits: Eval<Value>[];
  try {
    inits = elements.map((node) => compiler.elementInitializer(element, node));
  } catch (error) {
    if (elements.length > 0 && elements.length <= 2) return undefined;
    throw error;
  }
  return (frame) =>
    holdAll(frame, inits, (values) => {
      const temporaries = values as Value[];
      const { hasEffects, copy, destroy } = ops();
      if (!hasEffects) return make(temporaries);
      // The container copies the initializer list's elements, which then end their lifetime.
      const result = make(temporaries.map((item) => copy(frame, item)));
      if (destroy) for (let index = temporaries.length - 1; index >= 0; index--) destroy(frame, temporaries[index]);
      return result;
    });
}

/** `emplace_back(args...)` and the like, which construct an element in place from constructor arguments. */
function emplacement(
  compiler: ExpressionCompiler,
  library: Library,
  object: Expr,
  member: string,
  args: Expr[],
  row: number,
  element: Type,
  kind: SequenceKind,
  ops: () => ElementOperations,
  grow: (frame: Frame, sequence: SequenceValue, size: number, beforeMove?: () => void) => void
): Expr | undefined {
  if (!['emplace_back', 'emplace_front', 'emplace'].includes(member)) return undefined;
  if (isConstType(object.type))
    return compiler.error(row, `const の ${typeName(object.type)} には ${member} を使えません。`);
  const positionArg = member === 'emplace' ? args[0] : undefined;
  const elementArgs = member === 'emplace' ? args.slice(1) : args;
  const value = constructElement(compiler, element, elementArgs, row);
  const self = compiler.objectOf(object);
  const position = positionArg
    ? compiler.convert(
        positionArg,
        classType(
          object.type.kind === 'class'
            ? (object.type.cls.memberTypes.get('const_iterator') as never as Extract<Type, { kind: 'class' }>).cls
            : library.stringClass
        ),
        row
      ).run
    : undefined;
  const ret: Type =
    member === 'emplace'
      ? object.type.kind === 'class'
        ? (object.type.cls.memberTypes.get('iterator') as Type)
        : VOID
      : referenceTo(element);
  return {
    type: ret.kind === 'reference' ? ret.to : ret,
    isLvalue: ret.kind === 'reference',
    row,
    run: (frame) => {
      const sequence = (self(frame) as Ptr).read() as SequenceValue;
      const at = position ? (position(frame) as Ptr).index : member === 'emplace_front' ? 0 : sequence.items.length;
      const made = value(frame);
      frame.runtime.reserve(1);
      grow(frame, sequence, sequence.items.length + 1);
      sequence.items.splice(at, 0, made);
      return new Ptr(sequence, at);
    },
  };
}

/** Compiles the construction of an element from arguments, as `emplace_back` and the like do. */
export function constructElement(compiler: ExpressionCompiler, element: Type, args: Expr[], row: number): Eval<Value> {
  if (element.kind === 'class') return compiler.constructObject(element.cls, args, row, false).run as Eval<Value>;
  if (args.length === 0) return compiler.valueInitialized(element, row).run as Eval<Value>;
  if (args.length !== 1) return compiler.error(row, `${typeName(element)} の値には引数を1つだけ書いてください。`);
  return compiler.convert(args[0], unqualified(element), row).run as Eval<Value>;
}

export { elementLocation };
