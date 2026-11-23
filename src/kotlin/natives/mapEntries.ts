import { hashOf, stringOf, valueEquals } from '../format';
import type { Frame } from '../runtime';
import { type HashEntry, KObject, type Value } from '../values';
import { BuilderStore } from './builderStore';
import { MAP_ENTRY, readCollectionProperty } from './collectionTraversal';
import { mapEntryEquals } from './mapEquality';
import { defineNative, defineNativeProperty, libraryClass, throwError } from './registry';

interface EntryState {
  entry: HashEntry;
  map: KObject | undefined;
  expectedModCount: number | undefined;
}

const entryWrappers = new WeakMap<KObject, WeakMap<HashEntry, KObject>>();

export function newEntry(frame: Frame, map: KObject | undefined, entry: HashEntry): KObject {
  if (!map || map.store instanceof BuilderStore) return createEntry(frame, map, entry);
  let wrappers = entryWrappers.get(map);
  if (!wrappers) {
    wrappers = new WeakMap();
    entryWrappers.set(map, wrappers);
  }
  const present = wrappers.get(entry);
  if (present) return present;
  const wrapper = createEntry(frame, map, entry);
  wrappers.set(entry, wrapper);
  return wrapper;
}

function createEntry(frame: Frame, map: KObject | undefined, entry: HashEntry): KObject {
  frame.runtime.allocate(frame, 1);
  const object = new KObject(libraryClass('kotlin.collections.NativeEntry'), 0);
  object.native = {
    entry,
    map,
    expectedModCount: map?.store instanceof BuilderStore ? map.modCount : undefined,
  };
  return object;
}

export function defineNativeEntry(requireMutable: (frame: Frame, map: KObject) => void): void {
  const owner = 'kotlin.collections.NativeEntry';
  defineNativeProperty(`${owner}.key`, (frame, receiver) => entryOf(frame, receiver).entry.key);
  defineNativeProperty(`${owner}.value`, (frame, receiver) => entryOf(frame, receiver).entry.value);
  defineNative(`${owner}.setValue(V)`, (frame, receiver, [value]) => {
    const { entry, map } = entryOf(frame, receiver);
    if (map) requireMutable(frame, map);
    const old = entry.value;
    entry.value = value;
    return old;
  });
  defineNative(`${owner}.toString()`, (frame, receiver) => {
    const key = stringOf(frame, entryOf(frame, receiver).entry.key);
    const value = stringOf(frame, entryOf(frame, receiver).entry.value);
    frame.runtime.allocateString(frame, key.length + 1 + value.length);
    return `${key}=${value}`;
  });
  defineNative(`${owner}.hashCode()`, (frame, receiver) => {
    const keyHash = hashOf(frame, entryOf(frame, receiver).entry.key);
    return keyHash ^ hashOf(frame, entryOf(frame, receiver).entry.value);
  });
  defineNative(`${owner}.equals(Any?)`, (frame, receiver, [other]) => {
    const state = entryState(receiver);
    if (state.expectedModCount !== undefined) return builderEntryEquals(frame, receiver, other);
    return receiver === other || mapEntryEquals(frame, state.entry, other);
  });
}

function builderEntryEquals(frame: Frame, receiver: Value, other: Value): boolean {
  if (!(other instanceof KObject) || !other.cls.isSubclassOf(libraryClass(MAP_ENTRY))) return false;
  return (
    builderComponentEquals(frame, receiver, other, 'key') && builderComponentEquals(frame, receiver, other, 'value')
  );
}

function builderComponentEquals(frame: Frame, receiver: Value, other: Value, component: 'key' | 'value'): boolean {
  const left = readCollectionProperty(frame, other, MAP_ENTRY, component);
  return frame.runtime.withNativeRoots([left], () =>
    valueEquals(frame, left, entryOf(frame, receiver).entry[component])
  );
}

function entryOf(frame: Frame, receiver: Value): EntryState {
  const state = entryState(receiver);
  if (state.expectedModCount !== undefined && state.map?.modCount !== state.expectedModCount)
    throwError(
      frame,
      'java.util.ConcurrentModificationException',
      'The backing map has been modified after this entry was obtained.'
    );
  return state;
}

function entryState(receiver: Value): EntryState {
  return (receiver as KObject).native as unknown as EntryState;
}
