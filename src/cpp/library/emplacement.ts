import { CompileError } from '../../interpreter/diagnostics';
import { CppException } from '../errors';
import type { Expr, Initializer } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { constructCells, makeEach, newObject } from '../objectCompiler';
import { type Eval, type Frame, holdAll } from '../runtime';
import type { Syntax } from '../syntax';
import { type ClassInfo, isConstType, type Type, typeName, unqualified, VOID, withConst } from '../types';
import { CObject, endLifetime, holdValues, type Ptr, type Store, type Value } from '../values';
import { type ElementOperations, requireElementUse } from './elements';
import type { Source } from './sequenceEdits';
import { constructElement, initializerList, iteratorRange, listElementsOf } from './sequences';
import { addMethod, constRef, native, nativeConstructor } from './support';

/** The types of an associative container's entries: the key, the entry, and the mapped value of a map. */
export interface EntryTypes {
  keyType: Type;
  entryType: Type;
  valueType: Type | undefined;
}

/** What the insertions of an associative container need: looking a key up and inserting an entry it made. */
export interface EntryTable<T, Position = number> {
  make: () => T;
  keyOf: (entry: Value) => Value;
  /** The position of an entry with the key, or undefined when there is none or the container takes equal keys. */
  lookup: (frame: Frame, self: T, key: Value) => Position | undefined;
  insert: (frame: Frame, self: T, entry: Value, hint?: Ptr) => [Position, boolean];
  checkHint?: (self: T, hint: Ptr) => void;
  ops: () => ElementOperations;
}

/** How an associative container compiles `emplace`, `try_emplace`, and `insert` of a pair of another type. */
export interface EmplacementCall<T, Position> {
  types: EntryTypes;
  table: EntryTable<T, Position>;
  resultType: Type;
  isTemporaryObject: boolean;
  hint?: Eval<unknown>;
  mappedLocation?: (self: T, at: Position) => Ptr;
  /** The call's result for the entry at a position, which it inserted or found. */
  result: (frame: Frame, self: T, at: Position, inserted: boolean) => Value;
}

/** The arguments of an emplacement: the key they give directly, if any, and how to construct the entry from them. */
interface Emplacing {
  key: Value | undefined;
  make: () => Value;
  assign?: (target: Ptr) => void;
}

/**
 * Compiles `emplace(args...)`, `try_emplace(key, args...)`, and `insert(pair)` with a pair of another type than the
 * entries, or gives undefined for another member function.
 */
export function emplacementCall<T, Position>(
  compiler: ExpressionCompiler,
  object: Expr,
  member: string,
  args: Expr[],
  row: number,
  call: EmplacementCall<T, Position>
): Expr | undefined {
  const { entryType, valueType } = call.types;
  if (member === 'try_emplace' && !valueType) return;
  const mappedLocation = member === 'insert_or_assign' ? call.mappedLocation : undefined;
  if (mappedLocation && args.length !== 2)
    return compiler.error(row, 'insert_or_assign にはキーと値を書いてください。');
  const [arg] = args;
  const isPairInsert =
    member === 'insert' &&
    valueType !== undefined &&
    args.length === 1 &&
    arg.type.kind === 'class' &&
    arg.type.cls.library?.kind === 'pair' &&
    (arg.type.cls !== (entryType as Extract<Type, { kind: 'class' }>).cls ||
      ((!arg.isLvalue || arg.isXvalue) && !isConstType(arg.type)));
  if (member !== 'emplace' && member !== 'try_emplace' && !isPairInsert && !mappedLocation) return;
  if (isConstType(object.type)) return compiler.error(row, `const のオブジェクトには ${member} を使えません。`);
  const self = compiler.objectOf(object);
  const mode = mappedLocation ? 'assign' : member === 'try_emplace' ? 'try' : 'insert';
  const emplace = compileEmplacing(compiler, args, call.types, mode, row);
  return {
    type: call.resultType,
    isLvalue: false,
    row,
    isTemporaryObject: call.isTemporaryObject,
    run: (frame) =>
      holdAll(frame, call.hint ? [self, call.hint] : [self], ([receiver, position]) =>
        emplace(frame, (emplacing) => {
          const target = (receiver as Ptr).read() as T;
          const [at, inserted] = emplaceEntry(call.table, frame, target, emplacing, {
            mappedLocation,
            hint: position as Ptr | undefined,
          });
          return call.result(frame, target, at, inserted);
        })
      ),
  };
}

/**
 * Adds the range constructor and `insert(first, last)` of an associative container, which take iterators of any
 * container or pointers whose elements construct entries.
 */
export function addRangeMembers<T extends Store, Position>(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  entryType: Type,
  table: EntryTable<T, Position>
): void {
  const rangeOf = (args: Expr[]): ReturnType<typeof iteratorRange> =>
    args.length === 2 ? iteratorRange(compiler, args, unqualified(entryType), table.ops) : undefined;
  cls.constructors.push({
    ...nativeConstructor(cls, [], () => {}),
    instantiate: (args) => {
      const range = rangeOf(args);
      if (!range) return;
      return nativeConstructor(cls, range.params, ([first, last], { frame }) =>
        constructEntries(frame, cls, table, range.read(first, last))
      );
    },
    isTemplate: true,
  });
  addMethod(cls, {
    ...native('insert', [], VOID, () => {}),
    instantiate: (args) => {
      const range = rangeOf(args);
      if (!range) return;
      return native(
        'insert',
        range.params,
        VOID,
        ([first, last], { self, frame }) => insertRange(table, frame, self as T, range.read(first, last)),
        { owner: cls }
      );
    },
    isTemplate: true,
  });
  addMethod(cls, {
    ...native('insert', [], VOID, () => {}),
    instantiate: (args) => {
      const braced = args.length === 1 ? args[0].braced : undefined;
      if (!braced) return;
      let list: ReturnType<typeof initializerList>;
      try {
        list = initializerList(compiler, unqualified(entryType), braced, table.ops);
      } catch (error) {
        if (error instanceof CompileError) return;
        throw error;
      }
      return native(
        'insert',
        [{ kind: 'function', ret: VOID, params: [] }],
        VOID,
        (_args, { self, frame }) => {
          list(frame, (source) => insertRange(table, frame, self as T, source));
        },
        { owner: cls }
      );
    },
    isTemplate: true,
  });
}

export function associativeInitializerList<T extends Store, Position>(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  entryType: Type,
  elements: readonly Syntax[],
  row: number,
  table: EntryTable<T, Position>
): Initializer {
  const type = unqualified(entryType);
  if (elements.length > 0) requireElementUse(compiler, type, row, 'copy');
  const list = listElementsOf(
    elements.map((node) => compiler.elementInitializer(type, node)),
    table.ops
  );
  return (frame) => list(frame, (source) => constructEntries(frame, cls, table, source));
}

function constructEntries<T extends Store, Position>(
  frame: Frame,
  cls: ClassInfo,
  table: EntryTable<T, Position>,
  source: Source
): T {
  const self = table.make();
  return holdAll(frame, [() => self], () => {
    try {
      insertRange(table, frame, self, source);
      return self;
    } catch (error) {
      if (error instanceof CppException) {
        cls.operations?.destroy?.(frame, self);
        endLifetime(self);
      }
      throw error;
    }
  });
}

export function copyEntries(
  frame: Frame,
  entries: readonly Value[],
  ops: ElementOperations,
  cleanup: 'destroy' | 'release' = 'destroy'
): Value[] {
  const destroy = cleanup === 'destroy' ? ops.destroy : undefined;
  return makeEach(
    frame,
    entries.length,
    (index) => ops.copy(frame, entries[index]),
    () => destroy,
    undefined,
    'forward'
  );
}

/** Inserts a copy of an entry unless its key is there already, which libc++ looks up before it copies. */
export function insertCopy<T, Position>(
  table: EntryTable<T, Position>,
  frame: Frame,
  self: T,
  entry: Value,
  hint?: Ptr
): [Position, boolean] {
  return emplaceEntry(
    table,
    frame,
    self,
    { key: table.keyOf(entry), make: () => table.ops().copy(frame, entry) },
    { hint }
  );
}

/** Inserts the elements of an iterator range, as the range constructor and `insert(first, last)` do. */
export function insertRange<T, Position>(table: EntryTable<T, Position>, frame: Frame, self: T, source: Source): void {
  for (let index = 0; index < source.length; index++) {
    emplaceEntry(table, frame, self, {
      key: source.isSameType ? table.keyOf(source.read(index)) : undefined,
      make: () => source.construct(frame, index),
    });
  }
}

export type PairMemberInitializer = (frame: Frame, destination?: CObject) => Value;

export function constructPair(
  frame: Frame,
  cls: ClassInfo,
  members: readonly [PairMemberInitializer, PairMemberInitializer],
  destroyAt: (index: number) => ElementOperations['destroy']
): CObject {
  const pair = newObject(frame, cls);
  return constructCells(
    frame,
    pair,
    members.length,
    (index) => cls.fields[index].type,
    (current, target, index) => members[index](current, target instanceof CObject ? target : undefined),
    destroyAt
  );
}

export function pairResult(frame: Frame, cls: ClassInfo, first: Value, second: Value): CObject {
  const pair = newObject(frame, cls);
  pair.values[0] = first;
  pair.values[1] = second;
  return pair;
}

/**
 * Inserts the entry an emplacement makes: when it gives the key, only after looking the key up, and otherwise by
 * making the entry and destroying it again when its key is there already.
 */
function emplaceEntry<T, Position>(
  table: EntryTable<T, Position>,
  frame: Frame,
  self: T,
  { key, make, assign }: Emplacing,
  { mappedLocation, hint }: { mappedLocation?: (self: T, at: Position) => Ptr; hint?: Ptr } = {}
): [Position, boolean] {
  if (hint) table.checkHint?.(self, hint);
  const existing = key === undefined ? undefined : table.lookup(frame, self, key);
  if (existing !== undefined) {
    if (mappedLocation) assign?.(mappedLocation(self, existing));
    return [existing, false];
  }
  const entry = make();
  const [at, inserted] = table.insert(frame, self, entry, hint);
  if (!inserted) table.ops().destroy?.(frame, entry);
  return [at, inserted];
}

/**
 * Compiles the arguments of an emplacement as libc++'s `__try_key_extraction` uses them: when an argument is the key
 * itself, or a pair whose first member is, the container looks the key up before it constructs an entry, and
 * constructs none for a key it has.
 */
function compileEmplacing(
  compiler: ExpressionCompiler,
  args: Expr[],
  { keyType, entryType, valueType }: EntryTypes,
  mode: 'insert' | 'try' | 'assign',
  row: number
): <R>(frame: Frame, use: (emplacing: Emplacing) => R) => R {
  const key = unqualified(keyType);
  const count = args.length;
  const explicitKey = mode !== 'insert';
  if (explicitKey && count === 0) return compiler.error(row, 'try_emplace にはキーを書いてください。');
  const positions = new WeakMap<Frame, number>();
  // Each argument is evaluated once, into a location the construction then reads, as perfect forwarding passes it.
  const forwarded = args.map((arg, index) =>
    explicitKey && index === 0 ? compiler.convert(arg, constRef(key), row) : compiler.materialize(arg)
  );
  const locations = forwarded.map((arg) => arg.run);
  const slots: Expr[] = forwarded.map((arg, index) => ({
    type: explicitKey && index === 0 ? (arg.isXvalue && !isConstType(arg.type) ? key : withConst(key)) : arg.type,
    isLvalue: true,
    isXvalue: arg.isXvalue,
    row: arg.row,
    run: (frame) => frame.pending[(positions.get(frame) as number) + index] as Ptr,
  }));
  const keyOf = explicitKey ? (location: Ptr) => location.read() : keyExtraction(args, key);
  let make: Eval<Value>;
  let assign: Eval<unknown> | undefined;
  if (valueType && (explicitKey || count === 2)) {
    const keyValue = constructElement(compiler, key, [slots[0]], row);
    const mappedValue = constructElement(compiler, valueType, slots.slice(1), row);
    const cls = (entryType as Extract<Type, { kind: 'class' }>).cls;
    const destroyers = compiler.withLibraryAccess(() => cls.fields.map(({ type }) => compiler.destroyerOf(type, row)));
    make = (frame) => constructPair(frame, cls, [keyValue, mappedValue], (index) => destroyers[index]);
    if (mode === 'assign') {
      const target: Expr = {
        type: valueType,
        isLvalue: true,
        row,
        run: (frame) => frame.pending[(positions.get(frame) as number) + count] as Ptr,
      };
      assign = compiler.withLibraryAccess(() => compiler.assign('=', target, slots[1], row)).run;
    }
  } else {
    make = constructElement(compiler, unqualified(entryType), slots, row);
  }
  return (frame, use) => {
    const previous = positions.get(frame);
    positions.set(frame, frame.pending.length);
    try {
      return holdAll(frame, locations, (values) =>
        holdValues(frame, values as Value[], () =>
          use({
            key: keyOf?.(values[0] as Ptr),
            make: () => make(frame),
            assign: assign ? (target) => holdValues(frame, [target], () => assign(frame)) : undefined,
          })
        )
      );
    } finally {
      if (previous === undefined) positions.delete(frame);
      else positions.set(frame, previous);
    }
  };
}

/** Where the arguments of `emplace`, held at the end of `frame.pending`, give the key, if they do. */
function keyExtraction(args: Expr[], key: Type): ((location: Ptr) => Value) | undefined {
  const isKey = (type: Type): boolean =>
    typeName(unqualified(type.kind === 'array' ? { kind: 'pointer', to: type.of } : type)) === typeName(key);
  const [first] = args;
  if ((args.length === 1 || args.length === 2) && isKey(first.type)) return (location) => location.read();
  if (
    args.length === 1 &&
    first.type.kind === 'class' &&
    first.type.cls.library?.kind === 'pair' &&
    isKey(first.type.cls.fields[0].type)
  )
    return (location) => (location.read() as CObject).values[0];
  return undefined;
}
