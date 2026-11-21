import type { TableMap } from '../capacity';
import type { CollectionEntries, CollectionKey } from '../collectionEntries';
import { cloneValue, compareValues, testPartialOrder, valuesEqual } from '../ops';
import type { Type } from '../types';
import { DONE, ElementPlace, EntryValue, type IterValue, MapValue, SetValue, UNIT_VALUE, type Value } from '../values';
import { checkTableCapacity } from './capacityNatives';
import { defaultValue } from './core';
import {
  arrayIter,
  extendedValue,
  mapIter,
  nextForFold,
  ownedIter,
  reserveHashInput,
  setIter,
  snapshotIter,
} from './iterators';
import { sizeOf } from './layout';
import { boundsOf } from './ranges';
import { btreeSetOp, hashSetIter, type SetOp } from './setOps';
import { call, define, deref, libraryPanic, type Native, type NativeContext, none, option, some } from './support';

/** A new `HashMap` or `HashSet` with its entries' size, and with room for `capacity` elements. */
export function withTable<T extends MapValue | SetValue>(collection: T, size: number, capacity?: Value): T {
  const table = collection.entries.table;
  if (table) {
    table.entrySize = size;
    if (capacity !== undefined) table.allocate(Number(capacity as bigint));
  }
  return collection;
}

/** The size of a `HashMap`'s key and value together, as its table stores them. */
function entrySize(ctx: NativeContext): number {
  return sizeOf({ kind: 'tuple', elems: [ctx.typeArgs[0], ctx.typeArgs[1]] });
}

/** `with_capacity` of a `HashMap` or a `HashSet`, which panics as hashbrown does when the table would overflow. */
function tableWithCapacity<T extends MapValue | SetValue>(
  ctx: NativeContext,
  collection: T,
  size: number,
  capacity: Value
): T {
  checkTableCapacity(ctx, 0, capacity, size);
  return withTable(collection, size, capacity);
}

/** `reserve` of a `HashMap` or a `HashSet`, which panics as hashbrown does when the table would overflow. */
function reserveTable(ctx: NativeContext, collection: MapValue | SetValue, additional: Value, size: number): Value {
  checkTableCapacity(ctx, collection.entries.size, additional, size);
  return resize(collection, (table) => table.reserve(Number(additional as bigint)));
}

function resize(collection: MapValue | SetValue, change: (table: TableMap<unknown, unknown>) => void): Value {
  if (collection.entries.table) change(collection.entries.table);
  return UNIT_VALUE;
}

function map(self: Value): MapValue {
  return deref(self) as MapValue;
}

function set(self: Value): SetValue {
  return deref(self) as SetValue;
}

function hashSetOp(ctx: NativeContext, op: SetOp, self: Value, other: Value): Value {
  return hashSetIter(op, set(self), set(other), keyType(ctx));
}

/** `BTreeSet`'s set operations, which take std's steps. */
const btree = (ctx: NativeContext, op: SetOp, self: Value, other: Value): IterValue => {
  const sets: [SetValue, SetValue] = [set(self), set(other)];
  const type = keyType(ctx);
  return btreeSetOp(op, sets, type, ctx.interp.program.builtinType('BTreeSet', [type]));
};

/** The type of the keys, which hashes them: `K` of `HashMap<K, V>`. */
function keyType(ctx: NativeContext): Type {
  return ctx.typeArgs[0];
}

function entryKey<V>(ctx: NativeContext, entries: CollectionEntries<V>, value: Value): CollectionKey<V> {
  return entries.key(keyType(ctx), value);
}

function mapNatives(sorted: boolean): Record<string, Native> {
  return { ...mapCapacityNatives(sorted), ...mapEntryNatives(), ...mapIterNatives(), ...mapEndNatives() };
}

function mapCapacityNatives(sorted: boolean): Record<string, Native> {
  return {
    new: (_args, ctx) => withTable(new MapValue(sorted), entrySize(ctx)),
    with_capacity: ([capacity], ctx) => tableWithCapacity(ctx, new MapValue(sorted), entrySize(ctx), capacity),
    reserve: ([self, additional], ctx) => reserveTable(ctx, map(self), additional, entrySize(ctx)),
    shrink_to_fit: ([self]) => resize(map(self), (table) => table.shrinkTo(0)),
    shrink_to: ([self, min]) => resize(map(self), (table) => table.shrinkTo(Number(min as bigint))),
    capacity: ([self]) => BigInt(map(self).entries.table!.capacity),
  };
}

function mapEntryNatives(): Record<string, Native> {
  return {
    insert: ([self, k, v], ctx) => insertEntry(ctx, map(self), k, v),
    get: ([self, k], ctx) => {
      const entry = mapEntry(ctx, map(self), k);
      return option(ctx, entry?.[1], entry !== undefined);
    },
    get_mut: ([self, k], ctx) => {
      const entry = mapEntry(ctx, map(self), k);
      return option(ctx, entry && new ElementPlace(entry, 1), entry !== undefined);
    },
    get_key_value: ([self, k], ctx) => {
      const entry = mapEntry(ctx, map(self), k);
      return option(ctx, entry && [entry[0], entry[1]], entry !== undefined);
    },
    contains_key: ([self, k], ctx) => mapEntry(ctx, map(self), k) !== undefined,
    remove: ([self, k], ctx) => {
      const m = map(self);
      const key = entryKey(ctx, m.entries, k);
      const entry = m.entries.get(key);
      m.entries.delete(key);
      return option(ctx, entry?.[1], entry !== undefined);
    },
    remove_entry: ([self, k], ctx) => {
      const m = map(self);
      const key = entryKey(ctx, m.entries, k);
      const entry = m.entries.get(key);
      m.entries.delete(key);
      return option(ctx, entry && [entry[0], entry[1]], entry !== undefined);
    },
    entry: ([self, k], ctx) => {
      const m = map(self);
      return new EntryValue(m, entryKey(ctx, m.entries, k), k);
    },
    len: ([self]) => BigInt(map(self).entries.size),
    is_empty: ([self]) => map(self).entries.size === 0,
    clear: ([self]) => {
      map(self).entries.clear();
      return UNIT_VALUE;
    },
  };
}

function mapEntry(ctx: NativeContext, m: MapValue, key: Value): [Value, Value] | undefined {
  return m.entries.get(entryKey(ctx, m.entries, key));
}

function insertEntry(ctx: NativeContext, m: MapValue, k: Value, v: Value): Value {
  const key = entryKey(ctx, m.entries, k);
  const existing = m.entries.get(key);
  if (existing) {
    const old = existing[1];
    existing[1] = v;
    return some(ctx, old);
  }
  storeNewEntry(ctx, m, key, k, v);
  return none(ctx);
}

function storeNewEntry(
  ctx: NativeContext,
  map: MapValue,
  key: CollectionKey<[Value, Value]>,
  k: Value,
  v: Value
): void {
  ctx.runtime.allocate(2);
  map.entries.set(key, [k, v]);
}

function mapIterNatives(): Record<string, Native> {
  return {
    into_iter: ([self], ctx) => mapIter(map(self), 'value', ctx.typeArgs),
    iter: ([self], ctx) => mapIter(map(self), 'ref', ctx.typeArgs),
    iter_mut: ([self], ctx) => mapIter(map(self), 'mut', ctx.typeArgs),
    keys: ([self], ctx) => mapProjection(map(self), ctx.typeArgs, (entry) => entry[0]),
    values: ([self], ctx) => mapProjection(map(self), ctx.typeArgs, (entry) => entry[1]),
    values_mut: ([self], ctx) => mapProjection(map(self), ctx.typeArgs, (entry) => new ElementPlace(entry, 1)),
    into_keys: ([self], ctx) => mapProjection(map(self), ctx.typeArgs, (entry) => entry[0], 0),
    into_values: ([self], ctx) => mapProjection(map(self), ctx.typeArgs, (entry) => entry[1], 1),
    drain: ([self], ctx) => {
      const entries = map(self).entries.snapshot();
      map(self).entries.clear();
      return ownedIter(entries, { kind: 'tuple', elems: ctx.typeArgs });
    },
    retain: ([self, f], ctx) => {
      const m = map(self);
      m.entries.retain((entry) => deref(call(ctx, f, [entry[0], new ElementPlace(entry, 1)])) as boolean);
      return UNIT_VALUE;
    },
    extend: ([self, iter], ctx) => extendMap(ctx, map(self), deref(iter) as IterValue),
  };
}

function mapProjection(
  map: MapValue,
  types: Type[],
  project: (entry: [Value, Value]) => Value,
  owned?: 0 | 1
): IterValue {
  const entries = map.entries.snapshot();
  const storageType: Type = { kind: 'tuple', elems: types };
  if (owned === undefined) return snapshotIter(entries, storageType, project);
  return ownedIter(entries, types[owned], { map: (entry) => project(entry as [Value, Value]), storageType });
}

function extendMap(ctx: NativeContext, m: MapValue, iterator: IterValue): Value {
  if (m.entries.table) reserveHashInput(ctx, m.entries.table, iterator, ctx.typeArgs[2]);
  for (;;) {
    ctx.runtime.spend();
    const item = nextForFold(iterator);
    if (item === DONE) break;
    const [k, v] = item as Value[];
    // Finding the key can run the program's `Eq` or `Ord`, during which only this loop holds the entry.
    ctx.runtime.withRoots([item], () => {
      const key = entryKey(ctx, m.entries, k);
      const existing = m.entries.get(key);
      if (existing) existing[1] = v;
      else storeNewEntry(ctx, m, key, k, v);
    });
  }
  return UNIT_VALUE;
}

function mapEndNatives(): Record<string, Native> {
  return {
    first_entry: ([self], ctx) => edgeEntry(ctx, map(self), true),
    last_entry: ([self], ctx) => edgeEntry(ctx, map(self), false),
    first_key_value: ([self], ctx) => {
      const first = map(self).entries.getEdge(true);
      return option(ctx, first && [first[0], first[1]], first !== undefined);
    },
    last_key_value: ([self], ctx) => {
      const last = map(self).entries.getEdge(false);
      return option(ctx, last && [last[0], last[1]], last !== undefined);
    },
    pop_first: ([self], ctx) => {
      const m = map(self);
      const first = m.entries.takeEdge(true);
      return option(ctx, first && [first[0], first[1]], first !== undefined);
    },
    pop_last: ([self], ctx) => {
      const m = map(self);
      const last = m.entries.takeEdge(false);
      return option(ctx, last && [last[0], last[1]], last !== undefined);
    },
  };
}

function edgeEntry(ctx: NativeContext, value: MapValue, first: boolean): Value {
  const lookup = value.entries.edgeKey(first);
  if (!lookup) return none(ctx);
  const [key] = value.entries.get(lookup)!;
  return some(ctx, new EntryValue(value, lookup, key));
}

// code-gauge-allow functionNcss 59 -- One native per method of std's sets.
function setNatives(sorted: boolean): Record<string, (args: Value[], ctx: NativeContext) => Value> {
  return {
    new: (_args, ctx) => withTable(new SetValue(sorted), sizeOf(ctx.typeArgs[0])),
    with_capacity: ([capacity], ctx) => tableWithCapacity(ctx, new SetValue(sorted), sizeOf(ctx.typeArgs[0]), capacity),
    capacity: ([self]) => BigInt(set(self).entries.table!.capacity),
    reserve: ([self, additional], ctx) => reserveTable(ctx, set(self), additional, sizeOf(ctx.typeArgs[0])),
    shrink_to_fit: ([self]) => resize(set(self), (table) => table.shrinkTo(0)),
    shrink_to: ([self, min]) => resize(set(self), (table) => table.shrinkTo(Number(min as bigint))),
    insert: ([self, value], ctx) => {
      const s = set(self);
      const hash = entryKey(ctx, s.entries, value);
      if (s.entries.has(hash)) return false;
      ctx.runtime.allocate(1);
      s.entries.set(hash, value);
      return true;
    },
    replace: ([self, value], ctx) => {
      const { entries } = set(self);
      const key = entryKey(ctx, entries, value);
      const present = entries.has(key);
      const previous = entries.get(key);
      if (!present) ctx.runtime.allocate(1);
      entries.set(key, value);
      return option(ctx, previous, present);
    },
    contains: ([self, value], ctx) => {
      const { entries } = set(self);
      return entries.has(entryKey(ctx, entries, value));
    },
    remove: ([self, value], ctx) => {
      const { entries } = set(self);
      return entries.delete(entryKey(ctx, entries, value));
    },
    take: ([self, value], ctx) => {
      const s = set(self);
      const hash = entryKey(ctx, s.entries, value);
      const found = s.entries.get(hash);
      s.entries.delete(hash);
      return option(ctx, found, found !== undefined);
    },
    get: ([self, value], ctx) => {
      const { entries } = set(self);
      const found = entries.get(entryKey(ctx, entries, value));
      return option(ctx, found, found !== undefined);
    },
    len: ([self]) => BigInt(set(self).entries.size),
    is_empty: ([self]) => set(self).entries.size === 0,
    clear: ([self]) => {
      set(self).entries.clear();
      return UNIT_VALUE;
    },
    iter: ([self], ctx) => setIter(set(self), keyType(ctx)),
    union: ([self, other], ctx) => setOp(ctx, sorted, 'union', self, other),
    intersection: ([self, other], ctx) => setOp(ctx, sorted, 'intersection', self, other),
    difference: ([self, other], ctx) => setOp(ctx, sorted, 'difference', self, other),
    symmetric_difference: ([self, other], ctx) => setOp(ctx, sorted, 'symmetric_difference', self, other),
    is_subset: ([self, other], ctx) => isSubset(ctx, set(self), set(other)),
    is_superset: ([self, other], ctx) => isSubset(ctx, set(other), set(self)),
    is_disjoint: ([self, other], ctx) =>
      sorted
        ? btree(ctx, 'intersection', self, other).next() === DONE
        : everySetMember(ctx, set(self), set(other), false),
    retain: ([self, f], ctx) => {
      const s = set(self);
      s.entries.retain((value) => deref(call(ctx, f, [value])) as boolean);
      return UNIT_VALUE;
    },
    extend: ([self, iter], ctx) => extendSet(ctx, set(self), deref(iter) as IterValue),
    drain: ([self], ctx) => {
      const values = set(self).entries.snapshot();
      set(self).entries.clear();
      return ownedIter(values, ctx.typeArgs[0]);
    },
    into_iter: ([self], ctx) => setIter(set(self), keyType(ctx), true),
    first: ([self], ctx) => {
      const first = set(self).entries.getEdge(true);
      return option(ctx, first, first !== undefined);
    },
    last: ([self], ctx) => {
      const last = set(self).entries.getEdge(false);
      return option(ctx, last, last !== undefined);
    },
    pop_first: ([self], ctx) => {
      const value = set(self).entries.takeEdge(true);
      return option(ctx, value, value !== undefined);
    },
    pop_last: ([self], ctx) => {
      const value = set(self).entries.takeEdge(false);
      return option(ctx, value, value !== undefined);
    },
  };
}

function extendSet(ctx: NativeContext, target: SetValue, iterator: IterValue): Value {
  if (target.entries.table) reserveHashInput(ctx, target.entries.table, iterator, ctx.typeArgs[2]);
  const convert = extendedValue(ctx.typeArgs[0], ctx.typeArgs[1]);
  for (;;) {
    ctx.runtime.spend();
    const item = nextForFold(iterator);
    if (item === DONE) return UNIT_VALUE;
    ctx.runtime.withRoots([item], () => {
      const hash = entryKey(ctx, target.entries, item);
      if (target.entries.has(hash)) return;
      ctx.runtime.allocate(1);
      target.entries.set(hash, convert(item));
    });
  }
}

/**
 * `is_subset`, comparing in the order std's algorithms do: the lengths first, and for a `BTreeSet` the ends of both
 * sets before the rest, which is looked up when it is much shorter than the other set and walked beside it otherwise.
 */
function isSubset(ctx: NativeContext, a: SetValue, b: SetValue): boolean {
  if (a.entries.size > b.entries.size) return false;
  const type = keyType(ctx);
  const members = [...a.entries.values()];
  const isMember = (value: Value): boolean => {
    ctx.runtime.spend();
    return b.entries.has(b.entries.key(type, value));
  };
  if (!a.sorted) return members.every(isMember);
  if (members.length === 0) return true;
  const others = [...b.entries.values()];
  const low = compareValues(type, members[0], others[0]) as number;
  if (low < 0) return false;
  const high = compareValues(type, members.at(-1) as Value, others.at(-1) as Value) as number;
  if (high > 0) return false;
  const rest = members.slice(low === 0 ? 1 : 0, high === 0 ? -1 : undefined);
  if (rest.length <= Math.floor(others.length / 16)) return rest.every(isMember);
  return isSubsequence(ctx, type, rest, others.slice(1, -1));
}

/** Whether each of some sorted values is among other sorted values, comparing as std walks the two side by side. */
function isSubsequence(ctx: NativeContext, type: Type, values: Value[], others: Value[]): boolean {
  let next = 0;
  for (let index = 0; index < values.length;) {
    ctx.runtime.spend();
    // std compares each of the other values with the one looked for, in that order.
    const order = next < others.length ? (compareValues(type, others[next++], values[index]) as number) : 1;
    if (order > 0) return false;
    if (order === 0) index++;
  }
  return true;
}

function everySetMember(ctx: NativeContext, a: SetValue, b: SetValue, present: boolean): boolean {
  const type = keyType(ctx);
  for (const value of a.entries.values()) {
    ctx.runtime.spend();
    if (b.entries.has(b.entries.key(type, value)) !== present) return false;
  }
  return true;
}

function setOp(ctx: NativeContext, sorted: boolean, op: SetOp, self: Value, other: Value): Value {
  return sorted ? btree(ctx, op, self, other) : hashSetOp(ctx, op, self, other);
}

function entryValue(entry: Value): EntryValue {
  return deref(entry) as EntryValue;
}

/** Inserts an entry's key with a value when the map lacks it, returning a place for the entry's value. */
function orInsertWith(ctx: NativeContext, entry: EntryValue, make: () => Value): Value {
  let existing = entry.map.entries.get(entry.lookup);
  if (!existing) {
    ctx.runtime.allocate(2);
    existing = [entry.key, make()];
    entry.map.entries.set(entry.lookup, existing);
  }
  return new ElementPlace(existing, 1);
}

const entryNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  or_insert: ([self, value], ctx) => orInsertWith(ctx, entryValue(self), () => value),
  or_insert_with: ([self, f], ctx) => orInsertWith(ctx, entryValue(self), () => call(ctx, f, [])),
  or_insert_with_key: ([self, f], ctx) => {
    const entry = entryValue(self);
    return orInsertWith(ctx, entry, () => call(ctx, f, [entry.key]));
  },
  or_default: ([self], ctx) => orInsertWith(ctx, entryValue(self), () => defaultValue(ctx, ctx.typeArgs[1])),
  and_modify: ([self, f], ctx) => {
    const entry = entryValue(self);
    const existing = entry.map.entries.get(entry.lookup);
    if (existing) call(ctx, f, [new ElementPlace(existing, 1)]);
    return entry;
  },
  key: ([self]) => {
    const entry = entryValue(self);
    return entry.map.entries.get(entry.lookup)?.[0] ?? entry.key;
  },
};

const occupiedNatives: Record<string, Native> = {
  key: ([self]) => entryValue(self).key,
  get: ([self]) => occupiedValue(self)[1],
  get_mut: ([self]) => new ElementPlace(occupiedValue(self), 1),
  into_mut: ([self]) => new ElementPlace(occupiedValue(self), 1),
  insert: ([self, value]) => {
    const pair = occupiedValue(self);
    const old = pair[1];
    pair[1] = value;
    return old;
  },
  remove: ([self]) => removeOccupied(self)[1],
  remove_entry: ([self]) => removeOccupied(self),
};

function occupiedValue(self: Value): [Value, Value] {
  const entry = entryValue(self);
  return entry.map.entries.get(entry.lookup)!;
}

function removeOccupied(self: Value): [Value, Value] {
  const entry = entryValue(self);
  const pair = entry.map.entries.get(entry.lookup)!;
  entry.map.entries.delete(entry.lookup);
  return pair;
}

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
function treeRange<V extends Value>(
  ctx: NativeContext,
  collection: CollectionEntries<V>,
  range: Value,
  name: 'BTreeMap' | 'BTreeSet'
): IterValue {
  if (!collection.hasTreeRoot) return arrayIter([]);
  const { start, end } = boundsOf(range);
  const type = keyType(ctx);
  if (start && end) {
    if (!start.included && !end.included && valuesEqual(type, start.key, end.key)) {
      libraryPanic(
        ctx,
        `range start and end are equal and excluded in ${name}`,
        `alloc/src/collections/btree/search.rs:${name === 'BTreeMap' ? 112 : 110}:21`
      );
    }
    if (testPartialOrder('gt', type, start.key, end.key)) {
      libraryPanic(
        ctx,
        `range start is greater than range end in ${name}`,
        `alloc/src/collections/btree/search.rs:${name === 'BTreeMap' ? 121 : 119}:21`
      );
    }
  }
  const entry: Type = name === 'BTreeMap' ? { kind: 'tuple', elems: ctx.typeArgs.slice(0, 2) } : type;
  return snapshotIter(collection.range(type, start, end), entry);
}

natives['BTreeMap<_, _>::range'] = ([self, range], ctx) => treeRange(ctx, map(self).entries, range, 'BTreeMap');
natives['BTreeSet<_>::range'] = ([self, range], ctx) => treeRange(ctx, set(self).entries, range, 'BTreeSet');
for (const [name, native] of Object.entries(mapNatives(false))) natives[`HashMap<_, _>::${name}`] = native;
for (const [name, native] of Object.entries(mapNatives(true))) natives[`BTreeMap<_, _>::${name}`] = native;
for (const [name, native] of Object.entries(setNatives(false))) natives[`HashSet<_>::${name}`] = native;
for (const [name, native] of Object.entries(setNatives(true))) natives[`BTreeSet<_>::${name}`] = native;
for (const [name, native] of Object.entries(entryNatives)) natives[`Entry<_, _>::${name}`] = native;
for (const [name, native] of Object.entries(occupiedNatives)) natives[`OccupiedEntry<_, _>::${name}`] = native;
natives['&HashMap<_, _>::into_iter'] = ([self], ctx) => mapIter(map(self), 'ref', ctx.typeArgs);
natives['&mut HashMap<_, _>::into_iter'] = ([self], ctx) => mapIter(map(self), 'mut', ctx.typeArgs);
natives['&BTreeMap<_, _>::into_iter'] = ([self], ctx) => mapIter(map(self), 'ref', ctx.typeArgs);
natives['&mut BTreeMap<_, _>::into_iter'] = ([self], ctx) => mapIter(map(self), 'mut', ctx.typeArgs);
natives['&HashSet<_>::into_iter'] = ([self], ctx) => setIter(set(self), keyType(ctx));
natives['&BTreeSet<_>::into_iter'] = ([self], ctx) => setIter(set(self), keyType(ctx));
void cloneValue;
define(natives);
