// code-gauge-allow-file fileNcss 806 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import {
  applyOperator,
  assignExpression,
  assignReference,
  compoundAssign,
  destructure,
  incDec,
  isset,
  nativeIteratorSlot,
  placeOf,
} from './assignment';
import type { Arg, ClassDecl, ClassRef, Expr } from './ast';
import { hasReferenceItem } from './astAnalysis';
import builtinNames from './builtinNames.json';
import { lower } from './bytes';
import {
  callExpression,
  callMethod,
  callValue,
  createArrow,
  createClosure,
  evalArgs,
  methodCallExpression,
  staticCallExpression,
} from './callables';
import { type ArgValue, copyClosureData, invoke } from './calls';
import {
  canCall,
  checkInstantiable,
  classConstant,
  createObject,
  declareClass,
  findClass,
  instantiate,
  issetProp,
  readProp,
  readStaticProp,
  requireClass,
  requireClassScope,
  visibleProps,
  writeProp,
} from './classes';
import * as classesModule from './classes';
import { debugType, numericPrefix, toBool, valueName } from './conversions';
import * as conversionsModule from './conversions';
import { deprecated, notice, throwError, warn } from './errors';
import { constantDeprecation } from './native';
import {
  bitwiseNot,
  compare,
  looseEquals,
  negate,
  strictEquals,
  toFloat,
  toInt,
  toKey,
  toStr,
  unaryPlus,
} from './operators';
import { readElement, share } from './places';
import { PhpThrow, rt } from './runtime';
import { constantKey, iteratorOf } from './statements';
import { UnsupportedFeatureError } from './unsupported';
import {
  type ClosureData,
  copyValueSlot,
  INT_MAX,
  INT_MIN,
  isClosure,
  PhpArray,
  type PhpClass,
  PhpObject,
  Ref,
  type Value,
} from './values';

export const SHORT = Symbol('nullsafe');
export type Chain = Value | typeof SHORT;

// Expressions --------------------------------------------------------------------------------------------------------

/** Evaluates an expression whose value a `return` passes to the caller, which keeps it alive meanwhile. */
export function evReturn(e: Expr): Value {
  const runtime = rt();
  const frame = runtime.frame;
  const fn = frame.fn;
  if (fn?.kind !== 'user' || !fn.decl.byRefReturn) return ev(e);
  let ref: Ref | undefined;
  let value: Value;
  if (['var', 'varvar', 'idx', 'prop', 'sprop'].includes(e.k)) {
    ref = placeOf(e).ref();
    value = ref.v;
  } else {
    runtime.lastReturnRef = undefined;
    value = ev(e);
    if (e.k === 'call' || e.k === 'mcall' || e.k === 'scall') ref = runtime.lastReturnRef;
    runtime.lastReturnRef = undefined;
  }
  if (ref) {
    ref.isRef = true;
    frame.returnRef = ref;
  } else notice('Only variable references should be returned by reference');
  return value;
}

export function ev(e: Expr, discardResult = false): Value {
  const runtime = rt();
  const constant = compileTimeValue(e);
  const literals = runtime.literalArrays.get(e);
  const scope = scopedCompileTimeValues.expression.get(e) ? runtime.frame.scope : undefined;
  const cached = constant ? literals?.get(scope) : undefined;
  if (cached) return share(cached);
  const epoch = runtime.constantEvaluationEpoch;
  let value: Value;
  if (RELEASING_OPERANDS.has(e.k)) {
    const mark = runtime.frame.temporaries.length;
    const result = evChain(e, discardResult);
    value = keepResult(mark, result === SHORT ? null : result) as Value;
  } else {
    const result = evChain(e, discardResult);
    value = result === SHORT ? null : result;
  }
  if (
    value instanceof PhpArray &&
    constant &&
    epoch === runtime.constantEvaluationEpoch &&
    immutableArrayContents(value)
  ) {
    const scopes = literals ?? new Map<PhpClass | undefined, PhpArray>();
    scopes.set(scope, value);
    runtime.literalArrays.set(e, scopes);
    runtime.rootConstants.add(value);
    value.persistentHolder = true;
    value.shared = true;
    value.uncollectable = value.size === 0;
  }
  return value;
}

/** The expressions that consume their operands, which PHP frees right after the expression. */
const RELEASING_OPERANDS = new Set<Expr['k']>(['instanceof', 'unary', 'cast', 'cond', 'empty', 'isset', 'prop', 'idx']);

export function evBool(e: Expr): boolean {
  return consumeExpression(e, toBool);
}

export function consumeExpression<T>(e: Expr, consume: (value: Value) => T): T {
  const runtime = rt();
  const frame = runtime.frame;
  const mark = frame.temporaries.length;
  const value = ev(e);
  const result = consume(value);
  frame.temporaries.push(value);
  runtime.dropTemporaries(frame, mark);
  return result;
}

export function evChain(e: Expr, discardResult = false): Chain {
  const runtime = rt();
  switch (e.k) {
    case 'lit': {
      return e.v;
    }
    case 'interp': {
      let text = '';
      for (const part of e.parts) {
        text += typeof part === 'string' ? part : toStr(ev(part));
        rt().ensureStringFits(text.length);
      }
      return text;
    }
    case 'var': {
      return readVar(e.name, e.row);
    }
    case 'varvar': {
      return readVar(toStr(ev(e.name)), e.row);
    }
    case 'array': {
      return arrayLiteral(e);
    }
    case 'idx': {
      if (e.index === undefined) throwError('Error', 'Cannot use [] for reading');
      if (e.base.k === 'var' && e.base.name === 'GLOBALS') {
        const name = toStr(ev(e.index));
        runtime.row = e.row;
        const ref = runtime.globalFrame.vars.get(name);
        if (ref) return ref.v;
        warn(`Undefined global variable $${name}`);
        return null;
      }
      const base = evChain(e.base);
      if (base === SHORT) return SHORT;
      const index = ev(e.index);
      runtime.row = e.row;
      return readIndex(base, index, false);
    }
    case 'prop': {
      const object = evChain(e.obj);
      if (object === SHORT) return SHORT;
      if (e.nullsafe && object === null) return SHORT;
      const name = memberName(e.name);
      runtime.row = e.row;
      if (!(object instanceof PhpObject)) {
        warn(`Attempt to read property "${name}" on ${valueName(object)}`);
        return null;
      }
      return readProp(object, name, runtime.frame.scope);
    }
    case 'sprop': {
      const cls = resolveClassRef(e.cls);
      const name = typeof e.name === 'string' ? e.name : toStr(ev(e.name));
      return readStaticProp(cls, name, runtime.frame.scope);
    }
    case 'cconst': {
      return classConstantOf(e);
    }
    case 'const': {
      return readConstant(e.name.name, e.name.fallback);
    }
    case 'magic': {
      return magicConstant(e.name);
    }
    case 'call': {
      const mark = runtime.frame.temporaries.length;
      return keepResult(mark, callExpression(e, discardResult));
    }
    case 'mcall': {
      const mark = runtime.frame.temporaries.length;
      return keepResult(mark, methodCallExpression(e, discardResult));
    }
    case 'scall': {
      const mark = runtime.frame.temporaries.length;
      return keepResult(mark, staticCallExpression(e, discardResult));
    }
    case 'new': {
      return keepingResult(() => {
        runtime.row = e.row;
        const cls = resolveClassRef(e.cls);
        checkInstantiable(cls);
        return instantiate(cls, () => constructorArgs(cls, e.args, e.row), e.row, runtime.frame.scope);
      });
    }
    case 'newAnon': {
      return keepingResult(() => {
        runtime.row = e.row;
        const cls = anonymousClass(e.decl, e.row);
        return instantiate(cls, () => constructorArgs(cls, e.args, e.row), e.row, runtime.frame.scope);
      });
    }
    case 'assign': {
      if (e.target.k === 'list') {
        const value = ev(e.value);
        runtime.frame.temporaries.push(value);
        if (['call', 'mcall', 'scall'].includes(e.value.k) && hasReferenceItem(e.target)) {
          notice('Attempting to set reference to non referenceable value');
        }
        destructure(e.target, value);
        return value;
      }
      return assignExpression(e.target, e.value);
    }
    case 'assignRef': {
      return assignReference(e.target, e.source);
    }
    case 'assignOp': {
      return compoundAssign(e);
    }
    case 'bin': {
      return binary(e);
    }
    case 'unary': {
      const value = ev(e.e);
      runtime.row = e.row;
      switch (e.op) {
        case '!': {
          return !toBool(value);
        }
        case '-': {
          return negate(value);
        }
        case '+': {
          return unaryPlus(value);
        }
        default: {
          return bitwiseNot(value);
        }
      }
    }
    case 'incdec': {
      return incDec(e);
    }
    case 'cond': {
      if (e.consequent !== undefined) return evBool(e.test) ? ev(e.consequent) : ev(e.alternate);
      const test = ev(e.test);
      return toBool(test) ? test : ev(e.alternate);
    }
    case 'cast': {
      return cast(e.type, ev(e.e));
    }
    case 'silence': {
      runtime.silence++;
      try {
        return ev(e.e);
      } finally {
        runtime.silence--;
      }
    }
    case 'clone': {
      return cloneExpression(e);
    }
    case 'throw': {
      const value = ev(e.e);
      runtime.row = e.row;
      if (!(value instanceof PhpObject) || !isThrowableObject(value)) throwError('Error', 'Can only throw objects');
      throw new PhpThrow(value);
    }
    case 'isset': {
      return e.items.every((item) => isset(item));
    }
    case 'empty': {
      return !toBool(evQuiet(e.e));
    }
    case 'closure': {
      return createClosure(e);
    }
    case 'arrow': {
      return createArrow(e);
    }
    case 'instanceof': {
      const value = ev(e.e);
      if (e.cls.k === 'expr') {
        const right = ev(e.cls.e);
        if (right instanceof PhpObject) return value instanceof PhpObject && value.cls.isSubclassOf(right.cls);
        if (typeof right === 'string') {
          const cls = findClass(right);
          return value instanceof PhpObject && cls !== undefined && value.cls.isSubclassOf(cls);
        }
        throwError('Error', 'Class name must be a valid object or a string');
      }
      if (!(value instanceof PhpObject)) return false;
      if (e.cls.k === 'named') {
        const cls = findClass(e.cls.name);
        return cls !== undefined && value.cls.isSubclassOf(cls);
      }
      return value.cls.isSubclassOf(resolveClassRef(e.cls));
    }
    case 'match': {
      return matchExpression(e);
    }
    case 'print': {
      return consumeExpression(e.e, (value) => {
        runtime.echo(toStr(value));
        return 1n;
      });
    }
    case 'pipe': {
      const value = ev(e.l);
      runtime.frame.temporaries.push(value);
      const callable = ev(e.r);
      runtime.row = e.row;
      return callValue(callable, [{ v: value }], e.row, 'direct');
    }
    case 'list': {
      throwError('Error', 'Cannot use list() outside an assignment');
    }
    case 'unsupported': {
      throwError('Error', e.what);
    }
  }
}

/**
 * Runs a call, then releases the temporaries its arguments held, as PHP frees arguments when a call returns, keeping
 * only the result until the statement stores or drops it.
 */
function keepingResult(run: () => Chain): Chain {
  return keepResult(rt().frame.temporaries.length, run());
}

/** Releases the temporaries held since `mark`, keeping only a call's result, as {@link keepingResult} describes. */
function keepResult(mark: number, result: Chain): Chain {
  const runtime = rt();
  const frame = runtime.frame;
  const keep = result instanceof PhpObject || result instanceof PhpArray;
  // The result stays held while the temporaries it was made from are released.
  if (keep) frame.temporaries.splice(mark, 0, result);
  runtime.dropTemporaries(frame, keep ? mark + 1 : mark);
  return result;
}

function isThrowableObject(object: PhpObject): boolean {
  const throwable = rt().classes.get('throwable');
  return throwable !== undefined && object.cls.isSubclassOf(throwable);
}

/** Evaluates an expression without the warnings an undefined variable or key would raise, as `??` and `empty` do. */
// code-gauge-allow functionNcss 37 -- One case per expression kind, as PHP evaluates each kind differently.
// code-gauge-allow functionCognitiveComplexity 19 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function evQuiet(e: Expr, mode: 'isset' | 'coalesce' = 'isset'): Value {
  const runtime = rt();
  switch (e.k) {
    case 'var': {
      if (e.name === 'this') return runtime.frame.thisObj ?? null;
      if (e.name === 'GLOBALS') return globalsArray();
      return runtime.frame.vars.get(e.name)?.v ?? null;
    }
    case 'varvar': {
      return runtime.frame.vars.get(toStr(ev(e.name)))?.v ?? null;
    }
    case 'idx': {
      if (e.index === undefined) throwError('Error', 'Cannot use [] for reading');
      const base = evQuiet(e.base, 'coalesce');
      const index = ev(e.index);
      if (base === null) return null;
      return readIndex(base, index, true);
    }
    case 'prop': {
      const object = evQuiet(e.obj, 'coalesce');
      if (!(object instanceof PhpObject)) return null;
      const name = memberName(e.name);
      const scope = runtime.frame.scope;
      if (mode === 'coalesce') return readProp(object, name, scope, 'coalesce');
      const decl = classesModule.lookupProp(object.cls, name, scope);
      if (!(decl?.hooks?.get && classesModule.canAccessProp(decl, scope)) && !issetProp(object, name, scope))
        return null;
      return readProp(object, name, scope, 'quiet');
    }
    case 'sprop': {
      const cls = resolveClassRef(e.cls);
      const name = typeof e.name === 'string' ? e.name : toStr(ev(e.name));
      return readStaticProp(cls, name, runtime.frame.scope, true);
    }
    default: {
      return ev(e);
    }
  }
}

function readVar(name: string, row: number): Value {
  const runtime = rt();
  const frame = runtime.frame;
  if (name === 'this') {
    if (frame.thisObj) return frame.thisObj;
    runtime.row = row;
    throwError('Error', 'Using $this when not in object context');
  }
  const ref = frame.vars.get(name);
  if (ref) return ref.v;
  if (name === 'GLOBALS') return globalsArray();
  runtime.row = row;
  warn(`Undefined variable $${name}`);
  return null;
}

function globalsArray(): PhpArray {
  const array = new PhpArray();
  for (const [name, ref] of rt().globalFrame.vars) array.set(toKey(name), share(ref.v));
  return array;
}

export function readIndex(base: Value, index: Value, quiet: boolean): Value {
  if (base instanceof PhpArray) return readElement(base, toKey(index, quiet ? 'isset' : 'access'), quiet);
  if (typeof base === 'string') return readStringOffset(base, index, quiet);
  if (base instanceof PhpObject) {
    if (base.cls.findMethod('offsetget') && isArrayAccess(base)) {
      if (quiet && !toBool(callMethod(base, 'offsetExists', [index], rt().row))) return null;
      return callMethod(base, 'offsetGet', [index], rt().row);
    }
    throwError('Error', `Cannot use object of type ${base.cls.name} as array`);
  }
  if (!quiet) warn(`Trying to access array offset on ${valueName(base)}`);
  return null;
}

export function isArrayAccess(object: PhpObject): boolean {
  const arrayAccess = rt().classes.get('arrayaccess');
  return arrayAccess !== undefined && object.cls.isSubclassOf(arrayAccess);
}

/** The position an index selects in a string: -1 when it is out of range, undefined when `quiet` and the index is not an integer. */
// code-gauge-allow functionNcss 40 -- One case per expression kind, as PHP evaluates each kind differently.
export function stringOffset(text: string, index: Value, quiet: boolean): number | undefined {
  let offset: bigint;
  if (typeof index === 'bigint') offset = index;
  else if (typeof index === 'string') {
    if (/^[ \t\n\r\v\f]*[+-]?\d+[ \t\n\r\v\f]*$/.test(index)) {
      offset = BigInt(index);
      if (offset < INT_MIN || offset > INT_MAX) {
        if (quiet) return undefined;
        throwError('TypeError', 'Cannot access offset of type string on string');
      }
    } else {
      if (numericPrefix(index)?.whole) {
        if (quiet) return undefined;
        throwError('TypeError', 'Cannot access offset of type string on string');
      }
      const leading = /^[ \t\n\r\v\f]*[+-]?\d+/.exec(index);
      if (!leading || quiet) {
        if (quiet) return undefined;
        throwError('TypeError', `Cannot access offset of type ${debugType(index)} on string`);
      }
      warn(`Illegal string offset "${index}"`);
      offset = BigInt(leading[0].trim());
    }
  } else if (typeof index === 'number') {
    if (!quiet) warn('String offset cast occurred');
    offset = toInt(index);
  } else if (typeof index === 'boolean' || index === null) {
    if (!quiet) warn('String offset cast occurred');
    offset = index ? 1n : 0n;
  } else throwError('TypeError', `Cannot access offset of type ${debugType(index)} on string`);
  const position = offset < 0n ? BigInt(text.length) + offset : offset;
  if (position < 0n || position >= BigInt(text.length)) return -1;
  return Number(position);
}

function readStringOffset(text: string, index: Value, quiet: boolean): Value {
  const position = stringOffset(text, index, quiet);
  if (position === undefined) return null;
  if (position < 0) {
    if (quiet) return null;
    warn(`Uninitialized string offset ${toInt(index)}`);
    return '';
  }
  return text[position];
}

export function memberName(name: string | Expr): string {
  return typeof name === 'string' ? name : toStr(ev(name));
}

const compileTimeConstants = new Set(builtinNames.constants);
type ConstantContext = 'constant' | 'expression';
const compileTimeValues = { constant: new WeakMap<Expr, boolean>(), expression: new WeakMap<Expr, boolean>() };
const scopedCompileTimeValues = { constant: new WeakMap<Expr, boolean>(), expression: new WeakMap<Expr, boolean>() };

// code-gauge-allow functionCognitiveComplexity 21 -- One case per expression kind, as PHP evaluates each kind differently.
function arrayLiteral(e: Extract<Expr, { k: 'array' }>): PhpArray {
  const runtime = rt();
  const array = new PhpArray(undefined, e.items.length);
  for (const item of e.items) {
    if (item.spread) {
      const value = ev(item.value);
      spreadInto(array, value);
      continue;
    }
    const key = item.key === undefined ? undefined : toKey(ev(item.key));
    if (item.byRef) {
      const ref = placeOf(item.value).ref();
      ref.isRef = true;
      ref.rc++;
      if (key === undefined) {
        if (!array.append(ref))
          throwError('Error', 'Cannot add element to the array as the next element is already occupied');
      } else array.setSlot(key, ref);
      continue;
    }
    const value = share(ev(item.value));
    if (key === undefined) {
      if (!array.append(value))
        throwError('Error', 'Cannot add element to the array as the next element is already occupied');
    } else array.setSlot(key, value);
    runtime.spend();
  }
  return array;
}

// code-gauge-allow functionNcss 46 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function compileTimeValue(e: Expr, context: ConstantContext = 'expression'): boolean {
  const cached = compileTimeValues[context].get(e);
  if (cached !== undefined) return cached;
  let scoped = e.k === 'magic' || (e.k === 'cconst' && e.cls.k !== 'named');
  const child = (value: Expr, childContext = context): boolean => {
    const constant = compileTimeValue(value, childContext);
    if (scopedCompileTimeValues[childContext].get(value)) scoped = true;
    return constant;
  };
  let result = false;
  switch (e.k) {
    case 'lit':
    case 'magic': {
      result = true;
      break;
    }
    case 'const': {
      result = compileTimeConstants.has(e.name.name);
      break;
    }
    case 'array': {
      result = e.items.every(
        (item) => !item.byRef && (!item.key || child(item.key, 'constant')) && child(item.value, 'constant')
      );
      break;
    }
    case 'unary': {
      result = child(e.e);
      break;
    }
    case 'cast': {
      result = context === 'constant' && e.type !== 'object' && child(e.e);
      break;
    }
    case 'bin': {
      result = child(e.l) && child(e.r);
      break;
    }
    case 'cond': {
      result = child(e.test) && (!e.consequent || child(e.consequent)) && child(e.alternate);
      break;
    }
    case 'interp': {
      result = e.parts.every((part) => typeof part === 'string' || child(part));
      break;
    }
    case 'idx': {
      result = e.index !== undefined && child(e.base) && child(e.index);
      break;
    }
    case 'cconst': {
      result = e.name === 'class' && e.cls.k !== 'expr' && e.cls.k !== 'static';
      break;
    }
  }
  compileTimeValues[context].set(e, result);
  scopedCompileTimeValues[context].set(e, scoped);
  return result;
}

function immutableArrayContents(array: PhpArray): boolean {
  for (const value of array.map.values()) {
    if (value instanceof Ref || value instanceof PhpObject) return false;
    if (value instanceof PhpArray && !immutableArrayContents(value)) return false;
  }
  return true;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function spreadInto(array: PhpArray, value: Value): void {
  if (value instanceof PhpArray) {
    for (const [key, slot] of value.map) {
      const item = copyValueSlot(slot);
      if (typeof key === 'string') array.setSlot(key, item);
      else if (!array.append(item))
        throwError('Error', 'Cannot add element to the array as the next element is already occupied');
    }
    return;
  }
  if (value instanceof PhpObject && value.cls.isSubclassOf(rt().classes.get('traversable') as PhpClass)) {
    for (const [key, item] of iterate(value)) {
      if (typeof key === 'string') array.set(key, share(item));
      else if (typeof key === 'bigint') array.append(share(item));
      else throwError('Error', 'Keys must be of type int|string during array unpacking');
    }
    return;
  }
  throwError('TypeError', `Only arrays and Traversables can be unpacked, ${valueName(value)} given`);
}

/** Iterates over an array or a Traversable object, as `foreach` would. */
export function iterate(value: Value, fetch?: 'both' | 'value' | 'none', slots?: false): Generator<[Value, Value]>;
export function iterate(value: Value, fetch: 'both' | 'value' | 'none', slots: true): Generator<[Value, Value | Ref]>;
// code-gauge-allow functionNcss 33 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function* iterate(
  value: Value,
  fetch: 'both' | 'value' | 'none' = 'both',
  slots = false
): Generator<[Value, Value | Ref]> {
  if (value instanceof PhpArray) {
    for (const [key, slot] of value.map) yield [key, slots ? slot : slot instanceof Ref ? slot.v : slot];
    return;
  }
  if (!(value instanceof PhpObject)) return;
  const iterator = iteratorOf(value);
  if (!iterator) {
    for (const entry of visibleProps(value, rt().frame.scope)) yield entry;
    return;
  }
  callMethod(iterator, 'rewind', []);
  while (toBool(callMethod(iterator, 'valid', []))) {
    const runtime = rt();
    runtime.spend();
    const frame = runtime.frame;
    const mark = frame.temporaries.length;
    try {
      if (slots) runtime.lastReturnRef = undefined;
      const current = fetch === 'none' ? null : callMethod(iterator, 'current', []);
      const reference = slots && fetch !== 'none' ? runtime.lastReturnRef : undefined;
      if (slots) runtime.lastReturnRef = undefined;
      const slot = slots ? (reference ?? nativeIteratorSlot(iterator) ?? current) : current;
      if (slots && slot instanceof Ref) runtime.holdTemporaryReference(slot);
      const key = fetch === 'both' ? callMethod(iterator, 'key', []) : null;
      yield [key, slot];
    } finally {
      if (slots) runtime.dropTemporaries(frame, mark);
    }
    callMethod(iterator, 'next', []);
  }
}

/** The constants that describe the machine running PHP, which differ between this grader and a learner's PHP. */
const ENVIRONMENT_CONSTANTS = new Set([
  'PHP_OS',
  'PHP_OS_FAMILY',
  'PHP_BINARY',
  'PHP_BINDIR',
  'PHP_LIBDIR',
  'PHP_DATADIR',
  'PHP_EXTENSION_DIR',
  'PHP_CONFIG_FILE_PATH',
  'PHP_CONFIG_FILE_SCAN_DIR',
  'PHP_SHLIB_SUFFIX',
  'PHP_PREFIX',
  'PHP_MANDIR',
  'PHP_SYSCONFDIR',
  'PHP_LOCALSTATEDIR',
  'DEFAULT_INCLUDE_PATH',
  'PEAR_INSTALL_DIR',
  'PEAR_EXTENSION_DIR',
]);

function readConstant(name: string, fallback: string | undefined): Value {
  const runtime = rt();
  const global = fallback ?? name;
  if (ENVIRONMENT_CONSTANTS.has(global) && !runtime.constants.has(constantKey(name))) {
    throw new UnsupportedFeatureError(`実行環境の情報（${global}）`);
  }
  const value = runtime.constants.get(constantKey(name));
  if (value !== undefined) return deprecatedConstant(name, value);
  if (fallback !== undefined) {
    const global = runtime.constants.get(fallback);
    if (global !== undefined) return deprecatedConstant(fallback, global);
  }
  if (builtinNames.constants.includes(global)) {
    throw new UnsupportedFeatureError(`実行環境の機能（${global}）`);
  }
  throwError('Error', `Undefined constant "${name}"`);
}

/** Returns a constant's value after the deprecation PHP reports when a program reads a deprecated builtin one. */
export function deprecatedConstant(name: string, value: Value): Value {
  const message = constantDeprecation(name);
  if (message) deprecated(message);
  return value;
}

// code-gauge-allow functionCognitiveComplexity 23 -- One case per expression kind, as PHP evaluates each kind differently.
function magicConstant(name: Extract<Expr, { k: 'magic' }>['name']): Value {
  const frame = rt().frame;
  const decl = frame.decl;
  switch (name) {
    case '__CLASS__': {
      if (frame.closure) return (frame.closure.internal as ClosureData).scope?.fullName ?? '';
      return frame.scope?.fullName ?? '';
    }
    case '__FUNCTION__': {
      if (!decl) return '';
      if (decl.isClosure) return decl.name;
      return frame.method ? frame.method.name : decl.name;
    }
    case '__METHOD__': {
      if (!decl) return '';
      if (decl.isClosure) return decl.name;
      // The class or trait that declares the method, as PHP fixes it at compile time.
      if (frame.method) {
        const scope = frame.method.scope;
        const owner = decl.className === undefined || decl.className === scope.name ? scope.fullName : decl.className;
        return `${owner}::${frame.method.name}`;
      }
      return decl.name;
    }
    case '__TRAIT__': {
      const owner = decl?.className === undefined ? undefined : findClass(decl.className);
      return owner?.kind === 'trait' ? owner.name : '';
    }
  }
}

// Classes ------------------------------------------------------------------------------------------------------------

export function resolveClassRef(ref: ClassRef): PhpClass {
  const frame = rt().frame;
  switch (ref.k) {
    case 'named': {
      return requireClass(ref.name);
    }
    case 'self': {
      return requireClassScope(frame.scope, 'self');
    }
    case 'parent': {
      requireClassScope(frame.scope, 'parent');
      if (!frame.scope?.parent) throwError('Error', 'Cannot use "parent" when current class scope has no parent');
      return frame.scope.parent;
    }
    case 'static': {
      return requireClassScope(frame.staticClass, 'static');
    }
    case 'expr': {
      const value = ev(ref.e);
      if (value instanceof PhpObject) return value.cls;
      if (typeof value === 'string') return requireClass(value);
      throwError('Error', 'Class name must be a valid object or a string');
    }
  }
}

function classConstantOf(e: Extract<Expr, { k: 'cconst' }>): Value {
  const runtime = rt();
  if (lower(e.name) === 'class') {
    if (e.cls.k === 'named') return e.cls.name;
    if (e.cls.k === 'expr') {
      const value = ev(e.cls.e);
      if (!(value instanceof PhpObject)) throwError('TypeError', `Cannot use "::class" on ${debugType(value)}`);
      return value.cls.fullName;
    }
    if (e.cls.k === 'self' || e.cls.k === 'static' || e.cls.k === 'parent')
      requireClassScope(runtime.frame.scope, e.cls.k, 'className');
    return resolveClassRef(e.cls).fullName;
  }
  const cls = resolveClassRef(e.cls);
  runtime.row = e.row;
  const displayName =
    runtime.frame.constantExpression && (e.cls.k === 'self' || e.cls.k === 'parent') ? e.cls.k : cls.name;
  return classConstant(cls, e.name, runtime.frame.scope, displayName);
}

/** Evaluates the arguments of `new`, which PHP does after it has created the object. */
function constructorArgs(cls: PhpClass, args: Arg[], row: number): ArgValue[] {
  const constructor = cls.findMethod('__construct');
  const values = evalArgs(args, constructor?.fn, constructor ? `${constructor.scope.name}::__construct` : undefined);
  rt().row = row;
  return values;
}

const anonymousClasses = new WeakMap<object, PhpClass>();

function anonymousClass(decl: ClassDecl, row: number): PhpClass {
  let cls = anonymousClasses.get(decl);
  if (!cls) {
    cls = declareClass(decl, row);
    anonymousClasses.set(decl, cls);
  }
  return cls;
}

function cloneExpression(e: Extract<Expr, { k: 'clone' }>): Value {
  const runtime = rt();
  const value = ev(e.e);
  runtime.row = e.row;
  if (!(value instanceof PhpObject)) {
    throwError('TypeError', `clone(): Argument #1 ($object) must be of type object, ${valueName(value)} given`);
  }
  return cloneObject(value);
}

// code-gauge-allow functionNcss 41 -- One case per expression kind, as PHP evaluates each kind differently.
export function cloneObject(original: PhpObject, withValue?: Value): PhpObject {
  if (original.isResource)
    throwError('TypeError', 'clone(): Argument #1 ($object) must be of type object, resource given');
  if (!original.cls.isCloneable)
    throwError('Error', `Trying to clone an uncloneable object of class ${original.cls.name}`);
  const runtime = rt();
  const scope = runtime.frame.scope;
  const cloneMethod = original.cls.findMethod('__clone');
  if (cloneMethod && !canCall(cloneMethod, scope)) {
    throwError(
      'Error',
      `Call to ${cloneMethod.visibility} method ${original.cls.name}::__clone() from ${scope ? `scope ${scope.name}` : 'global scope'}`
    );
  }
  const copy = runtime.newObject(original.cls);
  runtime.frame.temporaries.push(copy);
  for (const [key, slot] of original.props) {
    if (slot instanceof Ref) {
      if (slot.rc > 1) {
        slot.rc++;
        copy.props.set(key, slot);
        const decl = classesModule.declForKey(copy.cls, key);
        if (decl?.type) classesModule.attachPropertyReference(slot, decl, copy);
      } else copy.props.set(key, share(slot.v));
    } else copy.props.set(key, typeof slot === 'symbol' ? slot : share(slot));
  }
  if (original.unsetProperties) copy.unsetProperties = new Set(original.unsetProperties);
  copy.internal = cloneInternal(original, copy);
  copy.cloning = true;
  try {
    if (cloneMethod) {
      invoke(
        { fn: cloneMethod.fn, thisObj: copy, scope: cloneMethod.scope, staticClass: copy.cls, method: cloneMethod },
        [],
        runtime.row
      );
    }
    if (withValue !== undefined) {
      if (!(withValue instanceof PhpArray)) {
        throwError(
          'TypeError',
          `clone(): Argument #2 ($withProperties) must be of type array, ${valueName(withValue)} given`
        );
      }
      for (const [key, item] of withValue.entries()) {
        if (typeof key !== 'string') throwError('Error', 'Property name must be of type string, int given');
        writeProp(copy, key, item, scope);
      }
    }
  } finally {
    copy.cloning = false;
    copy.readonlyInit = undefined;
  }
  return copy;
}

function cloneInternal(original: PhpObject, copy: PhpObject): unknown {
  const internal = original.internal as { clone?: (copy: PhpObject) => unknown } | undefined;
  if (internal && typeof internal.clone === 'function') return internal.clone(copy);
  if (isClosure(original)) return copyClosureData(original.internal as ClosureData);
  return internal;
}

// Operators ----------------------------------------------------------------------------------------------------------

function binary(e: Extract<Expr, { k: 'bin' }>): Value {
  const runtime = rt();
  switch (e.op) {
    case '&&':
    case 'and': {
      return evBool(e.l) && evBool(e.r);
    }
    case '||':
    case 'or': {
      return evBool(e.l) || evBool(e.r);
    }
    case 'xor': {
      const mark = runtime.frame.temporaries.length;
      const left = ev(e.l);
      runtime.frame.temporaries.push(left);
      const right = ev(e.r);
      return keepResult(mark, toBool(left) !== toBool(right)) as Value;
    }
    case '??': {
      return evQuiet(e.l, 'coalesce') ?? ev(e.r);
    }
  }
  const mark = runtime.frame.temporaries.length;
  const left = ev(e.l);
  runtime.frame.temporaries.push(left);
  const right = ev(e.r);
  runtime.row = e.row;
  // PHP frees the operands as soon as the operator has used them.
  return keepResult(mark, operate(e.op, left, right)) as Value;
}

function operate(op: string, left: Value, right: Value): Value {
  switch (op) {
    case '==': {
      return looseEquals(left, right);
    }
    case '!=': {
      return !looseEquals(left, right);
    }
    case '===': {
      return strictEquals(left, right);
    }
    case '!==': {
      return !strictEquals(left, right);
    }
    case '<': {
      return compareForOrder(left, right) < 0;
    }
    case '<=': {
      return compareForOrder(left, right) <= 0;
    }
    case '>': {
      return compareForOrder(right, left) < 0;
    }
    case '>=': {
      return compareForOrder(right, left) <= 0;
    }
    case '<=>': {
      return BigInt(compare(left, right));
    }
    default: {
      return applyOperator(op, left, right);
    }
  }
}

function compareForOrder(left: Value, right: Value): number {
  return compare(left, right);
}

// code-gauge-allow functionCognitiveComplexity 17 -- One case per expression kind, as PHP evaluates each kind differently.
// code-gauge-allow functionNcss 33 -- One case per expression kind, as PHP evaluates each kind differently.
export function cast(type: string, value: Value): Value {
  switch (type) {
    case 'int': {
      return toInt(value);
    }
    case 'float': {
      return toFloat(value);
    }
    case 'string': {
      return toStr(value);
    }
    case 'bool': {
      return toBool(value);
    }
    case 'array': {
      if (value instanceof PhpArray) return value;
      if (value === null) return new PhpArray();
      if (value instanceof PhpObject) return objectToArrayCast(value);
      if (Number.isNaN(value)) warn('unexpected NAN value was coerced to array');
      return PhpArray.list([value]);
    }
    case 'object': {
      if (value instanceof PhpObject) return value;
      const object = createObject(rt().classes.get('stdclass') as PhpClass);
      if (value instanceof PhpArray) {
        for (const [key, slot] of value.map) {
          object.props.set(String(key), copyValueSlot(slot));
        }
      } else if (value !== null) object.props.set('scalar', value);
      return object;
    }
    default: {
      throwError('Error', `Unknown cast ${type}`);
    }
  }
}

function objectToArrayCast(object: PhpObject): PhpArray {
  if (isClosure(object)) return PhpArray.list([object]);
  // ArrayObject and ArrayIterator cast to the array they hold.
  const storage = (object.internal as { properties?: () => PhpArray } | undefined)?.properties;
  if (typeof storage === 'function') return storage.call(object.internal).copy();
  return classesModule.objectToArray(object);
}

function matchExpression(e: Extract<Expr, { k: 'match' }>): Value {
  const runtime = rt();
  const subject = ev(e.subject);
  runtime.frame.temporaries.push(subject);
  for (const arm of e.arms) {
    if (!arm.conditions) continue;
    for (const condition of arm.conditions) {
      if (strictEquals(subject, ev(condition))) return ev(arm.body);
    }
  }
  const fallback = e.arms.find((arm) => !arm.conditions);
  if (fallback) return ev(fallback.body);
  runtime.row = e.row;
  throwError('UnhandledMatchError', `Unhandled match case ${matchCaseText(subject)}`);
}

function matchCaseText(value: Value): string {
  if (typeof value === 'string') {
    const escaped = value
      .slice(0, 15)
      .replaceAll(/[\\']/g, String.raw`\$&`)
      .replaceAll('\n', String.raw`\n`)
      .replaceAll('\r', String.raw`\r`)
      .replaceAll('\t', String.raw`\t`);
    return `'${escaped}${value.length > 15 ? '...' : ''}'`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    const text = conversionsModule.formatFloat(value);
    return Number.isFinite(value) && !/[.E]/.test(text) ? `${text}.0` : text;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'NULL';
  return `of type ${debugType(value)}`;
}
