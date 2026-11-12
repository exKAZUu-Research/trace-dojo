import { ArrayOps } from './arrayOps';
import { JsThrow, type Value } from './values';

/** What {@link ValueIterator.next} returns once the iteration has ended. */
export const DONE = Symbol('done');

/** A builtin iterator's steps: the next value or {@link DONE}, and what leaving a loop early runs. */
export interface HostIterator {
  next: () => Value | typeof DONE;
  close?: () => void;
}

/**
 * JavaScript's iterator over an array, a string, or a builtin iterator. An array is read at each step, so changes the
 * loop body makes are seen, and once the iterator has passed the end it stays done even if the array grows, as an
 * array iterator does.
 */
export class ValueIterator {
  private index = 0;
  private isDone = false;

  /**
   * @param source An array, read by the spec's Get, values that cannot change, such as a string's code points, or a
   * builtin iterator.
   */
  constructor(private readonly source: ArrayOps | readonly Value[] | HostIterator) {}

  next(): Value | typeof DONE {
    const { source } = this;
    if (this.isDone) return DONE;
    if (!Array.isArray(source) && !(source instanceof ArrayOps)) {
      let value: Value | typeof DONE;
      try {
        value = (source as HostIterator).next();
      } catch (error) {
        // An iterator whose step failed is done, and closing it calls nothing.
        this.isDone = true;
        throw error;
      }
      if (value === DONE) this.isDone = true;
      return value;
    }
    if (this.index >= source.length) {
      this.isDone = true;
      return DONE;
    }
    const index = this.index++;
    return Array.isArray(source) ? (source as readonly Value[])[index] : (source as ArrayOps).get(index);
  }

  /**
   * Ends the iteration before it is done, as leaving a loop or a destructuring early does. After an exception, an
   * error from closing is discarded, so the exception that ended the iteration propagates.
   */
  close(completion: 'normal' | 'throw' = 'normal'): void {
    if (this.isDone) return;
    this.isDone = true;
    const { source } = this;
    if (Array.isArray(source) || source instanceof ArrayOps) return;
    try {
      (source as HostIterator).close?.();
    } catch (error) {
      if (completion === 'normal' || !(error instanceof JsThrow)) throw error;
    }
  }

  /** The values not read yet, which ends the iteration. */
  rest(): Value[] {
    const values: Value[] = [];
    for (let value = this.next(); value !== DONE; value = this.next()) values.push(value);
    return values;
  }
}
