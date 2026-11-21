import {
  fdlibmAcos,
  fdlibmAsin,
  fdlibmAtan,
  fdlibmAtan2,
  fdlibmCbrt,
  fdlibmCos,
  fdlibmExp,
  fdlibmHypot,
  fdlibmLog,
  fdlibmLog10,
  fdlibmSin,
  fdlibmTan,
} from '../../interpreter/fdlibm';
import { fdlibmPow } from '../../interpreter/fdlibmPow';
import { callFunction } from '../dispatch';
import { formatPrimitive, stringOf, valueEquals } from '../format';
import { compareDoubles, compareNumbers, toInt32 } from '../operators';
import { arrayFactoryName, UNSIGNED_ARRAYS } from '../prelude/arrays';
import type { Frame } from '../runtime';
import type { FunctionSymbol } from '../symbols';
import { box, KObject, NULL, type PrimitiveKind, UNIT, type Value } from '../values';
import { elementsOf, newList, newPrimitiveArrayList } from './collections';
import { arrayIterator, checkArrayIndex } from './core';
import { defineNative, defineNativeProperty, libraryClass } from './registry';

/** The primitive arrays, with the default value of their elements. */
const PRIMITIVE_ARRAYS: [name: string, kind: PrimitiveKind | 'Boolean', zero: Value][] = [
  ['IntArray', 'Int', 0],
  ['LongArray', 'Long', 0n],
  ['DoubleArray', 'Double', 0],
  ['FloatArray', 'Float', 0],
  ['ShortArray', 'Short', 0],
  ['ByteArray', 'Byte', 0],
  ['CharArray', 'Char', 0],
  ['BooleanArray', 'Boolean', false],
  ...UNSIGNED_ARRAYS.map(([name, kind]): [string, PrimitiveKind, Value] => [name, kind, kind === 'ULong' ? 0n : 0]),
];

function checkSize(frame: Frame, size: number): void {
  if (size < 0) frame.runtime.throwError(frame, 'java.lang.NegativeArraySizeException', String(size));
  frame.runtime.allocate(frame, size + 1);
}

// code-gauge-allow functionNcss 43 -- registers the natives of one class together, in the order the prelude declares them.
function defineArrays(): void {
  for (const [name, kind, zero] of PRIMITIVE_ARRAYS) {
    const prefix = `kotlin.${name}`;
    defineNative(`${prefix}.<init>(Int)`, (frame, instance, [size]) => {
      checkSize(frame, size as number);
      (instance as KObject).items = Array.from({ length: size as number }, () => zero);
      return UNIT;
    });
    defineNativeProperty(`${prefix}.size`, (_frame, receiver) => ((receiver as KObject).items as Value[]).length);
    defineNative(`${prefix}.get(Int)`, (frame, receiver, [index]) => {
      const items = (receiver as KObject).items as Value[];
      checkArrayIndex(frame, items, index as number);
      return items[index as number];
    });
    defineNative(`${prefix}.set(Int, ${kind})`, (frame, receiver, [index, value]) => {
      const items = (receiver as KObject).items as Value[];
      checkArrayIndex(frame, items, index as number);
      items[index as number] = value;
      return UNIT;
    });
    defineNative(`${prefix}.iterator()`, (frame, receiver) => arrayIterator(frame, receiver as KObject, kind));
  }
  defineNative('kotlin.collections.NativeLists.of(Collection<T>)', (frame, _receiver, [elements]) =>
    newList(frame, 'ArraysList', elementsOf(frame, elements))
  );
  defineNative('kotlin.collections.NativeLists.toArray(Iterable<T>)', (frame, _receiver, [elements]) => {
    const array = new KObject(libraryClass('kotlin.Array'), 0);
    array.items = elementsOf(frame, elements);
    frame.runtime.allocate(frame, array.items.length + 1);
    return array;
  });
  defineNative('kotlin.collections.MutableList<T>.sortWith(Comparator<in T>)', (frame, list, [comparator]) => {
    const object = list as KObject;
    const values = elementsOf(frame, list);
    const compare = comparatorFunction(frame, comparator);
    frame.runtime.nativeRoots.push(list, comparator);
    try {
      const sorted = stableSort(frame, values, compare);
      writeBack(frame, object, sorted);
    } finally {
      frame.runtime.nativeRoots.length -= 2;
    }
    return UNIT;
  });
  defineNative('kotlin.collections.MutableList<T>.reverse()', (frame, list) => {
    const values = elementsOf(frame, list).toReversed();
    writeBack(frame, list as KObject, values);
    return UNIT;
  });
}

/** Stores sorted or reversed elements into a list, as `set` would, without counting as a structural change. */
function writeBack(frame: Frame, list: KObject, values: Value[]): void {
  if (list.items) {
    list.items.length = values.length;
    for (const [index, value] of values.entries()) list.items[index] = value;
    return;
  }
  const set = libraryClass('kotlin.collections.MutableList').members.get('set')?.[0] as FunctionSymbol;
  const { nativeRoots } = frame.runtime;
  const mark = nativeRoots.length;
  for (const value of values) nativeRoots.push(value);
  try {
    for (const [index, value] of values.entries()) callFunction(set, frame, list, [index, value], undefined);
  } finally {
    nativeRoots.length = mark;
  }
}

/** Calls a `Comparator`'s `compare`, dispatched on its class. */
export function comparatorFunction(frame: Frame, comparator: Value): (a: Value, b: Value) => number {
  const compare = libraryClass('kotlin.Comparator').members.get('compare')?.[0] as FunctionSymbol;
  return (a, b) => callFunction(compare, frame, comparator, [a, b], undefined) as number;
}

/**
 * Sorts stably as Java's `TimSort` does for the short lists of learners' programs: binary insertion sort after the
 * leading run, which also calls the comparator in Java's order; longer lists merge sorted runs of that size.
 */
// code-gauge-allow functionNcss 33 -- registers the natives of one class together, in the order the prelude declares them.
// code-gauge-allow functionCognitiveComplexity 18 -- registers the natives of one class together, in the order the prelude declares them.
export function stableSort(frame: Frame, values: Value[], compare: (a: Value, b: Value) => number): Value[] {
  const array = [...values];
  if (array.length < 2) return array;
  if (array.length < 32) {
    binaryInsertionSort(
      frame,
      array,
      0,
      array.length,
      countRunAndMakeAscending(frame, array, 0, array.length, compare),
      compare
    );
    return array;
  }
  let runs: Value[][] = [];
  for (let start = 0; start < array.length; start += 32) {
    const run = array.slice(start, start + 32);
    binaryInsertionSort(
      frame,
      run,
      0,
      run.length,
      countRunAndMakeAscending(frame, run, 0, run.length, compare),
      compare
    );
    runs.push(run);
  }
  while (runs.length > 1) {
    const merged: Value[][] = [];
    for (let index = 0; index < runs.length; index += 2) {
      const left = runs[index];
      const right = runs[index + 1];
      merged.push(right ? mergeSortedRuns(frame, left, right, compare) : left);
    }
    runs = merged;
  }
  return runs[0];
}

function mergeSortedRuns(
  frame: Frame,
  left: Value[],
  right: Value[],
  compare: (a: Value, b: Value) => number
): Value[] {
  const merged: Value[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    frame.runtime.spend();
    if (compare(right[j], left[i]) < 0) merged.push(right[j++]);
    else merged.push(left[i++]);
  }
  for (; i < left.length; i++) merged.push(left[i]);
  for (; j < right.length; j++) merged.push(right[j]);
  return merged;
}

function countRunAndMakeAscending(
  frame: Frame,
  array: Value[],
  low: number,
  high: number,
  compare: (a: Value, b: Value) => number
): number {
  let runHigh = low + 1;
  if (runHigh === high) return 1;
  frame.runtime.spend();
  if (compare(array[runHigh++], array[low]) < 0) {
    while (runHigh < high && compare(array[runHigh], array[runHigh - 1]) < 0) runHigh++;
    for (let start = low, end = runHigh - 1; start < end; start++, end--)
      [array[start], array[end]] = [array[end], array[start]];
  } else {
    while (runHigh < high && compare(array[runHigh], array[runHigh - 1]) >= 0) runHigh++;
  }
  return runHigh - low;
}

function binaryInsertionSort(
  frame: Frame,
  array: Value[],
  low: number,
  high: number,
  sortedCount: number,
  compare: (a: Value, b: Value) => number
): void {
  for (let start = low + sortedCount; start < high; start++) {
    const pivot = array[start];
    let left = low;
    let right = start;
    while (left < right) {
      frame.runtime.spend();
      const middle = (left + right) >>> 1;
      if (compare(pivot, array[middle]) < 0) right = middle;
      else left = middle + 1;
    }
    array.splice(start, 1);
    array.splice(left, 0, pivot);
  }
}

const LN2 = fdlibmLog(2);

// code-gauge-allow functionNcss 42 -- registers the natives of `kotlin.math` together, in the order the prelude declares them.
// code-gauge-allow functionCognitiveComplexity 30 -- registers the natives of `kotlin.math` together, in the order the prelude declares them.
function defineMath(): void {
  const unary: [string, (x: number) => number][] = [
    ['sqrt', Math.sqrt],
    ['cbrt', fdlibmCbrt],
    ['sin', fdlibmSin],
    ['cos', fdlibmCos],
    ['tan', fdlibmTan],
    ['asin', fdlibmAsin],
    ['acos', fdlibmAcos],
    ['atan', fdlibmAtan],
    ['exp', fdlibmExp],
    ['ln', fdlibmLog],
    ['log10', fdlibmLog10],
    // Kotlin computes `log2` as `ln(x) / ln(2)`, whose last digit differs from a direct `log2` for some arguments.
    ['log2', (x) => fdlibmLog(x) / LN2],
    ['floor', Math.floor],
    ['ceil', Math.ceil],
    ['round', roundHalfEven],
    ['truncate', Math.trunc],
    ['abs', Math.abs],
    ['sign', (x) => (Number.isNaN(x) ? x : x === 0 ? x : Math.sign(x))],
  ];
  for (const [name, operation] of unary)
    defineNative(`kotlin.math.${name}(Double)`, (_frame, _receiver, [x]) => operation(x as number));
  defineNative('kotlin.math.sqrt(Float)', (_frame, _receiver, [x]) => Math.fround(Math.sqrt(x as number)));
  defineNative('kotlin.math.abs(Float)', (_frame, _receiver, [x]) => Math.abs(x as number));
  defineNative('kotlin.math.atan2(Double, Double)', (_frame, _receiver, [y, x]) =>
    fdlibmAtan2(y as number, x as number)
  );
  defineNative('kotlin.math.hypot(Double, Double)', (_frame, _receiver, [x, y]) =>
    fdlibmHypot(x as number, y as number)
  );
  defineNative('kotlin.math.log(Double, Double)', (_frame, _receiver, [x, base]) => {
    if ((base as number) <= 0 || base === 1) return Number.NaN;
    return fdlibmLog(x as number) / fdlibmLog(base as number);
  });
  for (const type of ['Double', 'Float']) {
    defineNative(`kotlin.math.max(${type}, ${type})`, (_frame, _receiver, [a, b]) => javaMax(a as number, b as number));
    defineNative(`kotlin.math.min(${type}, ${type})`, (_frame, _receiver, [a, b]) => javaMin(a as number, b as number));
  }
  for (const [type, round] of [
    ['Double', Number],
    ['Float', Math.fround],
  ] as const) {
    for (const exponent of [type, 'Int']) {
      defineNative(`kotlin.math.${type}.pow(${exponent})`, (_frame, receiver, [power]) =>
        round(fdlibmPow(receiver as number, power as number))
      );
    }
  }
  for (const type of ['Double', 'Float']) {
    defineNative(`kotlin.math.${type}.roundToInt()`, (frame, receiver) => {
      const value = receiver as number;
      if (Number.isNaN(value))
        frame.runtime.throwError(frame, 'java.lang.IllegalArgumentException', 'Cannot round NaN value.');
      return value > 2_147_483_647
        ? 2_147_483_647
        : value < -2_147_483_648
          ? -2_147_483_648
          : toInt32(Math.round(value));
    });
  }
  defineNative('kotlin.math.Double.roundToLong()', (frame, receiver) => {
    const value = receiver as number;
    if (Number.isNaN(value))
      frame.runtime.throwError(frame, 'java.lang.IllegalArgumentException', 'Cannot round NaN value.');
    if (value >= 2 ** 63) return 2n ** 63n - 1n;
    if (value <= -(2 ** 63)) return -(2n ** 63n);
    return BigInt(Math.round(value));
  });
  defineNative('kotlin.Double.nextDown()', (_frame, receiver) => nextAfter(receiver as number, -1));
  defineNative('kotlin.Double.nextUp()', (_frame, receiver) => nextAfter(receiver as number, 1));
  defineNative('kotlin.time.monotonicNanos()', () => BigInt(Math.round(performance.now() * 1_000_000)));
  defineNative('kotlin.random.platformSeed()', () => toInt32(Math.trunc(Math.random() * 2 ** 32)));
}

const bitsView = new DataView(new ArrayBuffer(8));

/** The adjacent double toward the sign's infinity, as `Math.nextUp` and `Math.nextDown` give it. */
function nextAfter(value: number, direction: 1 | -1): number {
  if (Number.isNaN(value) || value === direction * Number.POSITIVE_INFINITY) return value;
  if (value === 0) return direction * Number.MIN_VALUE;
  bitsView.setFloat64(0, value);
  const bits = bitsView.getBigInt64(0);
  bitsView.setBigInt64(0, value > 0 === direction > 0 ? bits + 1n : bits - 1n);
  return bitsView.getFloat64(0);
}

/** `Math.round` of Kotlin's `round`, which rounds half to even, as `Math.rint` does. */
function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const difference = value - floor;
  let rounded: number;
  if (difference < 0.5) rounded = floor;
  else if (difference > 0.5) rounded = floor + 1;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  // Math.rint keeps the sign of a value that rounds to zero, so round(-0.5) is -0.0.
  return rounded === 0 && value < 0 ? -0 : rounded;
}

/** `Math.max`, where NaN wins and 0.0 is greater than -0.0. */
function javaMax(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  if (a === 0 && b === 0) return Object.is(a, -0) ? b : a;
  return a >= b ? a : b;
}

function javaMin(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  if (a === 0 && b === 0) return Object.is(a, -0) ? a : b;
  return a <= b ? a : b;
}

/** The receivers of the generated array functions, as the prelude writes them. */
const ARRAY_RECEIVERS: [receiver: string, kind: PrimitiveKind | 'Boolean' | undefined, zero: Value][] = [
  ['Array<out T>', undefined, NULL],
  ...PRIMITIVE_ARRAYS,
];

function boxedItems(array: Value, kind: PrimitiveKind | 'Boolean' | undefined): Value[] {
  const items = (array as KObject).items as Value[];
  return kind === undefined || kind === 'Boolean' ? items : items.map((value) => box(kind, value as number));
}

function copyArray(frame: Frame, array: Value, size: number, makeItems: () => Value[]): KObject {
  checkSize(frame, size);
  const copy = new KObject((array as KObject).cls, 0);
  copy.items = makeItems();
  return copy;
}

const fromVararg =
  (name: string) =>
  (frame: Frame, _receiver: Value, [elements]: Value[]): Value => {
    const array = new KObject(libraryClass(`kotlin.${name}`), 0);
    array.items = [...((elements as KObject).items as Value[])];
    frame.runtime.allocate(frame, array.items.length + 1);
    return array;
  };

/** Kotlin's unsigned arrays are value classes, whose `toString` shows their storage, as `UIntArray(storage=[1, 2])`. */
function defineUnsignedArrayStrings(): void {
  for (const [name, kind] of UNSIGNED_ARRAYS) {
    defineNative(`kotlin.${name}.toString()`, (frame, receiver) => {
      const values = ((receiver as KObject).items as (number | bigint)[]).map((value) => formatPrimitive(kind, value));
      const text = `${name}(storage=[${values.join(', ')}])`;
      frame.runtime.allocateString(frame, text.length);
      return text;
    });
  }
}

function defineArrayFunctions(): void {
  for (const [receiver, kind, zero] of ARRAY_RECEIVERS) {
    defineArrayReading(receiver, kind, zero);
    defineArrayChanging(receiver, kind);
  }
  defineNative('kotlin.collections.arrayOf(vararg T)', fromVararg('Array'));
  defineNative('kotlin.collections.emptyArray()', (frame) =>
    fromVararg('Array')(frame, undefined, [Object.assign(new KObject(libraryClass('kotlin.Array'), 0), { items: [] })])
  );
  defineNative('kotlin.collections.arrayOfNulls(Int)', (frame, _receiver, [size]) => {
    checkSize(frame, size as number);
    const array = new KObject(libraryClass('kotlin.Array'), 0);
    array.items = Array.from({ length: size as number }, (): Value => NULL);
    return array;
  });
  for (const [name, kind] of PRIMITIVE_ARRAYS) {
    defineNative(`kotlin.collections.${arrayFactoryName(name)}(vararg ${kind})`, fromVararg(name));
  }
}

// code-gauge-allow functionNcss 36 -- Registers the array readers together in prelude declaration order.
function defineArrayReading(receiver: string, kind: PrimitiveKind | 'Boolean' | undefined, zero: Value): void {
  const prefix = `kotlin.collections.${receiver}`;
  defineNative(`${prefix}.asList()`, (frame, array) => {
    const source = array as KObject;
    if (kind !== undefined) return newPrimitiveArrayList(frame, { source, kind });
    const list = newList(frame, 'ArraysList', []);
    list.items = source.items;
    return list;
  });
  defineNative(`${prefix}.contentToString()`, (frame, array) => {
    const text = `[${boxedItems(array, kind)
      .map((value) => stringOf(frame, value))
      .join(', ')}]`;
    frame.runtime.allocateString(frame, text.length);
    return text;
  });
  defineNative(`${prefix}.copyOf()`, (frame, array) => {
    const items = (array as KObject).items as Value[];
    return copyArray(frame, array, items.length, () => [...items]);
  });
  defineNative(`${prefix}.copyOf(Int)`, (frame, array, [newSize]) => {
    const size = newSize as number;
    const items = (array as KObject).items as Value[];
    return copyArray(frame, array, size, () =>
      Array.from({ length: size }, (_, index) => (index < items.length ? items[index] : zero))
    );
  });
  defineNative(`${prefix}.copyOfRange(Int, Int)`, (frame, array, [from, to]) => {
    const items = (array as KObject).items as Value[];
    const start = from as number;
    const end = to as number;
    if (end > items.length)
      frame.runtime.throwError(
        frame,
        'java.lang.IndexOutOfBoundsException',
        `toIndex (${end}) is greater than size (${items.length}).`
      );
    if (start > end) frame.runtime.throwError(frame, 'java.lang.IllegalArgumentException', `${start} > ${end}`);
    const copied = items.slice(start, end);
    return copyArray(frame, array, copied.length, () => copied);
  });
  defineNative(`${prefix}.contentEquals(${receiver})`, (frame, array, [other]) => {
    if (other === undefined) return false;
    const a = boxedItems(array, kind);
    const b = boxedItems(other, kind);
    return a.length === b.length && a.every((value, index) => valueEquals(frame, value, b[index]));
  });
}

/** What changes an array in place. */
function defineArrayChanging(receiver: string, kind: PrimitiveKind | 'Boolean' | undefined): void {
  const prefix = `kotlin.collections.${receiver}`;
  const target = receiver.replace('out ', '');
  defineNative(`${prefix}.copyInto(${target}, Int, Int, Int)`, (frame, source, args) =>
    copyArrayInto(frame, kind, source, args)
  );
  const element = kind ?? 'T';
  defineNative(`${prefix}.fill(${element}, Int, Int)`, (frame, array, [value, from, to]) => {
    const items = (array as KObject).items as Value[];
    const start = from as number;
    const end = to as number;
    if (start < 0 || end > items.length)
      frame.runtime.throwError(
        frame,
        'java.lang.ArrayIndexOutOfBoundsException',
        `Array index out of range: ${start < 0 ? start : end}`
      );
    if (start > end)
      frame.runtime.throwError(frame, 'java.lang.IllegalArgumentException', `fromIndex(${start}) > toIndex(${end})`);
    items.fill(value, start, end);
    return UNIT;
  });
  defineNative(`${prefix}.reverse()`, (_frame, array) => {
    ((array as KObject).items as Value[]).reverse();
    return UNIT;
  });
  if (kind !== undefined && kind !== 'Boolean') {
    defineNative(`${prefix}.sort()`, (_frame, array) => {
      const items = (array as KObject).items as Value[];
      const isFloating = kind === 'Double' || kind === 'Float';
      items.sort((a, b) =>
        isFloating
          ? compareDoubles(a as number, b as number)
          : compareNumbers(a as number | bigint, b as number | bigint)
      );
      return UNIT;
    });
  }
}

function copyArrayInto(frame: Frame, kind: PrimitiveKind | 'Boolean' | undefined, source: Value, args: Value[]): Value {
  const [destination, destinationOffset, startIndex, endIndex] = args;
  const from = (source as KObject).items as Value[];
  const to = (destination as KObject).items as Value[];
  const start = startIndex as number;
  const offset = destinationOffset as number;
  const length = toInt32((endIndex as number) - start);
  const name = kind?.replace(/^U/, '').toLowerCase() ?? 'object array';
  const reject = (message: string): never =>
    frame.runtime.throwError(frame, 'java.lang.ArrayIndexOutOfBoundsException', `arraycopy: ${message}`);
  if (start < 0) reject(`source index ${start} out of bounds for ${name}[${from.length}]`);
  if (offset < 0) reject(`destination index ${offset} out of bounds for ${name}[${to.length}]`);
  if (length < 0) reject(`length ${length} is negative`);
  if (start + length > from.length)
    reject(`last source index ${start + length} out of bounds for ${name}[${from.length}]`);
  if (offset + length > to.length)
    reject(`last destination index ${offset + length} out of bounds for ${name}[${to.length}]`);
  frame.runtime.spend(Math.ceil(length / 64));
  if (from === to) to.copyWithin(offset, start, start + length);
  else for (let index = 0; index < length; index++) to[offset + index] = from[start + index];
  return destination;
}

defineArrays();
defineUnsignedArrayStrings();
defineArrayFunctions();
defineMath();
