import { numericCompare } from './conversions';
import type { Gen } from './interp';
import type { Value } from './objects';
import { classOf } from './values';

/**
 * Sorts in place as Ruby's `ruby_qsort` does on the reference platform, which calls the C library's BSD `qsort_r`
 * (Bentley and McIlroy's quicksort). The order of elements that compare equal follows from it, so it is transcribed
 * rather than replaced with a stable sort.
 */
export function* platformSort<T>(items: T[], compare: (a: T, b: T) => Gen<number>): Gen<void> {
  const swap = (i: number, j: number): void => {
    const temporary = items[i];
    items[i] = items[j];
    items[j] = temporary;
  };
  const vecswap = (i: number, j: number, count: number): void => {
    for (let k = 0; k < count; k++) swap(i + k, j + k);
  };
  const med3 = function* (a: number, b: number, c: number): Gen<number> {
    if ((yield* compare(items[a], items[b])) < 0) {
      if ((yield* compare(items[b], items[c])) < 0) return b;
      return (yield* compare(items[a], items[c])) < 0 ? c : a;
    }
    if ((yield* compare(items[b], items[c])) > 0) return b;
    return (yield* compare(items[a], items[c])) < 0 ? a : c;
  };
  const insertion = function* (start: number, count: number): Gen<void> {
    for (let m = start + 1; m < start + count; m++) {
      for (let l = m; l > start && (yield* compare(items[l - 1], items[l])) > 0; l--) swap(l, l - 1);
    }
  };
  const sort = function* (start: number, count: number): Gen<void> {
    let a = start;
    let n = count;
    for (;;) {
      if (n < 8) {
        yield* insertion(a, n);
        return;
      }
      let pm = a + (n >> 1);
      if (n > 7) {
        let pl = a;
        let pn = a + n - 1;
        if (n > 40) {
          const d = n >> 3;
          pl = yield* med3(pl, pl + d, pl + 2 * d);
          pm = yield* med3(pm - d, pm, pm + d);
          pn = yield* med3(pn - 2 * d, pn - d, pn);
        }
        pm = yield* med3(pl, pm, pn);
      }
      swap(a, pm);
      let pa = a + 1;
      let pb = a + 1;
      let pc = a + n - 1;
      let pd = a + n - 1;
      for (;;) {
        let order: number;
        while (pb <= pc && (order = yield* compare(items[pb], items[a])) <= 0) {
          if (order === 0) {
            swap(pa, pb);
            pa++;
          }
          pb++;
        }
        while (pb <= pc && (order = yield* compare(items[pc], items[a])) >= 0) {
          if (order === 0) {
            swap(pc, pd);
            pd--;
          }
          pc--;
        }
        if (pb > pc) break;
        swap(pb, pc);
        pb++;
        pc--;
      }
      const pn = a + n;
      let r = Math.min(pa - a, pb - pa);
      vecswap(a, pb - r, r);
      r = Math.min(pd - pc, pn - pd - 1);
      vecswap(pb, pn - r, r);
      if ((r = pb - pa) > 1) yield* sort(a, r);
      if ((r = pd - pc) > 1) {
        a = pn - r;
        n = r;
        continue;
      }
      return;
    }
  };
  yield* sort(0, items.length);
}

/** A key of `sort_by` that Ruby compares directly: a fixnum-sized Integer or a Float. */
export function isUniformKey(value: Value): boolean {
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  if (typeof value === 'bigint' && (value < -(2n ** 62n) || value >= 2n ** 62n)) return false;
  return (
    (typeof value === 'number' || typeof value === 'bigint') && classOf(value).findMethod('<=>')?.body.kind === 'native'
  );
}

function less(a: Value, b: Value): boolean {
  return numericCompare(a as bigint | number, b as bigint | number) === -1;
}

/** `sort_by` for keys that are all Integers or Floats: Ruby's introsort over (key, value) pairs. */
export function uniformSort(pairs: { key: Value; value: Value }[]): void {
  const n = pairs.length;
  if (n < 2) return;
  let sorted = true;
  for (let index = 1; index < n; index++) {
    if (less(pairs[index].key, pairs[index - 1].key)) {
      sorted = false;
      break;
    }
  }
  if (sorted) return;
  const depth = (31 - Math.clz32(n)) << 1;
  quicksortIntro(pairs, 0, n, depth);
}

function insertionSort(pairs: { key: Value; value: Value }[], begin: number, end: number): void {
  if (end - begin < 2) return;
  for (let index = begin + 1; index < end; index++) {
    const temporary = pairs[index];
    let j = index;
    if (less(temporary.key, pairs[begin].key)) {
      while (begin < j) {
        pairs[j] = pairs[j - 1];
        j--;
      }
    } else {
      while (less(temporary.key, pairs[j - 1].key)) {
        pairs[j] = pairs[j - 1];
        j--;
      }
    }
    pairs[j] = temporary;
  }
}

function heapDown(pairs: { key: Value; value: Value }[], begin: number, start: number, length: number): void {
  let offset = start;
  const temporary = pairs[begin + offset];
  let child: number;
  while ((child = (offset << 1) + 1) <= length) {
    if (child < length && less(pairs[begin + child].key, pairs[begin + child + 1].key)) child++;
    if (!less(temporary.key, pairs[begin + child].key)) break;
    pairs[begin + offset] = pairs[begin + child];
    offset = child;
  }
  pairs[begin + offset] = temporary;
}

function heapSort(pairs: { key: Value; value: Value }[], begin: number, end: number): void {
  const n = end - begin;
  if (n < 2) return;
  for (let offset = n >> 1; offset > 0;) heapDown(pairs, begin, --offset, n - 1);
  for (let offset = n - 1; offset > 0;) {
    [pairs[begin], pairs[begin + offset]] = [pairs[begin + offset], pairs[begin]];
    heapDown(pairs, begin, 0, --offset);
  }
}

function median3(a: Value, b: Value, c: Value): Value {
  if (less(a, b)) {
    if (less(b, c)) return b;
    return less(c, a) ? a : c;
  }
  if (less(c, b)) return b;
  return less(a, c) ? a : c;
}

function quicksortIntro(pairs: { key: Value; value: Value }[], begin: number, end: number, depth: number): void {
  if (end - begin <= 16) {
    insertionSort(pairs, begin, end);
    return;
  }
  if (depth === 0) {
    heapSort(pairs, begin, end);
    return;
  }
  const pivot = median3(pairs[begin].key, pairs[begin + ((end - begin) >> 1)].key, pairs[end - 1].key);
  let i = begin;
  let j = end - 1;
  do {
    while (less(pairs[i].key, pivot)) i++;
    while (less(pivot, pairs[j].key)) j--;
    if (i <= j) {
      [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
      i++;
      j--;
    }
  } while (i <= j);
  j++;
  if (end - j > 1) quicksortIntro(pairs, j, end, depth - 1);
  if (i - begin > 1) quicksortIntro(pairs, begin, i, depth - 1);
}
