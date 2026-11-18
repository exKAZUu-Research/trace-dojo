import { type Behavior, type Comparisons, type Entry, setEntries, SortedWalk } from './arraySetWalk';
import { consumeCallbackResult } from './callables';
import { argumentCountMessage, callableProblem } from './calls';
import { compareBytes } from './conversions';
import { throwError } from './errors';
import { checkSetArguments, comparisonSign, userComparisonCaller } from './libArray';
import { isCallable } from './libCore';
import { defineFunction } from './native';
import { toStr } from './operators';
import { copyValueSlot, deref, PhpArray, type Value } from './values';
import { zendSort } from './zendSort';

// The array diffs and intersections that take comparison callbacks. Programs see the order of the callbacks' calls, so
// these transcribe ext/standard/array.c: array_udiff_assoc and array_uintersect_assoc look up each key, and the others
// sort each array with zend_sort and walk the sorted lists together.

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
    return lookupOperation(arrays as PhpArray[], intersect, (a, b) =>
      consumeCallbackResult(callback, [a, b], comparisonSign)
    );
  });
}

function sortedOperation(operation: SortedOperation, args: Value[]): PhpArray {
  const { name, behavior } = operation;
  const [arrays, callbacks] = splitCallbacks(name, args, Number(operation.userData) + Number(operation.userKey));
  const comparisons = comparisonsFor(operation, callbacks);
  const lists: Entry[][] = [];
  for (const [index, array] of arrays.entries()) {
    checkSetArguments(name, arrays.slice(0, index + 1));
    const list = setEntries(array as PhpArray);
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
  const dataCallback = callbacks[0];
  const keyCallback = callbacks.at(-1) as Value;
  let current = operation.userKey && operation.behavior !== 'normal' ? keyCallback : dataCallback;
  return {
    data: operation.userData
      ? (a, b) => userCompare(current, deref(a.slot), deref(b.slot))
      : (a, b) => compareBytes(toStr(deref(a.slot)), toStr(deref(b.slot))),
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

function lookupOperation(arrays: PhpArray[], intersect: boolean, same: (a: Value, b: Value) => number): PhpArray {
  const [first, ...others] = arrays;
  const result = new PhpArray();
  for (const [key, slot] of first.map) {
    const matches = (other: PhpArray): boolean => {
      const otherSlot = other.map.get(key);
      return otherSlot !== undefined && same(deref(slot), deref(otherSlot)) === 0;
    };
    const keep = intersect ? others.every((other) => matches(other)) : !others.some((other) => matches(other));
    if (keep) result.setSlot(key, copyValueSlot(slot));
  }
  return result;
}
