import { ArrayOps } from './arrayOps';
import type { RealmBuilder } from './realm';
import { arrayMethod, buildArray, flattenInto } from './realmArrays';
import type { Runtime } from './runtime';
import { isCallable, JsArray, type JsFunction, type NativeCall, toBoolean, type Value } from './values';

type Callback = (value: Value, index: number) => Value;
type Iteration = (ops: ArrayOps, callback: Callback, call: NativeCall) => Value;

/**
 * Defines the methods that call a function for elements. As in the spec, each captures the length once and reads each
 * element only when visiting it; all but the find family skip absent elements.
 */
export function defineArrayIterations(builder: RealmBuilder): void {
  defineMappings(builder);
  defineFinders(builder);
  for (const fromEnd of [false, true]) {
    arrayMethod(builder, fromEnd ? 'reduceRight' : 'reduce', 1, ({ runtime, args, callRow }, ops) => {
      const fn = args[0];
      if (!isCallable(fn)) return runtime.throwError('TypeError', `${runtime.describe(fn)} is not a function`);
      return reduce(runtime, ops, fn, args, fromEnd, callRow);
    });
  }
}

/** Defines a method that calls its first argument for elements, with its second argument as `this`. */
function iterationMethod(builder: RealmBuilder, name: string, run: Iteration): void {
  arrayMethod(builder, name, 1, (call, ops) => {
    const { runtime, args, callRow } = call;
    const fn = args[0];
    if (!isCallable(fn)) return runtime.throwError('TypeError', `${runtime.describe(fn)} is not a function`);
    const thisArg = args[1];
    return run(ops, (value, index) => runtime.call(fn, thisArg, [value, index, ops.array], callRow), call);
  });
}

function defineMappings(builder: RealmBuilder): void {
  iterationMethod(builder, 'forEach', (ops, callback) => {
    forEachPresent(ops, (value, index) => {
      callback(value, index);
    });
    return;
  });
  iterationMethod(builder, 'map', (ops, callback, { runtime }) =>
    buildArray(runtime, (result) => {
      result.setLength(ops.length);
      forEachPresent(ops, (value, index) => result.set(index, callback(value, index)));
    })
  );
  iterationMethod(builder, 'filter', (ops, callback, { runtime }) =>
    buildArray(runtime, (result) =>
      forEachPresent(ops, (value, index) => {
        if (toBoolean(callback(value, index))) result.set(result.length, value);
      })
    )
  );
  iterationMethod(builder, 'flatMap', (ops, callback, { runtime }) =>
    buildArray(runtime, (result) =>
      forEachPresent(ops, (value, index) => {
        const mapped = callback(value, index);
        if (mapped instanceof JsArray) flattenInto(runtime, result, new ArrayOps(runtime, mapped), 0);
        else result.set(result.length, mapped);
      })
    )
  );
}

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineFinders(builder: RealmBuilder): void {
  for (const [name, fromEnd, returnsIndex] of [
    ['find', false, false],
    ['findIndex', false, true],
    ['findLast', true, false],
    ['findLastIndex', true, true],
  ] as const) {
    iterationMethod(builder, name, (ops, callback) => {
      const { length } = ops;
      for (let step = 0; step < length; step++) {
        const index = fromEnd ? length - 1 - step : step;
        // The find family visits absent elements as undefined.
        const value = ops.get(index);
        if (toBoolean(callback(value, index))) return returnsIndex ? index : value;
      }
      return returnsIndex ? -1 : undefined;
    });
  }
  iterationMethod(builder, 'some', (ops, callback) => {
    let found = false;
    forEachPresent(ops, (value, index) => {
      found ||= toBoolean(callback(value, index));
      return found;
    });
    return found;
  });
  iterationMethod(builder, 'every', (ops, callback) => {
    let failed = false;
    forEachPresent(ops, (value, index) => {
      failed ||= !toBoolean(callback(value, index));
      return failed;
    });
    return !failed;
  });
}

function reduce(
  runtime: Runtime,
  ops: ArrayOps,
  fn: JsFunction,
  args: Value[],
  fromEnd: boolean,
  callRow: number | undefined
): Value {
  const { length } = ops;
  let step = 0;
  const indexAt = (position: number): number => (fromEnd ? length - 1 - position : position);
  let accumulator: Value;
  if (args.length >= 2) {
    accumulator = args[1];
  } else {
    // Without an initial value, the first element present starts the accumulation.
    while (step < length && !ops.has(indexAt(step))) step++;
    if (step >= length) return runtime.throwError('TypeError', 'Reduce of empty array with no initial value');
    accumulator = ops.get(indexAt(step++));
  }
  for (; step < length; step++) {
    const index = indexAt(step);
    if (ops.has(index))
      accumulator = runtime.call(fn, undefined, [accumulator, ops.get(index), index, ops.array], callRow);
  }
  return accumulator;
}

/**
 * Visits the elements present at their visit among the indices below the length when the iteration started, until
 * `visit` returns true.
 */
function forEachPresent(ops: ArrayOps, visit: (value: Value, index: number) => unknown): void {
  const { length } = ops;
  for (let index = 0; index < length; index++) {
    if (ops.has(index) && visit(ops.get(index), index) === true) return;
  }
}
