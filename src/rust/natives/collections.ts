import { cloneValue, compareValues, hashKey } from '../ops';
import type { Type } from '../types';
import { DONE, ElementPlace, EntryValue, type IterValue, MapValue, SetValue, UNIT_VALUE, type Value } from '../values';
import { defaultValue } from './core';
import { arrayIter, mapIter, setIter } from './iterators';
import { call, define, deref, type NativeContext, none, option, some } from './support';

function map(self: Value): MapValue {
  return deref(self) as MapValue;
}

function set(self: Value): SetValue {
  return deref(self) as SetValue;
}

/** The type of the keys, which hashes them: `K` of `HashMap<K, V>`. */
function keyType(ctx: NativeContext): Type {
  return ctx.typeArgs[0];
}

function entriesOf(ctx: NativeContext, m: MapValue): [Value, Value][] {
  return ctx.interp.formatter.mapEntries(m, keyType(ctx));
}

function setValues(ctx: NativeContext, s: SetValue): Value[] {
  const values = [...s.entries.values()];
  if (s.sorted) values.sort((a, b) => compareValues(keyType(ctx), a, b) ?? 0);
  return values;
}

function mapNatives(sorted: boolean): Record<string, (args: Value[], ctx: NativeContext) => Value> {
  return {
    new: () => new MapValue(sorted),
    with_capacity: () => new MapValue(sorted),
    insert: ([self, k, v], ctx) => {
      const m = map(self);
      const hash = hashKey(keyType(ctx), k);
      const existing = m.entries.get(hash);
      if (existing) {
        const old = existing[1];
        existing[1] = v;
        return some(ctx, old);
      }
      ctx.runtime.allocate(2);
      m.entries.set(hash, [k, v]);
      return none(ctx);
    },
    get: ([self, k], ctx) => {
      const entry = map(self).entries.get(hashKey(keyType(ctx), k));
      return option(ctx, entry?.[1], entry !== undefined);
    },
    get_mut: ([self, k], ctx) => {
      const entry = map(self).entries.get(hashKey(keyType(ctx), k));
      return option(ctx, entry && new ElementPlace(entry, 1), entry !== undefined);
    },
    get_key_value: ([self, k], ctx) => {
      const entry = map(self).entries.get(hashKey(keyType(ctx), k));
      return option(ctx, entry && [entry[0], entry[1]], entry !== undefined);
    },
    contains_key: ([self, k], ctx) => map(self).entries.has(hashKey(keyType(ctx), k)),
    remove: ([self, k], ctx) => {
      const m = map(self);
      const hash = hashKey(keyType(ctx), k);
      const entry = m.entries.get(hash);
      m.entries.delete(hash);
      return option(ctx, entry?.[1], entry !== undefined);
    },
    remove_entry: ([self, k], ctx) => {
      const m = map(self);
      const hash = hashKey(keyType(ctx), k);
      const entry = m.entries.get(hash);
      m.entries.delete(hash);
      return option(ctx, entry && [entry[0], entry[1]], entry !== undefined);
    },
    entry: ([self, k], ctx) => new EntryValue(map(self), hashKey(keyType(ctx), k), k),
    len: ([self]) => BigInt(map(self).entries.size),
    is_empty: ([self]) => map(self).entries.size === 0,
    clear: ([self]) => {
      map(self).entries.clear();
      return UNIT_VALUE;
    },
    iter: ([self], ctx) => mapIter(ctx.interp, map(self), keyType(ctx), 'ref'),
    iter_mut: ([self], ctx) => mapIter(ctx.interp, map(self), keyType(ctx), 'mut'),
    keys: ([self], ctx) => arrayIter(entriesOf(ctx, map(self)).map((entry) => entry[0])),
    values: ([self], ctx) => arrayIter(entriesOf(ctx, map(self)).map((entry) => entry[1])),
    values_mut: ([self], ctx) => arrayIter(entriesOf(ctx, map(self)).map((entry) => new ElementPlace(entry, 1))),
    into_keys: ([self], ctx) => arrayIter(entriesOf(ctx, map(self)).map((entry) => entry[0])),
    into_values: ([self], ctx) => arrayIter(entriesOf(ctx, map(self)).map((entry) => entry[1])),
    drain: ([self], ctx) => {
      const entries = entriesOf(ctx, map(self)).map(([k, v]) => [k, v] as Value);
      map(self).entries.clear();
      return arrayIter(entries);
    },
    retain: ([self, f], ctx) => {
      const m = map(self);
      for (const [hash, entry] of m.entries) {
        if (!(deref(call(ctx, f, [entry[0], new ElementPlace(entry, 1)])) as boolean)) m.entries.delete(hash);
      }
      return UNIT_VALUE;
    },
    extend: ([self, iter], ctx) => {
      const m = map(self);
      const iterator = deref(iter) as IterValue;
      for (;;) {
        ctx.runtime.spend();
        const item = iterator.next();
        if (item === DONE) break;
        const [k, v] = item as Value[];
        const hash = hashKey(keyType(ctx), k);
        const existing = m.entries.get(hash);
        if (existing) existing[1] = v;
        else m.entries.set(hash, [k, v]);
      }
      return UNIT_VALUE;
    },
    capacity: ([self]) => BigInt(map(self).entries.size),
    into_iter: ([self], ctx) => mapIter(ctx.interp, map(self), keyType(ctx), 'value'),
    first_key_value: ([self], ctx) => {
      const entries = entriesOf(ctx, map(self));
      return option(ctx, entries[0] && [entries[0][0], entries[0][1]], entries.length > 0);
    },
    last_key_value: ([self], ctx) => {
      const entries = entriesOf(ctx, map(self));
      const last = entries.at(-1);
      return option(ctx, last && [last[0], last[1]], last !== undefined);
    },
    pop_first: ([self], ctx) => {
      const m = map(self);
      const first = entriesOf(ctx, m)[0];
      if (!first) return none(ctx);
      m.entries.delete(hashKey(keyType(ctx), first[0]));
      return some(ctx, [first[0], first[1]]);
    },
    pop_last: ([self], ctx) => {
      const m = map(self);
      const last = entriesOf(ctx, m).at(-1);
      if (!last) return none(ctx);
      m.entries.delete(hashKey(keyType(ctx), last[0]));
      return some(ctx, [last[0], last[1]]);
    },
  };
}

function setNatives(sorted: boolean): Record<string, (args: Value[], ctx: NativeContext) => Value> {
  const others = (
    ctx: NativeContext,
    a: SetValue,
    b: SetValue,
    keep: (inA: boolean, inB: boolean) => boolean,
    order: 'a' | 'ab'
  ): Value => {
    const result: Value[] = [];
    for (const value of setValues(ctx, a))
      if (keep(true, b.entries.has(hashKey(keyType(ctx), value)))) result.push(value);
    if (order === 'ab') {
      for (const value of setValues(ctx, b))
        if (keep(a.entries.has(hashKey(keyType(ctx), value)), true) && !a.entries.has(hashKey(keyType(ctx), value)))
          result.push(value);
    }
    if (sorted) result.sort((x, y) => compareValues(keyType(ctx), x, y) ?? 0);
    return arrayIter(result);
  };
  return {
    new: () => new SetValue(sorted),
    with_capacity: () => new SetValue(sorted),
    insert: ([self, value], ctx) => {
      const s = set(self);
      const hash = hashKey(keyType(ctx), value);
      if (s.entries.has(hash)) return false;
      ctx.runtime.allocate(1);
      s.entries.set(hash, value);
      return true;
    },
    contains: ([self, value], ctx) => set(self).entries.has(hashKey(keyType(ctx), value)),
    remove: ([self, value], ctx) => set(self).entries.delete(hashKey(keyType(ctx), value)),
    take: ([self, value], ctx) => {
      const s = set(self);
      const hash = hashKey(keyType(ctx), value);
      const found = s.entries.get(hash);
      s.entries.delete(hash);
      return option(ctx, found, s.entries.has(hash) || found !== undefined);
    },
    get: ([self, value], ctx) => {
      const found = set(self).entries.get(hashKey(keyType(ctx), value));
      return option(ctx, found, found !== undefined);
    },
    len: ([self]) => BigInt(set(self).entries.size),
    is_empty: ([self]) => set(self).entries.size === 0,
    clear: ([self]) => {
      set(self).entries.clear();
      return UNIT_VALUE;
    },
    iter: ([self], ctx) => setIter(set(self), keyType(ctx)),
    union: ([self, other], ctx) => others(ctx, set(self), set(other), () => true, 'ab'),
    intersection: ([self, other], ctx) => others(ctx, set(self), set(other), (_a, b) => b, 'a'),
    difference: ([self, other], ctx) => others(ctx, set(self), set(other), (_a, b) => !b, 'a'),
    symmetric_difference: ([self, other], ctx) => {
      const a = set(self);
      const b = set(other);
      const result = [
        ...setValues(ctx, a).filter((value) => !b.entries.has(hashKey(keyType(ctx), value))),
        ...setValues(ctx, b).filter((value) => !a.entries.has(hashKey(keyType(ctx), value))),
      ];
      if (sorted) result.sort((x, y) => compareValues(keyType(ctx), x, y) ?? 0);
      return arrayIter(result);
    },
    is_subset: ([self, other]) => [...set(self).entries.keys()].every((hash) => set(other).entries.has(hash)),
    is_superset: ([self, other]) => [...set(other).entries.keys()].every((hash) => set(self).entries.has(hash)),
    is_disjoint: ([self, other]) => [...set(self).entries.keys()].every((hash) => !set(other).entries.has(hash)),
    retain: ([self, f], ctx) => {
      const s = set(self);
      for (const [hash, value] of s.entries) if (!(deref(call(ctx, f, [value])) as boolean)) s.entries.delete(hash);
      return UNIT_VALUE;
    },
    extend: ([self, iter], ctx) => {
      const s = set(self);
      const iterator = deref(iter) as IterValue;
      for (;;) {
        ctx.runtime.spend();
        const item = iterator.next();
        if (item === DONE) break;
        const hash = hashKey(keyType(ctx), item);
        if (!s.entries.has(hash)) s.entries.set(hash, item);
      }
      return UNIT_VALUE;
    },
    drain: ([self], ctx) => {
      const values = setValues(ctx, set(self));
      set(self).entries.clear();
      return arrayIter(values);
    },
    into_iter: ([self], ctx) => setIter(set(self), keyType(ctx)),
    first: ([self], ctx) => {
      const values = setValues(ctx, set(self));
      return option(ctx, values[0], values.length > 0);
    },
    last: ([self], ctx) => {
      const values = setValues(ctx, set(self));
      return option(ctx, values.at(-1), values.length > 0);
    },
    pop_first: ([self], ctx) => {
      const values = setValues(ctx, set(self));
      if (values.length === 0) return none(ctx);
      set(self).entries.delete(hashKey(keyType(ctx), values[0]));
      return some(ctx, values[0]);
    },
    pop_last: ([self], ctx) => {
      const values = setValues(ctx, set(self));
      const last = values.at(-1);
      if (last === undefined) return none(ctx);
      set(self).entries.delete(hashKey(keyType(ctx), last));
      return some(ctx, last);
    },
  };
}

function entryValue(entry: Value): EntryValue {
  return deref(entry) as EntryValue;
}

/** Inserts an entry's key with a value when the map lacks it, returning a place for the entry's value. */
function orInsertWith(ctx: NativeContext, entry: EntryValue, make: () => Value): Value {
  let existing = entry.map.entries.get(entry.hash);
  if (!existing) {
    ctx.runtime.allocate(2);
    existing = [entry.key, make()];
    entry.map.entries.set(entry.hash, existing);
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
    const existing = entry.map.entries.get(entry.hash);
    if (existing) call(ctx, f, [new ElementPlace(existing, 1)]);
    return entry;
  },
  key: ([self]) => entryValue(self).key,
};

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const [name, native] of Object.entries(mapNatives(false))) natives[`HashMap<_, _>::${name}`] = native;
for (const [name, native] of Object.entries(mapNatives(true))) natives[`BTreeMap<_, _>::${name}`] = native;
for (const [name, native] of Object.entries(setNatives(false))) natives[`HashSet<_>::${name}`] = native;
for (const [name, native] of Object.entries(setNatives(true))) natives[`BTreeSet<_>::${name}`] = native;
for (const [name, native] of Object.entries(entryNatives)) natives[`Entry<_, _>::${name}`] = native;
natives['&HashMap<_, _>::into_iter'] = ([self], ctx) => mapIter(ctx.interp, map(self), keyType(ctx), 'ref');
natives['&mut HashMap<_, _>::into_iter'] = ([self], ctx) => mapIter(ctx.interp, map(self), keyType(ctx), 'mut');
natives['&BTreeMap<_, _>::into_iter'] = ([self], ctx) => mapIter(ctx.interp, map(self), keyType(ctx), 'ref');
natives['&mut BTreeMap<_, _>::into_iter'] = ([self], ctx) => mapIter(ctx.interp, map(self), keyType(ctx), 'mut');
natives['&HashSet<_>::into_iter'] = ([self], ctx) => setIter(set(self), keyType(ctx));
natives['&BTreeSet<_>::into_iter'] = ([self], ctx) => setIter(set(self), keyType(ctx));
void cloneValue;
define(natives);
