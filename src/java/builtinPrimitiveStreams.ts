import { addWithCompensation, compensatedSum, type NumericSum } from './builtinDownstreamCollectors';
import { callFunction } from './builtinFunctions';
import { createOptional, type Optionals } from './builtinOptionals';
import { mapped, type StreamTypes } from './builtinStreams';
import {
  classType,
  type Context,
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
import { addMethod } from './builtinSupport';
import { box } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import { type ClassInfo, DOUBLE, type JavaType, LONG } from './types';
import { JavaArray, type Value } from './values';

/** What the operations of `LongStream` and `DoubleStream` differ in. */
interface PrimitiveStream {
  /** The prefix of the stream's functional interfaces, as in `LongUnaryOperator`. */
  name: 'Long' | 'Double';
  element: JavaType;
  cls: ClassInfo;
  impl: ClassInfo;
  /** `sum`, which wraps around for longs and compensates for rounding for doubles, as the JDK's do. */
  sum: (values: Iterable<Value>) => Value;
  average: (values: Iterable<Value>) => number | undefined;
  /** An `int` of `IntStream.asLongStream` or `asDoubleStream` as an element of this stream. */
  fromInt: (value: number) => Value;
}

/**
 * The operations only `LongStream` and `DoubleStream` have, the operations of other streams that give one, and their
 * sources: `of`, `empty`, `Arrays.stream` of an array, and `LongStream.range`.
 */
export function definePrimitiveStreamOperations(context: Context, types: StreamTypes, optionals: Optionals): void {
  const streams: PrimitiveStream[] = [
    {
      name: 'Long',
      element: LONG,
      cls: types.longStream,
      impl: types.longStreamImpl,
      sum: (values) => longSum(values),
      average: (values) => {
        const count = [...values].length;
        return count === 0 ? undefined : Number(longSum(values)) / count;
      },
      fromInt: BigInt,
    },
    {
      name: 'Double',
      element: DOUBLE,
      cls: types.doubleStream,
      impl: types.doubleStreamImpl,
      sum: (values) => compensatedSum(doubleSum(values)),
      average: (values) => {
        const state = doubleSum(values);
        return state.count === 0 ? undefined : compensatedSum(state) / state.count;
      },
      fromInt: (value) => value,
    },
  ];
  for (const primitive of streams) {
    definePrimitiveOperations(context, types, optionals, primitive);
    defineConversions(context, types, primitive);
    defineArraySources(context, primitive);
  }
  defineLongRanges(types.longStream, types.longStreamImpl);
}

function definePrimitiveOperations(
  context: Context,
  types: StreamTypes,
  optionals: Optionals,
  { name, element, cls, impl, sum, average }: PrimitiveStream
): void {
  const { fn } = context;
  const wrapper = context.wrappers.byKind.get(name === 'Long' ? 'long' : 'double') as ClassInfo;
  op(cls, 'map', [fn(`${name}UnaryOperator`).type], cls.type, mapTo(context, impl, `${name}UnaryOperator`));
  op(
    cls,
    'mapToInt',
    [fn(`${name}ToIntFunction`).type],
    types.intStream.type,
    mapTo(context, types.intStreamImpl, `${name}ToIntFunction`)
  );
  const r = typeVariable('R', context.objectType);
  op(
    cls,
    'mapToObj',
    [classType(fn(`${name}Function`), extendsOf(variableType(r)))],
    classType(types.stream, variableType(r)),
    mapTo(context, types.streamImpl, `${name}Function`),
    [r]
  );
  op(cls, 'boxed', [], classType(types.stream, wrapper.type), (frame, receiver) =>
    derive(
      types.streamImpl,
      receiver,
      frame,
      function* (items) {
        for (const value of iterate(items)) yield box(frame, wrapper, value);
      },
      true
    )
  );
  op(cls, 'sum', [], element, (frame, receiver) => sum(iterate(take(frame, receiver))));
  op(cls, 'average', [], optionals.optionalDouble.type, (frame, receiver) => {
    const result = average([...iterate(take(frame, receiver))]);
    return createOptional(frame, optionals.optionalDouble, result, result !== undefined);
  });
  op(cls, 'toArray', [], { kind: 'array', element }, (frame, receiver) => {
    const values = [...iterate(take(frame, receiver))];
    frame.runtime.allocateArray(frame, values.length);
    return new JavaArray(element, values);
  });
  const binary = fn(`${name}BinaryOperator`);
  op(cls, 'reduce', [element, binary.type], element, (frame, receiver, [identity, accumulator]) => {
    let result = identity;
    for (const value of iterate(take(frame, receiver))) {
      result = callFunction(frame, binary, accumulator, [result, value]);
    }
    return result;
  });
}

/** `mapToLong` and `mapToDouble` of `Stream` and `IntStream`, and `IntStream.asLongStream` and `asDoubleStream`. */
function defineConversions(context: Context, types: StreamTypes, { name, cls, impl, fromInt }: PrimitiveStream): void {
  const [t] = types.stream.typeParameters;
  op(
    types.stream,
    `mapTo${name}`,
    [classType(context.fn(`To${name}Function`), superOf(variableType(t)))],
    cls.type,
    mapTo(context, impl, `To${name}Function`)
  );
  op(
    types.intStream,
    `mapTo${name}`,
    [context.fn(`IntTo${name}Function`).type],
    cls.type,
    mapTo(context, impl, `IntTo${name}Function`)
  );
  op(types.intStream, `as${name}Stream`, [], cls.type, (frame, receiver) =>
    derive(
      impl,
      receiver,
      frame,
      function* (items) {
        for (const value of iterate(items)) yield fromInt(value as number);
      },
      true
    )
  );
}

/** An operation that maps each element with a function of `iface` into a stream of `impl`. */
function mapTo(context: Context, impl: ClassInfo, iface: string) {
  return (frame: Frame, receiver: Value, [mapper]: Value[]): Value =>
    derive(impl, receiver, frame, (items) => mapped(frame, items, context.fn(iface), mapper), true);
}

function defineArraySources(context: Context, { element, cls, impl }: PrimitiveStream): void {
  const arrayType: JavaType = { kind: 'array', element };
  const fromArray = (frame: Frame, array: Value): Value => {
    if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
    return createStream(
      frame,
      impl,
      () => [...array.values][Symbol.iterator](),
      [],
      () => BigInt(array.values.length)
    );
  };
  addMethod(cls, 'of', [arrayType], cls.type, true, (frame, _, [array]) => fromArray(frame, array)).isVarargs = true;
  addMethod(cls, 'empty', [], cls.type, true, (frame) =>
    createStream(
      frame,
      impl,
      () => [][Symbol.iterator](),
      [],
      () => 0n
    )
  );
  const arraysClass = context.registry.classes.get('Arrays') as ClassInfo;
  addMethod(arraysClass, 'stream', [arrayType], cls.type, true, (frame, _, [array]) => fromArray(frame, array));
}

function defineLongRanges(longStream: ClassInfo, longStreamImpl: ClassInfo): void {
  for (const [name, isClosed] of [
    ['range', false],
    ['rangeClosed', true],
  ] as const) {
    addMethod(longStream, name, [LONG, LONG], longStream.type, true, (frame, _, [start, end]) => {
      const last = (end as bigint) - (isClosed ? 0n : 1n);
      return createStream(
        frame,
        longStreamImpl,
        function* () {
          for (let value = start as bigint; value <= last; value++) {
            frame.runtime.spend();
            yield value;
          }
        },
        [],
        () => (last >= (start as bigint) ? last - (start as bigint) + 1n : 0n)
      );
    });
  }
}

/** The sum of longs, which wraps around as Java's long arithmetic does. */
function longSum(values: Iterable<Value>): bigint {
  let sum = 0n;
  for (const value of values) sum = BigInt.asIntN(64, sum + (value as bigint));
  return sum;
}

/** The compensated sum and the count of doubles, as `DoubleStream.sum` and `average` collect them. */
function doubleSum(values: Iterable<Value>): NumericSum {
  const state: NumericSum = { sum: 0, compensation: 0, simpleSum: 0, count: 0 };
  for (const value of values) {
    addWithCompensation(state, value as number);
    state.count++;
  }
  return state;
}
