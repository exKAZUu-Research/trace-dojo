import { ArrayOps } from './arrayOps';
import { DONE } from './iteration';
import type { RealmBuilder } from './realm';
import { defineArrayCopies } from './realmArrayCopies';
import { defineArrayIterations } from './realmArrayIterations';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import { isCallable, JsArray, JsThrow, type NativeCall, type Value } from './values';

/**
 * Defines Array and Array.prototype. Each method follows its algorithm in the ECMAScript specification step by step,
 * reading the length where the spec does and each element through {@link ArrayOps} only when the step reaches it.
 */
export function defineArrayBuiltins(builder: RealmBuilder): void {
  const { arrayPrototype } = builder.realm;
  const arrayConstructor = builder.defineClass('Array', 1, arrayPrototype, ({ runtime, args, newTarget }) => {
    const array = runtime.newArray(args.length === 1 && typeof args[0] === 'number' ? [] : [...args]);
    if (args.length === 1 && typeof args[0] === 'number') runtime.setLength(array, args[0]);
    // A subclass such as `class Path extends Array` gets its own prototype.
    array.proto = runtime.prototypeFor(newTarget, arrayPrototype);
    return array;
  });
  builder.method(arrayConstructor, 'isArray', 1, ({ args }) => args[0] instanceof JsArray);
  builder.method(arrayConstructor, 'of', 0, ({ runtime, args }) => runtime.newArray([...args]));
  builder.method(arrayConstructor, 'from', 1, arrayFrom);
  defineStackMethods(builder);
  defineReorderings(builder);
  defineCopies(builder);
  defineSearches(builder);
  defineArrayIterations(builder);
  defineArrayCopies(builder);
}

export type ArrayMethod = (call: NativeCall, ops: ArrayOps) => Value;

export function arrayMethod(builder: RealmBuilder, name: string, length: number, run: ArrayMethod): void {
  builder.method(builder.realm.arrayPrototype, name, length, (call) => {
    const { runtime, thisValue } = call;
    if (!(thisValue instanceof JsArray)) {
      return runtime.throwError('TypeError', `Array.prototype.${name} requires an array`);
    }
    return run(call, new ArrayOps(runtime, thisValue));
  });
}

/** A new array that the builder's steps fill through {@link ArrayOps}, held so that its values stay reachable. */
export function buildArray(runtime: Runtime, build: (ops: ArrayOps) => void): JsArray {
  const array = runtime.newArray([]);
  runtime.hold(array, () => build(new ArrayOps(runtime, array)));
  return array;
}

function arrayFrom({ runtime, args, callRow }: NativeCall): JsArray {
  const [source, mapper, thisArg] = args;
  if (mapper !== undefined && !isCallable(mapper)) {
    runtime.throwError('TypeError', `${runtime.describe(mapper)} is not a function`);
  }
  return buildArray(runtime, (result) => {
    const add = (value: Value, index: number): void =>
      result.set(index, mapper ? runtime.call(mapper, thisArg, [value, index], callRow) : value);
    const method =
      source === undefined || source === null ? undefined : runtime.get(source, WELL_KNOWN_SYMBOLS.iterator);
    if (method !== undefined && method !== null) {
      // Each value is read just before its mapper runs, as JavaScript's iteration does.
      const iterator = runtime.iterator(source, method);
      try {
        for (let index = 0, value = iterator.next(); value !== DONE; index++, value = iterator.next())
          add(value, index);
      } catch (error) {
        // A mapper that throws closes the iterator; a failed `next()` has already ended it.
        if (error instanceof JsThrow) iterator.close('throw');
        throw error;
      }
      return;
    }
    // Null and undefined are neither iterable nor array-like, which JavaScript reports as a TypeError.
    const object = runtime.toObject(source);
    const length = toLength(runtime, runtime.get(object, 'length'));
    for (let index = 0; index < length; index++) add(runtime.get(object, String(index)), index);
  });
}

function toLength(runtime: Runtime, value: Value): number {
  const length = Math.trunc(runtime.toNumber(value));
  return Number.isNaN(length) || length < 0 ? 0 : Math.min(length, Number.MAX_SAFE_INTEGER);
}

/** The spec's ToIntegerOrInfinity. */
export function toInteger(runtime: Runtime, value: Value): number {
  const number = runtime.toNumber(value);
  return Number.isNaN(number) ? 0 : Math.trunc(number);
}

/** Resolves a relative index as slice, splice, and fill do: negative counts from the end, clamped to the array. */
export function relativeIndex(runtime: Runtime, value: Value, length: number, fallback: number): number {
  if (value === undefined) return fallback;
  const index = toInteger(runtime, value);
  return index < 0 ? Math.max(length + index, 0) : Math.min(index, length);
}

// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
// code-gauge-allow functionNcss 40 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineStackMethods(builder: RealmBuilder): void {
  arrayMethod(builder, 'push', 1, ({ runtime, args }, ops) => {
    let length = ops.length;
    runtime.scan(args.length);
    for (const item of args) ops.set(length++, item);
    ops.setLength(length);
    return length;
  });
  arrayMethod(builder, 'pop', 0, (_, ops) => {
    const { length } = ops;
    if (length === 0) {
      ops.setLength(0);
      return;
    }
    const element = ops.get(length - 1);
    ops.delete(length - 1);
    ops.setLength(length - 1);
    return element;
  });
  arrayMethod(builder, 'shift', 0, ({ runtime }, ops) => {
    const { length } = ops;
    if (length === 0) {
      ops.setLength(0);
      return;
    }
    runtime.scan(length);
    const first = ops.get(0);
    for (let index = 1; index < length; index++) ops.move(index, index - 1);
    ops.delete(length - 1);
    ops.setLength(length - 1);
    return first;
  });
  arrayMethod(builder, 'unshift', 1, ({ runtime, args }, ops) => {
    const { length } = ops;
    runtime.scan(length + args.length);
    if (args.length > 0) {
      for (let index = length; index > 0; index--) ops.move(index - 1, index + args.length - 1);
      for (const [index, item] of args.entries()) ops.set(index, item);
    }
    ops.setLength(length + args.length);
    return length + args.length;
  });
  arrayMethod(builder, 'splice', 2, splice);
}

// code-gauge-allow functionCognitiveComplexity 22 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function splice({ runtime, args }: NativeCall, ops: ArrayOps): JsArray {
  const { length } = ops;
  const start = relativeIndex(runtime, args[0], length, 0);
  const deleteCount =
    args.length === 0
      ? 0
      : args.length === 1
        ? length - start
        : Math.min(Math.max(toInteger(runtime, args[1]), 0), length - start);
  const items = args.slice(2);
  runtime.scan(length + items.length);
  const removed = buildArray(runtime, (result) => {
    for (let index = 0; index < deleteCount; index++) {
      if (ops.has(start + index)) result.set(index, ops.get(start + index));
    }
    result.setLength(deleteCount);
  });
  return runtime.hold(removed, () => {
    if (items.length < deleteCount) {
      for (let index = start; index < length - deleteCount; index++)
        ops.move(index + deleteCount, index + items.length);
      for (let index = length; index > length - deleteCount + items.length; index--) ops.delete(index - 1);
    } else if (items.length > deleteCount) {
      for (let index = length - deleteCount; index > start; index--) {
        ops.move(index + deleteCount - 1, index + items.length - 1);
      }
    }
    for (const [index, item] of items.entries()) ops.set(start + index, item);
    ops.setLength(length - deleteCount + items.length);
    return removed;
  });
}

// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineReorderings(builder: RealmBuilder): void {
  arrayMethod(builder, 'reverse', 0, ({ runtime }, ops) => {
    const { length } = ops;
    runtime.scan(length);
    for (let lower = 0; lower < Math.floor(length / 2); lower++) {
      const upper = length - lower - 1;
      const lowerExists = ops.has(lower);
      const lowerValue = lowerExists ? ops.get(lower) : undefined;
      const upperExists = ops.has(upper);
      const upperValue = upperExists ? ops.get(upper) : undefined;
      if (upperExists) ops.set(lower, upperValue);
      else if (lowerExists) ops.delete(lower);
      if (lowerExists) ops.set(upper, lowerValue);
      else if (upperExists) ops.delete(upper);
    }
    return ops.array;
  });
  arrayMethod(builder, 'fill', 1, ({ runtime, args }, ops) => {
    const { length } = ops;
    const start = relativeIndex(runtime, args[1], length, 0);
    const end = relativeIndex(runtime, args[2], length, length);
    runtime.scan(end - start);
    for (let index = start; index < end; index++) ops.set(index, args[0]);
    return ops.array;
  });
  arrayMethod(builder, 'sort', 1, sortArray);
}

function sortArray(call: NativeCall, ops: ArrayOps): JsArray {
  const { runtime } = call;
  const compare = sortComparison(call);
  const { length } = ops;
  // SortIndexedProperties collects the present elements into a list, held while the comparator runs.
  const collected = buildArray(runtime, (items) => {
    for (let index = 0; index < length; index++) if (ops.has(index)) items.set(items.length, ops.get(index));
  });
  runtime.scan(collected.elements.length * Math.ceil(Math.log2(collected.elements.length + 1)));
  return runtime.hold(collected, () => {
    // The host's sort also places undefined last without calling the comparison.
    const sorted = (collected.elements as Value[]).toSorted(compare);
    for (const [index, value] of sorted.entries()) ops.set(index, value);
    for (let index = sorted.length; index < length; index++) ops.delete(index);
    return ops.array;
  });
}

/**
 * The spec's SortCompare with the comparator `call.args[0]`, which the host's sort calls only on values other than
 * undefined, as SortCompare does.
 */
export function sortComparison({ runtime, args, callRow }: NativeCall): (left: Value, right: Value) => number {
  const comparator = args[0];
  if (comparator !== undefined && !isCallable(comparator)) {
    runtime.throwError('TypeError', 'The comparison function must be either a function or undefined');
  }
  return comparator
    ? (left, right) => runtime.toNumber(runtime.call(comparator, undefined, [left, right], callRow)) || 0
    : (left, right) => {
        const leftText = runtime.toString(left);
        const rightText = runtime.toString(right);
        return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
      };
}

// code-gauge-allow functionCognitiveComplexity 25 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineCopies(builder: RealmBuilder): void {
  arrayMethod(builder, 'slice', 2, ({ runtime, args }, ops) => {
    const { length } = ops;
    const start = relativeIndex(runtime, args[0], length, 0);
    const end = relativeIndex(runtime, args[1], length, length);
    runtime.scan(end - start);
    return buildArray(runtime, (result) => {
      for (let index = start; index < end; index++) if (ops.has(index)) result.set(index - start, ops.get(index));
      result.setLength(Math.max(end - start, 0));
    });
  });
  arrayMethod(builder, 'concat', 1, ({ runtime, args }, ops) =>
    buildArray(runtime, (result) => {
      let next = 0;
      for (const item of [ops.array, ...args]) {
        if (!(item instanceof JsArray)) {
          result.set(next++, item);
          continue;
        }
        const source = new ArrayOps(runtime, item);
        const { length } = source;
        runtime.scan(length);
        for (let index = 0; index < length; index++, next++) if (source.has(index)) result.set(next, source.get(index));
      }
      result.setLength(next);
    })
  );
  arrayMethod(builder, 'flat', 0, ({ runtime, args }, ops) => {
    const depth = args[0] === undefined ? 1 : Math.max(toInteger(runtime, args[0]), 0);
    return buildArray(runtime, (result) => flattenInto(runtime, result, ops, Math.min(depth, 100)));
  });
}

/** The spec's FlattenIntoArray without a mapper: appends the present elements, flattening nested arrays. */
export function flattenInto(runtime: Runtime, target: ArrayOps, source: ArrayOps, depth: number): void {
  const { length } = source;
  runtime.scan(length);
  for (let index = 0; index < length; index++) {
    if (!source.has(index)) continue;
    const element = source.get(index);
    if (depth > 0 && element instanceof JsArray)
      flattenInto(runtime, target, new ArrayOps(runtime, element), depth - 1);
    else target.set(target.length, element);
  }
}

function defineSearches(builder: RealmBuilder): void {
  arrayMethod(builder, 'join', 1, ({ runtime, args }, ops) => joinArray(runtime, ops, args[0], new Set()));
  arrayMethod(builder, 'toString', 0, ({ runtime }, ops) => joinArray(runtime, ops, undefined, new Set()));
  arrayMethod(builder, 'at', 1, ({ runtime, args }, ops) => {
    const { length } = ops;
    const relative = toInteger(runtime, args[0]);
    const index = relative >= 0 ? relative : length + relative;
    return index < 0 || index >= length ? undefined : ops.get(index);
  });
  arrayMethod(builder, 'indexOf', 1, ({ runtime, args }, ops) => indexOf(runtime, ops, args, false));
  arrayMethod(builder, 'lastIndexOf', 1, ({ runtime, args }, ops) => indexOf(runtime, ops, args, true));
  arrayMethod(builder, 'includes', 1, ({ runtime, args }, ops) => includes(runtime, ops, args));
}

/** The spec's indexOf and lastIndexOf: strict equality, skipping absent elements. */
function indexOf(runtime: Runtime, ops: ArrayOps, args: Value[], fromEnd: boolean): number {
  const { length } = ops;
  runtime.scan(length);
  const start = args.length < 2 ? (fromEnd ? length - 1 : 0) : toInteger(runtime, args[1]);
  const step = fromEnd ? -1 : 1;
  let index = fromEnd
    ? start < 0
      ? length + start
      : Math.min(start, length - 1)
    : start < 0
      ? Math.max(length + start, 0)
      : start;
  for (; index >= 0 && index < length; index += step) {
    if (ops.has(index) && ops.get(index) === args[0]) return index;
  }
  return -1;
}

/** The spec's includes: SameValueZero, which matches NaN with NaN and 0 with -0, reading absent elements as undefined. */
function includes(runtime: Runtime, ops: ArrayOps, args: Value[]): boolean {
  const { length } = ops;
  runtime.scan(length);
  const start = args.length < 2 ? 0 : toInteger(runtime, args[1]);
  for (let index = start < 0 ? Math.max(length + start, 0) : start; index < length; index++) {
    const element = ops.get(index);
    if (element === args[0] || (Number.isNaN(element) && Number.isNaN(args[0]))) return true;
  }
  return false;
}

function joinArray(runtime: Runtime, ops: ArrayOps, separatorValue: Value, joining: Set<JsArray>): string {
  if (joining.has(ops.array)) return '';
  // The length is read before any conversion, which may run the program's code and change the array.
  const { length } = ops;
  const separator = separatorValue === undefined ? ',' : runtime.toString(separatorValue);
  joining.add(ops.array);
  runtime.scan(length);
  try {
    let text = '';
    for (let index = 0; index < length; index++) {
      const element = ops.get(index);
      let part = index > 0 ? separator : '';
      if (element instanceof JsArray) part += joinArray(runtime, new ArrayOps(runtime, element), undefined, joining);
      else if (element !== undefined && element !== null) part += runtime.toString(element);
      runtime.extendString(text.length + part.length, part.length);
      text += part;
    }
    return text;
  } finally {
    joining.delete(ops.array);
  }
}
