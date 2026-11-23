import { ArrayOps } from './arrayOps';
import { DONE } from './iteration';
import type { RealmBuilder } from './realm';
import { defineArrayCopies } from './realmArrayCopies';
import { defineArrayIterations } from './realmArrayIterations';
import { objectToString } from './realmGlobals';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  isCallable,
  isObject,
  JsArray,
  JsFunction,
  type JsObject,
  JsThrow,
  type NativeCall,
  type Value,
} from './values';

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
    array.setPrototype(runtime.prototypeFor(newTarget, arrayPrototype));
    return array;
  });
  builder.getter(arrayConstructor, WELL_KNOWN_SYMBOLS.species, ({ thisValue }) => thisValue);
  builder.method(arrayConstructor, 'isArray', 1, ({ args }) => args[0] instanceof JsArray);
  builder.method(arrayConstructor, 'of', 0, ({ runtime, thisValue, args }) =>
    buildWith(runtime, thisValue, args.length, (result) => {
      for (const [index, value] of args.entries()) result.create(index, value);
      result.setLength(args.length);
    })
  );
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
    if ((thisValue === undefined || thisValue === null) && NAMED_RECEIVER_ERRORS.has(name)) {
      return runtime.throwError('TypeError', `Array.prototype.${name} called on null or undefined`);
    }
    return run(call, new ArrayOps(runtime, runtime.toObject(thisValue)));
  });
}

/** The methods whose V8 error for a null or undefined receiver names them; the others report ToObject's error. */
const NAMED_RECEIVER_ERRORS = new Set([
  'concat',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'indexOf',
  'map',
  'reduce',
  'reduceRight',
  'some',
]);

/** A new array that the builder's steps fill through {@link ArrayOps}, held so that its values stay reachable. */
export function buildArray(runtime: Runtime, build: (ops: ArrayOps) => void): JsArray {
  const array = runtime.newArray([]);
  runtime.hold(array, () => build(new ArrayOps(runtime, array)));
  return array;
}

/** The spec's ArraySpeciesCreate, whose result the builder fills at its algorithm-owned indices. */
export function buildSpeciesArray(
  runtime: Runtime,
  original: JsObject,
  length: number,
  build: (ops: ArrayOps) => void
): JsObject {
  let constructor = original instanceof JsArray ? runtime.get(original, 'constructor') : undefined;
  if (isObject(constructor)) constructor = runtime.get(constructor, WELL_KNOWN_SYMBOLS.species) ?? undefined;
  if (constructor === undefined)
    return buildArray(runtime, (result) => {
      result.setLength(length);
      build(result);
    });
  if (!(constructor instanceof JsFunction) || !constructor.isConstructor)
    runtime.throwError('TypeError', 'object.constructor[Symbol.species] is not a constructor');
  const result = runtime.construct(constructor, [length]);
  runtime.hold(result, () => build(new ArrayOps(runtime, result)));
  return result;
}

/**
 * A new array that `Array.from` or `Array.of` called on `constructor` fills: an instance of a subclass of Array called
 * on it, made with `length` when the source has one, or else an array.
 */
function buildWith(
  runtime: Runtime,
  constructor: Value,
  length: number | undefined,
  build: (ops: ArrayOps) => void
): JsObject {
  if (!(constructor instanceof JsFunction) || !constructor.isConstructor) {
    return buildArray(runtime, build);
  }
  const result = runtime.construct(constructor, length === undefined ? [] : [length]);
  runtime.hold(result, () => build(new ArrayOps(runtime, result)));
  return result;
}

// code-gauge-allow functionCognitiveComplexity -- Transcribes the specification's Array.from step by step, whose branches mirror its steps.
function arrayFrom({ runtime, thisValue, args, callRow }: NativeCall): JsObject {
  const [source, mapper, thisArg] = args;
  if (mapper !== undefined && !isCallable(mapper)) {
    runtime.throwError('TypeError', `${runtime.describeTyped(mapper)} is not a function`);
  }
  if (source === undefined || source === null) runtime.iterator(source);
  const method = runtime.get(source, WELL_KNOWN_SYMBOLS.iterator);
  if (method !== undefined && method !== null && !isCallable(method))
    runtime.throwError('TypeError', `${runtime.describeTyped(method)} is not a function`);
  const iterable = method !== undefined && method !== null;
  const length = iterable ? undefined : toLength(runtime, runtime.get(runtime.toObject(source), 'length'));
  return buildWith(runtime, thisValue, length, (result) => {
    const add = (value: Value, index: number): void =>
      result.create(index, mapper ? runtime.call(mapper, thisArg, [value, index], callRow) : value);
    if (method !== undefined && method !== null) {
      // Each value is read just before its mapper runs, as JavaScript's iteration does.
      const iterator = runtime.iterator(source, method);
      try {
        let index = 0;
        for (let value = iterator.next(); value !== DONE; value = iterator.next()) add(value, index++);
        result.setLength(index);
      } catch (error) {
        // A mapper that throws closes the iterator; a failed `next()` has already ended it.
        if (error instanceof JsThrow) iterator.close('throw');
        throw error;
      }
      return;
    }
    const object = runtime.toObject(source);
    for (let index = 0; index < (length ?? 0); index++) add(runtime.get(object, String(index)), index);
    result.setLength(length ?? 0);
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

// code-gauge-allow functionCognitiveComplexity -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
// code-gauge-allow functionNcss -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
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

// code-gauge-allow functionCognitiveComplexity -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function splice({ runtime, args }: NativeCall, ops: ArrayOps): JsObject {
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
  const removed = buildSpeciesArray(runtime, ops.array, deleteCount, (result) => {
    for (let index = 0; index < deleteCount; index++) {
      if (ops.has(start + index)) result.create(index, ops.get(start + index));
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

// code-gauge-allow functionCognitiveComplexity -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
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

function sortArray(call: NativeCall, ops: ArrayOps): JsObject {
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
    runtime.throwError(
      'TypeError',
      `The comparison function must be either a function or undefined: ${runtime.describePlain(comparator)}`
    );
  }
  return comparator
    ? (left, right) => runtime.toNumber(runtime.call(comparator, undefined, [left, right], callRow)) || 0
    : (left, right) => {
        const leftText = runtime.toString(left);
        const rightText = runtime.toString(right);
        return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
      };
}

// code-gauge-allow functionCognitiveComplexity -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineCopies(builder: RealmBuilder): void {
  arrayMethod(builder, 'slice', 2, ({ runtime, args }, ops) => {
    const { length } = ops;
    const start = relativeIndex(runtime, args[0], length, 0);
    const end = relativeIndex(runtime, args[1], length, length);
    runtime.scan(end - start);
    return buildSpeciesArray(runtime, ops.array, Math.max(end - start, 0), (result) => {
      for (let index = start; index < end; index++) if (ops.has(index)) result.create(index - start, ops.get(index));
      result.setLength(Math.max(end - start, 0));
    });
  });
  arrayMethod(builder, 'concat', 1, ({ runtime, args }, ops) =>
    buildSpeciesArray(runtime, ops.array, 0, (result) => {
      let next = 0;
      for (const item of [ops.array, ...args]) {
        if (!(item instanceof JsArray)) {
          result.create(next++, item);
          continue;
        }
        const source = new ArrayOps(runtime, item);
        const { length } = source;
        runtime.scan(length);
        for (let index = 0; index < length; index++, next++)
          if (source.has(index)) result.create(next, source.get(index));
      }
      result.setLength(next);
    })
  );
  arrayMethod(builder, 'flat', 0, ({ runtime, args }, ops) => {
    const length = ops.length;
    const depth = args[0] === undefined ? 1 : Math.max(toInteger(runtime, args[0]), 0);
    return buildSpeciesArray(runtime, ops.array, 0, (result) =>
      flattenInto(runtime, result, ops, Math.min(depth, 100), { length })
    );
  });
}

/** The spec's FlattenIntoArray without a mapper: appends the present elements, flattening nested arrays. */
export function flattenInto(
  runtime: Runtime,
  target: ArrayOps,
  source: ArrayOps,
  depth: number,
  options: { start?: number; length?: number } = {}
): number {
  const length = options.length ?? source.length;
  let next = options.start ?? 0;
  runtime.scan(length);
  for (let index = 0; index < length; index++) {
    if (!source.has(index)) continue;
    const element = source.get(index);
    if (depth > 0 && element instanceof JsArray)
      next = flattenInto(runtime, target, new ArrayOps(runtime, element), depth - 1, { start: next });
    else target.create(next++, element);
  }
  return next;
}

function defineSearches(builder: RealmBuilder): void {
  arrayMethod(builder, 'join', 1, ({ runtime, args }, ops) => {
    // The length is read before the separator's conversion, which may run the program's code and change the array.
    const { length } = ops;
    const separator = args[0] === undefined ? ',' : runtime.toString(args[0]);
    return cycleProtectedJoin(runtime, ops, length, separator, (element) => runtime.toString(element));
  });
  arrayMethod(builder, 'toString', 0, ({ runtime }, ops) => {
    const join = runtime.get(ops.array, 'join');
    return isCallable(join) ? runtime.call(join, ops.array, []) : objectToString(runtime, ops.array);
  });
  // V8 passes each element's toLocaleString both the locales and the options, even when the array was given neither.
  arrayMethod(builder, 'toLocaleString', 0, ({ runtime, args, callRow }, ops) =>
    cycleProtectedJoin(runtime, ops, ops.length, ',', (element) => {
      const method = runtime.get(element, 'toLocaleString');
      if (!isCallable(method))
        return runtime.throwError('TypeError', `${runtime.describeTyped(method)} is not a function`);
      return runtime.toString(runtime.call(method, element, [args[0], args[1]], callRow));
    })
  );
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

/**
 * V8's CycleProtectedArrayJoin: joins the formatted elements below `length`, formatting absent and nullish ones as
 * empty, while an array whose join, toString, or toLocaleString is already running anywhere in the runtime joins as
 * empty, so that cyclic arrays format as V8 formats them.
 */
function cycleProtectedJoin(
  runtime: Runtime,
  ops: ArrayOps,
  length: number,
  separator: string,
  format: (element: Value) => string
): string {
  let joining = joiningArrays.get(runtime);
  if (!joining) {
    joining = new Set();
    joiningArrays.set(runtime, joining);
  }
  if (length === 0 || joining.has(ops.array)) return '';
  joining.add(ops.array);
  runtime.scan(length);
  try {
    let text = '';
    for (let index = 0; index < length; index++) {
      const element = ops.get(index);
      const part = (index > 0 ? separator : '') + (element === undefined || element === null ? '' : format(element));
      runtime.extendString(text.length + part.length, part.length);
      text += part;
    }
    return text;
  } finally {
    joining.delete(ops.array);
  }
}

const joiningArrays = new WeakMap<Runtime, Set<JsObject>>();
