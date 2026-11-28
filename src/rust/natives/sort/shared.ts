import type { Value } from '../../values';

// What std's `core::slice::sort::shared` gives both sorts: the small sorts, the pivot choice, and the search for an
// existing run, step by step, so that a comparison function sees the calls rustc's makes. Every type the interpreter
// has is `Freeze`, which picks the small sorts std uses for such types.

export type IsLess = (a: Value, b: Value) => boolean;

/** What std's sorts specialize on: the element's size in bytes and whether it is `Copy`. */
export interface SortElement {
  size: number;
  isCopy: boolean;
}

export interface Sorter {
  isLess: IsLess;
  element: SortElement;
  scratch: Value[];
  /** `panic_on_ord_violation`, when the comparisons contradict each other. */
  ordViolation: () => never;
}

export const MAX_LEN_ALWAYS_INSERTION_SORT = 20;
export const SMALL_SORT_FALLBACK_THRESHOLD = 16;
export const SMALL_SORT_GENERAL_THRESHOLD = 32;
export const SMALL_SORT_GENERAL_SCRATCH_LEN = SMALL_SORT_GENERAL_THRESHOLD + 16;
export const MAX_STACK_ARRAY_SIZE = 4096;
const PSEUDO_MEDIAN_REC_THRESHOLD = 64;

export function findExistingRun(v: Value[], base: number, len: number, isLess: IsLess): [number, boolean] {
  if (len < 2) return [len, false];
  let runLen = 2;
  const strictlyDescending = isLess(v[base + 1], v[base]);
  if (strictlyDescending) {
    while (runLen < len && isLess(v[base + runLen], v[base + runLen - 1])) runLen++;
  } else {
    while (runLen < len && !isLess(v[base + runLen], v[base + runLen - 1])) runLen++;
  }
  return [runLen, strictlyDescending];
}

/** The median of three, or of three medians of three for long slices, at positions spread over the slice. */
export function choosePivot(v: Value[], base: number, len: number, isLess: IsLess): number {
  const lenDiv8 = Math.floor(len / 8);
  const a = base;
  const b = base + lenDiv8 * 4;
  const c = base + lenDiv8 * 7;
  const pivot =
    len < PSEUDO_MEDIAN_REC_THRESHOLD ? median3(v, [a, b, c], isLess) : median3Rec(v, [a, b, c], lenDiv8, isLess);
  return pivot - base;
}

function median3Rec(v: Value[], [a, b, c]: [number, number, number], n: number, isLess: IsLess): number {
  if (n * 8 < PSEUDO_MEDIAN_REC_THRESHOLD) return median3(v, [a, b, c], isLess);
  const n8 = Math.floor(n / 8);
  const medianFrom = (start: number): number => median3Rec(v, [start, start + n8 * 4, start + n8 * 7], n8, isLess);
  const ma = medianFrom(a);
  const mb = medianFrom(b);
  const mc = medianFrom(c);
  return median3(v, [ma, mb, mc], isLess);
}

function median3(v: Value[], [a, b, c]: [number, number, number], isLess: IsLess): number {
  const x = isLess(v[a], v[b]);
  const y = isLess(v[a], v[c]);
  if (x !== y) return a;
  const z = isLess(v[b], v[c]);
  return z !== x ? c : b;
}

export function insertionSortShiftLeft(v: Value[], base: number, len: number, offset: number, isLess: IsLess): void {
  for (let tail = base + offset; tail < base + len; tail++) insertTail(v, base, tail, isLess);
}

function insertTail(v: Value[], begin: number, tail: number, isLess: IsLess): void {
  let sift = tail - 1;
  if (!isLess(v[tail], v[sift])) return;
  const tmp = v[tail];
  let gap = tail;
  for (;;) {
    v[gap] = v[sift];
    gap = sift;
    if (sift === begin) break;
    sift--;
    if (!isLess(tmp, v[sift])) break;
  }
  v[gap] = tmp;
}

/**
 * Sorts each half of `v[base..base + len]` into the scratch, eight or four elements by fixed comparisons and the rest by
 * insertion, and merges the halves back.
 */
export function smallSortGeneral(v: Value[], base: number, len: number, sorter: Sorter): void {
  if (len < 2) return;
  const { isLess, scratch } = sorter;
  const half = len >> 1;
  let presortedLen = 1;
  if (sorter.element.size <= 16 && len >= 16) {
    sort8Stable(v, base, 0, len, sorter);
    sort8Stable(v, base + half, half, len + 8, sorter);
    presortedLen = 8;
  } else if (len >= 8) {
    sort4Stable(v, base, scratch, 0, isLess);
    sort4Stable(v, base + half, scratch, half, isLess);
    presortedLen = 4;
  } else {
    scratch[0] = v[base];
    scratch[half] = v[base + half];
  }
  for (const offset of [0, half]) {
    const desiredLen = offset === 0 ? half : len - half;
    for (let index = presortedLen; index < desiredLen; index++) {
      scratch[offset + index] = v[base + offset + index];
      insertTail(scratch, offset, offset + index, isLess);
    }
  }
  bidirectionalMerge(scratch, 0, len, { dst: v, d: base }, sorter);
}

function sort4Stable(src: Value[], s: number, dst: Value[], d: number, isLess: IsLess): void {
  const c1 = isLess(src[s + 1], src[s]);
  const c2 = isLess(src[s + 3], src[s + 2]);
  const a = s + Number(c1);
  const b = s + Number(!c1);
  const c = s + 2 + Number(c2);
  const e = s + 2 + Number(!c2);
  const c3 = isLess(src[c], src[a]);
  const c4 = isLess(src[e], src[b]);
  const min = c3 ? c : a;
  const max = c4 ? b : e;
  const unknownLeft = c3 ? a : c4 ? c : b;
  const unknownRight = c4 ? e : c3 ? b : c;
  const c5 = isLess(src[unknownRight], src[unknownLeft]);
  dst[d] = src[min];
  dst[d + 1] = src[c5 ? unknownRight : unknownLeft];
  dst[d + 2] = src[c5 ? unknownLeft : unknownRight];
  dst[d + 3] = src[max];
}

/** Sorts eight elements of `src` into the scratch at `d`, through the scratch at `t`. */
function sort8Stable(src: Value[], s: number, d: number, t: number, sorter: Sorter): void {
  const { scratch } = sorter;
  sort4Stable(src, s, scratch, t, sorter.isLess);
  sort4Stable(src, s + 4, scratch, t + 4, sorter.isLess);
  bidirectionalMerge(scratch, t, 8, { dst: scratch, d }, sorter);
}

/** Merges the two sorted halves of `src[s..s + len]` into `dst` at `d`, from both ends at once. */
export function bidirectionalMerge(
  src: Value[],
  s: number,
  len: number,
  { dst, d }: { dst: Value[]; d: number },
  sorter: Sorter
): void {
  const { isLess } = sorter;
  const half = len >> 1;
  let left = s;
  let right = s + half;
  let out = d;
  let leftRev = s + half - 1;
  let rightRev = s + len - 1;
  let outRev = d + len - 1;
  const inBounds = (...indexes: number[]): boolean => indexes.every((index) => index >= s && index < s + len);
  for (let step = 0; step < half; step++) {
    if (!inBounds(left, right, leftRev, rightRev)) sorter.ordViolation();
    const takeLeft = !isLess(src[right], src[left]);
    dst[out++] = takeLeft ? src[left++] : src[right++];
    const takeRight = !isLess(src[rightRev], src[leftRev]);
    dst[outRev--] = takeRight ? src[rightRev--] : src[leftRev--];
  }
  if (len % 2 !== 0) {
    const leftNonempty = left <= leftRev;
    dst[out] = leftNonempty ? src[left++] : src[right++];
  }
  if (left !== leftRev + 1 || right !== rightRev + 1) sorter.ordViolation();
}

export function swap(v: Value[], a: number, b: number): void {
  [v[a], v[b]] = [v[b], v[a]];
}

export function ilog2(n: number): number {
  return 31 - Math.clz32(n);
}
