// code-gauge-allow-file fileNcss 999 -- Holds assignment and offset access modes with their shared helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { arrayObjectProperty } from './arrayObjectProperties';
import { withArrayReadView } from './arrayTable';
import type { Expr, ListItem } from './ast';
import { foreachSubjectWritable, hasReferenceItem } from './astAnalysis';
import { callMethod, callOffsetExists, discardInvokedResult, readOffset } from './callables';
import { propRef, readProp, staticPropRef, unsetProp, writeProp } from './classes';
import * as classesModule from './classes';
import * as conversionsModule from './conversions';
import { debugType, numericPrefix, valueName } from './conversions';
import {
  deprecated,
  invalidObjectDimension,
  notice,
  throwError,
  type UpdateWarning,
  warn,
  withOperandWarnings,
  withPendingException,
} from './errors';
import { hasStoredObject } from './garbage';
import {
  ev,
  isArrayAccess,
  isCompiledVariable,
  missingCompiledOperand,
  prepareOperand,
  readIndex,
  readOperandWithWarning,
  resolveClassRef,
  stringOffset,
  stringOffsetIndex,
  withPropertyName,
} from './interp';
import type { ArrayStorage } from './libArrayObject';
import { nativeArrayStorage } from './nativeArrayStorage';
import { compiledOperandRow, dimensionWriteRow, operandAstRow } from './opcodeRows';
import { arithmetic, bitwise, concat, toKey, toStr } from './operators';
import {
  type BeforeOffsetGet,
  type CompoundRead,
  ElementPlace,
  type NestMode,
  type Place,
  type PlaceOperation,
  readCompound,
  readElement,
  RefPlace,
  share,
  SKIP_COMPOUND,
  ValuePlace,
  VarPlace,
  warnPropertySlot,
  watchStringSlot,
  withIncrementCleanup,
  writableContainer,
} from './places';
import { FatalError, PhpThrow, rt } from './runtime';
import { incrementString } from './strings';
import { coerce, describePropertyType, matches, NO_MATCH, typeToString } from './types';
import {
  PhpArray,
  type PhpClass,
  PhpObject,
  type PropDecl,
  Ref,
  type TypeDecl,
  UNDEFINED_RESULT,
  UNINIT,
  type Value,
} from './values';

// Assignment ---------------------------------------------------------------------------------------------------------

type WriteMode = 'write' | 'update' | 'incdec';
type PlaceMode = WriteMode | 'deferred' | 'coalesce';

/** The location a writable expression names, evaluating its keys and creating containers as PHP's writes do. */
// code-gauge-allow functionNcss 52 -- Handles each kind of writable expression, whose write rules PHP defines separately.
// code-gauge-allow functionCognitiveComplexity 30 -- Writable kinds share operand preparation and defer their writes through places.
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
        return new VarPlace(frame, name, 'dynamic', e.row);
      });
    }
    case 'idx': {
      if (e.base.k === 'var' && e.base.name === 'GLOBALS') {
        if (e.index === undefined) throwError('Error', 'Cannot append to $GLOBALS');
        return namedPlace(e.index, mode, (name) => new VarPlace(runtime.globalFrame, name, 'global'));
      }
      return dimensionPlace(e, mode, through);
    }
    case 'prop': {
      return instancePropertyPlace(e, mode, through);
    }
    case 'sprop': {
      return staticPropertyPlace(e, mode);
    }
    case 'call':
    case 'mcall':
    case 'scall':
    case 'pipe':
    case 'clone': {
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
  return mode === 'deferred' || mode === 'coalesce' ? deferredPlace(resolve, () => readForIsset(resolve())) : resolve();
}

function staticPropertyPlace(e: Extract<Expr, { k: 'sprop' }>, mode: PlaceMode): Place {
  const runtime = rt();
  runtime.row = e.row;
  const cls = resolveClassRef(e.cls);
  const scope = runtime.frame.scope;
  const name = e.name;
  const readName = typeof name === 'string' ? () => name : prepareOperand(name);
  const withName = <T>(use: (name: string) => T, diagnose?: (name: string) => unknown): T => {
    const value = readName(e.row);
    runtime.row = e.row;
    return withPropertyName(value, use, diagnose);
  };
  const resolve = (): StaticPlace =>
    withName(
      (name) => new StaticPlace(cls, name, scope),
      (name) => staticPropRef(cls, name, scope)
    );
  if (mode !== 'deferred' && mode !== 'coalesce') return resolve();
  return deferredPlace(resolve, () => withName((name) => classesModule.readStaticProp(cls, name, scope, true)));
}

// code-gauge-allow functionNcss 35 -- Shares operand evaluation and parent writes across assignment modes.
// code-gauge-allow functionCognitiveComplexity 25 -- Shares operand evaluation and parent writes across assignment modes.
function dimensionPlace(e: Extract<Expr, { k: 'idx' }>, mode: PlaceMode, through: boolean): Place {
  const parent = placeOf(e.base, mode, true);
  const readKey = e.index === undefined ? undefined : prepareOperand(e.index);
  const resolve = (writeMode: WriteMode, beforeOffsetGet?: BeforeOffsetGet, warning?: UpdateWarning): Place => {
    const row = dimensionWriteRow(e);
    const lookupRow =
      e.base.k === 'idx' || e.base.k === 'prop' || e.base.k === 'sprop' ? compiledOperandRow(e.base) : undefined;
    const options = { update: writeMode !== 'write', lookupRow, fetchDimension: through || writeMode === 'incdec' };
    let fetch: Place | undefined;
    let container: PhpArray | PhpObject | string | undefined;
    if (mode === 'coalesce') {
      fetch = nestedPlace(parent, writeMode);
      rt().row = row;
      container = writableContainer(fetch, undefined, options);
    }
    const { key, keyWarning } = readDimensionKey(readKey, warning);
    rt().row = row;
    fetch ??= nestedPlace(parent, writeMode);
    rt().row = row;
    container ??= writableContainer(fetch, undefined, options);
    if (container instanceof PhpObject) {
      if (beforeOffsetGet && !isArrayAccess(container)) {
        beforeOffsetGet();
        invalidObjectDimension(container, 'same');
      }
      return arrayAccessPlace(container, key, writeMode === 'write', keyWarning !== undefined, fetch.unbound);
    }
    if (keyWarning) throw keyWarning;
    if (container instanceof PhpArray)
      return new ElementPlace(container, key === undefined ? undefined : toKey(key), fetch.unbound);
    return stringOffsetPlace(fetch, container, key, row);
  };
  if (mode !== 'deferred' && mode !== 'coalesce') return resolve(mode);
  return deferredPlace(resolve, () => {
    const container = readForIsset(parent);
    const key = readKey?.();
    rt().row = e.row;
    return container === undefined || container === null || key === undefined
      ? undefined
      : readIndex(container, key, 'coalesce');
  });
}

function readDimensionKey(
  readKey: (() => Value) | undefined,
  warning: UpdateWarning | undefined
): { key: Value | undefined; keyWarning?: PhpThrow } {
  try {
    return { key: readKey?.() };
  } catch (error) {
    if (!warning || !(error instanceof PhpThrow)) throw error;
    warning(() => {
      throw error;
    });
    return { key: null, keyWarning: error };
  }
}

// code-gauge-allow functionCognitiveComplexity 21 -- Shares receiver resolution across the read and write phases.
// code-gauge-allow functionNcss 36 -- Retains the same receiver and name across deferred property operations.
function instancePropertyPlace(e: Extract<Expr, { k: 'prop' }>, mode: PlaceMode, through: boolean): Place {
  const parent = placeOf(e.obj, mode, true);
  const property = e.name;
  let readName = typeof property === 'string' ? () => property : prepareOperand(property);
  const locate = (name: Value, object: Value, writeMode: WriteMode, unbound?: boolean): Place => {
    rt().row = e.row;
    if (!(object instanceof PhpObject)) {
      const action = through ? 'modify' : writeMode === 'incdec' ? 'increment/decrement' : 'assign';
      const error = (): never =>
        withPropertyName(name, (key) =>
          throwError('Error', `Attempt to ${action} property "${key}" on ${valueName(object)}`)
        );
      if (writeMode === 'write' && !through) return invalidWriteTarget(error);
      return error();
    }
    return propPlace(object, toStr(name), unbound && !hasStoredObject(rt(), object));
  };
  const resolve = (writeMode: WriteMode): Place => {
    const name = readName();
    const receiver = nestedPlace(parent, writeMode);
    return locate(name, propertyReceiver(e.obj, receiver, writeMode), writeMode, receiver.unbound);
  };
  if (mode !== 'deferred' && mode !== 'coalesce') return resolve(mode);
  const place = deferredPlace(resolve, () => {
    const object = readForIsset(parent);
    const key = readName();
    if (!(object instanceof PhpObject)) return;
    const name = toStr(key);
    rt().row = e.row;
    return readProp(object, name, rt().frame.scope, 'coalesce');
  });
  if (typeof property !== 'string' && !through) {
    place.readCompoundName = (warning) => {
      const name = readOperandWithWarning(property, readName, warning, e.row);
      readName = () => name;
    };
    place.assign = (readValue) => {
      const object = propertyReceiver(e.obj, nestedPlace(parent, 'write'), 'write');
      const value = readValue();
      return locate(readName(), object, 'write').set(value);
    };
  }
  return place;
}

function invalidWriteTarget(error: () => never): Place {
  return {
    get: error,
    set: error,
    ref: error,
    unset: error,
    assign: (value) => {
      value();
      return error();
    },
  };
}

function propertyReceiver(e: Expr, target: Place, mode: WriteMode): Value {
  const object = target.get(mode === 'write' ? 'receiver' : 'receiverUpdate');
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
    return new RefPlace(Ref.temporary(null));
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

function deferredPlace(
  resolve: (mode: WriteMode, beforeOffsetGet?: BeforeOffsetGet, warning?: UpdateWarning) => Place,
  read: () => Value | undefined
): Place {
  let target: Place | undefined;
  const writable = (mode: WriteMode = 'write', beforeOffsetGet?: BeforeOffsetGet, warning?: UpdateWarning): Place =>
    (target ??= resolve(mode, beforeOffsetGet, warning));
  return {
    get: (operation) => (operation === 'assignOp' ? writable('update').get(operation) : read()),
    fetchCompound: (warning, beforeOffsetGet) =>
      readCompound(writable('update', beforeOffsetGet, warning), warning, beforeOffsetGet),
    getForIsset: read,
    nested: (mode) => {
      const place = writable(mode === 'update' ? 'update' : 'write');
      return place.nested?.(mode) ?? place;
    },
    warnUndefined: (warning) => target?.warnUndefined?.(warning),
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
  return new VarPlace(rt().globalFrame, toStr(ev(index)), 'global');
}

class StaticPlace implements Place {
  private reportedTraitAccess = false;
  private pendingTraitDiagnostic?: PhpThrow;

  constructor(
    private readonly cls: PhpClass,
    private readonly name: string,
    private readonly scope: PhpClass | undefined
  ) {}

  private get decl(): PropDecl | undefined {
    return this.cls.findStatic(this.name)?.decl;
  }

  private target(warning?: UpdateWarning): Ref {
    const report = warning && ((emit: () => void) => warning(() => this.reportTraitDiagnostic(emit)));
    const target = staticPropRef(this.cls, this.name, this.scope, !this.reportedTraitAccess, report);
    this.reportedTraitAccess = true;
    return target;
  }

  typeSources(): Ref['typedBy'] {
    return this.reference()?.typeOwners();
  }

  reference(): Ref | undefined {
    const target = this.target();
    return target.isRef ? target : undefined;
  }

  declaration(): PropDecl | undefined {
    return this.decl;
  }

  get(update?: PlaceOperation, warning?: UpdateWarning): Value {
    const value = this.target(warning).v;
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
    const target = this.target();
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
    return this.withWriteTarget((target) => this.write(target, value, operation));
  }

  stringStorage(): ReturnType<typeof watchStringSlot> {
    return watchStringSlot(
      this.cls,
      this.name,
      () => this.target(),
      (value) => this.set(value)
    );
  }

  assign(read: () => Value): Value {
    return this.withWriteTarget((target) => this.write(target, read()));
  }

  private withWriteTarget(write: (target: Ref) => Value): Value {
    if (this.cls.kind === 'trait' && !this.reportedTraitAccess)
      return withOperandWarnings((warning) => write(this.target(warning)));
    return write(this.target());
  }

  private write(target: Ref, value: Value, operation?: 'assignOp'): Value {
    return rt().withPropertyDiagnostic(
      this.pendingTraitDiagnostic,
      () => {
        const decl = this.decl;
        const assigned =
          decl?.type && !(operation === 'assignOp' && target.isRef) ? classesModule.coerceProperty(decl, value) : value;
        return target.assign(assigned);
      },
      operation === 'assignOp' && target.isRef ? 'reference-update' : 'write'
    );
  }

  private reportTraitDiagnostic(emit: () => void): void {
    try {
      emit();
    } catch (error) {
      if (error instanceof PhpThrow) this.pendingTraitDiagnostic = error;
      throw error;
    }
  }

  unset(): void {
    throwError('Error', `Attempt to unset static property ${this.cls.name}::$${this.name}`);
  }
}

// code-gauge-allow functionNcss 38 -- Keeps the property lookup shared across all place operations.
// code-gauge-allow functionCognitiveComplexity 16 -- Shares the receiver and property lookup across ordinary access modes.
function propPlace(object: PhpObject, name: string, unbound = false): Place {
  const scope = rt().frame.scope;
  const storage = arrayObjectProperty(object, name, scope, undefined, unbound);
  if (storage) return storage;
  let reportedStaticAccess = false;
  const lookup = (report: boolean): PropDecl | undefined => {
    const property = classesModule.lookupProp(object.cls, name, scope);
    if (!property?.isStatic) return property;
    if (report && classesModule.checkStaticInstanceAccess(object, name, scope, property, 'get', !reportedStaticAccess))
      reportedStaticAccess = true;
    return undefined;
  };
  const reference = (): Ref | undefined => {
    const slot = object.props.get(lookup(false)?.key ?? name);
    return slot instanceof Ref && slot.isRef ? slot : undefined;
  };
  return {
    unbound,
    get: (operation) => {
      if (operation) lookup(true);
      return readPropertyPlace(object, name, scope, operation);
    },
    fetchCompound(warning) {
      return fetchCompoundProperty(this, object, name, scope, lookup(true), warning);
    },
    set: (value, operation) => writeProp(object, name, value, scope, { fetched: reportedStaticAccess, operation }),
    stringStorage() {
      const key = lookup(false)?.key ?? name;
      return watchStringSlot(
        object.props,
        key,
        () => object.props.get(key),
        (value) => this.set(value)
      );
    },
    ref: () => propRef(object, name, scope),
    unset: () => unsetProp(object, name, scope),
    declaration: () => lookup(false),
    reference,
    typeSources: () => reference()?.typeOwners(),
    getForIsset: () => readProp(object, name, scope, 'coalesce'),
    warnUndefined: (
      warning = (emit) => {
        emit();
        return true;
      }
    ) => {
      if (object.cls.findMethod('__get')) return;
      const decl = lookup(false);
      if (decl) object.props.set(decl.key, null);
      else classesModule.createDynamicProp(object, name, null, (message) => warning(() => deprecated(message)));
      return warnPropertySlot(
        object,
        decl?.key ?? name,
        decl !== undefined,
        warning,
        `Undefined property: ${object.cls.name}::$${name}`
      );
    },
    nested(mode = 'write') {
      return nestedPropertyPlace(object, name, scope, mode, lookup(true), reportedStaticAccess) ?? this;
    },
  };
}

function fetchCompoundProperty(
  place: Place,
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  decl: PropDecl | undefined,
  warning: UpdateWarning
): CompoundRead | typeof SKIP_COMPOUND {
  const ordinary =
    decl &&
    !decl.isReadonly &&
    !decl.hooks &&
    classesModule.canAccessProp(decl, scope) &&
    classesModule.canWriteProp(decl, scope) &&
    !object.unsetProperties?.has(decl.key);
  let value = readPropertyPlace(object, name, scope, 'assignOp');
  if (value === undefined) {
    if (place.warnUndefined?.(warning) === false) return SKIP_COMPOUND;
    value = readPropertyPlace(object, name, scope, 'assignOp');
  }
  return {
    value: value ?? null,
    declaration: ordinary ? decl : undefined,
    sources: ordinary ? place.typeSources?.() : undefined,
  };
}

function nestedPropertyPlace(
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  mode: NestMode,
  decl: PropDecl | undefined,
  reportedStaticAccess: boolean
): Place | undefined {
  const accessible = decl && classesModule.canAccessProp(decl, scope);
  if (accessible) classesModule.requireVirtualPropertyHook(object, decl, 'get');
  if (((decl && !accessible) || !issetPropExists(object, name, scope)) && object.cls.findMethod('__get'))
    return new RefPlace(propRef(object, name, scope, 'alias', reportedStaticAccess));
  if (decl?.hooks?.get && !object.guards?.has(`hook:${name}`))
    return new RefPlace(classesModule.hookedPropertyReference(object, decl, scope));
  const indirect = classesModule.checkIndirectModification(object, name, scope, mode);
  if (indirect) return new RefPlace(Ref.temporary(indirect));
  const key = decl?.key ?? name;
  if (mode !== 'update' && !decl && !object.props.has(key)) classesModule.createDynamicProp(object, name);
  else if (mode === 'unset' && decl && !decl.type && (!object.props.has(key) || object.unsetProperties?.has(key)))
    object.props.set(key, null);
  return undefined;
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
  const update =
    operation === 'assignOp' ||
    operation === 'incdec' ||
    operation === 'nestedUpdate' ||
    operation === 'receiverUpdate';
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

function arrayAccessPlace(
  object: PhpObject,
  key: Value | undefined,
  readAssignmentValue = false,
  hasKeyWarning = false,
  unboundReceiver = false
): Place {
  if (!isArrayAccess(object)) {
    const error = (): never => invalidObjectDimension(object);
    return readAssignmentValue ? invalidWriteTarget(error) : error();
  }
  let refPlace: Place | undefined;
  const nested = (mode?: NestMode): Place => arrayAccessNestedPlace(object, key, mode, unboundReceiver);
  return {
    get unbound() {
      return refPlace?.unbound;
    },
    getForIsset: () => (callOffsetExists(object, key ?? null) ? readOffset(object, key) : undefined),
    nested,
    incrementTarget: () => nested('update'),
    get: () => readOffset(object, key),
    fetchCompound: (warning, beforeOffsetGet) =>
      fetchCompoundDimension(object, key, warning, beforeOffsetGet?.(), hasKeyWarning),
    set: (value) => {
      if (!rt().pendingAssignmentWarning || writesOffsetWithException(object, key)) writeOffset(object, key, value);
      return value;
    },
    ref: () => (refPlace ??= nested()).ref(),
    unset: () => {
      const storage = object.internal as { unsetOffset?: (value: Value) => void } | undefined;
      if (storage?.unsetOffset && object.cls.findMethod('offsetunset')?.fn.kind === 'native')
        storage.unsetOffset(key ?? null);
      else discardInvokedResult(() => callMethod(object, 'offsetUnset', [key ?? null], rt().row));
    },
  };
}

function writeOffset(object: PhpObject, key: Value | undefined, value: Value): void {
  const setter = object.cls.findMethod('offsetset');
  if (key === undefined && setter?.fn.kind === 'native' && setter.scope.lname === 'splfixedarray')
    throwError('Error', '[] operator not supported for SplFixedArray');
  const inline = object.cls.lname === 'splobjectstorage' && key instanceof PhpObject && !key.isResource;
  discardInvokedResult(() => callMethod(object, 'offsetSet', [key ?? null, value], rt().row, { inline }));
}

function writesOffsetWithException(object: PhpObject, key: Value | undefined): boolean {
  const setter = object.cls.findMethod('offsetset');
  if (setter?.fn.kind !== 'native') return false;
  return (
    nativeArrayStorage(object.internal) ||
    setter.scope.lname === 'splfixedarray' ||
    (setter.scope.lname === 'splobjectstorage' && key instanceof PhpObject && !key.isResource)
  );
}

// code-gauge-allow functionCognitiveComplexity 20 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function fetchCompoundDimension(
  object: PhpObject,
  key: Value | undefined,
  warning: UpdateWarning,
  pending: PhpThrow | undefined,
  hasKeyWarning: boolean
): CompoundRead {
  const storage = object.internal;
  const nativeArray = nativeArrayStorage(storage);
  const getter = object.cls.findMethod('offsetget');
  const fixedClass = classesModule.findClass('SplFixedArray');
  const fixed = fixedClass && object.cls.isSubclassOf(fixedClass);
  if (!nativeArray && !(fixed && getter?.fn.kind !== 'native'))
    return { value: fetchObjectDimension(object, key, pending, hasKeyWarning) };
  let value: Value = null;
  if (nativeArray && getter?.fn.kind === 'native') {
    if (key !== undefined) {
      try {
        value = storage.offsetValue(key, object.cls.name, warning, pending !== undefined);
      } catch (error) {
        if (!(error instanceof PhpThrow)) throw error;
        warning(() => {
          throw error;
        });
      }
    }
  } else {
    warning(() => {
      value = readOffset(object, key);
    });
  }
  return {
    value,
    write: (result) => {
      if (!writesOffsetWithException(object, key)) warning(() => writeOffset(object, key, result));
      else if (nativeArray) storage.setOffset(key ?? null, result, object.cls.name, warning);
      else writeOffset(object, key, result);
      return result;
    },
  };
}

function fetchObjectDimension(
  object: PhpObject,
  key: Value | undefined,
  pending: PhpThrow | undefined,
  hasKeyWarning: boolean
): Value {
  const getter = object.cls.findMethod('offsetget');
  const fixedRead = hasKeyWarning && getter?.scope.lname === 'splfixedarray';
  if (pending && !fixedRead) {
    if (hasKeyWarning || getter?.fn.kind !== 'native') invalidObjectDimension(object);
    throw pending;
  }
  try {
    return readOffset(object, key);
  } catch (error) {
    if (error instanceof PhpThrow) invalidObjectDimension(object, error);
    throw error;
  }
}

function arrayAccessNestedPlace(
  object: PhpObject,
  key: Value | undefined,
  mode: NestMode = 'write',
  unboundReceiver = false
): Place {
  const storage = object.internal;
  if (nativeArrayStorage(storage) && object.cls.findMethod('offsetget')?.fn.kind === 'native') {
    if (key === undefined) {
      notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
      return new RefPlace(Ref.temporary(null));
    }
    return nativeArrayNestedPlace(object, storage, key, mode, unboundReceiver && !hasStoredObject(rt(), object));
  }
  const runtime = rt();
  runtime.lastReturnRef = undefined;
  const value = readOffset(object, key);
  const returned = runtime.lastReturnRef as Ref | undefined;
  runtime.lastReturnRef = undefined;
  if (returned) return new RefPlace(returned);
  if (!(value instanceof PhpObject))
    notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
  return new RefPlace(Ref.temporary(value));
}

// code-gauge-allow functionCognitiveComplexity 20 -- Shares mode, key conversion and storage lifetime across nested offset access.
function nativeArrayNestedPlace(
  object: PhpObject,
  storage: ArrayStorage,
  key: Value,
  mode: NestMode,
  unbound: boolean
): Place {
  if (mode === 'unset') {
    if (key instanceof PhpArray || key instanceof PhpObject)
      notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
    const index = toKey(key, 'unset', object.cls.name);
    if (storage.array.map.has(index)) return new ElementPlace(storage.writable(), index);
    notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
    return new RefPlace(Ref.temporary(null));
  }
  let place!: Place;
  const array = storage.writable();
  withArrayReadView(array, (view) =>
    withOperandWarnings((warning) => {
      const index = toKey(key, 'access', object.cls.name, warning);
      if (view.detached()) {
        place = detachedArrayOffset(view.get(index));
        return null;
      }
      const element = new ElementPlace(array, index, unbound, true);
      place = element;
      if (element.get() === undefined) {
        if (mode === 'update') warning(() => element.warnUndefined());
        element.resetNull();
      }
      return null;
    })
  );
  return place;
}

function detachedArrayOffset(slot: Value | Ref | undefined): RefPlace {
  if (slot instanceof Ref && slot.rc > 0) return new RefPlace(slot);
  const value = slot instanceof Ref ? slot.v : slot;
  const live = value instanceof PhpObject && rt().objects.get(value.id) !== value ? null : value;
  return new RefPlace(Ref.temporary(live ?? null));
}

function stringOffsetPlace(parent: Place, text: string, key: Value | undefined, row: number): Place {
  const assign = (value: () => Value): Value => assignStringOffset(parent, text, key, value);
  return {
    get: (operation) => {
      rt().row = row;
      if (key === undefined) throwError('Error', '[] operator not supported for strings');
      stringOffset(text, key);
      const message =
        operation === 'assignOp'
          ? 'Cannot use assign-op operators with string offsets'
          : operation === 'incdec'
            ? 'Cannot increment/decrement string offsets'
            : `Cannot use string offset as an ${operation === 'receiver' || operation === 'receiverUpdate' ? 'object' : 'array'}`;
      throwError('Error', message);
    },
    getForIsset: () => (key === undefined ? undefined : readIndex(text, key, 'coalesce')),
    set: (value) => assign(() => value),
    assign,
    ref: () => {
      rt().row = row;
      return rejectStringReference(key);
    },
    unset: () => {
      throwError('Error', 'Cannot unset string offsets');
    },
  };
}

function assignStringOffset(parent: Place, text: string, key: Value | undefined, value: () => Value): Value {
  if (key === undefined) throwError('Error', '[] operator not supported for strings');
  const storage = parent.stringStorage?.();
  try {
    const index = stringOffsetIndex(key)!;
    if (storage?.current() === false) return null;
    const position = index < 0n ? BigInt(text.length) + index : index;
    if (position < 0n) {
      warn(`Illegal string offset ${index}`);
      return null;
    }
    const character = toStr(value());
    if (storage?.current() === false) return null;
    if (character === '') throwError('Error', 'Cannot assign an empty string to a string offset');
    if (character.length > 1) {
      warn('Only the first byte will be assigned to the string offset');
      if (storage?.current() === false) return null;
    }
    const updated = replaceStringByte(text, Number(position), character[0]);
    if (storage) storage.write(updated);
    else parent.set(updated);
    return character[0];
  } finally {
    storage?.close();
  }
}

function replaceStringByte(text: string, offset: number, character: string): string {
  const length = Math.max(text.length, offset + 1);
  rt().ensureStringFits(length);
  rt().spend(Math.ceil(length / 64));
  return offset >= text.length
    ? text + ' '.repeat(offset - text.length) + character
    : text.slice(0, offset) + character + text.slice(offset + 1);
}

function rejectStringReference(key: Value | undefined): never {
  if (key === undefined) throwError('Error', '[] operator not supported for strings');
  stringOffsetIndex(key);
  throwError('Error', 'Cannot create references to/from string offsets');
}

export function assignExpression(target: Expr, valueExpr: Expr): Value {
  const runtime = rt();
  if (target.k === 'var' && target.name !== 'this') {
    if (missingCompiledOperand(valueExpr))
      return assignWithOperandWarning(
        new VarPlace(runtime.frame, target.name),
        valueExpr,
        prepareOperand(valueExpr),
        target.row
      );
    const value = share(ev(valueExpr));
    const frame = runtime.frame;
    const ref = frame.vars.get(target.name);
    if (!ref) {
      frame.vars.set(target.name, new Ref(value));
      return value;
    }
    return ref.assign(value);
  }
  const place = placeOf(target, 'deferred');
  const read = prepareOperand(valueExpr);
  const row = assignmentWriteRow(target, 'plain');
  if (isCompiledVariable(valueExpr) && !dimensionWritesOwnVariable(target, valueExpr)) {
    runtime.row = row;
    return assignWithOperandWarning(place, valueExpr, read, row);
  }
  const value = share(read());
  runtime.row = row;
  return assignPlace(place, () => value);
}

function dimensionWritesOwnVariable(target: Expr, value: Expr): boolean {
  if (target.k !== 'idx' || value.k !== 'var') return false;
  let root: Expr = target;
  while (root.k === 'idx' || root.k === 'prop') root = root.k === 'idx' ? root.base : root.obj;
  return root.k === 'var' && root.name === value.name;
}

function assignWithOperandWarning(place: Place, expression: Expr, read: (row?: number) => Value, row: number): Value {
  const runtime = rt();
  const previous = runtime.assignmentWarning;
  return withOperandWarnings((warning, pending) => {
    try {
      return assignPlace(place, () => {
        const value = readOperandWithWarning(expression, read, warning, row);
        const exception = pending();
        if (exception) runtime.assignmentWarning = { frame: runtime.frame, exception };
        return share(value);
      });
    } finally {
      runtime.assignmentWarning = previous;
    }
  });
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

export function bindRef(target: Expr, ref: Ref, valueFallback = false): void {
  if (target.k === 'var' || target.k === 'varvar') {
    const name = target.k === 'var' ? target.name : toStr(ev(target.name));
    new VarPlace(rt().frame, name, target.k === 'varvar' ? 'dynamic' : 'compiled').bind(ref);
    return;
  }
  if (target.k === 'idx') return bindDimensionRef(target, ref);
  if (target.k === 'prop') {
    const receiver = nestedPlace(placeOf(target.obj, 'write', true), 'write');
    const object = propertyReceiver(target.obj, receiver, 'write');
    const name = typeof target.name === 'string' ? target.name : ev(target.name);
    if (!(object instanceof PhpObject))
      return withPropertyName(name, (key) =>
        throwError('Error', `Attempt to modify property "${key}" on ${valueName(object)}`)
      );
    classesModule.bindPropertyReference(object, toStr(name), ref, rt().frame.scope, valueFallback);
    return;
  }
  if (target.k === 'sprop') {
    const cls = resolveClassRef(target.cls);
    const name = typeof target.name === 'string' ? target.name : prepareOperand(target.name)(target.row);
    const runtime = rt();
    runtime.row = target.row;
    withPropertyName(name, (key) =>
      classesModule.bindStaticPropertyReference(cls, key, runtime.frame.scope, ref, valueFallback)
    );
    return;
  }
  throwError('Error', 'Cannot assign reference to this expression');
}

function bindDimensionRef(target: Extract<Expr, { k: 'idx' }>, ref: Ref): void {
  if (target.base.k === 'var' && target.base.name === 'GLOBALS') return globalPlace(target.index).bind(ref);
  const parent = nestedPlace(placeOf(target.base, 'write', true), 'write');
  const rawKey = target.index === undefined ? undefined : ev(target.index);
  let container = writableContainer(parent);
  if (typeof container === 'string') return rejectStringReference(rawKey);
  const key = rawKey === undefined ? undefined : toKey(rawKey);
  if (
    container instanceof PhpObject &&
    key !== undefined &&
    nativeArrayStorage(container.internal) &&
    container.cls.findMethod('offsetget')?.fn.kind === 'native'
  )
    container = container.internal.writable();
  if (container instanceof PhpObject) {
    arrayAccessPlace(container, key).nested?.('unset');
    throwError('Error', 'Cannot assign by reference to an array dimension of an object');
  }
  ref.isRef = true;
  if (key !== undefined && container.map.get(key) === ref) return;
  ref.rc++;
  if (key !== undefined) container.setSlot(key, ref);
  else if (!container.append(ref)) {
    ref.rc--;
    throwError('Error', 'Cannot add element to the array as the next element is already occupied');
  }
}

export function assignReference(target: Expr, source: Expr): Value {
  const runtime = rt();
  let ref: Ref;
  let valueFallback = false;
  if (source.k === 'call' || source.k === 'mcall' || source.k === 'scall') {
    runtime.lastReturnRef = undefined;
    const value = ev(source);
    const returned = runtime.lastReturnRef as Ref | undefined;
    runtime.lastReturnRef = undefined;
    if (returned) ref = returned;
    else {
      if (target.k !== 'prop' && target.k !== 'sprop') {
        notice('Only variables should be assigned by reference');
        runtime.row = target.row;
        return placeOf(target).set(share(value));
      }
      ref = Ref.temporary(value);
      valueFallback = true;
    }
  } else ref = placeOf(source, 'write', true).ref();
  runtime.row = target.row;
  bindRef(target, ref, valueFallback);
  return ref.v;
}

export function destructureAssignment(target: Extract<Expr, { k: 'list' }>, expression: Expr): Value {
  const runtime = rt();
  const byRef = hasReferenceItem(target);
  const row = !byRef && isCompiledVariable(expression) ? listOperandRow(target) : compiledOperandRow(expression);
  if (!byRef) return destructure(target, prepareOperand(expression)(row), undefined, row);
  if (foreachSubjectWritable(expression)) {
    const place = placeOf(expression, 'write', true);
    const slot = place.ref();
    const temporary = slot.rc === 0 || (slot.rc === 1 && place.unbound);
    return destructure(target, slot.v, temporary ? 'temporary' : new RefPlace(slot), row);
  }
  const call = ['call', 'mcall', 'scall', 'pipe', 'clone'].includes(expression.k);
  runtime.lastReturnRef = undefined;
  const value = ev(expression);
  if (expression.k === 'clone') throw new FatalError('Invalid opcode 140/2/0.', row);
  const returned = call ? runtime.lastReturnRef : undefined;
  runtime.lastReturnRef = undefined;
  return destructure(target, value, returned ? new RefPlace(returned) : call ? 'temporary' : undefined, row);
}

// code-gauge-allow functionCognitiveComplexity 29 -- Keeps the list's fetch line and lazy writable source in assignment order.
// code-gauge-allow functionNcss 31 -- Keeps reference ownership and ordered target writes together.
export function destructure(
  target: Extract<Expr, { k: 'list' }>,
  value: Value,
  source?: RefPlace | 'temporary',
  fetchRow = target.row
): Value {
  const runtime = rt();
  const writableSource =
    source === 'temporary'
      ? undefined
      : (source ??
        (value instanceof PhpArray && hasReferenceItem(target)
          ? new RefPlace(Ref.temporary(share(value)))
          : undefined));
  if (writableSource) {
    writableSource.target.isRef = true;
    runtime.holdTemporaryReference(writableSource.target);
  } else runtime.frame.temporaries.push(value);
  let position = 0n;
  for (const item of target.items) {
    if (item === undefined) {
      position++;
      continue;
    }
    const key = item.key === undefined ? position++ : ev(item.key);
    runtime.row = item.key ? compiledOperandRow(item.key) : fetchRow;
    const itemRow = runtime.row;
    const byRef = item.byRef || (item.target.k === 'list' && hasReferenceItem(item.target));
    if (writableSource) value = writableSource.get();
    if (byRef && writableSource && (value instanceof PhpArray || value === null || value === false))
      value = writableContainer(writableSource, value === false ? null : value);
    destructureItem(item, value, key, source, byRef);
    if (item.target.k === 'list') fetchRow = runtime.row;
    else if (item.byRef) fetchRow = itemRow;
    else fetchRow = item.target.row;
    runtime.row = fetchRow;
  }
  return writableSource ? writableSource.get() : value;
}

function listOperandRow(target: Expr): number {
  while (target.k === 'list') {
    const item = target.items[0];
    if (!item) return target.row;
    target = item.target;
  }
  return target.row;
}

function destructureItem(
  item: ListItem,
  value: Value,
  key: Value,
  source: RefPlace | 'temporary' | undefined,
  byRef: boolean
): void {
  if (byRef) {
    const slot = listElementReference(value, key, source);
    if (item.target.k === 'list')
      destructure(item.target, slot.v, source === 'temporary' ? source : new RefPlace(slot), rt().row);
    else bindRef(item.target, slot);
    return;
  }
  const element = readListElement(value, key);
  if (item.target.k === 'list') destructure(item.target, element, undefined, rt().row);
  else placeOf(item.target).set(share(element));
}

function readListElement(value: Value, key: Value): Value {
  if (value instanceof PhpArray) return readElement(value, toKey(key), false);
  if (value instanceof PhpObject) return readIndex(value, key);
  if (value !== null) warn(`Cannot use ${debugType(value)} as array`);
  return null;
}

function listElementReference(value: Value, key: Value, source: RefPlace | 'temporary' | undefined): Ref {
  if (source === 'temporary') {
    notice('Attempting to set reference to non referenceable value');
    return Ref.temporary(readListElement(value, key));
  }
  if (value instanceof PhpArray) return new ElementPlace(value, toKey(key)).ref();
  if (value instanceof PhpObject) return arrayAccessPlace(value, key).ref();
  if (typeof value === 'string') return rejectStringReference(key);
  if (source && value !== null) throwError('Error', 'Cannot use a scalar value as an array');
  if (value !== null) warn(`Cannot use ${debugType(value)} as array`);
  return Ref.temporary(null);
}

// code-gauge-allow functionNcss 31 -- Keeps the read and write phases of compound assignment together.
// code-gauge-allow functionCognitiveComplexity 21 -- Keeps the read and write phases of compound assignment together.
export function compoundAssign(e: Extract<Expr, { k: 'assignOp' }>): Value {
  const runtime = rt();
  if (e.op === '??') {
    const place = placeOf(e.target, 'coalesce');
    const current = place.getForIsset ? place.getForIsset() : place.get();
    if (current !== undefined && current !== null && current !== UNDEFINED_RESULT) return current;
    const read = prepareOperand(e.value);
    const row = assignmentWriteRow(e.target, 'coalesce');
    if (dimensionWritesOwnVariable(e.target, e.value)) return place.set(share(read(row)));
    return assignPlace(place, () => share(read(row)));
  }
  const place = placeOf(e.target, 'deferred');
  const read = prepareOperand(e.value);
  const row = compoundWriteRow(e.target, e.value);
  return withOperandWarnings((warning, warningPending) => {
    place.readCompoundName?.(warning);
    let readAfterFetch =
      (e.target.k === 'idx' || e.target.k === 'varvar' || e.target.k === 'sprop') &&
      isCompiledVariable(e.value) &&
      !dimensionWritesOwnVariable(e.target, e.value);
    let value = readAfterFetch ? null : share(readUpdateValue(e, read, warning, row));
    runtime.row = row;
    const fetched = readCompound(place, warning, () => {
      if (readAfterFetch && missingCompiledOperand(e.value)) {
        value = readOperandWithWarning(e.value, read, warning, row);
        readAfterFetch = false;
      }
      return warningPending();
    });
    if (fetched === SKIP_COMPOUND) return null;
    if (readAfterFetch) value = readOperandWithWarning(e.value, read, warning, row);
    runtime.row = row;
    return storeCompoundResult(e.op, place, fetched, value, warningPending());
  });
}

function assignmentWriteRow(target: Expr, kind: 'coalesce' | 'plain'): number {
  if (target.k === 'varvar') return operandAstRow(target.name);
  const name =
    target.k === 'idx'
      ? (target.index ?? target.base)
      : target.k === 'prop' || target.k === 'sprop'
        ? target.name
        : undefined;
  if (name && typeof name !== 'string') return kind === 'coalesce' ? operandAstRow(name) : compiledOperandRow(name);
  return target.row;
}

function compoundWriteRow(target: Expr, value: Expr): number {
  if (target.k === 'idx') return dimensionWriteRow(target);
  if (target.k === 'prop' || target.k === 'sprop') return compiledOperandRow(target);
  return compiledOperandRow(value);
}

function readUpdateValue(
  e: Extract<Expr, { k: 'assignOp' }>,
  read: (row?: number) => Value,
  warning: UpdateWarning,
  row: number
): Value {
  if (e.target.k !== 'var' && e.target.k !== 'prop') return read(row);
  return readOperandWithWarning(e.value, read, warning, row);
}

function storeCompoundResult(
  op: string,
  place: Place,
  fetched: CompoundRead,
  value: Value,
  pending: PhpThrow | undefined
): Value {
  const current = fetched.value;
  let result: Value;
  try {
    result = applyOperator(op, current, value, pending);
  } catch (error) {
    if (pending && error === pending) return current;
    if (error instanceof PhpThrow && !(op === '.' && typeof current === 'string')) {
      finishFailedCompound(place, fetched, error);
    }
    throw error;
  }
  const stored = share(result);
  return fetched.write ? fetched.write(stored) : place.set(stored, 'assignOp');
}

// code-gauge-allow functionCognitiveComplexity 17 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function finishFailedCompound(place: Place, fetched: CompoundRead, pending: PhpThrow): void {
  const runtime = rt();
  const sources = fetched.sources ?? [];
  const property = fetched.declaration;
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

export function applyOperator(op: string, left: Value, right: Value, pending?: PhpThrow): Value {
  switch (op) {
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
    case '**': {
      return arithmetic(op, left, right, pending);
    }
    case '.': {
      return concat(left, right, pending);
    }
    case '&':
    case '|':
    case '^':
    case '<<':
    case '>>': {
      return bitwise(op, left, right, pending);
    }
  }
  throw new Error(`Unknown operator ${op}`);
}

export function incDec(e: Extract<Expr, { k: 'incdec' }>): Value {
  return withOperandWarnings((warning) => incrementPlace(e, warning));
}

function incrementPlace(e: Extract<Expr, { k: 'incdec' }>, warning: UpdateWarning): Value {
  const target = placeOf(e.target, 'incdec');
  const place = target.incrementTarget?.() ?? target;
  rt().row = compiledOperandRow(e.target);
  let old = place.get('incdec', warning);
  let writeDetached = false;
  if (old === undefined) {
    if (place instanceof VarPlace && e.target.k !== 'idx') place.fetchCompound(warning);
    else if (place instanceof ElementPlace) writeDetached = !place.warnMissingUpdate(warning);
    else {
      writeDetached = place.warnUndefined?.(warning) === false;
      if (e.target.k === 'prop' && !writeDetached) old = place.get('incdec', warning);
    }
    old ??= null;
  }
  const updated = withIncrementCleanup(place, old, () => incrementedValue(old, e.inc, warning));
  if (updated === undefined) return old;
  if (typeof old === 'bigint' && typeof updated === 'number') checkIntOverflow(place, e.inc);
  const stored = writeDetached ? updated : place.set(updated);
  return e.prefix ? stored : old;
}

// code-gauge-allow functionCognitiveComplexity 23 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function incrementedValue(old: Value, increment: boolean, warning: UpdateWarning): Value | undefined {
  let updated: Value;
  if (typeof old === 'bigint') updated = increment ? arithmetic('+', old, 1n) : arithmetic('-', old, 1n);
  else if (typeof old === 'number') updated = increment ? old + 1 : old - 1;
  else if (old === null) {
    if (increment) updated = 1n;
    else {
      if (
        !warning(() => warn('Decrement on type null has no effect, this will change in the next major version of PHP'))
      )
        return undefined;
      updated = null;
    }
  } else if (typeof old === 'boolean') {
    warn(
      `${increment ? 'Increment' : 'Decrement'} on type bool has no effect, this will change in the next major version of PHP`
    );
    updated = old;
  } else if (typeof old === 'string') {
    updated = incDecString(old, increment);
  } else if (old instanceof PhpArray) {
    throwError('TypeError', `Cannot ${increment ? 'increment' : 'decrement'} array`);
  } else {
    throwError('TypeError', `Cannot ${increment ? 'increment' : 'decrement'} ${(old as PhpObject).cls.name}`);
  }
  return updated;
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
      return () => new VarPlace(rt().frame, toStr(name()), 'dynamic');
    }
    case 'sprop': {
      if (nested) {
        const place = staticPropertyPlace(e, 'deferred');
        return () => nestedPlace(place, 'unset');
      }
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

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps ordinary, global and nested unset access on the same operand path.
function prepareUnsetOffset(e: Extract<Expr, { k: 'idx' }>, nested?: UnsetBase): () => Place | undefined {
  if (e.index === undefined) throwError('Error', 'Cannot use [] for unsetting');
  if (e.base.k === 'var' && e.base.name === 'GLOBALS') {
    const readKey = prepareOperand(e.index);
    return () => {
      const name = toStr(readKey());
      if (nested && name === 'this') throwError('Error', 'Cannot unset $this');
      return new VarPlace(rt().globalFrame, name, 'global');
    };
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
  if (base instanceof PhpArray) return base.isSet(toKey(index, 'isset'));
  if (typeof base === 'string') {
    const position = stringOffset(base, index, 'isset');
    return position !== undefined && position >= 0;
  }
  return base instanceof PhpObject && !base.isResource && issetArrayAccess(base, index);
}

function issetArrayAccess(object: PhpObject, index: Value): boolean {
  if (!isArrayAccess(object)) throwError('Error', `Cannot use object of type ${object.cls.name} as array`);
  if (nativeArrayStorage(object.internal) && object.cls.findMethod('offsetexists')?.fn.kind === 'native')
    return object.internal.array.isSet(toKey(index, 'isset'));
  return callOffsetExists(object, index);
}
