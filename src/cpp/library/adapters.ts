import { CppException, CppRuntimeError } from '../errors';
import { withTemporaries } from '../objectCompiler';
import { type Frame, holdAll } from '../runtime';
import {
  alignOf,
  BOOL,
  ClassInfo,
  classType,
  isConstType,
  nonReference,
  referenceTo,
  SIZE_T,
  sizeOf,
  type Type,
  typeName,
  VOID,
  withConst,
} from '../types';
import { type Ptr, type Value } from '../values';
import { comparatorOrder } from './associative';
import { SequenceValue } from './containerValues';
import {
  type ElementOperations,
  elementOperations,
  moveConstructElement,
  moveValue,
  requireElementUse,
} from './elements';
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
    if (kind === 'priority_queue') new Heap(frame, self, ops(), less).push();
  };
  cls.memberTypes.set('value_type', element);
  cls.memberTypes.set('size_type', SIZE_T);
  cls.memberTypes.set('container_type', storage);
  const reference = storage.cls.memberTypes.get('reference') ?? referenceTo(element);
  const constReference = storage.cls.memberTypes.get('const_reference') ?? referenceTo(withConst(element));
  const comparatorAlignment = compareType ? alignOf(compareType) : 1;
  const align = Math.max(alignOf(storage), comparatorAlignment);
  const storageSize = sizeOf(storage);
  const size = compareType
    ? Math.ceil((Math.ceil(storageSize / comparatorAlignment) * comparatorAlignment + sizeOf(compareType)) / align) *
      align
    : storageSize;
  cls.memberTypes.set('reference', reference);
  cls.memberTypes.set('const_reference', constReference);
  if (compareType) cls.memberTypes.set('value_compare', compareType);
  cls.library = {
    kind,
    args: [element],
    ownedTypes: [element],
    elementUseOnAssignment: storage.cls.library?.elementUseOnAssignment,
    size,
    align,
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
      if (kind === 'priority_queue' && ['push', 'pop', 'emplace'].includes(member))
        requireElementUse(compiler_, element, row, 'relocate');
      else if (member === 'push') requireElementUse(compiler_, element, row, 'copy');
      if (member !== 'emplace') return;
      if (isConstType(object.type)) return compiler_.error(row, `const の ${cls.name} には emplace を使えません。`);
      const value = constructElement(compiler_, element, args, row);
      const self = compiler_.objectOf(object);
      const result = kind === 'priority_queue' ? VOID : reference;
      return {
        type: nonReference(result),
        isLvalue: result.kind === 'reference',
        row,
        run: (frame) => {
          const sequence = (self(frame) as Ptr).read() as SequenceValue;
          push(frame, sequence, () => value(frame));
          if (result.kind !== 'void') return sequence.location(sequence.items.length - 1);
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
    const fromItems = (frame: Frame, items: Value[]): SequenceValue => {
      const sequence = make(items);
      return holdAll(frame, [() => sequence], () => {
        try {
          new Heap(frame, sequence, ops(), less).build();
          return sequence;
        } catch (error) {
          if (error instanceof CppException) editor.destroy(frame, items);
          throw error;
        }
      });
    };
    const uses = (row: number): void => requireElementUse(compiler, element, row, 'relocate');
    cls.constructors.push(
      nativeConstructor(cls, [constRef(compareType)], () => make([]), { isExplicit: true }),
      nativeConstructor(
        cls,
        [constRef(compareType), constRef(storage)],
        ([, from], { frame }) => fromItems(frame, copyItems(frame, (from as Ptr).read() as SequenceValue)),
        { uses }
      ),
      {
        ...nativeConstructor(cls, [], () => make([])),
        instantiate: (args) => {
          if (args.length !== 2 && args.length !== 3) return;
          const range = iteratorRange(compiler, args.slice(0, 2), element, ops);
          if (!range) return;
          const params = args.length === 3 ? [...range.params, constRef(compareType)] : range.params;
          return nativeConstructor(
            cls,
            params,
            ([first, last], { frame }) => {
              const source = range.read(first, last);
              frame.runtime.reserve(source.values.length);
              return fromItems(
                frame,
                editor.build(frame, source.values.length, (index) => source.construct(frame, source.values[index]))
              );
            },
            { uses }
          );
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
          uses: (row) => compiler.requireLibraryObjectUse(element, 'copy', row),
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
      if (kind === 'priority_queue') new Heap(frame, self, ops(), less).pop();
      editor.truncate(frame, self, self.items.length - 1);
    }
  });
  const access = (memberName: string, at: (self: SequenceValue) => number): void => {
    for (const isConst of kind === 'priority_queue' ? [true] : [false, true]) {
      method(
        memberName,
        [],
        isConst ? constReference : reference,
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

const nonEmpty = (self: SequenceValue): void => {
  if (self.items.length === 0) throw new CppRuntimeError('emptyContainer');
};

class Heap {
  private readonly items: Value[];

  constructor(
    private readonly frame: Frame,
    private readonly sequence: SequenceValue,
    private readonly operations: ElementOperations,
    private readonly less: (a: Value, b: Value) => boolean
  ) {
    this.items = sequence.items;
  }

  build(): void {
    const lastParent = Math.floor((this.items.length - 2) / 2);
    for (let parent = lastParent; parent >= 0; parent--) {
      const firstChild = this.largerChild(parent);
      if (this.less(this.items[firstChild], this.items[parent])) continue;
      this.withMoved(parent, (value) => {
        let hole = parent;
        let child = firstChild;
        for (;;) {
          this.assign(hole, this.items[child]);
          hole = child;
          if (hole > lastParent) break;
          child = this.largerChild(hole);
          if (this.less(this.items[child], value)) break;
        }
        this.assign(hole, value);
      });
    }
  }

  push(): void {
    this.siftUp(this.items.length);
  }

  pop(): void {
    const length = this.items.length;
    if (length <= 1) return;
    this.withMoved(0, (top) => {
      const last = length - 1;
      const lastParent = Math.floor((length - 2) / 2);
      let hole = 0;
      do {
        const child = this.largerChild(hole);
        this.assign(hole, this.items[child]);
        hole = child;
      } while (hole <= lastParent);
      if (hole === last) {
        this.assign(last, top);
        return;
      }
      this.assign(hole, this.items[last]);
      this.assign(last, top);
      this.siftUp(hole + 1);
    });
  }

  private siftUp(length: number): void {
    if (length <= 1) return;
    let parent = Math.floor((length - 2) / 2);
    let hole = length - 1;
    if (!this.less(this.items[parent], this.items[hole])) return;
    this.withMoved(hole, (value) => {
      for (;;) {
        this.assign(hole, this.items[parent]);
        hole = parent;
        if (parent === 0) break;
        parent = Math.floor((parent - 1) / 2);
        if (!this.less(this.items[parent], value)) break;
      }
      this.assign(hole, value);
    });
  }

  private largerChild(parent: number): number {
    const left = 2 * parent + 1;
    const right = left + 1;
    return right < this.items.length && this.less(this.items[left], this.items[right]) ? right : left;
  }

  private assign(index: number, value: Value): void {
    const target = this.sequence.location(index);
    target.write(moveValue(this.frame, this.operations.type, target.readRaw(), value));
  }

  private withMoved(index: number, run: (value: Value) => void): void {
    withTemporaries(this.frame, () => {
      const object = moveConstructElement(this.frame, this.operations, this.items[index]);
      const { destroy } = this.operations;
      if (destroy) this.frame.temporaries.push({ object, destroy });
      run(object);
    });
  }
}
