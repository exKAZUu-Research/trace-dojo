import { DONE, type HostIterator, type ValueIterator } from './iteration';
import type { RealmBuilder } from './realm';
import { defineHostIteratorPrototype, newHostIterator, WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  isAccessor,
  isCallable,
  isObject,
  JsFunction,
  JsObject,
  JsThrow,
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
 * The spec's `[[MapData]]` or `[[SetData]]`: entries in insertion order, where deleting an entry empties its slot
 * instead of removing it, so that iterators and `forEach`, which walk the slots by index, see later changes as the
 * spec's do.
 */
export class CollectionState {
  readonly entries: (CollectionEntry | undefined)[] = [];
  readonly isWeak: boolean;
  /** The slot of each live key, which the host's Map finds by SameValueZero as JavaScript's does. */
  private readonly slots = new Map<Value, number>();

  constructor(readonly kind: CollectionKind) {
    this.isWeak = kind === 'WeakMap' || kind === 'WeakSet';
  }

  get size(): number {
    return this.slots.size;
  }

  has(key: Value): boolean {
    return this.slots.has(key);
  }

  entryOf(key: Value): CollectionEntry | undefined {
    const slot = this.slots.get(key);
    return slot === undefined ? undefined : this.entries[slot];
  }

  set(runtime: Runtime, key: Value, value: Value): void {
    const entry = this.entryOf(key);
    if (entry) {
      entry.value = value;
      return;
    }
    runtime.allocate(1);
    this.slots.set(key, this.entries.length);
    this.entries.push({ key: Object.is(key, -0) ? 0 : key, value });
  }

  delete(key: Value): boolean {
    const slot = this.slots.get(key);
    if (slot === undefined) return false;
    this.slots.delete(key);
    this.entries[slot] = undefined;
    return true;
  }

  clear(): void {
    for (const slot of this.slots.values()) this.entries[slot] = undefined;
    this.slots.clear();
  }

  /** The live entries from slot `start` on, charged as one scan. */
  liveEntries(runtime: Runtime, start = 0): CollectionEntry[] {
    runtime.scan(this.entries.length - start);
    const live: CollectionEntry[] = [];
    for (let slot = start; slot < this.entries.length; slot++) {
      const entry = this.entries[slot];
      if (entry) live.push(entry);
    }
    return live;
  }
}

export type CollectionIteratorKind = 'keys' | 'values' | 'entries';

/** A Map or Set iterator, which `util.inspect` previews without advancing it. */
export class CollectionIterator implements HostIterator {
  /** The next slot to visit, or Infinity once done, after which the iterator ignores later additions. */
  position = 0;

  constructor(
    private readonly runtime: Runtime,
    readonly source: JsObject,
    readonly state: CollectionState,
    readonly kind: CollectionIteratorKind
  ) {}

  next(): Value | typeof DONE {
    const { entries } = this.state;
    const start = this.position;
    while (this.position < entries.length) {
      const entry = entries[this.position++];
      if (!entry) continue;
      this.runtime.scan(this.position - start);
      if (this.kind === 'keys') return entry.key;
      if (this.kind === 'values') return entry.value;
      return this.runtime.newArray([entry.key, entry.value]);
    }
    this.runtime.scan(this.position - start);
    this.position = Number.POSITIVE_INFINITY;
    return DONE;
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
  adderName: 'set' | 'add'
): { prototype: JsObject; constructor: JsFunction } {
  const prototype = new JsObject(builder.realm.objectPrototype);
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

/** Runs `run`, closing the iterator when it throws, as the spec's IfAbruptCloseIterator does. */
function closingOnThrow(iterator: ValueIterator, run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof JsThrow) {
      try {
        iterator.close();
      } catch {
        // The first exception wins over one that closing the iterator throws.
      }
    }
    throw error;
  }
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
  // The slots are read by index so that entries the callback adds are visited and the ones it deletes are not.
  for (let slot = 0; slot < state.entries.length; slot++) {
    const entry = state.entries[slot];
    runtime.spend();
    if (entry) runtime.call(callback, thisArg, [entry.value, entry.key, collection], callRow);
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
  const { prototype, constructor } = defineCollectionClass(builder, 'Map', 'set');
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
 * appear. The values are held while the callback runs, so the turtles among them stay alive.
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
        }
        group.push(value);
      }
    });
  });
  return groups;
}

function defineSet(builder: RealmBuilder): void {
  const { prototype } = defineCollectionClass(builder, 'Set', 'add');
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
  const iterator = runtime.call(record.keys, record.set, [], callRow);
  if (!isObject(iterator)) runtime.throwError('TypeError', 'Result of the keys method is not an object');
  const next = runtime.get(iterator, 'next');
  for (;;) {
    const result = runtime.call(next, iterator, [], callRow);
    if (!isObject(result))
      runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
    if (toBoolean(runtime.get(result, 'done'))) return;
    const value = runtime.get(result, 'value');
    if (visit(Object.is(value, -0) ? 0 : value)) continue;
    const close = runtime.get(iterator, 'return');
    if (close !== undefined && close !== null) runtime.call(close, iterator, [], callRow);
    return;
  }
}

/** Visits a set's entries by slot, as the spec's loops over `O.[[SetData]]` do, until `visit` returns false. */
function forEachOwn(runtime: Runtime, state: CollectionState, visit: (key: Value) => boolean): void {
  for (let slot = 0; slot < state.entries.length; slot++) {
    runtime.spend();
    const entry = state.entries[slot];
    if (entry && !visit(entry.key)) return;
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
        forEachOwn(call.runtime, state, (key) => {
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
    if (isObject(key) || (typeof key === 'symbol' && Symbol.keyFor(key) === undefined)) return;
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
