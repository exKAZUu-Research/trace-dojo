import { mappingEntries } from '../callArguments';
// code-gauge-allow-file fileNcss 501 -- The methods and attributes of the builtin types it defines belong together.
import { pyRepr } from '../conversions';
import { method, pythonMethod, redeclareMethods } from '../define';
import { defineGetSet } from '../descriptors';
import { DictStore } from '../dictStore';
import { pyHash } from '../hashing';
import { keyError } from '../items';
import { libraryReceiver } from '../libraryReceivers';
import { runLibrarySource } from '../librarySource';
import { registerLazyAttributes, registerModule } from '../modules';
import { argument, bindPythonArgs, checkArgs, pythonSignature } from '../nativeArgs';
import { toIndex } from '../numbers';
import {
  callValue,
  getAttribute,
  getItem,
  getIterator,
  isCallable,
  isTruthy,
  iterate,
  lookupSpecial,
  toArray,
} from '../objects';
import { binaryOp, compareOp, contains, equals, lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { containerRepr, dictBody, joinReprs, sequenceIndex, updateDict } from '../typeContainers';
import { newGenericAlias } from '../typeHints';
import {
  builtinClass,
  classOf,
  defineMethod,
  dictClass,
  dictItemsClass,
  dictKeysClass,
  dictValuesClass,
  iteratorClass,
  newDict,
  newList,
  newTuple,
  None,
  NotImplemented,
  propertyClass,
  pyError,
  typeClass,
  typeError,
  typeName,
  valueError,
} from '../types';
import {
  DONE,
  type Kwargs,
  PyBuiltinFunction,
  PyClass,
  PyDeque,
  PyDescriptor,
  PyDict,
  PyDictView,
  PyIterator,
  PyObject,
  type PyValue,
} from '../values';
import { COLLECTIONS_SOURCE } from './collectionsSource';
import { comparedReceiver, counterReceiver, inPlaceReceiver, superError } from './counterReceivers';
import { makeNamedTupleClass, namedtupleFunction } from './namedtuple';
import { updateOrderedDict } from './orderedDictUpdate';

// deque -------------------------------------------------------------------------------------------------------------

export const dequeClass = builtinClass('deque');
dequeClass.tpName = 'collections.deque';
dequeClass.module = 'collections';
dequeClass.construct = (cls, args, kwargs) => {
  checkArgs(
    { qualified: 'deque', min: 0, max: 2, style: 'takes', keywords: ['iterable', 'maxlen'], named: 2 },
    args,
    kwargs
  );
  const iterable = argument(args, kwargs, 0, 'iterable');
  const maxlenValue = argument(args, kwargs, 1, 'maxlen') ?? None;
  let maxlen: number | undefined;
  if (maxlenValue !== None) {
    maxlen = Number(toIndex(maxlenValue));
    if (maxlen < 0) throw valueError('maxlen must be non-negative');
  }
  const deque = new PyDeque(cls, [], maxlen);
  if (iterable !== undefined) for (const item of toArray(iterable)) push(deque, item, false);
  return deque;
};
const dequeOf = (self: PyValue): PyDeque => self as PyDeque;

function push(deque: PyDeque, item: PyValue, left: boolean): void {
  if (deque.maxlen === 0) {
    // Nothing is stored to charge, and an endless iterable must still end.
    currentRuntime().spend();
    return;
  }
  if (left) deque.appendLeft(item);
  else deque.append(item);
  if (deque.maxlen !== undefined && deque.length > deque.maxlen) {
    if (left) deque.popRight();
    else deque.popLeft();
  }
}

function dequeIndex(deque: PyDeque, key: PyValue): number {
  const index = toIndex(key, (value) => `sequence index must be integer, not '${typeName(value)}'`);
  const resolved = index < 0n ? index + BigInt(deque.length) : index;
  if (resolved < 0n || resolved >= BigInt(deque.length)) throw pyError('IndexError', 'deque index out of range');
  return Number(resolved);
}

method(dequeClass, 'append', 'one', 1, 1, (self, [item]) => {
  push(dequeOf(self), item, false);
  return None;
});
method(dequeClass, 'appendleft', 'one', 1, 1, (self, [item]) => {
  push(dequeOf(self), item, true);
  return None;
});
method(dequeClass, 'extend', 'one', 1, 1, (self, [iterable]) => {
  extendDeque(dequeOf(self), iterable, false);
  return None;
});
method(dequeClass, 'extendleft', 'one', 1, 1, (self, [iterable]) => {
  extendDeque(dequeOf(self), iterable, true);
  return None;
});

/** Adds each item as the iterable yields it; a deque extended with itself reads its items first, as CPython does. */
function extendDeque(deque: PyDeque, iterable: PyValue, left: boolean): void {
  if (iterable === deque) {
    // oxlint-disable-next-line unicorn/prefer-spread -- A copy, not an iteration, is the point.
    const items = deque.items.slice();
    for (const item of items) push(deque, item, left);
    return;
  }
  const next = iterate(iterable);
  for (let item = next(); item !== DONE; item = next()) push(deque, item, left);
}
method(dequeClass, 'pop', 'none', 0, 0, (self) => {
  if (dequeOf(self).length === 0) throw pyError('IndexError', 'pop from an empty deque');
  return dequeOf(self).popRight();
});
method(dequeClass, 'popleft', 'none', 0, 0, (self) => {
  if (dequeOf(self).length === 0) throw pyError('IndexError', 'pop from an empty deque');
  return dequeOf(self).popLeft();
});
const MAX_SSIZE = (1n << 63n) - 1n;
method(dequeClass, 'rotate', 'expected', 0, 1, (self, [steps]) => {
  const deque = dequeOf(self);
  const count = toIndex(steps ?? 1n);
  if (count > MAX_SSIZE || count < -MAX_SSIZE - 1n) {
    throw pyError('OverflowError', 'Python int too large to convert to C ssize_t');
  }
  if (deque.length > 0) deque.rotate(Number(count % BigInt(deque.length)));
  return None;
});
method(dequeClass, 'clear', 'none', 0, 0, (self) => {
  dequeOf(self).editableItems.length = 0;
  return None;
});
method(dequeClass, 'count', 'one', 1, 1, (self, [item]) =>
  BigInt(dequeOf(self).items.filter((each) => equals(each, item)).length)
);
method(dequeClass, 'index', 'expected', 1, 3, (self, [item, start, stop]) => {
  const index = sequenceIndex(dequeOf(self).items, item, start, stop);
  if (index === -1) throw valueError('deque.index(x): x not in deque');
  return BigInt(index);
});
method(dequeClass, 'insert', 'expected', 2, 2, (self, [index, item]) => {
  const deque = dequeOf(self);
  if (deque.maxlen !== undefined && deque.items.length >= deque.maxlen)
    throw pyError('IndexError', 'deque already at its maximum size');
  let position = Number(toIndex(index));
  if (position < 0) position = Math.max(0, position + deque.items.length);
  deque.splice(Math.min(position, deque.items.length), 0, [item]);
  return None;
});
method(dequeClass, 'remove', 'one', 1, 1, (self, [item]) => {
  const items = dequeOf(self).items;
  const index = items.findIndex((each) => equals(each, item));
  currentRuntime().scan(index === -1 ? items.length : index + 1);
  if (index === -1) throw valueError('deque.remove(x): x not in deque');
  dequeOf(self).removeRange(index, 1);
  return None;
});
method(dequeClass, 'reverse', 'none', 0, 0, (self) => {
  const items = dequeOf(self).editableItems;
  currentRuntime().scan(items.length);
  items.reverse();
  return None;
});
method(
  dequeClass,
  'copy',
  'none',
  0,
  0,
  (self) => new PyDeque(dequeOf(self).cls, [...dequeOf(self).items], dequeOf(self).maxlen)
);
method(dequeClass, '__len__', 'none', 0, 0, (self) => BigInt(dequeOf(self).length));
method(dequeClass, '__add__', 'one', 1, 1, (self, [other]) => {
  if (!(other instanceof PyDeque)) throw typeError(`can only concatenate deque (not "${typeName(other)}") to deque`);
  const result = copyDeque(dequeOf(self));
  // The items are copied first, as `d + d` must not see its own appends.
  // oxlint-disable-next-line unicorn/prefer-spread -- A copy, not an iteration, is the point.
  const items = other.items.slice();
  for (const item of items) push(result, item, false);
  return result;
});
method(dequeClass, '__iadd__', 'one', 1, 1, (self, [other]) => {
  extendDeque(dequeOf(self), other, false);
  return self;
});
for (const name of ['__mul__', '__rmul__']) {
  method(dequeClass, name, 'one', 1, 1, (self, [count]) => {
    if (!isIndex(count)) return NotImplemented;
    const result = copyDeque(dequeOf(self));
    repeatDeque(result, count);
    return result;
  });
}
method(dequeClass, '__imul__', 'one', 1, 1, (self, [count]) => {
  if (!isIndex(count)) return NotImplemented;
  repeatDeque(dequeOf(self), count);
  return self;
});

function isIndex(value: PyValue): boolean {
  return typeof value === 'bigint' || typeof value === 'boolean' || lookupSpecial(value, '__index__') !== undefined;
}
method(dequeClass, '__copy__', 'none', 0, 0, (self) => copyDeque(dequeOf(self)));
method(dequeClass, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), {
  binding: 'class',
});
dequeClass.dict.set('__module__', 'collections');

function copyDeque(deque: PyDeque): PyDeque {
  return new PyDeque(deque.cls, [...deque.items], deque.maxlen);
}

/** Repeats a deque in place, computing what a bounded one keeps instead of appending every round. */
function repeatDeque(deque: PyDeque, countValue: PyValue): void {
  const count = toIndex(countValue);
  if (count >= 1n << 63n || count < -(1n << 63n)) {
    throw pyError('OverflowError', "cannot fit 'int' into an index-sized integer");
  }
  const { items } = deque;
  const size = BigInt(items.length);
  if (count <= 0n || size === 0n) {
    deque.editableItems.length = 0;
    return;
  }
  const total = size * count;
  const kept = deque.maxlen !== undefined && BigInt(deque.maxlen) < total ? BigInt(deque.maxlen) : total;
  currentRuntime().ensureRoom(Number(kept - size));
  const skipped = total - kept;
  const repeated: PyValue[] = [];
  for (let index = 0n; index < kept; index++) repeated.push(items[Number((skipped + index) % size)]);
  deque.splice(0, items.length, repeated);
}
method(dequeClass, '__getitem__', 'one', 1, 1, (self, [key]) => dequeOf(self).at(dequeIndex(dequeOf(self), key)));
method(dequeClass, '__setitem__', 'expected', 2, 2, (self, [key, value]) => {
  dequeOf(self).editableItems[dequeIndex(dequeOf(self), key)] = value;
  return None;
});
method(dequeClass, '__delitem__', 'one', 1, 1, (self, [key]) => {
  dequeOf(self).removeRange(dequeIndex(dequeOf(self), key), 1);
  return None;
});
method(dequeClass, '__contains__', 'one', 1, 1, (self, [item]) =>
  dequeOf(self).items.some((each) => equals(each, item))
);
method(dequeClass, '__iter__', 'none', 0, 0, (self) => {
  const deque = dequeOf(self);
  let index = 0;
  const length = deque.length;
  return new PyIterator(
    iteratorClass('_collections._deque_iterator'),
    () => {
      if (deque.length !== length) throw pyError('RuntimeError', 'deque mutated during iteration');
      return index < deque.length ? deque.at(index++) : DONE;
    },
    () => [deque]
  );
});
method(dequeClass, '__reversed__', 'none', 0, 0, (self) => {
  const deque = dequeOf(self);
  const length = deque.length;
  let remaining = length;
  return new PyIterator(
    iteratorClass('_collections._deque_reverse_iterator'),
    () => {
      if (remaining === 0) return DONE;
      if (deque.length !== length) {
        remaining = 0;
        throw pyError('RuntimeError', 'deque mutated during iteration');
      }
      return deque.at(--remaining);
    },
    () => [deque]
  );
});
method(dequeClass, '__repr__', 'none', 0, 0, (self) => {
  const deque = dequeOf(self);
  return containerRepr(deque, '[...]', () => {
    const body = `[${joinReprs(deque.items)}]`;
    return deque.maxlen === undefined ? `deque(${body})` : `deque(${body}, maxlen=${deque.maxlen})`;
  });
});
for (const [name, operator] of [
  ['__eq__', '=='],
  ['__ne__', '!='],
  ['__lt__', '<'],
  ['__le__', '<='],
  ['__gt__', '>'],
  ['__ge__', '>='],
] as const) {
  method(dequeClass, name, 'one', 1, 1, (self, [other]) =>
    other instanceof PyDeque ? compareDeques(operator, dequeOf(self).items, other.items) : NotImplemented
  );
}

/** Compares as CPython's deque_richcompare does: by the first pair of unequal items, then by length. */
function compareDeques(
  operator: '==' | '!=' | '<' | '<=' | '>' | '>=',
  a: readonly PyValue[],
  b: readonly PyValue[]
): boolean {
  if (a === b) return operator === '==' || operator === '<=' || operator === '>=';
  if (a.length !== b.length && (operator === '==' || operator === '!=')) return operator === '!=';
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    currentRuntime().spend();
    if (!equals(a[index], b[index])) return isTruthy(compareOp(operator, a[index], b[index]));
  }
  return isTruthy(compareOp(operator, BigInt(a.length), BigInt(b.length)));
}
dequeClass.dict.set(
  'maxlen',
  new PyDescriptor(
    propertyClass,
    new PyBuiltinFunction(builtinClass('getter'), 'maxlen', ([self]) => {
      const { maxlen } = dequeOf(self);
      return maxlen === undefined ? None : BigInt(maxlen);
    })
  )
);
dequeClass.dict.set('__hash__', None);

// Counter -----------------------------------------------------------------------------------------------------------

export const counterClass = new PyClass('Counter', [dictClass], typeClass);
counterClass.mro = [counterClass, ...dictClass.mro];
counterClass.module = 'collections';
counterClass.layout = { base: 'native' };
counterClass.isWrittenInPython = true;
const COUNTING_PARAMETERS = 'iterable=None, /, **kwds';
const COUNTER_INIT = pythonSignature('Counter.__init__', `self, ${COUNTING_PARAMETERS}`);

counterClass.construct = (cls, args, kwargs) => {
  const counter = new PyDict(cls, new DictStore());
  countInto(counter, bindPythonArgs(COUNTER_INIT, [counter, ...args], kwargs)[1], kwargs, 1n);
  return counter;
};

// code-gauge-allow functionCognitiveComplexity 19 -- Follows how Counter counts a mapping, an iterable, and keyword arguments.
function countInto(counter: PyDict, source: PyValue | undefined, kwargs: Kwargs, sign: bigint): void {
  const add = (key: PyValue, amount: PyValue, hash?: bigint): void => {
    const current = counter.store.lookup(key, hash)?.value ?? 0n;
    counter.store.set(key, binaryOp(sign === 1n ? '+' : '-', current, amount), hash);
  };
  if (source !== undefined && source !== None) {
    if (source instanceof PyDict || lookupSpecial(source, 'keys') !== undefined) {
      for (const [key, value] of mappingEntries(source)) add(key, value);
    } else {
      const next = iterate(source);
      for (let item = next(); item !== DONE; item = next()) {
        currentRuntime().spend();
        // CPython's _count_elements, which counts up, hashes the element itself, so its TypeError is not reworded.
        add(item, 1n, sign === 1n ? pyHash(item) : undefined);
      }
    }
  }
  for (const [key, value] of kwargs ?? []) add(key, value);
}

/**
 * The `limit` most common items of a Counter, ties in insertion order, chosen as most_common does: none without
 * reading the counter for a limit below one, the maximum for one, else a sort; each visit and comparison is charged.
 */
function mostCommon(counter: PyDict, limit?: number): [PyValue, PyValue][] {
  if (limit !== undefined && limit <= 0) return [];
  const runtime = currentRuntime();
  const entries = counter.store.ordered();
  runtime.allocate(entries.length);
  const items = entries.map((entry): [PyValue, PyValue] => [entry.key, entry.value]);
  if (limit === 1) {
    let best = items[0];
    for (const item of items) {
      runtime.spend();
      // max() keeps the first of equal counts, taking a later one only when it compares greater.
      if (isTruthy(compareOp('>', item[1], best[1]))) best = item;
    }
    return best === undefined ? [] : [best];
  }
  const sorted = items
    .map((item, index) => ({ item, index }))
    .toSorted((a, b) => {
      runtime.spend();
      if (lessThan(b.item[1], a.item[1])) return -1;
      if (lessThan(a.item[1], b.item[1])) return 1;
      return a.index - b.index;
    })
    .map(({ item }) => item);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

pythonMethod(counterClass, 'most_common', 'n=None', (self, [count]) => {
  const limit = count === undefined || count === None ? undefined : Number(toIndex(count));
  const items = mostCommon(counterReceiver(self, 'most_common'), limit);
  return newList(items.map((item) => newTuple(item)));
});
pythonMethod(counterClass, 'elements', '', (self) => {
  const entries = counterReceiver(self, 'elements').store.ordered();
  currentRuntime().allocate(entries.length);
  let position = 0;
  let key: PyValue = None;
  let remaining = 0n;
  return new PyIterator(
    iteratorClass('itertools.chain'),
    () => {
      while (remaining <= 0n) {
        if (position === entries.length) return DONE;
        const entry = entries[position++];
        key = entry.key;
        // CPython repeats each element with itertools.repeat, which converts its count as an index.
        remaining = toIndex(entry.value);
      }
      remaining--;
      return key;
    },
    () => entries.map((entry) => entry.key)
  );
});
for (const [name, sign] of [
  ['update', 1n],
  ['subtract', -1n],
] as const) {
  pythonMethod(counterClass, name, COUNTING_PARAMETERS, (self, [iterable], kwargs) => {
    const isEmpty = (iterable === undefined || iterable === None) && !kwargs?.size;
    if (!isEmpty) countInto(counterReceiver(self, name, 'get'), iterable, kwargs, sign);
    return None;
  });
}
pythonMethod(counterClass, 'total', '', (self) => {
  let total: PyValue = 0n;
  for (const entry of counterReceiver(self, 'total', 'values').store.ordered()) {
    total = binaryOp('+', total, entry.value);
  }
  return total;
});
method(counterClass, '__repr__', 'none', 0, 0, (self) => {
  if (!isTruthy(self)) return `${classOf(self).name}()`;
  const counter = libraryReceiver(self, isCounter, 'most_common', 'Counter.__repr__');
  return containerRepr(counter, '...', () => {
    const ordered = newDict(mostCommon(counter));
    return `${counter.cls.name}(${dictBody(ordered)})`;
  });
});
// The arithmetic, comparisons, and in-place operators of Counter, as CPython's collections/__init__.py writes them.

/** `counter[key]`, which a plain dict given as the receiver answers with a KeyError for a missing key. */
const countOf = (counter: PyDict, key: PyValue): PyValue =>
  isCounter(counter) ? (counter.store.get(key) ?? 0n) : getItem(counter, key);
const isPositive = (value: PyValue): boolean => isTruthy(compareOp('>', value, 0n));
const isCounter = (value: PyValue): value is PyDict => value instanceof PyDict && value.cls.isSubclassOf(counterClass);

function newCounter(): PyDict {
  return new PyDict(counterClass, new DictStore());
}

function counterBinary(self: PyDict, other: PyDict, combine: (count: PyValue, otherCount: PyValue) => PyValue): PyDict {
  const result = newCounter();
  for (const { key, value } of self.store.ordered()) {
    const count = combine(value, countOf(other, key));
    if (isPositive(count)) result.store.set(key, count);
  }
  return result;
}

/** Adds the counts only `other` has, as `+`, `-`, and `|` do, `-` negating them. */
function addOtherCounts(result: PyDict, self: PyDict, other: PyDict, negate: boolean): PyDict {
  for (const { key, value } of other.store.ordered()) {
    if (self.store.has(key)) continue;
    if (negate ? isTruthy(compareOp('<', value, 0n)) : isPositive(value)) {
      result.store.set(key, negate ? binaryOp('-', 0n, value) : value);
    }
  }
  return result;
}

const pickLarger = (count: PyValue, otherCount: PyValue): PyValue =>
  isTruthy(compareOp('<', count, otherCount)) ? otherCount : count;
const pickSmaller = (count: PyValue, otherCount: PyValue): PyValue =>
  isTruthy(compareOp('<', count, otherCount)) ? count : otherCount;

for (const [name, run] of [
  [
    '__add__',
    (a: PyDict, b: PyDict) =>
      addOtherCounts(
        counterBinary(a, b, (x, y) => binaryOp('+', x, y)),
        a,
        b,
        false
      ),
  ],
  [
    '__sub__',
    (a: PyDict, b: PyDict) =>
      addOtherCounts(
        counterBinary(a, b, (x, y) => binaryOp('-', x, y)),
        a,
        b,
        true
      ),
  ],
  ['__or__', (a: PyDict, b: PyDict) => addOtherCounts(counterBinary(a, b, pickLarger), a, b, false)],
  ['__and__', (a: PyDict, b: PyDict) => counterBinary(a, b, pickSmaller)],
] as const) {
  method(counterClass, name, 'one', 1, 1, (self, [other]) =>
    isCounter(other) ? run(counterReceiver(self, name), other) : NotImplemented
  );
}

for (const [name, keep] of [
  ['__pos__', (count: PyValue) => (isPositive(count) ? count : undefined)],
  ['__neg__', (count: PyValue) => (isTruthy(compareOp('<', count, 0n)) ? binaryOp('-', 0n, count) : undefined)],
] as const) {
  method(counterClass, name, 'none', 0, 0, (self) => {
    const result = newCounter();
    for (const { key, value } of counterReceiver(self, name).store.ordered()) {
      const count = keep(value);
      if (count !== undefined) result.store.set(key, count);
    }
    return result;
  });
}

/** Ends an in-place operator, whose body calls `self._keep_positive()`, which a plain dict receiver lacks. */
function keepPositiveInPlace(counter: PyDict): PyDict {
  if (!isCounter(counter)) getAttribute(counter, '_keep_positive');
  return keepPositive(counter);
}

/** Removes the counts that are not positive, as Counter's `_keep_positive` does after an in-place operator. */
function keepPositive(counter: PyDict): PyDict {
  for (const entry of counter.store.ordered()) if (!isPositive(entry.value)) counter.store.remove(entry);
  return counter;
}

for (const [name, update] of [
  ['__iadd__', (count: PyValue, otherCount: PyValue) => binaryOp('+', count, otherCount)],
  ['__isub__', (count: PyValue, otherCount: PyValue) => binaryOp('-', count, otherCount)],
  ['__ior__', (count: PyValue, otherCount: PyValue) => (lessThan(count, otherCount) ? otherCount : undefined)],
] as const) {
  method(counterClass, name, 'one', 1, 1, (self, [other]) => {
    const items = itemsOf(other);
    const counter = inPlaceReceiver(self, items[0]?.[0], name);
    for (const [key, otherCount] of items) {
      const count = update(countOf(counter, key), otherCount);
      if (count !== undefined) counter.store.set(key, count);
    }
    return keepPositiveInPlace(counter);
  });
}
method(counterClass, '__iand__', 'one', 1, 1, (self, [other]) => {
  const counter = counterReceiver(self, '__iand__');
  for (const entry of counter.store.ordered()) {
    const otherCount = getItem(other, entry.key);
    if (lessThan(otherCount, entry.value)) entry.value = otherCount;
  }
  return keepPositiveInPlace(counter);
});

/** The pairs of `other.items()`: the in-place operators of Counter take any object that has the method. */
function itemsOf(other: PyValue): [PyValue, PyValue][] {
  if (other instanceof PyDict && other.cls.lookup('items') === dictClass.dict.get('items')) {
    return other.store.ordered().map((entry) => [entry.key, entry.value]);
  }
  return toArray(callValue(getAttribute(other, 'items'), [])).map((item) => {
    const [key, value] = toArray(item);
    return [key, value];
  });
}

/** Whether a comparison holds for the count of every element either Counter has. */
function everyCount(self: PyDict, other: PyDict, operator: '==' | '<=' | '>='): boolean {
  for (const counter of [self, other]) {
    for (const { key } of counter.store.ordered()) {
      if (!isTruthy(compareOp(operator, countOf(self, key), countOf(other, key)))) return false;
    }
  }
  return true;
}

for (const [name, compare] of [
  ['__eq__', (a: PyDict, b: PyDict) => everyCount(a, b, '==')],
  ['__ne__', (a: PyDict, b: PyDict) => !everyCount(a, b, '==')],
  ['__le__', (a: PyDict, b: PyDict) => everyCount(a, b, '<=')],
  ['__lt__', (a: PyDict, b: PyDict) => everyCount(a, b, '<=') && !everyCount(a, b, '==')],
  ['__ge__', (a: PyDict, b: PyDict) => everyCount(a, b, '>=')],
  ['__gt__', (a: PyDict, b: PyDict) => everyCount(a, b, '>=') && !everyCount(a, b, '==')],
] as const) {
  method(counterClass, name, 'one', 1, 1, (self, [other]) =>
    isCounter(other) ? compare(comparedReceiver(self, name), other) : NotImplemented
  );
}
pythonMethod(counterClass, '__missing__', 'key', () => 0n);
pythonMethod(counterClass, '_keep_positive', '', (self) => keepPositive(counterReceiver(self, '_keep_positive')));
// Counter is a class written in Python in CPython, whose dictionary has what a class statement gives it.
counterClass.dict.set('__module__', 'collections');
counterClass.dict.set('__firstlineno__', 551n);
counterClass.dict.set('__static_attributes__', newTuple([]));
defineGetSet(counterClass, '__dict__', () => newDict());
defineGetSet(counterClass, '__weakref__', () => None);
method(counterClass, '__delitem__', 'one', 1, 1, (self, [key]) => {
  if (!contains(self, key)) return None;
  if (!isCounter(self)) throw superError(self);
  self.store.delete(key);
  return None;
});
pythonMethod(counterClass, 'copy', '', (self) => callValue(classOf(self), [self]));
pythonMethod(
  counterClass,
  'fromkeys',
  'iterable, v=None',
  () => {
    throw pyError('NotImplementedError', 'Counter.fromkeys() is undefined.  Use Counter(iterable) instead.');
  },
  'class'
);

// defaultdict -------------------------------------------------------------------------------------------------------

export const defaultdictClass = new PyClass('defaultdict', [dictClass], typeClass);
defaultdictClass.tpName = 'collections.defaultdict';
defaultdictClass.mro = [defaultdictClass, ...dictClass.mro];
defaultdictClass.module = 'collections';
defaultdictClass.layout = { base: 'native' };
defaultdictClass.construct = (cls, args, kwargs) => {
  const factory = args[0] ?? None;
  if (factory !== None && !isCallable(factory)) throw typeError('first argument must be callable or None');
  const dict = new PyDict(cls, new DictStore(), factory);
  if (args.length > 1) updateDict(dict, args[1]);
  if (args.length > 2) throw typeError(`defaultdict expected at most 2 arguments, got ${args.length}`);
  for (const [key, value] of kwargs ?? []) dict.store.set(key, value);
  return dict;
};
method(defaultdictClass, '__repr__', 'none', 0, 0, (self) => {
  const dict = self as PyDict;
  return containerRepr(dict, '...', () => `defaultdict(${pyRepr(dict.defaultFactory ?? None)}, ${dictBody(dict)})`);
});
method(defaultdictClass, '__missing__', 'one', 1, 1, (self, [key]) => currentRuntime().missingKey(self as PyDict, key));
redeclareMethods(defaultdictClass, dictClass, ['copy']);
method(defaultdictClass, '__copy__', 'none', 0, 0, (self) => callValue(getAttribute(self, 'copy'), []));
defaultdictClass.dict.set('__module__', 'collections');
defineGetSet(defaultdictClass, 'default_factory', (self) => (self as PyDict).defaultFactory ?? None, {
  member: true,
  set: (self, value) => {
    (self as PyDict).defaultFactory = value === None ? undefined : value;
  },
  delete: (self) => {
    (self as PyDict).defaultFactory = undefined;
  },
});

// OrderedDict -------------------------------------------------------------------------------------------------------

export const orderedDictClass = new PyClass('OrderedDict', [dictClass], typeClass);
orderedDictClass.tpName = 'collections.OrderedDict';
defineGetSet(orderedDictClass, '__dict__', () => newDict());
orderedDictClass.mro = [orderedDictClass, ...dictClass.mro];
orderedDictClass.module = 'collections';
orderedDictClass.layout = { base: 'native' };
orderedDictClass.construct = (cls, args, kwargs) => {
  if (args.length > 1) throw typeError(`expected at most 1 argument, got ${args.length}`);
  const dict = new PyDict(cls, new DictStore(true));
  updateOrderedDict(dict, args, kwargs);
  return dict;
};
orderedDictClass.flags.isOrderedDict = true;
redeclareMethods(orderedDictClass, dictClass, ['clear', 'copy', 'pop', 'setdefault', '__reversed__']);
for (const [name, base] of [
  ['keys', dictKeysClass],
  ['values', dictValuesClass],
  ['items', dictItemsClass],
] as const) {
  // CPython's OrderedDict views are their own subclasses of the dict views, which name them in their reprs.
  const viewClass = builtinClass(`odict_${name}`, base);
  method(orderedDictClass, name, 'none', 0, 0, (self) => new PyDictView(viewClass, self as PyDict, name));
}
defineMethod(orderedDictClass, 'update', (self, args, kwargs) => {
  updateOrderedDict(self, args, kwargs);
  return None;
});
method(orderedDictClass, '__repr__', 'none', 0, 0, (self) => {
  const dict = self as PyDict;
  if (dict.store.size === 0) return 'OrderedDict()';
  return containerRepr(dict, '...', () => `OrderedDict(${dictBody(dict)})`);
});
method(
  orderedDictClass,
  'move_to_end',
  'takes',
  1,
  2,
  (self, args, kwargs) => {
    const dict = self as PyDict;
    const key = argument(args, kwargs, 0, 'key') as PyValue;
    const entry = dict.store.lookup(key, pyHash(key));
    if (!entry) throw keyError(key);
    dict.store.moveToEnd(entry, isTruthy(argument(args, kwargs, 1, 'last') ?? true));
    return None;
  },
  { keywords: ['key', 'last'], named: 2 }
);
method(
  orderedDictClass,
  'popitem',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    const dict = self as PyDict;
    const last = isTruthy(argument(args, kwargs, 0, 'last') ?? true);
    const entry = last ? dict.store.last() : dict.store.first();
    if (!entry) throw keyError('dictionary is empty');
    dict.store.remove(entry);
    return newTuple([entry.key, entry.value]);
  },
  { keywords: ['last'], named: 1 }
);
method(orderedDictClass, '__eq__', 'one', 1, 1, (self, [other]) => orderedDictEquals(self as PyDict, other));
// odict_richcompare answers `!=` as the negation of its order-sensitive `==`, where dict's would ignore the order.
method(orderedDictClass, '__ne__', 'one', 1, 1, (self, [other]) => {
  const equal = orderedDictEquals(self as PyDict, other);
  return equal === NotImplemented ? equal : !equal;
});

function orderedDictEquals(self: PyDict, other: PyValue): PyValue {
  if (!(other instanceof PyDict)) return NotImplemented;
  const a = self.store.ordered();
  const b = other.store.ordered();
  if (a.length !== b.length) return false;
  if (other.cls.isSubclassOf(orderedDictClass)) {
    return a.every((entry, index) => equals(entry.key, b[index].key) && equals(entry.value, b[index].value));
  }
  return a.every((entry) => {
    const found = other.store.lookup(entry.key);
    return found !== undefined && equals(found.value, entry.value);
  });
}

// CPython's defaultdict and OrderedDict define `|` themselves, which keeps their type where dict gives a plain dict.
for (const cls of [defaultdictClass, orderedDictClass]) {
  method(cls, '__or__', 'one', 1, 1, (self, [other]) =>
    other instanceof PyDict ? unionLike(self as PyDict, self as PyDict, other) : NotImplemented
  );
  method(cls, '__ror__', 'one', 1, 1, (self, [other]) =>
    other instanceof PyDict ? unionLike(self as PyDict, other, self as PyDict) : NotImplemented
  );
}

/** A new dict of the type (and default factory) of `like` holding the items of `first`, then those of `second`. */
function unionLike(like: PyDict, first: PyDict, second: PyDict): PyDict {
  const result = new PyDict(like.cls, new DictStore(like.store.plainWrites), like.defaultFactory);
  for (const dict of [first, second]) {
    for (const entry of dict.store.ordered()) result.store.set(entry.key, entry.value);
  }
  return result;
}

const pythonNamespaces = new WeakMap<object, Map<string, PyValue>>();
registerLazyAttributes('collections', ['ChainMap', 'UserDict', 'UserList', 'UserString'], (runtime, name) => {
  let namespace = pythonNamespaces.get(runtime);
  if (!namespace) {
    namespace = runLibrarySource('collections', COLLECTIONS_SOURCE);
    pythonNamespaces.set(runtime, namespace);
  }
  return namespace.get(name) as PyValue;
});

registerModule(
  'collections',
  () =>
    new Map<string, PyValue>([
      ['deque', dequeClass],
      // CPython imports heapq into collections only when Counter.most_common needs it.
      ['heapq', None],
      ['Counter', counterClass],
      ['defaultdict', defaultdictClass],
      ['OrderedDict', orderedDictClass],
      ['namedtuple', namedtupleFunction],
    ])
);

export { getIterator, makeNamedTupleClass, PyObject };
