import type { TurtleState } from '../interpreter/turtleWorld';
import type { BigFloat } from './floats';
import type { FunctionInstance } from './functions';
import type { Type } from './types';
import { WeakValueMap } from './weakValueMap';

/**
 * A value of the running program. Integers of every type are bigints, floats are numbers or BigFloats, enums are their
 * integer tags as bigints, `void` is `undefined`, and types are their {@link Type} objects. Aggregates (arrays,
 * structs, and unions) are mutable objects that assignment copies into, so that pointers into them stay valid.
 */
export type Value =
  | bigint
  | number
  | boolean
  | undefined
  | BigFloat
  | Type
  | ZArray
  | ZStruct
  | ZUnion
  | EnumLiteral
  | ErrorValue
  | Pointer
  | Slice
  | NullValue
  | Some
  | FnValue
  | NativeHandle;

/** Storage that pointers can refer into: a variable, an array's elements, a struct's fields, or a union's payload. */
export interface Slots {
  slots: Value[];
}

/** A variable's storage. */
export class Cell implements Slots {
  slots: Value[];

  constructor(value: Value) {
    this.slots = [value];
  }
}

/**
 * An array's elements: `length` slots from `offset` of storage that a view of part of another array shares, followed
 * by the sentinel of a sentinel-terminated array.
 */
export class ZArray implements Slots {
  constructor(
    public slots: Value[],
    readonly offset = 0,
    readonly length = slots.length
  ) {}

  get(index: number): Value {
    return this.slots[this.offset + index];
  }

  set(index: number, value: Value): void {
    this.slots[this.offset + index] = value;
  }

  /** The elements, followed by the sentinel when `withSentinel`. */
  values(withSentinel = false): Value[] {
    return this.slots.slice(this.offset, this.offset + this.length + (withSentinel ? 1 : 0));
  }

  /** Whether the array holds a sentinel after its elements. */
  get hasSentinel(): boolean {
    return this.offset + this.length < this.slots.length;
  }
}

export class ZStruct implements Slots {
  constructor(public slots: Value[]) {}
}

/** A union value: the index of its active field and that field's value. */
export class ZUnion implements Slots {
  slots: Value[];

  constructor(
    public tag: number,
    payload: Value
  ) {
    this.slots = [payload];
  }
}

export class EnumLiteral {
  private static readonly cache = new WeakValueMap<string, EnumLiteral>();

  private constructor(readonly name: string) {}

  static of(name: string): EnumLiteral {
    let literal = EnumLiteral.cache.get(name);
    if (!literal) {
      literal = new EnumLiteral(name);
      EnumLiteral.cache.set(name, literal);
    }
    return literal;
  }
}

/** An error value, which every error set shares by name. */
export class ErrorValue {
  private static readonly cache = new WeakValueMap<string, ErrorValue>();

  private constructor(readonly name: string) {}

  static of(name: string): ErrorValue {
    let value = ErrorValue.cache.get(name);
    if (!value) {
      value = new ErrorValue(name);
      ErrorValue.cache.set(name, value);
    }
    return value;
  }
}

/** A single-item pointer, to a slot of some storage. */
export class Pointer {
  private static readonly projections = new WeakMap<object, Map<string, Slots>>();
  constructor(
    readonly target: Slots,
    readonly index: number
  ) {}

  load(): Value {
    return this.target.slots[this.index];
  }

  project(kind: 'length' | 'optional'): Pointer {
    let projections = Pointer.projections.get(this.storageIdentity());
    if (!projections) {
      projections = new Map();
      Pointer.projections.set(this.storageIdentity(), projections);
    }
    const key = `${this.index} ${kind}`;
    let storage = projections.get(key);
    if (!storage) {
      storage = kind === 'length' ? new SliceLength(this) : new SomeSlots(this);
      projections.set(key, storage);
    }
    return new Pointer(storage, 0);
  }

  private storageIdentity(): object {
    return this.target instanceof SomeSlots || this.target instanceof SliceLength ? this.target : this.target.slots;
  }

  equals(other: Pointer): boolean {
    return this.storageIdentity() === other.storageIdentity() && this.index === other.index;
  }
}

/** A slice: a pointer to the first of `length` elements of an array, and the length. */
export class Slice {
  constructor(
    readonly target: Slots,
    readonly start: number,
    readonly length: number
  ) {}

  get(index: number): Value {
    return this.target.slots[this.start + index];
  }

  set(index: number, value: Value): void {
    this.target.slots[this.start + index] = value;
  }

  values(): Value[] {
    return this.target.slots.slice(this.start, this.start + this.length);
  }
}

/** The value `null` of every optional type. */
export class NullValue {
  static readonly instance = new NullValue();

  private constructor() {}
}

export const NULL = NullValue.instance;

/** A non-null value of an optional whose payload is itself optional, so that `?(?T)` tells its two nulls apart. */
export class Some {
  constructor(readonly value: Value) {}
}

/** A function, as a value of a function type or a function pointer. */
export class FnValue {
  constructor(readonly fn: FunctionInstance) {}
}

/** A value that the grader implements natively, such as a turtle, an allocator, or a writer. */
export class NativeHandle {
  constructor(
    readonly kind: string,
    readonly state: NativeState
  ) {}
}

export type NativeState = { turtle?: TurtleState } & Record<string, unknown>;

/** The marker of a local that is not in scope yet or any longer, which the trace does not show. */
export const UNASSIGNED = Symbol('unassigned') as unknown as Value;

export function isAggregate(value: Value): value is ZArray | ZStruct | ZUnion {
  return value instanceof ZArray || value instanceof ZStruct || value instanceof ZUnion;
}

/** A copy of a value whose aggregates are fresh, since Zig copies arrays, structs, and unions by value. */
export function copyValue(value: Value): Value {
  if (value instanceof ZArray) {
    const copied = value.values(value.hasSentinel).map((slot) => copyValue(slot));
    return new ZArray(copied, 0, value.length);
  }
  if (value instanceof ZStruct) return new ZStruct(value.slots.map((slot) => copyValue(slot)));
  if (value instanceof ZUnion) return new ZUnion(value.tag, copyValue(value.slots[0]));
  if (value instanceof Some) return new Some(copyValue(value.value));
  return value;
}

/**
 * Stores a value into a slot, copying an aggregate into the one the slot holds when both have the same shape, so that
 * pointers into the slot's aggregate see the new value.
 */
// code-gauge-allow functionCognitiveComplexity 18 -- Handles each kind of value the operation accepts.
export function storeInto(target: Slots, index: number, value: Value): void {
  const current = target.slots[index];
  if (value instanceof ZArray && current instanceof ZArray && current.length === value.length) {
    if (current === value) return;
    const source = value.values();
    for (const [at, slot] of source.entries()) storeInto(current, current.offset + at, slot);
    return;
  }
  if (value instanceof ZStruct && current instanceof ZStruct && current.slots.length === value.slots.length) {
    if (current === value) return;
    const source = [...value.slots];
    for (const [at, slot] of source.entries()) storeInto(current, at, slot);
    return;
  }
  if (value instanceof ZUnion && current instanceof ZUnion && current.tag === value.tag) {
    if (current === value) return;
    storeInto(current, 0, value.slots[0]);
    return;
  }
  if (value instanceof Some && current instanceof Some) {
    const payload = new Cell(current.value);
    storeInto(payload, 0, value.value);
    target.slots[index] = new Some(payload.slots[0]);
    return;
  }
  target.slots[index] = copyValue(value);
}

class SliceLength implements Slots {
  constructor(private readonly pointer: Pointer) {}

  get slots(): Value[] {
    const slice = this.pointer.load() as Slice;
    return new Proxy([BigInt(slice.length)], {
      set: (_, key, value) => {
        if (key === '0')
          this.pointer.target.slots[this.pointer.index] = new Slice(slice.target, slice.start, Number(value));
        return true;
      },
    });
  }
}

/** The payload of an optional whose payload is itself optional, as storage that `.?` points into. */
class SomeSlots implements Slots {
  constructor(private readonly pointer: Pointer) {}

  get slots(): Value[] {
    const some = this.pointer.load() as Some;
    const holder = this.pointer;
    return new Proxy([some.value], {
      set: (_, key, value) => {
        if (key === '0') holder.target.slots[holder.index] = new Some(value as Value);
        return true;
      },
    });
  }
}
