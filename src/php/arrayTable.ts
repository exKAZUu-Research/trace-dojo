import type { Key, Ref, Value } from './values';

type Slot = Value | Ref;

export class ArrayTable extends Map<Key, Slot> {
  private packed?: Slot[];
  private integerKeys = 0;
  private readonly holders = new Map<object, number>();

  constructor(
    entries?: Iterable<readonly [Key, Slot]>,
    private readonly onMaterialize?: () => void
  ) {
    super();
    if (entries)
      for (const [key, slot] of entries) {
        if (typeof key === 'bigint' && !super.has(key)) this.integerKeys++;
        super.set(key, slot);
      }
  }

  hasIntegerKeys(): boolean {
    return this.packed ? this.packed.length > 0 : this.integerKeys > 0;
  }

  spliceList(start: number, count: number, replacement: Slot[]): Slot[] | undefined {
    if (!this.pack()) return;
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
    const slot = (this.packed as Slot[]).shift() as Slot;
    this.count(slot, -1);
    return { slot };
  }

  prependList(values: Slot[]): boolean {
    if (!this.pack()) return false;
    for (let end = values.length; end > 0; end -= 4096)
      (this.packed as Slot[]).unshift(...values.slice(Math.max(0, end - 4096), end));
    for (const value of values) this.count(value, 1);
    return true;
  }

  private pack(): boolean {
    if (this.packed) return true;
    let index = 0n;
    for (const key of super.keys()) if (key !== index++) return false;
    this.packed = [...super.values()];
    for (const value of this.packed) this.count(value, 1);
    return true;
  }

  private count(value: Slot, difference: number): void {
    if (value === null || typeof value !== 'object') return;
    const count = (this.holders.get(value) ?? 0) + difference;
    if (count) this.holders.set(value, count);
    else this.holders.delete(value);
  }

  packedValueCount(value: object): number | undefined {
    return this.packed ? (this.holders.get(value) ?? 0) : undefined;
  }

  hasValue(value: object, key: Key): boolean {
    return this.packed ? this.holders.has(value) : super.get(key) === value;
  }

  override get size(): number {
    return this.packed?.length ?? super.size;
  }

  override get(key: Key): Slot | undefined {
    return this.packed ? (typeof key === 'bigint' && key >= 0n ? this.packed[Number(key)] : undefined) : super.get(key);
  }

  override has(key: Key): boolean {
    return this.packed ? typeof key === 'bigint' && key >= 0n && key < BigInt(this.packed.length) : super.has(key);
  }

  override set(key: Key, value: Slot): this {
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
    this.packed = undefined;
    this.holders.clear();
    this.integerKeys = 0;
    super.clear();
  }

  private materialize(): void {
    if (!this.packed) return;
    const values = this.packed;
    this.packed = undefined;
    this.holders.clear();
    super.clear();
    for (let index = 0; index < values.length; index++) super.set(BigInt(index), values[index]);
    this.integerKeys = values.length;
    this.onMaterialize?.();
  }

  override *entries(): MapIterator<[Key, Slot]> {
    const values = this.packed;
    if (values) for (let index = 0; index < values.length; index++) yield [BigInt(index), values[index]];
    else yield* super.entries();
  }

  override *keys(): MapIterator<Key> {
    const values = this.packed;
    if (values) for (let index = 0; index < values.length; index++) yield BigInt(index);
    else yield* super.keys();
  }

  override *values(): MapIterator<Slot> {
    yield* this.packed ?? super.values();
  }

  override [Symbol.iterator](): MapIterator<[Key, Slot]> {
    return this.entries();
  }

  override forEach(callback: (value: Slot, key: Key, map: Map<Key, Slot>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
}
