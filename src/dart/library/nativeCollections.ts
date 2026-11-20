// code-gauge-allow-file fileNcss 984 -- The natives of List, Set, Map, and their iterators share the helpers of this file.
import type { TopLevelFunction } from '../environment';
import { stringOf } from '../format';
import { type HashPolicy, HashStore } from '../hashStore';
import { type Frame, Frame as FrameClass, type Runtime } from '../runtime';
import {
  coreTypes,
  type DartType,
  DYNAMIC,
  type InterfaceType,
  interfaceType,
  isSubtype,
  makeNullable,
} from '../types';
import { Cell, DartClosure, DartList, DartObject, type Value } from '../values';
import { identical, identityHashCode } from './nativeCore';
import {
  callFunction,
  castTo,
  checkElement,
  define,
  defineConstructor,
  elementTypeOf,
  forEachIteratorValue,
  forEachValue,
  implicitCast,
  index,
  intArg,
  iterableValues,
  named,
  nativeFunction,
  newList,
} from './nativeSupport';

const MAX_LIST_LENGTH = 576_460_752_303_423_487n;

function list(value: Value): DartList {
  return value as DartList;
}

function rangeError(
  runtime: Runtime,
  value: bigint | number,
  min: number,
  max: number | bigint,
  name: string | undefined
): never {
  runtime.throwError('RangeError', 'range', [BigInt(value), BigInt(min), BigInt(max), name]);
}

function checkIndex(runtime: Runtime, target: DartList, at: Value, name: string): number {
  const position = intArg(runtime, at, 'index');
  if (position < 0n || position >= BigInt(target.elements.length))
    rangeError(runtime, position, 0, target.elements.length - 1, name);
  return index(position);
}

function checkGrowable(runtime: Runtime, target: DartList, action: 'add' | 'remove' | 'clear' | 'length'): void {
  if (target.unmodifiable) {
    const messages = {
      add: 'Cannot add to an unmodifiable list',
      remove: 'Cannot remove from an unmodifiable list',
      clear: 'Cannot clear an unmodifiable list',
      length: 'Cannot change the length of an unmodifiable list',
    };
    runtime.throwError('UnsupportedError', '', [messages[action]]);
  }
  if (!target.growable) {
    const messages = {
      add: 'Cannot add to a fixed-length list',
      remove: 'Cannot remove from a fixed-length list',
      clear: 'Cannot clear a fixed-length list',
      length: 'Cannot change the length of a fixed-length list',
    };
    runtime.throwError('UnsupportedError', '', [messages[action]]);
  }
}

function checkModifiable(runtime: Runtime, target: DartList): void {
  if (target.unmodifiable) runtime.throwError('UnsupportedError', '', ['Cannot modify an unmodifiable list']);
}

function changed(target: DartList): void {
  target.modifications++;
}

function checkRange(runtime: Runtime, start: Value, end: Value, length: number, namedBounds = true): [number, number] {
  const from = intArg(runtime, start, 'start');
  if (from < 0n || from > BigInt(length)) rangeError(runtime, from, 0, length, namedBounds ? 'start' : undefined);
  const to = end === undefined ? BigInt(length) : intArg(runtime, end, 'end');
  if (to < from || to > BigInt(length)) rangeError(runtime, to, Number(from), length, namedBounds ? 'end' : undefined);
  return [index(from), index(to)];
}

// Constructors

defineConstructor('List.filled', (runtime, _instance, args, typeArgs) => {
  const length = intArg(runtime, args.positional[0], 'length');
  if (length < 0n || length > MAX_LIST_LENGTH) rangeError(runtime, length, 0, MAX_LIST_LENGTH, 'length');
  const count = index(length);
  runtime.allocate(count + 1);
  const fill = args.positional[1];
  return new DartList(
    coreTypes.list,
    typeArgs[0] ?? DYNAMIC,
    Array.from({ length: count }, () => fill),
    named(args.named, 'growable', false) === true
  );
});
defineConstructor(
  'List.empty',
  (_runtime, _instance, args, typeArgs) =>
    new DartList(coreTypes.list, typeArgs[0] ?? DYNAMIC, [], named(args.named, 'growable', false) === true)
);
defineConstructor('List.from', (runtime, _instance, args, typeArgs) => {
  const elementType = typeArgs[0] ?? DYNAMIC;
  const result = newList(runtime, elementType, [], named(args.named, 'growable', true) !== false);
  const frame = runtime.currentFrame;
  frame?.temporaries.push(result);
  try {
    forEachValue(runtime, args.positional[0], (value) => {
      implicitCast(runtime, value, elementType);
      runtime.allocate(1);
      result.elements.push(value);
    });
    return result;
  } finally {
    frame?.temporaries.pop();
  }
});
defineConstructor('List.of', (runtime, _instance, args, typeArgs) => {
  const values = iterableValues(runtime, args.positional[0]);
  runtime.allocate(values.length + 1);
  return new DartList(coreTypes.list, typeArgs[0] ?? DYNAMIC, values, named(args.named, 'growable', true) !== false);
});
defineConstructor('List.generate', (runtime, _instance, args, typeArgs) => {
  const length = intArg(runtime, args.positional[0], 'length');
  if (length < 0n || length > MAX_LIST_LENGTH) rangeError(runtime, length, 0, MAX_LIST_LENGTH, 'length');
  const generator = args.positional[1];
  const values: Value[] = [];
  const result = new DartList(
    coreTypes.list,
    typeArgs[0] ?? DYNAMIC,
    values,
    named(args.named, 'growable', true) !== false
  );
  const frame = runtime.currentFrame;
  frame?.temporaries.push(result);
  try {
    for (let position = 0n; position < length; position++) {
      runtime.allocate(1);
      values.push(callFunction(runtime, generator, position));
    }
  } finally {
    frame?.temporaries.pop();
  }
  return result;
});
defineConstructor('List.unmodifiable', (runtime, _instance, args, typeArgs) => {
  const values = iterableValues(runtime, args.positional[0]);
  runtime.allocate(values.length + 1);
  return new DartList(coreTypes.list, typeArgs[0] ?? DYNAMIC, values, false, true);
});

// Access

define('List.[]', (runtime, receiver, [at]) => {
  const target = list(receiver);
  return target.elements[checkIndex(runtime, target, at, 'length')];
});
define('List.[]=', (runtime, receiver, [at, value]) => {
  const target = list(receiver);
  checkElement(runtime, value, elementTypeOf(target), 'value');
  checkModifiable(runtime, target);
  const position = checkIndex(runtime, target, at, 'index');
  target.elements[position] = value;
  return;
});
define('List.length', (_runtime, receiver) => BigInt(list(receiver).elements.length));
define('List.length=', (runtime, receiver, [length]) => {
  const target = list(receiver);
  checkGrowable(runtime, target, 'length');
  const count = intArg(runtime, length, 'newLength');
  if (count < 0n || count > MAX_LIST_LENGTH) rangeError(runtime, count, 0, MAX_LIST_LENGTH, 'length');
  const elements = target.elements;
  if (count > BigInt(elements.length)) {
    const elementType = elementTypeOf(target);
    castTo(runtime, undefined, elementType);
    runtime.allocate(index(count) - elements.length);
    while (elements.length < count) elements.push(undefined);
  } else {
    elements.length = index(count);
  }
  changed(target);
  return;
});
function first(runtime: Runtime, target: DartList): Value {
  if (target.elements.length === 0) runtime.throwError('StateError', '', ['No element']);
  return target.elements[0];
}
define('List.first', (runtime, receiver) => first(runtime, list(receiver)));
define('List.last', (runtime, receiver) => {
  const target = list(receiver);
  if (target.elements.length === 0) runtime.throwError('StateError', '', ['No element']);
  return target.elements.at(-1);
});
define('List.first=', (runtime, receiver, [value]) => {
  const target = list(receiver);
  checkElement(runtime, value, elementTypeOf(target), 'value');
  checkModifiable(runtime, target);
  if (target.elements.length === 0) rangeError(runtime, 0, 0, -1, 'index');
  target.elements[0] = value;
  return;
});
define('List.last=', (runtime, receiver, [value]) => {
  const target = list(receiver);
  checkElement(runtime, value, elementTypeOf(target), 'value');
  checkModifiable(runtime, target);
  if (target.elements.length === 0) rangeError(runtime, -1, 0, -1, 'index');
  target.elements[target.elements.length - 1] = value;
  return;
});
define('List.single', (runtime, receiver) => {
  const target = list(receiver);
  if (target.elements.length === 0) runtime.throwError('StateError', '', ['No element']);
  if (target.elements.length > 1) runtime.throwError('StateError', '', ['Too many elements']);
  return target.elements[0];
});
define('List.isEmpty', (_runtime, receiver) => list(receiver).elements.length === 0);
define('List.isNotEmpty', (_runtime, receiver) => list(receiver).elements.length > 0);
define('List.elementAt', (runtime, receiver, [at]) => {
  const target = list(receiver);
  return target.elements[checkIndex(runtime, target, at, 'length')];
});

// Iteration

interface ListIteratorState {
  list: DartList;
  length: number;
  position: number;
  current: Value;
  values(): Iterable<Value>;
}

export function listIterator(runtime: Runtime, target: DartList): DartObject {
  const iterator = new DartObject(runtime.links.classNamed('_ListIterator'), target.typeArgs, []);
  const state: ListIteratorState = {
    list: target,
    length: target.elements.length,
    position: 0,
    current: undefined,
    values: () => [state.list, state.current],
  };
  iterator.native = state as unknown as DartObject['native'];
  return iterator;
}

define('List.iterator', (runtime, receiver) => listIterator(runtime, list(receiver)));
define('_ListIterator.moveNext', (runtime, receiver) => {
  const state = (receiver as DartObject).native as unknown as ListIteratorState;
  const { elements } = state.list;
  if (state.length !== elements.length) runtime.throwError('ConcurrentModificationError', '', [state.list]);
  if (state.position >= elements.length) {
    state.current = undefined;
    return false;
  }
  state.current = elements[state.position];
  state.position++;
  return true;
});
define('_ListIterator.current', (runtime, receiver) => {
  const state = (receiver as DartObject).native as unknown as ListIteratorState;
  // Before the first moveNext and after the last, `current` is `null as E`, which fails for a non-nullable E.
  if (state.current === undefined) castTo(runtime, undefined, elementTypeOf(receiver as DartObject));
  return state.current;
});

define('List.forEach', (runtime, receiver, [action]) => {
  const target = list(receiver);
  const length = target.elements.length;
  for (let position = 0; position < length; position++) {
    callFunction(runtime, action, target.elements[position]);
    if (length !== target.elements.length) runtime.throwError('ConcurrentModificationError', '', [target]);
  }
  return;
});
define('List.contains', (runtime, receiver, [value]) => {
  const target = list(receiver);
  for (const element of target.elements) if (runtime.equals(element, value)) return true;
  return false;
});
define('List.join', (runtime, receiver, [separator = '']) => {
  const target = list(receiver);
  return target.elements.map((element) => stringOf(runtime, element)).join(separator as string);
});
define('List.toString', (runtime, receiver) =>
  iterableToFullString(runtime, receiver, list(receiver).elements, '[', ']')
);

/** `Iterable.iterableToFullString`: the elements' strings between delimiters, `[...]` for a list inside itself. */
export function iterableToFullString(
  runtime: Runtime,
  object: Value,
  elements: Iterable<Value>,
  left: string,
  right: string
): string {
  if (runtime.toStringVisiting.includes(object)) return `${left}...${right}`;
  runtime.toStringVisiting.push(object);
  try {
    const parts: string[] = [];
    for (const element of elements) parts.push(stringOf(runtime, element));
    return left + parts.join(', ') + right;
  } finally {
    runtime.toStringVisiting.pop();
  }
}

define('List.==', (_runtime, receiver, [other]) => receiver === other);
define('List.hashCode', (_runtime, receiver) => BigInt((receiver as DartObject).identity));

// Changes

define('List.add', (runtime, receiver, [value]) => {
  const target = list(receiver);
  checkElement(runtime, value, elementTypeOf(target), 'value');
  checkGrowable(runtime, target, 'add');
  runtime.allocate(1);
  target.elements.push(value);
  changed(target);
  return;
});
define('List.addAll', (runtime, receiver, [iterable]) => {
  const target = list(receiver);
  const elementType = elementTypeOf(target);
  checkElement(runtime, iterable, interfaceType(coreTypes.iterable, [elementType]), 'iterable');
  checkGrowable(runtime, target, 'add');
  if (iterable === target && target.elements.length > 0)
    runtime.throwError('ConcurrentModificationError', '', [target]);
  let length = target.elements.length;
  forEachValue(runtime, iterable, (value) => {
    if (target.elements.length !== length) runtime.throwError('ConcurrentModificationError', '', [target]);
    checkElement(runtime, value, elementType, 'value');
    runtime.allocate(1);
    target.elements.push(value);
    changed(target);
    length++;
  });
  return;
});
define('List.insert', (runtime, receiver, [at, value]) => {
  const target = list(receiver);
  checkElement(runtime, value, elementTypeOf(target), 'element');
  checkGrowable(runtime, target, 'add');
  const position = intArg(runtime, at, 'index');
  if (position < 0n || position > BigInt(target.elements.length))
    rangeError(runtime, position, 0, target.elements.length, undefined);
  runtime.allocate(1);
  target.elements.splice(index(position), 0, value);
  changed(target);
  return;
});
define('List.insertAll', (runtime, receiver, [at, iterable]) => {
  const target = list(receiver);
  checkElement(runtime, iterable, interfaceType(coreTypes.iterable, [elementTypeOf(target)]), 'iterable');
  checkGrowable(runtime, target, 'add');
  const position = intArg(runtime, at, 'index');
  if (position < 0n || position > BigInt(target.elements.length))
    rangeError(runtime, position, 0, target.elements.length, undefined);
  const values = iterableValues(runtime, iterable);
  runtime.allocate(values.length);
  if (iterable === target) {
    // As the VM: the list grows first and then copies itself in, which the longer list no longer fits.
    const start = index(position);
    const oldLength = target.elements.length;
    target.elements.length = oldLength + values.length;
    target.elements.fill(undefined, oldLength);
    target.elements.copyWithin(start + values.length, start, oldLength);
    changed(target);
    rangeError(runtime, start + target.elements.length, start, target.elements.length, 'end');
  }
  target.elements.splice(index(position), 0, ...values);
  changed(target);
  return;
});
define('List.setAll', (runtime, receiver, [at, iterable]) => {
  const target = list(receiver);
  checkElement(runtime, iterable, interfaceType(coreTypes.iterable, [elementTypeOf(target)]), 'iterable');
  checkModifiable(runtime, target);
  const position = intArg(runtime, at, 'index');
  const values = iterableValues(runtime, iterable);
  if (position < 0n || position > BigInt(target.elements.length))
    rangeError(runtime, position, 0, target.elements.length, 'index');
  if (index(position) + values.length > target.elements.length)
    rangeError(runtime, index(position) + values.length, Number(position), target.elements.length, 'end');
  for (const [offset, value] of values.entries()) target.elements[index(position) + offset] = value;
  return;
});
define('List.remove', (runtime, receiver, [value]) => {
  const target = list(receiver);
  checkGrowable(runtime, target, 'remove');
  const position = target.elements.findIndex((element) => runtime.equals(element, value));
  if (position === -1) return false;
  target.elements.splice(position, 1);
  changed(target);
  return true;
});
define('List.removeAt', (runtime, receiver, [at]) => {
  const target = list(receiver);
  checkGrowable(runtime, target, 'remove');
  const position = checkIndex(runtime, target, at, 'length');
  const [removed] = target.elements.splice(position, 1);
  changed(target);
  return removed;
});
define('List.removeLast', (runtime, receiver) => {
  const target = list(receiver);
  checkGrowable(runtime, target, 'remove');
  if (target.elements.length === 0) rangeError(runtime, -1, 0, -1, 'length');
  changed(target);
  return target.elements.pop();
});
function filterList(runtime: Runtime, receiver: Value, test: Value, keep: boolean): Value {
  const target = list(receiver);
  checkGrowable(runtime, target, 'remove');
  const length = target.elements.length;
  const retained: Value[] = [];
  for (let position = 0; position < length; position++) {
    const element = target.elements[position];
    if ((callFunction(runtime, test, element) === true) === keep) retained.push(element);
    if (length !== target.elements.length) runtime.throwError('ConcurrentModificationError', '', [target]);
  }
  if (retained.length !== length) {
    target.elements = retained;
    changed(target);
  }
  return undefined;
}
define('List.removeWhere', (runtime, receiver, [test]) => filterList(runtime, receiver, test, false));
define('List.retainWhere', (runtime, receiver, [test]) => filterList(runtime, receiver, test, true));
define('List.clear', (runtime, receiver) => {
  const target = list(receiver);
  checkGrowable(runtime, target, 'clear');
  if (target.elements.length > 0) {
    target.elements = [];
    changed(target);
  }
  return;
});
define('List.+', (runtime, receiver, [other]) => {
  const target = list(receiver);
  const values = [...target.elements, ...(other instanceof DartList ? other.elements : iterableValues(runtime, other))];
  return newList(runtime, elementTypeOf(target), values);
});
define('List.sublist', (runtime, receiver, [start, end]) => {
  const target = list(receiver);
  const [from, to] = checkRange(runtime, start, end, target.elements.length);
  return newList(runtime, elementTypeOf(target), target.elements.slice(from, to));
});
// code-gauge-allow functionCognitiveComplexity 17 -- Growable and fixed lists differ for iterable and list sources.
// code-gauge-allow functionNcss 34 -- Keep the copy cases with the shared checks and write rules.
define('List.setRange', (runtime, receiver, [start, end, iterable, skip = 0n]) => {
  const target = list(receiver);
  checkElement(runtime, iterable, interfaceType(coreTypes.iterable, [elementTypeOf(target)]), 'iterable');
  checkModifiable(runtime, target);
  const [from, to] = checkRange(runtime, start, end, target.elements.length, target.growable);
  if (from === to) return;
  const skipCount = intArg(runtime, skip, 'skipCount');
  if (target.growable && skipCount < 0n)
    runtime.throwError('RangeError', 'range', [skipCount, 0n, undefined, 'skipCount']);
  const elementType = elementTypeOf(target);
  const write = (position: number, value: Value): void => {
    checkIndex(runtime, target, BigInt(position), 'index');
    checkElement(runtime, value, elementType, 'value');
    target.elements[position] = value;
    runtime.spend();
  };
  if (runtime.links.isValueOf(runtime, iterable, interfaceType(coreTypes.list, [elementType]))) {
    if (target.growable) {
      const sourceLength = runtime.getProperty(iterable, 'length', undefined) as bigint;
      if (skipCount + BigInt(to - from) > sourceLength) runtime.throwError('StateError', '', ['Too few elements']);
    }
    copyListRange(runtime, iterable, skipCount, from, to, write);
  } else if (target.growable) {
    const values = iterableValues(runtime, iterable).slice(index(skipCount));
    if (values.length < to - from) runtime.throwError('StateError', '', ['Too few elements']);
    for (let position = from; position < to; position++) write(position, values[position - from]);
  } else {
    const skip = skipCount < 0n ? 0n : skipCount;
    let position = from;
    forEachIteratorValue(runtime, iterable, skip, skip + BigInt(to - from), (value) => write(position++, value));
  }
  return;
});

function copyListRange(
  runtime: Runtime,
  source: Value,
  skipCount: bigint,
  from: number,
  to: number,
  write: (position: number, value: Value) => void
): void {
  const length = to - from;
  const backwards = skipCount < BigInt(from);
  for (let offset = 0; offset < length; offset++) {
    const position = backwards ? length - offset - 1 : offset;
    const args = { positional: [skipCount + BigInt(position)], named: undefined };
    write(from + position, runtime.invoke(source, '[]', args, [], undefined));
  }
}

define('List.removeRange', (runtime, receiver, [start, end]) => {
  const target = list(receiver);
  checkGrowable(runtime, target, 'remove');
  const [from, to] = checkRange(runtime, start, end, target.elements.length);
  target.elements.splice(from, to - from);
  changed(target);
  return;
});
define('List.fillRange', (runtime, receiver, [start, end, fill]) => {
  const target = list(receiver);
  const elementType = elementTypeOf(target);
  checkElement(runtime, fill, makeNullable(elementType), 'fill');
  checkModifiable(runtime, target);
  const [from, to] = checkRange(runtime, start, end, target.elements.length);
  castTo(runtime, fill, elementType);
  for (let position = from; position < to; position++) target.elements[position] = fill;
  return;
});
define('List.replaceRange', (runtime, receiver, [start, end, iterable]) => {
  const target = list(receiver);
  checkElement(runtime, iterable, interfaceType(coreTypes.iterable, [elementTypeOf(target)]), 'newContents');
  checkGrowable(runtime, target, 'remove');
  const [from, to] = checkRange(runtime, start, end, target.elements.length);
  const values = iterableValues(runtime, iterable);
  target.elements.splice(from, to - from, ...values);
  changed(target);
  return;
});
define('List.indexOf', (runtime, receiver, [value, start = 0n]) => {
  const target = list(receiver);
  let from = index(intArg(runtime, start, 'start'));
  if (from < 0) from = 0;
  for (let position = from; position < target.elements.length; position++) {
    if (runtime.equals(target.elements[position], value)) return BigInt(position);
  }
  return -1n;
});
define('List.lastIndexOf', (runtime, receiver, [value, start]) => {
  const target = list(receiver);
  let from = start === undefined ? target.elements.length - 1 : index(intArg(runtime, start, 'start'));
  if (from >= target.elements.length) from = target.elements.length - 1;
  for (let position = from; position >= 0; position--) {
    if (runtime.equals(target.elements[position], value)) return BigInt(position);
  }
  return -1n;
});
define('List.indexWhere', (runtime, receiver, [test, start = 0n]) => {
  const target = list(receiver);
  let from = index(intArg(runtime, start, 'start'));
  if (from < 0) from = 0;
  for (let position = from; position < target.elements.length; position++) {
    if (callFunction(runtime, test, target.elements[position]) === true) return BigInt(position);
  }
  return -1n;
});
define('List.lastIndexWhere', (runtime, receiver, [test, start]) => {
  const target = list(receiver);
  let from = start === undefined ? target.elements.length - 1 : index(intArg(runtime, start, 'start'));
  if (from >= target.elements.length) from = target.elements.length - 1;
  for (let position = from; position >= 0; position--) {
    if (callFunction(runtime, test, target.elements[position]) === true) return BigInt(position);
  }
  return -1n;
});
define('List.sort', (runtime, receiver, [compare]) => {
  const target = list(receiver);
  checkModifiable(runtime, target);
  // Without a comparator, the SDK compares as `Comparable.compare(a as Comparable, b as Comparable)`.
  const comparable = interfaceType(runtime.links.classNamed('Comparable'), [DYNAMIC]);
  const comparator = (a: Value, b: Value): number => {
    runtime.spend();
    if (compare === undefined) {
      castTo(runtime, a, comparable);
      castTo(runtime, b, comparable);
    }
    const result =
      compare === undefined
        ? runtime.invoke(a, 'compareTo', { positional: [b], named: undefined }, [], undefined)
        : callFunction(runtime, compare, a, b);
    return Number(result as bigint);
  };
  dartSort(target.elements, comparator);
  return;
});
define('List.shuffle', (runtime, receiver, [random]) => {
  const target = list(receiver);
  checkModifiable(runtime, target);
  const generator = random ?? runtime.links.construct(runtime, 'Random', '', []);
  let length = target.elements.length;
  while (length > 1) {
    const position = index(
      runtime.invoke(generator, 'nextInt', { positional: [BigInt(length)], named: undefined }, [], undefined) as bigint
    );
    length -= 1;
    const swap = target.elements[length];
    target.elements[length] = target.elements[position];
    target.elements[position] = swap;
  }
  return;
});
define('List.asMap', (runtime, receiver) =>
  runtime.links.construct(runtime, 'ListMapView', '', [receiver], undefined, [elementTypeOf(list(receiver))])
);
define('List.cast', (runtime, receiver, _args, _named, typeArgs) => {
  // As the SDK's List.castFrom, a view of the list that casts what it reads and writes.
  const target = list(receiver);
  return runtime.links.construct(runtime, 'CastList', '', [target], undefined, [
    elementTypeOf(target),
    typeArgs[0] ?? DYNAMIC,
  ]);
});

/**
 * Dart's sort: insertion sort for up to 32 elements, which is stable, and otherwise the dual-pivot quicksort of
 * dart:_internal, whose order of equal elements programs may see.
 */
export function dartSort(values: Value[], compare: (a: Value, b: Value) => number): void {
  doSort(values, 0, values.length - 1, compare);
}

const INSERTION_SORT_THRESHOLD = 32;

function doSort(a: Value[], left: number, right: number, compare: (a: Value, b: Value) => number): void {
  if (right - left <= INSERTION_SORT_THRESHOLD) insertionSort(a, left, right, compare);
  else dualPivotQuicksort(a, left, right, compare);
}

function insertionSort(a: Value[], left: number, right: number, compare: (a: Value, b: Value) => number): void {
  for (let i = left + 1; i <= right; i++) {
    const element = a[i];
    let j = i;
    while (j > left && compare(a[j - 1], element) > 0) {
      a[j] = a[j - 1];
      j--;
    }
    a[j] = element;
  }
}

type Compare = (a: Value, b: Value) => number;

/** A transcription of dart:_internal's _dualPivotQuicksort, whose order of ties and of comparisons programs see. */
function dualPivotQuicksort(a: Value[], left: number, right: number, compare: Compare): void {
  const { pivot1, pivot2, index1, index5 } = choosePivots(a, left, right, compare);
  let less = left + 1;
  let great = right - 1;
  const pivotsAreEqual = compare(pivot1, pivot2) === 0;
  ({ less, great } = pivotsAreEqual
    ? partitionAroundPivot(a, less, great, pivot1, compare)
    : partitionThree(
        a,
        less,
        great,
        pivot1,
        (value) => compare(value, pivot1) < 0,
        (value) => compare(value, pivot2) > 0,
        compare
      ));
  a[left] = a[less - 1];
  a[less - 1] = pivot1;
  a[right] = a[great + 1];
  a[great + 1] = pivot2;
  doSort(a, left, less - 2, compare);
  doSort(a, great + 2, right, compare);
  if (pivotsAreEqual) return;
  if (less < index1 && great > index5) {
    while (compare(a[less], pivot1) === 0) less++;
    while (compare(a[great], pivot2) === 0) great--;
    ({ less, great } = partitionThree(
      a,
      less,
      great,
      pivot1,
      (value) => compare(value, pivot1) === 0,
      (value) => compare(value, pivot2) === 0,
      compare
    ));
  }
  doSort(a, less, great, compare);
}

/** Sorts five sample elements with a sorting network and takes the second and fourth as the pivots. */
function choosePivots(
  a: Value[],
  left: number,
  right: number,
  compare: Compare
): { pivot1: Value; pivot2: Value; index1: number; index5: number } {
  const sixth = Math.trunc((right - left + 1) / 6);
  const index1 = left + sixth;
  const index5 = right - sixth;
  const index3 = Math.trunc((left + right) / 2);
  const index2 = index3 - sixth;
  const index4 = index3 + sixth;
  const el = [a[index1], a[index2], a[index3], a[index4], a[index5]];
  for (const [x, y] of [
    [0, 1],
    [3, 4],
    [0, 2],
    [1, 2],
    [0, 3],
    [2, 3],
    [1, 4],
    [1, 2],
    [3, 4],
  ] as const) {
    if (compare(el[x], el[y]) > 0) [el[x], el[y]] = [el[y], el[x]];
  }
  a[index1] = el[0];
  a[index3] = el[2];
  a[index5] = el[4];
  a[index2] = a[left];
  a[index4] = a[right];
  return { pivot1: el[1], pivot2: el[3], index1, index5 };
}

/** Moves the elements less than the pivot to the left and the greater ones to the right, keeping equal ones between. */
// code-gauge-allow duplicateLines 28 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
// code-gauge-allow functionCognitiveComplexity 17 -- A transcription of dart:_internal's dual-pivot quicksort, whose comparisons programs see.
function partitionAroundPivot(
  a: Value[],
  start: number,
  end: number,
  pivot: Value,
  compare: Compare
): { less: number; great: number } {
  let less = start;
  let great = end;
  for (let k = less; k <= great; k++) {
    const ak = a[k];
    const comp = compare(ak, pivot);
    if (comp === 0) continue;
    if (comp < 0) {
      if (k !== less) {
        a[k] = a[less];
        a[less] = ak;
      }
      less++;
      continue;
    }
    for (;;) {
      const greatComp = compare(a[great], pivot);
      if (greatComp > 0) {
        great--;
        continue;
      }
      if (greatComp < 0) {
        a[k] = a[less];
        a[less++] = a[great];
      } else {
        a[k] = a[great];
      }
      a[great--] = ak;
      break;
    }
  }
  return { less, great };
}

/** Moves the elements that belong left to the left and those that belong right to the right. */
// code-gauge-allow duplicateLines 28 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
// code-gauge-allow functionCognitiveComplexity 21 -- A transcription of dart:_internal's dual-pivot quicksort, whose comparisons programs see.
// code-gauge-allow functionParameterCount 7 -- The parameters are the parts a caller already holds; grouping them would only rename them.
function partitionThree(
  a: Value[],
  start: number,
  end: number,
  pivot1: Value,
  belongsLeft: (value: Value) => boolean,
  belongsRight: (value: Value) => boolean,
  compare: Compare
): { less: number; great: number } {
  let less = start;
  let great = end;
  for (let k = less; k <= great; k++) {
    const ak = a[k];
    if (belongsLeft(ak)) {
      if (k !== less) {
        a[k] = a[less];
        a[less] = ak;
      }
      less++;
      continue;
    }
    if (!belongsRight(ak)) continue;
    for (;;) {
      if (belongsRight(a[great])) {
        great--;
        if (great < k) break;
        continue;
      }
      if (compare(a[great], pivot1) < 0) {
        a[k] = a[less];
        a[less++] = a[great];
      } else {
        a[k] = a[great];
      }
      a[great--] = ak;
      break;
    }
  }
  return { less, great };
}

// Sets

function store(value: Value): HashStore {
  return (value as DartObject).native as unknown as HashStore;
}

export function newSet(runtime: Runtime, elementType: DartType, isConst = false): DartObject {
  return newHashObject(runtime, 'Set', [elementType], isConst);
}

export function newMap(runtime: Runtime, keyType: DartType, valueType: DartType, isConst = false): DartObject {
  return newHashObject(runtime, 'Map', [keyType, valueType], isConst);
}

function newHashObject(
  runtime: Runtime,
  kind: 'Map' | 'Set',
  typeArgs: readonly DartType[],
  isConst: boolean,
  policy?: HashPolicy
): DartObject {
  const name = policy
    ? `CompactLinked${policy.identity ? 'Identity' : 'Custom'}Hash${kind}`
    : `_${isConst ? 'Const' : ''}${kind}`;
  const result = new DartObject(runtime.links.classNamed(name), typeArgs, []);
  result.native = new HashStore(runtime, kind === 'Map', policy);
  (result as DartObject & { unmodifiable?: boolean }).unmodifiable = isConst;
  return result;
}

function installHashFactories(kind: 'Map' | 'Set', argumentCount: number): void {
  const types = (args: readonly DartType[]): DartType[] =>
    Array.from({ length: argumentCount }, (_, index) => args[index] ?? DYNAMIC);
  const identity = (runtime: Runtime, typeArgs: readonly DartType[]): Value => {
    let policy = identityPolicies.get(runtime);
    if (!policy) {
      policy = { identity: true, equals: identical, hash: (key) => identityHashCode(runtime, key) };
      identityPolicies.set(runtime, policy);
    }
    return newHashObject(runtime, kind, types(typeArgs), false, policy);
  };
  defineConstructor(`${kind}.identity`, (runtime, _instance, _args, typeArgs) => identity(runtime, typeArgs));
  defineConstructor(`LinkedHash${kind}.identity`, (runtime, _instance, _args, typeArgs) => identity(runtime, typeArgs));
  defineConstructor(`LinkedHash${kind}.new`, (runtime, _instance, args, typeArgs) => {
    const normalized = types(typeArgs);
    const equals = args.named?.get('equals');
    const hashCode = args.named?.get('hashCode');
    const isValidKey = args.named?.get('isValidKey');
    if (isValidKey === undefined && isCoreFunction(equals, 'identical') && isCoreFunction(hashCode, 'identityHashCode'))
      return identity(runtime, normalized);
    if (equals === undefined && hashCode === undefined && isValidKey === undefined)
      return newHashObject(runtime, kind, normalized, false);
    return newHashObject(runtime, kind, normalized, false, {
      equals: equals === undefined ? undefined : (left, right) => callFunction(runtime, equals, left, right) === true,
      hash: hashCode === undefined ? undefined : (key) => callFunction(runtime, hashCode, key) as bigint,
      valid:
        isValidKey === undefined
          ? (key) => runtime.links.isValueOf(runtime, key, normalized[0])
          : (key) => callFunction(runtime, isValidKey, key) === true,
      callbacks: [equals, hashCode, isValidKey],
    });
  });
}

function isCoreFunction(value: Value, name: string): boolean {
  if (!(value instanceof DartClosure)) return false;
  const fn = value.tearOffKey as TopLevelFunction | undefined;
  return fn?.library === 'dart:core' && fn.name === name;
}

const identityPolicies = new WeakMap<Runtime, HashPolicy>();
installHashFactories('Set', 1);
installHashFactories('Map', 2);

function checkSetModifiable(runtime: Runtime, set: Value): void {
  if ((set as DartObject & { unmodifiable?: boolean }).unmodifiable)
    runtime.throwError('UnsupportedError', '', ['Cannot change an unmodifiable set']);
}

function checkMapModifiable(runtime: Runtime, map: Value): void {
  if ((map as DartObject & { unmodifiable?: boolean }).unmodifiable)
    runtime.throwError('UnsupportedError', '', ['Cannot modify unmodifiable map']);
}

defineConstructor('Set.new', (runtime, _instance, _args, typeArgs) => newSet(runtime, typeArgs[0] ?? DYNAMIC));
function setFrom(
  runtime: Runtime,
  elements: Value,
  elementType: DartType,
  check: boolean,
  isConst = false
): DartObject {
  const set = newSet(runtime, elementType, false);
  // Set.from adds each element as it iterates; Set.of is addAll, which may copy another set's table outright.
  if (check) {
    forEachValue(runtime, elements, (value) => {
      castTo(runtime, value, elementType);
      store(set).set(value, undefined);
    });
  } else {
    addAllToSet(runtime, set, elements);
  }
  (set as DartObject & { unmodifiable?: boolean }).unmodifiable = isConst;
  return set;
}
defineConstructor('Set.from', (runtime, _instance, args, typeArgs) =>
  setFrom(runtime, args.positional[0], typeArgs[0] ?? DYNAMIC, true)
);
defineConstructor('Set.of', (runtime, _instance, args, typeArgs) =>
  setFrom(runtime, args.positional[0], typeArgs[0] ?? DYNAMIC, false)
);
defineConstructor('Set.unmodifiable', (runtime, _instance, args, typeArgs) => {
  const set = setFrom(runtime, args.positional[0], typeArgs[0] ?? DYNAMIC, false, true);
  set.cls = runtime.links.classNamed('UnmodifiableSetView');
  return set;
});

interface StoreIteratorState {
  store: HashStore;
  owner: Value;
  positions: number[];
  next: number;
  modifications: number;
  current: Value;
  kind: 'keys' | 'values' | 'entries';
  values(): Iterable<Value>;
}

function storeIterator(
  runtime: Runtime,
  owner: Value,
  className: string,
  kind: StoreIteratorState['kind'],
  typeArgs: readonly DartType[]
): DartObject {
  const hashStore = store(owner);
  const iterator = new DartObject(runtime.links.classNamed(className), typeArgs, []);
  const state: StoreIteratorState = {
    store: hashStore,
    owner,
    positions: [...hashStore.positions()],
    next: 0,
    modifications: hashStore.modifications,
    current: undefined,
    kind,
    values: () => [state.owner, state.current],
  };
  iterator.native = state as unknown as DartObject['native'];
  return iterator;
}

function storeCurrent(runtime: Runtime, receiver: Value): Value {
  const state = (receiver as DartObject).native as unknown as StoreIteratorState;
  if (state.current === undefined) {
    // The VM's iterator of a map's entries has no entry to give, and says so; the others cast null to the element.
    if (state.kind === 'entries') runtime.throwError('StateError', '', ['No element']);
    castTo(runtime, undefined, elementTypeOf(receiver as DartObject));
  }
  return state.current;
}

function moveStoreIterator(runtime: Runtime, receiver: Value): boolean {
  const state = (receiver as DartObject).native as unknown as StoreIteratorState;
  if (state.modifications !== state.store.modifications)
    runtime.throwError('ConcurrentModificationError', '', [state.owner]);
  while (state.next < state.positions.length) {
    const position = state.positions[state.next++];
    if (!state.store.isLive(position)) continue;
    const key = state.store.keyAt(position);
    if (state.kind === 'keys') state.current = key;
    else if (state.kind === 'values') state.current = state.store.entryValues[position];
    else {
      state.current = runtime.links.construct(
        runtime,
        'MapEntry',
        '_',
        [key, state.store.entryValues[position]],
        undefined,
        (receiver as DartObject).typeArgs[0].kind === 'interface'
          ? ((receiver as DartObject).typeArgs[0] as InterfaceType).args
          : undefined
      );
    }
    return true;
  }
  state.current = undefined;
  return false;
}

define('Set.iterator', (runtime, receiver) =>
  storeIterator(runtime, receiver, '_SetIterator', 'keys', (receiver as DartObject).typeArgs)
);
define('_SetIterator.moveNext', (runtime, receiver) => moveStoreIterator(runtime, receiver));
define('_SetIterator.current', (runtime, receiver) => storeCurrent(runtime, receiver));
define('Set.contains', (_runtime, receiver, [value]) => store(receiver).has(value));
define('Set.add', (runtime, receiver, [value]) => {
  checkSetModifiable(runtime, receiver);
  checkElement(runtime, value, elementTypeOf(receiver as DartObject), 'value');
  return store(receiver).set(value, undefined);
});
define('Set.addAll', (runtime, receiver, [elements]) => {
  const set = receiver as DartObject;
  checkElement(runtime, elements, interfaceType(coreTypes.iterable, [elementTypeOf(set)]), 'other');
  checkSetModifiable(runtime, set);
  addAllToSet(runtime, set, elements);
  return;
});

/** The VM's `_Set.addAll`: an empty set copies another `_Set` without deleted entries, and otherwise adds each. */
function addAllToSet(runtime: Runtime, set: DartObject, elements: Value): void {
  if (quickCopySet(runtime, set, elements)) return;
  forEachValue(runtime, elements, (value) => {
    checkElement(runtime, value, elementTypeOf(set), 'value');
    store(set).set(value, undefined);
  });
}

/** Whether a value is an instance of the VM's own `_Map` or `_Set`, whose tables `_quickCopy` reads. */
function isPlainHashObject(runtime: Runtime, value: Value, className: '_Map' | '_Set'): value is DartObject {
  return (
    value instanceof DartObject &&
    value.native instanceof HashStore &&
    (value.cls === runtime.links.classNamed(className) ||
      value.cls.name === `CompactLinkedIdentityHash${className.slice(1)}`)
  );
}
define('Set.remove', (runtime, receiver, [value]) => {
  checkSetModifiable(runtime, receiver);
  return store(receiver).delete(value).found;
});
define('Set.lookup', (_runtime, receiver, [value]) => {
  const position = store(receiver).find(value);
  return position >= 0 ? store(receiver).keyAt(position) : undefined;
});
define('Set.removeAll', (runtime, receiver, [elements]) => {
  checkSetModifiable(runtime, receiver);
  forEachValue(runtime, elements, (value) => store(receiver).delete(value));
  return;
});
define('Set.retainAll', (runtime, receiver, [elements]) => {
  checkSetModifiable(runtime, receiver);
  // As SetMixin.retainAll: copy the set, remove the elements from the copy, and remove what is left from the set.
  const toRemove = copySet(runtime, receiver as DartObject);
  forEachValue(runtime, elements, (value) => store(toRemove).delete(value));
  forEachValue(runtime, toRemove, (value) => store(receiver).delete(value));
  return;
});
/** The VM's `_Set._filter`: tests each element in place and marks the removed ones without hashing them. */
function filterSet(runtime: Runtime, receiver: Value, test: Value, keep: boolean): Value {
  checkSetModifiable(runtime, receiver);
  const source = store(receiver);
  const used = source.keys.length;
  let modifications = source.modifications;
  for (let position = 0; position < used; position++) {
    if (!source.isLive(position)) continue;
    const result = callFunction(runtime, test, source.keyAt(position)) === true;
    if (source.modifications !== modifications) runtime.throwError('ConcurrentModificationError', '', [receiver]);
    if (result !== keep) {
      source.deleteAt(position);
      modifications = source.modifications;
    }
  }
  return undefined;
}
define('Set.removeWhere', (runtime, receiver, [test]) => filterSet(runtime, receiver, test, false));
define('Set.retainWhere', (runtime, receiver, [test]) => filterSet(runtime, receiver, test, true));
define('Set.containsAll', (runtime, receiver, [other]) => {
  // SetMixin.containsAll stops at the first element the set lacks.
  const iterator = runtime.getProperty(other, 'iterator', undefined);
  while (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) === true) {
    if (!store(receiver).has(runtime.getProperty(iterator, 'current', undefined))) return false;
  }
  return true;
});
// As SetMixin: a copy of the set (`toSet`), then the elements the other set decides about removed from it.
define('Set.intersection', (runtime, receiver, [other]) => {
  const result = copySet(runtime, receiver as DartObject);
  forEachValue(runtime, receiver, (key) => {
    if (!setContains(runtime, other, key)) store(result).delete(key);
  });
  return result;
});
define('Set.union', (runtime, receiver, [other]) => {
  const result = copySet(runtime, receiver as DartObject);
  addAllToSet(runtime, result, other);
  return result;
});
define('Set.difference', (runtime, receiver, [other]) => {
  const result = copySet(runtime, receiver as DartObject);
  forEachValue(runtime, receiver, (key) => {
    if (setContains(runtime, other, key)) store(result).delete(key);
  });
  return result;
});

/** `_Set<E>()..addAll(this)`, the VM's `toSet`. */
function copySet(runtime: Runtime, set: DartObject): DartObject {
  const copy = newHashObject(runtime, 'Set', set.typeArgs, false, store(set).policy);
  addAllToSet(runtime, copy, set);
  return copy;
}
define('Set.clear', (runtime, receiver) => {
  checkSetModifiable(runtime, receiver);
  store(receiver).clear();
  return;
});
// As the SDK's castFrom, views that cast what they read and write.
define('Set.cast', (runtime, receiver, _args, _named, typeArgs) =>
  runtime.links.construct(runtime, 'CastSet', '', [receiver], undefined, [
    elementTypeOf(receiver as DartObject),
    typeArgs[0] ?? DYNAMIC,
  ])
);
define('Set.length', (_runtime, receiver) => BigInt(store(receiver).size));
define('Set.isEmpty', (_runtime, receiver) => store(receiver).size === 0);
define('Set.isNotEmpty', (_runtime, receiver) => store(receiver).size > 0);
define('Set.first', (runtime, receiver) => {
  for (const key of store(receiver).values()) return key;
  return runtime.throwError('StateError', '', ['No element']);
});
define('Set.last', (runtime, receiver) => {
  const keys = [...store(receiver).values()];
  if (keys.length === 0) runtime.throwError('StateError', '', ['No element']);
  return keys.at(-1);
});
define('Set.toSet', (runtime, receiver) => copySet(runtime, receiver as DartObject));
define('Set.toString', (runtime, receiver) =>
  iterableToFullString(runtime, receiver, store(receiver).values(), '{', '}')
);

// Maps

defineConstructor('Map.new', (runtime, _instance, _args, typeArgs) =>
  newMap(runtime, typeArgs[0] ?? DYNAMIC, typeArgs[1] ?? DYNAMIC)
);
function mapFrom(
  runtime: Runtime,
  other: Value,
  typeArgs: readonly DartType[],
  check: boolean,
  isConst = false
): DartObject {
  const map = newMap(runtime, typeArgs[0] ?? DYNAMIC, typeArgs[1] ?? DYNAMIC);
  // Map.from sets each entry as forEach gives it; Map.of is addAll, which may copy another map's table outright.
  if (check || !(isPlainHashObject(runtime, other, '_Map') && store(map).quickCopy(store(other)))) {
    forEachEntry(runtime, other, (key, value) => {
      if (check) {
        castTo(runtime, key, typeArgs[0] ?? DYNAMIC);
        castTo(runtime, value, typeArgs[1] ?? DYNAMIC);
      }
      store(map).set(key, value);
    });
  }
  (map as DartObject & { unmodifiable?: boolean }).unmodifiable = isConst;
  return map;
}
defineConstructor('Map.from', (runtime, _instance, args, typeArgs) =>
  mapFrom(runtime, args.positional[0], typeArgs, true)
);
defineConstructor('Map.of', (runtime, _instance, args, typeArgs) =>
  mapFrom(runtime, args.positional[0], typeArgs, false)
);
defineConstructor('Map.unmodifiable', (runtime, _instance, args, typeArgs) => {
  const map = mapFrom(runtime, args.positional[0], typeArgs, true, true);
  map.cls = runtime.links.classNamed('UnmodifiableMapView');
  return map;
});
defineConstructor('Map.fromIterable', (runtime, _instance, args, typeArgs) => {
  const map = newMap(runtime, typeArgs[0] ?? DYNAMIC, typeArgs[1] ?? DYNAMIC);
  const keyOf = named(args.named, 'key', undefined);
  const valueOf = named(args.named, 'value', undefined);
  forEachValue(runtime, args.positional[0], (element) => {
    const key = keyOf === undefined ? element : callFunction(runtime, keyOf, element);
    const value = valueOf === undefined ? element : callFunction(runtime, valueOf, element);
    store(map).set(key, value);
  });
  return map;
});
defineConstructor('Map.fromIterables', (runtime, _instance, args, typeArgs) => {
  const map = newMap(runtime, typeArgs[0] ?? DYNAMIC, typeArgs[1] ?? DYNAMIC);
  // As the SDK's _fillMapWithIterables: both iterators in step, each pair set as it is read.
  const keys = runtime.getProperty(args.positional[0], 'iterator', undefined);
  const values = runtime.getProperty(args.positional[1], 'iterator', undefined);
  const moveNext = (iterator: Value): boolean =>
    runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) === true;
  let hasNextKey = moveNext(keys);
  let hasNextValue = moveNext(values);
  while (hasNextKey && hasNextValue) {
    store(map).set(runtime.getProperty(keys, 'current', undefined), runtime.getProperty(values, 'current', undefined));
    hasNextKey = moveNext(keys);
    hasNextValue = moveNext(values);
    runtime.spend();
  }
  if (hasNextKey || hasNextValue) runtime.throwError('ArgumentError', '', ['Iterables do not have same length.']);
  return map;
});
defineConstructor('Map.fromEntries', (runtime, _instance, args, typeArgs) => {
  const map = newMap(runtime, typeArgs[0] ?? DYNAMIC, typeArgs[1] ?? DYNAMIC);
  forEachValue(runtime, args.positional[0], (entry) => {
    store(map).set(runtime.getProperty(entry, 'key', undefined), runtime.getProperty(entry, 'value', undefined));
  });
  return map;
});
define('Map.cast', (runtime, receiver, _args, _named, typeArgs) =>
  runtime.links.construct(runtime, 'CastMap', '', [receiver], undefined, [
    elementTypeOf(receiver as DartObject, 0),
    elementTypeOf(receiver as DartObject, 1),
    typeArgs[0] ?? DYNAMIC,
    typeArgs[1] ?? DYNAMIC,
  ])
);
define('Map.containsValue', (runtime, receiver, [value]) => {
  const source = store(receiver);
  for (const position of source.positions()) if (runtime.equals(source.entryValues[position], value)) return true;
  return false;
});
define('Map.containsKey', (_runtime, receiver, [key]) => store(receiver).has(key));
define('Map.[]', (_runtime, receiver, [key]) => store(receiver).get(key));
define('Map.[]=', (runtime, receiver, [key, value]) => {
  checkMapModifiable(runtime, receiver);
  const map = receiver as DartObject;
  checkElement(runtime, key, elementTypeOf(map, 0), 'key');
  checkElement(runtime, value, elementTypeOf(map, 1), 'value');
  store(receiver).set(key, value);
  return;
});
function mapView(runtime: Runtime, receiver: Value, className: string, typeArgs: DartType[]): DartObject {
  const view = new DartObject(runtime.links.classNamed(className), typeArgs, []);
  view.native = { map: receiver, values: () => [receiver] };
  return view;
}
define('Map.keys', (runtime, receiver) =>
  mapView(runtime, receiver, '_CompactKeysIterable', [elementTypeOf(receiver as DartObject, 0)])
);
define('Map.values', (runtime, receiver) =>
  mapView(runtime, receiver, '_CompactValuesIterable', [elementTypeOf(receiver as DartObject, 1)])
);
define('Map.entries', (runtime, receiver) =>
  mapView(runtime, receiver, '_CompactEntriesIterable', [
    elementTypeOf(receiver as DartObject, 0),
    elementTypeOf(receiver as DartObject, 1),
  ])
);
function viewedMap(receiver: Value): Value {
  return ((receiver as DartObject).native as unknown as { map: Value }).map;
}
define('_CompactKeysIterable.iterator', (runtime, receiver) =>
  storeIterator(runtime, viewedMap(receiver), '_MapIterator', 'keys', (receiver as DartObject).typeArgs)
);
define('_CompactValuesIterable.iterator', (runtime, receiver) =>
  storeIterator(runtime, viewedMap(receiver), '_MapIterator', 'values', (receiver as DartObject).typeArgs)
);
define('_CompactEntriesIterable.iterator', (runtime, receiver) => {
  const mapEntry = runtime.links.classNamed('MapEntry');
  return storeIterator(runtime, viewedMap(receiver), '_MapIterator', 'entries', [
    interfaceType(mapEntry, (receiver as DartObject).typeArgs),
  ]);
});
define('_CompactKeysIterable.length', (_runtime, receiver) => BigInt(store(viewedMap(receiver)).size));
define('_CompactValuesIterable.length', (_runtime, receiver) => BigInt(store(viewedMap(receiver)).size));
define('_CompactEntriesIterable.length', (_runtime, receiver) => BigInt(store(viewedMap(receiver)).size));
define('_CompactKeysIterable.contains', (_runtime, receiver, [key]) => store(viewedMap(receiver)).has(key));
define('_MapIterator.moveNext', (runtime, receiver) => moveStoreIterator(runtime, receiver));
define('_MapIterator.current', (runtime, receiver) => storeCurrent(runtime, receiver));
define('Map.addEntries', (runtime, receiver, [entries]) => {
  checkMapModifiable(runtime, receiver);
  forEachValue(runtime, entries, (entry) => {
    store(receiver).set(runtime.getProperty(entry, 'key', undefined), runtime.getProperty(entry, 'value', undefined));
  });
  return;
});
define('Map.removeWhere', (runtime, receiver, [test]) => {
  checkMapModifiable(runtime, receiver);
  // As the VM's removeWhere: test each entry in place and mark the removed ones without hashing their keys.
  const source = store(receiver);
  const used = source.keys.length;
  let modifications = source.modifications;
  for (let position = 0; position < used; position++) {
    if (!source.isLive(position)) continue;
    const remove = callFunction(runtime, test, source.keyAt(position), source.entryValues[position]) === true;
    if (source.modifications !== modifications) runtime.throwError('ConcurrentModificationError', '', [receiver]);
    if (remove) {
      source.deleteAt(position);
      modifications = source.modifications;
    }
  }
  return;
});
define('Map.addAll', (runtime, receiver, [other]) => {
  const map = receiver as DartObject;
  checkElement(runtime, other, interfaceType(coreTypes.map, map.typeArgs), 'other');
  checkMapModifiable(runtime, map);
  addAllToMap(runtime, map, other);
  return;
});
define('Map.remove', (runtime, receiver, [key]) => {
  checkMapModifiable(runtime, receiver);
  return store(receiver).delete(key).value;
});
define('Map.clear', (runtime, receiver) => {
  checkMapModifiable(runtime, receiver);
  store(receiver).clear();
  return;
});
define('Map.length', (_runtime, receiver) => BigInt(store(receiver).size));
define('Map.isEmpty', (_runtime, receiver) => store(receiver).size === 0);
define('Map.isNotEmpty', (_runtime, receiver) => store(receiver).size > 0);

// sync* functions

interface SyncStarState {
  frame: Frame;
  body: (frame: Frame) => Generator<Value, unknown, undefined>;
  elementType: DartType;
  values(): Iterable<Value>;
}

interface SyncStarIteratorState {
  frame: Frame;
  generator: Generator<Value, unknown, undefined> | undefined;
  current: Value;
  values(): Iterable<Value>;
}

export function syncStarIterable(frame: Frame, elementType: DartType, body: SyncStarState['body']): DartObject {
  const iterable = new DartObject(frame.runtime.links.classNamed('_SyncStarIterable'), [elementType], []);
  const state: SyncStarState = {
    frame,
    body,
    elementType,
    values: () => [...frame.locals.map((cell) => cell?.v), ...frame.captured.map((cell) => cell.v), frame.receiver],
  };
  iterable.native = state as unknown as DartObject['native'];
  return iterable;
}

define('_SyncStarIterable.iterator', (runtime, receiver) => {
  const state = (receiver as DartObject).native as unknown as SyncStarState;
  const source = state.frame;
  // Each iterator runs the body from its start, with its own copy of the parameters.
  const frame = new FrameClass(
    runtime,
    source.info,
    source.locals.length,
    source.receiver,
    source.captured,
    source.typeEnv,
    runtime.userCallRow ?? source.callRow
  );
  for (const [slot, cell] of source.locals.entries()) if (cell) frame.locals[slot] = new Cell(cell.v);
  const iterator = new DartObject(runtime.links.classNamed('_SyncStarIterator'), [state.elementType], []);
  const iteratorState: SyncStarIteratorState = {
    frame,
    generator: state.body(frame),
    current: undefined,
    values: () => [
      ...frame.locals.map((cell) => cell?.v),
      ...frame.captured.map((cell) => cell.v),
      frame.receiver,
      ...frame.temporaries,
      iteratorState.current,
    ],
  };
  iterator.native = iteratorState as unknown as DartObject['native'];
  return iterator;
});
define('_SyncStarIterator.moveNext', (runtime, receiver) => {
  const state = (receiver as DartObject).native as unknown as SyncStarIteratorState;
  const { generator } = state;
  if (!generator) return false;
  runtime.enter(state.frame);
  let result: IteratorResult<Value, unknown>;
  try {
    result = generator.next();
  } catch (error) {
    state.generator = undefined;
    throw error;
  } finally {
    runtime.exit(state.frame);
  }
  if (result.done) {
    state.generator = undefined;
    state.current = undefined;
    return false;
  }
  state.current = result.value;
  return true;
});
define(
  '_SyncStarIterator.current',
  (_runtime, receiver) => ((receiver as DartObject).native as unknown as SyncStarIteratorState).current
);

export { checkIndex, store };

// As internal/cast.dart, castFrom wraps any list, set, or map, the program's own included, in a casting view.
define('List.castFrom', (runtime, _receiver, [source], _named, typeArgs) =>
  runtime.links.construct(runtime, 'CastList', '', [source], undefined, [
    typeArgs[0] ?? DYNAMIC,
    typeArgs[1] ?? DYNAMIC,
  ])
);
define('Set.castFrom', (runtime, _receiver, [source], _named, typeArgs) =>
  runtime.links.construct(runtime, 'CastSet', '', [source], undefined, [typeArgs[0] ?? DYNAMIC, typeArgs[1] ?? DYNAMIC])
);
define('Map.castFrom', (runtime, _receiver, [source], _named, typeArgs) =>
  runtime.links.construct(runtime, 'CastMap', '', [source], undefined, [
    typeArgs[0] ?? DYNAMIC,
    typeArgs[1] ?? DYNAMIC,
    typeArgs[2] ?? DYNAMIC,
    typeArgs[3] ?? DYNAMIC,
  ])
);

/** A set's `contains`, which a set of the program answers itself. */
function setContains(runtime: Runtime, set: Value, key: Value): boolean {
  if (set instanceof DartObject && set.native instanceof HashStore) return set.native.has(key);
  return runtime.invoke(set, 'contains', { positional: [key], named: undefined }, [], undefined) === true;
}

/** `map.forEach(body)`: the interpreter's maps run it directly, checking for modification after each entry. */
export function forEachEntry(runtime: Runtime, map: Value, body: (key: Value, value: Value) => void): void {
  if (map instanceof DartObject && map.native instanceof HashStore) {
    const source = map.native;
    const used = source.keys.length;
    const modifications = source.modifications;
    for (let position = 0; position < used; position++) {
      if (!source.isLive(position)) continue;
      body(source.keyAt(position), source.entryValues[position]);
      if (source.modifications !== modifications) runtime.throwError('ConcurrentModificationError', '', [map]);
    }
    return;
  }
  const callback = nativeFunction(2, (args) => {
    body(args[0], args[1]);
    return;
  });
  runtime.invoke(map, 'forEach', { positional: [callback], named: undefined }, [], undefined);
}

define('Map.forEach', (runtime, receiver, [action]) => {
  forEachEntry(runtime, receiver, (key, value) => callFunction(runtime, action, key, value));
  return;
});
define('Map.putIfAbsent', (runtime, receiver, [key, ifAbsent]) => {
  checkMapModifiable(runtime, receiver);
  checkElement(runtime, key, elementTypeOf(receiver as DartObject, 0), 'key');
  return store(receiver).putIfAbsent(key, () => {
    const value = callFunction(runtime, ifAbsent);
    checkElement(runtime, value, elementTypeOf(receiver as DartObject, 1), 'value');
    return value;
  });
});

/** The VM's `_Map.addAll`: an empty map copies another `_Map` without deleted entries, and otherwise sets each. */
export function addAllToMap(runtime: Runtime, map: DartObject, other: Value): void {
  const keyType = elementTypeOf(map, 0);
  const valueType = elementTypeOf(map, 1);
  if (
    isPlainHashObject(runtime, other, '_Map') &&
    isSubtype(elementTypeOf(other, 0), keyType) &&
    isSubtype(elementTypeOf(other, 1), valueType) &&
    store(map).quickCopy(store(other))
  )
    return;
  forEachEntry(runtime, other, (key, value) => {
    implicitCast(runtime, key, keyType);
    implicitCast(runtime, value, valueType);
    store(map).set(key, value);
  });
}

/** The quick copy of `_Set.addAll` into an empty set, telling whether it applied. */
export function quickCopySet(runtime: Runtime, set: DartObject, other: Value): boolean {
  return (
    isPlainHashObject(runtime, other, '_Set') &&
    isSubtype(elementTypeOf(other), elementTypeOf(set)) &&
    store(set).quickCopy(store(other))
  );
}
