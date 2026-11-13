// A transcription of the sort in CPython 3.14's Objects/listobject.c: which pairs `less` is asked about, in which
// order, and where the items are when `less` throws are all observable from Python, so every routine keeps the
// control flow of the C routine named in its JSDoc.

type Less<T> = (left: T, right: T) => boolean;

interface Run {
  base: number;
  length: number;
  power: number;
}

interface MergeState<T> {
  items: T[];
  less: Less<T>;
  pending: Run[];
  minGallop: number;
}

/** The positions a merge has reached: `pa` and `pb` index the next items of the two runs and `dest` where one goes. */
interface MergeCursor {
  dest: number;
  pa: number;
  pb: number;
  na: number;
  nb: number;
}

const MAX_MINRUN = 64;
const MIN_GALLOP = 7;

/**
 * `list_sort_impl`: sorts `items` in place and stably, asking only `less`. When `less` throws, `items` is left as
 * the permutation CPython leaves.
 */
export function timsort<T>(items: T[], less: Less<T>, reverse: boolean): void {
  if (items.length < 2) return;
  if (reverse) items.reverse();
  try {
    sortAscending({ items, less, pending: [], minGallop: MIN_GALLOP });
  } finally {
    if (reverse) items.reverse();
  }
}

function sortAscending<T>(ms: MergeState<T>): void {
  let remaining = ms.items.length;
  const minrun = mergeComputeMinrun(remaining);
  let lo = 0;
  do {
    let n = countRun(ms, lo, remaining);
    if (n < minrun) {
      const force = Math.min(remaining, minrun);
      binarysort(ms, lo, force, n);
      n = force;
    }
    foundNewRun(ms, n);
    ms.pending.push({ base: lo, length: n, power: 0 });
    lo += n;
    remaining -= n;
  } while (remaining > 0);
  mergeForceCollapse(ms);
}

/** `merge_compute_minrun`. */
function mergeComputeMinrun(length: number): number {
  let n = length;
  let r = 0;
  while (n >= MAX_MINRUN) {
    r |= n & 1;
    n >>= 1;
  }
  return n + r;
}

/** `count_run`: the length of the run starting at `lo`, which is made ascending in place. */
function countRun<T>(ms: MergeState<T>, lo: number, remaining: number): number {
  const { items, less } = ms;
  const nextIsSmaller = (n: number): boolean => less(items[lo + n], items[lo + n - 1]);
  let n = 1;
  while (n < remaining && !nextIsSmaller(n)) ++n;
  if (n === remaining) return n;
  if (n > 1) {
    if (less(items[lo], items[lo + n - 1])) return n;
    reverseSlice(items, lo, lo + n);
  }
  ++n;
  n = finishDescendingRun(ms, lo, n, remaining);
  reverseSlice(items, lo, lo + n);
  while (n < remaining && !nextIsSmaller(n)) ++n;
  return n;
}

/** The descending loop of `count_run`: runs of equal items are reversed so that the final reversal restores them. */
function finishDescendingRun<T>({ items, less }: MergeState<T>, lo: number, start: number, remaining: number): number {
  let n = start;
  let equalCount = 0;
  const reverseLastEqualItems = (): void => {
    if (equalCount === 0) return;
    reverseSlice(items, lo + n - equalCount - 1, lo + n);
    equalCount = 0;
  };
  for (; n < remaining; ++n) {
    if (less(items[lo + n], items[lo + n - 1])) reverseLastEqualItems();
    else if (less(items[lo + n - 1], items[lo + n])) break;
    else ++equalCount;
  }
  reverseLastEqualItems();
  return n;
}

function reverseSlice<T>(items: T[], from: number, to: number): void {
  for (let i = from, j = to - 1; i < j; ++i, --j) {
    const item = items[i];
    items[i] = items[j];
    items[j] = item;
  }
}

/** `binarysort`: binary insertion of the `n` items from `lo`, of which the first `sortedCount` are sorted. */
function binarysort<T>({ items, less }: MergeState<T>, lo: number, n: number, sortedCount: number): void {
  for (let ok = Math.max(sortedCount, 1); ok < n; ++ok) {
    const pivot = items[lo + ok];
    let left = 0;
    let right = ok;
    do {
      const middle = (left + right) >> 1;
      if (less(pivot, items[lo + middle])) right = middle;
      else left = middle + 1;
    } while (left < right);
    items.copyWithin(lo + left + 1, lo + left, lo + ok);
    items[lo + left] = pivot;
  }
}

/** `found_new_run`: the powersort policy, merging the pending runs whose power exceeds that of the last one. */
function foundNewRun<T>(ms: MergeState<T>, newRunLength: number): void {
  const { pending } = ms;
  const last = pending.at(-1);
  if (!last) return;
  const power = powerloop(last.base, last.length, newRunLength, ms.items.length);
  while ((pending.at(-2)?.power ?? 0) > power) mergeAt(ms, pending.length - 2);
  const top = pending.at(-1);
  if (top) top.power = power;
}

/** `powerloop`. */
function powerloop(s1: number, n1: number, n2: number, n: number): number {
  let result = 0;
  let a = 2 * s1 + n1;
  let b = a + n1 + n2;
  for (;;) {
    ++result;
    if (a >= n) {
      a -= n;
      b -= n;
    } else if (b >= n) {
      break;
    }
    a *= 2;
    b *= 2;
  }
  return result;
}

/** `merge_force_collapse`. */
function mergeForceCollapse<T>(ms: MergeState<T>): void {
  const { pending } = ms;
  while (pending.length > 1) {
    let n = pending.length - 2;
    if (n > 0 && pending[n - 1].length < pending[n + 1].length) --n;
    mergeAt(ms, n);
  }
}

/** `merge_at`: merges the pending runs `i` and `i + 1`. */
function mergeAt<T>(ms: MergeState<T>, i: number): void {
  const { items, less, pending } = ms;
  let { base: baseA, length: na } = pending[i];
  const { base: baseB, length: lengthB } = pending[i + 1];
  pending[i].length = na + lengthB;
  pending.splice(i + 1, 1);

  const k = gallopRight(less, items[baseB], items, baseA, na, 0);
  baseA += k;
  na -= k;
  if (na === 0) return;
  const nb = gallopLeft(less, items[baseA + na - 1], items, baseB, lengthB, lengthB - 1);
  if (nb === 0) return;
  if (na <= nb) mergeLo(ms, baseA, na, baseB, nb);
  else mergeHi(ms, baseA, na, baseB, nb);
}

/** `merge_lo`: merges from the left, with run A moved to a temporary array. */
// code-gauge-allow duplicateLines 16 -- Transcribes merge_lo of CPython's listobject.c.
function mergeLo<T>(ms: MergeState<T>, baseA: number, na: number, baseB: number, nb: number): void {
  const { items } = ms;
  const temp = items.slice(baseA, baseA + na);
  const c: MergeCursor = { dest: baseA, pa: 0, pb: baseB, na, nb };
  let onlyLastOfAIsLeft = false;
  try {
    onlyLastOfAIsLeft = mergeLoRuns(ms, temp, c);
  } finally {
    if (onlyLastOfAIsLeft) {
      items.copyWithin(c.dest, c.pb, c.pb + c.nb);
      items[c.dest + c.nb] = temp[c.pa];
    } else {
      copyItems(temp, c.pa, items, c.dest, c.na);
    }
  }
}

/** The body of `merge_lo`; true stands for its `CopyB` exit and false for `Succeed`. */
function mergeLoRuns<T>(ms: MergeState<T>, temp: T[], c: MergeCursor): boolean {
  const { items } = ms;
  items[c.dest++] = items[c.pb++];
  --c.nb;
  if (c.nb === 0) return false;
  if (c.na === 1) return true;
  for (;;) {
    const exit = mergeLoOneAtATime(ms, temp, c) ?? mergeLoGalloping(ms, temp, c);
    if (exit !== undefined) return exit;
  }
}

// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes merge_lo of CPython's listobject.c.
function mergeLoOneAtATime<T>(
  { items, less, minGallop }: MergeState<T>,
  temp: T[],
  c: MergeCursor
): boolean | undefined {
  let aCount = 0;
  let bCount = 0;
  for (;;) {
    if (less(items[c.pb], temp[c.pa])) {
      items[c.dest++] = items[c.pb++];
      ++bCount;
      aCount = 0;
      --c.nb;
      if (c.nb === 0) return false;
      if (bCount >= minGallop) return undefined;
    } else {
      items[c.dest++] = temp[c.pa++];
      ++aCount;
      bCount = 0;
      --c.na;
      if (c.na === 1) return true;
      if (aCount >= minGallop) return undefined;
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes merge_lo of CPython's listobject.c.
// code-gauge-allow functionNcss 36 -- Transcribes merge_lo of CPython's listobject.c.
function mergeLoGalloping<T>(ms: MergeState<T>, temp: T[], c: MergeCursor): boolean | undefined {
  const { items, less } = ms;
  let aCount: number;
  let bCount: number;
  ++ms.minGallop;
  do {
    if (ms.minGallop > 1) --ms.minGallop;
    aCount = gallopRight(less, items[c.pb], temp, c.pa, c.na, 0);
    if (aCount > 0) {
      copyItems(temp, c.pa, items, c.dest, aCount);
      c.dest += aCount;
      c.pa += aCount;
      c.na -= aCount;
      if (c.na === 1) return true;
      // An inconsistent `less` can use run A up.
      if (c.na === 0) return false;
    }
    items[c.dest++] = items[c.pb++];
    --c.nb;
    if (c.nb === 0) return false;

    bCount = gallopLeft(less, temp[c.pa], items, c.pb, c.nb, 0);
    if (bCount > 0) {
      items.copyWithin(c.dest, c.pb, c.pb + bCount);
      c.dest += bCount;
      c.pb += bCount;
      c.nb -= bCount;
      if (c.nb === 0) return false;
    }
    items[c.dest++] = temp[c.pa++];
    --c.na;
    if (c.na === 1) return true;
  } while (aCount >= MIN_GALLOP || bCount >= MIN_GALLOP);
  ++ms.minGallop;
  return undefined;
}

/** `merge_hi`: merges from the right, with run B moved to a temporary array. */
// code-gauge-allow duplicateLines 16 -- Transcribes merge_hi of CPython's listobject.c.
function mergeHi<T>(ms: MergeState<T>, baseA: number, na: number, baseB: number, nb: number): void {
  const { items } = ms;
  const temp = items.slice(baseB, baseB + nb);
  const c: MergeCursor = { dest: baseB + nb - 1, pa: baseA + na - 1, pb: nb - 1, na, nb };
  let onlyFirstOfBIsLeft = false;
  try {
    onlyFirstOfBIsLeft = mergeHiRuns(ms, temp, baseA, c);
  } finally {
    if (onlyFirstOfBIsLeft) {
      items.copyWithin(c.dest + 1 - c.na, c.pa + 1 - c.na, c.pa + 1);
      items[c.dest - c.na] = temp[c.pb];
    } else {
      copyItems(temp, 0, items, c.dest - (c.nb - 1), c.nb);
    }
  }
}

/** The body of `merge_hi`; true stands for its `CopyA` exit and false for `Succeed`. */
function mergeHiRuns<T>(ms: MergeState<T>, temp: T[], baseA: number, c: MergeCursor): boolean {
  const { items } = ms;
  items[c.dest--] = items[c.pa--];
  --c.na;
  if (c.na === 0) return false;
  if (c.nb === 1) return true;
  for (;;) {
    const exit = mergeHiOneAtATime(ms, temp, c) ?? mergeHiGalloping(ms, temp, baseA, c);
    if (exit !== undefined) return exit;
  }
}

// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes merge_hi of CPython's listobject.c.
function mergeHiOneAtATime<T>(
  { items, less, minGallop }: MergeState<T>,
  temp: T[],
  c: MergeCursor
): boolean | undefined {
  let aCount = 0;
  let bCount = 0;
  for (;;) {
    if (less(temp[c.pb], items[c.pa])) {
      items[c.dest--] = items[c.pa--];
      ++aCount;
      bCount = 0;
      --c.na;
      if (c.na === 0) return false;
      if (aCount >= minGallop) return undefined;
    } else {
      items[c.dest--] = temp[c.pb--];
      ++bCount;
      aCount = 0;
      --c.nb;
      if (c.nb === 1) return true;
      if (bCount >= minGallop) return undefined;
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes merge_hi of CPython's listobject.c.
// code-gauge-allow functionNcss 36 -- Transcribes merge_hi of CPython's listobject.c.
function mergeHiGalloping<T>(ms: MergeState<T>, temp: T[], baseA: number, c: MergeCursor): boolean | undefined {
  const { items, less } = ms;
  let aCount: number;
  let bCount: number;
  ++ms.minGallop;
  do {
    if (ms.minGallop > 1) --ms.minGallop;
    aCount = c.na - gallopRight(less, temp[c.pb], items, baseA, c.na, c.na - 1);
    if (aCount > 0) {
      c.dest -= aCount;
      c.pa -= aCount;
      items.copyWithin(c.dest + 1, c.pa + 1, c.pa + 1 + aCount);
      c.na -= aCount;
      if (c.na === 0) return false;
    }
    items[c.dest--] = temp[c.pb--];
    --c.nb;
    if (c.nb === 1) return true;

    bCount = c.nb - gallopLeft(less, items[c.pa], temp, 0, c.nb, c.nb - 1);
    if (bCount > 0) {
      c.dest -= bCount;
      c.pb -= bCount;
      copyItems(temp, c.pb + 1, items, c.dest + 1, bCount);
      c.nb -= bCount;
      if (c.nb === 1) return true;
      // An inconsistent `less` can use run B up.
      if (c.nb === 0) return false;
    }
    items[c.dest--] = items[c.pa--];
    --c.na;
    if (c.na === 0) return false;
  } while (aCount >= MIN_GALLOP || bCount >= MIN_GALLOP);
  ++ms.minGallop;
  return undefined;
}

function copyItems<T>(source: T[], sourceStart: number, target: T[], targetStart: number, count: number): void {
  for (let i = 0; i < count; ++i) target[targetStart + i] = source[sourceStart + i];
}

/**
 * `gallop_left`: the index `k` in 0..n at which `key` belongs among the `n` sorted items from `a[base]`, left of any
 * equal item; the search starts at index `hint`.
 */
function gallopLeft<T>(less: Less<T>, key: T, a: T[], base: number, n: number, hint: number): number {
  const start = base + hint;
  let lastOffset = 0;
  let offset = 1;
  if (less(a[start], key)) {
    const maxOffset = n - hint;
    while (offset < maxOffset && less(a[start + offset], key)) {
      lastOffset = offset;
      offset = offset * 2 + 1;
    }
    offset = Math.min(offset, maxOffset);
    lastOffset += hint;
    offset += hint;
  } else {
    const maxOffset = hint + 1;
    while (offset < maxOffset && !less(a[start - offset], key)) {
      lastOffset = offset;
      offset = offset * 2 + 1;
    }
    offset = Math.min(offset, maxOffset);
    [lastOffset, offset] = [hint - offset, hint - lastOffset];
  }
  ++lastOffset;
  while (lastOffset < offset) {
    const middle = lastOffset + ((offset - lastOffset) >> 1);
    if (less(a[base + middle], key)) lastOffset = middle + 1;
    else offset = middle;
  }
  return offset;
}

/** `gallop_right`: as `gallopLeft`, but right of any item equal to `key`. */
function gallopRight<T>(less: Less<T>, key: T, a: T[], base: number, n: number, hint: number): number {
  const start = base + hint;
  let lastOffset = 0;
  let offset = 1;
  if (less(key, a[start])) {
    const maxOffset = hint + 1;
    while (offset < maxOffset && less(key, a[start - offset])) {
      lastOffset = offset;
      offset = offset * 2 + 1;
    }
    offset = Math.min(offset, maxOffset);
    [lastOffset, offset] = [hint - offset, hint - lastOffset];
  } else {
    const maxOffset = n - hint;
    while (offset < maxOffset && !less(key, a[start + offset])) {
      lastOffset = offset;
      offset = offset * 2 + 1;
    }
    offset = Math.min(offset, maxOffset);
    lastOffset += hint;
    offset += hint;
  }
  ++lastOffset;
  while (lastOffset < offset) {
    const middle = lastOffset + ((offset - lastOffset) >> 1);
    if (less(key, a[base + middle])) offset = middle;
    else lastOffset = middle + 1;
  }
  return offset;
}
