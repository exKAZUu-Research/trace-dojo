import { hasStringSlots, permuteStringSlots, swapOwnedElements } from '../capacity';
import { comparePartialValues, testPartialOrder } from '../ops';
import { type IntName, intType, type Type } from '../types';
import { ElementPlace, sliceBase, sliceItems, sliceSet, UNIT_VALUE, type Value } from '../values';
import { sizeOf } from './layout';
import type { SortElement } from './sort/shared';
import { stableSort } from './sort/stable';
import { unstableSort } from './sort/unstable';
import { call, libraryPanic, type NativeContext } from './support';

/** Sorts a slice in place as std's stable sort (`sort`) or unstable sort (`sort_unstable`) does. */
export function sortSlice(
  ctx: NativeContext,
  slice: Value,
  stable: boolean,
  isLess: (a: Value, b: Value) => boolean,
  elementType = ctx.typeArgs[0]
): void {
  const { base, start } = sliceBase(slice);
  const items = sliceItems(slice);
  const sort = stable ? stableSort : unstableSort;
  const layout = sortElement(ctx, elementType);
  if (hasStringSlots(base)) {
    ctx.runtime.allocate(items.length * 5);
    const tracked = items.map((item, index): [Value, bigint] => [item, BigInt(index)]);
    ctx.runtime.withRoots(tracked, () => {
      sort(
        tracked,
        (a, b) => isLess((a as Value[])[0], (b as Value[])[0]),
        layout,
        () => ordViolation(ctx)
      );
      permuteStringSlots(
        base,
        start,
        tracked.map((pair) => Number(pair[1]))
      );
      for (const [index, pair] of tracked.entries()) sliceSet(slice, index, pair[0]);
    });
    return;
  }
  ctx.runtime.withRoots(items, () => {
    sort(items, isLess, layout, () => ordViolation(ctx));
    for (const [index, item] of items.entries()) sliceSet(slice, index, item);
  });
}

function sortElement(ctx: NativeContext, type: Type): SortElement {
  return { size: sizeOf(type), isCopy: ctx.interp.checker.solver.isCopy(type) };
}

function ordViolation(ctx: NativeContext): never {
  return libraryPanic(
    ctx,
    'user-provided comparison function does not correctly implement a total order',
    'core/src/slice/sort/shared/smallsort.rs:854:5'
  );
}

/** `a < b` by `PartialOrd`, as `sort` compares its elements. */
export function lessByPartialOrd(type: Type): (a: Value, b: Value) => boolean {
  return (a, b) => testPartialOrder('lt', type, a, b);
}

/** `f(a) < f(b)`, as `sort_by_key` compares, computing both keys at each comparison. */
export function lessByKey(ctx: NativeContext, f: Value): (a: Value, b: Value) => boolean {
  const keyType = ctx.typeArgs[1];
  return (a, b) => {
    const keyA = call(ctx, f, [a]);
    return testPartialOrder('lt', keyType, keyA, call(ctx, f, [b]));
  };
}

/** `BinaryHeap::into_sorted_vec`: swaps the greatest to the end and sifts the rest down, as std's heap does. */
export function intoSortedVec(data: Value[], compare: (a: Value, b: Value) => number): Value[] {
  for (let end = data.length - 1; end > 0; end--) {
    swapOwnedElements(data, 0, end);
    siftDownRange(data, end, compare);
  }
  return data;
}

function siftDownRange(data: Value[], end: number, compare: (a: Value, b: Value) => number): void {
  let hole = 0;
  let child = 1;
  while (child < end) {
    if (child + 1 < end && compare(data[child], data[child + 1]) <= 0) child++;
    if (compare(data[hole], data[child]) >= 0) return;
    swapOwnedElements(data, hole, child);
    hole = child;
    child = 2 * hole + 1;
  }
}

/**
 * Keeps an element unless `sameBucket(it, the last element kept)` says it repeats that one, as `Vec::dedup_by` does;
 * both reach the elements by `&mut`.
 */
export function dedupBy(items: Value[], sameBucket: (current: ElementPlace, kept: ElementPlace) => boolean): Value {
  const kept: Value[] = [];
  for (let index = 0; index < items.length; index++) {
    const repeats =
      kept.length > 0 && sameBucket(new ElementPlace(items, index), new ElementPlace(kept, kept.length - 1));
    if (!repeats) kept.push(items[index]);
  }
  items.length = 0;
  for (const item of kept) items.push(item);
  return UNIT_VALUE;
}

/**
 * `sort_by_cached_key`: each key once, then `sort_unstable` of the keys paired with their indices, as std does with
 * the narrowest index type that makes the pair smaller.
 */
export function sortByCachedKey(ctx: NativeContext, slice: Value, f: Value): void {
  const keyType = ctx.typeArgs[1];
  const items = [...sliceItems(slice)];
  if (items.length < 2) return;
  const pairs: Value[] = items.map((item, index) => [call(ctx, f, [item]), index]);
  const pairType = (name: IntName): Type => ({ kind: 'tuple', elems: [keyType, intType(name)] });
  const names: IntName[] = ['u8', 'u16', 'u32', 'usize'];
  let index = 0;
  while (
    index < 3 &&
    !(sizeOf(pairType(names[index])) < sizeOf(pairType(names[index + 1])) && items.length < 2 ** (8 << index))
  ) {
    index++;
  }
  const isLess = (a: Value, b: Value): boolean => {
    const [keyA, indexA] = a as [Value, number];
    const [keyB, indexB] = b as [Value, number];
    const order = comparePartialValues(keyType, keyA, keyB);
    return order === 0 ? indexA < indexB : (order ?? 0) < 0;
  };
  ctx.runtime.nativeRoots.push(pairs);
  try {
    unstableSort(pairs, isLess, sortElement(ctx, pairType(names[index])), () => ordViolation(ctx));
  } finally {
    ctx.runtime.nativeRoots.pop();
  }
  const { base, start } = sliceBase(slice);
  const order = pairs.map((pair) => (pair as [Value, number])[1]);
  permuteStringSlots(base, start, order);
  for (const [position, index] of order.entries()) sliceSet(slice, position, items[index]);
}
