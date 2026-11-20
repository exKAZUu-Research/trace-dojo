/**
 * Sorts `items` in place as PHP's `zend_sort` does: a hybrid of insertion sort and quicksort. Programs see its order of
 * comparisons through comparison callbacks, and its result through comparisons that are not consistent, so it follows
 * Zend/zend_sort.c step by step.
 */
export function zendSort<T>(items: T[], compare: (a: T, b: T) => number): void {
  const sorter = new ZendSorter(items, compare);
  sorter.sort(0, items.length);
}

class ZendSorter<T> {
  constructor(
    private readonly items: T[],
    private readonly compare: (a: T, b: T) => number
  ) {}

  sort(base: number, count: number): void {
    for (;;) {
      if (count <= 16) {
        this.insertSort(base, count);
        return;
      }
      const end = base + count;
      const offset = count >> 1;
      let pivot = base + offset;
      if (count >> 10) {
        const delta = offset >> 1;
        this.sort5(base, base + delta, pivot, pivot + delta, end - 1);
      } else {
        this.sort3(base, pivot, end - 1);
      }
      this.swap(base + 1, pivot);
      pivot = base + 1;
      const split = this.partition(pivot, pivot + 1, end - 1);
      this.swap(pivot, split - 1);
      if (split - 1 - base < end - split) {
        this.sort(base, split - base - 1);
        count = end - split;
        base = split;
      } else {
        this.sort(split, end - split);
        count = split - base - 1;
      }
    }
  }

  /** Moves the items greater than the pivot after the ones that are not, returning where the second group starts. */
  private partition(pivot: number, i: number, j: number): number {
    for (;;) {
      while (this.greater(pivot, i)) {
        i++;
        if (i === j) return i;
      }
      j--;
      if (j === i) return i;
      while (this.greater(j, pivot)) {
        j--;
        if (j === i) return i;
      }
      this.swap(i, j);
      i++;
      if (i === j) return i;
    }
  }

  private insertSort(base: number, count: number): void {
    if (count <= 5) {
      this.sortFew(base, count);
      return;
    }
    const sentry = base + 6;
    for (let i = base + 1; i < sentry; i++) this.insertLinearly(base, i);
    for (let i = sentry; i < base + count; i++) this.insertByHalves(base, i);
  }

  private sortFew(base: number, count: number): void {
    switch (count) {
      case 2: {
        this.sort2(base, base + 1);
        return;
      }
      case 3: {
        this.sort3(base, base + 1, base + 2);
        return;
      }
      case 4: {
        this.sort4(base, base + 1, base + 2, base + 3);
        return;
      }
      case 5: {
        this.sort5(base, base + 1, base + 2, base + 3, base + 4);
      }
    }
  }

  /** Inserts the item at `i` into the sorted items before it, searching them one by one from the back. */
  private insertLinearly(base: number, i: number): void {
    let j = i - 1;
    if (!this.greater(j, i)) return;
    while (j !== base) {
      j--;
      if (!this.greater(j, i)) {
        j++;
        break;
      }
    }
    this.rotate(j, i);
  }

  /** Inserts the item at `i` into the sorted items before it, searching them two at a time from the back. */
  private insertByHalves(base: number, i: number): void {
    let j = i - 1;
    if (!this.greater(j, i)) return;
    for (;;) {
      j -= 2;
      if (!this.greater(j, i)) {
        j++;
        if (!this.greater(j, i)) j++;
        break;
      }
      if (j === base) break;
      if (j === base + 1) {
        j--;
        if (this.compare(this.items[i], this.items[j]) > 0) j++;
        break;
      }
    }
    this.rotate(j, i);
  }

  /** Moves the item at `to` down to `from` by swapping it with each item before it, as zend_insert_sort does. */
  private rotate(from: number, to: number): void {
    for (let k = to; k > from; k--) this.swap(k, k - 1);
  }

  private sort2(a: number, b: number): void {
    if (this.greater(a, b)) this.swap(a, b);
  }

  private sort3(a: number, b: number, c: number): void {
    if (!this.greater(a, b)) {
      if (!this.greater(b, c)) return;
      this.swap(b, c);
      if (this.greater(a, b)) this.swap(a, b);
      return;
    }
    if (!this.greater(c, b)) {
      this.swap(a, c);
      return;
    }
    this.swap(a, b);
    if (this.greater(b, c)) this.swap(b, c);
  }

  private sort4(a: number, b: number, c: number, d: number): void {
    this.sort3(a, b, c);
    if (!this.greater(c, d)) return;
    this.swap(c, d);
    if (!this.greater(b, c)) return;
    this.swap(b, c);
    if (this.greater(a, b)) this.swap(a, b);
  }

  private sort5(a: number, b: number, c: number, d: number, e: number): void {
    this.sort4(a, b, c, d);
    if (!this.greater(d, e)) return;
    this.swap(d, e);
    if (!this.greater(c, d)) return;
    this.swap(c, d);
    if (!this.greater(b, c)) return;
    this.swap(b, c);
    if (this.greater(a, b)) this.swap(a, b);
  }

  private greater(a: number, b: number): boolean {
    return this.compare(this.items[a], this.items[b]) > 0;
  }

  private swap(a: number, b: number): void {
    const item = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = item;
  }
}
