import { LIMITS } from '../../interpreter/limits';
import type { Entity } from '../entities';
import { equalityOf, mapKeyOf } from '../equality';
import {
  addMethod,
  currentRuntime,
  definePackage,
  fn,
  genericFunction,
  namedType,
  nativeFunction,
  typeEntity,
  typeParam,
} from '../native';
import { boundsPanic, runtimeErrorPanic } from '../runtimeErrors';
import { appendValues, grownCapacity } from '../sliceOps';
import {
  ANY,
  BASIC,
  COMPARABLE,
  EMPTY_INTERFACE,
  type FuncType,
  funcType,
  type InterfaceType,
  isFloat,
  type NamedType,
  pointerTo,
  sliceOf,
  type Type,
  type TypeParamType,
  underlying,
} from '../types';
import {
  Cell,
  Complex,
  copyValue,
  GoArray,
  GoFunc,
  GoMap,
  GoStruct,
  Iface,
  Pointer,
  Slice,
  type Value,
} from '../values';
import { pdqsort, type SortData, stableSort } from './sorting';
import {
  BOOL,
  callFunction,
  callMethod,
  FLOAT64,
  INT,
  receiverStruct,
  sliceValues,
  spendFor,
  STRING,
  stringPanic,
} from './support';

// Ordering --------------------------------------------------------------------------------------------------------

/** `cmp.Ordered`: the types that < compares. */
export const ORDERED: InterfaceType = {
  kind: 'interface',
  methods: [],
  typeSet: {
    terms: [
      BASIC.int,
      BASIC.int8,
      BASIC.int16,
      BASIC.int32,
      BASIC.int64,
      BASIC.uint,
      BASIC.uint8,
      BASIC.uint16,
      BASIC.uint32,
      BASIC.uint64,
      BASIC.uintptr,
      BASIC.float32,
      BASIC.float64,
      BASIC.string,
    ].map((type) => ({ tilde: true, type })),
  },
};

const ORDERED_TYPE: NamedType = namedType('cmp', 'Ordered', ORDERED);

/** `cmp.Less`: NaN sorts before every number. */
function less(a: Value, b: Value): boolean {
  if (typeof a === 'number') return (Number.isNaN(a) && !Number.isNaN(b)) || a < (b as number);
  return (a as unknown as number) < (b as unknown as number);
}

/** `cmp.Compare`. */
function compare(a: Value, b: Value): number {
  if (typeof a === 'number') {
    const aNaN = Number.isNaN(a);
    const bNaN = Number.isNaN(b);
    if (aNaN) return bNaN ? 0 : -1;
    if (bNaN) return 1;
  }
  if ((a as unknown as number) < (b as unknown as number)) return -1;
  if ((a as unknown as number) > (b as unknown as number)) return 1;
  return 0;
}

function swapSliceElements(slice: Slice, i: number, j: number): void {
  if (i === j) return;
  const left = copyValue(slice.get(i));
  const right = copyValue(slice.get(j));
  slice.set(i, right);
  slice.set(j, left);
}

/** Sorts a slice's elements in place, as the slices and sort packages do. */
function sortSlice(slice: Value, isLess: (a: Value, b: Value) => boolean, stable = false): undefined {
  if (!(slice instanceof Slice)) return undefined;
  const { length } = slice;
  spendFor(length * Math.max(1, Math.ceil(Math.log2(length + 1))));
  const data: SortData = {
    less: (i, j) => isLess(slice.get(i), slice.get(j)),
    swap: (i, j) => swapSliceElements(slice, i, j),
  };
  if (stable) stableSort(data, length);
  else pdqsort(data, length);
  return undefined;
}

function cmpResult(fnValue: Value): (a: Value, b: Value) => number {
  return (a, b) => Number(callFunction(fnValue, [a, b]) as bigint);
}

function binarySearch(slice: Value, compareTo: (element: Value) => number): [bigint, boolean] {
  const values = sliceValues(slice);
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareTo(values[mid]) < 0) low = mid + 1;
    else high = mid;
  }
  return [BigInt(low), low < values.length && compareTo(values[low]) === 0];
}

// sort ------------------------------------------------------------------------------------------------------------

const SORT_INTERFACE = namedType('sort', 'Interface', {
  kind: 'interface',
  methods: [
    { name: 'Len', type: fn([], [INT]) },
    { name: 'Less', type: fn([INT, INT], [BOOL]) },
    { name: 'Swap', type: fn([INT, INT], []) },
  ],
});

/** Sorts through an Interface's methods, which the program may define. */
function sortData(data: Value): [SortData, number] {
  const length = Number(callMethod(data, 'Len') as bigint);
  return [
    {
      less: (i, j) => callMethod(data, 'Less', [BigInt(i), BigInt(j)]) === true,
      swap: (i, j) => void callMethod(data, 'Swap', [BigInt(i), BigInt(j)]),
    },
    length,
  ];
}

/** The type that `sort.Reverse` returns, which reverses its Interface's Less. */
const REVERSE = namedType('sort', 'reverse', {
  kind: 'struct',
  fields: [{ name: 'Interface', type: SORT_INTERFACE, embedded: true }],
});
const reversed = (receiver: Value): Value => receiverStruct(receiver).fields[0];
addMethod(REVERSE, 'Len', fn([], [INT]), (receiver) => callMethod(reversed(receiver), 'Len'), true);
addMethod(
  REVERSE,
  'Less',
  fn([INT, INT], [BOOL]),
  (receiver, [i, j]) => callMethod(reversed(receiver), 'Less', [j, i]),
  true
);
addMethod(
  REVERSE,
  'Swap',
  fn([INT, INT], []),
  (receiver, [i, j]) => callMethod(reversed(receiver), 'Swap', [i, j]),
  true
);

/** `sort.IntSlice` and its relatives: slice types that implement Interface. */
function sliceType(name: string, element: Type, isLess: (a: Value, b: Value) => boolean): NamedType {
  const type = namedType('sort', name, sliceOf(element));
  addMethod(type, 'Len', fn([], [INT]), (receiver) => BigInt((receiver as Slice | undefined)?.length ?? 0));
  addMethod(type, 'Less', fn([INT, INT], [BOOL]), (receiver, [i, j]) =>
    isLess((receiver as Slice).get(Number(i)), (receiver as Slice).get(Number(j)))
  );
  addMethod(type, 'Swap', fn([INT, INT], []), (receiver, [i, j]) => {
    swapSliceElements(receiver as Slice, Number(i), Number(j));
    return;
  });
  addMethod(type, 'Sort', fn([], []), (receiver) => {
    sortSlice(receiver, isLess);
    return;
  });
  return type;
}

const INT_SLICE = sliceType('IntSlice', INT, less);
const STRING_SLICE = sliceType('StringSlice', STRING, less);
const FLOAT64_SLICE = sliceType('Float64Slice', FLOAT64, less);

function isSorted(slice: Value, isLess: (a: Value, b: Value) => boolean): boolean {
  const values = sliceValues(slice);
  for (let index = values.length - 1; index > 0; index--) if (isLess(values[index], values[index - 1])) return false;
  return true;
}

function search(count: number, predicate: (index: number) => boolean): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (!predicate(mid)) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The slice inside the `any` that `sort.Slice` receives, which must hold a slice. */
function anySlice(value: Value, name: string): Slice | undefined {
  if (!(value instanceof Iface) || underlying(value.type).kind !== 'slice') {
    stringPanic(`reflect: call of Swapper on ${value instanceof Iface ? underlying(value.type).kind : 'zero'} Value`);
  }
  void name;
  return value.value as Slice | undefined;
}

const sortMembers: Record<string, Entity> = {
  Interface: typeEntity(SORT_INTERFACE),
  IntSlice: typeEntity(INT_SLICE),
  StringSlice: typeEntity(STRING_SLICE),
  Float64Slice: typeEntity(FLOAT64_SLICE),
  Ints: nativeFunction('Ints', fn([sliceOf(INT)], []), ([slice]) => sortSlice(slice, less)),
  Strings: nativeFunction('Strings', fn([sliceOf(STRING)], []), ([slice]) => sortSlice(slice, less)),
  Float64s: nativeFunction('Float64s', fn([sliceOf(FLOAT64)], []), ([slice]) => sortSlice(slice, less)),
  IntsAreSorted: nativeFunction('IntsAreSorted', fn([sliceOf(INT)], [BOOL]), ([slice]) => isSorted(slice, less)),
  StringsAreSorted: nativeFunction('StringsAreSorted', fn([sliceOf(STRING)], [BOOL]), ([slice]) =>
    isSorted(slice, less)
  ),
  Float64sAreSorted: nativeFunction('Float64sAreSorted', fn([sliceOf(FLOAT64)], [BOOL]), ([slice]) =>
    isSorted(slice, less)
  ),
  Slice: nativeFunction('Slice', fn([ANY, funcType([INT, INT], [BOOL])], []), ([value, isLessFn]) => {
    const slice = anySlice(value, 'Slice');
    if (!slice) return;
    sortByIndex(slice, isLessFn, false);
    return;
  }),
  SliceStable: nativeFunction('SliceStable', fn([ANY, funcType([INT, INT], [BOOL])], []), ([value, isLessFn]) => {
    const slice = anySlice(value, 'SliceStable');
    if (!slice) return;
    sortByIndex(slice, isLessFn, true);
    return;
  }),
  SliceIsSorted: nativeFunction(
    'SliceIsSorted',
    fn([ANY, funcType([INT, INT], [BOOL])], [BOOL]),
    ([value, isLessFn]) => {
      const slice = anySlice(value, 'SliceIsSorted');
      for (let index = (slice?.length ?? 0) - 1; index > 0; index--) {
        if (callFunction(isLessFn, [BigInt(index), BigInt(index - 1)]) === true) return false;
      }
      return true;
    }
  ),
  Sort: nativeFunction('Sort', fn([SORT_INTERFACE], []), ([data]) => {
    const [sortable, length] = sortData(data);
    pdqsort(sortable, length);
    return;
  }),
  Stable: nativeFunction('Stable', fn([SORT_INTERFACE], []), ([data]) => {
    const [sortable, length] = sortData(data);
    stableSort(sortable, length);
    return;
  }),
  IsSorted: nativeFunction('IsSorted', fn([SORT_INTERFACE], [BOOL]), ([data]) => {
    const [sortable, length] = sortData(data);
    for (let index = length - 1; index > 0; index--) if (sortable.less(index, index - 1)) return false;
    return true;
  }),
  Reverse: nativeFunction(
    'Reverse',
    fn([SORT_INTERFACE], [SORT_INTERFACE]),
    ([data]) => new Iface(pointerTo(REVERSE), new Pointer(new Cell(new GoStruct([data])), 'v'))
  ),
  Search: nativeFunction('Search', fn([INT, funcType([INT], [BOOL])], [INT]), ([count, predicate]) =>
    BigInt(search(Number(count as bigint), (index) => callFunction(predicate, [BigInt(index)]) === true))
  ),
  SearchInts: nativeFunction('SearchInts', fn([sliceOf(INT), INT], [INT]), ([slice, target]) => {
    const values = sliceValues(slice);
    return BigInt(search(values.length, (index) => (values[index] as bigint) >= (target as bigint)));
  }),
  SearchStrings: nativeFunction('SearchStrings', fn([sliceOf(STRING), STRING], [INT]), ([slice, target]) => {
    const values = sliceValues(slice);
    return BigInt(search(values.length, (index) => (values[index] as string) >= (target as string)));
  }),
  SearchFloat64s: nativeFunction('SearchFloat64s', fn([sliceOf(FLOAT64), FLOAT64], [INT]), ([slice, target]) => {
    const values = sliceValues(slice);
    return BigInt(search(values.length, (index) => (values[index] as number) >= (target as number)));
  }),
};

/** `sort.Slice`: sorts with a less function of indexes, swapping elements as reflect.Swapper does. */
function sortByIndex(slice: Slice, isLessFn: Value, stable: boolean): void {
  const { length } = slice;
  const data: SortData = {
    less: (i, j) => callFunction(isLessFn, [BigInt(i), BigInt(j)]) === true,
    swap: (i, j) => swapSliceElements(slice, i, j),
  };
  if (stable) stableSort(data, length);
  else pdqsort(data, length);
}

sortMembers.Find = nativeFunction('Find', fn([INT, funcType([INT], [INT])], [INT, BOOL]), ([count, cmpFn]) => {
  const n = Number(count as bigint);
  let i = 0;
  let j = n;
  while (i < j) {
    const h = (i + j) >>> 1;
    if ((callFunction(cmpFn, [BigInt(h)]) as bigint) > 0n) i = h + 1;
    else j = h;
  }
  return [BigInt(i), i < n && callFunction(cmpFn, [BigInt(i)]) === 0n];
});

export const SORT_PACKAGE = definePackage('sort', sortMembers);

// slices ----------------------------------------------------------------------------------------------------------

/** The type parameters `S ~[]E, E constraint` that most of the slices package declares. */
function sliceParams(constraint: InterfaceType): [TypeParamType, TypeParamType] {
  const element = typeParam('E', constraint);
  const slice = typeParam('S', {
    kind: 'interface',
    methods: [],
    typeSet: { terms: [{ tilde: true, type: sliceOf(element) }] },
  });
  return [slice, element];
}

function sliceGeneric(
  name: string,
  constraint: InterfaceType,
  signature: (s: Type, e: Type) => { params: Type[]; results: Type[]; variadic?: boolean },
  impl: (types: Type[]) => (args: Value[]) => Value | Value[]
): Entity {
  const [s, e] = sliceParams(constraint);
  const { params, results, variadic = false } = signature(s, e);
  return genericFunction(name, [s, e], funcType(params, results, variadic), impl);
}

function elementTypeOf(types: Type[]): Type {
  return types[1];
}

function zeroSlotCount(type: Type): number {
  const under = underlying(type);
  if (under.kind === 'array') return Math.max(1, under.length * zeroSlotCount(under.element));
  if (under.kind === 'struct') {
    let total = Math.max(1, under.fields.length);
    for (const field of under.fields) total += zeroSlotCount(field.type) - 1;
    return total;
  }
  return 1;
}

function allocateElements(count: number, element: Type): void {
  const slots = BigInt(count) * BigInt(zeroSlotCount(element));
  if (slots > BigInt(LIMITS.maxSlots)) allocate(LIMITS.maxSlots + 1);
  allocate(Number(slots));
}

function cloneSlice(value: Value, element: Type): Value {
  if (value === undefined) return undefined;
  const values = sliceValues(value);
  if (values.length === 0) return new Slice([], 0, 0, 0);
  const zero = zeroValueOf(element);
  return appendValues(new Slice([], 0, 0, 0), values, element, zero, (count) => allocateElements(count, element));
}

const SEQ_YIELD = (element: Type): FuncType => funcType([element], [BASIC.bool]);
const SEQ = (element: Type): FuncType => funcType([SEQ_YIELD(element)], []);

/** Appends the values an iterator yields one by one, matching Go's `slices.AppendSeq`. */
function appendSeq(initial: Slice | undefined, seq: Value, element: Type): Slice | undefined {
  const zero = zeroValueOf(element);
  let result = initial;
  callFunction(seq, [
    new GoFunc(([value]) => {
      result = appendValues(result, [value], element, zero, (count) => allocateElements(count, element));
      return true;
    }),
  ]);
  return result;
}

const slicesMembers: Record<string, Entity> = {
  Sort: sliceGeneric(
    'Sort',
    ORDERED,
    (s) => ({ params: [s], results: [] }),
    () =>
      ([slice]) =>
        sortSlice(slice, less)
  ),
  SortFunc: sliceGeneric(
    'SortFunc',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, funcType([e, e], [INT])], results: [] }),
    () =>
      ([slice, cmpFn]) => {
        const order = cmpResult(cmpFn);
        sortSlice(slice, (a, b) => order(a, b) < 0);
        return;
      }
  ),
  SortStableFunc: sliceGeneric(
    'SortStableFunc',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, funcType([e, e], [INT])], results: [] }),
    () =>
      ([slice, cmpFn]) => {
        const order = cmpResult(cmpFn);
        sortSlice(slice, (a, b) => order(a, b) < 0, true);
        return;
      }
  ),
  IsSorted: sliceGeneric(
    'IsSorted',
    ORDERED,
    (s) => ({ params: [s], results: [BOOL] }),
    () =>
      ([slice]) =>
        isSorted(slice, less)
  ),
  IsSortedFunc: sliceGeneric(
    'IsSortedFunc',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, funcType([e, e], [INT])], results: [BOOL] }),
    () =>
      ([slice, cmpFn]) => {
        const order = cmpResult(cmpFn);
        return isSorted(slice, (a, b) => order(a, b) < 0);
      }
  ),
  BinarySearch: sliceGeneric(
    'BinarySearch',
    ORDERED,
    (s, e) => ({ params: [s, e], results: [INT, BOOL] }),
    () =>
      ([slice, target]) =>
        binarySearch(slice, (element) => compare(element, target))
  ),
  BinarySearchFunc: (() => {
    const [s, e] = sliceParams(EMPTY_INTERFACE);
    const t = typeParam('T', EMPTY_INTERFACE);
    return genericFunction(
      'BinarySearchFunc',
      [s, e, t],
      funcType([s, t, funcType([e, t], [INT])], [INT, BOOL]),
      () =>
        ([slice, target, cmpFn]) =>
          binarySearch(slice, (element) => Number(callFunction(cmpFn, [element, target]) as bigint))
    );
  })(),
  Contains: sliceGeneric(
    'Contains',
    COMPARABLE,
    (s, e) => ({ params: [s, e], results: [BOOL] }),
    (types) => {
      const equal = equalityOf(elementTypeOf(types));
      return ([slice, value]) => sliceValues(slice).some((element) => equal(element, value));
    }
  ),
  ContainsFunc: sliceGeneric(
    'ContainsFunc',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, funcType([e], [BOOL])], results: [BOOL] }),
    () =>
      ([slice, predicate]) =>
        sliceValues(slice).some((element) => callFunction(predicate, [element]) === true)
  ),
  Index: sliceGeneric(
    'Index',
    COMPARABLE,
    (s, e) => ({ params: [s, e], results: [INT] }),
    (types) => {
      const equal = equalityOf(elementTypeOf(types));
      return ([slice, value]) => BigInt(sliceValues(slice).findIndex((element) => equal(element, value)));
    }
  ),
  IndexFunc: sliceGeneric(
    'IndexFunc',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, funcType([e], [BOOL])], results: [INT] }),
    () =>
      ([slice, predicate]) =>
        BigInt(sliceValues(slice).findIndex((element) => callFunction(predicate, [element]) === true))
  ),
  Equal: sliceGeneric(
    'Equal',
    COMPARABLE,
    (s) => ({ params: [s, s], results: [BOOL] }),
    (types) => {
      const equal = equalityOf(elementTypeOf(types));
      return ([a, b]) => {
        const x = sliceValues(a);
        const y = sliceValues(b);
        return x.length === y.length && x.every((element, index) => equal(element, y[index]));
      };
    }
  ),
  Reverse: sliceGeneric(
    'Reverse',
    EMPTY_INTERFACE,
    (s) => ({ params: [s], results: [] }),
    () =>
      ([slice]) => {
        if (!(slice instanceof Slice)) return;
        for (let i = 0, j = slice.length - 1; i < j; i++, j--) swapSliceElements(slice, i, j);
        return;
      }
  ),
  Max: sliceGeneric(
    'Max',
    ORDERED,
    (s, e) => ({ params: [s], results: [e] }),
    (types) => {
      const floats = isFloat(elementTypeOf(types));
      return ([slice]) =>
        extreme(slice, 'slices.Max: empty list', (a, b) => (floats && Number.isNaN(a) ? true : compare(a, b) > 0));
    }
  ),
  Min: sliceGeneric(
    'Min',
    ORDERED,
    (s, e) => ({ params: [s], results: [e] }),
    (types) => {
      const floats = isFloat(elementTypeOf(types));
      return ([slice]) =>
        extreme(slice, 'slices.Min: empty list', (a, b) => (floats && Number.isNaN(a) ? true : compare(a, b) < 0));
    }
  ),
  MaxFunc: sliceGeneric(
    'MaxFunc',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, funcType([e, e], [INT])], results: [e] }),
    () =>
      ([slice, cmpFn]) =>
        extreme(slice, 'slices.MaxFunc: empty list', (a, b) => Number(callFunction(cmpFn, [a, b]) as bigint) > 0)
  ),
  MinFunc: sliceGeneric(
    'MinFunc',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, funcType([e, e], [INT])], results: [e] }),
    () =>
      ([slice, cmpFn]) =>
        extreme(slice, 'slices.MinFunc: empty list', (a, b) => Number(callFunction(cmpFn, [a, b]) as bigint) < 0)
  ),
  Clone: sliceGeneric(
    'Clone',
    EMPTY_INTERFACE,
    (s) => ({ params: [s], results: [s] }),
    (types) =>
      ([slice]) =>
        cloneSlice(slice, elementTypeOf(types))
  ),
  Compact: sliceGeneric(
    'Compact',
    COMPARABLE,
    (s) => ({ params: [s], results: [s] }),
    (types) => {
      const equal = equalityOf(elementTypeOf(types));
      return ([slice]) => compact(slice, equal, types);
    }
  ),
  CompactFunc: sliceGeneric(
    'CompactFunc',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, funcType([e, e], [BOOL])], results: [s] }),
    (types) =>
      ([slice, eq]) =>
        compact(slice, (a, b) => callFunction(eq, [a, b]) === true, types)
  ),
  Insert: sliceGeneric(
    'Insert',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, INT, sliceOf(e)], results: [s], variadic: true }),
    (types) =>
      ([slice, at, values]) =>
        insert(slice, Number(at as bigint), sliceValues(values), types)
  ),
  Delete: sliceGeneric(
    'Delete',
    EMPTY_INTERFACE,
    (s) => ({ params: [s, INT, INT], results: [s] }),
    (types) =>
      ([slice, from, to]) =>
        deleteRange(slice, Number(from as bigint), Number(to as bigint), types)
  ),
  DeleteFunc: sliceGeneric(
    'DeleteFunc',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, funcType([e], [BOOL])], results: [s] }),
    (types) =>
      ([slice, predicate]) => {
        if (!(slice instanceof Slice)) return slice;
        const kept = slice.values().filter((element) => callFunction(predicate, [element]) !== true);
        return overwrite(slice, kept, types);
      }
  ),
  Concat: sliceGeneric(
    'Concat',
    EMPTY_INTERFACE,
    (s) => ({ params: [sliceOf(s)], results: [s], variadic: true }),
    (types) =>
      ([lists]) => {
        const parts = sliceValues(lists);
        let totalBig = 0n;
        for (const part of parts) {
          totalBig += BigInt((part as Slice | undefined)?.length ?? 0);
          if (totalBig >= 1n << 63n) stringPanic('len out of range');
        }
        if (totalBig === 0n) return;
        if (totalBig > BigInt(LIMITS.maxSlots)) allocate(LIMITS.maxSlots + 1);
        const total = Number(totalBig);
        const element = elementTypeOf(types);
        const capacity = grownCapacity(0, total, element);
        allocateElements(capacity, element);
        spendFor(capacity);
        const zero = zeroValueOf(element);
        const array: Value[] = [];
        for (const part of parts) {
          currentRuntime().spend();
          for (const item of sliceValues(part)) array.push(copyValue(item));
        }
        while (array.length < capacity) array.push(zero());
        return new Slice(array, 0, total, capacity);
      }
  ),
  Repeat: sliceGeneric(
    'Repeat',
    EMPTY_INTERFACE,
    (s) => ({ params: [s, INT], results: [s] }),
    (types) =>
      ([slice, count]) => {
        const times = count as bigint;
        if (times < 0n) stringPanic('cannot be negative');
        const values = sliceValues(slice);
        const totalBig = BigInt(values.length) * times;
        if (totalBig >= 1n << 63n) stringPanic('the result of (len(x) * count) overflows');
        if (totalBig > BigInt(LIMITS.maxSlots)) allocate(LIMITS.maxSlots + 1);
        const total = Number(totalBig);
        const element = elementTypeOf(types);
        allocateElements(total, element);
        spendFor(total);
        const runtime = currentRuntime();
        const repeated: Value[] = [];
        if (values.length > 0) {
          for (let index = 0; index < Number(times); index++) {
            runtime.spend();
            for (const value of values) repeated.push(copyValue(value));
          }
        }
        return new Slice(repeated, 0, total, total);
      }
  ),
  AppendSeq: sliceGeneric(
    'AppendSeq',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, SEQ(e)], results: [s] }),
    (types) =>
      ([slice, seq]) =>
        appendSeq(slice as Slice | undefined, seq, elementTypeOf(types))
  ),
  Sorted: (() => {
    const e = typeParam('E', ORDERED);
    return genericFunction('Sorted', [e], funcType([SEQ(e)], [sliceOf(e)]), (types) => ([seq]) => {
      const slice = appendSeq(undefined, seq, types[0]);
      sortSlice(slice, less);
      return slice;
    });
  })(),
  Collect: (() => {
    const e = typeParam('E', EMPTY_INTERFACE);
    return genericFunction(
      'Collect',
      [e],
      funcType([SEQ(e)], [sliceOf(e)]),
      (types) =>
        ([seq]) =>
          appendSeq(undefined, seq, types[0])
    );
  })(),
  Values: sliceGeneric(
    'Values',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s], results: [SEQ(e)] }),
    () =>
      ([slice]) =>
        new GoFunc(([yieldFn]) => {
          for (const value of sliceValues(slice)) if (callFunction(yieldFn, [value]) !== true) break;
          return;
        })
  ),
};

function extreme(slice: Value, message: string, better: (a: Value, b: Value) => boolean): Value {
  const values = sliceValues(slice);
  if (values.length === 0) stringPanic(message);
  let best = values[0];
  for (const value of values.slice(1)) if (better(value, best)) best = value;
  return copyValue(best);
}

function compact(slice: Value, equal: (a: Value, b: Value) => boolean, types: Type[]): Value {
  if (!(slice instanceof Slice) || slice.length < 2) return slice;
  const values = slice.values();
  const kept: Value[] = [values[0]];
  for (const value of values.slice(1)) if (!equal(kept.at(-1), value)) kept.push(value);
  return overwrite(slice, kept, types);
}

/** Writes values over the front of a slice's array, clears the rest of its old length, and shortens it. */
function overwrite(slice: Slice, kept: Value[], types: Type[]): Slice {
  const zero = zeroValueOf(elementTypeOf(types));
  for (let index = 0; index < slice.length; index++)
    slice.set(index, index < kept.length ? copyValue(kept[index]) : zero());
  return new Slice(slice.array, slice.offset, kept.length, slice.capacity);
}

function zeroValueOf(type: Type): () => Value {
  const under = underlying(type);
  if (under.kind === 'basic') {
    if (under.basic === 'string') return () => '';
    if (under.basic === 'bool') return () => false;
    if (under.basic.startsWith('float')) return () => 0;
    if (under.basic.startsWith('complex')) return () => new Complex(0, 0);
    if (under.basic.startsWith('int') || under.basic.startsWith('uint')) return () => 0n;
  }
  if (under.kind === 'struct') {
    const zeros = under.fields.map((field) => zeroValueOf(field.type));
    return () => new GoStruct(zeros.map((zero) => zero()));
  }
  if (under.kind === 'array') {
    const zero = zeroValueOf(under.element);
    return () => new GoArray(Array.from({ length: under.length }, zero));
  }
  return () => {};
}

function allocate(count: number): void {
  currentRuntime().allocate(count);
}

function insert(slice: Value, at: number, values: Value[], types: Type[]): Value {
  const length = (slice as Slice | undefined)?.length ?? 0;
  if (at < 0 || at > length) boundsPanic(`slice bounds out of range [${at}:${length}]`);
  if (values.length === 0) return slice;
  const element = elementTypeOf(types);
  const zero = zeroValueOf(element);
  const alloc = (count: number): void => allocateElements(count, element);
  if (at === length) return appendValues(slice as Slice | undefined, values, element, zero, alloc);
  const current = slice as Slice;
  const tail = current.values().slice(at).map(copyValue);
  if (length + values.length > current.capacity) {
    const newLength = length + values.length;
    const newCapacity = grownCapacity(current.capacity, newLength, element);
    alloc(newCapacity);
    spendFor(newCapacity);
    const array: Value[] = current.values().slice(0, at).map(copyValue);
    for (const value of values) array.push(copyValue(value));
    for (const value of tail) array.push(value);
    while (array.length < newCapacity) array.push(zero());
    return new Slice(array, 0, newLength, newCapacity);
  }
  const result = new Slice(current.array, current.offset, length + values.length, current.capacity);
  for (const [index, value] of tail.entries()) result.set(at + values.length + index, value);
  for (const [index, value] of values.entries()) result.set(at + index, copyValue(value));
  return result;
}

function deleteRange(slice: Value, from: number, to: number, types: Type[]): Value {
  const current = slice as Slice | undefined;
  const length = current?.length ?? 0;
  if (to > length || from > to || from < 0) boundsPanic(`slice bounds out of range [${from}:${to}]`);
  if (!current || from === to) return slice;
  const kept = [...current.values().slice(0, from), ...current.values().slice(to)];
  return overwrite(current, kept, types);
}

const SEQ2_YIELD = (key: Type, value: Type): FuncType => funcType([key, value], [BASIC.bool]);
const SEQ2 = (key: Type, value: Type): FuncType => funcType([SEQ2_YIELD(key, value)], []);

/** Collects the pairs an iterator of pairs yields. */
function collectPairs(seq: Value): [Value, Value][] {
  const pairs: [Value, Value][] = [];
  callFunction(seq, [
    new GoFunc(([key, value]) => {
      pairs.push([copyValue(key), copyValue(value)]);
      return true;
    }),
  ]);
  return pairs;
}

/** An iterator over pairs, which stops when the yield function returns false, as range-over-func requires. */
function pairIterator(pairs: () => [Value, Value][]): GoFunc {
  return new GoFunc(([yieldFn]) => {
    for (const [key, value] of pairs()) if (callFunction(yieldFn, [key, value]) !== true) break;
    return;
  });
}

Object.assign(slicesMembers, {
  All: sliceGeneric(
    'All',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s], results: [SEQ2(INT, e)] }),
    () =>
      ([slice]) =>
        pairIterator(() => sliceValues(slice).map((value, index): [Value, Value] => [BigInt(index), value]))
  ),
  Backward: sliceGeneric(
    'Backward',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s], results: [SEQ2(INT, e)] }),
    () =>
      ([slice]) =>
        pairIterator(() =>
          sliceValues(slice)
            .map((value, index): [Value, Value] => [BigInt(index), value])
            .toReversed()
        )
  ),
  Chunk: sliceGeneric(
    'Chunk',
    EMPTY_INTERFACE,
    (s) => ({ params: [s, INT], results: [SEQ(s)] }),
    () =>
      ([slice, size]) => {
        const n = Number(size as bigint);
        if (n < 1) stringPanic('cannot be less than 1');
        return new GoFunc(([yieldFn]) => {
          const current = slice as Slice | undefined;
          for (let start = 0; start < (current?.length ?? 0); start += n) {
            const end = Math.min(start + n, (current as Slice).length);
            // Each chunk is a slice of the original array whose capacity ends with the chunk.
            const chunk = new Slice(
              (current as Slice).array,
              (current as Slice).offset + start,
              end - start,
              end - start
            );
            if (callFunction(yieldFn, [chunk]) !== true) break;
          }
          return;
        });
      }
  ),
  Compare: sliceGeneric(
    'Compare',
    ORDERED,
    (s) => ({ params: [s, s], results: [INT] }),
    () =>
      ([a, b]) => {
        const x = sliceValues(a);
        const y = sliceValues(b);
        for (let index = 0; index < Math.min(x.length, y.length); index++) {
          const order = compare(x[index], y[index]);
          if (order !== 0) return BigInt(order);
        }
        return BigInt(Math.sign(x.length - y.length));
      }
  ),
  EqualFunc: (() => {
    const [s1, e1] = sliceParams(EMPTY_INTERFACE);
    const [s2, e2] = sliceParams(EMPTY_INTERFACE);
    return genericFunction(
      'EqualFunc',
      [s1, s2, e1, e2],
      funcType([s1, s2, funcType([e1, e2], [BOOL])], [BOOL]),
      () =>
        ([a, b, eq]) => {
          const x = sliceValues(a);
          const y = sliceValues(b);
          return x.length === y.length && x.every((value, index) => callFunction(eq, [value, y[index]]) === true);
        }
    );
  })(),
  Clip: sliceGeneric(
    'Clip',
    EMPTY_INTERFACE,
    (s) => ({ params: [s], results: [s] }),
    () =>
      ([slice]) => {
        const current = slice as Slice | undefined;
        return current && new Slice(current.array, current.offset, current.length, current.length);
      }
  ),
  Grow: sliceGeneric(
    'Grow',
    EMPTY_INTERFACE,
    (s) => ({ params: [s, INT], results: [s] }),
    (types) =>
      ([slice, count]) => {
        const nBig = count as bigint;
        if (nBig < 0n) stringPanic('cannot be negative');
        const current = slice as Slice | undefined;
        const length = current?.length ?? 0;
        const capacity = current?.capacity ?? 0;
        if (BigInt(capacity - length) >= nBig) return slice;
        if (BigInt(length) + nBig > BigInt(LIMITS.maxSlots)) allocate(LIMITS.maxSlots + 1);
        const n = Number(nBig);
        const element = elementTypeOf(types);
        const newCapacity = grownCapacity(capacity, length + n, element);
        allocateElements(newCapacity, element);
        spendFor(newCapacity);
        const zero = zeroValueOf(element);
        const array: Value[] = current
          ? current.array.slice(current.offset, current.offset + capacity).map(copyValue)
          : [];
        while (array.length < newCapacity) array.push(zero());
        return new Slice(array, 0, length, newCapacity);
      }
  ),
  Replace: sliceGeneric(
    'Replace',
    EMPTY_INTERFACE,
    (s, e) => ({ params: [s, INT, INT, sliceOf(e)], results: [s], variadic: true }),
    (types) =>
      ([slice, from, to, values]) => {
        const current = slice as Slice | undefined;
        const length = current?.length ?? 0;
        const i = Number(from as bigint);
        const j = Number(to as bigint);
        if (i < 0 || j < i || j > length) boundsPanic(`slice bounds out of range [${i}:${j}]`);
        const element = elementTypeOf(types);
        const inserted = sliceValues(values).map(copyValue);
        const kept = [
          ...(current?.values() ?? []).slice(0, i).map(copyValue),
          ...inserted,
          ...(current?.values() ?? []).slice(j).map(copyValue),
        ];
        if (current && kept.length <= current.capacity) {
          const zero = zeroValueOf(element);
          for (let index = 0; index < Math.max(kept.length, length); index++)
            current.set(index, index < kept.length ? kept[index] : zero());
          return new Slice(current.array, current.offset, kept.length, current.capacity);
        }
        const head = current && new Slice(current.array, current.offset, i, current.capacity);
        const zero = zeroValueOf(element);
        return appendValues(head, kept.slice(i), element, zero, (count) => allocateElements(count, element));
      }
  ),
  SortedFunc: (() => {
    const e = typeParam('E', EMPTY_INTERFACE);
    return genericFunction(
      'SortedFunc',
      [e],
      funcType([SEQ(e), funcType([e, e], [INT])], [sliceOf(e)]),
      (types) =>
        ([seq, cmpFn]) => {
          const slice = appendSeq(undefined, seq, types[0]);
          const order = cmpResult(cmpFn);
          sortSlice(slice, (a, b) => order(a, b) < 0);
          return slice;
        }
    );
  })(),
  SortedStableFunc: (() => {
    const e = typeParam('E', EMPTY_INTERFACE);
    return genericFunction(
      'SortedStableFunc',
      [e],
      funcType([SEQ(e), funcType([e, e], [INT])], [sliceOf(e)]),
      (types) =>
        ([seq, cmpFn]) => {
          const slice = appendSeq(undefined, seq, types[0]);
          const order = cmpResult(cmpFn);
          sortSlice(slice, (a, b) => order(a, b) < 0, true);
          return slice;
        }
    );
  })(),
});

export const SLICES_PACKAGE = definePackage(
  'slices',
  slicesMembers,
  [
    'All',
    'Backward',
    'AppendSeq',
    'Chunk',
    'Clip',
    'Grow',
    'EqualFunc',
    'IndexFunc',
    'Replace',
    'SortedFunc',
    'SortedStableFunc',
    'ContainsFunc',
  ].filter((name) => !(name in slicesMembers))
);

// maps ------------------------------------------------------------------------------------------------------------

function mapParams(keyConstraint: InterfaceType = COMPARABLE): [TypeParamType, TypeParamType, TypeParamType] {
  const k = typeParam('K', keyConstraint);
  const v = typeParam('V', EMPTY_INTERFACE);
  const m = typeParam('M', {
    kind: 'interface',
    methods: [],
    typeSet: { terms: [{ tilde: true, type: { kind: 'map', key: k, value: v } }] },
  });
  return [m, k, v];
}

function mapEntries(value: Value): { key: Value; value: Value }[] {
  return [...((value as GoMap | undefined)?.entries.values() ?? [])];
}

const mapsMembers: Record<string, Entity> = {
  Keys: (() => {
    const [m, k, v] = mapParams();
    return genericFunction(
      'Keys',
      [m, k, v],
      funcType([m], [SEQ(k)]),
      () =>
        ([map]) =>
          new GoFunc(([yieldFn]) => {
            for (const entry of mapEntries(map)) if (callFunction(yieldFn, [entry.key]) !== true) break;
            return;
          })
    );
  })(),
  Values: (() => {
    const [m, k, v] = mapParams();
    return genericFunction(
      'Values',
      [m, k, v],
      funcType([m], [SEQ(v)]),
      () =>
        ([map]) =>
          new GoFunc(([yieldFn]) => {
            for (const entry of mapEntries(map)) if (callFunction(yieldFn, [entry.value]) !== true) break;
            return;
          })
    );
  })(),
  Clone: (() => {
    const [m, k, v] = mapParams();
    return genericFunction('Clone', [m, k, v], funcType([m], [m]), (types) => ([map]) => {
      if (map === undefined) return;
      const copy = new GoMap(mapKeyOf(types[1]));
      for (const [key, entry] of (map as GoMap).entries)
        copy.entries.set(key, { key: copyValue(entry.key), value: copyValue(entry.value) });
      return copy;
    });
  })(),
  Copy: (() => {
    const [m, k, v] = mapParams();
    const m2 = typeParam('M2', m.constraint);
    return genericFunction('Copy', [m, m2, k, v], funcType([m, m2], []), () => ([destination, source]) => {
      for (const [key, entry] of (source as GoMap | undefined)?.entries ?? []) {
        if (!destination) runtimeErrorPanic('assignment to entry in nil map');
        (destination as GoMap).entries.set(key, { key: copyValue(entry.key), value: copyValue(entry.value) });
      }
      return;
    });
  })(),
  Equal: (() => {
    const k = typeParam('K', COMPARABLE);
    const v = typeParam('V', COMPARABLE);
    const m = typeParam('M1', {
      kind: 'interface',
      methods: [],
      typeSet: { terms: [{ tilde: true, type: { kind: 'map', key: k, value: v } }] },
    });
    const m2 = typeParam('M2', m.constraint);
    return genericFunction('Equal', [m, m2, k, v], funcType([m, m2], [BOOL]), (types) => {
      const equal = equalityOf(types[3]);
      return ([a, b]) => {
        const x = (a as GoMap | undefined)?.entries ?? new Map();
        const y = (b as GoMap | undefined)?.entries ?? new Map();
        if (x.size !== y.size) return false;
        for (const [key, entry] of x) {
          const other = y.get(key);
          if (!other || !equal(entry.value, other.value)) return false;
        }
        return true;
      };
    });
  })(),
  DeleteFunc: (() => {
    const [m, k, v] = mapParams();
    return genericFunction(
      'DeleteFunc',
      [m, k, v],
      funcType([m, funcType([k, v], [BOOL])], []),
      () =>
        ([map, predicate]) => {
          for (const [key, entry] of (map as GoMap | undefined)?.entries ?? []) {
            if (callFunction(predicate, [entry.key, entry.value]) === true) (map as GoMap).entries.delete(key);
          }
          return;
        }
    );
  })(),
  All: (() => {
    const [m, k, v] = mapParams();
    return genericFunction(
      'All',
      [m, k, v],
      funcType([m], [SEQ2(k, v)]),
      () =>
        ([map]) =>
          pairIterator(() => mapEntries(map).map((entry): [Value, Value] => [entry.key, entry.value]))
    );
  })(),
  Collect: (() => {
    const k = typeParam('K', COMPARABLE);
    const v = typeParam('V', EMPTY_INTERFACE);
    return genericFunction(
      'Collect',
      [k, v],
      funcType([SEQ2(k, v)], [{ kind: 'map', key: k, value: v }]),
      (types) =>
        ([seq]) => {
          const keyOf = mapKeyOf(types[0]);
          const map = new GoMap(keyOf);
          for (const [key, value] of collectPairs(seq)) map.entries.set(keyOf(key), { key, value });
          return map;
        }
    );
  })(),
  Insert: (() => {
    const [m, k, v] = mapParams();
    return genericFunction('Insert', [m, k, v], funcType([m, SEQ2(k, v)], []), () => ([map, seq]) => {
      for (const [key, value] of collectPairs(seq)) {
        if (!map) runtimeErrorPanic('assignment to entry in nil map');
        const target = map as GoMap;
        const existing = target.entries.get(target.keyOf(key));
        if (existing) existing.value = value;
        else target.entries.set(target.keyOf(key), { key, value });
      }
      return;
    });
  })(),
  EqualFunc: (() => {
    const k = typeParam('K', COMPARABLE);
    const v1 = typeParam('V1', EMPTY_INTERFACE);
    const v2 = typeParam('V2', EMPTY_INTERFACE);
    const m1 = typeParam('M1', {
      kind: 'interface',
      methods: [],
      typeSet: { terms: [{ tilde: true, type: { kind: 'map', key: k, value: v1 } }] },
    });
    const m2 = typeParam('M2', {
      kind: 'interface',
      methods: [],
      typeSet: { terms: [{ tilde: true, type: { kind: 'map', key: k, value: v2 } }] },
    });
    return genericFunction(
      'EqualFunc',
      [m1, m2, k, v1, v2],
      funcType([m1, m2, funcType([v1, v2], [BOOL])], [BOOL]),
      () =>
        ([a, b, eq]) => {
          const x = (a as GoMap | undefined)?.entries ?? new Map();
          const y = (b as GoMap | undefined)?.entries ?? new Map();
          if (x.size !== y.size) return false;
          for (const [key, entry] of x) {
            const other = y.get(key);
            if (!other || callFunction(eq, [entry.value, other.value]) !== true) return false;
          }
          return true;
        }
    );
  })(),
};

export const MAPS_PACKAGE = definePackage('maps', mapsMembers);

// cmp -------------------------------------------------------------------------------------------------------------

const cmpMembers: Record<string, Entity> = {
  Ordered: { kind: 'type', name: 'Ordered', type: ORDERED_TYPE },
  Compare: (() => {
    const t = typeParam('T', ORDERED);
    return genericFunction(
      'Compare',
      [t],
      funcType([t, t], [INT]),
      () =>
        ([a, b]) =>
          BigInt(compare(a, b))
    );
  })(),
  Less: (() => {
    const t = typeParam('T', ORDERED);
    return genericFunction(
      'Less',
      [t],
      funcType([t, t], [BOOL]),
      () =>
        ([a, b]) =>
          less(a, b)
    );
  })(),
  Or: (() => {
    const t = typeParam('T', COMPARABLE);
    return genericFunction('Or', [t], funcType([sliceOf(t)], [t], true), (types) => {
      const zero = zeroValueOf(types[0]);
      const equal = equalityOf(types[0]);
      return ([values]) => copyValue(sliceValues(values).find((value) => !equal(value, zero())) ?? zero());
    });
  })(),
};

export const CMP_PACKAGE = definePackage('cmp', cmpMembers);
