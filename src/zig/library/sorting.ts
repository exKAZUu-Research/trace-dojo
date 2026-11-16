import type { Frame } from '../runtime';
import type { Value } from '../values';

/**
 * Sorts values with a `lessThan` function. A stable sort's result is the one every stable algorithm gives, which is
 * that of Zig's block sort; the unstable sorts order equal elements as a stable sort does.
 */
export function sortValues(
  values: Value[],
  lessThan: (a: Value, b: Value) => boolean,
  stable: boolean,
  frame: Frame
): Value[] {
  void stable;
  return mergeSort(values, lessThan, frame);
}

function mergeSort(values: Value[], lessThan: (a: Value, b: Value) => boolean, frame: Frame): Value[] {
  if (values.length <= 1) return values;
  const middle = Math.floor(values.length / 2);
  const left = mergeSort(values.slice(0, middle), lessThan, frame);
  const right = mergeSort(values.slice(middle), lessThan, frame);
  const merged: Value[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    frame.runtime.spend();
    if (lessThan(right[j], left[i])) merged.push(right[j++]);
    else merged.push(left[i++]);
  }
  return [...merged, ...left.slice(i), ...right.slice(j)];
}
