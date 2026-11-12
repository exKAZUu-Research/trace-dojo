import { type CollectorFunctions } from './builtinCollectors';
import { addWithCompensation, compensatedSum, type NumericSum } from './builtinDownstreamCollectors';
import { callFunction } from './builtinFunctions';
import { type Context, iterate, op, take } from './builtinStreamSupport';
import { addConstructor, addMethod, newString } from './builtinSupport';
import { box } from './builtinWrappers';
import { formatText } from './javaFormatter';
import { type Frame, throwBuiltin } from './runtime';
import { type ClassInfo, DOUBLE, INT, LONG, VOID } from './types';
import { JavaObject, JavaString, type Value } from './values';

/** What `IntSummaryStatistics` (`isInt`) or `DoubleSummaryStatistics` has seen. */
interface Statistics {
  isInt: boolean;
  /** The double sum with its compensation, or the exact long sum of ints in `sum`. */
  total: NumericSum;
  min: number;
  max: number;
}

const statistics = new WeakMap<JavaObject, Statistics>();

/** `IntSummaryStatistics` and `DoubleSummaryStatistics`, which streams and collectors fill with their values. */
export function defineSummaryStatistics(context: Context): void {
  for (const [name, isInt] of [
    ['IntSummaryStatistics', true],
    ['DoubleSummaryStatistics', false],
  ] as const) {
    const cls = context.registry.define(name, context.objectClass, 'java.util');
    const element = isInt ? INT : DOUBLE;
    addConstructor(cls, [], (_, receiver) => {
      statistics.set(receiver as JavaObject, emptyStatistics(isInt));
    });
    addMethod(cls, 'accept', [element], VOID, false, (_, receiver, [value]) => {
      accept(statisticsOf(receiver), value as number);
    });
    addMethod(cls, 'combine', [cls.type], VOID, false, (frame, receiver, [other]) => {
      if (!(other instanceof JavaObject)) throwBuiltin(frame, 'NullPointerException');
      combine(statisticsOf(receiver), statisticsOf(other));
    });
    addMethod(cls, 'getCount', [], LONG, false, (_, receiver) => BigInt(statisticsOf(receiver).total.count));
    addMethod(cls, 'getSum', [], isInt ? LONG : DOUBLE, false, (_, receiver) => sumOf(statisticsOf(receiver)));
    addMethod(cls, 'getMin', [], element, false, (_, receiver) => statisticsOf(receiver).min);
    addMethod(cls, 'getMax', [], element, false, (_, receiver) => statisticsOf(receiver).max);
    addMethod(cls, 'getAverage', [], DOUBLE, false, (_, receiver) => averageOf(statisticsOf(receiver)));
    addMethod(cls, 'toString', [], context.stringType, false, (frame, receiver) => {
      const state = statisticsOf(receiver);
      const pattern = isInt
        ? '%s{count=%d, sum=%d, min=%d, average=%f, max=%d}'
        : '%s{count=%d, sum=%f, min=%f, average=%f, max=%f}';
      const boxed = (kind: 'int' | 'long' | 'double', value: Value): Value =>
        box(frame, context.wrappers.byKind.get(kind) as ClassInfo, value);
      const elementKind = isInt ? 'int' : 'double';
      const args = [
        new JavaString(name),
        boxed('long', BigInt(state.total.count)),
        boxed(isInt ? 'long' : 'double', sumOf(state)),
        boxed(elementKind, state.min),
        boxed('double', averageOf(state)),
        boxed(elementKind, state.max),
      ];
      return newString(frame, formatText(frame, pattern, args));
    });
  }
}

/** `summaryStatistics` of `IntStream` and `DoubleStream`. */
export function defineStatisticsOperations(context: Context, intStream: ClassInfo, doubleStream: ClassInfo): void {
  for (const [stream, isInt] of [
    [intStream, true],
    [doubleStream, false],
  ] as const) {
    const cls = context.fn(isInt ? 'IntSummaryStatistics' : 'DoubleSummaryStatistics');
    op(stream, 'summaryStatistics', [], cls.type, (frame, receiver) => {
      const object = createStatistics(frame, cls, isInt);
      for (const value of iterate(take(frame, receiver))) accept(statisticsOf(object), value as number);
      return object;
    });
  }
}

/** The collector `summarizingInt` (`isInt`) or `summarizingDouble` makes of `mapper`, a function of `iface`. */
export function statisticsCollector(
  cls: ClassInfo,
  isInt: boolean,
  iface: ClassInfo,
  mapper: Value
): CollectorFunctions {
  return {
    supply: (frame) => createStatistics(frame, cls, isInt),
    accumulate: (frame, container, value) => {
      accept(statisticsOf(container as Value), callFunction(frame, iface, mapper, [value]) as number);
    },
    finish: (_, container) => container as Value,
  };
}

function createStatistics(frame: Frame, cls: ClassInfo, isInt: boolean): JavaObject {
  const object = frame.runtime.allocateObject(frame, cls);
  statistics.set(object, emptyStatistics(isInt));
  return object;
}

function emptyStatistics(isInt: boolean): Statistics {
  return {
    isInt,
    total: { sum: 0, compensation: 0, simpleSum: 0, count: 0 },
    min: isInt ? 2_147_483_647 : Number.POSITIVE_INFINITY,
    max: isInt ? -2_147_483_648 : Number.NEGATIVE_INFINITY,
  };
}

function statisticsOf(value: Value): Statistics {
  return statistics.get(value as JavaObject) as Statistics;
}

function accept(state: Statistics, value: number): void {
  if (state.isInt) state.total.sum += value;
  else addWithCompensation(state.total, value);
  state.total.count++;
  // Math.min and Math.max give NaN for a NaN and order -0.0 below 0.0, as the JDK's do.
  state.min = Math.min(state.min, value);
  state.max = Math.max(state.max, value);
}

function combine(state: Statistics, other: Statistics): void {
  if (state.isInt) {
    state.total.sum += other.total.sum;
  } else {
    const { simpleSum } = state.total;
    addWithCompensation(state.total, other.total.sum);
    addWithCompensation(state.total, -other.total.compensation);
    state.total.simpleSum = simpleSum + other.total.simpleSum;
  }
  state.total.count += other.total.count;
  state.min = Math.min(state.min, other.min);
  state.max = Math.max(state.max, other.max);
}

function sumOf(state: Statistics): Value {
  return state.isInt ? BigInt(state.total.sum) : compensatedSum(state.total);
}

function averageOf(state: Statistics): number {
  if (state.total.count === 0) return 0;
  return (state.isInt ? state.total.sum : compensatedSum(state.total)) / state.total.count;
}
