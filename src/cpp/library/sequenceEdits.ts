import { CppException } from '../errors';
import { makeEach } from '../objectCompiler';
import type { Frame } from '../runtime';
import { Ptr, UNINIT, type Value } from '../values';
import type { SequenceValue } from './containerValues';
import { type ElementOperations, moveConstructElement } from './elements';

/** The values a range insertion or assignment takes, which may have another type than the elements. */
export interface Source {
  values: Value[];
  /** Constructs an element from a value, as the container's allocator does. */
  construct: (frame: Frame, value: Value) => Value;
  /** Whether the values have the element type, which assigns them directly instead of through a temporary. */
  isSameType: boolean;
}

/**
 * The changes of `std::vector`, `std::deque`, and `std::list`, ported from libc++ so that elements are constructed,
 * assigned, and destroyed in the same order and number: a vector and a deque shift their elements by assignment and
 * assign over existing elements, and a vector relocates its elements when it reallocates.
 */
export class SequenceEditor {
  constructor(
    private readonly kind: 'vector' | 'deque' | 'list',
    private readonly operations: () => ElementOperations
  ) {}

  get ops(): ElementOperations {
    return this.operations();
  }

  construct(frame: Frame, count: number, make: (index: number) => Value): Value[] {
    // Apple's deque constructors release partial allocations without calling element destructors.
    return this.build(frame, count, make, this.kind === 'deque' ? undefined : this.ops.destroy);
  }

  private build(
    frame: Frame,
    count: number,
    make: (index: number) => Value,
    destroy: ElementOperations['destroy']
  ): Value[] {
    return makeEach(frame, count, make, () => destroy, undefined, this.kind === 'vector' ? 'reverse' : 'forward');
  }

  /** Destroys elements: a vector from its last, a deque and a list from their first. */
  destroy(frame: Frame, values: Value[]): void {
    const destroy = this.ops.destroy;
    if (!destroy) return;
    if (this.kind === 'vector') for (let index = values.length - 1; index >= 0; index--) destroy(frame, values[index]);
    else for (const value of values) destroy(frame, value);
  }

  /** Destroys the elements from `length` on, as `__destruct_at_end` and `__erase_to_end` do. */
  truncate(frame: Frame, self: SequenceValue, length: number): void {
    if (length < self.items.length) this.destroy(frame, self.splice(length, self.items.length - length));
  }

  removeFront(frame: Frame, self: SequenceValue): void {
    const [removed] = self.splice(0, 1);
    this.ops.destroy?.(frame, removed);
  }

  /** Constructs `count` elements at the end, reallocating a vector first if needed, as `resize` does. */
  append(frame: Frame, self: SequenceValue, count: number, make: () => Value): void {
    const length = self.items.length;
    if (this.kind === 'vector' && length + count > self.capacity) {
      const made = this.build(frame, count, make, this.ops.destroy);
      this.reallocate(frame, self, recommend(self, length + count), length, made);
    } else for (let index = 0; index < count; index++) self.append(make());
  }

  resize(frame: Frame, self: SequenceValue, length: number, make: () => Value): void {
    if (length < self.items.length) this.truncate(frame, self, length);
    else this.append(frame, self, length - self.items.length, make);
  }

  /** `emplace(position, args...)`, whose element `make` constructs. */
  emplace(frame: Frame, self: SequenceValue, at: number, make: () => Value): void {
    const items = self.items;
    const length = items.length;
    if (this.kind === 'list') self.splice(at, 0, make());
    else if (this.kind === 'deque') this.dequeEmplace(frame, self, at, make);
    else if (length >= self.capacity) this.reallocate(frame, self, recommend(self, length + 1), at, [make()]);
    else if (at === length) self.append(make());
    else {
      const temporary = make();
      this.moveRange(frame, items, at, length, at + 1);
      this.assignAt(frame, items, at, temporary);
      this.ops.destroy?.(frame, temporary);
      self.invalidateVectorSuffix(at);
    }
  }

  /** `insert(position, value)`, where the value may be an element of the container itself. */
  insert(frame: Frame, self: SequenceValue, at: number, value: Ptr): void {
    if (this.kind !== 'vector') {
      this.emplace(frame, self, at, () => this.ops.copy(frame, value.read()));
      return;
    }
    const items = self.items;
    const length = items.length;
    if (length >= self.capacity) {
      const made = this.ops.copy(frame, value.read());
      this.reallocate(frame, self, recommend(self, length + 1), at, [made]);
    } else if (at === length) self.append(this.ops.copy(frame, value.read()));
    else {
      this.moveRange(frame, items, at, length, at + 1);
      this.assignAt(frame, items, at, shifted(value, self, at, 1).read());
      self.invalidateVectorSuffix(at);
    }
  }

  /** `insert(position, count, value)`. */
  insertCopies(frame: Frame, self: SequenceValue, at: number, count: number, value: Ptr): void {
    if (count === 0) return;
    if (this.kind === 'list') {
      const made = makeEach(
        frame,
        count,
        () => this.ops.copy(frame, value.read()),
        () => this.ops.destroy
      );
      self.insertValues(at, made);
    } else if (this.kind === 'deque') this.dequeInsertCopies(frame, self, at, count, value);
    else {
      this.vectorInsertCopies(frame, self, at, count, value);
      self.invalidateVectorSuffix(at);
    }
  }

  /** `insert(position, first, last)`, whose elements `source` holds. */
  insertRange(frame: Frame, self: SequenceValue, at: number, source: Source, isForwardOnly: boolean): void {
    if (source.values.length === 0) return;
    if (this.kind === 'list') {
      const values = this.build(
        frame,
        source.values.length,
        (index) => source.construct(frame, source.values[index]),
        this.ops.destroy
      );
      self.insertValues(at, values);
    } else if (this.kind === 'vector') {
      this.vectorInsertRange(frame, self, at, source);
      self.invalidateVectorSuffix(at);
    } else if (isForwardOnly) {
      // A deque copies a forward-only range into a buffer first, and moves the buffer's elements in.
      const buffer = source.values.map((value) => source.construct(frame, value));
      this.dequeInsertBidirectional(frame, self, at, {
        values: buffer,
        construct: (f, value) => this.ops.copy(f, value),
        isSameType: true,
      });
      const destroy = this.ops.destroy;
      if (destroy) for (let index = buffer.length - 1; index >= 0; index--) destroy(frame, buffer[index]);
    } else this.dequeInsertBidirectional(frame, self, at, source);
  }

  /** `erase(first, last)`. */
  erase(frame: Frame, self: SequenceValue, from: number, to: number): void {
    const count = to - from;
    if (count === 0) return;
    const items = self.items;
    if (this.kind === 'list') {
      this.destroy(frame, self.splice(from, count));
    } else if (this.kind === 'deque' && from <= Math.floor((items.length - count) / 2)) {
      // A deque shifts the elements before the erased ones when they are fewer.
      for (let index = from - 1; index >= 0; index--) this.assignAt(frame, items, index + count, items[index]);
      if (from !== 0) self.editPositions(from, count, 0);
      if (from === 0) this.destroy(frame, self.splice(0, count));
      else this.destroy(frame, items.splice(0, count));
    } else {
      for (let index = to; index < items.length; index++) this.assignAt(frame, items, index - count, items[index]);
      if (this.kind === 'deque' && to < items.length) self.editPositions(from, count, 0);
      this.truncate(frame, self, items.length - count);
      self.invalidateVectorSuffix(from);
    }
  }

  /** `assign(first, last)` and copy assignment, which assign over the existing elements. */
  assignRange(frame: Frame, self: SequenceValue, source: Source): void {
    const { values } = source;
    if (this.kind === 'vector' && values.length > self.capacity) {
      this.truncate(frame, self, 0);
      self.replaceAllocation([], values.length);
      for (const value of values) self.append(source.construct(frame, value));
      return;
    }
    const assigned = Math.min(values.length, self.items.length);
    for (let index = 0; index < assigned; index++) this.assignFrom(frame, self.items, index, source, values[index]);
    for (let index = assigned; index < values.length; index++) self.append(source.construct(frame, values[index]));
    this.truncate(frame, self, values.length);
  }

  /** `assign(count, value)`. */
  assignCopies(frame: Frame, self: SequenceValue, count: number, value: Ptr): void {
    if (this.kind === 'vector' && count > self.capacity) {
      this.truncate(frame, self, 0);
      self.replaceAllocation([], count);
      for (let index = 0; index < count; index++) self.append(this.ops.copy(frame, value.read()));
      return;
    }
    const assigned = Math.min(count, self.items.length);
    for (let index = 0; index < assigned; index++) this.assignAt(frame, self.items, index, value.read());
    for (let index = assigned; index < count; index++) self.append(this.ops.copy(frame, value.read()));
    this.truncate(frame, self, count);
  }

  /** Move assignment, which destroys the elements and takes the other container's storage. */
  moveAssign(frame: Frame, self: SequenceValue, other: SequenceValue): void {
    this.truncate(frame, self, 0);
    self.takeItems(other);
  }

  private assignAt(frame: Frame, items: Value[], index: number, value: Value): void {
    items[index] = this.ops.assign(frame, items[index], value);
  }

  /** Assigns a value of a source, through a temporary element when the value has another type. */
  private assignFrom(frame: Frame, items: Value[], index: number, source: Source, value: Value): void {
    if (source.isSameType) {
      this.assignAt(frame, items, index, value);
      return;
    }
    const temporary = source.construct(frame, value);
    this.assignAt(frame, items, index, temporary);
    this.ops.destroy?.(frame, temporary);
  }

  // std::vector ------------------------------------------------------------------------------------------------------

  /** `__swap_out_circular_buffer(v, p)`: relocates the elements after `at`, then those before, around `made`. */
  reallocate(frame: Frame, self: SequenceValue, capacity: number, at = self.length, made: Value[] = []): void {
    const old = self.items;
    const { destroy, type } = this.ops;
    if (type.kind !== 'class') {
      self.replaceAllocation([...old.slice(0, at), ...made, ...old.slice(at)], capacity);
      return;
    }
    const mark = frame.pending.length;
    let back: Value[] = [];
    try {
      for (const value of made) frame.pending.push(value);
      back = makeEach(
        frame,
        old.length - at,
        (index) => moveConstructElement(frame, this.ops, old[at + index]),
        () => destroy
      );
      for (const value of back) frame.pending.push(value);
      if (destroy) for (let index = at; index < old.length; index++) destroy(frame, old[index]);
      if (old.length > at) self.splice(at, old.length - at);
      const front = makeEach(
        frame,
        at,
        (index) => moveConstructElement(frame, this.ops, old[index]),
        () => destroy
      );
      if (destroy) for (const item of old) destroy(frame, item);
      self.replaceAllocation([...front, ...made, ...back], capacity);
    } catch (error) {
      if (error instanceof CppException) {
        this.destroy(frame, back);
        this.destroy(frame, made);
      }
      throw error;
    } finally {
      frame.pending.length = mark;
    }
  }

  /** `__move_range(from, fromEnd, to)`: constructs the elements that pass the end, then assigns the rest backward. */
  private moveRange(frame: Frame, items: Value[], from: number, fromEnd: number, to: number): void {
    const assigned = items.length - to;
    for (let index = from + assigned; index < fromEnd; index++) items.push(this.ops.copy(frame, items[index]));
    for (let index = assigned - 1; index >= 0; index--) this.assignAt(frame, items, to + index, items[from + index]);
  }

  private vectorInsertCopies(frame: Frame, self: SequenceValue, at: number, count: number, value: Ptr): void {
    const items = self.items;
    const length = items.length;
    if (count > self.capacity - length) {
      const made = makeEach(
        frame,
        count,
        () => this.ops.copy(frame, value.read()),
        () => this.ops.destroy
      );
      this.reallocate(frame, self, recommend(self, length + count), at, made);
      return;
    }
    let remaining = count;
    if (remaining > length - at) {
      const constructed = remaining - (length - at);
      for (let index = 0; index < constructed; index++) items.push(this.ops.copy(frame, value.read()));
      remaining -= constructed;
    }
    if (remaining === 0) return;
    this.moveRange(frame, items, at, length, at + count);
    const source = shifted(value, self, at, count);
    for (let index = 0; index < remaining; index++) this.assignAt(frame, items, at + index, source.read());
  }

  private vectorInsertRange(frame: Frame, self: SequenceValue, at: number, source: Source): void {
    const { values } = source;
    const count = values.length;
    const items = self.items;
    const length = items.length;
    if (count > self.capacity - length) {
      const made = makeEach(
        frame,
        count,
        (index) => source.construct(frame, values[index]),
        () => this.ops.destroy
      );
      this.reallocate(frame, self, recommend(self, length + count), at, made);
      return;
    }
    const after = length - at;
    let assigned = count;
    if (count > after) {
      for (let index = after; index < count; index++) items.push(source.construct(frame, values[index]));
      assigned = after;
    }
    if (assigned === 0) return;
    this.moveRange(frame, items, at, length, at + count);
    for (let index = 0; index < assigned; index++) this.assignFrom(frame, items, at + index, source, values[index]);
  }

  // std::deque -------------------------------------------------------------------------------------------------------
  // A deque grows at whichever end is nearer to the position, so these build the new elements in `cells`, which has
  // room for them before the old first element.

  private dequeEmplace(frame: Frame, self: SequenceValue, at: number, make: () => Value): void {
    const items = self.items;
    const length = items.length;
    if (at < length - at) {
      if (at === 0) {
        self.splice(0, 0, make());
        return;
      }
      const temporary = make();
      self.editPositions(at, 0, 1);
      items.unshift(this.ops.copy(frame, items[0]));
      for (let index = 1; index < at; index++) this.assignAt(frame, items, index, items[index + 1]);
      this.assignAt(frame, items, at, temporary);
      this.ops.destroy?.(frame, temporary);
      return;
    }
    if (at === length) {
      self.append(make());
      return;
    }
    const temporary = make();
    self.editPositions(at, 0, 1);
    items.push(this.ops.copy(frame, items[length - 1]));
    for (let index = length - 2; index >= at; index--) this.assignAt(frame, items, index + 1, items[index]);
    this.assignAt(frame, items, at, temporary);
    this.ops.destroy?.(frame, temporary);
  }

  private dequeInsertCopies(frame: Frame, self: SequenceValue, at: number, count: number, value: Ptr): void {
    if (at < self.items.length - at) this.dequeInsertCopiesAtFront(frame, self, at, count, value);
    else this.dequeInsertCopiesAtBack(frame, self, at, count, value);
  }

  /** libc++'s `deque::insert(p, n, v)` when it shifts the elements before `p` toward the front. */
  private dequeInsertCopiesAtFront(frame: Frame, self: SequenceValue, at: number, count: number, value: Ptr): void {
    const cells: Value[] = [...Array.from<Value>({ length: count }).fill(UNINIT), ...self.items];
    const followed = new Followed(value, value.store === self ? value.index + count : undefined, cells);
    const oldBegin = count;
    let first = oldBegin;
    let remaining = count;
    if (remaining > at) {
      for (let made = remaining - at; made > 0; made--) cells[--first] = this.ops.copy(frame, followed.read());
      remaining = at;
    }
    if (remaining > 0) {
      const moved = oldBegin + remaining;
      followed.move(oldBegin, moved, first - moved);
      for (let index = moved; index !== oldBegin;) cells[--first] = this.ops.copy(frame, cells[--index]);
      let begin = oldBegin;
      followed.move(moved, oldBegin + at, oldBegin - moved);
      for (let index = moved; index < oldBegin + at; index++) this.assignAt(frame, cells, begin++, cells[index]);
      for (let index = 0; index < remaining; index++) this.assignAt(frame, cells, begin + index, followed.read());
    }
    self.editPositions(at, 0, count);
    self.items = cells.slice(first);
  }

  /** libc++'s `deque::insert(p, n, v)` when it shifts the elements after `p` toward the back. */
  private dequeInsertCopiesAtBack(frame: Frame, self: SequenceValue, at: number, count: number, value: Ptr): void {
    const cells = [...self.items];
    const followed = new Followed(value, value.store === self ? value.index : undefined, cells);
    const length = cells.length;
    const after = length - at;
    let last = length;
    let remaining = count;
    if (remaining > after) {
      for (let made = remaining - after; made > 0; made--) cells[last++] = this.ops.copy(frame, followed.read());
      remaining = after;
    }
    if (remaining > 0) {
      const moved = length - remaining;
      followed.move(moved, length, last - moved);
      for (let index = moved; index < length; index++) cells[last++] = this.ops.copy(frame, cells[index]);
      let end = length;
      followed.move(at, moved, length - moved);
      for (let index = moved; index > at;) this.assignAt(frame, cells, --end, cells[--index]);
      for (let index = 0; index < remaining; index++)
        this.assignAt(frame, cells, end - remaining + index, followed.read());
    }
    self.editPositions(at, 0, count);
    self.items = cells;
  }

  /** libc++'s `deque::__insert_bidirectional`. */
  private dequeInsertBidirectional(frame: Frame, self: SequenceValue, at: number, source: Source): void {
    if (at < self.items.length - at) this.dequeInsertRangeAtFront(frame, self, at, source);
    else this.dequeInsertRangeAtBack(frame, self, at, source);
  }

  private dequeInsertRangeAtFront(frame: Frame, self: SequenceValue, at: number, source: Source): void {
    const { values } = source;
    const count = values.length;
    const cells: Value[] = [...Array.from<Value>({ length: count }).fill(UNINIT), ...self.items];
    const oldBegin = count;
    let first = oldBegin;
    // The values before `middle` go before the old first element; the rest are assigned over moved elements.
    const middle = Math.max(0, count - at);
    for (let index = middle; index > 0;) cells[--first] = source.construct(frame, values[--index]);
    const remaining = count - middle;
    if (remaining > 0) {
      const moved = oldBegin + remaining;
      for (let index = moved; index !== oldBegin;) cells[--first] = this.ops.copy(frame, cells[--index]);
      let begin = oldBegin;
      for (let index = moved; index < oldBegin + at; index++) this.assignAt(frame, cells, begin++, cells[index]);
      for (let index = middle; index < count; index++) this.assignFrom(frame, cells, begin++, source, values[index]);
    }
    self.editPositions(at, 0, count);
    self.items = cells.slice(first);
  }

  private dequeInsertRangeAtBack(frame: Frame, self: SequenceValue, at: number, source: Source): void {
    const { values } = source;
    const count = values.length;
    const cells = [...self.items];
    const length = cells.length;
    const after = length - at;
    let last = length;
    // The values from `middle` on go after the old last element; the rest are assigned over moved elements.
    const middle = Math.min(count, after);
    for (let index = middle; index < count; index++) cells[last++] = source.construct(frame, values[index]);
    if (middle > 0) {
      const moved = length - middle;
      for (let index = moved; index < length; index++) cells[last++] = this.ops.copy(frame, cells[index]);
      let end = length;
      for (let index = moved; index > at;) this.assignAt(frame, cells, --end, cells[--index]);
      for (let index = middle; index > 0;) this.assignFrom(frame, cells, --end, source, values[--index]);
    }
    self.editPositions(at, 0, count);
    self.items = cells;
  }
}

/** The value a deque insertion copies, which it follows when it is an element the insertion moves. */
class Followed {
  constructor(
    private readonly value: Ptr,
    private index: number | undefined,
    private readonly cells: Value[]
  ) {}

  read(): Value {
    return this.index === undefined ? this.value.read() : this.cells[this.index];
  }

  /** Follows the value when it is among the elements in [from, to), which move by `delta`. */
  move(from: number, to: number, delta: number): void {
    if (this.index !== undefined && this.index >= from && this.index < to) this.index += delta;
  }
}

/**
 * libc++'s `list::__sort`, a merge sort that compares the elements in the same order, which a comparator with
 * effects shows.
 */
export function listSort<T>(items: T[], less: (a: T, b: T) => boolean): T[] {
  if (items.length < 2) return items;
  if (items.length === 2) return less(items[1], items[0]) ? [items[1], items[0]] : items;
  const half = Math.floor(items.length / 2);
  const left = listSort(items.slice(0, half), less);
  const right = listSort(items.slice(half), less);
  const merged: T[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (less(right[j], left[i])) {
      // The run of the right half's elements that go before left[i] moves there at once.
      let end = j + 1;
      while (end < right.length && less(right[end], left[i])) end++;
      merged.push(...right.slice(j, end));
      j = end;
    }
    merged.push(left[i++]);
  }
  return [...merged, ...left.slice(i), ...right.slice(j)];
}

/** `__recommend`: the capacity a vector grows to, twice the old one or the needed size if larger. */
function recommend(self: SequenceValue, size: number): number {
  return Math.max(2 * self.capacity, size);
}

/** Where a value that was an element at or after `at` is after the elements there moved `by` places back. */
function shifted(value: Ptr, self: SequenceValue, at: number, by: number): Ptr {
  return value.store === self && value.index >= at && value.index < self.items.length - by
    ? new Ptr(self, value.index + by)
    : value;
}
