import { removeEntry } from './builtinCollections';
import {
  checkModifiable,
  itemsOf,
  type MapViewSource,
  mapViewSources,
  removeElements,
} from './builtinCollectionSupport';
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
    // The positions the predicate picks, as a stateful predicate may pick one of two equal elements.
    const picked = items.map((item) => matches(item));
    check();
    if (!picked.includes(true)) return false;
    checkModifiable(frame, receiver, true);
    return removeElements(frame, receiver, (_, index) => picked[index] === true);
  }
  const view = mapViewSources.get(collection);
  if (view) return removeFromView(frame, collection, view, matches);
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
