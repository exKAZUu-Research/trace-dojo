import { valueEquals } from '../format';
import type { Frame } from '../runtime';
import { type HashEntry, KObject, type KStore, type Value } from '../values';
import {
  callCollectionMember,
  compareCollections,
  everyMapEntry,
  MAP,
  MAP_ENTRY,
  objectsEqual,
  readCollectionProperty,
} from './collectionTraversal';
import { libraryClass } from './registry';

export function mapEquals(frame: Frame, map: KObject, other: Value): boolean {
  if (map === other) return true;
  if (!(other instanceof KObject) || !other.cls.isSubclassOf(libraryClass(MAP))) return false;
  if (map.cls === libraryClass('kotlin.collections.EmptyMap')) {
    return callCollectionMember(frame, other, MAP, 'isEmpty') === true;
  }
  const store = map.store as KStore;
  if (readCollectionProperty(frame, other, MAP, 'size') !== readCollectionProperty(frame, map, MAP, 'size'))
    return false;
  const matches = (key: Value, value: Value): boolean =>
    frame.runtime.withNativeRoots([key, value], () => {
      const actual = callCollectionMember(frame, other, MAP, 'get', [key]);
      if (value !== undefined) return valueEquals(frame, value, actual);
      return actual === undefined && callCollectionMember(frame, other, MAP, 'containsKey', [key]) === true;
    });
  return compareCollections(() => {
    if (map.cls.isSubclassOf(libraryClass('kotlin.collections.HashMap'))) return everyMapEntry(frame, map, matches);
    return store.ordered().every(({ key, value }) => matches(key, value));
  });
}

export function mapEntryEquals(frame: Frame, entry: HashEntry, other: Value): boolean {
  if (!(other instanceof KObject) || !other.cls.isSubclassOf(libraryClass(MAP_ENTRY))) return false;
  return (
    entryComponentEquals(frame, entry.key, other, 'key') && entryComponentEquals(frame, entry.value, other, 'value')
  );
}

function entryComponentEquals(frame: Frame, value: Value, other: KObject, component: 'key' | 'value'): boolean {
  return frame.runtime.withNativeRoots([value], () =>
    objectsEqual(frame, value, readCollectionProperty(frame, other, MAP_ENTRY, component))
  );
}
