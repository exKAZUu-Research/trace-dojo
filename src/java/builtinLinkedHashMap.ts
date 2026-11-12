import { classType, touch } from './builtinCollectionSupport';
import { createStore, findEntry, nodeEntries, nodeMaps, removeEntry, storeOf, tableSizeFor } from './builtinMaps';
import { addConstructor, addMethod } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, type ClassInfo, FLOAT, INT, type JavaType } from './types';
import { formatFloat, type HashEntry, type JavaObject, type Value } from './values';

/** The maps that order their entries by access, which `new LinkedHashMap<>(capacity, loadFactor, true)` makes. */
const accessOrderedMaps = new WeakSet<JavaObject>();

/** What a `LinkedHashMap` and its subclasses do after adding an entry: remove the eldest if `removeEldestEntry` says. */
const evictions = new WeakMap<ClassInfo, (frame: Frame, map: JavaObject) => void>();

export function evictionOf(cls: ClassInfo): ((frame: Frame, map: JavaObject) => void) | undefined {
  for (let current: ClassInfo | undefined = cls; current; current = current.superclass) {
    const eviction = evictions.get(current);
    if (eviction) return eviction;
  }
}

/**
 * Moves an entry an access-ordered map reads or writes to its end, which counts as a structural change only when the
 * entry was not already last, as in the JDK.
 */
export function recordAccess(map: Value, entry: HashEntry): void {
  if (!accessOrderedMaps.has(map as JavaObject)) return;
  if (storeOf(map).moveToEnd(entry)) touch(map);
}

/** The entry of `key`, which an access-ordered map moves to its end, as reading or writing it does. */
export function accessedEntry(frame: Frame, map: Value, key: Value): HashEntry | undefined {
  const entry = findEntry(frame, map, key);
  if (entry) recordAccess(map, entry);
  return entry;
}

/**
 * The constructors that choose a `LinkedHashMap`'s order, and `removeEldestEntry`, which it asks after each addition
 * whether to remove its eldest entry, as an LRU cache that overrides it does.
 */
export function defineLinkedHashMapOrder(cls: ClassInfo, entryClass: ClassInfo, nodeClass: ClassInfo): void {
  const [key, value] = cls.typeParameters.map((variable): JavaType => ({ kind: 'typeVar', variable }));
  for (const parameterTypes of [
    [INT, FLOAT],
    [INT, FLOAT, BOOLEAN],
  ]) {
    addConstructor(cls, parameterTypes, (frame, receiver, [capacity, loadFactor, accessOrder]) => {
      if ((capacity as number) < 0) {
        throwBuiltin(frame, 'IllegalArgumentException', `Illegal initial capacity: ${capacity as number}`);
      }
      if (!((loadFactor as number) > 0)) {
        throwBuiltin(frame, 'IllegalArgumentException', `Illegal load factor: ${formatFloat(loadFactor as number)}`);
      }
      createStore(receiver, tableSizeFor(capacity as number));
      if (accessOrder === true) accessOrderedMaps.add(receiver as JavaObject);
    });
  }
  const removeEldestEntry = addMethod(
    cls,
    'removeEldestEntry',
    [classType(entryClass, key as JavaType, value as JavaType)],
    BOOLEAN,
    false,
    () => false
  );
  removeEldestEntry.access = 'protected';
  evictions.set(cls, (frame, map) => {
    const eldest = storeOf(map).ordered()[0];
    if (!eldest) return;
    const node = frame.runtime.allocateObject(frame, nodeClass);
    nodeEntries.set(node, eldest);
    nodeMaps.set(node, map);
    if (frame.runtime.invokeVirtual(frame, cls, 'removeEldestEntry', map, [node]) === true) {
      removeEntry(frame, map, eldest.key);
    }
  });
}
