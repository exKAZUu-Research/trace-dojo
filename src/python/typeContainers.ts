// code-gauge-allow-file fileNcss 401 -- The methods of the builtin containers share their helpers here.
import { pyRepr } from './conversions';
import { method } from './define';
import { DictStore } from './dictStore';
import { mappingEntries } from './expressionEvaluator';
import { pyHash } from './hashing';
import { builtinGetItem, keyError, sliceIndices } from './items';
import { argument, checkArgs } from './nativeArgs';
import { toIndex } from './numbers';
import {
  builtinIterator,
  callValue,
  getItem,
  getIterator,
  isTruthy,
  iterate,
  lookupSpecial,
  toArray,
  withRemaining,
} from './objects';
import { builtinContains, contains, equals, lessThan } from './operators';
import { currentRuntime } from './runtimeContext';
import {
  differenceUpdate,
  setDifference,
  setIntersection,
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
  resultClassOf,
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
method(listClass, '__contains__', 'one', 1, 1, (self, [item]) => builtinContains(self, item));
method(listClass, '__getitem__', 'one', 1, 1, (self, [key]) => builtinGetItem(self, key));
method(listClass, '__iter__', 'none', 0, 0, (self) => builtinIterator(self));
method(listClass, '__reversed__', 'none', 0, 0, (self) => reversedIterator(listOf(self), 'list_reverseiterator'));
method(listClass, 'append', 'one', 1, 1, (self, [item]) => {
  currentRuntime().allocate(1);
  listOf(self).items.push(item);
  return None;
});
method(listClass, 'extend', 'one', 1, 1, (self, [iterable]) => {
  const items = toArray(iterable);
  currentRuntime().allocate(items.length);
  for (const item of items) listOf(self).items.push(item);
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
  (self, args, kwargs) => {
    if (args.length > 0) throw typeError('sort() takes no positional arguments');
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
  const next = withRemaining(
    () => {
      if (index >= sequence.items.length) index = -1;
      return index >= 0 ? sequence.items[index--] : DONE;
    },
    () => (index >= 0 && index < sequence.items.length ? index + 1 : 0)
  );
  return new PyIterator(iteratorClass(name), next, () => [sequence]);
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
method(rangeClass, 'count', 'one', 1, 1, (self, [item]) => (contains(self, item) ? 1n : 0n));
method(rangeClass, 'index', 'one', 1, 1, (self, [item]) => {
  const range = rangeOf(self);
  if (!contains(self, item) || (typeof item !== 'bigint' && typeof item !== 'boolean')) {
    throw valueError(`${pyRepr(item)} is not in range`);
  }
  return (BigInt(item) - range.start) / range.step;
});

// dict --------------------------------------------------------------------------------------------------------------

dictClass.construct = (cls, args, kwargs) => {
  const dict = new PyDict(cls, new DictStore());
  updateFromArguments('dict', dict, args, kwargs);
  return dict;
};
const dictOf = (self: PyValue): PyDict => self as PyDict;

/** Adds the entries of a mapping, or of an iterable of pairs, as `dict.update` does. */
/** Updates a dict from an optional mapping or iterable of pairs, then from keyword arguments, as `dict()` does. */
function updateFromArguments(qualified: string, dict: PyDict, args: PyValue[], kwargs: Kwargs): void {
  checkArgs({ qualified, min: 0, max: 1, style: 'expected', keywords: [...(kwargs?.keys() ?? [])] }, args, kwargs);
  if (args.length > 0) updateDict(dict, args[0]);
  for (const [key, value] of kwargs ?? []) dict.store.set(key, value);
}

export function updateDict(dict: PyDict, source: PyValue): void {
  if (source instanceof PyDict || lookupSpecial(source, 'keys') !== undefined) {
    for (const [key, value] of mappingEntries(source)) dict.store.set(key, value);
    return;
  }
  const next = iterate(source);
  let index = 0;
  for (let item = next(); item !== DONE; item = next(), index++) {
    let pair: PyValue[];
    try {
      pair = toArray(item);
    } catch {
      throw typeError(`cannot convert dictionary update sequence element #${index} to a sequence`);
    }
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
method(dictClass, '__getitem__', 'one', 1, 1, (self, [key]) => builtinGetItem(self, key));
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
  const copy = new PyDict(resultClassOf(dictOf(self).cls), new DictStore(), dictOf(self).defaultFactory);
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
// The views of keys and items compare like sets, so they are unhashable as CPython's are.
dictKeysClass.dict.set('__hash__', None);
dictItemsClass.dict.set('__hash__', None);

function listIterator(items: PyValue[], name: string): PyIterator {
  let index = 0;
  return new PyIterator(
    iteratorClass(name),
    () => (index < items.length ? items[index++] : DONE),
    () => items
  );
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
    method(cls, 'isdisjoint', 'one', 1, 1, (self, [other]) => toArray(other).every((item) => !contains(self, item)));
  }
}

// set and frozenset -------------------------------------------------------------------------------------------------

for (const cls of [setClass, frozensetClass]) {
  cls.construct = (setType, args, kwargs) => {
    checkArgs({ qualified: cls.name, min: 0, max: 1, style: 'expected' }, args, kwargs);
    const table = new SetTable();
    if (args.length > 0) updateTable(table, args[0]);
    currentRuntime().allocate(table.size + 1);
    return new PySet(setType, table);
  };
}

const setOf = (self: PyValue): PySet => self as PySet;

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
  method(cls, '__iter__', 'none', 0, 0, (self) => builtinIterator(self));
  method(cls, 'copy', 'none', 0, 0, (self) => new PySet(resultClassOf(setOf(self).cls), setOf(self).table.copy()));
  method(cls, 'union', 'expected', 0, Number.POSITIVE_INFINITY, (self, others) => setUnion(setOf(self), others));
  method(cls, 'intersection', 'expected', 0, Number.POSITIVE_INFINITY, (self, others) =>
    foldSets(setOf(self), others, setIntersection)
  );
  method(cls, 'difference', 'expected', 0, Number.POSITIVE_INFINITY, (self, others) =>
    foldSets(setOf(self), others, setDifference)
  );
  method(cls, 'symmetric_difference', 'one', 1, 1, (self, [other]) => {
    const table = (other instanceof PySet ? other.table : tableFrom(other)).copy();
    symmetricDifferenceUpdate(table, self);
    return new PySet(resultClassOf(setOf(self).cls), table);
  });
  method(cls, 'isdisjoint', 'one', 1, 1, (self, [other]) =>
    toArray(other).every((item) => !setOf(self).table.has(item))
  );
  method(cls, 'issubset', 'one', 1, 1, (self, [other]) => {
    // CPython compares the size of the intersection unless the other operand is a set.
    if (!(other instanceof PySet)) return setIntersection(setOf(self), other).table.size === setOf(self).table.size;
    return setOf(self)
      .table.keys()
      .every((key) => other.table.has(key));
  });
  method(cls, 'issuperset', 'one', 1, 1, (self, [other]) =>
    toArray(other).every((item) => setOf(self).table.has(item))
  );
  void otherSet;
}

/** Applies a set operation with each of `others` in turn, starting from a copy of `set`. */
function foldSets(set: PySet, others: PyValue[], operation: (set: PySet, other: PyValue) => PySet): PySet {
  let result = new PySet(resultClassOf(set.cls), set.table.copy());
  for (const other of others) result = operation(result, other);
  return result;
}

function tableFrom(value: PyValue): SetTable {
  const table = new SetTable();
  updateTable(table, value);
  return table;
}

method(frozensetClass, '__hash__', 'none', 0, 0, (self) => pyHash(self));
setClass.dict.set('__hash__', None);
method(setClass, 'add', 'one', 1, 1, (self, [item]) => {
  setOf(self).table.add(item);
  currentRuntime().allocate(1);
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
  const set = setOf(self);
  set.table = foldSets(set, others, setIntersection).table;
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
