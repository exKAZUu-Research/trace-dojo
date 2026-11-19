import { type HashEntry as SharedHashEntry, HashStore } from '../interpreter/hashStore';
import type { TurtleState } from '../interpreter/turtleWorld';
import type { Frame } from './runtime';
import type { ClassSymbol } from './symbols';

/**
 * A Kotlin value. Values of the primitive types (`Int`, `Double`, `Char`, ...) are numbers, except `Long` and `ULong`,
 * which are bigints; where a reference is expected (`Any`, `Int?`, a type argument), they are {@link Boxed}, as on the
 * JVM, so that their type survives. `Boolean`s are booleans either way, strings are strings, and `null` is `undefined`.
 */
export type Value = number | bigint | boolean | string | Boxed | KObject | UnitValue | undefined;

/** Kotlin's `Unit`, an object that prints as `kotlin.Unit`. */
export const UNIT: unique symbol = Symbol('Unit');
export type UnitValue = typeof UNIT;

/** Kotlin's `null`, for code that must name it without writing `undefined`. */
export const NULL: Value = undefined;

export type PrimitiveKind =
  | 'Int'
  | 'Long'
  | 'Short'
  | 'Byte'
  | 'Double'
  | 'Float'
  | 'Char'
  | 'UInt'
  | 'ULong'
  | 'UShort'
  | 'UByte';

/** A primitive value held as a reference, like a `java.lang.Integer`. */
export class Boxed {
  constructor(
    readonly kind: PrimitiveKind,
    readonly value: number | bigint
  ) {}
}

/** `Integer.valueOf` and its kin cache the boxes of small values, which `===` shows. */
const boxCache = new Map<PrimitiveKind, Boxed[]>();

export function box(kind: PrimitiveKind, value: number | bigint): Boxed {
  const cachesSmall = kind !== 'Double' && kind !== 'Float' && kind !== 'UInt' && kind !== 'ULong';
  if (cachesSmall) {
    const small = Number(value);
    const low = kind === 'Char' ? 0 : -128;
    if (small >= low && small <= 127) {
      let cache = boxCache.get(kind);
      if (!cache) {
        cache = [];
        boxCache.set(kind, cache);
      }
      return (cache[small - low] ??= new Boxed(kind, value));
    }
  }
  return new Boxed(kind, value);
}

export type HashEntry = SharedHashEntry<Value>;

/** The entries of a hash, linked, or sorted map or set, which iterate as Java's do. */
export class KStore extends HashStore<Value, Frame> {
  /** Whether the program gave the initial capacity, which `HashMap()` leaves to its first insertion. */
  isSized = false;
}

let nextIdentity = 1;
let firstRunIdentity: number | undefined;

/**
 * Numbers a run's objects from where the first run started, after the library's own objects, so that the identity
 * hashes of a program, and the order of hash sets and the map keys of traces that follow them, do not depend on the
 * runs before it in the server's process.
 */
export function startRunIdentities(): void {
  firstRunIdentity ??= nextIdentity;
  nextIdentity = firstRunIdentity;
}

/** An instance of a class, including the standard library's: its fields, and what a native class holds besides. */
export class KObject {
  readonly identity = nextIdentity++;
  readonly fields: Value[];
  /** The elements of a list or an array. */
  items?: Value[];
  /** The entries of a map or a set. */
  store?: KStore;
  /** The text of a `StringBuilder`. */
  builder?: string;
  /** Counts the structural changes of a collection, which make its iterators fail fast. */
  modCount?: number;
  /** What a function value runs, with the arguments its type lists (a receiver first). */
  function?: KFunction;
  /** Set by the Turtle constructor. */
  turtle?: TurtleState;
  /** Values a native object holds, such as an iterator's position or a lazy value's initializer. */
  native?: Record<string, unknown>;
  /** What a lambda captured when it was created. */
  env?: readonly unknown[];

  constructor(
    public cls: ClassSymbol,
    fieldCount = cls.fieldCount
  ) {
    this.fields = fieldCount === cls.fieldCount ? [...cls.fieldDefaults] : Array.from({ length: fieldCount });
    this.fields.length = fieldCount;
  }
}

/** A local variable that a lambda captures and may assign, which the lambda and its function share. */
export class Cell {
  constructor(public value: Value) {}
}

export interface KFunction {
  arity: number;
  call: (caller: Frame, args: Value[], callRow?: number) => Value;
}

export function isReference(value: Value): value is KObject {
  return value instanceof KObject;
}
