import type { DisplayNode } from '../../problems/trace';
import { CppRuntimeError } from '../errors';
import { type Expr, initializerWithConstancy } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { makeEach } from '../objectCompiler';
import type { Eval, Frame } from '../runtime';
import {
  alignOf,
  allowsConstantCopy,
  allowsMemberAssignment,
  BOOL,
  ClassInfo,
  classType,
  type FunctionInfo,
  isConstType,
  nonReference,
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
import { CObject, Ptr, type Value } from '../values';
import { MapValue, NodePositions } from './containerValues';
import {
  assignElement,
  type ElementOperations,
  elementOperations,
  equalTo,
  lessThan,
  requireElementUse,
  swapElements,
} from './elements';
import { addRangeMembers, emplacementCall, type EntryTable, insertCopy } from './emplacement';
import { positionOf, randomAccessIterator, rangePositions } from './iterators';
import type { Library } from './registry';
import { StringValue } from './string';
import { addMethod, constRef, generic, native, nativeConstructor, throwLibrary } from './support';
import { typeKey } from './templates';

/** `std::pair<T1, T2>`, an object with the members `first` and `second`. */
export function pairClass(library: Library, first: Type, second: Type): ClassInfo {
  const key = `pair<${typeKey(first)},${typeKey(second)}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  const cls = new ClassInfo(`std::pair<${typeName(first)}, ${typeName(second)}>`, 'struct');
  library.instances.set(key, cls);
  cls.isComplete = true;
  cls.fields = [
    { name: 'first', type: first, index: 0, access: 'public', owner: cls, row: -1 },
    { name: 'second', type: second, index: 1, access: 'public', owner: cls, row: -1 },
  ];
  cls.memberTypes.set('first_type', first);
  cls.memberTypes.set('second_type', second);
  cls.isAssignmentDeleted = [first, second].some((member) => {
    const type = nonReference(member);
    return type.kind === 'array' || !allowsMemberAssignment(type);
  });
  let operations: [ElementOperations, ElementOperations] | undefined;
  const ops = (): [ElementOperations, ElementOperations] => {
    operations ??= [
      elementOperations(library.compiler, unqualified(first), 0),
      elementOperations(library.compiler, unqualified(second), 0),
    ];
    return operations;
  };
  const make = (a: Value, b: Value): CObject => new CObject(cls, [a, b]);
  const firstStorage = first.kind === 'reference' ? pointerTo(first.to) : first;
  const secondStorage = second.kind === 'reference' ? pointerTo(second.to) : second;
  const secondAlign = alignOf(secondStorage);
  const align = Math.max(alignOf(firstStorage), secondAlign);
  const secondOffset = Math.ceil(sizeOf(firstStorage) / secondAlign) * secondAlign;
  const constantMembers = allowsConstantCopy(first) && allowsConstantCopy(second);
  cls.library = {
    kind: 'pair',
    allowsConstantCopy: constantMembers,
    valueInitializedMembers: [first, second],
    args: [first, second],
    size: Math.ceil((secondOffset + sizeOf(secondStorage)) / align) * align,
    align,
    listInitializer: (compiler, elements, row) => {
      if (elements.length !== 2) return;
      // The forwarding constructor deduces its parameters before initializing the pair's member types.
      const expr = compiler.constructObject(
        cls,
        elements.map((element) => compiler.argument(element)),
        row,
        false
      );
      return initializerWithConstancy((frame) => expr.run(frame), expr.constantInitialization === true);
    },
    operator: (compiler, operator, operands, row) => {
      const [left, right] = operands;
      const isSelf = (expr: Expr | undefined): boolean => expr?.type.kind === 'class' && expr.type.cls === cls;
      if (!['==', '!=', '<', '<=', '>', '>='].includes(operator) || !isSelf(left) || !isSelf(right)) return;
      const type = classType(cls);
      const compare = operator === '==' || operator === '!=' ? equalTo(type) : lessThan(type);
      if (!compare) return compiler.error(row, `${cls.name} の値は ${operator} で比べられません。`);
      const a = compiler.rvalue(left).run;
      const b = compiler.rvalue(right).run;
      const test = orderTest(operator, compare);
      return { type: BOOL, isLvalue: false, row, run: (frame) => (test(a(frame) as Value, b(frame) as Value) ? 1 : 0) };
    },
  };
  const construct = (frame: Frame, initialize: [(frame: Frame) => Value, (frame: Frame) => Value]): CObject => {
    const parts = ops();
    const [a, b] = makeEach(
      frame,
      2,
      (index) => initialize[index](frame),
      (index) => parts[index].destroy
    );
    return make(a, b);
  };
  cls.operations = {
    copy: (frame, source) => {
      const [a, b] = (source as CObject).values;
      return construct(frame, [(f) => ops()[0].copy(f, a), (f) => ops()[1].copy(f, b)]);
    },
    assign: (frame, target, source) => {
      const to = target as CObject;
      const from = source as CObject;
      for (const [index, member] of [first, second].entries()) {
        if (member.kind === 'reference') {
          const value = (from.values[index] as Ptr).read();
          const assignment = elementOperations(library.compiler, unqualified(member.to), 0);
          assignElement(frame, to.values[index] as Ptr, assignment, value);
        } else to.values[index] = ops()[index].assign(frame, to.values[index], from.values[index]);
      }
    },
    destroy: (frame, value) => {
      const [a, b] = (value as CObject).values;
      ops()[1].destroy?.(frame, b);
      ops()[0].destroy?.(frame, a);
    },
  };
  cls.constructors = [
    nativeConstructor(
      cls,
      [],
      (_args, { frame }) => construct(frame, [(f) => ops()[0].make(f), (f) => ops()[1].make(f)]),
      {
        libraryConstant: () => (constantMembers ? true : undefined),
        uses: (row) => {
          library.compiler.valueInitialized(first, row);
          library.compiler.valueInitialized(second, row);
        },
      }
    ),
    nativeConstructor(
      cls,
      [first, second].map((type) => (type.kind === 'reference' ? type : constRef(type))),
      ([a, b], { frame }) =>
        construct(frame, [
          (f) => (first.kind === 'reference' ? (a as Ptr) : ops()[0].copy(f, (a as Ptr).read())),
          (f) => (second.kind === 'reference' ? (b as Ptr) : ops()[1].copy(f, (b as Ptr).read())),
        ]),
      {
        libraryConstant: () => (constantMembers ? true : undefined),
        uses: (row) => {
          library.compiler.requireLibraryObjectUse(classType(cls), 'copy', row);
          library.compiler.requireLibraryObjectUse(classType(cls), 'destroy', row);
        },
      }
    ),
    {
      ...nativeConstructor(cls, [], () => {}),
      instantiate: (args) => {
        // pair(const pair<U1, U2>&): converts each member, as make_pair's result needs.
        const [source] = args;
        if (
          args.length !== 1 ||
          source.type.kind !== 'class' ||
          source.type.cls.library?.kind !== 'pair' ||
          source.type.cls === cls
        ) {
          return;
        }
        const [u1, u2] = source.type.cls.fields;
        const compiler = library.compiler;
        // The members construct from the source's members, which a class member's copy constructor copies.
        const slot = (type: Type): Expr => ({
          type,
          isLvalue: true,
          row: source.row,
          run: (frame) => frame.pending.at(-1) as Ptr,
        });
        let convertFirst: Eval;
        let convertSecond: Eval;
        try {
          convertFirst = compiler.convert(slot(u1.type), unqualified(first), source.row).run as Eval;
          convertSecond = compiler.convert(slot(u2.type), unqualified(second), source.row).run as Eval;
        } catch {
          return;
        }
        return nativeConstructor(
          cls,
          [constRef(source.type)],
          ([pair], { frame }) => {
            const object = (pair as Ptr).read() as CObject;
            const member =
              (index: number, convert: Eval): Eval<Value> =>
              (f) => {
                f.pending.push(new Ptr(object, index));
                try {
                  return convert(f) as Value;
                } finally {
                  f.pending.pop();
                }
              };
            return construct(frame, [member(0, convertFirst), member(1, convertSecond)]);
          },
          {
            libraryConstant: () => {
              const targets = [first, second];
              const incoming = [u1.type, u2.type];
              if (
                constantMembers &&
                targets.every((to, index) => to.kind !== 'class' || sameType(to, incoming[index], false))
              )
                return true;
            },
          }
        );
      },
      isTemplate: true,
    },
  ];
  addMethod(
    cls,
    native(
      'swap',
      [referenceTo(classType(cls))],
      VOID,
      ([other], { frame, self }) => {
        const a = self as CObject;
        const b = (other as Ptr).read() as CObject;
        for (const index of [0, 1]) {
          const type = cls.fields[index].type;
          if (type.kind === 'reference') {
            swapElements(
              frame,
              a.values[index] as Ptr,
              b.values[index] as Ptr,
              elementOperations(library.compiler, type.to, 0)
            );
          } else {
            swapElements(frame, new Ptr(a, index), new Ptr(b, index), ops()[index]);
          }
        }
        return;
      },
      {
        uses: (row) => {
          requireElementUse(library.compiler, nonReference(first), row, 'swap');
          requireElementUse(library.compiler, nonReference(second), row, 'swap');
        },
      }
    )
  );
  return cls;
}

/** `std::make_pair(a, b)`, whose pair's member types are the arguments' decayed types. */
export function makePair(library: Library): FunctionInfo {
  return generic('make_pair', (args) => {
    if (args.length !== 2) return;
    const types = args.map((arg) => decayed(arg.type));
    if (types.some((type) => type.kind === 'void')) return;
    const cls = pairClass(library, types[0], types[1]);
    return native(
      'make_pair',
      types.map((type) => constRef(type)),
      classType(cls),
      ([a, b], { frame }) =>
        cls.operations?.copy(frame, new CObject(cls, [(a as Ptr).read(), (b as Ptr).read()])) as Value,
      {
        libraryConstant: () => (cls.library?.allowsConstantCopy ? true : undefined),
        uses: (row) => library.compiler.requireLibraryObjectUse(classType(cls), 'copy', row),
      }
    );
  });
}

function decayed(type: Type): Type {
  if (type.kind === 'array') return { kind: 'pointer', to: type.of };
  return unqualified(type);
}

function orderTest(
  operator: string,
  compare: ((a: Value, b: Value) => number) | ((a: Value, b: Value) => boolean)
): (a: Value, b: Value) => boolean {
  if (operator === '==') return (a, b) => compare(a, b) === true;
  if (operator === '!=') return (a, b) => compare(a, b) !== true;
  const order = compare as (a: Value, b: Value) => number;
  switch (operator) {
    case '<': {
      return (a, b) => order(a, b) < 0;
    }
    case '<=': {
      return (a, b) => order(a, b) <= 0;
    }
    case '>': {
      return (a, b) => order(a, b) > 0;
    }
    default: {
      return (a, b) => order(a, b) >= 0;
    }
  }
}

/** The entries of `std::map`, `std::multimap`, `std::set`, or `std::multiset`, kept in key order. */
export class OrderedValue extends MapValue {
  constructor(
    public entries: Value[],
    readonly keyOf: (entry: Value) => Value,
    readonly isMap: boolean,
    readonly keyType: Type,
    readonly valueType: Type | undefined
  ) {
    super();
  }

  private readonly nodes = new NodePositions(this);

  override location(index: number): Ptr {
    return this.nodes.at(index);
  }

  splice(from: number, remove: number, ...entries: Value[]): Value[] {
    this.nodes.splice(from, remove, entries.length);
    return this.entries.splice(from, remove, ...entries);
  }

  replace(entries: Value[]): Value[] {
    const previous = this.entries;
    this.nodes.splice(0, previous.length, entries.length);
    this.entries = entries;
    return previous;
  }

  swap(other: OrderedValue): void {
    this.nodes.swap(other.nodes);
    [this.entries, other.entries] = [other.entries, this.entries];
  }

  get length(): number {
    return this.entries.length;
  }

  get(index: number): Value {
    this.checkAlive();
    if (index < 0 || index >= this.entries.length) throw new CppRuntimeError('invalidIterator');
    return this.entries[index];
  }

  set(index: number, value: Value): void {
    this.checkAlive();
    this.entries[index] = value;
  }

  children(): Iterable<Value> {
    return this.entries;
  }

  displayNode(nodeOf: (value: Value, type: Type) => DisplayNode): DisplayNode {
    if (!this.isMap) {
      const entries: Record<string, DisplayNode> = {};
      for (const [index, entry] of this.entries.entries()) entries[index] = nodeOf(entry, this.keyType);
      return { kind: 'array', entries };
    }
    const entries: Record<string, DisplayNode> = {};
    for (const entry of this.entries) {
      const [key, value] = (entry as CObject).values;
      entries[keyText(key, this.keyType)] = nodeOf(value, this.valueType as Type);
    }
    return { kind: 'object', entries };
  }
}

/** The text a key shows as in the trace, which is how learners write it. */
export function keyText(key: Value, type: Type): string {
  if (key instanceof StringValue) return key.text;
  if (type.kind === 'int' && type.name === 'bool') return key === 0 ? 'false' : 'true';
  if (type.kind === 'int' && (type.name === 'char' || type.name === 'schar' || type.name === 'uchar')) {
    return String.fromCodePoint(Number(key) & 0xff);
  }
  if (typeof key === 'number' || typeof key === 'bigint') return String(key);
  return String(key);
}

type Order = (a: Value, b: Value) => number;

const keyWithoutOrder = (keyType: Type): string =>
  `${typeName(keyType)} の値は < で比べられないので、キーにできません。`;

/** The order of a container's comparator: `std::less<K>` (the default) or `std::greater<K>`. */
export function comparatorOrder(
  compiler: ExpressionCompiler,
  keyType: Type,
  comparator: Type | undefined,
  row: number
): Order {
  const less = lessThan(unqualified(keyType));
  if (!less) return compiler.error(row, keyWithoutOrder(keyType));
  if (!comparator) return less;
  if (comparator.kind === 'class' && comparator.cls.library?.kind === 'functor') {
    const name = comparator.cls.name.replace(/<.*$/, '');
    if (name === 'std::less') return less;
    if (name === 'std::greater') return (a, b) => less(b, a);
  }
  return compiler.unsupported(row, `比べ方に ${typeName(comparator)} を使うこと`);
}

/** The members of an ordered associative container that compare keys, besides `erase` of a key. */
const COMPARING_MEMBERS = new Set([
  'insert',
  'emplace',
  'try_emplace',
  'find',
  'count',
  'contains',
  'lower_bound',
  'upper_bound',
  'at',
]);

/**
 * `std::map<K, V>`, `std::multimap<K, V>`, `std::set<K>`, or `std::multiset<K>`, whose objects are `OrderedValue`s
 * with an index-based iterator.
 */
// code-gauge-allow functionNcss 160 -- The members of the ordered associative containers, which share their storage.
export function orderedClass(
  library: Library,
  kind: 'map' | 'multimap' | 'set' | 'multiset',
  keyType: Type,
  valueType: Type | undefined,
  comparator: Type | undefined
): ClassInfo {
  const args = valueType ? [keyType, valueType] : [keyType];
  const name = `std::${kind}<${args.map((arg) => typeName(arg)).join(', ')}${comparator ? `, ${typeName(comparator)}` : ''}>`;
  const key = `${kind}<${args.map((arg) => typeKey(arg)).join(',')},${comparator ? typeKey(comparator) : ''}>`;
  const cached = library.instances.get(key);
  if (cached) return cached;
  const cls = new ClassInfo(name, 'class');
  library.instances.set(key, cls);
  cls.isComplete = true;
  const compiler = library.compiler;
  // A container of keys without `<` stops only at a member that compares them, as libc++ instantiates members on use.
  const hasOrder = lessThan(unqualified(keyType)) !== undefined;
  const checkOrder = (compiler_: ExpressionCompiler, row: number): void => {
    if (!hasOrder) compiler_.error(row, keyWithoutOrder(keyType));
  };
  const order: Order = hasOrder
    ? comparatorOrder(compiler, keyType, comparator, 0)
    : () => {
        throw new CppRuntimeError('custom', keyWithoutOrder(keyType));
      };
  const isMap = valueType !== undefined;
  const isMulti = kind.startsWith('multi');
  const isSelf = (expr: Expr | undefined): boolean => expr?.type.kind === 'class' && expr.type.cls === cls;
  const entryType: Type = isMap ? classType(pairClass(library, withConst(keyType), valueType)) : keyType;
  const elementType: Type = isMap ? entryType : withConst(keyType);
  const iterator = randomAccessIterator(library.iterators, name, elementType, false, false, 'bidirectional');
  const constIterator = randomAccessIterator(library.iterators, name, elementType, true, false, 'bidirectional');
  const reverseIterator = randomAccessIterator(library.iterators, name, elementType, false, true, 'bidirectional');
  const constReverseIterator = randomAccessIterator(library.iterators, name, elementType, true, true, 'bidirectional');
  const types = {
    iterator: classType(iterator),
    constIterator: classType(constIterator),
    reverseIterator: classType(reverseIterator),
    constReverseIterator: classType(constReverseIterator),
  };
  cls.memberTypes.set('iterator', types.iterator);
  cls.memberTypes.set('const_iterator', types.constIterator);
  cls.memberTypes.set('reverse_iterator', types.reverseIterator);
  cls.memberTypes.set('const_reverse_iterator', types.constReverseIterator);
  cls.memberTypes.set('key_type', keyType);
  cls.memberTypes.set('value_type', entryType);
  cls.memberTypes.set('size_type', SIZE_T);
  if (valueType) cls.memberTypes.set('mapped_type', valueType);
  let entryOps: ElementOperations | undefined;
  let mappedOps: ElementOperations | undefined;
  const ops = (): ElementOperations => {
    entryOps ??= elementOperations(compiler, unqualified(entryType), 0);
    return entryOps;
  };
  const mapped = (): ElementOperations => {
    mappedOps ??= elementOperations(compiler, valueType as Type, 0);
    return mappedOps;
  };
  const keyOf = isMap ? (entry: Value): Value => (entry as CObject).values[0] : (entry: Value): Value => entry;
  const make = (entries: Value[]): OrderedValue => new OrderedValue(entries, keyOf, isMap, keyType, valueType);
  /** The first position whose key is not less than `key` (`upper` false) or greater than it (`upper` true). */
  const bound = (self: OrderedValue, key: Value, upper: boolean): number => {
    let low = 0;
    let high = self.entries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const comparison = order(keyOf(self.entries[middle]), key);
      if (comparison < 0 || (upper && comparison === 0)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const find = (self: OrderedValue, key: Value): number => {
    const at = bound(self, key, false);
    return at < self.entries.length && order(keyOf(self.entries[at]), key) === 0 ? at : -1;
  };
  /** Inserts an entry, giving its position and whether it was inserted, as `insert` does. */
  const insert = (frame: Frame, self: OrderedValue, entry: Value): [number, boolean] => {
    const key = keyOf(entry);
    if (!isMulti) {
      const existing = find(self, key);
      if (existing >= 0) return [existing, false];
    }
    frame.runtime.reserve(isMap ? 3 : 1);
    // A multimap inserts after the entries with an equal key, keeping the order of insertion among them.
    const at = bound(self, key, true);
    self.splice(at, 0, entry);
    return [at, true];
  };
  const destroyAll = (frame: Frame, entries: Value[]): void => {
    const destroy = ops().destroy;
    if (destroy) for (const entry of entries) destroy(frame, entry);
  };
  const table: EntryTable<OrderedValue> = {
    keyOf,
    lookup: (self, key) => {
      const at = isMulti ? -1 : find(self, key);
      return at >= 0 ? at : undefined;
    },
    insert,
    ops,
  };
  const insertResult = pairClass(library, types.iterator, BOOL);
  const insertionResult = (self: OrderedValue, at: number, inserted: boolean): Value => {
    const position = self.location(at);
    return isMulti ? position : new CObject(insertResult, [position, inserted ? 1 : 0]);
  };
  cls.library = {
    kind,
    args,
    size: 24,
    align: 8,
    listElementType: unqualified(entryType),
    listInitializer: (compiler_, elements, row) => {
      checkOrder(compiler_, row);
      const inits = elements.map((node) => compiler_.elementInitializer(unqualified(entryType), node));
      return (frame) => {
        const self = make([]);
        frame.pending.push(self);
        try {
          for (const init of inits) {
            const entry = init(frame);
            const [, inserted] = insert(frame, self, entry);
            if (!inserted) ops().destroy?.(frame, entry);
          }
        } finally {
          frame.pending.pop();
        }
        return self;
      };
    },
    operator: (compiler_, operator, operands, row) => {
      const [left, right] = operands;
      if (operator === '[]' && isMap && isSelf(left) && !isMulti) {
        checkOrder(compiler_, row);
        if (isConstType(left.type))
          return compiler_.error(row, `const の ${cls.name} には [] を使えません（at を使ってください）。`);
        if (!mapped().isDefaultConstructible) return mappedNotDefaultConstructible(compiler_, valueType as Type, row);
        compiler_.valueInitialized(valueType as Type, row);
        requireElementUse(compiler_, keyType, row, 'copy');
        const keyRun = compiler_.convert(right, constRef(keyType), row).run;
        const object = left.isLvalue ? left.run : compiler_.materialize(left).run;
        return {
          type: valueType as Type,
          isLvalue: true,
          row,
          run: (frame) => {
            const self = (object(frame) as Ptr).read() as OrderedValue;
            const keyValue = (keyRun(frame) as Ptr).read();
            let at = find(self, keyValue);
            if (at < 0) {
              const keyCopy = elementOperations(compiler, unqualified(keyType), row).copy(frame, keyValue);
              [at] = insert(
                frame,
                self,
                new CObject(entryType.kind === 'class' ? entryType.cls : cls, [keyCopy, mapped().make(frame)])
              );
            }
            return new Ptr(self.entries[at] as CObject, 1);
          },
        };
      }
      if (['==', '!=', '<', '<=', '>', '>='].includes(operator) && isSelf(left) && isSelf(right)) {
        const compareEntry =
          operator === '==' || operator === '!=' ? equalTo(unqualified(entryType)) : lessThan(unqualified(entryType));
        if (!compareEntry) return compiler_.error(row, `${cls.name} の値は ${operator} で比べられません。`);
        const a = compiler_.rvalue(left).run;
        const b = compiler_.rvalue(right).run;
        return {
          type: BOOL,
          isLvalue: false,
          row,
          run: (frame) => {
            const x = (a(frame) as OrderedValue).entries;
            const y = (b(frame) as OrderedValue).entries;
            if (operator === '==' || operator === '!=') {
              const same =
                x.length === y.length &&
                x.every((item, index) => (compareEntry as (p: Value, q: Value) => boolean)(item, y[index]));
              return (operator === '==') === same ? 1 : 0;
            }
            const less = compareEntry as Order;
            let result = 0;
            for (let index = 0; index < Math.min(x.length, y.length) && result === 0; index++)
              result = less(x[index], y[index]);
            if (result === 0) result = x.length - y.length;
            return orderTest(operator, () => result)(undefined, undefined) ? 1 : 0;
          },
        };
      }
      return;
    },
    memberCall: (compiler_, object, member, callArgs, row) => {
      const [first] = callArgs;
      const isKeyErase =
        member === 'erase' &&
        callArgs.length === 1 &&
        (first.type.kind !== 'class' || first.type.cls.library?.kind !== 'iterator');
      if (COMPARING_MEMBERS.has(member) || isKeyErase) checkOrder(compiler_, row);
      return emplacementCall(compiler_, object, member, callArgs, row, {
        types: { keyType, entryType, valueType },
        table,
        resultType: isMulti ? types.iterator : classType(insertResult),
        isTemporaryObject: !isMulti,
        result: insertionResult,
      });
    },
    constructingMembers: isMap ? ['emplace', 'try_emplace'] : ['emplace'],
    ownedTypes: [entryType],
    assignmentCopies: true,
  };
  cls.operations = {
    copy: (frame, source) => make((source as OrderedValue).entries.map((entry) => ops().copy(frame, entry))),
    assign: (frame, target, source) => {
      const to = target as OrderedValue;
      const from = source as OrderedValue;
      if (to === from) return;
      const old = to.entries;
      to.replace(from.entries.map((entry) => ops().copy(frame, entry)));
      destroyAll(frame, old);
    },
    destroy: (frame, value) => destroyAll(frame, (value as OrderedValue).entries),
  };
  cls.constructors = [nativeConstructor(cls, [], () => make([]))];
  addRangeMembers(compiler, cls, entryType, table, () => make([]));
  const method = (
    memberName: string,
    params: Type[],
    ret: Type,
    run: (self: OrderedValue, args: unknown[], frame: Frame) => unknown,
    options: { isConst?: boolean; optional?: number } = {}
  ): void => {
    addMethod(
      cls,
      native(
        memberName,
        params,
        ret,
        (callArgs, { self, frame }) => run(self as OrderedValue, callArgs, frame),
        options
      )
    );
  };
  method('size', [], SIZE_T, (self) => BigInt(self.entries.length), { isConst: true });
  method('max_size', [], SIZE_T, () => 0x0c_cc_cc_cc_cc_cc_cc_ccn, { isConst: true });
  method('empty', [], BOOL, (self) => (self.entries.length === 0 ? 1 : 0), { isConst: true });
  method('clear', [], VOID, (self, _args, frame) => {
    const old = self.replace([]);
    destroyAll(frame, old);
  });
  for (const isConst of [false, true]) {
    const it = isConst ? types.constIterator : types.iterator;
    const rit = isConst ? types.constReverseIterator : types.reverseIterator;
    method('begin', [], it, (self) => self.location(0), { isConst });
    method('end', [], it, (self) => self.location(self.entries.length), { isConst });
    const range = pairClass(library, it, it);
    method(
      'equal_range',
      [constRef(keyType)],
      classType(range),
      (self, [key]) => {
        const value = keyArg(key);
        return new CObject(range, [self.location(bound(self, value, false)), self.location(bound(self, value, true))]);
      },
      { isConst }
    );
    method('rbegin', [], rit, (self) => self.location(self.entries.length), { isConst });
    method('rend', [], rit, (self) => self.location(0), { isConst });
    method(
      'find',
      [constRef(keyType)],
      it,
      (self, [k]) => {
        const at = find(self, keyArg(k));
        return self.location(at < 0 ? self.entries.length : at);
      },
      { isConst }
    );
    method('lower_bound', [constRef(keyType)], it, (self, [k]) => self.location(bound(self, keyArg(k), false)), {
      isConst,
    });
    method('upper_bound', [constRef(keyType)], it, (self, [k]) => self.location(bound(self, keyArg(k), true)), {
      isConst,
    });
    if (isMap && !isMulti) {
      method(
        'at',
        [constRef(keyType)],
        referenceTo(isConst ? withConst(valueType as Type) : (valueType as Type)),
        (self, [k], frame) => {
          const at = find(self, keyArg(k));
          if (at < 0) return throwLibrary(frame, library.exception('out_of_range'), 'map::at:  key not found');
          return new Ptr(self.entries[at] as CObject, 1);
        },
        { isConst }
      );
    }
  }
  method('cbegin', [], types.constIterator, (self) => self.location(0), { isConst: true });
  method('cend', [], types.constIterator, (self) => self.location(self.entries.length), { isConst: true });
  method(
    'count',
    [constRef(keyType)],
    SIZE_T,
    (self, [k]) => BigInt(bound(self, keyArg(k), true) - bound(self, keyArg(k), false)),
    { isConst: true }
  );
  method('contains', [constRef(keyType)], BOOL, (self, [k]) => (find(self, keyArg(k)) >= 0 ? 1 : 0), { isConst: true });
  method(
    'insert',
    [constRef(unqualified(entryType))],
    isMulti ? types.iterator : classType(insertResult),
    (self, [entry], frame) => insertionResult(self, ...insertCopy(table, frame, self, (entry as Ptr).read()))
  );
  if (valueType && !isMulti) {
    method(
      'insert_or_assign',
      [constRef(keyType), constRef(valueType)],
      classType(insertResult),
      (self, [key, value], frame) => {
        const keyValue = keyArg(key);
        const source = (value as Ptr).read();
        const at = find(self, keyValue);
        if (at >= 0) {
          const entry = self.entries[at] as CObject;
          entry.values[1] = mapped().assign(frame, entry.values[1], source);
          return insertionResult(self, at, false);
        }
        const keyOps = elementOperations(compiler, unqualified(keyType), 0);
        const entry = new CObject((entryType as Extract<Type, { kind: 'class' }>).cls, [
          keyOps.copy(frame, keyValue),
          mapped().copy(frame, source),
        ]);
        return insertionResult(self, ...insert(frame, self, entry));
      }
    );
  }
  method(
    'insert',
    [types.constIterator, constRef(unqualified(entryType))],
    types.iterator,
    (self, [hint, entry], frame) => {
      positionOf(self, hint);
      return self.location(insertCopy(table, frame, self, (entry as Ptr).read())[0]);
    }
  );
  method('erase', [constRef(keyType)], SIZE_T, (self, [k], frame) => {
    const keyValue = keyArg(k);
    const from = bound(self, keyValue, false);
    const to = bound(self, keyValue, true);
    const removed = self.splice(from, to - from);
    destroyAll(frame, removed);
    return BigInt(removed.length);
  });
  method('erase', [types.constIterator], types.iterator, (self, [at], frame) => {
    const index = positionOf(self, at, false);
    const [removed] = self.splice(index, 1);
    ops().destroy?.(frame, removed);
    return self.location(index);
  });
  method('erase', [types.constIterator, types.constIterator], types.iterator, (self, [first, last], frame) => {
    const [from, to] = rangePositions(self, first, last);
    destroyAll(frame, self.splice(from, to - from));
    return self.location(from);
  });
  method('swap', [referenceTo(classType(cls))], VOID, (self, [other]) => {
    const target = (other as Ptr).read() as OrderedValue;
    self.swap(target);
  });
  return cls;
}

const keyArg = (arg: unknown): Value => (arg as Ptr).read();

/** Stops at `m[key]` of a map whose mapped type has no default constructor, which `[]` needs to insert an entry. */
export function mappedNotDefaultConstructible(compiler: ExpressionCompiler, mapped: Type, row: number): never {
  return compiler.error(
    row,
    `${typeName(mapped)} のオブジェクトは引数なしでは作れないので、[] は使えません（at や insert を使ってください）。`
  );
}
