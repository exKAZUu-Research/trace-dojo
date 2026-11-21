export interface HashEntry<V> {
  key: V;
  value: V;
  hash: number;
  /** For a hash-ordered store, where the entry comes within its bucket: entries iterate by bucket, then by this. */
  order?: number;
}

/** `HashMap`'s TREEIFY_THRESHOLD and MIN_TREEIFY_CAPACITY. */
const TREEIFY_THRESHOLD = 8;
const MIN_TREEIFY_CAPACITY = 64;

/**
 * The entries of a `HashMap` or `HashSet`, which iterates as Java's does: by bucket of a table that doubles whenever
 * the entries exceed three quarters of it, or a bucket of a table smaller than 64 grows crowded, and in insertion
 * order within a bucket.
 */
export class HashStore<V, F> {
  private list: HashEntry<V>[] = [];
  /** The orders of the first and the next last entry within buckets, which head and tail insertion take. */
  private firstOrder = 0;
  private lastOrder = 0;
  /** The entries by hash, which finds a key among the entries of its hash only; built when first needed. */
  private byHash: Map<number, HashEntry<V>[]> | undefined;
  capacity = 16;
  /** Whether an entry was ever added, after which a Java `HashMap` has allocated its table. */
  get isAllocated(): boolean {
    return this.lastOrder > 0 || this.firstOrder < 0;
  }
  /**
   * How iteration orders the entries: by hash bucket as a `HashMap`, by insertion as a `LinkedHashMap`, or sorted by
   * `compare` as a `TreeMap`, whose entries stay sorted as they are added.
   */
  order: 'hash' | 'insertion' | 'sorted' = 'hash';
  /** For a sorted store, compares keys, which also decides which keys are the same. */
  compare?: (frame: F, a: V, b: V) => number;
  /** For a sorted store, the `Comparator` that `compare` calls, or `undefined` for natural ordering. */
  comparator?: V;

  /**
   * Where `key` is or would go among a sorted store's entries, by binary search as a `TreeMap` descends its tree, so
   * that each lookup costs a logarithmic number of comparisons, which may call the program's comparator.
   */
  positionOf(frame: F, key: V): { index: number; isFound: boolean } {
    const compare = this.compare as NonNullable<HashStore<V, F>['compare']>;
    let [low, high] = [0, this.entries.length];
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const order = compare(frame, key, (this.entries[middle] as HashEntry<V>).key);
      if (order === 0) return { index: middle, isFound: true };
      if (order < 0) high = middle;
      else low = middle + 1;
    }
    return { index: low, isFound: false };
  }

  /**
   * The entry of a sorted store nearest to `target` whose order against it `accepts`: the first such entry, or with
   * `fromEnd` the last one, found by binary search since `accepts` holds on one side of `target` only.
   */
  nearest(frame: F, target: V, accepts: (order: number) => boolean, fromEnd: boolean): HashEntry<V> | undefined {
    const compare = this.compare as NonNullable<HashStore<V, F>['compare']>;
    // The first index from which `accepts` holds (or, from the end, stops holding).
    let [low, high] = [0, this.entries.length];
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const holds = accepts(compare(frame, (this.entries[middle] as HashEntry<V>).key, target));
      if (holds !== fromEnd) high = middle;
      else low = middle + 1;
    }
    return this.entries[fromEnd ? low - 1 : low];
  }

  /** The entries in the order Java's iteration visits them, as a new array that later changes leave as it is. */
  ordered(): HashEntry<V>[] {
    if (this.order !== 'hash') return [...this.list];
    return this.list.toSorted((a, b) => this.bucketOf(a) - this.bucketOf(b) || (a.order ?? 0) - (b.order ?? 0));
  }

  get entries(): HashEntry<V>[] {
    return this.list;
  }

  set entries(entries: HashEntry<V>[]) {
    this.list = entries;
    this.byHash = undefined;
  }

  /** The entries whose keys have `hash`, among which a key equal to one with that hash is. */
  withHash(hash: number): readonly HashEntry<V>[] {
    if (!this.byHash) {
      this.byHash = new Map();
      for (const entry of this.list) this.indexEntry(entry);
    }
    return this.byHash.get(hash) ?? [];
  }

  /** Inserts an entry at a position of a sorted store, which keeps its entries in order. */
  insertAt(index: number, entry: HashEntry<V>): void {
    this.list.splice(index, 0, entry);
    this.indexEntry(entry);
  }

  /**
   * Moves an entry to the end of an insertion-ordered store, as an access-ordered `LinkedHashMap` does, returning
   * whether that changed the order.
   */
  moveToEnd(entry: HashEntry<V>): boolean {
    const index = this.list.indexOf(entry);
    if (index === -1 || index === this.list.length - 1) return false;
    this.list.splice(index, 1);
    this.list.push(entry);
    return true;
  }

  /** Removes an entry, keeping the order of the others. */
  remove(entry: HashEntry<V>): void {
    const index = this.list.indexOf(entry);
    if (index !== -1) this.list.splice(index, 1);
    const sameHash = this.byHash?.get(entry.hash);
    if (sameHash) sameHash.splice(sameHash.indexOf(entry), 1);
  }

  private indexEntry(entry: HashEntry<V>): void {
    const sameHash = this.byHash?.get(entry.hash);
    if (sameHash) sameHash.push(entry);
    else this.byHash?.set(entry.hash, [entry]);
  }

  /** Adds an entry at the end of its bucket and then grows the table, as `HashMap.put` does. */
  add(entry: HashEntry<V>): void {
    const crowded = this.bucketSize(entry) >= TREEIFY_THRESHOLD;
    entry.order = this.lastOrder++;
    this.list.push(entry);
    this.indexEntry(entry);
    if (crowded) this.growCrowded();
    while (this.entries.length > this.capacity * 0.75) this.capacity *= 2;
  }

  /**
   * Grows a table whose entries exceed three quarters of it, as `HashMap.computeIfAbsent`, `compute`, and `merge` do
   * first, whether or not they find the key.
   */
  growBeforeCompute(): void {
    while (this.entries.length > this.capacity * 0.75) this.capacity *= 2;
  }

  /**
   * Adds an entry at the start of its bucket, as `HashMap.computeIfAbsent`, `compute`, and `merge` do after
   * `growBeforeCompute`; a later resize keeps the order within each bucket, as Java's split of a bucket does.
   */
  addAtBucketHead(entry: HashEntry<V>): void {
    this.growBeforeCompute();
    const crowded = this.bucketSize(entry) >= TREEIFY_THRESHOLD - 1;
    // An order before every other entry's puts it first in its bucket, where a HashMap's head insertion puts it.
    entry.order = this.order === 'hash' ? --this.firstOrder : this.lastOrder++;
    this.list.push(entry);
    this.indexEntry(entry);
    if (crowded) this.growCrowded();
  }

  /** The number of entries in the bucket `entry` falls into. */
  private bucketSize(entry: HashEntry<V>): number {
    if (this.capacity >= MIN_TREEIFY_CAPACITY) return 0;
    const bucket = this.bucketOf(entry);
    return this.entries.filter((other) => this.bucketOf(other) === bucket).length;
  }

  /**
   * Doubles a table smaller than 64 whose bucket grew crowded, as `HashMap.treeifyBin` resizes instead of turning
   * the bucket into a tree; a larger table's tree bins are not modeled.
   */
  private growCrowded(): void {
    if (this.capacity < MIN_TREEIFY_CAPACITY) this.capacity *= 2;
  }

  private bucketOf(entry: HashEntry<V>): number {
    return (entry.hash ^ (entry.hash >>> 16)) & (this.capacity - 1);
  }
}
