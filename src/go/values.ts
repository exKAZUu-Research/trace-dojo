import type { TurtleState } from '../interpreter/turtleWorld';
import type { Type } from './types';

/**
 * A Go value. Integers of every kind are bigints, floats are numbers, and strings hold UTF-8 bytes as code units.
 * `undefined` is the nil of pointers, slices, maps, functions, and interfaces.
 */
export type Value =
  | boolean
  | bigint
  | number
  | string
  | Complex
  | Pointer
  | GoStruct
  | GoArray
  | Slice
  | GoMap
  | GoFunc
  | Iface
  | undefined;

export class Complex {
  constructor(
    readonly re: number,
    readonly im: number
  ) {}
}

/** A variable that a closure captures or a pointer refers to, which must outlive its frame. */
export class Cell {
  constructor(public v: Value) {}
}

/** A pointer to a cell, a struct field, or an array element: the object that holds the value and its key there. */
export class Pointer {
  constructor(
    readonly base: Cell | Value[],
    readonly key: number | 'v'
  ) {}

  load(): Value {
    return (this.base as unknown as Record<string | number, Value>)[this.key];
  }

  store(value: Value): void {
    const record = this.base as unknown as Record<string | number, Value>;
    record[this.key] = writeInPlace(record[this.key], value);
  }

  equals(other: Pointer): boolean {
    return this.base === other.base && this.key === other.key;
  }
}

/** A struct value, which assignment copies. Library types keep their state in `native`. */
export class GoStruct {
  constructor(
    readonly fields: Value[],
    public native?: NativeState
  ) {}
}

/** Library state of a struct value: a turtle, or the fields a library type keeps outside Go's view. */
export interface NativeState {
  turtle?: TurtleState;
  clone?(): NativeState;
  /** The values of the type's declared fields, for a library type that keeps them in this state instead. */
  fieldValues?(): Value[];
  [key: string]: unknown;
}

/** An array value, which assignment copies. */
export class GoArray {
  constructor(readonly elements: Value[]) {}
}

export class Slice {
  constructor(
    readonly array: Value[],
    readonly offset: number,
    readonly length: number,
    readonly capacity: number
  ) {}

  get(index: number): Value {
    return this.array[this.offset + index];
  }

  set(index: number, value: Value): void {
    this.array[this.offset + index] = writeInPlace(this.array[this.offset + index], value);
  }

  values(): Value[] {
    return this.array.slice(this.offset, this.offset + this.length);
  }
}

/** A map, keyed by the comparable form of its keys, that keeps insertion order (Go leaves its order unspecified). */
export class GoMap {
  readonly entries = new Map<unknown, { key: Value; value: Value }>();

  constructor(readonly keyOf: (key: Value) => unknown) {}
}

/** A function value: a declared function, a method value, a closure with the cells it captured, or a library function. */
export class GoFunc {
  constructor(
    /**
     * Runs the function. `callRow` is the row of the call, for the trace; `deferredFor` is the frame whose deferred
     * call this is, where `recover` works.
     */
    readonly call: (
      args: Value[],
      callRow?: number,
      deferredFor?: unknown,
      resultStaysOnStack?: boolean
    ) => Value | Value[],
    /** The values the function keeps alive, which garbage collection follows. */
    readonly captured: readonly unknown[] = []
  ) {}
}

/** A non-nil interface value: its dynamic type and the value of that type. */
export class Iface {
  constructor(
    readonly type: Type,
    readonly value: Value
  ) {}
}

/** Copies a value as assignment does: structs and arrays are values, everything else is shared. */
export function copyValue(value: Value): Value {
  if (value instanceof GoStruct) {
    return new GoStruct(value.fields.map(copyValue), value.native?.clone ? value.native.clone() : value.native);
  }
  if (value instanceof GoArray) return new GoArray(value.elements.map(copyValue));
  return value;
}

/**
 * Writes `next` into existing storage `current`, updating struct fields and array elements in place so that existing
 * pointers and slices into the destination continue to observe the variable's storage.
 */
export function writeInPlace(current: Value, next: Value): Value {
  if (current instanceof GoStruct && next instanceof GoStruct && current.fields.length === next.fields.length) {
    if (current === next) return current;
    for (let index = 0; index < current.fields.length; index++) {
      current.fields[index] = writeInPlace(current.fields[index], next.fields[index]);
    }
    current.native = next.native?.clone ? next.native.clone() : next.native;
    return current;
  }
  if (current instanceof GoArray && next instanceof GoArray && current.elements.length === next.elements.length) {
    if (current === next) return current;
    for (let index = 0; index < current.elements.length; index++) {
      current.elements[index] = writeInPlace(current.elements[index], next.elements[index]);
    }
    return current;
  }
  return copyValue(next);
}
