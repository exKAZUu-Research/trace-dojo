import { pyRepr } from './conversions';
import { method } from './define';
import { DictStore } from './dictStore';
import { mappingEntries } from './expressionEvaluator';
import { NATIVE_HASHES, pyHash } from './hashing';
import { keyError, sliceIndices } from './items';
import { argument, checkArgs } from './nativeArgs';
import { toIndex } from './numbers';
import { callValue, getItem, getIterator, isTruthy, iterate, lookupSpecial, toArray } from './objects';
import { contains, countEqual, equals, extendList, lessThan } from './operators';
import { currentRuntime } from './runtimeContext';
import {
  addToTable,
  differenceUpdate,
  setDifferenceAll,
  setIntersection,
  setIntersectionAll,
  setSymmetricDifference,
  setUnion,
  symmetricDifferenceUpdate,
  updateTable,
} from './setOperations';
import { SetTable } from './setTable';
import {
  defineMethod,
  dictClass,
  dictItemsClass,
  dictKeysClass,
  dictValuesClass,
  frozensetClass,
  iteratorClass,
  listClass,
  newList,
  newTuple,
  None,
  pyError,
  rangeClass,
  setClass,
  sliceClass,
  tupleClass,
  typeError,
  typeName,
  valueError,
} from './types';
import {
  DONE,
  type Kwargs,
  PyDict,
  PyDictView,
  PyIterator,
  PyList,
  type PyObject,
  PyRange,
  PySet,
  PySlice,
  PyTuple,
  type PyValue,
} from './values';

// Representation ----------------------------------------------------------------------------------------------------

const reprInProgress = new Set<PyObject>();

/** Reprs a container, showing `placeholder` for a container already being shown, as recursive reprs do. */
export function containerRepr(object: PyObject, placeholder: string, render: () => string): string {
  if (reprInProgress.has(object)) return placeholder;
  reprInProgress.add(object);
  try {
    return currentRuntime().nestedRepr(render);
  } finally {
    reprInProgress.delete(object);
  }
}

function joinReprs(items: readonly PyValue[]): string {
  let result = '';
  for (const [index, item] of items.entries()) {
    if (index > 0) result += ', ';
    result += pyRepr(item);
    currentRuntime().buildString(result.length);
  }
  return result;
}

// list --------------------------------------------------------------------------------------------------------------

listClass.construct = (cls, args, kwargs) => {
  checkArgs({ qualified: 'list', min: 0, max: 1, style: 'expected' }, args, kwargs);
  const items = args.length === 0 ? [] : toArray(args[0]);
  currentRuntime().allocate(items.length + 1);
  return new PyList(cls, items);
};
const listOf = (self: PyValue): PyList => self as PyList;

method(listClass, '__repr__', 'none', 0, 0, (self) =>
  containerRepr(self as PyObject, '[...]', () => `[${joinReprs(listOf(self).items)}]`)
);
method(listClass, '__len__', 'none', 0, 0, (self) => BigInt(listOf(self).items.length));
method(listClass, '__contains__', 'one', 1, 1, (self, [item]) => contains(self, item));
method(listClass, '__getitem__', 'one', 1, 1, (self, [key]) => getItem(self, key));
method(listClass, '__iter__', 'none', 0, 0, (self) => getIterator(self));
method(listClass, '__reversed__', 'none', 0, 0, (self) => reversedIterator(listOf(self), 'list_reverseiterator'));
method(listClass, 'append', 'one', 1, 1, (self, [item]) => {
  currentRuntime().allocate(1);
  listOf(self).items.push(item);
  return None;
});
method(listClass, 'extend', 'one', 1, 1, (self, [iterable]) => {
  extendList(listOf(self), iterable);
  return None;
});
method(listClass, 'insert', 'expected', 2, 2, (self, [index, item]) => {
  const { items } = listOf(self);
  let position = toIndex(index);
  const length = BigInt(items.length);
  if (position < 0n) position = position + length < 0n ? 0n : position + length;
  if (position > length) position = length;
  currentRuntime().allocate(1);
  items.splice(Number(position), 0, item);
  return None;
});
method(listClass, 'remove', 'one', 1, 1, (self, [item]) => {
  const { items } = listOf(self);
  const index = items.findIndex((element) => equals(element, item));
  if (index === -1) throw valueError('list.remove(x): x not in list');
  items.splice(index, 1);
  return None;
});
method(listClass, 'pop', 'expected', 0, 1, (self, [index]) => {
  const { items } = listOf(self);
  if (items.length === 0) throw pyError('IndexError', 'pop from empty list');
  let position = index === undefined ? -1n : toIndex(index);
  if (position < 0n) position += BigInt(items.length);
  if (position < 0n || position >= BigInt(items.length)) throw pyError('IndexError', 'pop index out of range');
  return items.splice(Number(position), 1)[0];
});
method(listClass, 'clear', 'none', 0, 0, (self) => {
  listOf(self).items.length = 0;
  return None;
});
method(listClass, 'index', 'expected', 1, 3, (self, [item, start, stop]) => {
  const index = sequenceIndex(listOf(self).items, item, start, stop);
  if (index === -1) throw valueError('list.index(x): x not in list');
  return BigInt(index);
});
method(listClass, 'count', 'one', 1, 1, (self, [item]) =>
  BigInt(listOf(self).items.filter((element) => equals(element, item)).length)
);
method(listClass, 'reverse', 'none', 0, 0, (self) => {
  listOf(self).items.reverse();
  return None;
});
method(listClass, 'copy', 'none', 0, 0, (self) => newList([...listOf(self).items]));
method(
  listClass,
  'sort',
  'takes',
  0,
  0,
  (self, _args, kwargs) => {
    sortList(listOf(self), kwargs?.get('key') ?? None, isTruthy(kwargs?.get('reverse') ?? false));
    return None;
  },
  { keywords: ['key', 'reverse'] }
);
listClass.dict.set('__hash__', None);

/** The index of the first item equal to `item` between the slice bounds, or -1. */
function sequenceIndex(
  items: readonly PyValue[],
  item: PyValue,
  start: PyValue | undefined,
  stop: PyValue | undefined
): number {
  const { start: from, stop: to } = sliceIndices(
    new PySlice(sliceClass, start ?? None, stop ?? None, None),
    items.length
  );
  for (let index = from; index < to; index++) {
    currentRuntime().spend();
    if (equals(items[index], item)) return index;
  }
  return -1;
}

/** Sorts a list in place, stably, with keys computed once each, as `list.sort` does. */
export function sortList(list: PyList, key: PyValue, reverse: boolean): void {
  const original = list.items;
  const keys = key === None ? original : original.map((item) => callValue(key, [item]));
  const indices = original.map((_, index) => index);
  if (reverse) indices.reverse();
  list.items = [];
  const runtime = currentRuntime();
  try {
    const sorted = mergeSort(indices, (a, b) => {
      runtime.spend();
      return lessThan(keys[a], keys[b]);
    });
    if (reverse) sorted.reverse();
    if (list.items.length > 0) throw valueError('list modified during sort');
    list.items = sorted.map((index) => original[index]);
  } catch (error) {
    if (list.items.length === 0) list.items = original;
    throw error;
  }
}

/** A stable merge sort that only asks whether one item is less than another, as Python's sort does. */
function mergeSort(items: number[], less: (a: number, b: number) => boolean): number[] {
  if (items.length <= 1) return items;
  const middle = items.length >> 1;
  const left = mergeSort(items.slice(0, middle), less);
  const right = mergeSort(items.slice(middle), less);
  const result: number[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (less(right[j], left[i])) result.push(right[j++]);
    else result.push(left[i++]);
  }
  while (i < left.length) result.push(left[i++]);
  while (j < right.length) result.push(right[j++]);
  return result;
}

function reversedIterator(sequence: PyList | PyTuple, name: string): PyIterator {
  let index = sequence.items.length - 1;
  const iterator = new PyIterator(
    iteratorClass(name),
    () => {
      if (index >= sequence.items.length) index = -1;
      return index >= 0 ? sequence.items[index--] : DONE;
    },
    () => [sequence]
  );
  iterator.lengthHint = () => (index < sequence.items.length ? index + 1 : 0);
  return iterator;
}

// tuple -------------------------------------------------------------------------------------------------------------

tupleClass.construct = (cls, args, kwargs) => {
  checkArgs({ qualified: 'tuple', min: 0, max: 1, style: 'expected' }, args, kwargs);
  if (args.length === 0) return cls === tupleClass ? newTuple([]) : new PyTuple(cls, []);
  if (args[0] instanceof PyTuple && cls === tupleClass && args[0].cls === tupleClass) return args[0];
  const items = toArray(args[0]);
  currentRuntime().allocate(items.length + 1);
  return cls === tupleClass ? newTuple(items) : new PyTuple(cls, items);
};
const tupleOf = (self: PyValue): PyTuple => self as PyTuple;
method(tupleClass, '__repr__', 'none', 0, 0, (self) => {
  const { items } = tupleOf(self);
  return containerRepr(self as PyObject, '(...)', () =>
    items.length === 1 ? `(${pyRepr(items[0])},)` : `(${joinReprs(items)})`
  );
});
method(tupleClass, '__len__', 'none', 0, 0, (self) => BigInt(tupleOf(self).items.length));
method(tupleClass, '__hash__', 'none', 0, 0, (self) => pyHash(newTuple(tupleOf(self).items)));
method(tupleClass, '__contains__', 'one', 1, 1, (self, [item]) =>
  tupleOf(self).items.some((element) => equals(element, item))
);
method(tupleClass, '__getitem__', 'one', 1, 1, (self, [key]) => getItem(newTuple(tupleOf(self).items), key));
method(tupleClass, '__iter__', 'none', 0, 0, (self) => getIterator(newTuple(tupleOf(self).items)));
method(tupleClass, 'index', 'expected', 1, 3, (self, [item, start, stop]) => {
  const index = sequenceIndex(tupleOf(self).items, item, start, stop);
  if (index === -1) throw valueError('tuple.index(x): x not in tuple');
  return BigInt(index);
});
method(tupleClass, 'count', 'one', 1, 1, (self, [item]) =>
  BigInt(tupleOf(self).items.filter((element) => equals(element, item)).length)
);

// range -------------------------------------------------------------------------------------------------------------

rangeClass.construct = (_cls, args, kwargs) => {
  checkArgs({ qualified: 'range', min: 1, max: 3, style: 'expected' }, args, kwargs);
  const [first, second, third] = args.map((value) => toIndex(value));
  if (args.length === 1) return new PyRange(rangeClass, 0n, first, 1n);
  const step = third ?? 1n;
  if (step === 0n) throw valueError('range() arg 3 must not be zero');
  return new PyRange(rangeClass, first, second, step);
};
const rangeOf = (self: PyValue): PyRange => self as PyRange;
method(rangeClass, '__repr__', 'none', 0, 0, (self) => {
  const { start, stop, step } = rangeOf(self);
  return step === 1n ? `range(${start}, ${stop})` : `range(${start}, ${stop}, ${step})`;
});
method(rangeClass, '__len__', 'none', 0, 0, (self) => rangeOf(self).length);
method(rangeClass, '__contains__', 'one', 1, 1, (self, [item]) => contains(self, item));
method(rangeClass, '__getitem__', 'one', 1, 1, (self, [key]) => getItem(self, key));
method(rangeClass, '__iter__', 'none', 0, 0, (self) => getIterator(self));
method(rangeClass, '__reversed__', 'none', 0, 0, (self) => {
  const { start, step, length } = rangeOf(self);
  return getIterator(new PyRange(rangeClass, start + (length - 1n) * step, start - step, -step));
});
method(rangeClass, '__hash__', 'none', 0, 0, (self) => {
  const { start, step, length } = rangeOf(self);
  return pyHash(newTuple([length, length === 0n ? None : start, length <= 1n ? None : step]));
});
method(rangeClass, 'count', 'one', 1, 1, (self, [item]) =>
  isExactInt(item) ? (contains(self, item) ? 1n : 0n) : BigInt(countEqual(iterate(self), item))
);
method(rangeClass, 'index', 'one', 1, 1, (self, [item]) => {
  const range = rangeOf(self);
  if (!isExactInt(item)) return indexByIteration(self, item);
  if (!contains(self, item)) throw valueError('range.index(x): x not in range');
  return (BigInt(item) - range.start) / range.step;
});
const isExactInt = (item: PyValue): item is bigint | boolean => typeof item === 'bigint' || typeof item === 'boolean';

function indexByIteration(range: PyValue, item: PyValue): bigint {
  const next = iterate(range);
  let index = 0n;
  for (let element = next(); element !== DONE; element = next(), index++) {
    currentRuntime().spend();
    if (equals(element, item)) return index;
  }
  throw valueError('sequence.index(x): x not in sequence');
}

// dict --------------------------------------------------------------------------------------------------------------

dictClass.construct = (cls, args, kwargs) => {
  const dict = new PyDict(cls, new DictStore());
  updateFromArguments('dict', dict, args, kwargs);
  return dict;
};
const dictOf = (self: PyValue): PyDict => self as PyDict;

/** Updates a dict from an optional mapping or iterable of pairs, then from keyword arguments, as `dict()` does. */
function updateFromArguments(qualified: string, dict: PyDict, args: PyValue[], kwargs: Kwargs): void {
  checkArgs({ qualified, min: 0, max: 1, style: 'expected', keywords: [...(kwargs?.keys() ?? [])] }, args, kwargs);
  if (args.length > 0) updateDict(dict, args[0]);
  for (const [key, value] of kwargs ?? []) dict.store.set(key, value);
}

export function updateDict(dict: PyDict, source: PyValue): void {
  const runtime = currentRuntime();
  if (source instanceof PyDict || lookupSpecial(source, 'keys') !== undefined) {
    for (const [key, value] of mappingEntries(source)) {
      runtime.spend();
      dict.store.set(key, value);
    }
    return;
  }
  const next = iterate(source);
  let index = 0;
  for (let item = next(); item !== DONE; item = next(), index++) {
    runtime.spend();
    const pair = toArray(item, 'object is not iterable');
    if (pair.length !== 2) {
      throw valueError(`dictionary update sequence element #${index} has length ${pair.length}; 2 is required`);
    }
    dict.store.set(pair[0], pair[1]);
  }
}

method(dictClass, '__repr__', 'none', 0, 0, (self) =>
  containerRepr(self as PyObject, '{...}', () => dictBody(dictOf(self)))
);

export function dictBody(dict: PyDict): string {
  let result = '{';
  for (const [index, entry] of dict.store.ordered().entries()) {
    if (index > 0) result += ', ';
    result += `${pyRepr(entry.key)}: ${pyRepr(entry.value)}`;
    currentRuntime().buildString(result.length);
  }
  return `${result}}`;
}

method(dictClass, '__len__', 'none', 0, 0, (self) => BigInt(dictOf(self).store.size));
method(dictClass, '__contains__', 'one', 1, 1, (self, [key]) => dictOf(self).store.has(key));
method(dictClass, '__getitem__', 'one', 1, 1, (self, [key]) => getItem(self, key));
method(dictClass, '__setitem__', 'expected', 2, 2, (self, [key, value]) => {
  dictOf(self).store.set(key, value);
  return None;
});
method(dictClass, '__delitem__', 'one', 1, 1, (self, [key]) => {
  if (!dictOf(self).store.delete(key)) throw keyError(key);
  return None;
});
method(dictClass, '__iter__', 'none', 0, 0, (self) => getIterator(new PyDictView(dictKeysClass, dictOf(self), 'keys')));
method(dictClass, '__reversed__', 'none', 0, 0, (self) =>
  listIterator(
    dictOf(self)
      .store.ordered()
      .toReversed()
      .map((entry) => entry.key),
    'dict_reversekeyiterator'
  )
);
method(dictClass, 'keys', 'none', 0, 0, (self) => new PyDictView(dictKeysClass, dictOf(self), 'keys'));
method(dictClass, 'values', 'none', 0, 0, (self) => new PyDictView(dictValuesClass, dictOf(self), 'values'));
method(dictClass, 'items', 'none', 0, 0, (self) => new PyDictView(dictItemsClass, dictOf(self), 'items'));
method(dictClass, 'get', 'expected', 1, 2, (self, [key, fallback]) => dictOf(self).store.get(key) ?? fallback ?? None);
method(dictClass, 'pop', 'expected', 1, 2, (self, [key, fallback]) => {
  // CPython does not hash the key when the dict is empty.
  const entry = dictOf(self).store.size === 0 ? undefined : dictOf(self).store.delete(key);
  if (entry) return entry.value;
  if (fallback !== undefined) return fallback;
  throw keyError(key);
});
method(dictClass, 'popitem', 'none', 0, 0, (self) => {
  const entry = dictOf(self).store.last();
  if (!entry) throw keyError('popitem(): dictionary is empty');
  dictOf(self).store.remove(entry);
  return newTuple([entry.key, entry.value]);
});
method(dictClass, 'setdefault', 'expected', 1, 2, (self, [key, fallback]) => {
  const existing = dictOf(self).store.get(key);
  if (existing !== undefined) return existing;
  dictOf(self).store.set(key, fallback ?? None);
  return fallback ?? None;
});
defineMethod(dictClass, 'update', (self, args, kwargs) => {
  updateFromArguments('dict.update', dictOf(self), args, kwargs);
  return None;
});
method(dictClass, 'clear', 'none', 0, 0, (self) => {
  dictOf(self).store.clear();
  return None;
});
method(dictClass, 'copy', 'none', 0, 0, (self) => {
  const copy = new PyDict(dictOf(self).cls, new DictStore(dictOf(self).store.plainWrites), dictOf(self).defaultFactory);
  for (const entry of dictOf(self).store.ordered()) copy.store.set(entry.key, entry.value);
  return copy;
});
method(
  dictClass,
  'fromkeys',
  'expected',
  1,
  2,
  (cls, [iterable, value]) => {
    const dict = callValue(cls, []) as PyDict;
    for (const key of toArray(iterable)) dict.store.set(key, value ?? None);
    return dict;
  },
  { binding: 'class' }
);
dictClass.dict.set('__hash__', None);

function listIterator(items: PyValue[], name: string): PyIterator {
  let index = 0;
  const iterator = new PyIterator(
    iteratorClass(name),
    () => (index < items.length ? items[index++] : DONE),
    () => items
  );
  iterator.lengthHint = () => items.length - index;
  return iterator;
}

for (const [cls, view] of [
  [dictKeysClass, 'keys'],
  [dictValuesClass, 'values'],
  [dictItemsClass, 'items'],
] as const) {
  method(cls, '__repr__', 'none', 0, 0, (self) =>
    containerRepr(self as PyObject, '...', () => `${cls.name}([${joinReprs(toArray(self))}])`)
  );
  method(cls, '__len__', 'none', 0, 0, (self) => BigInt((self as PyDictView).dict.store.size));
  method(cls, '__iter__', 'none', 0, 0, (self) => getIterator(self));
  method(cls, '__contains__', 'one', 1, 1, (self, [item]) => contains(self, item));
  method(cls, '__reversed__', 'none', 0, 0, (self) =>
    listIterator(
      toArray(self).toReversed(),
      `dict_reverse${view === 'keys' ? 'key' : view === 'values' ? 'value' : 'item'}iterator`
    )
  );
  if (view !== 'values') {
    method(cls, 'isdisjoint', 'one', 1, 1, (self, [other]) => !someItem(other, (item) => contains(self, item)));
  }
}

// set and frozenset -------------------------------------------------------------------------------------------------

for (const cls of [setClass, frozensetClass]) {
  cls.construct = (setType, args, kwargs) => {
    checkArgs({ qualified: cls.name, min: 0, max: 1, style: 'expected' }, args, kwargs);
    if (isExactFrozenset(args[0]) && setType === frozensetClass) return args[0];
    const table = new SetTable();
    if (args.length > 0) updateTable(table, args[0]);
    currentRuntime().allocate(1);
    return new PySet(setType, table);
  };
}

const setOf = (self: PyValue): PySet => self as PySet;

/** An exact frozenset, which CPython returns itself for where it would copy a set: `frozenset(f)` and `f.copy()`. */
function isExactFrozenset(value: PyValue | undefined): value is PySet {
  return value instanceof PySet && value.cls === frozensetClass;
}

function setRepr(self: PyValue): string {
  const set = setOf(self);
  const isFrozen = set.cls.isSubclassOf(frozensetClass);
  const name = set.cls.name;
  if (set.table.size === 0) return `${name}()`;
  return containerRepr(set, `${name}(...)`, () => {
    const body = `{${joinReprs(set.table.keys())}}`;
    return isFrozen || set.cls !== setClass ? `${name}(${body})` : body;
  });
}

function otherSet(value: PyValue, operator: string, self: PyValue): PySet {
  if (value instanceof PySet) return value;
  throw typeError(`unsupported operand type(s) for ${operator}: '${typeName(self)}' and '${typeName(value)}'`);
}

for (const cls of [setClass, frozensetClass]) {
  method(cls, '__repr__', 'none', 0, 0, setRepr);
  method(cls, '__len__', 'none', 0, 0, (self) => BigInt(setOf(self).table.size));
  method(cls, '__contains__', 'one', 1, 1, (self, [item]) => setOf(self).table.has(item));
  method(cls, '__iter__', 'none', 0, 0, (self) => getIterator(self));
  method(cls, 'copy', 'none', 0, 0, (self) => (isExactFrozenset(self) ? self : setUnion(setOf(self), [])));
  method(cls, 'union', 'expected', 0, Number.POSITIVE_INFINITY, (self, others) => setUnion(setOf(self), others));
  method(cls, 'intersection', 'expected', 0, Number.POSITIVE_INFINITY, (self, others) =>
    setIntersectionAll(setOf(self), others)
  );
  method(cls, 'difference', 'expected', 0, Number.POSITIVE_INFINITY, (self, others) =>
    setDifferenceAll(setOf(self), others)
  );
  method(cls, 'symmetric_difference', 'one', 1, 1, (self, [other]) => setSymmetricDifference(setOf(self), other));
  method(cls, 'isdisjoint', 'one', 1, 1, (self, [other]) => !someItem(other, (item) => setOf(self).table.has(item)));
  method(cls, 'issubset', 'one', 1, 1, (self, [other]) => {
    // CPython compares the size of the intersection unless the other operand is a set.
    if (!(other instanceof PySet)) return setIntersection(setOf(self), other).table.size === setOf(self).table.size;
    return setOf(self)
      .table.keys()
      .every((key) => other.table.has(key));
  });
  method(cls, 'issuperset', 'one', 1, 1, (self, [other]) => !someItem(other, (item) => !setOf(self).table.has(item)));
  void otherSet;
}

/** Whether an iterable has an item passing the test, reading no further than the first one as CPython does. */
function someItem(iterable: PyValue, test: (item: PyValue) => boolean): boolean {
  const runtime = currentRuntime();
  const next = iterate(iterable);
  for (let item = next(); item !== DONE; item = next()) {
    runtime.spend();
    if (test(item)) return true;
  }
  return false;
}

method(frozensetClass, '__hash__', 'none', 0, 0, (self) => pyHash(self));
NATIVE_HASHES.add(frozensetClass.dict.get('__hash__') as PyValue);
setClass.dict.set('__hash__', None);
method(setClass, 'add', 'one', 1, 1, (self, [item]) => {
  addToTable(setOf(self).table, item);
  return None;
});
method(setClass, 'remove', 'one', 1, 1, (self, [item]) => {
  if (!setOf(self).table.discard(item)) throw keyError(item);
  return None;
});
method(setClass, 'discard', 'one', 1, 1, (self, [item]) => {
  setOf(self).table.discard(item);
  return None;
});
method(setClass, 'pop', 'none', 0, 0, (self) => {
  const entry = setOf(self).table.pop();
  if (!entry) throw keyError('pop from an empty set');
  return entry.key;
});
method(setClass, 'clear', 'none', 0, 0, (self) => {
  setOf(self).table.clear();
  return None;
});
method(setClass, 'update', 'expected', 0, Number.POSITIVE_INFINITY, (self, others) => {
  for (const other of others) updateTable(setOf(self).table, other);
  return None;
});
method(setClass, 'intersection_update', 'expected', 0, Number.POSITIVE_INFINITY, (self, others) => {
  setOf(self).table.adopt(setIntersectionAll(setOf(self), others).table);
  return None;
});
method(setClass, 'difference_update', 'expected', 0, Number.POSITIVE_INFINITY, (self, others) => {
  for (const other of others) differenceUpdate(setOf(self).table, other);
  return None;
});
method(setClass, 'symmetric_difference_update', 'one', 1, 1, (self, [other]) => {
  symmetricDifferenceUpdate(setOf(self).table, other);
  return None;
});

export { argument };
