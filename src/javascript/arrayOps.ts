import type { Runtime } from './runtime';
import { HOLE, type JsArray, type Value } from './values';

/**
 * The spec's abstract operations on an array by index (`HasProperty`, `Get`, `Set`, `DeletePropertyOrThrow`), in
 * which the Array builtins are written as the spec writes them. Each operation reads the array as it is now, so the
 * builtins see what callbacks change, refuse writes to frozen arrays, and charge for growth as assignments do.
 */
export class ArrayOps {
  private uncharged = 0;

  constructor(
    private readonly runtime: Runtime,
    readonly array: JsArray
  ) {}

  get length(): number {
    return this.array.elements.length;
  }

  has(index: number): boolean {
    this.charge();
    if (this.own(index) !== HOLE) return true;
    const { proto } = this.array;
    return proto !== null && this.runtime.hasProperty(proto, String(index));
  }

  get(index: number): Value {
    this.charge();
    const element = this.own(index);
    if (element !== HOLE) return element;
    const { proto } = this.array;
    return proto ? this.runtime.get(proto, String(index), this.array) : undefined;
  }

  set(index: number, value: Value): void {
    this.runtime.setElement(this.array, index, value);
  }

  delete(index: number): void {
    this.runtime.deleteProperty(this.array, String(index));
  }

  setLength(length: number): void {
    this.runtime.setLength(this.array, length);
  }

  /** Copies index `from` to index `to`, or deletes `to` when `from` is absent, as the shifting builtins do. */
  move(from: number, to: number): void {
    if (this.has(from)) this.set(to, this.get(from));
    else this.delete(to);
  }

  /** Charges one operation per 64 element operations, so that every builtin's scan is bounded by the budget and clock. */
  private charge(): void {
    if (++this.uncharged < 64) return;
    this.uncharged = 0;
    this.runtime.spend();
  }

  private own(index: number): Value | typeof HOLE {
    const { elements } = this.array;
    return index < elements.length ? elements[index] : HOLE;
  }
}
