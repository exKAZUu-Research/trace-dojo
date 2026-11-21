// code-gauge-allow-file fileNcss 990 -- the natives of the collections, which share the helpers of their items.
import { runtimeClassOf } from '../dispatch';
import { hashOf, identityHash, stringOf, valueEquals } from '../format';
import { toInt32 } from '../operators';
import type { Frame } from '../runtime';
import {
  type HashEntry,
  indexedItem,
  indexedItems,
  indexedSize,
  KObject,
  type KStore,
  listView,
  type PrimitiveArrayView,
  primitiveArrayView,
  type PrimitiveKind,
  UNIT,
  type Value,
} from '../values';
import {
  callCollectionMember,
  COLLECTION,
  collectionContains,
  collectionIterator,
  collectionSize,
  compareCollections,
  containsAll,
  filterCollection,
  forEachIterable,
  iterateElements,
  objectsEqual,
  readCollectionProperty,
  removeFirstIterable,
} from './collectionTraversal';
import { arrayIterator } from './core';
import { jdkHashCapacity, mapCapacity, newStore, reserveForCopy } from './hashTables';
import { listEquals } from './listEquality';
import { defineNative, defineNativeProperty, libraryClass, throwError } from './registry';

/**
 * The native lists of the library share one implementation, whose behavior depends on the class the JVM would use:
 * `ArrayList` (mutable), `java.util.Arrays$ArrayList` (`listOf` of several elements: fixed size), a singleton list,
 * and Kotlin's `EmptyList`.
 */
const LIST = 'kotlin.collections.NativeList';
const PRIMITIVE_ARRAY_LIST = 'kotlin.collections.PrimitiveArrayList';

function listStorage(list: Value): Value[] {
  return (list as KObject).items as Value[];
}

function readableItems(list: Value): Value[] {
  return indexedItems(list as KObject) as Value[];
}

function className(value: Value): string {
  return runtimeClassOf(value).name;
}

function listKind(list: Value): string | undefined {
  const { arrayList, cls } = list as KObject;
  if (arrayList) return 'ArrayList';
  return cls.isLibrary ? cls.name : undefined;
}

/** Throws `UnsupportedOperationException` for a change a read-only or fixed-size list does not allow. */
function requireResizable(frame: Frame, list: Value): void {
  const root = listView(list as KObject)?.source ?? list;
  const name = listKind(root);
  const isResizable = name === 'ArrayList' || name === 'ArrayDeque' || (name === 'ListBuilder' && !isBuilt(root));
  if (!isResizable) throwError(frame, 'java.lang.UnsupportedOperationException');
}

function requireMutable(frame: Frame, list: Value): void {
  const root = listView(list as KObject)?.source ?? list;
  const name = listKind(root);
  if (
    name === 'SingletonList' ||
    name === 'EmptyList' ||
    name === 'EnumEntriesList' ||
    (name === 'ListBuilder' && isBuilt(root))
  ) {
    throwError(frame, 'java.lang.UnsupportedOperationException');
  }
}

/** Whether `buildList` has finished a list it built, which no longer changes. */
function isBuilt(list: Value): boolean {
  return (list as KObject).native?.isBuilt === true;
}

function kotlinListIndex(index: number, size: number): string {
  return `index: ${index}, size: ${size}`;
}

function usesKotlinPositionBounds(list: Value): boolean {
  const source = listView(list as KObject)?.source ?? list;
  const kind = listKind(source);
  return kind === 'ListBuilder' || (list === source && kind === 'ArrayDeque');
}

/** Checks an index of `get`, `set`, and `removeAt`, with the message each list class gives. */
function checkIndex(frame: Frame, list: Value, index: number): void {
  const size = indexedSize(list as KObject);
  if (index >= 0 && index < size) return;
  if (usesKotlinPositionBounds(list))
    throwError(frame, 'java.lang.IndexOutOfBoundsException', kotlinListIndex(index, size));
  const isSublist = listView(list as KObject) !== undefined;
  switch (isSublist ? 'SubList' : listKind(list)) {
    case 'PrimitiveArrayList': {
      if (primitiveArrayView(list as KObject)?.range) {
        throwError(frame, 'java.lang.IndexOutOfBoundsException', kotlinListIndex(index, size));
      }
      throwError(frame, 'java.lang.ArrayIndexOutOfBoundsException', `Index ${index} out of bounds for length ${size}`);
      break;
    }
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
}

/** `AbstractCollection.toString`: the elements in brackets, a collection inside itself shown as `(this Collection)`. */
export function collectionToString(frame: Frame, collection: Value, elements: Iterable<Value>): string {
  return joinRendered(frame, elements, '[', ']', (element) =>
    element === collection ? '(this Collection)' : stringOf(frame, element)
  );
}

export function joinRendered<T>(
  frame: Frame,
  elements: Iterable<T>,
  prefix: string,
  suffix: string,
  render: (value: T) => string
): string {
  let length = prefix.length + suffix.length;
  const parts: string[] = [];
  for (const element of elements) {
    const part = render(element);
    const added = part.length + (parts.length > 0 ? 2 : 0);
    length += added;
    frame.runtime.allocateString(frame, length, added);
    parts.push(part);
  }
  return prefix + parts.join(', ') + suffix;
}

export function newList(
  frame: Frame,
  className: 'ArrayList' | 'ArraysList' | 'SingletonList' | 'EmptyList' | 'ListBuilder',
  values: Value[]
): KObject {
  frame.runtime.allocate(frame, values.length + 1);
  const list = new KObject(libraryClass(`kotlin.collections.${className}`), 0);
  list.items = values;
  if (className === 'ArrayList') list.arrayList = { size: values.length, capacity: values.length };
  list.modCount = 0;
  list.readOnlyCollection = className === 'EmptyList';
  return list;
}

function mutableListOfItems(frame: Frame, values: Value[]): KObject {
  const list = newList(frame, 'ArrayList', values);
  if (values.length === 0) list.arrayList = { size: 0, capacity: undefined };
  return list;
}

export function newPrimitiveArrayList(frame: Frame, arrayView: PrimitiveArrayView): KObject {
  frame.runtime.allocate(frame, 1);
  const list = new KObject(libraryClass(PRIMITIVE_ARRAY_LIST), 0);
  list.native = { arrayView };
  list.readOnlyCollection = true;
  return list;
}

/** The elements of any collection or iterable, read natively when it is one of the library's. */
export function elementsOf(frame: Frame, collection: Value): Value[] {
  const object = collection as KObject;
  checkListView(frame, object);
  const indexed = indexedItems(object);
  if (indexed) return [...indexed];
  if (object.store) return storeElements(object);
  if (object.native?.view) return viewElements(frame, object);
  return iterateElements(frame, object);
}

function storeElements(object: KObject): Value[] {
  const store = object.store as KStore;
  return store.ordered().map((entry) => entry.key);
}

type ListNative = (frame: Frame, list: Value, args: Value[]) => Value;

/** What reads a list of the library. */
const LIST_READING_NATIVES: Record<string, ListNative> = {
  'isEmpty()': (_frame, list) => indexedSize(list as KObject) === 0,
  'contains(E)': (frame, list, [element]) => searchListValue(frame, list as KObject, element) !== -1,
  'containsAll(Collection<E>)': (frame, list, [elements]) => containsAll(frame, list, elements),
  'get(Int)': (frame, list, [index]) => {
    checkIndex(frame, list, index as number);
    return indexedItem(list as KObject, index as number);
  },
  'indexOf(E)': (frame, list, [element]) => searchListValue(frame, list as KObject, element),
  'lastIndexOf(E)': (frame, list, [element]) => searchListValue(frame, list as KObject, element, true),
  'iterator()': (frame, list) => arrayIterator(frame, list as KObject),
  'listIterator()': (frame, list) => arrayIterator(frame, list as KObject),
  'listIterator(Int)': (frame, list, [index]) => {
    const size = indexedSize(list as KObject);
    const position = index as number;
    if (position < 0 || position > size) {
      const name = listKind(list);
      const message =
        name === 'EmptyList'
          ? `Index: ${position}`
          : name === 'ListBuilder'
            ? `index: ${position}, size: ${size}`
            : `Index: ${position}, Size: ${size}`;
      throwError(frame, 'java.lang.IndexOutOfBoundsException', message);
    }
    const iterator = arrayIterator(frame, list as KObject);
    (iterator.native as { index: number }).index = position;
    return iterator;
  },
  'subList(Int, Int)': (frame, list, [from, to]) => subList(frame, list as KObject, from as number, to as number),
  'equals(Any?)': (frame, list, [other]) => listEquals(frame, list as KObject, other),
  'hashCode()': (frame, list) => hashList(frame, list as KObject),
  'toString()': renderList,
};

function renderList(frame: Frame, receiver: Value): string {
  const list = receiver as KObject;
  checkListView(frame, list);
  if (usesJvmListIterator(list)) return renderCollection(frame, list);
  const view = listView(list);
  const items = (view?.source ?? list).items;
  return items
    ? withIndexedListElements(frame, list, items, view?.from ?? 0, (elements) =>
        collectionToString(frame, list, elements)
      )
    : collectionToString(frame, list, readableItems(list));
}

function renderCollection(frame: Frame, receiver: Value): string {
  return withCollectionElements(frame, receiver, (elements) => collectionToString(frame, receiver, elements));
}

function withCollectionElements<T>(frame: Frame, receiver: Value, use: (elements: Iterable<Value>) => T): T {
  const iterator = collectionIterator(frame, receiver);
  function* elements(): Iterable<Value> {
    while (iterator.hasNext()) yield iterator.next();
  }
  return frame.runtime.withNativeRoots([iterator.value], () => use(elements()));
}

function withIndexedListElements<T>(
  frame: Frame,
  list: KObject,
  items: Value[],
  from: number,
  use: (elements: Iterable<Value>) => T
): T {
  const end = from + indexedSize(list);
  function* elements(): Iterable<Value> {
    for (let index = from; index < end; index++) yield items[index];
  }
  return frame.runtime.withNativeRoots([items], () => use(elements()));
}

function usesJvmListIterator(list: KObject): boolean {
  const kind = listKind(listView(list)?.source ?? list);
  return kind === 'ArrayList' || kind === 'ArrayDeque';
}

function searchListValue(frame: Frame, list: KObject, element: Value, fromEnd = false): number {
  const index = findListValue(frame, list, element, fromEnd);
  if (listView(list)?.source.arrayList) checkListView(frame, list);
  return index;
}

function findListValue(frame: Frame, list: KObject, element: Value, fromEnd = false): number {
  const view = listView(list);
  const values = (view?.source ?? list).items;
  const from = view?.from ?? 0;
  const size = indexedSize(list);
  return frame.runtime.withNativeRoots([values], () => {
    for (let offset = 0; offset < size; offset++) {
      const index = fromEnd ? size - 1 - offset : offset;
      const value = values ? values[from + index] : indexedItem(list, index);
      frame.runtime.spend();
      if (valueEquals(frame, element, value)) return index;
    }
    return -1;
  });
}

/** What changes a list of the library, which only its resizable and mutable kinds allow. */
const LIST_CHANGING_NATIVES: Record<string, ListNative> = {
  'add(E)': (frame, list, [element]) => {
    requireResizable(frame, list);
    replaceListItems(frame, list as KObject, indexedSize(list as KObject), 0, [element]);
    return true;
  },
  'add(Int, E)': (frame, list, [index, element]) => {
    requireResizable(frame, list);
    const position = insertionIndex(frame, list, index as number);
    replaceListItems(frame, list as KObject, position, 0, [element]);
    return UNIT;
  },
  'addAll(Collection<E>)': (frame, list, [elements]) => insertListElements(frame, list as KObject, undefined, elements),
  'addAll(Int, Collection<E>)': (frame, list, [index, elements]) =>
    insertListElements(frame, list as KObject, index as number, elements),
  'remove(E)': (frame, list, [element]) => {
    const index = findListValue(frame, list as KObject, element);
    if (index === -1) {
      requireMutable(frame, list);
      return false;
    }
    requireResizable(frame, list);
    replaceListItems(frame, list as KObject, index, 1, []);
    return true;
  },
  'removeAt(Int)': (frame, list, [index]) => {
    requireResizable(frame, list);
    checkIndex(frame, list, index as number);
    const removed = indexedItem(list as KObject, index as number);
    replaceListItems(frame, list as KObject, index as number, 1, []);
    return removed;
  },
  'set(Int, E)': (frame, list, [index, element]) => {
    requireMutable(frame, list);
    checkIndex(frame, list, index as number);
    const view = listView(list as KObject);
    const values = listStorage(view?.source ?? list);
    const position = (index as number) + (view?.from ?? 0);
    const old = values[position];
    values[position] = element;
    return old;
  },
  'removeAll(Collection<E>)': (frame, list, [elements]) => filterList(frame, list as KObject, elements, false),
  'retainAll(Collection<E>)': (frame, list, [elements]) => filterList(frame, list as KObject, elements, true),
  'clear()': (frame, list) => {
    requireResizable(frame, list);
    if (listKind(list) !== 'ArrayDeque' || indexedSize(list as KObject) > 0)
      replaceListItems(frame, list as KObject, 0, indexedSize(list as KObject), []);
    return UNIT;
  },
};

function insertListElements(frame: Frame, list: KObject, index: number | undefined, elements: Value): boolean {
  const view = listView(list);
  if (!view) requireResizable(frame, list);
  const position = index === undefined ? indexedSize(list) : insertionIndex(frame, list, index);
  const added = elementsOf(frame, elements);
  if (added.length === 0 && (view || listKind(list) === 'ArrayDeque')) return false;
  if (view) {
    checkListView(frame, list);
    requireResizable(frame, list);
  }
  replaceListItems(frame, list, position, 0, added);
  return added.length > 0;
}

function insertionIndex(frame: Frame, list: Value, position: number): number {
  const size = indexedSize(list as KObject);
  if (position < 0 || position > size) {
    const message = usesKotlinPositionBounds(list)
      ? kotlinListIndex(position, size)
      : `Index: ${position}, Size: ${size}`;
    throwError(frame, 'java.lang.IndexOutOfBoundsException', message);
  }
  return position;
}

function replaceListItems(frame: Frame, list: KObject, index: number, removed: number, added: Value[]): void {
  const view = listView(list);
  const source = view?.source ?? list;
  const oldSize = indexedSize(source);
  const from = index + (view?.from ?? 0);
  const growth = added.length - removed;
  frame.runtime.spend(oldSize - from + added.length);
  if (growth > 0) frame.runtime.allocate(frame, growth);
  const values = listStorageForSize(frame, source, oldSize + growth);
  replaceListRange(values, from, removed, added, oldSize);
  if (source.arrayList) source.arrayList.size = oldSize + growth;
  else values.length = oldSize + growth;
  touch(source);
  updateListViews(list, source, growth);
}

function updateListViews(list: KObject, source: KObject, growth: number): void {
  for (let current = list, range = listView(list); range; current = range.parent, range = listView(current)) {
    range.size += growth;
    current.modCount = source.modCount;
  }
}

function listStorageForSize(frame: Frame, list: KObject, required: number): Value[] {
  const current = listStorage(list);
  const array = list.arrayList;
  const capacity = array?.capacity ?? list.listBuilderCapacity;
  if ((!array && capacity === undefined) || required <= (capacity ?? 0)) return current;
  const grownCapacity = Math.max(required, capacity === undefined ? 10 : capacity + Math.floor(capacity / 2));
  if (array) array.capacity = grownCapacity;
  else list.listBuilderCapacity = grownCapacity;
  frame.runtime.spend(Math.floor(current.length / 64));
  const grown = [...current];
  list.items = grown;
  return grown;
}

// code-gauge-allow functionNcss 32 -- registers the native list classes and the helper operations they share.
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
  defineNative(
    'kotlin.collections.NativeLists.removeIfArrayList(MutableCollection<T>, (T) -> Boolean)',
    (frame, _receiver, [list, predicate]) => removeIfArrayList(frame, list as KObject, predicate as KObject)
  );
  defineNative('kotlin.collections.NativeLists.builder(Int)', (frame, _receiver, [capacity]) => {
    const size = checkedBuilderCapacity(frame, capacity as number);
    const list = newList(frame, 'ListBuilder', []);
    list.listBuilderCapacity = size;
    return list;
  });
  defineNative('kotlin.collections.NativeLists.builderCapacity(Int)', (frame, _receiver, [capacity]) =>
    checkedBuilderCapacity(frame, capacity as number)
  );
  defineNative('kotlin.collections.ListBuilder.build()', (_frame, list) => {
    (list as KObject).native = { isBuilt: true };
    return list;
  });
  for (const cls of ['ArrayList', 'ArrayDeque']) {
    for (const [signature, initialize] of constructors) {
      defineNative(`kotlin.collections.${cls}.<init>${signature}`, (frame, instance, args) => {
        const list = instance as KObject;
        list.items = [];
        list.modCount = 0;
        initialize(frame, list, args);
        finishListAllocation(
          frame,
          list,
          cls,
          signature === '()',
          signature === '(Int)' ? (args[0] as number) : undefined
        );
        return UNIT;
      });
    }
  }
  for (const type of [LIST, PRIMITIVE_ARRAY_LIST]) {
    defineNativeProperty(`${type}.size`, (frame, list) => {
      checkListView(frame, list as KObject);
      return indexedSize(list as KObject);
    });
    for (const [signature, native] of Object.entries(LIST_READING_NATIVES)) registerListNative(type, signature, native);
  }
  for (const [signature, native] of Object.entries(LIST_CHANGING_NATIVES)) registerListNative(LIST, signature, native);
}

function finishListAllocation(
  frame: Frame,
  list: KObject,
  kind: string,
  defaultSize: boolean,
  initialCapacity: number | undefined
): void {
  const size = indexedSize(list);
  if (kind === 'ArrayList') list.arrayList = { size, capacity: defaultSize ? undefined : (initialCapacity ?? size) };
  const allocated = kind === 'ArrayDeque' ? (initialCapacity ?? size) : size;
  frame.runtime.allocate(frame, allocated + 1);
}

function checkedBuilderCapacity(frame: Frame, capacity: number): number {
  if (capacity < 0) throwError(frame, 'java.lang.IllegalArgumentException', 'capacity must be non-negative.');
  frame.runtime.allocate(frame, capacity);
  return capacity;
}

function registerListNative(type: string, signature: string, native: ListNative): void {
  if (signature.startsWith('addAll(')) {
    defineNative(`${type}.${signature}`, native);
    return;
  }
  defineNative(`${type}.${signature}`, (frame, list, args) => {
    checkListView(frame, list as KObject);
    return native(frame, list, args);
  });
}

export function checkListView(frame: Frame, list: KObject): void {
  const view = listView(list);
  if (view && view.source.modCount !== list.modCount) throwError(frame, 'java.util.ConcurrentModificationException');
}

function removeIfArrayList(frame: Frame, list: KObject, predicate: KObject): boolean | undefined {
  const view = listView(list);
  const source = view?.source ?? list;
  if (!source.arrayList) return undefined;
  checkListView(frame, list);
  const modCount = source.modCount;
  const values = listStorage(source);
  const from = view?.from ?? 0;
  const size = view?.size ?? indexedSize(source);
  const removed = new Uint8Array(size);
  const test = predicate.function;
  if (!test) throw new Error('Missing collection predicate');
  frame.runtime.withNativeRoots([values], () => {
    for (let index = 0; index < size; index++) {
      if (test.call(frame, [values[from + index]]) === true) removed[index] = 1;
    }
  });
  if (source.modCount !== modCount) throwError(frame, 'java.util.ConcurrentModificationException');
  if (!removed.includes(1)) return false;
  const kept: Value[] = [];
  for (let index = 0; index < size; index++) {
    if (!removed[index]) kept.push(values[from + index]);
  }
  replaceListItems(frame, list, 0, size, kept);
  return true;
}

function filterList(frame: Frame, list: KObject, elements: Value, retain: boolean): boolean {
  const view = listView(list);
  const source = view?.source ?? list;
  const keeps = (value: Value): boolean => collectionContains(frame, elements, value) === retain;
  if (source.arrayList) {
    const oldSize = source.arrayList.size;
    const from = view?.from ?? 0;
    const changed = filterArrayList(frame, source, from, from + indexedSize(list), keeps);
    if (changed) updateListViews(list, source, source.arrayList.size - oldSize);
    return changed;
  }
  if (listKind(source) === 'ListBuilder' || listKind(list) === 'ArrayDeque') {
    requireResizable(frame, list);
    const from = view?.from ?? 0;
    const size = indexedSize(list);
    const values = listStorage(source);
    let write = from;
    for (let read = from; read < from + size; read++) {
      const element = values[read];
      if (keeps(element)) values[write++] = element;
    }
    if (write === from + size) return false;
    replaceListItems(frame, list, write - from, from + size - write, []);
    return true;
  }
  return filterCollection(frame, list, elements, retain, false);
}

function filterArrayList(
  frame: Frame,
  source: KObject,
  from: number,
  end: number,
  keeps: (value: Value) => boolean
): boolean {
  const array = source.arrayList as NonNullable<KObject['arrayList']>;
  const values = listStorage(source);
  return frame.runtime.withNativeRoots([values], () => {
    let read = from;
    while (read < end && keeps(values[read])) read++;
    if (read === end) return false;
    let write = read++;
    try {
      for (; read < end; read++) {
        const element = values[read];
        if (keeps(element)) values[write++] = element;
      }
    } catch (error) {
      // ArrayList keeps all elements from the failed lookup onward, even if earlier lookups removed some.
      values.copyWithin(write, read, end);
      write += end - read;
      throw error;
    } finally {
      touch(source);
      if (array.size < end) {
        throwError(
          frame,
          'java.lang.ArrayIndexOutOfBoundsException',
          `arraycopy: length ${array.size - end} is negative`
        );
      }
      values.copyWithin(write, end, array.size);
      const newSize = array.size - (end - write);
      values.fill(undefined, newSize, array.size);
      array.size = newSize;
    }
    return true;
  });
}

function hashList(frame: Frame, list: KObject): number {
  const view = listView(list);
  const source = view?.source ?? list;
  const hash = (elements: Iterable<Value>): number => orderedListHash(frame, elements);
  if (listKind(source) === 'ArrayDeque') return withCollectionElements(frame, list, hash);
  if (!source.items) return hash(readableItems(list));
  const version = source.modCount;
  const result = withIndexedListElements(frame, list, source.items, view?.from ?? 0, hash);
  if (source.arrayList) {
    if (view) checkListView(frame, list);
    else if (source.modCount !== version) throwError(frame, 'java.util.ConcurrentModificationException');
  }
  return result;
}

function orderedListHash(frame: Frame, values: Iterable<Value>): number {
  let hash = 1;
  for (const value of values) hash = toInt32(Math.imul(31, hash) + hashOf(frame, value));
  return hash;
}

function subList(frame: Frame, list: KObject, from: number, to: number): KObject {
  const size = indexedSize(list);
  if (from < 0) throwError(frame, 'java.lang.IndexOutOfBoundsException', `fromIndex = ${from}`);
  if (to > size) throwError(frame, 'java.lang.IndexOutOfBoundsException', `toIndex = ${to}`);
  if (from > to) throwError(frame, 'java.lang.IllegalArgumentException', `fromIndex(${from}) > toIndex(${to})`);
  if (listKind(list) === 'EmptyList') return list;
  const arrayView = primitiveArrayView(list);
  if (arrayView) {
    return newPrimitiveArrayList(frame, {
      ...arrayView,
      range: { from: (arrayView.range?.from ?? 0) + from, size: to - from },
    });
  }
  const parent = listView(list);
  const source = parent?.source ?? list;
  frame.runtime.allocate(frame, 1);
  const cls = listKind(source) === 'ArrayDeque' ? 'SequentialSubList' : 'SubList';
  const view = new KObject(libraryClass(`kotlin.collections.${cls}`), 0);
  view.modCount = source.modCount;
  view.readOnlyCollection = source.readOnlyCollection;
  view.native = { listView: { source, parent: list, from: from + (parent?.from ?? 0), size: to - from } };
  return view;
}

function replaceListRange(values: Value[], from: number, removed: number, added: Value[], size: number): void {
  const change = added.length - removed;
  if (change > 0 && size + change > values.length) values.length = size + change;
  if (change !== 0) values.copyWithin(from + added.length, from + removed, size);
  if (change < 0) values.fill(undefined, size + change, size);
  for (const [offset, value] of added.entries()) values[from + offset] = value;
}

interface ItemIteratorState {
  source: KObject;
  kind?: PrimitiveKind | 'Boolean';
  index: number;
  expectedModCount: number | undefined;
  last?: number;
}

// code-gauge-allow functionNcss 55 -- registers the natives of one class together, in the order the prelude declares them.
function defineIterators(): void {
  const iterator = 'kotlin.collections.ItemIterator';
  defineNative(`${iterator}.hasNext()`, (_frame, receiver) => {
    const current = itemIteratorState(receiver);
    const size = indexedSize(current.source);
    return usesJvmListIterator(current.source) ? current.index !== size : current.index < size;
  });
  defineNative(`${iterator}.next()`, (frame, receiver) => {
    const current = itemIteratorState(receiver);
    checkIteratorModification(frame, current);
    if (current.index >= indexedSize(current.source)) exhaustedIterator(frame, current.source, current.index);
    current.last = current.index;
    return indexedItem(current.source, current.index++, current.kind);
  });
  defineNative(`${iterator}.remove()`, (frame, receiver) => {
    const current = itemIteratorState(receiver);
    if (current.last === undefined) throwError(frame, 'java.lang.IllegalStateException');
    checkIteratorModification(frame, current);
    requireResizable(frame, current.source);
    replaceListItems(frame, current.source, current.last, 1, []);
    return finishIteratorMutation(current, current.last);
  });
  defineNative(`${iterator}.set(T)`, (frame, receiver, [element]) => {
    const current = itemIteratorState(receiver);
    if (current.last === undefined) throwError(frame, 'java.lang.IllegalStateException');
    checkIteratorModification(frame, current);
    LIST_CHANGING_NATIVES['set(Int, E)'](frame, current.source, [current.last, element]);
    return UNIT;
  });
  defineNative(`${iterator}.add(T)`, (frame, receiver, [element]) => {
    const current = itemIteratorState(receiver);
    checkIteratorModification(frame, current);
    LIST_CHANGING_NATIVES['add(Int, E)'](frame, current.source, [current.index, element]);
    return finishIteratorMutation(current, current.index + 1);
  });
  defineNative(`${iterator}.hasPrevious()`, (_frame, receiver) => itemIteratorState(receiver).index > 0);
  defineNative(`${iterator}.previous()`, (frame, receiver) => {
    const current = itemIteratorState(receiver);
    checkIteratorModification(frame, current);
    if (current.index <= 0) exhaustedIterator(frame, current.source, current.index - 1);
    current.index--;
    current.last = current.index;
    return indexedItem(current.source, current.index, current.kind);
  });
  defineNative(`${iterator}.nextIndex()`, (_frame, receiver) => itemIteratorState(receiver).index);
  defineNative(`${iterator}.previousIndex()`, (_frame, receiver) => itemIteratorState(receiver).index - 1);
}

function exhaustedIterator(frame: Frame, source: KObject, index: number): never {
  const message =
    listKind(source) === 'ArrayDeque'
      ? `java.lang.IndexOutOfBoundsException: ${kotlinListIndex(index, indexedSize(source))}`
      : undefined;
  return throwError(frame, 'java.util.NoSuchElementException', message);
}

function finishIteratorMutation(state: ItemIteratorState, index: number): Value {
  state.index = index;
  state.last = undefined;
  state.expectedModCount = state.source.modCount;
  return UNIT;
}

function itemIteratorState(value: Value): ItemIteratorState {
  return (value as KObject).native as unknown as ItemIteratorState;
}

function checkIteratorModification(frame: Frame, current: ItemIteratorState): void {
  checkListView(frame, current.source);
  if (current.source.modCount !== current.expectedModCount)
    throwError(frame, 'java.util.ConcurrentModificationException');
}

// Maps and sets.

const MAP = 'kotlin.collections.NativeMap';
const SET = 'kotlin.collections.NativeSet';
const entryWrappers = new WeakMap<KObject, WeakMap<HashEntry, KObject>>();

function hashCollection(frame: Frame, receiver: Value): number {
  return withCollectionElements(frame, receiver, (elements) => {
    let sum = 0;
    for (const element of elements) sum = toInt32(sum + hashOf(frame, element));
    return sum;
  });
}

function storeOf(value: Value): KStore {
  return (value as KObject).store as KStore;
}

/** Finds the entry of a key, comparing with `equals` among the entries of its hash, or by order in a sorted store. */
export function findEntry(frame: Frame, store: KStore, key: Value, removing = false): HashEntry | undefined {
  if (!removing && !store.isAllocated && store.entries.length === 0) return undefined;
  if (store.isSingleton) return store.entries.find((entry) => valueEquals(frame, key, entry.key));
  if (store.order === 'sorted') {
    const { index, isFound } = store.positionOf(frame, key);
    return isFound ? store.entries[index] : undefined;
  }
  const tableCapacity = store.capacity;
  const hash = hashOf(frame, key);
  // HashMap lookups read their table before invoking hashCode, and resize clears the buckets of the old table.
  return removing || store.capacity === tableCapacity ? findHashedEntry(frame, store, key, hash) : undefined;
}

function findHashedEntry(frame: Frame, store: KStore, key: Value, hash: number): HashEntry | undefined {
  for (const entry of store.withHash(hash)) {
    frame.runtime.spend();
    if (entry.key === key || valueEquals(frame, key, entry.key)) return entry;
  }
  return undefined;
}

/** `HashMap.hash` keeps the hashes as Java's `hashCode` returns them; the store spreads them into buckets. */
export function putEntry(frame: Frame, store: KStore, key: Value, value: Value): Value {
  const position = store.order === 'sorted' ? store.positionOf(frame, key) : undefined;
  const hash = position ? 0 : hashOf(frame, key);
  const existing = position
    ? position.isFound
      ? store.entries[position.index]
      : undefined
    : findHashedEntry(frame, store, key, hash);
  if (existing) {
    const old = existing.value;
    existing.value = value;
    return old;
  }
  frame.runtime.allocate(frame, 2);
  const entry: HashEntry = { key, value, hash };
  if (position) store.insertAt(position.index, entry);
  else store.add(entry);
  return undefined;
}

export function newMap(frame: Frame, className: string, store: KStore): KObject {
  frame.runtime.allocate(frame, 1);
  const map = new KObject(libraryClass(`kotlin.collections.${className}`), 0);
  map.store = store;
  map.modCount = 0;
  map.readOnlyCollection = className === 'EmptyMap' || className === 'EmptySet';
  return map;
}

function requireMutableMap(frame: Frame, map: Value): void {
  const name = className(map);
  if (
    isBuilt(map) ||
    name === 'SingletonMap' ||
    name === 'EmptyMap' ||
    name === 'SingletonSet' ||
    name === 'EmptySet'
  ) {
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
    'containsValue(V)': (frame, map, [value]) => findMapValue(frame, storeOf(map), value) !== undefined,
    'get(K)': (frame, map, [key]) => {
      const store = storeOf(map);
      return findEntry(frame, store, key)?.value;
    },
    'put(K, V)': (frame, map, [key, value]) => {
      requireMutableMap(frame, map);
      return putMapEntry(frame, map as KObject, key, value);
    },
    'remove(K)': (frame, map, [key]) => {
      requireMutableMap(frame, map);
      const store = storeOf(map);
      const entry = findEntry(frame, store, key, true);
      if (!entry) return;
      store.remove(entry);
      touch(map as KObject);
      return entry.value;
    },
    'putAll(Map<out K, V>)': (frame, map, [source]) => {
      requireMutableMap(frame, map);
      const entries = mapEntriesOf(frame, source);
      reserveForCopy(storeOf(map), entries.length);
      for (const [key, value] of entries) putMapEntry(frame, map as KObject, key, value);
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
      hashCollection(frame, readCollectionProperty(frame, map, 'kotlin.collections.Map', 'entries')),
    'toString()': (frame, map) => mapToString(frame, map as KObject),
  };
  for (const [signature, native] of Object.entries(natives)) defineNative(`${MAP}.${signature}`, native);
  for (const view of ['keys', 'values', 'entries'] as const) {
    defineNativeProperty(`${MAP}.${view}`, (frame, map) => liveMapView(frame, map as KObject, view));
  }
}

function putMapEntry(frame: Frame, map: KObject, key: Value, value: Value): Value {
  const store = storeOf(map);
  const sizeBefore = store.entries.length;
  const previous = putEntry(frame, store, key, value);
  if (store.entries.length !== sizeBefore) touch(map);
  return previous;
}

/** The entries of any map, as key–value pairs in its iteration order. */
function mapEntriesOf(frame: Frame, map: Value): [Value, Value][] {
  const object = map as KObject;
  if (object.store) return object.store.ordered().map((entry) => [entry.key, entry.value]);
  const entries = elementsOf(frame, readCollectionProperty(frame, map, 'kotlin.collections.Map', 'entries'));
  const owner = 'kotlin.collections.Map.Entry';
  return entries.map((entry) => [
    readCollectionProperty(frame, entry, owner, 'key'),
    readCollectionProperty(frame, entry, owner, 'value'),
  ]);
}

function mapEquals(frame: Frame, map: KObject, other: Value): boolean {
  if (map === other) return true;
  const owner = 'kotlin.collections.Map';
  if (!(other instanceof KObject) || !other.cls.isSubclassOf(libraryClass(owner))) return false;
  const store = storeOf(map);
  if (map.cls === libraryClass('kotlin.collections.EmptyMap')) {
    return callCollectionMember(frame, other, owner, 'isEmpty') === true;
  }
  if (store.entries.length !== readCollectionProperty(frame, other, owner, 'size')) return false;
  return compareCollections(() =>
    store.ordered().every(({ key, value }) => {
      const actual = callCollectionMember(frame, other, owner, 'get', [key]);
      if (value !== undefined) return valueEquals(frame, value, actual);
      return actual === undefined && callCollectionMember(frame, other, owner, 'containsKey', [key]) === true;
    })
  );
}

function mapToString(frame: Frame, map: KObject): string {
  const entries = readCollectionProperty(frame, map, 'kotlin.collections.Map', 'entries');
  const owner = 'kotlin.collections.Map.Entry';
  return withCollectionElements(frame, entries, (elements) =>
    joinRendered(frame, elements, '{', '}', (entry) => {
      const entryKey = readCollectionProperty(frame, entry, owner, 'key');
      const entryValue = readCollectionProperty(frame, entry, owner, 'value');
      return frame.runtime.withNativeRoots([entryKey, entryValue], () => {
        const key = entryKey === map ? '(this Map)' : stringOf(frame, entryKey);
        const value = entryValue === map ? '(this Map)' : stringOf(frame, entryValue);
        frame.runtime.allocateString(frame, key.length + value.length + 1, 0);
        return `${key}=${value}`;
      });
    })
  );
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
  defineSetConstructors();
  defineNativeProperty(`${SET}.size`, (_frame, set) => storeOf(set).entries.length);
  const natives: Record<string, (frame: Frame, set: Value, args: Value[]) => Value> = {
    'isEmpty()': (_frame, set) => storeOf(set).entries.length === 0,
    'contains(E)': (frame, set, [element]) => findEntry(frame, storeOf(set), element) !== undefined,
    'containsAll(Collection<E>)': (frame, set, [elements]) => containsAll(frame, set, elements),
    'iterator()': (frame, set) => storeIterator(frame, set as KObject, 'keys'),
    'add(E)': (frame, set, [element]) => {
      requireMutableMap(frame, set);
      return addSetEntry(frame, set as KObject, element);
    },
    'remove(E)': (frame, set, [element]) => {
      if (isBuilt(set)) requireMutableMap(frame, set);
      const store = storeOf(set);
      const entry = findEntry(frame, store, element, true);
      if (!entry) return false;
      requireMutableMap(frame, set);
      store.remove(entry);
      touch(set as KObject);
      return true;
    },
    'addAll(Collection<E>)': (frame, set, [elements]) => {
      requireMutableMap(frame, set);
      return addSetElements(frame, set as KObject, elements);
    },
    'removeAll(Collection<E>)': (frame, set, [elements]) => {
      requireMutableMap(frame, set);
      return filterCollection(frame, set, elements, false, true);
    },
    'retainAll(Collection<E>)': (frame, set, [elements]) => {
      requireMutableMap(frame, set);
      return filterCollection(frame, set, elements, true, true);
    },
    'clear()': (frame, set) => {
      requireMutableMap(frame, set);
      storeOf(set).entries = [];
      touch(set as KObject);
      return UNIT;
    },
    'equals(Any?)': (frame, set, [other]) => setEquals(frame, set, other),
    'hashCode()': hashCollection,
    'toString()': renderCollection,
  };
  for (const [signature, native] of Object.entries(natives)) defineNative(`${SET}.${signature}`, native);
}

function addSetElements(frame: Frame, set: KObject, elements: Value): boolean {
  let changed = false;
  forEachIterable(frame, elements, (element) => {
    if (addSetEntry(frame, set, element)) changed = true;
  });
  return changed;
}

function addSetEntry(frame: Frame, set: KObject, element: Value): boolean {
  const store = storeOf(set);
  const size = store.entries.length;
  putEntry(frame, store, element, undefined);
  if (size === store.entries.length) return false;
  touch(set);
  return true;
}

function defineSetConstructors(): void {
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
      const store = newStore(order, jdkHashCapacity(Math.max(collectionSize(frame, elements), 12)));
      initializeSet(instance, store);
      addSetElements(frame, instance as KObject, elements);
      return UNIT;
    });
  }
}

function setEquals(frame: Frame, set: Value, other: Value): boolean {
  if (set === other) return true;
  if (!(other instanceof KObject) || !other.cls.isSubclassOf(libraryClass('kotlin.collections.Set'))) return false;
  if ((set as KObject).cls === libraryClass('kotlin.collections.EmptySet'))
    return callCollectionMember(frame, other, COLLECTION, 'isEmpty') === true;
  if (collectionSize(frame, other) !== collectionSize(frame, set)) return false;
  return compareCollections(() => callCollectionMember(frame, set, COLLECTION, 'containsAll', [other]) === true);
}

// Views of maps and iterators over stores.

type ViewKind = 'keys' | 'values' | 'entries';

function liveMapView(frame: Frame, map: KObject, kind: ViewKind): KObject {
  const state = (map.native ??= {});
  const views = (state.mapViews ??= {}) as Partial<Record<ViewKind, KObject>>;
  return (views[kind] ??= newView(frame, map, kind));
}

function newView(frame: Frame, map: KObject, view: ViewKind): KObject {
  if (map.readOnlyCollection) {
    return view === 'values' ? newList(frame, 'EmptyList', []) : setInstance(frame, 'EmptySet', newStore('insertion'));
  }
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
  if (!map || map.native?.isMapBuilder) return createEntry(frame, map, entry);
  let wrappers = entryWrappers.get(map);
  if (!wrappers) {
    wrappers = new WeakMap();
    entryWrappers.set(map, wrappers);
  }
  const present = wrappers.get(entry);
  if (present) return present;
  const wrapper = createEntry(frame, map, entry);
  wrappers.set(entry, wrapper);
  return wrapper;
}

function createEntry(frame: Frame, map: KObject | undefined, entry: HashEntry): KObject {
  frame.runtime.allocate(frame, 1);
  const object = new KObject(libraryClass('kotlin.collections.NativeEntry'), 0);
  object.native = { entry, map };
  return object;
}

function storeIterator(frame: Frame, collection: KObject, kind: ViewKind, map = collection): KObject {
  const iterator = new KObject(libraryClass('kotlin.collections.StoreIterator'), 0);
  iterator.readOnlyCollection = map.readOnlyCollection;
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
  for (const owner of ['kotlin.collections.MapKeysOrEntries', 'kotlin.collections.MapValues']) {
    defineViewReading(owner);
    defineViewChanging(owner);
  }
  defineStoreIterator();
  defineNativeEntry();
}

/** What reads the keys, values, or entries of a map, as views of it. */
function defineViewReading(owner: string): void {
  defineNativeProperty(`${owner}.size`, (_frame, view) => (viewOf(view).map.store as KStore).entries.length);
  defineNative(`${owner}.isEmpty()`, (_frame, view) => (viewOf(view).map.store as KStore).entries.length === 0);
  defineNative(
    `${owner}.contains(E)`,
    (frame, view, [element]) => matchingViewEntry(frame, view, element, false) !== undefined
  );
  defineNative(`${owner}.containsAll(Collection<E>)`, (frame, view, [elements]) => containsAll(frame, view, elements));
  defineNative(`${owner}.iterator()`, (frame, view) => {
    const { view: kind, map } = viewOf(view);
    return storeIterator(frame, view as KObject, kind, map);
  });
  defineNative(`${owner}.toString()`, renderCollection);
  defineNative(`${owner}.hashCode()`, (frame, view) =>
    viewOf(view).view === 'values' ? identityHash(view) : hashCollection(frame, view)
  );
  defineNative(`${owner}.equals(Any?)`, (frame, view, [other]) => {
    if (viewOf(view).view === 'values') return view === other;
    return setEquals(frame, view, other);
  });
}

function matchingViewEntry(frame: Frame, view: Value, element: Value, removing: boolean): HashEntry | undefined {
  const { view: kind, map } = viewOf(view);
  const store = storeOf(map);
  if (kind === 'keys') return findEntry(frame, store, element, removing);
  if (kind === 'values') return findMapValue(frame, store, element);
  return matchingEntry(frame, store, element, removing);
}

function findMapValue(frame: Frame, store: KStore, value: Value): HashEntry | undefined {
  if (store.isSingleton) return store.entries.find((entry) => valueEquals(frame, value, entry.value));
  return store.findOrdered((entry) => {
    frame.runtime.spend();
    return frame.runtime.withNativeRoots([entry.key, entry.value], () => objectsEqual(frame, value, entry.value));
  });
}

function matchingEntry(frame: Frame, store: KStore, element: Value, removing: boolean): HashEntry | undefined {
  const owner = 'kotlin.collections.Map.Entry';
  if (!(element instanceof KObject) || !element.cls.isSubclassOf(libraryClass(owner))) return undefined;
  const key = readCollectionProperty(frame, element, owner, 'key');
  if (removing) {
    const value = readCollectionProperty(frame, element, owner, 'value');
    const found = findEntry(frame, store, key, true);
    return found && objectsEqual(frame, value, found.value) ? found : undefined;
  }
  const found = findEntry(frame, store, key);
  if (!found || found === element.native?.entry) return found;
  if (!objectsEqual(frame, found.key, readCollectionProperty(frame, element, owner, 'key'))) return undefined;
  return objectsEqual(frame, found.value, readCollectionProperty(frame, element, owner, 'value')) ? found : undefined;
}

/** What changes a map through its keys, values, or entries, which remove from the map and never add to it. */
function defineViewChanging(owner: string): void {
  defineNative(`${owner}.remove(E)`, (frame, view, [element]) => {
    const { map, view: kind } = viewOf(view);
    if (storeOf(map).isSingleton)
      return removeFirstIterable(frame, view, (value) => valueEquals(frame, element, value));
    requireMutableMap(frame, map);
    if (kind === 'values') return removeFirstIterable(frame, view, (value) => objectsEqual(frame, element, value));
    const store = map.store as KStore;
    const entry = matchingViewEntry(frame, view, element, true);
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
      return filterCollection(frame, view, elements, name === 'retainAll', kind !== 'values');
    });
  }
  defineNative(`${owner}.clear()`, (frame, view) => {
    const { map } = viewOf(view);
    requireMutableMap(frame, map);
    (map.store as KStore).entries = [];
    touch(map);
    return UNIT;
  });
}

/** The iterator of a map's view, which removes the entry it returned last. */
// code-gauge-allow functionNcss 32 -- registers the natives of one class together, in the order the prelude declares them.
function defineStoreIterator(): void {
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
}

function defineNativeEntry(): void {
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
    const owner = 'kotlin.collections.Map.Entry';
    if (receiver === other) return true;
    if (!(other instanceof KObject) || !other.cls.isSubclassOf(libraryClass(owner))) return false;
    const { key, value } = entryOf(receiver).entry;
    return (
      objectsEqual(frame, key, readCollectionProperty(frame, other, owner, 'key')) &&
      objectsEqual(frame, value, readCollectionProperty(frame, other, owner, 'value'))
    );
  });
}

function finishBuild(_frame: Frame, collection: Value): Value {
  const object = collection as KObject;
  object.native = { ...object.native, isBuilt: true };
  return object;
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

function singletonStore(frame: Frame, key: Value, value: Value): KStore {
  frame.runtime.allocate(frame, 2);
  const store = newStore('insertion', 1);
  store.isSingleton = true;
  store.add({ key, value, hash: 0 });
  return store;
}

function mapGetOrDefault(frame: Frame, map: Value, [key, fallback]: Value[]): Value {
  const store = (map as KObject).store;
  if (store && store.order !== 'sorted' && !isBuilt(map)) {
    const entry = findEntry(frame, store, key);
    return entry ? entry.value : fallback;
  }
  const owner = 'kotlin.collections.Map';
  const value = callCollectionMember(frame, map, owner, 'get', [key]);
  return value !== undefined || callCollectionMember(frame, map, owner, 'containsKey', [key]) === true
    ? value
    : fallback;
}

function setOfValues(frame: Frame, name: string, order: KStore['order'], values: Value[], capacity: number): KObject {
  const store = newStore(order, capacity);
  for (const value of values) putEntry(frame, store, value, undefined);
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
    'mutableListOf()': (frame) => mutableListOfItems(frame, []),
    'mutableListOf(vararg T)': (frame, _receiver, [array]) => mutableListOfItems(frame, varargItems(array)),
    'arrayListOf()': (frame) => mutableListOfItems(frame, []),
    'arrayListOf(vararg T)': (frame, _receiver, [array]) => mutableListOfItems(frame, varargItems(array)),
    'setOf()': (frame) => setInstance(frame, 'EmptySet', newStore('insertion')),
    'setOf(T)': (frame, _receiver, [element]) =>
      setInstance(frame, 'SingletonSet', singletonStore(frame, element, undefined)),
    'setOf(vararg T)': (frame, _receiver, [array]) => {
      const values = varargItems(array);
      if (values.length === 0) return setInstance(frame, 'EmptySet', newStore('insertion'));
      if (values.length === 1) return setInstance(frame, 'SingletonSet', singletonStore(frame, values[0], undefined));
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
    'mapOf(Pair<K, V>)': (frame, _receiver, [pair]) => {
      const [key, value] = pairParts(pair);
      return newMap(frame, 'SingletonMap', singletonStore(frame, key, value));
    },
    'Map<out K, V>.getOrDefault(K, V)': mapGetOrDefault,
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
defineNative('kotlin.collections.LinkedHashSet<E>.finishBuild()', finishBuild);
defineNative('kotlin.collections.LinkedHashMap<K, V>.startBuild()', (_frame, collection) => {
  const map = collection as KObject;
  map.native = { ...map.native, isMapBuilder: true };
  return map;
});
defineNative('kotlin.collections.LinkedHashMap<K, V>.finishBuild()', finishBuild);
defineViews();
