import { fitsElement, runtimeClassNameOf } from './builtinClass';
import { type Collections, compareNatural, itemsOf, javaEquals } from './builtinCollections';
import { sortedValues } from './builtinCollectionSupport';
import { type CollectorFunctions, collectors, defineCollectors } from './builtinCollectors';
import { callFunction, type Functions } from './builtinFunctions';
import { createOptional, defineOptionals, type Optionals, stateOf as optionalState } from './builtinOptionals';
import {
  classType,
  closeStream,
  type Context,
  countOf,
  createStream,
  derive,
  extendsOf,
  iterate,
  op,
  superOf,
  take,
  typeVariable,
  variableType,
} from './builtinStreamSupport';
import { addMethod, defineInterface, newString, type Registry } from './builtinSupport';
import { box, type Wrappers } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, type ClassInfo, type ClassType, createClass, INT, type JavaType, LONG, VOID } from './types';
import { charCodeOf, JavaArray, type JavaObject, type JavaString, toInt32, type Value } from './values';

export function defineStreams(
  registry: Registry,
  objectClass: ClassInfo,
  stringType: JavaType,
  collections: Collections,
  wrappers: Wrappers,
  _functions: Functions
): { stream: ClassInfo; streamImpl: ClassInfo } {
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
  defineStringStreams(context, streams);
  defineGeneratedStreams(context, streams);
  return { stream: streams.stream, streamImpl: streams.streamImpl };
}

interface StreamTypes {
  stream: ClassInfo;
  intStream: ClassInfo;
  streamImpl: ClassInfo;
  intStreamImpl: ClassInfo;
}

/**
 * Makes streams `AutoCloseable`, as `BaseStream` is, so that streams of files close in try-with-resources. Closing
 * one ends its use, as Java's does, though its sources hold no resources.
 */
function defineClosing(context: Context, streams: ClassInfo[]): void {
  const autoCloseable = context.fn('AutoCloseable');
  for (const stream of streams) {
    stream.interfaces.push(autoCloseable);
    stream.supertypes.push(autoCloseable.type as ClassType);
    addMethod(stream, 'close', [], VOID, false, (_, receiver) => {
      closeStream(receiver);
    });
  }
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
  defineClosing(context, [stream, intStream]);
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
  /** The function that combines two elements, as `reduce` takes it. */
  binary: ClassInfo;
  binaryType: JavaType;
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
  const binary = isInt ? fn('IntBinaryOperator') : fn('BinaryOperator');
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
    binary,
    binaryType: isInt ? binary.type : classType(binary, element),
    orderParameters: isInt ? [] : [classType(comparator, superOf(element))],
  };
}

/** The operations that make a stream from another: filtering, limiting, skipping, deduplicating, and sorting. */
function defineIntermediateOperations(kind: StreamKind): void {
  const { cls, impl, isInt, self, predicate } = kind;
  const test = (frame: Frame, function_: Value) => (value: Value) =>
    callFunction(frame, predicate, function_, [value]) === true;
  op(cls, 'filter', [kind.predicateType], self, (frame, receiver, [function_]) =>
    derive(impl, receiver, frame, (items) => filtered(items, test(frame, function_)))
  );
  op(cls, 'takeWhile', [kind.predicateType], self, (frame, receiver, [function_]) =>
    derive(impl, receiver, frame, (items) => takenWhile(items, test(frame, function_)))
  );
  op(cls, 'dropWhile', [kind.predicateType], self, (frame, receiver, [function_]) =>
    derive(impl, receiver, frame, (items) => droppedWhile(items, test(frame, function_)))
  );
  op(cls, 'limit', [LONG], self, (frame, receiver, [count]) => {
    const n = sliceCount(frame, count);
    return derive(
      impl,
      receiver,
      frame,
      (items) => limited(items, n),
      (size) => minOf(size, n)
    );
  });
  op(cls, 'skip', [LONG], self, (frame, receiver, [count]) => {
    const n = sliceCount(frame, count);
    return derive(
      impl,
      receiver,
      frame,
      (items) => skipped(items, n),
      (size) => (size > n ? size - n : 0n)
    );
  });
  op(cls, 'distinct', [], self, (frame, receiver) =>
    derive(impl, receiver, frame, (items) => distinct(items, (a, b) => (isInt ? a === b : javaEquals(frame, a, b))))
  );
  const natural = (frame: Frame) => (a: Value, b: Value) =>
    isInt ? (a as number) - (b as number) : compareNatural(frame, a, b);
  op(cls, 'sorted', [], self, (frame, receiver) =>
    derive(impl, receiver, frame, (items) => sortedValues([...iterate(items)], natural(frame))[Symbol.iterator](), true)
  );
  op(cls, 'peek', [kind.consumerType], self, (frame, receiver, [action]) =>
    derive(
      impl,
      receiver,
      frame,
      (items) => peeked(items, (value) => callFunction(frame, kind.consumer, action, [value])),
      true
    )
  );
}

/** The count `limit` or `skip` takes, which must not be negative. */
function sliceCount(frame: Frame, count: Value): bigint {
  if ((count as bigint) < 0n) throwBuiltin(frame, 'IllegalArgumentException', String(count as bigint));
  return count as bigint;
}

function minOf(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function* filtered(items: Iterator<Value>, test: (value: Value) => boolean): Generator<Value> {
  for (const value of iterate(items)) if (test(value)) yield value;
}

function* takenWhile(items: Iterator<Value>, test: (value: Value) => boolean): Generator<Value> {
  for (const value of iterate(items)) {
    if (!test(value)) return;
    yield value;
  }
}

function* droppedWhile(items: Iterator<Value>, test: (value: Value) => boolean): Generator<Value> {
  let isDropping = true;
  for (const value of iterate(items)) {
    if (isDropping) isDropping = test(value);
    if (!isDropping) yield value;
  }
}

function* skipped(items: Iterator<Value>, count: bigint): Generator<Value> {
  let passed = 0n;
  for (const value of iterate(items)) if (passed++ >= count) yield value;
}

function* peeked(items: Iterator<Value>, action: (value: Value) => void): Generator<Value> {
  for (const value of iterate(items)) {
    action(value);
    yield value;
  }
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
  op(cls, 'count', [], LONG, (frame, receiver) => countOf(frame, receiver));
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
  op(cls, 'reduce', [kind.binaryType], kind.optionalType, (frame, receiver, [accumulator]) =>
    reduceToOptional(frame, kind, receiver, accumulator)
  );
  // A sequential stream finds its first element for findAny too.
  for (const name of ['findFirst', 'findAny']) {
    op(cls, name, [], kind.optionalType, (frame, receiver) => {
      const next = take(frame, receiver).next();
      return createOptional(frame, kind.optionalClass, next.done ? undefined : next.value, !next.done);
    });
  }
  op(cls, 'max', kind.orderParameters, kind.optionalType, (frame, receiver, [order]) =>
    extremeOf(frame, kind, receiver, order, 1)
  );
  op(cls, 'min', kind.orderParameters, kind.optionalType, (frame, receiver, [order]) =>
    extremeOf(frame, kind, receiver, order, -1)
  );
}

/** `reduce` without an identity, which gives an empty optional for an empty stream. */
function reduceToOptional(frame: Frame, kind: StreamKind, receiver: Value, accumulator: Value): Value {
  let result: Value;
  let found = false;
  for (const value of iterate(take(frame, receiver))) {
    result = found ? callFunction(frame, kind.binary, accumulator, [result, value]) : value;
    found = true;
  }
  return createOptional(frame, kind.optionalClass, result, found);
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
// code-gauge-allow functionNcss 33 -- One registration per builtin method, each a small native.
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
      derive(streamImpl, receiver, frame, (items) => mapped(frame, items, fn('Function'), mapper), true),
    [r]
  );
  defineFlatMap(context, types, tType);
  defineToArray(context, stream);
  op(
    stream,
    'mapToInt',
    [classType(fn('ToIntFunction'), superOf(tType))],
    intStream.type,
    (frame, receiver, [mapper]) =>
      derive(intStreamImpl, receiver, frame, (items) => mapped(frame, items, fn('ToIntFunction'), mapper), true)
  );
  const comparator = fn('Comparator');
  op(stream, 'sorted', [classType(comparator, superOf(tType))], classType(stream, tType), (frame, receiver, [order]) =>
    derive(
      streamImpl,
      receiver,
      frame,
      (items) =>
        sortedValues([...iterate(items)], (a, b) => callFunction(frame, comparator, order, [a, b]) as number)[
          Symbol.iterator
        ](),
      true
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
      // A consumed stream fails before the collector supplies its container.
      return collectAll(frame, functions, iterate(take(frame, receiver)));
    },
    [rr, a]
  );
}

function collectAll(frame: Frame, functions: CollectorFunctions, values: Iterable<Value>): Value {
  const container = functions.supply(frame);
  for (const value of values) functions.accumulate(frame, container, value);
  return functions.finish(frame, container);
}

/** `toArray()`, which gives an `Object[]`, and `toArray(generator)`, which fills the array the generator makes. */
function defineToArray(context: Context, stream: ClassInfo): void {
  const { objectType, fn } = context;
  op(stream, 'toArray', [], { kind: 'array', element: objectType }, (frame, receiver) => {
    const values = [...iterate(take(frame, receiver))];
    frame.runtime.allocateArray(frame, values.length);
    return new JavaArray(objectType, values);
  });
  const a = typeVariable('A', objectType);
  const arrayType: JavaType = { kind: 'array', element: variableType(a) };
  op(
    stream,
    'toArray',
    [classType(fn('IntFunction'), arrayType)],
    arrayType,
    (frame, receiver, [generator]) => {
      const values = [...iterate(take(frame, receiver))];
      const array = callFunction(frame, fn('IntFunction'), generator, [values.length]);
      if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
      if (array.values.length < values.length) throwBuiltin(frame, 'IllegalStateException');
      for (const [index, value] of values.entries()) {
        if (!fitsElement(frame, array.elementType, value)) {
          throwBuiltin(frame, 'ArrayStoreException', runtimeClassNameOf(frame, value));
        }
        array.values[index] = value;
      }
      return array;
    },
    [a]
  );
}

/** `flatMap`, which replaces each element with the elements of the stream the mapper returns for it. */
function defineFlatMap(context: Context, types: StreamTypes, tType: JavaType): void {
  const { stream, streamImpl } = types;
  const fn = context.fn('Function');
  const r = typeVariable('R', context.objectType);
  const mapperType = classType(fn, superOf(tType), extendsOf(classType(stream, extendsOf(variableType(r)))));
  op(
    stream,
    'flatMap',
    [mapperType],
    classType(stream, variableType(r)),
    (frame, receiver, [mapper]) =>
      derive(streamImpl, receiver, frame, function* (items) {
        for (const value of iterate(items)) {
          const inner = callFunction(frame, fn, mapper, [value]);
          if (inner !== undefined) yield* iterate(take(frame, inner));
        }
      }),
    [r]
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
    derive(intStreamImpl, receiver, frame, (items) => mapped(frame, items, fn('IntUnaryOperator'), mapper), true)
  );
  const r = typeVariable('R', context.objectType);
  op(
    intStream,
    'mapToObj',
    [classType(fn('IntFunction'), extendsOf(variableType(r)))],
    classType(stream, variableType(r)),
    (frame, receiver, [mapper]) =>
      derive(streamImpl, receiver, frame, (items) => mapped(frame, items, fn('IntFunction'), mapper), true),
    [r]
  );
  op(intStream, 'boxed', [], classType(stream, integerClass.type), (frame, receiver) =>
    derive(
      streamImpl,
      receiver,
      frame,
      function* (items) {
        for (const value of iterate(items)) yield box(frame, integerClass, value);
      },
      true
    )
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

/**
 * The stream `iterate` makes: the seed, then each value `next` gives for the last, while `hasNext` holds when the
 * bounded form gives one, whose function, as `next`, must not be null.
 */
function iteratedStream(
  frame: Frame,
  context: Context,
  streams: StreamTypes,
  { seed, next, hasNext, isInt }: { seed: Value; next: Value; hasNext?: { test: Value }; isInt: boolean }
): JavaObject {
  const { fn } = context;
  const [step, test] = isInt ? [fn('IntUnaryOperator'), fn('IntPredicate')] : [fn('UnaryOperator'), fn('Predicate')];
  if (next === undefined || (hasNext && hasNext.test === undefined)) throwBuiltin(frame, 'NullPointerException');
  return createStream(
    frame,
    isInt ? streams.intStreamImpl : streams.streamImpl,
    function* () {
      for (let value = seed; ; value = callFunction(frame, step, next, [value])) {
        if (hasNext && callFunction(frame, test, hasNext.test, [value]) !== true) return;
        yield value;
      }
    },
    [seed, next, hasNext?.test]
  );
}

/** `Stream.iterate` and `Stream.generate`, whose streams compute each element when it is pulled. */
function defineGeneratedStreams(context: Context, streams: StreamTypes): void {
  const { objectType, fn } = context;
  const unary = fn('UnaryOperator');
  const predicate = fn('Predicate');
  const supplier = fn('Supplier');
  const iterateVariable = typeVariable('T', objectType);
  const tType = variableType(iterateVariable);
  const iterated = (frame: Frame, seed: Value, next: Value, hasNext?: { test: Value }, isInt = false): JavaObject =>
    iteratedStream(frame, context, streams, { seed, next, hasNext, isInt });

  addMethod(
    streams.intStream,
    'iterate',
    [INT, fn('IntUnaryOperator').type],
    streams.intStream.type,
    true,
    (frame, _, [seed, next]) => iterated(frame, seed, next, undefined, true)
  );
  addMethod(
    streams.intStream,
    'iterate',
    [INT, fn('IntPredicate').type, fn('IntUnaryOperator').type],
    streams.intStream.type,
    true,
    (frame, _, [seed, hasNext, next]) => iterated(frame, seed, next, { test: hasNext }, true)
  );
  const streamOfT = classType(streams.stream, tType);
  const unbounded = addMethod(
    streams.stream,
    'iterate',
    [tType, classType(unary, tType)],
    streamOfT,
    true,
    (frame, _, [seed, next]) => iterated(frame, seed, next)
  );
  const bounded = addMethod(
    streams.stream,
    'iterate',
    [tType, classType(predicate, superOf(tType)), classType(unary, tType)],
    streamOfT,
    true,
    (frame, _, [seed, hasNext, next]) => iterated(frame, seed, next, { test: hasNext })
  );
  unbounded.typeParameters = [iterateVariable];
  bounded.typeParameters = [iterateVariable];
  const variable = typeVariable('T', objectType);
  const generate = addMethod(
    streams.stream,
    'generate',
    [classType(supplier, extendsOf(variableType(variable)))],
    classType(streams.stream, variableType(variable)),
    true,
    (frame, _, [source]) =>
      source === undefined
        ? throwBuiltin(frame, 'NullPointerException')
        : createStream(
            frame,
            streams.streamImpl,
            function* () {
              for (;;) yield callFunction(frame, supplier, source, []);
            },
            [source]
          )
  );
  generate.typeParameters = [variable];
}

/** `String.chars` and `String.lines`, which stream a string's characters and lines. */
function defineStringStreams(context: Context, streams: StreamTypes): void {
  const stringClass = context.registry.classes.get('String') as ClassInfo;
  addMethod(stringClass, 'chars', [], streams.intStream.type, false, (frame, receiver) => {
    const text = (receiver as JavaString).value;
    return createStream(
      frame,
      streams.intStreamImpl,
      function* () {
        for (let index = 0; index < text.length; index++) yield charCodeOf(text, index);
      },
      [],
      () => BigInt(text.length)
    );
  });
  addMethod(stringClass, 'lines', [], classType(streams.stream, stringClass.type), false, (frame, receiver) => {
    const text = (receiver as JavaString).value;
    frame.runtime.scanString(text.length);
    const lines = text === '' ? [] : text.replace(/(?:\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/);
    return createStream(frame, streams.streamImpl, function* () {
      for (const line of lines) yield newString(frame, line);
    });
  });
}

/** `Optional.stream`, a stream of the value if there is one. */
function defineOptionalStream(context: Context, { stream, streamImpl }: StreamTypes): void {
  const optional = context.registry.classes.get('Optional') as ClassInfo;
  const [optionalT] = optional.typeParameters;
  addMethod(optional, 'stream', [], classType(stream, variableType(optionalT)), false, (frame, receiver) => {
    const { isPresent, value } = optionalState(receiver);
    const values = isPresent ? [value] : [];
    return createStream(
      frame,
      streamImpl,
      () => values[Symbol.iterator](),
      [receiver],
      () => BigInt(values.length)
    );
  });
}

// code-gauge-allow functionCognitiveComplexity 21 -- One registration per stream source, each a small native.
// code-gauge-allow functionNcss 39 -- One registration per builtin method, each a small native.
function defineSources(context: Context, streams: StreamTypes): void {
  const { registry, objectType, collections } = context;
  const { stream, intStream, streamImpl, intStreamImpl } = streams;
  defineOptionalStream(context, streams);
  const [collectionE] = collections.collectionClass.typeParameters;
  addMethod(
    collections.collectionClass,
    'stream',
    [],
    classType(stream, variableType(collectionE)),
    false,
    (frame, receiver) => {
      // The elements are read when the stream is consumed, so that changes made before then show, as in Java.
      return createStream(
        frame,
        streamImpl,
        () => [...itemsOf(frame, receiver)][Symbol.iterator](),
        [receiver],
        () => BigInt(itemsOf(frame, receiver).length)
      );
    }
  );
  const ofVariable = typeVariable('T', objectType);
  const of = addMethod(
    stream,
    'of',
    [{ kind: 'array', element: variableType(ofVariable) }],
    classType(stream, variableType(ofVariable)),
    true,
    (frame, _, [array]) => {
      if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
      const { values } = array;
      return createStream(
        frame,
        streamImpl,
        () => values[Symbol.iterator](),
        [array],
        () => BigInt(values.length)
      );
    }
  );
  of.typeParameters = [ofVariable];
  of.isVarargs = true;
  for (const [name, isClosed] of [
    ['range', false],
    ['rangeClosed', true],
  ] as const) {
    addMethod(intStream, name, [INT, INT], intStream.type, true, (frame, _, [start, end]) =>
      createStream(
        frame,
        intStreamImpl,
        function* () {
          const last = (end as number) - (isClosed ? 0 : 1);
          for (let value = start as number; value <= last; value++) {
            frame.runtime.spend();
            yield value;
          }
        },
        [],
        () => BigInt(Math.max(0, (end as number) - (start as number) + (isClosed ? 1 : 0)))
      )
    );
  }
  const intOf = addMethod(
    intStream,
    'of',
    [{ kind: 'array', element: INT }],
    intStream.type,
    true,
    (frame, _, [array]) => {
      if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
      const { values } = array;
      return createStream(
        frame,
        intStreamImpl,
        () => values[Symbol.iterator](),
        [],
        () => BigInt(values.length)
      );
    }
  );
  intOf.isVarargs = true;
  const arraysClass = registry.classes.get('Arrays') as ClassInfo;
  addMethod(arraysClass, 'stream', [{ kind: 'array', element: INT }], intStream.type, true, (frame, _, [array]) => {
    if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
    return createStream(
      frame,
      intStreamImpl,
      () => [...array.values][Symbol.iterator](),
      [],
      () => BigInt(array.values.length)
    );
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
      return createStream(
        frame,
        streamImpl,
        () => [...array.values][Symbol.iterator](),
        [array],
        () => BigInt(array.values.length)
      );
    }
  );
  arrayStream.typeParameters = [arrayVariable];
}
