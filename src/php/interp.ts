// code-gauge-allow-file fileNcss 1000 -- Holds the cases of one concern of the interpreter, which share their helpers.
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
  callOffsetExists,
  callValue,
  createArrow,
  createClosure,
  discardInvokedResult,
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
import { debugType, floatFitsInt, getType, numericPrefix, toBool, valueName } from './conversions';
import { deprecated, throwError, type UpdateWarning, warn, withOperandWarnings, withPendingException } from './errors';
import { acquireIterator, callIteratorMethod } from './iteratorAcquisition';
import { matchExpression } from './match';
import { constantDeprecation } from './native';
import { compiledOperandRow, constantAstRow } from './opcodeRows';
import {
  arithmetic,
  bitwiseNot,
  compare,
  floatToIntCast,
  formatFloatForMessage,
  looseEquals,
  negate,
  silentFloatToInt,
  strictEquals,
  toFloat,
  toInt,
  toKey,
  toStr,
  unaryPlus,
} from './operators';
import { readElement, share } from './places';
import { PhpThrow, rt, type Runtime } from './runtime';
import { constantKey } from './statements';
import { checkedDynamicVariable, UnsupportedFeatureError } from './unsupported';
import {
  type ClosureData,
  copyValueSlot,
  deref,
  INT_MAX,
  INT_MIN,
  isClosure,
  PhpArray,
  type PhpClass,
  PhpObject,
  Ref,
  UNDEFINED_RESULT,
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

// code-gauge-allow functionCognitiveComplexity 20 -- Direct expression dispatch keeps hot PHP recursion within the host stack.
// code-gauge-allow functionNcss 44 -- Direct expression dispatch avoids extra wrapper frames on hot expression kinds.
export function ev(e: Expr, discardResult = false): Value {
  const runtime = rt();
  if (runtime.frame.constantExpression && runtime.frame.scope && e.k !== 'const')
    return evaluateConstantExpression(runtime, e, discardResult);
  if (compileTimeValue(e)) return evaluateValue(runtime, e, discardResult);
  switch (e.k) {
    case 'lit': {
      return e.v;
    }
    case 'var': {
      return e.name === 'GLOBALS' ? globalsArray() : readVar(e.name, e.row);
    }
    case 'bin': {
      return e.foldedString ?? binary(e);
    }
    case 'call': {
      return keepResult(runtime.frame.temporaries.length, callExpression(e, discardResult), !e.fcc) as Value;
    }
    case 'mcall': {
      const result = keepResult(runtime.frame.temporaries.length, methodCallExpression(e, discardResult), !e.fcc);
      return result === SHORT ? null : result;
    }
    case 'scall': {
      const result = keepResult(runtime.frame.temporaries.length, staticCallExpression(e, discardResult), !e.fcc);
      return result === SHORT ? null : result;
    }
    case 'new': {
      const mark = runtime.frame.temporaries.length;
      runtime.row = e.row;
      const cls = resolveClassRef(e.cls);
      const callRow = runtime.instructionRow;
      return keepResult(
        mark,
        instantiate(cls, () => constructorArgs(cls, e.args, callRow), callRow, runtime.frame.scope)
      ) as Value;
    }
    case 'assign': {
      return e.target.k === 'list' ? destructureAssignment(e.target, e.value) : assignExpression(e.target, e.value);
    }
    case 'assignOp': {
      return compoundAssign(e);
    }
    case 'idx': {
      if (e.index === undefined || e.base.k !== 'call') break;
      const mark = runtime.frame.temporaries.length;
      const value = keepResult(mark, callExpression(e.base, false), !e.base.fcc) as Value;
      const key = ev(e.index);
      runtime.row = e.row;
      return keepResult(mark, readIndex(value, key, 'read')) as Value;
    }
    case 'cond': {
      if (e.consequent !== undefined)
        return keepResult(
          runtime.frame.temporaries.length,
          evBool(e.test) ? ev(e.consequent) : ev(e.alternate)
        ) as Value;
      break;
    }
  }
  return evalChainValue(runtime, e, discardResult);
}

function evaluateConstantExpression(runtime: Runtime, e: Expr, discardResult: boolean): Value {
  const outer = runtime.constantAstRow;
  runtime.constantAstRow = constantAstRow(e);
  try {
    return evaluateValue(runtime, e, discardResult);
  } finally {
    runtime.constantAstRow = outer;
  }
}

function evaluateValue(runtime: Runtime, e: Expr, discardResult: boolean): Value {
  const constant = compileTimeValue(e);
  const literals = runtime.literalArrays.get(e);
  const scope = scopedCompileTimeValues.expression.get(e) ? runtime.frame.scope : undefined;
  const cached = constant ? literals?.get(scope) : undefined;
  if (cached) return share(cached);
  const epoch = runtime.constantEvaluationEpoch;
  const value = evalChainValue(runtime, e, discardResult);
  if (
    constant &&
    value instanceof PhpArray &&
    epoch === runtime.constantEvaluationEpoch &&
    immutableArrayContents(value)
  ) {
    const scopes = literals ?? new Map<PhpClass | undefined, PhpArray>();
    scopes.set(scope, value);
    runtime.literalArrays.set(e, scopes);
    runtime.declarationRoots.add(value);
    value.persistentHolder = value.shared = true;
    value.uncollectable = value.size === 0;
  }
  return value;
}

function evalChainValue(runtime: Runtime, e: Expr, discardResult: boolean): Value {
  const mark = runtime.frame.temporaries.length;
  const result = evChain(e, discardResult);
  return RELEASING_OPERANDS.has(e.k)
    ? (keepResult(mark, result === SHORT ? null : result) as Value)
    : result === SHORT
      ? null
      : result;
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
  rt().row = compiledOperandRow(e);
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
        text += typeof part === 'string' ? part : stringifyInterpolated(part);
        rt().ensureStringFits(text.length);
      }
      return text;
    }
    case 'var': {
      return e.name === 'GLOBALS' ? globalsArray() : readVar(e.name, e.row);
    }
    case 'varvar': {
      return evaluateRead(e, 'read');
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
      return keepResult(runtime.frame.temporaries.length, callExpression(e, discardResult), !e.fcc);
    }
    case 'mcall': {
      return keepResult(runtime.frame.temporaries.length, methodCallExpression(e, discardResult), !e.fcc);
    }
    case 'scall': {
      return keepResult(runtime.frame.temporaries.length, staticCallExpression(e, discardResult), !e.fcc);
    }
    case 'new':
    case 'newAnon': {
      const mark = runtime.frame.temporaries.length;
      runtime.row = e.row;
      const cls = e.k === 'new' ? resolveClassRef(e.cls) : anonymousClass(e.decl, e.row);
      const callRow = runtime.instructionRow;
      return keepResult(
        mark,
        instantiate(cls, () => constructorArgs(cls, e.args, callRow), callRow, runtime.frame.scope)
      );
    }
    case 'assign': {
      if (e.target.k === 'list') return destructureAssignment(e.target, e.value);
      return assignExpression(e.target, e.value);
    }
    case 'assignRef': {
      return deref(assignReference(e.target, e.source));
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
      const lowerConstantUnary =
        runtime.frame.constantExpression && typeof value !== 'bigint' && typeof value !== 'number';
      if (e.op === '!') return !toBool(value);
      if (e.op === '-') return lowerConstantUnary ? arithmetic('*', -1n, value) : negate(value);
      if (e.op === '+') return lowerConstantUnary ? arithmetic('+', 0n, value) : unaryPlus(value);
      return bitwiseNot(value);
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
      return withSilence(runtime, () => ev(e.e));
    }
    case 'clone': {
      return cloneExpression(e);
    }
    case 'throw': {
      const value = evOpcodeOperand(e.e);
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
      return instanceOfExpression(e);
    }
    case 'match': {
      return keepResult(runtime.frame.temporaries.length, matchExpression(e), false);
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
 * Releases the temporaries held since `mark`, as PHP frees a call's arguments when it returns, keeping only the call's
 * result until the statement stores or drops it.
 */
function keepResult(mark: number, result: Chain, allowsReference?: boolean): Chain {
  const runtime = rt();
  const reference = allowsReference && result !== SHORT ? runtime.lastReturnRef : undefined;
  const retained = reference ?? (result instanceof PhpObject || result instanceof PhpArray ? result : undefined);
  if (reference) reference.rc++;
  if (retained) runtime.frame.temporaries.splice(mark, 0, retained);
  runtime.dropTemporaries(runtime.frame, retained ? mark + 1 : mark);
  if (allowsReference !== undefined) runtime.lastReturnRef = reference;
  return reference ? share(reference.v) : result;
}

export function withSilence<T>(runtime: Runtime, evaluate: () => T): T {
  runtime.silence++;
  try {
    return evaluate();
  } finally {
    runtime.silence--;
  }
}

function isThrowableObject(object: PhpObject): boolean {
  const throwable = rt().classes.get('throwable');
  return throwable !== undefined && object.cls.isSubclassOf(throwable);
}

/** Evaluates an expression without the warnings an undefined variable or key would raise, as `??` and `empty` do. */
export function evQuiet(e: Expr, mode: 'empty' | 'coalesce' = 'empty'): Value {
  const result = evaluateRead(e, mode);
  return result === SHORT || result === UNDEFINED_RESULT ? null : result;
}

type ReadMode = 'read' | 'empty' | 'coalesce' | 'isset';
type ReadPlan = typeof SHORT | (() => Chain);

function evaluateRead(e: Expr, mode: ReadMode): Chain {
  const plan = prepareRead(e, mode);
  return plan === SHORT ? SHORT : plan();
}

// code-gauge-allow functionNcss 37 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 27 -- Applies quiet, isset and value reads across the same expression forms.
function prepareRead(e: Expr, mode: ReadMode): ReadPlan {
  const runtime = rt();
  switch (e.k) {
    case 'var': {
      return () => variableRead(e, mode);
    }
    case 'varvar': {
      const name = prepareOperand(e.name);
      return () => {
        const value = name(e.row);
        runtime.row = e.row;
        const key = checkedDynamicVariable(toStr(value));
        const ref = runtime.frame.vars.get(key);
        if (mode === 'isset') return ref?.isSetBinding ?? false;
        return mode === 'read' ? readVar(key, e.row) : definedOrNull(ref?.v);
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
        const property = name(e.row);
        runtime.row = e.row;
        const value = withPropertyName(property, (key) =>
          readStaticProp(cls, key, runtime.frame.scope, mode !== 'read')
        );
        return mode === 'isset' ? value !== null : value;
      };
    }
    default: {
      const value = e.k === 'mcall' || e.k === 'scall' ? evChain(e) : ev(e);
      if (value === SHORT) return SHORT;
      if (value instanceof PhpArray || value instanceof PhpObject) runtime.frame.temporaries.push(value);
      return () => (mode === 'isset' ? definedOrNull(value) !== null : value);
    }
  }
}

function variableRead(e: Extract<Expr, { k: 'var' }>, mode: ReadMode): Value {
  const runtime = rt();
  if (e.name === 'GLOBALS') return mode === 'isset' ? true : globalsArray();
  if (mode === 'read' || (e.name === 'this' && mode === 'coalesce')) return readVar(e.name, e.row);
  if (e.name === 'this')
    return mode === 'isset' ? runtime.frame.thisObj !== undefined : (runtime.frame.thisObj ?? null);
  const ref = runtime.frame.vars.get(e.name);
  if (mode === 'isset') return ref?.isSetBinding ?? false;
  return definedOrNull(ref?.v);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Keeps operand evaluation and mode-dependent offset fetches in opcode order.
function prepareOffsetRead(e: Extract<Expr, { k: 'idx' }>, mode: ReadMode): ReadPlan {
  if (e.index === undefined) throwError('Error', 'Cannot use [] for reading');
  if (e.base.k === 'var' && e.base.name === 'GLOBALS') {
    const key = prepareOperand(e.index);
    return () => globalOffsetRead(key(), e.row, mode);
  }
  const base =
    mode === 'read' && isCompiledVariable(e.base)
      ? prepareOperand(e.base)
      : prepareRead(e.base, mode === 'read' ? 'read' : 'coalesce');
  if (base === SHORT) return SHORT;
  const index = prepareOperand(e.index);
  return () => {
    const value = base(e.row);
    if (value === SHORT) return SHORT;
    const key = index();
    rt().row = e.row;
    if (mode === 'isset') return issetOffset(value, key);
    if (value === null && mode !== 'read') return null;
    return readIndex(value, key, mode === 'empty' ? 'isset' : mode);
  };
}

function globalOffsetRead(key: Value, row: number, mode: ReadMode): Value {
  const name = checkedDynamicVariable(toStr(key));
  const runtime = rt();
  runtime.row = row;
  const ref = runtime.globalFrame.vars.get(name);
  if (mode === 'isset') return ref?.isSetBinding ?? false;
  if (name === 'this' && (mode === 'read' || mode === 'coalesce') && runtime.frame.thisObj)
    return runtime.frame.thisObj;
  if (ref?.isDefinedBinding) return ref.v;
  if (mode === 'read') warn(`Undefined global variable $${name}`);
  return null;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Retains the nullsafe receiver across operand preparation and fetch.
function preparePropertyRead(e: Extract<Expr, { k: 'prop' }>, mode: ReadMode): ReadPlan {
  let receiver =
    mode === 'read' && !e.nullsafe && isCompiledVariable(e.obj)
      ? prepareOperand(e.obj)
      : prepareRead(e.obj, mode === 'read' ? 'read' : 'coalesce');
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
    const object = receiver(e.row);
    return object === SHORT ? SHORT : readPropertyOperand(object, name(), e.row, mode);
  };
}

function readPropertyOperand(object: Value, name: Value, row: number, mode: ReadMode): Value {
  const runtime = rt();
  if (!(object instanceof PhpObject)) {
    if (mode !== 'read') return mode === 'isset' ? false : null;
    return withPropertyName(name, (key) => {
      runtime.row = row;
      warn(`Attempt to read property "${key}" on ${valueName(object)}`);
      return null;
    });
  }
  const key = toStr(name);
  runtime.row = row;
  if (mode === 'isset') return issetProp(object, key, runtime.frame.scope);
  return readProp(object, key, runtime.frame.scope, mode);
}

function readMemberOperand(name: string | Expr): (row?: number) => Value {
  return typeof name === 'string' ? () => name : prepareOperand(name);
}

function stringifyInterpolated(part: Expr): string {
  const value = ev(part);
  rt().row = compiledOperandRow(part);
  return toStr(value);
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
  if (ref?.isDefinedBinding) return ref.v;
  runtime.row = row;
  warn(`Undefined variable $${name}`);
  return null;
}

function globalsArray(): never {
  throw new UnsupportedFeatureError('スーパーグローバル変数 $GLOBALS の参照');
}

type OffsetRead = 'read' | 'isset' | 'coalesce';

export function readIndex(base: Value, index: Value, mode: OffsetRead = 'read'): Value {
  const quiet = mode !== 'read';
  if (base instanceof PhpArray) return readElement(base, toKey(index, mode === 'isset' ? 'isset' : 'access'), quiet);
  if (typeof base === 'string') return readStringOffset(base, index, mode);
  if (base instanceof PhpObject && !base.isResource) {
    if (base.cls.findMethod('offsetget') && isArrayAccess(base)) {
      if (quiet && !callOffsetExists(base, index)) return null;
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

export function stringOffset(text: string, index: Value, mode: OffsetRead = 'read'): number | undefined {
  const offset = stringOffsetIndex(index, mode);
  return offset === undefined ? undefined : stringOffsetPosition(text, offset);
}

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps type and mode decisions with their ordered offset diagnostics.
export function stringOffsetIndex(index: Value, mode: OffsetRead = 'read'): bigint | undefined {
  const quiet = mode === 'isset' || mode === 'coalesce';
  if (typeof index === 'bigint') return index;
  if (typeof index === 'string') return parseStringOffset(index, mode === 'isset', quiet);
  if (typeof index === 'number') {
    if (!quiet) warn('String offset cast occurred');
    if (mode !== 'isset') return silentFloatToInt(index);
    const offset = floatToIntCast(index);
    if (!floatFitsInt(index) || !Number.isInteger(index))
      deprecated(`Implicit conversion from float ${formatFloatForMessage(index)} to int loses precision`);
    return offset;
  }
  if (typeof index === 'boolean' || index === null) {
    if (!quiet) warn('String offset cast occurred');
    return index ? 1n : 0n;
  }
  if (mode !== 'isset') throwError('TypeError', `Cannot access offset of type ${debugType(index)} on string`);
}

function stringOffsetPosition(text: string, offset: bigint): number {
  const position = offset < 0n ? BigInt(text.length) + offset : offset;
  if (position < 0n || position >= BigInt(text.length)) return -1;
  return Number(position);
}

function parseStringOffset(index: string, isset: boolean, quiet: boolean): bigint | undefined {
  if (/^[ \t\n\r\v\f]*[+-]?\d+[ \t\n\r\v\f]*$/.test(index)) {
    const offset = BigInt(index);
    if (offset >= INT_MIN && offset <= INT_MAX) return offset;
  } else if (!isset && !numericPrefix(index)?.whole) {
    const leading = /^[ \t\n\r\v\f]*[+-]?\d+/.exec(index);
    if (leading) {
      warn(`Illegal string offset "${index}"`);
      return BigInt(leading[0].trim());
    }
  }
  if (!quiet) throwError('TypeError', 'Cannot access offset of type string on string');
}

function readStringOffset(text: string, index: Value, mode: OffsetRead): Value {
  const offset = stringOffsetIndex(index, mode);
  if (offset === undefined) return null;
  const position = stringOffsetPosition(text, offset);
  if (position < 0) {
    if (mode !== 'read') return null;
    warn(`Uninitialized string offset ${offset}`);
    return '';
  }
  return text[position];
}

export function withPropertyName<T>(name: Value, use: (key: string) => T, diagnose: (key: string) => unknown = use): T {
  let key: string;
  try {
    key = toStr(name);
  } catch (error) {
    if (!(error instanceof PhpThrow)) throw error;
    withPendingException(rt(), error, () => diagnose(''));
    throw error;
  }
  return use(key);
}

const compileTimeConstants = new Set(builtinNames.constants);
type ConstantContext = 'constant' | 'expression';
const compileTimeValues = { constant: new WeakMap<Expr, boolean>(), expression: new WeakMap<Expr, boolean>() };
const scopedCompileTimeValues = { constant: new WeakMap<Expr, boolean>(), expression: new WeakMap<Expr, boolean>() };

function arrayLiteral(e: Extract<Expr, { k: 'array' }>): PhpArray {
  const runtime = rt();
  const frame = runtime.frame;
  const array = new PhpArray(undefined, e.items.length, e.mixedStorage);
  const initializerRow = frame.scope ? e.initializerRow : (frame.initializerOpcodeRow ?? e.initializerRow);
  frame.temporaries.push(array);
  for (const item of e.items) {
    const mark = frame.temporaries.length;
    if (item.spread) spreadInto(array, ev(item.value));
    else insertArrayItem(array, item, initializerRow);
    runtime.dropTemporaries(frame, mark);
  }
  return array;
}

function insertArrayItem(
  array: PhpArray,
  item: Extract<Expr, { k: 'array' }>['items'][number],
  initializerRow: number | undefined
): void {
  const readKey = item.key === undefined ? undefined : prepareOperand(item.key);
  let slot: Value | Ref;
  if (item.byRef) {
    slot = placeOf(item.value).ref();
    slot.isRef = true;
    slot.rc++;
  } else slot = share(ev(item.value));
  const key =
    readKey === undefined
      ? undefined
      : readLiteralKey(item.key!, readKey, initializerRow ?? item.keyOpcodeRow ?? compiledOperandRow(item.value));
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

function spreadInto(array: PhpArray, value: Value): void {
  if (value instanceof PhpArray) {
    for (const [key, slot] of value.map)
      if (typeof key === 'string') array.setSlot(key, copyValueSlot(slot));
      else appendSpreadValue(array, copyValueSlot(slot));
    return;
  }
  if (value instanceof PhpObject && value.cls.isSubclassOf(rt().classes.get('traversable') as PhpClass)) {
    for (const [key, item] of iterate(value)) spreadTraversableEntry(array, key, item);
    return;
  }
  throwError(
    value instanceof PhpObject && !value.isResource ? 'TypeError' : 'Error',
    `Only arrays and Traversables can be unpacked, ${valueName(value)} given`
  );
}

function spreadTraversableEntry(array: PhpArray, key: Value, item: Value): void {
  if (typeof key !== 'string' && typeof key !== 'bigint')
    throwError('Error', 'Keys must be of type int|string during array unpacking');
  if (typeof key === 'string' && typeof toKey(key) === 'string') array.set(key, share(item));
  else appendSpreadValue(array, share(item));
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
    callIteratorMethod(iterator, 'rewind');
    while (callIteratorMethod(iterator, 'valid')) {
      runtime.spend();
      const frame = runtime.frame;
      const mark = frame.temporaries.length;
      try {
        if (slots) runtime.lastReturnRef = undefined;
        const current = fetch === 'none' ? null : callIteratorMethod(iterator, 'current');
        const reference = slots && fetch !== 'none' ? runtime.lastReturnRef : undefined;
        if (slots) runtime.lastReturnRef = undefined;
        const slot = slots ? (reference ?? nativeIteratorSlot(iterator) ?? current) : current;
        if (slots && slot instanceof Ref) runtime.holdTemporaryReference(slot);
        const key = fetch === 'both' ? callIteratorMethod(iterator, 'key') : null;
        yield [key, slot];
      } finally {
        if (slots) runtime.dropTemporaries(frame, mark);
      }
      callIteratorMethod(iterator, 'next');
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
  const value = runtime.constants.get(constantKey(name));
  if (value !== undefined) return deprecatedConstant(name, value);
  if (fallback !== undefined) {
    const global = runtime.constants.get(constantKey(fallback));
    if (global !== undefined) return deprecatedConstant(fallback, global);
  }
  rejectUnsupportedConstant(fallback ?? name);
  throwError('Error', `Undefined constant "${name}"`);
}

/** Rejects a global constant the program has not defined that PHP provides but this environment does not. */
export function rejectUnsupportedConstant(name: string): void {
  if (ENVIRONMENT_CONSTANTS.has(name)) throw new UnsupportedFeatureError(`実行環境の情報（${name}）`);
  if (builtinNames.constants.includes(name)) throw new UnsupportedFeatureError(`実行環境の機能（${name}）`);
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

function instanceOfExpression(e: Extract<Expr, { k: 'instanceof' }>): boolean {
  const readObject = prepareOperand(e.e);
  let target: PhpClass | undefined;
  if (e.cls.k === 'expr') {
    const right = ev(e.cls.e);
    rt().row = e.cls.fetchRow ?? compiledOperandRow(e.cls.e);
    if (right instanceof PhpObject && !right.isResource) target = right.cls;
    else if (typeof right === 'string') target = findClass(right);
    else throwError('Error', 'Class name must be a valid object or a string');
  } else if (e.cls.k === 'named') target = findClass(e.cls.name);
  const object = readObject(e.row);
  if (!(object instanceof PhpObject) || object.isResource) return false;
  if (e.cls.k === 'self' || e.cls.k === 'parent' || e.cls.k === 'static') target = resolveClassRef(e.cls);
  return target !== undefined && object.cls.isSubclassOf(target);
}

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
      const row = rt().row;
      return classOfOperand(ev(ref.e), ref, row);
    }
  }
}

export function resolveStaticClass(
  ref: ClassRef,
  evaluate: (expression: Expr) => Chain = evChain
): PhpClass | typeof SHORT {
  if (ref.k !== 'expr') return resolveClassRef(ref);
  const row = rt().row;
  const value = evaluate(ref.e);
  return value === SHORT ? SHORT : classOfOperand(value, ref, row);
}

function classOfOperand(value: Value, ref: Extract<ClassRef, { k: 'expr' }>, opcodeRow: number): PhpClass {
  const expression = ref.e;
  const folded = expression.k === 'lit' || (expression.k === 'bin' && expression.foldedString !== undefined);
  rt().row = ref.fetchRow ?? (folded ? opcodeRow : expression.row);
  return classOfValue(value);
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
      discardInvokedResult(() =>
        invoke(
          { fn: cloneMethod.fn, thisObj: copy, scope: cloneMethod.scope, staticClass: copy.cls, method: cloneMethod },
          [],
          runtime.row
        )
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

export function binary(e: Extract<Expr, { k: 'bin' }>): Value {
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
  const deferLeft = isCompiledVariable(e.l);
  const deferRight = isCompiledVariable(e.r);
  const left = deferLeft ? null : ev(e.l);
  if (!deferLeft) runtime.frame.temporaries.push(left);
  const right = deferRight ? null : ev(e.r);
  if (!deferRight) runtime.frame.temporaries.push(right);
  const row = compiledOperandRow(e.r);
  runtime.row = row;
  const castLeft = e.concatArrayCasts?.left ? toStr(left) : left;
  const castRight = e.concatArrayCasts?.right ? toStr(right) : right;
  if (missingCompiledOperand(e.l) || missingCompiledOperand(e.r))
    return binaryWithWarnings(e, castLeft, castRight, mark, row);
  const lval = deferLeft ? readCompiledVar(e.l, row, runtime) : castLeft;
  const rval = deferRight ? readCompiledVar(e.r, row, runtime) : castRight;
  return keepResult(mark, e.swapOperands ? operate(e.op, rval, lval) : operate(e.op, lval, rval)) as Value;
}

function readCompiledVar(e: Expr, row: number, runtime: Runtime): Value {
  const value = readVar((e as Extract<Expr, { k: 'var' }>).name, row);
  runtime.frame.temporaries.push(value);
  return value;
}

function binaryWithWarnings(
  e: Extract<Expr, { k: 'bin' }>,
  leftValue: Value,
  rightValue: Value,
  mark: number,
  row: number
): Value {
  const runtime = rt();
  const readLeft = isCompiledVariable(e.l) ? (r = e.l.row) => readCompiledVar(e.l, r, runtime) : () => leftValue;
  const readRight = isCompiledVariable(e.r) ? (r = e.r.row) => readCompiledVar(e.r, r, runtime) : () => rightValue;
  return withOperandWarnings((warning, pending) => {
    const left = readOperandWithWarning(e.l, readLeft, warning, row);
    const right = readOperandWithWarning(e.r, readRight, warning, row);
    runtime.row = row;
    return keepResult(
      mark,
      e.swapOperands ? operate(e.op, right, left, pending()) : operate(e.op, left, right, pending())
    ) as Value;
  });
}

export function missingCompiledOperand(e: Expr): boolean {
  return e.k === 'var' && isCompiledVariable(e) && !rt().frame.vars.get(e.name)?.isDefinedBinding;
}

function definedOrNull(value: Value | undefined): Value {
  return value === UNDEFINED_RESULT ? null : (value ?? null);
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
  if (e.k === 'var' && isCompiledVariable(e)) return (row = e.row) => readCompiledVar(e, row, rt());
  const value = ev(e);
  rt().frame.temporaries.push(value);
  return () => value;
}

const BINARY_OPS: Record<string, (left: Value, right: Value) => Value> = {
  xor: (left, right) => toBool(left) !== toBool(right),
  '==': looseEquals,
  '!=': (left, right) => !looseEquals(left, right),
  '===': strictEquals,
  '!==': (left, right) => !strictEquals(left, right),
  '<': (left, right) => compare(left, right) < 0,
  '<=': (left, right) => compare(left, right) <= 0,
  '>': (left, right) => compare(right, left) < 0,
  '>=': (left, right) => compare(right, left) <= 0,
  '<=>': (left, right) => BigInt(compare(left, right)),
};

function operate(op: string, left: Value, right: Value, pending?: PhpThrow): Value {
  return BINARY_OPS[op]?.(left, right) ?? applyOperator(op, left, right, pending);
}

// code-gauge-allow functionCognitiveComplexity 21 -- Keeps conversion, warning and allocation order visible for each PHP cast.
// code-gauge-allow functionNcss 35 -- Keeps conversion, warning and allocation order visible for each PHP cast.
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
      if (Number.isNaN(value)) warn('unexpected NAN value was coerced to object');
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
  const storage = object.internal as
    | { properties?: () => PhpArray; indexedProperties?: () => [bigint, Value][] }
    | undefined;
  if (storage?.properties) return storage.properties().copy();
  return classesModule.objectToArray(object, storage?.indexedProperties?.());
}
