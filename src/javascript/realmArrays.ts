import type { RealmBuilder } from './realm';
import type { Runtime } from './runtime';
import { appendAll, isCallable, JsArray, type JsFunction, type NativeCall, toBoolean, type Value } from './values';

export function defineArrayBuiltins(builder: RealmBuilder): void {
  const { arrayPrototype } = builder.realm;
  const arrayConstructor = builder.defineClass('Array', 1, arrayPrototype, ({ runtime, args }) => {
    if (args.length === 1 && typeof args[0] === 'number') {
      const array = runtime.newArray([]);
      runtime.setLength(array, args[0]);
      return array;
    }
    return runtime.newArray([...args]);
  });
  builder.method(arrayConstructor, 'isArray', 1, ({ args }) => args[0] instanceof JsArray);
  builder.method(arrayConstructor, 'of', 0, ({ runtime, args }) => runtime.newArray([...args]));
  builder.method(arrayConstructor, 'from', 1, arrayFrom);
  defineMutators(builder);
  defineAccessors(builder);
  defineIterations(builder);
}

function arrayFrom({ runtime, args, callRow }: NativeCall): JsArray {
  const [source, mapper] = args;
  if (mapper !== undefined && !isCallable(mapper)) {
    runtime.throwError('TypeError', `${runtime.describe(mapper)} is not a function`);
  }
  // The array is built in place so that the values read and mapped so far stay reachable during callbacks.
  const array = runtime.newArray([]);
  return runtime.hold(array, () => {
    readArrayLike(runtime, source, array.elements);
    if (mapper) {
      for (const [index, value] of array.elements.entries()) {
        array.elements[index] = runtime.call(mapper, undefined, [value, index], callRow);
      }
    }
    return array;
  });
}

/** Reads the values of an array, a string, or an object with a `length` into `elements`. */
function readArrayLike(runtime: Runtime, source: Value, elements: Value[]): void {
  if (source instanceof JsArray || typeof source === 'string') {
    const items = runtime.iterate(source);
    runtime.allocate(items.length);
    appendAll(elements, items);
    return;
  }
  const length = toLength(runtime, source === undefined || source === null ? undefined : runtime.get(source, 'length'));
  runtime.allocate(length);
  for (let index = 0; index < length; index++) elements.push(runtime.get(source, String(index)));
}

function toLength(runtime: Runtime, value: Value): number {
  const length = Math.trunc(runtime.toNumber(value));
  return Number.isNaN(length) || length < 0 ? 0 : Math.min(length, Number.MAX_SAFE_INTEGER);
}

function thisArray(runtime: Runtime, value: Value, name: string): JsArray {
  if (!(value instanceof JsArray)) return runtime.throwError('TypeError', `Array.prototype.${name} requires an array`);
  return value;
}

/** Resolves a relative index argument as `slice` and `splice` do. */
function relativeIndex(runtime: Runtime, value: Value, length: number, fallback: number): number {
  if (value === undefined) return fallback;
  const index = Math.trunc(runtime.toNumber(value)) || 0;
  if (index < 0) return Math.max(length + index, 0);
  return Math.min(index, length);
}

type ArrayMethod = (call: NativeCall, array: JsArray) => Value;

function arrayMethod(builder: RealmBuilder, name: string, length: number, run: ArrayMethod): void {
  builder.method(builder.realm.arrayPrototype, name, length, (call) =>
    run(call, thisArray(call.runtime, call.thisValue, name))
  );
}

// code-gauge-allow functionCognitiveComplexity 23 -- Lists the builtin methods, each a small closure of its own.
// code-gauge-allow functionNcss 53 -- Lists the builtin methods, each a small closure of its own.
function defineMutators(builder: RealmBuilder): void {
  arrayMethod(builder, 'push', 1, ({ runtime, args }, array) => {
    runtime.allocate(args.length);
    appendAll(array.elements, args);
    return array.elements.length;
  });
  arrayMethod(builder, 'pop', 0, (_, array) => array.elements.pop());
  arrayMethod(builder, 'shift', 0, ({ runtime }, array) => {
    runtime.scan(array.elements.length);
    return array.elements.shift();
  });
  arrayMethod(builder, 'unshift', 1, ({ runtime, args }, array) => {
    runtime.allocate(args.length);
    runtime.scan(array.elements.length);
    const rest = array.elements.splice(0);
    appendAll(array.elements, args);
    appendAll(array.elements, rest);
    return array.elements.length;
  });
  arrayMethod(builder, 'splice', 2, ({ runtime, args }, array) => {
    const { elements } = array;
    const start = relativeIndex(runtime, args[0], elements.length, 0);
    const deleteCount =
      args.length === 0
        ? 0
        : args.length === 1
          ? elements.length - start
          : Math.min(Math.max(Math.trunc(runtime.toNumber(args[1])) || 0, 0), elements.length - start);
    const items = args.slice(2);
    runtime.allocate(items.length);
    runtime.scan(elements.length);
    const rest = elements.splice(start);
    const removed = rest.splice(0, deleteCount);
    appendAll(elements, items);
    appendAll(elements, rest);
    return runtime.newArray(removed);
  });
  arrayMethod(builder, 'reverse', 0, ({ runtime }, array) => {
    runtime.scan(array.elements.length);
    array.elements.reverse();
    return array;
  });
  arrayMethod(builder, 'fill', 1, ({ runtime, args }, array) => {
    const { elements } = array;
    const start = relativeIndex(runtime, args[1], elements.length, 0);
    const end = relativeIndex(runtime, args[2], elements.length, elements.length);
    runtime.scan(end - start);
    elements.fill(args[0], start, end);
    return array;
  });
  arrayMethod(builder, 'sort', 1, ({ runtime, args, callRow }, array) => {
    const comparator = args[0];
    if (comparator !== undefined && !isCallable(comparator)) {
      runtime.throwError('TypeError', 'The comparison function must be either a function or undefined');
    }
    const { elements } = array;
    runtime.scan(elements.length * Math.ceil(Math.log2(elements.length + 1)));
    const compare = comparator
      ? (left: Value, right: Value): number =>
          runtime.toNumber(runtime.call(comparator, undefined, [left, right], callRow)) || 0
      : (left: Value, right: Value): number => {
          const leftText = runtime.toString(left);
          const rightText = runtime.toString(right);
          return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
        };
    // The host's sort also places undefined last without calling the comparison.
    const sorted = elements.toSorted(compare);
    for (const [index, value] of sorted.entries()) elements[index] = value;
    return array;
  });
}

function defineAccessors(builder: RealmBuilder): void {
  arrayMethod(builder, 'slice', 2, ({ runtime, args }, array) => {
    const { elements } = array;
    const start = relativeIndex(runtime, args[0], elements.length, 0);
    const end = relativeIndex(runtime, args[1], elements.length, elements.length);
    return runtime.newArray(elements.slice(start, Math.max(start, end)));
  });
  arrayMethod(builder, 'concat', 1, ({ runtime, args }, array) => {
    const values = [...array.elements];
    for (const item of args) {
      if (item instanceof JsArray) appendAll(values, item.elements);
      else values.push(item);
    }
    return runtime.newArray(values);
  });
  arrayMethod(builder, 'join', 1, ({ runtime, args }, array) => joinArray(runtime, array, args[0], new Set()));
  arrayMethod(builder, 'toString', 0, ({ runtime }, array) => joinArray(runtime, array, undefined, new Set()));
  arrayMethod(builder, 'at', 1, ({ runtime, args }, array) => {
    const index = Math.trunc(runtime.toNumber(args[0])) || 0;
    return array.elements.at(index);
  });
  for (const name of ['indexOf', 'lastIndexOf', 'includes'] as const) {
    arrayMethod(builder, name, 1, ({ runtime, args }, array) => {
      runtime.scan(array.elements.length);
      return search(
        array.elements,
        name,
        args[0],
        args.length < 2 ? undefined : Math.trunc(runtime.toNumber(args[1])) || 0
      );
    });
  }
  arrayMethod(builder, 'flat', 0, ({ runtime, args }, array) => {
    const depth = args[0] === undefined ? 1 : Math.trunc(runtime.toNumber(args[0])) || 0;
    const values: Value[] = [];
    flatten(runtime, array.elements, Math.min(depth, 100), values);
    return runtime.newArray(values);
  });
}

/** Searches with the host's methods, which treat an explicit undefined start as 0 unlike an omitted one. */
function search(
  elements: Value[],
  name: 'indexOf' | 'lastIndexOf' | 'includes',
  value: Value,
  start: number | undefined
): number | boolean {
  if (name === 'includes') return start === undefined ? elements.includes(value) : elements.includes(value, start);
  if (name === 'indexOf') return start === undefined ? elements.indexOf(value) : elements.indexOf(value, start);
  return start === undefined ? elements.lastIndexOf(value) : elements.lastIndexOf(value, start);
}

function flatten(runtime: Runtime, elements: Value[], depth: number, values: Value[]): void {
  runtime.scan(elements.length);
  for (const element of elements) {
    if (element instanceof JsArray && depth > 0) flatten(runtime, element.elements, depth - 1, values);
    else values.push(element);
  }
}

function joinArray(runtime: Runtime, array: JsArray, separatorValue: Value, joining: Set<JsArray>): string {
  if (joining.has(array)) return '';
  const separator = separatorValue === undefined ? ',' : runtime.toString(separatorValue);
  joining.add(array);
  try {
    let text = '';
    for (const [index, element] of array.elements.entries()) {
      if (index > 0) text += separator;
      if (element === undefined || element === null) continue;
      text += element instanceof JsArray ? joinArray(runtime, element, undefined, joining) : runtime.toString(element);
      runtime.buildString(text.length);
    }
    return text;
  } finally {
    joining.delete(array);
  }
}

type Callback = (value: Value, index: number) => Value;
type Iteration = (array: JsArray, callback: Callback, call: NativeCall) => Value;

/** Defines a method that calls its first argument for elements, with its second argument as `this`. */
function iterationMethod(builder: RealmBuilder, name: string, run: Iteration): void {
  arrayMethod(builder, name, 1, (call, array) => {
    const { runtime, args, callRow } = call;
    const fn = args[0];
    if (!isCallable(fn)) return runtime.throwError('TypeError', `${runtime.describe(fn)} is not a function`);
    const thisArg = args[1];
    return run(array, (value, index) => runtime.call(fn, thisArg, [value, index, array], callRow), call);
  });
}

function defineIterations(builder: RealmBuilder): void {
  defineMappings(builder);
  defineFinders(builder);
  for (const fromEnd of [false, true]) {
    arrayMethod(builder, fromEnd ? 'reduceRight' : 'reduce', 1, ({ runtime, args, callRow }, array) => {
      const fn = args[0];
      if (!isCallable(fn)) return runtime.throwError('TypeError', `${runtime.describe(fn)} is not a function`);
      return reduce(runtime, array, fn, args, fromEnd, callRow);
    });
  }
}

function defineMappings(builder: RealmBuilder): void {
  iterationMethod(builder, 'forEach', (array, callback) => {
    forEachIndex(array, (index) => callback(array.elements[index], index));
    return;
  });
  iterationMethod(builder, 'map', (array, callback, { runtime }) => {
    const result = runtime.newArray([]);
    runtime.setLength(result, array.elements.length);
    runtime.hold(result, () =>
      forEachIndex(array, (index) => (result.elements[index] = callback(array.elements[index], index)))
    );
    return result;
  });
  iterationMethod(builder, 'filter', (array, callback, { runtime }) => {
    const result = runtime.newArray([]);
    runtime.hold(result, () =>
      forEachIndex(array, (index) => {
        const value = array.elements[index];
        if (toBoolean(callback(value, index))) result.elements.push(value);
      })
    );
    runtime.allocate(result.elements.length);
    return result;
  });
  iterationMethod(builder, 'flatMap', (array, callback, { runtime }) => {
    const result = runtime.newArray([]);
    const values = result.elements;
    runtime.hold(result, () =>
      forEachIndex(array, (index) => {
        const mapped = callback(array.elements[index], index);
        if (mapped instanceof JsArray) appendAll(values, mapped.elements);
        else values.push(mapped);
      })
    );
    runtime.allocate(values.length);
    return result;
  });
}

function defineFinders(builder: RealmBuilder): void {
  for (const [name, fromEnd, returnsIndex] of [
    ['find', false, false],
    ['findIndex', false, true],
    ['findLast', true, false],
    ['findLastIndex', true, true],
  ] as const) {
    iterationMethod(builder, name, (array, callback) => {
      const index = findIndex(array, callback, fromEnd);
      if (returnsIndex) return index;
      return index === -1 ? undefined : array.elements[index];
    });
  }
  iterationMethod(builder, 'some', (array, callback) => findIndex(array, callback, false) !== -1);
  iterationMethod(
    builder,
    'every',
    (array, callback) => findIndex(array, (value, index) => !toBoolean(callback(value, index)), false) === -1
  );
}

/** The index of the first element (or the last with `fromEnd`) for which `callback` returns a truthy value, or -1. */
function findIndex(array: JsArray, callback: Callback, fromEnd: boolean): number {
  const length = array.elements.length;
  for (let step = 0; step < length; step++) {
    const index = fromEnd ? length - 1 - step : step;
    if (toBoolean(callback(array.elements[index], index))) return index;
  }
  return -1;
}

function reduce(
  runtime: Runtime,
  array: JsArray,
  fn: JsFunction,
  args: Value[],
  fromEnd: boolean,
  callRow: number | undefined
): Value {
  const length = array.elements.length;
  const indices = Array.from({ length }, (_, step) => (fromEnd ? length - 1 - step : step));
  let accumulator: Value;
  if (args.length >= 2) {
    accumulator = args[1];
  } else {
    const first = indices.shift();
    if (first === undefined) return runtime.throwError('TypeError', 'Reduce of empty array with no initial value');
    accumulator = array.elements[first];
  }
  for (const index of indices) {
    if (index >= array.elements.length) continue;
    accumulator = runtime.call(fn, undefined, [accumulator, array.elements[index], index, array], callRow);
  }
  return accumulator;
}

/** Visits the indices present when the iteration started that are still present, as the spec's `HasProperty` does. */
function forEachIndex(array: JsArray, visit: (index: number) => void): void {
  const length = array.elements.length;
  for (let index = 0; index < length && index < array.elements.length; index++) visit(index);
}
