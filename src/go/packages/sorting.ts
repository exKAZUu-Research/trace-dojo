import { runToEnd, type Suspending } from '../runtime';

/**
 * Go's sorting algorithms, transcribed from sort/zsortfunc.go (Go 1.27): pattern-defeating quicksort for unstable
 * sorts and insertion sort with SymMerge for stable ones. Transcribing them, rather than using JavaScript's sort,
 * keeps the order of equal elements and the sequence of calls to Less and Swap as Go's.
 */
export interface SortData<R = boolean> {
  less(i: number, j: number): R;
  swap(i: number, j: number): void;
}

type ResumableSortData = SortData<boolean | Suspending<boolean>>;

const enum Hint {
  Unknown,
  Increasing,
  Decreasing,
}

export function pdqsort(data: SortData, length: number): void {
  runToEnd(resumeSort(data, length));
}

export function stableSort(data: SortData, length: number): void {
  runToEnd(resumeSort(data, length, true));
}

export function* resumeSort(data: ResumableSortData, length: number, stable = false): Suspending<void> {
  yield* stable ? stableSortFlow(data, length) : pdqsortFlow(data, length);
}

function* pdqsortFlow(data: ResumableSortData, length: number): Suspending<void> {
  if (length <= 1) return;
  yield* pdq(data, 0, length, bitLength(length));
}

function* stableSortFlow(data: ResumableSortData, length: number): Suspending<void> {
  let blockSize = 20;
  let a = 0;
  let b = blockSize;
  while (b <= length) {
    yield* insertionSort(data, a, b);
    a = b;
    b += blockSize;
  }
  yield* insertionSort(data, a, length);
  while (blockSize < length) {
    a = 0;
    b = 2 * blockSize;
    while (b <= length) {
      yield* symMerge(data, a, a + blockSize, b);
      a = b;
      b += 2 * blockSize;
    }
    const m = a + blockSize;
    if (m < length) yield* symMerge(data, a, m, length);
    blockSize *= 2;
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- A transcription of Go's pdqsort_func.
// code-gauge-allow functionNcss 41 -- Retains the Go sort algorithm and comparison order while comparisons can suspend.
function* pdq(data: ResumableSortData, start: number, end: number, depthLimit: number): Suspending<void> {
  const maxInsertion = 12;
  let a = start;
  let b = end;
  let limit = depthLimit;
  let wasBalanced = true;
  let wasPartitioned = true;
  for (;;) {
    const length = b - a;
    if (length <= maxInsertion) {
      yield* insertionSort(data, a, b);
      return;
    }
    if (limit === 0) {
      yield* heapSort(data, a, b);
      return;
    }
    if (!wasBalanced) {
      breakPatterns(data, a, b);
      limit--;
    }
    let [pivot, hint] = yield* choosePivot(data, a, b);
    if (hint === Hint.Decreasing) {
      reverseRange(data, a, b);
      pivot = b - 1 - (pivot - a);
      hint = Hint.Increasing;
    }
    if (wasBalanced && wasPartitioned && hint === Hint.Increasing && (yield* partialInsertionSort(data, a, b))) return;
    if (a > 0 && !(yield* lessAt(data, a - 1, pivot))) {
      a = yield* partitionEqual(data, a, b, pivot);
      continue;
    }
    const [mid, alreadyPartitioned] = yield* partition(data, a, b, pivot);
    wasPartitioned = alreadyPartitioned;
    const leftLength = mid - a;
    const rightLength = b - mid;
    const balanceThreshold = Math.floor(length / 8);
    if (leftLength < rightLength) {
      wasBalanced = leftLength >= balanceThreshold;
      yield* pdq(data, a, mid, limit);
      a = mid + 1;
    } else {
      wasBalanced = rightLength >= balanceThreshold;
      yield* pdq(data, mid + 1, b, limit);
      b = mid;
    }
  }
}

function* insertionSort(data: ResumableSortData, a: number, b: number): Suspending<void> {
  for (let i = a + 1; i < b; i++) {
    for (let j = i; j > a && (yield* lessAt(data, j, j - 1)); j--) data.swap(j, j - 1);
  }
}

function* heapSort(data: ResumableSortData, a: number, b: number): Suspending<void> {
  const first = a;
  const hi = b - a;
  for (let i = Math.floor((hi - 1) / 2); i >= 0; i--) yield* siftDown(data, i, hi, first);
  for (let i = hi - 1; i >= 0; i--) {
    data.swap(first, first + i);
    yield* siftDown(data, 0, i, first);
  }
}

function* siftDown(data: ResumableSortData, lo: number, hi: number, first: number): Suspending<void> {
  let root = lo;
  for (;;) {
    let child = 2 * root + 1;
    if (child >= hi) return;
    if (child + 1 < hi && (yield* lessAt(data, first + child, first + child + 1))) child++;
    if (!(yield* lessAt(data, first + root, first + child))) return;
    data.swap(first + root, first + child);
    root = child;
  }
}

function* partition(data: ResumableSortData, a: number, b: number, pivot: number): Suspending<[number, boolean]> {
  data.swap(a, pivot);
  let i = a + 1;
  let j = b - 1;
  while (i <= j && (yield* lessAt(data, i, a))) i++;
  while (i <= j && !(yield* lessAt(data, j, a))) j--;
  if (i > j) {
    data.swap(j, a);
    return [j, true];
  }
  data.swap(i, j);
  i++;
  j--;
  for (;;) {
    while (i <= j && (yield* lessAt(data, i, a))) i++;
    while (i <= j && !(yield* lessAt(data, j, a))) j--;
    if (i > j) break;
    data.swap(i, j);
    i++;
    j--;
  }
  data.swap(j, a);
  return [j, false];
}

function* partitionEqual(data: ResumableSortData, a: number, b: number, pivot: number): Suspending<number> {
  data.swap(a, pivot);
  let i = a + 1;
  let j = b - 1;
  for (;;) {
    while (i <= j && !(yield* lessAt(data, a, i))) i++;
    while (i <= j && (yield* lessAt(data, a, j))) j--;
    if (i > j) break;
    data.swap(i, j);
    i++;
    j--;
  }
  return i;
}

// code-gauge-allow functionCognitiveComplexity 26 -- Retains the Go sort algorithm and comparison order while comparisons can suspend.
function* partialInsertionSort(data: ResumableSortData, a: number, b: number): Suspending<boolean> {
  const maxSteps = 5;
  const shortestShifting = 50;
  let i = a + 1;
  for (let step = 0; step < maxSteps; step++) {
    while (i < b && !(yield* lessAt(data, i, i - 1))) i++;
    if (i === b) return true;
    if (b - a < shortestShifting) return false;
    data.swap(i, i - 1);
    if (i - a >= 2) {
      for (let j = i - 1; j >= 1; j--) {
        if (!(yield* lessAt(data, j, j - 1))) break;
        data.swap(j, j - 1);
      }
    }
    if (b - i >= 2) {
      for (let j = i + 1; j < b; j++) {
        if (!(yield* lessAt(data, j, j - 1))) break;
        data.swap(j, j - 1);
      }
    }
  }
  return false;
}

function breakPatterns(data: ResumableSortData, a: number, b: number): void {
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

export function bitLength(value: number): number {
  return value === 0 ? 0 : Math.floor(Math.log2(value)) + 1;
}

function* choosePivot(data: ResumableSortData, a: number, b: number): Suspending<[number, Hint]> {
  const shortestNinther = 50;
  const maxSwaps = 4 * 3;
  const length = b - a;
  const swaps = { count: 0 };
  let i = a + Math.floor(length / 4);
  let j = a + Math.floor(length / 4) * 2;
  let k = a + Math.floor(length / 4) * 3;
  if (length >= 8) {
    if (length >= shortestNinther) {
      i = yield* median(data, i - 1, i, i + 1, swaps);
      j = yield* median(data, j - 1, j, j + 1, swaps);
      k = yield* median(data, k - 1, k, k + 1, swaps);
    }
    j = yield* median(data, i, j, k, swaps);
  }
  if (swaps.count === 0) return [j, Hint.Increasing];
  if (swaps.count === maxSwaps) return [j, Hint.Decreasing];
  return [j, Hint.Unknown];
}

function* median(
  data: ResumableSortData,
  first: number,
  second: number,
  third: number,
  swaps: { count: number }
): Suspending<number> {
  let [a, b] = yield* order2(data, first, second, swaps);
  let c: number;
  [b, c] = yield* order2(data, b, third, swaps);
  void c;
  [a, b] = yield* order2(data, a, b, swaps);
  void a;
  return b;
}

function* order2(
  data: ResumableSortData,
  a: number,
  b: number,
  swaps: { count: number }
): Suspending<[number, number]> {
  if (yield* lessAt(data, b, a)) {
    swaps.count++;
    return [b, a];
  }
  return [a, b];
}

function reverseRange(data: ResumableSortData, a: number, b: number): void {
  for (let i = a, j = b - 1; i < j; i++, j--) data.swap(i, j);
}

// code-gauge-allow functionCognitiveComplexity 30 -- Retains the Go sort algorithm and comparison order while comparisons can suspend.
// code-gauge-allow functionNcss 49 -- Retains the Go sort algorithm and comparison order while comparisons can suspend.
function* symMerge(data: ResumableSortData, a: number, m: number, b: number): Suspending<void> {
  if (m - a === 1) {
    let i = m;
    let j = b;
    while (i < j) {
      const h = (i + j) >>> 1;
      if (yield* lessAt(data, h, a)) i = h + 1;
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
      if (!(yield* lessAt(data, m, h))) i = h + 1;
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
    if (!(yield* lessAt(data, p - c, c))) start = c + 1;
    else r = c;
  }
  const end = n - start;
  if (start < m && m < end) rotate(data, start, m, end);
  if (a < start && start < mid) yield* symMerge(data, a, start, mid);
  if (mid < end && end < b) yield* symMerge(data, mid, end, b);
}

function rotate(data: ResumableSortData, a: number, m: number, b: number): void {
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

function swapRange(data: ResumableSortData, a: number, b: number, count: number): void {
  for (let i = 0; i < count; i++) data.swap(a + i, b + i);
}

function* lessAt(data: ResumableSortData, i: number, j: number): Suspending<boolean> {
  const result = data.less(i, j);
  return typeof result === 'boolean' ? result : yield* result;
}
