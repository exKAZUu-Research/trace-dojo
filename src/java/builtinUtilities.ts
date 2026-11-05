import {
  type Collections,
  compareNatural,
  findEntry,
  itemsOf,
  javaEquals,
  javaHash,
  putEntry,
} from './builtinCollections';
import { checkModifiable } from './builtinCollectionSupport';
import { createStore, NO_ENTRY } from './builtinMaps';
import { stringify } from './builtins';
import { addMethod, newString, type Registry } from './builtinSupport';
import { type BoxableKind, hashOf } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  BYTE,
  CHAR,
  type ClassInfo,
  type ClassType,
  DOUBLE,
  FLOAT,
  INT,
  isPrimitive,
  type JavaType,
  LONG,
  type MethodInfo,
  type NativeMethod,
  sameType,
  SHORT,
  type TypeVariable,
  VOID,
} from './types';
import { defaultValue, JavaArray, JavaObject, toInt32, type Value } from './values';

const PRIMITIVE_ELEMENTS = [INT, LONG, DOUBLE, FLOAT, CHAR, BYTE, SHORT, BOOLEAN];

/** Adds a generic static method, whose signature `signature` builds from its type parameters' types. */
function addGenericStatic(
  cls: ClassInfo,
  name: string,
  typeParameterNames: string[],
  objectType: JavaType,
  signature: (...variables: JavaType[]) => { parameterTypes: JavaType[]; returnType: JavaType; isVarargs?: boolean },
  native: NativeMethod
): MethodInfo {
  const typeParameters = typeParameterNames.map((variableName): TypeVariable => ({
    name: variableName,
    bounds: [objectType],
  }));
  const { parameterTypes, returnType, isVarargs } = signature(
    ...typeParameters.map((variable): JavaType => ({ kind: 'typeVar', variable }))
  );
  const method = addMethod(cls, name, parameterTypes, returnType, true, native);
  method.typeParameters = typeParameters;
  method.isVarargs = isVarargs;
  return method;
}

export function defineUtilities(
  registry: Registry,
  objectClass: ClassInfo,
  stringType: JavaType,
  collections: Collections,
  comparableClass: ClassInfo
): void {
  const objectType = objectClass.type;
  const listOf = (element: JavaType): ClassType => ({ kind: 'class', cls: collections.listClass, args: [element] });
  addGenericStatic(
    collections.listClass,
    'of',
    ['E'],
    objectType,
    (element) => ({ parameterTypes: [{ kind: 'array', element }], returnType: listOf(element), isVarargs: true }),
    (frame, _, [array]) => {
      const values = (array as JavaArray).values;
      if (values.includes(undefined)) throwBuiltin(frame, 'NullPointerException');
      return createList(frame, collections.immutableList, [...values]);
    }
  );
  addGenericStatic(
    collections.listClass,
    'copyOf',
    ['E'],
    objectType,
    (element) => ({
      parameterTypes: [
        {
          kind: 'class',
          cls: collections.collectionClass,
          args: [{ kind: 'wildcard', bound: element, isSuper: false }],
        },
      ],
      returnType: listOf(element),
    }),
    (frame, _, [collection]) => {
      const values = itemsOf(frame, collection);
      if (values.includes(undefined)) throwBuiltin(frame, 'NullPointerException');
      return createList(frame, collections.immutableList, [...values]);
    }
  );
  defineMapOf(collections, objectType);
  addGenericStatic(
    collections.setClass,
    'of',
    ['E'],
    objectType,
    (element) => ({
      parameterTypes: [{ kind: 'array', element }],
      returnType: { kind: 'class', cls: collections.setClass, args: [element] },
      isVarargs: true,
    }),
    (frame, _, [array]) => createImmutableSet(frame, collections.immutableSet, (array as JavaArray).values)
  );
  defineArrays(registry, objectClass, stringType, collections, listOf);
  defineCollectionsClass(registry, objectClass, collections, comparableClass);
  defineCollectionViews(
    registry.classes.get('Collections') as ClassInfo,
    collections,
    objectClass.type,
    comparableClass
  );
}

/** `Map.of` with up to ten keys and values, as the JDK overloads it. */
function defineMapOf(collections: Collections, objectType: JavaType): void {
  for (let count = 0; count <= 10; count++) {
    addGenericStatic(
      collections.mapClass,
      'of',
      ['K', 'V'],
      objectType,
      (key, value) => ({
        parameterTypes: Array.from({ length: count * 2 }, (_, index) => (index % 2 === 0 ? key : value)),
        returnType: { kind: 'class', cls: collections.mapClass, args: [key, value] },
      }),
      (frame, _, args) => createImmutableMap(frame, collections.immutableMap, args)
    );
  }
}

/** A set of `values`, as `Set.of` makes it, which rejects null and duplicate elements. */
function createImmutableSet(frame: Frame, cls: ClassInfo, values: Value[]): JavaObject {
  const set = frame.runtime.allocateObject(frame, cls);
  createStore(set);
  for (const value of values) {
    if (value === undefined) throwBuiltin(frame, 'NullPointerException');
    if (putEntry(frame, set, value, true) !== NO_ENTRY) {
      throwBuiltin(
        frame,
        'IllegalArgumentException',
        `duplicate element: ${stringify(frame, value, { kind: 'null' })}`
      );
    }
  }
  return set;
}

/** A map of the keys and values that alternate in `args`, as `Map.of` makes it. */
function createImmutableMap(frame: Frame, cls: ClassInfo, args: Value[]): JavaObject {
  const map = frame.runtime.allocateObject(frame, cls);
  createStore(map);
  for (let index = 0; index < args.length; index += 2) {
    const [key, value] = [args[index], args[index + 1]];
    if (key === undefined || value === undefined) throwBuiltin(frame, 'NullPointerException');
    if (findEntry(frame, map, key)) {
      throwBuiltin(frame, 'IllegalArgumentException', `duplicate key: ${stringify(frame, key, { kind: 'null' })}`);
    }
    putEntry(frame, map, key, false, value);
  }
  return map;
}

/** `Arrays.hashCode` and, except for a boolean array, `Arrays.binarySearch`. */
function defineArraySearches(arraysClass: ClassInfo, element: JavaType, isObject: boolean): void {
  const arrayType: JavaType = { kind: 'array', element };
  addMethod(arraysClass, 'hashCode', [arrayType], INT, true, (frame, _, [array]) =>
    hashArray(frame, array, isObject ? undefined : (element.kind as BoxableKind))
  );
  addMethod(arraysClass, 'fill', [arrayType, INT, INT, element], VOID, true, (frame, _, [array, from, to, value]) => {
    const { values } = arrayOf(frame, array);
    checkArrayRange(frame, from as number, to as number, values.length);
    values.fill(value, from as number, to as number);
  });
  if (element === BOOLEAN) return;
  const compare = isObject ? compareNatural : (_: Frame, a: Value, b: Value): number => comparePrimitives(a, b);
  addMethod(arraysClass, 'binarySearch', [arrayType, element], INT, true, (frame, _, [array, key]) =>
    binarySearch(frame, arrayOf(frame, array).values, key, compare)
  );
  addMethod(arraysClass, 'sort', [arrayType, INT, INT], VOID, true, (frame, _, [array, from, to]) => {
    const { values } = arrayOf(frame, array);
    const [start, end] = [from as number, to as number];
    checkArrayRange(frame, start, end, values.length);
    frame.runtime.spend(Math.ceil(((end - start) * Math.log2(end - start + 1)) / 16));
    values.splice(start, end - start, ...values.slice(start, end).toSorted((a, b) => compare(frame, a, b)));
  });
}

/** Checks the range of an array that `Arrays.fill` and `Arrays.sort` take, as `Arrays.rangeCheck` does. */
function checkArrayRange(frame: Frame, from: number, to: number, length: number): void {
  if (from > to) throwBuiltin(frame, 'IllegalArgumentException', `fromIndex(${from}) > toIndex(${to})`);
  if (from < 0) throwBuiltin(frame, 'ArrayIndexOutOfBoundsException', `Array index out of range: ${from}`);
  if (to > length) throwBuiltin(frame, 'ArrayIndexOutOfBoundsException', `Array index out of range: ${to}`);
}

/** `Arrays.deepEquals`, which compares nested arrays by their elements and other elements with `equals`. */
function deepEquals(frame: Frame, a: Value, b: Value): boolean {
  if (a === b) return true;
  if (!(a instanceof JavaArray) || !(b instanceof JavaArray)) return javaEquals(frame, a, b);
  if (a.values.length !== b.values.length) return false;
  if (isPrimitive(a.elementType) || isPrimitive(b.elementType)) {
    return sameType(a.elementType, b.elementType) && a.values.every((item, index) => Object.is(item, b.values[index]));
  }
  return a.values.every((item, index) => deepEquals(frame, item, b.values[index]));
}

/** `Arrays.hashCode`, which hashes objects with `hashCode` and primitives of `kind` as their wrappers do. */
function hashArray(frame: Frame, array: Value, kind: BoxableKind | undefined): number {
  if (!(array instanceof JavaArray)) return 0;
  let hash = 1;
  for (const item of array.values) {
    hash = toInt32(Math.imul(31, hash) + (kind ? hashOf(item, kind) : javaHash(frame, item)));
  }
  return hash;
}

/** `Arrays.binarySearch`, which returns `-(insertion point) - 1` for a missing key. */
function binarySearch(
  frame: Frame,
  values: Value[],
  key: Value,
  compare: (frame: Frame, a: Value, b: Value) => number
): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    frame.runtime.spend(1);
    const middle = (low + high) >>> 1;
    const order = compare(frame, values[middle], key);
    if (order === 0) return middle;
    if (order < 0) low = middle + 1;
    else high = middle - 1;
  }
  return -(low + 1);
}

function typeOf(variable: TypeVariable): JavaType {
  return { kind: 'typeVar', variable };
}

function classOf(owner: ClassInfo, ...args: JavaType[]): JavaType {
  return { kind: 'class', cls: owner, args };
}

/** A class type whose type arguments are `? extends` the given ones, which a method only reads from. */
function readOnly(owner: ClassInfo, ...args: JavaType[]): JavaType {
  return classOf(owner, ...args.map((arg): JavaType => ({ kind: 'wildcard', bound: arg, isSuper: false })));
}

/**
 * The `Collections` methods that make empty, single-element, and unmodifiable collections, whose unmodifiable views
 * share the elements of the collections they wrap, and `binarySearch`.
 */
function defineCollectionViews(
  cls: ClassInfo,
  collections: Collections,
  objectType: JavaType,
  comparableClass: ClassInfo
): void {
  const { listClass, setClass, mapClass } = collections;
  const generic = (names: string[], define: (...types: JavaType[]) => MethodInfo): void => {
    const variables = names.map((name): TypeVariable => ({ name, bounds: [objectType] }));
    define(...variables.map((variable) => typeOf(variable))).typeParameters = variables;
  };
  generic(['T'], (t) =>
    addMethod(cls, 'emptyList', [], classOf(listClass, t), true, (frame) =>
      createList(frame, collections.immutableList, [])
    )
  );
  generic(['T'], (t) =>
    addMethod(cls, 'singletonList', [t], classOf(listClass, t), true, (frame, _, [value]) =>
      createList(frame, collections.immutableList, [value])
    )
  );
  generic(['T'], (t) =>
    addMethod(cls, 'unmodifiableList', [readOnly(listClass, t)], classOf(listClass, t), true, (frame, _, [list]) =>
      createList(frame, collections.immutableList, itemsOf(frame, list))
    )
  );
  for (const [owner, immutable, names] of [
    [setClass, collections.immutableSet, ['T']],
    [mapClass, collections.immutableMap, ['K', 'V']],
  ] as const) {
    generic([...names], (...types) =>
      addMethod(
        cls,
        `unmodifiable${owner.name}`,
        [readOnly(owner, ...types)],
        classOf(owner, ...types),
        true,
        (frame, _, [source]) => {
          if (!(source instanceof JavaObject) || !source.store) return throwBuiltin(frame, 'NullPointerException');
          const view = frame.runtime.allocateObject(frame, immutable);
          view.store = source.store;
          view.modCount = 0;
          return view;
        }
      )
    );
  }
  const keyVariable: TypeVariable = { name: 'T', bounds: [objectType] };
  const key = typeOf(keyVariable);
  const comparable: JavaType = {
    kind: 'class',
    cls: comparableClass,
    args: [{ kind: 'wildcard', bound: key, isSuper: true }],
  };
  addMethod(cls, 'binarySearch', [readOnly(listClass, comparable), key], INT, true, (frame, _, [list, target]) =>
    binarySearch(frame, itemsOf(frame, list), target, compareNatural)
  ).typeParameters = [keyVariable];
}

function createList(frame: Frame, cls: ClassInfo, elements: Value[]): JavaObject {
  frame.runtime.allocateArray(frame, elements.length);
  const list = frame.runtime.allocateObject(frame, cls);
  list.elements = elements;
  list.modCount = 0;
  return list;
}

function arrayOf(frame: Frame, value: Value): JavaArray {
  if (!(value instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
  return value;
}

// code-gauge-allow functionNcss 60 -- One registration per Arrays method and element type.
// code-gauge-allow functionCognitiveComplexity 27 -- One registration per builtin method, each a small native.
function defineArrays(
  registry: Registry,
  objectClass: ClassInfo,
  stringType: JavaType,
  collections: Collections,
  listOf: (element: JavaType) => ClassType
): void {
  const arraysClass = registry.define('Arrays', objectClass, 'java.util');
  const objectType = objectClass.type;
  const objectArray: JavaType = { kind: 'array', element: objectType };
  const describe = (frame: Frame, value: Value, deep: boolean): string => {
    if (value === undefined) return 'null';
    const array = arrayOf(frame, value);
    frame.runtime.scanString(array.values.length);
    const parts = array.values.map((item) =>
      deep && item instanceof JavaArray ? describe(frame, item, true) : stringify(frame, item, array.elementType)
    );
    return `[${parts.join(', ')}]`;
  };
  for (const element of [...PRIMITIVE_ELEMENTS, objectType]) {
    const arrayType: JavaType = { kind: 'array', element };
    addMethod(arraysClass, 'toString', [arrayType], stringType, true, (frame, _, [array]) =>
      newString(frame, describe(frame, array, false))
    );
    addMethod(arraysClass, 'fill', [arrayType, element], VOID, true, (frame, _, [array, value]) => {
      const { values } = arrayOf(frame, array);
      frame.runtime.spend(Math.ceil(values.length / 64));
      values.fill(value);
    });
    addMethod(arraysClass, 'equals', [arrayType, arrayType], BOOLEAN, true, (frame, _, [a, b]) => {
      if (a === b) return true;
      if (!(a instanceof JavaArray) || !(b instanceof JavaArray) || a.values.length !== b.values.length) return false;
      return a.values.every((item, index) =>
        element === objectType
          ? javaEquals(frame, item, b.values[index])
          : Object.is(item, b.values[index]) || item === b.values[index]
      );
    });
    if (element !== objectType) {
      addMethod(arraysClass, 'copyOf', [arrayType, INT], arrayType, true, (frame, _, [array, length]) =>
        copyRange(frame, arrayOf(frame, array), 0, length as number)
      );
      addMethod(arraysClass, 'copyOfRange', [arrayType, INT, INT], arrayType, true, (frame, _, [array, from, to]) =>
        copyRange(frame, arrayOf(frame, array), from as number, to as number)
      );
    }
    defineArraySearches(arraysClass, element, element === objectType);
    if (element === BOOLEAN) continue;
    addMethod(arraysClass, 'sort', [arrayType], VOID, true, (frame, _, [array]) => {
      const { values } = arrayOf(frame, array);
      frame.runtime.spend(Math.ceil((values.length * Math.log2(values.length + 1)) / 16));
      if (element === objectType) {
        const sorted = values.toSorted((a, b) => compareNatural(frame, a, b));
        values.splice(0, values.length, ...sorted);
      } else values.sort(comparePrimitives);
    });
  }
  addMethod(arraysClass, 'deepToString', [objectArray], stringType, true, (frame, _, [array]) =>
    newString(frame, describe(frame, array, true))
  );
  addMethod(arraysClass, 'deepEquals', [objectArray, objectArray], BOOLEAN, true, (frame, _, [a, b]) =>
    deepEquals(frame, a, b)
  );
  const generic = (
    name: string,
    signature: (element: JavaType) => { parameterTypes: JavaType[]; returnType: JavaType; isVarargs?: boolean },
    native: NativeMethod
  ): void => {
    addGenericStatic(arraysClass, name, ['T'], objectType, signature, native);
  };
  generic(
    'copyOf',
    (element) => ({ parameterTypes: [{ kind: 'array', element }, INT], returnType: { kind: 'array', element } }),
    (frame, _, [array, length]) => copyRange(frame, arrayOf(frame, array), 0, length as number)
  );
  generic(
    'copyOfRange',
    (element) => ({ parameterTypes: [{ kind: 'array', element }, INT, INT], returnType: { kind: 'array', element } }),
    (frame, _, [array, from, to]) => copyRange(frame, arrayOf(frame, array), from as number, to as number)
  );
  generic(
    'asList',
    (element) => ({ parameterTypes: [{ kind: 'array', element }], returnType: listOf(element), isVarargs: true }),
    // The list shares the array's elements, so writes through either show in both.
    (frame, _, [array]) => createList(frame, collections.fixedSizeList, arrayOf(frame, array).values)
  );
}

/** Orders primitive values as `Arrays.sort` does, with -0.0 before 0.0 and NaN last. */
// code-gauge-allow functionCognitiveComplexity 23 -- Java's order puts -0.0 before 0.0 and NaN last, which takes one branch per case.
function comparePrimitives(a: Value, b: Value): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  const x = a as number;
  const y = b as number;
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
  if (x === y) return Object.is(x, -0) && Object.is(y, 0) ? -1 : Object.is(x, 0) && Object.is(y, -0) ? 1 : 0;
  return x < y ? -1 : 1;
}

function copyRange(frame: Frame, array: JavaArray, from: number, to: number): JavaArray {
  if (to - from < 0) {
    if (from === 0) throwBuiltin(frame, 'NegativeArraySizeException', String(to));
    throwBuiltin(frame, 'IllegalArgumentException', `${from} > ${to}`);
  }
  if (from < 0 || from > array.values.length) {
    throwBuiltin(frame, 'ArrayIndexOutOfBoundsException', `Array index out of range: ${from}`);
  }
  frame.runtime.allocateArray(frame, to - from);
  const values = Array.from({ length: to - from }, (_, index) =>
    from + index < array.values.length ? array.values[from + index] : defaultValue(array.elementType)
  );
  return new JavaArray(array.elementType, values);
}

function elementsOf(frame: Frame, value: Value): Value[] {
  if (!(value instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
  return value.elements ?? itemsOf(frame, value);
}

function touch(value: Value): void {
  const object = value as JavaObject;
  object.modCount = (object.modCount ?? 0) + 1;
}

// code-gauge-allow functionCognitiveComplexity 24 -- One registration per builtin method, each a small native.
// code-gauge-allow functionNcss 55 -- One registration per builtin method, each a small native.
function defineCollectionsClass(
  registry: Registry,
  objectClass: ClassInfo,
  collections: Collections,
  comparableClass: ClassInfo
): void {
  const cls = registry.define('Collections', objectClass, 'java.util');
  const objectType = objectClass.type;
  const listOf = (element: JavaType): ClassType => ({ kind: 'class', cls: collections.listClass, args: [element] });
  const collectionOf = (element: JavaType): ClassType => ({
    kind: 'class',
    cls: collections.listClass.interfaces[0],
    args: [element],
  });
  const comparableBound = (variable: TypeVariable): void => {
    variable.bounds = [
      {
        kind: 'class',
        cls: comparableClass,
        args: [{ kind: 'wildcard', bound: { kind: 'typeVar', variable }, isSuper: true }],
      },
    ];
  };
  const sort = addGenericStatic(
    cls,
    'sort',
    ['T'],
    objectType,
    (element) => ({ parameterTypes: [listOf(element)], returnType: VOID }),
    (frame, _, [list]) => {
      checkModifiable(frame, list, false);
      const values = elementsOf(frame, list);
      frame.runtime.spend(Math.ceil((values.length * Math.log2(values.length + 1)) / 16));
      const sorted = values.toSorted((a, b) => compareNatural(frame, a, b));
      values.splice(0, values.length, ...sorted);
      touch(list);
    }
  );
  comparableBound((sort.typeParameters as TypeVariable[])[0]);
  for (const [name, sign] of [
    ['max', 1],
    ['min', -1],
  ] as const) {
    const method = addGenericStatic(
      cls,
      name,
      ['T'],
      objectType,
      (element) => ({ parameterTypes: [collectionOf(element)], returnType: element }),
      (frame, _, [collection]) => {
        const values = elementsOf(frame, collection);
        if (values.length === 0) throwBuiltin(frame, 'NoSuchElementException');
        let best = values[0];
        for (const value of values) if (compareNatural(frame, value, best) * sign > 0) best = value;
        return best;
      }
    );
    comparableBound((method.typeParameters as TypeVariable[])[0]);
  }
  addGenericStatic(
    cls,
    'shuffle',
    ['T'],
    objectType,
    (element) => ({
      parameterTypes: [listOf(element), (registry.classes.get('Random') as ClassInfo).type],
      returnType: VOID,
    }),
    (frame, _, [list, random]) => {
      checkModifiable(frame, list, false);
      const values = elementsOf(frame, list);
      // Collections.shuffle swaps each position from the end with a random one before it, as Java specifies.
      for (let index = values.length - 1; index > 0; index--) {
        const randomClass = (random as JavaObject).cls;
        const other = frame.runtime.invokeVirtual(frame, randomClass, 'nextInt', random, [index + 1]) as number;
        [values[index], values[other]] = [values[other], values[index]];
      }
    }
  );
  addGenericStatic(
    cls,
    'addAll',
    ['T'],
    objectType,
    (element) => ({
      parameterTypes: [collectionOf({ kind: 'wildcard', bound: element, isSuper: true }), { kind: 'array', element }],
      returnType: BOOLEAN,
      isVarargs: true,
    }),
    (frame, _, [collection, array]) => {
      checkModifiable(frame, collection, true);
      let changed = false;
      for (const value of (array as JavaArray).values) {
        changed =
          frame.runtime.invokeVirtual(frame, collections.listClass.interfaces[0], 'add', collection, [value]) ===
            true || changed;
      }
      return changed;
    }
  );
  addGenericStatic(
    cls,
    'reverse',
    ['T'],
    objectType,
    (element) => ({ parameterTypes: [listOf(element)], returnType: VOID }),
    (frame, _, [list]) => {
      checkModifiable(frame, list, false);
      elementsOf(frame, list).reverse();
    }
  );
  addGenericStatic(
    cls,
    'swap',
    ['T'],
    objectType,
    (element) => ({ parameterTypes: [listOf(element), INT, INT], returnType: VOID }),
    (frame, _, [list, i, j]) => {
      checkModifiable(frame, list, false);
      const values = elementsOf(frame, list);
      for (const index of [i, j] as number[]) {
        if (index < 0 || index >= values.length) {
          throwBuiltin(frame, 'IndexOutOfBoundsException', `Index ${index} out of bounds for length ${values.length}`);
        }
      }
      [values[i as number], values[j as number]] = [values[j as number], values[i as number]];
    }
  );
  addGenericStatic(
    cls,
    'frequency',
    ['T'],
    objectType,
    (element) => ({ parameterTypes: [collectionOf(element), objectType], returnType: INT }),
    (frame, _, [collection, target]) =>
      elementsOf(frame, collection).filter((value) => javaEquals(frame, target, value)).length
  );
  addGenericStatic(
    cls,
    'nCopies',
    ['T'],
    objectType,
    (element) => ({ parameterTypes: [INT, element], returnType: listOf(element) }),
    (frame, _, [count, value]) => {
      if ((count as number) < 0) throwBuiltin(frame, 'IllegalArgumentException', `List length = ${count as number}`);
      return createList(
        frame,
        collections.immutableList,
        Array.from({ length: count as number }, () => value)
      );
    }
  );
}
