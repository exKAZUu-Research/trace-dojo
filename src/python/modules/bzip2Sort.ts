// The block sorting of bzip2 1.0.8's `blocksort.c`, which CPython's `_bz2` links. Both of its algorithms must be kept:
// the order of identical rotations, which a periodic block has, and so the stored origin pointer, depend on them.

export const BZ_N_OVERSHOOT = 34;
const BZ_N_RADIX = 2;
const BZ_N_QSORT = 12;

/** The sorted rotations of `block[0, nblock)` into `ptr`, returning the origin pointer. */
export function blockSort(block: Uint8Array, ptr: Int32Array, nblock: number, workFactor: number): number {
  if (nblock < 10_000) {
    fallbackSort(ptr, block, nblock);
  } else {
    const factor = Math.min(Math.max(workFactor, 1), 100);
    const sorting: Sorting = {
      ptr,
      block,
      quadrant: new Uint16Array(nblock + BZ_N_OVERSHOOT),
      nblock,
      budget: nblock * Math.trunc((factor - 1) / 3),
    };
    mainSort(sorting);
    if (sorting.budget < 0) fallbackSort(ptr, block, nblock);
  }
  for (let i = 0; i < nblock; i++) if (ptr[i] === 0) return i;
  throw new Error('bzip2: no origin pointer');
}

// Three-way partitioning, which both quicksorts share -----------------------------------------------------------------

interface Partition {
  ltLo: number;
  unLo: number;
  unHi: number;
  gtHi: number;
}

function swap(map: Int32Array, a: number, b: number): void {
  const tmp = map[a];
  map[a] = map[b];
  map[b] = tmp;
}

function swapRuns(map: Int32Array, from: number, to: number, count: number): void {
  for (let n = 0; n < count; n++) swap(map, from + n, to + n);
}

/** Partitions `map[lo, hi]` around `med` by `key`, keeping the equal keys at both ends, as both quicksorts do. */
function partition(map: Int32Array, key: (index: number) => number, lo: number, hi: number, med: number): Partition {
  const part: Partition = { ltLo: lo, unLo: lo, unHi: hi, gtHi: hi };
  for (;;) {
    scanUp(map, key, med, part);
    scanDown(map, key, med, part);
    if (part.unLo > part.unHi) return part;
    swap(map, part.unLo++, part.unHi--);
  }
}

function scanUp(map: Int32Array, key: (index: number) => number, med: number, part: Partition): void {
  while (part.unLo <= part.unHi) {
    const n = key(map[part.unLo]) - med;
    if (n > 0) return;
    if (n === 0) swap(map, part.unLo, part.ltLo++);
    part.unLo++;
  }
}

function scanDown(map: Int32Array, key: (index: number) => number, med: number, part: Partition): void {
  while (part.unLo <= part.unHi) {
    const n = key(map[part.unHi]) - med;
    if (n < 0) return;
    if (n === 0) swap(map, part.unHi, part.gtHi--);
    part.unHi--;
  }
}

/** Moves the equal keys to the middle, returning the ends of the lesser and the greater runs. */
function gatherEquals(map: Int32Array, lo: number, hi: number, part: Partition): [number, number] {
  const { ltLo, unLo, unHi, gtHi } = part;
  const n = Math.min(ltLo - lo, unLo - ltLo);
  swapRuns(map, lo, unLo - n, n);
  const m = Math.min(hi - gtHi, gtHi - unHi);
  swapRuns(map, unLo, hi - m + 1, m);
  return [lo + unLo - ltLo - 1, hi - (gtHi - unHi) + 1];
}

// Fallback O(N log(N)^2) sorting, for repetitive blocks ---------------------------------------------------------------

function fallbackSimpleSort(fmap: Int32Array, eclass: Uint32Array, lo: number, hi: number): void {
  if (lo === hi) return;
  if (hi - lo > 3) insertionPass(fmap, eclass, lo, hi, 4);
  insertionPass(fmap, eclass, lo, hi, 1);
}

function insertionPass(fmap: Int32Array, eclass: Uint32Array, lo: number, hi: number, step: number): void {
  for (let i = hi - step; i >= lo; i--) {
    const tmp = fmap[i];
    const ecTmp = eclass[tmp];
    let j = i + step;
    for (; j <= hi && ecTmp > eclass[fmap[j]]; j += step) fmap[j - step] = fmap[j];
    fmap[j - step] = tmp;
  }
}

function fallbackQSort3(fmap: Int32Array, eclass: Uint32Array, loSt: number, hiSt: number): void {
  const stack: [number, number][] = [[loSt, hiSt]];
  const key = (index: number): number => eclass[index];
  let r = 0;
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    if (hi - lo < 10) {
      fallbackSimpleSort(fmap, eclass, lo, hi);
      continue;
    }
    r = (r * 7621 + 1) % 32_768;
    const pivot = [lo, (lo + hi) >> 1, hi][r % 3];
    const part = partition(fmap, key, lo, hi, eclass[fmap[pivot]]);
    if (part.gtHi < part.ltLo) continue;
    const [n, m] = gatherEquals(fmap, lo, hi, part);
    if (n - lo > hi - m) stack.push([lo, n], [m, hi]);
    else stack.push([m, hi], [lo, n]);
  }
}

/** The bucket boundaries of the fallback sort, one bit per position of the sorted order. */
class BucketHeads {
  private readonly bits: Uint32Array;

  constructor(nblock: number) {
    this.bits = new Uint32Array(4 + (nblock >> 5));
  }

  set(index: number): void {
    this.bits[index >> 5] |= 1 << (index & 31);
  }

  clear(index: number): void {
    this.bits[index >> 5] &= ~(1 << (index & 31));
  }

  has(index: number): boolean {
    return (this.bits[index >> 5] & (1 << (index & 31))) !== 0;
  }

  /** The first position from `start` whose bit is not `value`, skipping whole words as bzip2 does. */
  skip(start: number, value: boolean): number {
    let k = start;
    while (this.has(k) === value && (k & 0x1f) !== 0) k++;
    if (this.has(k) === value) {
      const word = value ? 0xff_ff_ff_ff : 0;
      while (this.bits[k >> 5] === word) k += 32;
      while (this.has(k) === value) k++;
    }
    return k;
  }
}

function fallbackSort(fmap: Int32Array, block: Uint8Array, nblock: number): void {
  const eclass = new Uint32Array(nblock);
  const heads = new BucketHeads(nblock);
  for (const start of radixSortBytes(fmap, block, nblock)) heads.set(start);
  for (let i = 0; i < 32; i++) {
    heads.set(nblock + 2 * i);
    heads.clear(nblock + 2 * i + 1);
  }
  for (let h = 1; ; h *= 2) {
    let j = 0;
    for (let i = 0; i < nblock; i++) {
      if (heads.has(i)) j = i;
      let k = fmap[i] - h;
      if (k < 0) k += nblock;
      eclass[k] = j;
    }
    const nNotDone = refineBuckets(fmap, eclass, heads, nblock);
    if (h * 2 > nblock || nNotDone === 0) break;
  }
}

/** Sorts the positions by their byte, returning the start of each byte's bucket. */
function radixSortBytes(fmap: Int32Array, block: Uint8Array, nblock: number): Int32Array {
  const ftab = new Int32Array(257);
  for (let i = 0; i < nblock; i++) ftab[block[i]]++;
  for (let i = 1; i < 257; i++) ftab[i] += ftab[i - 1];
  for (let i = 0; i < nblock; i++) {
    const k = --ftab[block[i]];
    fmap[k] = i;
  }
  return ftab.subarray(0, 256);
}

/** Sorts each bucket of more than one position by the classes, marking the new buckets; returns how many it sorted. */
function refineBuckets(fmap: Int32Array, eclass: Uint32Array, heads: BucketHeads, nblock: number): number {
  let nNotDone = 0;
  let r = -1;
  for (;;) {
    let k = heads.skip(r + 1, true);
    const l = k - 1;
    if (l >= nblock) break;
    k = heads.skip(k, false);
    r = k - 1;
    if (r >= nblock) break;
    if (r <= l) continue;
    nNotDone += r - l + 1;
    fallbackQSort3(fmap, eclass, l, r);
    let cc = -1;
    for (let i = l; i <= r; i++) {
      const cc1 = eclass[fmap[i]];
      if (cc !== cc1) heads.set(i);
      cc = cc1;
    }
  }
  return nNotDone;
}

// The main O(N^2 log(N)) sorting, faster for non-repetitive blocks ----------------------------------------------------

interface Sorting {
  ptr: Int32Array;
  block: Uint8Array;
  quadrant: Uint16Array;
  nblock: number;
  /** The work left before the block counts as too repetitive, which falls back to the fallback sort. */
  budget: number;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes mainGtU of bzip2's blocksort.c.
function mainGtU(sorting: Sorting, i1Start: number, i2Start: number): boolean {
  const { block, quadrant, nblock } = sorting;
  let i1 = i1Start;
  let i2 = i2Start;
  for (let n = 0; n < 12; n++, i1++, i2++) {
    if (block[i1] !== block[i2]) return block[i1] > block[i2];
  }
  for (let k = nblock + 8; k >= 0; k -= 8) {
    for (let n = 0; n < 8; n++, i1++, i2++) {
      if (block[i1] !== block[i2]) return block[i1] > block[i2];
      if (quadrant[i1] !== quadrant[i2]) return quadrant[i1] > quadrant[i2];
    }
    if (i1 >= nblock) i1 -= nblock;
    if (i2 >= nblock) i2 -= nblock;
    sorting.budget--;
  }
  return false;
}

const INCS = [1, 4, 13, 40, 121, 364, 1093, 3280, 9841, 29_524, 88_573, 265_720, 797_161, 2_391_484];

// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes mainSimpleSort of bzip2's blocksort.c.
function mainSimpleSort(sorting: Sorting, lo: number, hi: number, d: number): void {
  const { ptr } = sorting;
  const bigN = hi - lo + 1;
  if (bigN < 2) return;
  let hp = 0;
  while (INCS[hp] < bigN) hp++;
  for (hp--; hp >= 0; hp--) {
    const h = INCS[hp];
    // bzip2 unrolls this loop three times, checking the budget after every third insertion.
    for (let i = lo + h, copies = 1; i <= hi; i++, copies++) {
      const v = ptr[i];
      let j = i;
      while (mainGtU(sorting, ptr[j - h] + d, v + d)) {
        ptr[j] = ptr[j - h];
        j -= h;
        if (j <= lo + h - 1) break;
      }
      ptr[j] = v;
      if (copies % 3 === 0 && sorting.budget < 0) return;
    }
  }
}

function median3(first: number, second: number, third: number): number {
  let [a, b] = first > second ? [second, first] : [first, second];
  if (b > third) {
    b = third;
    if (a > b) b = a;
  }
  return b;
}

function mainQSort3(sorting: Sorting, loSt: number, hiSt: number, dSt: number): void {
  const { ptr, block } = sorting;
  const stack: [number, number, number][] = [[loSt, hiSt, dSt]];
  while (stack.length > 0) {
    const [lo, hi, d] = stack.pop() as [number, number, number];
    if (hi - lo < 20 || d > BZ_N_RADIX + BZ_N_QSORT) {
      mainSimpleSort(sorting, lo, hi, d);
      if (sorting.budget < 0) return;
      continue;
    }
    const med = median3(block[ptr[lo] + d], block[ptr[hi] + d], block[ptr[(lo + hi) >> 1] + d]);
    const part = partition(ptr, (index) => block[index + d], lo, hi, med);
    if (part.gtHi < part.ltLo) {
      stack.push([lo, hi, d + 1]);
      continue;
    }
    const [n, m] = gatherEquals(ptr, lo, hi, part);
    const next: [number, number, number][] = [
      [lo, n, d],
      [m, hi, d],
      [n + 1, m - 1, d + 1],
    ];
    const size = (index: number): number => next[index][1] - next[index][0];
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [0, 1],
    ]) {
      if (size(a) < size(b)) [next[a], next[b]] = [next[b], next[a]];
    }
    stack.push(...next);
  }
}

const SETMASK = 1 << 21;
const CLEARMASK = ~SETMASK;

function mainSort(sorting: Sorting): void {
  const ftab = radixSortPairs(sorting);
  const runningOrder = bigBucketOrder(ftab);
  const bigDone = Array.from({ length: 256 }, () => false);
  for (let i = 0; i <= 255; i++) {
    const ss = runningOrder[i];
    sortSmallBuckets(sorting, ftab, ss);
    if (sorting.budget < 0) return;
    synthesizeBuckets(sorting, ftab, bigDone, ss);
    bigDone[ss] = true;
    if (i < 255) updateQuadrant(sorting, ftab, ss);
  }
}

/** Sorts the positions by their first two bytes, returning the start of each two-byte bucket. */
function radixSortPairs({ ptr, block, quadrant, nblock }: Sorting): Int32Array {
  const ftab = new Int32Array(65_537);
  let j = block[0] << 8;
  for (let i = nblock - 1; i >= 0; i--) {
    quadrant[i] = 0;
    j = (j >> 8) | (block[i] << 8);
    ftab[j]++;
  }
  for (let i = 0; i < BZ_N_OVERSHOOT; i++) {
    block[nblock + i] = block[i];
    quadrant[nblock + i] = 0;
  }
  for (let i = 1; i <= 65_536; i++) ftab[i] += ftab[i - 1];
  let s = block[0] << 8;
  for (let i = nblock - 1; i >= 0; i--) {
    s = ((s >> 8) | (block[i] << 8)) & 0xff_ff;
    ptr[--ftab[s]] = i;
  }
  return ftab;
}

/** The big buckets from the least full to the fullest, by bzip2's shell sort. */
function bigBucketOrder(ftab: Int32Array): number[] {
  const runningOrder = Array.from({ length: 256 }, (_, i) => i);
  const bigFreq = (b: number): number => ftab[(b + 1) << 8] - ftab[b << 8];
  let h = 1;
  do h = 3 * h + 1;
  while (h <= 256);
  do {
    h = Math.trunc(h / 3);
    for (let i = h; i <= 255; i++) {
      const vv = runningOrder[i];
      let k = i;
      while (bigFreq(runningOrder[k - h]) > bigFreq(vv)) {
        runningOrder[k] = runningOrder[k - h];
        k -= h;
        if (k <= h - 1) break;
      }
      runningOrder[k] = vv;
    }
  } while (h !== 1);
  return runningOrder;
}

/** Step 1: quicksorts the small buckets [ss, j] that earlier scans did not complete. */
function sortSmallBuckets(sorting: Sorting, ftab: Int32Array, ss: number): void {
  for (let k = 0; k <= 255; k++) {
    if (k === ss) continue;
    const sb = (ss << 8) + k;
    if ((ftab[sb] & SETMASK) === 0) {
      const lo = ftab[sb] & CLEARMASK;
      const hi = (ftab[sb + 1] & CLEARMASK) - 1;
      if (hi > lo) {
        mainQSort3(sorting, lo, hi, BZ_N_RADIX);
        if (sorting.budget < 0) return;
      }
    }
    ftab[sb] |= SETMASK;
  }
}

/** Step 2: scans the big bucket [ss] to synthesise the sorted order of the small buckets [t, ss]. */
function synthesizeBuckets({ ptr, block, nblock }: Sorting, ftab: Int32Array, bigDone: boolean[], ss: number): void {
  const copyStart = new Int32Array(256);
  const copyEnd = new Int32Array(256);
  for (let k = 0; k <= 255; k++) {
    copyStart[k] = ftab[(k << 8) + ss] & CLEARMASK;
    copyEnd[k] = (ftab[(k << 8) + ss + 1] & CLEARMASK) - 1;
  }
  const previous = (k: number): number => (ptr[k] === 0 ? nblock - 1 : ptr[k] - 1);
  for (let k = ftab[ss << 8] & CLEARMASK; k < copyStart[ss]; k++) {
    const p = previous(k);
    if (!bigDone[block[p]]) ptr[copyStart[block[p]]++] = p;
  }
  for (let k = (ftab[(ss + 1) << 8] & CLEARMASK) - 1; k > copyEnd[ss]; k--) {
    const p = previous(k);
    if (!bigDone[block[p]]) ptr[copyEnd[block[p]]--] = p;
  }
  for (let k = 0; k <= 255; k++) ftab[(k << 8) + ss] |= SETMASK;
}

/** Step 3: records the order of the big bucket [ss] in the quadrants, which later comparisons read. */
function updateQuadrant({ ptr, quadrant, nblock }: Sorting, ftab: Int32Array, ss: number): void {
  const bbStart = ftab[ss << 8] & CLEARMASK;
  const bbSize = (ftab[(ss + 1) << 8] & CLEARMASK) - bbStart;
  let shifts = 0;
  while (bbSize >> shifts > 65_534) shifts++;
  for (let k = bbSize - 1; k >= 0; k--) {
    const a2update = ptr[bbStart + k];
    const qVal = (k >> shifts) & 0xff_ff;
    quadrant[a2update] = qVal;
    if (a2update < BZ_N_OVERSHOOT) quadrant[a2update + nblock] = qVal;
  }
}
