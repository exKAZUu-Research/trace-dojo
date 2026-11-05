import { type Collections, compareNatural, itemsOf, javaEquals } from './builtinCollections';
import { stringify } from './builtins';
import { addMethod, newString, type Registry } from './builtinSupport';
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
  type JavaType,
  LONG,
  type MethodInfo,
  type NativeMethod,
  SHORT,
  type TypeVariable,
  VOID,
} from './types';
import { defaultValue, JavaArray, JavaObject, type Value } from './values';

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
  defineArrays(registry, objectClass, stringType, collections, listOf);
  defineCollectionsClass(registry, objectClass, collections, comparableClass);
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

// code-gauge-allow functionCognitiveComplexity 22 -- One registration per builtin method, each a small native.
// code-gauge-allow functionNcss 46 -- One registration per builtin method, each a small native.
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
      const values = elementsOf(frame, list);
      // Collections.shuffle swaps each position from the end with a random one before it, as Java specifies.
      for (let index = values.length - 1; index > 0; index--) {
        const randomClass = (random as JavaObject).cls;
        const other = frame.runtime.invokeVirtual(frame, randomClass, 'nextInt', random, [index + 1]) as number;
        [values[index], values[other]] = [values[other], values[index]];
      }
    }
  );
  const addAll = addGenericStatic(
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
      let changed = false;
      for (const value of (array as JavaArray).values) {
        changed =
          frame.runtime.invokeVirtual(frame, collections.listClass.interfaces[0], 'add', collection, [value]) ===
            true || changed;
      }
      return changed;
    }
  );
  void addAll;
  addGenericStatic(
    cls,
    'reverse',
    ['T'],
    objectType,
    (element) => ({ parameterTypes: [listOf(element)], returnType: VOID }),
    (frame, _, [list]) => {
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
}
