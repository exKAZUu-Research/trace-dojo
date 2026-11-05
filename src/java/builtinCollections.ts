import { stringify } from './builtins';
import {
  addAbstractMethod,
  addConstructor,
  addInterface,
  addMethod,
  addTypeParameters,
  defineInterface,
  newString,
  type Registry,
} from './builtinSupport';
import { type BoxableKind, hashOf, type Wrappers } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  type ClassInfo,
  type ClassType,
  INT,
  type JavaType,
  type MethodInfo,
  superinterfacesOf,
  VOID,
} from './types';
import {
  charCodeOf,
  type HashEntry,
  HashStore,
  JavaArray,
  JavaObject,
  JavaString,
  toInt32,
  type Value,
} from './values';

export interface Collections {
  iterableClass: ClassInfo;
  iteratorClass: ClassInfo;
  listClass: ClassInfo;
  /** The class of the lists `List.of` returns. */
  immutableList: ClassInfo;
  /** The class of the lists `Arrays.asList` returns, which share their array's elements. */
  fixedSizeList: ClassInfo;
  collectionClass: ClassInfo;
  mapClass: ClassInfo;
  /** `Iterable.iterator`, which an enhanced for statement calls. */
  iterator: MethodInfo;
  hasNext: MethodInfo;
  next: MethodInfo;
}

interface Context {
  registry: Registry;
  objectClass: ClassInfo;
  objectType: JavaType;
  stringType: JavaType;
  wrappers: Wrappers;
}

const classType = (cls: ClassInfo, ...args: JavaType[]): ClassType => ({ kind: 'class', cls, args });

export function defineCollections(
  registry: Registry,
  objectClass: ClassInfo,
  stringType: JavaType,
  wrappers: Wrappers
): Collections {
  const context: Context = { registry, objectClass, objectType: objectClass.type, stringType, wrappers };
  const { objectType } = context;
  const iterableClass = defineInterface(registry, 'Iterable', 'java.lang');
  const [iterableElement] = addTypeParameters(iterableClass, ['T'], objectType);
  const iteratorClass = defineInterface(registry, 'Iterator', 'java.util');
  const [iteratorElement] = addTypeParameters(iteratorClass, ['E'], objectType);
  const hasNext = addAbstractMethod(iteratorClass, 'hasNext', [], BOOLEAN);
  const next = addAbstractMethod(iteratorClass, 'next', [], iteratorElement);
  // Iterator.remove is a default method that iterators without removal leave throwing.
  addMethod(iteratorClass, 'remove', [], VOID, false, (frame) => throwBuiltin(frame, 'UnsupportedOperationException'));
  const iterator = addAbstractMethod(iterableClass, 'iterator', [], classType(iteratorClass, iterableElement));
  const itrClass = defineIteratorClass(context, iteratorClass);

  const collectionClass = defineInterface(registry, 'Collection', 'java.util');
  const [collectionElement] = addTypeParameters(collectionClass, ['E'], objectType);
  addInterface(collectionClass, classType(iterableClass, collectionElement));
  declareCollectionMethods(collectionClass, collectionElement, context);
  const listClass = defineInterface(registry, 'List', 'java.util');
  const [listElement] = addTypeParameters(listClass, ['E'], objectType);
  addInterface(listClass, classType(collectionClass, listElement));
  declareListMethods(listClass, listElement);
  const setClass = defineInterface(registry, 'Set', 'java.util');
  const [setElement] = addTypeParameters(setClass, ['E'], objectType);
  addInterface(setClass, classType(collectionClass, setElement));

  const lists = { listClass, collectionClass, itrClass };
  for (const name of ['ArrayList', 'LinkedList']) defineArrayList(context, name, lists);
  const immutableList = defineRestrictedList(context, 'ListN', lists, () => true);
  // Arrays.asList writes through to its array, so it may set elements but not change its size.
  const fixedSizeList = defineRestrictedList(context, 'ArrayList', lists, (method) => method.name !== 'set', 'Arrays$');
  const snapshotSet = defineSnapshot(context, 'Set', setClass, itrClass);
  const snapshotCollection = defineSnapshot(context, 'Collection', collectionClass, itrClass);
  defineHashSet(context, setClass, collectionClass, itrClass);
  const mapClass = defineHashMap(context, { setClass, collectionClass, snapshotSet, snapshotCollection });
  return {
    iterableClass,
    iteratorClass,
    iterator,
    hasNext,
    next,
    listClass,
    collectionClass,
    mapClass,
    immutableList,
    fixedSizeList,
  };
}

/** A list whose methods that `rejects` throw `UnsupportedOperationException`, as `List.of` and `Arrays.asList` give. */
function defineRestrictedList(
  context: Context,
  name: string,
  lists: { listClass: ClassInfo; collectionClass: ClassInfo; itrClass: ClassInfo },
  rejects: (method: MethodInfo) => boolean,
  prefix = 'ImmutableCollections$'
): ClassInfo {
  const cls = defineArrayList(context, name, lists, `${prefix}${name}`);
  for (const method of cls.methods) {
    if (MUTATORS.has(method.name) && rejects(method)) {
      method.native = (frame) => throwBuiltin(frame, 'UnsupportedOperationException');
    }
  }
  cls.constructors = [];
  return cls;
}

const MUTATORS = new Set(['add', 'addAll', 'set', 'remove', 'clear']);

/** The iterator every builtin collection returns, which fails fast when its collection changes structurally. */
function defineIteratorClass(context: Context, iteratorClass: ClassInfo): ClassInfo {
  const itrClass = context.registry.define('Itr', context.objectClass, 'java.util');
  context.registry.classes.delete('Itr');
  const [element] = addTypeParameters(itrClass, ['E'], context.objectType);
  addInterface(itrClass, classType(iteratorClass, element));
  addMethod(itrClass, 'hasNext', [], BOOLEAN, false, (_, receiver) => {
    const state = iteratorState(receiver);
    return state.index < state.items().length;
  });
  addMethod(itrClass, 'next', [], element, false, (frame, receiver) => {
    const state = iteratorState(receiver);
    if (state.source.modCount !== state.expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
    const items = state.items();
    if (state.index >= items.length) throwBuiltin(frame, 'NoSuchElementException');
    state.removed = false;
    return items[state.index++];
  });
  addMethod(itrClass, 'remove', [], VOID, false, (frame, receiver) => {
    const state = iteratorState(receiver);
    // Only the element the last next() returned may be removed, once.
    if (state.removed) throwBuiltin(frame, 'IllegalStateException');
    state.remove(frame, --state.index);
    state.removed = true;
    state.expectedModCount = state.source.modCount;
  });
  linkOverrides(itrClass);
  return itrClass;
}

interface IteratorState {
  source: JavaObject;
  items: () => Value[];
  index: number;
  expectedModCount: number | undefined;
  removed: boolean;
  remove: (frame: Frame, index: number) => void;
}

const iteratorStates = new WeakMap<JavaObject, IteratorState>();

function iteratorState(receiver: Value): IteratorState {
  return iteratorStates.get(receiver as JavaObject) as IteratorState;
}

function createIterator(
  frame: Frame,
  itrClass: ClassInfo,
  source: JavaObject,
  items: () => Value[],
  remove: (frame: Frame, index: number) => void
): JavaObject {
  const iterator = frame.runtime.allocateObject(frame, itrClass);
  iteratorStates.set(iterator, {
    source,
    items,
    index: 0,
    expectedModCount: source.modCount,
    removed: true,
    remove,
  });
  // The iterator keeps its collection alive, as the collection's turtles must stay while it is walked.
  iterator.elements = [source];
  return iterator;
}

/** Marks each native method as implementing the interface methods of the same name and arity it stands for. */
function linkOverrides(cls: ClassInfo): void {
  const inherited = superinterfacesOf(cls).flatMap((parent) => parent.methods);
  for (const method of cls.methods) {
    if (method.isStatic) continue;
    const overridden = inherited.filter(
      (other) => other.name === method.name && other.parameterTypes.length === method.parameterTypes.length
    );
    if (overridden.length > 0) method.overrides = new Set(overridden);
  }
}

function declareCollectionMethods(cls: ClassInfo, element: JavaType, context: Context): void {
  const { objectType } = context;
  addAbstractMethod(cls, 'size', [], INT);
  addAbstractMethod(cls, 'isEmpty', [], BOOLEAN);
  addAbstractMethod(cls, 'contains', [objectType], BOOLEAN);
  addAbstractMethod(cls, 'add', [element], BOOLEAN);
  addAbstractMethod(cls, 'remove', [objectType], BOOLEAN);
  addAbstractMethod(cls, 'clear', [], VOID);
  addAbstractMethod(cls, 'addAll', [classType(cls, { kind: 'wildcard', bound: element, isSuper: false })], BOOLEAN);
}

function declareListMethods(cls: ClassInfo, element: JavaType): void {
  addAbstractMethod(cls, 'get', [INT], element);
  addAbstractMethod(cls, 'set', [INT, element], element);
  addAbstractMethod(cls, 'add', [INT, element], VOID);
  addAbstractMethod(cls, 'remove', [INT], element);
  addAbstractMethod(
    cls,
    'indexOf',
    [element.kind === 'typeVar' ? (element.variable.bounds[0] as JavaType) : element],
    INT
  );
  addAbstractMethod(
    cls,
    'lastIndexOf',
    [element.kind === 'typeVar' ? (element.variable.bounds[0] as JavaType) : element],
    INT
  );
}

function elementsOf(receiver: Value): Value[] {
  return (receiver as JavaObject).elements as Value[];
}

function touch(receiver: Value): void {
  const object = receiver as JavaObject;
  object.modCount = (object.modCount ?? 0) + 1;
}

/** `ArrayList` and `LinkedList`, which differ only in performance, as far as these programs can tell. */
function defineArrayList(
  context: Context,
  name: string,
  { listClass, collectionClass, itrClass }: { listClass: ClassInfo; collectionClass: ClassInfo; itrClass: ClassInfo },
  hiddenName?: string
): ClassInfo {
  const cls = context.registry.define(hiddenName ?? name, context.objectClass, 'java.util');
  if (hiddenName) {
    context.registry.classes.delete(hiddenName);
    cls.name = name;
  }
  LIST_CLASSES.add(cls);
  const [element] = addTypeParameters(cls, ['E'], context.objectType);
  addInterface(cls, classType(listClass, element));
  addConstructor(cls, [], (_, receiver) => createList(receiver));
  if (name === 'ArrayList') {
    addConstructor(cls, [INT], (frame, receiver, [capacity]) => {
      if ((capacity as number) < 0)
        throwBuiltin(frame, 'IllegalArgumentException', `Illegal Capacity: ${capacity as number}`);
      return createList(receiver);
    });
  }
  addConstructor(
    cls,
    [classType(collectionClass, { kind: 'wildcard', bound: element, isSuper: false })],
    (frame, receiver, [source]) => {
      createList(receiver);
      const items = itemsOf(frame, source);
      frame.runtime.allocateArray(frame, items.length);
      (receiver as JavaObject).elements = [...items];
      return;
    }
  );
  defineReadMethods(cls, element, context, itrClass, (frame, receiver, index) => {
    if (hiddenName) throwBuiltin(frame, 'UnsupportedOperationException');
    elementsOf(receiver).splice(index, 1);
    touch(receiver);
  });
  addMethod(cls, 'add', [element], BOOLEAN, false, (frame, receiver, [value]) => {
    frame.runtime.allocateArray(frame, 1);
    elementsOf(receiver).push(value);
    touch(receiver);
    return true;
  });
  addMethod(cls, 'add', [INT, element], VOID, false, (frame, receiver, [index, value]) => {
    checkPosition(frame, index as number, elementsOf(receiver).length);
    frame.runtime.allocateArray(frame, 1);
    elementsOf(receiver).splice(index as number, 0, value);
    touch(receiver);
  });
  addMethod(
    cls,
    'addAll',
    [classType(collectionClass, { kind: 'wildcard', bound: element, isSuper: false })],
    BOOLEAN,
    false,
    (frame, receiver, [source]) => {
      const items = [...itemsOf(frame, source)];
      frame.runtime.allocateArray(frame, items.length);
      elementsOf(receiver).push(...items);
      touch(receiver);
      return items.length > 0;
    }
  );
  addMethod(cls, 'get', [INT], element, false, (frame, receiver, [index]) => {
    checkIndex(frame, index as number, elementsOf(receiver).length);
    return elementsOf(receiver)[index as number];
  });
  addMethod(cls, 'set', [INT, element], element, false, (frame, receiver, [index, value]) => {
    checkIndex(frame, index as number, elementsOf(receiver).length);
    const previous = elementsOf(receiver)[index as number];
    elementsOf(receiver)[index as number] = value;
    return previous;
  });
  addMethod(cls, 'remove', [INT], element, false, (frame, receiver, [index]) => {
    checkIndex(frame, index as number, elementsOf(receiver).length);
    touch(receiver);
    return elementsOf(receiver).splice(index as number, 1)[0];
  });
  addMethod(cls, 'remove', [context.objectType], BOOLEAN, false, (frame, receiver, [value]) => {
    const index = indexOf(frame, elementsOf(receiver), value);
    if (index === -1) return false;
    elementsOf(receiver).splice(index, 1);
    touch(receiver);
    return true;
  });
  addMethod(cls, 'clear', [], VOID, false, (_, receiver) => {
    elementsOf(receiver).length = 0;
    touch(receiver);
  });
  addMethod(cls, 'indexOf', [context.objectType], INT, false, (frame, receiver, [value]) =>
    indexOf(frame, elementsOf(receiver), value)
  );
  addMethod(cls, 'lastIndexOf', [context.objectType], INT, false, (frame, receiver, [value]) => {
    const items = elementsOf(receiver);
    for (let index = items.length - 1; index >= 0; index--) if (javaEquals(frame, value, items[index])) return index;
    return -1;
  });
  addMethod(cls, 'equals', [context.objectType], BOOLEAN, false, (frame, receiver, [other]) => {
    if (!(other instanceof JavaObject) || !other.elements || !isList(other)) return false;
    const items = elementsOf(receiver);
    return (
      items.length === other.elements.length &&
      items.every((item, index) => javaEquals(frame, item, other.elements?.[index]))
    );
  });
  addMethod(cls, 'hashCode', [], INT, false, (frame, receiver) => {
    let hash = 1;
    for (const item of elementsOf(receiver)) hash = toInt32(Math.imul(hash, 31) + javaHash(frame, item));
    return hash;
  });
  if (name === 'LinkedList') defineDequeMethods(cls, element);
  linkOverrides(cls);
  return cls;
}

const LIST_CLASSES = new Set<ClassInfo>();

function isList(object: JavaObject): boolean {
  return LIST_CLASSES.has(object.cls);
}

/** The queue and stack methods of `LinkedList`, which learners use for breadth-first searches and stacks. */
function defineDequeMethods(cls: ClassInfo, element: JavaType): void {
  for (const [name, atEnd] of [
    ['addFirst', false],
    ['addLast', true],
    ['push', false],
    ['offer', true],
    ['offerLast', true],
    ['offerFirst', false],
  ] as const) {
    const returnsBoolean = name.startsWith('offer');
    addMethod(cls, name, [element], returnsBoolean ? BOOLEAN : VOID, false, (frame, receiver, [value]) => {
      frame.runtime.allocateArray(frame, 1);
      if (atEnd) elementsOf(receiver).push(value);
      else elementsOf(receiver).unshift(value);
      touch(receiver);
      return returnsBoolean ? true : undefined;
    });
  }
  for (const [name, atEnd, removes, throws] of [
    ['getFirst', false, false, true],
    ['getLast', true, false, true],
    ['peek', false, false, false],
    ['peekFirst', false, false, false],
    ['peekLast', true, false, false],
    ['element', false, false, true],
    ['removeFirst', false, true, true],
    ['removeLast', true, true, true],
    ['pop', false, true, true],
    ['remove', false, true, true],
    ['poll', false, true, false],
    ['pollFirst', false, true, false],
    ['pollLast', true, true, false],
  ] as const) {
    addMethod(cls, name, [], element, false, (frame, receiver) => {
      const items = elementsOf(receiver);
      if (items.length === 0) return throws ? throwBuiltin(frame, 'NoSuchElementException') : undefined;
      const index = atEnd ? items.length - 1 : 0;
      const value = items[index];
      if (removes) {
        items.splice(index, 1);
        touch(receiver);
      }
      return value;
    });
  }
}

/** The methods that read a collection whose `elements` hold its items in iteration order. */
function defineReadMethods(
  cls: ClassInfo,
  element: JavaType,
  context: Context,
  itrClass: ClassInfo,
  remove: (frame: Frame, receiver: Value, index: number) => void
): void {
  addMethod(cls, 'size', [], INT, false, (_, receiver) => elementsOf(receiver).length);
  addMethod(cls, 'isEmpty', [], BOOLEAN, false, (_, receiver) => elementsOf(receiver).length === 0);
  addMethod(
    cls,
    'contains',
    [context.objectType],
    BOOLEAN,
    false,
    (frame, receiver, [value]) => indexOf(frame, elementsOf(receiver), value) !== -1
  );
  addMethod(cls, 'iterator', [], { kind: 'class', cls: itrClass, args: [element] }, false, (frame, receiver) =>
    createIterator(
      frame,
      itrClass,
      receiver as JavaObject,
      () => elementsOf(receiver),
      (removeFrame, index) => remove(removeFrame, receiver, index)
    )
  );
  addMethod(cls, 'toString', [], context.stringType, false, (frame, receiver) =>
    newString(
      frame,
      `[${elementsOf(receiver)
        .map((item) => describe(frame, item, receiver))
        .join(', ')}]`
    )
  );
}

/** Snapshots that `keySet`, `values`, and `entrySet` return, which read a map's contents at the time of the call. */
function defineSnapshot(context: Context, kind: string, parent: ClassInfo, itrClass: ClassInfo): ClassInfo {
  const cls = context.registry.define(`Snapshot${kind}`, context.objectClass, 'java.util');
  context.registry.classes.delete(cls.name);
  const [element] = addTypeParameters(cls, ['E'], context.objectType);
  addInterface(cls, classType(parent, element));
  defineReadMethods(cls, element, context, itrClass, (_, receiver, index) => {
    elementsOf(receiver).splice(index, 1);
  });
  for (const name of ['add', 'remove', 'clear', 'addAll']) {
    const parameterCount = name === 'clear' ? 0 : 1;
    addMethod(
      cls,
      name,
      Array.from({ length: parameterCount }, () => context.objectType),
      name === 'clear' ? VOID : BOOLEAN,
      false,
      (frame) => throwBuiltin(frame, 'UnsupportedOperationException')
    );
  }
  linkOverrides(cls);
  return cls;
}

function defineHashSet(context: Context, setClass: ClassInfo, collectionClass: ClassInfo, itrClass: ClassInfo): void {
  const cls = context.registry.define('HashSet', context.objectClass, 'java.util');
  const [element] = addTypeParameters(cls, ['E'], context.objectType);
  addInterface(cls, classType(setClass, element));
  addConstructor(cls, [], (_, receiver) => createStore(receiver));
  addConstructor(cls, [INT], (_, receiver, [capacity]) => createStore(receiver, tableSizeFor(capacity as number)));
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
    if (!(other instanceof JavaObject) || !other.store || other.cls !== cls) return false;
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

function defineHashMap(
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

function mapSignatures(
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
function defineEntryNode(context: Context, entryClass: ClassInfo): ClassInfo {
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

const nodeEntries = new WeakMap<JavaObject, { key: Value; value: Value }>();

function defineMapMethods(
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
  // A LinkedHashMap iterates in insertion order and a TreeMap in key order; a HashMap by bucket.
  const ordered = (frame: Frame, receiver: Value): HashEntry[] => {
    const store = storeOf(receiver);
    if (name === 'LinkedHashMap') return store.entries;
    if (name === 'TreeMap') return store.entries.toSorted((a, b) => compareNatural(frame, a.key, b.key));
    return store.ordered();
  };
  const checkKey = (frame: Frame, keyValue: Value): void => {
    // A TreeMap compares keys, so it rejects null and keys that are not comparable.
    if (name === 'TreeMap') compareNatural(frame, keyValue, keyValue);
  };
  addConstructor(cls, [], (_, receiver) => createStore(receiver));
  if (name !== 'TreeMap') {
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
    checkKey(frame, keyValue);
    const previous = putEntry(frame, receiver, keyValue, false, newValue);
    return previous === NO_ENTRY ? undefined : previous;
  });
  addMethod(cls, 'putIfAbsent', [key, value], value, false, (frame, receiver, [keyValue, newValue]) => {
    checkKey(frame, keyValue);
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
      ordered(frame, receiver).map((entry) => entry.key)
    )
  );
  addMethod(cls, 'values', [], classType(views.collectionClass, value), false, (frame, receiver) =>
    snapshot(
      frame,
      views.snapshotCollection,
      ordered(frame, receiver).map((entry) => entry.value)
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
        ordered(frame, receiver).map((entry) => {
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
      `{${ordered(frame, receiver)
        .map((entry) => `${describe(frame, entry.key, receiver)}=${describe(frame, entry.value, receiver)}`)
        .join(', ')}}`
    )
  );
  linkOverrides(cls);
}

const NO_ENTRY = Symbol('noEntry');

function createStore(receiver: Value, capacity = 16): Value {
  const store = new HashStore();
  store.capacity = capacity;
  (receiver as JavaObject).store = store;
  (receiver as JavaObject).modCount = 0;
  return undefined;
}

function keysOf(receiver: Value): Value[] {
  return storeOf(receiver)
    .ordered()
    .map((entry) => entry.key);
}

function entryOf(receiver: Value): { key: Value; value: Value } {
  return nodeEntries.get(receiver as JavaObject) as { key: Value; value: Value };
}

function snapshot(frame: Frame, viewClass: ClassInfo, items: Value[]): JavaObject {
  frame.runtime.allocateArray(frame, items.length);
  const object = frame.runtime.allocateObject(frame, viewClass);
  object.elements = items;
  object.modCount = 0;
  return object;
}

function createList(receiver: Value): Value {
  (receiver as JavaObject).elements = [];
  (receiver as JavaObject).modCount = 0;
  return undefined;
}

function storeOf(receiver: Value): HashStore {
  return (receiver as JavaObject).store as HashStore;
}

export function findEntry(frame: Frame, receiver: Value, key: Value): HashStore['entries'][number] | undefined {
  const hash = javaHash(frame, key);
  return storeOf(receiver).entries.find((entry) => entry.hash === hash && javaEquals(frame, key, entry.key));
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
  storeOf(receiver).add({ key, value, hash: javaHash(frame, key) });
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
function tableSizeFor(capacity: number): number {
  let size = 1;
  while (size < capacity) size *= 2;
  return Math.max(size, 1);
}

/** The items of any builtin collection or array-backed view, in iteration order. */
export function itemsOf(frame: Frame, source: Value): Value[] {
  if (!(source instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
  if (source.elements) return source.elements;
  if (source.store) return source.store.ordered().map((entry) => entry.key);
  return throwBuiltin(frame, 'UnsupportedOperationException');
}

function indexOf(frame: Frame, items: Value[], value: Value): number {
  return items.findIndex((item) => javaEquals(frame, value, item));
}

/** Formats an element as a collection's `toString` does, naming the collection itself to avoid endless recursion. */
function describe(frame: Frame, item: Value, owner: Value): string {
  if (item === owner) return '(this Collection)';
  return stringify(frame, item, { kind: 'null' });
}

/** Calls `equals` as collections do: `Objects.equals(a, b)`. */
export function javaEquals(frame: Frame, a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a instanceof JavaString) return b instanceof JavaString && a.value === b.value;
  if (a instanceof JavaObject && a.boxed !== undefined) {
    return b instanceof JavaObject && b.cls === a.cls && Object.is(a.boxed, b.boxed);
  }
  if (a instanceof JavaArray) return false;
  return frame.runtime.invokeVirtual(frame, frame.runtime.builtins.objectClass, 'equals', a, [b]) === true;
}

/** Calls `hashCode` as hash tables do, giving null the hash 0. */
export function javaHash(frame: Frame, value: Value): number {
  if (value === undefined) return 0;
  if (value instanceof JavaString) {
    frame.runtime.scanString(value.value.length);
    let hash = 0;
    for (let index = 0; index < value.value.length; index++)
      hash = toInt32(Math.imul(hash, 31) + charCodeOf(value.value, index));
    return hash;
  }
  if (value instanceof JavaObject && value.boxed !== undefined) {
    return hashOf(value.boxed, value.cls.unboxedType?.kind as BoxableKind);
  }
  if (value instanceof JavaArray) return value.identity;
  return frame.runtime.invokeVirtual(frame, frame.runtime.builtins.objectClass, 'hashCode', value, []) as number;
}

/** Compares as `Comparable.compareTo` does, which sorting and ordered collections use for natural order. */
export function compareNatural(frame: Frame, a: Value, b: Value): number {
  if (a === undefined || b === undefined) return throwBuiltin(frame, 'NullPointerException');
  const comparable = frame.runtime.builtins.wrappers.comparableClass;
  if (!frame.runtime.isInstance(a, comparable)) {
    const name = a instanceof JavaObject ? a.cls.name : 'array';
    return throwBuiltin(frame, 'ClassCastException', `class ${name} cannot be cast to class java.lang.Comparable`);
  }
  if (a instanceof JavaString && b instanceof JavaString) {
    frame.runtime.scanString(Math.min(a.value.length, b.value.length));
    for (let index = 0; index < Math.min(a.value.length, b.value.length); index++) {
      const difference = charCodeOf(a.value, index) - charCodeOf(b.value, index);
      if (difference !== 0) return difference;
    }
    return a.value.length - b.value.length;
  }
  return frame.runtime.invokeVirtual(frame, comparable, 'compareTo', a, [b]) as number;
}

function checkIndex(frame: Frame, index: number, length: number): void {
  if (index < 0 || index >= length) {
    throwBuiltin(frame, 'IndexOutOfBoundsException', `Index ${index} out of bounds for length ${length}`);
  }
}

function checkPosition(frame: Frame, index: number, length: number): void {
  if (index < 0 || index > length) throwBuiltin(frame, 'IndexOutOfBoundsException', `Index: ${index}, Size: ${length}`);
}
