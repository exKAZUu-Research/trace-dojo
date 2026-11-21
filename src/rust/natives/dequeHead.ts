import { vecCapacity } from '../capacity';
import { described, listPart, numberPart, tuplePart } from '../iterDebug';
import type { Type } from '../types';
import { DONE, ElementPlace, IterValue, type Next, SliceView, type Value } from '../values';
import { ownedIter } from './iterators';
import { sizeOf } from './layout';

/**
 * Where each `VecDeque`'s first element sits in its ring buffer (its `head`), which its iterators show as two slices
 * (`Iter([0], [1])`) and `as_slices` gives. The deque's array holds its elements in order; the head moves as std's
 * does: when the buffer grows or shrinks, and on `push_front`, `pop_front`, `insert`, `remove`, `rotate_*`, `make_contiguous`,
 * `clear`, and `drain`.
 */
const heads = new WeakMap<object, number>();

export function dequeHead(items: object): number {
  return heads.get(items) ?? 0;
}

export function resetDequeHead(items: object): void {
  heads.delete(items);
}

/** How long the first of a deque's two slices is: the elements from its head to the end of its buffer. */
export function firstSliceLength(items: Value[], capacity: number): number {
  return capacity === 0 ? items.length : Math.min(items.length, capacity - dequeHead(items));
}

type Move = (head: number, capacity: number, len: number, args: Value[]) => number;

const wrapAdd = (index: number, n: number, capacity: number): number => (index + n) % capacity;
const wrapSub = (index: number, n: number, capacity: number): number => (index - n + capacity) % capacity;
const indexArg = (args: Value[]): number => Number(args[1] as bigint);

/** How each native moves the head, given it before, the capacity after any growth, and the length before. */
const HEAD_MOVES: Record<string, Move> = {
  push_front: (head, capacity) => wrapSub(head, 1, capacity),
  pop_front: (head, capacity, len) => (len > 0 ? wrapAdd(head, 1, capacity) : head),
  // `insert` and `remove` shift the shorter side, moving the head when it is the front.
  insert: (head, capacity, len, args) => (len - indexArg(args) < indexArg(args) ? head : wrapSub(head, 1, capacity)),
  remove: (head, capacity, len, args) => {
    const index = indexArg(args);
    return index >= len || len - index - 1 < index ? head : wrapAdd(head, 1, capacity);
  },
  clear: () => 0,
  rotate_left: (head, capacity, len, args) => {
    const n = indexArg(args);
    return n <= len - n ? wrapAdd(head, n, capacity) : wrapSub(head, len - n, capacity);
  },
  rotate_right: (head, capacity, len, args) => {
    const n = indexArg(args);
    return n <= len - n ? wrapSub(head, n, capacity) : wrapAdd(head, len - n, capacity);
  },
  make_contiguous: contiguousHead,
};

/** `make_contiguous`: where it moves the elements to, by the room left beside each part. */
function contiguousHead(head: number, capacity: number, len: number): number {
  if (head + len <= capacity) return head;
  const free = capacity - len;
  const headLen = capacity - head;
  const tailLen = len - headLen;
  if (free >= headLen) return 0;
  if (free >= tailLen) return tailLen;
  return headLen > tailLen ? free : 0;
}

/** `handle_capacity_increase`: when the elements wrap, the shorter part moves to the new room, maybe the head's. */
function grownHead(head: number, oldCapacity: number, newCapacity: number, len: number): number {
  if (head <= oldCapacity - len) return head;
  const headLen = oldCapacity - head;
  const tailLen = len - headLen;
  if (headLen > tailLen && newCapacity - oldCapacity >= tailLen) return head;
  return newCapacity - headLen;
}

/** `shrink_to`: the elements that the smaller buffer no longer holds move into it, the head's part to its end. */
function shrunkHead(head: number, oldCapacity: number, newCapacity: number, len: number): number {
  if (len === 0) return 0;
  const end = head + len;
  const tailOutside = end > newCapacity && end <= oldCapacity;
  if (tailOutside) return head >= newCapacity ? 0 : head;
  return end > oldCapacity ? newCapacity - (oldCapacity - head) : head;
}

function resizedHead(head: number, oldCapacity: number, newCapacity: number, len: number): number {
  if (newCapacity > oldCapacity) return grownHead(head, oldCapacity, newCapacity, len);
  return newCapacity < oldCapacity ? shrunkHead(head, oldCapacity, newCapacity, len) : head;
}

/** Wraps the deque's natives so that its head moves as std's does; `capacity` reads its capacity. */
export function withDequeHead<C>(
  natives: Record<string, (args: Value[], ctx: C) => Value>,
  capacity: (items: Value[], ctx: C) => number
): Record<string, (args: Value[], ctx: C) => Value> {
  const tracked = { ...natives };
  for (const [name, native] of Object.entries(natives)) {
    tracked[name] = (args, ctx) => {
      const items = (args[0] as { get?: () => Value } | undefined)?.get?.() ?? args[0];
      if (!Array.isArray(items) || name === 'new' || name === 'with_capacity') return native(args, ctx);
      const len = items.length;
      const head = dequeHead(items);
      const oldCapacity = capacity(items, ctx);
      const result = native(args, ctx);
      const newCapacity = capacity(items, ctx);
      let moved = resizedHead(head, oldCapacity, newCapacity, len);
      const move = HEAD_MOVES[name];
      if (move && newCapacity > 0) moved = move(moved, newCapacity, len, args);
      if (moved !== head) heads.set(items, moved);
      return result;
    };
  }
  return tracked;
}

export function dequeIterator(items: Value[], type: Type, mode: 'value' | 'ref' | 'mut'): IterValue {
  if (mode === 'value') {
    return described(ownedIter(items, type), (show, item, target) =>
      tuplePart('IntoIter', [listPart(target.rest?.() ?? [], item, show)])
    );
  }
  return dequeIter(items, vecCapacity(items, items.length, sizeOf(type)), mode === 'mut');
}

/**
 * `VecDeque::iter` and `iter_mut`: two slice iterators, of the elements up to the buffer's end and of those that wrap
 * to its start, swapped once the first runs out, as std's are.
 */
function dequeIter(items: Value[], capacity: number, mutable: boolean): IterValue {
  const first = firstSliceLength(items, capacity);
  return dequeIterFrom(items, mutable, { front: 0, back: first }, { front: first, back: items.length });
}

export function dequeRange(items: Value[], capacity: number, start: number, end: number): IterValue {
  const split = Math.min(end, Math.max(start, firstSliceLength(items, capacity)));
  return dequeIterFrom(items, false, { front: start, back: split }, { front: split, back: end });
}

function dequeIterFrom(
  items: Value[],
  mutable: boolean,
  i1: { front: number; back: number },
  i2: { front: number; back: number }
): IterValue {
  const element = (index: number): Value => (mutable ? new ElementPlace(items, index) : items[index]);
  const take = (range: { front: number; back: number }, fromBack: boolean): Next => {
    if (range.front >= range.back) return DONE;
    return element(fromBack ? --range.back : range.front++);
  };
  const next = (): Next => {
    const item = take(i1, false);
    if (item !== DONE) return item;
    [i1, i2] = [i2, i1];
    return take(i1, false);
  };
  const nextBack = (): Next => {
    const item = take(i2, true);
    if (item !== DONE) return item;
    [i1, i2] = [i2, i1];
    return take(i2, true);
  };
  const values = (range: { front: number; back: number }): Value[] =>
    Array.from({ length: Math.max(0, range.back - range.front) }, (_, offset) => element(range.front + offset));
  const iter = new IterValue(next, nextBack, () => i1.back - i1.front + i2.back - i2.front);
  iter.borrowedRoots.push(items);
  iter.rest = () => [...values(i1), ...values(i2)];
  if (!mutable) iter.fork = () => dequeIterFrom(items, mutable, { ...i1 }, { ...i2 });
  return described(iter, (show, item) =>
    tuplePart(mutable ? 'IterMut' : 'Iter', [listPart(values(i1), item, show), listPart(values(i2), item, show)])
  );
}

/**
 * `VecDeque::drain`: the elements it takes, and the head std leaves once the drain is dropped (the shorter of the parts
 * before and after it moves); `{:?}` shows std's counters `Drain(drain_len, idx, tail_len, remaining)`.
 */
export function dequeDrain(items: Value[], start: number, end: number, capacity: number, element: Type): IterValue {
  const len = items.length;
  const drainLen = end - start;
  const tailLen = len - end;
  const head = dequeHead(items);
  if (len - drainLen === 0) heads.set(items, 0);
  else if (start < tailLen && capacity > 0) heads.set(items, wrapAdd(head, drainLen, capacity));
  const iter = ownedIter(items.splice(start, drainLen), element);
  let taken = 0;
  const next = iter.next;
  iter.next = () => {
    const item = next();
    if (item !== DONE) taken++;
    return item;
  };
  return described(iter, () => {
    const remaining = iter.rest?.().length ?? 0;
    return tuplePart(
      'Drain',
      [drainLen, start + taken, tailLen, remaining].map((n) => numberPart(n))
    );
  });
}

/** `as_slices`: the elements from the head to the buffer's end, then those that wrap. */
export function dequeSlices(items: Value[], capacity: number): [SliceView, SliceView] {
  const first = firstSliceLength(items, capacity);
  return [new SliceView(items, 0, first), new SliceView(items, first, items.length)];
}
