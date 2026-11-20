import { CompileError } from '../../interpreter/diagnostics';
import { implicitConversion } from '../conversions';
import { CppRuntimeError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { Frame } from '../runtime';
import {
  alignOf,
  allowsConstantCopy,
  allowsMemberAssignment,
  BOOL,
  ClassInfo,
  classType,
  type FunctionInfo,
  intMax,
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
  destroyElements,
  type ElementOperations,
  elementOperations,
  equalTo,
  lessThan,
  requireDefaultConstruction,
  requireElementUse,
  swapElements,
} from './elements';
import {
  addRangeMembers,
  associativeInitializerList,
  constructPair,
  copyEntries,
  emplacementCall,
  type EntryTable,
  insertCopy,
  type PairMemberInitializer,
  pairResult,
} from './emplacement';
import { positionOf, randomAccessIterator, rangePositions } from './iterators';
import type { Library } from './registry';
import { elementConstruction } from './sequences';
import { addMethod, constRef, generic, native, nativeConstructor, type NativeOptions, throwLibrary } from './support';
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
    fieldOffsets: [0, secondOffset],
    operator: (compiler, operator, operands, row) => {
      const [left, right] = operands;
      const isSelf = (expr: Expr | undefined): boolean => expr?.type.kind === 'class' && expr.type.cls === cls;
      if (!['==', '!=', '<', '<=', '>', '>='].includes(operator) || !isSelf(left) || !isSelf(right)) return;
      const type = classType(cls);
      const compare = operator === '==' || operator === '!=' ? equalTo(type) : lessThan(type);
      if (!compare) return compiler.error(row, `${cls.name} の値は ${operator} で比べられません。`);
      return {
        type: BOOL,
        isLvalue: false,
        row,
        run: compiler.compareObjects(left, right, orderTest(operator, compare)),
      };
    },
  };
  const construct = (frame: Frame, initialize: [PairMemberInitializer, PairMemberInitializer]): CObject =>
    constructPair(frame, cls, initialize, (index) => ops()[index].destroy);
  cls.operations = {
    copy: (frame, source) => {
      const [a, b] = (source as CObject).values;
      return construct(frame, [(f, target) => ops()[0].copy(f, a, target), (f, target) => ops()[1].copy(f, b, target)]);
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
      (_args, { frame }) =>
        construct(frame, [(f, target) => ops()[0].make(f, target), (f, target) => ops()[1].make(f, target)]),
      {
        libraryConstant: () => (constantMembers ? true : undefined),
        uses: (row) => {
          requireDefaultConstruction(library.compiler, first, row);
          requireDefaultConstruction(library.compiler, second, row);
        },
      }
    ),
    {
      ...nativeConstructor(cls, [], () => {}),
      instantiate: (args) => {
        if (args.length !== 2) return;
        const forwarded = pairForwarding(library.compiler, cls, args, ops);
        return nativeConstructor(cls, forwarded.params, forwarded.run, forwarded.options);
      },
      isTemplate: true,
    },
    {
      ...nativeConstructor(cls, [], () => {}),
      instantiate: (args) => {
        const [source] = args;
        if (
          args.length !== 1 ||
          source.type.kind !== 'class' ||
          source.type.cls.library?.kind !== 'pair' ||
          source.type.cls === cls
        )
          return;
        const isXvalue = (!source.isLvalue || source.isXvalue === true) && !isConstType(source.type);
        const incoming = source.type.cls.fields;
        return library.compiler.withLibraryAccess(() => {
          try {
            const initialize = incoming.map(({ type }, index) =>
              pairMemberBinding(
                library.compiler,
                cls.fields[index].type,
                type.kind === 'reference' || isXvalue ? nonReference(type) : withConst(type),
                type.kind !== 'reference' && isXvalue,
                source.row
              )
            );
            return nativeConstructor(
              cls,
              [constRef(source.type)],
              ([pair], { frame }) => {
                const object = (pair as Ptr).read() as CObject;
                const member =
                  (index: number): PairMemberInitializer =>
                  (f, target) =>
                    initialize[index].make(
                      f,
                      incoming[index].type.kind === 'reference'
                        ? (object.values[index] as Ptr)
                        : new Ptr(object, index),
                      target
                    );
                return construct(frame, [member(0), member(1)]);
              },
              pairConstructionOptions(library.compiler, cls, initialize)
            );
          } catch (error) {
            if (error instanceof CompileError) return;
            throw error;
          }
        });
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
  return generic('make_pair', (args, specified) => {
    if (args.length !== 2 || (specified && specified.length > 2)) return;
    if (specified?.some((type, at) => type.kind !== 'reference' && args[at].isLvalue && !args[at].isXvalue)) return;
    const types = args.map((arg, at) => decayed(nonReference(specified?.[at] ?? arg.type)));
    if (types.some((type) => type.kind === 'void')) return;
    const cls = pairClass(library, types[0], types[1]);
    const compiler = library.compiler;
    const ops = (): ElementOperations[] => types.map((type) => elementOperations(compiler, type, 0));
    const forwarded = pairForwarding(compiler, cls, args, ops, specified);
    return native('make_pair', forwarded.params, classType(cls), forwarded.run, forwarded.options);
  });
}

interface PairMemberBinding {
  make: (frame: Frame, loc: Ptr, destination?: CObject) => Value;
  isImplicit: boolean;
  isConstant: boolean;
}

interface PairForwarding {
  params: Type[];
  run: NonNullable<FunctionInfo['native']>;
  options: NativeOptions;
}

function pairForwarding(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  args: Expr[],
  ops: () => ElementOperations[],
  specified?: Type[]
): PairForwarding {
  const params: Type[] = [];
  const initialize = compiler.withLibraryAccess(() =>
    cls.fields.map(({ type }, index) => {
      const arg = args[index];
      const explicit = specified?.[index];
      const incoming = explicit ? nonReference(explicit) : arg.braced ? nonReference(type) : arg.type;
      if (type.kind === 'reference') {
        params.push(type);
        return { make: (_frame: Frame, loc: Ptr) => loc, isImplicit: true, isConstant: true };
      }
      const parameter = explicit?.kind === 'reference' ? explicit : constRef(decayed(incoming));
      params.push(parameter);
      const isXvalue = explicit?.kind !== 'reference' && (!arg.isLvalue || arg.isXvalue === true);
      return pairMemberBinding(
        compiler,
        type,
        incoming.kind === 'array' ? decayed(incoming) : incoming,
        isXvalue,
        arg.row,
        arg
      );
    })
  );
  const run: NonNullable<FunctionInfo['native']> = ([a, b], { frame }) =>
    constructPair(
      frame,
      cls,
      [(f, target) => initialize[0].make(f, a as Ptr, target), (f, target) => initialize[1].make(f, b as Ptr, target)],
      (index) => ops()[index].destroy
    );
  return { params, run, options: pairConstructionOptions(compiler, cls, initialize) };
}

function pairMemberBinding(
  compiler: ExpressionCompiler,
  type: Type,
  incoming: Type,
  isXvalue: boolean,
  row: number,
  arg?: Expr
): PairMemberBinding {
  const slot: Expr = {
    type: incoming,
    isLvalue: true,
    isXvalue,
    row,
    constantInitialization: true,
    literalBytes: arg?.literalBytes,
    run: (f) => f.pending.at(-1) as Ptr,
  };
  const target = type.kind === 'reference' ? type : unqualified(type);
  const implicit = implicitConversion(compiler, slot, target);
  const construct =
    type.kind === 'reference' ? compiler.convert(slot, type, row) : elementConstruction(compiler, target, [slot], row);
  return {
    make: (frame: Frame, loc: Ptr, destination?: CObject): Value => {
      frame.pending.push(loc);
      try {
        return construct.run(frame, undefined, destination) as Value;
      } finally {
        frame.pending.pop();
      }
    },
    isImplicit: implicit !== undefined,
    isConstant:
      target.kind !== 'class' || sameType(target, incoming, false) || construct.constantInitialization === true,
  };
}

function pairConstructionOptions(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  initialize: readonly PairMemberBinding[]
): NativeOptions {
  return {
    isExplicit: initialize.some((member) => !member.isImplicit),
    libraryConstant: () =>
      cls.library?.allowsConstantCopy && initialize.every((member) => member.isConstant) ? true : undefined,
    uses: (row: number) => compiler.requireLibraryObjectUse(classType(cls), 'destroy', row),
  };
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
    entryType: Type
  ) {
    super(entryType);
  }

  private readonly nodes = new NodePositions(this);

  override location(index: number): Ptr {
    if (index === this.length) throw new CppRuntimeError('invalidIterator');
    const location = this.nodes.at(index).cellLocation(this.entryType);
    const value = this.entries[index];
    if (value instanceof CObject) value.bindContainerCell(location);
    return location;
  }

  override iteratorLocation(index: number): Ptr {
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
    if (name === 'std::less' || name === 'std::greater') {
      const apply = comparator.cls.library.apply?.(unqualified(keyType), unqualified(keyType));
      if (!apply) return compiler.error(row, `${typeName(comparator)} は ${typeName(keyType)} のキーに使えません。`);
      return (a, b) => (apply(a, b) ? -1 : apply(b, a) ? 1 : 0);
    }
  }
  return compiler.unsupported(row, `比べ方に ${typeName(comparator)} を使うこと`);
}

/** The members of an ordered associative container that compare keys, besides `erase` of a key. */
const COMPARING_MEMBERS = new Set([
  'insert',
  'emplace',
  'emplace_hint',
  'try_emplace',
  'insert_or_assign',
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
  const make = (entries: Value[]): OrderedValue => new OrderedValue(entries, entryType);
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
  const insert = (frame: Frame, self: OrderedValue, entry: Value, hint?: Ptr): [number, boolean] => {
    const key = keyOf(entry);
    if (!isMulti) {
      const existing = find(self, key);
      if (existing >= 0) return [existing, false];
    }
    frame.runtime.reserve(1);
    const at = isMulti && hint ? hintedPosition(self, key, positionOf(self, hint)) : bound(self, key, true);
    self.splice(at, 0, entry);
    return [at, true];
  };
  const hintedPosition = (self: OrderedValue, key: Value, hint: number): number => {
    if (hint < self.entries.length && order(keyOf(self.entries[hint]), key) < 0) return bound(self, key, false);
    if (hint > 0 && order(key, keyOf(self.entries[hint - 1])) < 0) return bound(self, key, true);
    return hint;
  };
  const destroyAll = (frame: Frame, entries: Value[]): void => {
    destroyElements(frame, entries, ops().destroy);
  };
  const table: EntryTable<OrderedValue> = {
    make: () => make([]),
    keyOf,
    lookup: (self, key) => {
      const at = isMulti ? -1 : find(self, key);
      return at >= 0 ? at : undefined;
    },
    insert,
    checkHint: positionOf,
    ops,
  };
  const insertResult = pairClass(library, types.iterator, BOOL);
  const insertionResult = (frame: Frame, self: OrderedValue, at: number, inserted: boolean): Value => {
    const position = self.iteratorLocation(at);
    return isMulti ? position : pairResult(frame, insertResult, position, inserted ? 1 : 0);
  };
  cls.library = {
    kind,
    args,
    size: 24,
    align: 8,
    listElementType: unqualified(entryType),
    listInitializer: (compiler_, elements, row) => {
      checkOrder(compiler_, row);
      return associativeInitializerList(compiler_, cls, entryType, elements, row, table);
    },
    operator: (compiler_, operator, operands, row) => {
      const [left, right] = operands;
      if (operator === '[]' && isMap && isSelf(left) && !isMulti) {
        checkOrder(compiler_, row);
        if (isConstType(left.type))
          return compiler_.error(row, `const の ${cls.name} には [] を使えません（at を使ってください）。`);
        if (!mapped().isDefaultConstructible) return mappedNotDefaultConstructible(compiler_, valueType as Type, row);
        requireDefaultConstruction(compiler_, valueType as Type, row);
        requireElementUse(compiler_, keyType, row, 'copy');
        const keyRun = compiler_.convert(right, constRef(keyType), row).run;
        return {
          type: valueType as Type,
          isLvalue: true,
          row,
          run: compiler_.subscriptObject(left, keyRun, (frame, receiver, key) => {
            const self = receiver as OrderedValue;
            const keyValue = (key as Ptr).read();
            let at = find(self, keyValue);
            if (at < 0) {
              const keyOps = elementOperations(compiler, unqualified(keyType), row);
              [at] = insert(
                frame,
                self,
                constructPair(
                  frame,
                  (entryType as Extract<Type, { kind: 'class' }>).cls,
                  [(f, target) => keyOps.copy(f, keyValue, target), (f, target) => mapped().make(f, target)],
                  (index) => (index === 0 ? keyOps.destroy : mapped().destroy)
                )
              );
            }
            return new Ptr(self.entries[at] as CObject, 1);
          }),
        };
      }
      if (['==', '!=', '<', '<=', '>', '>='].includes(operator) && isSelf(left) && isSelf(right)) {
        const compareEntry =
          operator === '==' || operator === '!=' ? equalTo(unqualified(entryType)) : lessThan(unqualified(entryType));
        if (!compareEntry) return compiler_.error(row, `${cls.name} の値は ${operator} で比べられません。`);
        return {
          type: BOOL,
          isLvalue: false,
          row,
          run: compiler_.compareObjects(left, right, (first, second) => {
            const x = (first as OrderedValue).entries;
            const y = (second as OrderedValue).entries;
            if (operator === '==' || operator === '!=') {
              const same =
                x.length === y.length &&
                x.every((item, index) => (compareEntry as (p: Value, q: Value) => boolean)(item, y[index]));
              return (operator === '==') === same;
            }
            const less = compareEntry as Order;
            let result = 0;
            for (let index = 0; index < Math.min(x.length, y.length) && result === 0; index++)
              result = less(x[index], y[index]);
            if (result === 0) result = x.length - y.length;
            return orderTest(operator, () => result)(undefined, undefined);
          }),
        };
      }
      return;
    },
    memberCall: (compiler_, object, member, callArgs, row) => {
      const [first, second] = callArgs;
      const isKeyErase =
        member === 'erase' &&
        callArgs.length === 1 &&
        (first.type.kind !== 'class' || first.type.cls.library?.kind !== 'iterator');
      if (COMPARING_MEMBERS.has(member) || isKeyErase) checkOrder(compiler_, row);
      const isHinted =
        member === 'emplace_hint' ||
        (member === 'insert' &&
          callArgs.length === 2 &&
          second?.type.kind === 'class' &&
          second.type.cls.library?.kind === 'pair');
      if (isHinted && !first) return compiler_.error(row, 'emplace_hint には挿入位置を書いてください。');
      const hint = isHinted ? compiler_.convert(first, types.constIterator, row).run : undefined;
      const returnsIterator = isHinted || isMulti;
      return emplacementCall(
        compiler_,
        object,
        member === 'emplace_hint' ? 'emplace' : member,
        isHinted ? callArgs.slice(1) : callArgs,
        row,
        {
          types: { keyType, entryType, valueType },
          table,
          hint,
          resultType: returnsIterator ? types.iterator : classType(insertResult),
          isTemporaryObject: !returnsIterator,
          mappedLocation: valueType && !isMulti ? (self, at) => new Ptr(self.entries[at] as CObject, 1) : undefined,
          result: isHinted ? (_frame, self, at) => self.iteratorLocation(at) : insertionResult,
        }
      );
    },
    constructingMembers:
      isMap && !isMulti ? ['emplace', 'emplace_hint', 'try_emplace', 'insert_or_assign'] : ['emplace', 'emplace_hint'],
    ownedTypes: [entryType],
    elementUseOnAssignment: 'copy',
  };
  cls.operations = {
    copy: (frame, source) => {
      const { entries } = source as OrderedValue;
      frame.runtime.reserve(entries.length);
      return make(copyEntries(frame, entries, ops()));
    },
    assign: (frame, target, source) => {
      const to = target as OrderedValue;
      const from = source as OrderedValue;
      if (to === from) return;
      const old = to.entries;
      frame.runtime.reserve(from.entries.length);
      to.replace(copyEntries(frame, from.entries, ops()));
      destroyAll(frame, old);
    },
    destroy: (frame, value) => destroyAll(frame, (value as OrderedValue).entries),
  };
  cls.constructors = [nativeConstructor(cls, [], () => make([]))];
  addRangeMembers(compiler, cls, entryType, table);
  const method = (
    memberName: string,
    params: Type[],
    ret: Type,
    run: (self: OrderedValue, args: unknown[], frame: Frame) => unknown,
    options: NativeOptions = {}
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
  method('max_size', [], SIZE_T, () => treeMaxSize(entryType), { isConst: true });
  method('empty', [], BOOL, (self) => (self.entries.length === 0 ? 1 : 0), { isConst: true });
  method('clear', [], VOID, (self, _args, frame) => {
    const old = self.replace([]);
    destroyAll(frame, old);
  });
  for (const isConst of [false, true]) {
    const it = isConst ? types.constIterator : types.iterator;
    const rit = isConst ? types.constReverseIterator : types.reverseIterator;
    method('begin', [], it, (self) => self.iteratorLocation(0), { isConst });
    method('end', [], it, (self) => self.iteratorLocation(self.entries.length), { isConst });
    const range = pairClass(library, it, it);
    method(
      'equal_range',
      [constRef(keyType)],
      classType(range),
      (self, [key], frame) => {
        const value = keyArg(key);
        return pairResult(
          frame,
          range,
          self.iteratorLocation(bound(self, value, false)),
          self.iteratorLocation(bound(self, value, true))
        );
      },
      { isConst }
    );
    method('rbegin', [], rit, (self) => self.iteratorLocation(self.entries.length), { isConst });
    method('rend', [], rit, (self) => self.iteratorLocation(0), { isConst });
    method(
      'find',
      [constRef(keyType)],
      it,
      (self, [k]) => {
        const at = find(self, keyArg(k));
        return self.iteratorLocation(at < 0 ? self.entries.length : at);
      },
      { isConst }
    );
    method(
      'lower_bound',
      [constRef(keyType)],
      it,
      (self, [k]) => self.iteratorLocation(bound(self, keyArg(k), false)),
      {
        isConst,
      }
    );
    method('upper_bound', [constRef(keyType)], it, (self, [k]) => self.iteratorLocation(bound(self, keyArg(k), true)), {
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
  method('cbegin', [], types.constIterator, (self) => self.iteratorLocation(0), { isConst: true });
  method('cend', [], types.constIterator, (self) => self.iteratorLocation(self.entries.length), { isConst: true });
  method(
    'count',
    [constRef(keyType)],
    SIZE_T,
    (self, [k]) => BigInt(bound(self, keyArg(k), true) - bound(self, keyArg(k), false)),
    { isConst: true }
  );
  method('contains', [constRef(keyType)], BOOL, (self, [k]) => (find(self, keyArg(k)) >= 0 ? 1 : 0), { isConst: true });
  const copyEntry = { uses: (row: number) => requireElementUse(compiler, entryType, row, 'copy') };
  method(
    'insert',
    [constRef(unqualified(entryType))],
    isMulti ? types.iterator : classType(insertResult),
    (self, [entry], frame) => insertionResult(frame, self, ...insertCopy(table, frame, self, (entry as Ptr).read())),
    copyEntry
  );
  method(
    'insert',
    [types.constIterator, constRef(unqualified(entryType))],
    types.iterator,
    (self, [hint, entry], frame) =>
      self.iteratorLocation(insertCopy(table, frame, self, (entry as Ptr).read(), hint as Ptr)[0]),
    copyEntry
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
    return self.iteratorLocation(index);
  });
  method('erase', [types.constIterator, types.constIterator], types.iterator, (self, [first, last], frame) => {
    const [from, to] = rangePositions(self, first, last);
    destroyAll(frame, self.splice(from, to - from));
    return self.iteratorLocation(from);
  });
  method('swap', [referenceTo(classType(cls))], VOID, (self, [other]) => {
    const target = (other as Ptr).read() as OrderedValue;
    self.swap(target);
  });
  return cls;
}

const keyArg = (arg: unknown): Value => (arg as Ptr).read();

function treeMaxSize(entry: Type): bigint {
  const alignment = alignOf(entry);
  // libc++ uses the tail padding after the three pointers and color flag in its arm64 tree node base.
  const offset = Math.ceil(25 / alignment) * alignment;
  const nodeAlignment = Math.max(8, alignment);
  const nodeSize = Math.ceil((offset + sizeOf(entry)) / nodeAlignment) * nodeAlignment;
  return intMax(SIZE_T.name) / BigInt(nodeSize);
}

export function mappedNotDefaultConstructible(compiler: ExpressionCompiler, mapped: Type, row: number): never {
  return compiler.error(
    row,
    `${typeName(mapped)} のオブジェクトは引数なしでは作れないので、[] は使えません（at や insert を使ってください）。`
  );
}
