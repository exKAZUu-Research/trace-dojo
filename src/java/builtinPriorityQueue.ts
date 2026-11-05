import {
  classType,
  compareNatural,
  type Context,
  defineReadMethods,
  elementsOf,
  indexOf,
  itemsOf,
  linkOverrides,
  mapViewSources,
  touch,
  unmodifiableWrappers,
} from './builtinCollectionSupport';
import { callFunction } from './builtinFunctions';
import { lazyComparator } from './builtinMaps';
import { addConstructor, addInterface, addMethod, addTypeParameters } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, type ClassInfo, createClass, INT, type JavaType, type MethodInfo, VOID } from './types';
import { type HashStore, JavaObject, type Value } from './values';

const comparators = new WeakMap<JavaObject, Value>();

/**
 * The store of a `SortedSet` source, decided by its type as the JDK decides `instanceof SortedSet`: a `TreeSet`, or
 * a `TreeMap`'s key set, but not an unmodifiable wrapper of either, which only shares the store.
 */
function sortedSetStore(source: Value): HashStore | undefined {
  if (!(source instanceof JavaObject) || unmodifiableWrappers.has(source)) return undefined;
  const view = mapViewSources.get(source);
  const store = view ? (view.isKeySet ? view.store() : undefined) : source.store;
  // EnumSet and EnumMap keep their constants sorted too, but are no SortedSet.
  const owner = view ? view.map : source;
  const isEnum = owner.cls.name === 'EnumSet' || owner.cls.name === 'EnumMap';
  return store?.order === 'sorted' && !isEnum ? store : undefined;
}

/**
 * `PriorityQueue(Collection)`: a priority queue, a subclass's included, or a sorted set passes on its ordering; the
 * elements of a `PriorityQueue` itself or a sorted set already form a heap in that order, and others are heapified.
 */
function fillFrom(frame: Frame, receiver: Value, source: Value, queueClass: ClassInfo): void {
  const sorted = sortedSetStore(source);
  const isQueue = source instanceof JavaObject && frame.runtime.isInstance(source, queueClass);
  create(receiver, isQueue ? comparators.get(source as JavaObject) : sorted?.comparator);
  const heap = elementsOf(receiver);
  for (const item of itemsOf(frame, source)) {
    if (item === undefined) throwBuiltin(frame, 'NullPointerException');
    heap.push(item);
  }
  frame.runtime.allocateArray(frame, heap.length);
  if ((isQueue && (source as JavaObject).cls === queueClass) || sorted) return;
  for (let index = (heap.length >>> 1) - 1; index >= 0; index--) siftDown(frame, receiver, index, heap[index]);
}

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
      fillFrom(frame, receiver, source, cls);
    }
  );
  defineReadMethods(cls, element, context, lists.itrClass, (frame, receiver, index) => {
    removeAt(frame, receiver, index);
  });
  defineHeapIterator(context, cls, element);
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

/**
 * Removes the element at `index`, moving the last element into its place, and returns that element when it then
 * rises to an index before `index`, which an iterator past `index` would otherwise not visit, as `PriorityQueue`'s
 * `removeAt` does.
 */
function removeAt(frame: Frame, receiver: Value, index: number): { moved: Value } | undefined {
  touch(receiver);
  const heap = elementsOf(receiver);
  const moved = heap.pop();
  if (index === heap.length) return undefined;
  siftDown(frame, receiver, index, moved);
  if (heap[index] !== moved) return undefined;
  siftUp(frame, receiver, index, moved);
  return heap[index] === moved ? undefined : { moved };
}

/** The state of a heap iterator: its cursor, and the elements removal moved before it, which it visits last. */
interface HeapIteratorState {
  queue: JavaObject;
  cursor: number;
  lastReturned: number;
  lastElement: { value: Value } | undefined;
  forgetMeNot: Value[];
  expectedModCount: number | undefined;
}

const heapIterators = new WeakMap<JavaObject, HeapIteratorState>();

/**
 * `PriorityQueue.iterator()`, which walks the heap array and then the elements that a removal through it moved
 * behind its cursor, as OpenJDK's `forgetMeNot` queue keeps them, so that removal visits every element once.
 */
function defineHeapIterator(context: Context, cls: ClassInfo, element: JavaType): void {
  const iteratorClass = context.registry.classes.get('Iterator') as ClassInfo;
  const itrClass = createClass('Itr', context.objectClass, true);
  itrClass.binaryName = 'PriorityQueue$Itr';
  const [itrElement] = addTypeParameters(itrClass, ['E'], context.objectType);
  addInterface(itrClass, classType(iteratorClass, itrElement));
  addMethod(itrClass, 'hasNext', [], BOOLEAN, false, (_, receiver) => {
    const state = heapIteratorState(receiver);
    return state.cursor < elementsOf(state.queue).length || state.forgetMeNot.length > 0;
  });
  addMethod(itrClass, 'next', [], itrElement, false, (frame, receiver) =>
    nextOfHeap(frame, heapIteratorState(receiver))
  );
  addMethod(itrClass, 'remove', [], VOID, false, (frame, receiver) => {
    removeThroughHeapIterator(frame, receiver, heapIteratorState(receiver));
  });
  linkOverrides(itrClass);
  const iterator = cls.methods.find(
    (method) => method.name === 'iterator' && method.parameterTypes.length === 0
  ) as MethodInfo;
  iterator.returnType = classType(itrClass, element);
  iterator.native = (frame, receiver) => {
    const object = frame.runtime.allocateObject(frame, itrClass);
    const queue = receiver as JavaObject;
    heapIterators.set(object, {
      queue,
      cursor: 0,
      lastReturned: -1,
      lastElement: undefined,
      forgetMeNot: [],
      expectedModCount: queue.modCount,
    });
    // The iterator keeps its queue and the elements it still has to visit alive.
    object.retained = [queue];
    return object;
  };
}

function heapIteratorState(receiver: Value): HeapIteratorState {
  return heapIterators.get(receiver as JavaObject) as HeapIteratorState;
}

function nextOfHeap(frame: Frame, state: HeapIteratorState): Value {
  if (state.expectedModCount !== state.queue.modCount) throwBuiltin(frame, 'ConcurrentModificationException');
  const heap = elementsOf(state.queue);
  if (state.cursor < heap.length) return heap[(state.lastReturned = state.cursor++)];
  state.lastReturned = -1;
  if (state.forgetMeNot.length === 0) return throwBuiltin(frame, 'NoSuchElementException');
  state.lastElement = { value: state.forgetMeNot.shift() };
  return state.lastElement.value;
}

function removeThroughHeapIterator(frame: Frame, receiver: Value, state: HeapIteratorState): void {
  if (state.expectedModCount !== state.queue.modCount) throwBuiltin(frame, 'ConcurrentModificationException');
  if (state.lastReturned !== -1) {
    const displaced = removeAt(frame, state.queue, state.lastReturned);
    state.lastReturned = -1;
    if (displaced) {
      state.forgetMeNot.push(displaced.moved);
      (receiver as JavaObject).retained?.push(displaced.moved);
    } else state.cursor--;
  } else if (state.lastElement) {
    // The element taken from forgetMeNot is removed by identity, as removeEq does.
    const index = elementsOf(state.queue).indexOf(state.lastElement.value);
    if (index !== -1) removeAt(frame, state.queue, index);
    state.lastElement = undefined;
  } else throwBuiltin(frame, 'IllegalStateException');
  state.expectedModCount = state.queue.modCount;
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
