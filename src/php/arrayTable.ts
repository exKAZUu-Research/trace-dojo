import { replaceWatchedSlot, replaceWatchedSlots } from './slotWatch';
import { type Key, type PhpArray, type Ref, UNDEFINED_RESULT, type Value } from './values';

type Slot = Value | Ref;

export class ArrayTable extends Map<Key, Slot> {
  private packed?: Slot[];
  private releasedKeys?: Set<Key>;
  private integerKeys = 0;
  mayHaveUndefinedSlots = false;
  removedUndefinedSlots = 0;
  private readonly holders = new Map<object, number>();

  constructor(
    entries?: Iterable<readonly [Key, Slot]>,
    private readonly onMaterialize?: () => void
  ) {
    super();
    if (entries)
      for (const [key, slot] of entries) {
        if (slot === UNDEFINED_RESULT) this.mayHaveUndefinedSlots = true;
        if (typeof key === 'bigint' && !super.has(key)) this.integerKeys++;
        super.set(key, slot);
      }
  }

  hasIntegerKeys(): boolean {
    return this.packed ? this.packed.length > 0 : this.integerKeys > 0;
  }

  get countsUndefinedSlots(): boolean {
    return this.mayHaveUndefinedSlots || this.removedUndefinedSlots > 0;
  }

  spliceList(start: number, count: number, replacement: Slot[]): Slot[] | undefined {
    if (!this.pack()) return;
    replaceWatchedSlots(this, BigInt(start));
    const values = this.packed as Slot[];
    const removed = values.splice(start, count);
    for (let index = 0; index < replacement.length; index += 4096)
      values.splice(start + index, 0, ...replacement.slice(index, index + 4096));
    for (const slot of removed) this.count(slot, -1);
    for (const slot of replacement) this.count(slot, 1);
    return removed;
  }

  shiftList(): { slot: Slot } | undefined {
    if (!this.pack() || this.size === 0) return;
    replaceWatchedSlots(this);
    const slot = (this.packed as Slot[]).shift() as Slot;
    this.count(slot, -1);
    return { slot };
  }

  prependList(values: Slot[]): boolean {
    if (!this.pack()) return false;
    if (values.length > 0) replaceWatchedSlots(this);
    for (let end = values.length; end > 0; end -= 4096)
      (this.packed as Slot[]).unshift(...values.slice(Math.max(0, end - 4096), end));
    for (const value of values) this.count(value, 1);
    return true;
  }

  private pack(): boolean {
    if (this.countsUndefinedSlots) return false;
    if (this.packed) return true;
    let index = 0n;
    for (const key of super.keys()) if (key !== index++) return false;
    this.packed = [...super.values()];
    for (const value of this.packed) this.count(value, 1);
    super.clear();
    return true;
  }

  private count(value: Slot, difference: number): void {
    if (value === null || typeof value !== 'object') return;
    const count = (this.holders.get(value) ?? 0) + difference;
    if (count) this.holders.set(value, count);
    else this.holders.delete(value);
  }

  packedValueCount(value: object): number | undefined {
    return this.packed && !this.releasedKeys?.size ? (this.holders.get(value) ?? 0) : undefined;
  }

  hasValue(value: object, key: Key): boolean {
    const packed = this.packedValueCount(value);
    return packed === undefined ? this.ownedSlot(key) === value : packed > 0;
  }

  ownedSlot(key: Key): Slot | undefined {
    return this.releasedKeys?.has(key) ? undefined : this.get(key);
  }

  ownedSlots(): IterableIterator<Slot> {
    return this.releasedKeys?.size ? this.unreleasedSlots() : this.values();
  }

  private *unreleasedSlots(): IterableIterator<Slot> {
    for (const [key, slot] of this) if (!this.releasedKeys?.has(key)) yield slot;
  }

  releaseSlot(key: Key): Slot | undefined {
    const slot = this.ownedSlot(key);
    if (slot !== null && typeof slot === 'object') {
      this.releasedKeys ??= new Set();
      this.releasedKeys.add(key);
    }
    return slot;
  }

  override get size(): number {
    return (this.packed?.length ?? super.size) + this.removedUndefinedSlots;
  }

  override get(key: Key): Slot | undefined {
    return this.packed ? (typeof key === 'bigint' && key >= 0n ? this.packed[Number(key)] : undefined) : super.get(key);
  }

  override has(key: Key): boolean {
    return this.packed ? typeof key === 'bigint' && key >= 0n && key < BigInt(this.packed.length) : super.has(key);
  }

  override set(key: Key, value: Slot): this {
    replaceWatchedSlot(this, key);
    this.releasedKeys?.delete(key);
    if (value === UNDEFINED_RESULT) this.mayHaveUndefinedSlots = true;
    if (this.packed && typeof key === 'bigint' && key >= 0n && key <= BigInt(this.packed.length)) {
      const index = Number(key);
      const old = this.packed[index];
      if (old !== undefined) this.count(old, -1);
      this.packed[index] = value;
      this.count(value, 1);
      return this;
    }
    this.materialize();
    if (!super.has(key) && typeof key === 'bigint') this.integerKeys++;
    return super.set(key, value);
  }

  override delete(key: Key): boolean {
    replaceWatchedSlot(this, key);
    this.releasedKeys?.delete(key);
    if (this.packed && this.packed.length > 0 && key === BigInt(this.packed.length - 1)) {
      this.count(this.packed.pop() as Slot, -1);
      return true;
    }
    this.materialize();
    const removed = super.delete(key);
    if (removed && typeof key === 'bigint') this.integerKeys--;
    return removed;
  }

  override clear(): void {
    replaceWatchedSlots(this);
    this.releasedKeys = undefined;
    this.packed = undefined;
    this.holders.clear();
    this.integerKeys = 0;
    this.mayHaveUndefinedSlots = false;
    this.removedUndefinedSlots = 0;
    super.clear();
  }

  private materialize(): void {
    if (!this.packed) return;
    const values = this.packed;
    this.packed = undefined;
    this.holders.clear();
    for (let index = 0; index < values.length; index++) super.set(BigInt(index), values[index]);
    this.integerKeys = values.length;
    this.onMaterialize?.();
  }

  *physicalEntries(): MapIterator<[Key, Slot]> {
    const values = this.packed;
    if (values) for (let index = 0; index < values.length; index++) yield [BigInt(index), values[index]];
    else yield* super.entries();
  }

  *physicalKeys(): MapIterator<Key> {
    const values = this.packed;
    if (values) for (let index = 0; index < values.length; index++) yield BigInt(index);
    else yield* super.keys();
  }

  override entries(): MapIterator<[Key, Slot]> {
    if (this.mayHaveUndefinedSlots) return this.visibleEntries();
    return this.packed ? this.physicalEntries() : super.entries();
  }

  private *visibleEntries(): MapIterator<[Key, Slot]> {
    for (const entry of this.physicalEntries()) if (entry[1] !== UNDEFINED_RESULT) yield entry;
  }

  override *keys(): MapIterator<Key> {
    if (!this.mayHaveUndefinedSlots) yield* this.physicalKeys();
    else for (const [key] of this) yield key;
  }

  override *values(): MapIterator<Slot> {
    if (!this.mayHaveUndefinedSlots) yield* this.packed ?? super.values();
    else for (const [, slot] of this) yield slot;
  }

  override [Symbol.iterator](): MapIterator<[Key, Slot]> {
    return this.entries();
  }

  override forEach(callback: (value: Slot, key: Key, map: Map<Key, Slot>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
}

export interface ArrayReadView {
  get(key: Key): Value | Ref | undefined;
  detached(): boolean;
}

interface ReadState {
  borrowers: number;
  detachedTable?: ArrayTable;
}

const reads = new WeakMap<PhpArray, ReadState>();

export function withArrayReadView<T>(array: PhpArray, use: (view: ArrayReadView) => T): T {
  const state = reads.get(array) ?? { borrowers: 0 };
  reads.set(array, state);
  state.borrowers++;
  try {
    return use({
      get: (key) => (state.detachedTable ? state.detachedTable.get(key) : array.getSlot(key)),
      detached: () => state.detachedTable !== undefined,
    });
  } finally {
    if (--state.borrowers === 0) reads.delete(array);
  }
}

export function detachArrayTable(array: PhpArray, retiring: boolean, createTable: () => ArrayTable): ArrayTable {
  const state = retiring ? reads.get(array) : undefined;
  if (state) {
    state.detachedTable = array.map;
    return createTable();
  }
  array.map.clear();
  return array.map;
}
