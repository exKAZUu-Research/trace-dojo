import { CppRuntimeError } from '../errors';
import type { Frame } from '../runtime';
import {
  BOOL,
  ClassInfo,
  classType,
  isConstType,
  referenceTo,
  SIZE_T,
  type Type,
  typeName,
  VOID,
  withConst,
} from '../types';
import { type Ptr, type Value } from '../values';
import { comparatorOrder } from './associative';
import { SequenceValue } from './containerValues';
import { type ElementOperations, elementOperations } from './elements';
import type { Library } from './registry';
import { SequenceEditor } from './sequenceEdits';
import { constructElement, iteratorRange, sequenceClass } from './sequences';
import { addMethod, constRef, native, nativeConstructor } from './support';
import { typeKey } from './templates';
import { functorClass } from './utility';

/** `std::stack<T>`, `std::queue<T>`, or `std::priority_queue<T, Container, Compare>`, over a `SequenceValue`. */
export function adapterClass(
  library: Library,
  kind: 'stack' | 'queue' | 'priority_queue',
  element: Type,
  container: Type | undefined,
  comparator: Type | undefined
): ClassInfo {
  const storage =
    container?.kind === 'class'
      ? container
      : classType(sequenceClass(library, kind === 'priority_queue' ? 'vector' : 'deque', element));
  const compareType =
    kind === 'priority_queue' ? (comparator ?? classType(functorClass(library, 'less', element))) : undefined;
  const key = `${kind}<${typeKey(element)},${typeKey(storage)},${compareType ? typeKey(compareType) : ''}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  const name = `std::${kind}<${typeName(element)}${container || comparator ? `, ${typeName(storage)}` : ''}${comparator ? `, ${typeName(comparator)}` : ''}>`;
  const cls = new ClassInfo(name, 'class');
  library.instances.set(key, cls);
  cls.isComplete = true;
  const compiler = library.compiler;
  const order = kind === 'priority_queue' ? comparatorOrder(compiler, element, comparator, 0) : undefined;
  const less = (a: Value, b: Value): boolean => (order as (x: Value, y: Value) => number)(a, b) < 0;
  let elementOps: ElementOperations | undefined;
  const ops = (): ElementOperations => {
    elementOps ??= elementOperations(compiler, element, 0);
    return elementOps;
  };
  const storageKind = storage.cls.library?.kind;
  const editor = new SequenceEditor(storageKind === 'deque' || storageKind === 'list' ? storageKind : 'vector', ops);
  const make = (items: Value[]): SequenceValue => {
    const sequence = new SequenceValue(
      items,
      element,
      kind !== 'priority_queue',
      storageKind === 'deque' || storageKind === 'list' || storageKind === 'vector' ? storageKind : undefined
    );
    sequence.capacity = items.length;
    return sequence;
  };
  const push = (frame: Frame, self: SequenceValue, create: () => Value): void => {
    frame.runtime.reserve(1);
    editor.append(frame, self, 1, create);
    if (kind === 'priority_queue') siftUp(self.items, self.items.length, less);
  };
  cls.memberTypes.set('value_type', element);
  cls.memberTypes.set('size_type', SIZE_T);
  cls.memberTypes.set('container_type', storage);
  if (compareType) cls.memberTypes.set('value_compare', compareType);
  cls.library = {
    kind,
    args: [element],
    ownedTypes: [element],
    assignmentCopies: storage.cls.library?.assignmentCopies,
    size: kind === 'priority_queue' ? 32 : 48,
    align: 8,
    operator: (compiler_, operator, operands, row) => {
      if (kind === 'priority_queue' || !['==', '!=', '<', '<=', '>', '>='].includes(operator)) return;
      if (operands.length !== 2 || operands.some(({ type }) => type.kind !== 'class' || type.cls !== cls)) return;
      return storage.cls.library?.operator?.(
        compiler_,
        operator,
        operands.map((operand) => ({ ...operand, type: storage })),
        row
      );
    },
    memberCall: (compiler_, object, member, args, row) => {
      if (member === 'push') compiler_.requireObjectUse(element, 'copy', row);
      if (member !== 'emplace') return;
      if (isConstType(object.type)) return compiler_.error(row, `const の ${cls.name} には emplace を使えません。`);
      const value = constructElement(compiler_, element, args, row);
      const self = compiler_.objectOf(object);
      return {
        type: VOID,
        isLvalue: false,
        row,
        run: (frame) => {
          push(frame, (self(frame) as Ptr).read() as SequenceValue, () => value(frame));
          return;
        },
      };
    },
    constructingMembers: ['emplace'],
  };
  const copyItems = (frame: Frame, { items }: SequenceValue): Value[] => {
    frame.runtime.reserve(items.length);
    return editor.build(frame, items.length, (index) => ops().copy(frame, items[index]));
  };
  const storageOperations = storage.cls.operations;
  if (storageOperations) {
    cls.operations = {
      ...storageOperations,
      copy: (frame, source) => {
        const copied = storageOperations.copy(frame, source) as SequenceValue;
        copied.isArrayLike = kind !== 'priority_queue';
        return copied;
      },
    };
  }
  cls.constructors = [nativeConstructor(cls, [], () => make([]))];
  if (compareType) {
    const fromItems = (items: Value[]): SequenceValue => {
      makeHeap(items, less);
      return make(items);
    };
    cls.constructors.push(
      nativeConstructor(cls, [constRef(compareType)], () => make([]), { isExplicit: true }),
      nativeConstructor(cls, [constRef(compareType), constRef(storage)], ([, from], { frame }) =>
        fromItems(copyItems(frame, (from as Ptr).read() as SequenceValue))
      ),
      {
        ...nativeConstructor(cls, [], () => make([])),
        instantiate: (args) => {
          if (args.length !== 2 && args.length !== 3) return;
          const range = iteratorRange(compiler, args.slice(0, 2), element, ops);
          if (!range) return;
          const params = args.length === 3 ? [...range.params, constRef(compareType)] : range.params;
          return nativeConstructor(cls, params, ([first, last], { frame }) => {
            const source = range.read(first, last);
            frame.runtime.reserve(source.values.length);
            return fromItems(
              editor.build(frame, source.values.length, (index) => source.construct(frame, source.values[index]))
            );
          });
        },
      }
    );
  } else {
    cls.constructors.push(
      nativeConstructor(
        cls,
        [constRef(storage)],
        ([from], { frame }) => make(copyItems(frame, (from as Ptr).read() as SequenceValue)),
        {
          isExplicit: true,
          uses: (row) => compiler.requireObjectUse(element, 'copy', row),
        }
      )
    );
  }
  const method = (
    memberName: string,
    params: Type[],
    ret: Type,
    run: (self: SequenceValue, args: unknown[], frame: Frame) => unknown,
    isConst = false
  ): void => {
    addMethod(
      cls,
      native(memberName, params, ret, (args, { self, frame }) => run(self as SequenceValue, args, frame), { isConst })
    );
  };
  method('size', [], SIZE_T, (self) => BigInt(self.items.length), true);
  method('empty', [], BOOL, (self) => (self.items.length === 0 ? 1 : 0), true);
  method('push', [constRef(element)], VOID, (self, [value], frame) =>
    push(frame, self, () => ops().copy(frame, (value as Ptr).read()))
  );
  method('pop', [], VOID, (self, _args, frame) => {
    nonEmpty(self);
    if (kind === 'queue') editor.removeFront(frame, self);
    else {
      if (kind === 'priority_queue') popHeap(self.items, less);
      editor.truncate(frame, self, self.items.length - 1);
    }
  });
  const access = (memberName: string, at: (self: SequenceValue) => number): void => {
    for (const isConst of kind === 'priority_queue' ? [true] : [false, true]) {
      method(
        memberName,
        [],
        referenceTo(isConst ? withConst(element) : element),
        (self) => {
          nonEmpty(self);
          return self.location(at(self));
        },
        isConst
      );
    }
  };
  if (kind === 'queue') {
    access('front', () => 0);
    access('back', (self) => self.items.length - 1);
  } else {
    access('top', (self) => (kind === 'stack' ? self.items.length - 1 : 0));
  }
  method('swap', [referenceTo(classType(cls))], VOID, (self, [other]) => {
    const target = (other as Ptr).read() as SequenceValue;
    self.swapItems(target);
  });
  return cls;
}

function makeHeap(items: Value[], less: (a: Value, b: Value) => boolean): void {
  for (let parent = Math.floor((items.length - 2) / 2); parent >= 0; parent--) {
    const value = items[parent];
    let hole = parent;
    for (let child = 2 * hole + 1; child < items.length; child = 2 * hole + 1) {
      if (child + 1 < items.length && less(items[child], items[child + 1])) child++;
      if (less(items[child], value)) break;
      items[hole] = items[child];
      hole = child;
    }
    items[hole] = value;
  }
}

const nonEmpty = (self: SequenceValue): void => {
  if (self.items.length === 0) throw new CppRuntimeError('emptyContainer');
};

/** libc++'s `__sift_up`, which moves the last of `length` elements up the heap. */
function siftUp(items: Value[], length: number, less: (a: Value, b: Value) => boolean): void {
  if (length <= 1) return;
  let parent = Math.floor((length - 2) / 2);
  let last = length - 1;
  if (!less(items[parent], items[last])) return;
  const value = items[last];
  for (;;) {
    items[last] = items[parent];
    last = parent;
    if (parent === 0) break;
    parent = Math.floor((parent - 1) / 2);
    if (!less(items[parent], value)) break;
  }
  items[last] = value;
}

/** libc++'s `__pop_heap`: Floyd's sift down of a hole from the top, then a sift up of the moved last element. */
function popHeap(items: Value[], less: (a: Value, b: Value) => boolean): void {
  const length = items.length;
  if (length <= 1) return;
  const top = items[0];
  let hole = 0;
  let child = 0;
  for (;;) {
    child = 2 * child + 1;
    let childIndex = child;
    if (child + 1 < length && less(items[childIndex], items[childIndex + 1])) {
      childIndex++;
      child++;
    }
    items[hole] = items[childIndex];
    hole = childIndex;
    if (child > Math.floor((length - 2) / 2)) break;
  }
  const last = length - 1;
  if (hole === last) {
    items[hole] = top;
    return;
  }
  items[hole] = items[last];
  items[last] = top;
  siftUp(items, hole + 1, less);
}
