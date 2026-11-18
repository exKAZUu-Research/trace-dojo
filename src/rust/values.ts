import type { TurtleState } from '../interpreter/turtleWorld';
import type { AdtDef, Type } from './types';

/**
 * A value at run time. Types decide how a value reads, so values carry no types: integers are bigints, floats
 * numbers, `char`s and strings JS strings, tuples, arrays, and `Vec`s JS arrays, and a shared reference is the value it
 * refers to, since nothing can change that value while the reference lives. A mutable reference is a {@link Place}.
 * `Box<T>` is the boxed value itself.
 */
export type Value =
  | bigint
  | number
  | boolean
  | string
  | Value[]
  | StructValue
  | EnumValue
  | Place
  | SliceView
  | FnValue
  | IterValue
  | MapValue
  | SetValue
  | RangeValue
  | DynValue
  | TurtleValue
  | FormatterValue
  | EntryValue
  | undefined;

export const UNIT_VALUE: Value[] = Object.freeze([]) as unknown as Value[];

export class StructValue {
  constructor(
    readonly def: AdtDef,
    readonly fields: Value[]
  ) {}
}

export class EnumValue {
  constructor(
    readonly def: AdtDef,
    readonly variant: number,
    readonly fields: Value[]
  ) {}
}

/** Where a mutable reference points: a variable, a field, an element, or a value a `Box` holds. */
export interface Place {
  readonly isPlace: true;
  get(): Value;
  set(value: Value): void;
}

export class CellPlace implements Place {
  readonly isPlace = true;
  constructor(public value: Value) {}

  get(): Value {
    return this.value;
  }

  set(value: Value): void {
    this.value = value;
  }
}

export class ElementPlace implements Place {
  readonly isPlace = true;
  constructor(
    readonly array: Value[],
    readonly index: number
  ) {}

  get(): Value {
    return this.array[this.index];
  }

  set(value: Value): void {
    this.array[this.index] = value;
  }
}

export class AccessorPlace implements Place {
  readonly isPlace = true;
  constructor(
    readonly get: () => Value,
    readonly set: (value: Value) => void
  ) {}
}

export function isPlace(value: unknown): value is Place {
  return typeof value === 'object' && value !== null && (value as Place).isPlace === true;
}

/** A shared or mutable slice of an array or `Vec`: a window on its elements. */
export class SliceView {
  constructor(
    readonly base: Value[],
    readonly start: number,
    readonly end: number
  ) {}

  get length(): number {
    return this.end - this.start;
  }
}

/** A slice as an array of its elements, which copies a window and returns a whole array as it is. */
export function sliceItems(value: Value): Value[] {
  if (value instanceof SliceView) return value.base.slice(value.start, value.end);
  return value as Value[];
}

export function sliceLength(value: Value): number {
  if (value instanceof SliceView) return value.end - value.start;
  return (value as Value[]).length;
}

export function sliceGet(value: Value, index: number): Value {
  if (value instanceof SliceView) return value.base[value.start + index];
  return (value as Value[])[index];
}

export function sliceSet(value: Value, index: number, element: Value): void {
  if (value instanceof SliceView) value.base[value.start + index] = element;
  else (value as Value[])[index] = element;
}

/** The array and offset a slice's elements live in, for places that refer to them. */
export function sliceBase(value: Value): { base: Value[]; start: number } {
  if (value instanceof SliceView) return { base: value.base, start: value.start };
  return { base: value as Value[], start: 0 };
}

/** A function, closure, or constructor as a value. */
export class FnValue {
  constructor(
    readonly call: (args: Value[], callRow: number | undefined) => Value,
    readonly name: string,
    /** What the function keeps alive, such as a closure's captured values, for garbage collection. */
    readonly roots: unknown[] = []
  ) {}
}

export const DONE: unique symbol = Symbol('done');
export type Next = Value | typeof DONE;

/** An iterator: `next` yields elements until it returns `DONE`. */
export class IterValue {
  constructor(
    public next: () => Next,
    public nextBack?: () => Next,
    /** The number of elements left, for iterators that know it (ExactSizeIterator). */
    public remaining?: () => number,
    /** What the iterator keeps alive, such as the collection it walks, for garbage collection. */
    readonly roots: unknown[] = []
  ) {}

  /** Elements pushed back by `peekable`. */
  peeked: Next[] | undefined;

  /** The elements left, for iterators over an array (`Chars::as_str` reads them without taking them). */
  rest: (() => Value[]) | undefined;
}

/** A `HashMap` or `BTreeMap`: entries keyed by a text that equal keys share. */
export class MapValue {
  readonly entries = new Map<string, [Value, Value]>();
  constructor(readonly sorted: boolean) {}
}

export class SetValue {
  readonly entries = new Map<string, Value>();
  constructor(readonly sorted: boolean) {}
}

/** A `Range` or `RangeInclusive`, which is its own iterator. */
export class RangeValue {
  constructor(
    public start: Value,
    public end: Value,
    readonly inclusive: boolean,
    public exhausted = false
  ) {}
}

/** A trait object: a value with the type that decides which implementation its methods run. */
export class DynValue {
  constructor(
    readonly type: Type,
    readonly value: Value
  ) {}
}

export class TurtleValue {
  constructor(readonly state: TurtleState) {}
}

/** The `fmt::Formatter` that a `Display` or `Debug` implementation writes to. */
export class FormatterValue {
  text = '';
  constructor(
    readonly spec: {
      alternate: boolean;
      width: number | undefined;
      precision: number | undefined;
      fill: string;
      align: '<' | '>' | '^' | undefined;
      sign: '+' | '-' | undefined;
      zero: boolean;
    },
    readonly debugIndent = 0
  ) {}
}

/** An entry of a map (`map.entry(key)`), which knows its key and whether the map has it. */
export class EntryValue {
  constructor(
    readonly map: MapValue,
    readonly hash: string,
    readonly key: Value
  ) {}
}
