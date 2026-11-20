import type { TableMap } from '../capacity';
import type { CollectionEntries, CollectionKey } from '../collectionEntries';
import { described, listPart } from '../iterDebug';
import { cloneValue, isGreater } from '../ops';
import type { Type } from '../types';
import {
  DONE,
  ElementPlace,
  EntryValue,
  type IterValue,
  MapValue,
  type RangeValue,
  SetValue,
  UNIT_VALUE,
  type Value,
} from '../values';
import { checkTableCapacity } from './capacityNatives';
import { defaultValue } from './core';
import { arrayIter, mapIter, setIter } from './iterators';
import { sizeOf } from './layout';
import { btreeSetOp, type SetOp } from './setOps';
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

function resize(collection: MapValue | SetValue, change: (table: TableMap<string, unknown>) => void): Value {
  if (collection.entries.table) change(collection.entries.table);
  return UNIT_VALUE;
}

/** `HashSet`'s set operations, which `{:?}` writes as the list of the elements left. */
function listed(iter: IterValue): IterValue {
  return described(iter, (show, item) => listPart(iter.rest?.() ?? [], item, show));
}

function map(self: Value): MapValue {
  return deref(self) as MapValue;
}

function set(self: Value): SetValue {
  return deref(self) as SetValue;
}

const others = (
  ctx: NativeContext,
  a: SetValue,
  b: SetValue,
  keep: (inA: boolean, inB: boolean) => boolean,
  order: 'a' | 'ab'
): Value => {
  const result: Value[] = [];
  for (const value of setValues(a)) if (keep(true, b.entries.has(entryKey(ctx, b.entries, value)))) result.push(value);
  if (order === 'ab') {
    for (const value of setValues(b))
      if (!a.entries.has(entryKey(ctx, a.entries, value)) && keep(false, true)) result.push(value);
  }
  return listed(arrayIter(result));
};
/** `BTreeSet`'s set operations, which take std's steps. */
const btree = (ctx: NativeContext, op: SetOp, self: Value, other: Value): Value => {
  const sets: [SetValue, SetValue] = [set(self), set(other)];
  const type = keyType(ctx);
  return btreeSetOp(op, sets, type, ctx.interp.program.builtinType('BTreeSet', [type]));
};

/** The type of the keys, which hashes them: `K` of `HashMap<K, V>`. */
function keyType(ctx: NativeContext): Type {
  return ctx.typeArgs[0];
}

function entryKey<V>(ctx: NativeContext, entries: CollectionEntries<V>, value: Value): CollectionKey {
  return entries.key(keyType(ctx), value);
}

function entriesOf(m: MapValue): [Value, Value][] {
  return [...m.entries.values()];
}

function setValues(s: SetValue): Value[] {
  return [...s.entries.values()];
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
  ctx.runtime.allocate(2);
  m.entries.set(key, [k, v]);
  return none(ctx);
}

function mapIterNatives(): Record<string, Native> {
  return {
    into_iter: ([self]) => mapIter(map(self), 'value'),
    iter: ([self]) => mapIter(map(self), 'ref'),
    iter_mut: ([self]) => mapIter(map(self), 'mut'),
    keys: ([self]) => arrayIter(entriesOf(map(self)).map((entry) => entry[0])),
    values: ([self]) => arrayIter(entriesOf(map(self)).map((entry) => entry[1])),
    values_mut: ([self]) => arrayIter(entriesOf(map(self)).map((entry) => new ElementPlace(entry, 1))),
    into_keys: ([self]) => arrayIter(entriesOf(map(self)).map((entry) => entry[0])),
    into_values: ([self]) => arrayIter(entriesOf(map(self)).map((entry) => entry[1])),
    drain: ([self]) => {
      const entries = entriesOf(map(self)).map(([k, v]) => [k, v] as Value);
      map(self).entries.clear();
      return arrayIter(entries);
    },
    retain: ([self, f], ctx) => {
      const m = map(self);
      m.entries.retain((entry) => deref(call(ctx, f, [entry[0], new ElementPlace(entry, 1)])) as boolean);
      return UNIT_VALUE;
    },
    extend: ([self, iter], ctx) => extendMap(ctx, map(self), deref(iter) as IterValue),
  };
}

function extendMap(ctx: NativeContext, m: MapValue, iterator: IterValue): Value {
  for (;;) {
    ctx.runtime.spend();
    const item = iterator.next();
    if (item === DONE) break;
    const [k, v] = item as Value[];
    const key = entryKey(ctx, m.entries, k);
    const existing = m.entries.get(key);
    if (existing) existing[1] = v;
    else m.entries.set(key, [k, v]);
  }
  return UNIT_VALUE;
}

function mapEndNatives(): Record<string, Native> {
  return {
    first_key_value: ([self], ctx) => {
      const entries = entriesOf(map(self));
      return option(ctx, entries[0] && [entries[0][0], entries[0][1]], entries.length > 0);
    },
    last_key_value: ([self], ctx) => {
      const entries = entriesOf(map(self));
      const last = entries.at(-1);
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

// code-gauge-allow functionCognitiveComplexity 28 -- One native per method of std's sets.
// code-gauge-allow functionNcss 57 -- One native per method of std's sets.
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
    iter: ([self]) => setIter(set(self)),
    union: ([self, other], ctx) =>
      sorted ? btree(ctx, 'union', self, other) : others(ctx, set(self), set(other), () => true, 'ab'),
    intersection: ([self, other], ctx) =>
      sorted ? btree(ctx, 'intersection', self, other) : others(ctx, set(self), set(other), (_a, b) => b, 'a'),
    difference: ([self, other], ctx) =>
      sorted ? btree(ctx, 'difference', self, other) : others(ctx, set(self), set(other), (_a, b) => !b, 'a'),
    symmetric_difference: ([self, other], ctx) => {
      if (sorted) return btree(ctx, 'symmetric_difference', self, other);
      const a = set(self);
      const b = set(other);
      return listed(
        arrayIter([
          ...setValues(a).filter((value) => !b.entries.has(entryKey(ctx, b.entries, value))),
          ...setValues(b).filter((value) => !a.entries.has(entryKey(ctx, a.entries, value))),
        ])
      );
    },
    is_subset: ([self, other], ctx) => everySetMember(ctx, set(self), set(other), true),
    is_superset: ([self, other], ctx) => everySetMember(ctx, set(other), set(self), true),
    is_disjoint: ([self, other], ctx) => everySetMember(ctx, set(self), set(other), false),
    retain: ([self, f], ctx) => {
      const s = set(self);
      s.entries.retain((value) => deref(call(ctx, f, [value])) as boolean);
      return UNIT_VALUE;
    },
    extend: ([self, iter], ctx) => {
      const s = set(self);
      const iterator = deref(iter) as IterValue;
      for (;;) {
        ctx.runtime.spend();
        const item = iterator.next();
        if (item === DONE) break;
        const hash = entryKey(ctx, s.entries, item);
        if (!s.entries.has(hash)) s.entries.set(hash, item);
      }
      return UNIT_VALUE;
    },
    drain: ([self]) => {
      const values = setValues(set(self));
      set(self).entries.clear();
      return arrayIter(values);
    },
    into_iter: ([self]) => setIter(set(self)),
    first: ([self], ctx) => {
      const values = setValues(set(self));
      return option(ctx, values[0], values.length > 0);
    },
    last: ([self], ctx) => {
      const values = setValues(set(self));
      return option(ctx, values.at(-1), values.length > 0);
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

function everySetMember(ctx: NativeContext, a: SetValue, b: SetValue, present: boolean): boolean {
  const type = keyType(ctx);
  for (const value of a.entries.values()) {
    if (b.entries.has(b.entries.key(type, value)) !== present) return false;
  }
  return true;
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

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
function treeRange<V extends Value>(
  ctx: NativeContext,
  collection: CollectionEntries<V>,
  range: Value,
  name: 'BTreeMap' | 'BTreeSet'
): IterValue {
  if (!collection.hasTreeRoot) return arrayIter([]);
  const bounds = deref(range) as RangeValue | undefined;
  const type = keyType(ctx);
  const start = bounds?.start;
  const end = bounds?.end;
  if (start !== undefined && end !== undefined && isGreater(type, start, end)) {
    libraryPanic(
      ctx,
      `range start is greater than range end in ${name}`,
      `alloc/src/collections/btree/search.rs:${name === 'BTreeMap' ? 121 : 119}:21`
    );
  }
  return arrayIter(collection.range(type, start, end, !!bounds?.inclusive && !bounds.exhausted));
}

natives['BTreeMap<_, _>::range'] = ([self, range], ctx) => treeRange(ctx, map(self).entries, range, 'BTreeMap');
natives['BTreeSet<_>::range'] = ([self, range], ctx) => treeRange(ctx, set(self).entries, range, 'BTreeSet');
for (const [name, native] of Object.entries(mapNatives(false))) natives[`HashMap<_, _>::${name}`] = native;
for (const [name, native] of Object.entries(mapNatives(true))) natives[`BTreeMap<_, _>::${name}`] = native;
for (const [name, native] of Object.entries(setNatives(false))) natives[`HashSet<_>::${name}`] = native;
for (const [name, native] of Object.entries(setNatives(true))) natives[`BTreeSet<_>::${name}`] = native;
for (const [name, native] of Object.entries(entryNatives)) natives[`Entry<_, _>::${name}`] = native;
natives['&HashMap<_, _>::into_iter'] = ([self]) => mapIter(map(self), 'ref');
natives['&mut HashMap<_, _>::into_iter'] = ([self]) => mapIter(map(self), 'mut');
natives['&BTreeMap<_, _>::into_iter'] = ([self]) => mapIter(map(self), 'ref');
natives['&mut BTreeMap<_, _>::into_iter'] = ([self]) => mapIter(map(self), 'mut');
natives['&HashSet<_>::into_iter'] = ([self]) => setIter(set(self));
natives['&BTreeSet<_>::into_iter'] = ([self]) => setIter(set(self));
void cloneValue;
define(natives);
