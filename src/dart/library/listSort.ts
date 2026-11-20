import type { Value } from '../values';

export interface ListSortAccess {
  length: number;
  read(position: number): Value;
  write(position: number, value: Value): void;
}

/**
 * Dart's sort: insertion sort for up to 32 elements, which is stable, and otherwise the dual-pivot quicksort of
 * dart:_internal, whose order of equal elements programs may see.
 */
export function dartSort(values: ListSortAccess, compare: (a: Value, b: Value) => number): void {
  doSort(values, 0, values.length - 1, compare);
}

const INSERTION_SORT_THRESHOLD = 32;

function doSort(a: ListSortAccess, left: number, right: number, compare: (a: Value, b: Value) => number): void {
  if (right - left <= INSERTION_SORT_THRESHOLD) insertionSort(a, left, right, compare);
  else dualPivotQuicksort(a, left, right, compare);
}

function insertionSort(a: ListSortAccess, left: number, right: number, compare: (a: Value, b: Value) => number): void {
  for (let i = left + 1; i <= right; i++) {
    const element = a.read(i);
    let j = i;
    while (j > left && compare(a.read(j - 1), element) > 0) {
      a.write(j, a.read(j - 1));
      j--;
    }
    a.write(j, element);
  }
}

type Compare = (a: Value, b: Value) => number;

/** A transcription of dart:_internal's _dualPivotQuicksort, whose order of ties and of comparisons programs see. */
function dualPivotQuicksort(a: ListSortAccess, left: number, right: number, compare: Compare): void {
  const { pivot1, pivot2, index1, index5 } = choosePivots(a, left, right, compare);
  let less = left + 1;
  let great = right - 1;
  const pivotsAreEqual = compare(pivot1, pivot2) === 0;
  ({ less, great } = pivotsAreEqual
    ? partitionAroundPivot(a, less, great, pivot1, compare)
    : partitionThree(
        a,
        less,
        great,
        pivot1,
        (value) => compare(value, pivot1) < 0,
        (value) => compare(value, pivot2) > 0,
        compare
      ));
  a.write(left, a.read(less - 1));
  a.write(less - 1, pivot1);
  a.write(right, a.read(great + 1));
  a.write(great + 1, pivot2);
  doSort(a, left, less - 2, compare);
  doSort(a, great + 2, right, compare);
  if (pivotsAreEqual) return;
  if (less < index1 && great > index5) {
    while (compare(a.read(less), pivot1) === 0) less++;
    while (compare(a.read(great), pivot2) === 0) great--;
    ({ less, great } = partitionThree(
      a,
      less,
      great,
      pivot1,
      (value) => compare(value, pivot1) === 0,
      (value) => compare(value, pivot2) === 0,
      compare
    ));
  }
  doSort(a, less, great, compare);
}

/** Sorts five sample elements with a sorting network and takes the second and fourth as the pivots. */
function choosePivots(
  a: ListSortAccess,
  left: number,
  right: number,
  compare: Compare
): { pivot1: Value; pivot2: Value; index1: number; index5: number } {
  const sixth = Math.trunc((right - left + 1) / 6);
  const index1 = left + sixth;
  const index5 = right - sixth;
  const index3 = Math.trunc((left + right) / 2);
  const index2 = index3 - sixth;
  const index4 = index3 + sixth;
  const el = [a.read(index1), a.read(index2), a.read(index3), a.read(index4), a.read(index5)];
  for (const [x, y] of [
    [0, 1],
    [3, 4],
    [0, 2],
    [1, 2],
    [0, 3],
    [2, 3],
    [1, 4],
    [1, 2],
    [3, 4],
  ] as const) {
    if (compare(el[x], el[y]) > 0) [el[x], el[y]] = [el[y], el[x]];
  }
  a.write(index1, el[0]);
  a.write(index3, el[2]);
  a.write(index5, el[4]);
  a.write(index2, a.read(left));
  a.write(index4, a.read(right));
  return { pivot1: el[1], pivot2: el[3], index1, index5 };
}

/** Moves the elements less than the pivot to the left and the greater ones to the right, keeping equal ones between. */
// code-gauge-allow functionCognitiveComplexity 17 -- A transcription of dart:_internal's dual-pivot quicksort, whose comparisons programs see.
function partitionAroundPivot(
  a: ListSortAccess,
  start: number,
  end: number,
  pivot: Value,
  compare: Compare
): { less: number; great: number } {
  let less = start;
  let great = end;
  for (let k = less; k <= great; k++) {
    const ak = a.read(k);
    const comp = compare(ak, pivot);
    if (comp === 0) continue;
    if (comp < 0) {
      if (k !== less) {
        a.write(k, a.read(less));
        a.write(less, ak);
      }
      less++;
      continue;
    }
    for (;;) {
      const greatComp = compare(a.read(great), pivot);
      if (greatComp > 0) {
        great--;
        continue;
      }
      if (greatComp < 0) {
        a.write(k, a.read(less));
        a.write(less++, a.read(great));
      } else {
        a.write(k, a.read(great));
      }
      a.write(great--, ak);
      break;
    }
  }
  return { less, great };
}

/** Moves the elements that belong left to the left and those that belong right to the right. */
// code-gauge-allow functionCognitiveComplexity 21 -- A transcription of dart:_internal's dual-pivot quicksort, whose comparisons programs see.
// code-gauge-allow functionParameterCount 7 -- The parameters are the parts a caller already holds; grouping them would only rename them.
function partitionThree(
  a: ListSortAccess,
  start: number,
  end: number,
  pivot1: Value,
  belongsLeft: (value: Value) => boolean,
  belongsRight: (value: Value) => boolean,
  compare: Compare
): { less: number; great: number } {
  let less = start;
  let great = end;
  for (let k = less; k <= great; k++) {
    const ak = a.read(k);
    if (belongsLeft(ak)) {
      if (k !== less) {
        a.write(k, a.read(less));
        a.write(less, ak);
      }
      less++;
      continue;
    }
    if (!belongsRight(ak)) continue;
    for (;;) {
      if (belongsRight(a.read(great))) {
        great--;
        if (great < k) break;
        continue;
      }
      if (compare(a.read(great), pivot1) < 0) {
        a.write(k, a.read(less));
        a.write(less++, a.read(great));
      } else {
        a.write(k, a.read(great));
      }
      a.write(great--, ak);
      break;
    }
  }
  return { less, great };
}
