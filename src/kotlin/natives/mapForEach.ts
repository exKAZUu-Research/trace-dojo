import { invokeFunctionValue } from '../lambdaValue';
import type { Frame } from '../runtime';
import { type KObject, type KStore, UNIT, type Value } from '../values';
import { everyMapEntry } from './collectionTraversal';
import { defineNative, libraryClass, throwError } from './registry';

export function defineMapForEach(): void {
  defineNative('kotlin.collections.Map<out K, V>.forEach((K, V) -> Unit)', (frame, receiver, [action]) => {
    forEachMap(frame, receiver as KObject, action as KObject);
    return UNIT;
  });
}

function forEachMap(frame: Frame, map: KObject, action: KObject): void {
  const visit = (key: Value, value: Value): boolean => {
    invokeFunctionValue(frame, action, [key, value]);
    return false;
  };
  if (map.cls.isSubclassOf(libraryClass('kotlin.collections.HashMap'))) {
    const version = map.modCount;
    (map.store as KStore).findOrdered(({ key, value }) => visit(key, value));
    if (map.modCount !== version) throwError(frame, 'java.util.ConcurrentModificationException');
    return;
  }
  everyMapEntry(frame, map, (key, value) => {
    visit(key, value);
    return true;
  });
}
