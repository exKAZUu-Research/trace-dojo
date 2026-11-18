import type { Value } from '../../values';
import {
  choosePivot,
  findExistingRun,
  ilog2,
  insertionSortShiftLeft,
  type IsLess,
  MAX_LEN_ALWAYS_INSERTION_SORT,
  MAX_STACK_ARRAY_SIZE,
  SMALL_SORT_GENERAL_SCRATCH_LEN,
  SMALL_SORT_GENERAL_THRESHOLD,
  smallSortGeneral,
  type SortElement,
  type Sorter,
} from './shared';

/** `slice::sort` and its `_by` and `_by_key` forms, as std's `core::slice::sort::stable`: driftsort. */
export function stableSort(v: Value[], isLess: IsLess, element: SortElement, ordViolation: () => never): void {
  const len = v.length;
  if (element.size === 0 || len < 2) return;
  if (len <= MAX_LEN_ALWAYS_INSERTION_SORT) {
    insertionSortShiftLeft(v, 0, len, 1, isLess);
    return;
  }
  const maxFullAlloc = Math.floor(8_000_000 / element.size);
  const allocLen = Math.max(len - (len >> 1), Math.min(len, maxFullAlloc), SMALL_SORT_GENERAL_SCRATCH_LEN);
  const stackLen = Math.floor(MAX_STACK_ARRAY_SIZE / element.size);
  const scratch = Array.from<Value>({ length: stackLen >= allocLen ? stackLen : allocLen });
  const eagerSort = len <= SMALL_SORT_GENERAL_THRESHOLD * 2;
  driftSort(v, 0, len, eagerSort, { isLess, element, scratch, ordViolation });
}

interface Run {
  len: number;
  sorted: boolean;
}

/** Finds or makes runs and merges them as a merge tree whose depths `mergeTreeDepth` gives. */
function driftSort(v: Value[], base: number, len: number, eager: boolean, sorter: Sorter): void {
  if (len < 2) return;
  const scaleFactor = ((1n << 62n) + BigInt(len) - 1n) / BigInt(len);
  const minGoodRunLen = len <= 64 * 64 ? Math.min(len - (len >> 1), 64) : sqrtApprox(len);
  const stack: { run: Run; depth: number }[] = [];
  let scanIdx = 0;
  let prevRun: Run = { len: 0, sorted: true };
  for (;;) {
    const nextRun =
      scanIdx < len ? createRun(v, base + scanIdx, len - scanIdx, { minGoodRunLen, eager }, sorter) : undefined;
    const desiredDepth = nextRun
      ? mergeTreeDepth(scanIdx - prevRun.len, scanIdx, scanIdx + nextRun.len, scaleFactor)
      : 0;
    while (stack.length > 1 && (stack.at(-1) as { depth: number }).depth >= desiredDepth) {
      const left = (stack.pop() as { run: Run }).run;
      const mergedLen = left.len + prevRun.len;
      prevRun = logicalMerge(v, base + scanIdx - mergedLen, [left, prevRun], sorter);
    }
    stack.push({ run: prevRun, depth: desiredDepth });
    if (!nextRun) break;
    scanIdx += nextRun.len;
    prevRun = nextRun;
  }
  if (!prevRun.sorted) stableQuicksortWithLimit(v, base, len, sorter);
}

function mergeTreeDepth(left: number, mid: number, right: number, scaleFactor: bigint): number {
  const x = BigInt.asUintN(64, scaleFactor * BigInt(left + mid));
  const y = BigInt.asUintN(64, scaleFactor * BigInt(mid + right));
  const bits = x ^ y;
  return bits === 0n ? 64 : 64 - bits.toString(2).length;
}

function sqrtApprox(n: number): number {
  const shift = Math.ceil(ilog2(n | 1) / 2);
  return Math.floor((2 ** shift + Math.floor(n / 2 ** shift)) / 2);
}

/** Merges two adjacent runs, sorting either first if it is not, unless both are unsorted and fit the scratch. */
function logicalMerge(v: Value[], base: number, [left, right]: [Run, Run], sorter: Sorter): Run {
  const len = left.len + right.len;
  if (len <= sorter.scratch.length && !left.sorted && !right.sorted) return { len, sorted: false };
  if (!left.sorted) stableQuicksortWithLimit(v, base, left.len, sorter);
  if (!right.sorted) stableQuicksortWithLimit(v, base + left.len, right.len, sorter);
  merge(v, base, len, left.len, sorter);
  return { len, sorted: true };
}

function createRun(
  v: Value[],
  base: number,
  len: number,
  { minGoodRunLen, eager }: { minGoodRunLen: number; eager: boolean },
  sorter: Sorter
): Run {
  if (len >= minGoodRunLen) {
    const [runLen, wasReversed] = findExistingRun(v, base, len, sorter.isLess);
    if (runLen >= minGoodRunLen) {
      if (wasReversed) v.splice(base, runLen, ...v.slice(base, base + runLen).toReversed());
      return { len: runLen, sorted: true };
    }
  }
  if (!eager) return { len: Math.min(minGoodRunLen, len), sorted: false };
  const eagerRunLen = Math.min(SMALL_SORT_GENERAL_THRESHOLD, len);
  stableQuicksort(v, base, eagerRunLen, { limit: 0, ancestor: undefined }, sorter);
  return { len: eagerRunLen, sorted: true };
}

function stableQuicksortWithLimit(v: Value[], base: number, len: number, sorter: Sorter): void {
  stableQuicksort(v, base, len, { limit: 2 * ilog2(len | 1), ancestor: undefined }, sorter);
}

/** `stable::merge::merge`: merges `v[..mid]` and `v[mid..]`, saving the shorter run in the scratch. */
function merge(v: Value[], base: number, len: number, mid: number, sorter: Sorter): void {
  const { scratch } = sorter;
  if (mid === 0 || mid >= len || scratch.length < Math.min(mid, len - mid)) return;
  const leftIsShorter = mid <= len - mid;
  const saveBase = leftIsShorter ? base : base + mid;
  const saveLen = leftIsShorter ? mid : len - mid;
  for (let index = 0; index < saveLen; index++) scratch[index] = v[saveBase + index];
  const state = { start: 0, end: saveLen, dst: saveBase };
  if (leftIsShorter) mergeUp(v, base + mid, base + len, state, sorter);
  else mergeDown(v, base, base + len, state, sorter);
  // `MergeState`'s drop moves what remains of the saved run into place.
  for (let index = state.start; index < state.end; index++) v[state.dst + index - state.start] = scratch[index];
}

interface MergeState {
  start: number;
  end: number;
  dst: number;
}

/** Merges the saved left run with the right run in place, from the front. */
function mergeUp(v: Value[], rightStart: number, rightEnd: number, state: MergeState, sorter: Sorter): void {
  const { scratch, isLess } = sorter;
  let right = rightStart;
  while (state.start !== state.end && right !== rightEnd) {
    const consumeLeft = !isLess(v[right], scratch[state.start]);
    v[state.dst++] = consumeLeft ? scratch[state.start++] : v[right++];
  }
}

/** Merges the left run in place with the saved right run, from the back. */
function mergeDown(v: Value[], leftEnd: number, outEnd: number, state: MergeState, sorter: Sorter): void {
  const { scratch, isLess } = sorter;
  let out = outEnd;
  for (;;) {
    const left = state.dst - 1;
    const right = state.end - 1;
    out--;
    const consumeLeft = isLess(scratch[right], v[left]);
    v[out] = consumeLeft ? v[left] : scratch[right];
    state.dst = consumeLeft ? left : left + 1;
    state.end = consumeLeft ? right + 1 : right;
    if (state.dst === leftEnd || state.end === 0) return;
  }
}

/** The quicksort of the stable sort, which partitions through the scratch to keep equal elements in order. */
function stableQuicksort(
  v: Value[],
  start: number,
  length: number,
  initial: { limit: number; ancestor: { value: Value } | undefined },
  sorter: Sorter
): void {
  let base = start;
  let len = length;
  let { limit, ancestor } = initial;
  for (;;) {
    if (len <= SMALL_SORT_GENERAL_THRESHOLD) {
      smallSortGeneral(v, base, len, sorter);
      return;
    }
    if (limit === 0) {
      driftSort(v, base, len, true, sorter);
      return;
    }
    limit--;
    const pivotPos = choosePivot(v, base, len, sorter.isLess);
    const pivotCopy = v[base + pivotPos];
    let performEqualPartition = ancestor !== undefined && !sorter.isLess(ancestor.value, v[base + pivotPos]);
    let leftLen = 0;
    if (!performEqualPartition) {
      leftLen = stablePartition(v, { base, len, pivotPos, pivotGoesLeft: false }, sorter.isLess, sorter.scratch);
      performEqualPartition = leftLen === 0;
    }
    if (performEqualPartition) {
      const isLessOrEqual: IsLess = (a, b) => !sorter.isLess(b, a);
      const midEq = stablePartition(v, { base, len, pivotPos, pivotGoesLeft: true }, isLessOrEqual, sorter.scratch);
      base += midEq;
      len -= midEq;
      ancestor = undefined;
      continue;
    }
    stableQuicksort(v, base + leftLen, len - leftLen, { limit, ancestor: { value: pivotCopy } }, sorter);
    len = leftLen;
  }
}

/**
 * Moves the elements less than the pivot to the left and the rest to the right, each in their order, through the
 * scratch, where the right side fills from the end backwards; the pivot itself goes as `pivotGoesLeft` says.
 */
function stablePartition(
  v: Value[],
  { base, len, pivotPos, pivotGoesLeft }: { base: number; len: number; pivotPos: number; pivotGoesLeft: boolean },
  isLess: IsLess,
  scratch: Value[]
): number {
  const pivot = v[base + pivotPos];
  let numLeft = 0;
  for (let index = 0; index < len; index++) {
    const value = v[base + index];
    const towardsLeft = index === pivotPos ? pivotGoesLeft : isLess(value, pivot);
    scratch[(towardsLeft ? 0 : len - 1 - index) + numLeft] = value;
    if (towardsLeft) numLeft++;
  }
  for (let index = 0; index < numLeft; index++) v[base + index] = scratch[index];
  for (let index = 0; index < len - numLeft; index++) v[base + numLeft + index] = scratch[len - 1 - index];
  return numLeft;
}
