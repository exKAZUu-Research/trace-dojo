/**
 * Go's sorting algorithms, transcribed from sort/zsortfunc.go (Go 1.27): pattern-defeating quicksort for unstable
 * sorts and insertion sort with SymMerge for stable ones. Transcribing them, rather than using JavaScript's sort,
 * keeps the order of equal elements and the sequence of calls to Less and Swap as Go's.
 */
export interface SortData {
  less(i: number, j: number): boolean;
  swap(i: number, j: number): void;
}

const enum Hint {
  Unknown,
  Increasing,
  Decreasing,
}

/** The unstable sort of `sort.Sort`, `sort.Slice`, and `slices.Sort`. */
export function pdqsort(data: SortData, length: number): void {
  if (length <= 1) return;
  pdq(data, 0, length, bitLength(length));
}

/** The stable sort of `sort.Stable`, `sort.SliceStable`, and `slices.SortStableFunc`. */
export function stableSort(data: SortData, length: number): void {
  let blockSize = 20;
  let a = 0;
  let b = blockSize;
  while (b <= length) {
    insertionSort(data, a, b);
    a = b;
    b += blockSize;
  }
  insertionSort(data, a, length);
  while (blockSize < length) {
    a = 0;
    b = 2 * blockSize;
    while (b <= length) {
      symMerge(data, a, a + blockSize, b);
      a = b;
      b += 2 * blockSize;
    }
    const m = a + blockSize;
    if (m < length) symMerge(data, a, m, length);
    blockSize *= 2;
  }
}

export function bitLength(value: number): number {
  return value === 0 ? 0 : Math.floor(Math.log2(value)) + 1;
}

function insertionSort(data: SortData, a: number, b: number): void {
  for (let i = a + 1; i < b; i++) {
    for (let j = i; j > a && data.less(j, j - 1); j--) data.swap(j, j - 1);
  }
}

function siftDown(data: SortData, lo: number, hi: number, first: number): void {
  let root = lo;
  for (;;) {
    let child = 2 * root + 1;
    if (child >= hi) return;
    if (child + 1 < hi && data.less(first + child, first + child + 1)) child++;
    if (!data.less(first + root, first + child)) return;
    data.swap(first + root, first + child);
    root = child;
  }
}

function heapSort(data: SortData, a: number, b: number): void {
  const first = a;
  const hi = b - a;
  for (let i = Math.floor((hi - 1) / 2); i >= 0; i--) siftDown(data, i, hi, first);
  for (let i = hi - 1; i >= 0; i--) {
    data.swap(first, first + i);
    siftDown(data, 0, i, first);
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- A transcription of Go's pdqsort_func.
function pdq(data: SortData, start: number, end: number, depthLimit: number): void {
  const maxInsertion = 12;
  let a = start;
  let b = end;
  let limit = depthLimit;
  let wasBalanced = true;
  let wasPartitioned = true;
  for (;;) {
    const length = b - a;
    if (length <= maxInsertion) {
      insertionSort(data, a, b);
      return;
    }
    if (limit === 0) {
      heapSort(data, a, b);
      return;
    }
    if (!wasBalanced) {
      breakPatterns(data, a, b);
      limit--;
    }
    let [pivot, hint] = choosePivot(data, a, b);
    if (hint === Hint.Decreasing) {
      reverseRange(data, a, b);
      pivot = b - 1 - (pivot - a);
      hint = Hint.Increasing;
    }
    if (wasBalanced && wasPartitioned && hint === Hint.Increasing && partialInsertionSort(data, a, b)) return;
    if (a > 0 && !data.less(a - 1, pivot)) {
      a = partitionEqual(data, a, b, pivot);
      continue;
    }
    const [mid, alreadyPartitioned] = partition(data, a, b, pivot);
    wasPartitioned = alreadyPartitioned;
    const leftLength = mid - a;
    const rightLength = b - mid;
    const balanceThreshold = Math.floor(length / 8);
    if (leftLength < rightLength) {
      wasBalanced = leftLength >= balanceThreshold;
      pdq(data, a, mid, limit);
      a = mid + 1;
    } else {
      wasBalanced = rightLength >= balanceThreshold;
      pdq(data, mid + 1, b, limit);
      b = mid;
    }
  }
}

function partition(data: SortData, a: number, b: number, pivot: number): [number, boolean] {
  data.swap(a, pivot);
  let i = a + 1;
  let j = b - 1;
  while (i <= j && data.less(i, a)) i++;
  while (i <= j && !data.less(j, a)) j--;
  if (i > j) {
    data.swap(j, a);
    return [j, true];
  }
  data.swap(i, j);
  i++;
  j--;
  for (;;) {
    while (i <= j && data.less(i, a)) i++;
    while (i <= j && !data.less(j, a)) j--;
    if (i > j) break;
    data.swap(i, j);
    i++;
    j--;
  }
  data.swap(j, a);
  return [j, false];
}

function partitionEqual(data: SortData, a: number, b: number, pivot: number): number {
  data.swap(a, pivot);
  let i = a + 1;
  let j = b - 1;
  for (;;) {
    while (i <= j && !data.less(a, i)) i++;
    while (i <= j && data.less(a, j)) j--;
    if (i > j) break;
    data.swap(i, j);
    i++;
    j--;
  }
  return i;
}

// code-gauge-allow functionCognitiveComplexity 20 -- A transcription of Go's partialInsertionSort_func.
function partialInsertionSort(data: SortData, a: number, b: number): boolean {
  const maxSteps = 5;
  const shortestShifting = 50;
  let i = a + 1;
  for (let step = 0; step < maxSteps; step++) {
    while (i < b && !data.less(i, i - 1)) i++;
    if (i === b) return true;
    if (b - a < shortestShifting) return false;
    data.swap(i, i - 1);
    if (i - a >= 2) {
      for (let j = i - 1; j >= 1; j--) {
        if (!data.less(j, j - 1)) break;
        data.swap(j, j - 1);
      }
    }
    if (b - i >= 2) {
      for (let j = i + 1; j < b; j++) {
        if (!data.less(j, j - 1)) break;
        data.swap(j, j - 1);
      }
    }
  }
  return false;
}

function breakPatterns(data: SortData, a: number, b: number): void {
  const length = b - a;
  if (length < 8) return;
  let random = BigInt(length);
  const modulus = 1n << BigInt(bitLength(length));
  const mask = (1n << 64n) - 1n;
  for (let index = a + Math.floor(length / 4) * 2 - 1; index <= a + Math.floor(length / 4) * 2 + 1; index++) {
    random ^= (random << 13n) & mask;
    random ^= random >> 7n;
    random ^= (random << 17n) & mask;
    let other = Number(random & (modulus - 1n));
    if (other >= length) other -= length;
    data.swap(index, a + other);
  }
}

function choosePivot(data: SortData, a: number, b: number): [number, Hint] {
  const shortestNinther = 50;
  const maxSwaps = 4 * 3;
  const length = b - a;
  const swaps = { count: 0 };
  let i = a + Math.floor(length / 4);
  let j = a + Math.floor(length / 4) * 2;
  let k = a + Math.floor(length / 4) * 3;
  if (length >= 8) {
    if (length >= shortestNinther) {
      i = median(data, i - 1, i, i + 1, swaps);
      j = median(data, j - 1, j, j + 1, swaps);
      k = median(data, k - 1, k, k + 1, swaps);
    }
    j = median(data, i, j, k, swaps);
  }
  if (swaps.count === 0) return [j, Hint.Increasing];
  if (swaps.count === maxSwaps) return [j, Hint.Decreasing];
  return [j, Hint.Unknown];
}

function order2(data: SortData, a: number, b: number, swaps: { count: number }): [number, number] {
  if (data.less(b, a)) {
    swaps.count++;
    return [b, a];
  }
  return [a, b];
}

function median(data: SortData, first: number, second: number, third: number, swaps: { count: number }): number {
  let [a, b] = order2(data, first, second, swaps);
  let c: number;
  [b, c] = order2(data, b, third, swaps);
  void c;
  [a, b] = order2(data, a, b, swaps);
  void a;
  return b;
}

function reverseRange(data: SortData, a: number, b: number): void {
  for (let i = a, j = b - 1; i < j; i++, j--) data.swap(i, j);
}

function swapRange(data: SortData, a: number, b: number, count: number): void {
  for (let i = 0; i < count; i++) data.swap(a + i, b + i);
}

// code-gauge-allow functionCognitiveComplexity 20 -- A transcription of Go's symMerge_func.
function symMerge(data: SortData, a: number, m: number, b: number): void {
  if (m - a === 1) {
    let i = m;
    let j = b;
    while (i < j) {
      const h = (i + j) >>> 1;
      if (data.less(h, a)) i = h + 1;
      else j = h;
    }
    for (let k = a; k < i - 1; k++) data.swap(k, k + 1);
    return;
  }
  if (b - m === 1) {
    let i = a;
    let j = m;
    while (i < j) {
      const h = (i + j) >>> 1;
      if (!data.less(m, h)) i = h + 1;
      else j = h;
    }
    for (let k = m; k > i; k--) data.swap(k, k - 1);
    return;
  }
  const mid = (a + b) >>> 1;
  const n = mid + m;
  let start: number;
  let r: number;
  if (m > mid) {
    start = n - b;
    r = mid;
  } else {
    start = a;
    r = m;
  }
  const p = n - 1;
  while (start < r) {
    const c = (start + r) >>> 1;
    if (!data.less(p - c, c)) start = c + 1;
    else r = c;
  }
  const end = n - start;
  if (start < m && m < end) rotate(data, start, m, end);
  if (a < start && start < mid) symMerge(data, a, start, mid);
  if (mid < end && end < b) symMerge(data, mid, end, b);
}

function rotate(data: SortData, a: number, m: number, b: number): void {
  let i = m - a;
  let j = b - m;
  while (i !== j) {
    if (i > j) {
      swapRange(data, m - i, m, j);
      i -= j;
    } else {
      swapRange(data, m - i, m + j - i, i);
      j -= i;
    }
  }
  swapRange(data, m - i, m, i);
}
