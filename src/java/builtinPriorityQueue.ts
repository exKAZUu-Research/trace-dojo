import {
  classType,
  compareNatural,
  type Context,
  defineReadMethods,
  elementsOf,
  indexOf,
  itemsOf,
  linkOverrides,
  touch,
} from './builtinCollectionSupport';
import { callFunction } from './builtinFunctions';
import { lazyComparator } from './builtinMaps';
import { addConstructor, addInterface, addMethod, addTypeParameters } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, type ClassInfo, INT, type JavaType, VOID } from './types';
import { type JavaObject, type Value } from './values';

const comparators = new WeakMap<JavaObject, Value>();

/**
 * `PriorityQueue`, a binary heap in `elements` that sifts as the JDK's does, so that its iteration order and
 * `toString` match.
 */
export function definePriorityQueue(
  context: Context,
  lists: { collectionClass: ClassInfo; itrClass: ClassInfo },
  queueClass: ClassInfo
): ClassInfo {
  const cls = context.registry.define('PriorityQueue', context.objectClass, 'java.util');
  const [element] = addTypeParameters(cls, ['E'], context.objectType);
  addInterface(cls, classType(queueClass, element));
  const comparatorType: JavaType = classType(lazyComparator, { kind: 'wildcard', bound: element, isSuper: true });
  addConstructor(cls, [], (_, receiver) => create(receiver));
  addConstructor(cls, [INT], (frame, receiver, [capacity]) => {
    if ((capacity as number) < 1) throwBuiltin(frame, 'IllegalArgumentException');
    return create(receiver);
  });
  addConstructor(cls, [comparatorType], (_, receiver, [comparator]) => create(receiver, comparator));
  addConstructor(cls, [INT, comparatorType], (frame, receiver, [capacity, comparator]) => {
    if ((capacity as number) < 1) throwBuiltin(frame, 'IllegalArgumentException');
    return create(receiver, comparator);
  });
  addConstructor(
    cls,
    [classType(lists.collectionClass, { kind: 'wildcard', bound: element, isSuper: false })],
    (frame, receiver, [source]) => {
      create(receiver);
      const heap = elementsOf(receiver);
      for (const item of itemsOf(frame, source)) {
        if (item === undefined) throwBuiltin(frame, 'NullPointerException');
        heap.push(item);
      }
      frame.runtime.allocateArray(frame, heap.length);
      for (let index = (heap.length >>> 1) - 1; index >= 0; index--) siftDown(frame, receiver, index, heap[index]);
    }
  );
  defineReadMethods(cls, element, context, lists.itrClass, (frame, receiver, index) => {
    removeAt(frame, receiver, index);
  });
  defineQueueOperations(cls, element, context, lists.collectionClass);
  linkOverrides(cls);
  return cls;
}

function create(receiver: Value, comparator?: Value): undefined {
  const queue = receiver as JavaObject;
  queue.elements = [];
  queue.modCount = 0;
  if (comparator !== undefined) comparators.set(queue, comparator);
  return undefined;
}

function defineQueueOperations(cls: ClassInfo, element: JavaType, context: Context, collectionClass: ClassInfo): void {
  for (const name of ['add', 'offer']) {
    addMethod(cls, name, [element], BOOLEAN, false, (frame, receiver, [value]) => offer(frame, receiver, value));
  }
  addMethod(cls, 'peek', [], element, false, (_, receiver) => elementsOf(receiver)[0]);
  addMethod(cls, 'element', [], element, false, (frame, receiver) => {
    if (elementsOf(receiver).length === 0) throwBuiltin(frame, 'NoSuchElementException');
    return elementsOf(receiver)[0];
  });
  addMethod(cls, 'poll', [], element, false, (frame, receiver) => poll(frame, receiver));
  addMethod(cls, 'remove', [], element, false, (frame, receiver) => {
    if (elementsOf(receiver).length === 0) throwBuiltin(frame, 'NoSuchElementException');
    return poll(frame, receiver);
  });
  addMethod(cls, 'remove', [context.objectType], BOOLEAN, false, (frame, receiver, [value]) => {
    const index = indexOf(frame, elementsOf(receiver), value);
    if (index === -1) return false;
    removeAt(frame, receiver, index);
    return true;
  });
  addMethod(cls, 'clear', [], VOID, false, (_, receiver) => {
    elementsOf(receiver).length = 0;
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
      for (const item of items) offer(frame, receiver, item);
      return items.length > 0;
    }
  );
}

function offer(frame: Frame, receiver: Value, value: Value): boolean {
  if (value === undefined) throwBuiltin(frame, 'NullPointerException');
  touch(receiver);
  const heap = elementsOf(receiver);
  frame.runtime.allocateArray(frame, 1);
  heap.push(value);
  siftUp(frame, receiver, heap.length - 1, value);
  return true;
}

function poll(frame: Frame, receiver: Value): Value {
  const heap = elementsOf(receiver);
  if (heap.length === 0) return undefined;
  touch(receiver);
  const [result] = heap;
  const last = heap.pop();
  if (heap.length > 0) siftDown(frame, receiver, 0, last);
  return result;
}

function removeAt(frame: Frame, receiver: Value, index: number): void {
  touch(receiver);
  const heap = elementsOf(receiver);
  const moved = heap.pop();
  if (index === heap.length) return;
  siftDown(frame, receiver, index, moved);
  if (heap[index] === moved) siftUp(frame, receiver, index, moved);
}

function siftUp(frame: Frame, receiver: Value, start: number, value: Value): void {
  const heap = elementsOf(receiver);
  let index = start;
  while (index > 0) {
    frame.runtime.spend(1);
    const parent = (index - 1) >>> 1;
    if (compare(frame, receiver, value, heap[parent]) >= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
}

function siftDown(frame: Frame, receiver: Value, start: number, value: Value): void {
  const heap = elementsOf(receiver);
  const half = heap.length >>> 1;
  let index = start;
  while (index < half) {
    frame.runtime.spend(1);
    let child = 2 * index + 1;
    const right = child + 1;
    if (right < heap.length && compare(frame, receiver, heap[child], heap[right]) > 0) child = right;
    if (compare(frame, receiver, value, heap[child]) <= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = value;
}

function compare(frame: Frame, receiver: Value, a: Value, b: Value): number {
  const comparator = comparators.get(receiver as JavaObject);
  if (comparator === undefined) return compareNatural(frame, a, b);
  return callFunction(frame, frame.runtime.builtins.functions.comparatorClass, comparator, [a, b]) as number;
}
