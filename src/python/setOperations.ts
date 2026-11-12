import { pyHash } from './hashing';
import { iterate } from './objects';
import { currentRuntime } from './runtimeContext';
import { SetTable } from './setTable';
import { dictClass, exceptionClassNamed, frozensetClass, newTuple, setClass } from './types';
import { DONE, PyDict, PyDictView, PyError, PySet, type PyValue } from './values';

/**
 * Looks `key` up as CPython's set_contains, set_discard, and set_remove do: a mutable set, unhashable, is looked up
 * again as the frozenset of its elements, so that it finds the equal frozenset.
 */
export function lookupSetKey<T>(key: PyValue, lookup: (key: PyValue) => T): T {
  try {
    return lookup(key);
  } catch (error) {
    const isUnhashableSet =
      key instanceof PySet &&
      key.cls.isSubclassOf(setClass) &&
      error instanceof PyError &&
      error.exception.cls.isSubclassOf(exceptionClassNamed('TypeError'));
    if (!isUnhashableSet) throw error;
    const table = new SetTable();
    mergeTable(table, key.table);
    return lookup(new PySet(frozensetClass, table));
  }
}

/** A new set or frozenset filled from a table: the builtin type of `like`, as CPython gives for a subclass too. */
function setLike(like: PySet, table: SetTable): PySet {
  return new PySet(like.cls.isSubclassOf(frozensetClass) ? frozensetClass : setClass, table);
}

/** Adds the elements of an iterable as CPython's set_update_internal does, which decides the resulting order. */
export function updateTable(table: SetTable, other: PyValue): void {
  if (other instanceof PySet) {
    mergeTable(table, other.table);
    return;
  }
  if (isExactDict(other)) {
    currentRuntime().scan(other.store.size);
    table.reserveFor(other.store.size);
    for (const entry of other.store.ordered()) table.add(entry.key, entry.hash);
    return;
  }
  const next = iterate(other);
  for (let item = next(); item !== DONE; item = next()) addToTable(table, item);
}

/** Adds one element taken from an iterator, charging the step. */
export function addToTable(table: SetTable, item: PyValue, hash?: bigint): void {
  currentRuntime().spend();
  table.add(item, hash);
}

function mergeTable(table: SetTable, other: SetTable): void {
  currentRuntime().scan(other.size);
  table.merge(other);
}

/** CPython pre-sizes a set and reads keys with their stored hashes only for an exact dict, not for a subclass. */
function isExactDict(value: PyValue): value is PyDict {
  return value instanceof PyDict && value.cls === dictClass;
}

/** `set | other` and `set.union(*others)`: a copy that CPython updates with each operand but the set itself. */
export function setUnion(set: PySet, others: PyValue[]): PySet {
  const table = copyTable(set.table);
  for (const other of others) if (other !== set) updateTable(table, other);
  return setLike(set, table);
}

/** `set.intersection(*others)`, which CPython folds over the set itself and copies only without arguments. */
export function setIntersectionAll(set: PySet, others: PyValue[]): PySet {
  if (others.length === 0) return setLike(set, copyTable(set.table));
  let result = set;
  for (const other of others) result = setIntersection(result, other);
  return result;
}

/** `set & other`, iterating the smaller set as CPython does, whose elements the result keeps. */
export function setIntersection(set: PySet, other: PyValue): PySet {
  if (set === other) return setLike(set, copyTable(set.table));
  const result = new SetTable();
  if (other instanceof PySet) {
    let [large, small] = [set.table, other.table];
    if (small.size > large.size) [large, small] = [small, large];
    const runtime = currentRuntime();
    runtime.scan(small.size);
    for (const entry of small.entries()) if (large.has(entry.key, entry.hash)) result.add(entry.key, entry.hash);
    return setLike(set, result);
  }
  const next = iterate(other);
  // As set_intersection does, the reading stops once every element of the set has been found.
  for (let item = next(); item !== DONE; item = next()) {
    const hash = pyHash(item);
    if (!set.table.has(item, hash)) {
      currentRuntime().spend();
      continue;
    }
    addToTable(result, item, hash);
    if (result.size >= set.table.size) break;
  }
  return setLike(set, result);
}

/** Removes the elements of an iterable, then shrinks a table holding many dummies, as CPython does. */
export function differenceUpdate(table: SetTable, other: PyValue): void {
  if (other instanceof PySet && other.table === table) {
    table.clear();
    return;
  }
  const runtime = currentRuntime();
  if (other instanceof PySet) {
    runtime.scan(other.table.size);
    for (const entry of other.table.entries()) table.discard(entry.key, entry.hash);
  } else {
    const next = iterate(other);
    for (let item = next(); item !== DONE; item = next()) {
      runtime.spend();
      table.discard(item);
    }
  }
  if (table.fill - table.used > Math.floor((table.capacity - 1) / 4)) {
    table.resize(table.used > 50_000 ? table.used * 2 : table.used * 4);
  }
}

/** `set.difference(*others)`: the difference with the first, from which CPython removes the rest in place. */
export function setDifferenceAll(set: PySet, others: PyValue[]): PySet {
  if (others.length === 0) return setLike(set, copyTable(set.table));
  const result = setDifference(set, others[0]);
  for (const other of others.slice(1)) differenceUpdate(result.table, other);
  return result;
}

/** `set - other`, as CPython's set_difference does. */
export function setDifference(set: PySet, other: PyValue): PySet {
  const otherSize = other instanceof PySet ? other.table.size : isExactDict(other) ? other.store.size : undefined;
  if (otherSize === undefined || set.table.size >> 2 > otherSize) {
    const table = copyTable(set.table);
    differenceUpdate(table, other);
    return setLike(set, table);
  }
  const runtime = currentRuntime();
  runtime.scan(set.table.size);
  const result = new SetTable();
  const otherTable = other instanceof PySet ? other.table : undefined;
  for (const entry of set.table.entries()) {
    const found = otherTable ? otherTable.has(entry.key, entry.hash) : (other as PyDict).store.has(entry.key);
    if (!found) result.add(entry.key, entry.hash);
  }
  return setLike(set, result);
}

/** `set ^= other`, as CPython's set_symmetric_difference_update does: a dict's keys in dict order, anything else as a set. */
export function symmetricDifferenceUpdate(table: SetTable, other: PyValue): void {
  if (other instanceof PySet && other.table === table) {
    table.clear();
    return;
  }
  const entries = isExactDict(other)
    ? other.store.ordered()
    : [...(other instanceof PySet ? other.table : tableFrom(other)).entries()];
  const runtime = currentRuntime();
  runtime.scan(entries.length);
  for (const entry of entries) {
    if (!table.discard(entry.key, entry.hash)) table.add(entry.key, entry.hash);
  }
}

/** `set ^ other`, which CPython computes by updating a new set of the other operand with the set. */
export function setSymmetricDifference(set: PySet, other: PyValue): PySet {
  const table = tableFrom(other);
  symmetricDifferenceUpdate(table, set);
  return setLike(set, table);
}

function copyTable(table: SetTable): SetTable {
  const copy = new SetTable();
  mergeTable(copy, table);
  return copy;
}

/** A new table filled from an iterable, as CPython's make_new_set does. */
function tableFrom(value: PyValue): SetTable {
  const table = new SetTable();
  updateTable(table, value);
  return table;
}

/** Whether a value is a dict's keys or items view, which supports set operators. */
export function isSetLikeView(value: PyValue): value is PyDictView {
  return value instanceof PyDictView && value.view !== 'values';
}

/**
 * A set operator with a keys or items view on either side, as CPython's dictviews_and, _or, _sub, and _xor do: all
 * but `&` start from a set of the left operand.
 */
export function dictViewBinary(
  operator: '&' | '|' | '-' | '^',
  left: PyValue,
  right: PyValue,
  contains: (view: PyDictView, item: PyValue) => boolean
): PySet {
  if (operator === '&') return viewIntersection(left, right, contains);
  if (operator === '^' && isItemsView(left) && isItemsView(right))
    return itemsSymmetricDifference(left, right, contains);
  // CPython builds the set from the dict itself for the keys view of an exact dict, which pre-sizes the table.
  const table = tableFrom(
    left instanceof PyDictView && left.view === 'keys' && isExactDict(left.dict) ? left.dict : left
  );
  if (operator === '|') updateTable(table, right);
  else if (operator === '-') differenceUpdate(table, right);
  else symmetricDifferenceUpdate(table, right);
  return new PySet(setClass, table);
}

function isItemsView(value: PyValue): value is PyDictView {
  return value instanceof PyDictView && value.view === 'items';
}

/** `items ^ items` as CPython's dictitems_xor does: the right dict's unmatched pairs, then the left dict's. */
function itemsSymmetricDifference(
  left: PyDictView,
  right: PyDictView,
  contains: (view: PyDictView, item: PyValue) => boolean
): PySet {
  const result = new SetTable();
  const matched = new Set<unknown>();
  for (const { key, value, hash } of right.dict.store.ordered()) {
    const pair = newTuple([key, value]);
    if (contains(left, pair)) matched.add(left.dict.store.lookup(key, hash));
    else addToTable(result, pair);
  }
  for (const entry of left.dict.store.ordered()) {
    if (!matched.has(entry)) addToTable(result, newTuple([entry.key, entry.value]));
  }
  return new PySet(setClass, result);
}

function viewIntersection(
  left: PyValue,
  right: PyValue,
  contains: (view: PyDictView, item: PyValue) => boolean
): PySet {
  let [self, other] = isSetLikeView(left) ? [left, right] : [right as PyDictView, left];
  const size = self.dict.store.size;
  if (other instanceof PySet && other.cls === setClass && size <= other.table.size) {
    return setIntersection(other, self);
  }
  if (isSetLikeView(other) && other.dict.store.size > size) [self, other] = [other, self];
  const result = new SetTable();
  const next = iterate(other);
  for (let item = next(); item !== DONE; item = next()) {
    if (contains(self, item)) addToTable(result, item);
    else currentRuntime().spend();
  }
  return new PySet(setClass, result);
}
