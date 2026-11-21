import { BTree, type TreeKey } from './btree';
import { TableMap } from './capacity';
import { allocateCollectionSnapshot, hashKey, valuesEqual } from './ops';
import type { Type } from './types';
import type { RangeEndpoint, Value } from './values';

interface HashTableKey {
  readonly hash: string;
}

export type CollectionKey<V> = HashTableKey | TreeKey<V>;

export class CollectionEntries<V> {
  readonly table: TableMap<HashTableKey, V> | undefined;
  private readonly hashBuckets = new Map<string, Set<HashTableKey>>();
  private readonly tree: BTree<V> | undefined;

  constructor(
    sorted: boolean,
    private readonly keyOf: (value: V) => Value
  ) {
    if (sorted) this.tree = new BTree(keyOf);
    else this.table = new TableMap();
  }

  get size(): number {
    return this.table?.size ?? this.tree!.size;
  }

  get hasTreeRoot(): boolean {
    return this.tree?.root !== undefined;
  }

  key(type: Type, value: Value): CollectionKey<V> {
    if (!this.table) return this.tree!.search(type, value);
    const hash = hashKey(type, value);
    const candidates = this.hashBuckets.get(hash);
    if (candidates) {
      for (const candidate of candidates) {
        const entry = this.table.get(candidate) as V;
        if (valuesEqual(type, value, this.keyOf(entry))) return candidate;
      }
    }
    return { hash };
  }

  get(key: CollectionKey<V>): V | undefined {
    if ('hash' in key) return this.table!.get(key);
    return key.present ? key.node!.entries[key.index] : undefined;
  }

  has(key: CollectionKey<V>): boolean {
    return 'hash' in key ? this.table!.has(key) : key.present;
  }

  set(key: CollectionKey<V>, value: V): void {
    if (!('hash' in key)) {
      this.tree!.write(key, value);
      return;
    }
    const candidates = this.hashBuckets.get(key.hash);
    if (candidates) candidates.add(key);
    else this.hashBuckets.set(key.hash, new Set([key]));
    this.table!.set(key, value);
  }

  delete(key: CollectionKey<V>): boolean {
    if (!('hash' in key)) return this.tree!.remove(key);
    if (!this.table!.delete(key)) return false;
    const candidates = this.hashBuckets.get(key.hash);
    candidates?.delete(key);
    if (candidates?.size === 0) this.hashBuckets.delete(key.hash);
    return true;
  }

  clear(): void {
    this.table?.clear();
    this.hashBuckets.clear();
    this.tree?.clear();
  }

  values(): IterableIterator<V> {
    return this.table?.values() ?? this.tree!.values();
  }

  snapshot(): V[] {
    allocateCollectionSnapshot(this.size);
    return [...this.values()];
  }

  appendOrdered(value: V): void {
    this.tree!.appendOrdered(value);
  }

  rangeRanks(type: Type, start: RangeEndpoint | undefined, end: RangeEndpoint | undefined): [number, number] {
    return this.tree!.rangeRanks(type, start, end);
  }

  entryAt(rank: number): V {
    return this.tree!.entryAt(rank);
  }

  retain(keep: (value: V) => boolean): void {
    if (this.table) {
      for (const [key, value] of this.table) if (!keep(value)) this.delete(key);
    } else this.tree!.retain(keep);
  }

  getEdge(first: boolean): V | undefined {
    return this.tree!.getEdge(first);
  }

  edgeKey(first: boolean): CollectionKey<V> | undefined {
    return this.tree!.edgeKey(first);
  }

  takeEdge(first: boolean): V | undefined {
    return this.tree!.takeEdge(first);
  }

  copyFrom(source: CollectionEntries<V>, clone: (value: V) => V): void {
    if (this.table && source.table) {
      for (const [key, value] of source.table) this.set(key, clone(value));
      this.table.copyTable(source.table);
    } else this.tree!.copyFrom(source.tree!, clone);
  }
}
