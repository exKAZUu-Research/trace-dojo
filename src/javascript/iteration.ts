import { JsArray, type Value, valueOfElement } from './values';

/** What {@link ValueIterator.next} returns once the iteration has ended. */
export const DONE = Symbol('done');

/**
 * JavaScript's iterator over an array or a string. An array is read at each step, so changes the loop body makes are
 * seen, and once the iterator has passed the end it stays done even if the array grows, as an array iterator does.
 */
export class ValueIterator {
  private index = 0;
  private isDone = false;

  /** @param source An array, or the code points of a string, which cannot change. */
  constructor(private readonly source: JsArray | readonly string[]) {}

  next(): Value | typeof DONE {
    const length = this.source instanceof JsArray ? this.source.elements.length : this.source.length;
    if (this.isDone || this.index >= length) {
      this.isDone = true;
      return DONE;
    }
    const index = this.index++;
    return this.source instanceof JsArray ? valueOfElement(this.source.elements[index]) : this.source[index];
  }

  /** The values not read yet, which ends the iteration. */
  rest(): Value[] {
    const values: Value[] = [];
    for (let value = this.next(); value !== DONE; value = this.next()) values.push(value);
    return values;
  }
}
