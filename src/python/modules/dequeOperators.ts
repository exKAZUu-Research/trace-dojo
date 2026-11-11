// The operators of `collections.deque`: concatenation, repetition, and ordering, as Modules/_collectionsmodule.c has.
import { method } from '../define';
import { toIndex } from '../numbers';
import { toArray } from '../objects';
import { equals, lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { NotImplemented, typeError, typeName } from '../types';
import { PyDeque, type PyValue } from '../values';
import { dequeClass } from './collections';

const dequeOf = (self: PyValue): PyDeque => self as PyDeque;

/** A deque of `items` with the maxlen of `like`, which keeps only the last items that fit, as appending does. */
function newDeque(like: PyDeque, items: PyValue[]): PyDeque {
  const kept = like.maxlen === undefined ? items : items.slice(Math.max(items.length - like.maxlen, 0));
  return new PyDeque(like.cls, kept, like.maxlen);
}

function repeatCount(count: PyValue): number {
  const times = toIndex(count, () => `can't multiply sequence by non-int of type '${typeName(count)}'`);
  return times > 0n ? Number(times) : 0;
}

/** The items of `times` copies of a deque, without the leading ones that its maxlen would drop. */
function repeated(deque: PyDeque, times: number): PyValue[] {
  const { items } = deque;
  const total = items.length * times;
  const start = deque.maxlen === undefined ? 0 : Math.max(total - deque.maxlen, 0);
  currentRuntime().allocate(total - start);
  return Array.from({ length: total - start }, (_, index) => items[(start + index) % items.length]);
}

method(dequeClass, '__add__', 'one', 1, 1, (self, [other]) => {
  if (!(other instanceof PyDeque)) throw typeError(`can only concatenate deque (not "${typeName(other)}") to deque`);
  currentRuntime().allocate(dequeOf(self).items.length + other.items.length);
  return newDeque(dequeOf(self), [...dequeOf(self).items, ...other.items]);
});
method(dequeClass, '__iadd__', 'one', 1, 1, (self, [other]) => {
  const deque = dequeOf(self);
  const added = toArray(other);
  currentRuntime().allocate(added.length);
  deque.items = newDeque(deque, [...deque.items, ...added]).items;
  return deque;
});
for (const name of ['__mul__', '__rmul__']) {
  method(dequeClass, name, 'one', 1, 1, (self, [count]) => {
    const deque = dequeOf(self);
    return newDeque(deque, repeated(deque, repeatCount(count)));
  });
}
method(dequeClass, '__imul__', 'one', 1, 1, (self, [count]) => {
  const deque = dequeOf(self);
  deque.items = newDeque(deque, repeated(deque, repeatCount(count))).items;
  return deque;
});

/** Compares two deques item by item, as sequences compare. */
function compareDeques(left: PyDeque, right: PyDeque): number {
  const length = Math.min(left.items.length, right.items.length);
  for (let index = 0; index < length; index++) {
    const [a, b] = [left.items[index], right.items[index]];
    if (!equals(a, b)) return lessThan(a, b) ? -1 : 1;
  }
  return left.items.length - right.items.length;
}

for (const [name, holds] of [
  ['__lt__', (order: number) => order < 0],
  ['__le__', (order: number) => order <= 0],
  ['__gt__', (order: number) => order > 0],
  ['__ge__', (order: number) => order >= 0],
] as const) {
  method(dequeClass, name, 'one', 1, 1, (self, [other]) =>
    other instanceof PyDeque ? holds(compareDeques(dequeOf(self), other)) : NotImplemented
  );
}
