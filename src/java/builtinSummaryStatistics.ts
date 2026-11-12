import { type CollectorFunctions } from './builtinCollectors';
import { addWithCompensation, compensatedSum, type NumericSum } from './builtinDownstreamCollectors';
import { callFunction } from './builtinFunctions';
import { type Context, iterate, op, take } from './builtinStreamSupport';
import { addConstructor, addMethod, newString } from './builtinSupport';
import { box } from './builtinWrappers';
import { formatText } from './javaFormatter';
import { type Frame, throwBuiltin } from './runtime';
import { type ClassInfo, DOUBLE, INT, type JavaType, LONG, VOID } from './types';
import { JavaObject, JavaString, type Value } from './values';

/** The element types of the summary statistics, by the prefix of their classes' names. */
export type StatisticsKind = 'Int' | 'Long' | 'Double';

/** What a summary statistics object has seen. */
interface Statistics {
  kind: StatisticsKind;
  /** The sum of doubles with its compensation, and the count of every kind. */
  total: NumericSum;
  /** The sum of ints or longs, a long that wraps around as Java's does. */
  integerSum: bigint;
  min: Value;
  max: Value;
}

const statistics = new WeakMap<JavaObject, Statistics>();

const ELEMENTS: Readonly<Record<StatisticsKind, { type: JavaType; wrapper: 'int' | 'long' | 'double' }>> = {
  Int: { type: INT, wrapper: 'int' },
  Long: { type: LONG, wrapper: 'long' },
  Double: { type: DOUBLE, wrapper: 'double' },
};

/** `IntSummaryStatistics`, `LongSummaryStatistics`, and `DoubleSummaryStatistics`. */
export function defineSummaryStatistics(context: Context): void {
  for (const kind of ['Int', 'Long', 'Double'] as const) {
    const name = `${kind}SummaryStatistics`;
    const cls = context.registry.define(name, context.objectClass, 'java.util');
    const element = ELEMENTS[kind].type;
    addConstructor(cls, [], (_, receiver) => {
      statistics.set(receiver as JavaObject, emptyStatistics(kind));
    });
    addMethod(cls, 'accept', [element], VOID, false, (_, receiver, [value]) => {
      accept(statisticsOf(receiver), value);
    });
    // A LongSummaryStatistics also accepts ints, as its IntConsumer side does.
    if (kind === 'Long') {
      addMethod(cls, 'accept', [INT], VOID, false, (_, receiver, [value]) => {
        accept(statisticsOf(receiver), BigInt(value as number));
      });
    }
    addMethod(cls, 'combine', [cls.type], VOID, false, (frame, receiver, [other]) => {
      if (!(other instanceof JavaObject)) throwBuiltin(frame, 'NullPointerException');
      combine(statisticsOf(receiver), statisticsOf(other));
    });
    addMethod(cls, 'getCount', [], LONG, false, (_, receiver) => BigInt(statisticsOf(receiver).total.count));
    addMethod(cls, 'getSum', [], kind === 'Double' ? DOUBLE : LONG, false, (_, receiver) =>
      sumOf(statisticsOf(receiver))
    );
    addMethod(cls, 'getMin', [], element, false, (_, receiver) => statisticsOf(receiver).min);
    addMethod(cls, 'getMax', [], element, false, (_, receiver) => statisticsOf(receiver).max);
    addMethod(cls, 'getAverage', [], DOUBLE, false, (_, receiver) => averageOf(statisticsOf(receiver)));
    addMethod(cls, 'toString', [], context.stringType, false, (frame, receiver) => {
      const state = statisticsOf(receiver);
      const pattern =
        kind === 'Double'
          ? '%s{count=%d, sum=%f, min=%f, average=%f, max=%f}'
          : '%s{count=%d, sum=%d, min=%d, average=%f, max=%d}';
      const boxed = (wrapper: 'int' | 'long' | 'double', value: Value): Value =>
        box(frame, context.wrappers.byKind.get(wrapper) as ClassInfo, value);
      const { wrapper } = ELEMENTS[kind];
      const args = [
        new JavaString(name),
        boxed('long', BigInt(state.total.count)),
        boxed(kind === 'Double' ? 'double' : 'long', sumOf(state)),
        boxed(wrapper, state.min),
        boxed('double', averageOf(state)),
        boxed(wrapper, state.max),
      ];
      return newString(frame, formatText(frame, pattern, args));
    });
  }
}

/** `summaryStatistics` of the primitive streams, by the kind of their elements. */
export function defineStatisticsOperations(context: Context, streams: Record<StatisticsKind, ClassInfo>): void {
  for (const kind of ['Int', 'Long', 'Double'] as const) {
    const cls = context.fn(`${kind}SummaryStatistics`);
    op(streams[kind], 'summaryStatistics', [], cls.type, (frame, receiver) => {
      const object = createStatistics(frame, cls, kind);
      for (const value of iterate(take(frame, receiver))) accept(statisticsOf(object), value);
      return object;
    });
  }
}

/** The collector `summarizingInt`, `summarizingLong`, or `summarizingDouble` makes of `mapper`, of `iface`. */
export function statisticsCollector(
  cls: ClassInfo,
  kind: StatisticsKind,
  iface: ClassInfo,
  mapper: Value
): CollectorFunctions {
  return {
    supply: (frame) => createStatistics(frame, cls, kind),
    accumulate: (frame, container, value) => {
      accept(statisticsOf(container as Value), callFunction(frame, iface, mapper, [value]));
    },
    finish: (_, container) => container as Value,
  };
}

function createStatistics(frame: Frame, cls: ClassInfo, kind: StatisticsKind): JavaObject {
  const object = frame.runtime.allocateObject(frame, cls);
  statistics.set(object, emptyStatistics(kind));
  return object;
}

function emptyStatistics(kind: StatisticsKind): Statistics {
  const bounds = {
    Int: [2_147_483_647, -2_147_483_648],
    Long: [9_223_372_036_854_775_807n, -9_223_372_036_854_775_808n],
    Double: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  }[kind];
  return {
    kind,
    total: { sum: 0, compensation: 0, simpleSum: 0, count: 0 },
    integerSum: 0n,
    min: bounds[0],
    max: bounds[1],
  };
}

function statisticsOf(value: Value): Statistics {
  return statistics.get(value as JavaObject) as Statistics;
}

function accept(state: Statistics, value: Value): void {
  if (state.kind === 'Double') addWithCompensation(state.total, value as number);
  else state.integerSum = BigInt.asIntN(64, state.integerSum + BigInt(value as number | bigint));
  state.total.count++;
  updateBounds(state, value, value);
}

function combine(state: Statistics, other: Statistics): void {
  if (state.kind === 'Double') {
    const { simpleSum } = state.total;
    addWithCompensation(state.total, other.total.sum);
    addWithCompensation(state.total, -other.total.compensation);
    state.total.simpleSum = simpleSum + other.total.simpleSum;
  } else {
    state.integerSum = BigInt.asIntN(64, state.integerSum + other.integerSum);
  }
  state.total.count += other.total.count;
  updateBounds(state, other.min, other.max);
}

/** Math.min and Math.max give NaN for a NaN and order -0.0 below 0.0, as the JDK's do. */
function updateBounds(state: Statistics, min: Value, max: Value): void {
  if (state.kind === 'Double') {
    state.min = Math.min(state.min as number, min as number);
    state.max = Math.max(state.max as number, max as number);
    return;
  }
  if ((min as number | bigint) < (state.min as number | bigint)) state.min = min;
  if ((max as number | bigint) > (state.max as number | bigint)) state.max = max;
}

function sumOf(state: Statistics): Value {
  return state.kind === 'Double' ? compensatedSum(state.total) : state.integerSum;
}

function averageOf(state: Statistics): number {
  if (state.total.count === 0) return 0;
  return (state.kind === 'Double' ? compensatedSum(state.total) : Number(state.integerSum)) / state.total.count;
}
