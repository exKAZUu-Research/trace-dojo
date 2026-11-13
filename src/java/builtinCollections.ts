// code-gauge-allow-file fileNcss 468 -- The list classes and their sublist and restricted variants, which share one definition of the list methods.
import { checkCopiedElement } from './arrayCopy';
import { checkStore } from './builtinClass';
import type { Context } from './builtinCollectionSupport';
import {
  batchRemovalClasses,
  checkListIndex,
  checkModifiable,
  checkPosition,
  checkRemovable,
  classType,
  countsEmptyClear,
  countsNoOpChanges,
  createIterator,
  defaultRemoveClasses,
  defineIndexFailures,
  defineIteratorClass,
  defineReadMethods,
  defineSetEquality,
  defineSnapshot,
  eagerlyRejectingClasses,
  elementsOf,
  fixedSizeClasses,
  immutableCollectionsLists,
  indexOf,
  itemsOf,
  javaEquals,
  javaHash,
  linkOverrides,
  singletonClasses,
  subListChecks,
  touch,
  unmodifiableClasses,
  unmodifiableWrappers,
  vectorCapacities,
  wrapUnmodifiable,
} from './builtinCollectionSupport';
import { addListIterators, defineListIterator } from './builtinListIterator';
import { defineHashMap, defineSets } from './builtinMaps';
import { definePriorityQueue } from './builtinPriorityQueue';
import { createSubList } from './builtinSubList';
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
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  type ClassInfo,
  INT,
  type JavaType,
  type MethodInfo,
  type NativeMethod,
  type TypeVariable,
  VOID,
} from './types';
import { JavaArray, JavaObject, toInt32, type Value } from './values';

export interface Collections {
  iterableClass: ClassInfo;
  iteratorClass: ClassInfo;
  listClass: ClassInfo;
  /** The class of the lists `List.of` returns, but of one or two elements. */
  immutableList: ClassInfo;
  /** The class of the lists of one or two elements that `List.of` and `List.copyOf` return. */
  pairList: ClassInfo;
  /** The classes of `Collections.emptyList`, `Collections.singletonList`, and `Collections.nCopies`. */
  emptyList: ClassInfo;
  singletonList: ClassInfo;
  copiesList: ClassInfo;
  /** The classes of `Collections.unmodifiableList` of a `LinkedList` or a program's list, and of another list. */
  unmodifiableList: ClassInfo;
  unmodifiableRandomAccessList: ClassInfo;
  /** The class of the maps `Map.of` returns. */
  immutableMap: ClassInfo;
  /** The class of the sets `Set.of` returns. */
  immutableSet: ClassInfo;
  emptySet: ClassInfo;
  singletonSet: ClassInfo;
  /** `AbstractList$SubList`, the class of views of `LinkedList`, which does not implement `RandomAccess`. */
  sequentialSubList: ClassInfo;
  /** `Collections$SynchronizedRandomAccessList`, the class of views of `Stack`. */
  synchronizedSubList: ClassInfo;
  emptyMap: ClassInfo;
  singletonMap: ClassInfo;
  /** The class of `Collections.unmodifiableSet` of a set without a store of its own, such as a map's key set. */
  unmodifiableViewSet: ClassInfo;
  /** The class of the lists `Arrays.asList` returns, which share their array's elements. */
  fixedSizeList: ClassInfo;
  /** `TreeMap`, `TreeSet`, and `PriorityQueue`, whose constructors take a `Comparator`. */
  sortedClasses: ClassInfo[];
  collectionClass: ClassInfo;
  setClass: ClassInfo;
  mapClass: ClassInfo;
  /** `Iterable.iterator`, which an enhanced for statement calls. */
  iterator: MethodInfo;
  hasNext: MethodInfo;
  next: MethodInfo;
}

// code-gauge-allow functionNcss 45 -- One registration per builtin method, each a small native.
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
  addMethod(iteratorClass, 'remove', [], VOID, false, (frame) =>
    throwBuiltin(frame, 'UnsupportedOperationException', 'remove')
  );
  const iterator = addAbstractMethod(iterableClass, 'iterator', [], classType(iteratorClass, iterableElement));
  const itrClass = defineIteratorClass(context, iteratorClass);

  const collectionClass = defineInterface(registry, 'Collection', 'java.util');
  const [collectionElement] = addTypeParameters(collectionClass, ['E'], objectType);
  addInterface(collectionClass, classType(iterableClass, collectionElement));
  declareCollectionMethods(collectionClass, collectionElement, context);
  defineCollectionArrays(collectionClass, context);
  const listClass = defineInterface(registry, 'List', 'java.util');
  const [listElement] = addTypeParameters(listClass, ['E'], objectType);
  addInterface(listClass, classType(collectionClass, listElement));
  declareListMethods(listClass, listElement, collectionClass);
  const listItrClass = defineListIterator(context, iteratorClass, listClass);
  const setClass = defineInterface(registry, 'Set', 'java.util');
  const [setElement] = addTypeParameters(setClass, ['E'], objectType);
  addInterface(setClass, classType(collectionClass, setElement));

  const lists = { listClass, collectionClass, itrClass, listItrClass };
  const dequeClass = defineDequeInterfaces(context, collectionClass);
  defineListClasses(context, lists, dequeClass);
  defineArrayDeque(context, lists, dequeClass);
  const priorityQueue = definePriorityQueue(context, lists, registry.classes.get('Queue') as ClassInfo);
  const restrictedLists = defineRestrictedLists(context, lists);
  const snapshotSet = defineSnapshot(context, 'Set', setClass, itrClass);
  // A map's key and entry sets compare and hash as sets; its values, a plain collection, keep identity.
  defineSetEquality(snapshotSet, context, setClass);
  linkOverrides(snapshotSet);
  const snapshotCollection = defineSnapshot(context, 'Collection', collectionClass, itrClass);
  const unmodifiableViewSet = defineUnmodifiableViewSet(context, setClass, itrClass);
  const sets = defineSets(context, setClass, collectionClass, itrClass);
  const { mapClass, ...maps } = defineHashMap(context, {
    setClass,
    collectionClass,
    snapshotSet,
    snapshotCollection,
  });
  return {
    iterableClass,
    iteratorClass,
    iterator,
    hasNext,
    next,
    listClass,
    collectionClass,
    setClass,
    mapClass,
    ...maps,
    ...sets,
    unmodifiableViewSet,
    ...restrictedLists,
    sequentialSubList: subListClasses.other,
    synchronizedSubList: subListClasses.synchronized,
    sortedClasses: [
      ...['TreeMap', 'TreeSet'].map((name) => context.registry.classes.get(name) as ClassInfo),
      priorityQueue,
    ],
  };
}

/**
 * The lists that reject changes: those `List.of`, `Collections.emptyList`, `singletonList`, `nCopies`, and
 * `unmodifiableList` return, and the fixed-size list of `Arrays.asList`.
 */
function defineRestrictedLists(
  context: Context,
  lists: { listClass: ClassInfo; collectionClass: ClassInfo; itrClass: ClassInfo; listItrClass: ClassInfo }
): Pick<
  Collections,
  | 'immutableList'
  | 'pairList'
  | 'emptyList'
  | 'singletonList'
  | 'copiesList'
  | 'unmodifiableList'
  | 'unmodifiableRandomAccessList'
  | 'fixedSizeList'
> {
  const immutableList = defineRestrictedList(context, 'ListN', lists, 'eager');
  const pairList = defineRestrictedList(context, 'List12', lists, 'eager');
  const emptyList = defineRestrictedList(context, 'EmptyList', lists, 'readOnly', 'Collections$');
  const singletonList = defineRestrictedList(context, 'SingletonList', lists, 'readOnly', 'Collections$');
  const copiesList = defineRestrictedList(context, 'CopiesList', lists, 'readOnly', 'Collections$');
  const unmodifiableList = defineRestrictedList(context, 'UnmodifiableList', lists, 'eager', 'Collections$');
  const unmodifiableRandomAccessList = defineRestrictedList(
    context,
    'UnmodifiableRandomAccessList',
    lists,
    'eager',
    'Collections$'
  );
  immutableCollectionsLists.add(immutableList);
  immutableCollectionsLists.add(pairList);
  singletonClasses.add(singletonList);
  // Arrays.asList writes through to its array, so it may set elements but not change its size.
  const fixedSizeList = defineRestrictedList(context, 'ArrayList', lists, 'fixedSize', 'Arrays$');
  defaultRemoveClasses.add(fixedSizeList);
  defineIndexFailures({ immutableList, pairList, emptyList, singletonList, fixedSizeList }, context.registry);
  defineSubListClasses(context, lists, {
    immutableList,
    pairList,
    emptyList,
    singletonList,
    copiesList,
    fixedSizeList,
  });
  return {
    immutableList,
    pairList,
    emptyList,
    singletonList,
    copiesList,
    unmodifiableList,
    unmodifiableRandomAccessList,
    fixedSizeList,
  };
}

/** The classes of the views `subList` returns, which differ from their lists' classes as the JDK's do. */
const subListClasses: Record<'arrayList' | 'other' | 'synchronized', ClassInfo> = {} as never;

/** The class of the view that `subList` returns for each builtin list class but those whose view is `other`. */
const subListClassesOf = new Map<ClassInfo, ClassInfo>();

/**
 * The sublist classes: `ArrayList$SubList`, which removes in batches as its list does; `AbstractList$SubList` for the
 * other modifiable lists; `AbstractList$RandomAccessSubList` for the lists of `Arrays.asList` and of `Collections`'
 * empty and singleton lists, which changes its list through the list's own methods, so that the list rejects what it
 * rejects; the immutable view of `List.of`; and `nCopies`, whose view is a list of copies too.
 */
function defineSubListClasses(
  context: Context,
  lists: { listClass: ClassInfo; collectionClass: ClassInfo; itrClass: ClassInfo; listItrClass: ClassInfo },
  restricted: Record<
    'immutableList' | 'pairList' | 'emptyList' | 'singletonList' | 'copiesList' | 'fixedSizeList',
    ClassInfo
  >
): void {
  const { registry } = context;
  subListClasses.arrayList = defineArrayList(context, 'SubList', lists, 'ArrayList$SubList');
  batchRemovalClasses.add(subListClasses.arrayList);
  subListClasses.other = defineArrayList(context, 'SubList', lists, 'AbstractList$SubList');
  // Vector.subList wraps its view in a synchronized list, which implements RandomAccess as Vector does.
  subListClasses.synchronized = defineArrayList(
    context,
    'SynchronizedRandomAccessList',
    lists,
    'Collections$SynchronizedRandomAccessList'
  );
  const randomAccess = defineArrayList(context, 'RandomAccessSubList', lists, 'AbstractList$RandomAccessSubList');
  const immutable = defineRestrictedList(context, 'SubList', lists, 'eager', 'ImmutableCollections$');
  immutableCollectionsLists.add(immutable);
  for (const [listClasses, view] of [
    [[registry.classes.get('ArrayList') as ClassInfo, subListClasses.arrayList], subListClasses.arrayList],
    [[registry.classes.get('Stack') as ClassInfo, subListClasses.synchronized], subListClasses.synchronized],
    [[restricted.fixedSizeList, restricted.emptyList, restricted.singletonList, randomAccess], randomAccess],
    [[restricted.immutableList, restricted.pairList, immutable], immutable],
    [[restricted.copiesList], restricted.copiesList],
  ] as const) {
    for (const list of listClasses) subListClassesOf.set(list, view);
  }
}

/** The class of a view of a list of `cls`, whose JDK class decides how the view checks indexes and changes. */
function subListClassOf(listClass: ClassInfo): ClassInfo {
  let cls = listClass;
  while (!cls.isBuiltin && cls.superclass) cls = cls.superclass;
  return subListClassesOf.get(cls) ?? subListClasses.other;
}

/** A read-only set over another set's elements, which it reads afresh at each use. */
function defineUnmodifiableViewSet(context: Context, setClass: ClassInfo, itrClass: ClassInfo): ClassInfo {
  const cls = defineSnapshot(context, 'UnmodifiableSet', setClass, itrClass);
  defineSetEquality(cls, context, setClass);
  linkOverrides(cls);
  for (const method of cls.methods) {
    if (method.name === 'remove' || method.name === 'clear') {
      method.native = (frame) => throwBuiltin(frame, 'UnsupportedOperationException');
    }
  }
  unmodifiableClasses.add(cls);
  eagerlyRejectingClasses.add(cls);
  return cls;
}

/** `ArrayList`, `Stack`, and `LinkedList`, which hold their elements in an array. */
function defineListClasses(
  context: Context,
  lists: { listClass: ClassInfo; collectionClass: ClassInfo; itrClass: ClassInfo; listItrClass: ClassInfo },
  dequeClass: ClassInfo
): void {
  const arrayList = defineArrayList(context, 'ArrayList', lists);
  const stack = defineArrayList(context, 'Stack', lists);
  defineStack(stack);
  batchRemovalClasses.add(arrayList);
  batchRemovalClasses.add(stack);
  const linkedList = defineArrayList(context, 'LinkedList', lists);
  addInterface(linkedList, classType(dequeClass, { kind: 'typeVar', variable: linkedList.typeParameters[0] }));
  linkOverrides(linkedList);
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
  const iteratorClass = context.registry.classes.get('Iterator') as ClassInfo;
  addAbstractMethod(dequeClass, 'descendingIterator', [], classType(iteratorClass, dequeElement));
  return dequeClass;
}

function isIndexed(method: MethodInfo): boolean {
  return (
    ['get', 'set', 'indexOf', 'lastIndexOf', 'equals', 'hashCode', 'listIterator'].includes(method.name) ||
    method.parameterTypes[0]?.kind === 'int'
  );
}

/** The elements of a non-empty stack, whose last is its top. */
function stackElements(frame: Frame, receiver: Value): Value[] {
  const elements = elementsOf(receiver);
  if (elements.length === 0) throwBuiltin(frame, 'EmptyStackException');
  return elements;
}

/** Inserts the elements of `source` at `index`, returning whether there were any. */
function insertAll(frame: Frame, receiver: Value, index: number, source: Value): boolean {
  const items = [...itemsOf(frame, source)];
  if (items.length === 0 && !countsNoOpChanges(receiver)) return false;
  if (items.length > 0) checkModifiable(frame, receiver, true);
  frame.runtime.allocateArray(frame, items.length);
  elementsOf(receiver).splice(index, 0, ...items);
  touch(receiver);
  return items.length > 0;
}

/** `Stack`, a list whose end is the top of the stack. */
function defineStack(cls: ClassInfo): void {
  const element: JavaType = { kind: 'typeVar', variable: cls.typeParameters[0] };
  for (const constructor of cls.constructors) {
    const construct = constructor.native as NativeMethod;
    constructor.native = (frame, receiver, args) => {
      const result = construct(frame, receiver, args);
      // A Vector starts with an array of 10, or one as long as the collection it copies.
      vectorCapacities.set(receiver as JavaObject, Math.max(elementsOf(receiver).length, args.length > 0 ? 0 : 10));
      return result;
    };
  }
  addMethod(cls, 'push', [element], element, false, (_, receiver, [value]) => {
    elementsOf(receiver).push(value);
    touch(receiver);
    return value;
  });
  addMethod(cls, 'pop', [], element, false, (frame, receiver) => {
    const value = stackElements(frame, receiver).pop();
    touch(receiver);
    return value;
  });
  addMethod(cls, 'peek', [], element, false, (frame, receiver) => stackElements(frame, receiver).at(-1));
  addMethod(cls, 'empty', [], BOOLEAN, false, (_, receiver) => elementsOf(receiver).length === 0);
  addMethod(
    cls,
    'search',
    [{ kind: 'class', cls: cls.superclass as ClassInfo }],
    INT,
    false,
    (frame, receiver, [value]) => {
      const elements = elementsOf(receiver);
      const index = elements.findLastIndex((item) => javaEquals(frame, value, item));
      return index === -1 ? -1 : elements.length - index;
    }
  );
}

/** `ArrayDeque`, a deque without the list's indexed methods. */
function defineArrayDeque(
  context: Context,
  lists: { listClass: ClassInfo; collectionClass: ClassInfo; itrClass: ClassInfo; listItrClass: ClassInfo },
  dequeClass: ClassInfo
): void {
  const cls = defineArrayList(context, 'ArrayDeque', lists);
  LIST_CLASSES.delete(cls);
  batchRemovalClasses.add(cls);
  // A deque has no indexed access, so it keeps only the list methods that ignore positions.
  cls.methods = cls.methods.filter((method) => !isIndexed(method));
  cls.interfaces = [dequeClass];
  cls.supertypes = [cls.supertypes[0], classType(dequeClass, { kind: 'typeVar', variable: cls.typeParameters[0] })];
  defineDequeMethods(cls, { kind: 'typeVar', variable: cls.typeParameters[0] }, lists.itrClass);
  rejectNullElements(cls);
  linkOverrides(cls);
}

/**
 * Makes ArrayDeque's inserting methods throw `NullPointerException` for a null element, as null marks an empty slot
 * of its array; `addAll` adds the elements before the first null, as its `addLast` calls do.
 */
function rejectNullElements(cls: ClassInfo): void {
  const addLast = cls.methods.find((method) => method.name === 'addLast')?.native as NativeMethod;
  for (const method of cls.methods) {
    const { native } = method;
    if (native && INSERTERS.has(method.name)) method.native = nonNull(native);
    else if (native && method.name === 'addAll') method.native = addingEachLast(addLast);
  }
  // The copy constructor adds the elements as addAll does.
  for (const constructor of cls.constructors) {
    const { native } = constructor;
    if (!native || constructor.parameterTypes[0]?.kind !== 'class') continue;
    constructor.native = (frame, receiver, args) => {
      if ([...itemsOf(frame, args[0])].includes(undefined)) throwBuiltin(frame, 'NullPointerException');
      return native(frame, receiver, args);
    };
  }
}

const INSERTERS = new Set(['add', 'addFirst', 'addLast', 'offer', 'offerFirst', 'offerLast', 'push']);

function nonNull(native: NativeMethod): NativeMethod {
  return (frame, receiver, args) => {
    if (args[0] === undefined) throwBuiltin(frame, 'NullPointerException');
    return native(frame, receiver, args);
  };
}

function addingEachLast(addLast: NativeMethod): NativeMethod {
  return (frame, receiver, [source]) => {
    const items = [...itemsOf(frame, source)];
    for (const item of items) {
      if (item === undefined) throwBuiltin(frame, 'NullPointerException');
      addLast(frame, receiver, [item]);
    }
    return items.length > 0;
  };
}

/**
 * A list that rejects changes. An `eager` one, of `ImmutableCollections` or an unmodifiable wrapper, throws
 * `UnsupportedOperationException` from every mutator at once. The others extend `AbstractList`, which throws at once
 * only from the primitives it leaves unsupported, adding and removing at an index and, but for a `fixedSize` list,
 * setting an element; its other mutators reach those primitives, and so throw, only when they would change the list.
 */
function defineRestrictedList(
  context: Context,
  name: string,
  lists: { listClass: ClassInfo; collectionClass: ClassInfo; itrClass: ClassInfo; listItrClass: ClassInfo },
  kind: 'eager' | 'readOnly' | 'fixedSize',
  prefix = 'ImmutableCollections$'
): ClassInfo {
  const cls = defineArrayList(context, name, lists, `${prefix}${name}`);
  const isPrimitive = (method: MethodInfo): boolean =>
    method.name === 'add' ||
    (method.name === 'remove' && method.parameterTypes[0] === INT) ||
    (method.name === 'set' && kind === 'readOnly');
  for (const method of cls.methods) {
    if (kind === 'eager' ? MUTATORS.has(method.name) : isPrimitive(method)) {
      method.native = (frame) => throwBuiltin(frame, 'UnsupportedOperationException');
    }
  }
  if (kind === 'fixedSize') fixedSizeClasses.add(cls);
  else unmodifiableClasses.add(cls);
  if (kind === 'eager') eagerlyRejectingClasses.add(cls);
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

function declareListMethods(cls: ClassInfo, element: JavaType, collectionClass: ClassInfo): void {
  addAbstractMethod(
    cls,
    'addAll',
    [INT, classType(collectionClass, { kind: 'wildcard', bound: element, isSuper: false })],
    BOOLEAN
  );
  addAbstractMethod(cls, 'subList', [INT, INT], { kind: 'class', cls, args: [element] });
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
// code-gauge-allow functionNcss 34 -- One registration per builtin method, each a small native.
function defineArrayList(
  context: Context,
  name: string,
  {
    listClass,
    collectionClass,
    itrClass,
    listItrClass,
  }: { listClass: ClassInfo; collectionClass: ClassInfo; itrClass: ClassInfo; listItrClass: ClassInfo },
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
    checkModifiable(frame, receiver, true);
    elementsOf(receiver).splice(index, 1);
    touch(receiver);
  });
  defineListAdditions(cls, element, context, { listClass, collectionClass });
  addListIterators(cls, element, listItrClass);
  defineListUpdates(cls, element, context);
  defineListSearches(cls, context);
  if (name === 'LinkedList') defineDequeMethods(cls, element, itrClass);
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
    checkModifiable(frame, receiver, true);
    frame.runtime.allocateArray(frame, 1);
    elementsOf(receiver).push(value);
    touch(receiver);
    return true;
  });
  addMethod(cls, 'add', [INT, element], VOID, false, (frame, receiver, [index, value]) => {
    checkPosition(frame, index as number, elementsOf(receiver).length);
    checkModifiable(frame, receiver, true);
    frame.runtime.allocateArray(frame, 1);
    elementsOf(receiver).splice(index as number, 0, value);
    touch(receiver);
  });
  const sourceType = classType(collectionClass, { kind: 'wildcard', bound: element, isSuper: false });
  addMethod(cls, 'addAll', [sourceType], BOOLEAN, false, (frame, receiver, [source]) =>
    insertAll(frame, receiver, elementsOf(receiver).length, source)
  );
  addMethod(cls, 'addAll', [INT, sourceType], BOOLEAN, false, (frame, receiver, [index, source]) => {
    checkPosition(frame, index as number, elementsOf(receiver).length);
    return insertAll(frame, receiver, index as number, source);
  });
  addMethod(
    cls,
    'subList',
    [INT, INT],
    { kind: 'class', cls: listClass, args: [element] },
    false,
    (frame, receiver, [from, to]) => {
      const items = elementsOf(receiver);
      const [start, end] = [from as number, to as number];
      if (start < 0) throwBuiltin(frame, 'IndexOutOfBoundsException', `fromIndex = ${start}`);
      if (end > items.length) throwBuiltin(frame, 'IndexOutOfBoundsException', `toIndex = ${end}`);
      if (start > end) throwBuiltin(frame, 'IllegalArgumentException', `fromIndex(${start}) > toIndex(${end})`);
      return subListOf(frame, receiver as JavaObject, start, end);
    }
  );
}

/** A view of `list`, which wraps a view of the backing list of an unmodifiable wrapper, as `UnmodifiableList` does. */
function subListOf(frame: Frame, list: JavaObject, start: number, end: number): JavaObject {
  if (!unmodifiableWrappers.has(list)) return createSubList(frame, subListClassOf(list.cls), list, start, end);
  const backing = subListOf(frame, list.retained?.[0] as JavaObject, start, end);
  return wrapUnmodifiable(frame.runtime.allocateObject(frame, list.cls), backing);
}

/** The methods that copy a list into an array. */
/**
 * `Collection.toArray`, which every collection and view gives in its iteration order; the typed form fills the given
 * array when it is long enough, and its stores fail where the array's runtime element type forbids an element.
 */
function defineCollectionArrays(cls: ClassInfo, context: Context): void {
  addMethod(cls, 'toArray', [], { kind: 'array', element: context.objectType }, false, (frame, receiver) => {
    const items = itemsOf(frame, receiver);
    frame.runtime.allocateArray(frame, items.length);
    return new JavaArray(context.objectType, [...items]);
  });
  const arrayVariable: TypeVariable = { name: 'T', bounds: [context.objectType] };
  const arrayType: JavaType = { kind: 'array', element: { kind: 'typeVar', variable: arrayVariable } };
  const toTypedArray = addMethod(cls, 'toArray', [arrayType], arrayType, false, (frame, receiver, [array]) => {
    if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
    const items = itemsOf(frame, receiver);
    const target = array.values.length < items.length ? new JavaArray(array.elementType, []) : array;
    if (target !== array) frame.runtime.allocateArray(frame, items.length);
    // An array-backed collection copies its Object[] through System.arraycopy; the others store each element.
    const copiesArray = copiesBackingArray(receiver as JavaObject);
    for (const [index, item] of items.entries()) {
      if (copiesArray) checkCopiedElement(frame, context.objectType, target, item);
      else checkStore(frame, target, item);
      target.values[index] = item;
    }
    if (target === array && array.values.length > items.length) array.values[items.length] = undefined;
    return target;
  });
  toTypedArray.typeParameters = [arrayVariable];
}

function copiesBackingArray(collection: JavaObject): boolean {
  if (fixedSizeClasses.has(collection.cls)) return true;
  for (let cls: ClassInfo | undefined = collection.cls; cls; cls = cls.superclass) {
    if (batchRemovalClasses.has(cls)) return true;
  }
  return false;
}

/** The methods that read, replace, and remove elements by position or value. */
function defineListUpdates(cls: ClassInfo, element: JavaType, context: Context): void {
  addMethod(cls, 'get', [INT], element, false, (frame, receiver, [index]) => {
    checkListIndex(frame, receiver, index as number, elementsOf(receiver).length);
    return elementsOf(receiver)[index as number];
  });
  addMethod(cls, 'set', [INT, element], element, false, (frame, receiver, [index, value]) => {
    checkListIndex(frame, receiver, index as number, elementsOf(receiver).length);
    checkModifiable(frame, receiver, false);
    const previous = elementsOf(receiver)[index as number];
    elementsOf(receiver)[index as number] = value;
    return previous;
  });
  addMethod(cls, 'remove', [INT], element, false, (frame, receiver, [index]) => {
    checkListIndex(frame, receiver, index as number, elementsOf(receiver).length);
    checkModifiable(frame, receiver, true);
    touch(receiver);
    return elementsOf(receiver).splice(index as number, 1)[0];
  });
  addMethod(cls, 'remove', [context.objectType], BOOLEAN, false, (frame, receiver, [value]) => {
    const index = indexOf(frame, elementsOf(receiver), value);
    if (index === -1) return false;
    checkRemovable(frame, receiver);
    elementsOf(receiver).splice(index, 1);
    touch(receiver);
    return true;
  });
  addMethod(cls, 'clear', [], VOID, false, clearList);
}

function clearList(frame: Frame, receiver: Value): Value {
  if (elementsOf(receiver).length > 0) checkModifiable(frame, receiver, true);
  else if (!countsEmptyClear(receiver)) return undefined;
  elementsOf(receiver).length = 0;
  touch(receiver);
  return undefined;
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
  addMethod(cls, 'equals', [context.objectType], BOOLEAN, false, listEquals);
  addMethod(cls, 'hashCode', [], INT, false, (frame, receiver) => {
    let hash = 1;
    for (const item of elementsOf(receiver)) hash = toInt32(Math.imul(hash, 31) + javaHash(frame, item));
    return hash;
  });
}

/** `List.equals`, which compares the elements in order with those of any list. */
function listEquals(frame: Frame, receiver: Value, [other]: Value[]): boolean {
  // An unmodifiable wrapper compares through the list it wraps, which is equal to itself before reading anything.
  let list = receiver as JavaObject;
  while (unmodifiableWrappers.has(list)) list = list.retained?.[0] as JavaObject;
  if (other === receiver || other === list) return true;
  if (!(other instanceof JavaObject) || !other.elements || !isList(other)) return false;
  subListChecks.get(other)?.();
  const items = elementsOf(receiver);
  return (
    items.length === other.elements.length &&
    items.every((item, index) => javaEquals(frame, item, other.elements?.[index]))
  );
}

const LIST_CLASSES = new Set<ClassInfo>();

function isList(object: JavaObject): boolean {
  return LIST_CLASSES.has(object.cls);
}

/** The queue and stack methods of `LinkedList`, which learners use for breadth-first searches and stacks. */
// code-gauge-allow functionCognitiveComplexity 24 -- One registration per builtin method, each a small native.
function defineDequeMethods(cls: ClassInfo, element: JavaType, itrClass: ClassInfo): void {
  defineDescendingIterator(cls, element, itrClass);
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

/** `descendingIterator`, which walks a deque from its last element. */
function defineDescendingIterator(cls: ClassInfo, element: JavaType, itrClass: ClassInfo): void {
  addMethod(cls, 'descendingIterator', [], classType(itrClass, element), false, (frame, receiver) => {
    // As the JDK's, it counts the elements it has yet to return, which only its own removals change, and reads each in
    // place, its position counted from the end of the deque.
    let length = elementsOf(receiver).length;
    const reversed = new Proxy<Value[]>([], {
      get: (target, property) => {
        if (property === 'length') return length;
        if (typeof property !== 'string' || !/^\d+$/.test(property)) return Reflect.get(target, property);
        const items = elementsOf(receiver);
        return items[items.length - 1 - Number(property)];
      },
    });
    return createIterator(
      frame,
      itrClass,
      receiver as JavaObject,
      () => reversed,
      (_, index) => {
        const items = elementsOf(receiver);
        items.splice(items.length - 1 - index, 1);
        length--;
        touch(receiver);
      }
    );
  });
}

function createList(receiver: Value): Value {
  (receiver as JavaObject).elements = [];
  (receiver as JavaObject).modCount = 0;
  return undefined;
}

export { compareNatural, itemsOf, javaEquals, javaHash } from './builtinCollectionSupport';
export { findEntry, linkComparator, putEntry, removeEntry } from './builtinMaps';
