import { CppException } from '../errors';
import { initializeAt, makeEach, withTemporaries } from '../objectCompiler';
import type { Frame } from '../runtime';
import { ArrayStore, CObject, endLifetime, holdValues, Ptr, UNINIT, type Value } from '../values';
import type { SequenceValue } from './containerValues';
import {
  constructElementFromRvalue,
  destroyElements,
  type ElementOperations,
  moveConstructElement,
  moveValue,
} from './elements';

/** The values a range insertion or assignment takes, which may have another type than the elements. */
export interface Source {
  values: Value[];
  /** Constructs an element from a value, as the container's allocator does. */
  construct: (frame: Frame, value: Value, destination?: CObject) => Value;
  /** Whether the values have the element type, which assigns them directly instead of through a temporary. */
  isSameType: boolean;
}

type ElementFactory = (destination?: CObject) => Value;

interface VectorInsertion {
  at: number;
  count: number;
  make: (index: number, destination?: CObject) => Value;
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

  construct(
    frame: Frame,
    self: SequenceValue,
    count: number,
    make: (index: number, destination?: CObject) => Value
  ): SequenceValue {
    // Apple's deque constructors release partial allocations without calling element destructors.
    const { destroy } = this.ops;
    self.items = Array.from({ length: count }, (): Value => UNINIT);
    self.capacity = count;
    return holdValues(frame, [self], () => {
      try {
        makeEach(
          frame,
          count,
          (index) => this.constructAt(frame, self.location(index), (destination) => make(index, destination)),
          () => (this.kind === 'deque' ? undefined : destroy),
          self.items,
          this.kind === 'vector' ? 'reverse' : 'forward'
        );
        self.bindElements(0, count);
        return self;
      } catch (error) {
        endLifetime(self);
        throw error;
      }
    });
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
    destroyElements(frame, values, this.ops.destroy, this.kind === 'vector' ? 'reverse' : 'forward');
  }

  /** Destroys the elements from `length` on, as `__destruct_at_end` and `__erase_to_end` do. */
  truncate(frame: Frame, self: SequenceValue, length: number): void {
    const count = self.length - length;
    if (count > 0) this.destroyRange(frame, self, length, count);
  }

  removeFront(frame: Frame, self: SequenceValue): void {
    this.destroyRange(frame, self, 0, 1);
  }

  private destroyRange(frame: Frame, self: SequenceValue, from: number, count: number, dequeEraseAt = from): void {
    if (this.kind === 'list') {
      self.eraseNodes(from, count, (values) => this.destroy(frame, values));
      return;
    }
    this.destroy(frame, self.items.slice(from, from + count));
    if (dequeEraseAt === from) {
      self.splice(from, count);
      return;
    }
    self.editPositions(dequeEraseAt, count, 0);
    self.items.splice(from, count);
    self.bindElements(0, self.length);
  }

  /** Constructs `count` elements at the end, reallocating a vector first if needed, as `resize` does. */
  append(frame: Frame, self: SequenceValue, count: number, make: ElementFactory): void {
    const length = self.items.length;
    if (this.kind === 'vector' && length + count > self.capacity) {
      this.reallocate(frame, self, recommend(self, length + count), {
        at: length,
        count,
        make: (_, target) => make(target),
      });
    } else for (let index = 0; index < count; index++) this.appendElement(frame, self, make);
  }

  private appendElement(frame: Frame, self: SequenceValue, make: ElementFactory): void {
    const { type } = this.ops;
    if (type.kind === 'class' && !type.cls.library)
      self.appendInPlace((location) => this.constructAt(frame, location, make));
    else self.append(make());
  }

  private constructAt(frame: Frame, location: Ptr, make: ElementFactory): Value {
    return initializeAt(frame, this.ops.type, location, UNINIT, (target) =>
      make(target instanceof CObject ? target : undefined)
    );
  }

  resize(frame: Frame, self: SequenceValue, length: number, make: ElementFactory): void {
    if (length < self.items.length) this.truncate(frame, self, length);
    else this.append(frame, self, length - self.items.length, make);
  }

  /** `emplace(position, args...)`, whose element `make` constructs. */
  emplace(frame: Frame, self: SequenceValue, at: number, make: ElementFactory): void {
    const items = self.items;
    const length = items.length;
    if (this.kind === 'list') {
      if (at === length) this.appendElement(frame, self, make);
      else self.splice(at, 0, make());
    } else if (this.kind === 'deque') this.dequeEmplace(frame, self, at, make);
    else if (length >= self.capacity)
      this.reallocate(frame, self, recommend(self, length + 1), { at, count: 1, make: (_, target) => make(target) });
    else if (at === length) this.appendElement(frame, self, make);
    else {
      this.withTemporaryElement(frame, make(), (temporary) => {
        this.moveRange(frame, self, at, length, at + 1);
        this.moveAt(frame, items, at, temporary);
      });
      self.finishVectorEdit(at, length);
    }
  }

  insert(frame: Frame, self: SequenceValue, at: number, value: Ptr, move = false): void {
    const construct: ElementFactory = (destination) =>
      move ? this.moveConstruct(frame, value.read(), destination) : this.ops.copy(frame, value.read(), destination);
    if (this.kind !== 'vector') {
      this.emplace(frame, self, at, construct);
      return;
    }
    const items = self.items;
    const length = items.length;
    if (length >= self.capacity) {
      this.reallocate(frame, self, recommend(self, length + 1), {
        at,
        count: 1,
        make: (_, target) => construct(target),
      });
    } else if (at === length) this.appendElement(frame, self, construct);
    else {
      this.moveRange(frame, self, at, length, at + 1);
      const argument = shifted(value, self, at, 1).read();
      if (move) this.moveAt(frame, items, at, argument);
      else this.assignAt(frame, items, at, argument);
      self.finishVectorEdit(at, length);
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
    else this.vectorInsertCopies(frame, self, at, count, value);
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
    } else if (this.kind === 'vector') this.vectorInsertRange(frame, self, at, source);
    else if (isForwardOnly) this.dequeInsertBuffered(frame, self, at, source);
    else this.dequeInsertBidirectional(frame, self, at, source);
  }

  /** `erase(first, last)`. */
  erase(frame: Frame, self: SequenceValue, from: number, to: number): void {
    const count = to - from;
    if (count === 0) return;
    const items = self.items;
    if (this.kind === 'list') {
      this.destroyRange(frame, self, from, count);
    } else if (this.kind === 'deque' && from <= Math.floor((items.length - count) / 2)) {
      // A deque shifts the elements before the erased ones when they are fewer.
      for (let index = from - 1; index >= 0; index--) this.moveAt(frame, items, index + count, items[index]);
      this.destroyRange(frame, self, 0, count, from);
    } else {
      for (let index = to; index < items.length; index++) this.moveAt(frame, items, index - count, items[index]);
      const tail = items.length - count;
      this.destroyRange(frame, self, tail, count, this.kind === 'deque' ? from : tail);
      if (this.kind === 'vector') self.finishVectorEdit(from);
    }
  }

  /** `assign(first, last)` and copy assignment, which assign over the existing elements. */
  assignRange(frame: Frame, self: SequenceValue, source: Source): void {
    const { values } = source;
    if (this.kind === 'vector' && values.length > self.capacity) {
      this.truncate(frame, self, 0);
      self.replaceAllocation([], values.length);
      for (const value of values) this.appendElement(frame, self, (target) => source.construct(frame, value, target));
      return;
    }
    const assigned = Math.min(values.length, self.items.length);
    for (let index = 0; index < assigned; index++) this.assignFrom(frame, self.items, index, source, values[index]);
    for (let index = assigned; index < values.length; index++)
      this.appendElement(frame, self, (target) => source.construct(frame, values[index], target));
    this.truncate(frame, self, values.length);
  }

  /** `assign(count, value)`. */
  assignCopies(frame: Frame, self: SequenceValue, count: number, value: Ptr): void {
    if (this.kind === 'vector' && count > self.capacity) {
      this.truncate(frame, self, 0);
      self.replaceAllocation([], count);
      for (let index = 0; index < count; index++)
        this.appendElement(frame, self, (target) => this.ops.copy(frame, value.read(), target));
      return;
    }
    const assigned = Math.min(count, self.items.length);
    for (let index = 0; index < assigned; index++) this.assignAt(frame, self.items, index, value.read());
    for (let index = assigned; index < count; index++)
      this.appendElement(frame, self, (target) => this.ops.copy(frame, value.read(), target));
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

  private moveAt(frame: Frame, items: Value[], index: number, value: Value): void {
    items[index] = moveValue(frame, this.ops.type, items[index], value);
  }

  private moveConstruct(frame: Frame, value: Value, destination?: CObject): Value {
    return constructElementFromRvalue(frame, this.ops.type, value, destination);
  }

  /** Assigns a value of a source, through a temporary element when the value has another type. */
  private assignFrom(frame: Frame, items: Value[], index: number, source: Source, value: Value): void {
    if (source.isSameType) {
      this.assignAt(frame, items, index, value);
      return;
    }
    this.withTemporaryElement(frame, source.construct(frame, value), (temporary) =>
      this.assignAt(frame, items, index, temporary)
    );
  }

  private withTemporaryElement(frame: Frame, object: Value, use: (value: Value) => void): void {
    const destroy = this.ops.destroy ?? (() => {});
    withTemporaries(frame, () => {
      frame.temporaries.push({ object, destroy });
      use(object);
    });
  }

  // std::vector ------------------------------------------------------------------------------------------------------

  /** `__swap_out_circular_buffer(v, p)`: relocates the elements after `at`, then those before, around `made`. */
  reallocate(frame: Frame, self: SequenceValue, capacity: number, insertion?: VectorInsertion): void {
    const old = self.items;
    const { destroy, type } = this.ops;
    const at = insertion?.at ?? old.length;
    const count = insertion?.count ?? 0;
    if (type.kind !== 'class') {
      const made = insertion ? this.build(frame, count, insertion.make, destroy) : [];
      self.replaceAllocation([...old.slice(0, at), ...made, ...old.slice(at)], capacity);
      return;
    }
    const next = self.newAllocation(old.length + count, capacity);
    holdValues(frame, [next], () => this.relocateClassElements(frame, self, next, at, insertion));
  }

  private relocateClassElements(
    frame: Frame,
    self: SequenceValue,
    next: SequenceValue,
    at: number,
    insertion: VectorInsertion | undefined
  ): void {
    const old = self.items;
    const { destroy } = this.ops;
    const count = insertion?.count ?? 0;
    const moveTo = (value: Value, index: number): Value =>
      this.constructAt(frame, next.location(index), (target) => moveConstructElement(frame, this.ops, value, target));
    let made: Value[] = [];
    let back: Value[] = [];
    try {
      if (insertion) {
        made = this.build(
          frame,
          count,
          (index) => this.constructAt(frame, next.location(at + index), (target) => insertion.make(index, target)),
          destroy
        );
      }
      back = makeEach(
        frame,
        old.length - at,
        (index) => moveTo(old[at + index], at + count + index),
        () => destroy
      );
      if (destroy) for (let index = at; index < old.length; index++) destroy(frame, old[index]);
      if (old.length > at) self.splice(at, old.length - at);
      makeEach(
        frame,
        at,
        (index) => moveTo(old[index], index),
        () => destroy
      );
      if (destroy) for (const item of old) destroy(frame, item);
      self.installAllocation(next);
    } catch (error) {
      if (error instanceof CppException) {
        this.destroy(frame, back);
        this.destroy(frame, made);
      }
      endLifetime(next);
      throw error;
    }
  }

  /** `__move_range(from, fromEnd, to)`: constructs the elements that pass the end, then assigns the rest backward. */
  private moveRange(frame: Frame, self: SequenceValue, from: number, fromEnd: number, to: number): void {
    const items = self.items;
    const assigned = items.length - to;
    for (let index = from + assigned; index < fromEnd; index++)
      this.appendElement(frame, self, (target) => this.moveConstruct(frame, items[index], target));
    for (let index = assigned - 1; index >= 0; index--) this.moveAt(frame, items, to + index, items[from + index]);
  }

  private vectorInsertCopies(frame: Frame, self: SequenceValue, at: number, count: number, value: Ptr): void {
    const items = self.items;
    const length = items.length;
    if (count > self.capacity - length) {
      this.reallocate(frame, self, recommend(self, length + count), {
        at,
        count,
        make: (_, target) => this.ops.copy(frame, value.read(), target),
      });
      return;
    }
    let remaining = count;
    if (remaining > length - at) {
      const constructed = remaining - (length - at);
      for (let index = 0; index < constructed; index++)
        this.appendElement(frame, self, (target) => this.ops.copy(frame, value.read(), target));
      remaining -= constructed;
    }
    if (remaining === 0) {
      self.finishVectorEdit(at, length);
      return;
    }
    this.moveRange(frame, self, at, length, at + count);
    const source = shifted(value, self, at, count);
    for (let index = 0; index < remaining; index++) this.assignAt(frame, items, at + index, source.read());
    self.finishVectorEdit(at, length);
  }

  private vectorInsertRange(frame: Frame, self: SequenceValue, at: number, source: Source): void {
    const { values } = source;
    const count = values.length;
    const items = self.items;
    const length = items.length;
    if (count > self.capacity - length) {
      this.reallocate(frame, self, recommend(self, length + count), {
        at,
        count,
        make: (index, target) => source.construct(frame, values[index], target),
      });
      return;
    }
    const after = length - at;
    let assigned = count;
    if (count > after) {
      for (let index = after; index < count; index++)
        this.appendElement(frame, self, (target) => source.construct(frame, values[index], target));
      assigned = after;
    }
    if (assigned === 0) {
      self.finishVectorEdit(at, length);
      return;
    }
    this.moveRange(frame, self, at, length, at + count);
    for (let index = 0; index < assigned; index++) this.assignFrom(frame, items, at + index, source, values[index]);
    self.finishVectorEdit(at, length);
  }

  // std::deque -------------------------------------------------------------------------------------------------------
  // A deque grows at whichever end is nearer to the position, so these build the new elements in `cells`, which has
  // room for them before the old first element.

  private dequeEmplace(frame: Frame, self: SequenceValue, at: number, make: ElementFactory): void {
    const items = self.items;
    const length = items.length;
    if (at === length) this.appendElement(frame, self, make);
    else if (at === 0) self.splice(0, 0, make());
    else {
      this.withTemporaryElement(frame, make(), (temporary) => {
        if (at < length - at) {
          items.unshift(this.moveConstruct(frame, items[0]));
          self.editPositions(at, 0, 1);
          for (let index = 1; index < at; index++) this.moveAt(frame, items, index, items[index + 1]);
        } else {
          items.push(this.moveConstruct(frame, items[length - 1]));
          self.editPositions(at, 0, 1);
          for (let index = length - 2; index >= at; index--) this.moveAt(frame, items, index + 1, items[index]);
        }
        self.bindElements(0, self.length);
        this.moveAt(frame, items, at, temporary);
      });
    }
  }

  private dequeInsertCopies(frame: Frame, self: SequenceValue, at: number, count: number, value: Ptr): void {
    this.editDequeInsertion(frame, self, at, count, (cells, atFront) => {
      if (atFront) this.dequeInsertCopiesAtFront(frame, self, cells, at, count, value);
      else this.dequeInsertCopiesAtBack(frame, self, cells, at, count, value);
    });
  }

  /** libc++'s `deque::insert(p, n, v)` when it shifts the elements before `p` toward the front. */
  private dequeInsertCopiesAtFront(
    frame: Frame,
    self: SequenceValue,
    cells: Value[],
    at: number,
    count: number,
    value: Ptr
  ): void {
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
      for (let index = moved; index !== oldBegin;) cells[--first] = this.moveConstruct(frame, cells[--index]);
      let begin = oldBegin;
      followed.move(moved, oldBegin + at, oldBegin - moved);
      for (let index = moved; index < oldBegin + at; index++) this.moveAt(frame, cells, begin++, cells[index]);
      for (let index = 0; index < remaining; index++) this.assignAt(frame, cells, begin + index, followed.read());
    }
  }

  /** libc++'s `deque::insert(p, n, v)` when it shifts the elements after `p` toward the back. */
  private dequeInsertCopiesAtBack(
    frame: Frame,
    self: SequenceValue,
    cells: Value[],
    at: number,
    count: number,
    value: Ptr
  ): void {
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
      for (let index = moved; index < length; index++) cells[last++] = this.moveConstruct(frame, cells[index]);
      let end = length;
      followed.move(at, moved, length - moved);
      for (let index = moved; index > at;) this.moveAt(frame, cells, --end, cells[--index]);
      for (let index = 0; index < remaining; index++)
        this.assignAt(frame, cells, end - remaining + index, followed.read());
    }
  }

  private dequeInsertBuffered(frame: Frame, self: SequenceValue, at: number, source: Source): void {
    withTemporaries(frame, () => {
      const values: Value[] = [];
      const { copy, destroy } = this.ops;
      frame.temporaries.push({
        object: new ArrayStore(values),
        destroy: (f) => destroyElements(f, values, destroy, 'reverse'),
      });
      for (const value of source.values) values.push(source.construct(frame, value));
      this.dequeInsertBidirectional(frame, self, at, { values, construct: copy, isSameType: true });
    });
  }

  /** libc++'s `deque::__insert_bidirectional`. */
  private dequeInsertBidirectional(frame: Frame, self: SequenceValue, at: number, source: Source): void {
    this.editDequeInsertion(frame, self, at, source.values.length, (cells, atFront) => {
      if (atFront) this.dequeInsertRangeAtFront(frame, cells, at, source);
      else this.dequeInsertRangeAtBack(frame, cells, at, source);
    });
  }

  private dequeInsertRangeAtFront(frame: Frame, cells: Value[], at: number, source: Source): void {
    const { values } = source;
    const count = values.length;
    const oldBegin = count;
    let first = oldBegin;
    // The values before `middle` go before the old first element; the rest are assigned over moved elements.
    const middle = Math.max(0, count - at);
    for (let index = middle; index > 0;) cells[--first] = source.construct(frame, values[--index]);
    const remaining = count - middle;
    if (remaining > 0) {
      const moved = oldBegin + remaining;
      for (let index = moved; index !== oldBegin;) cells[--first] = this.moveConstruct(frame, cells[--index]);
      let begin = oldBegin;
      for (let index = moved; index < oldBegin + at; index++) this.moveAt(frame, cells, begin++, cells[index]);
      for (let index = middle; index < count; index++) this.assignFrom(frame, cells, begin++, source, values[index]);
    }
  }

  private dequeInsertRangeAtBack(frame: Frame, cells: Value[], at: number, source: Source): void {
    const { values } = source;
    const count = values.length;
    const length = cells.length;
    const after = length - at;
    let last = length;
    // The values from `middle` on go after the old last element; the rest are assigned over moved elements.
    const middle = Math.min(count, after);
    for (let index = middle; index < count; index++) cells[last++] = source.construct(frame, values[index]);
    if (middle > 0) {
      const moved = length - middle;
      for (let index = moved; index < length; index++) cells[last++] = this.moveConstruct(frame, cells[index]);
      let end = length;
      for (let index = moved; index > at;) this.moveAt(frame, cells, --end, cells[--index]);
      for (let index = middle; index > 0;) this.assignFrom(frame, cells, --end, source, values[--index]);
    }
  }

  private editDequeInsertion(
    frame: Frame,
    self: SequenceValue,
    at: number,
    count: number,
    edit: (cells: Value[], atFront: boolean) => void
  ): void {
    const length = self.items.length;
    const atFront = at < length - at;
    const cells = atFront ? [...Array.from<Value>({ length: count }).fill(UNINIT), ...self.items] : [...self.items];
    holdValues(frame, [new ArrayStore(cells)], () => {
      try {
        edit(cells, atFront);
      } catch (error) {
        if (error instanceof CppException) {
          const committed = atFront ? cells.slice(cells.findIndex((value) => value !== UNINIT)) : cells;
          self.editPositions(atFront ? 0 : length, 0, committed.length - length);
          self.items = committed;
        }
        throw error;
      }
      self.editPositions(at, 0, count);
      self.items = cells;
    });
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
