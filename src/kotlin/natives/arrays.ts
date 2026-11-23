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
import { hashOf, stringOf } from '../format';
import { compareDoubles, compareNumbers, toInt32 } from '../operators';
import { arrayFactoryName, UNSIGNED_ARRAYS } from '../prelude/arrays';
import type { Frame } from '../runtime';
import type { FunctionSymbol } from '../symbols';
import { box, type Boxed, indexedSize, KObject, listView, NULL, type PrimitiveKind, UNIT, type Value } from '../values';
import { checkListView, elementsOf, joinRendered, newList, newPrimitiveArrayList, touch } from './collections';
import {
  callCollectionMember,
  collectionIterator,
  collectionSize,
  copyCollectionToArray,
  forEachIterable,
  objectsEqual,
} from './collectionTraversal';
import { arrayIterator, checkArrayIndex } from './core';
import { defineNative, defineNativeProperty, libraryClass } from './registry';
import { stableSort } from './timSort';

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

// code-gauge-allow functionNcss -- registers the natives of one class together, in the order the prelude declares them.
function defineArrays(): void {
  defineNative('kotlin.Array.clone()', cloneArray);
  for (const [name, kind, zero] of PRIMITIVE_ARRAYS) {
    const prefix = `kotlin.${name}`;
    if (!name.startsWith('U')) defineNative(`${prefix}.clone()`, cloneArray);
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
  defineNative('kotlin.collections.MutableList<T>.sortWith(Comparator<in T>)', sortList);
  defineNative(
    'kotlin.collections.Array<out T>.sortWith(Comparator<in T>, Int, Int)',
    (frame, array, [comparator, from, to]) => {
      const values = (array as KObject).items as Value[];
      checkArrayRange(frame, values.length, from as number, to as number);
      sortValues(frame, array, comparator, values, from as number, to as number);
      return UNIT;
    }
  );
}

function sortList(frame: Frame, list: Value, [comparator]: Value[]): Value {
  const object = list as KObject;
  const view = listView(object);
  const source = view?.source ?? object;
  if (source.arrayList) {
    checkListView(frame, object);
    const from = view?.from ?? 0;
    const values = source.items as Value[];
    const size = view?.size ?? indexedSize(source);
    if (size <= 1) return UNIT;
    const modCount = source.modCount;
    sortValues(frame, list, comparator, values, from, from + size);
    if (source.modCount !== modCount) frame.runtime.throwError(frame, 'java.util.ConcurrentModificationException');
    if (!view) touch(source);
  } else if (!view && source.cls === libraryClass('kotlin.collections.ArraysList')) {
    const values = source.items as Value[];
    sortValues(frame, list, comparator, values, 0, values.length);
  } else {
    if (collectionSize(frame, list) <= 1) return UNIT;
    const values = copyCollectionToArray(frame, object);
    sortValues(frame, list, comparator, values, 0, values.length);
    writeSortedList(frame, object, values);
  }
  return UNIT;
}

function sortValues(frame: Frame, owner: Value, comparator: Value, values: Value[], from: number, to: number): void {
  if (to - from <= 1) return;
  frame.runtime.spend(1 + Math.floor((to - from) / 64));
  frame.runtime.withNativeRoots([owner, comparator, values], () => {
    stableSort(frame, values, comparatorFunction(frame, comparator), from, to);
  });
}

function writeSortedList(frame: Frame, list: KObject, values: Value[]): void {
  frame.runtime.withNativeRoots([values], () => {
    const iterator = collectionIterator(frame, list, 'listIterator');
    frame.runtime.withNativeRoots([iterator.value], () => {
      for (const value of values) {
        iterator.next();
        callCollectionMember(frame, iterator.value, 'kotlin.collections.MutableListIterator', 'set', [value]);
      }
    });
  });
}

/** Calls a `Comparator`'s `compare`, dispatched on its class. */
export function comparatorFunction(frame: Frame, comparator: Value): (a: Value, b: Value) => number {
  const compare = libraryClass('kotlin.Comparator').members.get('compare')?.[0] as FunctionSymbol;
  return (a, b) => callFunction(compare, frame, comparator, [a, b], undefined) as number;
}

const LN2 = fdlibmLog(2);

// code-gauge-allow functionNcss -- registers the natives of `kotlin.math` together, in the order the prelude declares them.
// code-gauge-allow functionCognitiveComplexity -- registers the natives of `kotlin.math` together, in the order the prelude declares them.
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
    defineNative(`kotlin.math.${type}.nextDown()`, (_frame, receiver) =>
      nextAfter(receiver as number, -1, type === 'Float')
    );
    defineNative(`kotlin.math.${type}.nextUp()`, (_frame, receiver) =>
      nextAfter(receiver as number, 1, type === 'Float')
    );
    defineNative(`kotlin.math.${type}.withSign(${type})`, copySign);
    defineNative(`kotlin.math.${type}.withSign(Int)`, copySign);
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
  defineNative('kotlin.time.monotonicNanos()', () => BigInt(Math.round(performance.now() * 1_000_000)));
  defineNative('kotlin.random.platformSeed()', () => toInt32(Math.trunc(Math.random() * 2 ** 32)));
}

const bitsView = new DataView(new ArrayBuffer(8));

function copySign(_frame: Frame, value: Value, [sign]: Value[]): number {
  bitsView.setFloat64(0, sign as number);
  const signBit = bitsView.getUint8(0) & 0x80;
  bitsView.setFloat64(0, value as number);
  bitsView.setUint8(0, (bitsView.getUint8(0) & 0x7f) | signBit);
  return bitsView.getFloat64(0);
}

function nextAfter(value: number, direction: 1 | -1, isFloat: boolean): number {
  if (Number.isNaN(value) || value === direction * Number.POSITIVE_INFINITY) return value;
  if (value === 0) return direction * (isFloat ? 2 ** -149 : Number.MIN_VALUE);
  const step = value > 0 === direction > 0 ? 1 : -1;
  if (isFloat) {
    bitsView.setFloat32(0, value);
    bitsView.setInt32(0, bitsView.getInt32(0) + step);
    return bitsView.getFloat32(0);
  }
  bitsView.setFloat64(0, value);
  bitsView.setBigInt64(0, bitsView.getBigInt64(0) + BigInt(step));
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

export function arrayContentString(frame: Frame, array: Value, kind?: PrimitiveKind | 'Boolean'): string {
  if (array === NULL) return 'null';
  return joinRendered(frame, boxedItems(array, kind), '[', ']', (value) => stringOf(frame, value));
}

export function arrayContentHash(frame: Frame, array: Value, kind?: PrimitiveKind | 'Boolean'): number {
  if (array === NULL) return 0;
  let hash = 1;
  for (const item of boxedItems(array, kind)) {
    frame.runtime.spend();
    hash = toInt32(Math.imul(hash, 31) + hashOf(frame, item));
  }
  return hash;
}

export function dataArrayKind(name: string): PrimitiveKind | 'Boolean' | undefined {
  return PRIMITIVE_ARRAYS.find(([array]) => array === name)?.[1];
}

function boxedItems(array: Value, kind: PrimitiveKind | 'Boolean' | undefined): Value[] {
  const items = (array as KObject).items as Value[];
  return kind === undefined || kind === 'Boolean'
    ? items
    : items.map((value) => box(kind, arrayStorageValue(kind, value as number | bigint)));
}

function arrayStorageValue(kind: PrimitiveKind, value: number | bigint): number | bigint {
  switch (kind) {
    case 'Byte': {
      return ((value as number) << 24) >> 24;
    }
    case 'Short': {
      return ((value as number) << 16) >> 16;
    }
    case 'Int': {
      return toInt32(value as number);
    }
    case 'Long': {
      return BigInt.asIntN(64, value as bigint);
    }
    default: {
      return value;
    }
  }
}

const SIGNED_STORAGE = { UByte: 'Byte', UShort: 'Short', UInt: 'Int', ULong: 'Long' } as const;

function cloneArray(frame: Frame, array: Value): KObject {
  const items = (array as KObject).items as Value[];
  return copyArray(frame, array, items.length, () => [...items]);
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
      const values = boxedItems(receiver, SIGNED_STORAGE[kind]);
      return joinRendered(frame, values, `${name}(storage=[`, '])', (value) => stringOf(frame, value));
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

function defineArrayReading(receiver: string, kind: PrimitiveKind | 'Boolean' | undefined, zero: Value): void {
  const prefix = `kotlin.collections.${receiver}`;
  defineNative(`${prefix}.asList()`, (frame, array) => {
    const source = array as KObject;
    if (kind !== undefined) return newPrimitiveArrayList(frame, { source, kind });
    const list = newList(frame, 'ArraysList', []);
    list.items = source.items;
    return list;
  });
  defineNative(`${prefix}?.contentHashCode()`, (frame, array) => {
    const storage = kind && SIGNED_STORAGE[kind as keyof typeof SIGNED_STORAGE];
    return arrayContentHash(frame, array, storage || kind);
  });
  defineNative(`${prefix}?.contentToString()`, (frame, array) => arrayContentString(frame, array, kind));
  defineNative(`${prefix}.sliceArray(Collection<Int>)`, (frame, array, [indices]) =>
    sliceArrayByIndex(frame, array, indices, zero)
  );
  defineNative(`${prefix}.copyOf()`, cloneArray);
  defineNative(`${prefix}.copyOf(Int)`, (frame, array, [newSize]) => {
    const size = newSize as number;
    const items = (array as KObject).items as Value[];
    return copyArray(frame, array, size, () =>
      Array.from({ length: size }, (_, index) => (index < items.length ? items[index] : zero))
    );
  });
  defineNative(`${prefix}.copyOfRange(Int, Int)`, (frame, array, [from, to]) =>
    copyArrayRange(frame, kind, array, from as number, to as number)
  );
  defineNative(`${prefix}?.contentEquals(${receiver}?)`, (frame, array, [other]) => {
    if (array === other) return true;
    if (array === NULL || other === NULL) return false;
    const a = boxedItems(array, kind);
    const b = boxedItems(other, kind);
    return a.length === b.length && a.every((value, index) => objectsEqual(frame, value, b[index]));
  });
}

function sliceArrayByIndex(frame: Frame, array: Value, indices: Value, zero: Value): Value {
  const items = (array as KObject).items as Value[];
  const size = collectionSize(frame, indices);
  return copyArray(frame, array, size, () => {
    const result = Array.from({ length: size }, () => zero);
    let offset = 0;
    frame.runtime.withNativeRoots([result], () => {
      forEachIterable(frame, indices, (index) => {
        const sourceIndex = (index as Boxed).value as number;
        checkArrayIndex(frame, items, sourceIndex);
        checkArrayIndex(frame, result, offset);
        result[offset++] = items[sourceIndex];
      });
    });
    return result;
  });
}

function copyArrayRange(
  frame: Frame,
  kind: PrimitiveKind | 'Boolean' | undefined,
  array: Value,
  start: number,
  end: number
): Value {
  const items = (array as KObject).items as Value[];
  if (end > items.length)
    frame.runtime.throwError(
      frame,
      'java.lang.IndexOutOfBoundsException',
      `toIndex (${end}) is greater than size (${items.length}).`
    );
  if (start > end) frame.runtime.throwError(frame, 'java.lang.IllegalArgumentException', `${start} > ${end}`);
  if (start < 0)
    rejectArrayCopy(frame, `source index ${start} out of bounds for ${arrayStorageName(kind)}[${items.length}]`);
  const copied = items.slice(start, end);
  return copyArray(frame, array, copied.length, () => copied);
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
    checkArrayRange(frame, items.length, start, end);
    items.fill(value, start, end);
    return UNIT;
  });
  defineNative(`${prefix}.reverse(Int, Int)`, reverseArrayRange);
  if (kind !== undefined && kind !== 'Boolean') {
    defineNative(`${prefix}.sort(Int, Int)`, (frame, array, [from, to]) =>
      sortPrimitiveArrayRange(frame, array, kind, from as number, to as number)
    );
  }
}

function checkArrayRange(frame: Frame, size: number, from: number, to: number): void {
  if (from > to)
    frame.runtime.throwError(frame, 'java.lang.IllegalArgumentException', `fromIndex(${from}) > toIndex(${to})`);
  if (from < 0 || to > size)
    frame.runtime.throwError(
      frame,
      'java.lang.ArrayIndexOutOfBoundsException',
      `Array index out of range: ${from < 0 ? from : to}`
    );
}

function checkKotlinArrayRange(frame: Frame, size: number, from: number, to: number): void {
  if (from < 0 || to > size)
    frame.runtime.throwError(
      frame,
      'java.lang.IndexOutOfBoundsException',
      `fromIndex: ${from}, toIndex: ${to}, size: ${size}`
    );
  if (from > to)
    frame.runtime.throwError(frame, 'java.lang.IllegalArgumentException', `fromIndex: ${from} > toIndex: ${to}`);
}

function reverseArrayRange(frame: Frame, array: Value, [from, to]: Value[]): Value {
  const items = (array as KObject).items as Value[];
  const start = from as number;
  const end = to as number;
  checkKotlinArrayRange(frame, items.length, start, end);
  frame.runtime.spend(Math.ceil((end - start) / 64));
  for (let left = start, right = end - 1; left < right; left++, right--) {
    const value = items[left];
    items[left] = items[right];
    items[right] = value;
  }
  return UNIT;
}

function sortPrimitiveArrayRange(frame: Frame, array: Value, kind: PrimitiveKind, from: number, to: number): Value {
  const items = (array as KObject).items as Value[];
  if (kind.startsWith('U')) checkKotlinArrayRange(frame, items.length, from, to);
  else checkArrayRange(frame, items.length, from, to);
  if (to - from <= 1) return UNIT;
  frame.runtime.spend(1 + Math.floor((to - from) / 64));
  const isFloating = kind === 'Double' || kind === 'Float';
  const range = from === 0 && to === items.length ? items : items.slice(from, to);
  range.sort((a, b) =>
    isFloating ? compareDoubles(a as number, b as number) : compareNumbers(a as number | bigint, b as number | bigint)
  );
  if (range !== items) for (const [index, value] of range.entries()) items[from + index] = value;
  return UNIT;
}

function copyArrayInto(frame: Frame, kind: PrimitiveKind | 'Boolean' | undefined, source: Value, args: Value[]): Value {
  const [destination, destinationOffset, startIndex, endIndex] = args;
  const from = (source as KObject).items as Value[];
  const to = (destination as KObject).items as Value[];
  const start = startIndex as number;
  const offset = destinationOffset as number;
  const length = toInt32((endIndex as number) - start);
  const name = arrayStorageName(kind);
  if (start < 0) rejectArrayCopy(frame, `source index ${start} out of bounds for ${name}[${from.length}]`);
  if (offset < 0) rejectArrayCopy(frame, `destination index ${offset} out of bounds for ${name}[${to.length}]`);
  if (length < 0) rejectArrayCopy(frame, `length ${length} is negative`);
  if (start + length > from.length)
    rejectArrayCopy(frame, `last source index ${start + length} out of bounds for ${name}[${from.length}]`);
  if (offset + length > to.length)
    rejectArrayCopy(frame, `last destination index ${offset + length} out of bounds for ${name}[${to.length}]`);
  frame.runtime.spend(Math.ceil(length / 64));
  if (from === to) to.copyWithin(offset, start, start + length);
  else for (let index = 0; index < length; index++) to[offset + index] = from[start + index];
  return destination;
}

function arrayStorageName(kind: PrimitiveKind | 'Boolean' | undefined): string {
  return kind?.replace(/^U/, '').toLowerCase() ?? 'object array';
}

function rejectArrayCopy(frame: Frame, message: string): never {
  return frame.runtime.throwError(frame, 'java.lang.ArrayIndexOutOfBoundsException', `arraycopy: ${message}`);
}

defineArrays();
defineUnsignedArrayStrings();
defineArrayFunctions();
defineMath();
