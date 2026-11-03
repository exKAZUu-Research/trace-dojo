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
  builder.method(arrayConstructor, 'from', 1, (call) => {
    const { runtime, args, callRow } = call;
    const [source, mapper] = args;
    if (mapper !== undefined && !isCallable(mapper))
      runtime.throwError('TypeError', `${runtime.describe(mapper)} is not a function`);
    let values: Value[];
    if (source instanceof JsArray || typeof source === 'string') {
      values = [...runtime.iterate(source)];
    } else {
      const length = toLength(
        runtime,
        source === undefined || source === null ? undefined : runtime.get(source, 'length')
      );
      runtime.allocate(length);
      values = Array.from({ length }, (_, index) => runtime.get(source, String(index)));
    }
    const array = runtime.newArray(values);
    if (mapper) {
      for (const [index, value] of values.entries()) {
        array.elements[index] = runtime.call(mapper, undefined, [value, index], callRow);
      }
    }
    return array;
  });
  defineMutators(builder);
  defineAccessors(builder);
  defineIterations(builder);
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
      const { elements } = array;
      runtime.scan(elements.length);
      // The host methods treat an explicit undefined start as 0, which differs from an omitted one for lastIndexOf.
      if (args.length < 2) {
        if (name === 'includes') return elements.includes(args[0]);
        return name === 'indexOf' ? elements.indexOf(args[0]) : elements.lastIndexOf(args[0]);
      }
      const start = Math.trunc(runtime.toNumber(args[1])) || 0;
      if (name === 'includes') return elements.includes(args[0], start);
      return name === 'indexOf' ? elements.indexOf(args[0], start) : elements.lastIndexOf(args[0], start);
    });
  }
  arrayMethod(builder, 'flat', 0, ({ runtime, args }, array) => {
    const depth = args[0] === undefined ? 1 : Math.trunc(runtime.toNumber(args[0])) || 0;
    const values: Value[] = [];
    const flatten = (elements: Value[], remaining: number): void => {
      runtime.scan(elements.length);
      for (const element of elements) {
        if (element instanceof JsArray && remaining > 0) flatten(element.elements, remaining - 1);
        else values.push(element);
      }
    };
    flatten(array.elements, Math.min(depth, 100));
    return runtime.newArray(values);
  });
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

function defineIterations(builder: RealmBuilder): void {
  const iteration = (name: string, run: (array: JsArray, callback: Callback, call: NativeCall) => Value): void => {
    arrayMethod(builder, name, 1, (call, array) => {
      const { runtime, args, callRow } = call;
      const fn = args[0];
      if (!isCallable(fn)) return runtime.throwError('TypeError', `${runtime.describe(fn)} is not a function`);
      const thisArg = args[1];
      return run(array, (value, index) => runtime.call(fn, thisArg, [value, index, array], callRow), call);
    });
  };
  iteration('forEach', (array, callback) => {
    forEachIndex(array, (index) => callback(array.elements[index], index));
    return;
  });
  iteration('map', (array, callback, { runtime }) => {
    const result = runtime.newArray([]);
    runtime.setLength(result, array.elements.length);
    forEachIndex(array, (index) => (result.elements[index] = callback(array.elements[index], index)));
    return result;
  });
  iteration('filter', (array, callback, { runtime }) => {
    const values: Value[] = [];
    forEachIndex(array, (index) => {
      const value = array.elements[index];
      if (toBoolean(callback(value, index))) values.push(value);
    });
    return runtime.newArray(values);
  });
  iteration('flatMap', (array, callback, { runtime }) => {
    const values: Value[] = [];
    forEachIndex(array, (index) => {
      const mapped = callback(array.elements[index], index);
      if (mapped instanceof JsArray) appendAll(values, mapped.elements);
      else values.push(mapped);
    });
    return runtime.newArray(values);
  });
  for (const [name, fromEnd, returnsIndex] of [
    ['find', false, false],
    ['findIndex', false, true],
    ['findLast', true, false],
    ['findLastIndex', true, true],
  ] as const) {
    iteration(name, (array, callback) => {
      const length = array.elements.length;
      for (let step = 0; step < length; step++) {
        const index = fromEnd ? length - 1 - step : step;
        const value = array.elements[index];
        if (toBoolean(callback(value, index))) return returnsIndex ? index : value;
      }
      return returnsIndex ? -1 : undefined;
    });
  }
  iteration('some', (array, callback) => {
    for (let index = 0; index < array.elements.length; index++) {
      if (toBoolean(callback(array.elements[index], index))) return true;
    }
    return false;
  });
  iteration('every', (array, callback) => {
    for (let index = 0; index < array.elements.length; index++) {
      if (!toBoolean(callback(array.elements[index], index))) return false;
    }
    return true;
  });
  for (const fromEnd of [false, true]) {
    arrayMethod(builder, fromEnd ? 'reduceRight' : 'reduce', 1, ({ runtime, args, callRow }, array) => {
      const fn = args[0];
      if (!isCallable(fn)) return runtime.throwError('TypeError', `${runtime.describe(fn)} is not a function`);
      return reduce(runtime, array, fn, args, fromEnd, callRow);
    });
  }
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
