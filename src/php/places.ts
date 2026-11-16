import { deprecated, throwError, warn } from './errors';
import { toKey } from './operators';
import type { Frame } from './runtime';
import { type Key, PhpArray, PhpObject, Ref, type Value } from './values';

/** A location a program writes to: a variable, an element, a property, or a static property. */
export interface Place {
  /** The value, or undefined when the location does not exist. */
  get(): Value | undefined;
  set(value: Value): void;
  /** The location as a reference, which `=&`, by-reference arguments, and `global` share. */
  ref(): Ref;
  unset(): void;
}

/** Marks an array as held by more than one holder, so that the next write copies it. */
export function share(value: Value): Value {
  if (value instanceof PhpArray) value.shared = true;
  return value;
}

export class VarPlace implements Place {
  constructor(
    private readonly frame: Frame,
    readonly name: string
  ) {}

  get(): Value | undefined {
    return this.frame.vars.get(this.name)?.v;
  }

  set(value: Value): void {
    const ref = this.frame.vars.get(this.name);
    if (ref) ref.v = value;
    else this.frame.vars.set(this.name, new Ref(value));
  }

  ref(): Ref {
    let ref = this.frame.vars.get(this.name);
    if (!ref) {
      ref = new Ref(null);
      this.frame.vars.set(this.name, ref);
    }
    return ref;
  }

  unset(): void {
    const ref = this.frame.vars.get(this.name);
    if (ref) {
      ref.rc--;
      this.frame.vars.delete(this.name);
    }
  }

  bind(ref: Ref): void {
    const old = this.frame.vars.get(this.name);
    if (old === ref) return;
    if (old) old.rc--;
    ref.isRef = true;
    ref.rc++;
    this.frame.vars.set(this.name, ref);
  }
}

export class RefPlace implements Place {
  constructor(readonly target: Ref) {}

  get(): Value {
    return this.target.v;
  }

  set(value: Value): void {
    this.target.v = value;
  }

  ref(): Ref {
    return this.target;
  }

  unset(): void {
    throwError('Error', 'Attempt to unset static property');
  }
}

export class ElementPlace implements Place {
  constructor(
    readonly array: PhpArray,
    /** The key, or undefined to append. */
    public key: Key | undefined
  ) {}

  get(): Value | undefined {
    if (this.key === undefined) return undefined;
    return this.array.get(this.key);
  }

  set(value: Value): void {
    if (this.key === undefined) {
      const key = this.array.nextFree;
      if (!this.array.append(value)) {
        throwError('Error', 'Cannot add element to the array as the next element is already occupied');
      }
      this.key = key;
      return;
    }
    this.array.set(this.key, value);
  }

  ref(): Ref {
    if (this.key === undefined) {
      const ref = new Ref(null);
      ref.isRef = true;
      const key = this.array.nextFree;
      if (!this.array.append(ref)) {
        throwError('Error', 'Cannot add element to the array as the next element is already occupied');
      }
      this.key = key;
      return ref;
    }
    const slot = this.array.map.get(this.key);
    if (slot instanceof Ref) return slot;
    const ref = new Ref(slot ?? null);
    ref.isRef = true;
    this.array.setSlot(this.key, ref);
    return ref;
  }

  unset(): void {
    if (this.key !== undefined) this.array.delete(this.key);
  }
}

/** A value that is not a location, such as a call's result, which writes cannot change. */
export class ValuePlace implements Place {
  constructor(readonly value: Value) {}

  get(): Value {
    return this.value;
  }

  set(): void {
    throwError('Error', 'Cannot use temporary expression in write context');
  }

  ref(): Ref {
    return new Ref(this.value);
  }

  unset(): void {}
}

/**
 * The array a nested write goes into, after separating it from other holders or creating it, or the ArrayAccess
 * object that receives the write.
 */
export function writableContainer(place: Place): PhpArray | PhpObject | string {
  const value = place.get();
  if (value instanceof PhpArray) {
    if (value.shared) {
      const copy = value.copy();
      place.set(copy);
      return copy;
    }
    return value;
  }
  if (value === undefined || value === null) {
    const array = new PhpArray();
    place.set(array);
    return array;
  }
  if (value === false) {
    deprecated('Automatic conversion of false to array is deprecated');
    const array = new PhpArray();
    place.set(array);
    return array;
  }
  if (value instanceof PhpObject) return value;
  if (typeof value === 'string') {
    if (value === '') {
      throwError('Error', '[] operator not supported for strings');
    }
    return value;
  }
  throwError('Error', 'Cannot use a scalar value as an array');
}

/** Reads an element of an array, warning as PHP does when the key does not exist. */
export function readElement(array: PhpArray, key: Key, quiet: boolean): Value {
  const value = array.get(key);
  if (value === undefined) {
    if (!quiet) warn(`Undefined array key ${typeof key === 'bigint' ? key : `"${key}"`}`);
    return null;
  }
  return value;
}

export { toKey };
