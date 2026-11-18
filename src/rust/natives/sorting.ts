import { compareValues } from '../ops';
import { type IntName, intType, type Type } from '../types';
import { ElementPlace, sliceItems, sliceSet, UNIT_VALUE, type Value } from '../values';
import { sizeOf } from './core';
import type { SortElement } from './sort/shared';
import { stableSort } from './sort/stable';
import { unstableSort } from './sort/unstable';
import { call, libraryPanic, type NativeContext } from './support';

/** Sorts a slice in place as std's stable sort (`sort`) or unstable sort (`sort_unstable`) does. */
export function sortSlice(
  ctx: NativeContext,
  slice: Value,
  stable: boolean,
  isLess: (a: Value, b: Value) => boolean
): void {
  const items = sliceItems(slice);
  ctx.runtime.nativeRoots.push(items);
  try {
    (stable ? stableSort : unstableSort)(items, isLess, sortElement(ctx, ctx.typeArgs[0]), () => ordViolation(ctx));
    for (const [index, item] of items.entries()) sliceSet(slice, index, item);
  } finally {
    ctx.runtime.nativeRoots.pop();
  }
}

function sortElement(ctx: NativeContext, type: Type): SortElement {
  return { size: sizeOf(ctx, type), isCopy: ctx.interp.checker.solver.isCopy(type) };
}

function ordViolation(ctx: NativeContext): never {
  return libraryPanic(
    ctx,
    'user-provided comparison function does not correctly implement a total order',
    'core/src/slice/sort/shared/smallsort.rs:854:5'
  );
}

/** `a < b` by `Ord`, as `sort` compares its elements. */
export function lessByOrd(type: Type): (a: Value, b: Value) => boolean {
  return (a, b) => (compareValues(type, a, b) ?? 0) < 0;
}

/** `f(a) < f(b)`, as `sort_by_key` compares, computing both keys at each comparison. */
export function lessByKey(ctx: NativeContext, f: Value): (a: Value, b: Value) => boolean {
  const keyType = ctx.typeArgs[1];
  return (a, b) => {
    const keyA = call(ctx, f, [a]);
    return (compareValues(keyType, keyA, call(ctx, f, [b])) ?? 0) < 0;
  };
}

/** `BinaryHeap::into_sorted_vec`: swaps the greatest to the end and sifts the rest down, as std's heap does. */
export function intoSortedVec(data: Value[], compare: (a: Value, b: Value) => number): Value[] {
  for (let end = data.length - 1; end > 0; end--) {
    [data[0], data[end]] = [data[end], data[0]];
    siftDownRange(data, end, compare);
  }
  return data;
}

function siftDownRange(data: Value[], end: number, compare: (a: Value, b: Value) => number): void {
  const element = data[0];
  let hole = 0;
  let child = 1;
  while (child <= Math.max(end - 2, 0)) {
    if (compare(data[child], data[child + 1]) <= 0) child++;
    if (compare(element, data[child]) >= 0) {
      data[hole] = element;
      return;
    }
    data[hole] = data[child];
    hole = child;
    child = 2 * hole + 1;
  }
  if (child === end - 1 && compare(element, data[child]) < 0) {
    data[hole] = data[child];
    hole = child;
  }
  data[hole] = element;
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
  items.push(...kept);
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
    !(sizeOf(ctx, pairType(names[index])) < sizeOf(ctx, pairType(names[index + 1])) && items.length < 2 ** (8 << index))
  ) {
    index++;
  }
  const isLess = (a: Value, b: Value): boolean => {
    const [keyA, indexA] = a as [Value, number];
    const [keyB, indexB] = b as [Value, number];
    const order = compareValues(keyType, keyA, keyB) ?? 0;
    return order === 0 ? indexA < indexB : order < 0;
  };
  ctx.runtime.nativeRoots.push(pairs);
  try {
    unstableSort(pairs, isLess, sortElement(ctx, pairType(names[index])), () => ordViolation(ctx));
  } finally {
    ctx.runtime.nativeRoots.pop();
  }
  for (const [position, pair] of pairs.entries()) sliceSet(slice, position, items[(pair as [Value, number])[1]]);
}
