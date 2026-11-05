import { javaEquals, putEntry } from './builtinCollections';
import { type CollectorFunctions, collectors } from './builtinCollectors';
import { callFunction } from './builtinFunctions';
import { createStore } from './builtinMaps';
import { classType, type Context, extendsOf, superOf, typeVariable, variableType } from './builtinStreamSupport';
import { addMethod } from './builtinSupport';
import { box } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import { type ClassInfo, type JavaType, type NativeMethod, type TypeVariable, type WildcardType } from './types';
import { JavaObject, toInt32, type Value } from './values';

type Create = (frame: Frame, functions: CollectorFunctions) => JavaObject;

/** The elements a grouping collector has gathered under one key, in the downstream collector's container. */
interface Group {
  key: Value;
  container: unknown;
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
        supply: () => [] as Value[],
        accumulate: (__, container, value) => void (container as Value[]).push(value),
        finish: (finishFrame, container) => {
          const result = callFunction(finishFrame, fn('Supplier'), factory, []);
          for (const value of container as Value[]) {
            finishFrame.runtime.invokeVirtual(finishFrame, collections.collectionClass, 'add', result, [value]);
          }
          return result;
        },
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
          supply: () => ({ sum: 0, count: 0 }),
          accumulate: (accumulateFrame, container, value) => {
            const state = container as { sum: number; count: number };
            const number = callFunction(accumulateFrame, fn(iface), mapper, [value]) as number;
            state.sum = resultClass === integerClass ? toInt32(state.sum + number) : state.sum + number;
            state.count++;
          },
          finish: (finishFrame, container) => {
            const { sum, count } = container as { sum: number; count: number };
            return box(finishFrame, resultClass, average ? (count === 0 ? 0 : sum / count) : sum);
          },
        })
    );
  }
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

/** Groups elements by the classifier's key, each group collected by `downstream` into the map `newMap` makes. */
function grouping(
  frame: Frame,
  classifier: Value,
  downstream: Value,
  newMap: (frame: Frame) => Value
): CollectorFunctions {
  const target = functionsOf(frame, downstream);
  const fn = frame.runtime.builtins.classes.get('Function') as ClassInfo;
  return {
    supply: () => [] as Group[],
    accumulate: (accumulateFrame, container, value) => {
      const groups = container as Group[];
      const key = callFunction(accumulateFrame, fn, classifier, [value]);
      if (key === undefined)
        throwBuiltin(accumulateFrame, 'NullPointerException', 'element cannot be mapped to a null key');
      let group = groups.find((candidate) => javaEquals(accumulateFrame, candidate.key, key));
      if (!group) {
        group = { key, container: target.supply(accumulateFrame) };
        groups.push(group);
      }
      target.accumulate(accumulateFrame, group.container, value);
    },
    finish: (finishFrame, container) => {
      const map = newMap(finishFrame);
      // groupingBy adds each key with computeIfAbsent, which a HashMap puts at the start of its bucket.
      for (const { key, container: groupContainer } of container as Group[]) {
        putEntry(finishFrame, map, key, false, target.finish(finishFrame, groupContainer), true);
      }
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
