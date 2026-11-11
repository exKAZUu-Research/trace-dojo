import { pyHash } from './hashing';
import { iterate } from './objects';
import { SetTable } from './setTable';
import { resultClassOf, setClass } from './types';
import { DONE, PyDict, PyDictView, PySet, type PyValue } from './values';

/** A new set of the same type (set or frozenset) as `like`, filled from a table. */
function setLike(like: PySet, table: SetTable): PySet {
  return new PySet(resultClassOf(like.cls), table);
}

/** Adds the elements of an iterable as CPython's set_update_internal does, which decides the resulting order. */
export function updateTable(table: SetTable, other: PyValue): void {
  if (other instanceof PySet) {
    table.merge(other.table);
    return;
  }
  if (other instanceof PyDict && other.cls.isBuiltin) {
    table.reserveFor(other.store.size);
    for (const entry of other.store.ordered()) table.add(entry.key, entry.hash);
    return;
  }
  const next = iterate(other);
  for (let item = next(); item !== DONE; item = next()) table.add(item);
}

export function setUnion(set: PySet, others: PyValue[]): PySet {
  const table = set.table.copy();
  for (const other of others) updateTable(table, other);
  return setLike(set, table);
}

function tableOf(value: PyValue): SetTable {
  if (value instanceof PySet) return value.table;
  const table = new SetTable();
  updateTable(table, value);
  return table;
}

/** `set & other`, iterating the smaller set as CPython does, whose elements the result keeps. */
export function setIntersection(set: PySet, other: PyValue): PySet {
  if (set === other) return setLike(set, set.table.copy());
  const result = new SetTable();
  if (other instanceof PySet) {
    let [large, small] = [set.table, other.table];
    if (small.size > large.size) [large, small] = [small, large];
    for (const entry of small.entries()) if (large.has(entry.key, entry.hash)) result.add(entry.key, entry.hash);
    return setLike(set, result);
  }
  const next = iterate(other);
  for (let item = next(); item !== DONE; item = next()) {
    const hash = pyHash(item);
    if (set.table.has(item, hash)) result.add(item, hash);
  }
  return setLike(set, result);
}

/** Removes the elements of an iterable, then shrinks a table holding many dummies, as CPython does. */
export function differenceUpdate(table: SetTable, other: PyValue): void {
  if (other instanceof PySet && other.table === table) {
    table.clear();
    return;
  }
  if (other instanceof PySet || (other instanceof PyDict && other.cls.isBuiltin)) {
    const keys = other instanceof PySet ? [...other.table.entries()] : other.store.ordered();
    for (const entry of keys) table.discard(entry.key, entry.hash);
  } else {
    const next = iterate(other);
    for (let item = next(); item !== DONE; item = next()) table.discard(item);
  }
  if (table.fill - table.used > Math.floor((table.capacity - 1) / 4)) {
    table.resize(table.used > 50_000 ? table.used * 2 : table.used * 4);
  }
}

/** `set - other`, as CPython's set_difference does. */
export function setDifference(set: PySet, other: PyValue): PySet {
  const otherSize = other instanceof PySet ? other.table.size : other instanceof PyDict ? other.store.size : undefined;
  if (otherSize === undefined || set.table.size >> 2 > otherSize) {
    const table = set.table.copy();
    differenceUpdate(table, other);
    return setLike(set, table);
  }
  const result = new SetTable();
  const otherTable = other instanceof PySet ? other.table : undefined;
  for (const entry of set.table.entries()) {
    const found = otherTable ? otherTable.has(entry.key, entry.hash) : (other as PyDict).store.has(entry.key);
    if (!found) result.add(entry.key, entry.hash);
  }
  return setLike(set, result);
}

export function symmetricDifferenceUpdate(table: SetTable, other: PyValue): void {
  if (other instanceof PySet && other.table === table) {
    table.clear();
    return;
  }
  const otherTable = other instanceof PySet ? other.table : tableOf(other);
  for (const entry of otherTable.entries()) {
    if (!table.discard(entry.key, entry.hash)) table.add(entry.key, entry.hash);
  }
}

/** `set ^ other`, which CPython computes by updating a copy of the other operand. */
export function setSymmetricDifference(set: PySet, other: PyValue): PySet {
  const table = tableOf(other).copy();
  symmetricDifferenceUpdate(table, set);
  return setLike(set, table);
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
  const table = new SetTable();
  updateTable(table, left);
  if (operator === '|') updateTable(table, right);
  else if (operator === '-') differenceUpdate(table, right);
  else symmetricDifferenceUpdate(table, right);
  return new PySet(setClass, table);
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
  for (let item = next(); item !== DONE; item = next()) if (contains(self, item)) result.add(item);
  return new PySet(setClass, result);
}
