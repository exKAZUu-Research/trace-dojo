import type { Key, Ref, Value } from './values';

type Slot = Value | Ref;

export class ArrayTable extends Map<Key, Slot> {
  private packed?: Slot[];
  private readonly holders = new Map<object, number>();

  constructor(
    entries?: Iterable<readonly [Key, Slot]>,
    private readonly onMaterialize?: () => void
  ) {
    super();
    if (entries) for (const [key, slot] of entries) super.set(key, slot);
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
    return super.set(key, value);
  }

  override delete(key: Key): boolean {
    this.materialize();
    return super.delete(key);
  }

  override clear(): void {
    this.packed = undefined;
    this.holders.clear();
    super.clear();
  }

  private materialize(): void {
    if (!this.packed) return;
    const values = this.packed;
    this.packed = undefined;
    this.holders.clear();
    super.clear();
    for (let index = 0; index < values.length; index++) super.set(BigInt(index), values[index]);
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
