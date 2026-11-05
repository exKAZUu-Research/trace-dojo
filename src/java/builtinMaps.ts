import type { Context } from './builtinCollectionSupport';
import {
  classType,
  compareNatural,
  createIterator,
  describe,
  itemsOf,
  javaEquals,
  javaHash,
  linkOverrides,
  snapshot,
  touch,
} from './builtinCollectionSupport';
import { callFunction } from './builtinFunctions';
import {
  addAbstractMethod,
  addConstructor,
  addInterface,
  addMethod,
  addTypeParameters,
  defineInterface,
  newString,
} from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, type ClassInfo, createClass, INT, type JavaType, VOID } from './types';
import { HashStore, JavaObject, toInt32, type Value } from './values';

// code-gauge-allow functionCognitiveComplexity 17 -- One registration per builtin method, each a small native.
// code-gauge-allow functionNcss 51 -- One registration per builtin method, each a small native.
export function defineSetClass(
  context: Context,
  name: string,
  setClass: ClassInfo,
  collectionClass: ClassInfo,
  itrClass: ClassInfo
): void {
  const cls = context.registry.define(name, context.objectClass, 'java.util');
  const [element] = addTypeParameters(cls, ['E'], context.objectType);
  addInterface(cls, classType(setClass, element));
  addConstructor(cls, [], (_, receiver) => createStore(receiver));
  if (name === 'TreeSet') {
    addSortedConstructor(cls, element);
    defineNavigation(cls, element, false);
  } else {
    addConstructor(cls, [INT], (_, receiver, [capacity]) => createStore(receiver, tableSizeFor(capacity as number)));
  }
  addConstructor(
    cls,
    [classType(collectionClass, { kind: 'wildcard', bound: element, isSuper: false })],
    (frame, receiver, [source]) => {
      const items = [...itemsOf(frame, source)];
      createStore(receiver, Math.max(tableSizeFor(Math.floor(items.length / 0.75) + 1), 16));
      for (const item of items) putEntry(frame, receiver, item, true);
      return;
    }
  );
  addMethod(cls, 'size', [], INT, false, (_, receiver) => storeOf(receiver).entries.length);
  addMethod(cls, 'isEmpty', [], BOOLEAN, false, (_, receiver) => storeOf(receiver).entries.length === 0);
  addMethod(
    cls,
    'contains',
    [context.objectType],
    BOOLEAN,
    false,
    (frame, receiver, [value]) => findEntry(frame, receiver, value) !== undefined
  );
  addMethod(
    cls,
    'add',
    [element],
    BOOLEAN,
    false,
    (frame, receiver, [value]) => putEntry(frame, receiver, value, true) === NO_ENTRY
  );
  addMethod(
    cls,
    'remove',
    [context.objectType],
    BOOLEAN,
    false,
    (frame, receiver, [value]) => removeEntry(frame, receiver, value) !== NO_ENTRY
  );
  addMethod(cls, 'clear', [], VOID, false, (_, receiver) => {
    storeOf(receiver).entries = [];
    touch(receiver);
  });
  addMethod(
    cls,
    'addAll',
    [classType(collectionClass, { kind: 'wildcard', bound: element, isSuper: false })],
    BOOLEAN,
    false,
    (frame, receiver, [source]) => {
      let changed = false;
      for (const item of itemsOf(frame, source))
        changed = putEntry(frame, receiver, item, true) === NO_ENTRY || changed;
      return changed;
    }
  );
  addMethod(cls, 'iterator', [], { kind: 'class', cls: itrClass, args: [element] }, false, (frame, receiver) => {
    let snapshot: Value[] | undefined;
    let snapshotModCount: number | undefined;
    const items = (): Value[] => {
      if (!snapshot || snapshotModCount !== (receiver as JavaObject).modCount) {
        snapshot = keysOf(receiver);
        snapshotModCount = (receiver as JavaObject).modCount;
      }
      return snapshot;
    };
    return createIterator(frame, itrClass, receiver as JavaObject, items, (removeFrame, index) => {
      removeEntry(removeFrame, receiver, items()[index]);
    });
  });
  addMethod(cls, 'toString', [], context.stringType, false, (frame, receiver) =>
    newString(
      frame,
      `[${keysOf(receiver)
        .map((item) => describe(frame, item, receiver))
        .join(', ')}]`
    )
  );
  addMethod(cls, 'equals', [context.objectType], BOOLEAN, false, (frame, receiver, [other]) => {
    if (!(other instanceof JavaObject) || !other.store || !other.cls.name.endsWith('Set')) return false;
    const entries = storeOf(receiver).entries;
    return (
      entries.length === other.store.entries.length &&
      entries.every((entry) => findEntry(frame, other, entry.key) !== undefined)
    );
  });
  addMethod(cls, 'hashCode', [], INT, false, (_, receiver) => {
    let sum = 0;
    for (const entry of storeOf(receiver).entries) sum = toInt32(sum + entry.hash);
    return sum;
  });
  linkOverrides(cls);
}

export function defineHashMap(
  context: Context,
  views: { setClass: ClassInfo; collectionClass: ClassInfo; snapshotSet: ClassInfo; snapshotCollection: ClassInfo }
): ClassInfo {
  const { registry, objectType, stringType } = context;
  const mapClass = defineInterface(registry, 'Map', 'java.util');
  const [mapKey, mapValue] = addTypeParameters(mapClass, ['K', 'V'], objectType);
  const entryClass = defineInterface(registry, 'Entry', 'java.util');
  registry.classes.delete('Entry');
  entryClass.enclosing = mapClass;
  entryClass.binaryName = 'Map$Entry';
  mapClass.memberTypes.set('Entry', entryClass);
  const [entryKey, entryValue] = addTypeParameters(entryClass, ['K', 'V'], objectType);
  addAbstractMethod(entryClass, 'getKey', [], entryKey);
  addAbstractMethod(entryClass, 'getValue', [], entryValue);
  addAbstractMethod(entryClass, 'setValue', [entryValue], entryValue);
  const nodeClass = defineEntryNode(context, entryClass);
  for (const [name, parameters, returnType] of mapSignatures(mapKey, mapValue, context, entryClass, views)) {
    addAbstractMethod(mapClass, name, parameters, returnType);
  }
  for (const name of ['HashMap', 'LinkedHashMap', 'TreeMap']) {
    const cls = registry.define(name, context.objectClass, 'java.util');
    const [key, value] = addTypeParameters(cls, ['K', 'V'], objectType);
    addInterface(cls, classType(mapClass, key, value));
    defineMapMethods(cls, name, key, value, context, { ...views, entryClass, nodeClass, mapClass });
  }
  void stringType;
  return mapClass;
}

export function mapSignatures(
  key: JavaType,
  value: JavaType,
  context: Context,
  entryClass: ClassInfo,
  { setClass, collectionClass }: { setClass: ClassInfo; collectionClass: ClassInfo }
): [string, JavaType[], JavaType][] {
  const { objectType } = context;
  return [
    ['put', [key, value], value],
    ['get', [objectType], value],
    ['getOrDefault', [objectType, value], value],
    ['containsKey', [objectType], BOOLEAN],
    ['containsValue', [objectType], BOOLEAN],
    ['remove', [objectType], value],
    ['putIfAbsent', [key, value], value],
    ['size', [], INT],
    ['isEmpty', [], BOOLEAN],
    ['clear', [], VOID],
    ['keySet', [], classType(setClass, key)],
    ['values', [], classType(collectionClass, value)],
    ['entrySet', [], classType(setClass, classType(entryClass, key, value))],
  ];
}

/** The entry objects that `entrySet` gives, which write `setValue` through to their map. */
export function defineEntryNode(context: Context, entryClass: ClassInfo): ClassInfo {
  const cls = context.registry.define('Node', context.objectClass, 'java.util');
  context.registry.classes.delete('Node');
  const [key, value] = addTypeParameters(cls, ['K', 'V'], context.objectType);
  addInterface(cls, classType(entryClass, key, value));
  addMethod(cls, 'getKey', [], key, false, (_, receiver) => entryOf(receiver).key);
  addMethod(cls, 'getValue', [], value, false, (_, receiver) => entryOf(receiver).value);
  addMethod(cls, 'setValue', [value], value, false, (_, receiver, [newValue]) => {
    const entry = entryOf(receiver);
    const previous = entry.value;
    entry.value = newValue;
    return previous;
  });
  addMethod(cls, 'toString', [], context.stringType, false, (frame, receiver) =>
    newString(
      frame,
      `${describe(frame, entryOf(receiver).key, receiver)}=${describe(frame, entryOf(receiver).value, receiver)}`
    )
  );
  linkOverrides(cls);
  return cls;
}

export const nodeEntries = new WeakMap<JavaObject, { key: Value; value: Value }>();

// code-gauge-allow functionCognitiveComplexity 19 -- One registration per builtin method, each a small native.
// code-gauge-allow functionNcss 51 -- One registration per builtin method, each a small native.
export function defineMapMethods(
  cls: ClassInfo,
  name: string,
  key: JavaType,
  value: JavaType,
  context: Context,
  views: {
    snapshotSet: ClassInfo;
    snapshotCollection: ClassInfo;
    nodeClass: ClassInfo;
    entryClass: ClassInfo;
    mapClass: ClassInfo;
    setClass: ClassInfo;
    collectionClass: ClassInfo;
  }
): void {
  const { objectType } = context;
  addConstructor(cls, [], (_, receiver) => createStore(receiver));
  if (name === 'TreeMap') {
    addSortedConstructor(cls, key);
    defineNavigation(cls, key, true);
  } else {
    addConstructor(cls, [INT], (_, receiver, [capacity]) => createStore(receiver, tableSizeFor(capacity as number)));
  }
  addConstructor(
    cls,
    [
      classType(
        views.mapClass,
        { kind: 'wildcard', bound: key, isSuper: false },
        { kind: 'wildcard', bound: value, isSuper: false }
      ),
    ],
    (frame, receiver, [source]) => {
      if (!(source instanceof JavaObject) || !source.store) return throwBuiltin(frame, 'NullPointerException');
      const entries = source.store.entries;
      createStore(receiver, Math.max(tableSizeFor(Math.floor(entries.length / 0.75) + 1), 16));
      for (const entry of entries) putEntry(frame, receiver, entry.key, true, entry.value);
      return;
    }
  );
  addMethod(cls, 'put', [key, value], value, false, (frame, receiver, [keyValue, newValue]) => {
    const previous = putEntry(frame, receiver, keyValue, false, newValue);
    return previous === NO_ENTRY ? undefined : previous;
  });
  addMethod(cls, 'putIfAbsent', [key, value], value, false, (frame, receiver, [keyValue, newValue]) => {
    const entry = findEntry(frame, receiver, keyValue);
    if (entry && entry.value !== undefined) return entry.value;
    if (entry) entry.value = newValue;
    else putEntry(frame, receiver, keyValue, false, newValue);
    return;
  });
  addMethod(
    cls,
    'get',
    [objectType],
    value,
    false,
    (frame, receiver, [keyValue]) => findEntry(frame, receiver, keyValue)?.value
  );
  addMethod(cls, 'getOrDefault', [objectType, value], value, false, (frame, receiver, [keyValue, fallback]) => {
    const entry = findEntry(frame, receiver, keyValue);
    return entry ? entry.value : fallback;
  });
  addMethod(
    cls,
    'containsKey',
    [objectType],
    BOOLEAN,
    false,
    (frame, receiver, [keyValue]) => findEntry(frame, receiver, keyValue) !== undefined
  );
  addMethod(cls, 'containsValue', [objectType], BOOLEAN, false, (frame, receiver, [target]) =>
    storeOf(receiver).entries.some((entry) => javaEquals(frame, target, entry.value))
  );
  addMethod(cls, 'remove', [objectType], value, false, (frame, receiver, [keyValue]) => {
    const removed = removeEntry(frame, receiver, keyValue);
    return removed === NO_ENTRY ? undefined : removed;
  });
  addMethod(cls, 'size', [], INT, false, (_, receiver) => storeOf(receiver).entries.length);
  addMethod(cls, 'isEmpty', [], BOOLEAN, false, (_, receiver) => storeOf(receiver).entries.length === 0);
  addMethod(cls, 'clear', [], VOID, false, (_, receiver) => {
    storeOf(receiver).entries = [];
    touch(receiver);
  });
  addMethod(cls, 'keySet', [], classType(views.setClass, key), false, (frame, receiver) =>
    snapshot(
      frame,
      views.snapshotSet,
      storeOf(receiver)
        .ordered()
        .map((entry) => entry.key)
    )
  );
  addMethod(cls, 'values', [], classType(views.collectionClass, value), false, (frame, receiver) =>
    snapshot(
      frame,
      views.snapshotCollection,
      storeOf(receiver)
        .ordered()
        .map((entry) => entry.value)
    )
  );
  addMethod(
    cls,
    'entrySet',
    [],
    classType(views.setClass, classType(views.entryClass, key, value)),
    false,
    (frame, receiver) =>
      snapshot(
        frame,
        views.snapshotSet,
        storeOf(receiver)
          .ordered()
          .map((entry) => {
            const node = frame.runtime.allocateObject(frame, views.nodeClass);
            nodeEntries.set(node, entry);
            node.elements = [entry.key, entry.value];
            return node;
          })
      )
  );
  addMethod(cls, 'toString', [], context.stringType, false, (frame, receiver) =>
    newString(
      frame,
      `{${storeOf(receiver)
        .ordered()
        .map((entry) => `${describe(frame, entry.key, receiver)}=${describe(frame, entry.value, receiver)}`)
        .join(', ')}}`
    )
  );
  linkOverrides(cls);
}

export const NO_ENTRY = Symbol('noEntry');

/** `TreeMap(Comparator)` and `TreeSet(Comparator)`, which order the keys with the comparator. */
export function addSortedConstructor(cls: ClassInfo, key: JavaType): void {
  // The functions are defined after the collections, so the comparator's type is looked up when the class is used.
  const comparatorType: JavaType = {
    kind: 'class',
    cls: lazyComparator,
    args: [{ kind: 'wildcard', bound: key, isSuper: true }],
  };
  addConstructor(cls, [comparatorType], (_, receiver, [comparator]) => createStore(receiver, 16, comparator));
}

/** A placeholder for `Comparator`, which `linkComparator` replaces once the functional interfaces exist. */
export const lazyComparator = createClass('Comparator', undefined, true);

/** Points the sorted collections' constructors at the real `Comparator` interface. */
export function linkComparator(collections: { sortedClasses: ClassInfo[] }, comparatorClass: ClassInfo): void {
  for (const cls of collections.sortedClasses) {
    for (const constructor of cls.constructors) {
      constructor.parameterTypes = constructor.parameterTypes.map((type) =>
        type.kind === 'class' && type.cls === lazyComparator ? { ...type, cls: comparatorClass } : type
      );
    }
  }
}

export function sortedKeys(receiver: Value): Value[] {
  return storeOf(receiver).entries.map((entry) => entry.key);
}

/** The navigation methods of `TreeMap` (on keys) and `TreeSet`: the first and last keys and the nearest ones. */
// code-gauge-allow functionCognitiveComplexity 20 -- One registration per builtin method, each a small native.
export function defineNavigation(cls: ClassInfo, key: JavaType, isMap: boolean): void {
  const suffix = isMap ? 'Key' : '';
  for (const [name, isFirst] of [
    ['first', true],
    ['last', false],
  ] as const) {
    addMethod(cls, `${name}${suffix}`, [], key, false, (frame, receiver) => {
      const all = sortedKeys(receiver);
      if (all.length === 0) throwBuiltin(frame, 'NoSuchElementException');
      return isFirst ? all[0] : all.at(-1);
    });
  }
  for (const [name, accepts, fromEnd] of [
    ['floor', (order: number) => order <= 0, true],
    ['lower', (order: number) => order < 0, true],
    ['ceiling', (order: number) => order >= 0, false],
    ['higher', (order: number) => order > 0, false],
  ] as const) {
    addMethod(cls, `${name}${suffix}`, [key], key, false, (frame, receiver, [target]) => {
      const { compare } = storeOf(receiver);
      const all = fromEnd ? sortedKeys(receiver).toReversed() : sortedKeys(receiver);
      return all.find((candidate) => accepts((compare as NonNullable<typeof compare>)(frame, candidate, target)));
    });
  }
  if (isMap) return;
  for (const [name, isFirst] of [
    ['pollFirst', true],
    ['pollLast', false],
  ] as const) {
    addMethod(cls, name, [], key, false, (frame, receiver) => {
      const store = storeOf(receiver);
      const entry = isFirst ? store.entries[0] : store.entries.at(-1);
      if (!entry) return;
      store.entries = store.entries.filter((other) => other !== entry);
      touch(receiver);
      return entry.key;
    });
  }
}

/** The order each hash-based class iterates in. */
export const STORE_ORDERS: Record<string, HashStore['order']> = {
  HashMap: 'hash',
  HashSet: 'hash',
  LinkedHashMap: 'insertion',
  LinkedHashSet: 'insertion',
  TreeMap: 'sorted',
  TreeSet: 'sorted',
};

/** Gives a new map or set its entries, which a sorted one compares with `comparator` or in natural order. */
export function createStore(receiver: Value, capacity = 16, comparator?: Value): Value {
  const object = receiver as JavaObject;
  const store = new HashStore();
  store.capacity = capacity;
  store.order = STORE_ORDERS[object.cls.name] ?? 'hash';
  if (store.order === 'sorted') {
    store.compare =
      comparator === undefined
        ? compareNatural
        : (frame, a, b) =>
            callFunction(frame, frame.runtime.builtins.functions.comparatorClass, comparator, [a, b]) as number;
  }
  object.store = store;
  object.modCount = 0;
  return undefined;
}

export function keysOf(receiver: Value): Value[] {
  return storeOf(receiver)
    .ordered()
    .map((entry) => entry.key);
}

export function entryOf(receiver: Value): { key: Value; value: Value } {
  return nodeEntries.get(receiver as JavaObject) as { key: Value; value: Value };
}

export function storeOf(receiver: Value): HashStore {
  return (receiver as JavaObject).store as HashStore;
}

export function findEntry(frame: Frame, receiver: Value, key: Value): HashStore['entries'][number] | undefined {
  const store = storeOf(receiver);
  const { compare } = store;
  // A sorted map or set takes keys that compare as equal for the same key.
  if (compare) return store.entries.find((entry) => compare(frame, key, entry.key) === 0);
  const hash = javaHash(frame, key);
  return store.entries.find((entry) => entry.hash === hash && javaEquals(frame, key, entry.key));
}

/** Adds or replaces an entry, returning the value it replaced or `NO_ENTRY`; a set keeps an existing entry. */
export function putEntry(
  frame: Frame,
  receiver: Value,
  key: Value,
  keepsExisting: boolean,
  value?: Value
): Value | typeof NO_ENTRY {
  const entry = findEntry(frame, receiver, key);
  if (entry) {
    const previous = entry.value;
    if (!keepsExisting) entry.value = value;
    return previous;
  }
  frame.runtime.allocateArray(frame, 2);
  const store = storeOf(receiver);
  const { compare } = store;
  if (compare) {
    // Comparing a key with itself rejects null and keys that are not comparable, even in an empty map.
    compare(frame, key, key);
    const index = store.entries.findIndex((other) => compare(frame, key, other.key) < 0);
    store.entries.splice(index === -1 ? store.entries.length : index, 0, { key, value, hash: 0 });
  } else store.add({ key, value, hash: javaHash(frame, key) });
  touch(receiver);
  return NO_ENTRY;
}

export function removeEntry(frame: Frame, receiver: Value, key: Value): Value | typeof NO_ENTRY {
  const entry = findEntry(frame, receiver, key);
  if (!entry) return NO_ENTRY;
  const store = storeOf(receiver);
  store.entries = store.entries.filter((other) => other !== entry);
  touch(receiver);
  return entry.value;
}

/** The capacity Java's hash tables round a requested capacity up to: the next power of two. */
export function tableSizeFor(capacity: number): number {
  let size = 1;
  while (size < capacity) size *= 2;
  return Math.max(size, 1);
}
