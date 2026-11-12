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
import { type ClassInfo, DOUBLE, type JavaType } from './types';
import { JavaArray, type Value } from './values';

const DOUBLE_ARRAY: JavaType = { kind: 'array', element: DOUBLE };

/**
 * The operations only a `DoubleStream` has, the streams that give one, and its sources, `DoubleStream.of` and
 * `Arrays.stream` of a `double[]`.
 */
export function defineDoubleStreamOperations(context: Context, types: StreamTypes, optionals: Optionals): void {
  const { doubleStream, doubleStreamImpl, intStream, intStreamImpl, stream, streamImpl } = types;
  const { fn } = context;
  const doubleClass = context.wrappers.byKind.get('double') as ClassInfo;
  const mapTo =
    (impl: ClassInfo, iface: string) =>
    (frame: Frame, receiver: Value, [mapper]: Value[]): Value =>
      derive(impl, receiver, frame, (items) => mapped(frame, items, fn(iface), mapper), true);
  op(
    doubleStream,
    'map',
    [fn('DoubleUnaryOperator').type],
    doubleStream.type,
    mapTo(doubleStreamImpl, 'DoubleUnaryOperator')
  );
  op(
    doubleStream,
    'mapToInt',
    [fn('DoubleToIntFunction').type],
    intStream.type,
    mapTo(intStreamImpl, 'DoubleToIntFunction')
  );
  const r = typeVariable('R', context.objectType);
  op(
    doubleStream,
    'mapToObj',
    [classType(fn('DoubleFunction'), extendsOf(variableType(r)))],
    classType(stream, variableType(r)),
    mapTo(streamImpl, 'DoubleFunction'),
    [r]
  );
  op(doubleStream, 'boxed', [], classType(stream, doubleClass.type), (frame, receiver) =>
    derive(
      streamImpl,
      receiver,
      frame,
      function* (items) {
        for (const value of iterate(items)) yield box(frame, doubleClass, value);
      },
      true
    )
  );
  op(doubleStream, 'sum', [], DOUBLE, (frame, receiver) => compensatedSum(summed(frame, receiver)));
  op(doubleStream, 'average', [], optionals.optionalDouble.type, (frame, receiver) => {
    const state = summed(frame, receiver);
    const average = state.count === 0 ? undefined : compensatedSum(state) / state.count;
    return createOptional(frame, optionals.optionalDouble, average, state.count > 0);
  });
  op(doubleStream, 'toArray', [], DOUBLE_ARRAY, (frame, receiver) => {
    const values = [...iterate(take(frame, receiver))];
    frame.runtime.allocateArray(frame, values.length);
    return new JavaArray(DOUBLE, values);
  });
  const binary = fn('DoubleBinaryOperator');
  op(doubleStream, 'reduce', [DOUBLE, binary.type], DOUBLE, (frame, receiver, [identity, accumulator]) => {
    let result = identity;
    for (const value of iterate(take(frame, receiver)))
      result = callFunction(frame, binary, accumulator, [result, value]);
    return result;
  });
  const [t] = stream.typeParameters;
  op(
    stream,
    'mapToDouble',
    [classType(fn('ToDoubleFunction'), superOf(variableType(t)))],
    doubleStream.type,
    mapTo(doubleStreamImpl, 'ToDoubleFunction')
  );
  op(
    intStream,
    'mapToDouble',
    [fn('IntToDoubleFunction').type],
    doubleStream.type,
    mapTo(doubleStreamImpl, 'IntToDoubleFunction')
  );
  op(intStream, 'asDoubleStream', [], doubleStream.type, (frame, receiver) =>
    derive(doubleStreamImpl, receiver, frame, (items) => items, true)
  );
  defineDoubleSources(context, doubleStream, doubleStreamImpl);
}

/** The compensated sum and the count of a stream's values, as `DoubleStream.sum` and `average` collect them. */
function summed(frame: Frame, receiver: Value): NumericSum {
  const state: NumericSum = { sum: 0, compensation: 0, simpleSum: 0, count: 0 };
  for (const value of iterate(take(frame, receiver))) {
    addWithCompensation(state, value as number);
    state.count++;
  }
  return state;
}

function defineDoubleSources(context: Context, doubleStream: ClassInfo, doubleStreamImpl: ClassInfo): void {
  const fromArray = (frame: Frame, array: Value): Value => {
    if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
    return createStream(
      frame,
      doubleStreamImpl,
      () => [...array.values][Symbol.iterator](),
      [],
      () => BigInt(array.values.length)
    );
  };
  addMethod(doubleStream, 'of', [DOUBLE_ARRAY], doubleStream.type, true, (frame, _, [array]) =>
    fromArray(frame, array)
  ).isVarargs = true;
  const arraysClass = context.registry.classes.get('Arrays') as ClassInfo;
  addMethod(arraysClass, 'stream', [DOUBLE_ARRAY], doubleStream.type, true, (frame, _, [array]) =>
    fromArray(frame, array)
  );
}
