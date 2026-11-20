import { BTree, type TreeKey } from './btree';
import { TableMap } from './capacity';
import { allocateCollectionSnapshot, hashKey } from './ops';
import type { Type } from './types';
import type { Value } from './values';

export type CollectionKey<V> = string | TreeKey<V>;

export class CollectionEntries<V> {
  readonly table: TableMap<string, V> | undefined;
  private readonly tree: BTree<V> | undefined;

  constructor(sorted: boolean, keyOf: (value: V) => Value) {
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
    return this.table ? hashKey(type, value) : this.tree!.search(type, value);
  }

  get(key: CollectionKey<V>): V | undefined {
    if (typeof key === 'string') return this.table!.get(key);
    return key.present ? key.node!.entries[key.index] : undefined;
  }

  has(key: CollectionKey<V>): boolean {
    return typeof key === 'string' ? this.table!.has(key) : key.present;
  }

  set(key: CollectionKey<V>, value: V): void {
    if (typeof key === 'string') this.table!.set(key, value);
    else this.tree!.write(key, value);
  }

  delete(key: CollectionKey<V>): boolean {
    return typeof key === 'string' ? this.table!.delete(key) : this.tree!.remove(key);
  }

  clear(): void {
    this.table?.clear();
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

  range(type: Type, start: Value, end: Value, inclusive: boolean): V[] {
    return this.tree!.range(type, start, end, inclusive);
  }

  retain(keep: (value: V) => boolean): void {
    if (this.table) {
      for (const [key, value] of this.table) if (!keep(value)) this.table.delete(key);
    } else this.tree!.retain(keep);
  }

  takeEdge(first: boolean): V | undefined {
    return this.tree!.takeEdge(first);
  }

  copyFrom(source: CollectionEntries<V>, clone: (value: V) => V): void {
    if (this.table && source.table) {
      for (const [key, value] of source.table) this.table.set(key, clone(value));
      this.table.copyTable(source.table);
    } else this.tree!.copyFrom(source.tree!, clone);
  }
}
