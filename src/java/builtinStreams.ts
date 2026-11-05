import { type Collections, compareNatural, itemsOf, javaEquals, javaHash } from './builtinCollections';
import { callFunction, type Functions } from './builtinFunctions';
import { stringify } from './builtins';
import { addMethod, defineInterface, newString, type Registry } from './builtinSupport';
import { box, type Wrappers } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  type ClassInfo,
  type ClassType,
  createClass,
  DOUBLE,
  INT,
  type JavaType,
  LONG,
  type MethodInfo,
  type NativeMethod,
  type TypeVariable,
  VOID,
  type WildcardType,
} from './types';
import { charCodeOf, HashStore, JavaArray, JavaObject, type JavaString, toInt32, type Value } from './values';

/** The elements a stream yields, one at a time, as each stage pulls them from the stage before. */
type Source = () => Iterator<Value>;

const sources = new WeakMap<JavaObject, { source: Source; isUsed: boolean }>();

interface Context {
  registry: Registry;
  objectClass: ClassInfo;
  objectType: JavaType;
  stringType: JavaType;
  collections: Collections;
  wrappers: Wrappers;
  fn: (name: string) => ClassInfo;
}

const classType = (cls: ClassInfo, ...args: JavaType[]): ClassType => ({ kind: 'class', cls, args });
const superOf = (bound: JavaType): WildcardType => ({ kind: 'wildcard', bound, isSuper: true });
const extendsOf = (bound: JavaType): WildcardType => ({ kind: 'wildcard', bound, isSuper: false });
const typeVariable = (name: string, bound: JavaType): TypeVariable => ({ name, bounds: [bound] });
const variableType = (variable: TypeVariable): JavaType => ({ kind: 'typeVar', variable });

export function defineStreams(
  registry: Registry,
  objectClass: ClassInfo,
  stringType: JavaType,
  collections: Collections,
  wrappers: Wrappers,
  _functions: Functions
): void {
  const context: Context = {
    registry,
    objectClass,
    objectType: objectClass.type,
    stringType,
    collections,
    wrappers,
    fn: (name) => registry.classes.get(name) as ClassInfo,
  };
  const optional = defineOptionals(context);
  const collector = defineCollectors(context);
  const streams = defineStreamTypes(context, optional, collector);
  defineSources(context, streams);
}

interface Optionals {
  optional: ClassInfo;
  optionalInt: ClassInfo;
  optionalDouble: ClassInfo;
}

const optionalValues = new WeakMap<JavaObject, { isPresent: boolean; value: Value }>();

function createOptional(frame: Frame, cls: ClassInfo, value: Value, isPresent = value !== undefined): JavaObject {
  const object = frame.runtime.allocateObject(frame, cls);
  optionalValues.set(object, { isPresent, value });
  return object;
}

function stateOf(receiver: Value): { isPresent: boolean; value: Value } {
  return optionalValues.get(receiver as JavaObject) as { isPresent: boolean; value: Value };
}

function get(frame: Frame, receiver: Value): Value {
  const state = stateOf(receiver);
  if (!state.isPresent) throwBuiltin(frame, 'NoSuchElementException', 'No value present');
  return state.value;
}

function defineOptionals(context: Context): Optionals {
  const { registry, objectType, stringType } = context;
  const optional = registry.define('Optional', context.objectClass, 'java.util');
  optional.isFinal = true;
  const t = typeVariable('T', objectType);
  optional.typeParameters = [t];
  const tType = variableType(t);
  const generic = (
    name: string,
    parameters: (u: JavaType) => JavaType[],
    result: (u: JavaType) => JavaType,
    native: NativeMethod
  ): void => {
    const u = typeVariable('T', objectType);
    const method = addMethod(optional, name, parameters(variableType(u)), result(variableType(u)), true, native);
    method.typeParameters = [u];
  };
  generic(
    'of',
    (u) => [u],
    (u) => classType(optional, u),
    (frame, _, [value]) => {
      if (value === undefined) throwBuiltin(frame, 'NullPointerException');
      return createOptional(frame, optional, value);
    }
  );
  generic(
    'ofNullable',
    (u) => [u],
    (u) => classType(optional, u),
    (frame, _, [value]) => createOptional(frame, optional, value)
  );
  generic(
    'empty',
    () => [],
    (u) => classType(optional, u),
    (frame) => createOptional(frame, optional, undefined)
  );
  for (const [cls, name, valueType, getter] of [
    [optional, 'Optional', tType, 'get'],
    [registry.define('OptionalInt', context.objectClass, 'java.util'), 'OptionalInt', INT, 'getAsInt'],
    [registry.define('OptionalDouble', context.objectClass, 'java.util'), 'OptionalDouble', DOUBLE, 'getAsDouble'],
  ] as const) {
    cls.isFinal = true;
    addMethod(cls, getter, [], valueType, false, (frame, receiver) => get(frame, receiver));
    addMethod(cls, 'orElseThrow', [], valueType, false, (frame, receiver) => get(frame, receiver));
    addMethod(cls, 'isPresent', [], BOOLEAN, false, (_, receiver) => stateOf(receiver).isPresent);
    addMethod(cls, 'isEmpty', [], BOOLEAN, false, (_, receiver) => !stateOf(receiver).isPresent);
    addMethod(cls, 'orElse', [valueType], valueType, false, (_, receiver, [other]) =>
      stateOf(receiver).isPresent ? stateOf(receiver).value : other
    );
    addMethod(cls, 'toString', [], stringType, false, (frame, receiver) => {
      const state = stateOf(receiver);
      return newString(
        frame,
        state.isPresent ? `${name}[${stringify(frame, state.value, valueType)}]` : `${name}.empty`
      );
    });
    addMethod(cls, 'equals', [objectType], BOOLEAN, false, (frame, receiver, [other]) => {
      if (!(other instanceof JavaObject) || other.cls !== cls) return false;
      const [a, b] = [stateOf(receiver), stateOf(other)];
      return a.isPresent === b.isPresent && (Object.is(a.value, b.value) || javaEquals(frame, a.value, b.value));
    });
  }
  const consumer = context.fn('Consumer');
  addMethod(optional, 'ifPresent', [classType(consumer, superOf(tType))], VOID, false, (frame, receiver, [action]) => {
    const state = stateOf(receiver);
    if (state.isPresent) callFunction(frame, consumer, action, [state.value]);
  });
  const fn = context.fn('Function');
  const u = typeVariable('U', objectType);
  const map = addMethod(
    optional,
    'map',
    [classType(fn, superOf(tType), extendsOf(variableType(u)))],
    classType(optional, variableType(u)),
    false,
    (frame, receiver, [mapper]) => {
      const state = stateOf(receiver);
      return state.isPresent
        ? createOptional(frame, optional, callFunction(frame, fn, mapper, [state.value]))
        : receiver;
    }
  );
  map.typeParameters = [u];
  return {
    optional,
    optionalInt: registry.classes.get('OptionalInt') as ClassInfo,
    optionalDouble: registry.classes.get('OptionalDouble') as ClassInfo,
  };
}

/** What a collector does: create a container, add each element to it, and turn it into the result. */
interface CollectorFunctions {
  supply: (frame: Frame) => unknown;
  accumulate: (frame: Frame, container: unknown, value: Value) => void;
  finish: (frame: Frame, container: unknown) => Value;
}

const collectors = new WeakMap<JavaObject, CollectorFunctions>();

function defineCollectors(context: Context): ClassInfo {
  const { registry, objectType, collections } = context;
  const collector = defineInterface(registry, 'Collector', 'java.util.stream');
  const [ct, ca, cr] = ['T', 'A', 'R'].map((name) => typeVariable(name, objectType));
  collector.typeParameters = [ct, ca, cr];
  const impl = createClass('CollectorImpl', context.objectClass, true);
  impl.interfaces = [collector];
  impl.supertypes.push(collector.type as ClassType);
  const collectorsClass = registry.define('Collectors', context.objectClass, 'java.util.stream');
  const create = (frame: Frame, functions: CollectorFunctions): JavaObject => {
    const object = frame.runtime.allocateObject(frame, impl);
    collectors.set(object, functions);
    return object;
  };
  const listOf = (element: JavaType): ClassType => classType(collections.listClass, element);
  const generic = (
    name: string,
    parameters: (t: JavaType) => JavaType[],
    result: (t: JavaType) => JavaType,
    native: NativeMethod
  ): void => {
    const t = typeVariable('T', objectType);
    const method = addMethod(collectorsClass, name, parameters(variableType(t)), result(variableType(t)), true, native);
    method.typeParameters = [t];
  };
  const wildcard: WildcardType = { kind: 'wildcard', bound: undefined, isSuper: false };
  const arrayList = registry.classes.get('ArrayList') as ClassInfo;
  const hashSet = registry.classes.get('HashSet') as ClassInfo;
  const newList = (frame: Frame, items: Value[]): JavaObject => {
    frame.runtime.allocateArray(frame, items.length);
    const list = frame.runtime.allocateObject(frame, arrayList);
    list.elements = items;
    list.modCount = 0;
    return list;
  };
  generic(
    'toList',
    () => [],
    (t) => classType(collector, t, wildcard, listOf(t)),
    (frame) =>
      create(frame, {
        supply: () => [] as Value[],
        accumulate: (_, container, value) => void (container as Value[]).push(value),
        finish: (finishFrame, container) => newList(finishFrame, container as Value[]),
      })
  );
  generic(
    'toSet',
    () => [],
    (t) => classType(collector, t, wildcard, classType(registry.classes.get('Set') as ClassInfo, t)),
    (frame) =>
      create(frame, {
        supply: () => [] as Value[],
        accumulate: (_, container, value) => void (container as Value[]).push(value),
        finish: (finishFrame, container) => {
          const set = finishFrame.runtime.allocateObject(finishFrame, hashSet);
          set.store = new HashStore();
          set.modCount = 0;
          for (const value of container as Value[]) {
            const hash = javaHash(finishFrame, value);
            if (!set.store.entries.some((entry) => entry.hash === hash && javaEquals(finishFrame, value, entry.key))) {
              set.store.add({ key: value, value: undefined, hash });
            }
          }
          return set;
        },
      })
  );
  const charSequence = context.stringType;
  for (const parameters of [[], [charSequence]]) {
    addMethod(
      collectorsClass,
      'joining',
      parameters,
      classType(collector, charSequence, wildcard, context.stringType),
      true,
      (frame, _, [separator]) =>
        create(frame, {
          supply: () => [] as string[],
          accumulate: (accumulateFrame, container, value) =>
            void (container as string[]).push(stringify(accumulateFrame, value, context.objectType)),
          finish: (finishFrame, container) =>
            newString(finishFrame, (container as string[]).join((separator as JavaString | undefined)?.value ?? '')),
        })
    );
  }
  generic(
    'counting',
    () => [],
    (t) => classType(collector, t, wildcard, context.wrappers.byKind.get('long')?.type as JavaType),
    (frame) =>
      create(frame, {
        supply: () => ({ count: 0n }),
        accumulate: (_, container) => {
          (container as { count: bigint }).count++;
        },
        finish: (finishFrame, container) =>
          box(finishFrame, context.wrappers.byKind.get('long') as ClassInfo, (container as { count: bigint }).count),
      })
  );
  // groupingBy(classifier) collects each group into a list, keyed in a HashMap.
  const fn = context.fn('Function');
  const hashMap = registry.classes.get('HashMap') as ClassInfo;
  const t = typeVariable('T', objectType);
  const k = typeVariable('K', objectType);
  const groupingBy = addMethod(
    collectorsClass,
    'groupingBy',
    [classType(fn, superOf(variableType(t)), extendsOf(variableType(k)))],
    classType(
      collector,
      variableType(t),
      wildcard,
      classType(collections.mapClass, variableType(k), listOf(variableType(t)))
    ),
    true,
    (frame, _, [classifier]) =>
      create(frame, {
        supply: () => [] as { key: Value; items: Value[] }[],
        accumulate: (accumulateFrame, container, value) => {
          const key = callFunction(accumulateFrame, fn, classifier, [value]);
          const groups = container as { key: Value; items: Value[] }[];
          const group = groups.find((candidate) => javaEquals(accumulateFrame, candidate.key, key));
          if (group) group.items.push(value);
          else groups.push({ key, items: [value] });
        },
        finish: (finishFrame, container) => {
          const map = finishFrame.runtime.allocateObject(finishFrame, hashMap);
          map.store = new HashStore();
          map.modCount = 0;
          for (const { key, items } of container as { key: Value; items: Value[] }[]) {
            map.store.add({ key, value: newList(finishFrame, items), hash: javaHash(finishFrame, key) });
          }
          return map;
        },
      })
  );
  groupingBy.typeParameters = [t, k];
  return collector;
}

interface StreamTypes {
  stream: ClassInfo;
  intStream: ClassInfo;
  streamImpl: ClassInfo;
  intStreamImpl: ClassInfo;
}

function createStream(frame: Frame, cls: ClassInfo, source: Source): JavaObject {
  const object = frame.runtime.allocateObject(frame, cls);
  sources.set(object, { source, isUsed: false });
  return object;
}

/** Takes a stream's elements for its next stage, which Java allows only once per stream. */
function take(frame: Frame, receiver: Value): Iterator<Value> {
  const state = sources.get(receiver as JavaObject) as { source: Source; isUsed: boolean };
  if (state.isUsed) throwBuiltin(frame, 'IllegalStateException', 'stream has already been operated upon or closed');
  state.isUsed = true;
  return state.source();
}

function* iterate(iterator: Iterator<Value>): Generator<Value> {
  for (let next = iterator.next(); !next.done; next = iterator.next()) yield next.value;
}

/** Adds a stream operation as a default method of the interface, so that every stream object runs the same native. */
function op(
  cls: ClassInfo,
  name: string,
  parameterTypes: JavaType[],
  returnType: JavaType,
  native: NativeMethod,
  typeParameters?: TypeVariable[]
): MethodInfo {
  const method = addMethod(cls, name, parameterTypes, returnType, false, native);
  method.typeParameters = typeParameters;
  return method;
}

/** A stream whose elements `transform` derives from the elements of the stream `receiver`. */
function derive(
  cls: ClassInfo,
  receiver: Value,
  frame: Frame,
  transform: (items: Iterator<Value>) => Iterator<Value>
): JavaObject {
  const upstream = take(frame, receiver);
  return createStream(frame, cls, () => transform(upstream));
}

function defineStreamTypes(context: Context, optionals: Optionals, collector: ClassInfo): StreamTypes {
  const { registry, objectType, wrappers } = context;
  const stream = defineInterface(registry, 'Stream', 'java.util.stream');
  const intStream = defineInterface(registry, 'IntStream', 'java.util.stream');
  const t = typeVariable('T', objectType);
  stream.typeParameters = [t];
  const streamImpl = createClass('ReferencePipeline', context.objectClass, true);
  streamImpl.typeParameters = [typeVariable('T', objectType)];
  streamImpl.interfaces = [stream];
  streamImpl.supertypes.push(classType(stream, variableType(streamImpl.typeParameters[0])));
  const intStreamImpl = createClass('IntPipeline', context.objectClass, true);
  intStreamImpl.interfaces = [intStream];
  intStreamImpl.supertypes.push(intStream.type as ClassType);
  const types = { stream, intStream, streamImpl, intStreamImpl };
  const tType = variableType(t);
  for (const kind of [
    streamKind(context, optionals, { cls: stream, impl: streamImpl, element: tType, self: classType(stream, tType) }),
    streamKind(context, optionals, {
      cls: intStream,
      impl: intStreamImpl,
      element: INT,
      self: intStream.type as ClassType,
    }),
  ]) {
    defineIntermediateOperations(kind);
    defineTerminalOperations(kind);
  }
  defineReferenceOperations(context, types, tType, collector);
  defineIntStreamOperations(context, types, optionals, wrappers.byKind.get('int') as ClassInfo);
  return types;
}

/** What the operations that `Stream` and `IntStream` share differ in. */
interface StreamKind {
  cls: ClassInfo;
  impl: ClassInfo;
  isInt: boolean;
  self: ClassType;
  predicate: ClassInfo;
  predicateType: JavaType;
  consumer: ClassInfo;
  consumerType: JavaType;
  optionalClass: ClassInfo;
  optionalType: JavaType;
  comparator: ClassInfo;
  /** The parameters `max` and `min` take: a comparator, except for an `IntStream`, whose ints have an order. */
  orderParameters: JavaType[];
}

function streamKind(
  context: Context,
  optionals: Optionals,
  { cls, impl, element, self }: { cls: ClassInfo; impl: ClassInfo; element: JavaType; self: ClassType }
): StreamKind {
  const isInt = element === INT;
  const { fn } = context;
  const predicate = isInt ? fn('IntPredicate') : fn('Predicate');
  const consumer = isInt ? fn('IntConsumer') : fn('Consumer');
  const optionalClass = isInt ? optionals.optionalInt : optionals.optional;
  const comparator = fn('Comparator');
  return {
    cls,
    impl,
    isInt,
    self,
    predicate,
    predicateType: isInt ? predicate.type : classType(predicate, superOf(element)),
    consumer,
    consumerType: isInt ? consumer.type : classType(consumer, superOf(element)),
    optionalClass,
    optionalType: isInt ? optionalClass.type : classType(optionalClass, element),
    comparator,
    orderParameters: isInt ? [] : [classType(comparator, superOf(element))],
  };
}

/** The operations that make a stream from another: filtering, limiting, skipping, deduplicating, and sorting. */
function defineIntermediateOperations(kind: StreamKind): void {
  const { cls, impl, isInt, self, predicate } = kind;
  op(cls, 'filter', [kind.predicateType], self, (frame, receiver, [test]) =>
    derive(impl, receiver, frame, function* (items) {
      for (const value of iterate(items)) if (callFunction(frame, predicate, test, [value]) === true) yield value;
    })
  );
  op(cls, 'limit', [LONG], self, (frame, receiver, [count]) => {
    if ((count as bigint) < 0n) throwBuiltin(frame, 'IllegalArgumentException', String(count as bigint));
    return derive(impl, receiver, frame, (items) => limited(items, count as bigint));
  });
  op(cls, 'skip', [LONG], self, (frame, receiver, [count]) =>
    derive(impl, receiver, frame, function* (items) {
      let skipped = 0n;
      for (const value of iterate(items)) if (skipped++ >= (count as bigint)) yield value;
    })
  );
  op(cls, 'distinct', [], self, (frame, receiver) =>
    derive(impl, receiver, frame, (items) => distinct(items, (a, b) => (isInt ? a === b : javaEquals(frame, a, b))))
  );
  op(cls, 'sorted', [], self, (frame, receiver) =>
    derive(impl, receiver, frame, (items) =>
      [...iterate(items)]
        .toSorted((a, b) => (isInt ? (a as number) - (b as number) : compareNatural(frame, a, b)))
        [Symbol.iterator]()
    )
  );
  op(cls, 'peek', [kind.consumerType], self, (frame, receiver, [action]) =>
    derive(impl, receiver, frame, function* (items) {
      for (const value of iterate(items)) {
        callFunction(frame, kind.consumer, action, [value]);
        yield value;
      }
    })
  );
}

function* limited(items: Iterator<Value>, count: bigint): Generator<Value> {
  let taken = 0n;
  if (count === 0n) return;
  for (const value of iterate(items)) {
    yield value;
    if (++taken >= count) return;
  }
}

function* distinct(items: Iterator<Value>, equals: (a: Value, b: Value) => boolean): Generator<Value> {
  const seen: Value[] = [];
  for (const value of iterate(items)) {
    if (seen.some((other) => equals(other, value))) continue;
    seen.push(value);
    yield value;
  }
}

/** The operations that consume a stream: iterating, counting, matching, and finding elements. */
function defineTerminalOperations(kind: StreamKind): void {
  const { cls, predicate } = kind;
  op(cls, 'forEach', [kind.consumerType], VOID, (frame, receiver, [action]) => {
    for (const value of iterate(take(frame, receiver))) callFunction(frame, kind.consumer, action, [value]);
  });
  op(cls, 'count', [], LONG, (frame, receiver) => {
    let count = 0n;
    const items = take(frame, receiver);
    while (!items.next().done) count++;
    return count;
  });
  for (const [name, wanted, stopsAt] of [
    ['anyMatch', true, true],
    ['allMatch', false, false],
    ['noneMatch', true, false],
  ] as const) {
    op(cls, name, [kind.predicateType], BOOLEAN, (frame, receiver, [test]) => {
      for (const value of iterate(take(frame, receiver))) {
        if ((callFunction(frame, predicate, test, [value]) === true) === wanted) return stopsAt;
      }
      return !stopsAt;
    });
  }
  op(cls, 'findFirst', [], kind.optionalType, (frame, receiver) => {
    const next = take(frame, receiver).next();
    return createOptional(frame, kind.optionalClass, next.done ? undefined : next.value, !next.done);
  });
  op(cls, 'max', kind.orderParameters, kind.optionalType, (frame, receiver, [order]) =>
    extremeOf(frame, kind, receiver, order, 1)
  );
  op(cls, 'min', kind.orderParameters, kind.optionalType, (frame, receiver, [order]) =>
    extremeOf(frame, kind, receiver, order, -1)
  );
}

/** `max` (`sign` 1) or `min` (-1), which keep the first of equal elements. */
function extremeOf(frame: Frame, kind: StreamKind, receiver: Value, order: Value, sign: number): Value {
  let best: Value;
  let found = false;
  for (const value of iterate(take(frame, receiver))) {
    const difference = kind.isInt
      ? (value as number) - (best as number)
      : found
        ? (callFunction(frame, kind.comparator, order, [value, best]) as number)
        : 0;
    if (!found || difference * sign > 0) best = value;
    found = true;
  }
  return createOptional(frame, kind.optionalClass, best, found);
}

/** The operations only a `Stream` of objects has: mapping, sorting with a comparator, reducing, and collecting. */
function defineReferenceOperations(context: Context, types: StreamTypes, tType: JavaType, collector: ClassInfo): void {
  const { objectType, collections, fn } = context;
  const { stream, streamImpl, intStream, intStreamImpl } = types;
  const r = typeVariable('R', objectType);
  op(
    stream,
    'map',
    [classType(fn('Function'), superOf(tType), extendsOf(variableType(r)))],
    classType(stream, variableType(r)),
    (frame, receiver, [mapper]) =>
      derive(streamImpl, receiver, frame, (items) => mapped(frame, items, fn('Function'), mapper)),
    [r]
  );
  op(
    stream,
    'mapToInt',
    [classType(fn('ToIntFunction'), superOf(tType))],
    intStream.type,
    (frame, receiver, [mapper]) =>
      derive(intStreamImpl, receiver, frame, (items) => mapped(frame, items, fn('ToIntFunction'), mapper))
  );
  const comparator = fn('Comparator');
  op(stream, 'sorted', [classType(comparator, superOf(tType))], classType(stream, tType), (frame, receiver, [order]) =>
    derive(streamImpl, receiver, frame, (items) =>
      [...iterate(items)]
        .toSorted((a, b) => callFunction(frame, comparator, order, [a, b]) as number)
        [Symbol.iterator]()
    )
  );
  op(stream, 'toList', [], classType(collections.listClass, tType), (frame, receiver) => {
    const items = [...iterate(take(frame, receiver))];
    frame.runtime.allocateArray(frame, items.length);
    const list = frame.runtime.allocateObject(frame, collections.immutableList);
    list.elements = items;
    list.modCount = 0;
    return list;
  });
  const binary = fn('BinaryOperator');
  op(stream, 'reduce', [tType, classType(binary, tType)], tType, (frame, receiver, [identity, accumulator]) => {
    let result = identity;
    for (const value of iterate(take(frame, receiver)))
      result = callFunction(frame, binary, accumulator, [result, value]);
    return result;
  });
  const a = typeVariable('A', objectType);
  const rr = typeVariable('R', objectType);
  op(
    stream,
    'collect',
    [classType(collector, superOf(tType), variableType(a), variableType(rr))],
    variableType(rr),
    (frame, receiver, [target]) => {
      const functions = collectors.get(target as JavaObject);
      if (!functions) return throwBuiltin(frame, 'UnsupportedOperationException');
      const container = functions.supply(frame);
      for (const value of iterate(take(frame, receiver))) functions.accumulate(frame, container, value);
      return functions.finish(frame, container);
    },
    [rr, a]
  );
}

/** The elements that applying the function object `mapper` of `iface` gives. */
function* mapped(frame: Frame, items: Iterator<Value>, iface: ClassInfo, mapper: Value): Generator<Value> {
  for (const value of iterate(items)) yield callFunction(frame, iface, mapper, [value]);
}

function defineIntStreamOperations(
  context: Context,
  types: StreamTypes,
  optionals: Optionals,
  integerClass: ClassInfo
): void {
  const { intStream, intStreamImpl, streamImpl, stream } = types;
  const fn = context.fn;
  op(intStream, 'map', [fn('IntUnaryOperator').type], intStream.type, (frame, receiver, [mapper]) =>
    derive(intStreamImpl, receiver, frame, function* (items) {
      for (const value of iterate(items)) yield callFunction(frame, fn('IntUnaryOperator'), mapper, [value]);
    })
  );
  const r = typeVariable('R', context.objectType);
  op(
    intStream,
    'mapToObj',
    [classType(fn('IntFunction'), extendsOf(variableType(r)))],
    classType(stream, variableType(r)),
    (frame, receiver, [mapper]) =>
      derive(streamImpl, receiver, frame, function* (items) {
        for (const value of iterate(items)) yield callFunction(frame, fn('IntFunction'), mapper, [value]);
      }),
    [r]
  );
  op(intStream, 'boxed', [], classType(stream, integerClass.type), (frame, receiver) =>
    derive(streamImpl, receiver, frame, function* (items) {
      for (const value of iterate(items)) yield box(frame, integerClass, value);
    })
  );
  op(intStream, 'sum', [], INT, (frame, receiver) => {
    let sum = 0;
    for (const value of iterate(take(frame, receiver))) sum = toInt32(sum + (value as number));
    return sum;
  });
  op(intStream, 'average', [], optionals.optionalDouble.type, (frame, receiver) => {
    let sum = 0;
    let count = 0;
    for (const value of iterate(take(frame, receiver))) {
      sum += value as number;
      count++;
    }
    return createOptional(frame, optionals.optionalDouble, count === 0 ? undefined : sum / count, count > 0);
  });
  op(intStream, 'toArray', [], { kind: 'array', element: INT }, (frame, receiver) => {
    const values = [...iterate(take(frame, receiver))];
    frame.runtime.allocateArray(frame, values.length);
    return new JavaArray(INT, values);
  });
  op(intStream, 'reduce', [INT, fn('IntBinaryOperator').type], INT, (frame, receiver, [identity, accumulator]) => {
    let result = identity;
    for (const value of iterate(take(frame, receiver)))
      result = callFunction(frame, fn('IntBinaryOperator'), accumulator, [result, value]);
    return result;
  });
}

function defineSources(context: Context, streams: StreamTypes): void {
  const { registry, objectType, collections } = context;
  const { stream, intStream, streamImpl, intStreamImpl } = streams;
  const [collectionE] = collections.collectionClass.typeParameters;
  addMethod(
    collections.collectionClass,
    'stream',
    [],
    classType(stream, variableType(collectionE)),
    false,
    (frame, receiver) => {
      const items = itemsOf(frame, receiver);
      return createStream(frame, streamImpl, () => [...items][Symbol.iterator]());
    }
  );
  addMethod(registry.classes.get('String') as ClassInfo, 'chars', [], intStream.type, false, (frame, receiver) => {
    const text = (receiver as JavaString).value;
    return createStream(frame, intStreamImpl, function* () {
      for (let index = 0; index < text.length; index++) yield charCodeOf(text, index);
    });
  });
  const ofVariable = typeVariable('T', objectType);
  const of = addMethod(
    stream,
    'of',
    [{ kind: 'array', element: variableType(ofVariable) }],
    classType(stream, variableType(ofVariable)),
    true,
    (frame, _, [array]) => {
      const values = (array as JavaArray).values;
      return createStream(frame, streamImpl, () => values[Symbol.iterator]());
    }
  );
  of.typeParameters = [ofVariable];
  of.isVarargs = true;
  for (const [name, isClosed] of [
    ['range', false],
    ['rangeClosed', true],
  ] as const) {
    addMethod(intStream, name, [INT, INT], intStream.type, true, (frame, _, [start, end]) =>
      createStream(frame, intStreamImpl, function* () {
        const last = (end as number) - (isClosed ? 0 : 1);
        for (let value = start as number; value <= last; value++) {
          frame.runtime.spend();
          yield value;
        }
      })
    );
  }
  const intOf = addMethod(
    intStream,
    'of',
    [{ kind: 'array', element: INT }],
    intStream.type,
    true,
    (frame, _, [array]) => {
      const values = (array as JavaArray).values;
      return createStream(frame, intStreamImpl, () => values[Symbol.iterator]());
    }
  );
  intOf.isVarargs = true;
  const arraysClass = registry.classes.get('Arrays') as ClassInfo;
  addMethod(arraysClass, 'stream', [{ kind: 'array', element: INT }], intStream.type, true, (frame, _, [array]) => {
    if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
    return createStream(frame, intStreamImpl, () => [...array.values][Symbol.iterator]());
  });
  const arrayVariable = typeVariable('T', objectType);
  const arrayStream = addMethod(
    arraysClass,
    'stream',
    [{ kind: 'array', element: variableType(arrayVariable) }],
    classType(stream, variableType(arrayVariable)),
    true,
    (frame, _, [array]) => {
      if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
      return createStream(frame, streamImpl, () => [...array.values][Symbol.iterator]());
    }
  );
  arrayStream.typeParameters = [arrayVariable];
}
