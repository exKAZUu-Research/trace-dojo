import type { TurtleState } from '../interpreter/turtleWorld';
import { CppRuntimeError } from './errors';
import type { ClassInfo, FunctionInfo } from './types';

/** The value of a variable or an element that the program has not written yet. */
export const UNINIT = Symbol('uninitialized');

export type Value = number | bigint | Ptr | Store | FunctionRef | typeof UNINIT | undefined;

export const enum Liveness {
  Alive,
  /** A variable whose scope ended, or a temporary that was destroyed. */
  Dead,
  /** An object that `delete` freed. */
  Deleted,
}

let nextStoreId = 0;

/**
 * Storage that a pointer or a reference can designate: a variable, an array, the members of an object, or the
 * elements of a library container. Each holds a sequence of values, which pointers address by index.
 */
export abstract class Store {
  readonly id = nextStoreId++;
  liveness = Liveness.Alive;
  /** How `new` created the storage, which `delete` must match; undefined for storage `new` did not create. */
  allocation?: 'new' | 'newArray';

  abstract get length(): number;

  /** Reads an element, which must exist and have a value. */
  abstract get(index: number): Value;
  abstract set(index: number, value: Value): void;

  /** Stops at a use of storage whose lifetime ended. */
  checkAlive(): void {
    if (this.liveness === Liveness.Alive) return;
    throw new CppRuntimeError(this.liveness === Liveness.Dead ? 'deadVariable' : 'useAfterDelete');
  }
}

/** A variable of a type that is not an array, or an object that `new` created. */
export class Box extends Store {
  constructor(
    public value: Value = UNINIT,
    readonly ownsValue = true
  ) {
    super();
  }

  get length(): number {
    return 1;
  }

  get(index: number): Value {
    this.checkAlive();
    if (index !== 0) throw new CppRuntimeError('outOfBounds');
    const { value } = this;
    if (value === UNINIT) throw new CppRuntimeError('uninitialized');
    return value;
  }

  set(index: number, value: Value): void {
    this.checkAlive();
    if (index !== 0) throw new CppRuntimeError('outOfBounds');
    this.value = value;
  }
}

/** A built-in array, whose elements may be arrays or objects. */
export class ArrayStore extends Store {
  /** Whether the array is a string literal, which the program must not write. */
  isLiteral = false;

  constructor(readonly values: Value[]) {
    super();
  }

  get length(): number {
    return this.values.length;
  }

  get(index: number): Value {
    this.checkAlive();
    if (index < 0 || index >= this.values.length) throw new CppRuntimeError('outOfBounds');
    const value = this.values[index];
    if (value === UNINIT) throw new CppRuntimeError('uninitialized');
    return value;
  }

  set(index: number, value: Value): void {
    this.checkAlive();
    if (index < 0 || index >= this.values.length) throw new CppRuntimeError('outOfBounds');
    if (this.isLiteral) throw new CppRuntimeError('stringLiteralWrite');
    this.values[index] = value;
  }
}

/** An object of a class the program declares, or of a library class with members, holding its data members. */
export class CObject extends Store {
  /** The turtle of a `Turtle` object. */
  turtle?: TurtleState;
  /** The message of a library exception, which `what()` returns, as bytes. */
  message?: string;

  /**
   * @param cls The dynamic type, which construction and destruction set to the class whose constructor or destructor
   * is running, as virtual calls during them see it.
   */
  constructor(
    public cls: ClassInfo,
    readonly values: Value[]
  ) {
    super();
  }

  get length(): number {
    return this.values.length;
  }

  get(index: number): Value {
    this.checkAlive();
    const value = this.values[index];
    if (value === UNINIT) throw new CppRuntimeError('uninitialized');
    return value;
  }

  set(index: number, value: Value): void {
    this.checkAlive();
    this.values[index] = value;
  }
}

/** Ends the lifetime of a store and its owned subobjects. Pointer values do not own their target. */
export function endLifetime(value: Value, liveness = Liveness.Dead): void {
  if (!(value instanceof Store) || value.liveness !== Liveness.Alive) return;
  value.liveness = liveness;
  if (value instanceof Box && !value.ownsValue) return;
  for (const child of childValues(value)) endLifetime(child, liveness);
}

/** The values a store holds, including pointers that may reach stores it does not own. */
export function childValues(store: Store): Iterable<Value> {
  if (store instanceof Box) return [store.value];
  if (store instanceof ArrayStore || store instanceof CObject) return store.values;
  return (store as Store & { children?: () => Iterable<Value> }).children?.() ?? [];
}

/** A pointer, an iterator into a sequence, or the location an lvalue or a reference designates. */
export class Ptr {
  constructor(
    readonly store: Store | undefined,
    readonly index: number
  ) {}

  get isNull(): boolean {
    return this.store === undefined;
  }

  /** The storage the pointer designates, which must exist and be alive. */
  target(): Store {
    const { store } = this;
    if (!store) throw new CppRuntimeError('nullAccess');
    store.checkAlive();
    return store;
  }

  read(): Value {
    const value = this.target().get(this.index);
    if (value instanceof Store) value.checkAlive();
    return value;
  }

  write(value: Value): void {
    this.target().set(this.index, value);
  }

  /** Reads the value without checking that it was written, for copying objects member by member. */
  readRaw(): Value {
    const store = this.target();
    if (store instanceof Box) return store.value;
    if (store instanceof ArrayStore || store instanceof CObject) return store.values[this.index];
    return store.get(this.index);
  }

  offset(delta: number): Ptr {
    const store = this.target();
    const index = this.index + delta;
    if (index < 0 || index > store.length) throw new CppRuntimeError('pointerOutOfRange');
    return new Ptr(store, index);
  }

  equals(other: Ptr): boolean {
    return this.store === other.store && this.index === other.index;
  }
}

export const NULL_PTR = new Ptr(undefined, 0);

/** A function used as a value, which a library algorithm calls. */
export class FunctionRef {
  constructor(readonly candidates: FunctionInfo[]) {}
}
