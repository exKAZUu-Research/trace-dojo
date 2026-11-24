import type { TurtleState } from '../interpreter/turtleWorld';
import type { LambdaInfo } from './bound';
import type { CsDecimal } from './decimal';
import type { ArrayType, MethodSymbol, NamedType, Type } from './types';

/**
 * A C# value. `null` is `undefined`; `bool` is a boolean; integral types up to 32 bits and `char` are numbers, `long` and
 * `ulong` bigints; `float` and `double` numbers; `decimal` a {@link CsDecimal}; `string` a string when .NET interns it
 * and a {@link CsString} otherwise; enums their underlying values. Objects, structs, boxes, arrays, and delegates are
 * the classes below.
 */
export type Value =
  | undefined
  | boolean
  | number
  | bigint
  | string
  | CsString
  | CsDecimal
  | CsObject
  | CsStruct
  | CsBox
  | CsArray
  | CsDelegate;

/**
 * A string that the program made at run time, which .NET keeps as an object of its own: `ReferenceEquals` tells two
 * of them with the same text apart. Literals and the strings .NET interns are plain strings, since each text has one.
 */
export class CsString {
  constructor(readonly text: string) {}

  /** The text, which messages that the library builds from values in template literals show. */
  toString(): string {
    return this.text;
  }
}

/** Whether a value is a string, interned or not. */
export function isString(value: unknown): value is string | CsString {
  return typeof value === 'string' || value instanceof CsString;
}

export function stringText(value: string | CsString): string {
  return typeof value === 'string' ? value : value.text;
}

/** A value with a string as its text, for code that reads strings by their text alone. */
export function plainString<T extends Value>(value: T): Exclude<T, CsString> | string {
  return (value instanceof CsString ? value.text : value) as Exclude<T, CsString>;
}

/** A string that .NET allocates for a result: its own object, except the empty string, which .NET always shares. */
export function freshString(text: string): string | CsString {
  return text === '' ? '' : new CsString(text);
}

/** An instance of a class, whose library classes keep their state in `native`. */
export class CsObject {
  /** The hash code `RuntimeHelpers.GetHashCode` gave it, which .NET gives an object when first asked. */
  hashCode?: number;
  turtle?: TurtleState;
  /** The state of a library object, such as a list's elements or an exception's message. */
  native?: unknown;

  constructor(
    readonly type: NamedType,
    readonly fields: Value[]
  ) {}
}

/** An instance of a struct, which assignments and calls copy. */
export class CsStruct {
  native?: unknown;

  constructor(
    readonly type: NamedType,
    readonly fields: Value[]
  ) {}

  clone(): CsStruct {
    const copy = new CsStruct(
      this.type,
      this.fields.map((field) => copyValue(field))
    );
    copy.native = this.native;
    return copy;
  }
}

/** A value type's value converted to a reference type. */
export class CsBox {
  /** The hash code `RuntimeHelpers.GetHashCode` gave it, which .NET gives an object when first asked. */
  hashCode?: number;
  /** Whether storage has been charged for the struct it holds, which every later reference to it shares. */
  isCharged = false;

  constructor(
    readonly type: Type,
    readonly value: Value
  ) {}
}

export class CsArray {
  /** The hash code `RuntimeHelpers.GetHashCode` gave it, which .NET gives an object when first asked. */
  hashCode?: number;

  constructor(
    readonly type: ArrayType,
    /** The length of each dimension. */
    readonly lengths: number[],
    readonly values: Value[]
  ) {}
}

/** One method that a delegate calls, with the object it calls it on. */
export interface DelegateEntry {
  method: MethodSymbol | undefined;
  target: Value;
  /** The type arguments of a generic method, and the type that owns a static method. */
  typeArgs: Type[];
  owner: NamedType | undefined;
  /** For a lambda, its body and the cells of the variables it captured. */
  lambda?: { info: LambdaInfo; cells: Map<unknown, Cell>; thisValue: Value; typeEnvironment: unknown };
  /** For a library function object, what it does. */
  native?: (args: Value[]) => Value;
  isVirtual: boolean;
}

export class CsDelegate {
  /** The hash code `RuntimeHelpers.GetHashCode` gave it, which .NET gives an object when first asked. */
  hashCode?: number;

  constructor(
    readonly type: NamedType,
    readonly entries: DelegateEntry[]
  ) {}
}

/** What a local's storage holds before the program assigns it, and after its scope ends. */
export const UNASSIGNED = Symbol('unassigned');

/** The storage of a variable that a lambda captured, which outlives the frame that declared it. */
export class Cell {
  constructor(public value: Value | typeof UNASSIGNED) {}
}

/** A variable passed by `ref`, `out`, or `in`. */
export interface VariableReference {
  get(): Value;
  set(value: Value): void;
}

/**
 * The slots that storage newly keeping a value is charged for beyond the slot holding it: a struct's fields, nested
 * structs included, since storing a struct copies them, and a box's struct the first time any storage keeps the box,
 * since every reference shares it; 0 for other values.
 */
export function structFieldSlots(value: Value): number {
  if (value instanceof CsBox) {
    if (value.isCharged || pendingBoxes.has(value)) return 0;
    pendingBoxes.add(value);
    return structFieldSlots(value.value);
  }
  if (!(value instanceof CsStruct)) return 0;
  let count = value.fields.length;
  for (const field of value.fields) count += structFieldSlots(field);
  return count;
}

/** The boxes that structFieldSlots has counted, which a charge marks as charged only once it succeeds. */
const pendingBoxes = new Set<CsBox>();

/** Marks the counted boxes as charged when their charge succeeded, or forgets them when it failed. */
export function settleBoxCharges(isCharged: boolean): void {
  if (isCharged) for (const box of pendingBoxes) box.isCharged = true;
  pendingBoxes.clear();
}

/** The struct fields a store of a value adds over the value it replaces, which the store is charged for. */
export function storeGrowth(previous: Value, next: Value): number {
  return Math.max(0, structFieldSlots(next) - structFieldSlots(previous));
}

/** Copies a struct, as reading a variable of a value type into another does. */
export function copyValue<T extends Value | undefined>(value: T): T {
  return value instanceof CsStruct ? (value.clone() as T) : value;
}
