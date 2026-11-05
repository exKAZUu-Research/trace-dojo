import { classType, type Context, elementsOf, linkOverrides } from './builtinCollectionSupport';
import { addAbstractMethod, addInterface, addMethod, addTypeParameters, defineInterface } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, type ClassInfo, INT, type JavaType, VOID } from './types';
import type { JavaObject, Value } from './values';

/** Where a list iterator stands, as `ArrayList.ListItr` tracks it. */
interface ListIteratorState {
  list: JavaObject;
  cursor: number;
  /** The index of the element the last `next` or `previous` returned, or -1 after `add` or `remove`. */
  lastReturned: number;
  expectedModCount: number | undefined;
}

const states = new WeakMap<JavaObject, ListIteratorState>();

/** The classes of the lists `List.of` returns, whose iterators reject every edit before checking anything else. */
export const uneditableLists = new WeakSet<ClassInfo>();

/**
 * `ListIterator`, which walks a list both ways and edits it through the list's own `set`, `add`, and `remove`, so
 * that an unmodifiable list still rejects the edits. Returns the class that `listIterator()` creates.
 */
export function defineListIterator(context: Context, iteratorClass: ClassInfo, listClass: ClassInfo): ClassInfo {
  const iface = defineInterface(context.registry, 'ListIterator', 'java.util');
  const [element] = addTypeParameters(iface, ['E'], context.objectType);
  addInterface(iface, classType(iteratorClass, element));
  for (const [name, returnType] of [
    ['hasPrevious', BOOLEAN],
    ['previous', element],
    ['nextIndex', INT],
    ['previousIndex', INT],
  ] as const) {
    addAbstractMethod(iface, name, [], returnType);
  }
  addAbstractMethod(iface, 'set', [element], VOID);
  addAbstractMethod(iface, 'add', [element], VOID);
  const cls = context.registry.define('ListItr', context.objectClass, 'java.util');
  context.registry.classes.delete('ListItr');
  const [itemType] = addTypeParameters(cls, ['E'], context.objectType);
  addInterface(cls, classType(iface, itemType));
  defineMovements(cls, itemType);
  defineEdits(cls, itemType);
  linkOverrides(cls);
  const [listElement] = listClass.typeParameters.map((variable): JavaType => ({ kind: 'typeVar', variable }));
  for (const parameters of [[], [INT]])
    addAbstractMethod(listClass, 'listIterator', parameters, classType(iface, listElement));
  return cls;
}

/** A list class's `listIterator()` and `listIterator(int)`. */
export function addListIterators(cls: ClassInfo, element: JavaType, listItrClass: ClassInfo): void {
  for (const parameters of [[], [INT]]) {
    addMethod(
      cls,
      'listIterator',
      parameters,
      classType(listItrClass.interfaces[0], element),
      false,
      (frame, receiver, [index]) =>
        createListIterator(frame, listItrClass, receiver, (index as number | undefined) ?? 0)
    );
  }
}

function createListIterator(frame: Frame, cls: ClassInfo, list: Value, index: number): JavaObject {
  const size = elementsOf(list).length;
  if (index < 0 || index > size) throwBuiltin(frame, 'IndexOutOfBoundsException', `Index: ${index}`);
  const iterator = frame.runtime.allocateObject(frame, cls);
  const source = list as JavaObject;
  states.set(iterator, { list: source, cursor: index, lastReturned: -1, expectedModCount: source.modCount });
  // The iterator keeps its list alive, as the list's turtles must stay while it is walked.
  iterator.elements = [source];
  return iterator;
}

function defineMovements(cls: ClassInfo, element: JavaType): void {
  addMethod(cls, 'hasNext', [], BOOLEAN, false, (_, receiver) => {
    const state = stateOf(receiver);
    return state.cursor < elementsOf(state.list).length;
  });
  addMethod(cls, 'hasPrevious', [], BOOLEAN, false, (_, receiver) => stateOf(receiver).cursor > 0);
  addMethod(cls, 'nextIndex', [], INT, false, (_, receiver) => stateOf(receiver).cursor);
  addMethod(cls, 'previousIndex', [], INT, false, (_, receiver) => stateOf(receiver).cursor - 1);
  for (const [name, step] of [
    ['next', 1],
    ['previous', -1],
  ] as const) {
    addMethod(cls, name, [], element, false, (frame, receiver) => {
      const state = checkedState(frame, receiver);
      const index = step > 0 ? state.cursor : state.cursor - 1;
      const elements = elementsOf(state.list);
      if (index < 0 || index >= elements.length) throwBuiltin(frame, 'NoSuchElementException');
      state.cursor = step > 0 ? index + 1 : index;
      state.lastReturned = index;
      return elements[index];
    });
  }
}

function defineEdits(cls: ClassInfo, element: JavaType): void {
  addMethod(cls, 'remove', [], VOID, false, (frame, receiver) => {
    const state = checkedState(frame, receiver, true);
    if (state.lastReturned < 0) throwBuiltin(frame, 'IllegalStateException');
    callListMethod(frame, state.list, 'remove', [state.lastReturned]);
    state.cursor = state.lastReturned;
    state.lastReturned = -1;
    state.expectedModCount = state.list.modCount;
  });
  addMethod(cls, 'set', [element], VOID, false, (frame, receiver, [value]) => {
    const state = checkedState(frame, receiver, true);
    if (state.lastReturned < 0) throwBuiltin(frame, 'IllegalStateException');
    callListMethod(frame, state.list, 'set', [state.lastReturned, value]);
  });
  addMethod(cls, 'add', [element], VOID, false, (frame, receiver, [value]) => {
    const state = checkedState(frame, receiver, true);
    callListMethod(frame, state.list, 'add', [state.cursor, value]);
    state.cursor++;
    state.lastReturned = -1;
    state.expectedModCount = state.list.modCount;
  });
}

function stateOf(receiver: Value): ListIteratorState {
  return states.get(receiver as JavaObject) as ListIteratorState;
}

/** The iterator's state, after checking that its list has not changed structurally behind it. */
function checkedState(frame: Frame, receiver: Value, isEdit = false): ListIteratorState {
  const state = stateOf(receiver);
  if (isEdit && uneditableLists.has(state.list.cls)) throwBuiltin(frame, 'UnsupportedOperationException');
  if (state.list.modCount !== state.expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
  return state;
}

/** Calls the list's own indexed `name`, whose first parameter is the index. */
function callListMethod(frame: Frame, list: JavaObject, name: string, args: Value[]): void {
  const method = list.cls.methods.find(
    (candidate) =>
      candidate.name === name &&
      candidate.parameterTypes.length === args.length &&
      candidate.parameterTypes[0]?.kind === 'int'
  );
  if (!method) throw new Error(`${list.cls.name}.${name} is missing`);
  frame.runtime.invoke(frame, method, list, args, undefined);
}
