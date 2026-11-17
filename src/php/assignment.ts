// code-gauge-allow-file fileNcss 536 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { Expr, ListItem } from './ast';
import { callMethod } from './callables';
import { findClass, issetProp, propRef, readProp, staticPropRef, unsetProp, writeProp } from './classes';
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
// code-gauge-allow functionNcss 50 -- Handles each kind of writable expression, whose write rules PHP defines separately.
// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function placeOf(e: Expr): Place {
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
        if (e.index === undefined) throwError('Error', 'Cannot append to $GLOBALS');
        return new VarPlace(runtime.globalFrame, toStr(ev(e.index)));
      }
      const parent = placeOf(e.base);
      const key = e.index === undefined ? undefined : ev(e.index);
      runtime.row = e.row;
      const container = writableContainer(parent.nested?.() ?? parent);
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
      const ref = staticPropRef(cls, name, frame.scope);
      return new StaticPlace(ref, cls.findStatic(name)?.decl);
    }
    case 'call':
    case 'mcall':
    case 'scall': {
      const value = ev(e);
      return new ValuePlace(value);
    }
    default: {
      return new ValuePlace(ev(e));
    }
  }
}

class StaticPlace extends RefPlace {
  constructor(
    target: Ref,
    private readonly decl: PropDecl | undefined
  ) {
    super(target);
  }

  declaration(): PropDecl | undefined {
    return this.decl;
  }

  override ref(): Ref {
    if ((this.target.v as unknown) === UNINIT && this.decl?.type) {
      if (coerce(null, this.decl.type, { strict: true, internal: false, scope: this.decl.cls }) === NO_MATCH)
        throwError(
          'Error',
          `Cannot access uninitialized non-nullable property ${this.decl.cls.name}::$${this.decl.name} by reference`
        );
      this.target.v = null;
    }
    return this.target;
  }

  override set(value: Value): Value {
    if (this.decl?.type) {
      const { coerceProperty } = classesModule;
      this.target.v = coerceProperty(this.decl, value);
      return this.target.v;
    }
    this.target.v = value;
    return this.target.v;
  }
}

/** The object of a property write, which PHP fetches without warning about an undefined variable. */
function writtenObject(e: Expr): Value {
  return e.k === 'var' ? evQuiet(e) : ev(e);
}

// code-gauge-allow functionNcss 32 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 23 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function propPlace(object: PhpObject, name: string): Place {
  const scope = rt().frame.scope;
  return {
    get: () => {
      if (!issetPropExists(object, name, scope)) {
        const magic = object.cls.findMethod('__get');
        if (!magic) return;
      }
      return readProp(object, name, scope, true);
    },
    set: (value) => writeProp(object, name, value, scope),
    ref: () => propRef(object, name, scope),
    unset: () => unsetProp(object, name, scope),
    declaration: () => classesModule.lookupProp(object.cls, name, scope),
    getForIsset: () => (issetProp(object, name, scope) ? readProp(object, name, scope, true) : undefined),
    warnUndefined: () => {
      if (object.cls.findMethod('__get')) return;
      // PHP creates the property (deprecating a dynamic one) before it warns about reading it.
      if (!classesModule.lookupProp(object.cls, name, scope)) {
        classesModule.createDynamicProp(object, name);
        object.props.set(name, null);
      }
      warn(`Undefined property: ${object.cls.name}::$${name}`);
    },
    nested() {
      const decl = classesModule.lookupProp(object.cls, name, scope);
      if (decl?.hooks?.get && !object.guards?.has(`hook:${name}`)) {
        classesModule.checkIndirectModification(object, name, scope);
        const runtime = rt();
        runtime.lastReturnRef = undefined;
        const value = readProp(object, name, scope, true);
        const returned = runtime.lastReturnRef;
        runtime.lastReturnRef = undefined;
        if (returned) return new RefPlace(returned);
        if (!(value instanceof PhpObject))
          throwError('Error', `Indirect modification of ${decl.cls.name}::$${name} is not allowed`);
        return new RefPlace(new Ref(value));
      }
      if (!issetPropExists(object, name, scope) && object.cls.findMethod('__get')) {
        return new RefPlace(propRef(object, name, scope));
      }
      classesModule.checkIndirectModification(object, name, scope);
      return this;
    },
  };
}

function issetPropExists(object: PhpObject, name: string, scope: PhpClass | undefined): boolean {
  const decl = classesModule.lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic) return object.props.has(decl.key);
  return object.props.has(name);
}

let nativeArrayStorage: (value: unknown) => value is { writable(): PhpArray } = (
  _value
): _value is { writable(): PhpArray } => false;

export function setNativeArrayStorage(check: typeof nativeArrayStorage): void {
  nativeArrayStorage = check;
}

function arrayAccessPlace(object: PhpObject, key: Value | undefined): Place {
  if (!isArrayAccess(object)) throwError('Error', `Cannot use object of type ${object.cls.name} as array`);
  return {
    getForIsset: () =>
      toBool(callMethod(object, 'offsetExists', [key ?? null]))
        ? callMethod(object, 'offsetGet', [key ?? null])
        : undefined,
    nested: () => {
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
        return new RefPlace(new Ref(null));
      }
      const runtime = rt();
      runtime.lastReturnRef = undefined;
      const value = callMethod(object, 'offsetGet', [key ?? null]);
      const returned = runtime.lastReturnRef as Ref | undefined;
      runtime.lastReturnRef = undefined;
      if (returned) return new RefPlace(returned);
      if (!(value instanceof PhpObject)) {
        notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
      }
      return new RefPlace(new Ref(value));
    },
    get: () => callMethod(object, 'offsetGet', [key ?? null]),
    set: (value) => {
      callMethod(object, 'offsetSet', [key ?? null, value]);
      return value;
    },
    ref: () => {
      const value = callMethod(object, 'offsetGet', [key ?? null]);
      if (!(value instanceof PhpObject))
        notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
      return new Ref(value);
    },
    unset: () => {
      callMethod(object, 'offsetUnset', [key ?? null]);
    },
  };
}

function stringOffsetPlace(parent: Place, text: string, key: Value | undefined): Place {
  return {
    get: () => {
      throwError('Error', 'Cannot use string offset as an array');
    },
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
  const place = placeOf(target);
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
  if (target.k === 'var') {
    if (target.name === 'this') throwError('Error', 'Cannot re-assign $this');
    new VarPlace(rt().frame, target.name).bind(ref);
    return;
  }
  if (target.k === 'varvar') {
    new VarPlace(rt().frame, toStr(ev(target.name))).bind(ref);
    return;
  }
  if (target.k === 'idx') {
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
    const found = cls.findStatic(name);
    if (!found) throwError('Error', `Access to undeclared static property ${cls.name}::$${name}`);
    ref.isRef = true;
    if (found.decl.type) {
      classesModule.attachPropertyReference(ref, found.decl);
    }
    for (let current: PhpClass | undefined = cls; current; current = current.parent) {
      const own = current.staticProps.get(name);
      if (own) {
        current.staticProps.set(name, { ...own, ref });
        break;
      }
    }
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
      ref = new Ref(value);
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

function destructureItem(item: ListItem, value: Value, key: Key): void {
  if (item.byRef) {
    if (!(value instanceof PhpArray)) throwError('Error', 'Cannot assign reference to non referenceable value');
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
    const place = placeOf(e.target);
    const current = place.getForIsset ? place.getForIsset() : place.get();
    if (current !== undefined && current !== null) return current;
    const value = ev(e.value);
    return place.set(share(value));
  }
  const place = placeOf(e.target);
  const value = ev(e.value);
  runtime.row = e.row;
  let current = place.get();
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
  const place = placeOf(e.target);
  runtime.row = e.row;
  let old = place.get();
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
        callMethod(base, 'offsetUnset', [index]);
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
    return place.nested?.() ?? place;
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
      // PHP fetches the containers of an isset quietly, once, asking `__isset` before `__get`.
      const base = evQuiet(e.base);
      const index = ev(e.index);
      if (base instanceof PhpArray) return (base.get(toKey(index, 'isset')) ?? null) !== null;
      if (typeof base === 'string') {
        if (typeof index === 'string' && !/^[ \t\n\r\v\f]*[+-]?\d+[ \t\n\r\v\f]*$/.test(index)) return false;
        const position = stringOffset(base, index, true);
        return position !== undefined && position >= 0;
      }
      if (base instanceof PhpObject) {
        if (!isArrayAccess(base)) throwError('Error', `Cannot use object of type ${base.cls.name} as array`);
        return toBool(callMethod(base, 'offsetExists', [index]));
      }
      return false;
    }
    case 'prop': {
      const object = evQuiet(e.obj);
      if (!(object instanceof PhpObject)) return false;
      return issetProp(object, memberName(e.name), runtime.frame.scope);
    }
    case 'sprop': {
      const cls = e.cls.k === 'named' ? findClass(e.cls.name) : resolveClassRef(e.cls);
      if (!cls) return false;
      const name = typeof e.name === 'string' ? e.name : toStr(ev(e.name));
      const found = cls.findStatic(name);
      if (!found || !classesModule.canAccessProp(found.decl, runtime.frame.scope)) return false;
      return classesModule.resolveStatic(found.ref).v !== null;
    }
    case 'cconst': {
      return ev(e) !== null;
    }
    default: {
      return ev(e) !== null;
    }
  }
}
