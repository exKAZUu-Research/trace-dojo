import { valueEquals } from '../format';
import type { Frame } from '../runtime';
import { KObject, type KStore, type Value } from '../values';
import {
  callCollectionMember,
  compareCollections,
  everyIterableElement,
  readCollectionProperty,
} from './collectionTraversal';
import { libraryClass } from './registry';

const MAP = 'kotlin.collections.Map';
const ENTRY = 'kotlin.collections.Map.Entry';

export function mapEquals(frame: Frame, map: KObject, other: Value): boolean {
  if (map === other) return true;
  if (!(other instanceof KObject) || !other.cls.isSubclassOf(libraryClass(MAP))) return false;
  if (map.cls === libraryClass('kotlin.collections.EmptyMap')) {
    return callCollectionMember(frame, other, MAP, 'isEmpty') === true;
  }
  const store = map.store as KStore;
  if (store.entries.length !== readCollectionProperty(frame, other, MAP, 'size')) return false;
  const matches = (key: Value, value: Value): boolean =>
    frame.runtime.withNativeRoots([key, value], () => {
      const actual = callCollectionMember(frame, other, MAP, 'get', [key]);
      if (value !== undefined) return valueEquals(frame, value, actual);
      return actual === undefined && callCollectionMember(frame, other, MAP, 'containsKey', [key]) === true;
    });
  return compareCollections(() => {
    if (map.cls.name === 'HashMap' || map.cls.name === 'LinkedHashMap') {
      const entries = readCollectionProperty(frame, map, MAP, 'entries');
      return everyIterableElement(frame, entries, (entry) =>
        matches(
          readCollectionProperty(frame, entry, ENTRY, 'key'),
          readCollectionProperty(frame, entry, ENTRY, 'value')
        )
      );
    }
    return store.ordered().every(({ key, value }) => matches(key, value));
  });
}
