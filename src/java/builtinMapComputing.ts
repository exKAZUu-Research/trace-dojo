import { findEntry, javaEquals, putEntry, removeEntry } from './builtinCollections';
import { checkModifiable, uncountedMapClasses } from './builtinCollectionSupport';
import { callFunction } from './builtinFunctions';
import { classType, extendsOf, superOf } from './builtinStreamSupport';
import { addMethod } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, type ClassInfo, type JavaType, VOID } from './types';
import { type HashEntry, type HashStore, type JavaObject, type Value } from './values';

/** The functional interfaces the compute methods take. */
interface ComputeFunctions {
  biFunction: ClassInfo;
}

/**
 * `Map.compute` and `Map.computeIfPresent`, which remove the key when the function returns null, `remove` of a key only
 * with a given value, and `replace`.
 */
export function defineMapRemappings(
  mapClass: ClassInfo,
  functions: ComputeFunctions,
  mapK: JavaType,
  mapV: JavaType
): void {
  const remappingType = classType(functions.biFunction, superOf(mapK), superOf(mapV), extendsOf(mapV));
  addMethod(mapClass, 'compute', [mapK, remappingType], mapV, false, (frame, receiver, [key, remapping]) => {
    const current = startComputing(frame, receiver, key)?.value;
    const value = unchanging(frame, receiver, () =>
      callFunction(frame, functions.biFunction, remapping, [key, current])
    );
    return putComputed(frame, receiver, key, value);
  });
  addMethod(mapClass, 'computeIfPresent', [mapK, remappingType], mapV, false, (frame, receiver, [key, remapping]) => {
    checkModifiable(frame, receiver, false);
    const current = findEntry(frame, receiver, key)?.value;
    if (current === undefined) return;
    const value = unchanging(frame, receiver, () =>
      callFunction(frame, functions.biFunction, remapping, [key, current])
    );
    return putComputed(frame, receiver, key, value);
  });
  defineMapReplaceAll(mapClass, functions, mapK, mapV);
  const objectType = mapClass.typeParameters[0].bounds[0] as JavaType;
  addMethod(mapClass, 'remove', [objectType, objectType], BOOLEAN, false, (frame, receiver, [key, value]) => {
    checkModifiable(frame, receiver, false);
    const entry = findEntry(frame, receiver, key);
    if (!entry || !javaEquals(frame, entry.value, value)) return false;
    removeEntry(frame, receiver, key);
    return true;
  });
  addMethod(mapClass, 'replace', [mapK, mapV], mapV, false, (frame, receiver, [key, value]) => {
    checkModifiable(frame, receiver, false);
    const entry = findEntry(frame, receiver, key);
    if (!entry) return;
    const previous = entry.value;
    entry.value = value;
    return previous;
  });
}

/**
 * `Map.replaceAll`, which replaces each value, in iteration order, by what the function gives for its entry; a change
 * the function makes to the map fails with `ConcurrentModificationException`, after each entry for a sorted map and
 * after the last one for a hash map, as the JDK's do.
 */
function defineMapReplaceAll(mapClass: ClassInfo, functions: ComputeFunctions, mapK: JavaType, mapV: JavaType): void {
  const functionType = classType(functions.biFunction, superOf(mapK), superOf(mapV), extendsOf(mapV));
  addMethod(mapClass, 'replaceAll', [functionType], VOID, false, (frame, receiver, [fn]) => {
    if (fn === undefined) throwBuiltin(frame, 'NullPointerException');
    checkModifiable(frame, receiver, false);
    const map = receiver as JavaObject;
    const store = map.store;
    if (!store) return throwBuiltin(frame, 'UnsupportedOperationException');
    const apply = (entry: HashEntry): void => {
      entry.value = callFunction(frame, functions.biFunction, fn, [entry.key, entry.value]);
    };
    if (failsFast(map)) replaceFailingFast(frame, map, store, apply);
    else replaceLive(store, apply);
  });
}

/** Starts `computeIfAbsent`, `compute`, or `merge`, which grow a HashMap's table first, as the JDK's do. */
export function startComputing(frame: Frame, receiver: Value, key: Value): ReturnType<typeof findEntry> {
  checkModifiable(frame, receiver, false);
  (receiver as JavaObject).store?.growBeforeCompute();
  return findEntry(frame, receiver, key);
}

/**
 * Calls the function of a compute method, which fails with `ConcurrentModificationException` when it changes the map's
 * structure, as HashMap's and TreeMap's check.
 */
export function unchanging(frame: Frame, receiver: Value, call: () => Value): Value {
  const map = receiver as JavaObject;
  const expectedModCount = map.modCount;
  const value = call();
  if (failsFast(map) && map.modCount !== expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
  return value;
}

/** Whether the map's JDK class counts its changes, which an EnumMap does not. */
function failsFast(map: JavaObject): boolean {
  for (let cls: ClassInfo | undefined = map.cls; cls; cls = cls.superclass) {
    if (uncountedMapClasses.has(cls)) return false;
  }
  return true;
}

/** Replaces each value as a hash or tree map does, failing after each entry for a sorted map and at the end. */
function replaceFailingFast(frame: Frame, map: JavaObject, store: HashStore, apply: (entry: HashEntry) => void): void {
  const expectedModCount = map.modCount;
  const check = (): void => {
    if (map.modCount !== expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
  };
  for (const entry of store.ordered()) {
    apply(entry);
    if (store.compare) check();
  }
  check();
}

/** Replaces each value as Map's default does through an EnumMap's live iterator, which reaches keys added after it. */
function replaceLive(store: HashStore, apply: (entry: HashEntry) => void): void {
  for (let index = 0; index < store.ordered().length; index++) {
    const entry = store.ordered()[index] as HashEntry;
    apply(entry);
    index = Math.max(index, store.ordered().indexOf(entry));
  }
}

/** Maps the key to a computed value, or removes it for null, returning the value. */
export function putComputed(frame: Frame, receiver: Value, key: Value, value: Value): Value {
  if (value === undefined) removeEntry(frame, receiver, key);
  else putEntry(frame, receiver, key, false, value, true);
  return value;
}
