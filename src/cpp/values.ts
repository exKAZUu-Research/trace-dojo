import { INT_PROPERTIES } from '../c/types';
import type { TurtleState } from '../interpreter/turtleWorld';
import { CppRuntimeError } from './errors';
import type { FloatNaN } from './floatSign';
import type { Frame, Temporary } from './runtime';
import {
  baseSubobjectOffset,
  type ClassInfo,
  classType,
  fieldSubobjectOffset,
  type FunctionInfo,
  isArithmetic,
  sizeOf,
  type Type,
} from './types';

/** The value of a variable or an element that the program has not written yet. */
export const UNINIT = Symbol('uninitialized');

export class PartialScalar {
  constructor(
    readonly bits: bigint,
    readonly initializedByteMask: number
  ) {}
}

export type Value = number | bigint | FloatNaN | Ptr | Store | FunctionRef | PartialScalar | typeof UNINIT | undefined;

export function isIndeterminate(value: Value): boolean {
  return value === UNINIT || value instanceof PartialScalar;
}

interface Address {
  store: Store | undefined;
  index: number;
}

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

  get pointerLength(): number {
    return this.length;
  }

  get iteratorLength(): number {
    return this.length;
  }

  get inlineArray(): ArrayStore | undefined {
    return undefined;
  }

  get containingLocation(): Ptr | undefined {
    return undefined;
  }

  projectAddress(_index: number, _byteOffset: number): Address | undefined {
    return undefined;
  }

  classView(_location: Ptr, _cls: ClassInfo): Ptr | undefined {
    return undefined;
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
  elementSize?: number;

  constructor(
    public value: Value = UNINIT,
    readonly ownsValue = true
  ) {
    super();
  }

  get length(): number {
    return 1;
  }

  override projectAddress(index: number, byteOffset: number): Address | undefined {
    const array = inlineArrayOf(this.value);
    const size = array?.elementSize === undefined ? this.elementSize : array.length * array.elementSize;
    if (size !== undefined) return { store: this, index: index * size + byteOffset };
  }

  get(index: number): Value {
    this.checkAlive();
    if (index !== 0) throw new CppRuntimeError('outOfBounds');
    return initializedValue(this.value);
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
  elementSize?: number;
  /** Whether the array is a string literal, which the program must not write. */
  isLiteral = false;
  /** Whether the elements are arithmetic values, which reach no other storage. */
  holdsScalars = false;

  constructor(
    readonly values: Value[],
    element?: Type,
    private enclosingLocation?: Ptr
  ) {
    super();
    if (element) {
      this.elementSize = sizeOf(element);
      this.holdsScalars = isArithmetic(element);
    }
  }

  bindLocation(element: Type, location: Ptr): void {
    this.elementSize = sizeOf(element);
    this.holdsScalars = isArithmetic(element);
    this.enclosingLocation = location;
  }

  override get containingLocation(): Ptr | undefined {
    return this.enclosingLocation;
  }

  get length(): number {
    return this.values.length;
  }

  addressAt(offset: number): Address {
    return this.enclosingLocation?.embeddedAddress(offset) ?? { store: this, index: offset };
  }

  override projectAddress(index: number, byteOffset: number): Address | undefined {
    if (this.elementSize !== undefined) return this.addressAt(index * this.elementSize + byteOffset);
  }

  get(index: number): Value {
    this.checkAlive();
    if (index < 0 || index >= this.values.length) throw new CppRuntimeError('outOfBounds');
    return initializedValue(this.values[index]);
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

interface ObjectLocation {
  location?: Ptr;
}

/** An object of a class the program declares, or of a library class with members, holding its data members. */
export class CObject extends Store {
  readonly completeClass: ClassInfo;
  /** The turtle of a `Turtle` object. */
  turtle?: TurtleState;
  /** The message of a library exception, which `what()` returns, as bytes. */
  private exceptionMessage?: ExceptionMessage;
  referenceTemporaries?: Temporary[];
  needsConstruction = false;
  private receiverLocation: ObjectLocation = {};
  private hasContainerCell = false;
  private receiverStorage?: Store;
  private baseLocations?: Map<ClassInfo, Ptr>;
  private memberStorage?: Map<number, MemberStorage>;
  /** The object whose secondary base this object is, which virtual calls and downcasts reach. */
  secondaryOwner?: CObject;
  /** The member of a union that was written last, or undefined while no access has decided one. */
  activeMember?: number;

  get completeLocation(): Ptr | undefined {
    return this.receiverLocation.location;
  }

  set completeLocation(location: Ptr | undefined) {
    this.receiverLocation.location = location;
  }

  override get containingLocation(): Ptr | undefined {
    return this.completeLocation;
  }

  bindContainerCell(location: Ptr): void {
    if (this.completeLocation !== location && this.hasContainerCell) this.receiverLocation = { location };
    else this.completeLocation = location;
    this.hasContainerCell = true;
  }

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
    this.completeClass = cls;
  }

  get length(): number {
    return this.values.length;
  }

  receiver(asClass = this.cls): Ptr {
    if (this.completeClass === asClass)
      return new CompleteObjectPointer(this.receiverLocation, this.fallbackReceiver());
    // A secondary base's subobject is a member's object, which knows the object it is a base of.
    const secondary = this.completeClass.secondaryBaseOf(asClass);
    if (secondary) {
      const subobject = this.values[secondary.field.index];
      if (subobject instanceof CObject) {
        subobject.secondaryOwner = this;
        return subobject.receiver(asClass);
      }
    }
    if (this.secondaryOwner && !this.completeClass.isDerivedFrom(asClass)) return this.secondaryOwner.receiver(asClass);
    this.baseLocations ??= new Map();
    let location = this.baseLocations.get(asClass);
    if (!location) {
      location = new BaseSubobjectStorage(this, asClass).location(0);
      this.baseLocations.set(asClass, location);
    }
    return location;
  }

  subobjectAddress(cls: ClassInfo, index: number): Address {
    return this.addressAt(baseSubobjectOffset(this.completeClass, cls) + index * sizeOf(classType(cls)));
  }

  memberAddress(fieldIndex: number, index: number, offset: number): Address {
    const field = this.completeClass.fields[fieldIndex];
    if (!field) return { store: this, index: fieldIndex + index + offset };
    return this.addressAt(fieldSubobjectOffset(this.completeClass, field) + index * sizeOf(field.type) + offset);
  }

  addressAt(offset: number): Address {
    const complete = this.completeLocation;
    const embedded = complete?.embeddedAddress(offset);
    if (embedded) return embedded;
    if (offset === sizeOf(classType(this.completeClass))) {
      return new Ptr(complete?.store ?? this.fallbackReceiver(), (complete?.index ?? 0) + 1).address;
    }
    return { store: this, index: offset };
  }

  private fallbackReceiver(): Store {
    this.receiverStorage ??= new ObjectReceiverStorage(this);
    return this.receiverStorage;
  }

  parameterStorage(): Box {
    const storage = new ObjectReceiverStorage(this);
    this.completeLocation = storage.location(0);
    return storage;
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
    if (this.completeClass.isUnion) this.readUnionMember(index);
    return initializedValue(this.values[index]);
  }

  set(index: number, value: Value): void {
    this.checkAlive();
    if (this.completeClass.isUnion && value !== UNINIT) this.activeMember = index;
    const field = this.completeClass.fields[index];
    this.values[index] = field?.bitWidth === undefined ? value : fitBitField(value, field.type, field.bitWidth);
  }

  /**
   * Makes a member of a union the one in use as an access to it does: reading another member than the one written last
   * would reinterpret its bytes, which depend on the CPU, so only a member that is an object or an array, whose own
   * members the access goes on to write, takes over.
   */
  private readUnionMember(index: number): void {
    const active = this.activeMember;
    if (active === undefined || active === index) {
      this.activeMember = index;
      return;
    }
    const type = this.completeClass.fields[index]?.type;
    if (type?.kind === 'class' || type?.kind === 'array') {
      this.activeMember = index;
      return;
    }
    throw new CppRuntimeError(
      'custom',
      '共用体で、最後に書き込んだのとは別のメンバーを読むこと（値のメモリ上の表し方は、CPU や OS によって違います）は、この採点環境では使えません。'
    );
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

class ObjectReceiverStorage extends Box {
  constructor(readonly object: CObject) {
    super(object, false);
  }

  override checkAlive(): void {
    this.object.checkAlive();
  }
}

class BaseSubobjectStorage extends ObjectReceiverStorage {
  constructor(
    object: CObject,
    readonly cls: ClassInfo
  ) {
    super(object);
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

  override projectAddress(index: number, byteOffset: number): Address {
    return this.owner.memberAddress(this.field, index, byteOffset);
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
  if (store instanceof ArrayStore) return store.holdsScalars ? [] : store.values;
  if (store instanceof CObject) return store.values;
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
    const value = initializedValue(this.target().get(this.index));
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

  offset(delta: number | bigint, asIterator = false): Ptr {
    const isZero = delta === 0 || delta === 0n;
    if (isZero && this.isNull) return this;
    const store = this.target();
    const start = this.index;
    const length = asIterator ? store.iteratorLength : store.pointerLength;
    if (delta < -start || delta > length - start) throw new CppRuntimeError('pointerOutOfRange');
    if (isZero && !asIterator) return this;
    const index = start + Number(delta);
    return asIterator ? store.iteratorLocation(index) : store.location(index);
  }

  element(isReverse: boolean): Ptr {
    const store = this.target();
    const index = this.index - (isReverse ? 1 : 0);
    if (index < 0 || index >= store.iteratorLength) throw new CppRuntimeError('invalidIterator');
    return store.location(index);
  }

  checkIterator(): void {
    const { store, index } = this;
    if (!store) return;
    store.checkAlive();
    if (index < 0 || index > store.iteratorLength) throw new CppRuntimeError('invalidIterator');
  }

  sharesRange(other: Ptr): boolean {
    return this.store === other.store;
  }

  forClass(cls: ClassInfo): Ptr {
    const object = this.addressedValue();
    if (object instanceof CObject && (object.completeLocation || object.completeClass !== cls))
      return object.receiver(cls);
    return object instanceof Store ? (object.classView(this, cls) ?? this) : this;
  }

  allocationLocation(): Ptr {
    // A secondary base's subobject belongs to the object it is a base of, which `new` allocated.
    const object = this.isNull ? undefined : this.addressedValue();
    if (object instanceof CObject && object.secondaryOwner) {
      let owner = object.secondaryOwner;
      while (owner.secondaryOwner) owner = owner.secondaryOwner;
      if (owner.completeLocation) return owner.completeLocation;
    }
    const store = this.store;
    return this.index === 0 && store instanceof BaseSubobjectStorage ? (store.object.completeLocation ?? this) : this;
  }

  rangeLength(last: Ptr, isReverse: boolean): number {
    if (!this.sharesRange(last)) throw new CppRuntimeError('invalidRange');
    if (!this.isNull) this.target();
    const length = isReverse ? this.index - last.index : last.index - this.index;
    if (length < 0) throw new CppRuntimeError('invalidRange');
    return length;
  }

  equals(other: Ptr | FunctionRef): boolean {
    if (other instanceof FunctionRef) return false;
    const a = this.address;
    const b = other.address;
    return a.store === b.store && a.index === b.index;
  }

  compareAddress(other: Ptr): number {
    const a = this.address;
    const b = other.address;
    return a.store === b.store ? a.index - b.index : (a.store?.id ?? -1) - (b.store?.id ?? -1);
  }

  modeledAddress(): bigint {
    const { store, index } = this.address;
    // Each store has enough space for every byte offset representable as a safe integer.
    return store ? (BigInt(store.id + 1) << 53n) + BigInt(index) : 0n;
  }

  get address(): Address {
    const { store } = this;
    if (store instanceof BaseSubobjectStorage) return store.object.subobjectAddress(store.cls, this.index);
    const embedded = this.embeddedAddress(0);
    if (embedded) return embedded;
    const value = this.addressedValue();
    if (value instanceof CObject) return value.addressAt(0);
    const array = inlineArrayOf(value);
    if (array) return array.addressAt(0);
    return this.storageAddress;
  }

  embeddedAddress(offset: number): Address | undefined {
    return this.store?.projectAddress(this.index, offset);
  }

  byteAddress(elementSize: number): Address {
    return this.embeddedAddress(0) ?? { store: this.store, index: this.index * elementSize };
  }

  get storageAddress(): { store: Store | undefined; index: number } {
    const { store, index } = this;
    return store instanceof MemberStorage ? { store: store.owner, index: store.field + index } : { store, index };
  }

  get memberOwner(): { object: CObject; field: number } | undefined {
    const { store, index } = this;
    if (store instanceof MemberStorage && index === 0) return { object: store.owner, field: store.field };
  }

  private addressedValue(): Value {
    const { store, index } = this;
    if (!store || index < 0 || index >= store.pointerLength || store.liveness !== Liveness.Alive) return;
    try {
      return this.readRaw();
    } catch (error) {
      if (!(error instanceof CppRuntimeError)) throw error;
    }
  }
}

function initializedValue(value: Value): Value {
  if (isIndeterminate(value)) throw new CppRuntimeError('uninitialized');
  return value;
}

function inlineArrayOf(value: Value): ArrayStore | undefined {
  if (value instanceof ArrayStore) return value;
  if (value instanceof Store) return value.inlineArray;
}

export const NULL_PTR = new Ptr(undefined, 0);

class CompleteObjectPointer extends Ptr {
  constructor(
    private readonly receiver: ObjectLocation,
    private readonly fallback: Store,
    private readonly offsetFromObject = 0
  ) {
    super(fallback, offsetFromObject);
  }

  override get store(): Store {
    return this.receiver.location?.store ?? this.fallback;
  }

  override get index(): number {
    return (this.receiver.location?.index ?? 0) + this.offsetFromObject;
  }

  override offset(delta: number | bigint, asIterator = false): Ptr {
    super.offset(delta, asIterator);
    const offset = Number(delta);
    if (offset === 0) return this;
    return new CompleteObjectPointer(this.receiver, this.fallback, this.offsetFromObject + offset);
  }
}

/** A function used as a value, which a library algorithm calls. */
/** A function's name, or the value of a pointer to a function, which designates the first candidate. */
export class FunctionRef {
  constructor(readonly candidates: FunctionInfo[]) {}

  readonly isNull = false;

  equals(other: Ptr | FunctionRef): boolean {
    return other instanceof FunctionRef && other.candidates[0] === this.candidates[0];
  }
}

/** The value a bit-field holds after storing a value of its type: the value's low bits, signed for a signed type. */
function fitBitField(value: Value, type: Type, width: number): Value {
  if (type.kind !== 'int' || (typeof value !== 'number' && typeof value !== 'bigint')) return value;
  // An enumeration without a fixed type keeps a sign bit only when it has a negative enumerator, as clang does.
  const info = type.enumeration;
  const signed =
    info && !info.hasFixedType
      ? [...info.enumerators.values()].some((enumerator) => enumerator < 0)
      : INT_PROPERTIES[type.name].signed;
  const fitted = signed ? BigInt.asIntN(width, BigInt(value)) : BigInt.asUintN(width, BigInt(value));
  return typeof value === 'bigint' ? fitted : Number(fitted);
}
