import { callCallback } from './callables';
import { argumentCountMessage, callableProblem } from './calls';
import { compareBytes } from './conversions';
import { throwError } from './errors';
import { checkSetArguments, comparisonSign, userComparisonCaller } from './libArray';
import { isCallable } from './libCore';
import { defineFunction } from './native';
import { toStr } from './operators';
import { share } from './places';
import { type Key, PhpArray, type Value } from './values';
import { zendSort } from './zendSort';

// The array diffs and intersections that take comparison callbacks. Programs see the order of the callbacks' calls, so
// these transcribe ext/standard/array.c: array_udiff_assoc and array_uintersect_assoc look up each key, and the others
// sort each array with zend_sort and walk the sorted lists together.

interface Entry {
  key: Key;
  value: Value;
}

type Compare = (a: Entry, b: Entry) => number;

/**
 * The comparisons of a sorted walk. PHP keeps the callback in use in one global, which `useKey` and `useData` switch
 * at PHP's points: comparing keys after equal values calls the value callback with the keys.
 */
interface Comparisons {
  key: Compare;
  data: Compare;
  useKey: () => void;
  useData: () => void;
}

/** How the sorted walk compares entries: by value (`normal`), by key (`key`), or by key and then value (`assoc`). */
type Behavior = 'normal' | 'key' | 'assoc';

interface SortedOperation {
  name: string;
  intersect: boolean;
  behavior: Behavior;
  /** Whether a callback compares the values (the first callback) and the keys (the last one). */
  userData: boolean;
  userKey: boolean;
}

for (const operation of [
  { name: 'array_udiff', intersect: false, behavior: 'normal', userData: true, userKey: false },
  { name: 'array_uintersect', intersect: true, behavior: 'normal', userData: true, userKey: false },
  { name: 'array_diff_ukey', intersect: false, behavior: 'key', userData: false, userKey: true },
  { name: 'array_intersect_ukey', intersect: true, behavior: 'key', userData: false, userKey: true },
  { name: 'array_diff_uassoc', intersect: false, behavior: 'assoc', userData: false, userKey: true },
  { name: 'array_intersect_uassoc', intersect: true, behavior: 'assoc', userData: false, userKey: true },
  { name: 'array_udiff_uassoc', intersect: false, behavior: 'assoc', userData: true, userKey: true },
  { name: 'array_uintersect_uassoc', intersect: true, behavior: 'assoc', userData: true, userKey: true },
] as const satisfies SortedOperation[]) {
  defineFunction(`${operation.name}(...$arrays): array`, ({ args }) => sortedOperation(operation, args));
}
for (const [name, intersect] of [
  ['array_udiff_assoc', false],
  ['array_uintersect_assoc', true],
] as const) {
  defineFunction(`${name}(...$arrays): array`, ({ args }) => {
    const [arrays, [callback]] = splitCallbacks(name, args, 1);
    checkSetArguments(name, arrays);
    return lookupOperation(arrays as PhpArray[], intersect, (a, b) => comparisonSign(callCallback(callback, [a, b])));
  });
}

function sortedOperation(operation: SortedOperation, args: Value[]): PhpArray {
  const { name, behavior } = operation;
  const [arrays, callbacks] = splitCallbacks(name, args, Number(operation.userData) + Number(operation.userKey));
  const comparisons = comparisonsFor(operation, callbacks);
  const lists: Entry[][] = [];
  for (const [index, array] of arrays.entries()) {
    checkSetArguments(name, arrays.slice(0, index + 1));
    const list = [...(array as PhpArray).entries()].map(([key, value]) => ({ key, value }));
    if (list.length > 1) zendSort(list, behavior === 'normal' ? comparisons.data : comparisons.key);
    lists.push(list);
  }
  const walk = new SortedWalk(lists, behavior, comparisons);
  const result = (arrays[0] as PhpArray).copy();
  for (const key of operation.intersect ? walk.intersect() : walk.diff()) result.delete(key);
  return result;
}

function comparisonsFor(operation: SortedOperation, callbacks: Value[]): Comparisons {
  const userCompare = userComparisonCaller(operation.name);
  const [dataCallback, keyCallback] = [callbacks[0], callbacks.at(-1) as Value];
  let current = operation.userKey && operation.behavior !== 'normal' ? keyCallback : dataCallback;
  return {
    data: operation.userData
      ? (a, b) => userCompare(current, a.value, b.value)
      : (a, b) => compareBytes(toStr(a.value), toStr(b.value)),
    key: operation.userKey
      ? (a, b) => userCompare(current, a.key, b.key)
      : (a, b) => compareBytes(String(a.key), String(b.key)),
    useKey: () => {
      if (operation.userKey) current = keyCallback;
    },
    useData: () => {
      if (operation.userData) current = dataCallback;
    },
  };
}

/** Splits the arguments into the arrays and the trailing callbacks, checking the callbacks as PHP does first. */
function splitCallbacks(name: string, args: Value[], count: number): [Value[], Value[]] {
  if (args.length <= count) {
    throwError('ArgumentCountError', argumentCountMessage(name, count + 1, Infinity, args.length));
  }
  const first = args.length - count;
  for (let index = first; index < args.length; index++) {
    if (!isCallable(args[index])) {
      throwError(
        'TypeError',
        `${name}(): Argument #${index + 1} must be a valid callback, ${callableProblem(args[index])}`
      );
    }
  }
  return [args.slice(0, first), args.slice(first)];
}

/** Walks the sorted lists of php_array_intersect and php_array_diff together, as their loops do. */
class SortedWalk {
  readonly pointers: number[];

  constructor(
    readonly lists: Entry[][],
    readonly behavior: Behavior,
    readonly comparisons: Comparisons
  ) {
    this.pointers = lists.map(() => 0);
  }

  at(list: number): Entry | undefined {
    return this.lists[list][this.pointers[list]];
  }

  /** Transcribes php_array_intersect's walk, yielding the keys of the first array that the result leaves out. */
  *intersect(): Generator<Key> {
    while (this.at(0)) {
      this.comparisons.useKey();
      const mismatch = this.commonMismatch();
      if (mismatch === undefined) {
        for (let entry = this.at(0); entry; entry = this.next()) yield entry.key;
        return;
      }
      if (mismatch) yield* this.dropBefore(mismatch);
      else this.skipEqual();
    }
  }

  /**
   * Looks for the first list's entry in the other lists: the first list that lacks it, 0 if all have it, or undefined
   * if a list ran out, which leaves out the rest of the first list.
   */
  private commonMismatch(): number | undefined {
    for (let index = 1; index < this.lists.length; index++) {
      const c = this.seekCommon(index);
      if (!this.at(index)) return undefined;
      if (c) return index;
      this.pointers[index]++;
    }
    return 0;
  }

  /** Moves list `index` past the entries before the first list's, returning how they compare as PHP's `c`. */
  private seekCommon(index: number): number {
    const { key, data } = this.comparisons;
    const first = this.at(0) as Entry;
    const compare = this.behavior === 'normal' ? data : key;
    let c = 0;
    while (this.at(index) && (c = compare(first, this.at(index) as Entry)) > 0) this.pointers[index]++;
    if (c || !this.at(index) || this.behavior !== 'assoc') return c;
    this.comparisons.useData();
    if (data(first, this.at(index) as Entry) === 0) return 0;
    this.comparisons.useKey();
    return 1;
  }

  /** Leaves out the first list's entries that come before list `index`'s, which no other list has. */
  private *dropBefore(index: number): Generator<Key> {
    for (;;) {
      yield (this.at(0) as Entry).key;
      const entry = this.next();
      if (!entry || this.behavior !== 'normal' || this.comparisons.data(entry, this.at(index) as Entry) >= 0) return;
    }
  }

  /** Transcribes php_array_diff's walk, yielding the keys of the first array that the result leaves out. */
  *diff(): Generator<Key> {
    while (this.at(0)) {
      this.comparisons.useKey();
      let c = 1;
      for (let index = 1; index < this.lists.length; index++) {
        const [result, found] = this.findIn(index, c);
        c = result;
        if (found) break;
      }
      if (c) {
        this.skipEqual();
        continue;
      }
      for (let entry = this.at(0); entry; entry = this.nextDifferent()) yield entry.key;
    }
  }

  /** Looks for the first list's entry in list `index`, returning PHP's `c` and whether the walk stops looking. */
  private findIn(index: number, previous: number): [number, boolean] {
    const first = this.at(0) as Entry;
    const list = this.lists[index];
    let c = previous;
    if (this.behavior === 'normal') {
      while (this.at(index) && (c = this.comparisons.data(first, this.at(index) as Entry)) > 0) this.pointers[index]++;
      if (c) return [c, false];
      if (this.at(index)) this.pointers[index]++;
      return [0, true];
    }
    let pointer = this.pointers[index];
    while (list[pointer] && (c = this.comparisons.key(first, list[pointer])) !== 0) pointer++;
    if (c) return [c, false];
    if (this.behavior === 'key') return [0, true];
    if (!list[pointer]) return [0, false];
    this.comparisons.useData();
    if (this.comparisons.data(first, list[pointer]) === 0) return [0, true];
    this.comparisons.useKey();
    return [-1, false];
  }

  /** Moves past the first list's entry and, comparing by value, past those equal to it. */
  private skipEqual(): void {
    while (this.nextDifferent()) {
      // Moves on until an entry differs.
    }
  }

  /** Moves to the first list's next entry, returning it unless it compares by value equal to the one before. */
  private nextDifferent(): Entry | undefined {
    const previous = this.at(0) as Entry;
    const entry = this.next();
    if (!entry || this.behavior !== 'normal' || this.comparisons.data(previous, entry)) return undefined;
    return entry;
  }

  private next(): Entry | undefined {
    this.pointers[0]++;
    return this.at(0);
  }
}

/** Transcribes php_array_intersect_key and php_array_diff_key, which look up each key of the first array. */
function lookupOperation(arrays: PhpArray[], intersect: boolean, same: (a: Value, b: Value) => number): PhpArray {
  const [first, ...others] = arrays;
  const result = new PhpArray();
  for (const [key, value] of first.entries()) {
    const matches = (other: PhpArray): boolean => other.has(key) && same(value, other.get(key) as Value) === 0;
    const keep = intersect ? others.every((other) => matches(other)) : !others.some((other) => matches(other));
    if (keep) result.set(key, share(value));
  }
  return result;
}
