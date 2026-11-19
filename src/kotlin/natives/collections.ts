// code-gauge-allow-file fileNcss 662 -- the compiler of one area of Kotlin, whose parts call each other closely.
import { runtimeClassOf } from '../dispatch';
import { hashOf, stringOf, valueEquals } from '../format';
import { toInt32 } from '../operators';
import type { Frame } from '../runtime';
import { type HashEntry, KObject, type KStore, UNIT, type Value } from '../values';
import { arrayIterator } from './core';
import { mapCapacity, newStore, reserveForCopy } from './hashTables';
import { defineNative, defineNativeProperty, libraryClass, throwError } from './registry';

/**
 * The native lists of the library share one implementation, whose behavior depends on the class the JVM would use:
 * `ArrayList` (mutable), `java.util.Arrays$ArrayList` (`listOf` of several elements: fixed size), a singleton list,
 * and Kotlin's `EmptyList`.
 */
const LIST = 'kotlin.collections.NativeList';

function items(list: Value): Value[] {
  return (list as KObject).items as Value[];
}

function className(value: Value): string {
  return runtimeClassOf(value).name;
}

/** Throws `UnsupportedOperationException` for a change a read-only or fixed-size list does not allow. */
function requireResizable(frame: Frame, list: Value): void {
  if (className(list) !== 'ArrayList' && className(list) !== 'SubList')
    throwError(frame, 'java.lang.UnsupportedOperationException');
}

function requireMutable(frame: Frame, list: Value): void {
  const name = className(list);
  if (name === 'SingletonList' || name === 'EmptyList' || name === 'EnumEntriesList') {
    throwError(frame, 'java.lang.UnsupportedOperationException');
  }
}

/** Checks an index of `get`, `set`, and `removeAt`, with the message each list class gives. */
function checkIndex(frame: Frame, list: Value, index: number): void {
  const size = items(list).length;
  if (index >= 0 && index < size) return;
  // A sublist of any list is AbstractList's SubList on the JVM, which checks indexes with Objects.checkIndex.
  const isSublist = (list as KObject).native?.parent !== undefined;
  switch (isSublist ? 'SubList' : className(list)) {
    case 'ArraysList': {
      throwError(frame, 'java.lang.ArrayIndexOutOfBoundsException', `Index ${index} out of bounds for length ${size}`);
      break;
    }
    case 'SingletonList': {
      throwError(frame, 'java.lang.IndexOutOfBoundsException', `Index: ${index}, Size: ${size}`);
      break;
    }
    case 'EmptyList': {
      throwError(frame, 'java.lang.IndexOutOfBoundsException', `Empty list doesn't contain element at index ${index}.`);
      break;
    }
    default: {
      throwError(frame, 'java.lang.IndexOutOfBoundsException', `Index ${index} out of bounds for length ${size}`);
    }
  }
}

/** Marks a structural change, which makes the iterators created before it fail. */
export function touch(collection: KObject): void {
  collection.modCount = (collection.modCount ?? 0) + 1;
  const parent = collection.native?.parent as KObject | undefined;
  if (parent) touch(parent);
}

export function indexOfValue(frame: Frame, values: Value[], element: Value): number {
  for (const [index, value] of values.entries()) {
    frame.runtime.spend();
    if (valueEquals(frame, element, value)) return index;
  }
  return -1;
}

/** `AbstractCollection.toString`: the elements in brackets, a collection inside itself shown as `(this Collection)`. */
export function collectionToString(frame: Frame, collection: Value, elements: Value[]): string {
  const parts = elements.map((element) => (element === collection ? '(this Collection)' : stringOf(frame, element)));
  const text = `[${parts.join(', ')}]`;
  frame.runtime.allocateString(frame, text.length);
  return text;
}

export function newList(
  frame: Frame,
  className: 'ArrayList' | 'ArraysList' | 'SingletonList' | 'EmptyList',
  values: Value[]
): KObject {
  frame.runtime.allocate(frame, values.length + 1);
  const list = new KObject(libraryClass(`kotlin.collections.${className}`), 0);
  list.items = values;
  list.modCount = 0;
  return list;
}

/** The elements of any collection or iterable, read natively when it is one of the library's. */
export function elementsOf(frame: Frame, collection: Value): Value[] {
  const object = collection as KObject;
  if (object.items) return [...object.items];
  if (object.store) return storeElements(object);
  if (object.native?.view) return viewElements(frame, object);
  return iterateElements(frame, object);
}

/** Reads an iterable of the program through its iterator, as the library's functions do. */
function iterateElements(frame: Frame, iterable: KObject): Value[] {
  const iterableClass = libraryClass('kotlin.collections.Iterable');
  const iteratorClass = libraryClass('kotlin.collections.Iterator');
  const call = (receiver: Value, owner: typeof iterableClass, name: string): Value => {
    const member = owner.members.get(name)?.find((candidate) => candidate.kind === 'function');
    if (member?.kind !== 'function') throw new Error(`No ${name}`);
    const target = runtimeClassOf(receiver).dispatch(member);
    return (target.invoke as NonNullable<typeof target.invoke>)(frame, receiver, [], undefined);
  };
  const iterator = call(iterable, iterableClass, 'iterator');
  const result: Value[] = [];
  frame.runtime.nativeRoots.push(iterator);
  try {
    while (call(iterator, iteratorClass, 'hasNext') === true) result.push(call(iterator, iteratorClass, 'next'));
  } finally {
    frame.runtime.nativeRoots.pop();
  }
  return result;
}

function storeElements(object: KObject): Value[] {
  const store = object.store as KStore;
  return store.ordered().map((entry) => entry.key);
}

function defineLists(): void {
  const constructors: [string, (frame: Frame, instance: KObject, args: Value[]) => void][] = [
    ['()', () => {}],
    [
      '(Int)',
      (frame, _instance, [capacity]) => {
        if ((capacity as number) < 0)
          throwError(frame, 'java.lang.IllegalArgumentException', `Illegal Capacity: ${capacity as number}`);
      },
    ],
    [
      '(Collection<E>)',
      (frame, instance, [elements]) => {
        instance.items = elementsOf(frame, elements);
      },
    ],
  ];
  for (const [signature, initialize] of constructors) {
    defineNative(`kotlin.collections.ArrayList.<init>${signature}`, (frame, instance, args) => {
      const list = instance as KObject;
      list.items = [];
      list.modCount = 0;
      initialize(frame, list, args);
      frame.runtime.allocate(frame, list.items.length + 1);
      return UNIT;
    });
  }
  defineNativeProperty(`${LIST}.size`, (_frame, list) => items(list).length);
  const natives: Record<string, (frame: Frame, list: Value, args: Value[]) => Value> = {
    'isEmpty()': (_frame, list) => items(list).length === 0,
    'contains(E)': (frame, list, [element]) => indexOfValue(frame, items(list), element) !== -1,
    'containsAll(Collection<E>)': (frame, list, [elements]) =>
      elementsOf(frame, elements).every((element) => indexOfValue(frame, items(list), element) !== -1),
    'get(Int)': (frame, list, [index]) => {
      checkIndex(frame, list, index as number);
      return items(list)[index as number];
    },
    'indexOf(E)': (frame, list, [element]) => indexOfValue(frame, items(list), element),
    'lastIndexOf(E)': (frame, list, [element]) => {
      const values = items(list);
      for (let index = values.length - 1; index >= 0; index--)
        if (valueEquals(frame, element, values[index])) return index;
      return -1;
    },
    'iterator()': (frame, list) => arrayIterator(frame, list as KObject),
    'listIterator()': (frame, list) => arrayIterator(frame, list as KObject),
    'subList(Int, Int)': (frame, list, [from, to]) => subList(frame, list as KObject, from as number, to as number),
    'add(E)': (frame, list, [element]) => {
      requireResizable(frame, list);
      items(list).push(element);
      frame.runtime.allocate(frame, 1);
      touch(list as KObject);
      syncParent(list as KObject);
      return true;
    },
    'add(Int, E)': (frame, list, [index, element]) => {
      requireResizable(frame, list);
      const values = items(list);
      const position = index as number;
      if (position < 0 || position > values.length) {
        throwError(frame, 'java.lang.IndexOutOfBoundsException', `Index: ${position}, Size: ${values.length}`);
      }
      values.splice(position, 0, element);
      frame.runtime.allocate(frame, 1);
      frame.runtime.spend(values.length - position);
      touch(list as KObject);
      syncParent(list as KObject);
      return UNIT;
    },
    'addAll(Collection<E>)': (frame, list, [elements]) => {
      requireResizable(frame, list);
      const added = elementsOf(frame, elements);
      items(list).push(...added);
      frame.runtime.allocate(frame, added.length);
      touch(list as KObject);
      syncParent(list as KObject);
      return added.length > 0;
    },
    'addAll(Int, Collection<E>)': (frame, list, [index, elements]) => {
      requireResizable(frame, list);
      const values = items(list);
      const position = index as number;
      if (position < 0 || position > values.length) {
        throwError(frame, 'java.lang.IndexOutOfBoundsException', `Index: ${position}, Size: ${values.length}`);
      }
      const added = elementsOf(frame, elements);
      values.splice(position, 0, ...added);
      touch(list as KObject);
      syncParent(list as KObject);
      return added.length > 0;
    },
    'remove(E)': (frame, list, [element]) => {
      const values = items(list);
      const index = indexOfValue(frame, values, element);
      if (index === -1) {
        requireMutable(frame, list);
        return false;
      }
      requireResizable(frame, list);
      values.splice(index, 1);
      touch(list as KObject);
      syncParent(list as KObject);
      return true;
    },
    'removeAt(Int)': (frame, list, [index]) => {
      requireResizable(frame, list);
      checkIndex(frame, list, index as number);
      const [removed] = items(list).splice(index as number, 1);
      touch(list as KObject);
      syncParent(list as KObject);
      return removed;
    },
    'set(Int, E)': (frame, list, [index, element]) => {
      requireMutable(frame, list);
      checkIndex(frame, list, index as number);
      const values = items(list);
      const old = values[index as number];
      values[index as number] = element;
      syncParent(list as KObject);
      return old;
    },
    'removeAll(Collection<E>)': (frame, list, [elements]) => {
      requireResizable(frame, list);
      const removing = elementsOf(frame, elements);
      return filterInPlace(frame, list as KObject, (value) => indexOfValue(frame, removing, value) === -1);
    },
    'retainAll(Collection<E>)': (frame, list, [elements]) => {
      requireResizable(frame, list);
      const keeping = elementsOf(frame, elements);
      return filterInPlace(frame, list as KObject, (value) => indexOfValue(frame, keeping, value) !== -1);
    },
    'clear()': (frame, list) => {
      requireResizable(frame, list);
      items(list).length = 0;
      touch(list as KObject);
      syncParent(list as KObject);
      return UNIT;
    },
    'equals(Any?)': (frame, list, [other]) => listEquals(frame, list as KObject, other),
    'hashCode()': (frame, list) => listHash(frame, items(list)),
    'toString()': (frame, list) => collectionToString(frame, list, items(list)),
  };
  for (const [signature, native] of Object.entries(natives)) defineNative(`${LIST}.${signature}`, native);
}

/** Removes the elements `keeps` rejects, telling whether any went. */
export function filterInPlace(frame: Frame, list: KObject, keeps: (value: Value) => boolean): boolean {
  const values = list.items as Value[];
  const kept = values.filter((value) => keeps(value));
  if (kept.length === values.length) return false;
  values.length = 0;
  values.push(...kept);
  touch(list);
  syncParent(list);
  void frame;
  return true;
}

export function listEquals(frame: Frame, list: KObject, other: Value): boolean {
  if (list === other) return true;
  if (!(other instanceof KObject) || !runtimeClassOf(other).isSubclassOf(libraryClass('kotlin.collections.List')))
    return false;
  const a = list.items as Value[];
  const b = elementsOf(frame, other);
  return a.length === b.length && a.every((value, index) => valueEquals(frame, value, b[index]));
}

export function listHash(frame: Frame, values: Value[]): number {
  let hash = 1;
  for (const value of values) hash = toInt32(Math.imul(31, hash) + hashOf(frame, value));
  return hash;
}

/**
 * `subList`, a view of a range of a list. It copies the range and writes changes back, which keeps the parent and the
 * view consistent for the changes a program makes through one of them at a time.
 */
function subList(frame: Frame, list: KObject, from: number, to: number): KObject {
  const values = list.items as Value[];
  if (from < 0) throwError(frame, 'java.lang.IndexOutOfBoundsException', `fromIndex = ${from}`);
  if (to > values.length) throwError(frame, 'java.lang.IndexOutOfBoundsException', `toIndex = ${to}`);
  if (from > to) throwError(frame, 'java.lang.IllegalArgumentException', `fromIndex(${from}) > toIndex(${to})`);
  const view = newList(
    frame,
    className(list) === 'ArrayList' || className(list) === 'SubList' ? 'ArrayList' : 'ArraysList',
    values.slice(from, to)
  );
  if (className(list) === 'ArrayList' || className(list) === 'SubList')
    view.cls = libraryClass('kotlin.collections.SubList');
  view.native = { parent: list, from, length: to - from };
  return view;
}

/** Writes a sublist's elements back into its parent's range after a change. */
function syncParent(list: KObject): void {
  const native = list.native as { parent?: KObject; from: number; length: number } | undefined;
  if (!native?.parent) return;
  const parentItems = native.parent.items as Value[];
  parentItems.splice(native.from, native.length, ...(list.items as Value[]));
  native.length = (list.items as Value[]).length;
  syncParent(native.parent);
}

// code-gauge-allow functionNcss 46 -- registers the natives of one class together, in the order the prelude declares them.
function defineIterators(): void {
  const iterator = 'kotlin.collections.ItemIterator';
  interface State {
    source: KObject;
    index: number;
    expectedModCount: number | undefined;
    last?: number;
  }
  const state = (value: Value): State => (value as KObject).native as unknown as State;
  const checkModification = (frame: Frame, current: State): void => {
    if (current.source.modCount !== current.expectedModCount)
      throwError(frame, 'java.util.ConcurrentModificationException');
  };
  defineNative(`${iterator}.hasNext()`, (_frame, receiver) => {
    const current = state(receiver);
    return current.index < (current.source.items as Value[]).length;
  });
  defineNative(`${iterator}.next()`, (frame, receiver) => {
    const current = state(receiver);
    checkModification(frame, current);
    const values = current.source.items as Value[];
    if (current.index >= values.length) throwError(frame, 'java.util.NoSuchElementException');
    current.last = current.index;
    return values[current.index++];
  });
  defineNative(`${iterator}.remove()`, (frame, receiver) => {
    const current = state(receiver);
    if (current.last === undefined) throwError(frame, 'java.lang.IllegalStateException');
    checkModification(frame, current);
    requireResizable(frame, current.source);
    (current.source.items as Value[]).splice(current.last, 1);
    current.index = current.last;
    current.last = undefined;
    touch(current.source);
    syncParent(current.source);
    current.expectedModCount = current.source.modCount;
    return UNIT;
  });
  defineNative(`${iterator}.hasPrevious()`, (_frame, receiver) => state(receiver).index > 0);
  defineNative(`${iterator}.previous()`, (frame, receiver) => {
    const current = state(receiver);
    checkModification(frame, current);
    if (current.index <= 0) throwError(frame, 'java.util.NoSuchElementException');
    current.index--;
    current.last = current.index;
    return (current.source.items as Value[])[current.index];
  });
  defineNative(`${iterator}.nextIndex()`, (_frame, receiver) => state(receiver).index);
  defineNative(`${iterator}.previousIndex()`, (_frame, receiver) => state(receiver).index - 1);
}

// Maps and sets.

const MAP = 'kotlin.collections.NativeMap';
const SET = 'kotlin.collections.NativeSet';

/** The hash of a set or map: the sum of its elements' hashes, wrapping as Java's int does. */
function sumHashes(hashes: number[]): number {
  let sum = 0;
  for (const hash of hashes) sum = toInt32(sum + hash);
  return sum;
}

function storeOf(value: Value): KStore {
  return (value as KObject).store as KStore;
}

/** Finds the entry of a key, comparing with `equals` among the entries of its hash, or by order in a sorted store. */
export function findEntry(frame: Frame, store: KStore, key: Value): HashEntry | undefined {
  if (store.order === 'sorted') {
    const { index, isFound } = store.positionOf(frame, key);
    return isFound ? store.entries[index] : undefined;
  }
  const hash = hashOf(frame, key);
  for (const entry of store.withHash(hash)) {
    frame.runtime.spend();
    if (entry.key === key || valueEquals(frame, key, entry.key)) return entry;
  }
  return undefined;
}

/** `HashMap.hash` keeps the hashes as Java's `hashCode` returns them; the store spreads them into buckets. */
export function putEntry(frame: Frame, store: KStore, key: Value, value: Value): Value {
  const existing = findEntry(frame, store, key);
  if (existing) {
    const old = existing.value;
    existing.value = value;
    return old;
  }
  frame.runtime.allocate(frame, 2);
  const entry: HashEntry = { key, value, hash: store.order === 'sorted' ? 0 : hashOf(frame, key) };
  if (store.order === 'sorted') store.insertAt(store.positionOf(frame, key).index, entry);
  else store.add(entry);
  return undefined;
}

export function newMap(frame: Frame, className: string, store: KStore): KObject {
  frame.runtime.allocate(frame, 1);
  const map = new KObject(libraryClass(`kotlin.collections.${className}`), 0);
  map.store = store;
  map.modCount = 0;
  return map;
}

function requireMutableMap(frame: Frame, map: Value): void {
  const name = className(map);
  if (name === 'SingletonMap' || name === 'EmptyMap' || name === 'SingletonSet' || name === 'EmptySet') {
    throwError(frame, 'java.lang.UnsupportedOperationException');
  }
}

function defineMapConstructors(): void {
  const mapConstructors: [string, KStore['order']][] = [
    ['HashMap', 'hash'],
    ['LinkedHashMap', 'insertion'],
  ];
  for (const [name, order] of mapConstructors) {
    const key = `kotlin.collections.${name}.<init>`;
    defineNative(`${key}()`, (_frame, instance) => {
      (instance as KObject).store = newStore(order);
      (instance as KObject).modCount = 0;
      return UNIT;
    });
    defineNative(`${key}(Int)`, (frame, instance, [capacity]) => {
      if ((capacity as number) < 0)
        throwError(frame, 'java.lang.IllegalArgumentException', `Illegal initial capacity: ${capacity as number}`);
      (instance as KObject).store = newStore(order, capacity as number);
      (instance as KObject).modCount = 0;
      return UNIT;
    });
    defineNative(`${key}(Map<out K, V>)`, (frame, instance, [source]) => {
      const entries = mapEntriesOf(frame, source);
      const store = newStore(order);
      reserveForCopy(store, entries.length);
      for (const [entryKey, value] of entries) putEntry(frame, store, entryKey, value);
      (instance as KObject).store = store;
      (instance as KObject).modCount = 0;
      return UNIT;
    });
  }
}

// code-gauge-allow functionNcss 54 -- registers the natives of one class together, in the order the prelude declares them.
function defineMaps(): void {
  defineNativeProperty(`${MAP}.size`, (_frame, map) => storeOf(map).entries.length);
  const natives: Record<string, (frame: Frame, map: Value, args: Value[]) => Value> = {
    'isEmpty()': (_frame, map) => storeOf(map).entries.length === 0,
    'containsKey(K)': (frame, map, [key]) => findEntry(frame, storeOf(map), key) !== undefined,
    'containsValue(V)': (frame, map, [value]) =>
      storeOf(map).entries.some((entry) => valueEquals(frame, value, entry.value)),
    'get(K)': (frame, map, [key]) => {
      const store = storeOf(map);
      return findEntry(frame, store, key)?.value;
    },
    'put(K, V)': (frame, map, [key, value]) => {
      requireMutableMap(frame, map);
      const store = storeOf(map);
      const sizeBefore = store.entries.length;
      const old = putEntry(frame, store, key, value);
      if (store.entries.length !== sizeBefore) touch(map as KObject);
      return old;
    },
    'remove(K)': (frame, map, [key]) => {
      requireMutableMap(frame, map);
      const store = storeOf(map);
      const entry = findEntry(frame, store, key);
      if (!entry) return;
      store.remove(entry);
      touch(map as KObject);
      return entry.value;
    },
    'putAll(Map<out K, V>)': (frame, map, [source]) => {
      requireMutableMap(frame, map);
      const entries = mapEntriesOf(frame, source);
      reserveForCopy(storeOf(map), entries.length);
      for (const [key, value] of entries) putEntry(frame, storeOf(map), key, value);
      touch(map as KObject);
      return UNIT;
    },
    'clear()': (frame, map) => {
      requireMutableMap(frame, map);
      storeOf(map).entries = [];
      touch(map as KObject);
      return UNIT;
    },
    'equals(Any?)': (frame, map, [other]) => mapEquals(frame, map as KObject, other),
    'hashCode()': (frame, map) =>
      sumHashes(storeOf(map).entries.map((entry) => hashOf(frame, entry.key) ^ hashOf(frame, entry.value))),
    'toString()': (frame, map) => mapToString(frame, map as KObject),
  };
  for (const [signature, native] of Object.entries(natives)) defineNative(`${MAP}.${signature}`, native);
  for (const view of ['keys', 'values', 'entries'] as const) {
    defineNativeProperty(`${MAP}.${view}`, (frame, map) => newView(frame, map as KObject, view));
  }
}

/** The entries of any map, as key–value pairs in its iteration order. */
export function mapEntriesOf(frame: Frame, map: Value): [Value, Value][] {
  const object = map as KObject;
  if (object.store) return object.store.ordered().map((entry) => [entry.key, entry.value]);
  void frame;
  return [];
}

function mapEquals(frame: Frame, map: KObject, other: Value): boolean {
  if (map === other) return true;
  if (!(other instanceof KObject) || !other.store || other.native?.isSet || map.native?.isSet) return false;
  const a = storeOf(map);
  const b = other.store;
  if (a.entries.length !== b.entries.length) return false;
  return a.entries.every((entry) => {
    const found = findEntry(frame, b, entry.key);
    return found !== undefined && valueEquals(frame, entry.value, found.value);
  });
}

function mapToString(frame: Frame, map: KObject): string {
  const parts = storeOf(map)
    .ordered()
    .map((entry) => {
      const key = entry.key === map ? '(this Map)' : stringOf(frame, entry.key);
      const value = entry.value === map ? '(this Map)' : stringOf(frame, entry.value);
      return `${key}=${value}`;
    });
  const text = `{${parts.join(', ')}}`;
  frame.runtime.allocateString(frame, text.length);
  return text;
}

function initializeSet(instance: Value, store: KStore): Value {
  (instance as KObject).store = store;
  (instance as KObject).modCount = 0;
  (instance as KObject).native = { isSet: true };
  return UNIT;
}

// code-gauge-allow functionNcss 54 -- registers the natives of one class together, in the order the prelude declares them.
// code-gauge-allow functionCognitiveComplexity 19 -- registers the natives of one class together, in the order the prelude declares them.
function defineSets(): void {
  const setConstructors: [string, KStore['order']][] = [
    ['HashSet', 'hash'],
    ['LinkedHashSet', 'insertion'],
  ];
  for (const [name, order] of setConstructors) {
    const key = `kotlin.collections.${name}.<init>`;
    defineNative(`${key}()`, (_frame, instance) => initializeSet(instance, newStore(order)));
    defineNative(`${key}(Int)`, (frame, instance, [capacity]) => {
      if ((capacity as number) < 0)
        throwError(frame, 'java.lang.IllegalArgumentException', `Illegal initial capacity: ${capacity as number}`);
      return initializeSet(instance, newStore(order, capacity as number));
    });
    defineNative(`${key}(Collection<E>)`, (frame, instance, [elements]) => {
      const values = elementsOf(frame, elements);
      const store = newStore(order, Math.max(Math.trunc(values.length / 0.75) + 1, 16));
      for (const value of values) putEntry(frame, store, value, undefined);
      return initializeSet(instance, store);
    });
  }
  defineNativeProperty(`${SET}.size`, (_frame, set) => storeOf(set).entries.length);
  const natives: Record<string, (frame: Frame, set: Value, args: Value[]) => Value> = {
    'isEmpty()': (_frame, set) => storeOf(set).entries.length === 0,
    'contains(E)': (frame, set, [element]) => findEntry(frame, storeOf(set), element) !== undefined,
    'containsAll(Collection<E>)': (frame, set, [elements]) =>
      elementsOf(frame, elements).every((element) => findEntry(frame, storeOf(set), element) !== undefined),
    'iterator()': (frame, set) => storeIterator(frame, set as KObject, 'keys'),
    'add(E)': (frame, set, [element]) => {
      requireMutableMap(frame, set);
      const store = storeOf(set);
      if (findEntry(frame, store, element)) return false;
      putEntry(frame, store, element, undefined);
      touch(set as KObject);
      return true;
    },
    'remove(E)': (frame, set, [element]) => {
      const store = storeOf(set);
      const entry = findEntry(frame, store, element);
      if (!entry) return false;
      requireMutableMap(frame, set);
      store.remove(entry);
      touch(set as KObject);
      return true;
    },
    'addAll(Collection<E>)': (frame, set, [elements]) => {
      requireMutableMap(frame, set);
      let changed = false;
      for (const element of elementsOf(frame, elements)) {
        if (findEntry(frame, storeOf(set), element)) continue;
        putEntry(frame, storeOf(set), element, undefined);
        changed = true;
      }
      if (changed) touch(set as KObject);
      return changed;
    },
    'removeAll(Collection<E>)': (frame, set, [elements]) => {
      requireMutableMap(frame, set);
      const removing = elementsOf(frame, elements);
      return removeEntries(frame, set as KObject, (entry) => indexOfValue(frame, removing, entry.key) !== -1);
    },
    'retainAll(Collection<E>)': (frame, set, [elements]) => {
      requireMutableMap(frame, set);
      const keeping = elementsOf(frame, elements);
      return removeEntries(frame, set as KObject, (entry) => indexOfValue(frame, keeping, entry.key) === -1);
    },
    'clear()': (frame, set) => {
      requireMutableMap(frame, set);
      storeOf(set).entries = [];
      touch(set as KObject);
      return UNIT;
    },
    'equals(Any?)': (frame, set, [other]) => setEquals(frame, storeElements(set as KObject), other),
    'hashCode()': (frame, set) => sumHashes(storeOf(set).entries.map((entry) => hashOf(frame, entry.key))),
    'toString()': (frame, set) => collectionToString(frame, set, storeElements(set as KObject)),
  };
  for (const [signature, native] of Object.entries(natives)) defineNative(`${SET}.${signature}`, native);
}

function removeEntries(frame: Frame, collection: KObject, removes: (entry: HashEntry) => boolean): boolean {
  const store = collection.store as KStore;
  const removed = store.entries.filter((entry) => removes(entry));
  for (const entry of removed) store.remove(entry);
  if (removed.length > 0) touch(collection);
  void frame;
  return removed.length > 0;
}

function setEquals(frame: Frame, elements: Value[], other: Value): boolean {
  if (!(other instanceof KObject) || !runtimeClassOf(other).isSubclassOf(libraryClass('kotlin.collections.Set')))
    return false;
  const others = elementsOf(frame, other);
  if (others.length !== elements.length) return false;
  return elements.every((element) => indexOfValue(frame, others, element) !== -1);
}

// Views of maps and iterators over stores.

type ViewKind = 'keys' | 'values' | 'entries';

function newView(frame: Frame, map: KObject, view: ViewKind): KObject {
  frame.runtime.allocate(frame, 1);
  const object = new KObject(
    libraryClass(view === 'values' ? 'kotlin.collections.MapValues' : 'kotlin.collections.MapKeysOrEntries'),
    0
  );
  object.native = { view, map };
  return object;
}

function viewOf(value: Value): { view: ViewKind; map: KObject } {
  return (value as KObject).native as { view: ViewKind; map: KObject };
}

/** The elements of a map's view: its keys, its values, or its entries as `Map.Entry` objects. */
export function viewElements(frame: Frame, view: KObject): Value[] {
  const { view: kind, map } = viewOf(view);
  return (map.store as KStore).ordered().map((entry) => viewElement(frame, map, kind, entry));
}

function viewElement(frame: Frame, map: KObject, kind: ViewKind, entry: HashEntry): Value {
  if (kind === 'keys') return entry.key;
  if (kind === 'values') return entry.value;
  return newEntry(frame, map, entry);
}

export function newEntry(frame: Frame, map: KObject | undefined, entry: HashEntry): KObject {
  frame.runtime.allocate(frame, 1);
  const object = new KObject(libraryClass('kotlin.collections.NativeEntry'), 0);
  object.native = { entry, map };
  return object;
}

function storeIterator(frame: Frame, collection: KObject, kind: ViewKind, map = collection): KObject {
  const iterator = new KObject(libraryClass('kotlin.collections.StoreIterator'), 0);
  iterator.native = {
    map,
    kind,
    entries: (map.store as KStore).ordered(),
    index: 0,
    expectedModCount: map.modCount,
    last: undefined,
  };
  void frame;
  return iterator;
}

/** The entry a `Map.Entry` object of a native map stands for. */
function entryOf(value: Value): { entry: HashEntry; map: KObject | undefined } {
  return (value as KObject).native as { entry: HashEntry; map: KObject | undefined };
}

function varargItems(array: Value): Value[] {
  return [...((array as KObject).items as Value[])];
}

function pairParts(pair: Value): [Value, Value] {
  const { fields } = pair as KObject;
  return [fields[0], fields[1]];
}

function defineViews(): void {
  const keysOrEntries = 'kotlin.collections.MapKeysOrEntries';
  const values = 'kotlin.collections.MapValues';
  for (const owner of [keysOrEntries, values]) {
    defineNativeProperty(`${owner}.size`, (_frame, view) => (viewOf(view).map.store as KStore).entries.length);
    defineNative(`${owner}.isEmpty()`, (_frame, view) => (viewOf(view).map.store as KStore).entries.length === 0);
    defineNative(
      `${owner}.contains(E)`,
      (frame, view, [element]) => indexOfValue(frame, viewElements(frame, view as KObject), element) !== -1
    );
    defineNative(`${owner}.containsAll(Collection<E>)`, (frame, view, [elements]) => {
      const all = viewElements(frame, view as KObject);
      return elementsOf(frame, elements).every((element) => indexOfValue(frame, all, element) !== -1);
    });
    defineNative(`${owner}.iterator()`, (frame, view) => {
      const { view: kind, map } = viewOf(view);
      return storeIterator(frame, view as KObject, kind, map);
    });
    defineNative(`${owner}.remove(E)`, (frame, view, [element]) => {
      const { view: kind, map } = viewOf(view);
      requireMutableMap(frame, map);
      const store = map.store as KStore;
      const entry = store
        .ordered()
        .find((candidate) => valueEquals(frame, element, viewElement(frame, map, kind, candidate)));
      if (!entry) return false;
      store.remove(entry);
      touch(map);
      return true;
    });
    defineNative(`${owner}.add(E)`, (frame) => throwError(frame, 'java.lang.UnsupportedOperationException'));
    defineNative(`${owner}.addAll(Collection<E>)`, (frame) =>
      throwError(frame, 'java.lang.UnsupportedOperationException')
    );
    for (const name of ['removeAll', 'retainAll'] as const) {
      defineNative(`${owner}.${name}(Collection<E>)`, (frame, view, [elements]) => {
        const { view: kind, map } = viewOf(view);
        requireMutableMap(frame, map);
        const others = elementsOf(frame, elements);
        return removeEntries(
          frame,
          map,
          (entry) =>
            (indexOfValue(frame, others, viewElement(frame, map, kind, entry)) !== -1) === (name === 'removeAll')
        );
      });
    }
    defineNative(`${owner}.clear()`, (frame, view) => {
      const { map } = viewOf(view);
      requireMutableMap(frame, map);
      (map.store as KStore).entries = [];
      touch(map);
      return UNIT;
    });
    defineNative(`${owner}.toString()`, (frame, view) =>
      collectionToString(frame, view, viewElements(frame, view as KObject))
    );
    defineNative(`${owner}.hashCode()`, (frame, view) =>
      sumHashes(viewElements(frame, view as KObject).map((element) => hashOf(frame, element)))
    );
    defineNative(`${owner}.equals(Any?)`, (frame, view, [other]) => {
      if (viewOf(view).view === 'values') return view === other;
      return setEquals(frame, viewElements(frame, view as KObject), other);
    });
  }
  const iterator = 'kotlin.collections.StoreIterator';
  interface State {
    map: KObject;
    kind: ViewKind;
    entries: HashEntry[];
    index: number;
    expectedModCount: number | undefined;
    last: HashEntry | undefined;
  }
  const state = (value: Value): State => (value as KObject).native as unknown as State;
  defineNative(`${iterator}.hasNext()`, (_frame, receiver) => state(receiver).index < state(receiver).entries.length);
  defineNative(`${iterator}.next()`, (frame, receiver) => {
    const current = state(receiver);
    if (current.map.modCount !== current.expectedModCount)
      throwError(frame, 'java.util.ConcurrentModificationException');
    if (current.index >= current.entries.length) throwError(frame, 'java.util.NoSuchElementException');
    const entry = current.entries[current.index++];
    current.last = entry;
    return viewElement(frame, current.map, current.kind, entry);
  });
  defineNative(`${iterator}.remove()`, (frame, receiver) => {
    const current = state(receiver);
    if (!current.last) throwError(frame, 'java.lang.IllegalStateException');
    if (current.map.modCount !== current.expectedModCount)
      throwError(frame, 'java.util.ConcurrentModificationException');
    requireMutableMap(frame, current.map);
    (current.map.store as KStore).remove(current.last);
    current.last = undefined;
    touch(current.map);
    current.expectedModCount = current.map.modCount;
    return UNIT;
  });
  const entry = 'kotlin.collections.NativeEntry';
  defineNativeProperty(`${entry}.key`, (_frame, receiver) => entryOf(receiver).entry.key);
  defineNativeProperty(`${entry}.value`, (_frame, receiver) => entryOf(receiver).entry.value);
  defineNative(`${entry}.setValue(V)`, (frame, receiver, [value]) => {
    const { entry: stored, map } = entryOf(receiver);
    if (map) requireMutableMap(frame, map);
    const old = stored.value;
    stored.value = value;
    return old;
  });
  defineNative(`${entry}.toString()`, (frame, receiver) => {
    const { entry: stored } = entryOf(receiver);
    return `${stringOf(frame, stored.key)}=${stringOf(frame, stored.value)}`;
  });
  defineNative(`${entry}.hashCode()`, (frame, receiver) => {
    const { entry: stored } = entryOf(receiver);
    return hashOf(frame, stored.key) ^ hashOf(frame, stored.value);
  });
  defineNative(`${entry}.equals(Any?)`, (frame, receiver, [other]) => {
    if (!(other instanceof KObject) || other.cls !== (receiver as KObject).cls) return false;
    const a = entryOf(receiver).entry;
    const b = entryOf(other).entry;
    return valueEquals(frame, a.key, b.key) && valueEquals(frame, a.value, b.value);
  });
}

function setInstance(frame: Frame, name: string, store: KStore): KObject {
  const set = newMap(frame, name, store);
  set.native = { isSet: true };
  return set;
}

function fill(frame: Frame, store: KStore, pairs: Value[]): KStore {
  for (const pair of pairs) putEntry(frame, store, ...pairParts(pair));
  return store;
}

function setOfValues(frame: Frame, name: string, order: KStore['order'], values: Value[], capacity: number): KObject {
  const store = newStore(order, capacity);
  for (const value of values) if (!findEntry(frame, store, value)) putEntry(frame, store, value, undefined);
  return setInstance(frame, name, store);
}

/** The functions that create collections, which pick the JVM's classes as Kotlin's standard library does. */
function defineFactories(): void {
  const natives: Record<string, (frame: Frame, receiver: Value, args: Value[]) => Value> = {
    'listOf()': (frame) => newList(frame, 'EmptyList', []),
    'listOf(T)': (frame, _receiver, [element]) => newList(frame, 'SingletonList', [element]),
    'listOf(vararg T)': (frame, _receiver, [array]) => {
      const values = varargItems(array);
      return values.length === 0 ? newList(frame, 'EmptyList', []) : newList(frame, 'ArraysList', values);
    },
    'emptyList()': (frame) => newList(frame, 'EmptyList', []),
    'mutableListOf()': (frame) => newList(frame, 'ArrayList', []),
    'mutableListOf(vararg T)': (frame, _receiver, [array]) => newList(frame, 'ArrayList', varargItems(array)),
    'arrayListOf()': (frame) => newList(frame, 'ArrayList', []),
    'arrayListOf(vararg T)': (frame, _receiver, [array]) => newList(frame, 'ArrayList', varargItems(array)),
    'setOf()': (frame) => setInstance(frame, 'EmptySet', newStore('insertion')),
    'setOf(T)': (frame, _receiver, [element]) => setOfValues(frame, 'SingletonSet', 'insertion', [element], 1),
    'setOf(vararg T)': (frame, _receiver, [array]) => {
      const values = varargItems(array);
      if (values.length === 0) return setInstance(frame, 'EmptySet', newStore('insertion'));
      if (values.length === 1) return setOfValues(frame, 'SingletonSet', 'insertion', values, 1);
      return setOfValues(frame, 'LinkedHashSet', 'insertion', values, mapCapacity(values.length));
    },
    'emptySet()': (frame) => setInstance(frame, 'EmptySet', newStore('insertion')),
    'mutableSetOf()': (frame) => setOfValues(frame, 'LinkedHashSet', 'insertion', [], 16),
    'mutableSetOf(vararg T)': (frame, _receiver, [array]) => {
      const values = varargItems(array);
      return setOfValues(frame, 'LinkedHashSet', 'insertion', values, mapCapacity(values.length));
    },
    'hashSetOf()': (frame) => setOfValues(frame, 'HashSet', 'hash', [], 16),
    'hashSetOf(vararg T)': (frame, _receiver, [array]) => {
      const values = varargItems(array);
      return setOfValues(frame, 'HashSet', 'hash', values, mapCapacity(values.length));
    },
    'linkedSetOf(vararg T)': (frame, _receiver, [array]) => {
      const values = varargItems(array);
      return setOfValues(frame, 'LinkedHashSet', 'insertion', values, mapCapacity(values.length));
    },
    'mapOf()': (frame) => newMap(frame, 'EmptyMap', newStore('insertion')),
    'mapOf(Pair<K, V>)': (frame, _receiver, [pair]) =>
      newMap(frame, 'SingletonMap', fill(frame, newStore('insertion', 1), [pair])),
    'mapOf(vararg Pair<K, V>)': (frame, _receiver, [array]) => {
      const pairs = varargItems(array);
      if (pairs.length === 0) return newMap(frame, 'EmptyMap', newStore('insertion'));
      return newMap(frame, 'LinkedHashMap', fill(frame, newStore('insertion', mapCapacity(pairs.length)), pairs));
    },
    'emptyMap()': (frame) => newMap(frame, 'EmptyMap', newStore('insertion')),
    'mutableMapOf()': (frame) => newMap(frame, 'LinkedHashMap', newStore('insertion')),
    'mutableMapOf(vararg Pair<K, V>)': (frame, _receiver, [array]) => {
      const pairs = varargItems(array);
      return newMap(frame, 'LinkedHashMap', fill(frame, newStore('insertion', mapCapacity(pairs.length)), pairs));
    },
    'hashMapOf()': (frame) => newMap(frame, 'HashMap', newStore('hash')),
    'hashMapOf(vararg Pair<K, V>)': (frame, _receiver, [array]) => {
      const pairs = varargItems(array);
      return newMap(frame, 'HashMap', fill(frame, newStore('hash', mapCapacity(pairs.length)), pairs));
    },
    'linkedMapOf(vararg Pair<K, V>)': (frame, _receiver, [array]) => {
      const pairs = varargItems(array);
      return newMap(frame, 'LinkedHashMap', fill(frame, newStore('insertion', mapCapacity(pairs.length)), pairs));
    },
  };
  for (const [signature, native] of Object.entries(natives)) defineNative(`kotlin.collections.${signature}`, native);
}

defineLists();
defineFactories();
defineIterators();
defineMapConstructors();
defineMaps();
defineSets();
defineViews();
