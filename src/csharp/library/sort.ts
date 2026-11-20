/**
 * .NET's `ArraySortHelper<T>.IntrospectiveSort` (introsort with insertion sort for small partitions and heapsort past
 * the depth limit), transcribed so that equal elements end up in .NET's order and comparers run in its sequence.
 */
export function introSort<T>(keys: T[], start: number, length: number, compare: (a: T, b: T) => number): void {
  if (length < 2) return;
  introSortRange(keys, start, length, 2 * (Math.floor(Math.log2(length)) + 1), compare);
}

const INTROSORT_SIZE_THRESHOLD = 16;

function introSortRange<T>(
  keys: T[],
  offset: number,
  length: number,
  depthLimit: number,
  compare: (a: T, b: T) => number
): void {
  let partitionSize = length;
  let limit = depthLimit;
  while (partitionSize > 1) {
    if (partitionSize <= INTROSORT_SIZE_THRESHOLD) {
      if (partitionSize === 2) {
        swapIfGreater(keys, compare, offset, offset + 1);
        return;
      }
      if (partitionSize === 3) {
        swapIfGreater(keys, compare, offset, offset + 1);
        swapIfGreater(keys, compare, offset, offset + 2);
        swapIfGreater(keys, compare, offset + 1, offset + 2);
        return;
      }
      insertionSort(keys, offset, partitionSize, compare);
      return;
    }
    if (limit === 0) {
      heapSort(keys, offset, partitionSize, compare);
      return;
    }
    limit--;
    const pivot = pickPivotAndPartition(keys, offset, partitionSize, compare);
    introSortRange(keys, offset + pivot + 1, partitionSize - (pivot + 1), limit, compare);
    partitionSize = pivot;
  }
}

function swapIfGreater<T>(keys: T[], compare: (a: T, b: T) => number, i: number, j: number): void {
  if (compare(keys[i], keys[j]) > 0) {
    const temporary = keys[i];
    keys[i] = keys[j];
    keys[j] = temporary;
  }
}

function swap<T>(keys: T[], i: number, j: number): void {
  const temporary = keys[i];
  keys[i] = keys[j];
  keys[j] = temporary;
}

function pickPivotAndPartition<T>(keys: T[], offset: number, length: number, compare: (a: T, b: T) => number): number {
  const hi = length - 1;
  const middle = hi >> 1;
  swapIfGreater(keys, compare, offset, offset + middle);
  swapIfGreater(keys, compare, offset, offset + hi);
  swapIfGreater(keys, compare, offset + middle, offset + hi);
  const pivot = keys[offset + middle];
  swap(keys, offset + middle, offset + hi - 1);
  let left = 0;
  let right = hi - 1;
  while (left < right) {
    while (compare(keys[offset + ++left], pivot) < 0) {
      // Advance while the element is less than the pivot.
    }
    while (compare(pivot, keys[offset + --right]) < 0) {
      // Retreat while the pivot is less than the element.
    }
    if (left >= right) break;
    swap(keys, offset + left, offset + right);
  }
  if (left !== hi - 1) swap(keys, offset + left, offset + hi - 1);
  return left;
}

function heapSort<T>(keys: T[], offset: number, length: number, compare: (a: T, b: T) => number): void {
  for (let i = length >> 1; i >= 1; i--) downHeap(keys, offset, i, length, compare);
  for (let i = length; i > 1; i--) {
    swap(keys, offset, offset + i - 1);
    downHeap(keys, offset, 1, i - 1, compare);
  }
}

function downHeap<T>(keys: T[], offset: number, start: number, length: number, compare: (a: T, b: T) => number): void {
  let i = start;
  const d = keys[offset + i - 1];
  while (i <= length >> 1) {
    let child = 2 * i;
    if (child < length && compare(keys[offset + child - 1], keys[offset + child]) < 0) child++;
    if (!(compare(d, keys[offset + child - 1]) < 0)) break;
    keys[offset + i - 1] = keys[offset + child - 1];
    i = child;
  }
  keys[offset + i - 1] = d;
}

function insertionSort<T>(keys: T[], offset: number, length: number, compare: (a: T, b: T) => number): void {
  for (let i = 0; i < length - 1; i++) {
    const t = keys[offset + i + 1];
    let j = i;
    while (j >= 0 && compare(t, keys[offset + j]) < 0) {
      keys[offset + j + 1] = keys[offset + j];
      j--;
    }
    keys[offset + j + 1] = t;
  }
}

/**
 * `Enumerable.OrderBy`'s sort: introsort over the elements' positions, comparing their keys and then the positions, which
 * makes it stable, as .NET's `EnumerableSorter` sorts its map of indices.
 */
export function stableSort<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  const map = items.map((_item, index) => index);
  introSort(map, 0, map.length, (a, b) => compare(items[a], items[b]) || a - b);
  return map.map((index) => items[index]);
}
