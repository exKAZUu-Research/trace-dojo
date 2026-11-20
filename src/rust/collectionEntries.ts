import { TableMap } from './capacity';
import { allocateCollectionSnapshot, compareValues, hashKey, spendCollectionWork } from './ops';
import type { Type } from './types';
import type { Value } from './values';

export type CollectionKey = string | { index: number; present: boolean };

export class CollectionEntries<V> {
  readonly table: TableMap<string, V> | undefined;
  private readonly ordered: V[] = [];
  private treeRoot = false;

  constructor(
    sorted: boolean,
    private readonly keyOf: (value: V) => Value
  ) {
    this.table = sorted ? undefined : new TableMap();
  }

  get size(): number {
    return this.table?.size ?? this.ordered.length;
  }

  get hasTreeRoot(): boolean {
    return this.treeRoot;
  }

  key(type: Type, value: Value): CollectionKey {
    return this.table ? hashKey(type, value) : this.orderedKey(type, value);
  }

  private orderedKey(type: Type, value: Value, start = 0): Exclude<CollectionKey, string> {
    const compare = (index: number): number => compareValues(type, value, this.keyOf(this.ordered[index])) ?? 0;
    if (this.ordered.length <= 11) {
      for (let index = start; index < this.ordered.length; index++) {
        const order = compare(index);
        if (order <= 0) return { index, present: order === 0 };
      }
      return { index: this.ordered.length, present: false };
    }
    let first = start;
    let last = this.ordered.length;
    while (first < last) {
      const index = first + Math.floor((last - first) / 2);
      const order = compare(index);
      if (order === 0) return { index, present: true };
      if (order < 0) last = index;
      else first = index + 1;
    }
    return { index: first, present: false };
  }

  get(key: CollectionKey): V | undefined {
    if (typeof key === 'string') return this.table!.get(key);
    return key.present ? this.ordered[key.index] : undefined;
  }

  has(key: CollectionKey): boolean {
    return typeof key === 'string' ? this.table!.has(key) : key.present;
  }

  set(key: CollectionKey, value: V): void {
    if (typeof key === 'string') {
      this.table!.set(key, value);
      return;
    }
    if (!key.present) this.chargeShift(key.index);
    this.ordered.splice(key.index, key.present ? 1 : 0, value);
    key.present = true;
    this.treeRoot = true;
  }

  delete(key: CollectionKey): boolean {
    if (typeof key === 'string') return this.table!.delete(key);
    if (!key.present) return false;
    this.chargeShift(key.index);
    this.ordered.splice(key.index, 1);
    key.present = false;
    return true;
  }

  clear(): void {
    this.table?.clear();
    this.ordered.length = 0;
    this.treeRoot = false;
  }

  values(): IterableIterator<V> {
    return this.table?.values() ?? this.ordered.values();
  }

  snapshot(): V[] {
    allocateCollectionSnapshot(this.size);
    return [...this.values()];
  }

  appendOrdered(value: V): void {
    this.ordered.push(value);
    this.treeRoot = true;
  }

  range(type: Type, start: Value, end: Value, inclusive: boolean): V[] {
    const first = start === undefined ? 0 : this.orderedKey(type, start).index;
    const last = end === undefined ? undefined : this.orderedKey(type, end, first);
    const after = last ? last.index + Number(inclusive && last.present) : this.size;
    allocateCollectionSnapshot(after - first);
    return this.ordered.slice(first, after);
  }

  retain(keep: (value: V) => boolean): void {
    if (this.table) {
      for (const [key, value] of this.table) if (!keep(value)) this.table.delete(key);
      return;
    }
    for (let index = 0; index < this.ordered.length;) {
      if (keep(this.ordered[index])) index++;
      else {
        this.chargeShift(index);
        this.ordered.splice(index, 1);
      }
    }
  }

  takeEdge(first: boolean): V | undefined {
    if (first) this.chargeShift(0);
    return first ? this.ordered.shift() : this.ordered.pop();
  }

  private chargeShift(index: number): void {
    spendCollectionWork(Math.ceil((this.ordered.length - index) / 64));
  }

  copyFrom(source: CollectionEntries<V>, clone: (value: V) => V): void {
    if (this.table && source.table) {
      for (const [key, value] of source.table) this.table.set(key, clone(value));
      this.table.copyTable(source.table);
    } else {
      for (const value of source.ordered) this.ordered.push(clone(value));
      this.treeRoot = this.ordered.length > 0;
    }
  }
}
