// code-gauge-allow-file fileNcss 663 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { Expr, ListItem } from './ast';
import { foreachSubjectWritable, hasReferenceItem } from './astAnalysis';
import { callMethod } from './callables';
import { propRef, readProp, staticPropRef, unsetProp, writeProp } from './classes';
import * as classesModule from './classes';
import * as conversionsModule from './conversions';
import { debugType, numericPrefix, toBool, valueName } from './conversions';
import { deprecated, notice, throwError, warn, withPendingException } from './errors';
import { ev, isArrayAccess, memberName, prepareOperand, readIndex, resolveClassRef, stringOffset } from './interp';
import { arithmetic, bitwise, concat, toInt, toKey, toStr } from './operators';
import {
  ElementPlace,
  type Place,
  type PlaceOperation,
  readElement,
  RefPlace,
  share,
  ValuePlace,
  VarPlace,
  writableContainer,
} from './places';
import { PhpThrow, rt } from './runtime';
import { incrementString } from './strings';
import { coerce, describePropertyType, matches, NO_MATCH, typeToString } from './types';
import {
  type Key,
  PhpArray,
  type PhpClass,
  PhpObject,
  type PropDecl,
  Ref,
  type TypeDecl,
  UNINIT,
  type Value,
} from './values';

// Assignment ---------------------------------------------------------------------------------------------------------

type WriteMode = 'write' | 'update' | 'incdec';
type PlaceMode = WriteMode | 'deferred';

/** The location a writable expression names, evaluating its keys and creating containers as PHP's writes do. */
// code-gauge-allow functionNcss 52 -- Handles each kind of writable expression, whose write rules PHP defines separately.
// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function placeOf(e: Expr, mode: PlaceMode = 'write', through = false): Place {
  const runtime = rt();
  const frame = runtime.frame;
  switch (e.k) {
    case 'var': {
      if (e.name === 'GLOBALS') return new ValuePlace(ev(e));
      if (e.name === 'this') {
        if (frame.thisObj) return new ValuePlace(frame.thisObj);
        throwError('Error', 'Using $this when not in object context');
      }
      return new VarPlace(frame, e.name);
    }
    case 'varvar': {
      return namedPlace(e.name, mode, (name) => {
        if (name === 'this') throwError('Error', 'Cannot re-assign $this');
        return new VarPlace(frame, name);
      });
    }
    case 'idx': {
      if (e.base.k === 'var' && e.base.name === 'GLOBALS') {
        if (e.index === undefined) throwError('Error', 'Cannot append to $GLOBALS');
        return namedPlace(e.index, mode, (name) => new VarPlace(runtime.globalFrame, name, true));
      }
      return dimensionPlace(e, mode);
    }
    case 'prop': {
      return instancePropertyPlace(e, mode, through);
    }
    case 'sprop': {
      const cls = resolveClassRef(e.cls);
      return namedPlace(e.name, mode, (name) => new StaticPlace(cls, name, frame.scope));
    }
    case 'call':
    case 'mcall':
    case 'scall': {
      runtime.lastReturnRef = undefined;
      const value = ev(e);
      const returned = runtime.lastReturnRef;
      runtime.lastReturnRef = undefined;
      return new RefPlace(returned ?? Ref.temporary(value));
    }
    default: {
      return new ValuePlace(ev(e));
    }
  }
}

function namedPlace(name: Expr | string, mode: PlaceMode, locate: (name: string) => Place): Place {
  const readName = typeof name === 'string' ? () => name : prepareOperand(name);
  const resolve = (): Place => locate(toStr(readName()));
  return mode === 'deferred' ? deferredPlace(resolve, () => readForIsset(resolve())) : resolve();
}

function dimensionPlace(e: Extract<Expr, { k: 'idx' }>, mode: PlaceMode): Place {
  const parent = placeOf(e.base, mode, true);
  const readKey = e.index === undefined ? undefined : prepareOperand(e.index);
  const resolve = (writeMode: WriteMode): Place => {
    const key = readKey?.();
    rt().row = e.row;
    const fetch = nestedPlace(parent, writeMode);
    const container = writableContainer(fetch, undefined, writeMode !== 'write');
    if (container instanceof PhpArray) return new ElementPlace(container, key === undefined ? undefined : toKey(key));
    if (container instanceof PhpObject) return arrayAccessPlace(container, key);
    return stringOffsetPlace(fetch, container, key);
  };
  if (mode !== 'deferred') return resolve(mode);
  return deferredPlace(resolve, () => {
    const container = readForIsset(parent);
    const key = readKey?.();
    rt().row = e.row;
    return container === undefined || container === null || key === undefined
      ? undefined
      : readIndex(container, key, 'coalesce');
  });
}

function instancePropertyPlace(e: Extract<Expr, { k: 'prop' }>, mode: PlaceMode, through: boolean): Place {
  const parent = placeOf(e.obj, mode, true);
  const property = e.name;
  const readName = typeof property === 'string' ? () => property : prepareOperand(property);
  const resolve = (writeMode: WriteMode): Place => {
    const name = toStr(readName());
    const object = propertyReceiver(e.obj, parent, writeMode);
    rt().row = e.row;
    if (!(object instanceof PhpObject)) {
      const action = through ? 'modify' : writeMode === 'incdec' ? 'increment/decrement' : 'assign';
      throwError('Error', `Attempt to ${action} property "${name}" on ${valueName(object)}`);
    }
    return propPlace(object, name);
  };
  if (mode !== 'deferred') return resolve(mode);
  return deferredPlace(resolve, () => {
    const object = readForIsset(parent);
    const name = toStr(readName());
    rt().row = e.row;
    return object instanceof PhpObject ? readProp(object, name, rt().frame.scope, 'coalesce') : undefined;
  });
}

function propertyReceiver(e: Expr, parent: Place, mode: WriteMode): Value {
  const target = nestedPlace(parent, mode);
  const object = target.get('receiver');
  if (object !== undefined) return object;
  if (mode !== 'write') target.warnUndefined?.();
  materializeNestedSlot(e, target);
  return null;
}

export function foreachSubjectPlace(e: Expr): Place {
  if (e.k === 'call' || e.k === 'mcall' || e.k === 'scall') return placeOf(e);
  if (!foreachSubjectWritable(e)) return new RefPlace(Ref.temporary(share(ev(e))));
  const place = placeOf(e, 'write', true);
  if (place instanceof ValuePlace) return new RefPlace(Ref.temporary(place.value));
  if (e.k === 'var' && place.get() === undefined) {
    place.warnUndefined?.();
    return place;
  }
  return new RefPlace(place.ref());
}

function materializeNestedSlot(e: Expr, place: Place): void {
  if (e.k === 'idx' || e.k === 'prop') place.set(null);
}

function nestedPlace(place: Place, mode: WriteMode | 'unset'): Place {
  return place.nested?.(mode === 'incdec' ? 'update' : mode) ?? place;
}

function readForIsset(place: Place): Value | undefined {
  return place.getForIsset ? place.getForIsset() : place.get();
}

function deferredPlace(resolve: (mode: WriteMode) => Place, read: () => Value | undefined): Place {
  let target: Place | undefined;
  const writable = (mode: WriteMode = 'write'): Place => (target ??= resolve(mode));
  return {
    get: (operation) => (operation === 'assignOp' ? writable('update').get(operation) : read()),
    getForIsset: read,
    nested: (mode) => {
      const place = writable(mode === 'update' ? 'update' : 'write');
      return place.nested?.(mode) ?? place;
    },
    warnUndefined: () => target?.warnUndefined?.(),
    declaration: () => target?.declaration?.(),
    typeSources: () => target?.typeSources?.(),
    set: (value, operation) => writable().set(value, operation),
    assign: (value) => assignPlace(writable(), value),
    ref: () => writable().ref(),
    unset: () => writable().unset(),
  };
}

function globalPlace(index?: Expr): VarPlace {
  if (index === undefined) throwError('Error', 'Cannot append to $GLOBALS');
  return new VarPlace(rt().globalFrame, toStr(ev(index)), true);
}

class StaticPlace implements Place {
  private reportedTraitAccess = false;

  constructor(
    private readonly cls: PhpClass,
    private readonly name: string,
    private readonly scope: PhpClass | undefined
  ) {}

  private get decl(): PropDecl | undefined {
    return this.cls.findStatic(this.name)?.decl;
  }

  private get target(): Ref {
    const target = staticPropRef(this.cls, this.name, this.scope, !this.reportedTraitAccess);
    this.reportedTraitAccess = true;
    return target;
  }

  typeSources(): Ref['typedBy'] {
    const target = this.target;
    return target.isRef ? target.typeOwners() : undefined;
  }

  declaration(): PropDecl | undefined {
    return this.decl;
  }

  get(update?: PlaceOperation): Value {
    const value = this.target.v;
    if ((value as unknown) === UNINIT) {
      if (update === 'nested' || update === 'receiver') return null;
      throwError(
        'Error',
        `Typed static property ${this.decl?.cls.name ?? this.cls.name}::$${this.name} must not be accessed before initialization`
      );
    }
    return value;
  }

  getForIsset(): Value {
    return classesModule.readStaticProp(this.cls, this.name, this.scope, true);
  }

  ref(): Ref {
    const target = this.target;
    const decl = this.decl;
    if ((target.v as unknown) === UNINIT && decl?.type) {
      if (coerce(null, decl.type, { strict: true, internal: false, scope: decl.cls }) === NO_MATCH)
        throwError(
          'Error',
          `Cannot access uninitialized non-nullable property ${decl.cls.name}::$${decl.name} by reference`
        );
      target.v = null;
    }
    return target;
  }

  set(value: Value, operation?: 'assignOp'): Value {
    const target = this.target;
    const decl = this.decl;
    target.v =
      decl?.type && !(operation === 'assignOp' && target.isRef) ? classesModule.coerceProperty(decl, value) : value;
    return target.v;
  }

  unset(): void {
    throwError('Error', `Attempt to unset static property ${this.cls.name}::$${this.name}`);
  }
}

// code-gauge-allow functionCognitiveComplexity 28 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionNcss 36 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function propPlace(object: PhpObject, name: string): Place {
  const scope = rt().frame.scope;
  let reportedStaticAccess = false;
  const lookup = (report: boolean): PropDecl | undefined => {
    const property = classesModule.lookupProp(object.cls, name, scope);
    if (!property?.isStatic) return property;
    if (report && classesModule.checkStaticInstanceAccess(object, name, scope, property, 'get', !reportedStaticAccess))
      reportedStaticAccess = true;
    return undefined;
  };
  return {
    get: (operation) => {
      if (operation) lookup(true);
      return readPropertyPlace(object, name, scope, operation);
    },
    set: (value, operation) => writeProp(object, name, value, scope, { fetched: reportedStaticAccess, operation }),
    ref: () => propRef(object, name, scope),
    unset: () => unsetProp(object, name, scope),
    declaration: () => lookup(false),
    typeSources: () => {
      const decl = lookup(false);
      const ref = object.props.get(decl?.key ?? name);
      return ref instanceof Ref && ref.isRef ? ref.typeOwners() : undefined;
    },
    getForIsset: () => readProp(object, name, scope, 'coalesce'),
    warnUndefined: () => {
      if (object.cls.findMethod('__get')) return;
      // PHP creates the property (deprecating a dynamic one) before it warns about reading it.
      if (!lookup(false)) {
        classesModule.createDynamicProp(object, name);
        object.props.set(name, null);
      }
      warn(`Undefined property: ${object.cls.name}::$${name}`);
    },
    nested(mode = 'write') {
      const decl = lookup(true);
      if (decl && classesModule.canAccessProp(decl, scope))
        classesModule.requireVirtualPropertyHook(object, decl, 'get');
      if (
        ((decl && !classesModule.canAccessProp(decl, scope)) || !issetPropExists(object, name, scope)) &&
        object.cls.findMethod('__get')
      )
        return new RefPlace(propRef(object, name, scope, 'alias', reportedStaticAccess));
      if (decl?.hooks?.get && !object.guards?.has(`hook:${name}`)) {
        return new RefPlace(classesModule.hookedPropertyReference(object, decl, scope, mode, true));
      }
      classesModule.checkIndirectModification(object, name, scope, mode);
      if (mode === 'unset' && !decl && !object.props.has(name)) {
        classesModule.createDynamicProp(object, name);
        object.props.set(name, null);
      }
      return this;
    },
  };
}

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function readPropertyPlace(
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  operation?: PlaceOperation
): Value | undefined {
  if (object.isResource && operation)
    throwError(
      'Error',
      `Attempt to ${operation === 'assignOp' ? 'assign' : operation === 'incdec' ? 'increment/decrement' : 'modify'} property "${name}" on resource`
    );
  const update = operation === 'assignOp' || operation === 'incdec';
  const decl = classesModule.lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic && classesModule.canAccessProp(decl, scope)) {
    classesModule.requireVirtualPropertyHook(object, decl, 'get');
  }
  if (
    !decl?.hooks?.get &&
    !issetPropExists(object, name, scope) &&
    (!decl || classesModule.canAccessProp(decl, scope))
  ) {
    const magic = object.cls.findMethod('__get');
    if (!magic && (!decl?.type || decl.isStatic)) return;
  }
  return readProp(object, name, scope, update ? 'update' : 'quiet');
}

function issetPropExists(object: PhpObject, name: string, scope: PhpClass | undefined): boolean {
  const decl = classesModule.lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic) return object.props.has(decl.key) && !object.unsetProperties?.has(decl.key);
  return object.props.has(name);
}

interface NativeArrayStorage {
  writable(): PhpArray;
  readonly array: PhpArray;
  cursor(): { readonly key: Key | undefined };
}
let nativeArrayStorage: (value: unknown) => value is NativeArrayStorage = (_value): _value is NativeArrayStorage =>
  false;

export function setNativeArrayStorage(check: typeof nativeArrayStorage): void {
  nativeArrayStorage = check;
}

export function nativeIteratorSlot(object: PhpObject): Value | Ref | undefined {
  const storage = object.internal;
  if (
    !nativeArrayStorage(storage) ||
    ['current', 'key', 'next', 'rewind', 'valid'].some((name) => object.cls.findMethod(name)?.fn.kind !== 'native')
  )
    return;
  const key = storage.cursor().key;
  return key === undefined ? undefined : storage.array.map.get(key);
}

function arrayAccessPlace(object: PhpObject, key: Value | undefined): Place {
  if (!isArrayAccess(object)) throwError('Error', `Cannot use object of type ${object.cls.name} as array`);
  return {
    getForIsset: () =>
      toBool(callMethod(object, 'offsetExists', [key ?? null], rt().row))
        ? callMethod(object, 'offsetGet', [key ?? null], rt().row)
        : undefined,
    nested: (mode) => arrayAccessNestedPlace(object, key, mode === 'unset'),
    incrementTarget: () => arrayAccessNestedPlace(object, key),
    get: () => callMethod(object, 'offsetGet', [key ?? null], rt().row),
    set: (value) => {
      callMethod(object, 'offsetSet', [key ?? null, value], rt().row);
      return value;
    },
    ref: () => arrayAccessNestedPlace(object, key).ref(),
    unset: () => {
      const storage = object.internal as { unsetOffset?: (value: Value) => void } | undefined;
      if (storage?.unsetOffset && object.cls.findMethod('offsetunset')?.fn.kind === 'native')
        storage.unsetOffset(key ?? null);
      else callMethod(object, 'offsetUnset', [key ?? null], rt().row);
    },
  };
}

function arrayAccessNestedPlace(object: PhpObject, key: Value | undefined, unsetting = false): Place {
  if (
    key !== undefined &&
    object.internal !== undefined &&
    nativeArrayStorage(object.internal) &&
    object.cls.findMethod('offsetget')?.fn.kind === 'native'
  ) {
    if (unsetting && (key instanceof PhpArray || key instanceof PhpObject)) {
      notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
    }
    const index = toKey(key, unsetting ? 'unset' : 'access', object.cls.name);
    if (unsetting && !object.internal.array.map.has(index)) {
      notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
      return new RefPlace(Ref.temporary(null));
    }
    return new ElementPlace(object.internal.writable(), index);
  }
  if (
    key === undefined &&
    object.internal !== undefined &&
    nativeArrayStorage(object.internal) &&
    object.cls.findMethod('offsetget')?.fn.kind === 'native'
  ) {
    notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
    return new RefPlace(Ref.temporary(null));
  }
  const runtime = rt();
  runtime.lastReturnRef = undefined;
  const value = callMethod(object, 'offsetGet', [key ?? null], rt().row);
  const returned = runtime.lastReturnRef as Ref | undefined;
  runtime.lastReturnRef = undefined;
  if (returned) return new RefPlace(returned);
  if (!(value instanceof PhpObject)) {
    notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
  }
  return new RefPlace(Ref.temporary(value));
}

// code-gauge-allow functionCognitiveComplexity 28 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function stringOffsetPlace(parent: Place, text: string, key: Value | undefined): Place {
  const assign = (value: () => Value): Value => {
    if (key === undefined) throwError('Error', '[] operator not supported for strings');
    const position = stringOffset(text, key) as number;
    const offset = position < 0 ? Number(toInt(key)) : position;
    if (offset < 0) {
      warn(`Illegal string offset ${offset}`);
      return null;
    }
    let character = toStr(value());
    if (character === '') throwError('Error', 'Cannot assign an empty string to a string offset');
    if (character.length > 1) {
      warn('Only the first byte will be assigned to the string offset');
      character = character[0];
    }
    const length = Math.max(text.length, offset + 1);
    rt().ensureStringFits(length);
    rt().spend(Math.ceil(length / 64));
    const updated =
      offset >= text.length
        ? text + ' '.repeat(offset - text.length) + character
        : text.slice(0, offset) + character + text.slice(offset + 1);
    parent.set(updated);
    return character;
  };
  return {
    get: (operation) => {
      if (key === undefined) throwError('Error', '[] operator not supported for strings');
      stringOffset(text, key);
      const message =
        operation === 'assignOp'
          ? 'Cannot use assign-op operators with string offsets'
          : operation === 'incdec'
            ? 'Cannot increment/decrement string offsets'
            : `Cannot use string offset as an ${operation === 'receiver' ? 'object' : 'array'}`;
      throwError('Error', message);
    },
    getForIsset: () => (key === undefined ? undefined : readIndex(text, key, 'coalesce')),
    set: (value) => assign(() => value),
    assign,
    ref: () => {
      throwError('Error', 'Cannot create references to/from string offsets');
    },
    unset: () => {
      throwError('Error', 'Cannot unset string offsets');
    },
  };
}

export function assignExpression(target: Expr, valueExpr: Expr): Value {
  const runtime = rt();
  if (target.k === 'var' && target.name !== 'this') {
    const value = share(ev(valueExpr));
    const frame = runtime.frame;
    const ref = frame.vars.get(target.name);
    if (!ref) {
      frame.vars.set(target.name, new Ref(value));
      return value;
    }
    ref.assign(value);
    return ref.v;
  }
  const place = placeOf(target, 'deferred');
  const value = prepareOperand(valueExpr);
  runtime.row = target.row;
  return assignPlace(place, () => share(value(target.row)));
}

function assignPlace(place: Place, value: () => Value): Value {
  return place.assign ? place.assign(value) : place.set(value());
}

/** Assigns a value to a writable expression, as a foreach binding or list() element does. */
export function assignTo(target: Expr, value: Value): void {
  if (target.k === 'list') {
    destructure(target, value);
    return;
  }
  placeOf(target).set(share(value));
}

// code-gauge-allow functionNcss 52 -- Handles each kind of writable expression, whose write rules PHP defines separately.
export function bindRef(target: Expr, ref: Ref): void {
  if (target.k === 'var' || target.k === 'varvar') {
    const name = target.k === 'var' ? target.name : toStr(ev(target.name));
    new VarPlace(rt().frame, name).bind(ref);
    return;
  }
  if (target.k === 'idx') {
    if (target.base.k === 'var' && target.base.name === 'GLOBALS') {
      globalPlace(target.index).bind(ref);
      return;
    }
    const parent = nestedPlace(placeOf(target.base, 'write', true), 'write');
    const key = target.index === undefined ? undefined : toKey(ev(target.index));
    let container = writableContainer(parent);
    if (
      container instanceof PhpObject &&
      key !== undefined &&
      nativeArrayStorage(container.internal) &&
      container.cls.findMethod('offsetget')?.fn.kind === 'native'
    )
      container = container.internal.writable();
    if (container instanceof PhpObject) {
      arrayAccessPlace(container, key).nested?.();
      throwError('Error', 'Cannot assign by reference to an array dimension of an object');
    }
    if (typeof container === 'string')
      throwError(
        'Error',
        key === undefined ? '[] operator not supported for strings' : 'Cannot create references to/from string offsets'
      );
    if (!(container instanceof PhpArray)) throwError('Error', 'Cannot create references to elements of this value');
    ref.isRef = true;
    if (key !== undefined && container.map.get(key) === ref) return;
    ref.rc++;
    if (key === undefined) {
      if (!container.append(ref)) {
        ref.rc--;
        throwError('Error', 'Cannot add element to the array as the next element is already occupied');
      }
    } else container.setSlot(key, ref);
    return;
  }
  if (target.k === 'prop') {
    const object = propertyReceiver(target.obj, placeOf(target.obj, 'write', true), 'write');
    const name = memberName(target.name);
    if (!(object instanceof PhpObject))
      throwError('Error', `Attempt to modify property "${name}" on ${valueName(object)}`);
    classesModule.bindPropertyReference(object, name, ref, rt().frame.scope);
    return;
  }
  if (target.k === 'sprop') {
    const cls = resolveClassRef(target.cls);
    const name = typeof target.name === 'string' ? target.name : toStr(ev(target.name));
    classesModule.bindStaticPropertyReference(cls, name, rt().frame.scope, ref);
    return;
  }
  throwError('Error', 'Cannot assign reference to this expression');
}

export function assignReference(target: Expr, source: Expr): Value {
  const runtime = rt();
  let ref: Ref;
  if (source.k === 'call' || source.k === 'mcall' || source.k === 'scall') {
    runtime.lastReturnRef = undefined;
    const value = ev(source);
    const returned = runtime.lastReturnRef as Ref | undefined;
    runtime.lastReturnRef = undefined;
    if (returned) ref = returned;
    else {
      notice('Only variables should be assigned by reference');
      ref = Ref.temporary(value);
    }
  } else ref = placeOf(source, 'write', true).ref();
  runtime.row = target.row;
  bindRef(target, ref);
  return ref.v;
}

export function destructureAssignment(target: Extract<Expr, { k: 'list' }>, expression: Expr): Value {
  const runtime = rt();
  if (!hasReferenceItem(target)) return destructure(target, ev(expression));
  if (foreachSubjectWritable(expression)) {
    const source = nestedPlace(placeOf(expression, 'write', true), 'write');
    return destructure(target, source.get('nested') ?? null, source);
  }
  const call = expression.k === 'call' || expression.k === 'mcall' || expression.k === 'scall';
  runtime.lastReturnRef = undefined;
  const value = ev(expression);
  const returned = call ? runtime.lastReturnRef : undefined;
  runtime.lastReturnRef = undefined;
  if (call && !returned) notice('Attempting to set reference to non referenceable value');
  return destructure(target, value, returned ? new RefPlace(returned) : undefined);
}

export function destructure(target: Extract<Expr, { k: 'list' }>, value: Value, source?: Place): Value {
  if (hasReferenceItem(target) && (value instanceof PhpArray || (source && (value === null || value === false)))) {
    const place = source ?? new RefPlace(Ref.temporary(share(value)));
    value = writableContainer(place, value === false ? null : value);
  }
  rt().frame.temporaries.push(value);
  let position = 0n;
  for (const item of target.items) {
    if (item === undefined) {
      position++;
      continue;
    }
    const key = item.key === undefined ? position++ : toKey(ev(item.key));
    destructureItem(item, value, key, source !== undefined);
  }
  return value;
}

function destructureItem(item: ListItem, value: Value, key: Key, writable: boolean): void {
  if (item.byRef) {
    bindRef(item.target, destructuredReference(value, key, writable));
    return;
  }
  let element: Value;
  if (value instanceof PhpArray) {
    element = readElement(value, key, false);
  } else if (value instanceof PhpObject) {
    element = readIndex(value, key);
  } else {
    if (value !== null) warn(`Cannot use ${debugType(value)} as array`);
    element = null;
  }
  if (item.target.k === 'list') {
    const source = value instanceof PhpArray ? new ElementPlace(value, key) : undefined;
    destructure(item.target, element, source);
  } else placeOf(item.target).set(share(element));
}

function destructuredReference(value: Value, key: Key, writable: boolean): Ref {
  if (value instanceof PhpArray) return new ElementPlace(value, key).ref();
  if (value instanceof PhpObject) return arrayAccessPlace(value, key).ref();
  if (typeof value === 'string') throwError('Error', 'Cannot create references to/from string offsets');
  if (writable && value !== null) throwError('Error', 'Cannot use a scalar value as an array');
  if (value !== null) warn(`Cannot use ${debugType(value)} as array`);
  return Ref.temporary(null);
}

export function compoundAssign(e: Extract<Expr, { k: 'assignOp' }>): Value {
  const runtime = rt();
  if (e.op === '??') {
    // PHP evaluates the target's parts once, for both the read and the write.
    const place = placeOf(e.target, 'deferred');
    const current = place.getForIsset ? place.getForIsset() : place.get();
    if (current !== undefined && current !== null) return current;
    const value = ev(e.value);
    return place.set(share(value));
  }
  const place = placeOf(e.target, 'deferred');
  const value = ev(e.value);
  runtime.row = e.row;
  let current = place.get('assignOp');
  if (current === undefined) {
    place.warnUndefined?.();
    current = null;
  }
  let result: Value;
  try {
    result = applyOperator(e.op, current, value);
  } catch (error) {
    if (error instanceof PhpThrow && !(e.op === '.' && typeof current === 'string')) {
      finishFailedCompound(place, error);
    }
    throw error;
  }
  return place.set(share(result), 'assignOp');
}

// code-gauge-allow functionCognitiveComplexity 17 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function finishFailedCompound(place: Place, pending: PhpThrow): void {
  const runtime = rt();
  const sources = place.typeSources?.() ?? [];
  const property = place.declaration?.();
  const declarations =
    sources.length > 0 ? sources.map(({ decl }) => decl) : property?.type && !property.hooks ? [property] : [];
  if (declarations.length === 0) return;
  withPendingException(runtime, pending, () => {
    if (!runtime.strictTypes) {
      for (const zero of [0n, 0]) {
        if (!declarations.every((decl) => decl.type && matches(zero, decl.type, { scope: decl.cls }))) continue;
        place.set(zero, 'assignOp');
        return;
      }
    }
    const first = sources[0]?.decl;
    if (first) {
      throwError(
        'TypeError',
        `Cannot assign null to reference held by property ${first.cls.name}::$${first.name} of type ${describePropertyType(first)}`
      );
    }
  });
}

export function applyOperator(op: string, left: Value, right: Value): Value {
  switch (op) {
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
    case '**': {
      return arithmetic(op, left, right);
    }
    case '.': {
      return concat(left, right);
    }
    case '&':
    case '|':
    case '^':
    case '<<':
    case '>>': {
      return bitwise(op, left, right);
    }
  }
  throw new Error(`Unknown operator ${op}`);
}

// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 38 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function incDec(e: Extract<Expr, { k: 'incdec' }>): Value {
  const runtime = rt();
  const target = placeOf(e.target, 'incdec');
  const place = target.incrementTarget?.() ?? target;
  runtime.row = e.row;
  let old = place.get('incdec');
  if (old === undefined) {
    place.warnUndefined?.();
    old = null;
  }
  let updated: Value;
  if (typeof old === 'bigint') updated = e.inc ? arithmetic('+', old, 1n) : arithmetic('-', old, 1n);
  else if (typeof old === 'number') updated = e.inc ? old + 1 : old - 1;
  else if (old === null) {
    if (e.inc) updated = 1n;
    else {
      warn('Decrement on type null has no effect, this will change in the next major version of PHP');
      updated = null;
    }
  } else if (typeof old === 'boolean') {
    warn(
      `${e.inc ? 'Increment' : 'Decrement'} on type bool has no effect, this will change in the next major version of PHP`
    );
    updated = old;
  } else if (typeof old === 'string') {
    updated = incDecString(old, e.inc);
  } else if (old instanceof PhpArray) {
    throwError('TypeError', `Cannot ${e.inc ? 'increment' : 'decrement'} array`);
  } else {
    throwError('TypeError', `Cannot ${e.inc ? 'increment' : 'decrement'} ${(old as PhpObject).cls.name}`);
  }
  if (typeof old === 'bigint' && typeof updated === 'number') checkIntOverflow(place, e.inc);
  const stored = place.set(updated);
  return e.prefix ? stored : old;
}

/** Throws PHP's TypeError when `++` or `--` takes a property typed int past the range of ints. */
function checkIntOverflow(place: Place, inc: boolean): void {
  const owner = place.typeSources?.()?.find(({ decl }) => decl.type && !acceptsFloat(decl.type));
  const decl = owner?.decl ?? place.declaration?.();
  if (!decl?.type || acceptsFloat(decl.type)) return;
  throwError(
    'TypeError',
    `Cannot ${inc ? 'increment' : 'decrement'} ${owner ? 'a reference held by ' : ''}property ${decl.cls.name}::$${decl.name} of type ${typeToString(decl.type)} past its ${inc ? 'maximal' : 'minimal'} value`
  );
}

function acceptsFloat(type: TypeDecl): boolean {
  if (type.k === 'named') return type.name === 'float' || type.name === 'mixed';
  return type.k === 'union' && type.types.some((part) => acceptsFloat(part));
}

function incDecString(text: string, inc: boolean): Value {
  const { numericValue } = conversionsModule;
  const numeric = numericValue(text);
  if (numeric !== undefined) {
    if (typeof numeric === 'bigint') return inc ? arithmetic('+', numeric, 1n) : arithmetic('-', numeric, 1n);
    return inc ? numeric + 1 : numeric - 1;
  }
  if (!inc) {
    if (text === '') {
      deprecated('Decrement on empty string is deprecated as non-numeric');
      return -1n;
    }
    deprecated('Decrement on non-numeric string has no effect and is deprecated');
    return text;
  }
  deprecated('Increment on non-numeric string is deprecated, use str_increment() instead');
  if (text === '') return '1';
  return incrementString(text);
}

export function unsetTarget(target: Expr): void {
  rt().row = target.row;
  prepareUnset(target)()?.unset();
}

type UnsetBase = 'array' | 'object';

function prepareUnset(e: Expr, nested?: UnsetBase): () => Place | undefined {
  switch (e.k) {
    case 'idx': {
      return prepareUnsetOffset(e, nested);
    }
    case 'prop': {
      return prepareUnsetProperty(e, nested);
    }
    case 'var': {
      const place = placeOf(e);
      return () => place;
    }
    case 'varvar': {
      const name = prepareOperand(e.name);
      return () => new VarPlace(rt().frame, toStr(name()));
    }
    case 'sprop': {
      const cls = resolveClassRef(e.cls);
      const name = e.name;
      const readName = typeof name === 'string' ? () => name : prepareOperand(name);
      return () => new StaticPlace(cls, toStr(readName()), rt().frame.scope);
    }
    default: {
      if (!nested) throwError('Error', 'Cannot unset this expression');
      const place = placeOf(e);
      return () => place;
    }
  }
}

function prepareUnsetOffset(e: Extract<Expr, { k: 'idx' }>, nested?: UnsetBase): () => Place | undefined {
  if (e.index === undefined) throwError('Error', 'Cannot use [] for unsetting');
  if (e.base.k === 'var' && e.base.name === 'GLOBALS') {
    const readKey = prepareOperand(e.index);
    return () => new VarPlace(rt().globalFrame, toStr(readKey()), true);
  }
  const readParent = prepareUnset(e.base, 'array');
  const readKey = prepareOperand(e.index);
  return () => {
    const parent = readParent();
    const value = parent?.get('nested');
    if (value === undefined && e.base.k === 'var') parent?.warnUndefined?.();
    const key = readKey();
    rt().row = e.row;
    const container = value instanceof PhpArray && parent ? writableContainer(parent, value) : value;
    const place = unsetOffsetPlace(container, key, nested);
    return nested && place ? nestedPlace(place, 'unset') : place;
  };
}

function prepareUnsetProperty(e: Extract<Expr, { k: 'prop' }>, nested?: UnsetBase): () => Place | undefined {
  const readParent = prepareUnset(e.obj, 'object');
  const member = e.name;
  const readName = typeof member === 'string' ? () => member : prepareOperand(member);
  return () => {
    const parent = readParent();
    const object = parent?.get('receiver');
    if (nested && object === undefined && e.obj.k === 'var') parent?.warnUndefined?.();
    if (!(object instanceof PhpObject)) return;
    const name = toStr(readName());
    rt().row = e.row;
    const place = propPlace(object, name);
    return nested ? nestedPlace(place, 'unset') : place;
  };
}

function unsetOffsetPlace(container: Value | undefined, key: Value, nested?: UnsetBase): Place | undefined {
  if (container instanceof PhpArray) {
    const offset = !nested && key === null ? '' : toKey(key, nested ? 'access' : 'unset');
    return new ElementPlace(container, offset);
  }
  if (container instanceof PhpObject) return arrayAccessPlace(container, key);
  if (typeof container === 'string') return unsetStringOffset(key, nested);
  if (container === false) deprecated('Automatic conversion of false to array is deprecated');
  else if (container !== undefined && container !== null)
    throwError('Error', 'Cannot unset offset in a non-array variable');
  return undefined;
}

function unsetStringOffset(key: Value, nested?: UnsetBase): never {
  if (nested) {
    if (key === null || typeof key === 'boolean' || typeof key === 'number') {
      warn('String offset cast occurred');
      throwError('Error', `Cannot use string offset as an ${nested}`);
    }
    if (typeof key === 'bigint' || (typeof key === 'string' && typeof numericPrefix(key)?.value === 'bigint')) {
      throwError('Error', `Cannot use string offset as an ${nested}`);
    }
  }
  throwError('Error', 'Cannot unset string offsets');
}

export function issetOffset(base: Value, index: Value): boolean {
  if (base instanceof PhpArray) return (base.get(toKey(index, 'isset')) ?? null) !== null;
  if (typeof base === 'string') {
    const position = stringOffset(base, index, 'isset');
    return position !== undefined && position >= 0;
  }
  return base instanceof PhpObject && !base.isResource && issetArrayAccess(base, index);
}

function issetArrayAccess(object: PhpObject, index: Value): boolean {
  if (!isArrayAccess(object)) throwError('Error', `Cannot use object of type ${object.cls.name} as array`);
  if (nativeArrayStorage(object.internal) && object.cls.findMethod('offsetexists')?.fn.kind === 'native')
    return (object.internal.array.get(toKey(index, 'isset')) ?? null) !== null;
  return toBool(callMethod(object, 'offsetExists', [index], rt().row));
}
