import { ArrayOps } from './arrayOps';
import type { RealmBuilder } from './realm';
import { arrayMethod, buildSpeciesArray, flattenInto } from './realmArrays';
import { isCallable, JsArray, type JsFunction, type NativeCall, toBoolean, type Value } from './values';

type Callback = (value: Value, index: number) => Value;
type Iteration = (ops: ArrayOps, callback: Callback, length: number, call: NativeCall) => Value;

/**
 * Defines the methods that call a function for elements. As in the spec, each captures the length once, before
 * validating the function, and reads each element only when visiting it; all but the find family skip absent elements.
 */
export function defineArrayIterations(builder: RealmBuilder): void {
  defineMappings(builder);
  defineFinders(builder);
  for (const fromEnd of [false, true]) {
    arrayMethod(builder, fromEnd ? 'reduceRight' : 'reduce', 1, (call, ops) => {
      const { runtime, args } = call;
      const { length } = ops;
      const fn = args[0];
      if (!isCallable(fn)) return runtime.throwError('TypeError', `${runtime.describeTyped(fn)} is not a function`);
      return reduce(call, ops, length, fn, fromEnd);
    });
  }
}

/** Defines a method that calls its first argument for elements, with its second argument as `this`. */
function iterationMethod(builder: RealmBuilder, name: string, run: Iteration): void {
  arrayMethod(builder, name, 1, (call, ops) => {
    const { runtime, args, callRow } = call;
    const { length } = ops;
    const fn = args[0];
    if (!isCallable(fn)) return runtime.throwError('TypeError', `${runtime.describeTyped(fn)} is not a function`);
    const thisArg = args[1];
    return run(ops, (value, index) => runtime.call(fn, thisArg, [value, index, ops.array], callRow), length, call);
  });
}

function defineMappings(builder: RealmBuilder): void {
  iterationMethod(builder, 'forEach', (ops, callback, length) => {
    forEachPresent(ops, length, (value, index) => {
      callback(value, index);
    });
    return;
  });
  iterationMethod(builder, 'map', (ops, callback, length, { runtime }) => {
    return buildSpeciesArray(runtime, ops.array, length, (result) => {
      forEachPresent(ops, length, (value, index) => result.create(index, callback(value, index)));
    });
  });
  iterationMethod(builder, 'filter', (ops, callback, length, { runtime }) => {
    return buildSpeciesArray(runtime, ops.array, 0, (result) => {
      let next = 0;
      forEachPresent(ops, length, (value, index) => {
        if (toBoolean(callback(value, index))) result.create(next++, value);
      });
    });
  });
  iterationMethod(builder, 'flatMap', (ops, callback, length, { runtime }) => {
    return buildSpeciesArray(runtime, ops.array, 0, (result) => {
      let next = 0;
      forEachPresent(ops, length, (value, index) => {
        const mapped = callback(value, index);
        if (mapped instanceof JsArray)
          next = flattenInto(runtime, result, new ArrayOps(runtime, mapped), 0, { start: next });
        else result.create(next++, mapped);
      });
    });
  });
}

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineFinders(builder: RealmBuilder): void {
  for (const [name, fromEnd, returnsIndex] of [
    ['find', false, false],
    ['findIndex', false, true],
    ['findLast', true, false],
    ['findLastIndex', true, true],
  ] as const) {
    iterationMethod(builder, name, (ops, callback, length) => {
      for (let step = 0; step < length; step++) {
        const index = fromEnd ? length - 1 - step : step;
        // The find family visits absent elements as undefined.
        const value = ops.get(index);
        if (toBoolean(callback(value, index))) return returnsIndex ? index : value;
      }
      return returnsIndex ? -1 : undefined;
    });
  }
  iterationMethod(builder, 'some', (ops, callback, length) => {
    let found = false;
    forEachPresent(ops, length, (value, index) => {
      found ||= toBoolean(callback(value, index));
      return found;
    });
    return found;
  });
  iterationMethod(builder, 'every', (ops, callback, length) => {
    let failed = false;
    forEachPresent(ops, length, (value, index) => {
      failed ||= !toBoolean(callback(value, index));
      return failed;
    });
    return !failed;
  });
}

function reduce(
  { runtime, args, callRow }: NativeCall,
  ops: ArrayOps,
  length: number,
  fn: JsFunction,
  fromEnd: boolean
): Value {
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
 * Visits the elements present at their visit among the indices below `length`, the length when the iteration
 * started, until `visit` returns true.
 */
function forEachPresent(ops: ArrayOps, length: number, visit: (value: Value, index: number) => unknown): void {
  for (let index = 0; index < length; index++) {
    if (ops.has(index) && visit(ops.get(index), index) === true) return;
  }
}
