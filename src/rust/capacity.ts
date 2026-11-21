import { utf8Length } from './utf8';
import { isPlace, type Place, StringValue, textOf, type Value } from './values';

/**
 * The capacities of the collections: as `RawVec` grows a `Vec`, a `VecDeque`, and a `BinaryHeap`, whose arrays do not
 * hold it, and as hashbrown sizes the table of a `HashMap` and a `HashSet`. An array without an entry here has as
 * much capacity as length, as a `Vec` built at its size has (`vec!`, `clone`, an exact-size `collect`).
 */

const vecCapacities = new WeakMap<object, number>();

/** The capacity of a `Vec`, a `VecDeque`, or a `BinaryHeap`, whose elements are `elemSize` bytes each. */
export function vecCapacity(items: object, len: number, elemSize: number): number {
  return elemSize === 0 ? Number.MAX_SAFE_INTEGER : (vecCapacities.get(items) ?? len);
}

export function setVecCapacity(items: object, capacity: number): void {
  vecCapacities.set(items, capacity);
}

/** Notes the capacity before a collection's length changes, which it keeps when the length falls. */
export function keepVecCapacity(items: object, len: number): void {
  if (!vecCapacities.has(items)) vecCapacities.set(items, len);
}

/** `RawVec::reserve`: when the spare capacity is too small, grows to `max(2 * capacity, len + additional)`. */
export function reserveVec(items: object, len: number, additional: number, elemSize: number): void {
  const capacity = vecCapacities.get(items) ?? len;
  vecCapacities.set(items, elemSize === 0 ? capacity : reservedCapacity(capacity, len, additional, elemSize));
}

/** The capacity after `RawVec::reserve`, which grows to at least `MIN_NON_ZERO_CAP` and twice what it was. */
export function reservedCapacity(capacity: number, len: number, additional: number, elemSize: number): number {
  if (additional <= capacity - len) return capacity;
  return Math.max(minNonZeroCapacity(elemSize), capacity * 2, len + additional);
}

/** `RawVec::reserve_exact`: when the spare capacity is too small, grows to exactly `len + additional`. */
export function reserveVecExact(items: object, len: number, additional: number): void {
  const capacity = vecCapacities.get(items) ?? len;
  vecCapacities.set(items, additional <= capacity - len ? capacity : len + additional);
}

/** `shrink_to`: lowers the capacity to `max(len, min)` when it is above that. */
export function shrinkVec(items: object, len: number, min: number): void {
  const capacity = vecCapacities.get(items) ?? len;
  vecCapacities.set(items, Math.min(capacity, Math.max(len, min)));
}

/** The buffer of each `Vec`'s `into_iter`, which `collect` may reuse in place. */
const intoIterBuffers = new WeakMap<object, { capacity: number; elem: Layout }>();

interface Layout {
  size: number;
  align: number;
}

export function setIntoIterBuffer(iter: object, capacity: number, elem: Layout): void {
  intoIterBuffers.set(iter, { capacity, elem });
}

/**
 * The capacity of a `Vec` that `collect` makes in the buffer of the `Vec` whose `into_iter` it reads, as std does when
 * the elements have the same alignment and are no larger: all the bytes of that buffer.
 */
export function inPlaceCapacity(iter: object, elem: Layout): number | undefined {
  const buffer = intoIterBuffers.get(iter);
  if (!buffer || elem.size === 0 || buffer.elem.size === 0) return undefined;
  if (buffer.elem.align !== elem.align || buffer.elem.size < elem.size) return undefined;
  return Math.floor((buffer.capacity * buffer.elem.size) / elem.size);
}

function minNonZeroCapacity(elemSize: number): number {
  if (elemSize === 1) return 8;
  return elemSize <= 1024 ? 4 : 1;
}

export function stringCapacity(value: Value): number {
  return stringLayout(value).capacity;
}

export function stringByteLength(value: Value): number {
  return stringLayout(value).byteLength;
}

function stringLayout(value: Value): StringValue {
  let stored = value;
  while (isPlace(stored)) stored = stored.get();
  if (stored instanceof StringValue) return stored;
  const text = textOf(stored);
  const bytes = utf8Length(text);
  return new StringValue(text, bytes, bytes);
}

export function changeString(place: Place, change: () => void): void {
  const { byteLength, capacity } = stringLayout(place);
  change();
  const result = stringLayout(place);
  const updated = reservedCapacity(capacity, byteLength, result.byteLength - byteLength, 1);
  place.set(madeString(result.text, updated, result.byteLength));
}

export function setStringCapacity(place: Place, capacity: number): void {
  const { text, byteLength } = stringLayout(place);
  place.set(madeString(text, capacity, byteLength));
}

export class StringGrowth {
  constructor(
    private capacity = 0,
    private length = 0
  ) {}

  reserve(additional: number): void {
    this.capacity = reservedCapacity(this.capacity, this.length, additional, 1);
  }

  write(text: string, added = utf8Length(text)): void {
    this.writeBytes(added);
  }

  writeBytes(added: number): void {
    this.reserve(added);
    this.length += added;
  }

  finish(text: string): StringValue {
    return madeString(text, this.capacity, this.length);
  }

  store(place: Place, text: string): void {
    place.set(this.finish(text));
  }
}

export function madeString(text: string, capacity: number, length = utf8Length(text)): StringValue {
  return new StringValue(text, capacity, length);
}

export function concatStrings(left: Value, right: Value): StringValue {
  const a = stringLayout(left);
  const b = stringLayout(right);
  const capacity = reservedCapacity(a.capacity, a.byteLength, b.byteLength, 1);
  return madeString(a.text + b.text, capacity, a.byteLength + b.byteLength);
}

// ---------------------------------------------------------------------------------------------------------------------
// hashbrown

/**
 * The entries of a `HashMap` or a `HashSet`, whose table grows and shrinks as hashbrown's does, which gives
 * `capacity()`: the elements plus the room left before the table grows.
 */
export class TableMap<K, V> extends Map<K, V> {
  /** The size of a key and its value, by which hashbrown makes tables of tiny entries larger. */
  entrySize = 8;
  /** The number of buckets, a power of two, or 0 for the empty table that allocates nothing. */
  private buckets = 0;
  /** How many more elements fit before the table grows. */
  private growthLeft = 0;

  get capacity(): number {
    return this.size + this.growthLeft;
  }

  override set(key: K, value: V): this {
    if (!this.has(key)) {
      if (this.growthLeft === 0) this.reserveRehash(1);
      this.growthLeft--;
    }
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    const deleted = super.delete(key);
    if (deleted) this.growthLeft++;
    return deleted;
  }

  override clear(): void {
    super.clear();
    this.growthLeft = bucketMaskToCapacity(this.buckets - 1);
  }

  /** `with_capacity`: the smallest table that holds `capacity` elements. */
  allocate(capacity: number): void {
    this.buckets = capacity === 0 ? 0 : capacityToBuckets(capacity, this.entrySize);
    this.growthLeft = bucketMaskToCapacity(this.buckets - 1) - this.size;
  }

  /** A copy's table, which `clone` gives the same buckets. */
  copyTable(source: TableMap<K, V>): void {
    this.entrySize = source.entrySize;
    this.buckets = source.buckets;
    this.growthLeft = source.growthLeft;
  }

  reserve(additional: number): void {
    if (additional > this.growthLeft) this.reserveRehash(additional);
  }

  /** `shrink_to(min)`: the smallest table that holds the elements and `min`, when that is smaller. */
  shrinkTo(min: number): void {
    const minSize = Math.max(this.size, min);
    const buckets = minSize === 0 ? 0 : capacityToBuckets(minSize, this.entrySize);
    if (buckets < this.buckets) {
      this.buckets = buckets;
      this.growthLeft = bucketMaskToCapacity(buckets - 1) - this.size;
    }
  }

  /** Rehashes in place when at most half full with the new elements, and otherwise moves to a larger table. */
  private reserveRehash(additional: number): void {
    const newItems = this.size + additional;
    const fullCapacity = bucketMaskToCapacity(this.buckets - 1);
    if (newItems <= Math.floor(fullCapacity / 2)) {
      this.growthLeft = fullCapacity - this.size;
      return;
    }
    this.buckets = capacityToBuckets(Math.max(newItems, fullCapacity + 1), this.entrySize);
    this.growthLeft = bucketMaskToCapacity(this.buckets - 1) - this.size;
  }
}

/** Gives a new map's or set's table the size of its entries, or the table it copies, when it has one. */
export function sizeTable(entries: TableMap<unknown, unknown> | undefined, size: number): void {
  if (entries) entries.entrySize = size;
}

/**
 * The buckets for a capacity: at least 4, at least 8 past 3, and past 7 the power of two that keeps the table 7/8 full.
 * Tables of entries of up to one byte start larger, as hashbrown pads them to its group width of 8 on this target.
 */
function capacityToBuckets(capacity: number, entrySize: number): number {
  if (capacity < 15) {
    const smallest = Math.max(entrySize <= 1 ? 7 : 3, capacity);
    if (smallest < 4) return 4;
    if (smallest < 8) return 8;
  }
  return 2 ** Math.ceil(Math.log2(Math.floor((capacity * 8) / 7)));
}

function bucketMaskToCapacity(bucketMask: number): number {
  if (bucketMask < 0) return 0;
  return bucketMask < 8 ? bucketMask : ((bucketMask + 1) / 8) * 7;
}
