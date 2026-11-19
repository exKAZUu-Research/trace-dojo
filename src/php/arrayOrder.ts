// code-gauge-allow-file fileNcss 451 -- Keeps array bucket layout, mutations and their cursor positions together.
import type { Key } from './values';

class ArrayEntry {
  rawKey!: Key;
  rawIndex!: number;
  previous?: ArrayEntry;
  next?: ArrayEntry;

  constructor(
    private readonly order: ArrayOrder,
    key: Key,
    index: number
  ) {
    this.key = key;
    this.index = index;
  }

  get key(): Key {
    return typeof this.rawKey === 'bigint' ? this.rawKey - this.order.keyOffset : this.rawKey;
  }
  set key(key: Key) {
    this.rawKey = typeof key === 'bigint' ? key + this.order.keyOffset : key;
  }
  get index(): number {
    return this.rawIndex - this.order.indexOffset;
  }
  set index(index: number) {
    this.rawIndex = index + this.order.indexOffset;
  }
}

export interface SpliceRange {
  start: number;
  end: number;
  inserted: number;
}

type ArrayReindex = SpliceRange | 'shift' | { prepend: number };
interface ShiftedBuckets {
  positions: ReadonlyMap<Key, number>;
  keepPositions: boolean;
  packed: boolean;
}
export type ArrayRebuild = ArrayReindex | ShiftedBuckets;

interface CursorFamily {
  generation: number;
}

interface CursorPosition {
  cursor: ArrayCursor;
  index: number | undefined;
}

export class ArrayOrder {
  private readonly entries = new Map<Key, ArrayEntry>();
  private readonly buckets = new Map<number, ArrayEntry>();
  first: ArrayEntry | undefined;
  last: ArrayEntry | undefined;
  keyOffset = 0n;
  indexOffset = 0;
  storageVersion = 0;
  invalidPointer: number | undefined;
  private listLayout = false;
  private nextIndex = 0;
  private capacity = 8;
  private packed: boolean | undefined;
  private readonly cursors = new Set<WeakRef<ArrayCursor>>();
  private readonly cursorCopies = new WeakMap<CursorFamily, ArrayCursor>();

  constructor(keys: Iterable<Key>, capacityHint = 8, mixed = false) {
    if (mixed) this.packed = false;
    while (this.capacity < capacityHint) this.capacity *= 2;
    for (const key of keys) this.insert(key);
  }

  get(key: Key): ArrayEntry | undefined {
    return this.entries.get(typeof key === 'bigint' ? key + this.keyOffset : key);
  }

  keyAtBucket(index: number): Key | undefined {
    return this.buckets.get(index + this.indexOffset)?.key;
  }

  get isPacked(): boolean {
    return this.packed === true;
  }

  hasDensePackedStorage(): boolean {
    return this.isPacked && this.nextIndex === this.entries.size;
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  sampleKey(draw: (max: number) => number): Key {
    if (this.entries.size === this.nextIndex || this.entries.size < this.nextIndex - (this.nextIndex >> 1)) {
      let index = draw(this.entries.size - 1);
      for (const entry of this.orderedEntries()) {
        if (index-- === 0) return entry.key;
      }
    } else if (this.packed) {
      for (;;) {
        const key = BigInt(draw(this.nextIndex - 1));
        if (this.get(key)) return key;
      }
    } else {
      const buckets: (Key | undefined)[] = [];
      for (const entry of this.orderedEntries()) buckets[entry.index] = entry.key;
      for (;;) {
        const key = buckets[draw(this.nextIndex - 1)];
        if (key !== undefined) return key;
      }
    }
    throw new Error('Invalid array sampling index');
  }

  get endPosition(): number {
    return this.nextIndex;
  }

  cursor(
    key = this.first?.key,
    family?: CursorFamily,
    includes?: (key: Key) => boolean,
    physical = false
  ): ArrayCursor {
    const cursor = new ArrayCursor(this, key === undefined ? undefined : this.get(key), family, includes, physical);
    this.cursors.add(cursor.registration);
    return cursor;
  }

  unregisterCursor(cursor: ArrayCursor): void {
    this.cursors.delete(cursor.registration);
  }

  resumeCursor(key: Key | undefined, previous: ArrayCursor, retainPosition: boolean): ArrayCursor {
    const family = previous.family!;
    const saved = this.cursorCopies.get(family);
    const cursor = saved?.active ? saved : this.cursor(key, family);
    if (!saved?.active) {
      if (retainPosition) {
        const index = previous.index ?? 0;
        let entry = this.first;
        while (entry && entry.index < index) entry = entry.next;
        cursor.setPosition(entry, index);
      } else if (key === undefined) cursor.setPosition(undefined, this.nextIndex);
    }
    cursor.generation = ++family.generation;
    this.cursorCopies.delete(family);
    return cursor;
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Copies array layout and its active cursors using the same surviving buckets.
  copy(preservePositions: boolean, keys?: ReadonlyMap<Key, unknown>): ArrayOrder {
    const copy = new ArrayOrder([], this.capacity);
    for (const entry of this.orderedEntries())
      if (!keys || keys.has(entry.key)) copy.appendEntry(entry.key, entry.index);
    copy.nextIndex = this.nextIndex;
    copy.packed = this.packed;
    copy.listLayout = this.listLayout;
    if (copy.entries.size === 0) {
      copy.capacity = 8;
      copy.packed = undefined;
      copy.listLayout = false;
    } else if (!copy.packed && !preservePositions) copy.compact();
    for (const cursor of this.liveCursors()) {
      if (!cursor.family) continue;
      let entry = cursor.entry;
      while (entry && keys && !keys.has(entry.key)) entry = entry.next;
      const cloned = copy.cursor(entry?.key, cursor.family);
      if (entry === undefined) cloned.setPosition(undefined, cursor.index);
      else if (copy.packed || preservePositions) cloned.setPosition(cloned.entry, cursor.index);
      copy.cursorCopies.set(cursor.family, cloned);
    }
    return copy;
  }

  // code-gauge-allow functionCognitiveComplexity 26 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  insert(key: Key, count = this.entries.size): number | undefined {
    if (this.get(key)) return undefined;
    const numeric = typeof key === 'bigint' && key >= 0n && key < BigInt(Number.MAX_SAFE_INTEGER);
    const position = numeric ? Number(key) : -1;
    this.packed ??= numeric && position < this.capacity;
    if (this.packed) {
      if (!numeric || position < this.nextIndex) this.toMixed();
      else if (position >= this.capacity) {
        if (position < this.capacity * 2 && count > this.capacity / 2) {
          this.capacity *= 2;
          this.storageVersion++;
        } else this.toMixed();
      }
    }
    if (!this.packed && this.nextIndex >= this.capacity) {
      if (this.nextIndex > count + (count >> 5)) this.compact();
      else {
        this.capacity *= 2;
        this.storageVersion++;
      }
    }
    if (key !== BigInt(this.entries.size)) this.listLayout = false;
    const entry = this.appendEntry(key, this.packed ? position : this.nextIndex);
    this.nextIndex = entry.index + 1;
    for (const cursor of this.liveCursors()) {
      if (!cursor.entry && (!cursor.preservesPosition || entry.index >= (cursor.index ?? 0)))
        cursor.setPosition(entry, cursor.index);
    }
    return entry.index;
  }

  unpack(preservePositions = false): void {
    if (!this.packed) return;
    if (preservePositions) {
      this.packed = false;
      this.listLayout = false;
      this.storageVersion++;
    } else this.toMixed();
  }

  private toMixed(): void {
    if (this.nextIndex >= this.capacity) this.capacity *= 2;
    this.packed = false;
    this.listLayout = false;
    this.storageVersion++;
    this.compact();
  }

  compact(): void {
    if (this.nextIndex === this.entries.size) return;
    const previousEnd = this.nextIndex;
    let index = 0;
    this.buckets.clear();
    for (const entry of this.orderedEntries()) {
      entry.index = index++;
      this.buckets.set(entry.rawIndex, entry);
    }
    this.nextIndex = index;
    for (const cursor of this.liveCursors())
      if (cursor.index === undefined || cursor.index <= previousEnd) cursor.refreshPosition();
  }

  private appendEntry(key: Key, index: number): ArrayEntry {
    const entry = new ArrayEntry(this, key, index);
    entry.previous = this.last;
    if (this.last) this.last.next = entry;
    else this.first = entry;
    this.last = entry;
    this.entries.set(entry.rawKey, entry);
    this.buckets.set(entry.rawIndex, entry);
    return entry;
  }

  shiftList(): void {
    this.normalizeList();
    if (this.first) this.delete(this.first.key);
    const ended = [...this.liveCursors()]
      .filter((cursor) => !cursor.entry && cursor.index !== undefined)
      .map((cursor) => [cursor, cursor.index as number] as const);
    this.keyOffset++;
    this.indexOffset++;
    this.nextIndex = this.entries.size;
    for (const [cursor, index] of ended) cursor.setPosition(undefined, index);
    this.listLayout = true;
  }

  prependList(count: number): void {
    this.normalizeList();
    this.storageVersion++;
    this.keyOffset -= BigInt(count);
    this.indexOffset -= count;
    for (let index = count - 1; index >= 0; index--) {
      const entry = new ArrayEntry(this, BigInt(index), index);
      entry.next = this.first;
      if (this.first) this.first.previous = entry;
      else this.last = entry;
      this.first = entry;
      this.entries.set(entry.rawKey, entry);
      this.buckets.set(entry.rawIndex, entry);
    }
    this.nextIndex = this.entries.size;
    this.capacity = 8;
    while (this.capacity < this.nextIndex) this.capacity *= 2;
    this.packed = true;
  }

  private normalizeList(): void {
    if (this.listLayout) return;
    const previous = [...this.orderedEntries()];
    this.entries.clear();
    this.buckets.clear();
    this.keyOffset = 0n;
    this.indexOffset = 0;
    for (const [index, entry] of previous.entries()) {
      entry.key = BigInt(index);
      entry.index = index;
      this.entries.set(entry.rawKey, entry);
      this.buckets.set(entry.rawIndex, entry);
    }
    this.nextIndex = previous.length;
    for (const cursor of this.liveCursors()) cursor.refreshPosition();
    this.listLayout = true;
  }

  delete(key: Key, preserveEndPosition = false): void {
    const entry = this.get(key);
    if (!entry) return;
    if (entry !== this.last) this.listLayout = false;
    for (const cursor of this.liveCursors()) cursor.deleteEntry(entry);
    if (entry.previous) entry.previous.next = entry.next;
    else this.first = entry.next;
    if (entry.next) entry.next.previous = entry.previous;
    else {
      this.last = entry.previous;
      if (!preserveEndPosition) this.nextIndex = (this.last?.index ?? -1) + 1;
    }
    this.entries.delete(entry.rawKey);
    this.buckets.delete(entry.rawIndex);
    if (!entry.next) {
      if (this.invalidPointer !== undefined) this.invalidPointer = Math.min(this.invalidPointer, this.nextIndex);
      for (const cursor of this.liveCursors()) cursor.clamp(this.nextIndex);
    }
  }

  replace(keys: Iterable<Key>, packed: boolean, rebuild?: ArrayRebuild): void {
    const orderedKeys = [...keys];
    const cursors = [...this.liveCursors()].map((cursor) => ({ cursor, index: cursor.index }));
    let positions: ReadonlyMap<Key, number> | undefined;
    if (rebuild !== undefined) {
      if (typeof rebuild === 'object' && 'positions' in rebuild) {
        if (rebuild.keepPositions) positions = rebuild.positions;
        else if (cursors.length > 0) this.remapShiftedBuckets(rebuild, cursors);
      } else if (cursors.length > 0) this.remapRebuild(rebuild, cursors);
    }
    this.entries.clear();
    this.buckets.clear();
    this.first = undefined;
    this.last = undefined;
    this.keyOffset = 0n;
    this.indexOffset = 0;
    for (const key of orderedKeys) this.appendEntry(key, positions?.get(key) ?? this.entries.size);
    if (!positions) {
      this.storageVersion++;
      this.nextIndex = this.entries.size;
    }
    while (this.capacity < this.nextIndex) this.capacity *= 2;
    this.listLayout = orderedKeys.every((key, index) => key === BigInt(index));
    this.packed = packed && (this.listLayout || positions !== undefined);
    this.restorePositions(cursors, positions !== undefined);
  }

  private remapShiftedBuckets({ positions, packed }: ShiftedBuckets, cursors: CursorPosition[]): void {
    const previous = [...positions.values()];
    for (const state of cursors) {
      const position = state.index;
      if (position === undefined) continue;
      const next = previous.findIndex((index) => (packed ? index === position : index >= position));
      if (next !== -1) state.index = next;
      else if (!packed && position === this.nextIndex) state.index = previous.length;
    }
  }

  private restorePositions(cursors: CursorPosition[], preserve: boolean): void {
    if (cursors.length === 0) return;
    const entries = [...this.orderedEntries()];
    for (const { cursor, index } of cursors) {
      const entry =
        index === undefined ? undefined : preserve ? entries.find((entry) => entry.index >= index) : entries[index];
      cursor.setPosition(entry, index);
    }
  }

  private remapRebuild(rebuild: ArrayReindex, cursors: CursorPosition[]): void {
    if (rebuild === 'shift') {
      const positions = new Map([...this.orderedEntries()].map((entry, ordinal) => [entry.index, ordinal]));
      if (!this.packed) positions.set(this.nextIndex, positions.size);
      for (const state of cursors) {
        const index = state.index;
        if (index !== undefined) state.index = positions.get(index) ?? index;
      }
    } else if ('prepend' in rebuild) {
      for (const state of cursors) if (state.index !== undefined) state.index += rebuild.prepend;
    } else this.remapSplice(rebuild, cursors);
  }

  private remapSplice(splice: SpliceRange, cursors: CursorPosition[]): void {
    const { start, end } = splice;
    const entries = [...this.orderedEntries()];
    let used = this.nextIndex;
    let next = lowestPosition(cursors, 0, used);
    for (const [ordinal, entry] of entries.entries()) {
      const index = entry.index;
      const removing = ordinal >= start && ordinal < end;
      if (removing && index + 1 === used) {
        used = start ? entries[start - 1].index + 1 : 0;
        clampPositions(cursors, used);
      }
      if (!this.packed && ordinal === end) next = lowestPosition(cursors, next, used);
      if (index !== next || (removing && !this.packed)) continue;
      const position = splicePosition(splice, ordinal, removing);
      movePositions(cursors, index, position);
      next = lowestPosition(cursors, next + 1, used);
    }
  }

  private *keys(): Generator<Key> {
    for (const entry of this.orderedEntries()) yield entry.key;
  }

  private *orderedEntries(): Generator<ArrayEntry> {
    for (let entry = this.first; entry; entry = entry.next) yield entry;
  }

  private *liveCursors(): Generator<ArrayCursor> {
    for (const reference of this.cursors) {
      const cursor = reference.deref();
      if (cursor?.active) yield cursor;
      else this.cursors.delete(reference);
    }
  }
}

function splicePosition({ start, end, inserted }: SpliceRange, ordinal: number, removing: boolean): number {
  if (removing) return end;
  return ordinal < start ? ordinal : ordinal - (end - start) + inserted;
}

function clampPositions(cursors: CursorPosition[], used: number): void {
  for (const cursor of cursors) if (cursor.index !== undefined) cursor.index = Math.min(cursor.index, used);
}

function movePositions(cursors: CursorPosition[], index: number, position: number): void {
  for (const cursor of cursors) if (cursor.index === index) cursor.index = position;
}

function lowestPosition(cursors: CursorPosition[], minimum: number, used: number): number {
  let lowest = used;
  for (const { index } of cursors) if (index !== undefined && index >= minimum && index < lowest) lowest = index;
  return lowest;
}

export class ArrayCursor {
  private current: ArrayEntry | undefined;
  private rawPosition: number | undefined;
  generation: number | undefined;
  private closed = false;
  readonly registration = new WeakRef(this);

  constructor(
    private readonly order: ArrayOrder,
    entry: ArrayEntry | undefined,
    readonly family?: CursorFamily,
    private readonly includes?: (key: Key) => boolean,
    private readonly physical = false
  ) {
    this.generation = family?.generation;
    this.entry = entry;
    this.skipExcluded();
  }

  get active(): boolean {
    return !this.closed && this.generation === this.family?.generation;
  }
  get preservesPosition(): boolean {
    return this.physical || this.family !== undefined;
  }
  close(): void {
    if (this.family && this.active) this.family.generation++;
    this.closed = true;
    this.order.unregisterCursor(this);
  }
  get entry(): ArrayEntry | undefined {
    return this.current;
  }
  set entry(value: ArrayEntry | undefined) {
    this.setPosition(value);
  }
  setPosition(value: ArrayEntry | undefined, index = value?.index): void {
    this.current = value;
    const position = this.preservesPosition ? (index ?? this.order.endPosition) : value?.index;
    this.rawPosition = position === undefined ? undefined : position + this.order.indexOffset;
  }
  refreshPosition(): void {
    this.setPosition(this.current);
  }
  deleteEntry(entry: ArrayEntry): void {
    if (this.current === entry) this.current = entry.next;
  }
  clamp(end: number): void {
    const index = this.index;
    if (this.preservesPosition && index !== undefined && index > end) this.setPosition(this.current, end);
  }
  get key(): Key | undefined {
    this.skipExcluded();
    return this.current?.key;
  }
  get index(): number | undefined {
    return this.rawPosition === undefined ? undefined : Math.max(0, this.rawPosition - this.order.indexOffset);
  }
  rewind(): void {
    this.setPosition(this.order.first, this.family ? 0 : undefined);
    this.skipExcluded();
  }
  next(): void {
    const entry = this.current;
    if (entry) this.setPosition(entry.next, this.physical ? entry.next?.index : entry.index + 1);
    this.skipExcluded();
  }

  private skipExcluded(): void {
    if (!this.includes) return;
    let entry = this.current;
    while (entry && !this.includes(entry.key)) entry = entry.next;
    if (entry !== this.current) this.setPosition(entry);
  }
}
