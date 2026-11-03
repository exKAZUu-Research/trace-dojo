import type { RealmBuilder } from './realm';
import type { Runtime } from './runtime';
import {
  appendAll,
  type Element,
  HOLE,
  isCallable,
  JsArray,
  type JsFunction,
  type NativeCall,
  toBoolean,
  type Value,
  valueOfElement,
} from './values';

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
        array.elements[index] = runtime.call(mapper, undefined, [valueOfElement(value), index], callRow);
      }
    }
    return array;
  });
}

/** Reads the values of an array, a string, or an object with a `length` into `elements`. */
function readArrayLike(runtime: Runtime, source: Value, elements: Element[]): void {
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

// code-gauge-allow functionNcss 40 -- Lists the builtin methods, each a small closure of its own.
function defineMutators(builder: RealmBuilder): void {
  arrayMethod(builder, 'push', 1, ({ runtime, args }, array) => {
    runtime.allocate(args.length);
    appendAll(array.elements, args);
    return array.elements.length;
  });
  arrayMethod(builder, 'pop', 0, (_, array) => valueOfElement(array.elements.pop()));
  arrayMethod(builder, 'shift', 0, ({ runtime }, array) => {
    runtime.scan(array.elements.length);
    return valueOfElement(array.elements.shift());
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
  arrayMethod(builder, 'sort', 1, sortArray);
}

function sortArray({ runtime, args, callRow }: NativeCall, array: JsArray): JsArray {
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
  // The host's sort also places undefined last without calling the comparison; holes go after it.
  const sorted = (elements.filter((element) => element !== HOLE) as Value[]).toSorted(compare);
  for (const index of elements.keys()) elements[index] = index < sorted.length ? sorted[index] : HOLE;
  return array;
}

function defineAccessors(builder: RealmBuilder): void {
  arrayMethod(builder, 'slice', 2, ({ runtime, args }, array) => {
    const { elements } = array;
    const start = relativeIndex(runtime, args[0], elements.length, 0);
    const end = relativeIndex(runtime, args[1], elements.length, elements.length);
    return runtime.newArray(elements.slice(start, Math.max(start, end)));
  });
  arrayMethod(builder, 'concat', 1, ({ runtime, args }, array) => concatArrays(runtime, [array, ...args]));

  arrayMethod(builder, 'join', 1, ({ runtime, args }, array) => joinArray(runtime, array, args[0], new Set()));
  arrayMethod(builder, 'toString', 0, ({ runtime }, array) => joinArray(runtime, array, undefined, new Set()));
  arrayMethod(builder, 'at', 1, ({ runtime, args }, array) => {
    const index = Math.trunc(runtime.toNumber(args[0])) || 0;
    return valueOfElement(array.elements.at(index));
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
    const result = runtime.newArray([]);
    flatten(runtime, array.elements, Math.min(depth, 100), result.elements);
    return result;
  });
}

/**
 * Searches with the host's methods, which treat an explicit undefined start as 0 unlike an omitted one. A hole never
 * equals a value, as indexOf skips holes, but includes reads it as undefined.
 */
function search(
  elements: Element[],
  name: 'indexOf' | 'lastIndexOf' | 'includes',
  value: Value,
  start: number | undefined
): number | boolean {
  if (name === 'includes') {
    const values = elements.map(valueOfElement);
    return start === undefined ? values.includes(value) : values.includes(value, start);
  }
  if (name === 'indexOf') return start === undefined ? elements.indexOf(value) : elements.indexOf(value, start);
  return start === undefined ? elements.lastIndexOf(value) : elements.lastIndexOf(value, start);
}

/** Appends the elements of nested arrays, charging for each array before copying it, as one array may recur. */
function flatten(runtime: Runtime, elements: Element[], depth: number, values: Element[]): void {
  runtime.allocate(elements.length);
  for (const element of elements) {
    if (element instanceof JsArray && depth > 0) flatten(runtime, element.elements, depth - 1, values);
    else if (element !== HOLE) values.push(element);
  }
}

/** Concatenates arrays and values, charging the result before copying, since it can be far larger than every input. */
function concatArrays(runtime: Runtime, parts: Value[]): JsArray {
  let length = 0;
  for (const part of parts) length += part instanceof JsArray ? part.elements.length : 1;
  const result = runtime.newArray([]);
  runtime.allocate(length);
  for (const part of parts) {
    if (part instanceof JsArray) appendAll(result.elements, part.elements);
    else result.elements.push(part);
  }
  return result;
}

function joinArray(runtime: Runtime, array: JsArray, separatorValue: Value, joining: Set<JsArray>): string {
  if (joining.has(array)) return '';
  const separator = separatorValue === undefined ? ',' : runtime.toString(separatorValue);
  joining.add(array);
  runtime.scan(array.elements.length);
  try {
    let text = '';
    for (const [index, element] of array.elements.entries()) {
      let part = index > 0 ? separator : '';
      if (element instanceof JsArray) part += joinArray(runtime, element, undefined, joining);
      else if (element !== undefined && element !== null && element !== HOLE) part += runtime.toString(element);
      runtime.extendString(text.length + part.length, part.length);
      text += part;
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
    forEachElement(array, callback);
    return;
  });
  iterationMethod(builder, 'map', (array, callback, { runtime }) => {
    const result = runtime.newArray([]);
    runtime.setLength(result, array.elements.length);
    runtime.hold(result, () =>
      forEachElement(array, (value, index) => (result.elements[index] = callback(value, index)))
    );
    return result;
  });
  iterationMethod(builder, 'filter', (array, callback, { runtime }) => {
    const result = runtime.newArray([]);
    runtime.hold(result, () =>
      forEachElement(array, (value, index) => {
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
      forEachElement(array, (value, index) => {
        const mapped = callback(value, index);
        if (mapped instanceof JsArray) {
          flatten(runtime, mapped.elements, 0, values);
        } else {
          runtime.allocate(1);
          values.push(mapped);
        }
      })
    );
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
    // These visit holes as undefined, unlike some and every.
    iterationMethod(builder, name, (array, callback) => {
      const found = findElement(array, callback, fromEnd, false);
      return returnsIndex ? found.index : found.value;
    });
  }
  iterationMethod(builder, 'some', (array, callback) => findElement(array, callback, false, true).index !== -1);
  iterationMethod(
    builder,
    'every',
    (array, callback) =>
      findElement(array, (value, index) => !toBoolean(callback(value, index)), false, true).index === -1
  );
}

/**
 * The first element (or the last with `fromEnd`) for which `callback` returns a truthy value, as the callback saw it,
 * or index -1.
 */
function findElement(
  array: JsArray,
  callback: Callback,
  fromEnd: boolean,
  skipsHoles: boolean
): { index: number; value: Value } {
  const length = array.elements.length;
  for (let step = 0; step < length; step++) {
    const index = fromEnd ? length - 1 - step : step;
    const element = array.elements[index];
    if (element === HOLE && skipsHoles) continue;
    const value = valueOfElement(element);
    if (toBoolean(callback(value, index))) return { index, value };
  }
  return { index: -1, value: undefined };
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
  const indices = Array.from({ length }, (_, step) => (fromEnd ? length - 1 - step : step)).filter(
    (index) => array.elements[index] !== HOLE
  );
  let accumulator: Value;
  if (args.length >= 2) {
    accumulator = args[1];
  } else {
    const first = indices.shift();
    if (first === undefined) return runtime.throwError('TypeError', 'Reduce of empty array with no initial value');
    accumulator = valueOfElement(array.elements[first]);
  }
  for (const index of indices) {
    const element = index < array.elements.length ? array.elements[index] : HOLE;
    if (element === HOLE) continue;
    accumulator = runtime.call(fn, undefined, [accumulator, element, index, array], callRow);
  }
  return accumulator;
}

/**
 * Visits the elements present when the iteration started that are still present, skipping holes as the spec's
 * `HasProperty` does.
 */
function forEachElement(array: JsArray, visit: (value: Value, index: number) => void): void {
  const length = array.elements.length;
  for (let index = 0; index < length && index < array.elements.length; index++) {
    const element = array.elements[index];
    if (element !== HOLE) visit(element, index);
  }
}
