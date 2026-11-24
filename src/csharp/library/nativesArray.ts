import { defineNatives, type NativeCall } from '../natives';
import { nullableUnderlying, sameType, type Type } from '../types';
import { copyValue, CsArray, CsBox, CsObject, type Value } from '../values';
import { LibraryEnumerator } from './iteration';
import {
  binarySearch,
  comparisonOf,
  equalityOf,
  failDestinationIndex,
  guardedComparison,
  indexOfValue,
  predicateOf,
  rangeBinarySearch,
  reverseRange,
  sortItems,
} from './nativesCollections';
import { introSort } from './sort';
import {
  chargeElements,
  chargeStructFields,
  checkArrayStore,
  evaluatorOf,
  fail,
  failIndex,
  failNegative,
  failNull,
  failOutOfRange,
  libraryType,
  newArray,
  newArrayOf,
  refOf,
  storeInArray,
  typeArgument,
} from './support';

const ARRAY = 'System.Array';

/** `Array.LastIndexOf` over the `count` elements that end at `start`, searching backward. */
function arrayLastIndexOf(call: NativeCall, values: Value[], value: Value, start: number, count: number): number {
  if (values.length === 0) return -1;
  if (start < 0 || start >= values.length)
    failOutOfRange(
      call,
      'startIndex',
      'Index was out of range. Must be non-negative and less than the size of the collection.'
    );
  if (count < 0 || start - count + 1 < 0) failCount(call);
  const found = indexOfValue(call, values.slice(start - count + 1, start + 1), value, 0, true);
  return found < 0 ? -1 : found + start - count + 1;
}

function failCount(call: NativeCall): never {
  return failOutOfRange(
    call,
    'count',
    'Count must be positive and count must refer to a location within the string/array/collection.'
  );
}

function failStartIndex(call: NativeCall): never {
  return failOutOfRange(
    call,
    'startIndex',
    'Index was out of range. Must be non-negative and less than or equal to the size of the collection.'
  );
}

/** The range check of Array.Reverse and Array.Sort with an index and a length. */
function checkArrayRange(call: NativeCall, size: number, index: number, length: number): void {
  if (index < 0) failOutOfRange(call, 'index', 'Non-negative number required.');
  if (length < 0) failOutOfRange(call, 'length', 'Non-negative number required.');
  if (index + length > size) {
    fail(
      'System.ArgumentException',
      'Offset and length were out of bounds for the array or count is greater than the number of elements from index to the end of the source collection.'
    );
  }
}

function arrayOf(value: Value, name = 'array'): CsArray {
  if (value === undefined) failNull(name);
  return value as CsArray;
}

function checkValueIndex(array: CsArray, index: number): void {
  if (index < 0 || index >= array.values.length)
    fail('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');
}

/** Resets elements to their default, a value of its own in each slot, since a struct default is mutable storage. */
function clearRange(call: NativeCall, array: CsArray, index: number, length: number): void {
  chargeElements(call, length);
  const evaluator = evaluatorOf(call);
  const type = elementTypeOf(array);
  for (let offset = index; offset < index + length; offset++) array.values[offset] = evaluator.defaultOf(type);
}

function elementTypeOf(array: CsArray): Type {
  return array.type.element;
}

defineNatives({
  [`${ARRAY}.get_Length`]: (_call, receiver) => arrayOf(receiver).values.length,
  [`${ARRAY}.get_LongLength`]: (_call, receiver) => BigInt(arrayOf(receiver).values.length),
  [`${ARRAY}.get_Rank`]: (_call, receiver) => arrayOf(receiver).type.rank,
  [`${ARRAY}.GetLength`]: (_call, receiver, [dimension]) => {
    const array = arrayOf(receiver);
    if ((dimension as number) < 0 || (dimension as number) >= array.lengths.length)
      fail('System.IndexOutOfRangeException', 'Array does not have that many dimensions.');
    return array.lengths[dimension as number];
  },
  [`${ARRAY}.GetUpperBound`]: (_call, receiver, [dimension]) => arrayOf(receiver).lengths[dimension as number] - 1,
  [`${ARRAY}.GetLowerBound`]: () => 0,
  // `GetValue` and `SetValue` take and return `object`, so value-type elements cross them boxed.
  [`${ARRAY}.GetValue`]: (call, receiver, [index]) => {
    const array = arrayOf(receiver);
    checkValueIndex(array, index as number);
    return evaluatorOf(call).box(array.values[index as number], elementTypeOf(array));
  },
  [`${ARRAY}.SetValue`]: (call, receiver, [value, index]) => {
    const array = arrayOf(receiver);
    checkValueIndex(array, index as number);
    const stored = evaluatorOf(call).unbox(value as Value, elementTypeOf(array));
    checkArrayStore(call, array, stored);
    array.values[index as number] = stored;
    return;
  },
  [`${ARRAY}.Clone`]: (call, receiver) => {
    const array = arrayOf(receiver);
    call.frame.runtime.allocateSlots(array.values.length);
    chargeStructFields(call, array.values);
    return new CsArray(
      array.type,
      [...array.lengths],
      array.values.map((value) => copyValue(value))
    );
  },
  [`${ARRAY}.CopyTo`]: (call, receiver, [target, index]) => {
    const source = arrayOf(receiver);
    const destination = arrayOf(target as Value);
    if ((index as number) < 0) failDestinationIndex(call, index as number);
    if ((index as number) + source.values.length > destination.values.length)
      fail(
        'System.ArgumentException',
        "Destination array was not long enough. Check the destination index, length, and the array's lower bounds.",
        'destinationArray'
      );
    storeInArray(call, destination, index as number, source.values, source.type.element);
    return;
  },
  [`${ARRAY}.GetEnumerator`]: (call, receiver) => {
    const enumerator = new CsObject(
      libraryType(call, 'System.Linq.Internal.Enumerator', [libraryType(call, 'System.Object')]),
      []
    );
    const array = arrayOf(receiver);
    // The non-generic enumerator returns `object`, so it boxes the elements of a value type.
    const element = array.type.element;
    const isValueType = element.kind === 'named' && element.symbol.isValueType;
    // Each element is boxed as the enumerator reaches it, so the enumerator keeps no copy of the array.
    const boxed = function* (): Generator<Value> {
      for (const value of array.values)
        yield isValueType && value !== undefined ? new CsBox(element, copyValue(value)) : value;
    };
    enumerator.native = new LibraryEnumerator(boxed(), [receiver]);
    return enumerator;
  },
  [`${ARRAY}.BinarySearch(T[], T)`]: (call, _receiver, [array, value]) =>
    binarySearch(arrayOf(array as Value).values, value as Value, comparisonOf(call, undefined)),
  [`${ARRAY}.BinarySearch(T[], T, IComparer<T>?)`]: (call, _receiver, [array, value, comparer]) =>
    binarySearch(arrayOf(array as Value).values, value as Value, comparisonOf(call, comparer as Value)),
  [`${ARRAY}.BinarySearch(T[], int, int, T)`]: (call, _receiver, [array, index, length, value]) =>
    rangeBinarySearch(
      call,
      arrayOf(array as Value).values,
      { index: index as number, count: length as number, countName: 'length' },
      value as Value,
      undefined
    ),
  [`${ARRAY}.BinarySearch(T[], int, int, T, IComparer<T>?)`]: (
    call,
    _receiver,
    [array, index, length, value, comparer]
  ) =>
    rangeBinarySearch(
      call,
      arrayOf(array as Value).values,
      { index: index as number, count: length as number, countName: 'length' },
      value as Value,
      comparer as Value
    ),
  [`${ARRAY}.Clear(Array)`]: (call, _receiver, [array]) => {
    const target = arrayOf(array as Value);
    clearRange(call, target, 0, target.values.length);
    return;
  },
  [`${ARRAY}.Clear(Array, int, int)`]: (call, _receiver, [array, index, length]) => {
    const target = arrayOf(array as Value);
    if (
      (index as number) < 0 ||
      (length as number) < 0 ||
      (index as number) + (length as number) > target.values.length
    )
      fail('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');
    clearRange(call, target, index as number, length as number);
    return;
  },
  [`${ARRAY}.ConvertAll`]: (call, _receiver, [array, converter]) =>
    newArray(
      call,
      call.typeArgs[1],
      arrayOf(array as Value).values.map((item) =>
        evaluatorOf(call).invokeDelegate(call.frame, converter as Value, [item], undefined)
      )
    ),
  [`${ARRAY}.Copy(Array, Array, int)`]: (call, _receiver, [source, target, length]) =>
    copyArray(
      call,
      arrayOf(source as Value, 'sourceArray'),
      0,
      arrayOf(target as Value, 'destinationArray'),
      0,
      length as number
    ),
  [`${ARRAY}.Copy(Array, int, Array, int, int)`]: (
    call,
    _receiver,
    [source, sourceIndex, target, targetIndex, length]
  ) =>
    copyArray(
      call,
      arrayOf(source as Value, 'sourceArray'),
      sourceIndex as number,
      arrayOf(target as Value, 'destinationArray'),
      targetIndex as number,
      length as number
    ),
  [`${ARRAY}.Empty`]: (call) => newArray(call, call.typeArgs[0], []),
  [`${ARRAY}.Exists`]: (call, _receiver, [array, match]) =>
    arrayOf(array as Value).values.some(predicateOf(call, match as Value)),
  [`${ARRAY}.Fill(T[], T)`]: (call, _receiver, [array, value]) => {
    const values = arrayOf(array as Value).values;
    checkArrayStore(call, array as CsArray, value as Value);
    chargeElements(call, values.length);
    for (let index = 0; index < values.length; index++) values[index] = copyValue(value as Value);
    return;
  },
  [`${ARRAY}.Fill(T[], T, int, int)`]: (call, _receiver, [array, value, start, count]) => {
    const length = arrayOf(array as Value).values.length;
    if ((start as number) < 0 || (start as number) > length) failStartIndex(call);
    if ((count as number) < 0 || (start as number) > length - (count as number)) {
      failOutOfRange(
        call,
        'count',
        'Count must be positive and count must refer to a location within the string/array/collection.'
      );
    }
    const values = arrayOf(array as Value).values;
    checkArrayStore(call, array as CsArray, value as Value);
    chargeElements(call, count as number);
    for (let index = start as number; index < (start as number) + (count as number); index++)
      values[index] = copyValue(value as Value);
    return;
  },
  [`${ARRAY}.Find`]: (call, _receiver, [array, match]) => {
    const test = predicateOf(call, match as Value);
    for (const item of arrayOf(array as Value).values) if (test(item)) return item;
    return evaluatorOf(call).defaultOf(call.typeArgs[0]);
  },
  [`${ARRAY}.FindAll`]: (call, _receiver, [array, match]) =>
    newArray(call, call.typeArgs[0], arrayOf(array as Value).values.filter(predicateOf(call, match as Value))),
  [`${ARRAY}.FindIndex`]: (call, _receiver, args) => {
    const array = arrayOf(args[0] as Value);
    const [start, match] = args.length === 3 ? [args[1] as number, args[2]] : [0, args[1]];
    const test = predicateOf(call, match as Value);
    for (let index = start; index < array.values.length; index++) if (test(array.values[index])) return index;
    return -1;
  },
  [`${ARRAY}.FindLast`]: (call, _receiver, [array, match]) => {
    const test = predicateOf(call, match as Value);
    const values = arrayOf(array as Value).values;
    for (let index = values.length - 1; index >= 0; index--) if (test(values[index])) return values[index];
    return evaluatorOf(call).defaultOf(call.typeArgs[0]);
  },
  [`${ARRAY}.FindLastIndex`]: (call, _receiver, [array, match]) => {
    const test = predicateOf(call, match as Value);
    const values = arrayOf(array as Value).values;
    for (let index = values.length - 1; index >= 0; index--) if (test(values[index])) return index;
    return -1;
  },
  [`${ARRAY}.ForEach`]: (call, _receiver, [array, action]) => {
    for (const item of arrayOf(array as Value).values)
      evaluatorOf(call).invokeDelegate(call.frame, action as Value, [item], undefined);
    return;
  },
  [`${ARRAY}.IndexOf(T[], T)`]: (call, _receiver, [array, value]) =>
    indexOfValue(call, arrayOf(array as Value).values, value as Value),
  [`${ARRAY}.IndexOf(T[], T, int)`]: (call, _receiver, [array, value, start]) => {
    const { values } = arrayOf(array as Value);
    if ((start as number) < 0 || (start as number) > values.length) failStartIndex(call);
    return indexOfValue(call, values, value as Value, start as number);
  },
  [`${ARRAY}.IndexOf(T[], T, int, int)`]: (call, _receiver, [array, value, start, count]) => {
    const { values } = arrayOf(array as Value);
    const [from, length] = [start, count] as number[];
    if (from < 0 || from > values.length) failStartIndex(call);
    if (length < 0 || from + length > values.length) failCount(call);
    return indexOfValue(call, values, value as Value, from, false, from + length);
  },
  // The value comes boxed, while an array of a value type holds its elements unboxed.
  [`${ARRAY}.IndexOf(Array, object?)`]: (call, _receiver, [array, value]) => {
    const target = arrayOf(array as Value);
    // A non-null nullable boxes as its underlying type, which a nullable element type compares by.
    const element = elementTypeOf(target);
    const valueType = nullableUnderlying(element) ?? element;
    const sought = value instanceof CsBox && sameType(value.type, valueType) ? value.value : value;
    return indexOfValue(call, target.values, sought as Value);
  },
  [`${ARRAY}.LastIndexOf(T[], T)`]: (call, _receiver, [array, value]) =>
    indexOfValue(call, arrayOf(array as Value).values, value as Value, 0, true),
  [`${ARRAY}.LastIndexOf(T[], T, int)`]: (call, _receiver, [array, value, start]) =>
    arrayLastIndexOf(call, arrayOf(array as Value).values, value as Value, start as number, (start as number) + 1),
  [`${ARRAY}.LastIndexOf(T[], T, int, int)`]: (call, _receiver, [array, value, start, count]) =>
    arrayLastIndexOf(call, arrayOf(array as Value).values, value as Value, start as number, count as number),
  [`${ARRAY}.Resize`]: (call, _receiver, [reference, size]) => {
    if ((size as number) < 0) failOutOfRange(call, 'newSize', 'Non-negative number required.');
    const ref = refOf(reference);
    const array = ref.get() as CsArray | undefined;
    // An array that already has the size stays as it is, aliases included.
    if (array && array.values.length === size) return;
    // .NET allocates `new T[newSize]`, of the call's element type even when the old array is a covariant `string[]`.
    const elementType = call.typeArgs[0] ?? (array ? elementTypeOf(array) : undefined);
    ref.set(
      newArrayOf(call, elementType, size as number, (index) =>
        array && index < array.values.length ? array.values[index] : evaluatorOf(call).defaultOf(elementType)
      )
    );
    return;
  },
  [`${ARRAY}.Reverse(Array)`]: (call, _receiver, [array]) => {
    chargeElements(call, arrayOf(array as Value).values.length);
    arrayOf(array as Value).values.reverse();
    return;
  },
  [`${ARRAY}.Reverse(T[])`]: (call, _receiver, [array]) => {
    chargeElements(call, arrayOf(array as Value).values.length);
    arrayOf(array as Value).values.reverse();
    return;
  },
  [`${ARRAY}.Reverse(Array, int, int)`]: (call, _receiver, [array, index, length]) => {
    const values = arrayOf(array as Value).values;
    checkArrayRange(call, values.length, index as number, length as number);
    chargeElements(call, length as number);
    reverseRange(values, index as number, length as number);
    return;
  },
  [`${ARRAY}.Sort(Array)`]: (call, _receiver, [array]) =>
    sortArray(call, arrayOf(array as Value), 0, undefined, undefined),
  [`${ARRAY}.Sort(T[])`]: (call, _receiver, [array]) =>
    sortArray(call, arrayOf(array as Value), 0, undefined, undefined),
  [`${ARRAY}.Sort(T[], Comparison<T>)`]: (call, _receiver, [array, comparison]) => {
    if (comparison === undefined) failNull('comparison');
    return sortArray(call, arrayOf(array as Value), 0, undefined, comparison as Value);
  },
  [`${ARRAY}.Sort(T[], IComparer<T>?)`]: (call, _receiver, [array, comparer]) =>
    sortArray(call, arrayOf(array as Value), 0, undefined, comparer as Value),
  [`${ARRAY}.Sort(T[], int, int)`]: (call, _receiver, [array, index, length]) => {
    checkArrayRange(call, arrayOf(array as Value).values.length, index as number, length as number);
    return sortArray(call, arrayOf(array as Value), index as number, length as number, undefined);
  },
  [`${ARRAY}.Sort(TKey[], TValue[])`]: (call, _receiver, [keys, items]) => {
    const keyArray = arrayOf(keys as Value, 'keys');
    const itemArray = arrayOf(items as Value, 'items');
    if (itemArray.values.length < keyArray.values.length)
      fail(
        'System.ArgumentException',
        'Offset and length were out of bounds for the array or count is greater than the number of elements from index to the end of the source collection.'
      );
    const pairs = keyArray.values.map((key, index) => ({ key, item: itemArray.values[index] }));
    const compare = guardedComparison(call, comparisonOf(call, undefined));
    introSort(pairs, 0, pairs.length, (a, b) => compare(a.key, b.key));
    for (const [index, pair] of pairs.entries()) {
      keyArray.values[index] = pair.key;
      itemArray.values[index] = pair.item;
    }
    return;
  },
  [`${ARRAY}.TrueForAll`]: (call, _receiver, [array, match]) =>
    arrayOf(array as Value).values.every(predicateOf(call, match as Value)),
});

function sortArray(
  call: NativeCall,
  array: CsArray,
  index: number,
  length: number | undefined,
  comparer: Value
): Value {
  if (array.type.rank !== 1)
    fail('System.RankException', 'Only single dimensional arrays are supported for the requested action.');
  sortItems(call, array.values, index, length ?? array.values.length - index, comparer);
  return undefined;
}

function copyArray(
  call: NativeCall,
  source: CsArray,
  sourceIndex: number,
  target: CsArray,
  targetIndex: number,
  length: number
): Value {
  if (length < 0) failNegative(call, 'length', length);
  if (sourceIndex < 0 || targetIndex < 0)
    failOutOfRange(call, sourceIndex < 0 ? 'sourceIndex' : 'destinationIndex', 'Non-negative number required.');
  if (sourceIndex + length > source.values.length)
    fail(
      'System.ArgumentException',
      "Source array was not long enough. Check the source index, length, and the array's lower bounds.",
      'sourceArray'
    );
  if (targetIndex + length > target.values.length)
    fail(
      'System.ArgumentException',
      "Destination array was not long enough. Check the destination index, length, and the array's lower bounds.",
      'destinationArray'
    );
  storeInArray(call, target, targetIndex, source.values.slice(sourceIndex, sourceIndex + length), source.type.element);
  return undefined;
}

const ARRAY_HELPER = 'System.Linq.Internal.ArrayHelper`1';
const fixedSize = (): never => fail('System.NotSupportedException', 'Collection was of a fixed size.');

function arrayIndexOf(call: NativeCall, array: CsArray, item: Value): number {
  const equality = equalityOf(call, undefined);
  return array.values.findIndex((value) =>
    value === undefined ? item === undefined : item !== undefined && equality.equals(value, item)
  );
}

function checkedArrayIndex(call: NativeCall, array: CsArray, index: number): number {
  if (index < 0 || index >= array.values.length) failIndex(call);
  return index;
}

defineNatives({
  [`${ARRAY_HELPER}.get_Count`]: (_call, receiver) => (receiver as CsArray).values.length,
  [`${ARRAY_HELPER}.get_IsReadOnly`]: () => true,
  [`${ARRAY_HELPER}.get_Item`]: (call, receiver, [index]) =>
    (receiver as CsArray).values[checkedArrayIndex(call, receiver as CsArray, index as number)],
  [`${ARRAY_HELPER}.set_Item`]: (call, receiver, [index, value]) => {
    const position = checkedArrayIndex(call, receiver as CsArray, index as number);
    checkArrayStore(call, receiver as CsArray, value as Value);
    (receiver as CsArray).values[position] = value as Value;
    return;
  },
  [`${ARRAY_HELPER}.Add`]: fixedSize,
  [`${ARRAY_HELPER}.Clear`]: fixedSize,
  [`${ARRAY_HELPER}.Insert`]: fixedSize,
  [`${ARRAY_HELPER}.Remove`]: fixedSize,
  [`${ARRAY_HELPER}.RemoveAt`]: fixedSize,
  [`${ARRAY_HELPER}.Contains`]: (call, receiver, [item]) => arrayIndexOf(call, receiver as CsArray, item as Value) >= 0,
  [`${ARRAY_HELPER}.IndexOf`]: (call, receiver, [item]) => arrayIndexOf(call, receiver as CsArray, item as Value),
  [`${ARRAY_HELPER}.CopyTo`]: (call, receiver, [target, start]) => {
    if (target === undefined) failNull('array');
    const values = (receiver as CsArray).values;
    const destination = (target as CsArray).values;
    if ((start as number) < 0 || (start as number) + values.length > destination.length) {
      fail(
        'System.ArgumentException',
        "Destination array was not long enough. Check the destination index, length, and the array's lower bounds.",
        'destinationArray'
      );
    }
    storeInArray(call, target as CsArray, start as number, values, (receiver as CsArray).type.element);
    return;
  },
  [`${ARRAY_HELPER}.GetEnumerator`]: (call, receiver) => {
    const enumerator = new CsObject(libraryType(call, 'System.Linq.Internal.Enumerator', [typeArgument(call)]), []);
    enumerator.native = new LibraryEnumerator((receiver as CsArray).values[Symbol.iterator](), [receiver]);
    return enumerator;
  },
});
