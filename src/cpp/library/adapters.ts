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
import { Ptr, type Value } from '../values';
import { comparatorOrder } from './associative';
import { SequenceValue } from './containerValues';
import { type ElementOperations, elementOperations } from './elements';
import type { Library } from './registry';
import { constructElement } from './sequences';
import { addMethod, constRef, native, nativeConstructor } from './support';
import { typeKey } from './templates';

/** `std::stack<T>`, `std::queue<T>`, or `std::priority_queue<T, Container, Compare>`, over a `SequenceValue`. */
export function adapterClass(
  library: Library,
  kind: 'stack' | 'queue' | 'priority_queue',
  element: Type,
  comparator: Type | undefined
): ClassInfo {
  const key = `${kind}<${typeKey(element)},${comparator ? typeKey(comparator) : ''}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  const name = `std::${kind}<${typeName(element)}${comparator ? `, std::vector<${typeName(element)}>, ${typeName(comparator)}` : ''}>`;
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
  const make = (items: Value[]): SequenceValue => new SequenceValue(items, element, kind !== 'priority_queue');
  const push = (frame: Frame, self: SequenceValue, value: Value): void => {
    frame.runtime.reserve(1);
    self.items.push(value);
    if (kind === 'priority_queue') siftUp(self.items, self.items.length, less);
  };
  cls.memberTypes.set('value_type', element);
  cls.memberTypes.set('size_type', SIZE_T);
  cls.library = {
    kind,
    args: [element],
    size: kind === 'priority_queue' ? 32 : 48,
    align: 8,
    memberCall: (compiler_, object, member, args, row) => {
      if (member !== 'emplace') return;
      if (isConstType(object.type)) return compiler_.error(row, `const の ${cls.name} には emplace を使えません。`);
      const value = constructElement(compiler_, element, args, row);
      const self = compiler_.objectOf(object);
      return {
        type: VOID,
        isLvalue: false,
        row,
        run: (frame) => {
          push(frame, (self(frame) as Ptr).read() as SequenceValue, value(frame));
          return;
        },
      };
    },
    constructingMembers: ['emplace'],
  };
  cls.operations = {
    copy: (frame, source) => make((source as SequenceValue).items.map((item) => ops().copy(frame, item))),
    assign: (frame, target, source) => {
      (target as SequenceValue).items = (source as SequenceValue).items.map((item) => ops().copy(frame, item));
    },
    destroy: (frame, value) => {
      const destroy = ops().destroy;
      if (destroy) for (const item of (value as SequenceValue).items) destroy(frame, item);
    },
  };
  cls.constructors = [nativeConstructor(cls, [], () => make([]))];
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
    push(frame, self, ops().copy(frame, (value as Ptr).read()))
  );
  method('pop', [], VOID, (self, _args, frame) => {
    nonEmpty(self);
    let removed: Value;
    if (kind === 'queue') removed = self.items.shift() as Value;
    else if (kind === 'stack') removed = self.items.pop() as Value;
    else {
      popHeap(self.items, less);
      removed = self.items.pop() as Value;
    }
    ops().destroy?.(frame, removed);
  });
  const access = (memberName: string, at: (self: SequenceValue) => number): void => {
    for (const isConst of kind === 'priority_queue' ? [true] : [false, true]) {
      method(
        memberName,
        [],
        referenceTo(isConst ? withConst(element) : element),
        (self) => {
          nonEmpty(self);
          return new Ptr(self, at(self));
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
    [self.items, target.items] = [target.items, self.items];
  });
  return cls;
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
