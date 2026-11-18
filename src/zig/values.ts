// code-gauge-allow-file fileNcss 462 -- Keeps logical slots, pointer identity, and retained payload storage with their shared assignment rules.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { TurtleState } from '../interpreter/turtleWorld';
import { BigFloat, compareFloats } from './floats';
import type { FunctionInstance } from './functions';
import { reserveMemory, spendMemory } from './memoryAccounting';
import { MemoryFault, UNDEFINED_MEMORY } from './memoryFault';
import type { Type, UnionType } from './types';
import { WeakValueMap } from './weakValueMap';

export interface FunctionReference {
  readonly functionName: string;
}

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
  | FunctionReference
  | NativeHandle;

/** Storage that pointers can refer into: a variable, an array's elements, a struct's fields, or a union's payload. */
export interface Slots {
  slots: Value[];
}

const scalarIdentities = new WeakMap<object, number>();
let nextScalarIdentity = 1;

const storageAliases = new WeakMap<object, Value[]>();

export function aliasStorage(proxy: Value[], original: Value[]): void {
  storageAliases.set(proxy, original);
}

const virtualStorage = new WeakSet<object>();
const zeroArrayValues = new WeakMap<object, { value: Value }>();
const storageLocations = new WeakMap<object, (index: number) => { storage: object; index: number }>();

export function registerStorageLocation(
  storage: object,
  locate: (index: number) => { storage: object; index: number },
  virtual = false
): void {
  storageLocations.set(storage, locate);
  if (virtual) virtualStorage.add(storage);
}

// code-gauge-allow functionParameterCount 7 -- Compares typed storage ranges with independent starts and extents.
export function storageOverlaps(
  left: Slots,
  leftStart: number,
  right: Slots,
  rightStart: number,
  length: number,
  stride: number,
  rightLength = length
): boolean {
  if (length === 0 || rightLength === 0) return false;
  const a = storageByteLocation(left, leftStart, stride);
  const b = storageByteLocation(right, rightStart, stride);
  return a.storage === b.storage && a.index < b.index + rightLength * stride && b.index < a.index + length * stride;
}

export function storageByteLocation(target: Slots, index: number, stride: number): { storage: object; index: number } {
  const slots = target.slots;
  const location = storageLocation(slots, index);
  return storageLocations.has(slots) ? location : { storage: location.storage, index: location.index * stride };
}

export function storageLocation(storage: object, index: number): { storage: object; index: number } {
  const original = storageAliases.get(storage) ?? storage;
  return storageLocations.get(original)?.(index) ?? { storage: original, index };
}

const pointerLocations = new WeakMap<object, (index: number) => { storage: object; index: number }>();
const interiorLocations = new WeakMap<object, Map<number, object>>();
const aggregateLocations = new WeakMap<object, WeakValueMap<number, object>>();
const arrayLocations = new WeakMap<
  object,
  { start: number; stride: number; origin: { storage: object; index: number } }
>();

export function registerPointerLocation(
  storage: object,
  locate: (index: number) => { storage: object; index: number }
): void {
  pointerLocations.set(storage, locate);
}

function pointerLocation(location: { storage: object; index: number }): { storage: object; index: number } {
  if (Number.isInteger(location.index * 8)) return location;
  let interiors = interiorLocations.get(location.storage);
  if (!interiors) {
    interiors = new Map();
    interiorLocations.set(location.storage, interiors);
  }
  let storage = interiors.get(location.index);
  if (!storage) {
    storage = {};
    interiors.set(location.index, storage);
  }
  return { storage, index: 0 };
}

const immutableStorage = new WeakSet<object>();

export function markConstantStorage(storage: Slots): void {
  if (immutableStorage.has(storage.slots)) return;
  immutableStorage.add(storage);
  immutableStorage.add(storage.slots);
  const visit = (value: Value): void => {
    if (value instanceof ZArray || value instanceof ZStruct || value instanceof ZUnion) markConstantStorage(value);
    else if (value instanceof Some) visit(value.value);
  };
  for (const value of storage.slots) visit(value);
}

export function compileTimeReadable(value: Value): boolean {
  if (value instanceof Pointer) return immutableStorage.has(value.storageLocation().storage);
  if (value instanceof Slice) return immutableStorage.has(value.target.slots);
  if (value instanceof ZArray || value instanceof ZStruct || value instanceof ZUnion)
    return value.slots.every(compileTimeReadable);
  if (value instanceof Some) return compileTimeReadable(value.value);
  return !(value instanceof NativeHandle);
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
  readonly length: number;
  readonly lengthValue: bigint;
  constructor(
    public slots: Value[],
    readonly offset = 0,
    length: number | bigint = slots.length,
    readonly hasSentinel = false
  ) {
    this.lengthValue = BigInt(length);
    this.length = Number(length);
  }

  get(index: number): Value {
    return this.slots[this.offset + index];
  }

  set(index: number, value: Value): void {
    this.slots[this.offset + index] = value;
  }

  /** The elements, followed by the sentinel when `withSentinel`. */
  values(withSentinel = false, spend?: (cost: number) => void): Value[] {
    const length = this.length + (withSentinel ? 1 : 0);
    spend?.(length);
    if (virtualStorage.has(this.slots)) {
      if (length > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
      return Array.from({ length }, (_, index) => this.get(index));
    }
    return this.slots.slice(this.offset, this.offset + length);
  }
}

export class ZStruct implements Slots {
  constructor(public slots: Value[]) {}
}

export class ZUnion implements Slots {
  slots: Value[];
  rawTag?: () => bigint;
  retainedPayloads?: { type: UnionType; values: ReadonlyMap<number, Value> };
  writeBacking?: (value: ZUnion) => void;
  backingKey?: () => string;
  backingReferences?: () => Iterable<NativeReference>;
  fieldView?: (index: number) => Slots;
  copyBacking?: () => ZUnion;
  copyBackingTo?: (destination: unknown, offset: number) => void;

  constructor(
    public tag: number,
    payload: Value,
    public payloadInitialized = true
  ) {
    this.slots = [payload];
  }

  retainPayload(type: UnionType): void {
    const prior = this.retainedPayloads?.values;
    const count = prior?.size ?? 0;
    reserveMemory(count + 1);
    spendMemory(count + 1);
    const payloads = new Map(prior);
    payloads.delete(this.tag);
    payloads.set(this.tag, this.slots[0]);
    this.retainedPayloads = { type, values: payloads };
  }

  withCopiedPayload(payload: Value): ZUnion {
    const copy = new ZUnion(this.tag, payload, this.payloadInitialized);
    copy.retainedPayloads = this.retainedPayloads;
    return copy;
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
    readonly index: number,
    private readonly aggregateOrigin?: { storage: object; index: number }
  ) {}

  load(): Value {
    return this.target.slots[this.index];
  }

  project(kind: 'length' | 'optional'): Pointer {
    const location = kind === 'optional' ? storageLocation(this.target.slots, this.index) : this.storageLocation();
    const projections = Pointer.projectionMap(location.storage);
    const key = `${location.index} ${kind}`;
    let storage = projections.get(key);
    if (!storage) {
      storage = kind === 'length' ? new SliceLength(this) : new OptionalSlots(this);
      projections.set(key, storage);
    }
    return new Pointer(storage, 0);
  }

  projectErrorPayload(offset: number): Pointer {
    const location = this.slotLocation();
    const projections = Pointer.projectionMap(location.storage);
    const key = `${location.index} error`;
    let storage = projections.get(key);
    if (!storage) {
      storage = new ErrorPayloadSlots(this, offset);
      projections.set(key, storage);
    }
    return new Pointer(storage, 0);
  }

  static optionalProjection(target: Slots, index: number): OptionalSlots | undefined {
    const location = storageLocation(target.slots, index);
    const projection = Pointer.projections.get(location.storage)?.get(`${location.index} optional`);
    return projection instanceof OptionalSlots ? projection : undefined;
  }

  static errorProjection(target: Slots, index: number): ErrorPayloadSlots | undefined {
    const location = storageLocation(target.slots, index);
    const projection = Pointer.projections.get(location.storage)?.get(`${location.index} error`);
    return projection instanceof ErrorPayloadSlots ? projection : undefined;
  }

  private static projectionMap(owner: object): Map<string, Slots> {
    let projections = Pointer.projections.get(owner);
    if (!projections) {
      projections = new Map();
      Pointer.projections.set(owner, projections);
    }
    return projections;
  }

  storageLocation(): { storage: object; index: number } {
    const slots = this.target.slots;
    const projected = this.projectedLocation(slots);
    if (projected) return projected;
    const location = storageLocation(slots, this.index);
    if (storageLocations.has(slots) || location.storage === UNDEFINED_MEMORY.slots) return location;
    const value = (storageAliases.get(slots) ?? slots)[this.index];
    if (value instanceof ZArray) return storageLocation(value.slots, value.offset);
    return storageLocation(
      this.target instanceof OptionalSlots || this.target instanceof SliceLength ? this.target : this.target.slots,
      this.index
    );
  }

  projectedLocation(slots = this.target.slots): { storage: object; index: number } | undefined {
    const location = pointerLocations.get(slots)?.(this.index);
    return location && pointerLocation(location);
  }

  slotLocation(): { storage: object; index: number } {
    return storageLocation(this.target.slots, this.index);
  }

  fieldLocation(offset: number): { storage: object; index: number } {
    const origin = this.aggregateOrigin ?? this.aggregateLocation();
    return { storage: origin.storage, index: origin.index + offset };
  }

  withFieldLocation(parent: Pointer, offset: number): Pointer {
    return new Pointer(this.target, this.index, parent.fieldLocation(offset));
  }

  private aggregateLocation(): { storage: object; index: number } {
    const slots = this.target.slots;
    if (storageLocations.has(slots) || pointerLocations.has(slots)) return this.storageLocation();
    const array = arrayLocations.get(slots);
    if (array) {
      const { storage, index } = array.origin;
      return { storage, index: index + (this.index - array.start) * array.stride };
    }
    const location = this.slotLocation();
    let fields = aggregateLocations.get(location.storage);
    if (!fields) {
      fields = new WeakValueMap();
      aggregateLocations.set(location.storage, fields);
    }
    let storage = fields.get(location.index);
    if (!storage) {
      storage = {};
      fields.set(location.index, storage);
    }
    return { storage, index: 0 };
  }

  equals(other: Pointer): boolean {
    const left = this.storageLocation(),
      right = other.storageLocation();
    return left.storage === right.storage && left.index === right.index;
  }
}

/** A slice: a pointer to the first of `length` elements of an array, and the length. */
export class Slice {
  readonly length: number;
  readonly lengthValue: bigint;
  constructor(
    readonly target: Slots,
    readonly start: number,
    length: number | bigint,
    readonly undefinedHeader = false
  ) {
    this.length = Number(length);
    this.lengthValue = typeof length === 'bigint' ? length : BigInt(length);
  }

  get(index: number): Value {
    return this.target.slots[this.start + index];
  }

  set(index: number, value: Value): void {
    this.target.slots[this.start + index] = value;
  }

  readBytes(spend: (cost?: number) => void): Uint8Array {
    if (this.lengthValue !== 0n && isUndefinedMemory(this)) throw new MemoryFault();
    spend(this.length);
    return Uint8Array.from({ length: this.length }, (_, index) => Number(this.get(index)));
  }

  values(spend?: (cost: number) => void): Value[] {
    if (this.lengthValue !== 0n && isUndefinedMemory(this)) throw new MemoryFault();
    spend?.(this.length);
    if (this.lengthValue > BigInt(LIMITS.maxSlots)) throw new ExecutionLimitError('storage');
    return virtualStorage.has(this.target.slots)
      ? Array.from({ length: this.length }, (_, index) => this.get(index))
      : this.target.slots.slice(this.start, this.start + this.length);
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

export function optionalSome(value: Value, payload: Type): Value {
  return payload.kind === 'optional' ? new Some(value) : value;
}

/** A function, as a value of a function type or a function pointer. */
export class FnValue {
  constructor(
    readonly fn: FunctionInstance,
    readonly isUndefined = false
  ) {}
}

export interface NativeReference {
  value: unknown;
  type?: Type;
}

type NativeReferences = (spend: () => void, mayContainTurtles: (type: Type) => boolean) => Iterable<NativeReference>;

const nativeReferences = new WeakMap<object, NativeReferences>();

export function registerNativeReferences(state: object, references: NativeReferences): void {
  nativeReferences.set(state, references);
}

export class NativeHandle {
  constructor(
    readonly kind: string,
    readonly state: NativeState,
    private readonly logicalReferences?: (spend: () => void) => Iterable<unknown>
  ) {}

  *references(spend: () => void, mayContainTurtles: (type: Type) => boolean): Iterable<NativeReference> {
    const typed = nativeReferences.get(this.state);
    if (typed) yield* typed(spend, mayContainTurtles);
    else
      for (const value of this.logicalReferences ? this.logicalReferences(spend) : Object.values(this.state))
        yield { value };
  }
}

export function hasUndefinedHeader(value: Value): boolean {
  return value instanceof Slice ? value.undefinedHeader : isUndefinedMemory(value);
}

export function isUndefinedMemory(value: Value): boolean {
  if (value instanceof Pointer) return value.storageLocation().storage === UNDEFINED_MEMORY.slots;
  if (value instanceof Slice)
    return storageLocation(value.target.slots, value.start).storage === UNDEFINED_MEMORY.slots;
  return value instanceof FnValue && value.isUndefined;
}

export function arrayPointerView(value: Pointer, type: Extract<Type, { kind: 'array' }>, stride: number): ZArray {
  if (isUndefinedMemory(value)) return new ZArray(UNDEFINED_MEMORY.slots, 0, type.length, type.sentinel !== undefined);
  const array = value.load() as ZArray;
  if (stride !== 0 && hasAggregateStorage(type.child) && !arrayLocations.has(array.slots))
    arrayLocations.set(array.slots, { start: array.offset, stride, origin: value.fieldLocation(0) });
  return array;
}

export function hasAggregateStorage(type: Type): boolean {
  return (
    type.kind === 'array' ||
    type.kind === 'struct' ||
    type.kind === 'union' ||
    type.kind === 'optional' ||
    type.kind === 'error_union'
  );
}

export type NativeState = { turtle?: TurtleState } & Record<string, unknown>;

/** The marker of a local that is not in scope yet or any longer, which the trace does not show. */
export const UNASSIGNED = Symbol('unassigned') as unknown as Value;

export function isAggregate(value: Value): value is ZArray | ZStruct | ZUnion {
  return value instanceof ZArray || value instanceof ZStruct || value instanceof ZUnion;
}

export function zeroArray(length: bigint, hasSentinel: boolean, value: Value): ZArray {
  const backing: Value[] = [];
  const slots = new Proxy<Value[]>(backing, {
    get: (target, key, receiver) =>
      typeof key === 'string' && /^\d+$/.test(key) ? value : Reflect.get(target, key, receiver),
    set: () => true,
  });
  zeroArrayValues.set(slots, { value });
  registerStorageLocation(slots, () => ({ storage: backing, index: 0 }), true);
  return new ZArray(slots, 0, length, hasSentinel);
}

export function zeroArrayElement(value: ZArray): { value: Value } | undefined {
  return zeroArrayValues.get(value.slots);
}

export function copyZeroArray(value: ZArray): ZArray | undefined {
  const element = zeroArrayElement(value);
  return element ? zeroArray(value.lengthValue, value.hasSentinel, element.value) : undefined;
}

/** A copy of a value whose aggregates are fresh, since Zig copies arrays, structs, and unions by value. */
function copyValue(value: Value): Value {
  if (value instanceof ZArray) {
    const virtual = copyZeroArray(value);
    if (virtual) return virtual;
    const length = value.length + (value.hasSentinel ? 1 : 0);
    chargeSnapshot(length);
    return new ZArray(
      Array.from({ length }, (_, index) => copyValue(value.get(index))),
      0,
      value.lengthValue,
      value.hasSentinel
    );
  }
  if (value instanceof ZStruct) {
    chargeSnapshot(value.slots.length);
    return new ZStruct(value.slots.map(copyValue));
  }
  if (value instanceof ZUnion) {
    chargeSnapshot(1);
    return value.copyBacking?.() ?? value.withCopiedPayload(copyValue(value.slots[0]));
  }
  if (value instanceof Some) {
    chargeSnapshot(1);
    return new Some(copyValue(value.value));
  }
  return value;
}

function chargeSnapshot(slots: number): void {
  reserveMemory(slots);
  spendMemory(slots);
}

/**
 * Stores a value into a slot, copying an aggregate into the one the slot holds when both have the same shape, so that
 * pointers into the slot's aggregate see the new value.
 */
export function storeInto(target: Slots, index: number, value: Value): void {
  storeSnapshotInto(target, index, copyValue(value));
}

// code-gauge-allow functionCognitiveComplexity 21 -- Preserves existing aggregate locations when storing copied values.
// code-gauge-allow functionNcss 34 -- Handles aggregate assignment and retained payloads at the storage boundary.
function storeSnapshotInto(target: Slots, index: number, value: Value): void {
  value = valueWithRetainedPayload(target, index, value);
  if (storageLocations.has(target.slots)) {
    target.slots[index] = value;
    return;
  }
  const current = target.slots[index];
  if (value instanceof ZArray && current instanceof ZArray && current.length === value.length) {
    if (zeroArrayValues.has(value.slots) && zeroArrayValues.has(current.slots)) return;
    const length = value.length + (current.hasSentinel && value.hasSentinel ? 1 : 0);
    spendMemory(length);
    for (let at = 0; at < length; at++) storeSnapshotInto(current, current.offset + at, value.get(at));
    return;
  }
  if (value instanceof ZStruct && current instanceof ZStruct && current.slots.length === value.slots.length) {
    const source = value.slots;
    spendMemory(source.length);
    for (const [at, slot] of source.entries()) storeSnapshotInto(current, at, slot);
    return;
  }
  if (value instanceof ZUnion && current instanceof ZUnion && current.writeBacking) {
    current.writeBacking(value);
    return;
  }
  if (
    value instanceof ZUnion &&
    current instanceof ZUnion &&
    !value.fieldView &&
    !current.fieldView &&
    current.tag === value.tag
  ) {
    storeSnapshotInto(current, 0, value.slots[0]);
    current.retainedPayloads = value.retainedPayloads;
    current.payloadInitialized = value.payloadInitialized;
    return;
  }
  if (value instanceof Some && current instanceof Some) {
    const payload = new Cell(current.value);
    storeSnapshotInto(payload, 0, value.value);
    target.slots[index] = new Some(payload.slots[0]);
    return;
  }
  target.slots[index] = value;
}

function valueWithRetainedPayload(target: Slots, index: number, value: Value): Value {
  const error = Pointer.errorProjection(target, index);
  if (error) {
    if (value instanceof ErrorValue) error.retainCurrent();
    else return error.assign(value);
  }
  const optional = Pointer.optionalProjection(target, index);
  if (!optional || value === NULL) return value;
  optional.assign(optionalPayload(value));
  return optional.presentValue();
}

class SliceLength implements Slots {
  constructor(private readonly pointer: Pointer) {}

  get slots(): Value[] {
    const slice = this.pointer.load() as Slice;
    return new Proxy([slice.lengthValue], {
      set: (_, key, value) => {
        if (key === '0')
          this.pointer.target.slots[this.pointer.index] = new Slice(slice.target, slice.start, value as bigint);
        return true;
      },
    });
  }
}

/** The payload storage of an optional whose tag occupies separate bytes. */
class OptionalSlots implements Slots {
  private readonly cell: Cell;
  readonly slots: Value[];
  private readonly wrapped: boolean;

  constructor(private readonly pointer: Pointer) {
    this.wrapped = pointer.load() instanceof Some;
    this.cell = new Cell(optionalPayload(pointer.load()));
    this.slots = new Proxy(this.cell.slots, {
      set: (_, key, value) => {
        if (key === '0') {
          this.cell.slots[0] = value as Value;
          if (this.pointer.load() !== NULL) this.pointer.target.slots[this.pointer.index] = this.presentValue();
        }
        return true;
      },
    });
    aliasStorage(this.slots, this.cell.slots);
    registerPointerLocation(this.slots, () => this.pointer.storageLocation());
  }

  assign(value: Value): void {
    storeSnapshotInto(this.cell, 0, value);
  }

  presentValue(): Value {
    return this.wrapped ? new Some(this.cell.slots[0]) : this.cell.slots[0];
  }
}

class ErrorPayloadSlots implements Slots {
  private readonly cell: Cell;
  readonly slots: Value[];

  constructor(
    private readonly pointer: Pointer,
    offset: number
  ) {
    this.cell = new Cell(pointer.load());
    this.slots = new Proxy(this.cell.slots, {
      get: (target, key, receiver) => {
        if (key === '0') this.retainCurrent();
        return Reflect.get(target, key, receiver);
      },
      set: (_, key, value: Value) => {
        if (key === '0') {
          this.cell.slots[0] = value;
          if (!(this.pointer.load() instanceof ErrorValue)) this.pointer.target.slots[this.pointer.index] = value;
        }
        return true;
      },
    });
    aliasStorage(this.slots, this.cell.slots);
    registerPointerLocation(this.slots, () => this.pointer.fieldLocation(offset));
  }

  retainCurrent(): void {
    const value = this.pointer.load();
    if (!(value instanceof ErrorValue)) this.cell.slots[0] = value;
  }

  assign(value: Value): Value {
    this.retainCurrent();
    storeSnapshotInto(this.cell, 0, value);
    return this.presentValue();
  }

  presentValue(): Value {
    return this.cell.slots[0];
  }
}

export function scalarValueKey(value: Value): string {
  if (value instanceof BigFloat) return `float ${value.kind} ${value.sign} ${value.mantissa} ${value.exponent}`;
  if (value instanceof ErrorValue || value instanceof EnumLiteral)
    return `${value.constructor.name} ${JSON.stringify(value.name)}`;
  if (value instanceof Some) return `some ${scalarValueKey(value.value)}`;
  if (value instanceof Pointer) {
    const location = value.storageLocation();
    return `pointer ${scalarIdentity(location.storage)} ${location.index}`;
  }
  if (value instanceof FnValue) return `fn ${scalarIdentity(value.fn)}`;
  if (typeof value === 'object') return `object ${scalarIdentity(value)}`;
  if (typeof value === 'number' && Object.is(value, -0)) return 'number -0';
  return `${typeof value} ${String(value)}`;
}

function scalarIdentity(value: object): number {
  let identity = scalarIdentities.get(value);
  if (identity === undefined) {
    identity = nextScalarIdentity++;
    scalarIdentities.set(value, identity);
  }
  return identity;
}

export function optionalPayload(value: Value): Value {
  return value instanceof Some ? value.value : value;
}

export function scalarValuesEqual(a: Value, b: Value): boolean {
  if (a instanceof BigFloat && b instanceof BigFloat) return compareFloats(a, b) === 0;
  if (a instanceof Pointer && b instanceof Pointer) return a.equals(b);
  if (a instanceof FnValue && b instanceof FnValue) return a.fn === b.fn;
  return a === b;
}
