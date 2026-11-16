import type { Frame } from '../runtime';
import type { Value } from '../values';

/** The sort algorithms of `std.sort`: the stable ones (`block`, `insertion`) give one order, `heap` and `pdq` theirs. */
export type SortAlgorithm = 'stable' | 'heap' | 'pdq';

/**
 * Sorts values with a `lessThan` function. A stable sort's result is the one every stable algorithm gives, which is
 * that of Zig's block sort; `heap` and `pdq` are transcribed from Zig 0.17.1, so equal elements end in Zig's order.
 */
export function sortValues(
  values: Value[],
  lessThan: (a: Value, b: Value) => boolean,
  algorithm: SortAlgorithm,
  frame: Frame
): Value[] {
  if (algorithm === 'stable') return mergeSort(values, lessThan, frame);
  const items = [...values];
  const context: Context = {
    lessThan: (a, b) => {
      frame.runtime.spend();
      return lessThan(items[a], items[b]);
    },
    swap: (a, b) => {
      [items[a], items[b]] = [items[b], items[a]];
    },
  };
  if (algorithm === 'heap') heapContext(0, items.length, context);
  else pdqContext(0, items.length, context);
  return items;
}

function mergeSort(values: Value[], lessThan: (a: Value, b: Value) => boolean, frame: Frame): Value[] {
  if (values.length <= 1) return values;
  const middle = Math.floor(values.length / 2);
  const left = mergeSort(values.slice(0, middle), lessThan, frame);
  const right = mergeSort(values.slice(middle), lessThan, frame);
  const merged: Value[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    frame.runtime.spend();
    if (lessThan(right[j], left[i])) merged.push(right[j++]);
    else merged.push(left[i++]);
  }
  return [...merged, ...left.slice(i), ...right.slice(j)];
}

interface Context {
  lessThan: (a: number, b: number) => boolean;
  swap: (a: number, b: number) => void;
}

interface Range {
  a: number;
  b: number;
  limit: number;
  leftmost: boolean;
  balanced: boolean;
  partitioned: boolean;
}

const MAX_INSERTION = 24;

/** `std.sort.pdqContext`. */
function pdqContext(a: number, b: number, context: Context): void {
  const maxLimit = b > a ? Math.floor(Math.log2(b - a)) : 0;
  const stack: Range[] = [];
  let range: Range | undefined = { a, b, limit: maxLimit, leftmost: true, balanced: true, partitioned: true };
  while (range) {
    let sorted = false;
    while (!sorted) sorted = sortStep(range, a, stack, context);
    range = stack.pop();
  }
}

/**
 * One pass of pdqsort's inner loop over a range: true when the range is sorted, false after it narrows the range to
 * the smaller part of a partition, pushing the larger part onto the stack.
 */
// code-gauge-allow functionNcss 34 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function sortStep(range: Range, start: number, stack: Range[], context: Context): boolean {
  const length = range.b - range.a;
  if (length <= MAX_INSERTION) {
    if (range.leftmost) insertionContext(range.a, range.b, context);
    else unguardedInsertionContext(range.a, range.b, context);
    return true;
  }
  if (range.limit === 0) {
    heapContext(range.a, range.b, context);
    return true;
  }
  if (!range.balanced) {
    breakPatterns(range.a, range.b, context);
    range.limit--;
  }
  let { pivot, hint } = chosePivot(range.a, range.b, context);
  if (hint === 'decreasing') {
    reverseRange(range.a, range.b, context);
    pivot = range.b - 1 - (pivot - range.a);
    hint = 'increasing';
  }
  const presorted = range.balanced && range.partitioned && hint === 'increasing';
  if (presorted && partialInsertionSort(range.a, range.b, context)) return true;
  if (range.a > start && !context.lessThan(range.a - 1, pivot)) {
    range.a = partitionEqual(range.a, range.b, pivot, context);
    return false;
  }
  const { mid, wasPartitioned } = partition(range.a, range.b, pivot, context);
  const left: Range = { ...range, b: mid, balanced: true, partitioned: wasPartitioned };
  const right: Range = { ...range, a: mid + 1, leftmost: false, balanced: true, partitioned: wasPartitioned };
  const leftIsSmaller = mid - range.a < range.b - (mid + 1);
  const [smaller, larger] = leftIsSmaller ? [left, right] : [right, left];
  larger.balanced = smaller.b - smaller.a >= Math.floor(length / 8);
  stack.push(larger);
  Object.assign(range, smaller);
  return false;
}

function insertionContext(a: number, b: number, context: Context): void {
  for (let i = a + 1; i < b; i++) {
    for (let j = i; j > a && context.lessThan(j, j - 1); j--) context.swap(j, j - 1);
  }
}

function unguardedInsertionContext(a: number, b: number, context: Context): void {
  for (let i = a + 1; i < b; i++) {
    for (let j = i; context.lessThan(j, j - 1); j--) context.swap(j, j - 1);
  }
}

const BLOCK_SIZE = 64;

/** `partition`: the block partition of pdqsort, which moves the pivot to `mid`. */
function partition(a: number, b: number, pivot: number, context: Context): { mid: number; wasPartitioned: boolean } {
  context.swap(a, pivot);
  let i = a + 1;
  let j = b - 1;
  while (i <= j && context.lessThan(i, a)) i++;
  while (i <= j && !context.lessThan(j, a)) j--;
  if (i > j) {
    context.swap(j, a);
    return { mid: j, wasPartitioned: true };
  }
  context.swap(i, j);
  const mid = blockPartition(a, i + 1, j - 1, context);
  context.swap(mid, a);
  return { mid, wasPartitioned: false };
}

/** The block loop of `partition` over `i..=j`: the index where the pivot at `a` belongs. */
// code-gauge-allow functionNcss 46 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
// code-gauge-allow functionCognitiveComplexity 29 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function blockPartition(a: number, start: number, end: number, context: Context): number {
  let i = start;
  let j = end;
  const left = { offsets: [] as number[], base: i, count: 0, start: 0 };
  const right = { offsets: [] as number[], base: j, count: 0, start: 0 };
  while (i <= j) {
    const unknown = j + 1 - i;
    const leftSplit =
      left.count === 0 ? Math.min(BLOCK_SIZE, right.count === 0 ? Math.floor(unknown / 2) : unknown) : 0;
    const rightSplit = right.count === 0 ? Math.min(BLOCK_SIZE, unknown - leftSplit) : 0;
    for (let k = 0; k < leftSplit; k++) {
      left.offsets[left.count] = k;
      if (!context.lessThan(i + k, a)) left.count++;
    }
    i += leftSplit;
    for (let k = 0; k < rightSplit; k++) {
      right.offsets[right.count] = k;
      if (context.lessThan(j - k, a)) right.count++;
    }
    j -= rightSplit;
    const count = Math.min(left.count, right.count);
    for (let m = 0; m < count; m++) {
      context.swap(left.base + left.offsets[left.start + m], right.base - right.offsets[right.start + m]);
    }
    left.count -= count;
    right.count -= count;
    left.start += count;
    right.start += count;
    if (left.count === 0) [left.start, left.base] = [0, i];
    if (right.count === 0) [right.start, right.base] = [0, j];
  }
  if (left.count > 0) {
    while (left.count > 0) {
      left.count--;
      context.swap(left.base + left.offsets[left.start + left.count], j);
      j--;
    }
    return j;
  }
  if (right.count === 0) return j;
  while (right.count > 0) {
    right.count--;
    context.swap(right.base - right.offsets[right.start + right.count], i);
    i++;
  }
  return i - 1;
}

function partitionEqual(a: number, b: number, pivot: number, context: Context): number {
  context.swap(a, pivot);
  let i = a + 1;
  let j = b - 1;
  for (;;) {
    while (i <= j && !context.lessThan(a, i)) i++;
    while (i <= j && context.lessThan(a, j)) j--;
    if (i > j) break;
    context.swap(i, j);
    i++;
    j--;
  }
  return i;
}

// code-gauge-allow functionCognitiveComplexity 26 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function partialInsertionSort(a: number, b: number, context: Context): boolean {
  const maxSteps = 5;
  const shortestShifting = 50;
  let i = a + 1;
  for (let step = 0; step < maxSteps; step++) {
    while (i < b && !context.lessThan(i, i - 1)) i++;
    if (i === b) return true;
    if (b - a < shortestShifting) return false;
    context.swap(i, i - 1);
    if (i - a >= 2) {
      for (let j = i - 1; j > a; j--) {
        if (!context.lessThan(j, j - 1)) break;
        context.swap(j, j - 1);
      }
    }
    if (b - i >= 2) {
      for (let j = i + 1; j < b; j++) {
        if (!context.lessThan(j, j - 1)) break;
        context.swap(j, j - 1);
      }
    }
  }
  return false;
}

/** `breakPatterns`, which swaps a few elements chosen by an xorshift generator seeded with the length. */
function breakPatterns(a: number, b: number, context: Context): void {
  const length = b - a;
  if (length < 8) return;
  const mask = 0xff_ff_ff_ff_ff_ff_ff_ffn;
  let random = BigInt(length);
  let modulus = 1n;
  while (modulus < BigInt(length)) modulus <<= 1n;
  const middle = a + Math.floor(length / 4) * 2;
  for (let i = middle - 1; i <= middle + 1; i++) {
    random = (random ^ (random << 13n)) & mask;
    random ^= random >> 7n;
    random = (random ^ (random << 17n)) & mask;
    let other = Number(random & (modulus - 1n));
    if (other >= length) other -= length;
    context.swap(i, a + other);
  }
}

type Hint = 'increasing' | 'decreasing' | 'unknown';

function chosePivot(a: number, b: number, context: Context): { pivot: number; hint: Hint } {
  const shortestNinther = 50;
  const maxSwaps = 4 * 3;
  const length = b - a;
  const quarter = Math.floor(length / 4);
  const i = a + quarter;
  const j = a + quarter * 2;
  const k = a + quarter * 3;
  const swaps = { count: 0 };
  if (length >= 8) {
    if (length >= shortestNinther) {
      sort3(i - 1, i, i + 1, swaps, context);
      sort3(j - 1, j, j + 1, swaps, context);
      sort3(k - 1, k, k + 1, swaps, context);
    }
    sort3(i, j, k, swaps, context);
  }
  const hint: Hint = swaps.count === 0 ? 'increasing' : swaps.count === maxSwaps ? 'decreasing' : 'unknown';
  return { pivot: j, hint };
}

function sort3(a: number, b: number, c: number, swaps: { count: number }, context: Context): void {
  if (context.lessThan(b, a)) {
    swaps.count++;
    context.swap(b, a);
  }
  if (context.lessThan(c, b)) {
    swaps.count++;
    context.swap(c, b);
  }
  if (context.lessThan(b, a)) {
    swaps.count++;
    context.swap(b, a);
  }
}

function reverseRange(a: number, b: number, context: Context): void {
  for (let i = a, j = b - 1; i < j; i++, j--) context.swap(i, j);
}

/** `std.sort.heapContext`. */
function heapContext(a: number, b: number, context: Context): void {
  for (let i = a + Math.floor((b - a) / 2); i > a;) {
    i--;
    siftDown(a, i, b, context);
  }
  for (let i = b; i > a;) {
    i--;
    context.swap(a, i);
    siftDown(a, a, i, context);
  }
}

function siftDown(a: number, target: number, b: number, context: Context): void {
  let current = target;
  for (;;) {
    let child = (current - a) * 2 + a + 1;
    if (!(child < b)) break;
    const nextChild = child + 1;
    if (nextChild < b && context.lessThan(child, nextChild)) child = nextChild;
    if (context.lessThan(child, current)) break;
    context.swap(child, current);
    current = child;
  }
}
