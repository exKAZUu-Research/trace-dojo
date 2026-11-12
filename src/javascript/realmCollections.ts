import { closingOnThrow, DONE, type HostIterator, ValueIterator } from './iteration';
import type { RealmBuilder } from './realm';
import { defineHostIteratorPrototype, newHostIterator, registeredKeyOf, WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  isAccessor,
  isCallable,
  isObject,
  JsFunction,
  JsObject,
  type NativeCall,
  toBoolean,
  type Value,
} from './values';

export type CollectionKind = 'Map' | 'Set' | 'WeakMap' | 'WeakSet';

export interface CollectionEntry {
  key: Value;
  /** The key itself in a Set. */
  value: Value;
}

/**
 * The slots of a collection, in insertion order, where deleting an entry empties its slot. Compacting the collection
 * moves its live entries to a successor table, and the cursors still on this one follow them there.
 */
class SlotTable {
  readonly entries: (CollectionEntry | undefined)[] = [];
  successor?: SlotTable;
  /** The emptied slots that the move to the successor dropped, ascending; undefined when `clear` dropped them all. */
  droppedSlots?: number[];
}

/**
 * The spec's `[[MapData]]` or `[[SetData]]`. Iterators and `forEach` walk its slots through {@link SlotCursor}s, so they
 * see later additions and skip later deletions as the spec's do. Once emptied slots outnumber the live ones, the entries
 * are compacted, as V8's OrderedHashTable does on rehashing, so that a collection that churns stays cheap to iterate.
 */
export class CollectionState {
  readonly isWeak: boolean;
  private table = new SlotTable();
  /** The slot of each live key, which the host's Map finds by SameValueZero as JavaScript's does. */
  private readonly slots = new Map<Value, number>();

  constructor(readonly kind: CollectionKind) {
    this.isWeak = kind === 'WeakMap' || kind === 'WeakSet';
  }

  get entries(): readonly (CollectionEntry | undefined)[] {
    return this.table.entries;
  }

  get size(): number {
    return this.slots.size;
  }

  has(key: Value): boolean {
    return this.slots.has(key);
  }

  entryOf(key: Value): CollectionEntry | undefined {
    const slot = this.slots.get(key);
    return slot === undefined ? undefined : this.table.entries[slot];
  }

  set(runtime: Runtime, key: Value, value: Value): void {
    const entry = this.entryOf(key);
    if (entry) {
      entry.value = value;
      return;
    }
    runtime.allocate(1);
    this.slots.set(key, this.table.entries.length);
    this.table.entries.push({ key: Object.is(key, -0) ? 0 : key, value });
  }

  delete(key: Value): boolean {
    const slot = this.slots.get(key);
    if (slot === undefined) return false;
    this.slots.delete(key);
    this.table.entries[slot] = undefined;
    const emptied = this.table.entries.length - this.size;
    if (emptied > MIN_SLOTS_TO_COMPACT && emptied > this.size) this.compact();
    return true;
  }

  clear(): void {
    this.slots.clear();
    this.moveTo(new SlotTable(), undefined);
  }

  /** A cursor at the first slot, which visits the live entries in order. */
  cursor(): SlotCursor {
    return new SlotCursor(this.table);
  }

  /** The live entries, charged as one scan. */
  liveEntries(runtime: Runtime): CollectionEntry[] {
    return this.cursor().rest(runtime);
  }

  private compact(): void {
    const next = new SlotTable();
    const dropped: number[] = [];
    for (const [slot, entry] of this.table.entries.entries()) {
      if (!entry) {
        dropped.push(slot);
        continue;
      }
      this.slots.set(entry.key, next.entries.length);
      next.entries.push(entry);
    }
    this.moveTo(next, dropped);
  }

  private moveTo(next: SlotTable, droppedSlots: number[] | undefined): void {
    this.table.successor = next;
    this.table.droppedSlots = droppedSlots;
    this.table = next;
  }
}

const MIN_SLOTS_TO_COMPACT = 8;

/** A position in a collection's slots, which follows the entries when the collection compacts or clears them. */
class SlotCursor {
  private position = 0;

  constructor(private table: SlotTable) {}

  /** The next live entry, or undefined at the end, charging the slots passed over as one scan. */
  next(runtime: Runtime): CollectionEntry | undefined {
    this.follow();
    const { entries } = this.table;
    const start = this.position;
    let entry: CollectionEntry | undefined;
    while (!entry && this.position < entries.length) entry = entries[this.position++];
    runtime.scan(this.position - start);
    return entry;
  }

  /** The live entries from the cursor on, without advancing it. */
  rest(runtime: Runtime): CollectionEntry[] {
    this.follow();
    const { entries } = this.table;
    runtime.scan(entries.length - this.position);
    return entries.slice(this.position).filter((entry) => entry !== undefined);
  }

  private follow(): void {
    for (let { successor, droppedSlots } = this.table; successor; { successor, droppedSlots } = this.table) {
      this.position = droppedSlots ? this.position - countBelow(droppedSlots, this.position) : 0;
      this.table = successor;
    }
  }
}

/** The number of items of an ascending list that are less than `limit`. */
function countBelow(sorted: readonly number[], limit: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sorted[middle] < limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

export type CollectionIteratorKind = 'keys' | 'values' | 'entries';

/** A Map or Set iterator, which `util.inspect` previews without advancing it. */
export class CollectionIterator implements HostIterator {
  /** Undefined once done, after which the iterator ignores later additions. */
  private cursor: SlotCursor | undefined;

  constructor(
    private readonly runtime: Runtime,
    readonly source: JsObject,
    readonly state: CollectionState,
    readonly kind: CollectionIteratorKind
  ) {
    this.cursor = state.cursor();
  }

  next(): Value | typeof DONE {
    const entry = this.cursor?.next(this.runtime);
    if (!entry) {
      this.cursor = undefined;
      return DONE;
    }
    if (this.kind === 'keys') return entry.key;
    if (this.kind === 'values') return entry.value;
    return this.runtime.newArray([entry.key, entry.value]);
  }

  /** The entries the iterator has yet to visit. */
  remainingEntries(): CollectionEntry[] {
    return this.cursor?.rest(this.runtime) ?? [];
  }
}

export function defineCollectionBuiltins(builder: RealmBuilder): void {
  defineMap(builder);
  defineSet(builder);
  defineWeakCollection(builder, 'WeakMap');
  defineWeakCollection(builder, 'WeakSet');
}

/** Defines a constructor whose instances carry a {@link CollectionState}, filled from an iterable through `adderName`. */
// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineCollectionClass(
  builder: RealmBuilder,
  kind: CollectionKind,
  adderName: 'set' | 'add',
  prototype = new JsObject(builder.realm.objectPrototype)
): { prototype: JsObject; constructor: JsFunction } {
  const isMap = adderName === 'set';
  const constructor = builder.defineClass(kind, 0, prototype, ({ runtime, args, newTarget, callRow }) => {
    if (!newTarget) return runtime.throwError('TypeError', `Constructor ${kind} requires 'new'`);
    const collection = runtime.newObject(runtime.prototypeFor(newTarget, prototype));
    collection.collection = new CollectionState(kind);
    const [iterable] = args;
    if (iterable === undefined || iterable === null) return collection;
    const adder = runtime.get(collection, adderName);
    if (!isCallable(adder)) {
      runtime.throwError(
        'TypeError',
        `'${runtime.describe(adder)}' returned for property '${adderName}' of object '#<${kind}>' is not a function`
      );
    }
    return runtime.hold(collection, () => {
      const iterator = runtime.iterator(iterable);
      closingOnThrow(iterator, () => {
        for (let item = iterator.next(); item !== DONE; item = iterator.next()) {
          if (!isMap) {
            runtime.call(adder, collection, [item], callRow);
            continue;
          }
          if (!isObject(item)) {
            runtime.throwError('TypeError', `Iterator value ${primitiveText(item)} is not an entry object`);
          }
          const key = runtime.get(item, '0');
          const value = runtime.hold(key, () => runtime.get(item, '1'));
          runtime.call(adder, collection, [key, value], callRow);
        }
      });
      return collection;
    });
  });
  builder.constant(prototype, WELL_KNOWN_SYMBOLS.toStringTag, kind);
  return { prototype, constructor };
}

function primitiveText(value: Exclude<Value, JsObject>): string {
  return typeof value === 'symbol' ? value.toString() : String(value);
}

type CollectionMethod = (call: NativeCall, state: CollectionState, collection: JsObject) => Value;

/** Defines a method that requires a receiver of `kind`, as the spec's RequireInternalSlot does. */
function collectionMethod(
  builder: RealmBuilder,
  prototype: JsObject,
  kind: CollectionKind,
  name: string,
  length: number,
  run: CollectionMethod
): JsFunction {
  return builder.method(prototype, name, length, (call) =>
    run(
      call,
      requireCollection(call.runtime, call.thisValue, kind, `${kind}.prototype.${name}`),
      call.thisValue as JsObject
    )
  );
}

function requireCollection(runtime: Runtime, value: Value, kind: CollectionKind, method: string): CollectionState {
  if (value instanceof JsObject && value.collection?.kind === kind) return value.collection;
  return runtime.throwError(
    'TypeError',
    `Method ${method} called on incompatible receiver ${receiverText(runtime, value)}`
  );
}

/** How V8 names a value in a message: `#<Constructor>` for an object, its text for a primitive. */
export function receiverText(runtime: Runtime, value: Value): string {
  if (!(value instanceof JsObject)) return typeof value === 'string' ? value : primitiveText(value);
  return `#<${constructorNameOf(runtime, value)}>`;
}

/** The name of the constructor an object's prototype chain names, without running getters. */
export function constructorNameOf(runtime: Runtime, object: JsObject): string {
  for (let current: JsObject | null = object; current; current = current.proto) {
    const property = current.properties.get('constructor');
    if (property && !isAccessor(property) && property.value instanceof JsFunction) {
      const name = runtime.functionName(property.value);
      if (name) return name;
    }
  }
  return 'Object';
}

function defineIterators(
  builder: RealmBuilder,
  prototype: JsObject,
  kind: 'Map' | 'Set',
  names: [string, CollectionIteratorKind][]
): Map<string, JsFunction> {
  const iteratorPrototype = defineHostIteratorPrototype(builder, `${kind} Iterator`);
  const methods = new Map<string, JsFunction>();
  for (const [name, iteration] of names) {
    methods.set(
      name,
      collectionMethod(builder, prototype, kind, name, 0, ({ runtime }, state, collection) =>
        newHostIterator(runtime, iteratorPrototype, new CollectionIterator(runtime, collection, state, iteration))
      )
    );
  }
  return methods;
}

function forEachEntry({ runtime, args, callRow }: NativeCall, state: CollectionState, collection: JsObject): Value {
  const [callback, thisArg] = args;
  if (!isCallable(callback)) runtime.throwError('TypeError', `${runtime.describe(callback)} is not a function`);
  const cursor = state.cursor();
  for (let entry = cursor.next(runtime); entry; entry = cursor.next(runtime)) {
    runtime.spend();
    runtime.call(callback, thisArg, [entry.value, entry.key, collection], callRow);
  }
  return undefined;
}

function defineSizeAndClear(builder: RealmBuilder, prototype: JsObject, kind: 'Map' | 'Set'): void {
  builder.getter(prototype, 'size', ({ runtime, thisValue }) => {
    return requireCollection(runtime, thisValue, kind, `get ${kind}.prototype.size`).size;
  });
  collectionMethod(builder, prototype, kind, 'clear', 0, (_, state) => {
    state.clear();
    return;
  });
  collectionMethod(builder, prototype, kind, 'forEach', 1, forEachEntry);
}

function defineMap(builder: RealmBuilder): void {
  const { prototype, constructor } = defineCollectionClass(builder, 'Map', 'set', builder.realm.mapPrototype);
  collectionMethod(builder, prototype, 'Map', 'get', 1, ({ args }, state) => state.entryOf(args[0])?.value);
  collectionMethod(builder, prototype, 'Map', 'set', 2, ({ runtime, args }, state, map) => {
    state.set(runtime, args[0], args[1]);
    return map;
  });
  collectionMethod(builder, prototype, 'Map', 'has', 1, ({ args }, state) => state.has(args[0]));
  collectionMethod(builder, prototype, 'Map', 'delete', 1, ({ args }, state) => state.delete(args[0]));
  defineSizeAndClear(builder, prototype, 'Map');
  const iterators = defineIterators(builder, prototype, 'Map', [
    ['keys', 'keys'],
    ['values', 'values'],
    ['entries', 'entries'],
  ]);
  prototype.properties.set(WELL_KNOWN_SYMBOLS.iterator, {
    value: iterators.get('entries'),
    writable: true,
    enumerable: false,
    configurable: true,
  });
  builder.method(constructor, 'groupBy', 2, ({ runtime, args, callRow }) => {
    const groups = groupBy(runtime, args[0], args[1], callRow, (key) => (Object.is(key, -0) ? 0 : key));
    const map = runtime.newObject(prototype);
    const state = new CollectionState('Map');
    map.collection = state;
    for (const [key, values] of groups) state.set(runtime, key, runtime.newArray(values));
    return map;
  });
}

/**
 * The spec's GroupBy: the values of `items` grouped by the key `callback` gives each, in the order the keys first
 * appear. The values and keys are held while the callback runs, so the turtles among them stay alive.
 */
export function groupBy(
  runtime: Runtime,
  items: Value,
  callback: Value,
  callRow: number | undefined,
  toKey: (key: Value) => Value
): Map<Value, Value[]> {
  if (items === undefined || items === null) runtime.throwError('TypeError', `${String(items)} is not iterable`);
  if (!isCallable(callback)) runtime.throwError('TypeError', `${runtime.describe(callback)} is not a function`);
  const groups = new Map<Value, Value[]>();
  const held = runtime.newArray([]);
  runtime.hold(held, () => {
    const iterator = runtime.iterator(items);
    closingOnThrow(iterator, () => {
      for (let index = 0, value = iterator.next(); value !== DONE; index++, value = iterator.next()) {
        held.elements.push(value);
        runtime.allocate(1);
        const key = toKey(runtime.call(callback, undefined, [value, index], callRow));
        let group = groups.get(key);
        if (!group) {
          group = [];
          groups.set(key, group);
          held.elements.push(key);
          runtime.allocate(1);
        }
        group.push(value);
      }
    });
  });
  return groups;
}

function defineSet(builder: RealmBuilder): void {
  const { prototype } = defineCollectionClass(builder, 'Set', 'add', builder.realm.setPrototype);
  collectionMethod(builder, prototype, 'Set', 'add', 1, ({ runtime, args }, state, set) => {
    if (!state.has(args[0])) state.set(runtime, args[0], Object.is(args[0], -0) ? 0 : args[0]);
    return set;
  });
  collectionMethod(builder, prototype, 'Set', 'has', 1, ({ args }, state) => state.has(args[0]));
  collectionMethod(builder, prototype, 'Set', 'delete', 1, ({ args }, state) => state.delete(args[0]));
  defineSizeAndClear(builder, prototype, 'Set');
  const iterators = defineIterators(builder, prototype, 'Set', [
    ['values', 'values'],
    ['entries', 'entries'],
  ]);
  for (const key of ['keys', WELL_KNOWN_SYMBOLS.iterator]) {
    prototype.properties.set(key, {
      value: iterators.get('values'),
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  defineSetAlgebra(builder, prototype);
}

/** The spec's Set Record of the argument of a Set method: anything with `size`, `has`, and `keys`. */
interface SetRecord {
  set: JsObject;
  size: number;
  has: JsFunction;
  keys: JsFunction;
}

function getSetRecord(runtime: Runtime, value: Value, method: string): SetRecord {
  if (!isObject(value)) return runtime.throwError('TypeError', `Set.prototype.${method} argument must be an object`);
  const size = runtime.toNumber(runtime.get(value, 'size'));
  if (Number.isNaN(size)) runtime.throwError('TypeError', 'The .size property is NaN');
  const integerSize = Math.trunc(size);
  if (integerSize < 0) runtime.throwError('RangeError', `'${integerSize}' is an invalid size`);
  const has = runtime.get(value, 'has');
  if (!isCallable(has)) runtime.throwError('TypeError', 'string "has" is not a function');
  const keys = runtime.get(value, 'keys');
  if (!isCallable(keys)) runtime.throwError('TypeError', 'string "keys" is not a function');
  return { set: value, size: integerSize, has, keys };
}

/** Steps through the iterator `record.keys()` returns, stopping and closing it when `visit` returns false. */
function forEachKey(
  runtime: Runtime,
  record: SetRecord,
  callRow: number | undefined,
  visit: (key: Value) => boolean
): void {
  const keys = runtime.call(record.keys, record.set, [], callRow);
  if (!isObject(keys)) runtime.throwError('TypeError', 'Result of the keys method is not an object');
  const iterator = new ValueIterator(runtime.protocolIteration(keys));
  for (let value = iterator.next(); value !== DONE; value = iterator.next()) {
    if (!visit(Object.is(value, -0) ? 0 : value)) {
      iterator.close();
      return;
    }
  }
}

/** Visits a set's entries in order, as the spec's loops over `[[SetData]]` do, until `visit` returns false. */
function forEachOwn(runtime: Runtime, state: CollectionState, visit: (key: Value) => boolean): void {
  const cursor = state.cursor();
  for (let entry = cursor.next(runtime); entry; entry = cursor.next(runtime)) {
    runtime.spend();
    if (!visit(entry.key)) return;
  }
}

function calls(call: NativeCall, record: SetRecord, key: Value): boolean {
  return toBoolean(call.runtime.call(record.has, record.set, [key], call.callRow));
}

type SetAlgebra = (name: string, run: (call: NativeCall, state: CollectionState, record: SetRecord) => Value) => void;
type NewSet = (runtime: Runtime, from: CollectionState | undefined) => { set: JsObject; state: CollectionState };

function defineSetAlgebra(builder: RealmBuilder, prototype: JsObject): void {
  const newSet: NewSet = (runtime, from) => {
    const set = runtime.newObject(prototype);
    const state = new CollectionState('Set');
    set.collection = state;
    for (const entry of from?.liveEntries(runtime) ?? []) state.set(runtime, entry.key, entry.key);
    return { set, state };
  };
  const algebra: SetAlgebra = (name, run) => {
    collectionMethod(builder, prototype, 'Set', name, 1, (call, state) =>
      run(call, state, getSetRecord(call.runtime, call.args[0], name))
    );
  };
  defineSetCombinations(algebra, newSet);
  defineSymmetricDifference(algebra, newSet);
  defineSetComparisons(algebra);
}

// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
// code-gauge-allow functionNcss 34 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineSetCombinations(algebra: SetAlgebra, newSet: NewSet): void {
  algebra('union', (call, state, record) => {
    const result = newSet(call.runtime, state);
    call.runtime.hold(result.set, () =>
      forEachKey(call.runtime, record, call.callRow, (key) => {
        result.state.set(call.runtime, key, key);
        return true;
      })
    );
    return result.set;
  });
  algebra('intersection', (call, state, record) => {
    const result = newSet(call.runtime, undefined);
    call.runtime.hold(result.set, () => {
      if (state.size <= record.size) {
        forEachOwn(call.runtime, state, (key) => {
          if (calls(call, record, key)) result.state.set(call.runtime, key, key);
          return true;
        });
      } else {
        forEachKey(call.runtime, record, call.callRow, (key) => {
          if (state.has(key)) result.state.set(call.runtime, key, key);
          return true;
        });
      }
    });
    return result.set;
  });
  algebra('difference', (call, state, record) => {
    const result = newSet(call.runtime, state);
    call.runtime.hold(result.set, () => {
      if (state.size <= record.size) {
        forEachOwn(call.runtime, result.state, (key) => {
          if (calls(call, record, key)) result.state.delete(key);
          return true;
        });
      } else {
        forEachKey(call.runtime, record, call.callRow, (key) => {
          result.state.delete(key);
          return true;
        });
      }
    });
    return result.set;
  });
}

function defineSymmetricDifference(algebra: SetAlgebra, newSet: NewSet): void {
  algebra('symmetricDifference', (call, state, record) => {
    const result = newSet(call.runtime, state);
    call.runtime.hold(result.set, () =>
      forEachKey(call.runtime, record, call.callRow, (key) => {
        const inResult = result.state.has(key);
        if (state.has(key)) {
          if (inResult) result.state.delete(key);
        } else if (!inResult) result.state.set(call.runtime, key, key);
        return true;
      })
    );
    return result.set;
  });
}

function defineSetComparisons(algebra: SetAlgebra): void {
  algebra('isSubsetOf', (call, state, record) => {
    if (state.size > record.size) return false;
    let isSubset = true;
    forEachOwn(call.runtime, state, (key) => (isSubset = calls(call, record, key)));
    return isSubset;
  });
  algebra('isSupersetOf', (call, state, record) => {
    if (state.size < record.size) return false;
    let isSuperset = true;
    forEachKey(call.runtime, record, call.callRow, (key) => (isSuperset = state.has(key)));
    return isSuperset;
  });
  algebra('isDisjointFrom', (call, state, record) => {
    let isDisjoint = true;
    if (state.size <= record.size) forEachOwn(call.runtime, state, (key) => (isDisjoint = !calls(call, record, key)));
    else forEachKey(call.runtime, record, call.callRow, (key) => (isDisjoint = !state.has(key)));
    return isDisjoint;
  });
}

function defineWeakCollection(builder: RealmBuilder, kind: 'WeakMap' | 'WeakSet'): void {
  const isMap = kind === 'WeakMap';
  const { prototype } = defineCollectionClass(builder, kind, isMap ? 'set' : 'add');
  const requireKey = (runtime: Runtime, key: Value): void => {
    if (isObject(key) || (typeof key === 'symbol' && registeredKeyOf(runtime, key) === undefined)) return;
    runtime.throwError('TypeError', isMap ? 'Invalid value used as weak map key' : 'Invalid value used in weak set');
  };
  if (isMap) {
    collectionMethod(builder, prototype, kind, 'get', 1, ({ args }, state) => state.entryOf(args[0])?.value);
    collectionMethod(builder, prototype, kind, 'set', 2, ({ runtime, args }, state, map) => {
      requireKey(runtime, args[0]);
      state.set(runtime, args[0], args[1]);
      return map;
    });
  } else {
    collectionMethod(builder, prototype, kind, 'add', 1, ({ runtime, args }, state, set) => {
      requireKey(runtime, args[0]);
      state.set(runtime, args[0], undefined);
      return set;
    });
  }
  collectionMethod(builder, prototype, kind, 'has', 1, ({ args }, state) => state.has(args[0]));
  collectionMethod(builder, prototype, kind, 'delete', 1, ({ args }, state) => state.delete(args[0]));
}
