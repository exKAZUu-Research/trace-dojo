import { hashOf, valueEquals } from '../format';
import type { Frame } from '../runtime';
import { type HashEntry, KStore, type Value } from '../values';
import { throwError } from './registry';

export class BuilderStore extends KStore {
  private buckets = new Map<number, HashEntry>();
  private readonly positions = new WeakMap<HashEntry, number>();
  private used = 0;
  private maxProbe = 2;
  private tableSize: number;

  constructor(
    private entryCapacity: number,
    private readonly onStructuralChange: () => void
  ) {
    super();
    this.order = 'insertion';
    this.tableSize = builderTableSize(entryCapacity);
  }

  lookup(frame: Frame, key: Value): HashEntry | undefined {
    return this.probe(frame, key, false)?.entry;
  }

  addKey(frame: Frame, key: Value): { entry: HashEntry; added: boolean } {
    for (;;) {
      const position = this.probe(frame, key, true);
      if (!position) this.rehash(frame, this.tableSize * 2);
      else {
        const { entry, slot, distance } = position;
        if (entry) return { entry, added: false };
        if (this.used < this.entryCapacity) return this.insertKey(frame, key, slot, distance);
        this.reserve(frame, 1);
      }
    }
  }

  private probe(
    frame: Frame,
    key: Value,
    inserting: boolean
  ): { entry: HashEntry | undefined; slot: number; distance: number } | undefined {
    let slot = this.hashSlot(frame, key);
    const maxDistance = inserting ? Math.min(2 * this.maxProbe, this.tableSize / 2) : this.maxProbe;
    for (let distance = 0; distance <= maxDistance; distance++) {
      frame.runtime.spend();
      const entry = this.buckets.get(slot);
      if (!entry || valueEquals(frame, entry.key, key)) return { entry, slot, distance };
      slot = this.previousSlot(slot);
    }
    return undefined;
  }

  private insertKey(frame: Frame, key: Value, slot: number, distance: number): { entry: HashEntry; added: true } {
    frame.runtime.allocate(frame, 2);
    const entry: HashEntry = { key, value: undefined, hash: 0 };
    this.insertAt(this.entries.length, entry);
    this.used++;
    this.setBucket(slot, entry);
    this.onStructuralChange();
    this.maxProbe = Math.max(this.maxProbe, distance);
    return { entry, added: true };
  }

  reserve(frame: Frame, extra: number): void {
    const required = this.used + extra;
    if (required <= this.entryCapacity) return;
    const deleted = this.used - this.entries.length;
    if (required - deleted <= this.entryCapacity && deleted >= Math.floor(this.entryCapacity / 4)) {
      this.used = this.entries.length;
      return;
    }
    const next = Math.max(required, Math.floor(this.entryCapacity * 1.5));
    frame.runtime.allocate(frame, next - this.entryCapacity);
    this.entryCapacity = next;
    const tableSize = builderTableSize(next);
    if (tableSize > this.tableSize) this.rehash(frame, tableSize);
  }

  private rehash(frame: Frame, size: number): void {
    frame.runtime.allocate(frame, size - this.tableSize);
    this.onStructuralChange();
    this.used = this.entries.length;
    this.tableSize = size;
    this.buckets = new Map();
    for (let index = 0; index < this.entries.length; index++) this.reinsert(frame, this.entries[index]);
  }

  private reinsert(frame: Frame, entry: HashEntry): void {
    let slot = this.hashSlot(frame, entry.key);
    for (let distance = 0; distance <= this.maxProbe; distance++) {
      frame.runtime.spend();
      if (!this.buckets.has(slot)) {
        this.setBucket(slot, entry);
        return;
      }
      slot = this.previousSlot(slot);
    }
    throwError(
      frame,
      'java.lang.IllegalStateException',
      'This cannot happen with fixed magic multiplier and grow-only hash array. Have object hashCodes changed?'
    );
  }

  removeKeyEntry(frame: Frame, entry: HashEntry): void {
    const slot = this.positions.get(entry);
    if (slot === undefined) return;
    entry.key = entry.value = undefined;
    this.closeGap(frame, slot);
    this.positions.delete(entry);
    this.remove(entry);
    this.onStructuralChange();
  }

  private closeGap(frame: Frame, gap: number): void {
    let slot = gap;
    let distance = 0;
    for (;;) {
      frame.runtime.spend();
      slot = this.previousSlot(slot);
      const neighbor = this.buckets.get(slot);
      if (++distance > this.maxProbe || !neighbor) break;
      const fromHome = (this.hashSlot(frame, neighbor.key) - slot) & (this.tableSize - 1);
      if (fromHome >= distance) {
        this.setBucket(gap, neighbor);
        gap = slot;
        distance = 0;
      }
    }
    this.buckets.delete(gap);
  }

  clearKeys(): void {
    this.entries = [];
    this.buckets.clear();
    this.used = 0;
    this.onStructuralChange();
  }

  private hashSlot(frame: Frame, key: Value): number {
    const hash = hashOf(frame, key);
    return Math.imul(hash, -1_640_531_527) >>> (Math.clz32(this.tableSize) + 1);
  }

  private previousSlot(slot: number): number {
    return (slot - 1) & (this.tableSize - 1);
  }

  private setBucket(slot: number, entry: HashEntry): void {
    this.buckets.set(slot, entry);
    this.positions.set(entry, slot);
  }
}

function builderTableSize(capacity: number): number {
  return 2 ** (31 - Math.clz32(3 * Math.max(1, capacity)));
}
