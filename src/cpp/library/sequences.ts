import { CompileError } from '../../interpreter/diagnostics';
import { implicitConversion } from '../conversions';
import { CppRuntimeError, NarrowingConversionError } from '../errors';
import { type ConstantLocation, type Expr, hasConstantObject, type Initializer, offsetConstantLocation } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { constructArray } from '../objectCompiler';
import { type Eval, type Frame, holdAll } from '../runtime';
import type { Syntax } from '../syntax';
import {
  alignOf,
  allowsConstantCopy,
  allowsMemberAssignment,
  BOOL,
  ClassInfo,
  classType,
  type FunctionInfo,
  isConstType,
  isInteger,
  pointerTo,
  referenceTo,
  sameType,
  SIZE_T,
  sizeOf,
  type Type,
  typeName,
  unqualified,
  VOID,
  withConst,
} from '../types';
import { ArrayStore, CObject, holdValues, NULL_PTR, type Ptr, type Value } from '../values';
import { bitReferences } from './bitReference';
import { SequenceValue } from './containerValues';
import {
  callbackOperands,
  comparatorOf,
  constructElementFromRvalue,
  type ElementOperations,
  elementOperations,
  equalTo,
  lessThan,
  locationOf,
  movedArgument,
  requireDefaultConstruction,
  requireElementUse,
  requireMoveConstruction,
  requireRelocation,
  swapElements,
  truthy,
} from './elements';
import { elementLocation, positionOf, randomAccessIterator, rangePositions } from './iterators';
import type { Library } from './registry';
import { listSort, SequenceEditor, type Source } from './sequenceEdits';
import { addMethod, asNumber, constRef, native, nativeConstructor, type NativeOptions, throwLibrary } from './support';
import { typeKey } from './templates';

export type SequenceKind = 'vector' | 'deque' | 'array' | 'list';

const MAX_ELEMENTS = 1_000_000;
const PTRDIFF_MAX = 2n ** 63n - 1n;

/** The type of a library parameter that takes a braced list or a callable as the call wrote it. */
const AS_WRITTEN: Type = { kind: 'function', ret: VOID, params: [] };

/**
 * The element initializers of the lists that `sequenceList` compiled, by the evaluation it gave, so that `v = {...}`
 * assigns the elements as `operator=(initializer_list)` does instead of assigning a container made of them.
 */
const listElements = new WeakMap<Eval<unknown>, Eval<Value>[]>();

/** `std::vector<T>`, `std::deque<T>`, `std::list<T>`, or `std::array<T, N>`, whose objects are `SequenceValue`s. */
export function sequenceClass(library: Library, kind: SequenceKind, element: Type, fixedLength?: number): ClassInfo {
  const name =
    kind === 'array' ? `std::array<${typeName(element)}, ${fixedLength}>` : `std::${kind}<${typeName(element)}>`;
  const key = `${kind}<${typeKey(element)}${kind === 'array' ? `,${fixedLength}` : ''}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  if (element.kind === 'reference') library.compiler.error(0, `${name} の要素を参照にはできません。`);
  if (element.kind === 'void') library.compiler.error(0, `${name} の要素を void にはできません。`);
  if (kind !== 'array' && isConstType(element)) library.compiler.error(0, `${name} の要素を const 型にはできません。`);
  const cls = new ClassInfo(name, 'class');
  cls.isComplete = true;
  cls.isAssignmentDeleted = kind === 'array' && fixedLength !== 0 && !allowsMemberAssignment(element);
  library.instances.set(key, cls);
  let elementOps: ElementOperations | undefined;
  const ops = (): ElementOperations => {
    elementOps ??= elementOperations(library.compiler, element, 0);
    return elementOps;
  };
  const container = name;
  const category = kind === 'list' ? 'bidirectional' : 'randomAccess';
  const bits = kind === 'vector' && element.kind === 'int' && element.name === 'bool' ? bitReferences() : undefined;
  const reverseIterator = randomAccessIterator(library.iterators, container, element, false, true, category, bits);
  const constReverseIterator = randomAccessIterator(library.iterators, container, element, true, true, category, bits);
  if (bits) {
    cls.memberTypes.set('reference', bits.mutable);
    cls.memberTypes.set('const_reference', bits.constant);
  }
  cls.memberTypes.set('value_type', element);
  cls.memberTypes.set('size_type', SIZE_T);
  cls.memberTypes.set(
    'iterator',
    kind === 'array'
      ? pointerTo(element)
      : classType(randomAccessIterator(library.iterators, container, element, false, false, category, bits))
  );
  cls.memberTypes.set(
    'const_iterator',
    kind === 'array'
      ? pointerTo(withConst(element))
      : classType(randomAccessIterator(library.iterators, container, element, true, false, category, bits))
  );
  cls.memberTypes.set('reverse_iterator', classType(reverseIterator));
  cls.memberTypes.set('const_reverse_iterator', classType(constReverseIterator));
  const outOfRange = (frame: Frame): never =>
    throwLibrary(frame, library.exception('out_of_range'), kind === 'array' ? 'array::at' : kind);
  const make = (storage: Value[] | ArrayStore): SequenceValue => {
    const fixed = storage instanceof ArrayStore ? storage : undefined;
    const items = storage instanceof ArrayStore ? storage.values : storage;
    const value = new SequenceValue(items, element, kind !== 'list', kind === 'array' ? undefined : kind, fixed);
    value.capacity = items.length;
    return value;
  };
  // std::array destroys its elements as a built-in array does, from the last.
  const editor = new SequenceEditor(kind === 'array' ? 'vector' : kind, ops);
  // libc++ copies vector elements through the source's mutable storage pointers.
  cls.implicitCopyFromConst = kind !== 'array' || fixedLength === 0 || library.compiler.hasConstCopyParameter(element);
  const ownedCopyFromConst = kind !== 'vector' && cls.implicitCopyFromConst;
  const arrayDefault = (compiler: ExpressionCompiler, row: number, valueInitialize: boolean): Expr['run'] => {
    if (fixedLength === 0) return () => make(new ArrayStore([]));
    const initialize = compiler.withLibraryAccess<Initializer>(() => {
      if (!valueInitialize) return compiler.defaultInitializer(element, row);
      const { run } = compiler.valueInitialized(element, row);
      return (frame, target, zeroInitialize) =>
        run(frame, zeroInitialize, target instanceof CObject ? target : undefined);
    });
    const destroy = compiler.withLibraryAccess(() => compiler.destroyerOf(element, row));
    const length = fixedLength ?? 0;
    return (frame, zeroInitialize) =>
      make(constructArray(frame, length, element, (f, target) => initialize(f, target, zeroInitialize), destroy));
  };
  cls.library = {
    kind,
    args: [element],
    ownedTypes: fixedLength === 0 ? [] : [element],
    ownedCopyFromConst,
    elementUseOnAssignment: kind === 'array' ? undefined : 'assign-and-copy',
    allowsConstantCopy: kind === 'array' && (fixedLength === 0 || allowsConstantCopy(element)),
    size: kind === 'array' ? Math.max(1, fixedLength ?? 0) * sizeOf(element) : kind === 'deque' ? 48 : 24,
    align: kind === 'array' ? alignOf(element) : 8,
    operator: (compiler, operator, operands, row) =>
      sequenceOperator(compiler, cls, element, kind, operator, operands, row, editor, ops),
    aggregateArray:
      fixedLength === undefined ? undefined : { type: { kind: 'array', of: element, length: fixedLength }, make },
    listInitializer:
      fixedLength === undefined
        ? (compiler, elements, row) => sequenceList(compiler, element, elements, row, make, editor)
        : undefined,
    listElementType: fixedLength === undefined ? element : undefined,
    defaultInitializer: kind === 'array' ? arrayDefault : undefined,
    memberCall: (compiler, object, member, args, row) => {
      if (kind !== 'array') {
        const insertion = rvalueInsertion(compiler, object, member, args, row, { kind, element, editor });
        if (insertion) return insertion;
      }
      checkElementRequirement(compiler, { kind, element, ops }, member, args, row);
      return emplacement(compiler, library, object, member, args, row, element, editor);
    },
    constructingMembers:
      kind === 'array'
        ? []
        : kind === 'vector'
          ? ['emplace_back', 'emplace']
          : ['emplace_back', 'emplace', 'emplace_front'],
  };
  cls.operations = {
    copy: (frame, source, _destination, sourceIsConst) => {
      const items = (source as SequenceValue).items;
      if (kind === 'array') {
        const operations = ops();
        return make(
          constructArray(
            frame,
            items.length,
            element,
            (f, target, index) =>
              operations.copy(
                f,
                items[index],
                target instanceof CObject ? target : undefined,
                ownedCopyFromConst || sourceIsConst === true || isConstType(element)
              ),
            operations.destroy
          )
        );
      }
      reserve(frame, items.length);
      return editor.construct(frame, make([]), items.length, (index, destination) =>
        ops().copy(frame, items[index], destination, ownedCopyFromConst)
      );
    },
    assign: (frame, target, source) => {
      const to = target as SequenceValue;
      const from = source as SequenceValue;
      if (to === from) return;
      if (kind === 'array') {
        for (let index = 0; index < to.items.length; index++) {
          to.items[index] = ops().assign(frame, to.items[index], from.items[index]);
        }
        return;
      }
      reserve(frame, Math.max(0, from.items.length - to.items.length));
      editor.assignRange(frame, to, {
        values: from.items,
        construct: (f, value, destination) => ops().copy(f, value, destination, ownedCopyFromConst),
        isSameType: true,
      });
    },
    destroy: (frame, value) => editor.destroy(frame, (value as SequenceValue).items),
  };
  if (kind === 'array') {
    cls.memberTypes.set('size_type', SIZE_T);
    cls.constants.set('\0length', (row) => ({
      type: SIZE_T,
      isLvalue: false,
      row,
      run: () => BigInt(fixedLength ?? 0),
    }));
  } else {
    const countConstructor = nativeConstructor(
      cls,
      [SIZE_T],
      ([count], { frame }) => {
        checkVectorLength(frame, library, kind, element, count);
        const n = asNumber(count);
        reserve(frame, n);
        return editor.construct(frame, make([]), n, (_index, destination) => ops().make(frame, destination));
      },
      {
        isExplicit: true,
        uses: (row) => requireDefaultConstruction(library.compiler, element, row),
      }
    );
    cls.constructors = [
      nativeConstructor(cls, [], () => make([])),
      {
        ...countConstructor,
        // A template only to stop at a call for elements without a default constructor, as libc++ does.
        instantiate: ([count, ...rest]) => {
          if (count && rest.length === 0 && isInteger(unqualified(count.type)) && !ops().isDefaultConstructible) {
            library.compiler.error(
              count.row,
              `${typeName(element)} のオブジェクトは引数なしでは作れないので、${name}(n) には要素の値も渡してください。`
            );
          }
          return countConstructor;
        },
        isTemplate: true,
      },
      nativeConstructor(
        cls,
        [SIZE_T, constRef(element)],
        ([count, value], { frame }) => {
          checkVectorLength(frame, library, kind, element, count);
          const n = asNumber(count);
          reserve(frame, n);
          const source = (value as Ptr).read();
          return editor.construct(frame, make([]), n, (_index, destination) => ops().copy(frame, source, destination));
        },
        { uses: (row) => requireElementUse(library.compiler, element, row, 'copy') }
      ),
      {
        ...nativeConstructor(cls, [], () => {}),
        instantiate: (args) => {
          const range =
            args.length === 2
              ? iteratorRange(library.compiler, args, element, ops, bits ? 'assign' : 'construct')
              : undefined;
          if (!range) return;
          return nativeConstructor(
            cls,
            range.params,
            ([first, last], { frame }) => {
              const source = range.read(first, last);
              reserve(frame, source.values.length);
              return editor.construct(frame, make([]), source.values.length, (index, destination) =>
                source.construct(frame, source.values[index], destination)
              );
            },
            { uses: (row) => library.compiler.requireLibraryObjectUse(element, 'destroy', row) }
          );
        },
        isTemplate: true,
      },
    ];
  }
  sequenceMethods(library, cls, element, kind, ops, editor, outOfRange, fixedLength);
  return cls;
}

const reserve = (frame: Frame, count: number): void => {
  if (count > MAX_ELEMENTS) throw new CppRuntimeError('custom', 'コンテナの要素が多すぎます。');
  frame.runtime.reserve(count);
};

/**
 * `max_size()` of libc++ on arm64: as many elements, or nodes of a list, as the allocator can allocate, and at most
 * PTRDIFF_MAX.
 */
function maxSizeOf(kind: SequenceKind, element: Type): bigint {
  const nodeAlign = Math.max(8, alignOf(element));
  const size = kind === 'list' ? Math.ceil((16 + sizeOf(element)) / nodeAlign) * nodeAlign : sizeOf(element);
  const count = (2n ** 64n - 1n) / BigInt(size);
  return count < PTRDIFF_MAX ? count : PTRDIFF_MAX;
}

/** Throws the `std::length_error` that libc++ throws for a vector of more than `max_size()` elements. */
function checkVectorLength(frame: Frame, library: Library, kind: SequenceKind, element: Type, count: unknown): void {
  if (kind === 'vector' && BigInt(count as bigint) > maxSizeOf(kind, element))
    throwLibrary(frame, library.exception('length_error'), 'vector');
}

/** The iterators of a range, with what `read` needs to take the elements between two of them. */
interface IteratorRange {
  params: Type[];
  /** Whether the iterators only go forward, as those of the unordered containers do. */
  isForwardOnly: boolean;
  read: (first: unknown, last: unknown) => Source;
}

/**
 * Resolves a pair of iterators whose elements can initialize the destination. Range operations that write to live
 * elements, including libc++'s bit-proxy range constructor, use implicit conversion.
 */
export function iteratorRange(
  compiler: ExpressionCompiler,
  [first, last]: Expr[],
  element: Type,
  ops: () => ElementOperations,
  output: 'construct' | 'assign' = 'construct'
): IteratorRange | undefined {
  const params = [first, last].map((arg) =>
    arg.type.kind === 'array' ? pointerTo(arg.type.of) : unqualified(arg.type)
  );
  const [input, end] = params.map((type) => iteratorElement(type));
  if (!input || !end || !sameType(params[0], params[1])) return;
  const type = params[0];
  const proxy = type.kind === 'class' ? type.cls.library?.iteratorReference : undefined;
  const from = proxy ?? input;
  const isReverse = type.kind === 'class' && type.cls.library?.isReverse === true;
  const target = unqualified(element);
  const isSameType =
    typeName(unqualified(from)) === typeName(target) &&
    (target.kind !== 'class' || (from.kind === 'class' && from.cls === target.cls));
  const sourceIsConst = isConstType(from);
  let construct: Source['construct'] = (frame, value, destination) =>
    ops().copy(frame, value, destination, sourceIsConst);
  if (isSameType) requireElementUse(compiler, element, first.row, 'copy', sourceIsConst);
  if (!isSameType) {
    const [slot] = callbackOperands([{ type: from, category: proxy ? 'prvalue' : undefined }], first.row, (frame) =>
      frame.pending.at(-1)
    );
    let run: Expr['run'];
    try {
      run =
        output === 'assign'
          ? compiler.withLibraryAccess(() => compiler.convert(slot, target, first.row)).run
          : elementConstruction(compiler, target, [slot], first.row).run;
    } catch (error) {
      if (error instanceof CompileError) return;
      throw error;
    }
    construct = (frame, value, destination) =>
      holdValues(frame, [proxy ? value : locationOf(value)], () => run(frame, undefined, destination) as Value);
  }
  return {
    params,
    isForwardOnly: type.kind === 'class' && type.cls.name.startsWith('std::unordered_'),
    read: (a, b) => ({
      values: rangeValues(a as Ptr, b as Ptr, isReverse, proxy !== undefined),
      construct,
      isSameType,
    }),
  };
}

function iteratorElement(type: Type): Type | undefined {
  if (type.kind === 'pointer' && type.to.kind !== 'void' && type.to.kind !== 'function') return type.to;
  if (type.kind === 'class' && type.cls.library?.kind === 'iterator') return type.cls.library.args[0];
  return undefined;
}

/** The values between two iterators of a sequence, a container, or an array. */
function rangeValues(first: Ptr, last: Ptr, isReverse: boolean, keepsLocations: boolean): Value[] {
  const length = first.rangeLength(last, isReverse);
  if (length === 0) return [];
  const store = first.target();
  const start = first.index - (isReverse ? 1 : 0);
  return Array.from({ length }, (_, offset) => {
    const index = start + (isReverse ? -offset : offset);
    return keepsLocations ? store.location(index) : store.get(index);
  });
}

/** A member function template, such as `insert(position, first, last)`, whose instance the call's arguments decide. */
function addTemplateMethod(
  cls: ClassInfo,
  name: string,
  instantiate: (args: Expr[]) => FunctionInfo | undefined
): void {
  addMethod(cls, { ...native(name, [], VOID, () => {}), instantiate, isTemplate: true });
}

// code-gauge-allow functionNcss 150 -- The member functions of the sequence containers, which share their storage.
function sequenceMethods(
  library: Library,
  cls: ClassInfo,
  element: Type,
  kind: SequenceKind,
  ops: () => ElementOperations,
  editor: SequenceEditor,
  outOfRange: (frame: Frame) => never,
  fixedLength: number | undefined
): void {
  const type = classType(cls);
  const types = {
    iterator: cls.memberTypes.get('iterator') as Type,
    constIterator: cls.memberTypes.get('const_iterator') as Type,
    reverseIterator: cls.memberTypes.get('reverse_iterator') as Type,
    constReverseIterator: cls.memberTypes.get('const_reverse_iterator') as Type,
  };
  const method = (
    name: string,
    params: Type[],
    ret: Type,
    run: (self: SequenceValue, args: unknown[], frame: Frame) => unknown,
    options: NativeOptions = {}
  ): void => {
    addMethod(
      cls,
      native(name, params, ret, (args, { self, frame }) => run(self as SequenceValue, args, frame), options)
    );
  };
  const instance = (
    name: string,
    params: Type[],
    ret: Type,
    run: (self: SequenceValue, args: unknown[], frame: Frame) => unknown
  ): FunctionInfo =>
    native(name, params, ret, (args, { self, frame }) => run(self as SequenceValue, args, frame), { owner: cls });
  const iteratorAt = (self: SequenceValue, index: number): Ptr =>
    fixedLength === 0 ? NULL_PTR : self.iteratorLocation(index);
  const begin = (self: SequenceValue): Ptr => iteratorAt(self, 0);
  const end = (self: SequenceValue): Ptr => iteratorAt(self, self.items.length);
  const endConstant = (object: Expr): ConstantLocation | undefined => constantArrayLocation(object, fixedLength);
  method('size', [], SIZE_T, (self) => BigInt(self.items.length), { isConst: true });
  method('max_size', [], SIZE_T, () => (kind === 'array' ? BigInt(fixedLength ?? 0) : maxSizeOf(kind, element)), {
    isConst: true,
  });
  method('empty', [], BOOL, (self) => (self.items.length === 0 ? 1 : 0), { isConst: true });
  const bitProxy = cls.memberTypes.get('reference');
  if (bitProxy) {
    method('flip', [], VOID, (self, _args, frame) => {
      frame.runtime.spend(Math.ceil(self.items.length / 64));
      for (const [index, bit] of self.items.entries()) self.items[index] = bit === 0 ? 1 : 0;
    });
  }
  for (const isConst of [false, true]) {
    const ref =
      cls.memberTypes.get(isConst ? 'const_reference' : 'reference') ??
      referenceTo(isConst ? withConst(element) : element);
    if (kind !== 'list') {
      method(
        'at',
        [SIZE_T],
        ref,
        (self, [index], frame) => {
          const at = BigInt(index as bigint);
          if (at >= BigInt(self.items.length)) return outOfRange(frame);
          return self.location(Number(at));
        },
        { isConst, constantAccess: (object, [index]) => constantArrayLocation(object, index?.constant) }
      );
    }
    method(
      'front',
      [],
      ref,
      (self) => {
        nonEmpty(self);
        return self.location(0);
      },
      { isConst, constantAccess: (object) => constantArrayLocation(object, 0) }
    );
    method(
      'back',
      [],
      ref,
      (self) => {
        nonEmpty(self);
        return self.location(self.items.length - 1);
      },
      { isConst, constantAccess: (object) => constantArrayLocation(object, (fixedLength ?? 0) - 1) }
    );
    method('begin', [], isConst ? types.constIterator : types.iterator, begin, {
      isConst,
      constantAccess: constantArrayStart,
    });
    method('end', [], isConst ? types.constIterator : types.iterator, end, {
      isConst,
      constantAccess: endConstant,
    });
    method('rbegin', [], isConst ? types.constReverseIterator : types.reverseIterator, end, { isConst });
    method('rend', [], isConst ? types.constReverseIterator : types.reverseIterator, begin, {
      isConst,
    });
    if ((kind === 'vector' || kind === 'array') && !bitProxy) {
      method(
        'data',
        [],
        pointerTo(isConst ? withConst(element) : element),
        (self) => (self.capacity === 0 ? NULL_PTR : self.location(0)),
        {
          isConst,
          constantAccess: constantArrayStart,
        }
      );
    }
  }
  method('cbegin', [], types.constIterator, begin, { isConst: true, constantAccess: constantArrayStart });
  method('cend', [], types.constIterator, end, { isConst: true, constantAccess: endConstant });
  method('crbegin', [], types.constReverseIterator, end, {
    isConst: true,
  });
  method('crend', [], types.constReverseIterator, begin, { isConst: true });
  method(
    'swap',
    [referenceTo(type)],
    VOID,
    (self, [other], frame) => {
      const target = (other as Ptr).read() as SequenceValue;
      if (kind === 'array') {
        const operations = ops();
        for (let index = 0; index < self.length; index++)
          swapElements(frame, self.location(index), target.location(index), operations);
      } else {
        self.swapItems(target);
      }
    },
    {
      uses:
        kind === 'array' && fixedLength !== 0
          ? (row) => requireElementUse(library.compiler, element, row, 'swap')
          : undefined,
    }
  );
  if (kind === 'array') {
    method(
      'fill',
      [constRef(element)],
      VOID,
      (self, [value], frame) => {
        const source = (value as Ptr).read();
        const { assign } = ops();
        for (const [index, item] of self.items.entries()) {
          self.items[index] = assign(frame, item, source);
        }
      },
      {
        uses:
          fixedLength !== 0 || isConstType(element)
            ? (row) => requireElementUse(library.compiler, element, row, 'assign')
            : undefined,
      }
    );
    return;
  }
  method('clear', [], VOID, (self, _args, frame) => editor.truncate(frame, self, 0));
  method('push_back', [constRef(element)], VOID, (self, [value], frame) => {
    reserve(frame, 1);
    editor.append(frame, self, 1, (target) => ops().copy(frame, (value as Ptr).read(), target));
  });
  method('pop_back', [], VOID, (self, _args, frame) => {
    nonEmpty(self);
    editor.truncate(frame, self, self.items.length - 1);
  });
  if (kind === 'deque' || kind === 'list') {
    method('push_front', [constRef(element)], VOID, (self, [value], frame) => {
      reserve(frame, 1);
      self.splice(0, 0, ops().copy(frame, (value as Ptr).read()));
    });
    method('pop_front', [], VOID, (self, _args, frame) => {
      nonEmpty(self);
      editor.removeFront(frame, self);
    });
  }
  if (kind === 'vector') {
    method('capacity', [], SIZE_T, (self) => BigInt(self.capacity), { isConst: true });
    method('reserve', [SIZE_T], VOID, (self, [count], frame) => {
      checkVectorLength(frame, library, kind, element, count);
      const n = asNumber(count);
      if (n > self.capacity) editor.reallocate(frame, self, n);
    });
    method('shrink_to_fit', [], VOID, (self, _args, frame) => {
      if (self.capacity > self.length) editor.reallocate(frame, self, self.length);
    });
  }
  const copiesElement = { uses: (row: number) => requireElementUse(library.compiler, element, row, 'copy') };
  method(
    'insert',
    [types.constIterator, constRef(element)],
    types.iterator,
    (self, [at, value], frame) => {
      const index = positionOf(self, at);
      reserve(frame, 1);
      editor.insert(frame, self, index, value as Ptr);
      return self.iteratorLocation(index);
    },
    copiesElement
  );
  method(
    'insert',
    [types.constIterator, SIZE_T, constRef(element)],
    types.iterator,
    (self, [at, count, value], frame) => {
      const index = positionOf(self, at);
      checkVectorLength(frame, library, kind, element, BigInt(self.items.length) + BigInt(count as bigint));
      const n = asNumber(count);
      reserve(frame, n);
      editor.insertCopies(frame, self, index, n, value as Ptr);
      return self.iteratorLocation(index);
    },
    copiesElement
  );
  addTemplateMethod(cls, 'insert', (args) => {
    if (args.length === 2 && args[1].braced) {
      const list = initializerList(library.compiler, element, args[1].braced, ops);
      return instance('insert', [types.constIterator, AS_WRITTEN], types.iterator, (self, [at], frame) => {
        const index = positionOf(self, at);
        list(frame, (source) => {
          reserve(frame, source.values.length);
          editor.insertRange(frame, self, index, source, false);
        });
        return self.iteratorLocation(index);
      });
    }
    const range =
      args.length === 3
        ? iteratorRange(library.compiler, args.slice(1), element, ops, kind === 'list' ? 'construct' : 'assign')
        : undefined;
    if (!range) return;
    return instance(
      'insert',
      [types.constIterator, ...range.params],
      types.iterator,
      (self, [at, first, last], frame) => {
        const index = positionOf(self, at);
        const source = range.read(first, last);
        reserve(frame, source.values.length);
        editor.insertRange(frame, self, index, source, range.isForwardOnly);
        return self.iteratorLocation(index);
      }
    );
  });
  method('erase', [types.constIterator], types.iterator, (self, [at], frame) => {
    const index = positionOf(self, at, false);
    editor.erase(frame, self, index, index + 1);
    return self.iteratorLocation(index);
  });
  method('erase', [types.constIterator, types.constIterator], types.iterator, (self, [first, last], frame) => {
    const [from, to] = rangePositions(self, first, last);
    editor.erase(frame, self, from, to);
    return self.iteratorLocation(from);
  });
  method('resize', [SIZE_T], VOID, (self, [count], frame) => {
    checkVectorLength(frame, library, kind, element, count);
    const n = asNumber(count);
    reserve(frame, Math.max(0, n - self.items.length));
    editor.resize(frame, self, n, (target) => ops().make(frame, target));
  });
  method('resize', [SIZE_T, constRef(element)], VOID, (self, [count, value], frame) => {
    checkVectorLength(frame, library, kind, element, count);
    const n = asNumber(count);
    reserve(frame, Math.max(0, n - self.items.length));
    editor.resize(frame, self, n, (target) => ops().copy(frame, (value as Ptr).read(), target));
  });
  method(
    'assign',
    [SIZE_T, constRef(element)],
    VOID,
    (self, [count, value], frame) => {
      checkVectorLength(frame, library, kind, element, count);
      const n = asNumber(count);
      reserve(frame, n);
      editor.assignCopies(frame, self, n, value as Ptr);
    },
    copiesElement
  );
  addTemplateMethod(cls, 'assign', (args) => {
    if (args.length === 1 && args[0].braced) {
      const list = initializerList(library.compiler, element, args[0].braced, ops);
      return instance('assign', [AS_WRITTEN], VOID, (self, _args, frame) =>
        list(frame, (source) => {
          reserve(frame, source.values.length);
          editor.assignRange(frame, self, source);
        })
      );
    }
    const range = args.length === 2 ? iteratorRange(library.compiler, args, element, ops, 'assign') : undefined;
    if (!range) return;
    return instance('assign', range.params, VOID, (self, [first, last], frame) => {
      const source = range.read(first, last);
      reserve(frame, source.values.length);
      editor.assignRange(frame, self, source);
    });
  });
  if (kind === 'list') listMethods(library, cls, element, method, editor);
}

/**
 * The elements of a braced list argument, such as the `{1, 2}` of `v.insert(p, {1, 2})`, which `use` gets as the
 * elements of an `std::initializer_list`: temporaries that end their lifetime afterward, the last first.
 */
export function initializerList(
  compiler: ExpressionCompiler,
  element: Type,
  list: Syntax,
  ops: () => ElementOperations
): (frame: Frame, use: (source: Source) => void) => void {
  requireElementUse(compiler, element, list.row, 'copy');
  return listElementsOf(
    list.children.map((node) => compiler.elementInitializer(element, node)),
    ops
  );
}

export function listElementsOf(
  inits: Eval<Value>[],
  ops: () => ElementOperations
): <T>(frame: Frame, use: (source: Source) => T) => T {
  return (frame, use) => {
    const { destroy, copy } = ops();
    const mark = frame.pending.length;
    const values: Value[] = [];
    try {
      for (const init of inits) {
        const object = init(frame);
        values.push(object);
        frame.pending.push(object);
        if (destroy) frame.temporaries.push({ object, destroy });
      }
      return use({ values, construct: copy, isSameType: true });
    } finally {
      frame.pending.length = mark;
    }
  };
}

const nonEmpty = (self: SequenceValue): void => {
  if (self.items.length === 0) throw new CppRuntimeError('emptyContainer');
};

function listMethods(
  library: Library,
  cls: ClassInfo,
  element: Type,
  method: (
    name: string,
    params: Type[],
    ret: Type,
    run: (self: SequenceValue, args: unknown[], frame: Frame) => unknown,
    options?: { isConst?: boolean }
  ) => void,
  editor: SequenceEditor
): void {
  const less = lessThan(element);
  const equal = equalTo(element);
  // `checkElementRequirement` stops a call of these members for elements without == or <.
  method('remove', [constRef(element)], SIZE_T, (self, [value], frame) => {
    if (!equal) throw new CppRuntimeError('custom', `${typeName(element)} の値は == で比べられません。`);
    const target = (value as Ptr).read();
    let count = 0;
    self.reorder(
      (items) => items.filter(({ value: item }) => !equal(item, target)),
      (removed) => {
        count = removed.length;
        editor.destroy(frame, removed);
      }
    );
    return BigInt(count);
  });
  method('reverse', [], VOID, (self) => {
    self.reorder((items) => items.toReversed());
  });
  method('sort', [], VOID, (self) => {
    if (!less) throw new CppRuntimeError('custom', `${typeName(element)} の値は < で比べられません。`);
    self.reorder((items) => listSort(items, (a, b) => less(a.value, b.value) < 0));
  });
  const unique = (self: SequenceValue, frame: Frame, same: (a: Value, b: Value) => boolean): bigint => {
    let count = 0;
    let first: Value;
    self.reorder(
      (items) =>
        items.filter(({ value }, index) => {
          if (index > 0 && same(first, value)) return false;
          first = value;
          return true;
        }),
      (removed) => {
        count = removed.length;
        editor.destroy(frame, removed);
      }
    );
    return BigInt(count);
  };
  method('unique', [], SIZE_T, (self, _args, frame) => {
    if (!equal) throw new CppRuntimeError('custom', `${typeName(element)} の値は == で比べられません。`);
    return unique(self, frame, equal);
  });
  /** A comparator or predicate argument, given as a function's name or a function object. */
  const callable = (args: Expr[]): ((frame: Frame, a: Value, b: Value) => boolean) | undefined => {
    const [arg] = args;
    if (args.length !== 1) return;
    const call = comparatorOf(library.compiler, unqualified(arg.type), arg.functions, unqualified(element), arg.row);
    return call ? (frame, a, b) => truthy(call(frame, a, b)) : undefined;
  };
  addTemplateMethod(cls, 'sort', (args) => {
    const compare = callable(args);
    if (!compare) return;
    return native(
      'sort',
      callableParams(args),
      VOID,
      (_args, { self, frame }) => {
        const list = self as SequenceValue;
        list.reorder((items) => listSort(items, (a, b) => compare(frame, a.value, b.value)));
      },
      { owner: cls }
    );
  });
  addTemplateMethod(cls, 'unique', (args) => {
    const same = callable(args);
    if (!same) return;
    return native(
      'unique',
      callableParams(args),
      SIZE_T,
      (_args, { self, frame }) => unique(self as SequenceValue, frame, (a, b) => same(frame, a, b)),
      { owner: cls }
    );
  });
}

/**
 * Stops at a call of a member function that needs of the elements what they lack, as instantiating it does in libc++:
 * `resize(n)` a default constructor, and the list's `remove(value)`, `unique()`, and `sort()` `==` or `<`.
 */
function checkElementRequirement(
  compiler: ExpressionCompiler,
  { kind, element, ops }: { kind: SequenceKind; element: Type; ops: () => ElementOperations },
  member: string,
  args: Expr[],
  row: number
): void {
  if (member === 'resize' && args.length === 1 && !ops().isDefaultConstructible) {
    compiler.error(
      row,
      `${typeName(element)} のオブジェクトは引数なしでは作れないので、resize には要素の値も渡してください。`
    );
  }
  if (member === 'resize' && args.length === 1) requireDefaultConstruction(compiler, element, row);
  if (
    kind === 'vector' &&
    ['reserve', 'shrink_to_fit', 'resize', 'emplace', 'emplace_back', 'push_back', 'insert'].includes(member)
  ) {
    requireRelocation(compiler, element, row);
  }
  if (member === 'push_back' || member === 'push_front' || (member === 'resize' && args.length > 1)) {
    requireElementUse(compiler, element, row, 'copy');
  }
  const shifts = kind === 'vector' || kind === 'deque';
  if (member === 'assign' || (shifts && member === 'insert')) requireElementUse(compiler, element, row, 'assign');
  if (shifts && ['emplace', 'insert', 'erase'].includes(member)) {
    if (member !== 'erase') requireMoveConstruction(compiler, element, row);
    compiler.requireLibraryObjectUse(element, 'move-assign', row);
  }
  if (kind !== 'list') return;
  const isEqualityCall = (member === 'remove' && args.length === 1) || (member === 'unique' && args.length === 0);
  if (isEqualityCall && !equalTo(element)) compiler.error(row, `${typeName(element)} の値は == で比べられません。`);
  if (member === 'sort' && args.length === 0 && !lessThan(element))
    compiler.error(row, `${typeName(element)} の値は < で比べられません。比べ方を表す関数を渡してください。`);
}

function rvalueInsertion(
  compiler: ExpressionCompiler,
  object: Expr,
  member: string,
  args: Expr[],
  row: number,
  { kind, element, editor }: { kind: Exclude<SequenceKind, 'array'>; element: Type; editor: SequenceEditor }
): Expr | undefined {
  const isInsert = member === 'insert' && args.length === 2;
  const isBack = member === 'push_back' && args.length === 1;
  const isFront = member === 'push_front' && kind !== 'vector' && args.length === 1;
  if ((!isInsert && !isBack && !isFront) || object.type.kind !== 'class' || element.kind !== 'class') return;
  const argument = args[isInsert ? 1 : 0];
  if (isInsert && argument.braced && listArgumentMatches(compiler, argument.braced, element)) return;
  const source = movedArgument(compiler, element, argument);
  if (!source) return;
  if (isConstType(object.type)) compiler.error(row, `const の ${typeName(object.type)} には ${member} を使えません。`);
  if (kind === 'vector') requireRelocation(compiler, element, row);
  if (isInsert && kind !== 'list') compiler.requireLibraryObjectUse(element, 'move-assign', row);
  requireMoveConstruction(compiler, element, row);
  const self = compiler.objectOf(object);
  const { memberTypes } = object.type.cls;
  const position = isInsert ? compiler.convert(args[0], memberTypes.get('const_iterator') as Type, row).run : undefined;
  return {
    type: isInsert ? (memberTypes.get('iterator') as Type) : VOID,
    row,
    isLvalue: false,
    run: (frame) =>
      holdAll(frame, [self, position ?? (() => {}), source], ([receiver, where, value]) => {
        const sequence = (receiver as Ptr).read() as SequenceValue;
        const location = value as Ptr;
        const index = isInsert ? positionOf(sequence, where) : undefined;
        reserve(frame, 1);
        if (index !== undefined) {
          editor.insert(frame, sequence, index, location, true);
          return sequence.iteratorLocation(index);
        }
        const make = (target?: CObject): Value => constructElementFromRvalue(frame, element, location.read(), target);
        if (isFront) sequence.splice(0, 0, make());
        else editor.append(frame, sequence, 1, make);
        return;
      }),
  };
}

function listArgumentMatches(compiler: ExpressionCompiler, list: Syntax, element: Type): boolean {
  return list.children.every((node) => implicitConversion(compiler, compiler.argument(node), element) !== undefined);
}

/** The parameter of a member function taking a comparator or a predicate, as a function's name or an object. */
const callableParams = (args: Expr[]): Type[] => [args[0].functions ? AS_WRITTEN : unqualified(args[0].type)];

/** The operators of the sequence containers: `[]`, `=` from a list or a temporary, and the comparisons. */
function sequenceOperator(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  element: Type,
  kind: SequenceKind,
  operator: string,
  operands: Expr[],
  row: number,
  editor: SequenceEditor,
  ops: () => ElementOperations
): Expr | undefined {
  const [left, right] = operands;
  const isSelf = (expr: Expr | undefined): boolean => expr?.type.kind === 'class' && expr.type.cls === cls;
  if (operator === '[]' && isSelf(left) && kind !== 'list') {
    const index = compiler.convert(right, SIZE_T, row);
    const object = left.isLvalue ? left.run : compiler.materialize(left).run;
    const isConst = isConstType(left.type);
    const proxy = cls.memberTypes.get(isConst ? 'const_reference' : 'reference');
    const type = proxy ?? (isConst ? withConst(element) : element);
    const constantLocation = constantArrayLocation(left, index.constant);
    return {
      type,
      isLvalue: !proxy,
      staticAddress: hasConstantObject(constantLocation),
      constantInitialization: hasConstantObject(constantLocation),
      constantLocation,
      row,
      run: (frame) => {
        const target = (object(frame) as Ptr).read() as SequenceValue;
        const at = Number(index.run(frame));
        if (at < 0 || at >= target.items.length) throw new CppRuntimeError('outOfBounds');
        return target.location(at);
      },
    };
  }
  if (operator === '=' && kind !== 'array' && isSelf(left)) {
    return assignment(compiler, left, right, row, isSelf(right), editor, ops);
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

function constantArrayStart(object: Expr): ConstantLocation | undefined {
  return constantArrayLocation(object, 0);
}

function constantArrayLocation(object: Expr, index: number | bigint | undefined): ConstantLocation | undefined {
  if (!object.staticAddress || !object.constantInitialization || object.type.kind !== 'class') return;
  const length = object.type.cls.library?.aggregateArray?.type.length;
  if (length !== undefined) return offsetConstantLocation({ index: 0, length }, index);
}

/**
 * `v = {...}`, which assigns the list's elements over the existing ones as `assign` does, and `v = temporary`, which
 * moves the temporary's elements as the move assignment operator does. Gives undefined for a copy assignment.
 */
function assignment(
  compiler: ExpressionCompiler,
  left: Expr,
  right: Expr,
  row: number,
  isSameClass: boolean,
  editor: SequenceEditor,
  ops: () => ElementOperations
): Expr | undefined {
  const listInits = right.isAssignmentList ? listElements.get(right.run) : undefined;
  if (!listInits && !(isSameClass && right.isTemporaryObject)) return undefined;
  compiler.checkAssignable(left, row, '=');
  const target = left.run;
  // C++17 evaluates the right operand of an assignment first.
  if (listInits) {
    requireElementUse(compiler, ops().type, row, 'assign');
    const list = listElementsOf(listInits, ops);
    return {
      type: left.type,
      isLvalue: true,
      row,
      run: (frame) => {
        let place: Ptr | undefined;
        list(frame, (source) => {
          place = target(frame) as Ptr;
          editor.assignRange(frame, place.read() as SequenceValue, source);
        });
        return place as Ptr;
      },
    };
  }
  const source = compiler.materialize(right).run;
  return {
    type: left.type,
    isLvalue: true,
    row,
    run: (frame) => {
      const from = (source(frame) as Ptr).read() as SequenceValue;
      const place = target(frame) as Ptr;
      editor.moveAssign(frame, place.read() as SequenceValue, from);
      return place;
    },
  };
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
  elements: readonly Syntax[],
  row: number,
  make: (items: Value[]) => SequenceValue,
  editor: SequenceEditor
): Eval<Value> | undefined {
  const args = elements.map((node) => compiler.argument(node));
  const canUseOtherConstructors = args.length > 0 && args.length <= 2;
  if (canUseOtherConstructors && args.some((arg) => !arg.braced && !implicitConversion(compiler, arg, element)))
    return undefined;
  let inits: Eval<Value>[];
  try {
    inits = args.map((arg) =>
      arg.braced
        ? compiler.listInitializer(element, arg.braced, arg.row)
        : compiler.copyInitializer(element, arg, arg.row, true)
    );
  } catch (error) {
    if (
      canUseOtherConstructors &&
      error instanceof CompileError &&
      !(error instanceof NarrowingConversionError) &&
      args.some((arg) => arg.braced)
    )
      return undefined;
    throw error;
  }
  if (elements.length > 0) requireElementUse(compiler, element, row, 'copy');
  const list = listElementsOf(inits, () => editor.ops);
  const run: Eval<Value> = (frame) =>
    list(frame, ({ values, construct }) =>
      editor.ops.destroy
        ? editor.construct(frame, make([]), values.length, (index, destination) =>
            construct(frame, values[index], destination)
          )
        : make(values)
    );
  listElements.set(run, inits);
  return run;
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
  editor: SequenceEditor
): Expr | undefined {
  if (!['emplace_back', 'emplace_front', 'emplace'].includes(member)) return undefined;
  if (isConstType(object.type))
    return compiler.error(row, `const の ${typeName(object.type)} には ${member} を使えません。`);
  const positionArg = member === 'emplace' ? args[0] : undefined;
  if (member === 'emplace' && !positionArg) return compiler.error(row, 'emplace には挿入位置を書いてください。');
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
      : ((object.type.kind === 'class' ? object.type.cls.memberTypes.get('reference') : undefined) ??
        referenceTo(element));
  return {
    type: ret.kind === 'reference' ? ret.to : ret,
    isLvalue: ret.kind === 'reference',
    row,
    run: (frame) => {
      const sequence = (self(frame) as Ptr).read() as SequenceValue;
      frame.runtime.reserve(1);
      if (member === 'emplace_front') {
        sequence.splice(0, 0, value(frame));
        return sequence.location(0);
      }
      if (member === 'emplace_back') {
        editor.append(frame, sequence, 1, (target) => value(frame, target));
        return sequence.location(sequence.items.length - 1);
      }
      const at = positionOf(sequence, (position as Eval)(frame));
      editor.emplace(frame, sequence, at, (target) => value(frame, target));
      return sequence.iteratorLocation(at);
    },
  };
}

/** Compiles the construction of an element from arguments, as `emplace_back` and the like do. */
export function constructElement(
  compiler: ExpressionCompiler,
  element: Type,
  args: Expr[],
  row: number
): (frame: Frame, destination?: CObject) => Value {
  const { run } = elementConstruction(compiler, element, args, row);
  return (frame, destination) => run(frame, undefined, destination) as Value;
}

export function elementConstruction(compiler: ExpressionCompiler, element: Type, args: Expr[], row: number): Expr {
  return compiler.withLibraryAccess(() => {
    const source =
      args.length === 1 && sameType(element, args[0].type, false)
        ? movedArgument(compiler, element, args[0])
        : undefined;
    if (source) {
      requireMoveConstruction(compiler, element, row);
      return {
        type: element,
        isLvalue: false,
        row,
        run: (frame, _zeroInitialize, destination) =>
          constructElementFromRvalue(frame, element, source(frame).read(), destination),
      };
    }
    if (element.kind === 'class') return compiler.constructObject(element.cls, args, row, false);
    if (args.length === 0) return compiler.valueInitialized(element, row);
    if (args.length !== 1) return compiler.error(row, `${typeName(element)} の値には引数を1つだけ書いてください。`);
    const argument = compiler.directInitializerArgument(element, args[0]);
    return compiler.convert(argument, unqualified(element), row);
  });
}

export { elementLocation };
