import type { Context } from './builtinCollectionSupport';
import {
  checkIndex,
  checkPosition,
  classType,
  defineIteratorClass,
  defineReadMethods,
  defineSnapshot,
  elementsOf,
  indexOf,
  itemsOf,
  javaEquals,
  javaHash,
  linkOverrides,
  touch,
} from './builtinCollectionSupport';
import { defineHashMap, defineSetClass } from './builtinMaps';
import {
  addAbstractMethod,
  addConstructor,
  addInterface,
  addMethod,
  addTypeParameters,
  defineInterface,
  type Registry,
} from './builtinSupport';
import { type Wrappers } from './builtinWrappers';
import { throwBuiltin } from './runtime';
import { BOOLEAN, type ClassInfo, INT, type JavaType, type MethodInfo, type TypeVariable, VOID } from './types';
import { JavaArray, JavaObject, toInt32, type Value } from './values';

export interface Collections {
  iterableClass: ClassInfo;
  iteratorClass: ClassInfo;
  listClass: ClassInfo;
  /** The class of the lists `List.of` returns. */
  immutableList: ClassInfo;
  /** The class of the lists `Arrays.asList` returns, which share their array's elements. */
  fixedSizeList: ClassInfo;
  /** `TreeMap` and `TreeSet`, whose constructors take a `Comparator`. */
  sortedClasses: ClassInfo[];
  collectionClass: ClassInfo;
  mapClass: ClassInfo;
  /** `Iterable.iterator`, which an enhanced for statement calls. */
  iterator: MethodInfo;
  hasNext: MethodInfo;
  next: MethodInfo;
}

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
  const dequeClass = defineDequeInterfaces(context, collectionClass);
  defineArrayList(context, 'ArrayList', lists);
  const linkedList = defineArrayList(context, 'LinkedList', lists);
  addInterface(linkedList, classType(dequeClass, { kind: 'typeVar', variable: linkedList.typeParameters[0] }));
  linkOverrides(linkedList);
  defineArrayDeque(context, lists, dequeClass);
  const immutableList = defineRestrictedList(context, 'ListN', lists, () => true);
  // Arrays.asList writes through to its array, so it may set elements but not change its size.
  const fixedSizeList = defineRestrictedList(context, 'ArrayList', lists, (method) => method.name !== 'set', 'Arrays$');
  const snapshotSet = defineSnapshot(context, 'Set', setClass, itrClass);
  const snapshotCollection = defineSnapshot(context, 'Collection', collectionClass, itrClass);
  for (const name of ['HashSet', 'LinkedHashSet', 'TreeSet'])
    defineSetClass(context, name, setClass, collectionClass, itrClass);
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
    sortedClasses: ['TreeMap', 'TreeSet'].map((name) => context.registry.classes.get(name) as ClassInfo),
  };
}

const DEQUE_INSERTIONS = ['addFirst', 'addLast', 'offerFirst', 'offerLast', 'push'] as const;
const DEQUE_REMOVALS = [
  'pollFirst',
  'pollLast',
  'peekFirst',
  'peekLast',
  'getFirst',
  'getLast',
  'removeFirst',
  'removeLast',
  'pop',
] as const;

/** `Queue` and `Deque`, whose methods `LinkedList` and `ArrayDeque` implement. */
function defineDequeInterfaces(context: Context, collectionClass: ClassInfo): ClassInfo {
  const queueClass = defineInterface(context.registry, 'Queue', 'java.util');
  const [queueElement] = addTypeParameters(queueClass, ['E'], context.objectType);
  addInterface(queueClass, classType(collectionClass, queueElement));
  addAbstractMethod(queueClass, 'offer', [queueElement], BOOLEAN);
  for (const name of ['poll', 'peek', 'element', 'remove'] as const)
    addAbstractMethod(queueClass, name, [], queueElement);
  const dequeClass = defineInterface(context.registry, 'Deque', 'java.util');
  const [dequeElement] = addTypeParameters(dequeClass, ['E'], context.objectType);
  addInterface(dequeClass, classType(queueClass, dequeElement));
  for (const name of DEQUE_INSERTIONS) {
    addAbstractMethod(dequeClass, name, [dequeElement], name.startsWith('offer') ? BOOLEAN : VOID);
  }
  for (const name of DEQUE_REMOVALS) addAbstractMethod(dequeClass, name, [], dequeElement);
  return dequeClass;
}

function isIndexed(method: MethodInfo): boolean {
  return (
    ['get', 'set', 'indexOf', 'lastIndexOf', 'equals', 'hashCode'].includes(method.name) ||
    method.parameterTypes[0]?.kind === 'int'
  );
}

/** `ArrayDeque`, a deque without the list's indexed methods. */
function defineArrayDeque(
  context: Context,
  lists: { listClass: ClassInfo; collectionClass: ClassInfo; itrClass: ClassInfo },
  dequeClass: ClassInfo
): void {
  const cls = defineArrayList(context, 'ArrayDeque', lists);
  LIST_CLASSES.delete(cls);
  // A deque has no indexed access, so it keeps only the list methods that ignore positions.
  cls.methods = cls.methods.filter((method) => !isIndexed(method));
  cls.interfaces = [dequeClass];
  cls.supertypes = [cls.supertypes[0], classType(dequeClass, { kind: 'typeVar', variable: cls.typeParameters[0] })];
  defineDequeMethods(cls, { kind: 'typeVar', variable: cls.typeParameters[0] });
  linkOverrides(cls);
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
  addAbstractMethod(cls, 'subList', [INT, INT], { kind: 'class', cls, args: [element] });
  const objectType = element.kind === 'typeVar' ? (element.variable.bounds[0] as JavaType) : element;
  addAbstractMethod(cls, 'toArray', [], { kind: 'array', element: objectType });
  const arrayVariable: TypeVariable = { name: 'T', bounds: [objectType] };
  const arrayType: JavaType = { kind: 'array', element: { kind: 'typeVar', variable: arrayVariable } };
  addAbstractMethod(cls, 'toArray', [arrayType], arrayType).typeParameters = [arrayVariable];
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
  defineListAdditions(cls, element, context, { listClass, collectionClass });
  defineListArrays(cls, context);
  defineListUpdates(cls, element, context);
  defineListSearches(cls, context);
  if (name === 'LinkedList') defineDequeMethods(cls, element);
  linkOverrides(cls);
  return cls;
}

/** The methods that add to a list. */
function defineListAdditions(
  cls: ClassInfo,
  element: JavaType,
  context: Context,
  { listClass, collectionClass }: { listClass: ClassInfo; collectionClass: ClassInfo }
): void {
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
  addMethod(
    cls,
    'subList',
    [INT, INT],
    { kind: 'class', cls: listClass, args: [element] },
    false,
    (frame, receiver, [from, to]) => {
      const items = elementsOf(receiver);
      const [start, end] = [from as number, to as number];
      if (start < 0 || end > items.length || start > end) {
        throwBuiltin(frame, 'IndexOutOfBoundsException', `fromIndex: ${start}, toIndex: ${end}, size: ${items.length}`);
      }
      // A copy stands for the view, which these programs read rather than write through.
      frame.runtime.allocateArray(frame, end - start);
      const list = frame.runtime.allocateObject(frame, cls);
      list.elements = items.slice(start, end);
      list.modCount = 0;
      return list;
    }
  );
}

/** The methods that copy a list into an array. */
function defineListArrays(cls: ClassInfo, context: Context): void {
  addMethod(cls, 'toArray', [], { kind: 'array', element: context.objectType }, false, (frame, receiver) => {
    frame.runtime.allocateArray(frame, elementsOf(receiver).length);
    return new JavaArray(context.objectType, [...elementsOf(receiver)]);
  });
  const arrayVariable: TypeVariable = { name: 'T', bounds: [context.objectType] };
  const arrayType: JavaType = { kind: 'array', element: { kind: 'typeVar', variable: arrayVariable } };
  const toTypedArray = addMethod(cls, 'toArray', [arrayType], arrayType, false, (frame, receiver, [array]) => {
    if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
    const items = elementsOf(receiver);
    if (array.values.length < items.length) {
      frame.runtime.allocateArray(frame, items.length);
      return new JavaArray(array.elementType, [...items]);
    }
    array.values.splice(0, items.length, ...items);
    if (array.values.length > items.length) array.values[items.length] = undefined;
    return array;
  });
  toTypedArray.typeParameters = [arrayVariable];
}

/** The methods that read, replace, and remove elements by position or value. */
function defineListUpdates(cls: ClassInfo, element: JavaType, context: Context): void {
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
}

/** The methods that search a list and compare it with another. */
function defineListSearches(cls: ClassInfo, context: Context): void {
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

function createList(receiver: Value): Value {
  (receiver as JavaObject).elements = [];
  (receiver as JavaObject).modCount = 0;
  return undefined;
}

export { compareNatural, itemsOf, javaEquals, javaHash } from './builtinCollectionSupport';
export { findEntry, linkComparator, putEntry, removeEntry } from './builtinMaps';
