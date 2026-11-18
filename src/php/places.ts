// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { deprecated, throwError, type UpdateWarning, warn } from './errors';
import { type Frame, type PhpThrow, rt } from './runtime';
import { describePropertyType } from './types';
import { dropped, type Key, PhpArray, PhpObject, type PropDecl, Ref, type Value } from './values';
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

/** A location a program writes to: a variable, an element, a property, or a static property. */
export interface Place {
  /** The value, or undefined when the location does not exist. */
  get(update?: PlaceOperation): Value | undefined;
  readCompoundName?(warning: UpdateWarning): void;
  fetchCompound?(warning: UpdateWarning, beforeOffsetGet?: BeforeOffsetGet): CompoundRead | typeof SKIP_COMPOUND;
  set(value: Value, operation?: 'assignOp'): Value;
  assign?(value: () => Value): Value;
  /** The location as a reference, which `=&`, by-reference arguments, and `global` share. */
  ref(): Ref;
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
  /** Warns that the place does not exist, as a read-modify-write (`++`, `.=`) of it does, creating what PHP creates. */
  warnUndefined?(warning?: UpdateWarning): void;
  /** The value as `isset` and `??` read it, asking `__isset` or `offsetExists` first; undefined when unset. */
  getForIsset?(): Value | undefined;
}

export function readCompound(
  place: Place,
  warning: UpdateWarning,
  beforeOffsetGet?: BeforeOffsetGet
): CompoundRead | typeof SKIP_COMPOUND {
  if (place.fetchCompound) return place.fetchCompound(warning, beforeOffsetGet);
  const value = place.get('assignOp');
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
    private readonly kind: 'compiled' | 'dynamic' | 'global' = 'compiled'
  ) {}

  get(): Value | undefined {
    const ref = this.frame.vars.get(this.name);
    return ref?.isDefinedBinding ? ref.v : undefined;
  }

  warnUndefined(): void {
    warn(`Undefined ${this.kind === 'global' ? 'global ' : ''}variable $${this.name}`);
  }

  fetchCompound(warning: UpdateWarning): CompoundRead {
    const current = this.get();
    if (current !== undefined) return { value: current, sources: this.typeSources() };
    if (this.kind !== 'compiled') this.warnUndefined();
    else warning(() => this.warnUndefined());
    this.set(null);
    return { value: null };
  }

  set(value: Value): Value {
    const ref = this.frame.vars.get(this.name);
    if (ref) {
      ref.assign(value);
      return ref.v;
    }
    this.frame.vars.set(this.name, new Ref(value));
    return value;
  }

  typeSources(): Ref['typedBy'] {
    return this.frame.vars.get(this.name)?.typeOwners();
  }

  ref(): Ref {
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
    if (this.name === 'this') throwError('Error', 'Cannot re-assign $this');
    const old = this.frame.vars.get(this.name);
    if (old === ref) return;
    if (old) old.rc--;
    ref.isRef = true;
    ref.rc++;
    this.frame.vars.set(this.name, ref);
    if (old) dropped(old.v);
  }
}

export class RefPlace implements Place {
  constructor(readonly target: Ref) {
    if (target.rc === 0) rt().holdTemporaryReference(target);
  }

  get(): Value {
    return this.target.v;
  }

  set(value: Value): Value {
    this.target.assign(value);
    return this.target.v;
  }

  typeSources(): Ref['typedBy'] {
    return this.target.typeOwners();
  }

  ref(): Ref {
    return this.target;
  }

  unset(): void {
    throwError('Error', 'Cannot unset this expression');
  }
}

export class ElementPlace implements Place {
  constructor(
    readonly array: PhpArray,
    /** The key, or undefined to append. */
    public key: Key | undefined
  ) {}

  get(): Value | undefined {
    if (this.key === undefined) return undefined;
    return this.array.get(this.key);
  }

  warnUndefined(): void {
    if (this.key !== undefined)
      warn(`Undefined array key ${typeof this.key === 'bigint' ? this.key : `"${this.key}"`}`);
  }

  fetchCompound(): CompoundRead | typeof SKIP_COMPOUND {
    const current = this.get();
    if (current !== undefined) return { value: current, sources: this.typeSources() };
    this.warnUndefined();
    if (this.get() !== undefined) return SKIP_COMPOUND;
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
    this.array.set(this.key, value);
    return this.array.get(this.key) as Value;
  }

  typeSources(): Ref['typedBy'] {
    const ref = this.key === undefined ? undefined : this.array.map.get(this.key);
    return ref instanceof Ref ? ref.typeOwners() : undefined;
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
  update = false,
  lookupRow?: number
): PhpArray | PhpObject | string {
  if (value === undefined) value = readContainerForWrite(place, update, lookupRow);
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
    if (update && value === undefined) place.warnUndefined?.();
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

let sharingCheck: (array: PhpArray) => boolean = (array) => array.shared;

export function setArraySharingCheck(check: typeof sharingCheck): void {
  sharingCheck = check;
}

export function arrayIsShared(array: PhpArray): boolean {
  if (!array.shared) return false;
  const shared = sharingCheck(array);
  if (!shared) array.shared = false;
  return shared;
}
