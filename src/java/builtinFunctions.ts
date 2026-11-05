import { type Collections, compareNatural, findEntry, itemsOf, putEntry, removeEntry } from './builtinCollections';
import {
  addAbstractMethod,
  addInterface,
  addMethod,
  addTypeParameters,
  defineInterface,
  type Registry,
} from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  type ClassInfo,
  type ClassType,
  createClass,
  DOUBLE,
  INT,
  type JavaType,
  type MethodInfo,
  superinterfacesOf,
  type TypeVariable,
  VOID,
  type WildcardType,
} from './types';
import { JavaArray, type JavaObject, type Value } from './values';

export interface Functions {
  comparatorClass: ClassInfo;
}

const classType = (cls: ClassInfo, ...args: JavaType[]): ClassType => ({ kind: 'class', cls, args });
const superOf = (bound: JavaType): WildcardType => ({ kind: 'wildcard', bound, isSuper: true });
const extendsOf = (bound: JavaType): WildcardType => ({ kind: 'wildcard', bound, isSuper: false });

/** The classes whose objects lambdas and library function objects are, one for each functional interface. */
const functionClasses = new WeakMap<ClassInfo, ClassInfo>();

/** The single abstract method of a functional interface, or `undefined` when `cls` is not one. */
export function functionalMethodOf(cls: ClassInfo, objectClass: ClassInfo): MethodInfo | undefined {
  if (cls.kind !== 'interface') return;
  const abstract: MethodInfo[] = [];
  for (const owner of [cls, ...superinterfacesOf(cls)]) {
    for (const method of owner.methods) {
      if (!method.isAbstract || method.isStatic) continue;
      // An interface may redeclare Object's public methods, which every object implements.
      const isObjectMethod = objectClass.methods.some(
        (other) => other.name === method.name && other.parameterTypes.length === method.parameterTypes.length
      );
      const isOverridden = abstract.some((other) => other.overrides?.has(method) || other.name === method.name);
      if (!isObjectMethod && !isOverridden) abstract.push(method);
    }
  }
  return abstract.length === 1 ? abstract[0] : undefined;
}

/** Creates an object of a functional interface that runs `call` for its abstract method. */
export function functionObject(
  frame: Frame,
  iface: ClassInfo,
  call: (frame: Frame, args: Value[]) => Value,
  captured?: readonly Value[],
  outerThis?: Value
): JavaObject {
  const object = frame.runtime.allocateObject(frame, functionClassOf(iface, frame.runtime.builtins.objectClass));
  object.function = { call, captured, outerThis };
  return object;
}

export function functionClassOf(iface: ClassInfo, objectClass: ClassInfo): ClassInfo {
  let cls = functionClasses.get(iface);
  if (cls) return cls;
  const method = functionalMethodOf(iface, objectClass) as MethodInfo;
  cls = createClass(`${iface.name}$$Lambda`, objectClass, true);
  cls.isFinal = true;
  cls.interfaces = [iface];
  cls.supertypes.push(iface.type as ClassType);
  const implementation = addMethod(
    cls,
    method.name,
    method.parameterTypes,
    method.returnType,
    false,
    (frame, receiver, args) => (receiver as JavaObject).function?.call(frame, args)
  );
  implementation.overrides = new Set([method, ...(method.overrides ?? [])]);
  functionClasses.set(iface, cls);
  return cls;
}

interface Context {
  registry: Registry;
  objectClass: ClassInfo;
  objectType: JavaType;
}

/** Defines a functional interface with type parameters `names` and the abstract method `signature` gives. */
function defineFunctional(
  context: Context,
  name: string,
  packageName: string,
  names: string[],
  methodName: string,
  signature: (...variables: JavaType[]) => [JavaType[], JavaType]
): { cls: ClassInfo; variables: JavaType[] } {
  const cls = defineInterface(context.registry, name, packageName);
  const variables = addTypeParameters(cls, names, context.objectType);
  const [parameterTypes, returnType] = signature(...variables);
  addAbstractMethod(cls, methodName, parameterTypes, returnType);
  return { cls, variables };
}

// code-gauge-allow functionNcss 33 -- One registration per builtin method, each a small native.
export function defineFunctions(
  registry: Registry,
  objectClass: ClassInfo,
  collections: Collections,
  comparableClass: ClassInfo
): Functions {
  const context: Context = { registry, objectClass, objectType: objectClass.type };
  const pkg = 'java.util.function';
  defineFunctional(context, 'Runnable', 'java.lang', [], 'run', () => [[], VOID]);
  const autoCloseable = defineFunctional(context, 'AutoCloseable', 'java.lang', [], 'close', () => [[], VOID]);
  const close = autoCloseable.cls.methods[0];
  close.thrownTypes = [registry.classes.get('Exception') as ClassInfo];
  const fn = defineFunctional(context, 'Function', pkg, ['T', 'R'], 'apply', (t, r) => [[t], r]);
  const biFunction = defineFunctional(context, 'BiFunction', pkg, ['T', 'U', 'R'], 'apply', (t, u, r) => [[t, u], r]);
  const consumer = defineFunctional(context, 'Consumer', pkg, ['T'], 'accept', (t) => [[t], VOID]);
  const biConsumer = defineFunctional(context, 'BiConsumer', pkg, ['T', 'U'], 'accept', (t, u) => [[t, u], VOID]);
  defineFunctional(context, 'Supplier', pkg, ['T'], 'get', (t) => [[], t]);
  const predicate = defineFunctional(context, 'Predicate', pkg, ['T'], 'test', (t) => [[t], BOOLEAN]);
  defineFunctional(context, 'BiPredicate', pkg, ['T', 'U'], 'test', (t, u) => [[t, u], BOOLEAN]);
  const toInt = defineFunctional(context, 'ToIntFunction', pkg, ['T'], 'applyAsInt', (t) => [[t], INT]);
  const toDouble = defineFunctional(context, 'ToDoubleFunction', pkg, ['T'], 'applyAsDouble', (t) => [[t], DOUBLE]);
  defineFunctional(context, 'IntFunction', pkg, ['R'], 'apply', (r) => [[INT], r]);
  defineFunctional(context, 'IntPredicate', pkg, [], 'test', () => [[INT], BOOLEAN]);
  defineFunctional(context, 'IntUnaryOperator', pkg, [], 'applyAsInt', () => [[INT], INT]);
  defineFunctional(context, 'IntBinaryOperator', pkg, [], 'applyAsInt', () => [[INT, INT], INT]);
  defineFunctional(context, 'IntConsumer', pkg, [], 'accept', () => [[INT], VOID]);
  defineFunctional(context, 'DoubleUnaryOperator', pkg, [], 'applyAsDouble', () => [[DOUBLE], DOUBLE]);
  defineFunctional(context, 'DoubleBinaryOperator', pkg, [], 'applyAsDouble', () => [[DOUBLE, DOUBLE], DOUBLE]);
  const unary = defineInterface(registry, 'UnaryOperator', pkg);
  const [unaryT] = addTypeParameters(unary, ['T'], context.objectType);
  addInterface(unary, classType(fn.cls, unaryT, unaryT));
  const binary = defineInterface(registry, 'BinaryOperator', pkg);
  const [binaryT] = addTypeParameters(binary, ['T'], context.objectType);
  addInterface(binary, classType(biFunction.cls, binaryT, binaryT, binaryT));
  const comparator = defineComparator(
    context,
    { fn: fn.cls, toInt: toInt.cls, toDouble: toDouble.cls },
    comparableClass
  );
  definePredicateDefaults(predicate.cls, predicate.variables[0]);
  defineCollectionDefaults(context, collections, {
    consumer: consumer.cls,
    predicate: predicate.cls,
    unary,
    comparator,
    biConsumer: biConsumer.cls,
    fn: fn.cls,
    biFunction: biFunction.cls,
  });
  return { comparatorClass: comparator };
}

/** Calls the abstract method of a functional interface object, as library code calls a lambda. */
export function callFunction(frame: Frame, iface: ClassInfo, target: Value, args: Value[]): Value {
  if (target === undefined) return throwBuiltin(frame, 'NullPointerException');
  const method = functionalMethodOf(iface, frame.runtime.builtins.objectClass) as MethodInfo;
  return frame.runtime.invokeVirtual(frame, method.owner, method.name, target, args);
}

// code-gauge-allow functionNcss 37 -- One registration per builtin method, each a small native.
function defineComparator(
  context: Context,
  functions: { fn: ClassInfo; toInt: ClassInfo; toDouble: ClassInfo },
  comparableClass: ClassInfo
): ClassInfo {
  const cls = defineInterface(context.registry, 'Comparator', 'java.util');
  const [t] = addTypeParameters(cls, ['T'], context.objectType);
  addAbstractMethod(cls, 'compare', [t, t], INT);
  const comparatorOf = (element: JavaType): ClassType => classType(cls, element);
  const compare = (frame: Frame, comparator: Value, a: Value, b: Value): number =>
    callFunction(frame, cls, comparator, [a, b]) as number;
  addMethod(cls, 'reversed', [], comparatorOf(t), false, (frame, receiver) =>
    functionObject(frame, cls, (callFrame, [a, b]) => compare(callFrame, receiver, b, a))
  );
  addMethod(cls, 'thenComparing', [comparatorOf(superOf(t))], comparatorOf(t), false, (frame, receiver, [other]) =>
    functionObject(frame, cls, (callFrame, [a, b]) => {
      const first = compare(callFrame, receiver, a, b);
      return first === 0 ? compare(callFrame, other, a, b) : first;
    })
  );
  const generic = (
    name: string,
    signature: (variables: TypeVariable[]) => { parameterTypes: JavaType[]; returnType: JavaType },
    native: (frame: Frame, args: Value[]) => Value,
    names = ['T']
  ): void => {
    const typeParameters = names.map((variableName): TypeVariable => ({
      name: variableName,
      bounds: [context.objectType],
    }));
    const { parameterTypes, returnType } = signature(typeParameters);
    const method = addMethod(cls, name, parameterTypes, returnType, true, (frame, _, args) => native(frame, args));
    method.typeParameters = typeParameters;
  };
  const natural = (frame: Frame): JavaObject =>
    functionObject(frame, cls, (callFrame, [a, b]) => compareNatural(callFrame, a, b));
  const comparableOf = (variable: TypeVariable): void => {
    variable.bounds = [classType(comparableClass, superOf({ kind: 'typeVar', variable }))];
  };
  generic(
    'naturalOrder',
    ([variable]) => {
      comparableOf(variable);
      return { parameterTypes: [], returnType: comparatorOf({ kind: 'typeVar', variable }) };
    },
    (frame) => natural(frame)
  );
  generic(
    'reverseOrder',
    ([variable]) => {
      comparableOf(variable);
      return { parameterTypes: [], returnType: comparatorOf({ kind: 'typeVar', variable }) };
    },
    (frame) => functionObject(frame, cls, (callFrame, [a, b]) => compareNatural(callFrame, b, a))
  );
  generic(
    'comparing',
    ([tVariable, uVariable]) => {
      comparableOf(uVariable);
      const tType: JavaType = { kind: 'typeVar', variable: tVariable };
      const uType: JavaType = { kind: 'typeVar', variable: uVariable };
      return {
        parameterTypes: [classType(functions.fn, superOf(tType), extendsOf(uType))],
        returnType: comparatorOf(tType),
      };
    },
    (frame, [key]) =>
      functionObject(frame, cls, (callFrame, [a, b]) =>
        compareNatural(
          callFrame,
          callFunction(callFrame, functions.fn, key, [a]),
          callFunction(callFrame, functions.fn, key, [b])
        )
      ),
    ['T', 'U']
  );
  for (const [name, iface] of [
    ['comparingInt', functions.toInt],
    ['comparingDouble', functions.toDouble],
  ] as const) {
    generic(
      name,
      ([variable]) => {
        const tType: JavaType = { kind: 'typeVar', variable };
        return { parameterTypes: [classType(iface, superOf(tType))], returnType: comparatorOf(tType) };
      },
      (frame, [key]) =>
        functionObject(frame, cls, (callFrame, [a, b]) => {
          const x = callFunction(callFrame, iface, key, [a]) as number;
          const y = callFunction(callFrame, iface, key, [b]) as number;
          return x < y ? -1 : x > y ? 1 : 0;
        })
    );
  }
  return cls;
}

function definePredicateDefaults(cls: ClassInfo, t: JavaType): void {
  const predicateOf = classType(cls, t);
  const test = (frame: Frame, predicate: Value, value: Value): boolean =>
    callFunction(frame, cls, predicate, [value]) === true;
  addMethod(cls, 'negate', [], predicateOf, false, (frame, receiver) =>
    functionObject(frame, cls, (callFrame, [value]) => !test(callFrame, receiver, value))
  );
  addMethod(cls, 'and', [classType(cls, superOf(t))], predicateOf, false, (frame, receiver, [other]) =>
    functionObject(
      frame,
      cls,
      (callFrame, [value]) => test(callFrame, receiver, value) && test(callFrame, other, value)
    )
  );
  addMethod(cls, 'or', [classType(cls, superOf(t))], predicateOf, false, (frame, receiver, [other]) =>
    functionObject(
      frame,
      cls,
      (callFrame, [value]) => test(callFrame, receiver, value) || test(callFrame, other, value)
    )
  );
}

/** Sorts in place with a comparator, or in natural order when it is null, as `List.sort` does. */
export function sortValues(frame: Frame, values: Value[], comparator: Value, comparatorClass: ClassInfo): void {
  frame.runtime.spend(Math.ceil((values.length * Math.log2(values.length + 1)) / 16));
  const sorted = values.toSorted((a, b) =>
    comparator === undefined
      ? compareNatural(frame, a, b)
      : (callFunction(frame, comparatorClass, comparator, [a, b]) as number)
  );
  values.splice(0, values.length, ...sorted);
}

function defineCollectionDefaults(
  context: Context,
  collections: Collections,
  functions: {
    consumer: ClassInfo;
    predicate: ClassInfo;
    unary: ClassInfo;
    comparator: ClassInfo;
    biConsumer: ClassInfo;
    fn: ClassInfo;
    biFunction: ClassInfo;
  }
): void {
  defineIterableDefaults(collections, functions);
  defineListDefaults(collections, functions);
  defineMapDefaults(collections, functions);
  defineComparatorSorts(context, collections, functions);
}

type DefaultFunctions = Parameters<typeof defineCollectionDefaults>[2];

/** `Iterable.forEach` and `Collection.removeIf`, which every builtin collection inherits. */
function defineIterableDefaults(collections: Collections, functions: DefaultFunctions): void {
  const { iterableClass, collectionClass } = collections;
  const [iterableT] = iterableClass.typeParameters.map((variable): JavaType => ({ kind: 'typeVar', variable }));
  addMethod(
    iterableClass,
    'forEach',
    [classType(functions.consumer, superOf(iterableT))],
    VOID,
    false,
    (frame, receiver, [action]) => {
      if (action === undefined) throwBuiltin(frame, 'NullPointerException');
      const iterator = frame.runtime.invokeVirtual(frame, iterableClass, 'iterator', receiver, []);
      frame.temporaries.push(iterator);
      try {
        while (frame.runtime.invokeVirtual(frame, collections.iteratorClass, 'hasNext', iterator, []) === true) {
          const value = frame.runtime.invokeVirtual(frame, collections.iteratorClass, 'next', iterator, []);
          callFunction(frame, functions.consumer, action, [value]);
        }
      } finally {
        frame.temporaries.pop();
      }
    }
  );
  const [collectionE] = collectionClass.typeParameters.map((variable): JavaType => ({ kind: 'typeVar', variable }));
  addMethod(
    collectionClass,
    'removeIf',
    [classType(functions.predicate, superOf(collectionE))],
    BOOLEAN,
    false,
    (frame, receiver, [filter]) => {
      const object = receiver as JavaObject;
      const items = [...itemsOf(frame, receiver)];
      const removed = items.filter((item) => callFunction(frame, functions.predicate, filter, [item]) === true);
      if (removed.length === 0) return false;
      if (object.elements)
        object.elements.splice(0, object.elements.length, ...object.elements.filter((item) => !removed.includes(item)));
      else for (const item of removed) removeEntry(frame, receiver, item);
      object.modCount = (object.modCount ?? 0) + 1;
      return true;
    }
  );
}

/** `List.sort` and `List.replaceAll`. */
function defineListDefaults(collections: Collections, functions: DefaultFunctions): void {
  const { listClass } = collections;
  const [listE] = listClass.typeParameters.map((variable): JavaType => ({ kind: 'typeVar', variable }));
  addMethod(
    listClass,
    'sort',
    [classType(functions.comparator, superOf(listE))],
    VOID,
    false,
    (frame, receiver, [comparator]) => {
      sortValues(frame, itemsOf(frame, receiver), comparator, functions.comparator);
      const object = receiver as JavaObject;
      object.modCount = (object.modCount ?? 0) + 1;
    }
  );
  addMethod(
    listClass,
    'replaceAll',
    [classType(functions.unary, listE)],
    VOID,
    false,
    (frame, receiver, [operator]) => {
      const values = itemsOf(frame, receiver);
      for (const [index, value] of values.entries())
        values[index] = callFunction(frame, functions.unary, operator, [value]);
    }
  );
}

/** `Map.forEach`, `Map.computeIfAbsent`, and `Map.merge`. */
function defineMapDefaults(collections: Collections, functions: DefaultFunctions): void {
  const { mapClass } = collections;
  const [mapK, mapV] = mapClass.typeParameters.map((variable): JavaType => ({ kind: 'typeVar', variable }));
  addMethod(
    mapClass,
    'forEach',
    [classType(functions.biConsumer, superOf(mapK), superOf(mapV))],
    VOID,
    false,
    (frame, receiver, [action]) => {
      const entries = frame.runtime.invokeVirtual(frame, mapClass, 'entrySet', receiver, []) as JavaObject;
      for (const node of entries.elements ?? []) {
        const [key, value] = (node as JavaObject).elements ?? [];
        callFunction(frame, functions.biConsumer, action, [key, value]);
      }
    }
  );
  addMethod(
    mapClass,
    'computeIfAbsent',
    [mapK, classType(functions.fn, superOf(mapK), extendsOf(mapV))],
    mapV,
    false,
    (frame, receiver, [key, mapping]) => {
      const entry = findEntry(frame, receiver, key);
      if (entry && entry.value !== undefined) return entry.value;
      const value = callFunction(frame, functions.fn, mapping, [key]);
      if (value !== undefined) putEntry(frame, receiver, key, false, value);
      return value;
    }
  );
  addMethod(
    mapClass,
    'merge',
    [mapK, mapV, classType(functions.biFunction, superOf(mapV), superOf(mapV), extendsOf(mapV))],
    mapV,
    false,
    (frame, receiver, [key, value, remapping]) => {
      const entry = findEntry(frame, receiver, key);
      const merged =
        entry && entry.value !== undefined
          ? callFunction(frame, functions.biFunction, remapping, [entry.value, value])
          : value;
      if (merged === undefined) removeEntry(frame, receiver, key);
      else putEntry(frame, receiver, key, false, merged);
      return merged;
    }
  );
}

/** `Collections.sort` and `Arrays.sort` with a comparator. */
function defineComparatorSorts(context: Context, collections: Collections, functions: DefaultFunctions): void {
  const { listClass } = collections;
  const comparatorOf = (element: JavaType): ClassType => classType(functions.comparator, superOf(element));
  const typeParameter = (): TypeVariable => ({ name: 'T', bounds: [context.objectType] });
  const collectionsClass = context.registry.classes.get('Collections') as ClassInfo;
  const listVariable = typeParameter();
  const listT: JavaType = { kind: 'typeVar', variable: listVariable };
  const sortList = addMethod(
    collectionsClass,
    'sort',
    [classType(listClass, listT), comparatorOf(listT)],
    VOID,
    true,
    (frame, _, [list, comparator]) => {
      sortValues(frame, itemsOf(frame, list), comparator, functions.comparator);
      const object = list as JavaObject;
      object.modCount = (object.modCount ?? 0) + 1;
    }
  );
  sortList.typeParameters = [listVariable];
  const arraysClass = context.registry.classes.get('Arrays') as ClassInfo;
  const arrayVariable = typeParameter();
  const arrayT: JavaType = { kind: 'typeVar', variable: arrayVariable };
  const sortArray = addMethod(
    arraysClass,
    'sort',
    [{ kind: 'array', element: arrayT }, comparatorOf(arrayT)],
    VOID,
    true,
    (frame, _, [array, comparator]) => {
      if (!(array instanceof JavaArray)) throwBuiltin(frame, 'NullPointerException');
      sortValues(frame, array.values, comparator, functions.comparator);
    }
  );
  sortArray.typeParameters = [arrayVariable];
}
