import { JsThrow, type Value } from './values';

/** Runs `run`, closing the iterator when it throws, as the spec's IfAbruptCloseIterator does. */
export function closingOnThrow<T>(iterator: ValueIterator, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof JsThrow) iterator.close('throw');
    throw error;
  }
}

/** What {@link ValueIterator.next} returns once the iteration has ended. */
export const DONE = Symbol('done');

/** A builtin iterator's steps: the next value or {@link DONE}, and what leaving a loop early runs. */
export interface HostIterator {
  next: () => Value | typeof DONE;
  close?: () => void;
  /** The object the iteration reads, which garbage collection must keep alive with the iterator. */
  source?: Value;
}

/**
 * An iteration a loop, a spread, or a destructuring steps through: a builtin iterator, or fixed values such as the
 * keys `for...in` visits. Once it has ended, it stays done.
 */
export class ValueIterator {
  private index = 0;
  private isDone = false;

  constructor(private readonly source: readonly Value[] | HostIterator) {}

  next(): Value | typeof DONE {
    const { source } = this;
    if (this.isDone) return DONE;
    if (!Array.isArray(source)) {
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
    return (source as readonly Value[])[this.index++];
  }

  /**
   * Ends the iteration before it is done, as leaving a loop or a destructuring early does. After an exception, an
   * error from closing is discarded, so the exception that ended the iteration propagates.
   */
  close(completion: 'normal' | 'throw' = 'normal'): void {
    if (this.isDone) return;
    this.isDone = true;
    const { source } = this;
    if (Array.isArray(source)) return;
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
