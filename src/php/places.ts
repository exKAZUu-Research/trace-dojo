// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { deprecated, E_WARNING, emitError, throwError, type UpdateWarning, warn, withPendingException } from './errors';
import { type Frame, PhpThrow, rt } from './runtime';
import { watchSlot } from './slotWatch';
import { describePropertyType } from './types';
import { checkedDynamicVariable } from './unsupported';
import { dropped, type Key, PhpArray, PhpObject, type PropDecl, Ref, type Slot, type Value } from './values';
import { isSubtype } from './variance';

export type PlaceOperation = 'assignOp' | 'incdec' | 'nested' | 'nestedUpdate' | 'receiver' | 'receiverUpdate';
export type NestMode = 'write' | 'update' | 'unset';
export type BeforeOffsetGet = () => PhpThrow | undefined;

export const SKIP_COMPOUND = Symbol('compound target changed during fetch');

export interface CompoundRead {
  value: Value;
  write?(value: Value): Value;
  declaration?: PropDecl;
  sources?: Ref['typedBy'];
}

interface StringStorage {
  current(): boolean;
  write(value: string): void;
  close(): void;
}

/** A location a program writes to: a variable, an element, a property, or a static property. */
export interface Place {
  readonly unbound?: boolean;
  /** The value, or undefined when the location does not exist. */
  get(update?: PlaceOperation, warning?: UpdateWarning): Value | undefined;
  /** The value, emitting its undefined warning and returning null when missing. */
  getOrWarn?(): Value;
  readCompoundName?(warning: UpdateWarning): void;
  fetchCompound?(warning: UpdateWarning, beforeOffsetGet?: BeforeOffsetGet): CompoundRead | typeof SKIP_COMPOUND;
  set(value: Value, operation?: 'assignOp'): Value;
  stringStorage?(): StringStorage;
  assign?(value: () => Value): Value;
  /** The location as a reference, which `=&`, by-reference arguments, and `global` share. */
  ref(): Ref;
  reference?(): Ref | undefined;
  unset(): void;
  /** The declaration of the property the place is, whose type limits what the place holds. */
  declaration?(): PropDecl | undefined;
  typeSources?(): Ref['typedBy'];
  /**
   * The place a nested write (`$place[] = 1`) changes: the place itself, or another one for a property that `__get`
   * provides or an element that `offsetGet` provides. Throws where the place may not change that way.
   */
  nested?(mode?: NestMode): Place;
  incrementTarget?(): Place;
  writeAfterFailedIncrement?(value: Value): void;
  /** Warns that the place does not exist, as a read-modify-write (`++`, `.=`) of it does, creating what PHP creates. */
  warnUndefined?(warning?: UpdateWarning): boolean | void;
  /** The value as `isset` and `??` read it, asking `__isset` or `offsetExists` first; undefined when unset. */
  getForIsset?(): Value | undefined;
}

export function withIncrementCleanup<T>(place: Place, old: Value, update: () => T): T {
  try {
    return update();
  } catch (error) {
    if (error instanceof PhpThrow && place.writeAfterFailedIncrement)
      withPendingException(rt(), error, () => place.writeAfterFailedIncrement?.(old));
    throw error;
  }
}

export function warnPropertySlot(
  props: { has(key: Key): boolean },
  name: string,
  declared: boolean,
  warning: UpdateWarning,
  message: string
): boolean {
  const emit = (): boolean =>
    warning(
      () => warn(message),
      () => warn(message, true)
    );
  if (declared) {
    emit();
    return true;
  }
  const watch = watchSlot(props, name);
  try {
    return emit() || watch.current() || !props.has(name);
  } finally {
    watch.close();
  }
}

export function watchStringSlot(
  owner: object,
  key: Key,
  read: () => Slot | undefined,
  write: (value: string) => void
): StringStorage {
  const slot = read();
  if (slot instanceof Ref) {
    const watch = watchSlot(slot, '');
    const aliased = slot.isRef;
    return {
      current: () => watch.current() && (aliased ? slot.rc > 0 : read() === slot),
      write: (value) => slot.assign(value),
      close: () => watch.close(),
    };
  }
  const watch = watchSlot(owner, key);
  return { current: () => watch.current() && read() === slot, write, close: () => watch.close() };
}

export function readCompound(
  place: Place,
  warning: UpdateWarning,
  beforeOffsetGet?: BeforeOffsetGet
): CompoundRead | typeof SKIP_COMPOUND {
  if (place.fetchCompound) return place.fetchCompound(warning, beforeOffsetGet);
  const value = place.get('assignOp', warning);
  if (value === undefined) place.warnUndefined?.();
  return { value: value ?? null, declaration: place.declaration?.(), sources: place.typeSources?.() };
}

/** Marks an array as held by more than one holder, so that the next write copies it. */
export function share(value: Value): Value {
  if (value instanceof PhpArray) value.shared = true;
  return value;
}

export class VarPlace implements Place {
  constructor(
    private readonly frame: Frame,
    readonly name: string,
    private readonly kind: 'compiled' | 'dynamic' | 'global' = 'compiled',
    private readonly fetchRow?: number
  ) {
    checkedDynamicVariable(name);
  }

  get(operation?: PlaceOperation): Value | undefined {
    if (operation) this.checkWritableName();
    const ref = this.frame.vars.get(this.name);
    return ref?.isDefinedBinding ? ref.v : undefined;
  }

  getForIsset(): Value | undefined {
    if (this.kind === 'global' && this.name === 'this') return rt().frame.thisObj;
    return this.get();
  }

  stringStorage(): StringStorage {
    return watchStringSlot(
      this.frame.vars,
      this.name,
      () => this.frame.vars.get(this.name),
      (value) => this.set(value)
    );
  }

  warnUndefined(): void {
    emitError(E_WARNING, `Undefined ${this.kind === 'global' ? 'global ' : ''}variable $${this.name}`, this.fetchRow);
  }

  getOrWarn(): Value {
    const value = this.get();
    if (value !== undefined) return value;
    this.warnUndefined();
    return null;
  }

  fetchCompound(warning: UpdateWarning): CompoundRead {
    const current = this.get('assignOp');
    if (current !== undefined) return { value: current, sources: this.typeSources() };
    if (this.kind !== 'compiled') this.warnUndefined();
    else warning(() => this.warnUndefined());
    this.set(null);
    return { value: null };
  }

  set(value: Value): Value {
    this.checkWritableName();
    const ref = this.frame.vars.get(this.name);
    if (ref) return ref.assign(value);
    this.frame.vars.set(this.name, new Ref(value));
    return value;
  }

  typeSources(): Ref['typedBy'] {
    return this.frame.vars.get(this.name)?.typeOwners();
  }

  reference(): Ref | undefined {
    const ref = this.frame.vars.get(this.name);
    return ref?.isRef ? ref : undefined;
  }

  ref(): Ref {
    this.checkWritableName();
    let ref = this.frame.vars.get(this.name);
    if (!ref) {
      ref = new Ref(null);
      this.frame.vars.set(this.name, ref);
    } else if (!ref.isDefinedBinding) ref.v = null;
    return ref;
  }

  unset(): void {
    const ref = this.frame.vars.get(this.name);
    if (ref) {
      ref.rc--;
      this.frame.vars.delete(this.name);
      dropped(ref.v);
    }
  }

  bind(ref: Ref): void {
    this.checkWritableName();
    const old = this.frame.vars.get(this.name);
    if (old === ref) return;
    if (old) old.rc--;
    ref.isRef = true;
    ref.rc++;
    this.frame.vars.set(this.name, ref);
    if (old) dropped(old.v);
  }

  private checkWritableName(): void {
    if (this.name === 'this') throwError('Error', 'Cannot re-assign $this');
  }
}

export class RefPlace implements Place {
  readonly unbound: boolean;

  constructor(readonly target: Ref) {
    this.unbound = target.rc === 0;
    if (this.unbound) rt().holdTemporaryReference(target);
  }

  get(): Value {
    return this.target.v;
  }

  stringStorage(): StringStorage {
    return watchStringSlot(
      this.target,
      '',
      () => this.target,
      (value) => this.set(value)
    );
  }

  set(value: Value): Value {
    return this.target.assign(value);
  }

  typeSources(): Ref['typedBy'] {
    return this.target.typeOwners();
  }

  ref(): Ref {
    return this.target;
  }

  reference(): Ref | undefined {
    return this.target.isRef ? this.target : undefined;
  }

  unset(): void {
    throwError('Error', 'Cannot unset this expression');
  }
}

export class ElementPlace implements Place {
  constructor(
    readonly array: PhpArray,
    /** The key, or undefined to append. */
    public key: Key | undefined,
    readonly unbound = false,
    private readonly objectBacked = false
  ) {}

  get(): Value | undefined {
    if (this.key === undefined) return undefined;
    return this.array.get(this.key);
  }

  warnUndefined(): void {
    if (this.key !== undefined)
      warn(`Undefined array key ${typeof this.key === 'bigint' ? this.key : `"${this.key}"`}`);
  }

  warnMissingUpdate(warning?: UpdateWarning): boolean {
    if (this.objectBacked) {
      if (warning) warning(() => this.warnUndefined());
      else this.warnUndefined();
      this.set(null);
      return true;
    }
    if (this.unbound || !sharingCheck(this.array, 1)) {
      this.warnUndefined();
      return this.get() === undefined;
    }
    const runtime = rt();
    this.array.shared = true;
    runtime.held.push(this.array);
    let thrown: unknown;
    try {
      this.warnUndefined();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      runtime.held.pop();
      if (!sharingCheck(this.array, 1)) {
        if (thrown instanceof PhpThrow) withPendingException(runtime, thrown, () => dropped(this.array));
        else dropped(this.array);
      }
    }
    return sharingCheck(this.array, 1) && !arrayIsShared(this.array) && this.get() === undefined;
  }

  fetchCompound(): CompoundRead | typeof SKIP_COMPOUND {
    const current = this.get();
    if (current !== undefined) return { value: current, sources: this.typeSources() };
    if (!this.warnMissingUpdate()) return SKIP_COMPOUND;
    this.set(null);
    return { value: null };
  }

  set(value: Value): Value {
    if (this.key === undefined) {
      const key = this.array.appendKey;
      if (!this.array.append(value)) {
        throwError('Error', 'Cannot add element to the array as the next element is already occupied');
      }
      this.key = key;
      return value;
    }
    return this.array.set(this.key, value);
  }

  typeSources(): Ref['typedBy'] {
    const ref = this.key === undefined ? undefined : this.array.map.get(this.key);
    return ref instanceof Ref ? ref.typeOwners() : undefined;
  }

  stringStorage(): StringStorage {
    const key = this.key!;
    const table = this.array.map;
    return watchStringSlot(
      table,
      key,
      () => (this.array.map === table ? table.get(key) : undefined),
      (value) => this.set(value)
    );
  }

  reference(): Ref | undefined {
    const slot = this.key === undefined ? undefined : this.array.map.get(this.key);
    return slot instanceof Ref && slot.isRef ? slot : undefined;
  }

  ref(): Ref {
    if (this.key === undefined) {
      const ref = new Ref(null);
      ref.isRef = true;
      const key = this.array.appendKey;
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

  set(): never {
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
export function writableContainer(
  place: Place,
  value?: Value,
  options?: { update?: boolean; lookupRow?: number; fetchDimension?: boolean }
): PhpArray | PhpObject | string {
  if (value === undefined) value = readContainerForWrite(place, options?.update ?? false, options?.lookupRow);
  if (value instanceof PhpArray) {
    if (arrayIsShared(value)) {
      const copy = value.copy();
      place.set(copy);
      return copy;
    }
    return value;
  }
  if (value === undefined || value === null) return initializeArray(place);
  if (value === false) {
    if (!options?.fetchDimension || !place.reference?.())
      deprecated('Automatic conversion of false to array is deprecated');
    return initializeArray(place);
  }
  if (value instanceof PhpObject) return value;
  if (typeof value === 'string') return value;
  throwError('Error', 'Cannot use a scalar value as an array');
}

function readContainerForWrite(place: Place, update: boolean, lookupRow: number | undefined): Value | undefined {
  const runtime = rt();
  const operationRow = runtime.row;
  if (lookupRow !== undefined) runtime.row = lookupRow;
  try {
    const value = place.get(update ? 'nestedUpdate' : 'nested');
    if (update && value === undefined) {
      if (place instanceof ElementPlace) return place.warnMissingUpdate() ? undefined : new PhpArray();
      place.warnUndefined?.();
    }
    return value;
  } finally {
    if (lookupRow !== undefined) runtime.row = operationRow;
  }
}

function initializeArray(place: Place): PhpArray {
  const decl = place.declaration?.();
  if (decl?.type && !isSubtype({ k: 'named', name: 'array' }, undefined, decl.type, decl.cls))
    throwError(
      'TypeError',
      `Cannot auto-initialize an array inside property ${decl.cls.name}::$${decl.name} of type ${describePropertyType(decl)}`
    );
  for (const { decl: source } of place.typeSources?.() ?? [])
    if (source.type && !isSubtype({ k: 'named', name: 'array' }, undefined, source.type, source.cls))
      throwError(
        'TypeError',
        `Cannot auto-initialize an array inside a reference held by property ${source.cls.name}::$${source.name} of type ${describePropertyType(source)}`
      );
  const array = new PhpArray();
  place.set(array);
  return array;
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

let sharingCheck: (array: PhpArray, minimum?: 1 | 2) => boolean = (array) => array.shared;

export function setArraySharingCheck(check: typeof sharingCheck): void {
  sharingCheck = check;
}

export function arrayIsShared(array: PhpArray): boolean {
  if (!array.shared) return false;
  const shared = sharingCheck(array, 2);
  if (!shared) array.shared = false;
  return shared;
}
