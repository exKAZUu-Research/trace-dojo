import type { Value } from '../../values';
import {
  bidirectionalMerge,
  choosePivot,
  findExistingRun,
  ilog2,
  insertionSortShiftLeft,
  type IsLess,
  MAX_LEN_ALWAYS_INSERTION_SORT,
  MAX_STACK_ARRAY_SIZE,
  SMALL_SORT_FALLBACK_THRESHOLD,
  SMALL_SORT_GENERAL_SCRATCH_LEN,
  SMALL_SORT_GENERAL_THRESHOLD,
  smallSortGeneral,
  type SortElement,
  type Sorter,
  swap,
} from './shared';

const SMALL_SORT_NETWORK_SCRATCH_LEN = 32;
const MAX_BRANCHLESS_PARTITION_SIZE = 96;

/** `slice::sort_unstable` and its `_by` and `_by_key` forms, as std's `core::slice::sort::unstable`: ipnsort. */
export function unstableSort(v: Value[], isLess: IsLess, element: SortElement, ordViolation: () => never): void {
  const len = v.length;
  if (element.size === 0 || len < 2) return;
  if (len <= MAX_LEN_ALWAYS_INSERTION_SORT) {
    insertionSortShiftLeft(v, 0, len, 1, isLess);
    return;
  }
  const [runLen, wasReversed] = findExistingRun(v, 0, len, isLess);
  if (runLen === len) {
    if (wasReversed) v.reverse();
    return;
  }
  const scratch = Array.from<Value>({ length: SMALL_SORT_GENERAL_SCRATCH_LEN });
  quicksort(v, 0, len, { limit: 2 * ilog2(len | 1), ancestor: undefined }, { isLess, element, scratch, ordViolation });
}

function quicksort(
  v: Value[],
  start: number,
  length: number,
  initial: { limit: number; ancestor: { value: Value } | undefined },
  sorter: Sorter
): void {
  let base = start;
  let len = length;
  let { limit, ancestor } = initial;
  const { isLess } = sorter;
  for (;;) {
    if (len <= smallSortThreshold(sorter.element)) {
      smallSort(v, base, len, sorter);
      return;
    }
    if (limit === 0) {
      heapsort(v, base, len, isLess);
      return;
    }
    limit--;
    const pivotPos = choosePivot(v, base, len, isLess);
    if (ancestor !== undefined && !isLess(ancestor.value, v[base + pivotPos])) {
      const numLt = partition(v, { base, len, pivotPos }, (a, b) => !isLess(b, a), sorter.element);
      base += numLt + 1;
      len -= numLt + 1;
      ancestor = undefined;
      continue;
    }
    const numLt = partition(v, { base, len, pivotPos }, isLess, sorter.element);
    quicksort(v, base, numLt, { limit, ancestor }, sorter);
    ancestor = { value: v[base + numLt] };
    base += numLt + 1;
    len -= numLt + 1;
  }
}

/** Puts the pivot first, partitions the rest around it, and puts it between the two sides. */
function partition(
  v: Value[],
  { base, len, pivotPos }: { base: number; len: number; pivotPos: number },
  isLess: IsLess,
  element: SortElement
): number {
  if (len === 0) return 0;
  swap(v, base, base + pivotPos);
  const pivot = v[base];
  const numLt =
    element.size <= MAX_BRANCHLESS_PARTITION_SIZE
      ? partitionLomutoBranchlessCyclic(v, base + 1, len - 1, (value) => isLess(value, pivot))
      : partitionHoareBranchyCyclic(v, base + 1, len - 1, (value) => isLess(value, pivot));
  swap(v, base, base + numLt);
  return numLt;
}

/** Lomuto's partition as a cyclic permutation: the first element waits outside while the others shift into place. */
function partitionLomutoBranchlessCyclic(
  v: Value[],
  base: number,
  len: number,
  isLessThanPivot: (value: Value) => boolean
): number {
  if (len === 0) return 0;
  const gapValue = v[base];
  let gapPos = base;
  let numLt = 0;
  const step = (right: Value, rightPos: number): void => {
    const rightIsLt = isLessThanPivot(right);
    const left = base + numLt;
    v[gapPos] = v[left];
    v[left] = right;
    gapPos = rightPos;
    if (rightIsLt) numLt++;
  };
  for (let index = base + 1; index < base + len; index++) step(v[index], index);
  step(gapValue, -1);
  return numLt;
}

/** Hoare's partition, whose swaps of out-of-place pairs form one cycle through a gap. */
function partitionHoareBranchyCyclic(
  v: Value[],
  base: number,
  len: number,
  isLessThanPivot: (value: Value) => boolean
): number {
  if (len === 0) return 0;
  let gap: { pos: number; value: Value } | undefined;
  let left = base;
  let right = base + len;
  for (;;) {
    while (left < right && isLessThanPivot(v[left])) left++;
    do right--;
    while (left < right && !isLessThanPivot(v[right]));
    if (left >= right) break;
    if (gap) v[gap.pos] = v[left];
    else gap = { pos: right, value: v[left] };
    gap.pos = right;
    v[left] = v[right];
    left++;
  }
  if (gap) v[gap.pos] = gap.value;
  return left - base;
}

function heapsort(v: Value[], base: number, len: number, isLess: IsLess): void {
  for (let index = len + (len >> 1) - 1; index >= 0; index--) {
    let siftIdx = index - len;
    if (index < len) {
      swap(v, base, base + index);
      siftIdx = 0;
    }
    siftDown(v, base, Math.min(index, len), siftIdx, isLess);
  }
}

function siftDown(v: Value[], base: number, len: number, start: number, isLess: IsLess): void {
  let node = start;
  for (;;) {
    let child = 2 * node + 1;
    if (child >= len) break;
    if (child + 1 < len && isLess(v[base + child], v[base + child + 1])) child++;
    if (!isLess(v[base + node], v[base + child])) break;
    swap(v, base + node, base + child);
    node = child;
  }
}

/** Whether std sorts small slices of the element by sorting networks: `Copy` and no larger than a `u64`. */
function usesSortingNetwork(element: SortElement): boolean {
  return element.isCopy && element.size <= 8 && element.size * SMALL_SORT_NETWORK_SCRATCH_LEN <= MAX_STACK_ARRAY_SIZE;
}

function fitsGeneralScratch(element: SortElement): boolean {
  return element.size * SMALL_SORT_GENERAL_SCRATCH_LEN <= MAX_STACK_ARRAY_SIZE;
}

function smallSortThreshold(element: SortElement): number {
  return usesSortingNetwork(element) || fitsGeneralScratch(element)
    ? SMALL_SORT_GENERAL_THRESHOLD
    : SMALL_SORT_FALLBACK_THRESHOLD;
}

function smallSort(v: Value[], base: number, len: number, sorter: Sorter): void {
  if (usesSortingNetwork(sorter.element)) smallSortNetwork(v, base, len, sorter);
  else if (fitsGeneralScratch(sorter.element)) smallSortGeneral(v, base, len, sorter);
  else if (len >= 2) insertionSortShiftLeft(v, base, len, 1, sorter.isLess);
}

/** Sorts each half by a sorting network for its first 13 or 9 elements and insertion for the rest, then merges. */
function smallSortNetwork(v: Value[], base: number, len: number, sorter: Sorter): void {
  if (len < 2) return;
  const half = len >> 1;
  const noMerge = len < 18;
  const regions = noMerge
    ? [[base, len]]
    : [
        [base, half],
        [base + half, len - half],
      ];
  for (const [regionBase, regionLen] of regions) {
    let presortedLen = 1;
    if (regionLen >= 13) {
      sortingNetwork(v, regionBase, SORT13, sorter.isLess);
      presortedLen = 13;
    } else if (regionLen >= 9) {
      sortingNetwork(v, regionBase, SORT9, sorter.isLess);
      presortedLen = 9;
    }
    insertionSortShiftLeft(v, regionBase, regionLen, presortedLen, sorter.isLess);
  }
  if (noMerge) return;
  const merged: Value[] = [];
  bidirectionalMerge(v, base, len, { dst: merged, d: 0 }, sorter);
  for (let index = 0; index < len; index++) v[base + index] = merged[index];
}

/** The optimal sorting networks for 9 and 13 elements that std uses, as pairs to swap when out of order. */
const SORT9 = [
  [0, 3],
  [1, 7],
  [2, 5],
  [4, 8],
  [0, 7],
  [2, 4],
  [3, 8],
  [5, 6],
  [0, 2],
  [1, 3],
  [4, 5],
  [7, 8],
  [1, 4],
  [3, 6],
  [5, 7],
  [0, 1],
  [2, 4],
  [3, 5],
  [6, 8],
  [2, 3],
  [4, 5],
  [6, 7],
  [1, 2],
  [3, 4],
  [5, 6],
] as const;

const SORT13 = [
  [0, 12],
  [1, 10],
  [2, 9],
  [3, 7],
  [5, 11],
  [6, 8],
  [1, 6],
  [2, 3],
  [4, 11],
  [7, 9],
  [8, 10],
  [0, 4],
  [1, 2],
  [3, 6],
  [7, 8],
  [9, 10],
  [11, 12],
  [4, 6],
  [5, 9],
  [8, 11],
  [10, 12],
  [0, 5],
  [3, 8],
  [4, 7],
  [6, 11],
  [9, 10],
  [0, 1],
  [2, 5],
  [6, 9],
  [7, 8],
  [10, 11],
  [1, 3],
  [2, 4],
  [5, 6],
  [9, 10],
  [1, 2],
  [3, 4],
  [5, 7],
  [6, 8],
  [2, 3],
  [4, 5],
  [6, 7],
  [8, 9],
  [3, 4],
  [5, 6],
] as const;

function sortingNetwork(v: Value[], base: number, pairs: readonly (readonly [number, number])[], isLess: IsLess): void {
  for (const [a, b] of pairs) if (isLess(v[base + b], v[base + a])) swap(v, base + a, base + b);
}
