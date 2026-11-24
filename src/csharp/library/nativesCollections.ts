// code-gauge-allow-file fileNcss -- The nativesCollections module keeps one stage of the C# interpreter together.
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { PendingException } from '../numeric';
import { defaultCompare, environmentOf, hashOf, runtimeTypeName, stringOf, valuesEqual } from '../objects';
import { CsThrow } from '../runtime';
import { type MethodSymbol, specialOf, substitute, substitutionOf, type Type } from '../types';
import { copyValue, CsArray, CsDelegate, CsObject, CsStruct, type Value, type VariableReference } from '../values';
import { collectionModified, type EnumerableState, iterate, LibraryEnumerator } from './iteration';
import { InconsistentComparer, introSort } from './sort';
import {
  bufferedElements,
  chargeElements,
  chargeStructFields,
  copyToArray,
  dictionaryKeyText,
  evaluatorOf,
  fail,
  failIndex,
  failNegative,
  failNull,
  failOutOfRange,
  libraryType,
  NARROW_INTEGRALS,
  newArray,
  nullReference,
  refOf,
  stepMeter,
  storeInArray,
  textOf,
  typeArgument,
} from './support';

// ---- Comparers ----

/** How a collection compares elements: the program's comparer or comparison, or the default. */
export type Comparison = (a: Value, b: Value) => number;
export interface Equality {
  equals: (a: Value, b: Value) => boolean;
  hash: (value: Value) => number;
}

/**
 * The comparison of a `Comparison<T>` delegate, an `IComparer<T>`, or the default ordering when it is null. It is
 * metered like each comparison and hash that natives make through `equalityOf`, so a native whose loops compare
 * elements pays for each comparison without counting it itself.
 */
export function comparisonOf(call: NativeCall, comparer: Value): Comparison {
  const compare = unmeteredComparisonOf(call, comparer);
  const step = stepMeter(call);
  return (a, b) => {
    step();
    return compare(a, b);
  };
}

function unmeteredComparisonOf(call: NativeCall, comparer: Value): Comparison {
  const evaluator = evaluatorOf(call);
  if (comparer === undefined) return (a, b) => defaultCompare(evaluator, a, b, call.frame);
  if (comparer instanceof CsDelegate)
    return (a, b) => evaluator.invokeDelegate(call.frame, comparer, [a, b], undefined) as number;
  if (comparer instanceof CsObject && typeof comparer.native === 'function') return comparer.native as Comparison;
  const face = call.frame.runtime.library.typeNamed('System.Collections.Generic.IComparer', 1);
  const method = face.methods.find((candidate) => candidate.name === 'Compare') as MethodSymbol;
  const implementation = call.frame.runtime.dispatch(method, comparer);
  return (a, b) =>
    evaluator.invoke(
      call.frame,
      implementation,
      comparer,
      [a, b],
      undefined,
      environmentOf(evaluator, implementation, comparer)
    ) as number;
}

/** Runs a sort's comparisons, wrapping what they throw as .NET's sorting does. */
export function guardedComparison(call: NativeCall, compare: Comparison): Comparison {
  return (a, b) => {
    try {
      return compare(a, b);
    } catch (error) {
      const thrown = evaluatorOf(call).asThrow(error);
      if (!thrown) throw error;
      if (
        thrown.exception.type.symbol.fullName === 'System.InvalidOperationException' &&
        (thrown.exception.native as { message?: string }).message === 'Failed to compare two elements in the array.'
      )
        throw thrown;
      throw new CsThrow(
        call.frame.runtime.createException(
          'System.InvalidOperationException',
          'Failed to compare two elements in the array.',
          thrown.exception
        )
      );
    }
  };
}

/**
 * The equality of an `IEqualityComparer<T>`, or `EqualityComparer<T>.Default` when it is null, whose `T` is by default
 * the method's first type argument (LINQ, Array) or else the collection's (List<T>, EqualityComparer<T>).
 */
export function equalityOf(
  call: NativeCall,
  comparer: Value,
  elementType: Type | undefined = call.typeArgs[0] ?? call.owner?.args[0]
): Equality {
  const equality = unmeteredEqualityOf(call, comparer, elementType);
  const step = stepMeter(call);
  return {
    equals: (a, b) => {
      step();
      return equality.equals(a, b);
    },
    hash: (value) => {
      step();
      return equality.hash(value);
    },
  };
}

function unmeteredEqualityOf(call: NativeCall, comparer: Value, elementType: Type | undefined): Equality {
  const evaluator = evaluatorOf(call);
  if (comparer === undefined) {
    return {
      equals: (a, b) =>
        evaluator.equalsThroughEquatable(a, b, elementType, call.frame) ?? valuesEqual(evaluator, a, b, call.frame),
      hash: (value) => hashOf(evaluator, value, call.frame),
    };
  }
  if (comparer instanceof CsObject && comparer.native && typeof (comparer.native as Equality).equals === 'function')
    return comparer.native as Equality;
  const face = call.frame.runtime.library.typeNamed('System.Collections.Generic.IEqualityComparer', 1);
  const equalsMethod = call.frame.runtime.dispatch(
    face.methods.find((candidate) => candidate.name === 'Equals') as MethodSymbol,
    comparer
  );
  const hashMethod = call.frame.runtime.dispatch(
    face.methods.find((candidate) => candidate.name === 'GetHashCode') as MethodSymbol,
    comparer
  );
  return {
    equals: (a, b) =>
      evaluator.invoke(
        call.frame,
        equalsMethod,
        comparer,
        [a, b],
        undefined,
        environmentOf(evaluator, equalsMethod, comparer)
      ) as boolean,
    hash: (value) =>
      evaluator.invoke(
        call.frame,
        hashMethod,
        comparer,
        [value],
        undefined,
        environmentOf(evaluator, hashMethod, comparer)
      ) as number,
  };
}

// ---- List ----

export class ListState implements EnumerableState {
  version = 0;
  /** For a view of a sorted dictionary's keys, where a key is by the dictionary's comparer, which its search uses. */
  indexOfKey?: (key: Value) => number;
  /** The exception an enumeration throws when the list changes under it, which a view gives its owner's. */
  modified: () => PendingException = collectionModified;
  /** The capacity of .NET's backing array, which `Capacity` shows: it starts at 4 and doubles as items are added. */
  capacity = 0;

  constructor(
    public items: Value[],
    readonly elementType: Type
  ) {}

  /** Grows the capacity as .NET's List<T> does: to 4, then by doubling, or to the size needed if more. */
  ensureCapacity(size: number): void {
    if (size <= this.capacity) return;
    this.capacity = Math.max(this.capacity === 0 ? 4 : this.capacity * 2, size);
  }

  *enumerate(): Generator<Value> {
    const version = this.version;
    for (let index = 0; index < this.items.length; index++) {
      if (this.version !== version) throw this.modified();
      yield this.items[index];
    }
    if (this.version !== version) throw this.modified();
  }

  references(): Value[] {
    return this.items;
  }

  display(): { kind: 'array'; items: [string, Value, Type][] } {
    return { kind: 'array', items: this.items.map((item, index) => [String(index), item, this.elementType]) };
  }
}

export function listOf(value: Value): ListState {
  if (value === undefined)
    fail('System.NullReferenceException', 'Object reference not set to an instance of an object.');
  return (value as CsObject).native as ListState;
}

/** Creates a `List<T>` with elements, as LINQ's `ToList` does. */
export function newList(call: NativeCall, elementType: Type, items: Value[], isCharged = false): CsObject {
  if (!isCharged) {
    call.frame.runtime.allocateSlots(items.length);
    chargeStructFields(call, items);
  }
  const list = new CsObject(libraryType(call, 'System.Collections.Generic.List', [elementType]), []);
  const state = new ListState(
    items.map((item) => copyValue(item)),
    elementType
  );
  state.capacity = items.length;
  list.native = state;
  return list;
}

function enumeratorStruct(
  call: NativeCall,
  typeName: string,
  typeArgs: Type[],
  source: Iterable<Value>,
  holds: Value[]
): CsStruct {
  const type = libraryType(call, typeName, typeArgs);
  const enumerator = new CsStruct(type, []);
  enumerator.native = new LibraryEnumerator(source[Symbol.iterator](), holds);
  return enumerator;
}

// A default enumerator (`default(List<int>.Enumerator)`) has no collection, which MoveNext reads as .NET's does.
const enumeratorNatives = (typeName: string): Record<string, NativeMethod> => ({
  [`${typeName}.MoveNext`]: (_call, receiver) => {
    const enumerator = (receiver as CsStruct).native as LibraryEnumerator | undefined;
    return enumerator ? enumerator.next() : nullReference();
  },
  [`${typeName}.get_Current`]: (call, receiver) => {
    const enumerator = (receiver as CsStruct).native as LibraryEnumerator | undefined;
    if (enumerator) return enumerator.currentValue(call);
    const type = (receiver as CsStruct).type;
    return evaluatorOf(call).defaultOf(substitute(call.method.returnType, substitutionOf(type)));
  },
  [`${typeName}.Dispose`]: () => {},
});

const LIST = 'System.Collections.Generic.List`1';

function checkIndex(call: NativeCall, index: number, length: number, name = 'index'): void {
  if (index < 0 || index >= length) failIndex(call, name);
}

function checkRange(call: NativeCall, index: number, count: number, length: number): void {
  if (index < 0) failOutOfRange(call, 'index', 'Non-negative number required.');
  if (count < 0) failOutOfRange(call, 'count', 'Non-negative number required.');
  if (length - index < count)
    fail(
      'System.ArgumentException',
      'Offset and length were out of bounds for the array or count is greater than the number of elements from index to the end of the source collection.'
    );
}

export function predicateOf(call: NativeCall, predicate: Value, name = 'match'): (value: Value) => boolean {
  if (predicate === undefined) failNull(name);
  return (value) => evaluatorOf(call).invokeDelegate(call.frame, predicate, [value], undefined) as boolean;
}

export function indexOfValue(
  call: NativeCall,
  items: Value[],
  value: Value,
  start = 0,
  fromEnd = false,
  end = items.length
): number {
  const equality = equalityOf(call, undefined);
  // Each inspected element is charged as it is compared, so a search that stops early pays only for what it read.
  const step = stepMeter(call);
  if (fromEnd) {
    for (let index = items.length - 1; index >= 0; index--) {
      step();
      if (equality.equals(items[index], value)) return index;
    }
    return -1;
  }
  for (let index = start; index < end; index++) {
    step();
    if (equality.equals(items[index], value)) return index;
  }
  return -1;
}

/** `List.LastIndexOf` over the `count` items that end at `start`, searching backward. */
function lastIndexOfRange(call: NativeCall, items: Value[], value: Value, start: number, count: number): number {
  if (items.length === 0) return -1;
  if (start < 0) failOutOfRange(call, 'index', 'Non-negative number required.');
  if (start >= items.length)
    failOutOfRange(
      call,
      'index',
      'Index was out of range. Must be non-negative and less than the size of the collection.'
    );
  if (count < 0) failOutOfRange(call, 'count', 'Non-negative number required.');
  if (count > start + 1) failOutOfRange(call, 'count', 'Larger than collection size.');
  const found = indexOfValue(call, items.slice(start - count + 1, start + 1), value, 0, true);
  return found < 0 ? -1 : found + start - count + 1;
}

export function sortItems(call: NativeCall, items: Value[], start: number, length: number, comparer: Value): void {
  sortChecked(call, comparerNameOf(call, comparer), () =>
    introSort(items, start, length, guardedComparison(call, comparisonOf(call, comparer)))
  );
}

/** The comparer a sort of a collection names when it fails: the one it was given, empty for the default one. */
export function comparerNameOf(call: NativeCall, comparer: Value): string {
  return comparer === undefined ? '' : runtimeTypeName(call.frame.runtime.runtimeTypeOf(comparer) as Type);
}

/** Runs a sort, reporting a comparer whose inconsistent results overran a partition as .NET's ArgumentException. */
export function sortChecked(call: NativeCall, comparerName: string, sort: () => void): void {
  try {
    sort();
  } catch (error) {
    if (!(error instanceof InconsistentComparer)) throw error;
    fail(
      'System.ArgumentException',
      `Unable to sort because the IComparer.Compare() method returns inconsistent results. Either a value does not compare equal to itself, or one value repeatedly compared to another value yields different results. IComparer: '${comparerName}'.`
    );
  }
}

const listNatives: Record<string, NativeMethod> = {
  [`${LIST}..ctor()`]: (call, receiver) => setNative(receiver, new ListState([], typeArgument(call))),
  [`${LIST}..ctor(int)`]: (call, receiver, [capacity]) => {
    if ((capacity as number) < 0) failOutOfRange(call, 'capacity', 'Non-negative number required.');
    const list = new ListState([], typeArgument(call));
    list.capacity = capacity as number;
    return setNative(receiver, list);
  },
  [`${LIST}..ctor(IEnumerable<T>)`]: (call, receiver, [source]) => {
    const list = new ListState(chargedElements(call, source as Value), typeArgument(call));
    list.capacity = list.items.length;
    return setNative(receiver, list);
  },
  [`${LIST}.get_Count`]: (_call, receiver) => listOf(receiver).items.length,
  [`${LIST}.get_Capacity`]: (_call, receiver) => listOf(receiver).capacity,
  [`${LIST}.set_Capacity`]: (call, receiver, [capacity]) => {
    if ((capacity as number) < listOf(receiver).items.length)
      failOutOfRange(call, 'value', 'capacity was less than the current size.');
    listOf(receiver).capacity = capacity as number;
    return;
  },
  [`${LIST}.get_IsReadOnly`]: () => false,
  [`${LIST}.get_Item`]: (call, receiver, [index]) => {
    const list = listOf(receiver);
    checkIndex(call, index as number, list.items.length);
    return list.items[index as number];
  },
  [`${LIST}.set_Item`]: (call, receiver, [index, value]) => {
    const list = listOf(receiver);
    checkIndex(call, index as number, list.items.length);
    call.frame.runtime.chargeStore(list.items[index as number], value as Value);
    list.items[index as number] = value as Value;
    list.version++;
    return;
  },
  [`${LIST}.Add`]: (call, receiver, [value]) => {
    const list = listOf(receiver);
    call.frame.runtime.retainSlots(1, [value as Value]);
    list.ensureCapacity(list.items.length + 1);
    list.items.push(value as Value);
    list.version++;
    return;
  },
  [`${LIST}.AddRange`]: (call, receiver, [source]) => {
    const list = listOf(receiver);
    const added = chargedElements(call, source as Value);
    list.ensureCapacity(list.items.length + added.length);
    for (const item of added) list.items.push(item);
    list.version++;
    return;
  },
  [`${LIST}.AsReadOnly`]: (call, receiver) => {
    const readOnly = new CsObject(
      libraryType(call, 'System.Collections.ObjectModel.ReadOnlyCollection', [typeArgument(call)]),
      []
    );
    readOnly.native = listOf(receiver);
    return readOnly;
  },
  [`${LIST}.BinarySearch(T)`]: (call, receiver, [value]) =>
    binarySearch(listOf(receiver).items, value as Value, comparisonOf(call, undefined)),
  [`${LIST}.BinarySearch(T, IComparer<T>?)`]: (call, receiver, [value, comparer]) =>
    binarySearch(listOf(receiver).items, value as Value, comparisonOf(call, comparer as Value)),
  [`${LIST}.BinarySearch(int, int, T, IComparer<T>?)`]: (call, receiver, [index, count, value, comparer]) =>
    rangeBinarySearch(
      call,
      listOf(receiver).items,
      { index: index as number, count: count as number, countName: 'count' },
      value as Value,
      comparer as Value
    ),
  [`${LIST}.Clear`]: (_call, receiver) => {
    const list = listOf(receiver);
    list.items = [];
    list.version++;
    return;
  },
  [`${LIST}.Contains`]: (call, receiver, [value]) => indexOfValue(call, listOf(receiver).items, value as Value) >= 0,
  [`${LIST}.ConvertAll`]: (call, receiver, [converter]) => {
    if (converter === undefined) failNull('converter');
    const items = listOf(receiver).items.map((item) =>
      evaluatorOf(call).invokeDelegate(call.frame, converter as Value, [item], undefined)
    );
    return newList(call, call.typeArgs[0], items);
  },
  [`${LIST}.CopyTo`]: (call, receiver, [array, index = 0]) => {
    const items = listOf(receiver).items;
    const target = array as CsArray;
    if (target === undefined) failNull('array');
    if ((index as number) < 0) failDestinationIndex(call, index as number);
    if ((index as number) + items.length > target.values.length)
      fail(
        'System.ArgumentException',
        "Destination array was not long enough. Check the destination index, length, and the array's lower bounds.",
        'destinationArray'
      );
    storeInArray(call, target, index as number, items, listOf(receiver).elementType);
    return;
  },
  [`${LIST}.CopyTo(int, T[], int, int)`]: (call, receiver, [index, array, arrayIndex, count]) => {
    const items = listOf(receiver).items;
    const [from, to, length] = [index, arrayIndex, count] as number[];
    if (array === undefined) failNull('destinationArray');
    const target = array as CsArray;
    if (from < 0)
      failOutOfRange(
        call,
        'sourceIndex',
        `sourceIndex ('${from}') must be greater than or equal to '0'.`,
        String(from)
      );
    if (to < 0) failDestinationIndex(call, to);
    if (length < 0) failNegative(call, 'length', length);
    if (from + length > items.length)
      fail(
        'System.ArgumentException',
        'Offset and length were out of bounds for the array or count is greater than the number of elements from index to the end of the source collection.'
      );
    if (to + length > target.values.length)
      fail(
        'System.ArgumentException',
        "Destination array was not long enough. Check the destination index, length, and the array's lower bounds.",
        'destinationArray'
      );
    storeInArray(call, target, to, items.slice(from, from + length), listOf(receiver).elementType);
    return;
  },
  [`${LIST}.Exists`]: (call, receiver, [match]) => listOf(receiver).items.some(predicateOf(call, match as Value)),
  [`${LIST}.Find`]: (call, receiver, [match]) => {
    const test = predicateOf(call, match as Value);
    for (const item of listOf(receiver).items) if (test(item)) return item;
    return evaluatorOf(call).defaultOf(typeArgument(call));
  },
  [`${LIST}.FindAll`]: (call, receiver, [match]) => {
    const test = predicateOf(call, match as Value);
    return newList(
      call,
      typeArgument(call),
      listOf(receiver).items.filter((item) => test(item))
    );
  },
  [`${LIST}.FindIndex`]: (call, receiver, args) => {
    const items = listOf(receiver).items;
    const [start, match] = args.length === 2 ? [args[0] as number, args[1]] : [0, args[0]];
    if (start < 0 || start > items.length)
      failOutOfRange(
        call,
        'startIndex',
        'Index was out of range. Must be non-negative and less than or equal to the size of the collection.'
      );
    const test = predicateOf(call, match as Value);
    for (let index = start; index < items.length; index++) if (test(items[index])) return index;
    return -1;
  },
  [`${LIST}.FindLast`]: (call, receiver, [match]) => {
    const test = predicateOf(call, match as Value);
    const items = listOf(receiver).items;
    for (let index = items.length - 1; index >= 0; index--) if (test(items[index])) return items[index];
    return evaluatorOf(call).defaultOf(typeArgument(call));
  },
  [`${LIST}.FindLastIndex`]: (call, receiver, [match]) => {
    const test = predicateOf(call, match as Value);
    const items = listOf(receiver).items;
    for (let index = items.length - 1; index >= 0; index--) if (test(items[index])) return index;
    return -1;
  },
  [`${LIST}.ForEach`]: (call, receiver, [action]) => {
    if (action === undefined) failNull('action');
    const list = listOf(receiver);
    const version = list.version;
    for (let index = 0; index < list.items.length; index++) {
      if (version !== list.version) break;
      evaluatorOf(call).invokeDelegate(call.frame, action as Value, [list.items[index]], undefined);
    }
    if (version !== list.version)
      fail('System.InvalidOperationException', 'Collection was modified; enumeration operation may not execute.');
    return;
  },
  [`${LIST}.GetEnumerator`]: (call, receiver) =>
    enumeratorStruct(
      call,
      'System.Collections.Generic.List`1+Enumerator',
      [typeArgument(call)],
      listOf(receiver).enumerate(),
      [receiver]
    ),
  [`${LIST}.GetRange`]: (call, receiver, [index, count]) => {
    const items = listOf(receiver).items;
    checkRange(call, index as number, count as number, items.length);
    return newList(call, typeArgument(call), items.slice(index as number, (index as number) + (count as number)));
  },
  [`${LIST}.Slice`]: (call, receiver, [index, count]) => {
    const items = listOf(receiver).items;
    checkRange(call, index as number, count as number, items.length);
    return newList(call, typeArgument(call), items.slice(index as number, (index as number) + (count as number)));
  },
  [`${LIST}.IndexOf`]: (call, receiver, [value, start = 0]) => {
    const items = listOf(receiver).items;
    if ((start as number) < 0 || (start as number) > items.length)
      failOutOfRange(
        call,
        'index',
        'Index was out of range. Must be non-negative and less than or equal to the size of the collection.'
      );
    return indexOfValue(call, items, value as Value, start as number);
  },
  [`${LIST}.Insert`]: (call, receiver, [index, value]) => {
    const list = listOf(receiver);
    if ((index as number) < 0 || (index as number) > list.items.length)
      failOutOfRange(call, 'index', 'Index must be within the bounds of the List.');
    call.frame.runtime.retainSlots(1, [value as Value]);
    list.ensureCapacity(list.items.length + 1);
    list.items.splice(index as number, 0, value as Value);
    list.version++;
    return;
  },
  [`${LIST}.InsertRange`]: (call, receiver, [index, source]) => {
    const list = listOf(receiver);
    if ((index as number) < 0 || (index as number) > list.items.length)
      failOutOfRange(
        call,
        'index',
        'Index was out of range. Must be non-negative and less than or equal to the size of the collection.'
      );
    const added = chargedElements(call, source as Value);
    list.ensureCapacity(list.items.length + added.length);
    const tail = list.items.splice(index as number);
    for (const item of [...added, ...tail]) list.items.push(item);
    list.version++;
    return;
  },
  [`${LIST}.IndexOf(T, int, int)`]: (call, receiver, [value, start, count]) => {
    const items = listOf(receiver).items;
    const [from, length] = [start, count] as number[];
    const message =
      'Index was out of range. Must be non-negative and less than or equal to the size of the collection.';
    if (from > items.length) failOutOfRange(call, 'index', message);
    if (from < 0) failOutOfRange(call, 'startIndex', message);
    if (length < 0 || from + length > items.length)
      failOutOfRange(
        call,
        'count',
        'Count must be positive and count must refer to a location within the string/array/collection.'
      );
    const index = indexOfValue(call, items, value as Value, from, false, from + length);
    return index;
  },
  [`${LIST}.LastIndexOf(T)`]: (call, receiver, [value]) =>
    indexOfValue(call, listOf(receiver).items, value as Value, 0, true),
  [`${LIST}.LastIndexOf(T, int)`]: (call, receiver, [value, start]) =>
    lastIndexOfRange(call, listOf(receiver).items, value as Value, start as number, (start as number) + 1),
  [`${LIST}.LastIndexOf(T, int, int)`]: (call, receiver, [value, start, count]) =>
    lastIndexOfRange(call, listOf(receiver).items, value as Value, start as number, count as number),
  [`${LIST}.Remove`]: (call, receiver, [value]) => {
    const list = listOf(receiver);
    const index = indexOfValue(call, list.items, value as Value);
    if (index < 0) return false;
    list.items.splice(index, 1);
    list.version++;
    return true;
  },
  [`${LIST}.RemoveAll`]: (call, receiver, [match]) => {
    const list = listOf(receiver);
    const test = predicateOf(call, match as Value);
    const kept = list.items.filter((item) => !test(item));
    const removed = list.items.length - kept.length;
    list.items = kept;
    if (removed > 0) list.version++;
    return removed;
  },
  [`${LIST}.RemoveAt`]: (call, receiver, [index]) => {
    const list = listOf(receiver);
    checkIndex(call, index as number, list.items.length);
    list.items.splice(index as number, 1);
    list.version++;
    return;
  },
  [`${LIST}.RemoveRange`]: (call, receiver, [index, count]) => {
    const list = listOf(receiver);
    checkRange(call, index as number, count as number, list.items.length);
    list.items.splice(index as number, count as number);
    list.version++;
    return;
  },
  [`${LIST}.Reverse()`]: (call, receiver) => {
    const list = listOf(receiver);
    chargeElements(call, list.items.length);
    list.items.reverse();
    list.version++;
    return;
  },
  [`${LIST}.Reverse(int, int)`]: (call, receiver, [index, count]) => {
    const list = listOf(receiver);
    checkRange(call, index as number, count as number, list.items.length);
    chargeElements(call, count as number);
    reverseRange(list.items, index as number, count as number);
    list.version++;
    return;
  },
  [`${LIST}.Sort()`]: (call, receiver) => {
    const list = listOf(receiver);
    sortItems(call, list.items, 0, list.items.length, undefined);
    list.version++;
    return;
  },
  [`${LIST}.Sort(Comparison<T>)`]: (call, receiver, [comparison]) => {
    if (comparison === undefined) failNull('comparison');
    const list = listOf(receiver);
    sortItems(call, list.items, 0, list.items.length, comparison as Value);
    list.version++;
    return;
  },
  [`${LIST}.Sort(IComparer<T>?)`]: (call, receiver, [comparer]) => {
    const list = listOf(receiver);
    sortItems(call, list.items, 0, list.items.length, comparer as Value);
    list.version++;
    return;
  },
  [`${LIST}.Sort(int, int, IComparer<T>?)`]: (call, receiver, [index, count, comparer]) => {
    const list = listOf(receiver);
    checkRange(call, index as number, count as number, list.items.length);
    sortItems(call, list.items, index as number, count as number, comparer as Value);
    list.version++;
    return;
  },
  [`${LIST}.ToArray`]: (call, receiver) => newArray(call, typeArgument(call), [...listOf(receiver).items]),
  [`${LIST}.TrimExcess`]: (_call, receiver) => {
    const list = listOf(receiver);
    // .NET trims only when the list fills less than 90% of its capacity.
    if (list.items.length < Math.trunc(list.capacity * 0.9)) list.capacity = list.items.length;
    return;
  },
  [`${LIST}.TrueForAll`]: (call, receiver, [match]) => listOf(receiver).items.every(predicateOf(call, match as Value)),
  ...enumeratorNatives('System.Collections.Generic.List`1+Enumerator'),
};
defineNatives(listNatives);

/**
 * `BinarySearch` within `count` items from an index, whose result counts from the start of the whole list; the count
 * is named `count` for a list and `length` for an array.
 */
export function rangeBinarySearch(
  call: NativeCall,
  items: Value[],
  range: { index: number; count: number; countName: string },
  value: Value,
  comparer: Value
): number {
  const { index, count, countName } = range;
  if (index < 0) failOutOfRange(call, 'index', 'Non-negative number required.');
  if (count < 0) failOutOfRange(call, countName, 'Non-negative number required.');
  if (items.length - index < count)
    fail(
      'System.ArgumentException',
      'Offset and length were out of bounds for the array or count is greater than the number of elements from index to the end of the source collection.'
    );
  const found = binarySearch(items.slice(index, index + count), value, comparisonOf(call, comparer));
  return found >= 0 ? found + index : ~(~found + index);
}

export function binarySearch(items: Value[], value: Value, compare: Comparison): number {
  let low = 0;
  let high = items.length - 1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    const order = compare(items[middle], value);
    if (order === 0) return middle;
    if (order < 0) low = middle + 1;
    else high = middle - 1;
  }
  return ~low;
}

function setNative(receiver: Value, state: unknown): Value {
  (receiver as CsObject).native = state;
  return undefined;
}

// ---- Dictionary and HashSet ----

interface Entry {
  hash: number;
  key: Value;
  value: Value;
  /** Whether the entry is on the free list, after its key was removed. */
  isFree: boolean;
}

/**
 * The entries of a `Dictionary` or `HashSet`, which enumerate in .NET's order: in the order they were added, except
 * that an addition after removals reuses the most recently freed slot.
 */
export class HashState implements EnumerableState {
  entries: Entry[] = [];
  private readonly freeList: number[] = [];
  private readonly buckets = new Map<number, number[]>();
  version = 0;

  constructor(
    readonly equality: Equality,
    readonly keyType: Type,
    readonly valueType: Type | undefined,
    /** The comparer object the program passed, which `Comparer` returns. */
    readonly comparer: Value
  ) {}

  /** Charges a new entry against the run's slot limit, set where the collection is created. */
  /** Charges entries the collection newly keeps, as Runtime.retainSlots does. */
  retain: (baseSlots: number, values: Value[]) => void = () => {};
  /** Charges replacing a kept value, as Runtime.chargeStore does. */
  store: (previous: Value, next: Value) => void = () => {};

  /** Charges work against the run's operations budget, set where the collection is created. */
  spend: (count: number) => void = () => {};

  /** The type of a set's elements, which it holds unboxed; a dictionary's pairs carry their own type. */
  get elementType(): Type | undefined {
    return this.valueType ? undefined : this.keyType;
  }

  get count(): number {
    return this.entries.length - this.freeList.length;
  }

  find(key: Value): number {
    const hash = this.equality.hash(key);
    const bucket = this.buckets.get(hash) ?? [];
    // Keys whose hashes collide are compared one by one, which colliding keys can make long.
    if (bucket.length > 1) this.spend(bucket.length);
    for (const index of bucket) {
      const entry = this.entries[index];
      if (!entry.isFree && this.equality.equals(entry.key, key)) return index;
    }
    return -1;
  }

  /** Adds an entry, or with `replace` sets the value of an existing one; returns false when the key exists. */
  insert(key: Value, value: Value, replace: boolean): boolean {
    const existing = this.find(key);
    if (existing >= 0) {
      if (!replace) return false;
      // Since .NET Core 3.0, only adding a key invalidates an enumeration; setting, removing, and clearing do not.
      this.store(this.entries[existing].value, value);
      this.entries[existing].value = value;
      return true;
    }
    this.retain(1, [key, value]);
    const hash = this.equality.hash(key);
    const entry: Entry = { hash, key, value, isFree: false };
    let index: number;
    if (this.freeList.length > 0) {
      index = this.freeList.pop() as number;
      this.entries[index] = entry;
    } else {
      index = this.entries.length;
      this.entries.push(entry);
    }
    const bucket = this.buckets.get(hash) ?? [];
    bucket.push(index);
    this.buckets.set(hash, bucket);
    this.version++;
    return true;
  }

  remove(key: Value): Entry | undefined {
    const index = this.find(key);
    if (index < 0) return undefined;
    const entry = this.entries[index];
    const bucket = this.buckets.get(entry.hash) as number[];
    bucket.splice(bucket.indexOf(index), 1);
    this.entries[index] = { hash: 0, key: undefined, value: undefined, isFree: true };
    this.freeList.push(index);
    return entry;
  }

  clear(): void {
    this.entries = [];
    this.freeList.length = 0;
    this.buckets.clear();
  }

  *live(): Generator<Entry> {
    const version = this.version;
    // Indexing the current entries lets a removal or a clear during the enumeration end it as .NET's does.
    for (let index = 0; index < this.entries.length; index++) {
      if (this.version !== version) throw collectionModified();
      const entry = this.entries[index];
      if (!entry.isFree) yield entry;
    }
    if (this.version !== version) throw collectionModified();
  }

  *enumerate(): Generator<Value> {
    for (const entry of this.live()) yield this.valueType ? this.pair(entry) : entry.key;
  }

  /** The `KeyValuePair` of an entry, which the evaluator's struct conventions copy. */
  pair(entry: Entry): Value {
    return this.pairOf?.(entry.key, entry.value) ?? undefined;
  }

  pairOf?: (key: Value, value: Value) => Value;

  references(): Value[] {
    return this.entries.flatMap((entry) => [entry.key, entry.value]);
  }

  display(): { kind: 'array' | 'object'; items: [string, Value, Type][] } {
    const live = this.entries.filter((entry) => !entry.isFree);
    const valueType = this.valueType;
    if (!valueType)
      return { kind: 'array', items: live.map((entry, index) => [String(index), entry.key, this.keyType]) };
    return {
      kind: 'object',
      items: live.map((entry) => [this.keyText?.(entry.key) ?? String(entry.key), entry.value, valueType]),
    };
  }

  keyText?: (key: Value) => string;
}

function hashOfState(value: Value): HashState {
  if (value === undefined)
    fail('System.NullReferenceException', 'Object reference not set to an instance of an object.');
  return (value as CsObject).native as HashState;
}

/** The state of a dictionary or a hash set, charged, metered, and shown as every one is. */
export function newHashState(call: NativeCall, comparer: Value, keyType: Type, valueType: Type | undefined): HashState {
  const state = new HashState(equalityOf(call, comparer, keyType), keyType, valueType, comparer);
  state.retain = (baseSlots, values) => call.frame.runtime.retainSlots(baseSlots, values);
  state.store = (previous, next) => call.frame.runtime.chargeStore(previous, next);
  state.spend = (count) => call.frame.runtime.spend(count);
  if (valueType) {
    const pairType = libraryType(call, 'System.Collections.Generic.KeyValuePair', [keyType, valueType]);
    state.pairOf = (key, value) => new CsStruct(pairType, [key, value]);
  }
  state.keyText = (key) => dictionaryKeyText(call, key, keyType);
  return state;
}

const DICTIONARY = 'System.Collections.Generic.Dictionary`2';

function keyNotFound(call: NativeCall, key: Value, keyType: Type): never {
  throw new PendingException(
    'System.Collections.Generic.KeyNotFoundException',
    `The given key '${textOf(call, key, keyType)}' was not present in the dictionary.`
  );
}

function checkKey(key: Value): void {
  if (key === undefined) failNull('key');
}

const dictionaryNatives: Record<string, NativeMethod> = {
  [`${DICTIONARY}..ctor()`]: (call, receiver) =>
    setNative(receiver, newHashState(call, undefined, typeArgument(call, 0), typeArgument(call, 1))),
  [`${DICTIONARY}..ctor(int)`]: (call, receiver, [capacity]) => {
    if ((capacity as number) < 0) failNegative(call, 'capacity', capacity as number);
    return setNative(receiver, newHashState(call, undefined, typeArgument(call, 0), typeArgument(call, 1)));
  },
  [`${DICTIONARY}..ctor(IEqualityComparer<TKey>?)`]: (call, receiver, [comparer]) =>
    setNative(receiver, newHashState(call, comparer as Value, typeArgument(call, 0), typeArgument(call, 1))),
  [`${DICTIONARY}..ctor(IDictionary<TKey, TValue>)`]: (call, receiver, [source]) =>
    fillDictionary(call, receiver, source as Value),
  [`${DICTIONARY}..ctor(int, IEqualityComparer<TKey>?)`]: (call, receiver, [capacity, comparer]) => {
    if ((capacity as number) < 0) failNegative(call, 'capacity', capacity as number);
    return setNative(receiver, newHashState(call, comparer as Value, typeArgument(call, 0), typeArgument(call, 1)));
  },
  [`${DICTIONARY}..ctor(IDictionary<TKey, TValue>, IEqualityComparer<TKey>?)`]: (call, receiver, [source, comparer]) =>
    fillDictionary(call, receiver, source as Value, comparer as Value),
  [`${DICTIONARY}..ctor(IEnumerable<KeyValuePair<TKey, TValue>>)`]: (call, receiver, [source]) =>
    fillDictionary(call, receiver, source as Value),
  [`${DICTIONARY}.get_Count`]: (_call, receiver) => hashOfState(receiver).count,
  [`${DICTIONARY}.get_IsReadOnly`]: () => false,
  [`${DICTIONARY}.get_Comparer`]: (call, receiver) =>
    hashOfState(receiver).comparer ?? equalityComparerObject(call, typeArgument(call, 0)),
  [`${DICTIONARY}.get_Item`]: (call, receiver, [key]) => {
    checkKey(key as Value);
    const state = hashOfState(receiver);
    const index = state.find(key as Value);
    if (index < 0) keyNotFound(call, key as Value, state.keyType);
    return state.entries[index].value;
  },
  [`${DICTIONARY}.set_Item`]: (call, receiver, [key, value]) => {
    checkKey(key as Value);
    hashOfState(receiver).insert(key as Value, value as Value, true);
    return;
  },
  [`${DICTIONARY}.get_Keys`]: (call, receiver) =>
    viewOf(call, receiver, 'KeyCollection', typeArgument(call, 0), (entry) => entry.key),
  [`${DICTIONARY}.get_Values`]: (call, receiver) =>
    viewOf(call, receiver, 'ValueCollection', typeArgument(call, 1), (entry) => entry.value),
  [`${DICTIONARY}.Add`]: (call, receiver, [key, value]) => {
    checkKey(key as Value);
    if (!hashOfState(receiver).insert(key as Value, value as Value, false)) {
      fail(
        'System.ArgumentException',
        `An item with the same key has already been added. Key: ${textOf(call, key as Value, typeArgument(call, 0))}`
      );
    }
    return;
  },
  [`${DICTIONARY}.Clear`]: (_call, receiver) => {
    hashOfState(receiver).clear();
    return;
  },
  [`${DICTIONARY}.ContainsKey`]: (_call, receiver, [key]) => {
    checkKey(key as Value);
    return hashOfState(receiver).find(key as Value) >= 0;
  },
  [`${DICTIONARY}.ContainsValue`]: (call, receiver, [value]) => {
    const equality = equalityOf(call, undefined, typeArgument(call, 1));
    for (const entry of hashOfState(receiver).live()) if (equality.equals(entry.value, value as Value)) return true;
    return false;
  },
  [`${DICTIONARY}.GetEnumerator`]: (call, receiver) =>
    enumeratorStruct(
      call,
      'System.Collections.Generic.Dictionary`2+Enumerator',
      [typeArgument(call, 0), typeArgument(call, 1)],
      hashOfState(receiver).enumerate(),
      [receiver]
    ),
  [`${DICTIONARY}.Remove(TKey)`]: (_call, receiver, [key]) => {
    checkKey(key as Value);
    return hashOfState(receiver).remove(key as Value) !== undefined;
  },
  [`${DICTIONARY}.Remove(TKey, TValue)`]: (call, receiver, [key, value]) => {
    checkKey(key as Value);
    const removed = hashOfState(receiver).remove(key as Value);
    refOf(value).set(removed ? removed.value : evaluatorOf(call).defaultOf(typeArgument(call, 1)));
    return removed !== undefined;
  },
  [`${DICTIONARY}.TryAdd`]: (call, receiver, [key, value]) => {
    checkKey(key as Value);
    return hashOfState(receiver).insert(key as Value, value as Value, false);
  },
  [`${DICTIONARY}.TryGetValue`]: (call, receiver, [key, value]) => {
    checkKey(key as Value);
    const state = hashOfState(receiver);
    const index = state.find(key as Value);
    refOf(value).set(index >= 0 ? state.entries[index].value : evaluatorOf(call).defaultOf(typeArgument(call, 1)));
    return index >= 0;
  },
  [`${DICTIONARY}.GetValueOrDefault(TKey)`]: (call, receiver, [key]) => {
    const state = hashOfState(receiver);
    const index = state.find(key as Value);
    return index >= 0 ? state.entries[index].value : evaluatorOf(call).defaultOf(typeArgument(call, 1));
  },
  [`${DICTIONARY}.GetValueOrDefault(TKey, TValue)`]: (_call, receiver, [key, fallback]) => {
    const state = hashOfState(receiver);
    const index = state.find(key as Value);
    return index >= 0 ? state.entries[index].value : (fallback as Value);
  },
  [`${DICTIONARY}.TrimExcess`]: () => {},
  [`${DICTIONARY}.EnsureCapacity`]: (call, _receiver, [capacity]) => {
    if ((capacity as number) < 0) failNegative(call, 'capacity', capacity as number);
    return capacity as number;
  },
  ...enumeratorNatives('System.Collections.Generic.Dictionary`2+Enumerator'),
  ...enumeratorNatives('System.Collections.Generic.Dictionary`2+KeyCollection+Enumerator'),
  ...enumeratorNatives('System.Collections.Generic.Dictionary`2+ValueCollection+Enumerator'),
};
defineNatives(dictionaryNatives);

function fillDictionary(call: NativeCall, receiver: Value, source: Value, comparer: Value = undefined): Value {
  if (source === undefined) failNull('dictionary');
  const state = newHashState(call, comparer, typeArgument(call, 0), typeArgument(call, 1));
  setNative(receiver, state);
  for (const pair of iterate(call, source, 'collection')) {
    const [key, value] = (pair as CsStruct).fields;
    if (!state.insert(key, value, false))
      fail(
        'System.ArgumentException',
        `An item with the same key has already been added. Key: ${textOf(call, key, typeArgument(call, 0))}`
      );
  }
  return undefined;
}

/** A dictionary's live view of its keys or values. */
class ViewState implements EnumerableState {
  constructor(
    readonly dictionary: HashState,
    private readonly select: (entry: Entry) => Value,
    readonly elementType: Type
  ) {}

  *enumerate(): Generator<Value> {
    for (const entry of this.dictionary.live()) yield this.select(entry);
  }

  references(): Value[] {
    return this.dictionary.references();
  }

  display(): { kind: 'array'; items: [string, Value, Type][] } {
    return {
      kind: 'array',
      items: [...this.enumerate()].map((item, index) => [String(index), item, this.elementType]),
    };
  }
}

function viewOf(
  call: NativeCall,
  receiver: Value,
  name: 'KeyCollection' | 'ValueCollection',
  elementType: Type,
  select: (entry: Entry) => Value
): CsObject {
  const view = new CsObject(
    libraryType(call, `System.Collections.Generic.Dictionary\`2+${name}`, [
      typeArgument(call, 0),
      typeArgument(call, 1),
    ]),
    []
  );
  view.native = new ViewState(hashOfState(receiver), select, elementType);
  return view;
}

for (const name of ['KeyCollection', 'ValueCollection']) {
  const prefix = `System.Collections.Generic.Dictionary\`2+${name}`;
  defineNatives({
    [`${prefix}.get_Count`]: (_call, receiver) => ((receiver as CsObject).native as ViewState).dictionary.count,
    [`${prefix}.get_IsReadOnly`]: () => true,
    [`${prefix}.Contains`]: (call, receiver, [value]) => {
      const view = (receiver as CsObject).native as ViewState;
      // The keys' membership is the dictionary's own key lookup, with its comparer.
      if (name === 'KeyCollection') return view.dictionary.find(value as Value) >= 0;
      const equality = equalityOf(call, undefined, view.elementType);
      for (const item of view.enumerate()) if (equality.equals(item, value as Value)) return true;
      return false;
    },
    [`${prefix}.CopyTo`]: (call, receiver, [array, index]) => {
      copyToArray(call, [...((receiver as CsObject).native as ViewState).enumerate()], array as Value, index as number);
      return;
    },
    [`${prefix}.GetEnumerator`]: (call, receiver) =>
      enumeratorStruct(
        call,
        `${prefix}+Enumerator`,
        [typeArgument(call, 0), typeArgument(call, 1)],
        ((receiver as CsObject).native as ViewState).enumerate(),
        [receiver]
      ),
  });
}

defineNatives({
  'System.Collections.Generic.KeyValuePair`2..ctor': (_call, receiver, [key, value]) => {
    (receiver as CsStruct).fields[0] = key as Value;
    (receiver as CsStruct).fields[1] = value as Value;
    return;
  },
  'System.Collections.Generic.KeyValuePair`2.get_Key': (_call, receiver) => (receiver as CsStruct).fields[0],
  'System.Collections.Generic.KeyValuePair`2.get_Value': (_call, receiver) => (receiver as CsStruct).fields[1],
  'System.Collections.Generic.KeyValuePair`2.Deconstruct': (_call, receiver, [key, value]) => {
    refOf(key).set((receiver as CsStruct).fields[0]);
    refOf(value).set((receiver as CsStruct).fields[1]);
    return;
  },
  'System.Collections.Generic.KeyValuePair`2.ToString': (call, receiver) => {
    const pair = receiver as CsStruct;
    return `[${textOf(call, pair.fields[0], pair.type.args[0])}, ${textOf(call, pair.fields[1], pair.type.args[1])}]`;
  },
  'System.Collections.Generic.KeyValuePair.Create': (call, _receiver, [key, value]) =>
    new CsStruct(libraryType(call, 'System.Collections.Generic.KeyValuePair', call.typeArgs), [
      key as Value,
      value as Value,
    ]),
  'System.Collections.Generic.CollectionExtensions.GetValueOrDefault': (call, _receiver, args) => {
    const [dictionary, key, defaultValue] = args as Value[];
    if (dictionary === undefined) failNull('dictionary');
    const found = tryGetValue(call, dictionary, key);
    if (found.isFound) return found.value;
    return args.length > 2 ? defaultValue : evaluatorOf(call).defaultOf(call.typeArgs[1]);
  },
  'System.Collections.Generic.CollectionExtensions.TryAdd': (_call, _receiver, [dictionary, key, value]) =>
    hashOfState(dictionary as Value).insert(key as Value, value as Value, false),
});

/** `IReadOnlyDictionary.TryGetValue` of any dictionary, as SortedDictionary's or one the program implements. */
function tryGetValue(call: NativeCall, dictionary: Value, key: Value): { isFound: boolean; value: Value } {
  const native = (dictionary as CsObject).native;
  if (native instanceof HashState) {
    const index = native.find(key);
    return index >= 0 ? { isFound: true, value: native.entries[index].value } : { isFound: false, value: undefined };
  }
  const evaluator = evaluatorOf(call);
  const face = evaluator.runtime.library.typeNamed('System.Collections.Generic.IReadOnlyDictionary', 2);
  const method = face.methods.find((candidate) => candidate.name === 'TryGetValue') as MethodSymbol;
  const implementation = evaluator.runtime.dispatch(method, dictionary);
  let value: Value;
  const out: VariableReference = {
    get: () => value,
    set: (assigned) => {
      value = assigned;
    },
  };
  const isFound = evaluator.invoke(
    call.frame,
    implementation,
    dictionary,
    [key, out as unknown as Value],
    call.row,
    environmentOf(evaluator, implementation, dictionary)
  ) as boolean;
  return { isFound, value };
}

const HASH_SET = 'System.Collections.Generic.HashSet`1';

function otherElements(call: NativeCall, other: Value): Value[] {
  if (other === undefined) failNull('other');
  return bufferedElements(call, iterate(call, other, 'other'));
}

defineNatives({
  [`${HASH_SET}..ctor()`]: (call, receiver) =>
    setNative(receiver, newHashState(call, undefined, typeArgument(call), undefined)),
  [`${HASH_SET}..ctor(IEnumerable<T>)`]: (call, receiver, [source]) =>
    fillSet(call, receiver, source as Value, undefined),
  [`${HASH_SET}..ctor(int)`]: (call, receiver, [capacity]) => {
    if ((capacity as number) < 0) failNegative(call, 'capacity', capacity as number);
    return setNative(receiver, newHashState(call, undefined, typeArgument(call), undefined));
  },
  [`${HASH_SET}..ctor(int, IEqualityComparer<T>?)`]: (call, receiver, [capacity, comparer]) => {
    if ((capacity as number) < 0) failNegative(call, 'capacity', capacity as number);
    return setNative(receiver, newHashState(call, comparer as Value, typeArgument(call), undefined));
  },
  [`${HASH_SET}..ctor(IEqualityComparer<T>?)`]: (call, receiver, [comparer]) =>
    setNative(receiver, newHashState(call, comparer as Value, typeArgument(call), undefined)),
  [`${HASH_SET}..ctor(IEnumerable<T>, IEqualityComparer<T>?)`]: (call, receiver, [source, comparer]) =>
    fillSet(call, receiver, source as Value, comparer as Value),
  [`${HASH_SET}.get_Count`]: (_call, receiver) => hashOfState(receiver).count,
  [`${HASH_SET}.get_IsReadOnly`]: () => false,
  [`${HASH_SET}.Add`]: (_call, receiver, [value]) => {
    return hashOfState(receiver).insert(value as Value, undefined, false);
  },
  [`${HASH_SET}.Clear`]: (_call, receiver) => {
    hashOfState(receiver).clear();
    return;
  },
  [`${HASH_SET}.Contains`]: (_call, receiver, [value]) => hashOfState(receiver).find(value as Value) >= 0,
  [`${HASH_SET}.CopyTo`]: (call, receiver, [array, index = 0]) => {
    copyToArray(call, [...hashOfState(receiver).enumerate()], array as Value, index as number);
    return;
  },
  [`${HASH_SET}.ExceptWith`]: (call, receiver, [other]) => {
    const state = hashOfState(receiver);
    for (const item of otherElements(call, other as Value)) state.remove(item);
    return;
  },
  [`${HASH_SET}.GetEnumerator`]: (call, receiver) =>
    enumeratorStruct(
      call,
      'System.Collections.Generic.HashSet`1+Enumerator',
      // A call through the non-generic IEnumerable has no type arguments, which the set's own state keeps.
      [hashOfState(receiver).keyType],
      hashOfState(receiver).enumerate(),
      [receiver]
    ),
  [`${HASH_SET}.IntersectWith`]: (call, receiver, [other]) => {
    const state = hashOfState(receiver);
    const others = newHashState(call, state.comparer, state.keyType, undefined);
    for (const item of otherElements(call, other as Value)) others.insert(item, undefined, false);
    for (const entry of state.entries) if (!entry.isFree && others.find(entry.key) < 0) state.remove(entry.key);
    return;
  },
  [`${HASH_SET}.IsProperSubsetOf`]: (call, receiver, [other]) =>
    setRelation(call, receiver, other as Value, 'properSubset'),
  [`${HASH_SET}.IsProperSupersetOf`]: (call, receiver, [other]) =>
    setRelation(call, receiver, other as Value, 'properSuperset'),
  [`${HASH_SET}.IsSubsetOf`]: (call, receiver, [other]) => setRelation(call, receiver, other as Value, 'subset'),
  [`${HASH_SET}.IsSupersetOf`]: (call, receiver, [other]) => setRelation(call, receiver, other as Value, 'superset'),
  [`${HASH_SET}.Overlaps`]: (call, receiver, [other]) => setRelation(call, receiver, other as Value, 'overlaps'),
  [`${HASH_SET}.SetEquals`]: (call, receiver, [other]) => setRelation(call, receiver, other as Value, 'equals'),
  [`${HASH_SET}.Remove`]: (_call, receiver, [value]) => hashOfState(receiver).remove(value as Value) !== undefined,
  [`${HASH_SET}.RemoveWhere`]: (call, receiver, [match]) => {
    const state = hashOfState(receiver);
    const test = predicateOf(call, match as Value);
    let removed = 0;
    for (const entry of state.entries) {
      if (!entry.isFree && test(entry.key)) {
        state.remove(entry.key);
        removed++;
      }
    }
    return removed;
  },
  [`${HASH_SET}.SymmetricExceptWith`]: (call, receiver, [other]) => {
    const state = hashOfState(receiver);
    const seen = newHashState(call, state.comparer, state.keyType, undefined);
    if (
      other instanceof CsObject &&
      other.native instanceof HashState &&
      !other.native.valueType &&
      other.native.comparer === state.comparer
    ) {
      // Another set of the same comparer has elements unique under this set's, which .NET removes or adds one by one.
      for (const item of otherElements(call, other)) if (!state.remove(item)) state.insert(item, undefined, false);
      return;
    }
    // .NET adds another sequence's new elements first and removes the shared ones after, which decides the order.
    const shared: Value[] = [];
    for (const item of otherElements(call, other as Value)) {
      if (!seen.insert(item, undefined, false)) continue;
      if (!state.insert(item, undefined, false)) shared.push(item);
    }
    for (const item of shared) state.remove(item);
    return;
  },
  [`${HASH_SET}.TryGetValue`]: (call, receiver, [value, actual]) => {
    const state = hashOfState(receiver);
    const index = state.find(value as Value);
    refOf(actual).set(index >= 0 ? state.entries[index].key : evaluatorOf(call).defaultOf(typeArgument(call)));
    return index >= 0;
  },
  [`${HASH_SET}.UnionWith`]: (call, receiver, [other]) => {
    const state = hashOfState(receiver);
    for (const item of otherElements(call, other as Value)) state.insert(item, undefined, false);
    return;
  },
  ...enumeratorNatives('System.Collections.Generic.HashSet`1+Enumerator'),
});

function fillSet(call: NativeCall, receiver: Value, source: Value, comparer: Value): Value {
  if (source === undefined) failNull('collection');
  const state = newHashState(call, comparer, typeArgument(call), undefined);
  setNative(receiver, state);
  for (const item of iterate(call, source, 'collection')) state.insert(item, undefined, false);
  return undefined;
}

function setRelation(
  call: NativeCall,
  receiver: Value,
  other: Value,
  relation: 'subset' | 'superset' | 'properSubset' | 'properSuperset' | 'overlaps' | 'equals'
): boolean {
  const state = hashOfState(receiver);
  const others = newHashState(call, state.comparer, state.keyType, undefined);
  for (const item of otherElements(call, other)) others.insert(item, undefined, false);
  const mine = [...state.enumerate()];
  const theirs = [...others.enumerate()];
  const inOthers = mine.filter((item) => others.find(item) >= 0).length;
  const inMine = theirs.filter((item) => state.find(item) >= 0).length;
  switch (relation) {
    case 'subset': {
      return inOthers === mine.length;
    }
    case 'superset': {
      return inMine === theirs.length;
    }
    case 'properSubset': {
      return inOthers === mine.length && theirs.length > mine.length;
    }
    case 'properSuperset': {
      return inMine === theirs.length && mine.length > theirs.length;
    }
    case 'overlaps': {
      return inOthers > 0;
    }
    default: {
      return inOthers === mine.length && inMine === theirs.length;
    }
  }
}

// ---- Queue and Stack ----

/**
 * A queue's or stack's elements from `head` on, oldest first for a queue and in push order for a stack. A dequeue
 * advances the head instead of shifting the array, which takes time in the queue's length.
 */
class SequenceState implements EnumerableState {
  version = 0;
  head = 0;

  constructor(
    public items: Value[],
    readonly isStack: boolean,
    readonly elementType: Type
  ) {}

  *enumerate(): Generator<Value> {
    const version = this.version;
    const order = this.isStack ? this.items.toReversed() : this.items.slice(this.head);
    // Stack's enumerator words the error differently from the other collections'.
    const modified = (): PendingException =>
      this.isStack
        ? new PendingException(
            'System.InvalidOperationException',
            'Collection was modified after the enumerator was instantiated.'
          )
        : collectionModified();
    for (const item of order) {
      if (this.version !== version) throw modified();
      yield item;
    }
    if (this.version !== version) throw modified();
  }

  get count(): number {
    return this.items.length - this.head;
  }

  /** Takes the oldest element of a queue, dropping the elements before the head once they are half of the array. */
  dequeue(): Value {
    const value = this.items[this.head];
    this.items[this.head] = undefined;
    this.head++;
    if (this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return value;
  }

  references(): Value[] {
    return this.items;
  }

  display(): { kind: 'array'; items: [string, Value, Type][] } {
    return {
      kind: 'array',
      items: [...this.enumerate()].map((item, index) => [String(index), item, this.elementType]),
    };
  }
}

function sequenceOf(value: Value): SequenceState {
  if (value === undefined)
    fail('System.NullReferenceException', 'Object reference not set to an instance of an object.');
  return (value as CsObject).native as SequenceState;
}

for (const [name, isStack] of [
  ['Queue', false],
  ['Stack', true],
] as const) {
  const prefix = `System.Collections.Generic.${name}\`1`;
  const emptyMessage = `${name} empty.`;
  const take = (state: SequenceState, remove: boolean): Value => {
    if (state.count === 0) fail('System.InvalidOperationException', emptyMessage);
    if (!remove) return (isStack ? state.items.at(-1) : state.items[state.head]) as Value;
    state.version++;
    return (isStack ? state.items.pop() : state.dequeue()) as Value;
  };
  const tryTake = (
    state: SequenceState,
    result: Value | VariableReference,
    remove: boolean,
    call: NativeCall
  ): boolean => {
    if (state.count === 0) {
      refOf(result).set(evaluatorOf(call).defaultOf(state.elementType));
      return false;
    }
    refOf(result).set(take(state, remove));
    return true;
  };
  defineNatives({
    [`${prefix}..ctor()`]: (call, receiver) => setNative(receiver, new SequenceState([], isStack, typeArgument(call))),
    [`${prefix}..ctor(int)`]: (call, receiver, [capacity]) => {
      if ((capacity as number) < 0) failNegative(call, 'capacity', capacity as number);
      return setNative(receiver, new SequenceState([], isStack, typeArgument(call)));
    },
    [`${prefix}..ctor(IEnumerable<T>)`]: (call, receiver, [source]) =>
      setNative(receiver, new SequenceState(chargedElements(call, source as Value), isStack, typeArgument(call))),
    [`${prefix}.get_Count`]: (_call, receiver) => sequenceOf(receiver).count,
    [`${prefix}.Clear`]: (_call, receiver) => {
      const state = sequenceOf(receiver);
      state.items = [];
      state.head = 0;
      state.version++;
      return;
    },
    [`${prefix}.Contains`]: (call, receiver, [value]) =>
      indexOfValue(call, sequenceOf(receiver).items, value as Value, sequenceOf(receiver).head) >= 0,
    [`${prefix}.${isStack ? 'Push' : 'Enqueue'}`]: (call, receiver, [value]) => {
      const state = sequenceOf(receiver);
      call.frame.runtime.retainSlots(1, [value as Value]);
      state.items.push(value as Value);
      state.version++;
      return;
    },
    [`${prefix}.${isStack ? 'Pop' : 'Dequeue'}`]: (_call, receiver) => take(sequenceOf(receiver), true),
    [`${prefix}.Peek`]: (_call, receiver) => take(sequenceOf(receiver), false),
    [`${prefix}.${isStack ? 'TryPop' : 'TryDequeue'}`]: (call, receiver, [result]) =>
      tryTake(sequenceOf(receiver), result, true, call),
    [`${prefix}.TryPeek`]: (call, receiver, [result]) => tryTake(sequenceOf(receiver), result, false, call),
    [`${prefix}.ToArray`]: (call, receiver) =>
      newArray(call, typeArgument(call), [...sequenceOf(receiver).enumerate()]),
    [`${prefix}.TrimExcess`]: () => {},
    [`${prefix}.GetEnumerator`]: (call, receiver) =>
      enumeratorStruct(call, `${prefix}+Enumerator`, [typeArgument(call)], sequenceOf(receiver).enumerate(), [
        receiver,
      ]),
    ...enumeratorNatives(`${prefix}+Enumerator`),
  });
}

// ---- Comparer and EqualityComparer ----

function comparerObject(call: NativeCall, type: Type, compare: Comparison): CsObject {
  const object = new CsObject(libraryType(call, 'System.Collections.Generic.Comparer', [type]), []);
  object.native = compare;
  return object;
}

function equalityComparerObject(call: NativeCall, type: Type, equality?: Equality): CsObject {
  const object = new CsObject(libraryType(call, 'System.Collections.Generic.EqualityComparer', [type]), []);
  object.native = equality ?? equalityOf(call, undefined);
  return object;
}

defineNatives({
  'System.Collections.Generic.Comparer`1.get_Default': (call) => {
    const type = typeArgument(call);
    // The default comparer calls the type's CompareTo, which for the narrow integral types returns the difference.
    const compare: Comparison = NARROW_INTEGRALS.has(specialOf(type) ?? '')
      ? (a, b) => (a as number) - (b as number)
      : comparisonOf(call, undefined);
    return comparerObject(call, type, compare);
  },
  'System.Collections.Generic.Comparer`1.Create': (call, _receiver, [comparison]) => {
    if (comparison === undefined) failNull('comparison');
    return comparerObject(call, typeArgument(call), comparisonOf(call, comparison as Value));
  },
  'System.Collections.Generic.Comparer`1.Compare': (_call, receiver, [a, b]) =>
    ((receiver as CsObject).native as Comparison)(a as Value, b as Value),
  'System.Collections.Generic.EqualityComparer`1.get_Default': (call) =>
    equalityComparerObject(call, typeArgument(call)),
  'System.Collections.Generic.EqualityComparer`1.Create': (call, _receiver, [equals, getHashCode]) => {
    const evaluator = evaluatorOf(call);
    return equalityComparerObject(call, typeArgument(call), {
      equals: (a, b) => evaluator.invokeDelegate(call.frame, equals as Value, [a, b], undefined) as boolean,
      hash: (value) =>
        getHashCode === undefined
          ? fail('System.NotSupportedException', 'Specified method is not supported.')
          : (evaluator.invokeDelegate(call.frame, getHashCode as Value, [value], undefined) as number),
    });
  },
  'System.Collections.Generic.EqualityComparer`1.Equals': (_call, receiver, [a, b]) =>
    ((receiver as CsObject).native as Equality).equals(a as Value, b as Value),
  'System.Collections.Generic.EqualityComparer`1.GetHashCode': (_call, receiver, [value]) =>
    ((receiver as CsObject).native as Equality).hash(value as Value),
});

/** The ArgumentOutOfRangeException that .NET's Array.Copy throws for a negative destination index. */
export function failDestinationIndex(call: NativeCall, index: number): never {
  return failOutOfRange(
    call,
    'destinationIndex',
    `destinationIndex ('${index}') must be greater than or equal to '0'.`,
    String(index)
  );
}

/** The elements of a sequence a collection takes, charged against the slot limit as they are read, before they pile up. */
export function chargedElements(call: NativeCall, source: Value): Value[] {
  const items: Value[] = [];
  for (const item of iterate(call, source, 'collection')) {
    items.push(item);
    if (items.length % SLOTS_PER_CHARGE === 0) call.frame.runtime.allocateSlots(SLOTS_PER_CHARGE);
  }
  call.frame.runtime.allocateSlots(items.length % SLOTS_PER_CHARGE);
  chargeStructFields(call, items);
  return items;
}

const SLOTS_PER_CHARGE = 64;

// ---- ReadOnlyCollection ----

const READ_ONLY = 'System.Collections.ObjectModel.ReadOnlyCollection`1';

function readOnlyIndexOf(call: NativeCall, receiver: Value, value: Value): number {
  const list = listOf(receiver);
  return list.indexOfKey ? list.indexOfKey(value) : indexOfValue(call, list.items, value);
}
defineNatives({
  [`${READ_ONLY}..ctor`]: (call, receiver, [list]) => {
    if (list === undefined) failNull('list');
    // A List or an array stays the wrapper's backing store, so the wrapper shows later changes to it, as .NET's does.
    if (list instanceof CsArray) return setNative(receiver, new ListState(list.values, typeArgument(call)));
    return setNative(
      receiver,
      (list as CsObject).native instanceof ListState
        ? (list as CsObject).native
        : new ListState(chargedElements(call, list as Value), typeArgument(call))
    );
  },
  [`${READ_ONLY}.get_Count`]: (_call, receiver) => listOf(receiver).items.length,
  [`${READ_ONLY}.get_IsReadOnly`]: () => true,
  [`${READ_ONLY}.get_Item`]: (call, receiver, [index]) => {
    const list = listOf(receiver);
    checkIndex(call, index as number, list.items.length);
    return list.items[index as number];
  },
  [`${READ_ONLY}.Contains`]: (call, receiver, [value]) => readOnlyIndexOf(call, receiver, value as Value) >= 0,
  [`${READ_ONLY}.IndexOf`]: (call, receiver, [value]) => readOnlyIndexOf(call, receiver, value as Value),
  [`${READ_ONLY}.CopyTo`]: (call, receiver, [array, index]) => {
    copyToArray(call, listOf(receiver).items, array as Value, index as number);
    return;
  },
  [`${READ_ONLY}.GetEnumerator`]: (call, receiver) => {
    const enumerator = new CsObject(libraryType(call, 'System.Linq.Internal.Enumerator', [typeArgument(call)]), []);
    enumerator.native = new LibraryEnumerator(listOf(receiver).enumerate(), [receiver]);
    return enumerator;
  },
});

defineNatives({
  'System.Linq.Internal.CollectionBuilder.AddAll': (call, _receiver, [target, items]) => {
    const evaluator = evaluatorOf(call);
    const collection = evaluator.runtime.library.typeNamed('System.Collections.Generic.ICollection', 1);
    const add = collection.methods.find((method) => method.name === 'Add') as MethodSymbol;
    const implementation = evaluator.runtime.dispatch(add, target as Value);
    for (const item of iterate(call, items as Value)) {
      evaluator.invoke(
        call.frame,
        implementation,
        target as Value,
        [item],
        call.row,
        environmentOf(evaluator, implementation, target as Value)
      );
    }
    return;
  },
});

export { stringOf };

export function reverseRange(values: Value[], index: number, count: number): void {
  for (let low = index, high = index + count - 1; low < high; low++, high--)
    [values[low], values[high]] = [values[high], values[low]];
}
