// code-gauge-allow-file fileNcss 577 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { Expr, ListItem } from './ast';
import { callMethod } from './callables';
import { issetProp, propRef, readProp, staticPropRef, unsetProp, writeProp } from './classes';
import * as classesModule from './classes';
import * as conversionsModule from './conversions';
import { debugType, toBool, valueName } from './conversions';
import { deprecated, notice, throwError, warn } from './errors';
import { ev, evQuiet, isArrayAccess, memberName, readIndex, resolveClassRef, stringOffset } from './interp';
import { arithmetic, bitwise, concat, toInt, toKey, toStr } from './operators';
import {
  ElementPlace,
  type Place,
  readElement,
  RefPlace,
  share,
  ValuePlace,
  VarPlace,
  writableContainer,
} from './places';
import { rt } from './runtime';
import { incrementString } from './strings';
import { coerce, NO_MATCH, typeToString } from './types';
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

/** The location a writable expression names, evaluating its keys and creating containers as PHP's writes do. */
// code-gauge-allow functionNcss 52 -- Handles each kind of writable expression, whose write rules PHP defines separately.
// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function placeOf(e: Expr, mode: 'write' | 'update' | 'deferred' = 'write'): Place {
  const runtime = rt();
  const frame = runtime.frame;
  switch (e.k) {
    case 'var': {
      if (e.name === 'this') {
        if (frame.thisObj) return new ValuePlace(frame.thisObj);
        throwError('Error', 'Using $this when not in object context');
      }
      return new VarPlace(frame, e.name);
    }
    case 'varvar': {
      const name = toStr(ev(e.name));
      if (name === 'this') throwError('Error', 'Cannot re-assign $this');
      return new VarPlace(frame, name);
    }
    case 'idx': {
      if (e.base.k === 'var' && e.base.name === 'GLOBALS') {
        return globalPlace(e.index);
      }
      const parent = placeOf(e.base, mode);
      const key = e.index === undefined ? undefined : ev(e.index);
      runtime.row = e.row;
      if (mode === 'deferred') return deferredElementPlace(parent, key);
      const container = writableContainer(parent.nested?.(mode) ?? parent);
      if (container instanceof PhpArray) return new ElementPlace(container, key === undefined ? undefined : toKey(key));
      if (container instanceof PhpObject) return arrayAccessPlace(container, key);
      return stringOffsetPlace(parent, container, key);
    }
    case 'prop': {
      const object = writtenObject(e.obj);
      const name = memberName(e.name);
      runtime.row = e.row;
      if (!(object instanceof PhpObject)) {
        if (object === null) throwError('Error', `Attempt to assign property "${name}" on null`);
        throwError('Error', `Attempt to assign property "${name}" on ${valueName(object)}`);
      }
      return propPlace(object, name);
    }
    case 'sprop': {
      const cls = resolveClassRef(e.cls);
      const name = typeof e.name === 'string' ? e.name : toStr(ev(e.name));
      return new StaticPlace(cls, name, frame.scope);
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

function deferredElementPlace(parent: Place, key: Value | undefined): Place {
  let target: Place | undefined;
  const writable = (): Place => {
    if (target) return target;
    const container = writableContainer(parent.nested?.('write') ?? parent);
    target =
      container instanceof PhpArray
        ? new ElementPlace(container, key === undefined ? undefined : toKey(key))
        : container instanceof PhpObject
          ? arrayAccessPlace(container, key)
          : stringOffsetPlace(parent, container, key);
    return target;
  };
  const read = (): Value | undefined => {
    const container = parent.getForIsset ? parent.getForIsset() : parent.get();
    return container === undefined || container === null || key === undefined
      ? undefined
      : readIndex(container, key, true);
  };
  return {
    get: read,
    getForIsset: read,
    nested: (mode) => {
      const place = writable();
      return place.nested?.(mode) ?? place;
    },
    declaration: () => writable().declaration?.(),
    typeSources: () => writable().typeSources?.(),
    set: (value) => writable().set(value),
    ref: () => writable().ref(),
    unset: () => writable().unset(),
  };
}

function globalPlace(index?: Expr): VarPlace {
  if (index === undefined) throwError('Error', 'Cannot append to $GLOBALS');
  return new VarPlace(rt().globalFrame, toStr(ev(index)));
}

class StaticPlace implements Place {
  constructor(
    private readonly cls: PhpClass,
    private readonly name: string,
    private readonly scope: PhpClass | undefined
  ) {}

  private get decl(): PropDecl | undefined {
    return this.cls.findStatic(this.name)?.decl;
  }

  private get target(): Ref {
    return staticPropRef(this.cls, this.name, this.scope);
  }

  typeSources(): Ref['typedBy'] {
    return this.target.typeOwners();
  }

  declaration(): PropDecl | undefined {
    return this.decl;
  }

  get(update?: 'assignOp' | 'incdec' | 'nested'): Value {
    const value = this.target.v;
    if ((value as unknown) === UNINIT) {
      if (update === 'nested') return null;
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

  set(value: Value): Value {
    const target = this.target;
    const decl = this.decl;
    target.v = decl?.type ? classesModule.coerceProperty(decl, value) : value;
    return target.v;
  }

  unset(): void {
    throwError('Error', 'Attempt to unset static property');
  }
}

/** The object of a property write, which PHP fetches without warning about an undefined variable. */
function writtenObject(e: Expr): Value {
  return e.k === 'var' ? evQuiet(e) : ev(e);
}

// code-gauge-allow functionCognitiveComplexity 25 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function propPlace(object: PhpObject, name: string): Place {
  const scope = rt().frame.scope;
  return {
    get: (operation) => readPropertyPlace(object, name, scope, operation),
    set: (value) => writeProp(object, name, value, scope),
    ref: () => propRef(object, name, scope),
    unset: () => unsetProp(object, name, scope),
    declaration: () => classesModule.lookupProp(object.cls, name, scope),
    typeSources: () => {
      const decl = classesModule.lookupProp(object.cls, name, scope);
      const ref = object.props.get(decl?.key ?? name);
      return ref instanceof Ref ? ref.typeOwners() : undefined;
    },
    getForIsset: () => readProp(object, name, scope, 'coalesce'),
    warnUndefined: () => {
      if (object.cls.findMethod('__get')) return;
      // PHP creates the property (deprecating a dynamic one) before it warns about reading it.
      if (!classesModule.lookupProp(object.cls, name, scope)) {
        classesModule.createDynamicProp(object, name);
        object.props.set(name, null);
      }
      warn(`Undefined property: ${object.cls.name}::$${name}`);
    },
    nested(mode = 'write') {
      const decl = classesModule.lookupProp(object.cls, name, scope);
      if (
        ((decl && !classesModule.canAccessProp(decl, scope)) || !issetPropExists(object, name, scope)) &&
        object.cls.findMethod('__get')
      )
        return new RefPlace(propRef(object, name, scope));
      if (decl?.hooks?.get && !object.guards?.has(`hook:${name}`)) {
        classesModule.checkIndirectModification(object, name, scope, mode);
        const runtime = rt();
        runtime.lastReturnRef = undefined;
        const value = readProp(object, name, scope, 'quiet');
        const returned = runtime.lastReturnRef;
        runtime.lastReturnRef = undefined;
        if (returned) return new RefPlace(returned);
        if (!(value instanceof PhpObject))
          throwError('Error', `Indirect modification of ${decl.cls.name}::$${name} is not allowed`);
        return new RefPlace(Ref.temporary(value));
      }
      classesModule.checkIndirectModification(object, name, scope, mode);
      return this;
    },
  };
}

function readPropertyPlace(
  object: PhpObject,
  name: string,
  scope: PhpClass | undefined,
  operation?: 'assignOp' | 'incdec' | 'nested'
): Value | undefined {
  if (object.isResource && operation)
    throwError(
      'Error',
      `Attempt to ${operation === 'assignOp' ? 'assign' : operation === 'incdec' ? 'increment/decrement' : 'modify'} property "${name}" on resource`
    );
  if (!issetPropExists(object, name, scope)) {
    const magic = object.cls.findMethod('__get');
    const decl = classesModule.lookupProp(object.cls, name, scope);
    if (!magic && (!decl?.type || decl.isStatic)) return;
  }
  return readProp(object, name, scope, operation === 'assignOp' || operation === 'incdec' ? 'update' : 'quiet');
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
    nested: () => arrayAccessNestedPlace(object, key),
    get: () => callMethod(object, 'offsetGet', [key ?? null], rt().row),
    set: (value) => {
      callMethod(object, 'offsetSet', [key ?? null, value], rt().row);
      return value;
    },
    ref: () => arrayAccessNestedPlace(object, key).ref(),
    unset: () => {
      callMethod(object, 'offsetUnset', [key ?? null], rt().row);
    },
  };
}

function arrayAccessNestedPlace(object: PhpObject, key: Value | undefined): Place {
  if (
    key !== undefined &&
    object.internal !== undefined &&
    nativeArrayStorage(object.internal) &&
    object.cls.findMethod('offsetget')?.fn.kind === 'native'
  ) {
    return new ElementPlace(object.internal.writable(), toKey(key ?? null));
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

// code-gauge-allow functionCognitiveComplexity 22 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function stringOffsetPlace(parent: Place, text: string, key: Value | undefined): Place {
  return {
    get: (operation) => {
      const message =
        operation === 'assignOp'
          ? 'Cannot use assign-op operators with string offsets'
          : operation === 'incdec'
            ? 'Cannot increment/decrement string offsets'
            : 'Cannot use string offset as an array';
      throwError('Error', message);
    },
    getForIsset: () => (key === undefined ? undefined : readIndex(text, key, true)),
    set: (value) => {
      if (key === undefined) throwError('Error', '[] operator not supported for strings');
      const position = stringOffset(text, key, false) as number;
      let offset = position;
      if (position < 0) {
        const requested = Number(toInt(key));
        if (requested < 0) {
          warn(`Illegal string offset ${requested}`);
          return null;
        }
        offset = requested;
      }
      let character = toStr(value);
      if (character === '') throwError('Error', 'Cannot assign an empty string to a string offset');
      if (character.length > 1) {
        warn('Only the first byte will be assigned to the string offset');
        character = character[0];
      }
      rt().ensureStringFits(Math.max(text.length, offset + 1));
      rt().spend(Math.ceil(Math.max(text.length, offset + 1) / 64));
      const padded = offset >= text.length ? text + ' '.repeat(offset - text.length) + character : text;
      const updated = offset >= text.length ? padded : text.slice(0, offset) + character + text.slice(offset + 1);
      parent.set(updated);
      return character;
    },
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
  const value = ev(valueExpr);
  runtime.row = target.row;
  return place.set(share(value));
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
    const parent = placeOf(target.base);
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
    ref.rc++;
    if (key === undefined) container.append(ref);
    else container.setSlot(key, ref);
    return;
  }
  if (target.k === 'prop') {
    const object = ev(target.obj);
    if (!(object instanceof PhpObject)) throwError('Error', 'Cannot assign by reference to a property of a non-object');
    const name = memberName(target.name);
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
  } else ref = placeOf(source).ref();
  runtime.row = target.row;
  bindRef(target, ref);
  return ref.v;
}

export function destructure(target: Extract<Expr, { k: 'list' }>, value: Value): void {
  let position = 0n;
  for (const item of target.items) {
    if (item === undefined) {
      position++;
      continue;
    }
    const key = item.key === undefined ? position++ : toKey(ev(item.key));
    destructureItem(item, value, key);
  }
}

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function destructureItem(item: ListItem, value: Value, key: Key): void {
  if (item.byRef) {
    if (!(value instanceof PhpArray)) {
      if (value === null) throwError('Error', 'Cannot assign reference to non referenceable value');
      throwError(
        'Error',
        typeof value === 'string'
          ? 'Cannot create references to/from string offsets'
          : 'Cannot use a scalar value as an array'
      );
    }
    const ref = new ElementPlace(value, key).ref();
    bindRef(item.target, ref);
    return;
  }
  let element: Value;
  if (value instanceof PhpArray) {
    element = readElement(value, key, false);
  } else if (value instanceof PhpObject) {
    element = readIndex(value, key, false);
  } else {
    if (value !== null) warn(`Cannot use ${debugType(value)} as array`);
    element = null;
  }
  if (item.target.k === 'list') destructure(item.target, element);
  else placeOf(item.target).set(share(element));
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
  const place = placeOf(e.target, 'update');
  const value = ev(e.value);
  runtime.row = e.row;
  let current = place.get('assignOp');
  if (current === undefined) {
    warnUndefinedTarget(e.target, place);
    current = null;
  }
  const result = applyOperator(e.op, current, value);
  return place.set(share(result));
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
// code-gauge-allow functionNcss 37 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function incDec(e: Extract<Expr, { k: 'incdec' }>): Value {
  const runtime = rt();
  const place = placeOf(e.target, 'update');
  runtime.row = e.row;
  let old = place.get('incdec');
  if (old === undefined) {
    warnUndefinedTarget(e.target, place);
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

function warnUndefinedTarget(target: Expr, place: Place): void {
  if (target.k === 'var' || target.k === 'varvar') warn(`Undefined variable $${(place as VarPlace).name}`);
  else if (place instanceof ElementPlace && place.key !== undefined) {
    warn(`Undefined array key ${typeof place.key === 'bigint' ? place.key : `"${place.key}"`}`);
  } else place.warnUndefined?.();
}

/** Throws PHP's TypeError when `++` or `--` takes a property typed int past the range of ints. */
function checkIntOverflow(place: Place, inc: boolean): void {
  const decl = place.declaration?.();
  if (!decl?.type || acceptsFloat(decl.type)) return;
  throwError(
    'TypeError',
    `Cannot ${inc ? 'increment' : 'decrement'} property ${decl.cls.name}::$${decl.name} of type ${typeToString(decl.type)} past its ${inc ? 'maximal' : 'minimal'} value`
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

// code-gauge-allow functionNcss 41 -- Handles each kind of writable expression, whose write rules PHP defines separately.
// code-gauge-allow functionCognitiveComplexity 17 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function unsetTarget(target: Expr): void {
  const runtime = rt();
  runtime.row = target.row;
  switch (target.k) {
    case 'var': {
      new VarPlace(runtime.frame, target.name).unset();
      return;
    }
    case 'varvar': {
      new VarPlace(runtime.frame, toStr(ev(target.name))).unset();
      return;
    }
    case 'idx': {
      if (target.index === undefined) throwError('Error', 'Cannot use [] for unsetting');
      if (target.base.k === 'var' && target.base.name === 'GLOBALS') {
        new VarPlace(runtime.globalFrame, toStr(ev(target.index))).unset();
        return;
      }
      const base = unsetContainer(target.base);
      const index = ev(target.index);
      if (base === undefined) return;
      if (base instanceof PhpArray) base.delete(toKey(index, 'unset'));
      else if (base instanceof PhpObject) {
        if (!isArrayAccess(base)) throwError('Error', `Cannot use object of type ${base.cls.name} as array`);
        callMethod(base, 'offsetUnset', [index], rt().row);
      } else if (typeof base === 'string') throwError('Error', 'Cannot unset string offsets');
      return;
    }
    case 'prop': {
      const object = evQuiet(target.obj);
      if (!(object instanceof PhpObject)) return;
      unsetProp(object, memberName(target.name), runtime.frame.scope);
      return;
    }
    case 'sprop': {
      throwError('Error', 'Attempt to unset static property');
    }
    default: {
      throwError('Error', 'Cannot unset this expression');
    }
  }
}

/** The container an unset of an element writes into, or undefined when it does not exist. */
function unsetContainer(e: Expr): PhpArray | PhpObject | string | undefined {
  const place = unsetPlace(e);
  const value = place?.get();
  if (value === undefined && e.k !== 'idx') warnUndefinedBase(e);
  if (value instanceof PhpArray) return writableContainer(place as Place, value) as PhpArray;
  if (value instanceof PhpObject || typeof value === 'string') return value;
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity 17 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function unsetPlace(e: Expr): Place | undefined {
  if (e.k === 'idx') {
    if (e.index === undefined) throwError('Error', 'Cannot use [] for unsetting');
    if (e.base.k === 'var' && e.base.name === 'GLOBALS') {
      return new VarPlace(rt().globalFrame, toStr(ev(e.index)));
    }
    const container = unsetContainer(e.base);
    const key = ev(e.index);
    if (container instanceof PhpArray) return new ElementPlace(container, toKey(key, 'unset'));
    if (container instanceof PhpObject) {
      const place = arrayAccessPlace(container, key);
      return place.nested?.() ?? place;
    }
    if (typeof container === 'string') throwError('Error', 'Cannot unset string offsets');
    return undefined;
  }
  if (e.k === 'prop') {
    const object = ev(e.obj);
    const name = memberName(e.name);
    if (!(object instanceof PhpObject)) return undefined;
    const place = propPlace(object, name);
    return place.nested?.('unset') ?? place;
  }
  if (e.k === 'var' || e.k === 'varvar' || e.k === 'sprop') {
    return placeOf(e);
  }
  return new ValuePlace(ev(e));
}

/** Warns about the undefined variable an unset of an element starts from, as PHP's fetch for unset does. */
function warnUndefinedBase(e: Expr): void {
  let base = e;
  while (base.k === 'idx') base = base.base;
  if (base.k !== 'var' || base.name === 'this' || base.name === 'GLOBALS') return;
  if (!rt().frame.vars.has(base.name)) warn(`Undefined variable $${base.name}`);
}

// code-gauge-allow functionNcss 48 -- Handles each kind of writable expression, whose write rules PHP defines separately.
// code-gauge-allow functionCognitiveComplexity 27 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function isset(e: Expr): boolean {
  const runtime = rt();
  switch (e.k) {
    case 'var': {
      if (e.name === 'this') return runtime.frame.thisObj !== undefined;
      if (e.name === 'GLOBALS') return true;
      const ref = runtime.frame.vars.get(e.name);
      return ref !== undefined && ref.v !== null;
    }
    case 'varvar': {
      const ref = runtime.frame.vars.get(toStr(ev(e.name)));
      return ref !== undefined && ref.v !== null;
    }
    case 'idx': {
      if (e.index === undefined) throwError('Error', 'Cannot use [] for reading');
      const base = evQuiet(e.base, 'coalesce');
      const index = ev(e.index);
      if (base instanceof PhpArray) return (base.get(toKey(index, 'isset')) ?? null) !== null;
      if (typeof base === 'string') {
        if (typeof index === 'string' && !/^[ \t\n\r\v\f]*[+-]?\d+[ \t\n\r\v\f]*$/.test(index)) return false;
        const position = stringOffset(base, index, true);
        return position !== undefined && position >= 0;
      }
      if (base instanceof PhpObject) {
        return issetArrayAccess(base, index);
      }
      return false;
    }
    case 'prop': {
      const object = evQuiet(e.obj, 'coalesce');
      if (!(object instanceof PhpObject)) return false;
      return issetProp(object, memberName(e.name), runtime.frame.scope);
    }
    case 'sprop': {
      const cls = resolveClassRef(e.cls);
      const name = typeof e.name === 'string' ? e.name : toStr(ev(e.name));
      return classesModule.readStaticProp(cls, name, runtime.frame.scope, true) !== null;
    }
    case 'cconst': {
      return ev(e) !== null;
    }
    default: {
      return ev(e) !== null;
    }
  }
}

function issetArrayAccess(object: PhpObject, index: Value): boolean {
  if (!isArrayAccess(object)) throwError('Error', `Cannot use object of type ${object.cls.name} as array`);
  if (nativeArrayStorage(object.internal) && object.cls.findMethod('offsetexists')?.fn.kind === 'native')
    return (object.internal.array.get(toKey(index, 'isset')) ?? null) !== null;
  return toBool(callMethod(object, 'offsetExists', [index], rt().row));
}
