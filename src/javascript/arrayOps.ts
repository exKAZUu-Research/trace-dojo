import type { Runtime } from './runtime';
import { HOLE, isAccessor, isObject, JsArray, type JsObject, type Value } from './values';

/**
 * The spec's abstract operations on an array by index (`HasProperty`, `Get`, `Set`, `DeletePropertyOrThrow`), in
 * which the Array builtins are written as the spec writes them. Each operation reads the array as it is now, so the
 * builtins see what callbacks change, refuse writes to frozen arrays, and charge for growth as assignments do. Any
 * other object works through its `length` and index properties, as the builtins are generic.
 */
export class ArrayOps {
  private uncharged = 0;

  constructor(
    private readonly runtime: Runtime,
    readonly array: JsObject
  ) {}

  get length(): number {
    const { array } = this;
    if (array instanceof JsArray) return array.elements.length;
    // The spec's ToLength.
    const length = this.runtime.toNumber(this.runtime.get(array, 'length'));
    return Number.isNaN(length) || length <= 0 ? 0 : Math.min(Math.trunc(length), Number.MAX_SAFE_INTEGER);
  }

  has(index: number): boolean {
    this.charge();
    return this.runtime.hasProperty(this.array, String(index));
  }

  get(index: number): Value {
    this.charge();
    const element = this.own(index);
    if (element !== HOLE) return element;
    const { proto } = this.array;
    return proto ? this.runtime.get(proto, String(index), this.array) : undefined;
  }

  set(index: number, value: Value): void {
    if (this.array instanceof JsArray) this.runtime.setElement(this.array, index, value);
    else this.runtime.set(this.array, String(index), value);
  }

  delete(index: number): void {
    this.runtime.deleteProperty(this.array, String(index));
  }

  setLength(length: number): void {
    if (this.array instanceof JsArray) this.runtime.setLength(this.array, length);
    else this.runtime.set(this.array, 'length', length);
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
    const { array } = this;
    if (array instanceof JsArray && !array.definedElements?.has(index)) {
      return index < array.elements.length ? array.elements[index] : HOLE;
    }
    const property = this.runtime.getOwnProperty(array, String(index));
    if (!property) return HOLE;
    return isAccessor(property) ? this.runtime.get(array, String(index)) : property.value;
  }
}

/** The spec's CreateListFromArrayLike, which `apply` takes its arguments with; `null` and `undefined` give none. */
export function listFromArrayLike(runtime: Runtime, value: Value): Value[] {
  if (value === undefined || value === null) return [];
  if (!isObject(value)) return runtime.throwError('TypeError', 'CreateListFromArrayLike called on non-object');
  const ops = new ArrayOps(runtime, value);
  const { length } = ops;
  runtime.scan(length);
  return Array.from({ length }, (_, index) => ops.get(index));
}
