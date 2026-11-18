// code-gauge-allow-file fileNcss 950 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import {
  applyOperator,
  assignExpression,
  assignReference,
  compoundAssign,
  destructureAssignment,
  incDec,
  issetOffset,
  nativeIteratorSlot,
  placeOf,
} from './assignment';
import type { Arg, ClassDecl, ClassRef, Expr } from './ast';
import { hasNullsafeReceiver } from './astAnalysis';
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
  readOffset,
  staticCallExpression,
} from './callables';
import { type ArgValue, classMethodLabel, copyClosureData, invoke } from './calls';
import {
  canCall,
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
import { debugType, getType, numericPrefix, toBool, valueName } from './conversions';
import * as conversionsModule from './conversions';
import { deprecated, throwError, type UpdateWarning, warn, withOperandWarnings, withPendingException } from './errors';
import { acquireIterator } from './iteratorAcquisition';
import { constantDeprecation } from './native';
import { compiledOperandRow } from './opcodeRows';
import {
  bitwiseNot,
  compare,
  looseEquals,
  negate,
  strictEquals,
  toFloat,
  toInt,
  toIntForOperator,
  toKey,
  toStr,
  unaryPlus,
} from './operators';
import { readElement, share } from './places';
import { PhpThrow, rt } from './runtime';
import { constantKey } from './statements';
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
export function evReturn(e: Expr): Value | Ref {
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
    return ref;
  }
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
const RELEASING_OPERANDS = new Set<Expr['k']>([
  'instanceof',
  'unary',
  'cast',
  'cond',
  'empty',
  'isset',
  'prop',
  'idx',
  'clone',
  'cconst',
]);

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

export function evOpcodeOperand(e: Expr): Value {
  const value = ev(e);
  rt().row = e.row;
  return value;
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
      return e.name === 'GLOBALS' ? globalsArray() : readVar(e.name, e.row);
    }
    case 'varvar': {
      return readVar(toStr(ev(e.name)), e.row);
    }
    case 'array': {
      return arrayLiteral(e);
    }
    case 'idx':
    case 'prop':
    case 'sprop': {
      return evaluateRead(e, 'read');
    }
    case 'cconst': {
      return classConstantOf(e);
    }
    case 'const': {
      runtime.row = e.row;
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
      if (e.target.k === 'list') return destructureAssignment(e.target, e.value);
      return assignExpression(e.target, e.value);
    }
    case 'assignRef': {
      return assignReference(e.target, e.source);
    }
    case 'assignOp': {
      return compoundAssign(e);
    }
    case 'bin': {
      return e.foldedString ?? binary(e);
    }
    case 'unary': {
      if (e.op === '~' && missingCompiledOperand(e.e)) {
        const read = prepareOperand(e.e);
        return withOperandWarnings((warning) => bitwiseNot(readOperandWithWarning(e.e, read, warning, e.row)));
      }
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
      return cast(e.type, evOpcodeOperand(e.e));
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
      if (!(value instanceof PhpObject) || value.isResource) throwError('Error', 'Can only throw objects');
      if (!isThrowableObject(value)) throwError('Error', 'Cannot throw objects that do not implement Throwable');
      throw new PhpThrow(value);
    }
    case 'isset': {
      return e.items.every((item) => evaluateRead(item, 'isset') === true);
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
        if (right instanceof PhpObject && !right.isResource)
          return value instanceof PhpObject && !value.isResource && value.cls.isSubclassOf(right.cls);
        if (typeof right === 'string') {
          const cls = findClass(right);
          return value instanceof PhpObject && !value.isResource && cls !== undefined && value.cls.isSubclassOf(cls);
        }
        throwError('Error', 'Class name must be a valid object or a string');
      }
      if (!(value instanceof PhpObject) || value.isResource) return false;
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
        runtime.row = e.e.row;
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
export function evQuiet(e: Expr, mode: 'empty' | 'coalesce' = 'empty'): Value {
  const result = evaluateRead(e, mode);
  return result === SHORT ? null : result;
}

type ReadMode = 'read' | 'empty' | 'coalesce' | 'isset';
type ReadPlan = typeof SHORT | (() => Chain);

function evaluateRead(e: Expr, mode: ReadMode): Chain {
  const plan = prepareRead(e, mode);
  return plan === SHORT ? SHORT : plan();
}

// code-gauge-allow functionNcss 37 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function prepareRead(e: Expr, mode: ReadMode): ReadPlan {
  const runtime = rt();
  switch (e.k) {
    case 'var': {
      return () => {
        if (mode === 'isset' && e.name === 'GLOBALS') return true;
        const value = variableRead(e, mode);
        return mode === 'isset' ? value !== null : value;
      };
    }
    case 'varvar': {
      const name = prepareOperand(e.name);
      return () => {
        const key = toStr(name());
        const value = mode === 'read' ? readVar(key, e.row) : (runtime.frame.vars.get(key)?.v ?? null);
        return mode === 'isset' ? value !== null : value;
      };
    }
    case 'idx': {
      return prepareOffsetRead(e, mode);
    }
    case 'prop': {
      return preparePropertyRead(e, mode);
    }
    case 'sprop': {
      runtime.row = e.row;
      const cls = resolveStaticClass(e.cls, (expression) =>
        mode !== 'read' && hasNullsafeReceiver(expression) ? evaluateRead(expression, 'coalesce') : evChain(expression)
      );
      if (cls === SHORT) return SHORT;
      const name = readMemberOperand(e.name);
      return () => {
        const key = name();
        runtime.row = e.row;
        const value = readStaticProp(cls, key, runtime.frame.scope, mode !== 'read');
        return mode === 'isset' ? value !== null : value;
      };
    }
    default: {
      const value = e.k === 'mcall' || e.k === 'scall' ? evChain(e) : ev(e);
      if (value === SHORT) return SHORT;
      if (value instanceof PhpArray || value instanceof PhpObject) runtime.frame.temporaries.push(value);
      return () => (mode === 'isset' ? value !== null : value);
    }
  }
}

function variableRead(e: Extract<Expr, { k: 'var' }>, mode: ReadMode): Value {
  const runtime = rt();
  if (e.name === 'GLOBALS') return globalsArray();
  if (mode === 'read' || (e.name === 'this' && mode === 'coalesce')) return readVar(e.name, e.row);
  return e.name === 'this' ? (runtime.frame.thisObj ?? null) : (runtime.frame.vars.get(e.name)?.v ?? null);
}

function prepareOffsetRead(e: Extract<Expr, { k: 'idx' }>, mode: ReadMode): ReadPlan {
  if (e.index === undefined) throwError('Error', 'Cannot use [] for reading');
  if (e.base.k === 'var' && e.base.name === 'GLOBALS') {
    const key = prepareOperand(e.index);
    return () => globalOffsetRead(key(), e.row, mode);
  }
  const base = prepareRead(e.base, mode === 'read' ? 'read' : 'coalesce');
  if (base === SHORT) return SHORT;
  const index = prepareOperand(e.index);
  return () => {
    const value = base();
    if (value === SHORT) return SHORT;
    const key = index();
    rt().row = e.row;
    if (mode === 'isset') return issetOffset(value, key);
    if (value === null && mode !== 'read') return null;
    return readIndex(value, key, mode === 'empty' ? 'isset' : mode);
  };
}

function globalOffsetRead(key: Value, row: number, mode: ReadMode): Value {
  const name = toStr(key);
  const runtime = rt();
  runtime.row = row;
  const ref = runtime.globalFrame.vars.get(name);
  if (mode === 'isset') return ref !== undefined && ref.v !== null;
  if (ref) return ref.v;
  if (mode === 'read') warn(`Undefined global variable $${name}`);
  return null;
}

// code-gauge-allow functionCognitiveComplexity 23 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function preparePropertyRead(e: Extract<Expr, { k: 'prop' }>, mode: ReadMode): ReadPlan {
  let receiver = prepareRead(e.obj, mode === 'read' ? 'read' : 'coalesce');
  if (receiver === SHORT) return SHORT;
  if (e.nullsafe) {
    const object = receiver();
    if (object === SHORT || object === null) return SHORT;
    if (!isCompiledVariable(e.obj)) {
      if (object instanceof PhpObject) rt().frame.temporaries.push(object);
      receiver = () => object;
    }
  }
  const name = readMemberOperand(e.name);
  return () => {
    const object = receiver();
    if (object === SHORT) return SHORT;
    const key = name();
    const runtime = rt();
    runtime.row = e.row;
    if (!(object instanceof PhpObject)) {
      if (mode === 'read') warn(`Attempt to read property "${key}" on ${valueName(object)}`);
      return mode === 'isset' ? false : null;
    }
    if (mode === 'isset') return issetProp(object, key, runtime.frame.scope);
    return readProp(object, key, runtime.frame.scope, mode);
  };
}

function readMemberOperand(name: string | Expr): () => string {
  if (typeof name === 'string') return () => name;
  const read = prepareOperand(name);
  return () => toStr(read());
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
  runtime.row = row;
  warn(`Undefined variable $${name}`);
  return null;
}

function globalsArray(): PhpArray {
  const array = new PhpArray();
  for (const [name, ref] of rt().variableBindings(rt().globalFrame)) array.set(toKey(name), share(ref.v));
  return array;
}

type OffsetRead = 'read' | 'isset' | 'coalesce';

export function readIndex(base: Value, index: Value, mode: OffsetRead = 'read'): Value {
  const quiet = mode !== 'read';
  if (base instanceof PhpArray) return readElement(base, toKey(index, mode === 'isset' ? 'isset' : 'access'), quiet);
  if (typeof base === 'string') return readStringOffset(base, index, mode);
  if (base instanceof PhpObject && !base.isResource) {
    if (base.cls.findMethod('offsetget') && isArrayAccess(base)) {
      if (quiet && !toBool(callMethod(base, 'offsetExists', [index], rt().row))) return null;
      return readOffset(base, index);
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
// code-gauge-allow functionNcss 44 -- One case per expression kind, as PHP evaluates each kind differently.
export function stringOffset(text: string, index: Value, mode: OffsetRead = 'read'): number | undefined {
  const quiet = mode !== 'read';
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
      if (!leading || mode === 'isset') {
        if (quiet) return undefined;
        throwError('TypeError', `Cannot access offset of type ${debugType(index)} on string`);
      }
      warn(`Illegal string offset "${index}"`);
      offset = BigInt(leading[0].trim());
    }
  } else if (typeof index === 'number') {
    if (!quiet) warn('String offset cast occurred');
    offset = mode === 'isset' ? toIntForOperator(index) : toInt(index);
  } else if (typeof index === 'boolean' || index === null) {
    if (!quiet) warn('String offset cast occurred');
    offset = index ? 1n : 0n;
  } else if (mode === 'isset') return undefined;
  else throwError('TypeError', `Cannot access offset of type ${debugType(index)} on string`);
  const position = offset < 0n ? BigInt(text.length) + offset : offset;
  if (position < 0n || position >= BigInt(text.length)) return -1;
  return Number(position);
}

function readStringOffset(text: string, index: Value, mode: OffsetRead): Value {
  const position = stringOffset(text, index, mode);
  if (position === undefined) return null;
  if (position < 0) {
    if (mode !== 'read') return null;
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

function arrayLiteral(e: Extract<Expr, { k: 'array' }>): PhpArray {
  const runtime = rt();
  const frame = runtime.frame;
  const array = new PhpArray(undefined, e.items.length);
  frame.temporaries.push(array);
  for (const item of e.items) {
    const mark = frame.temporaries.length;
    if (item.spread) spreadInto(array, ev(item.value));
    else insertArrayItem(array, item);
    runtime.dropTemporaries(frame, mark);
  }
  return array;
}

function insertArrayItem(array: PhpArray, item: Extract<Expr, { k: 'array' }>['items'][number]): void {
  const readKey = item.key === undefined ? undefined : prepareOperand(item.key);
  let slot: Value | Ref;
  if (item.byRef) {
    slot = placeOf(item.value).ref();
    slot.isRef = true;
    slot.rc++;
  } else slot = share(ev(item.value));
  const key = readKey === undefined ? undefined : readLiteralKey(item.key!, readKey, compiledOperandRow(item.value));
  const previous = key === undefined ? undefined : array.map.get(key);
  if (key !== undefined) array.setSlot(key, slot);
  else if (!array.append(slot))
    throwError('Error', 'Cannot add element to the array as the next element is already occupied');
  if (previous !== undefined) rt().release([previous]);
  if (!item.byRef) rt().spend();
}

function readLiteralKey(expression: Expr, read: (row: number) => Value, row: number): string | bigint {
  const undefinedVariable =
    expression.k === 'var' && isCompiledVariable(expression) && !rt().frame.vars.has(expression.name);
  const value = read(row);
  rt().row = row;
  return undefinedVariable ? '' : toKey(value);
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
      result = e.className === true && e.cls.k !== 'expr' && e.cls.k !== 'static';
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

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function spreadInto(array: PhpArray, value: Value): void {
  if (value instanceof PhpArray) {
    for (const [key, slot] of value.map) {
      const item = copyValueSlot(slot);
      if (typeof key === 'string') array.setSlot(key, item);
      else appendSpreadValue(array, item);
    }
    return;
  }
  if (value instanceof PhpObject && value.cls.isSubclassOf(rt().classes.get('traversable') as PhpClass)) {
    for (const [key, item] of iterate(value)) {
      if (typeof key === 'string') array.set(key, share(item));
      else if (typeof key === 'bigint') appendSpreadValue(array, share(item));
      else throwError('Error', 'Keys must be of type int|string during array unpacking');
    }
    return;
  }
  throwError(
    value instanceof PhpObject && !value.isResource ? 'TypeError' : 'Error',
    `Only arrays and Traversables can be unpacked, ${valueName(value)} given`
  );
}

function appendSpreadValue(array: PhpArray, value: Value | Ref): void {
  if (!array.append(value))
    throwError('Error', 'Cannot add element to the array as the next element is already occupied');
}

/** Iterates over an array or a Traversable object, as `foreach` would. */
export function iterate(value: Value, fetch?: 'both' | 'value' | 'none', slots?: false): Generator<[Value, Value]>;
export function iterate(value: Value, fetch: 'both' | 'value' | 'none', slots: true): Generator<[Value, Value | Ref]>;
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
  const acquired = acquireIterator(value);
  if (!acquired) {
    for (const entry of visibleProps(value, rt().frame.scope)) yield entry;
    return;
  }
  yield* iterateObject(acquired.iterator, acquired.handle, fetch, slots);
}

// code-gauge-allow functionCognitiveComplexity 22 -- Retains fetched references while the callback runs and releases the engine iterator on every exit.
function* iterateObject(
  iterator: PhpObject,
  handle: PhpObject,
  fetch: 'both' | 'value' | 'none',
  slots: boolean
): Generator<[Value, Value | Ref]> {
  const runtime = rt();
  let failure: PhpThrow | undefined;
  try {
    callMethod(iterator, 'rewind', []);
    while (toBool(callMethod(iterator, 'valid', []))) {
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
  } catch (error) {
    if (error instanceof PhpThrow) failure = error;
    throw error;
  } finally {
    withPendingException(runtime, failure, () => runtime.discardNativeResult(handle, Infinity, 0));
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

// code-gauge-allow functionCognitiveComplexity 27 -- One case per expression kind, as PHP evaluates each kind differently.
function magicConstant(name: Extract<Expr, { k: 'magic' }>['name']): Value {
  const frame = rt().frame;
  const decl = frame.decl;
  switch (name) {
    case '__CLASS__': {
      const scopeName = frame.scope?.fullName ?? '';
      if (!decl) return scopeName;
      const className = decl.className;
      if (className === undefined) return '';
      if (!decl.isClosure || !frame.closure || findClass(className)?.kind === 'trait') return scopeName;
      return (frame.closure.internal as ClosureData).lexicalScope?.fullName ?? className;
    }
    case '__FUNCTION__': {
      return decl?.name ?? '';
    }
    case '__METHOD__': {
      if (!decl) return '';
      if (decl.isClosure) return decl.name;
      // The class or trait that declares the method, as PHP fixes it at compile time.
      if (frame.method || decl.isPropertyHook) {
        const scope = frame.method?.scope ?? frame.scope;
        const owner = decl.className === undefined || decl.className === scope?.name ? scope?.fullName : decl.className;
        if (owner) return `${owner}::${decl.name}`;
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
      if (!frame.scope?.parent) throwError('Error', 'Cannot access "parent" when current class scope has no parent');
      return frame.scope.parent;
    }
    case 'static': {
      return requireClassScope(frame.staticClass, 'static');
    }
    case 'expr': {
      return classOfValue(ev(ref.e));
    }
  }
}

export function resolveStaticClass(
  ref: ClassRef,
  evaluate: (expression: Expr) => Chain = evChain
): PhpClass | typeof SHORT {
  if (ref.k !== 'expr') return resolveClassRef(ref);
  const value = evaluate(ref.e);
  return value === SHORT ? SHORT : classOfValue(value);
}

function classOfValue(value: Value): PhpClass {
  if (value instanceof PhpObject && !value.isResource) return value.cls;
  if (typeof value === 'string') return requireClass(value);
  throwError('Error', 'Class name must be a valid object or a string');
}

function classConstantOf(e: Extract<Expr, { k: 'cconst' }>): Value {
  const runtime = rt();
  runtime.row = e.row;
  if (e.className) return resolveClassName(e.cls, e.className === 'initializer');
  const receiver = e.cls.k === 'expr' ? resolveClassRef(e.cls) : undefined;
  const name = typeof e.name === 'string' ? e.name : ev(e.name);
  runtime.row = e.row;
  const cls = receiver ?? resolveClassRef(e.cls);
  // The direct fetch opcode starts evaluation; lookups within an initializer track recursive constant references.
  const trackEvaluation = runtime.frame.constantExpression;
  if (typeof name !== 'string') {
    const type = name instanceof PhpObject ? getType(name) : debugType(name);
    throwError('TypeError', `Cannot use value of type ${type} as class constant name`);
  }
  if (typeof e.name !== 'string' && !trackEvaluation && lower(name) === 'class') return cls.fullName;
  const displayName = trackEvaluation && e.cls.k !== 'expr' ? (e.cls.k === 'named' ? e.cls.name : e.cls.k) : cls.name;
  return classConstant(cls, name, runtime.frame.scope, displayName, trackEvaluation);
}

function resolveClassName(ref: ClassRef, initializer: boolean): string {
  if (ref.k === 'named') return ref.name;
  if (ref.k === 'expr') {
    const value = ev(ref.e);
    if (!(value instanceof PhpObject) || value.isResource)
      throwError('TypeError', `Cannot use "::class" on ${valueName(value)}`);
    return value.cls.fullName;
  }
  const frame = rt().frame;
  if (!frame.scope && initializer) throwError('Error', 'Cannot use "self" when no class scope is active');
  const scope = requireClassScope(frame.scope, ref.k, 'className');
  if (ref.k === 'parent' && !scope.parent)
    throwError('Error', 'Cannot use "parent" when current class scope has no parent');
  return resolveClassRef(ref).fullName;
}

/** Evaluates the arguments of `new`, which PHP does after it has created the object. */
function constructorArgs(cls: PhpClass, args: Arg[], row: number): ArgValue[] {
  const constructor = cls.findMethod('__construct');
  const values = evalArgs(
    args,
    constructor?.fn,
    constructor ? classMethodLabel(constructor.scope, '__construct') : undefined,
    false
  );
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
  runtime.row = e.e.row;
  if (!(value instanceof PhpObject)) {
    throwError('TypeError', `clone(): Argument #1 ($object) must be of type object, ${valueName(value)} given`);
  }
  return cloneObject(value);
}

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
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
  cloneObjectContents(original, copy);
  if (original.turtle) runtime.attachTurtle(copy, runtime.world.clone(original.turtle));
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

function cloneObjectContents(original: PhpObject, copy: PhpObject): void {
  const internal = original.internal as { cloneWithDefaults?: (copy: PhpObject) => unknown } | undefined;
  if (typeof internal?.cloneWithDefaults === 'function') {
    classesModule.initializeObjectProperties(copy);
    let failure: PhpThrow | undefined;
    try {
      copy.internal = internal.cloneWithDefaults(copy);
    } catch (error) {
      if (!(error instanceof PhpThrow)) throw error;
      failure = error;
    }
    withPendingException(rt(), failure, () => copyCloneProperties(original, copy));
    if (failure) throw failure;
  } else {
    copyCloneProperties(original, copy);
    copy.internal = cloneInternal(original, copy);
  }
}

// code-gauge-allow functionCognitiveComplexity 18 -- Replaces slots and transfers reference constraints in source member order.
function copyCloneProperties(original: PhpObject, copy: PhpObject): void {
  for (const [key, slot] of original.props) {
    const previous = copy.props.get(key);
    if (previous instanceof Ref) {
      previous.rc--;
      if (previous.typedBy) previous.typedBy = previous.typedBy.filter(({ object }) => object !== copy);
    }
    if (!(slot instanceof Ref) || slot.rc <= 1) {
      const value = slot instanceof Ref ? slot.v : slot;
      copy.props.set(key, typeof value === 'symbol' ? value : share(value));
      continue;
    }
    slot.rc++;
    copy.props.set(key, slot);
    const decl = classesModule.declForKey(copy.cls, key);
    if (decl?.type) classesModule.attachPropertyReference(slot, decl, copy);
  }
  copy.unsetProperties = original.unsetProperties && new Set(original.unsetProperties);
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
    case '??': {
      return evQuiet(e.l, 'coalesce') ?? ev(e.r);
    }
  }
  const mark = runtime.frame.temporaries.length;
  const readLeft = prepareOperand(e.l);
  const readRight = prepareOperand(e.r);
  const run = (left: Value, right: Value, pending?: PhpThrow): Value => {
    runtime.row = e.r.row;
    const result = e.swapOperands ? operate(e.op, right, left, pending) : operate(e.op, left, right, pending);
    return keepResult(mark, result) as Value;
  };
  if (!missingCompiledOperand(e.l) && !missingCompiledOperand(e.r)) return run(readLeft(e.r.row), readRight(e.r.row));
  return withOperandWarnings((warning, pending) => {
    const left = readOperandWithWarning(e.l, readLeft, warning, e.r.row);
    const right = readOperandWithWarning(e.r, readRight, warning, e.r.row);
    return run(left, right, pending());
  });
}

export function missingCompiledOperand(e: Expr): boolean {
  return e.k === 'var' && isCompiledVariable(e) && !rt().frame.vars.has(e.name);
}

export function readOperandWithWarning(
  e: Expr,
  read: (row?: number) => Value,
  warning: UpdateWarning,
  row: number
): Value {
  if (!missingCompiledOperand(e)) return read(row);
  let value: Value = null;
  warning(() => {
    value = read(row);
  });
  return value;
}

export function isCompiledVariable(e: Expr): boolean {
  return e.k === 'var' && e.name !== 'this' && e.name !== 'GLOBALS';
}

export function prepareOperand(e: Expr): (row?: number) => Value {
  if (e.k === 'var' && isCompiledVariable(e)) {
    return (row = e.row) => {
      const value = readVar(e.name, row);
      rt().frame.temporaries.push(value);
      return value;
    };
  }
  const value = holdOperand(e);
  return () => value;
}

function holdOperand(e: Expr): Value {
  const value = ev(e);
  rt().frame.temporaries.push(value);
  return value;
}

function operate(op: string, left: Value, right: Value, pending?: PhpThrow): Value {
  switch (op) {
    case 'xor': {
      return toBool(left) !== toBool(right);
    }
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
      return applyOperator(op, left, right, pending);
    }
  }
}

function compareForOrder(left: Value, right: Value): number {
  return compare(left, right);
}

// code-gauge-allow functionCognitiveComplexity 19 -- One case per expression kind, as PHP evaluates each kind differently.
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
      if (value instanceof PhpObject && !value.isResource) return objectToArrayCast(value);
      if (Number.isNaN(value)) warn('unexpected NAN value was coerced to array');
      return PhpArray.list([value]);
    }
    case 'object': {
      if (value instanceof PhpObject && !value.isResource) return value;
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

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function matchExpression(e: Extract<Expr, { k: 'match' }>): Value {
  const runtime = rt();
  const readSubject = prepareOperand(e.subject);
  const snapshot = e.jumpTable ? readSubject() : undefined;
  for (const arm of e.arms) {
    if (!arm.conditions) continue;
    for (const condition of arm.conditions) {
      if (
        consumeExpression(condition, (value) =>
          strictEquals(snapshot === undefined ? readSubject(condition.row) : snapshot, value)
        )
      )
        return ev(arm.body);
    }
  }
  const fallback = e.arms.find((arm) => !arm.conditions);
  if (fallback) return ev(fallback.body);
  const subject =
    e.subject.k === 'var' && isCompiledVariable(e.subject)
      ? (runtime.frame.vars.get(e.subject.name)?.v ?? null)
      : readSubject();
  runtime.row = (e.jumpTable ? e.subject : (e.arms.at(-1)?.conditions?.at(-1) ?? e.subject)).row;
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
