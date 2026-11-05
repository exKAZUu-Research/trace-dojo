import { removeEntry } from './builtinCollections';
import { checkModifiable, itemsOf, removeElements } from './builtinCollectionSupport';
import { type Frame, throwBuiltin } from './runtime';
import { type JavaObject, type Value } from './values';

/**
 * `removeIf`, which fails with `ConcurrentModificationException` when the predicate changes the collection: a list
 * tests every element it had and then removes none, as ArrayList's does, and other collections remove each match
 * through their iterator as they go and fail at the next element, as Collection's default does.
 */
export function removeMatching(frame: Frame, receiver: Value, matches: (item: Value) => boolean): boolean {
  const collection = receiver as JavaObject;
  const items = [...itemsOf(frame, receiver)];
  let expectedModCount = collection.modCount;
  const check = (): void => {
    if (collection.modCount !== expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
  };
  if (Array.isArray(Object.getOwnPropertyDescriptor(collection, 'elements')?.value)) {
    const removed = items.filter((item) => matches(item));
    check();
    return removeAllOf(frame, receiver, removed);
  }
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
