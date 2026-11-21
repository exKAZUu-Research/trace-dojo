import { valueEquals } from '../format';
import type { Frame } from '../runtime';
import { indexedSize, KObject, listView, primitiveArrayView, type Value } from '../values';
import {
  callCollectionMember,
  COLLECTION,
  collectionIterator,
  collectionSize,
  objectsEqual,
} from './collectionTraversal';
import { libraryClass, throwError } from './registry';

const LIST = 'kotlin.collections.List';

export function listEquals(frame: Frame, list: KObject, other: Value): boolean {
  if (list === other) return true;
  if (!(other instanceof KObject) || !other.cls.isSubclassOf(libraryClass(LIST))) return false;
  const view = listView(list);
  const source = view?.source ?? list;
  if (source.arrayList) return arrayListEquals(frame, list, source, other);
  if (source.cls === libraryClass('kotlin.collections.EmptyList'))
    return callCollectionMember(frame, other, COLLECTION, 'isEmpty') === true;
  if (source.cls === libraryClass('kotlin.collections.ListBuilder')) return builderEquals(frame, list, source, other);
  if (primitiveArrayView(list) || source.cls === libraryClass('kotlin.collections.EnumEntriesList'))
    return sizedIterableEquals(frame, list, other);
  return listIteratorEquals(frame, list, other);
}

function arrayListEquals(frame: Frame, list: KObject, source: KObject, other: KObject): boolean {
  const view = listView(list);
  const items = source.items as Value[];
  const from = view?.from ?? 0;
  const size = indexedSize(list);
  const expected = source.modCount;
  let equal: boolean;
  if (!view && other.cls === libraryClass('kotlin.collections.ArrayList')) {
    equal = exactArrayListEquals(frame, items, size, other);
  } else {
    const iterator = collectionIterator(frame, other);
    equal = frame.runtime.withNativeRoots([items, iterator.value], () => {
      for (let i = from; i < from + size; i++) {
        if (!iterator.hasNext() || !objectsEqual(frame, items[i], iterator.next())) return false;
      }
      return !iterator.hasNext();
    });
  }
  checkVersion(frame, source, expected);
  return equal;
}

function exactArrayListEquals(frame: Frame, items: Value[], size: number, other: KObject): boolean {
  const otherItems = other.items as Value[];
  const expected = other.modCount;
  const equal = frame.runtime.withNativeRoots([items, otherItems], () => {
    if (size !== indexedSize(other)) return false;
    for (let i = 0; i < size; i++) {
      if (i % 64 === 0) frame.runtime.spend();
      if (!objectsEqual(frame, items[i], otherItems[i])) return false;
    }
    return true;
  });
  checkVersion(frame, other, expected);
  return equal;
}

function checkVersion(frame: Frame, list: KObject, expected: number | undefined): void {
  if (list.modCount !== expected) throwError(frame, 'java.util.ConcurrentModificationException');
}

function builderEquals(frame: Frame, list: KObject, source: KObject, other: KObject): boolean {
  const items = source.items as Value[];
  const from = listView(list)?.from ?? 0;
  const size = indexedSize(list);
  if (size !== collectionSize(frame, other)) return false;
  return frame.runtime.withNativeRoots([items], () => {
    for (let index = 0; index < size; index++) {
      if (!valueEquals(frame, items[from + index], callCollectionMember(frame, other, LIST, 'get', [index])))
        return false;
    }
    return true;
  });
}

function sizedIterableEquals(frame: Frame, list: KObject, other: KObject): boolean {
  if (indexedSize(list) !== collectionSize(frame, other)) return false;
  const right = collectionIterator(frame, other);
  return frame.runtime.withNativeRoots([right.value], () => {
    const left = collectionIterator(frame, list);
    return frame.runtime.withNativeRoots([left.value], () => {
      while (left.hasNext()) {
        if (!valueEquals(frame, left.next(), right.next())) return false;
      }
      return true;
    });
  });
}

function listIteratorEquals(frame: Frame, list: KObject, other: KObject): boolean {
  const left = collectionIterator(frame, list, 'listIterator');
  return frame.runtime.withNativeRoots([left.value], () => {
    const right = collectionIterator(frame, other, 'listIterator');
    return frame.runtime.withNativeRoots([right.value], () => {
      while (left.hasNext() && right.hasNext()) {
        if (!valueEquals(frame, left.next(), right.next())) return false;
      }
      return !left.hasNext() && !right.hasNext();
    });
  });
}
