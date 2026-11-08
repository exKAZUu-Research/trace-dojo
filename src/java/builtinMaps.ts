import { classObjectOf } from './builtinClass';
import type { Context } from './builtinCollectionSupport';
import {
  checkModifiable,
  classType,
  compareNatural,
  createIterator,
  defaultRemoveClasses,
  defineSetEquality,
  describe,
  itemsOf,
  javaEquals,
  javaHash,
  linkOverrides,
  mapViewSources,
  touch,
  uncountedMapClasses,
  unmodifiableClasses,
} from './builtinCollectionSupport';
import { callFunction } from './builtinFunctions';
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
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  type ClassInfo,
  createClass,
  INT,
  type JavaType,
  type NativeMethod,
  type TypeVariable,
  VOID,
} from './types';
import { HashStore, JavaArray, JavaObject, toInt32, type Value } from './values';

/** `HashSet`, `LinkedHashSet`, `TreeSet`, and the class of the sets `Set.of` returns, which this returns. */
export function defineSets(
  context: Context,
  setClass: ClassInfo,
  collectionClass: ClassInfo,
  itrClass: ClassInfo
): ClassInfo {
  for (const name of ['HashSet', 'LinkedHashSet', 'TreeSet'])
    defineSetClass(context, name, setClass, collectionClass, itrClass);
  defineEnumSet(context, defineSetClass(context, 'EnumSet', setClass, collectionClass, itrClass), collectionClass);
  return restrictToImmutable(
    context.registry,
    defineSetClass(context, 'ImmutableCollections$SetN', setClass, collectionClass, itrClass),
    'SetN'
  );
}

// code-gauge-allow functionNcss 52 -- One registration per builtin method, each a small native.
function defineSetClass(
  context: Context,
  name: string,
  setClass: ClassInfo,
  collectionClass: ClassInfo,
  itrClass: ClassInfo
): ClassInfo {
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
      // JDK 19 and later size the table for at least 12 elements, as HashMap.newHashMap(Math.max(size, 12)) does.
      createStore(receiver, tableSizeFor(Math.ceil(Math.max(items.length, 12) / 0.75)));
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
    const items = keysOf(receiver);
    return createIterator(
      frame,
      itrClass,
      receiver as JavaObject,
      () => items,
      (removeFrame, index) => {
        checkModifiable(removeFrame, receiver, true);
        removeEntry(removeFrame, receiver, items[index]);
      },
      true
    );
  });
  addMethod(cls, 'toString', [], context.stringType, false, (frame, receiver) =>
    newString(
      frame,
      `[${keysOf(receiver)
        .map((item) => describe(frame, item, receiver))
        .join(', ')}]`
    )
  );
  defineSetEquality(cls, context, setClass);
  linkOverrides(cls);
  return cls;
}

export function defineHashMap(
  context: Context,
  views: { setClass: ClassInfo; collectionClass: ClassInfo; snapshotSet: ClassInfo; snapshotCollection: ClassInfo }
): { mapClass: ClassInfo; immutableMap: ClassInfo } {
  const { registry, objectType } = context;
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
  const defineClass = (name: string, qualifiedName = name): ClassInfo => {
    const cls = registry.define(qualifiedName, context.objectClass, 'java.util');
    const [key, value] = addTypeParameters(cls, ['K', 'V'], objectType);
    addInterface(cls, classType(mapClass, key, value));
    defineMapMethods(cls, name, key, value, context, { ...views, entryClass, nodeClass, mapClass });
    defineMapEquality(cls, context, mapClass);
    return cls;
  };
  for (const name of ['HashMap', 'LinkedHashMap', 'TreeMap']) defineClass(name);
  defineEnumMap(defineClass('EnumMap'), registry.classes.get('Class') as ClassInfo);
  defineMapEntry(mapClass, entryClass, nodeClass, objectType);
  const immutableMap = defineClass('MapN', 'ImmutableCollections$MapN');
  return { mapClass, immutableMap: restrictToImmutable(registry, immutableMap, 'MapN') };
}

/** The views each map has given, which `keySet`, `values`, and `entrySet` return again, as the JDK's maps do. */
const mapViews = new WeakMap<JavaObject, Map<string, JavaObject>>();

function cachedView(map: Value, kind: string, create: () => JavaObject): JavaObject {
  let views = mapViews.get(map as JavaObject);
  if (!views) {
    views = new Map();
    mapViews.set(map as JavaObject, views);
  }
  let view = views.get(kind);
  if (!view) {
    view = create();
    views.set(kind, view);
  }
  return view;
}

/** A view of a map's keys, values, or entries, which follows the map's changes and removes the entries it loses. */
function mapView(
  frame: Frame,
  map: Value,
  viewClass: ClassInfo,
  elementOf: (entry: HashStore['entries'][number]) => Value,
  isKeySet = false
): JavaObject {
  const view = frame.runtime.allocateObject(frame, viewClass);
  // A view reads the map's entries whenever it is used, so that it follows every later change to the map.
  Object.defineProperties(view, {
    elements: {
      get: () =>
        storeOf(map)
          .ordered()
          .map((entry) => elementOf(entry)),
    },
    modCount: { get: () => (map as JavaObject).modCount, set: () => {} },
  });
  view.retained = [map];
  mapViewSources.set(view, {
    map: map as JavaObject,
    store: () => storeOf(map),
    entries: () => storeOf(map).ordered(),
    elementOf,
    isKeySet,
    remove: (removeFrame, entry) => {
      checkModifiable(removeFrame, map, true);
      removeEntry(removeFrame, map, entry.key);
    },
  });
  return view;
}

/** `EnumMap`, a map of an enum's constants in their order, which its constructors take the enum's class for. */
function defineEnumMap(cls: ClassInfo, classClass: ClassInfo): void {
  uncountedMapClasses.add(cls);
  // Of the constructors every map has, an EnumMap keeps only the one copying another map.
  cls.constructors = cls.constructors.filter((constructor) => constructor.parameterTypes[0]?.kind === 'class');
  const [key] = cls.typeParameters;
  addConstructor(cls, [classType(classClass, { kind: 'typeVar', variable: key })], (_, receiver) =>
    createStore(receiver)
  );
}

/** `EnumSet`, a set of an enum's constants in their order, which only its static methods create. */
function defineEnumSet(context: Context, cls: ClassInfo, collectionClass: ClassInfo): void {
  cls.constructors = [];
  const classClass = context.registry.classes.get('Class') as ClassInfo;
  const create = (frame: Frame, values: Iterable<Value>): JavaObject => createEnumSet(frame, cls, values);
  const generic = (
    name: string,
    parameters: (e: JavaType) => JavaType[],
    native: NativeMethod,
    isVarargs = false
  ): void => {
    const variable: TypeVariable = { name: 'E', bounds: [context.objectType] };
    const element: JavaType = { kind: 'typeVar', variable };
    const method = addMethod(cls, name, parameters(element), classType(cls, element), true, native);
    method.typeParameters = [variable];
    method.isVarargs = isVarargs;
  };
  generic(
    'noneOf',
    (e) => [classType(classClass, e)],
    (frame) => create(frame, [])
  );
  generic(
    'allOf',
    (e) => [classType(classClass, e)],
    (frame, _, [type]) => create(frame, constantsOf(frame, type))
  );
  generic(
    'of',
    (e) => [e, { kind: 'array', element: e }],
    (frame, _, [first, rest]) =>
      rest instanceof JavaArray ? create(frame, [first, ...rest.values]) : throwBuiltin(frame, 'NullPointerException'),
    true
  );
  generic(
    'range',
    (e) => [e, e],
    (frame, _, [from, to]) => {
      const constants = constantsOf(frame, classObjectOf((from as JavaObject).cls, classClass));
      const [start, end] = [constants.indexOf(from), constants.indexOf(to)];
      if (start > end)
        throwBuiltin(
          frame,
          'IllegalArgumentException',
          `${stringify(frame, from, context.objectType)} > ${stringify(frame, to, context.objectType)}`
        );
      return create(frame, constants.slice(start, end + 1));
    }
  );
  generic(
    'complementOf',
    (e) => [classType(cls, e)],
    (frame, _, [other]) => {
      const present = keysOf(other);
      const [first] = present;
      if (first === undefined) throwBuiltin(frame, 'IllegalArgumentException', 'Collection is empty');
      const all = constantsOf(frame, classObjectOf((first as JavaObject).cls, classClass));
      return create(
        frame,
        all.filter((constant) => !present.includes(constant))
      );
    }
  );
  generic(
    'copyOf',
    (e) => [classType(collectionClass, e)],
    (frame, _, [source]) => create(frame, itemsOf(frame, source))
  );
}

function createEnumSet(frame: Frame, cls: ClassInfo, values: Iterable<Value>): JavaObject {
  const set = frame.runtime.allocateObject(frame, cls);
  createStore(set);
  for (const value of values) {
    if (value === undefined) throwBuiltin(frame, 'NullPointerException');
    putEntry(frame, set, value, true);
  }
  return set;
}

/** The constants of the enum whose `Class` object is `type`, in their order. */
function constantsOf(frame: Frame, type: Value): Value[] {
  const enumClass = (type as JavaObject | undefined)?.reflected;
  if (!enumClass) return throwBuiltin(frame, 'NullPointerException');
  const values = enumClass.methods.find((method) => method.name === 'values' && method.isStatic);
  if (!values) return throwBuiltin(frame, 'ClassCastException', `${enumClass.binaryName} is not an enum class`);
  return (frame.runtime.invoke(frame, values, undefined, [], undefined) as JavaArray).values;
}

/** The view `entrySet` returns, in which each entry keeps one node, so that reading it again keeps identities. */
function entrySetView(frame: Frame, map: Value, viewClass: ClassInfo, nodeClass: ClassInfo): JavaObject {
  const nodes = new WeakMap<HashStore['entries'][number], JavaObject>();
  return mapView(frame, map, viewClass, (entry) => {
    let node = nodes.get(entry);
    if (!node) {
      node = frame.runtime.allocateObject(frame, nodeClass);
      nodeEntries.set(node, entry);
      nodeMaps.set(node, map as JavaObject);
      Object.defineProperty(node, 'elements', { get: () => [entry.key, entry.value] });
      nodes.set(entry, node);
    }
    return node;
  });
}

/** `equals` and `hashCode` of a map, which compare and hash its entries as `AbstractMap` does. */
function defineMapEquality(cls: ClassInfo, context: Context, mapClass: ClassInfo): void {
  addMethod(cls, 'equals', [context.objectType], BOOLEAN, false, (frame, receiver, [other]) => {
    if (other === receiver) return true;
    if (!(other instanceof JavaObject) || !other.store || !frame.runtime.isInstance(other, mapClass)) return false;
    const { entries } = storeOf(receiver);
    return (
      entries.length === other.store.entries.length &&
      entries.every((entry) => {
        const found = findEntry(frame, other, entry.key);
        return found !== undefined && javaEquals(frame, entry.value, found.value);
      })
    );
  });
  addMethod(cls, 'hashCode', [], INT, false, (frame, receiver) => {
    let sum = 0;
    for (const entry of storeOf(receiver).entries) {
      const valueHash = entry.value === undefined ? 0 : javaHash(frame, entry.value);
      sum = toInt32(sum + ((entry.key === undefined ? 0 : javaHash(frame, entry.key)) ^ valueHash));
    }
    return sum;
  });
}

/** `Map.entry`, whose entry holds its own key and value. */
function defineMapEntry(mapClass: ClassInfo, entryClass: ClassInfo, nodeClass: ClassInfo, objectType: JavaType): void {
  const [k, v] = ['K', 'V'].map((name): TypeVariable => ({ name, bounds: [objectType] }));
  const [kType, vType] = [k, v].map((variable): JavaType => ({ kind: 'typeVar', variable }));
  const method = addMethod(
    mapClass,
    'entry',
    [kType, vType],
    classType(entryClass, kType, vType),
    true,
    (frame, _, [key, value]) => {
      if (key === undefined || value === undefined) throwBuiltin(frame, 'NullPointerException');
      const node = frame.runtime.allocateObject(frame, nodeClass);
      nodeEntries.set(node, { key, value });
      return node;
    }
  );
  method.typeParameters = [k, v];
}

/**
 * Makes a map or set class the class of the collections `Map.of` or `Set.of` return, whose iteration order the JDK
 * randomizes per run.
 */
export function restrictToImmutable(registry: Registry, cls: ClassInfo, name: string): ClassInfo {
  registry.classes.delete(cls.name);
  unmodifiableClasses.add(cls);
  defaultRemoveClasses.add(cls);
  cls.name = name;
  cls.constructors = [];
  for (const method of cls.methods) {
    if (MUTATORS.has(method.name)) method.native = (frame) => throwBuiltin(frame, 'UnsupportedOperationException');
  }
  return cls;
}

const MUTATORS = new Set(['put', 'remove', 'putIfAbsent', 'clear', 'putAll', 'add', 'addAll']);

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

/** The maps whose entries the nodes from `entrySet` are, which other nodes, such as `Map.entry`'s, lack. */
const nodeMaps = new WeakMap<JavaObject, JavaObject>();

/** The entry objects that `entrySet` gives, which write `setValue` through to their map. */
export function defineEntryNode(context: Context, entryClass: ClassInfo): ClassInfo {
  const cls = context.registry.define('Node', context.objectClass, 'java.util');
  context.registry.classes.delete('Node');
  const [key, value] = addTypeParameters(cls, ['K', 'V'], context.objectType);
  addInterface(cls, classType(entryClass, key, value));
  addMethod(cls, 'getKey', [], key, false, (_, receiver) => entryOf(receiver).key);
  addMethod(cls, 'getValue', [], value, false, (_, receiver) => entryOf(receiver).value);
  addMethod(cls, 'setValue', [value], value, false, (frame, receiver, [newValue]) => {
    const map = nodeMaps.get(receiver as JavaObject);
    // Only an entry of a modifiable map can change; `Map.entry` and `TreeMap.firstEntry` give immutable ones.
    if (!map) throwBuiltin(frame, 'UnsupportedOperationException');
    checkModifiable(frame, map, false);
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
  // An entry equals any entry with equal key and value, and hashes as `Map.Entry` specifies.
  addMethod(cls, 'equals', [context.objectType], BOOLEAN, false, (frame, receiver, [other]) => {
    if (!frame.runtime.isInstance(other, entryClass)) return false;
    const { key, value } = entryOf(receiver);
    const read = (name: string): Value => frame.runtime.invokeVirtual(frame, entryClass, name, other, []);
    return javaEquals(frame, key, read('getKey')) && javaEquals(frame, value, read('getValue'));
  });
  addMethod(cls, 'hashCode', [], INT, false, (frame, receiver) => {
    const { key, value } = entryOf(receiver);
    return (key === undefined ? 0 : javaHash(frame, key)) ^ (value === undefined ? 0 : javaHash(frame, value));
  });
  linkOverrides(cls);
  return cls;
}

export const nodeEntries = new WeakMap<JavaObject, { key: Value; value: Value }>();

// code-gauge-allow functionCognitiveComplexity 21 -- One registration per builtin method, each a small native.
// code-gauge-allow functionNcss 52 -- One registration per builtin method, each a small native.
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
    defineEntryNavigation(cls, key, classType(views.entryClass, key, value), views.nodeClass);
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
      // As HashMap.putMapEntries does: a table for the entries, filled in the source's iteration order.
      const entries = source.store.ordered();
      createStore(receiver, entries.length === 0 ? 16 : tableSizeFor(Math.ceil(entries.length / 0.75)));
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
    cachedView(receiver, 'keySet', () => mapView(frame, receiver, views.snapshotSet, (entry) => entry.key, true))
  );
  addMethod(cls, 'values', [], classType(views.collectionClass, value), false, (frame, receiver) =>
    cachedView(receiver, 'values', () => mapView(frame, receiver, views.snapshotCollection, (entry) => entry.value))
  );
  addMethod(
    cls,
    'entrySet',
    [],
    classType(views.setClass, classType(views.entryClass, key, value)),
    false,
    (frame, receiver) =>
      cachedView(receiver, 'entrySet', () => entrySetView(frame, receiver, views.snapshotSet, views.nodeClass))
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
    addMethod(
      cls,
      `${name}${suffix}`,
      [key],
      key,
      false,
      (frame, receiver, [target]) => storeOf(receiver).nearest(frame, target, accepts, fromEnd)?.key
    );
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
      store.remove(entry);
      touch(receiver);
      return entry.key;
    });
  }
}

/** `TreeMap`'s methods that find an entry by its key's order, which return a snapshot of the entry. */
function defineEntryNavigation(cls: ClassInfo, key: JavaType, entryType: JavaType, nodeClass: ClassInfo): void {
  const snapshot = (frame: Frame, entry: { key: Value; value: Value } | undefined): Value => {
    if (!entry) return undefined;
    const node = frame.runtime.allocateObject(frame, nodeClass);
    nodeEntries.set(node, { key: entry.key, value: entry.value });
    return node;
  };
  for (const [name, isFirst, removes] of [
    ['firstEntry', true, false],
    ['lastEntry', false, false],
    ['pollFirstEntry', true, true],
    ['pollLastEntry', false, true],
  ] as const) {
    addMethod(cls, name, [], entryType, false, (frame, receiver) => {
      const store = storeOf(receiver);
      const ordered = store.ordered();
      const entry = isFirst ? ordered[0] : ordered.at(-1);
      if (entry && removes) {
        store.remove(entry);
        touch(receiver);
      }
      return snapshot(frame, entry);
    });
  }
  for (const [name, accepts, fromEnd] of [
    ['floorEntry', (order: number) => order <= 0, true],
    ['lowerEntry', (order: number) => order < 0, true],
    ['ceilingEntry', (order: number) => order >= 0, false],
    ['higherEntry', (order: number) => order > 0, false],
  ] as const) {
    addMethod(cls, name, [key], entryType, false, (frame, receiver, [target]) =>
      snapshot(frame, storeOf(receiver).nearest(frame, target, accepts, fromEnd))
    );
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
  // Enum constants compare by their ordinals, the order these iterate in.
  EnumMap: 'sorted',
  EnumSet: 'sorted',
};

/** Gives a new map or set its entries, which a sorted one compares with `comparator` or in natural order. */
export function createStore(receiver: Value, capacity = 16, comparator?: Value): Value {
  const object = receiver as JavaObject;
  const store = new HashStore();
  store.capacity = capacity;
  store.order = STORE_ORDERS[object.cls.name] ?? 'hash';
  if (store.order === 'sorted') {
    store.comparator = comparator;
    if (comparator !== undefined) object.retained = [...(object.retained ?? []), comparator];
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
  if (store.compare) {
    const { index, isFound } = store.positionOf(frame, key);
    return isFound ? store.entries[index] : undefined;
  }
  const hash = javaHash(frame, key);
  return store.withHash(hash).find((entry) => javaEquals(frame, key, entry.key));
}

/** Adds or replaces an entry, returning the value it replaced or `NO_ENTRY`; a set keeps an existing entry. */
export function putEntry(
  frame: Frame,
  receiver: Value,
  key: Value,
  keepsExisting: boolean,
  value?: Value,
  atBucketHead = false
): Value | typeof NO_ENTRY {
  const store = storeOf(receiver);
  // Comparing a key with itself rejects null and keys that are not comparable, even in an empty map.
  if (store.compare && store.entries.length === 0) store.compare(frame, key, key);
  const position = store.compare ? store.positionOf(frame, key) : undefined;
  const entry = position
    ? position.isFound
      ? store.entries[position.index]
      : undefined
    : findEntry(frame, receiver, key);
  if (entry) {
    const previous = entry.value;
    if (!keepsExisting) entry.value = value;
    return previous;
  }
  frame.runtime.allocateArray(frame, 2);
  if (position) store.insertAt(position.index, { key, value, hash: 0 });
  else if (atBucketHead) store.addAtBucketHead({ key, value, hash: javaHash(frame, key) });
  else store.add({ key, value, hash: javaHash(frame, key) });
  touch(receiver);
  return NO_ENTRY;
}

export function removeEntry(frame: Frame, receiver: Value, key: Value): Value | typeof NO_ENTRY {
  const entry = findEntry(frame, receiver, key);
  if (!entry) return NO_ENTRY;
  const store = storeOf(receiver);
  store.remove(entry);
  touch(receiver);
  return entry.value;
}

/** The capacity Java's hash tables round a requested capacity up to: the next power of two. */
export function tableSizeFor(capacity: number): number {
  let size = 1;
  while (size < capacity) size *= 2;
  return Math.max(size, 1);
}
