import { callFunction, getPropertyValue } from '../dispatch';
import { valueEquals } from '../format';
import { type Frame, KotlinThrow } from '../runtime';
import type { FunctionSymbol } from '../symbols';
import type { KObject, Value } from '../values';
import { libraryClass, throwError } from './registry';

export const MAP = 'kotlin.collections.Map';
export const MAP_ENTRY = 'kotlin.collections.Map.Entry';
export const COLLECTION = 'kotlin.collections.Collection';
const MUTABLE_COLLECTION = 'kotlin.collections.MutableCollection';

/** Reads an iterable of the program through its iterator, as the library's functions do. */
export function iterateElements(frame: Frame, iterable: KObject): Value[] {
  const result: Value[] = [];
  frame.runtime.withNativeRoots([result], () => forEachIterable(frame, iterable, (element) => result.push(element)));
  return result;
}

export function copyCollectionToArray(frame: Frame, collection: KObject): Value[] {
  let capacity = collectionSize(frame, collection);
  if (capacity === 0) return [];
  const iterator = collectionIterator(frame, collection);
  const items: Value[] = [];
  return frame.runtime.withNativeRoots([iterator.value, items], () => {
    if (!iterator.hasNext()) return items;
    if (capacity < 0) throwError(frame, 'java.lang.NegativeArraySizeException', String(capacity));
    frame.runtime.allocate(frame, capacity);
    do {
      if (items.length === capacity) {
        capacity = Math.floor((capacity * 3 + 1) / 2);
        frame.runtime.allocate(frame, capacity);
      }
      items.push(iterator.next());
    } while (iterator.hasNext());
    return items;
  });
}

export function forEachIterable(frame: Frame, iterable: Value, visit: (element: Value) => void): void {
  everyIterableElement(frame, iterable, (element) => {
    visit(element);
    return true;
  });
}

export function everyIterableElement(
  frame: Frame,
  iterable: Value,
  accepts: (element: Value, iterator: Value) => boolean
): boolean {
  const iterator = collectionIterator(frame, iterable);
  return frame.runtime.withNativeRoots([iterator.value], () => {
    while (iterator.hasNext()) {
      if (!accepts(iterator.next(), iterator.value)) return false;
    }
    return true;
  });
}

export function everyMapEntry(frame: Frame, map: Value, visit: (key: Value, value: Value) => boolean): boolean {
  const entries = readCollectionProperty(frame, map, MAP, 'entries');
  return everyIterableElement(frame, entries, (entry) =>
    frame.runtime.withNativeRoots([entry], () => {
      const key = readCollectionProperty(frame, entry, MAP_ENTRY, 'key');
      return frame.runtime.withNativeRoots([key], () => {
        const value = readCollectionProperty(frame, entry, MAP_ENTRY, 'value');
        return frame.runtime.withNativeRoots([value], () => visit(key, value));
      });
    })
  );
}

export function collectionIterator(
  frame: Frame,
  receiver: Value,
  method: 'iterator' | 'listIterator' = 'iterator'
): { value: Value; hasNext: () => boolean; next: () => Value } {
  const owner = method === 'iterator' ? 'kotlin.collections.Iterable' : 'kotlin.collections.List';
  const iterator = 'kotlin.collections.Iterator';
  const value = callCollectionMember(frame, receiver, owner, method);
  return {
    value,
    hasNext: () => callCollectionMember(frame, value, iterator, 'hasNext') === true,
    next: () => callCollectionMember(frame, value, iterator, 'next'),
  };
}

export function callCollectionMember(
  frame: Frame,
  receiver: Value,
  owner: string,
  name: string,
  args: Value[] = []
): Value {
  const member = libraryClass(owner)
    .members.get(name)
    ?.find(
      (candidate): candidate is FunctionSymbol =>
        candidate.kind === 'function' && candidate.params.length === args.length
    );
  if (!member) throw new Error(`No function ${owner}.${name}`);
  return callFunction(member, frame, receiver, args, undefined);
}

export function collectionContains(frame: Frame, collection: Value, element: Value): boolean {
  return callCollectionMember(frame, collection, COLLECTION, 'contains', [element]) === true;
}

export function containsAll(frame: Frame, receiver: Value, elements: Value): boolean {
  return everyIterableElement(frame, elements, (element) => collectionContains(frame, receiver, element));
}

export function removeFirstIterable(frame: Frame, iterable: Value, matches: (element: Value) => boolean): boolean {
  return !everyIterableElement(frame, iterable, (element, iterator) => {
    if (!matches(element)) return true;
    callCollectionMember(frame, iterator, 'kotlin.collections.MutableIterator', 'remove');
    return false;
  });
}

export function filterCollection(
  frame: Frame,
  receiver: Value,
  elements: Value,
  retain: boolean,
  usesSetRemoval: boolean
): boolean {
  let changed = false;
  if (!retain && usesSetRemoval && collectionSize(frame, receiver) > collectionSize(frame, elements)) {
    everyIterableElement(frame, elements, (element) => {
      if (callCollectionMember(frame, receiver, MUTABLE_COLLECTION, 'remove', [element]) === true) changed = true;
      return true;
    });
  } else {
    everyIterableElement(frame, receiver, (element, iterator) => {
      if (collectionContains(frame, elements, element) !== retain) {
        callCollectionMember(frame, iterator, 'kotlin.collections.MutableIterator', 'remove');
        changed = true;
      }
      return true;
    });
  }
  return changed;
}

export function readCollectionProperty(frame: Frame, receiver: Value, owner: string, name: string): Value {
  const property = libraryClass(owner)
    .members.get(name)
    ?.find((member) => member.kind === 'property');
  if (!property) throw new Error(`No property ${owner}.${name}`);
  return getPropertyValue(property, frame, receiver);
}

export function collectionSize(frame: Frame, collection: Value): number {
  return readCollectionProperty(frame, collection, COLLECTION, 'size') as number;
}

export function compareCollections(compare: () => boolean): boolean {
  try {
    return compare();
  } catch (error) {
    if (
      error instanceof KotlinThrow &&
      (error.value.cls.isSubclassOf(libraryClass('kotlin.ClassCastException')) ||
        error.value.cls.isSubclassOf(libraryClass('kotlin.NullPointerException')))
    )
      return false;
    throw error;
  }
}

export function objectsEqual(frame: Frame, left: Value, right: Value): boolean {
  return left === right || valueEquals(frame, left, right);
}
