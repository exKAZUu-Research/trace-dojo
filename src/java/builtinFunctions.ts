import {
  type Collections,
  compareNatural,
  findEntry,
  itemsOf,
  javaEquals,
  putEntry,
  removeEntry,
} from './builtinCollections';
import { checkModifiable, forEachLiveEntry, mapViewSources, removeElements } from './builtinCollectionSupport';
import {
  addAbstractMethod,
  addConstant,
  addInterface,
  addMethod,
  addTypeParameters,
  defineInterface,
  type Registry,
  requireString,
} from './builtinSupport';
import { compareIgnoringCase } from './builtinText';
import { compareValues } from './builtinWrappers';
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
import { type HashStore, JavaArray, JavaObject, type Value } from './values';

export interface Functions {
  comparatorClass: ClassInfo;
}

const classType = (cls: ClassInfo, ...args: JavaType[]): ClassType => ({ kind: 'class', cls, args });
const superOf = (bound: JavaType): WildcardType => ({ kind: 'wildcard', bound, isSuper: true });
const extendsOf = (bound: JavaType): WildcardType => ({ kind: 'wildcard', bound, isSuper: false });

/** The classes whose objects lambdas and library function objects are, one for each functional interface. */
/** The classes of function objects, by interface and then by the class whose lambdas they are. */
const functionClasses = new WeakMap<ClassInfo, Map<ClassInfo | undefined, ClassInfo>>();

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
  outerThis?: Value,
  owner?: ClassInfo
): JavaObject {
  const object = frame.runtime.allocateObject(frame, functionClassOf(iface, frame.runtime.builtins.objectClass, owner));
  object.function = { call, captured, outerThis };
  return object;
}

/**
 * The class of function objects of `iface`, named after the class whose lambdas they are as the JVM names its
 * hidden classes (`Main$$Lambda`), or after the interface for functions the library makes.
 */
export function functionClassOf(iface: ClassInfo, objectClass: ClassInfo, owner?: ClassInfo): ClassInfo {
  let byOwner = functionClasses.get(iface);
  if (!byOwner) {
    byOwner = new Map();
    functionClasses.set(iface, byOwner);
  }
  let cls = byOwner.get(owner);
  if (cls) return cls;
  const method = functionalMethodOf(iface, objectClass) as MethodInfo;
  cls = createClass(`${owner?.binaryName ?? iface.name}$$Lambda`, objectClass, true);
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
  byOwner.set(owner, cls);
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

// code-gauge-allow functionNcss 36 -- One registration per builtin functional interface.
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
  defineCaseInsensitiveOrder(registry.classes.get('String') as ClassInfo, comparator, objectClass);
  defineEntryComparators(
    context,
    collections.mapClass.memberTypes.get('Entry') as ClassInfo,
    comparator,
    comparableClass
  );
  definePredicateDefaults(predicate.cls, predicate.variables[0]);
  defineCompositions(context, { fn, biFunction, consumer }, { unary, binary, comparator });
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

/** `Map.Entry.comparingByKey` and `comparingByValue`, which order entries by their keys' or values' natural order. */
function defineEntryComparators(
  context: Context,
  entryClass: ClassInfo,
  comparatorClass: ClassInfo,
  comparableClass: ClassInfo
): void {
  for (const [name, getter] of [
    ['comparingByKey', 'getKey'],
    ['comparingByValue', 'getValue'],
  ] as const) {
    const [k, v] = ['K', 'V'].map((variableName): TypeVariable => ({
      name: variableName,
      bounds: [context.objectType],
    }));
    const [kType, vType] = [k, v].map((variable): JavaType => ({ kind: 'typeVar', variable }));
    const ordered = getter === 'getKey' ? k : v;
    ordered.bounds = [classType(comparableClass, superOf({ kind: 'typeVar', variable: ordered }))];
    const method = addMethod(
      entryClass,
      name,
      [],
      classType(comparatorClass, classType(entryClass, kType, vType)),
      true,
      (frame) =>
        functionObject(frame, comparatorClass, (callFrame, [a, b]) =>
          compareNatural(
            callFrame,
            callFrame.runtime.invokeVirtual(callFrame, entryClass, getter, a, []),
            callFrame.runtime.invokeVirtual(callFrame, entryClass, getter, b, [])
          )
        )
    );
    method.typeParameters = [k, v];
  }
}

function defineCaseInsensitiveOrder(stringClass: ClassInfo, comparatorClass: ClassInfo, objectClass: ClassInfo): void {
  const order = new JavaObject(functionClassOf(comparatorClass, objectClass));
  order.function = { call: (frame, [a, b]) => compareIgnoringCase(requireString(frame, a), requireString(frame, b)) };
  addConstant(stringClass, 'CASE_INSENSITIVE_ORDER', classType(comparatorClass, stringClass.type), order);
}

/** Calls the abstract method of a functional interface object, as library code calls a lambda. */
export function callFunction(frame: Frame, iface: ClassInfo, target: Value, args: Value[]): Value {
  if (target === undefined) return throwBuiltin(frame, 'NullPointerException');
  const method = functionalMethodOf(iface, frame.runtime.builtins.objectClass) as MethodInfo;
  return frame.runtime.invokeVirtual(frame, method.owner, method.name, target, args);
}

// code-gauge-allow functionNcss 38 -- One registration per builtin method, each a small native.
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
  defineThenComparing(cls, t, functions, comparableClass);
  return cls;
}

/** `thenComparing` with a key extractor, `thenComparingInt`, and `thenComparingDouble`, which break ties by a key. */
function defineThenComparing(
  cls: ClassInfo,
  t: JavaType,
  functions: { fn: ClassInfo; toInt: ClassInfo; toDouble: ClassInfo },
  comparableClass: ClassInfo
): void {
  const thenBy = (frame: Frame, first: Value, byKey: (frame: Frame, a: Value, b: Value) => number): JavaObject =>
    functionObject(frame, cls, (callFrame, [a, b]) => {
      const order = callFunction(callFrame, cls, first, [a, b]) as number;
      return order === 0 ? byKey(callFrame, a, b) : order;
    });
  const keyVariable: TypeVariable = { name: 'U', bounds: [] };
  const keyType: JavaType = { kind: 'typeVar', variable: keyVariable };
  keyVariable.bounds = [classType(comparableClass, superOf(keyType))];
  addMethod(
    cls,
    'thenComparing',
    [classType(functions.fn, superOf(t), extendsOf(keyType))],
    classType(cls, t),
    false,
    (frame, receiver, [key]) =>
      thenBy(frame, receiver, (callFrame, a, b) =>
        compareNatural(
          callFrame,
          callFunction(callFrame, functions.fn, key, [a]),
          callFunction(callFrame, functions.fn, key, [b])
        )
      )
  ).typeParameters = [keyVariable];
  for (const [name, iface] of [
    ['thenComparingInt', functions.toInt],
    ['thenComparingDouble', functions.toDouble],
  ] as const) {
    addMethod(cls, name, [classType(iface, superOf(t))], classType(cls, t), false, (frame, receiver, [key]) =>
      thenBy(frame, receiver, (callFrame, a, b) =>
        compareValues(callFunction(callFrame, iface, key, [a]), callFunction(callFrame, iface, key, [b]))
      )
    );
  }
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

interface Functional {
  cls: ClassInfo;
  variables: JavaType[];
}

function typeOf(variable: TypeVariable): JavaType {
  return { kind: 'typeVar', variable };
}

/** The default and static methods that compose functions: `andThen`, `compose`, `identity`, `minBy`, and `maxBy`. */
function defineCompositions(
  context: Context,
  { fn, biFunction, consumer }: { fn: Functional; biFunction: Functional; consumer: Functional },
  { unary, binary, comparator }: { unary: ClassInfo; binary: ClassInfo; comparator: ClassInfo }
): void {
  const variable = (name: string): TypeVariable => ({ name, bounds: [context.objectType] });
  const apply = (iface: Functional, target: Value, frame: Frame, args: Value[]): Value =>
    callFunction(frame, iface.cls, target, args);
  const [t, r] = fn.variables;
  const v = variable('V');
  addMethod(
    fn.cls,
    'andThen',
    [classType(fn.cls, superOf(r), extendsOf(typeOf(v)))],
    classType(fn.cls, t, typeOf(v)),
    false,
    (frame, receiver, [after]) =>
      functionObject(frame, fn.cls, (callFrame, [value]) =>
        apply(fn, after, callFrame, [apply(fn, receiver, callFrame, [value])])
      )
  ).typeParameters = [v];
  const before = variable('V');
  addMethod(
    fn.cls,
    'compose',
    [classType(fn.cls, superOf(typeOf(before)), extendsOf(t))],
    classType(fn.cls, typeOf(before), r),
    false,
    (frame, receiver, [first]) =>
      functionObject(frame, fn.cls, (callFrame, [value]) =>
        apply(fn, receiver, callFrame, [apply(fn, first, callFrame, [value])])
      )
  ).typeParameters = [before];
  for (const [owner, result] of [
    [fn.cls, (x: JavaType) => classType(fn.cls, x, x)],
    [unary, (x: JavaType) => classType(unary, x)],
  ] as const) {
    const element = variable('T');
    addMethod(owner, 'identity', [], result(typeOf(element)), true, (frame) =>
      functionObject(frame, owner, (_, [value]) => value)
    ).typeParameters = [element];
  }
  const [bt, bu, br] = biFunction.variables;
  const bv = variable('V');
  addMethod(
    biFunction.cls,
    'andThen',
    [classType(fn.cls, superOf(br), extendsOf(typeOf(bv)))],
    classType(biFunction.cls, bt, bu, typeOf(bv)),
    false,
    (frame, receiver, [after]) =>
      functionObject(frame, biFunction.cls, (callFrame, [a, b]) =>
        apply(fn, after, callFrame, [apply(biFunction, receiver, callFrame, [a, b])])
      )
  ).typeParameters = [bv];
  const [ct] = consumer.variables;
  addMethod(
    consumer.cls,
    'andThen',
    [classType(consumer.cls, superOf(ct))],
    classType(consumer.cls, ct),
    false,
    (frame, receiver, [after]) =>
      functionObject(frame, consumer.cls, (callFrame, [value]) => {
        apply(consumer, receiver, callFrame, [value]);
        apply(consumer, after, callFrame, [value]);
      })
  );
  for (const [name, sign] of [
    ['minBy', -1],
    ['maxBy', 1],
  ] as const) {
    const element = variable('T');
    addMethod(
      binary,
      name,
      [classType(comparator, superOf(typeOf(element)))],
      classType(binary, typeOf(element)),
      true,
      (frame, _, [order]) =>
        functionObject(frame, binary, (callFrame, [a, b]) =>
          (callFunction(callFrame, comparator, order, [a, b]) as number) * sign >= 0 ? a : b
        )
    ).typeParameters = [element];
  }
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
      // A map's views walk the map as Map.forEach does; other collections iterate as Iterable.forEach does.
      const view = mapViewSources.get(receiver as JavaObject);
      if (view) {
        forEachLiveEntry(frame, receiver as JavaObject, view.store, (entry) =>
          callFunction(frame, functions.consumer, action, [view.elementOf(entry)])
        );
        return;
      }
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
      checkModifiable(frame, receiver, false);
      const items = [...itemsOf(frame, receiver)];
      const removed = items.filter((item) => callFunction(frame, functions.predicate, filter, [item]) === true);
      return removeAllOf(frame, receiver, removed);
    }
  );
  defineBulkOperations(collectionClass);
}

/** Removes the items in `removed` from a list, a set, or a view of a map, returning whether there were any. */
function removeAllOf(frame: Frame, receiver: Value, removed: Value[]): boolean {
  if (removed.length === 0) return false;
  checkModifiable(frame, receiver, true);
  const object = receiver as JavaObject;
  if (object.elements) return removeElements(frame, receiver, (item) => removed.includes(item));
  for (const item of removed) removeEntry(frame, receiver, item);
  object.modCount = (object.modCount ?? 0) + 1;
  return true;
}

/** `containsAll`, `removeAll`, and `retainAll`, which ask the other collection whether it contains each element. */
function defineBulkOperations(collectionClass: ClassInfo): void {
  const otherType = classType(collectionClass, { kind: 'wildcard', bound: undefined, isSuper: false });
  const contains = (frame: Frame, collection: Value, item: Value): boolean => {
    if (collection === undefined) return throwBuiltin(frame, 'NullPointerException');
    return frame.runtime.invokeVirtual(frame, collectionClass, 'contains', collection, [item]) === true;
  };
  addMethod(collectionClass, 'containsAll', [otherType], BOOLEAN, false, (frame, receiver, [other]) =>
    itemsOf(frame, other).every((item) => contains(frame, receiver, item))
  );
  for (const [name, keepsContained] of [
    ['removeAll', false],
    ['retainAll', true],
  ] as const) {
    addMethod(collectionClass, name, [otherType], BOOLEAN, false, (frame, receiver, [other]) => {
      checkModifiable(frame, receiver, false);
      const removed = [...itemsOf(frame, receiver)].filter((item) => contains(frame, other, item) !== keepsContained);
      return removeAllOf(frame, receiver, removed);
    });
  }
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
      checkModifiable(frame, receiver, false);
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
      checkModifiable(frame, receiver, false);
      const values = itemsOf(frame, receiver);
      for (const [index, value] of values.entries())
        values[index] = callFunction(frame, functions.unary, operator, [value]);
    }
  );
}

/** Visits the entries of a map that keeps no store of its own, through the entries its `entrySet` gives. */
function forEachEntryOf(
  frame: Frame,
  mapClass: ClassInfo,
  map: Value,
  visit: (key: Value, value: Value) => void
): void {
  const entries = frame.runtime.invokeVirtual(frame, mapClass, 'entrySet', map, []) as JavaObject;
  for (const node of entries.elements ?? []) {
    const [key, value] = (node as JavaObject).elements ?? [];
    visit(key, value);
  }
}

/** `Map.forEach`, `Map.computeIfAbsent`, and `Map.merge`. */
// code-gauge-allow functionCognitiveComplexity 16 -- One registration per default method, each a small native.
// code-gauge-allow functionNcss 32 -- One registration per default method, each a small native.
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
      if (action === undefined) throwBuiltin(frame, 'NullPointerException');
      const visit = (key: Value, value: Value): void => {
        callFunction(frame, functions.biConsumer, action, [key, value]);
      };
      const map = receiver as JavaObject;
      if (map.store)
        forEachLiveEntry(
          frame,
          map,
          () => map.store as HashStore,
          (entry) => visit(entry.key, entry.value)
        );
      else forEachEntryOf(frame, mapClass, receiver, visit);
    }
  );
  addMethod(
    mapClass,
    'computeIfAbsent',
    [mapK, classType(functions.fn, superOf(mapK), extendsOf(mapV))],
    mapV,
    false,
    (frame, receiver, [key, mapping]) => {
      checkModifiable(frame, receiver, false);
      const entry = findEntry(frame, receiver, key);
      if (entry && entry.value !== undefined) return entry.value;
      const value = callFunction(frame, functions.fn, mapping, [key]);
      if (value !== undefined) putEntry(frame, receiver, key, false, value, true);
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
      checkModifiable(frame, receiver, false);
      const entry = findEntry(frame, receiver, key);
      const merged =
        entry && entry.value !== undefined
          ? callFunction(frame, functions.biFunction, remapping, [entry.value, value])
          : value;
      if (merged === undefined) removeEntry(frame, receiver, key);
      else putEntry(frame, receiver, key, false, merged, true);
      return merged;
    }
  );
  defineMapRemappings(mapClass, functions, mapK, mapV);
}

/**
 * `Map.compute` and `Map.computeIfPresent`, which remove the key when the function returns null, `remove` of a key only
 * with a given value, and `replace`.
 */
function defineMapRemappings(mapClass: ClassInfo, functions: DefaultFunctions, mapK: JavaType, mapV: JavaType): void {
  const remappingType = classType(functions.biFunction, superOf(mapK), superOf(mapV), extendsOf(mapV));
  for (const [name, needsValue] of [
    ['compute', false],
    ['computeIfPresent', true],
  ] as const) {
    addMethod(mapClass, name, [mapK, remappingType], mapV, false, (frame, receiver, [key, remapping]) => {
      checkModifiable(frame, receiver, false);
      const current = findEntry(frame, receiver, key)?.value;
      if (needsValue && current === undefined) return;
      const value = callFunction(frame, functions.biFunction, remapping, [key, current]);
      if (value === undefined) removeEntry(frame, receiver, key);
      else putEntry(frame, receiver, key, false, value, true);
      return value;
    });
  }
  const objectType = mapClass.typeParameters[0].bounds[0] as JavaType;
  addMethod(mapClass, 'remove', [objectType, objectType], BOOLEAN, false, (frame, receiver, [key, value]) => {
    checkModifiable(frame, receiver, false);
    const entry = findEntry(frame, receiver, key);
    if (!entry || !javaEquals(frame, entry.value, value)) return false;
    removeEntry(frame, receiver, key);
    return true;
  });
  addMethod(mapClass, 'replace', [mapK, mapV], mapV, false, (frame, receiver, [key, value]) => {
    checkModifiable(frame, receiver, false);
    const entry = findEntry(frame, receiver, key);
    if (!entry) return;
    const previous = entry.value;
    entry.value = value;
    return previous;
  });
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
      checkModifiable(frame, list, false);
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
  defineComparatorExtremes(context, collections, functions);
}

/** `Collections.max` and `Collections.min` with a comparator, which keep the first of equal elements. */
function defineComparatorExtremes(context: Context, collections: Collections, functions: DefaultFunctions): void {
  const collectionsClass = context.registry.classes.get('Collections') as ClassInfo;
  for (const [name, sign] of [
    ['max', 1],
    ['min', -1],
  ] as const) {
    const variable: TypeVariable = { name: 'T', bounds: [context.objectType] };
    const elementType: JavaType = { kind: 'typeVar', variable };
    const extreme = addMethod(
      collectionsClass,
      name,
      [
        classType(collections.collectionClass, extendsOf(elementType)),
        classType(functions.comparator, superOf(elementType)),
      ],
      elementType,
      true,
      (frame, _, [collection, comparator]) => {
        const values = itemsOf(frame, collection);
        if (values.length === 0) throwBuiltin(frame, 'NoSuchElementException');
        let best = values[0];
        for (const value of values) {
          if ((callFunction(frame, functions.comparator, comparator, [value, best]) as number) * sign > 0) best = value;
        }
        return best;
      }
    );
    extreme.typeParameters = [variable];
  }
  const orderVariable: TypeVariable = { name: 'T', bounds: [context.objectType] };
  const orderType: JavaType = { kind: 'typeVar', variable: orderVariable };
  addMethod(collectionsClass, 'reverseOrder', [], classType(functions.comparator, orderType), true, (frame) =>
    functionObject(frame, functions.comparator, (callFrame, [a, b]) => compareNatural(callFrame, b, a))
  ).typeParameters = [orderVariable];
  addMethod(
    collectionsClass,
    'reverseOrder',
    [classType(functions.comparator, orderType)],
    classType(functions.comparator, orderType),
    true,
    (frame, _, [order]) =>
      functionObject(frame, functions.comparator, (callFrame, [a, b]) =>
        callFunction(callFrame, functions.comparator, order, [b, a])
      )
  ).typeParameters = [orderVariable];
}
