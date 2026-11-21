import { callFunction, getPropertyValue } from '../dispatch';
import { type Frame, KotlinThrow } from '../runtime';
import type { KObject, Value } from '../values';
import { libraryClass } from './registry';

export const COLLECTION = 'kotlin.collections.Collection';
const MUTABLE_COLLECTION = 'kotlin.collections.MutableCollection';

/** Reads an iterable of the program through its iterator, as the library's functions do. */
export function iterateElements(frame: Frame, iterable: KObject): Value[] {
  const result: Value[] = [];
  everyIterableElement(frame, iterable, (element) => {
    result.push(element);
    return true;
  });
  return result;
}

function everyIterableElement(
  frame: Frame,
  iterable: Value,
  accepts: (element: Value, iterator: Value) => boolean
): boolean {
  const iteratorClass = 'kotlin.collections.Iterator';
  const iterator = callCollectionMember(frame, iterable, 'kotlin.collections.Iterable', 'iterator');
  frame.runtime.nativeRoots.push(iterator);
  try {
    while (callCollectionMember(frame, iterator, iteratorClass, 'hasNext') === true) {
      if (!accepts(callCollectionMember(frame, iterator, iteratorClass, 'next'), iterator)) return false;
    }
    return true;
  } finally {
    frame.runtime.nativeRoots.pop();
  }
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
    ?.find((candidate) => candidate.kind === 'function');
  if (!member) throw new Error(`No function ${owner}.${name}`);
  return callFunction(member, frame, receiver, args, undefined);
}

export function collectionContains(frame: Frame, collection: Value, element: Value): boolean {
  return callCollectionMember(frame, collection, COLLECTION, 'contains', [element]) === true;
}

export function containsAll(frame: Frame, receiver: Value, elements: Value): boolean {
  return everyIterableElement(frame, elements, (element) => collectionContains(frame, receiver, element));
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
