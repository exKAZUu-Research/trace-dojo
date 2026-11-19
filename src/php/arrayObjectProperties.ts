// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callMethod, callOffsetExists, consumeInvokedResult, discardInvokedResult, readOffset } from './callables';
import { canAccessProp, lookupProp } from './classes';
import { normalizeKeyString, toBool } from './conversions';
import { notice, throwError, type UpdateWarning } from './errors';
import type { ArrayStorage } from './libArrayObject';
import { nativeArrayStorage } from './nativeArrayStorage';
import { type CompoundRead, ElementPlace, type NestMode, type Place, RefPlace, share } from './places';
import { rt } from './runtime';
import { type Key, type PhpClass, type PhpObject, type PropDecl, Ref, UNINIT, type Value } from './values';

export function arrayObjectProperty(
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  decl?: PropDecl,
  unbound = false
): ArrayObjectProperty | undefined {
  const storage = object.internal;
  if (!nativeArrayStorage(storage) || !storage.arrayAsProperties) return;
  const prop = decl ?? lookupProp(object.cls, name, scope);
  if (prop && !prop.isStatic) {
    if (canAccessProp(prop, scope) && (prop.isVirtual || initialized(object, prop.key))) return;
  } else if (initialized(object, name)) return;
  return new ArrayObjectProperty(object, storage, name, unbound);
}

function initialized(object: PhpObject, key: string): boolean {
  const value = object.props.get(key);
  return value !== undefined && value !== UNINIT;
}

class ArrayObjectProperty implements Place {
  private readonly key: Key;

  constructor(
    private readonly object: PhpObject,
    private readonly storage: ArrayStorage,
    private readonly name: string,
    readonly unbound: boolean
  ) {
    this.key = normalizeKeyString(name);
  }

  read(mode: 'read' | 'quiet' | 'update' | 'coalesce' | 'empty' | 'native'): Value {
    if (mode === 'empty') return this.has('not-empty');
    if (mode === 'coalesce' && !this.has('isset')) return null;
    if (this.overrides('offsetget')) return readOffset(this.object, this.name);
    if (mode === 'read' || mode === 'update') return this.storage.offsetValue(this.name, this.object.cls.name);
    return this.get() ?? null;
  }

  has(mode: 'isset' | 'not-empty' | 'exists'): boolean {
    const overridden = this.overrides('offsetexists');
    if (overridden && !callOffsetExists(this.object, this.name)) return false;
    if (mode === 'isset') return overridden || this.storage.array.isSet(this.key);
    if (mode === 'exists' && !(overridden && this.overrides('offsetget'))) return this.storage.array.has(this.key);
    if (!overridden && !this.storage.array.has(this.key)) return false;
    if (this.overrides('offsetget')) return consumeInvokedResult(() => readOffset(this.object, this.name), toBool);
    return toBool(this.get() ?? null);
  }

  get(): Value | undefined {
    return this.overrides('offsetget') ? readOffset(this.object, this.name) : this.storage.array.get(this.key);
  }

  getForIsset(): Value {
    return this.read('coalesce');
  }

  set(value: Value, operation?: 'assignOp'): Value {
    if (operation && !this.overrides('offsetget')) return this.element().set(value);
    if (this.overrides('offsetset'))
      discardInvokedResult(() => callMethod(this.object, 'offsetSet', [this.name, value], rt().row));
    else this.storage.setOffset(this.name, value, this.object.cls.name);
    return value;
  }

  unset(): void {
    if (this.overrides('offsetunset'))
      discardInvokedResult(() => callMethod(this.object, 'offsetUnset', [this.name], rt().row));
    else this.storage.deleteOffset(this.name, this.object.cls.name);
  }

  fetchCompound(warning: UpdateWarning): CompoundRead {
    if (this.overrides('offsetget')) {
      let value: Value = null;
      warning(() => {
        value = readOffset(this.object, this.name);
      });
      return { value };
    }
    const element = this.element();
    const value = element.get();
    if (value === undefined && warning(() => element.warnUndefined()) && element.get() === undefined) {
      element.set(null);
    }
    return { value: value ?? null, sources: element.typeSources(), write: (result) => element.set(result) };
  }

  incrementTarget(): Place {
    return this.overrides('offsetget') ? this : this.element();
  }

  writeAfterFailedIncrement(value: Value): void {
    if (!this.overrides('offsetset')) this.storage.setOffset(this.name, value, this.object.cls.name);
  }

  nested(mode: NestMode = 'write'): Place {
    if (this.overrides('offsetget')) return new RefPlace(this.readReference());
    const element = this.element();
    if (element.get() === undefined) {
      if (mode === 'unset') return new RefPlace(Ref.temporary(null));
      if (mode === 'update') element.warnUndefined();
      element.set(null);
    }
    return element;
  }

  ref(): Ref {
    return this.overrides('offsetget') ? this.readReference() : this.element().ref();
  }

  bind(ref: Ref, valueFallback: boolean): void {
    if (this.overrides('offsetget')) {
      consumeInvokedResult(
        () => readOffset(this.object, this.name),
        () => {}
      );
      throwError('Error', 'Cannot assign by reference to overloaded object');
    }
    const element = this.element();
    if (valueFallback) {
      notice('Only variables should be assigned by reference');
      ref.v = element.set(share(ref.v));
      return;
    }
    if (element.reference() === ref) return;
    ref.isRef = true;
    ref.rc++;
    element.array.setSlot(this.key, ref);
  }

  private element(): ElementPlace {
    return new ElementPlace(this.storage.writable(), this.key, this.unbound, true);
  }

  private readReference(): Ref {
    const runtime = rt();
    runtime.lastReturnRef = undefined;
    try {
      const value = readOffset(this.object, this.name);
      return runtime.lastReturnRef ?? Ref.temporary(value);
    } finally {
      runtime.lastReturnRef = undefined;
    }
  }

  private overrides(method: string): boolean {
    return this.object.cls.findMethod(method)?.fn.kind === 'user';
  }
}
