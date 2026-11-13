import { classCastMessage } from './builtinClass';
import { stringify } from './builtins';
import { addInterface, addMethod, addTypeParameters, newString, type Registry } from './builtinSupport';
import { type BoxableKind, hashOf, type Wrappers } from './builtinWrappers';
import { type Frame, JavaThrow, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  type ClassInfo,
  type ClassType,
  INT,
  type JavaType,
  type NativeMethod,
  sameErasure,
  superinterfacesOf,
  VOID,
} from './types';
import { charCodeOf, type HashStore, JavaArray, JavaObject, JavaString, toInt32, type Value } from './values';

export interface Context {
  registry: Registry;
  objectClass: ClassInfo;
  objectType: JavaType;
  stringType: JavaType;
  wrappers: Wrappers;
}

export const classType = (cls: ClassInfo, ...args: JavaType[]): ClassType => ({ kind: 'class', cls, args });

/** The iterator every builtin collection returns, which fails fast when its collection changes structurally. */
export function defineIteratorClass(context: Context, iteratorClass: ClassInfo): ClassInfo {
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
    const items = state.items();
    // A TreeMap's iterators, its sets' and views' included, find the end before checking for a change.
    const isSorted = (mapViewSources.get(state.source)?.map ?? state.source).store?.compare !== undefined;
    if (isSorted && state.index >= items.length) throwBuiltin(frame, 'NoSuchElementException');
    if (state.source.modCount !== state.expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
    if (state.index >= items.length) throwBuiltin(frame, 'NoSuchElementException');
    state.removed = false;
    return items[state.index++];
  });
  addMethod(itrClass, 'remove', [], VOID, false, removeThroughIterator);
  linkOverrides(itrClass);
  return itrClass;
}

/** `Iterator.remove`, which removes the element the last `next()` returned, as the JDK's iterators check it. */
function removeThroughIterator(frame: Frame, receiver: Value): Value {
  const state = iteratorState(receiver);
  // A read-only wrapper rejects removal without a message, before its backing iterator's own rule.
  if (unmodifiableWrappers.has(state.source)) throwBuiltin(frame, 'UnsupportedOperationException');
  const owner = mapViewSources.get(state.source)?.map ?? state.source;
  // The iterators of ImmutableCollections and of the singletons reject every removal before checking their state;
  // those AbstractList and AbstractSet give check it first, and then reach the removal their collection rejects.
  if (defaultRemoveClasses.has(owner.cls) && !unmodifiableWrappers.has(owner)) {
    throwBuiltin(frame, 'UnsupportedOperationException', 'remove');
  }
  if (eagerlyRejectingClasses.has(owner.cls) || singletonClasses.has(owner.cls)) {
    throwBuiltin(frame, 'UnsupportedOperationException');
  }
  // Only the element the last next() returned may be removed, once.
  if (state.removed) throwBuiltin(frame, 'IllegalStateException');
  if (state.source.modCount !== state.expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
  checkModifiable(frame, owner, true);
  // A list's later elements move back over the removed one, which a fixed sequence of elements keeps.
  if (state.isFixed) state.remove(frame, state.index - 1);
  else state.remove(frame, --state.index);
  state.removed = true;
  state.expectedModCount = state.source.modCount;
  return undefined;
}

export interface IteratorState {
  source: JavaObject;
  items: () => Value[];
  index: number;
  expectedModCount: number | undefined;
  removed: boolean;
  remove: (frame: Frame, index: number) => void;
  /**
   * Whether the iterator walks the elements its collection had when it started, as the iterators of `HashMap`,
   * `TreeMap`, their sets, and their views do, rather than reading a list's elements as they are.
   */
  isFixed: boolean;
}

export const iteratorStates = new WeakMap<JavaObject, IteratorState>();

export function iteratorState(receiver: Value): IteratorState {
  return iteratorStates.get(receiver as JavaObject) as IteratorState;
}

/**
 * An iterator over `items`, which a list reads as they are on each step and a hash- or tree-based collection
 * (`isFixed`) fixes when the iterator starts: there `hasNext` follows the elements it started with, and a change made
 * other than through the iterator throws `ConcurrentModificationException` on the next step, as the JDK's do.
 */
export function createIterator(
  frame: Frame,
  itrClass: ClassInfo,
  source: JavaObject,
  items: () => Value[],
  remove: (frame: Frame, index: number) => void,
  isFixed = false
): JavaObject {
  // A sublist, or a wrapper of one, checks its list when it creates an iterator, as its listIterator does.
  subListChecks.get(source)?.();
  const iterator = frame.runtime.allocateObject(frame, itrClass);
  const fixed = isFixed ? items() : undefined;
  iteratorStates.set(iterator, {
    source,
    items: fixed ? () => fixed : items,
    index: 0,
    expectedModCount: source.modCount,
    removed: true,
    remove,
    isFixed,
  });
  // The iterator keeps its collection alive, as the collection's turtles must stay while it is walked.
  iterator.elements = [source];
  return iterator;
}

/** Marks each native method as implementing the interface methods of the same name and erased signature. */
export function linkOverrides(cls: ClassInfo): void {
  const inherited = superinterfacesOf(cls).flatMap((parent) => parent.methods);
  for (const method of cls.methods) {
    if (method.isStatic) continue;
    const overridden = inherited.filter(
      (other) =>
        other.name === method.name &&
        other.parameterTypes.length === method.parameterTypes.length &&
        other.parameterTypes.every((type, index) => sameErasure(type, method.parameterTypes[index]))
    );
    if (overridden.length > 0) method.overrides = new Set(overridden);
  }
}

/** How a view of a map's keys, values, or entries reads and removes the map's entries. */
export interface MapViewSource {
  map: JavaObject;
  store: () => HashStore;
  entries: () => HashStore['entries'];
  elementOf: (entry: HashStore['entries'][number]) => Value;
  /** Whether the view is a key set, which a sorted map's is a `SortedSet` with the map's comparator. */
  isKeySet?: boolean;
  /** The map's lookup that the view's `contains` makes, as `AbstractMap`'s key set and values make one. */
  lookup?: 'containsKey' | 'containsValue';
  remove: (frame: Frame, entry: HashStore['entries'][number]) => void;
}

/**
 * Visits the entries of a map or of its view as their `forEach` does in the JDK: a `HashMap` or
 * `LinkedHashMap` walks its live entries, skipping those removed before they are reached, and throws
 * `ConcurrentModificationException` at the end if the map changed; a `TreeMap` throws as soon as it changed.
 *
 * @param owner The collection or view whose `modCount` counts the changes.
 */
export function forEachLiveEntry(
  frame: Frame,
  owner: JavaObject,
  store: () => HashStore,
  visit: (entry: HashStore['entries'][number]) => void
): void {
  const expectedModCount = owner.modCount;
  for (const entry of store().ordered()) {
    if (owner.modCount !== expectedModCount) {
      if (store().order === 'sorted') throwBuiltin(frame, 'ConcurrentModificationException');
      if (!store().entries.includes(entry)) continue;
    }
    visit(entry);
  }
  if (owner.modCount !== expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
}

/** The maps behind the views that `keySet`, `values`, and `entrySet` return. */
export const mapViewSources = new WeakMap<JavaObject, MapViewSource>();

/**
 * An iterator over a map view, which walks the entries the map had when it started and reads each element, such as
 * an entry's current value, when `next` reaches it, as the JDK's do.
 */
function mapViewIterator(frame: Frame, itrClass: ClassInfo, view: JavaObject, source: MapViewSource): JavaObject {
  const entries = source.entries();
  const elements = new Proxy(entries, {
    get: (target, property, receiver) =>
      typeof property === 'string' && /^\d+$/.test(property)
        ? source.elementOf(target[Number(property)] as HashStore['entries'][number])
        : (Reflect.get(target, property, receiver) as unknown),
  }) as unknown as Value[];
  return createIterator(
    frame,
    itrClass,
    view,
    () => elements,
    (removeFrame, index) => source.remove(removeFrame, entries[index] as HashStore['entries'][number]),
    true
  );
}

/**
 * The classes of the collections that reject every change: those of `List.of`, `Set.of`, `Map.of`, the unmodifiable
 * views, and `Collections`' empty, singleton, and `nCopies` collections.
 */
export const unmodifiableClasses = new WeakSet<ClassInfo>();

/**
 * The classes among `unmodifiableClasses` whose every mutator, inherited defaults included, throws before it reads its
 * arguments, as `ImmutableCollections` and the `Collections.unmodifiable` wrappers override each one. The other
 * restricted classes extend `AbstractList`, `AbstractSet`, or `AbstractMap`, whose methods reject a call only when it
 * reaches the change it would make, so that a call that changes nothing succeeds.
 */
export const eagerlyRejectingClasses = new WeakSet<ClassInfo>();

/**
 * `Collections.singletonList` and `singleton`, which override `removeIf` and `replaceAll` to throw at once and whose
 * iterators reject removal before checking their state, unlike the defaults their `AbstractList` and `AbstractSet`
 * would give.
 */
export const singletonClasses = new WeakSet<ClassInfo>();

/** The classes of the lists that may change elements but not their size, as `Arrays.asList` returns. */
export const fixedSizeClasses = new WeakSet<ClassInfo>();

/**
 * The classes whose iterators keep `Iterator.remove`'s default, which throws `UnsupportedOperationException` with the
 * message "remove": `Set.of`'s and `Map.of`'s collections and `Arrays.asList`'s list.
 */
export const defaultRemoveClasses = new WeakSet<ClassInfo>();

/**
 * The collections whose `removeIf` tests every element before removing any, as ArrayList's, Vector's, ArrayDeque's,
 * and PriorityQueue's do; the others remove each match through their iterator, as Collection's default does.
 */
export const batchRemovalClasses = new WeakSet<ClassInfo>();

/** The maps whose JDK classes count no changes, as EnumMap, so that their compute methods never fail fast. */
export const uncountedMapClasses = new WeakSet<ClassInfo>();

/** Restores the order a class keeps among its elements after a bulk removal compacts them, as a heap's. */
export const bulkRemovalRepairs = new WeakMap<ClassInfo, (frame: Frame, receiver: Value) => void>();

/** The `Collections.unmodifiableSet` and `unmodifiableMap` wrappers, whose iterators reject removal without a message. */
export const unmodifiableWrappers = new WeakSet<JavaObject>();

/**
 * Makes `view` an unmodifiable wrapper of `source`, whose elements it shares: it follows the changes made to
 * `source`, so that its iterators fail fast on them, and keeps `source` alive.
 */
export function wrapUnmodifiable(view: JavaObject, source: JavaObject): JavaObject {
  Object.defineProperty(view, 'modCount', { get: () => source.modCount, set: () => {} });
  if (source.elements) Object.defineProperty(view, 'elements', { get: () => source.elements, set: () => {} });
  view.retained = [source];
  // A wrapper reads through its source, so a wrapped sublist's reads fail as the sublist's do.
  const check = subListChecks.get(source);
  if (check) subListChecks.set(view, check);
  unmodifiableWrappers.add(view);
  return view;
}

/**
 * Throws `UnsupportedOperationException` for a change to a collection that rejects it, as every method that changes
 * a collection checks, defaults and `Collections` utilities included.
 *
 * @param changesSize Whether the change adds or removes elements, which a fixed-size list rejects too.
 */
export function checkModifiable(frame: Frame, collection: Value, changesSize: boolean): void {
  // A sublist changes its list, which rejects the change as it rejects its own.
  const { cls } = rootListOf(collection as JavaObject);
  if (unmodifiableClasses.has(cls) || (changesSize && fixedSizeClasses.has(cls))) {
    throwBuiltin(frame, 'UnsupportedOperationException');
  }
}

/** Throws at the start of a mutator of a collection whose class rejects every call, before its arguments are read. */
export function rejectEagerly(frame: Frame, collection: Value): void {
  if (eagerlyRejectingClasses.has((collection as JavaObject).cls)) throwBuiltin(frame, 'UnsupportedOperationException');
}

/**
 * Checks a removal that `AbstractCollection` makes through the collection's iterator, which rejects it with the message
 * of `Iterator.remove`'s default for the classes whose iterators keep it.
 */
export function checkRemovable(frame: Frame, collection: Value): void {
  const owner = mapViewSources.get(collection as JavaObject)?.map ?? (collection as JavaObject);
  if (defaultRemoveClasses.has(owner.cls) && !unmodifiableWrappers.has(owner)) {
    throwBuiltin(frame, 'UnsupportedOperationException', 'remove');
  }
  checkModifiable(frame, collection, true);
}

/**
 * Whether clearing `list` while it is empty counts as a change, as `ArrayList`, `LinkedList`, and `Vector` count it
 * and so does a sublist whose list's `removeRange` does, unlike `AbstractList`'s, which `LinkedList` and the restricted
 * lists inherit.
 */
export function countsEmptyClear(list: Value): boolean {
  const root = rootListOf(list as JavaObject);
  if (unmodifiableClasses.has(root.cls) || fixedSizeClasses.has(root.cls)) return false;
  return root === list || checkingClassOf(root).name !== 'LinkedList';
}

/** The lists of `Stream.toList`, which are of `List.of`'s class but may hold and look up null. */
export const nullTolerantLists = new WeakSet<JavaObject>();

/**
 * The classes of `ImmutableCollections`, whose lookups reject a null argument, with the message their JDK
 * implementation class of a collection's size gives.
 */
const nullRejectingClasses = new WeakMap<ClassInfo, (collection: JavaObject, name: string) => string | undefined>();

/** Marks a class of `ImmutableCollections`, whose lookups reject a null argument with the message `messageOf` gives. */
export function rejectNullLookups(
  cls: ClassInfo,
  messageOf: (receiver: JavaObject, name: string) => string | undefined = () => {}
): void {
  nullRejectingClasses.set(cls, messageOf);
}

const NULL_CHECKED_LOOKUPS = new Set([
  'contains',
  'indexOf',
  'lastIndexOf',
  'get',
  'containsKey',
  'containsValue',
  'getOrDefault',
]);

/**
 * Makes the value lookups of every builtin collection and map class behave as their JDK classes' do: an unmodifiable
 * wrapper asks the collection it wraps, as `Collections.UnmodifiableCollection` delegates, so that the wrapped class's
 * own rules hold; and a lookup throws `NullPointerException` for a null argument when the collection it reads rejects
 * null, which may be the one a sublist or a map's key set or values reads, whose class may be shared with a
 * collection that accepts null.
 */
export function checkNullLookups(classes: Iterable<ClassInfo>, collectionClass: ClassInfo, mapClass: ClassInfo): void {
  for (const cls of classes) {
    const parents = superinterfacesOf(cls);
    if (cls.kind === 'interface' || !(parents.includes(collectionClass) || parents.includes(mapClass))) continue;
    for (const method of cls.methods) {
      const { native, name } = method;
      if (native && NULL_CHECKED_LOOKUPS.has(name) && method.parameterTypes[0]?.kind !== 'int') {
        method.native = lookingUp(native, name);
      }
    }
  }
}

function lookingUp(native: NativeMethod, name: string): NativeMethod {
  return (frame, receiver, args) => {
    const object = receiver as JavaObject;
    if (unmodifiableWrappers.has(object)) {
      const { collectionClass, listClass, mapClass } = frame.runtime.builtins.collections;
      const owner = name === 'contains' ? collectionClass : name.endsWith('ndexOf') ? listClass : mapClass;
      return frame.runtime.invokeVirtual(frame, owner, name, object.retained?.[0], args);
    }
    if (args[0] === undefined) {
      const [source, lookup] = readSourceOf(object, name);
      const messageOf = nullRejectingClasses.get(source.cls);
      if (messageOf && !nullTolerantLists.has(source))
        throwBuiltin(frame, 'NullPointerException', messageOf(source, lookup));
    }
    return native(frame, receiver, args);
  };
}

/**
 * The collection a lookup `name` reaches through any nesting of unmodifiable wrappers, sublists, and a map's key set
 * or values, which look up through the map, and the lookup it makes there.
 */
function readSourceOf(collection: JavaObject, name: string): [JavaObject, string] {
  let [source, lookup] = [collection, name];
  for (;;) {
    const view = mapViewSources.get(source);
    if (view?.lookup) {
      [source, lookup] = [view.map, view.lookup];
      continue;
    }
    const next = unmodifiableWrappers.has(source) || subListChecks.has(source) ? source.retained?.[0] : undefined;
    if (!(next instanceof JavaObject)) return [source, lookup];
    source = next;
  }
}

/**
 * Whether `collection` is the key set of a `HashMap` or `TreeMap`, whose membership its map's `containsKey` decides,
 * which a TreeMap does by its comparator; the restricted maps' key sets are AbstractMap's, which compare by equals.
 */
function looksUpThroughMap(collection: Value): boolean {
  const view = mapViewSources.get(collection as JavaObject);
  return view?.isKeySet === true && !unmodifiableClasses.has(lookupMapOf(view).cls);
}

/** The map whose lookup a key set asks: its map, or the map an unmodifiable wrapper of it wraps. */
function lookupMapOf(view: MapViewSource): JavaObject {
  let { map } = view;
  while (unmodifiableWrappers.has(map)) map = map.retained?.[0] as JavaObject;
  return map;
}

/** The list a sublist views, through any nesting of sublists, or the collection itself when it is not a sublist. */
function rootListOf(collection: JavaObject): JavaObject {
  let list = collection;
  while (subListChecks.has(list) && !unmodifiableWrappers.has(list)) list = list.retained?.[0] as JavaObject;
  return list;
}

/** The list an unmodifiable wrapper wraps, through any nesting of wrappers. */
function unwrapped(list: JavaObject): JavaObject {
  let backing = list;
  while (unmodifiableWrappers.has(backing)) backing = backing.retained?.[0] as JavaObject;
  return backing;
}

export function elementsOf(receiver: Value): Value[] {
  subListChecks.get(receiver as JavaObject)?.();
  return (receiver as JavaObject).elements as Value[];
}

/** The checks of sublists, which fail once their list changed in size other than through them, as the JDK's do. */
export const subListChecks = new WeakMap<JavaObject, () => void>();

export function touch(receiver: Value): void {
  const object = receiver as JavaObject;
  object.modCount = (object.modCount ?? 0) + 1;
  // A sublist grows the array of the Stack it views.
  const stack = rootListOf(object);
  const capacity = vectorCapacities.get(stack);
  if (capacity === undefined) return;
  // Vector grows its array to twice its length, or to the size needed if that is more, and never shrinks it.
  const size = (stack.elements as Value[]).length;
  if (size > capacity) vectorCapacities.set(stack, Math.max(capacity * 2, size));
}

/** The length of each `Stack`'s array, which its index messages report. */
export const vectorCapacities = new WeakMap<JavaObject, number>();

/** The methods that read a collection whose `elements` hold its items in iteration order. */
export function defineReadMethods(
  cls: ClassInfo,
  element: JavaType,
  context: Context,
  itrClass: ClassInfo,
  remove: (frame: Frame, receiver: Value, index: number) => void
): void {
  addMethod(cls, 'size', [], INT, false, (_, receiver) => elementsOf(receiver).length);
  addMethod(cls, 'isEmpty', [], BOOLEAN, false, (_, receiver) => elementsOf(receiver).length === 0);
  addMethod(cls, 'contains', [context.objectType], BOOLEAN, false, (frame, receiver, [value]) =>
    looksUpThroughMap(receiver)
      ? frame.runtime.invokeVirtual(
          frame,
          frame.runtime.builtins.collections.mapClass,
          'containsKey',
          mapViewSources.get(receiver as JavaObject)?.map,
          [value]
        )
      : indexOf(frame, elementsOf(receiver), value) !== -1
  );
  addMethod(cls, 'iterator', [], { kind: 'class', cls: itrClass, args: [element] }, false, (frame, receiver) => {
    const view = mapViewSources.get(receiver as JavaObject);
    if (view) return mapViewIterator(frame, itrClass, receiver as JavaObject, view);
    return createIterator(
      frame,
      itrClass,
      receiver as JavaObject,
      // As the JDK's, hasNext reads the size without a sublist's check, which next makes through the modCount.
      () => (receiver as JavaObject).elements as Value[],
      (removeFrame, index) => remove(removeFrame, receiver, index)
    );
  });
  addMethod(cls, 'toString', [], context.stringType, false, (frame, receiver) =>
    newString(
      frame,
      `[${elementsOf(receiver)
        .map((item) => describe(frame, item, receiver))
        .join(', ')}]`
    )
  );
}

/**
 * The views that `keySet`, `values`, and `entrySet` return, which read the map's current contents whenever they are
 * used and remove the map's entries behind the elements removed from them, but cannot add elements.
 */
export function defineSnapshot(context: Context, kind: string, parent: ClassInfo, itrClass: ClassInfo): ClassInfo {
  const cls = context.registry.define(`Snapshot${kind}`, context.objectClass, 'java.util');
  context.registry.classes.delete(cls.name);
  const [element] = addTypeParameters(cls, ['E'], context.objectType);
  addInterface(cls, classType(parent, element));
  defineReadMethods(cls, element, context, itrClass, (frame, receiver, index) => {
    removeElements(frame, receiver, (_, position) => position === index);
  });
  const collectionClass = context.registry.classes.get('Collection') as ClassInfo;
  for (const [name, parameter] of [
    ['add', element],
    ['addAll', classType(collectionClass, { kind: 'wildcard', bound: element, isSuper: false })],
  ] as const) {
    addMethod(cls, name, [parameter], BOOLEAN, false, (frame) => throwBuiltin(frame, 'UnsupportedOperationException'));
  }
  addMethod(cls, 'remove', [context.objectType], BOOLEAN, false, (frame, receiver, [value]) => {
    const view = mapViewSources.get(receiver as JavaObject);
    if (view && looksUpThroughMap(receiver)) {
      const { mapClass } = frame.runtime.builtins.collections;
      if (frame.runtime.invokeVirtual(frame, mapClass, 'containsKey', view.map, [value]) !== true) return false;
      // TreeMap.KeySet removes through its map, which finds the key by its comparator rather than by equals.
      if (view.store().compare) {
        frame.runtime.invokeVirtual(frame, mapClass, 'remove', view.map, [value]);
        return true;
      }
    }
    const index = indexOf(frame, elementsOf(receiver), value);
    if (index === -1) return false;
    // As AbstractCollection.remove does, it removes through the view's iterator.
    checkRemovable(frame, receiver);
    removeElements(frame, receiver, (_, position) => position === index);
    return true;
  });
  addMethod(cls, 'clear', [], VOID, false, (frame, receiver) => {
    removeElements(frame, receiver, () => true);
  });
  linkOverrides(cls);
  return cls;
}

/**
 * Removes the elements that `removes` selects from a collection whose `elements` hold its items, and through a view,
 * the entries of the map behind them, returning whether it removed any.
 */
export function removeElements(
  frame: Frame,
  receiver: Value,
  removes: (item: Value, index: number) => boolean
): boolean {
  const elements = elementsOf(receiver);
  // A view of a map removes the map's entries behind the elements, which it reads afresh from the map.
  const view = mapViewSources.get(receiver as JavaObject);
  const entries = view?.entries();
  let removed = false;
  // From the end, so that removing an element keeps the indices of those before it.
  for (let index = elements.length - 1; index >= 0; index--) {
    if (!removes(elements[index], index)) continue;
    if (view && entries) view.remove(frame, entries[index] as HashStore['entries'][number]);
    elements.splice(index, 1);
    removed = true;
  }
  if (removed) {
    // The removal counts even when the repair fails, as a comparator that throws while a heap is restored does.
    touch(receiver);
    for (let cls: ClassInfo | undefined = (receiver as JavaObject).cls; cls; cls = cls.superclass) {
      bulkRemovalRepairs.get(cls)?.(frame, receiver);
    }
  }
  return removed;
}

/** The items of any builtin collection or array-backed view, in iteration order. */
export function itemsOf(frame: Frame, source: Value): Value[] {
  if (!(source instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
  subListChecks.get(source)?.();
  if (source.elements) return source.elements;
  if (source.store) return source.store.ordered().map((entry) => entry.key);
  return throwBuiltin(frame, 'UnsupportedOperationException');
}

export function indexOf(frame: Frame, items: Value[], value: Value): number {
  return items.findIndex((item) => javaEquals(frame, value, item));
}

/** Formats an element as a collection's `toString` does, naming the collection itself to avoid endless recursion. */
export function describe(frame: Frame, item: Value, owner: Value): string {
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
    return throwBuiltin(frame, 'ClassCastException', classCastMessage(frame, a, 'java.lang.Comparable'));
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

/** How a list class reports an index outside it, as the JDK implementation it stands for checks the index. */
export const indexFailures = new Map<
  ClassInfo,
  (frame: Frame, index: number, length: number, list: JavaObject) => never
>();

/** The classes of `List.of`, whose position checks write their messages without a comma. */
export const immutableCollectionsLists = new WeakSet<ClassInfo>();

/** Checks the index of an element of `list`, which an unmodifiable wrapper leaves to the list it wraps. */
export function checkListIndex(frame: Frame, list: Value, index: number, length: number): void {
  if (index >= 0 && index < length) return;
  indexFailures.get(checkingClassOf(list))?.(frame, index, length, list as JavaObject);
  checkIndex(frame, index, length);
}

/** Checks the position `listIterator` starts at, which may be the size of the list. */
export function checkListPosition(frame: Frame, list: Value, index: number, length: number): void {
  if (index >= 0 && index <= length) return;
  const cls = checkingClassOf(list);
  // Vector.listIterator names only the index.
  if (cls.name === 'Stack') throwBuiltin(frame, 'IndexOutOfBoundsException', `Index: ${index}`);
  const separator = immutableCollectionsLists.has(cls) ? '' : ',';
  throwBuiltin(frame, 'IndexOutOfBoundsException', `Index: ${index}${separator} Size: ${length}`);
}

/** The class whose checks a list's methods make, which is that of the list an unmodifiable wrapper wraps. */
function checkingClassOf(list: Value): ClassInfo {
  // A program's subclass of a list inherits its builtin superclass's checks.
  let { cls } = unwrapped(list as JavaObject);
  while (!cls.isBuiltin && cls.superclass) cls = cls.superclass;
  return cls;
}

/**
 * Whether a sort, a `replaceAll`, or an `addAll` of nothing counts as a structural change of `list`, as `ArrayList` and
 * `Vector` count them, unlike sublists, `LinkedList`, and the `AbstractList` classes of `Arrays.asList` and
 * `Collections`.
 */
export function countsNoOpChanges(list: Value): boolean {
  if (subListChecks.has(list as JavaObject)) return false;
  const cls = checkingClassOf(list);
  return (cls.name === 'ArrayList' && !fixedSizeClasses.has(cls)) || cls.name === 'Stack';
}

/**
 * Reports an index outside a list as its JDK class does: an array access for `List.of`, `Arrays.asList`, and `Stack`, and
 * messages of their own for the other lists that do not call `Objects.checkIndex`.
 */
export function defineIndexFailures(lists: Record<string, ClassInfo>, registry: Context['registry']): void {
  indexFailures.set(lists.immutableList, arrayAccessFailure);
  indexFailures.set(lists.fixedSizeList, arrayAccessFailure);
  indexFailures.set(lists.pairList, (frame, index, length) =>
    throwBuiltin(frame, 'IndexOutOfBoundsException', `Index: ${index} Size: ${length}`)
  );
  indexFailures.set(lists.emptyList, (frame, index) =>
    throwBuiltin(frame, 'IndexOutOfBoundsException', `Index: ${index}`)
  );
  indexFailures.set(lists.singletonList, sizedIndexFailure);
  indexFailures.set(registry.classes.get('LinkedList') as ClassInfo, sizedIndexFailure);
  // A Vector checks only the upper bound and reads its array.
  indexFailures.set(registry.classes.get('Stack') as ClassInfo, (frame, index, length, list) => {
    if (index >= length) throwBuiltin(frame, 'ArrayIndexOutOfBoundsException', `Array index out of range: ${index}`);
    return arrayAccessFailure(frame, index, vectorCapacities.get(unwrapped(list)) ?? 10);
  });
}

function arrayAccessFailure(frame: Frame, index: number, length: number): never {
  return throwBuiltin(frame, 'ArrayIndexOutOfBoundsException', `Index ${index} out of bounds for length ${length}`);
}

function sizedIndexFailure(frame: Frame, index: number, length: number): never {
  return throwBuiltin(frame, 'IndexOutOfBoundsException', `Index: ${index}, Size: ${length}`);
}

export function checkIndex(frame: Frame, index: number, length: number): void {
  if (index < 0 || index >= length) {
    throwBuiltin(frame, 'IndexOutOfBoundsException', `Index ${index} out of bounds for length ${length}`);
  }
}

/**
 * Checks the position `add(int, E)` or, when `isBulk`, `addAll(int, Collection)` inserts at, which a `Stack` reports
 * as `Vector.insertElementAt` and `Vector.addAll` do, with array messages, and the other lists as `ArrayList` does.
 */
export function checkInsertPosition(frame: Frame, list: Value, index: number, length: number, isBulk: boolean): void {
  if (index >= 0 && index <= length) return;
  if (checkingClassOf(list).name === 'Stack') {
    if (isBulk) throwBuiltin(frame, 'ArrayIndexOutOfBoundsException', `Array index out of range: ${index}`);
    if (index > length) throwBuiltin(frame, 'ArrayIndexOutOfBoundsException', `${index} > ${length}`);
    // insertElementAt grows a full array before its arraycopy rejects the negative index.
    const capacity = vectorCapacities.get(unwrapped(list as JavaObject)) ?? 10;
    const grown = length === capacity ? Math.max(capacity * 2, length + 1) : capacity;
    throwBuiltin(
      frame,
      'ArrayIndexOutOfBoundsException',
      `arraycopy: source index ${index} out of bounds for object array[${grown}]`
    );
  }
  checkPosition(frame, index, length);
}

export function checkPosition(frame: Frame, index: number, length: number): void {
  if (index < 0 || index > length) throwBuiltin(frame, 'IndexOutOfBoundsException', `Index: ${index}, Size: ${length}`);
}

/**
 * `equals` and `hashCode` of a set, a map's key set, or its entry set, as `AbstractSet` gives them: equal to any set
 * of equal elements, and hashed as the sum of the elements' hashes.
 */
export function defineSetEquality(cls: ClassInfo, context: Context, setClass: ClassInfo): void {
  addMethod(cls, 'equals', [context.objectType], BOOLEAN, false, (frame, receiver, [other]) => {
    if (other === receiver) return true;
    if (!(other instanceof JavaObject) || !frame.runtime.isInstance(other, setClass)) return false;
    if (!other.store && !other.elements) return false;
    return containsAllOf(frame, receiver, itemsOf(frame, other), itemsOf(frame, receiver).length);
  });
  addMethod(cls, 'hashCode', [], INT, false, (frame, receiver) => sumOfHashes(frame, itemsOf(frame, receiver)));
}

/**
 * Whether a set of `size` elements equals a set of `theirs`, as `AbstractSet.equals` decides: as many elements, each of
 * them found by the set's own `contains`, so a sorted set or key set finds them by its comparator; a lookup that
 * rejects an element with `NullPointerException` or `ClassCastException` makes the sets unequal.
 */
function containsAllOf(frame: Frame, set: Value, theirs: readonly Value[], size: number): boolean {
  if (theirs.length !== size) return false;
  const { collectionClass } = frame.runtime.builtins.collections;
  try {
    return theirs.every(
      (item) => frame.runtime.invokeVirtual(frame, collectionClass, 'contains', set, [item]) === true
    );
  } catch (error) {
    const name = error instanceof JavaThrow ? error.value.cls.name : undefined;
    if (name === 'NullPointerException' || name === 'ClassCastException') return false;
    throw error;
  }
}

/** The sum of the elements' hashes that `Set.hashCode` specifies. */
function sumOfHashes(frame: Frame, items: readonly Value[]): number {
  let sum = 0;
  for (const item of items) sum = toInt32(sum + (item === undefined ? 0 : javaHash(frame, item)));
  return sum;
}

/**
 * The values sorted stably by `compare`, which also receives nulls: JavaScript's sort would put `undefined`, the
 * interpreter's null, last without asking the comparator, where a Java comparator such as `nullsFirst` decides.
 */
export function sortedValues(values: readonly Value[], compare: (a: Value, b: Value) => number): Value[] {
  return values
    .map((_, index) => index)
    .toSorted((i, j) => compare(values[i], values[j]))
    .map((index) => values[index]);
}
