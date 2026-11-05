import { stringify } from './builtins';
import { addInterface, addMethod, addTypeParameters, newString, type Registry } from './builtinSupport';
import { type BoxableKind, hashOf, type Wrappers } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  type ClassInfo,
  type ClassType,
  INT,
  type JavaType,
  sameErasure,
  superinterfacesOf,
  VOID,
} from './types';
import { charCodeOf, JavaArray, JavaObject, JavaString, toInt32, type Value } from './values';

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

export interface IteratorState {
  source: JavaObject;
  items: () => Value[];
  index: number;
  expectedModCount: number | undefined;
  removed: boolean;
  remove: (frame: Frame, index: number) => void;
}

export const iteratorStates = new WeakMap<JavaObject, IteratorState>();

export function iteratorState(receiver: Value): IteratorState {
  return iteratorStates.get(receiver as JavaObject) as IteratorState;
}

export function createIterator(
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

/**
 * Reads a collection's items again only after it changes structurally, as a view of a map computes its items on
 * every read, which would make each step of an iteration cost a pass over the map.
 */
function itemsUntilChanged(collection: JavaObject): () => Value[] {
  let items: Value[] | undefined;
  let readAt: number | undefined;
  return () => {
    if (!items || readAt !== collection.modCount) {
      items = elementsOf(collection);
      readAt = collection.modCount;
    }
    return items;
  };
}

export function elementsOf(receiver: Value): Value[] {
  return (receiver as JavaObject).elements as Value[];
}

export function touch(receiver: Value): void {
  const object = receiver as JavaObject;
  object.modCount = (object.modCount ?? 0) + 1;
}

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
      itemsUntilChanged(receiver as JavaObject),
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
  for (const name of ['add', 'addAll']) {
    addMethod(cls, name, [context.objectType], BOOLEAN, false, (frame) =>
      throwBuiltin(frame, 'UnsupportedOperationException')
    );
  }
  addMethod(cls, 'remove', [context.objectType], BOOLEAN, false, (frame, receiver, [value]) => {
    const index = indexOf(frame, elementsOf(receiver), value);
    if (index !== -1) removeElements(frame, receiver, (_, position) => position === index);
    return index !== -1;
  });
  addMethod(cls, 'clear', [], VOID, false, (frame, receiver) => {
    removeElements(frame, receiver, () => true);
  });
  linkOverrides(cls);
  return cls;
}

/**
 * For a view of a map's keys, values, or entries, removes the map's entry behind the view's element at an index,
 * which views of other collections lack.
 */
export const viewRemovals = new WeakMap<JavaObject, (frame: Frame, index: number) => void>();

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
  const removeBehind = viewRemovals.get(receiver as JavaObject);
  let removed = false;
  // From the end, so that removing an element keeps the indices of those before it.
  for (let index = elements.length - 1; index >= 0; index--) {
    if (!removes(elements[index], index)) continue;
    removeBehind?.(frame, index);
    elements.splice(index, 1);
    removed = true;
  }
  if (removed) touch(receiver);
  return removed;
}

/** The items of any builtin collection or array-backed view, in iteration order. */
export function itemsOf(frame: Frame, source: Value): Value[] {
  if (!(source instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
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

export function checkIndex(frame: Frame, index: number, length: number): void {
  if (index < 0 || index >= length) {
    throwBuiltin(frame, 'IndexOutOfBoundsException', `Index ${index} out of bounds for length ${length}`);
  }
}

export function checkPosition(frame: Frame, index: number, length: number): void {
  if (index < 0 || index > length) throwBuiltin(frame, 'IndexOutOfBoundsException', `Index: ${index}, Size: ${length}`);
}
