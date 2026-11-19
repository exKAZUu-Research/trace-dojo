import { ElementPlace, EnumValue, isPlace, type Place, StructValue, type Value } from './values';

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

/**
 * The capacity `Vec::from_iter` gives `count` elements from an iterator that is not `TrustedLen`: room for the first
 * and the size hint's lower bound, then growth whenever full by the bound at that point plus one. `lowerAfter(i)` is
 * the bound after `i` elements are taken.
 */
export function collectedVecCapacity(count: number, elemSize: number, lowerAfter: (taken: number) => number): number {
  if (count === 0) return 0;
  const min = minNonZeroCapacity(elemSize);
  let capacity = Math.max(min, lowerAfter(1) + 1);
  for (let len = 1; len < count; len++) {
    if (len === capacity) capacity = Math.max(min, capacity * 2, len + lowerAfter(len + 1) + 1);
  }
  return capacity;
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

/**
 * The capacities of `String`s, whose values are JS strings that cannot carry one: by where each is stored, for the
 * text it had when its capacity last changed there. A string stored elsewhere, or changed since by assignment, has as
 * much capacity as length, as a `String` made at its size has (`String::from`, `to_string`, `format!`).
 */
const stringCapacities = new WeakMap<object, Map<number, { text: string; capacity: number }>>();

/** The capacity of the `String` a value is, or a place holds. */
export function stringCapacity(value: Value): number {
  const text = (isPlace(value) ? value.get() : value) as string;
  const storage = isPlace(value) ? value.storage?.() : undefined;
  const entry = storage && stringCapacities.get(storage[0])?.get(storage[1]);
  return entry?.text === text ? entry.capacity : utf8Length(text);
}

/** Changes the `String` in a place, first making room for what the change adds as `RawVec::reserve` does. */
export function changeString(place: Place, change: () => void): void {
  const len = utf8Length(place.get() as string);
  const capacity = stringCapacity(place);
  change();
  const added = utf8Length(place.get() as string) - len;
  setStringCapacity(place, added > 0 ? reservedCapacity(capacity, len, added, 1) : capacity);
}

/** Sets the capacity of the `String` a place holds. */
export function setStringCapacity(place: Place, capacity: number): void {
  const storage = place.storage?.();
  if (!storage) return;
  let entries = stringCapacities.get(storage[0]);
  if (!entries) {
    entries = new Map();
    stringCapacities.set(storage[0], entries);
  }
  entries.set(storage[1], { text: place.get() as string, capacity });
}

/**
 * The `String`s in flight in the current statement with a capacity other than their length, by their text: made by
 * `String::with_capacity`, an integer's `to_string`, or `a + b`, or moved out of where they were stored. The place
 * that stores one next (a variable, a parameter, a field, an element) claims its capacity.
 */
const inFlight = new Map<string, number>();

export function madeString(text: string, capacity: number): string {
  if (capacity === utf8Length(text)) inFlight.delete(text);
  else inFlight.set(text, capacity);
  return text;
}

/** A `String` moved out of a place takes its capacity along, as do the `String` fields of a struct or an enum. */
export function moveString(place: Place): void {
  const value = place.get();
  if (typeof value === 'string') madeString(value, stringCapacity(place));
  else if (value instanceof StructValue || value instanceof EnumValue) {
    for (let index = 0; index < value.fields.length; index++) {
      if (typeof value.fields[index] === 'string') moveString(new ElementPlace(value.fields, index));
    }
  }
}

/** At the start of a statement: the strings in flight before it have been stored or dropped. */
export function settleStrings(): void {
  if (inFlight.size > 0) inFlight.clear();
}

/** A place that stores a `String` in flight keeps the capacity it had. */
export function claimString(place: Place): void {
  if (inFlight.size === 0) return;
  const text = place.get();
  const capacity = typeof text === 'string' ? inFlight.get(text) : undefined;
  if (capacity === undefined) return;
  setStringCapacity(place, capacity);
  inFlight.delete(text as string);
}

/** The elements of a new struct, tuple, array, or `Vec` that are `String`s in flight keep their capacities. */
export function claimStrings(elements: Value[]): Value[] {
  if (inFlight.size > 0)
    for (let index = 0; index < elements.length; index++) claimString(new ElementPlace(elements, index));
  return elements;
}

/** `a + b` of a `String` and a `&str`, which pushes onto `a` and so grows it as `push_str` does. */
export function concatStrings(left: string, right: string): string {
  const capacity = inFlight.get(left) ?? utf8Length(left);
  return madeString(left + right, reservedCapacity(capacity, utf8Length(left), utf8Length(right), 1));
}

export function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    length += code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
  }
  return length;
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
export function sizeTable(entries: Map<unknown, unknown>, size: number, source?: Map<unknown, unknown>): void {
  if (!(entries instanceof TableMap)) return;
  if (source instanceof TableMap) entries.copyTable(source);
  else entries.entrySize = size;
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
