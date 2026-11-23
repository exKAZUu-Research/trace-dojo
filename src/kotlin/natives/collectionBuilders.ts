import { valueEquals } from '../format';
import { type Frame, KotlinThrow } from '../runtime';
import { type HashEntry, KObject, UNIT, type Value } from '../values';
import { BuilderStore } from './builderStore';
import {
  callCollectionMember,
  COLLECTION,
  collectionSize,
  everyIterableElement,
  MAP,
  MAP_ENTRY,
  readCollectionProperty,
} from './collectionTraversal';
import { defineNative, libraryClass, throwError } from './registry';

export function defineCollectionBuilders(touch: (object: KObject) => void): void {
  for (const name of ['SetBuilder', 'MapBuilder'] as const) {
    const owner = `kotlin.collections.${name}`;
    defineNative(`${owner}.<init>(Int)`, (frame, receiver, [capacity]) => {
      initializeBuilder(frame, receiver as KObject, capacity as number, touch);
      return UNIT;
    });
    defineNative(`${owner}.build()`, (frame, receiver) => finishBuild(frame, receiver as KObject, touch));
  }
}

function initializeBuilder(frame: Frame, object: KObject, capacity: number, touch: (object: KObject) => void): void {
  object.store = new BuilderStore(checkedBuilderCapacity(frame, capacity), () => touch(object));
  object.modCount = 0;
  if (object.cls.name === 'SetBuilder') object.native = { isSet: true };
}

function finishBuild(frame: Frame, object: KObject, touch: (object: KObject) => void): KObject {
  if (object.native?.isBuilt) throwError(frame, 'java.lang.UnsupportedOperationException');
  (object.native ??= {}).isBuilt = true;
  if (object.store?.entries.length) return object;
  const existing = frame.runtime.objects.get(object.cls);
  if (existing) return existing;
  frame.runtime.allocate(frame, 1);
  const empty = new KObject(object.cls, 0);
  initializeBuilder(frame, empty, 0, touch);
  (empty.native ??= {}).isBuilt = true;
  frame.runtime.objects.set(object.cls, empty);
  return empty;
}

export function checkedBuilderCapacity(frame: Frame, capacity: number): number {
  if (capacity < 0) throwError(frame, 'java.lang.IllegalArgumentException', 'capacity must be non-negative.');
  frame.runtime.allocate(frame, capacity);
  return capacity;
}

export function copyBuilderEntries(frame: Frame, store: BuilderStore, source: Value): void {
  const entries = readCollectionProperty(frame, source, MAP, 'entries');
  frame.runtime.withNativeRoots([entries], () => {
    if (callCollectionMember(frame, entries, COLLECTION, 'isEmpty') === true) return;
    store.reserve(frame, collectionSize(frame, entries));
    everyIterableElement(frame, entries, (element) =>
      frame.runtime.withNativeRoots([element], () => {
        const key = readCollectionProperty(frame, element, MAP_ENTRY, 'key');
        const { entry, added } = frame.runtime.withNativeRoots([key], () => store.addKey(frame, key));
        const value = readCollectionProperty(frame, element, MAP_ENTRY, 'value');
        if (added) entry.value = value;
        else if (!valueEquals(frame, value, entry.value)) {
          entry.value = readCollectionProperty(frame, element, MAP_ENTRY, 'value');
        }
        return true;
      })
    );
  });
}

export function builderMapEquals(frame: Frame, store: BuilderStore, other: KObject): boolean {
  if (store.entries.length !== readCollectionProperty(frame, other, MAP, 'size')) return false;
  const entries = readCollectionProperty(frame, other, MAP, 'entries');
  return everyIterableElement(frame, entries, (element) => {
    try {
      return matchingBuilderEntry(frame, store, element) !== undefined;
    } catch (error) {
      if (error instanceof KotlinThrow && error.value.cls.isSubclassOf(libraryClass('kotlin.ClassCastException')))
        return false;
      throw error;
    }
  });
}

export function matchingBuilderEntry(frame: Frame, store: BuilderStore, element: Value): HashEntry | undefined {
  if (!(element instanceof KObject) || !element.cls.isSubclassOf(libraryClass(MAP_ENTRY))) return undefined;
  return frame.runtime.withNativeRoots([element], () => {
    const key = readCollectionProperty(frame, element, MAP_ENTRY, 'key');
    const entry = frame.runtime.withNativeRoots([key], () => store.lookup(frame, key));
    if (!entry) return;
    const stored = entry.value;
    return frame.runtime.withNativeRoots([stored], () => {
      const value = readCollectionProperty(frame, element, MAP_ENTRY, 'value');
      return valueEquals(frame, stored, value) ? entry : undefined;
    });
  });
}
