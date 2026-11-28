import { comparePartialValues, testPartialOrder } from '../ops';
import { MOVED } from '../runtime';
import { type IntName, intType, type Type } from '../types';
import { ElementPlace, sliceItems, sliceSet, UNIT_VALUE, type Value } from '../values';
import { sizeOf } from './layout';
import type { SortElement } from './sort/shared';
import { stableSort } from './sort/stable';
import { unstableSort } from './sort/unstable';
import { call, callForEach, libraryPanic, type NativeContext } from './support';

export function sortSlice(
  ctx: NativeContext,
  slice: Value,
  stable: boolean,
  isLess: (a: Value, b: Value) => boolean,
  elementType = ctx.typeArgs[0]
): void {
  const items = sliceItems(slice);
  const sort = stable ? stableSort : unstableSort;
  const layout = sortElement(ctx, elementType);
  // The sort keeps elements in buffers of its own while it overwrites the array, so a copy holds them all throughout.
  ctx.runtime.withRoots([...items], () => {
    sort(items, charged(ctx, isLess), layout, () => ordViolation(ctx));
    for (const [index, item] of items.entries()) sliceSet(slice, index, item);
  });
}

/** A comparison that spends an operation each time, so a sort stops at the run's limits however it compares. */
function charged(ctx: NativeContext, isLess: (a: Value, b: Value) => boolean): (a: Value, b: Value) => boolean {
  return (a, b) => {
    ctx.runtime.spend();
    return isLess(a, b);
  };
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

export function lessByPartialOrd(type: Type): (a: Value, b: Value) => boolean {
  return (a, b) => testPartialOrder('lt', type, a, b);
}

/** `f(a) < f(b)`, as `sort_by_key` compares, computing both keys at each comparison. */
export function lessByKey(ctx: NativeContext, f: Value): (a: Value, b: Value) => boolean {
  return compareByKey(ctx, f, (type, a, b) => testPartialOrder('lt', type, a, b));
}

export function compareByKey(
  ctx: NativeContext,
  f: Value,
  compare: (type: Type, a: Value, b: Value) => boolean
): (a: Value, b: Value) => boolean {
  const keyType = ctx.typeArgs[1];
  return (a, b) => {
    const first = call(ctx, f, [a]);
    return ctx.runtime.withRoots([first], () => compare(keyType, first, call(ctx, f, [b])));
  };
}

/**
 * Keeps an element unless `sameBucket(it, the last element kept)` says it repeats that one, as `Vec::dedup_by` does;
 * both reach the elements by `&mut`.
 */
export function dedupBy(
  items: Value[],
  sameBucket: (current: ElementPlace, kept: ElementPlace) => boolean,
  drop: (item: Value) => void
): Value {
  if (items.length < 2) return UNIT_VALUE;
  let read = 1;
  let write = 1;
  try {
    for (; read < items.length; read++) {
      if (sameBucket(new ElementPlace(items, read), new ElementPlace(items, write - 1))) {
        const removed = items[read];
        items[read] = MOVED;
        drop(removed);
      } else {
        if (write < read) {
          items[write] = items[read];
          items[read] = MOVED;
        }
        write++;
      }
    }
  } finally {
    items.copyWithin(write, read);
    items.length -= read - write;
  }
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
  const pairs = callForEach(ctx, items, (item, index) => [call(ctx, f, [item]), index]);
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
  // The sort keeps pairs in buffers of its own while it overwrites the array, so a copy holds every key throughout.
  ctx.runtime.nativeRoots.push([...pairs]);
  try {
    unstableSort(pairs, charged(ctx, isLess), sortElement(ctx, pairType(names[index])), () => ordViolation(ctx));
  } finally {
    ctx.runtime.nativeRoots.pop();
  }
  const order = pairs.map((pair) => (pair as [Value, number])[1]);
  for (const [position, index] of order.entries()) sliceSet(slice, position, items[index]);
}
