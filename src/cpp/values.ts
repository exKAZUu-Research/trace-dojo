import type { TurtleState } from '../interpreter/turtleWorld';
import { CppRuntimeError } from './errors';
import type { Frame, Temporary } from './runtime';
import type { ClassInfo, FunctionInfo, Type } from './types';

/** The value of a variable or an element that the program has not written yet. */
export const UNINIT = Symbol('uninitialized');

export type Value = number | bigint | Ptr | Store | FunctionRef | typeof UNINIT | undefined;

export function holdValues<T>(frame: Frame, values: readonly Value[], run: () => T): T {
  const mark = frame.pending.length;
  for (const value of values) frame.pending.push(value);
  try {
    return run();
  } finally {
    frame.pending.length = mark;
  }
}

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

  get iteratorLength(): number {
    return this.length;
  }

  /** Reads an element, which must exist and have a value. */
  abstract get(index: number): Value;
  abstract set(index: number, value: Value): void;

  location(index: number): Ptr {
    return new Ptr(this, index);
  }

  iteratorLocation(index: number): Ptr {
    return this.location(index);
  }

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

export class RetainedTemporary extends Box {
  constructor(readonly temporary: Temporary) {
    super(temporary.object);
  }
}

export function destroyRetainedTemporary(frame: Frame, value: Value): void {
  const { temporary } = value as RetainedTemporary;
  temporary.destroy(frame, temporary.object);
}

/** A built-in array, whose elements may be arrays or objects. */
export class ArrayStore extends Store {
  allocatedElementType?: Type;
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

interface ExceptionMessage {
  text: string;
  owners: number;
  storage?: ArrayStore;
}

/** An object of a class the program declares, or of a library class with members, holding its data members. */
export class CObject extends Store {
  /** The turtle of a `Turtle` object. */
  turtle?: TurtleState;
  /** The message of a library exception, which `what()` returns, as bytes. */
  private exceptionMessage?: ExceptionMessage;
  referenceTemporaries?: Temporary[];
  needsConstruction = false;
  arrayAddress?: Ptr;
  private memberStorage?: Map<number, MemberStorage>;

  /**
   * @param cls The dynamic type, which construction and destruction set to the class whose constructor or destructor
   * is running, as virtual calls during them see it.
   */
  constructor(
    public cls: ClassInfo,
    readonly values: Value[],
    public zeroInitialized = false
  ) {
    super();
  }

  get length(): number {
    return this.values.length;
  }

  receiver(): Ptr {
    return this.arrayAddress ?? new Ptr(new Box(this, false), 0);
  }

  get message(): string | undefined {
    return this.exceptionMessage?.text;
  }

  set message(text: string | undefined) {
    this.releaseMessage();
    if (text !== undefined) this.exceptionMessage = { text, owners: 1 };
  }

  messageLocation(create: (text: string) => ArrayStore): Ptr {
    const message = (this.exceptionMessage ??= { text: 'std::exception', owners: 1 });
    message.storage ??= create(message.text);
    return message.storage.location(0);
  }

  shareMessageFrom(source: CObject): void {
    const message = source.exceptionMessage;
    if (this.exceptionMessage === message) return;
    this.releaseMessage();
    this.exceptionMessage = message;
    if (message) message.owners++;
  }

  takeMessageFrom(source: CObject): void {
    if (source === this) return;
    this.releaseMessage();
    this.exceptionMessage = source.exceptionMessage;
    source.exceptionMessage = undefined;
  }

  releaseMessage(liveness = Liveness.Dead): void {
    const message = this.exceptionMessage;
    if (!message) return;
    this.exceptionMessage = undefined;
    if (--message.owners === 0) endLifetime(message.storage, liveness);
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

  destroyReferenceTemporaries(frame: Frame): void {
    const temporaries = this.referenceTemporaries;
    if (!temporaries) return;
    this.referenceTemporaries = undefined;
    holdValues(
      frame,
      temporaries.map(({ object }) => object),
      () => {
        for (let index = temporaries.length - 1; index >= 0; index--) {
          const temporary = temporaries[index];
          temporary.destroy(frame, temporary.object);
        }
      }
    );
  }

  member(index: number): MemberStorage {
    this.memberStorage ??= new Map();
    let storage = this.memberStorage.get(index);
    if (!storage) {
      storage = new MemberStorage(this, index);
      this.memberStorage.set(index, storage);
    }
    return storage;
  }
}

class MemberStorage extends Store {
  readonly length = 1;

  constructor(
    readonly owner: CObject,
    readonly field: number
  ) {
    super();
  }

  override checkAlive(): void {
    this.owner.checkAlive();
  }

  get(index: number): Value {
    return this.owner.get(this.fieldAt(index));
  }

  set(index: number, value: Value): void {
    this.owner.set(this.fieldAt(index), value);
  }

  getRaw(index: number): Value {
    return this.owner.values[this.fieldAt(index)];
  }

  private fieldAt(index: number): number {
    if (index !== 0) throw new CppRuntimeError('outOfBounds');
    return this.field;
  }
}

/** Ends the lifetime of a store and its owned subobjects. Pointer values do not own their target. */
export function endLifetime(value: Value, liveness = Liveness.Dead): void {
  if (!(value instanceof Store) || value.liveness !== Liveness.Alive) return;
  value.liveness = liveness;
  if (value instanceof Box && !value.ownsValue) return;
  if (value instanceof MemberStorage) return;
  if (value instanceof CObject) value.releaseMessage(liveness);
  for (const child of childValues(value)) endLifetime(child, liveness);
}

/** The values a store holds, including pointers that may reach stores it does not own. */
export function childValues(store: Store): Iterable<Value> {
  if (store instanceof Box) return [store.value];
  if (store instanceof MemberStorage) return [store.owner];
  if (store instanceof CObject && store.referenceTemporaries)
    return [...store.values, ...store.referenceTemporaries.map(({ object }) => object)];
  if (store instanceof ArrayStore || store instanceof CObject) return store.values;
  return (store as Store & { children?: () => Iterable<Value> }).children?.() ?? [];
}

/** A pointer, an iterator into a sequence, or the location an lvalue or a reference designates. */
export class Ptr {
  private readonly initialStore: Store | undefined;
  private readonly initialIndex: number;

  constructor(
    store: Store | undefined,
    index: number,
    readonly enclosingObject?: { location: Ptr; cls: ClassInfo }
  ) {
    this.initialStore = store instanceof CObject ? store.member(index) : store;
    this.initialIndex = store instanceof CObject ? 0 : index;
  }

  get store(): Store | undefined {
    return this.initialStore;
  }

  get index(): number {
    return this.initialIndex;
  }

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
    const { index } = this;
    if (store instanceof MemberStorage) return store.getRaw(index);
    if (store instanceof Box) return store.value;
    if (store instanceof ArrayStore || store instanceof CObject) return store.values[index];
    return store.get(index);
  }

  offset(delta: number, asIterator = false): Ptr {
    if (delta === 0 && this.isNull) return this;
    const store = this.target();
    const index = this.index + delta;
    if (index < 0 || index > (asIterator ? store.iteratorLength : store.length))
      throw new CppRuntimeError('pointerOutOfRange');
    if (delta === 0 && !asIterator) return this;
    return asIterator ? store.iteratorLocation(index) : store.location(index);
  }

  element(isReverse: boolean): Ptr {
    const store = this.target();
    const index = this.index - (isReverse ? 1 : 0);
    if (index < 0 || index >= store.iteratorLength) throw new CppRuntimeError('invalidIterator');
    return store.location(index);
  }

  sharesRange(other: Ptr): boolean {
    return this.store === other.store;
  }

  rangeLength(last: Ptr, isReverse: boolean): number {
    if (!this.sharesRange(last)) throw new CppRuntimeError('invalidRange');
    if (!this.isNull) this.target();
    const length = isReverse ? this.index - last.index : last.index - this.index;
    if (length < 0) throw new CppRuntimeError('invalidRange');
    return length;
  }

  equals(other: Ptr): boolean {
    if (this.store === other.store && this.index === other.index) return true;
    const a = this.address;
    const b = other.address;
    return a.store === b.store && a.index === b.index;
  }

  /** Constructor and destructor receivers can wrap the same object in different storage cells. */
  get address(): { store: Store | undefined; index: number } {
    const object = this.addressedObject();
    return object ? { store: object, index: 0 } : this.storageAddress;
  }

  get storageAddress(): { store: Store | undefined; index: number } {
    const { store, index } = this;
    return store instanceof MemberStorage ? { store: store.owner, index: store.field + index } : { store, index };
  }

  get memberOwner(): { object: CObject; field: number } | undefined {
    const { store, index } = this;
    if (store instanceof MemberStorage && index === 0) return { object: store.owner, field: store.field };
  }

  private addressedObject(): CObject | undefined {
    const { store, index } = this;
    if (!store || index < 0 || index >= store.length || store.liveness !== Liveness.Alive) return;
    try {
      const value = this.readRaw();
      return value instanceof CObject ? value : undefined;
    } catch (error) {
      if (!(error instanceof CppRuntimeError)) throw error;
    }
  }
}

export const NULL_PTR = new Ptr(undefined, 0);

/** A function used as a value, which a library algorithm calls. */
export class FunctionRef {
  constructor(readonly candidates: FunctionInfo[]) {}
}
