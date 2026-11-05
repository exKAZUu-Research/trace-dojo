import { removeEntry } from './builtinCollections';
import {
  batchRemovalClasses,
  checkModifiable,
  defaultRemoveClasses,
  itemsOf,
  type MapViewSource,
  mapViewSources,
  removeElements,
} from './builtinCollectionSupport';
import { type Frame, throwBuiltin } from './runtime';
import { type ClassInfo } from './types';
import { type JavaObject, type Value } from './values';

/**
 * `removeIf`, which fails with `ConcurrentModificationException` when the predicate changes the collection: an
 * ArrayList tests every position it had and then removes none, and other collections remove each match through their
 * iterator as they go and fail at the next element or removal, as Collection's default does.
 */
export function removeMatching(frame: Frame, receiver: Value, matches: (item: Value) => boolean): boolean {
  const collection = receiver as JavaObject;
  const elements = Object.getOwnPropertyDescriptor(collection, 'elements')?.value as unknown;
  if (Array.isArray(elements)) {
    return removesInBatch(collection.cls)
      ? removeMatchingPositions(frame, collection, elements as Value[], matches)
      : removeThroughListIterator(frame, collection, elements as Value[], matches);
  }
  const view = mapViewSources.get(collection);
  if (view) return removeFromView(frame, collection, view, matches);
  const items = [...itemsOf(frame, receiver)];
  let expectedModCount = collection.modCount;
  const check = (): void => {
    if (collection.modCount !== expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
  };
  let isRemoved = false;
  for (const item of items) {
    check();
    if (!matches(item)) continue;
    check();
    isRemoved = removeAllOf(frame, receiver, [item]) || isRemoved;
    expectedModCount = collection.modCount;
  }
  return isRemoved;
}

/**
 * `removeIf` on a list, which tests the element at each position it had, as its array holds it then, and then
 * removes the positions it picked, as ArrayList's does.
 */
function removeMatchingPositions(
  frame: Frame,
  collection: JavaObject,
  elements: Value[],
  matches: (item: Value) => boolean
): boolean {
  const expectedModCount = collection.modCount;
  const end = elements.length;
  const picked: boolean[] = [];
  for (let index = 0; index < end; index++) picked.push(matches(elements[index]));
  if (collection.modCount !== expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
  if (!picked.includes(true)) return false;
  checkModifiable(frame, collection, true);
  return removeElements(frame, collection, (_, index) => picked[index] === true);
}

function removesInBatch(cls: ClassInfo): boolean {
  for (let current: ClassInfo | undefined = cls; current; current = current.superclass) {
    if (batchRemovalClasses.has(current)) return true;
  }
  return false;
}

/**
 * `removeIf` through a list's iterator, which removes each match at its position as it reaches it, so that a
 * predicate that throws leaves the earlier matches removed, as for a LinkedList or `Arrays.asList`'s list.
 */
function removeThroughListIterator(
  frame: Frame,
  collection: JavaObject,
  elements: Value[],
  matches: (item: Value) => boolean
): boolean {
  let expectedModCount = collection.modCount;
  let isRemoved = false;
  for (let index = 0; index < elements.length;) {
    if (collection.modCount !== expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
    if (!matches(elements[index])) {
      index++;
      continue;
    }
    if (collection.modCount !== expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
    if (defaultRemoveClasses.has(collection.cls)) throwBuiltin(frame, 'UnsupportedOperationException', 'remove');
    checkModifiable(frame, collection, true);
    const position = index;
    removeElements(frame, collection, (_, candidate) => candidate === position);
    expectedModCount = collection.modCount;
    isRemoved = true;
  }
  return isRemoved;
}

/** `removeIf` on a map's view, which reads the entries once and removes each matching one from the map as it goes. */
function removeFromView(
  frame: Frame,
  collection: JavaObject,
  view: MapViewSource,
  matches: (item: Value) => boolean
): boolean {
  let expectedModCount = collection.modCount;
  let isRemoved = false;
  for (const entry of view.entries()) {
    if (collection.modCount !== expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
    if (!matches(view.elementOf(entry))) continue;
    // The iterator's remove checks for a change the predicate made first.
    if (collection.modCount !== expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
    view.remove(frame, entry);
    expectedModCount = collection.modCount;
    isRemoved = true;
  }
  return isRemoved;
}

/** Removes the items in `removed` from a list, a set, or a view of a map, returning whether there were any. */
export function removeAllOf(frame: Frame, receiver: Value, removed: Value[]): boolean {
  if (removed.length === 0) return false;
  checkModifiable(frame, receiver, true);
  const object = receiver as JavaObject;
  if (object.elements) return removeElements(frame, receiver, (item) => removed.includes(item));
  for (const item of removed) removeEntry(frame, receiver, item);
  object.modCount = (object.modCount ?? 0) + 1;
  return true;
}
