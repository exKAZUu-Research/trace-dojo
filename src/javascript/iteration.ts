import type { ArrayOps } from './arrayOps';
import type { Value } from './values';

/** What {@link ValueIterator.next} returns once the iteration has ended. */
export const DONE = Symbol('done');

/**
 * JavaScript's iterator over an array or a string. An array is read at each step, so changes the loop body makes are
 * seen, and once the iterator has passed the end it stays done even if the array grows, as an array iterator does.
 */
export class ValueIterator {
  private index = 0;
  private isDone = false;

  /** @param source An array, read by the spec's Get, or values that cannot change, such as a string's code points. */
  constructor(private readonly source: ArrayOps | readonly Value[]) {}

  next(): Value | typeof DONE {
    const { source } = this;
    if (this.isDone || this.index >= source.length) {
      this.isDone = true;
      return DONE;
    }
    const index = this.index++;
    return Array.isArray(source) ? (source as readonly Value[])[index] : (source as ArrayOps).get(index);
  }

  /** The values not read yet, which ends the iteration. */
  rest(): Value[] {
    const values: Value[] = [];
    for (let value = this.next(); value !== DONE; value = this.next()) values.push(value);
    return values;
  }
}
