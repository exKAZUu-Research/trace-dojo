import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { Eval, Frame } from '../runtime';
import { type ClassInfo, type Type, typeName, unqualified, VOID, withConst } from '../types';
import { CObject, type Ptr, type Value } from '../values';
import type { ElementOperations } from './elements';
import type { Source } from './sequenceEdits';
import { constructElement, iteratorRange } from './sequences';
import { addMethod, constRef, native, nativeConstructor } from './support';

/** The types of an associative container's entries: the key, the entry, and the mapped value of a map. */
export interface EntryTypes {
  keyType: Type;
  entryType: Type;
  valueType: Type | undefined;
}

/** What the insertions of an associative container need: looking a key up and inserting an entry it made. */
export interface EntryTable<T> {
  keyOf: (entry: Value) => Value;
  /** The position of an entry with the key, or -1 when there is none or the container takes equal keys. */
  lookup: (self: T, key: Value) => number;
  insert: (frame: Frame, self: T, entry: Value) => [number, boolean];
  ops: () => ElementOperations;
}

/** How an associative container compiles `emplace`, `try_emplace`, and `insert` of a pair of another type. */
export interface EmplacementCall<T> {
  types: EntryTypes;
  table: EntryTable<T>;
  resultType: Type;
  isTemporaryObject: boolean;
  /** The call's result for the entry at a position, which it inserted or found. */
  result: (self: T, at: number, inserted: boolean) => Value;
}

/** The arguments of an emplacement: the key they give directly, if any, and how to construct the entry from them. */
interface Emplacing {
  key: Value | undefined;
  make: () => Value;
}

/**
 * Compiles `emplace(args...)`, `try_emplace(key, args...)`, and `insert(pair)` with a pair of another type than the
 * entries, or gives undefined for another member function.
 */
export function emplacementCall<T>(
  compiler: ExpressionCompiler,
  object: Expr,
  member: string,
  args: Expr[],
  row: number,
  call: EmplacementCall<T>
): Expr | undefined {
  const { entryType, valueType } = call.types;
  if (member === 'try_emplace' && !valueType) return;
  const [arg] = args;
  const isPairInsert =
    member === 'insert' &&
    valueType !== undefined &&
    args.length === 1 &&
    arg.type.kind === 'class' &&
    arg.type.cls.library?.kind === 'pair' &&
    arg.type.cls !== (entryType as Extract<Type, { kind: 'class' }>).cls;
  if (member !== 'emplace' && member !== 'try_emplace' && !isPairInsert) return;
  const self = compiler.objectOf(object);
  const emplace = compileEmplacing(compiler, args, call.types, member === 'try_emplace', row);
  return {
    type: call.resultType,
    isLvalue: false,
    row,
    isTemporaryObject: call.isTemporaryObject,
    run: (frame) => {
      const target = (self(frame) as Ptr).read() as T;
      return emplace(frame, (emplacing) => {
        const [at, inserted] = emplaceEntry(call.table, frame, target, emplacing);
        return call.result(target, at, inserted);
      });
    },
  };
}

/**
 * Adds the range constructor and `insert(first, last)` of an associative container, which take iterators of any
 * container or pointers whose elements construct entries.
 */
export function addRangeMembers<T>(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  entryType: Type,
  table: EntryTable<T>,
  make: () => T
): void {
  const rangeOf = (args: Expr[]): ReturnType<typeof iteratorRange> =>
    args.length === 2 ? iteratorRange(compiler, args, unqualified(entryType), table.ops) : undefined;
  cls.constructors.push({
    ...nativeConstructor(cls, [], () => {}),
    instantiate: (args) => {
      const range = rangeOf(args);
      if (!range) return;
      return nativeConstructor(cls, range.params, ([first, last], { frame }) => {
        const self = make();
        insertRange(table, frame, self, range.read(first, last));
        return self;
      });
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
}

/** Inserts a copy of an entry unless its key is there already, which libc++ looks up before it copies. */
export function insertCopy<T>(table: EntryTable<T>, frame: Frame, self: T, entry: Value): [number, boolean] {
  return emplaceEntry(table, frame, self, {
    key: table.keyOf(entry),
    make: () => table.ops().copy(frame, entry),
  });
}

/** Inserts the elements of an iterator range, as the range constructor and `insert(first, last)` do. */
export function insertRange<T>(table: EntryTable<T>, frame: Frame, self: T, source: Source): void {
  for (const value of source.values) {
    if (source.isSameType) insertCopy(table, frame, self, value);
    else emplaceEntry(table, frame, self, { key: undefined, make: () => source.construct(frame, value) });
  }
}

/**
 * Inserts the entry an emplacement makes: when it gives the key, only after looking the key up, and otherwise by
 * making the entry and destroying it again when its key is there already.
 */
function emplaceEntry<T>(table: EntryTable<T>, frame: Frame, self: T, { key, make }: Emplacing): [number, boolean] {
  const existing = key === undefined ? -1 : table.lookup(self, key);
  if (existing >= 0) return [existing, false];
  const entry = make();
  const [at, inserted] = table.insert(frame, self, entry);
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
  isTry: boolean,
  row: number
): <R>(frame: Frame, use: (emplacing: Emplacing) => R) => R {
  const key = unqualified(keyType);
  const count = args.length;
  // Each argument is evaluated once, into a location the construction then reads, as perfect forwarding passes it.
  const locations = args.map((arg, index) =>
    isTry && index === 0
      ? compiler.convert(arg, constRef(key), row).run
      : arg.isLvalue
        ? arg.run
        : compiler.materialize(arg).run
  );
  const slots: Expr[] = args.map((arg, index) => ({
    type: isTry && index === 0 ? withConst(key) : arg.type,
    isLvalue: true,
    row: arg.row,
    run: (frame) => frame.pending.at(index - count) as Ptr,
  }));
  const keyOf = isTry ? (frame: Frame) => (frame.pending.at(-count) as Ptr).read() : keyExtraction(args, key);
  let make: Eval<Value>;
  if (valueType && (isTry || count === 2)) {
    const keyValue = constructElement(compiler, key, [slots[0]], row);
    const mappedValue = constructElement(compiler, valueType, slots.slice(1), row);
    const cls = (entryType as Extract<Type, { kind: 'class' }>).cls;
    make = (frame) => new CObject(cls, [keyValue(frame), mappedValue(frame)]);
  } else {
    make = constructElement(compiler, unqualified(entryType), slots, row);
  }
  return (frame, use) => {
    const values = locations.map((location) => location(frame) as Ptr);
    frame.pending.push(...values);
    try {
      return use({ key: keyOf?.(frame), make: () => make(frame) });
    } finally {
      frame.pending.length -= count;
    }
  };
}

/** Where the arguments of `emplace`, held at the end of `frame.pending`, give the key, if they do. */
function keyExtraction(args: Expr[], key: Type): ((frame: Frame) => Value) | undefined {
  const isKey = (type: Type): boolean =>
    typeName(unqualified(type.kind === 'array' ? { kind: 'pointer', to: type.of } : type)) === typeName(key);
  const [first] = args;
  if ((args.length === 1 || args.length === 2) && isKey(first.type))
    return (frame) => (frame.pending.at(-args.length) as Ptr).read();
  if (
    args.length === 1 &&
    first.type.kind === 'class' &&
    first.type.cls.library?.kind === 'pair' &&
    isKey(first.type.cls.fields[0].type)
  )
    return (frame) => ((frame.pending.at(-1) as Ptr).read() as CObject).values[0];
  return undefined;
}
