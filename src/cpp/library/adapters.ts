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
import { type CObject, type Ptr, type Value } from '../values';
import { comparatorOrder } from './associative';
import { SequenceValue } from './containerValues';
import {
  constructElementFromRvalue,
  type ElementOperations,
  elementOperations,
  moveAssignElement,
  movedArgument,
  requireElementUse,
  requireMoveConstruction,
  requireMoves,
  requireRelocation,
  type ValueComparison,
} from './elements';
import type { Library } from './registry';
import { SequenceEditor } from './sequenceEdits';
import { forwardedElementConstruction, iteratorRange, sequenceClass } from './sequences';
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
  const less: ValueComparison<boolean> = (a, b, frame) => (order as ValueComparison<number>)(a, b, frame) < 0;
  let elementOps: ElementOperations | undefined;
  const ops = (): ElementOperations => {
    elementOps ??= elementOperations(compiler, element, 0);
    return elementOps;
  };
  const storageKind = storage.cls.library?.kind;
  const ownedCopyFromConst = storage.cls.library?.ownedCopyFromConst;
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
  const push = (frame: Frame, self: SequenceValue, create: (target?: CObject) => Value): void => {
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
    inlineElementType: storage.cls.library?.inlineElementType,
    ownedCopyFromConst,
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
      const appends = member === 'push' || member === 'emplace';
      if (kind === 'priority_queue' && (appends || member === 'pop')) requireMoves(compiler_, element, row);
      if (!appends) return;
      if (storageKind === 'vector') requireRelocation(compiler_, element, row);
      const source = member === 'push' && args.length === 1 ? movedArgument(compiler_, element, args[0]) : undefined;
      if (member === 'push' && !source) {
        requireElementUse(compiler_, element, row, 'copy');
        return;
      }
      if (isConstType(object.type)) return compiler_.error(row, `const の ${cls.name} には ${member} を使えません。`);
      const withElement = source ? undefined : forwardedElementConstruction(compiler_, element, args, row);
      if (source && kind !== 'priority_queue') requireMoveConstruction(compiler_, element, row);
      const self = compiler_.objectOf(object);
      const result = member === 'emplace' && kind !== 'priority_queue' ? reference : VOID;
      return {
        type: nonReference(result),
        isLvalue: result.kind === 'reference',
        row,
        run: (frame) =>
          holdAll(frame, source ? [self, source] : [self], ([receiver, bound]) => {
            const append = (make: (target?: CObject) => Value): Value => {
              const sequence = (receiver as Ptr).read() as SequenceValue;
              push(frame, sequence, make);
              if (result.kind !== 'void') return sequence.location(sequence.items.length - 1);
            };
            if (withElement) return withElement(frame, append);
            return append((target) => constructElementFromRvalue(frame, element, (bound as Ptr).read(), target));
          }),
      };
    },
    constructingMembers: ['emplace'],
  };
  const copyItems = (frame: Frame, { items }: SequenceValue): SequenceValue => {
    frame.runtime.reserve(items.length);
    return editor.construct(frame, make([]), items.length, (index, destination) =>
      ops().copy(frame, items[index], destination, ownedCopyFromConst)
    );
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
    const heapify = (frame: Frame, sequence: SequenceValue): SequenceValue => {
      return holdAll(frame, [() => sequence], () => {
        try {
          new Heap(frame, sequence, ops(), less).build();
          return sequence;
        } catch (error) {
          if (error instanceof CppException) editor.destroy(frame, sequence.items);
          throw error;
        }
      });
    };
    const uses = (row: number): void => requireMoves(compiler, element, row);
    cls.constructors.push(
      nativeConstructor(cls, [constRef(compareType)], () => make([]), { isExplicit: true }),
      nativeConstructor(
        cls,
        [constRef(compareType), constRef(storage)],
        ([, from], { frame }) => heapify(frame, copyItems(frame, (from as Ptr).read() as SequenceValue)),
        {
          uses: (row) => {
            requireElementUse(compiler, element, row, 'copy');
            uses(row);
          },
        }
      ),
      {
        ...nativeConstructor(cls, [], () => make([])),
        instantiate: (args) => {
          if (args.length !== 2 && args.length !== 3) return;
          const bitStorage = storageKind === 'vector' && reference.kind === 'class';
          const range = iteratorRange(compiler, args.slice(0, 2), element, ops, bitStorage ? 'assign' : 'construct');
          if (!range) return;
          const params = args.length === 3 ? [...range.params, constRef(compareType)] : range.params;
          return nativeConstructor(
            cls,
            params,
            ([first, last], { frame }) => {
              const source = range.read(first, last);
              frame.runtime.reserve(source.length);
              return heapify(frame, editor.constructRange(frame, make([]), source));
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
        ([from], { frame }) => copyItems(frame, (from as Ptr).read() as SequenceValue),
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
  method('size', [], SIZE_T, (self) => BigInt(self.size), true);
  method('empty', [], BOOL, (self) => (self.size === 0 ? 1 : 0), true);
  method('push', [constRef(element)], VOID, (self, [value], frame) =>
    push(frame, self, (target) => ops().copy(frame, (value as Ptr).read(), target))
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
    private readonly order: ValueComparison<boolean>
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

  private less(a: Value, b: Value): boolean {
    this.frame.runtime.spend();
    return this.order(a, b, this.frame);
  }

  private largerChild(parent: number): number {
    const left = 2 * parent + 1;
    const right = left + 1;
    return right < this.items.length && this.less(this.items[left], this.items[right]) ? right : left;
  }

  private assign(index: number, value: Value): void {
    moveAssignElement(this.frame, this.sequence.location(index), this.operations.type, value);
  }

  private withMoved(index: number, run: (value: Value) => void): void {
    withTemporaries(this.frame, () => {
      const object = constructElementFromRvalue(this.frame, this.operations.type, this.items[index]);
      const { destroy } = this.operations;
      if (destroy) this.frame.temporaries.push({ object, destroy });
      run(object);
    });
  }
}
