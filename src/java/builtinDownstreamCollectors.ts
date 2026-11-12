import { findEntry, putEntry } from './builtinCollections';
import { type CollectorFunctions, collectors } from './builtinCollectors';
import { callFunction } from './builtinFunctions';
import { createStore } from './builtinMaps';
import { classType, type Context, extendsOf, superOf, typeVariable, variableType } from './builtinStreamSupport';
import { addMethod } from './builtinSupport';
import { box } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import { type ClassInfo, type JavaType, type NativeMethod, type TypeVariable, type WildcardType } from './types';
import { type HashEntry, JavaObject, toInt32, type Value } from './values';

type Create = (frame: Frame, functions: CollectorFunctions) => JavaObject;

/** A grouping collector's map, and the downstream container of each of its entries until it finishes. */
interface Groups {
  map: JavaObject;
  containers: Map<HashEntry, unknown>;
}

const ANY: WildcardType = { kind: 'wildcard', bound: undefined, isSuper: false };

/**
 * The collectors that pass elements on to another collector, `groupingBy`, `partitioningBy`, and `mapping`, and the
 * collectors of sums, averages, and given collections.
 */
export function defineDownstreamCollectors(
  context: Context,
  collectorsClass: ClassInfo,
  collector: ClassInfo,
  create: Create
): void {
  const { objectType, collections, fn } = context;
  const variables = (...names: string[]): [TypeVariable[], JavaType[]] => {
    const declared = names.map((name) => typeVariable(name, objectType));
    return [declared, declared.map((variable) => variableType(variable))];
  };
  const define = (
    name: string,
    names: string[],
    signature: (types: JavaType[]) => { parameters: JavaType[]; result: JavaType },
    native: NativeMethod
  ): void => {
    const [declared, types] = variables(...names);
    const { parameters, result } = signature(types);
    addMethod(collectorsClass, name, parameters, result, true, native).typeParameters = declared;
  };
  const collectorOf = (t: JavaType, a: JavaType, r: JavaType): JavaType => classType(collector, t, a, r);
  const mapOf = (key: JavaType, value: JavaType): JavaType => classType(collections.mapClass, key, value);
  const classifierOf = (t: JavaType, k: JavaType): JavaType => classType(fn('Function'), superOf(t), extendsOf(k));
  define(
    'groupingBy',
    ['T', 'K'],
    ([t, k]) => ({
      parameters: [classifierOf(t, k)],
      result: collectorOf(t, ANY, mapOf(k, classType(collections.listClass, t))),
    }),
    (frame, _, [classifier]) =>
      create(
        frame,
        grouping(frame, classifier, toListCollector(frame, collectorsClass), (finishFrame) => newHashMap(finishFrame))
      )
  );
  define(
    'groupingBy',
    ['T', 'K', 'A', 'D'],
    ([t, k, a, d]) => ({
      parameters: [classifierOf(t, k), collectorOf(superOf(t), a, d)],
      result: collectorOf(t, ANY, mapOf(k, d)),
    }),
    (frame, _, [classifier, downstream]) =>
      create(
        frame,
        grouping(frame, classifier, downstream, (finishFrame) => newHashMap(finishFrame))
      )
  );
  define(
    'groupingBy',
    ['T', 'K', 'D', 'A', 'M'],
    ([t, k, d, a, m]) => ({
      parameters: [classifierOf(t, k), classType(fn('Supplier'), m), collectorOf(superOf(t), a, d)],
      result: collectorOf(t, ANY, m),
    }),
    (frame, _, [classifier, factory, downstream]) =>
      create(
        frame,
        grouping(frame, classifier, downstream, (finishFrame) => callFunction(finishFrame, fn('Supplier'), factory, []))
      )
  );
  const booleanType = context.wrappers.byKind.get('boolean')?.type as JavaType;
  for (const takesDownstream of [false, true]) {
    define(
      'partitioningBy',
      takesDownstream ? ['T', 'D', 'A'] : ['T'],
      ([t, d, a]) => ({
        parameters: [
          classType(fn('Predicate'), superOf(t)),
          ...(takesDownstream ? [collectorOf(superOf(t), a, d)] : []),
        ],
        result: collectorOf(t, ANY, mapOf(booleanType, takesDownstream ? d : classType(collections.listClass, t))),
      }),
      (frame, _, [predicate, downstream]) =>
        create(frame, partitioning(frame, predicate, downstream ?? toListCollector(frame, collectorsClass)))
    );
  }
  define(
    'mapping',
    ['T', 'U', 'A', 'R'],
    ([t, u, a, r]) => ({
      parameters: [classType(fn('Function'), superOf(t), extendsOf(u)), collectorOf(superOf(u), a, r)],
      result: collectorOf(t, ANY, r),
    }),
    (frame, _, [mapper, downstream]) =>
      create(
        frame,
        adapted(functionsOf(frame, downstream), {
          map: (mapFrame, value) => callFunction(mapFrame, fn('Function'), mapper, [value]),
        })
      )
  );
  define(
    'collectingAndThen',
    ['T', 'A', 'R', 'RR'],
    ([t, a, r, rr]) => ({
      parameters: [collectorOf(t, a, r), classType(fn('Function'), r, rr)],
      result: collectorOf(t, a, rr),
    }),
    (frame, _, [downstream, finisher]) =>
      create(
        frame,
        adapted(functionsOf(frame, downstream), {
          finish: (finishFrame, result) => callFunction(finishFrame, fn('Function'), finisher, [result]),
        })
      )
  );
  defineNumericCollectors(context, define, collectorOf, create);
  define(
    'toCollection',
    ['T', 'C'],
    ([t, c]) => ({ parameters: [classType(fn('Supplier'), c)], result: collectorOf(t, ANY, c) }),
    (frame, _, [factory]) =>
      create(frame, {
        supply: (supplyFrame) => callFunction(supplyFrame, fn('Supplier'), factory, []),
        accumulate: (accumulateFrame, container, value) =>
          void accumulateFrame.runtime.invokeVirtual(
            accumulateFrame,
            collections.collectionClass,
            'add',
            container as Value,
            [value]
          ),
        finish: (_, container) => container as Value,
      })
  );
}

/** `summingInt`, `summingDouble`, `averagingInt`, and `averagingDouble`, which read a number from each element. */
function defineNumericCollectors(
  context: Context,
  define: (
    name: string,
    names: string[],
    signature: (types: JavaType[]) => { parameters: JavaType[]; result: JavaType },
    native: NativeMethod
  ) => void,
  collectorOf: (t: JavaType, a: JavaType, r: JavaType) => JavaType,
  create: Create
): void {
  const { fn, wrappers } = context;
  const integerClass = wrappers.byKind.get('int') as ClassInfo;
  const doubleClass = wrappers.byKind.get('double') as ClassInfo;
  for (const [name, iface, resultClass, average] of [
    ['summingInt', 'ToIntFunction', integerClass, false],
    ['summingDouble', 'ToDoubleFunction', doubleClass, false],
    ['averagingInt', 'ToIntFunction', doubleClass, true],
    ['averagingDouble', 'ToDoubleFunction', doubleClass, true],
  ] as const) {
    define(
      name,
      ['T'],
      ([t]) => ({ parameters: [classType(fn(iface), superOf(t))], result: collectorOf(t, ANY, resultClass.type) }),
      (frame, _, [mapper]) =>
        create(frame, {
          supply: (): NumericSum => ({ sum: 0, compensation: 0, simpleSum: 0, count: 0 }),
          accumulate: (accumulateFrame, container, value) => {
            const state = container as NumericSum;
            const number = callFunction(accumulateFrame, fn(iface), mapper, [value]) as number;
            if (iface === 'ToIntFunction') {
              state.sum = resultClass === integerClass ? toInt32(state.sum + number) : state.sum + number;
            } else {
              addWithCompensation(state, number);
            }
            state.count++;
          },
          finish: (finishFrame, container) => {
            const state = container as NumericSum;
            const sum = iface === 'ToIntFunction' ? state.sum : compensatedSum(state);
            return box(finishFrame, resultClass, average ? (state.count === 0 ? 0 : sum / state.count) : sum);
          },
        })
    );
  }
}

/** A running sum, of doubles with the compensation for lost low-order bits that the JDK's Kahan summation keeps. */
export interface NumericSum {
  sum: number;
  compensation: number;
  simpleSum: number;
  count: number;
}

/** Adds as `Collectors.sumWithCompensation` does. */
export function addWithCompensation(state: NumericSum, value: number): void {
  const corrected = value - state.compensation;
  const sum = state.sum + corrected;
  state.compensation = sum - state.sum - corrected;
  state.sum = sum;
  state.simpleSum += value;
}

/** The sum as `Collectors.computeFinalSum` gives it, which keeps an infinite sum that the compensation makes NaN. */
export function compensatedSum(state: NumericSum): number {
  const sum = state.sum - state.compensation;
  return Number.isNaN(sum) && !Number.isFinite(state.simpleSum) && !Number.isNaN(state.simpleSum)
    ? state.simpleSum
    : sum;
}

/** The collector functions behind a collector object, which only the builtin collectors have. */
/** A downstream collector that sees each value through `map`, as `mapping`, or gives its result to `finish`. */
function adapted(
  target: CollectorFunctions,
  {
    map = (_, value) => value,
    finish = (_, result) => result,
  }: { map?: (frame: Frame, value: Value) => Value; finish?: (frame: Frame, result: Value) => Value }
): CollectorFunctions {
  return {
    supply: (frame) => target.supply(frame),
    accumulate: (frame, container, value) => target.accumulate(frame, container, map(frame, value)),
    finish: (frame, container) => finish(frame, target.finish(frame, container)),
  };
}

function functionsOf(frame: Frame, collector: Value): CollectorFunctions {
  const functions = collector instanceof JavaObject ? collectors.get(collector) : undefined;
  return functions ?? throwBuiltin(frame, 'UnsupportedOperationException');
}

/**
 * Groups elements by the classifier's key into the map `newMap` makes before the elements come, each group collected
 * by `downstream`: each key is looked up in that map, as `computeIfAbsent` does, so that a sorted map's comparator
 * decides which keys share a group, and the map's table grows as the JDK's does.
 */
function grouping(
  frame: Frame,
  classifier: Value,
  downstream: Value,
  newMap: (frame: Frame) => Value
): CollectorFunctions {
  const target = functionsOf(frame, downstream);
  const fn = frame.runtime.builtins.classes.get('Function') as ClassInfo;
  return {
    supply: (supplyFrame): Groups => ({ map: newMap(supplyFrame) as JavaObject, containers: new Map() }),
    accumulate: (accumulateFrame, container, value) => {
      const { map, containers } = container as Groups;
      const key = callFunction(accumulateFrame, fn, classifier, [value]);
      if (key === undefined)
        throwBuiltin(accumulateFrame, 'NullPointerException', 'element cannot be mapped to a null key');
      map.store?.growBeforeCompute();
      let entry = findEntry(accumulateFrame, map, key);
      if (!entry) {
        const groupContainer = target.supply(accumulateFrame);
        putEntry(accumulateFrame, map, key, false, undefined, true);
        entry = findEntry(accumulateFrame, map, key) as HashEntry;
        containers.set(entry, groupContainer);
      }
      target.accumulate(accumulateFrame, containers.get(entry), value);
    },
    finish: (finishFrame, container) => {
      const { map, containers } = container as Groups;
      for (const [entry, groupContainer] of containers) entry.value = target.finish(finishFrame, groupContainer);
      return map;
    },
  };
}

/** Splits elements by the predicate into a map from `false` and `true`, each part collected by `downstream`. */
function partitioning(frame: Frame, predicate: Value, downstream: Value): CollectorFunctions {
  const target = functionsOf(frame, downstream);
  const predicateClass = frame.runtime.builtins.classes.get('Predicate') as ClassInfo;
  return {
    supply: (supplyFrame) => ({ false: target.supply(supplyFrame), true: target.supply(supplyFrame) }),
    accumulate: (accumulateFrame, container, value) => {
      const parts = container as { false: unknown; true: unknown };
      const matches = callFunction(accumulateFrame, predicateClass, predicate, [value]) === true;
      target.accumulate(accumulateFrame, matches ? parts.true : parts.false, value);
    },
    finish: (finishFrame, container) => {
      const parts = container as { false: unknown; true: unknown };
      const map = newHashMap(finishFrame);
      const booleanClass = finishFrame.runtime.builtins.wrappers.byKind.get('boolean') as ClassInfo;
      for (const key of [false, true]) {
        putEntry(
          finishFrame,
          map,
          box(finishFrame, booleanClass, key),
          false,
          target.finish(finishFrame, parts[`${key}`])
        );
      }
      return map;
    },
  };
}

/** The collector `Collectors.toList()` returns, which `partitioningBy` collects each part with by default. */
function toListCollector(frame: Frame, collectorsClass: ClassInfo): Value {
  const toList = collectorsClass.methods.find(
    (method) => method.name === 'toList' && method.parameterTypes.length === 0
  );
  return frame.runtime.invoke(frame, toList as NonNullable<typeof toList>, undefined, [], undefined);
}

function newHashMap(frame: Frame): JavaObject {
  const map = frame.runtime.allocateObject(frame, frame.runtime.builtins.classes.get('HashMap') as ClassInfo);
  createStore(map);
  return map;
}
