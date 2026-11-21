import type { HashEntry } from './hashStore';

class Buckets<V> {
  readonly entries = new Map<number, HashEntry<V>[]>();
  private indices: number[] | undefined;

  changed(): void {
    this.indices = undefined;
  }

  nextIndex(previous: number): number | undefined {
    const indices = (this.indices ??= [...this.entries.keys()].toSorted((a, b) => a - b));
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((indices[middle] as number) <= previous) low = middle + 1;
      else high = middle;
    }
    return indices[low];
  }
}

export class HashTraversal<V> {
  private readonly next = new WeakMap<HashEntry<V>, HashEntry<V>>();
  private buckets = new Buckets<V>();

  constructor(
    private readonly bucketOf: (entry: HashEntry<V>) => number,
    entries: readonly HashEntry<V>[]
  ) {
    this.replace(entries);
  }

  find(accepts: (entry: HashEntry<V>) => boolean): HashEntry<V> | undefined {
    const table = this.buckets;
    let index = table.nextIndex(-1);
    while (index !== undefined) {
      for (let entry = table.entries.get(index)?.[0]; entry; entry = this.next.get(entry)) {
        if (accepts(entry)) return entry;
      }
      index = table.nextIndex(index);
    }
    return undefined;
  }

  add(entry: HashEntry<V>, atHead: boolean): void {
    const index = this.bucketOf(entry);
    const bucket = this.buckets.entries.get(index);
    if (!bucket) {
      this.buckets.entries.set(index, [entry]);
      this.buckets.changed();
      return;
    }
    if (atHead) {
      this.next.set(entry, bucket[0] as HashEntry<V>);
      bucket.unshift(entry);
    } else {
      this.next.set(bucket.at(-1) as HashEntry<V>, entry);
      bucket.push(entry);
    }
  }

  remove(entry: HashEntry<V>): void {
    const index = this.bucketOf(entry);
    const bucket = this.buckets.entries.get(index);
    if (!bucket) return;
    const position = bucket.indexOf(entry);
    if (position === -1) return;
    const before = bucket[position - 1];
    const after = bucket[position + 1];
    if (before && after) this.next.set(before, after);
    else if (before) this.next.delete(before);
    bucket.splice(position, 1);
    if (bucket.length > 0) return;
    this.buckets.entries.delete(index);
    this.buckets.changed();
  }

  replace(entries: readonly HashEntry<V>[]): void {
    this.buckets.entries.clear();
    this.buckets.changed();
    for (const entry of entries) {
      this.next.delete(entry);
      this.add(entry, false);
    }
  }

  resize(entries: readonly HashEntry<V>[]): void {
    // Resizing empties the table held by an active search, then relinks its surviving nodes in the new table.
    this.buckets.entries.clear();
    this.buckets.changed();
    this.buckets = new Buckets<V>();
    this.replace(entries);
  }
}
