// code-gauge-allow-file fileNcss 1500 -- One evaluator of every statement and expression kind, which share the frame and places.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { Arg, ClassRef, Expr, FunctionDecl, ListItem, Program, Stmt } from './ast';
import { lower } from './bytes';
import {
  type ArgValue,
  type CallTarget,
  closureFunction,
  invoke,
  paramIsByRef,
  setBodyRunner,
  setDefaultEvaluator,
} from './calls';
import {
  canCall,
  canDeclareEarly,
  checkInstantiable,
  classConstant,
  createObject,
  declareClass,
  findClass,
  instantiate,
  issetProp,
  lookupMethod,
  propRef,
  readProp,
  readStaticProp,
  requireClass,
  setClassEvaluator,
  staticPropRef,
  unsetProp,
  visibleProps,
  writeProp,
} from './classes';
import * as classesModule from './classes';
import * as conversionsModule from './conversions';
import { debugType, toBool } from './conversions';
import { nestedBodies } from './converter';
import { deprecated, emitError, E_DEPRECATED, E_WARNING, notice, throwError, warn } from './errors';
import { collectGarbage, setDestructor } from './garbage';
import {
  arithmetic,
  bitwise,
  bitwiseNot,
  compare,
  concat,
  looseEquals,
  negate,
  strictEquals,
  toFloat,
  toInt,
  toKey,
  toStr,
  setObjectConversions,
  unaryPlus,
} from './operators';
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
import { ExitSignal, FatalError, Frame, PhpThrow, rt, type Runtime } from './runtime';
import { incrementString } from './strings';
import {
  type Callable,
  type ClosureData,
  isClosure,
  type Key,
  type Method,
  PhpArray,
  type PhpClass,
  PhpObject,
  Ref,
  UNINIT,
  type UserFunction,
  type Value,
} from './values';

type Completion =
  | undefined
  | { t: 'break' | 'continue'; depth: number }
  | { t: 'return'; v: Value }
  | { t: 'goto'; label: string };

const SHORT = Symbol('nullsafe');
type Chain = Value | typeof SHORT;

// Program --------------------------------------------------------------------------------------------------------------

/** Declares the functions and classes PHP binds before running, then runs the program's statements. */
export function runStatements(program: Program): void {
  const runtime = rt();
  runtime.strictTypes = program.strictTypes;
  hoist(program.body);
  for (const notice of runtime.notices) {
    emitError(notice.level === 'Deprecated' ? E_DEPRECATED : E_WARNING, notice.message, notice.row);
  }
  const completion = execList(program.body);
  if (completion?.t === 'goto') throw new Error(`Unresolved goto ${completion.label}`);
}

const hoisted = new WeakSet<Stmt>();

function hoist(body: Stmt[]): void {
  const runtime = rt();
  for (const statement of body) {
    if (statement.k === 'func') {
      declareFunction(statement.decl);
      hoisted.add(statement);
    }
  }
  const declared = new Set<string>();
  for (const statement of body) {
    if (statement.k !== 'class') continue;
    if (!canDeclareEarly(statement.decl, declared)) continue;
    runtime.row = statement.row;
    declareClass(statement.decl, statement.row);
    declared.add(lower(statement.decl.name));
    hoisted.add(statement);
  }
}

function declareFunction(decl: FunctionDecl): void {
  const runtime = rt();
  const key = lower(decl.name);
  if (runtime.functions.has(key)) {
    const existing = runtime.functions.get(key) as Callable;
    throwFatal(
      existing.kind === 'native'
        ? `Cannot redeclare function ${decl.name}()`
        : `Cannot redeclare function ${decl.name}() (previously declared in /main.php:${existing.decl.row + 1})`,
      decl.row
    );
  }
  runtime.functions.set(key, { kind: 'user', name: decl.name, decl, params: decl.params, statics: new Map() });
}

function throwFatal(message: string, row: number): never {
  throw new FatalError(message, row);
}

// Statements ---------------------------------------------------------------------------------------------------------

const labelIndexes = new WeakMap<Stmt[], Map<string, number>>();

/** The index of the statement in `statements` that holds `label`, directly or in nested blocks other than loops. */
function labelIndex(statements: Stmt[], label: string): number {
  let cache = labelIndexes.get(statements);
  if (!cache) {
    cache = new Map();
    labelIndexes.set(statements, cache);
  }
  const cached = cache.get(label);
  if (cached !== undefined) return cached;
  const index = statements.findIndex((statement) => containsLabel(statement, label));
  cache.set(label, index);
  return index;
}

function containsLabel(statement: Stmt, label: string): boolean {
  if (statement.k === 'label') return statement.name === label;
  return nestedBodies(statement).some(([body, isLoop]) => !isLoop && body.some((inner) => containsLabel(inner, label)));
}

/** Runs statements, jumping to a label they hold when `seek` names one or a `goto` targets one. */
function execList(statements: Stmt[], seek?: string): Completion {
  let index = 0;
  let target = seek;
  if (target !== undefined) index = Math.max(labelIndex(statements, target), 0);
  while (index < statements.length) {
    const completion = execStmt(statements[index], target);
    target = undefined;
    if (completion) {
      if (completion.t === 'goto') {
        const found = labelIndex(statements, completion.label);
        if (found !== -1) {
          index = found;
          target = completion.label;
          rt().spend();
          continue;
        }
      }
      return completion;
    }
    index++;
  }
  return undefined;
}

// code-gauge-allow functionNcss 130 -- One case per statement kind, each delegating where it grows.
// code-gauge-allow functionCognitiveComplexity 60 -- One case per statement kind, each delegating where it grows.
function execStmt(statement: Stmt, seek?: string): Completion {
  const runtime = rt();
  if (seek !== undefined) return seekInto(statement, seek);
  runtime.row = statement.row;
  runtime.spend();
  const frame = runtime.frame;
  const held = frame.temporaries.length;
  try {
    switch (statement.k) {
      case 'expr': {
        const mark = runtime.steps.statementMark();
        ev(statement.e);
        runtime.steps.completeStatement(statement.row, statement.onlyCalls, mark);
        return undefined;
      }
      case 'echo': {
        const mark = runtime.steps.statementMark();
        for (const arg of statement.args) runtime.echo(toStr(ev(arg)));
        runtime.steps.completeStatement(statement.row, true, mark);
        return undefined;
      }
      case 'inline': {
        runtime.echo(statement.text);
        return undefined;
      }
      case 'if': {
        if (toBool(ev(statement.cond))) return execList(statement.then);
        return statement.else ? execList(statement.else) : undefined;
      }
      case 'while': {
        for (;;) {
          frame.temporaries.length = held;
          runtime.row = statement.row;
          if (!toBool(ev(statement.cond))) return undefined;
          const result = loopBody(statement.body);
          if (result !== 'next') return result;
          runtime.spend();
        }
      }
      case 'do': {
        for (;;) {
          frame.temporaries.length = held;
          const result = loopBody(statement.body);
          if (result !== 'next') return result;
          runtime.row = statement.row;
          if (!toBool(ev(statement.cond))) return undefined;
          runtime.spend();
        }
      }
      case 'for': {
        return forStatement(statement, held);
      }
      case 'foreach': {
        return foreachStatement(statement);
      }
      case 'switch': {
        return switchStatement(statement);
      }
      case 'break':
      case 'continue': {
        return { t: statement.k, depth: statement.depth };
      }
      case 'return': {
        const value = statement.e ? evReturn(statement.e) : null;
        return { t: 'return', v: value };
      }
      case 'block': {
        return execList(statement.body);
      }
      case 'try': {
        return tryStatement(statement);
      }
      case 'global': {
        for (const nameExpr of statement.names) {
          const name = nameExpr.k === 'var' ? nameExpr.name : toStr(ev((nameExpr as Extract<Expr, { k: 'varvar' }>).name));
          new VarPlace(frame, name).bind(runtime.globalRef(name));
        }
        return undefined;
      }
      case 'static': {
        staticDeclaration(statement, frame);
        return undefined;
      }
      case 'unset': {
        const mark = runtime.steps.statementMark();
        for (const target of statement.targets) unsetTarget(target);
        runtime.steps.completeStatement(statement.row, false, mark);
        return undefined;
      }
      case 'func': {
        if (!hoisted.has(statement)) declareFunction(statement.decl);
        return undefined;
      }
      case 'class': {
        if (!hoisted.has(statement)) declareClass(statement.decl, statement.row);
        return undefined;
      }
      case 'const': {
        for (const item of statement.items) defineConstant(item.name, ev(item.value), true);
        return undefined;
      }
      case 'goto': {
        return { t: 'goto', label: statement.label };
      }
      case 'label':
      case 'nop': {
        return undefined;
      }
    }
  } finally {
    frame.temporaries.length = held;
    if (runtime.destructibles > 0 && !runtime.shuttingDown) collectGarbage(runtime);
  }
}

/** Enters the statement that holds a label without running what comes before the label inside it. */
function seekInto(statement: Stmt, label: string): Completion {
  switch (statement.k) {
    case 'label': {
      return undefined;
    }
    case 'if': {
      if (statement.then.some((inner) => containsLabel(inner, label))) return execList(statement.then, label);
      return execList(statement.else as Stmt[], label);
    }
    case 'block': {
      return execList(statement.body, label);
    }
    case 'try': {
      return tryStatement(statement, label);
    }
    default: {
      return undefined;
    }
  }
}

export function defineConstant(name: string, value: Value, fromConst: boolean): boolean {
  const runtime = rt();
  const key = constantKey(name);
  if (runtime.constants.has(key) || ['true', 'false', 'null'].includes(lower(name))) {
    warn(`Constant ${name} already defined, this will be an error in PHP 9`);
    return false;
  }
  if (value instanceof PhpObject && !fromConst) {
    // define() accepts objects since PHP 8.1.
  }
  runtime.constants.set(key, share(value));
  return true;
}

/** The key of a constant: its namespace is case-insensitive, its own name is not. */
export function constantKey(name: string): string {
  const slash = name.lastIndexOf('\\');
  if (slash === -1) return name;
  return lower(name.slice(0, slash)) + name.slice(slash);
}

function loopBody(body: Stmt[]): 'next' | Completion {
  const completion = execList(body);
  if (!completion) return 'next';
  if (completion.t === 'break') return completion.depth > 1 ? { t: 'break', depth: completion.depth - 1 } : undefined;
  if (completion.t === 'continue') {
    return completion.depth > 1 ? { t: 'continue', depth: completion.depth - 1 } : 'next';
  }
  return completion;
}

function forStatement(statement: Extract<Stmt, { k: 'for' }>, held: number): Completion {
  const runtime = rt();
  const frame = runtime.frame;
  if (statement.init.length > 0) {
    for (const e of statement.init) ev(e);
    runtime.steps.step(statement.row);
  }
  for (;;) {
    frame.temporaries.length = held;
    runtime.row = statement.row;
    let proceed = true;
    for (const [index, e] of statement.cond.entries()) {
      const value = ev(e);
      if (index === statement.cond.length - 1) proceed = toBool(value);
    }
    if (!proceed) return undefined;
    const result = loopBody(statement.body);
    if (result !== 'next') return result;
    if (statement.update.length > 0) {
      runtime.row = statement.row;
      for (const e of statement.update) ev(e);
      runtime.steps.step(statement.row);
    }
    runtime.spend();
  }
}

function switchStatement(statement: Extract<Stmt, { k: 'switch' }>): Completion {
  const subject = ev(statement.subject);
  let start = -1;
  for (const [index, item] of statement.cases.entries()) {
    if (item.test === undefined) continue;
    rt().row = item.row;
    if (looseEquals(subject, ev(item.test))) {
      start = index;
      break;
    }
  }
  if (start === -1) start = statement.cases.findIndex((item) => item.test === undefined);
  if (start === -1) return undefined;
  for (const item of statement.cases.slice(start)) {
    const completion = execList(item.body);
    if (!completion) continue;
    if (completion.t === 'break' || completion.t === 'continue') {
      if (completion.depth > 1) return { t: completion.t, depth: completion.depth - 1 };
      return undefined;
    }
    return completion;
  }
  return undefined;
}

function staticDeclaration(statement: Extract<Stmt, { k: 'static' }>, frame: Frame): void {
  const fn = frame.fn;
  const statics = fn?.kind === 'user' ? fn.statics : rt().globalFrame.vars;
  for (const { name, init } of statement.vars) {
    let ref = fn?.kind === 'user' ? statics.get(name) : undefined;
    if (!ref) {
      ref = new Ref(init ? share(ev(init)) : null);
      ref.isRef = true;
      if (fn?.kind === 'user') statics.set(name, ref);
    }
    new VarPlace(frame, name).bind(ref);
  }
}

// code-gauge-allow functionCognitiveComplexity 30 -- Try statements follow PHP's order of catch and finally.
function tryStatement(statement: Extract<Stmt, { k: 'try' }>, seek?: string): Completion {
  const runtime = rt();
  let completion: Completion;
  let pending: unknown;
  let failed = false;
  const inFinally = seek !== undefined && statement.fin?.some((inner) => containsLabel(inner, seek));
  if (!inFinally) {
    try {
      const inCatch = seek === undefined ? undefined : statement.catches.find((item) => item.body.some((inner) => containsLabel(inner, seek)));
      completion = inCatch ? execList(inCatch.body, seek) : execList(statement.body, seek);
    } catch (error) {
      if (!(error instanceof PhpThrow)) {
        if (statement.fin && !(error instanceof ExitSignal) && !(error instanceof ExecutionLimitError)) {
          pending = error;
          failed = true;
        } else throw error;
      } else {
        const handler = statement.catches.find((item) => item.types.some((name) => catches(error.object, name)));
        if (handler) {
          try {
            runtime.row = handler.row;
            if (handler.varName !== undefined) new VarPlace(runtime.frame, handler.varName).set(error.object);
            completion = execList(handler.body);
          } catch (inner) {
            if (!statement.fin) throw inner;
            pending = inner;
            failed = true;
          }
        } else if (statement.fin) {
          pending = error;
          failed = true;
        } else throw error;
      }
    }
  }
  if (statement.fin) {
    const frame = runtime.frame;
    if (completion?.t === 'return') frame.temporaries.push(completion.v);
    if (pending instanceof PhpThrow) frame.temporaries.push(pending.object);
    const finalCompletion = execList(statement.fin, inFinally ? seek : undefined);
    if (finalCompletion) return finalCompletion;
    if (failed) throw pending;
  }
  return completion;
}

function catches(object: PhpObject, name: string): boolean {
  const cls = findClass(name);
  return cls !== undefined && object.cls.isSubclassOf(cls);
}

// code-gauge-allow functionCognitiveComplexity 40 -- Foreach follows PHP's iteration over arrays, references, and objects.
function foreachStatement(statement: Extract<Stmt, { k: 'foreach' }>): Completion {
  const runtime = rt();
  const frame = runtime.frame;
  if (statement.byRef) {
    const place = placeOf(statement.subject);
    const container = place.get();
    if (container instanceof PhpObject) return foreachObject(statement, container);
    if (!(container instanceof PhpArray)) {
      if (container === undefined || container === null) {
        warn(`foreach() argument must be of type array|object, ${debugType(container ?? null)} given`);
        return undefined;
      }
      warn(`foreach() argument must be of type array|object, ${debugType(container)} given`);
      return undefined;
    }
    const array = writableContainer(place) as PhpArray;
    for (const key of array.map.keys()) {
      runtime.spend();
      if (!array.map.has(key)) continue;
      const ref = new ElementPlace(array, key).ref();
      bindForeachRef(statement.value, ref);
      if (statement.key) assignTo(statement.key, key);
      runtime.steps.stepBinding(statement.row, true);
      const result = loopBody(statement.body);
      if (result !== 'next') return result;
    }
    return undefined;
  }
  const subject = ev(statement.subject);
  if (subject instanceof PhpObject) return foreachObject(statement, subject);
  if (!(subject instanceof PhpArray)) {
    warn(`foreach() argument must be of type array|object, ${debugType(subject)} given`);
    return undefined;
  }
  subject.shared = true;
  frame.temporaries.push(subject);
  for (const [key, slot] of subject.map) {
    runtime.spend();
    const value = slot instanceof Ref ? slot.v : slot;
    const completion = foreachIteration(statement, key, value);
    if (completion !== 'next') return completion;
  }
  return undefined;
}

function foreachIteration(statement: Extract<Stmt, { k: 'foreach' }>, key: Key | Value, value: Value): 'next' | Completion {
  const runtime = rt();
  runtime.row = statement.row;
  if (statement.value.k === 'list') destructure(statement.value, value);
  else assignTo(statement.value, share(value));
  if (statement.key) assignTo(statement.key, key as Value);
  runtime.steps.stepBinding(statement.row, statement.value.k === 'list' || storesAnswer(value));
  return loopBody(statement.body);
}

/** Whether a foreach binding stores a value learners answer, as Java's primitives and strings are. */
function storesAnswer(value: Value): boolean {
  return value !== null && !(value instanceof PhpObject) && !(value instanceof PhpArray);
}

function bindForeachRef(target: Expr, ref: Ref): void {
  if (target.k === 'var') new VarPlace(rt().frame, target.name).bind(ref);
  else bindRef(target, ref);
}

// code-gauge-allow functionCognitiveComplexity 25 -- Iteration over Iterator, IteratorAggregate, and plain objects.
function foreachObject(statement: Extract<Stmt, { k: 'foreach' }>, object: PhpObject): Completion {
  const runtime = rt();
  const iterator = iteratorOf(object);
  if (iterator) {
    runtime.frame.temporaries.push(iterator);
    callMethod(iterator, 'rewind', []);
    while (toBool(callMethod(iterator, 'valid', []))) {
      runtime.spend();
      const value = callMethod(iterator, 'current', []);
      const key = statement.key ? callMethod(iterator, 'key', []) : null;
      if (statement.byRef) throwError('Error', 'An iterator cannot be used with foreach by reference');
      const completion = foreachIteration(statement, key, value);
      if (completion !== 'next') return completion;
      callMethod(iterator, 'next', []);
    }
    return undefined;
  }
  const scope = runtime.frame.scope;
  for (const [name] of visibleProps(object, scope)) {
    runtime.spend();
    if (statement.byRef) {
      const ref = propRef(object, name, scope);
      bindForeachRef(statement.value, ref);
      if (statement.key) assignTo(statement.key, name);
      runtime.steps.stepBinding(statement.row, true);
      const result = loopBody(statement.body);
      if (result !== 'next') return result;
      continue;
    }
    const completion = foreachIteration(statement, name, readProp(object, name, scope, true));
    if (completion !== 'next') return completion;
  }
  return undefined;
}

/** The Iterator an object iterates with: itself, or what `getIterator` returns; undefined for plain objects. */
export function iteratorOf(object: PhpObject): PhpObject | undefined {
  const runtime = rt();
  const iteratorClass = runtime.classes.get('iterator') as PhpClass;
  const aggregate = runtime.classes.get('iteratoraggregate') as PhpClass;
  let current = object;
  for (let depth = 0; depth < 32; depth++) {
    if (current.cls.isSubclassOf(iteratorClass)) return current;
    if (!current.cls.isSubclassOf(aggregate)) return depth === 0 ? undefined : current;
    const next = callMethod(current, 'getIterator', []);
    if (!(next instanceof PhpObject) || !next.cls.isSubclassOf(runtime.classes.get('traversable') as PhpClass)) {
      throwError('Exception', `Objects returned by ${current.cls.name}::getIterator() must be traversable or implement interface Iterator`);
    }
    current = next;
  }
  return current;
}

// Expressions --------------------------------------------------------------------------------------------------------

/** Evaluates an expression whose value a `return` passes to the caller, which keeps it alive meanwhile. */
function evReturn(e: Expr): Value {
  const frame = rt().frame;
  const fn = frame.fn;
  if (fn?.kind === 'user' && fn.decl.byRefReturn) {
    if (['var', 'idx', 'prop', 'sprop'].includes(e.k)) {
      const ref = placeOf(e).ref();
      ref.isRef = true;
      frame.returnRef = ref;
      return ref.v;
    }
    notice('Only variable references should be returned by reference');
  }
  return ev(e);
}

export function ev(e: Expr): Value {
  const value = evChain(e);
  return value === SHORT ? null : value;
}

// code-gauge-allow functionNcss 260 -- One case per expression kind, each delegating where it grows.
// code-gauge-allow functionCognitiveComplexity 90 -- One case per expression kind, each delegating where it grows.
function evChain(e: Expr): Chain {
  const runtime = rt();
  switch (e.k) {
    case 'lit': {
      return e.v;
    }
    case 'interp': {
      let text = '';
      for (const part of e.parts) {
        text += typeof part === 'string' ? part : toStr(ev(part));
        if (text.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
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
        warn(`Attempt to read property "${name}" on ${debugType(object)}`);
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
      return keepingResult(() => callExpression(e));
    }
    case 'mcall': {
      return keepingResult(() => methodCallExpression(e));
    }
    case 'scall': {
      return keepingResult(() => staticCallExpression(e));
    }
    case 'new': {
      return keepingResult(() => {
        runtime.row = e.row;
        const cls = resolveClassRef(e.cls);
        checkInstantiable(cls);
        const constructor = cls.findMethod('__construct');
        const args = evalArgs(e.args, constructor?.fn, constructor ? `${constructor.scope.name}::__construct` : undefined);
        runtime.row = e.row;
        return instantiate(cls, args, e.row, runtime.frame.scope);
      });
    }
    case 'newAnon': {
      return keepingResult(() => {
        runtime.row = e.row;
        const cls = anonymousClass(e.decl, e.row);
        const constructor = cls.findMethod('__construct');
        const args = evalArgs(e.args, constructor?.fn, constructor ? `${constructor.scope.name}::__construct` : undefined);
        return instantiate(cls, args, e.row, runtime.frame.scope);
      });
    }
    case 'assign': {
      if (e.target.k === 'list') {
        const value = ev(e.value);
        runtime.frame.temporaries.push(value);
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
      const test = ev(e.test);
      if (e.then === undefined) return toBool(test) ? test : ev(e.else);
      return toBool(test) ? ev(e.then) : ev(e.else);
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
      if (!(value instanceof PhpObject)) return false;
      if (e.cls.k === 'expr') {
        const right = ev(e.cls.e);
        if (right instanceof PhpObject) return value.cls.isSubclassOf(right.cls);
        if (typeof right === 'string') {
          const cls = findClass(right);
          return cls !== undefined && value.cls.isSubclassOf(cls);
        }
        throwError('Error', 'Class name must be a valid object or a string');
      }
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
      runtime.echo(toStr(ev(e.e)));
      return 1n;
    }
    case 'exit': {
      const value = e.e ? ev(e.e) : null;
      if (typeof value === 'string') {
        runtime.echo(value);
        throw new ExitSignal(0);
      }
      if (value === null) throw new ExitSignal(0);
      if (typeof value === 'bigint') throw new ExitSignal(Number(value));
      if (typeof value === 'boolean' || typeof value === 'number') {
        // PHP 8.4 treats exit() as a function taking string|int.
        if (typeof value === 'boolean') throw new ExitSignal(value ? 1 : 0);
        deprecated(`Implicit conversion from float ${value} to int loses precision`);
        throw new ExitSignal(Math.trunc(value));
      }
      throwError('TypeError', `exit(): Argument #1 ($status) must be of type string|int, ${debugType(value)} given`);
    }
    case 'pipe': {
      const value = ev(e.l);
      runtime.frame.temporaries.push(value);
      const callable = ev(e.r);
      runtime.row = e.row;
      return callValue(callable, [{ v: value }], e.row);
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
  const frame = rt().frame;
  const mark = frame.temporaries.length;
  const result = run();
  frame.temporaries.length = mark;
  if (result instanceof PhpObject || result instanceof PhpArray) frame.temporaries.push(result);
  return result;
}

function isThrowableObject(object: PhpObject): boolean {
  const throwable = rt().classes.get('throwable');
  return throwable !== undefined && object.cls.isSubclassOf(throwable);
}

/** Evaluates an expression without the warnings an undefined variable or key would raise, as `??` and `empty` do. */
function evQuiet(e: Expr): Value {
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
      const base = evQuiet(e.base);
      const index = ev(e.index);
      if (base === null) return null;
      return readIndex(base, index, true);
    }
    case 'prop': {
      const object = evQuiet(e.obj);
      if (!(object instanceof PhpObject)) return null;
      const name = memberName(e.name);
      const scope = runtime.frame.scope;
      if (!issetProp(object, name, scope)) return null;
      return readProp(object, name, scope, true);
    }
    case 'sprop': {
      const cls = resolveClassRef(e.cls);
      const name = typeof e.name === 'string' ? e.name : toStr(ev(e.name));
      const found = cls.findStatic(name);
      if (!found) return null;
      return readStaticProp(cls, name, runtime.frame.scope);
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

// code-gauge-allow functionCognitiveComplexity 30 -- Index reads follow PHP's rules per container type.
export function readIndex(base: Value, index: Value, quiet: boolean): Value {
  if (base instanceof PhpArray) return readElement(base, toKey(index), quiet);
  if (typeof base === 'string') return readStringOffset(base, index, quiet);
  if (base instanceof PhpObject) {
    if (base.cls.findMethod('offsetget') && isArrayAccess(base)) {
      if (quiet && !toBool(callMethod(base, 'offsetExists', [index]))) return null;
      return callMethod(base, 'offsetGet', [index]);
    }
    throwError('Error', `Cannot use object of type ${base.cls.name} as array`);
  }
  if (!quiet) warn(`Trying to access array offset on ${debugType(base)}`);
  return null;
}

function isArrayAccess(object: PhpObject): boolean {
  const arrayAccess = rt().classes.get('arrayaccess');
  return arrayAccess !== undefined && object.cls.isSubclassOf(arrayAccess);
}

function stringOffset(text: string, index: Value, quiet: boolean): number | undefined {
  let offset: bigint;
  if (typeof index === 'bigint') offset = index;
  else if (typeof index === 'string') {
    if (/^-?\d+$/.test(index)) offset = BigInt(index);
    else {
      const leading = /^[ \t\n\r\v\f]*-?\d+/.exec(index);
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
  if (position < 0n || position >= BigInt(text.length)) return -1 - Number(offset < 0n ? offset : offset);
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

function memberName(name: string | Expr): string {
  return typeof name === 'string' ? name : toStr(ev(name));
}

// code-gauge-allow functionCognitiveComplexity 25 -- Array literals follow PHP's rules for keys, spreads, and references.
function arrayLiteral(e: Extract<Expr, { k: 'array' }>): PhpArray {
  const runtime = rt();
  const array = new PhpArray();
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
        if (!array.append(ref)) throwError('Error', 'Cannot add element to the array as the next element is already occupied');
      } else array.setSlot(key, ref);
      continue;
    }
    const value = share(ev(item.value));
    if (key === undefined) {
      if (!array.append(value)) throwError('Error', 'Cannot add element to the array as the next element is already occupied');
    } else array.set(key, value);
    runtime.spend();
  }
  return array;
}

function spreadInto(array: PhpArray, value: Value): void {
  if (value instanceof PhpArray) {
    for (const [key, item] of value.entries()) {
      if (typeof key === 'string') array.set(key, share(item));
      else if (!array.append(share(item))) throwError('Error', 'Cannot add element to the array as the next element is already occupied');
    }
    return;
  }
  if (value instanceof PhpObject) {
    for (const [key, item] of iterate(value)) {
      if (typeof key === 'string') array.set(key, share(item));
      else if (typeof key === 'bigint') array.append(share(item));
      else throwError('Error', 'Keys must be of type int|string during array unpacking');
    }
    return;
  }
  throwError('Error', 'Only arrays and Traversables can be unpacked');
}

/** Iterates over an array or a Traversable object, as `foreach` would. */
export function* iterate(value: Value): Generator<[Value, Value]> {
  if (value instanceof PhpArray) {
    for (const entry of value.entries()) yield entry;
    return;
  }
  if (value instanceof PhpObject) {
    const iterator = iteratorOf(value);
    if (!iterator) {
      for (const entry of visibleProps(value, rt().frame.scope)) yield entry;
      return;
    }
    callMethod(iterator, 'rewind', []);
    while (toBool(callMethod(iterator, 'valid', []))) {
      rt().spend();
      const current = callMethod(iterator, 'current', []);
      const key = callMethod(iterator, 'key', []);
      yield [key, current];
      callMethod(iterator, 'next', []);
    }
  }
}

function readConstant(name: string, fallback: string | undefined): Value {
  const runtime = rt();
  const value = runtime.constants.get(constantKey(name));
  if (value !== undefined) return value;
  if (fallback !== undefined) {
    const global = runtime.constants.get(fallback);
    if (global !== undefined) return global;
  }
  throwError('Error', `Undefined constant "${name}"`);
}

function magicConstant(name: Extract<Expr, { k: 'magic' }>['name']): Value {
  const frame = rt().frame;
  const decl = frame.decl;
  switch (name) {
    case '__CLASS__': {
      if (frame.closure) return (frame.closure.internal as ClosureData).scope?.name ?? '';
      return frame.scope?.name ?? '';
    }
    case '__FUNCTION__': {
      if (!decl) return '';
      if (decl.isClosure) return `{closure:/main.php:${decl.row + 1}}`;
      return frame.method ? frame.method.name : decl.name;
    }
    case '__METHOD__': {
      if (!decl) return '';
      if (decl.isClosure) return `{closure:/main.php:${decl.row + 1}}`;
      if (frame.method) return `${frame.method.scope.name}::${frame.method.name}`;
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
      if (!frame.scope) throwError('Error', 'Cannot use "self" when no class scope is active');
      return frame.scope;
    }
    case 'parent': {
      if (!frame.scope) throwError('Error', 'Cannot use "parent" when no class scope is active');
      if (!frame.scope.parent) throwError('Error', 'Cannot use "parent" when current class scope has no parent');
      return frame.scope.parent;
    }
    case 'static': {
      if (!frame.staticClass) throwError('Error', 'Cannot use "static" when no class scope is active');
      return frame.staticClass;
    }
    case 'expr': {
      const value = ev(ref.e);
      if (value instanceof PhpObject) return value.cls;
      if (typeof value === 'string') return requireClass(value);
      throwError('Error', 'Cannot use value of type ' + debugType(value) + ' as class name');
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
      return value.cls.name;
    }
    return resolveClassRef(e.cls).name;
  }
  const cls = resolveClassRef(e.cls);
  runtime.row = e.row;
  return classConstant(cls, e.name, runtime.frame.scope);
}

const anonymousClasses = new WeakMap<object, PhpClass>();

function anonymousClass(decl: import('./ast').ClassDecl, row: number): PhpClass {
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
  const withValue = e.with ? ev(e.with) : undefined;
  runtime.row = e.row;
  if (!(value instanceof PhpObject)) throwError('Error', '__clone method called on non-object');
  return cloneObject(value, withValue);
}

export function cloneObject(original: PhpObject, withValue?: Value): PhpObject {
  const runtime = rt();
  const scope = runtime.frame.scope;
  const cloneMethod = original.cls.findMethod('__clone');
  if (cloneMethod && !canCall(cloneMethod, scope)) {
    throwError('Error', `Call to ${cloneMethod.visibility} ${original.cls.name}::__clone() from ${scope ? `scope ${scope.name}` : 'global scope'}`);
  }
  if (original.cls.name === 'Closure' || original.cls.name === 'Generator') {
    if (original.cls.name === 'Generator') throwError('Error', 'Trying to clone an uncloneable object of class Generator');
  }
  const copy = runtime.newObject(original.cls);
  runtime.frame.temporaries.push(copy);
  for (const [key, slot] of original.props) {
    if (slot instanceof Ref) {
      if (slot.rc > 1) {
        slot.rc++;
        copy.props.set(key, slot);
      } else copy.props.set(key, share(slot.v));
    } else copy.props.set(key, typeof slot === 'symbol' ? slot : share(slot));
  }
  copy.internal = cloneInternal(original);
  copy.cloning = true;
  try {
    if (cloneMethod) {
      invoke({ fn: cloneMethod.fn, thisObj: copy, scope: cloneMethod.scope, staticClass: copy.cls, method: cloneMethod }, [], runtime.row);
    }
    if (withValue !== undefined) {
      if (!(withValue instanceof PhpArray)) {
        throwError('TypeError', `clone(): Argument #2 ($withProperties) must be of type array, ${debugType(withValue)} given`);
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

function cloneInternal(original: PhpObject): unknown {
  const internal = original.internal as { clone?: () => unknown } | undefined;
  if (internal && typeof internal.clone === 'function') return internal.clone();
  if (isClosure(original)) return { ...(original.internal as ClosureData) };
  return internal;
}

// Assignment ---------------------------------------------------------------------------------------------------------

/** The location a writable expression names, evaluating its keys and creating containers as PHP's writes do. */
// code-gauge-allow functionCognitiveComplexity 35 -- One case per writable expression kind.
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
      const container = writableContainer(parent);
      if (container instanceof PhpArray) return new ElementPlace(container, key === undefined ? undefined : toKey(key));
      if (container instanceof PhpObject) return arrayAccessPlace(container, key);
      return stringOffsetPlace(parent, container, key);
    }
    case 'prop': {
      const object = ev(e.obj);
      const name = memberName(e.name);
      runtime.row = e.row;
      if (!(object instanceof PhpObject)) {
        if (object === null) throwError('Error', `Attempt to assign property "${name}" on null`);
        throwError('Error', `Attempt to assign property "${name}" on ${debugType(object)}`);
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
    private readonly decl: import('./values').PropDecl | undefined
  ) {
    super(target);
  }

  override set(value: Value): void {
    if (this.decl?.type) {
      const { coerceProperty } = classesModule;
      this.target.v = coerceProperty(this.decl, value);
      return;
    }
    this.target.v = value;
  }
}


function propPlace(object: PhpObject, name: string): Place {
  const scope = rt().frame.scope;
  return {
    get: () => {
      if (!issetPropExists(object, name, scope)) {
        const magic = object.cls.findMethod('__get');
        if (!magic) return undefined;
      }
      return readProp(object, name, scope, true);
    },
    set: (value) => writeProp(object, name, value, scope),
    ref: () => propRef(object, name, scope),
    unset: () => unsetProp(object, name, scope),
  };
}

function issetPropExists(object: PhpObject, name: string, scope: PhpClass | undefined): boolean {
  const decl = classesModule.lookupProp(object.cls, name, scope);
  if (decl && !decl.isStatic) return object.props.has(decl.key);
  return object.props.has(name);
}

function arrayAccessPlace(object: PhpObject, key: Value | undefined): Place {
  if (!isArrayAccess(object)) throwError('Error', `Cannot use object of type ${object.cls.name} as array`);
  return {
    get: () => callMethod(object, 'offsetGet', [key ?? null]),
    set: (value) => {
      callMethod(object, 'offsetSet', [key ?? null, value]);
    },
    ref: () => {
      const value = callMethod(object, 'offsetGet', [key ?? null]);
      if (!(value instanceof PhpObject)) notice(`Indirect modification of overloaded element of ${object.cls.name} has no effect`);
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
          return;
        }
        offset = requested;
      }
      let character = toStr(value);
      if (character === '') throwError('Error', 'Cannot assign an empty string to a string offset');
      if (character.length > 1) {
        warn('Only the first byte will be assigned to the string offset');
        character = character[0];
      }
      const padded = offset >= text.length ? text + ' '.repeat(offset - text.length) + character : text;
      const updated = offset >= text.length ? padded : text.slice(0, offset) + character + text.slice(offset + 1);
      parent.set(updated);
    },
    ref: () => {
      throwError('Error', 'Cannot create references to/from string offsets');
    },
    unset: () => {
      throwError('Error', 'Cannot unset string offsets');
    },
  };
}

function assignExpression(target: Expr, valueExpr: Expr): Value {
  const runtime = rt();
  if (target.k === 'var' && target.name !== 'this') {
    const value = share(ev(valueExpr));
    const frame = runtime.frame;
    const ref = frame.vars.get(target.name);
    if (ref) ref.v = value;
    else frame.vars.set(target.name, new Ref(value));
    return value;
  }
  const place = placeOf(target);
  const value = ev(valueExpr);
  runtime.row = target.row;
  place.set(share(value));
  return value;
}

/** Assigns a value to a writable expression, as a foreach binding or list() element does. */
export function assignTo(target: Expr, value: Value): void {
  if (target.k === 'list') {
    destructure(target, value);
    return;
  }
  placeOf(target).set(share(value));
}

function bindRef(target: Expr, ref: Ref): void {
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
    const container = writableContainer(parent);
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
    const decl = classesModule.lookupProp(object.cls, name, rt().frame.scope);
    ref.isRef = true;
    ref.rc++;
    object.props.set(decl && !decl.isStatic ? decl.key : name, ref);
    return;
  }
  if (target.k === 'sprop') {
    const cls = resolveClassRef(target.cls);
    const name = typeof target.name === 'string' ? target.name : toStr(ev(target.name));
    const found = cls.findStatic(name);
    if (!found) throwError('Error', `Access to undeclared static property ${cls.name}::$${name}`);
    ref.isRef = true;
    found.ref.v = ref.v;
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

function assignReference(target: Expr, source: Expr): Value {
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

// code-gauge-allow functionCognitiveComplexity 25 -- List destructuring follows PHP's warnings per source type.
function destructure(target: Extract<Expr, { k: 'list' }>, value: Value): void {
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

// code-gauge-allow functionCognitiveComplexity 25 -- Compound assignment follows PHP's order of evaluation.
function compoundAssign(e: Extract<Expr, { k: 'assignOp' }>): Value {
  const runtime = rt();
  if (e.op === '??') {
    if (isset(e.target)) {
      const current = evQuiet(e.target);
      if (current !== null) return current;
    }
    const place = placeOf(e.target);
    const value = ev(e.value);
    place.set(share(value));
    return value;
  }
  const place = placeOf(e.target);
  const value = ev(e.value);
  runtime.row = e.row;
  let current = place.get();
  if (current === undefined) {
    if (e.target.k === 'var' || e.target.k === 'varvar') warn(`Undefined variable $${(place as VarPlace).name}`);
    else if (e.target.k === 'idx' && place instanceof ElementPlace && place.key !== undefined) {
      warn(`Undefined array key ${typeof place.key === 'bigint' ? place.key : `"${place.key}"`}`);
    } else if (e.target.k === 'prop') warn(`Undefined property: ${''}`);
    current = null;
  }
  const result = applyOperator(e.op, current, value);
  place.set(share(result));
  return result;
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

// code-gauge-allow functionCognitiveComplexity 30 -- Increment and decrement follow PHP's rules per type.
function incDec(e: Extract<Expr, { k: 'incdec' }>): Value {
  const runtime = rt();
  const place = placeOf(e.target);
  runtime.row = e.row;
  let old = place.get();
  if (old === undefined) {
    if (e.target.k === 'var' || e.target.k === 'varvar') warn(`Undefined variable $${(place as VarPlace).name}`);
    else if (place instanceof ElementPlace && place.key !== undefined) {
      warn(`Undefined array key ${typeof place.key === 'bigint' ? place.key : `"${place.key}"`}`);
    }
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
    warn(`${e.inc ? 'Increment' : 'Decrement'} on type bool has no effect, this will change in the next major version of PHP`);
    updated = old;
  } else if (typeof old === 'string') {
    updated = incDecString(old, e.inc);
  } else if (old instanceof PhpArray) {
    throwError('TypeError', `Cannot ${e.inc ? 'increment' : 'decrement'} array`);
  } else {
    throwError('TypeError', `Cannot ${e.inc ? 'increment' : 'decrement'} ${(old as PhpObject).cls.name}`);
  }
  place.set(updated);
  return e.prefix ? updated : old;
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


function unsetTarget(target: Expr): void {
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
      const base = unsetContainer(target.base);
      const index = ev(target.index);
      if (base === undefined) return;
      if (base instanceof PhpArray) base.delete(toKey(index));
      else if (base instanceof PhpObject) {
        if (!isArrayAccess(base)) throwError('Error', `Cannot use object of type ${base.cls.name} as array`);
        callMethod(base, 'offsetUnset', [index]);
      } else if (typeof base === 'string') throwError('Error', 'Cannot unset string offsets');
      return;
    }
    case 'prop': {
      const object = ev(target.obj);
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
  if (e.k === 'var' || e.k === 'varvar' || e.k === 'idx' || e.k === 'prop' || e.k === 'sprop') {
    if (e.k === 'idx' && e.base.k === 'var' && e.base.name === 'GLOBALS' && e.index) {
      const name = toStr(ev(e.index));
      new VarPlace(rt().globalFrame, name).unset();
      return undefined;
    }
    if (!isset(e) && !(e.k === 'prop')) return undefined;
    const place = placeOf(e);
    const value = place.get();
    if (value instanceof PhpArray) return writableContainer(place) as PhpArray;
    if (value instanceof PhpObject || typeof value === 'string') return value;
    return undefined;
  }
  const value = ev(e);
  return value instanceof PhpArray || value instanceof PhpObject ? value : undefined;
}

// code-gauge-allow functionCognitiveComplexity 25 -- Isset follows PHP's rules per expression kind.
function isset(e: Expr): boolean {
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
      if (!isset(e.base) && !(e.base.k === 'call' || e.base.k === 'mcall' || e.base.k === 'scall' || e.base.k === 'array' || e.base.k === 'lit' || e.base.k === 'const' || e.base.k === 'cconst')) return false;
      const base = evQuiet(e.base);
      const index = ev(e.index);
      if (base instanceof PhpArray) return (base.get(toKey(index)) ?? null) !== null;
      if (typeof base === 'string') {
        if (typeof index === 'string' && !/^\s*-?\d+\s*$/.test(index)) return false;
        const position = stringOffset(base, index, true);
        return position !== undefined && position >= 0;
      }
      if (base instanceof PhpObject && isArrayAccess(base)) return toBool(callMethod(base, 'offsetExists', [index]));
      return false;
    }
    case 'prop': {
      const object = e.obj.k === 'var' || e.obj.k === 'idx' || e.obj.k === 'prop' ? (isset(e.obj) ? evQuiet(e.obj) : null) : ev(e.obj);
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

// Operators ----------------------------------------------------------------------------------------------------------

// code-gauge-allow functionCognitiveComplexity 30 -- One case per binary operator.
function binary(e: Extract<Expr, { k: 'bin' }>): Value {
  const runtime = rt();
  switch (e.op) {
    case '&&':
    case 'and': {
      return toBool(ev(e.l)) && toBool(ev(e.r));
    }
    case '||':
    case 'or': {
      return toBool(ev(e.l)) || toBool(ev(e.r));
    }
    case 'xor': {
      return toBool(ev(e.l)) !== toBool(ev(e.r));
    }
    case '??': {
      const left = isset(e.l) ? evQuiet(e.l) : null;
      return left === null ? ev(e.r) : left;
    }
  }
  const left = ev(e.l);
  runtime.frame.temporaries.push(left);
  const right = ev(e.r);
  runtime.row = e.row;
  switch (e.op) {
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
      return applyOperator(e.op, left, right);
    }
  }
}

function compareForOrder(left: Value, right: Value): number {
  return compare(left, right);
}

export function cast(type: string, value: Value): Value {
  switch (type) {
    case 'int': {
      return castToInt(value);
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
      return PhpArray.list([value]);
    }
    case 'object': {
      if (value instanceof PhpObject) return value;
      const object = createObject(rt().classes.get('stdclass') as PhpClass);
      if (value instanceof PhpArray) {
        for (const [key, item] of value.entries()) object.props.set(String(key), share(item));
      } else if (value !== null) object.props.set('scalar', value);
      return object;
    }
    default: {
      throwError('Error', `Unknown cast ${type}`);
    }
  }
}

function castToInt(value: Value): Value {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && !conversionsModule.floatFitsInt(value)) {
      warn(`The float ${conversionsModule.formatFloat(value, 17)} is not representable as an int, cast occurred`);
      return BigInt.asIntN(64, BigInt(Math.trunc(value)));
    }
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      warn(`The float ${conversionsModule.formatFloat(value)} is not representable as an int, cast occurred`);
      return 0n;
    }
  }
  return toInt(value);
}

function objectToArrayCast(object: PhpObject): PhpArray {
  if (isClosure(object)) return PhpArray.list([object]);
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
    const escaped = value.slice(0, 15).replaceAll(/[\\']/g, '\\$&').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
    return `'${escaped}${value.length > 15 ? '...' : ''}'`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return conversionsModule.formatFloatRepr(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'NULL';
  return `of type ${debugType(value)}`;
}

// Calls --------------------------------------------------------------------------------------------------------------

/** Evaluates call arguments, binding by-reference parameters to locations. */
export function evalArgs(args: Arg[], fn: Callable | undefined, name: string | undefined): ArgValue[] {
  const runtime = rt();
  const values: ArgValue[] = [];
  const frame = runtime.frame;
  for (const [index, arg] of args.entries()) {
    if (arg.spread) {
      const value = ev(arg.e);
      if (value instanceof PhpArray) {
        for (const [key, item] of value.entries()) {
          if (typeof key === 'string') values.push({ v: share(item), name: key });
          else {
            if (values.some((other) => other.name !== undefined)) {
              throwError('Error', 'Cannot use positional argument after named argument during unpacking');
            }
            const position = values.length;
            if (fn && paramIsByRef(fn, position)) values.push({ v: item, ref: new ElementPlace(value, key).ref() });
            else values.push({ v: share(item) });
          }
        }
      } else if (value instanceof PhpObject) {
        for (const [key, item] of iterate(value)) {
          if (typeof key === 'string') values.push({ v: share(item), name: key });
          else values.push({ v: share(item) });
        }
      } else throwError('TypeError', 'Only arrays and Traversables can be unpacked');
      continue;
    }
    const position = arg.name === undefined ? values.length : -1;
    const byRef = fn ? paramIsByRef(fn, position, arg.name) : false;
    if (byRef) {
      const e = arg.e;
      if (['var', 'varvar', 'idx', 'prop', 'sprop'].includes(e.k)) {
        const ref = placeOf(e).ref();
        values.push({ v: ref.v, ref, name: arg.name });
        continue;
      }
      const value = ev(e);
      const param = fn?.params[Math.min(position === -1 ? 0 : position, (fn?.params.length ?? 1) - 1)];
      if (param?.preferRef) {
        values.push({ v: value, name: arg.name });
        continue;
      }
      if (e.k === 'call' || e.k === 'mcall' || e.k === 'scall') {
        notice('Only variables should be passed by reference');
        values.push({ v: value, ref: new Ref(value), name: arg.name });
        continue;
      }
      const label = name ?? fn?.name ?? '';
      const paramIndex = arg.name === undefined ? index : (fn?.params.findIndex((param) => param.name === arg.name) ?? 0);
      const paramName = fn?.params[Math.min(paramIndex, (fn?.params.length ?? 1) - 1)]?.name ?? '';
      throwError('Error', `${label}(): Argument #${paramIndex + 1} ($${paramName}) could not be passed by reference`);
    }
    const value = ev(arg.e);
    frame.temporaries.push(value);
    values.push({ v: value, name: arg.name });
  }
  return values;
}

function callExpression(e: Extract<Expr, { k: 'call' }>): Value {
  const runtime = rt();
  runtime.row = e.row;
  if (!('k' in e.fn)) {
    const name = e.fn;
    const fn = runtime.functions.get(lower(name.name)) ?? (name.fallback ? runtime.functions.get(lower(name.fallback)) : undefined);
    if (!fn) throwError('Error', `Call to undefined function ${name.name}()`);
    if (e.fcc) return closureFromCallable({ fn });
    const args = evalArgs(e.args, fn, fn.name);
    runtime.row = e.row;
    const result = invoke({ fn }, args, e.row);
    runtime.frame.temporaries.push(result);
    return result;
  }
  const callee = ev(e.fn);
  runtime.row = e.row;
  const target = callTargetOf(callee, true);
  if (e.fcc) return closureFromCallable(target);
  const args = evalArgs(e.args, target.fn, functionNameFor(target));
  runtime.row = e.row;
  const result = invoke(target, args, e.row);
  runtime.frame.temporaries.push(result);
  return result;
}

function functionNameFor(target: CallTarget): string {
  return target.method ? `${target.method.scope.name}::${target.method.name}` : target.fn.name;
}

// code-gauge-allow functionCognitiveComplexity 30 -- Method calls follow PHP's lookup with visibility and __call.
function methodCallExpression(e: Extract<Expr, { k: 'mcall' }>): Chain {
  const runtime = rt();
  const object = evChain(e.obj);
  if (object === SHORT) return SHORT;
  if (e.nullsafe && object === null) return SHORT;
  const name = typeof e.name === 'string' ? e.name : undefined;
  let methodName: string;
  if (name !== undefined) methodName = name;
  else {
    const value = ev(e.name as Expr);
    if (value instanceof PhpObject && isClosure(value)) {
      throwError('Error', 'Method name must be a string');
    }
    methodName = toStr(value);
  }
  runtime.row = e.row;
  if (!(object instanceof PhpObject)) {
    throwError('Error', `Call to a member function ${methodName}() on ${debugType(object)}`);
  }
  runtime.frame.temporaries.push(object);
  const scope = runtime.frame.scope;
  const method = lookupMethod(object.cls, lower(methodName), scope);
  if (method && !method.isAbstract && canCall(method, scope)) {
    const target: CallTarget = method.isStatic
      ? { fn: method.fn, scope: method.scope, staticClass: object.cls, method }
      : { fn: method.fn, thisObj: object, scope: method.scope, staticClass: object.cls, method };
    if (e.fcc) return closureFromCallable(target);
    const args = evalArgs(e.args, method.fn, `${method.scope.name}::${method.name}`);
    runtime.row = e.row;
    const result = invoke(target, args, e.row);
    runtime.frame.temporaries.push(result);
    return result;
  }
  if (isClosure(object) && lower(methodName) === '__invoke') {
    const target = closureTarget(object);
    if (e.fcc) return object;
    const args = evalArgs(e.args, target.fn, functionNameFor(target));
    return invoke(target, args, e.row);
  }
  const magic = object.cls.findMethod('__call');
  if (magic) {
    const args = evalArgs(e.args, undefined, undefined);
    if (e.fcc) return magicClosure(object, magic, methodName);
    return invoke(
      { fn: magic.fn, thisObj: object, scope: magic.scope, staticClass: object.cls, method: magic },
      [{ v: methodName }, { v: argsArray(args) }],
      e.row
    );
  }
  if (method) {
    if (method.isAbstract) throwError('Error', `Cannot call abstract method ${method.scope.name}::${method.name}()`);
    throwError('Error', `Call to ${method.visibility} method ${object.cls.name}::${method.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`);
  }
  throwError('Error', `Call to undefined method ${object.cls.isAnonymous ? 'class@anonymous' : object.cls.name}::${methodName}()`);
}

function argsArray(args: ArgValue[]): PhpArray {
  const array = new PhpArray();
  for (const arg of args) {
    if (arg.name !== undefined) array.set(arg.name, arg.v);
    else array.append(arg.v);
  }
  return array;
}

function magicClosure(object: PhpObject, magic: Method, methodName: string): PhpObject {
  const native: Callable = {
    kind: 'native',
    name: methodName,
    params: [{ name: 'args', byRef: false, variadic: true, optional: true }],
    impl: ({ args }) =>
      invoke({ fn: magic.fn, thisObj: object, scope: magic.scope, staticClass: object.cls, method: magic }, [{ v: methodName }, { v: PhpArray.list(args) }], undefined),
  };
  return closureFromCallable({ fn: native, thisObj: object, scope: object.cls });
}

// code-gauge-allow functionCognitiveComplexity 35 -- Static calls follow PHP's rules for parent::, self::, and instance forwarding.
function staticCallExpression(e: Extract<Expr, { k: 'scall' }>): Value {
  const runtime = rt();
  const frame = runtime.frame;
  runtime.row = e.row;
  const cls = resolveClassRef(e.cls);
  const methodName = typeof e.name === 'string' ? e.name : toStr(ev(e.name));
  runtime.row = e.row;
  const scope = frame.scope;
  const method = lookupMethod(cls, lower(methodName), scope);
  const forwarding = e.cls.k === 'parent' || e.cls.k === 'self' || e.cls.k === 'static';
  const thisObj = frame.thisObj && frame.thisObj.cls.isSubclassOf(cls) ? frame.thisObj : undefined;
  if (method && canCall(method, scope)) {
    if (method.isAbstract) throwError('Error', `Cannot call abstract method ${method.scope.name}::${method.name}()`);
    let target: CallTarget;
    if (method.isStatic) {
      const staticClass = forwarding && frame.staticClass ? frame.staticClass : cls;
      target = { fn: method.fn, scope: method.scope, staticClass, method };
    } else if (thisObj) {
      target = { fn: method.fn, thisObj, scope: method.scope, staticClass: thisObj.cls, method };
    } else {
      throwError('Error', `Non-static method ${method.scope.name}::${method.name}() cannot be called statically`);
    }
    if (e.fcc) return closureFromCallable(target);
    const args = evalArgs(e.args, method.fn, `${method.scope.name}::${method.name}`);
    runtime.row = e.row;
    const result = invoke(target, args, e.row);
    frame.temporaries.push(result);
    return result;
  }
  if (thisObj) {
    const magic = thisObj.cls.findMethod('__call');
    if (magic) {
      const args = evalArgs(e.args, undefined, undefined);
      return invoke({ fn: magic.fn, thisObj, scope: magic.scope, staticClass: thisObj.cls, method: magic }, [{ v: methodName }, { v: argsArray(args) }], e.row);
    }
  }
  const magicStatic = cls.findMethod('__callstatic');
  if (magicStatic) {
    const args = evalArgs(e.args, undefined, undefined);
    return invoke({ fn: magicStatic.fn, scope: magicStatic.scope, staticClass: cls, method: magicStatic }, [{ v: methodName }, { v: argsArray(args) }], e.row);
  }
  if (method) {
    throwError('Error', `Call to ${method.visibility} method ${cls.name}::${method.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`);
  }
  throwError('Error', `Call to undefined method ${cls.name}::${methodName}()`);
}

/** Calls a method of an object by name, as native code calls `offsetGet` or `__toString`. */
export function callMethod(object: PhpObject, name: string, args: Value[]): Value {
  const method = object.cls.findMethod(lower(name));
  if (!method) {
    const magic = object.cls.findMethod('__call');
    if (magic) {
      return invoke(
        { fn: magic.fn, thisObj: object, scope: magic.scope, staticClass: object.cls, method: magic },
        [{ v: name }, { v: PhpArray.list(args) }],
        undefined
      );
    }
    throwError('Error', `Call to undefined method ${object.cls.name}::${name}()`);
  }
  return invoke(
    { fn: method.fn, thisObj: method.isStatic ? undefined : object, scope: method.scope, staticClass: object.cls, method },
    args.map((v) => ({ v })),
    undefined
  );
}

// Callables ----------------------------------------------------------------------------------------------------------

export function closureTarget(closure: PhpObject): CallTarget {
  const data = closure.internal as ClosureData;
  return {
    fn: data.fn,
    thisObj: data.thisObj,
    scope: data.scope,
    staticClass: data.calledClass ?? data.thisObj?.cls ?? data.scope,
    method: data.method,
    closure: data.fn.kind === 'user' && data.fn.decl.isClosure ? closure : undefined,
  };
}

/**
 * The function a callable value names: a closure, an invokable object, a function name, `"Class::method"`, or
 * `[$objectOrClass, "method"]`.
 */
// code-gauge-allow functionCognitiveComplexity 35 -- Resolves each form of PHP callable.
export function callTargetOf(value: Value, forCall: boolean): CallTarget {
  const runtime = rt();
  const scope = runtime.frame.scope;
  if (value instanceof PhpObject) {
    if (isClosure(value)) return closureTarget(value);
    const invokeMethod = value.cls.findMethod('__invoke');
    if (invokeMethod) return { fn: invokeMethod.fn, thisObj: value, scope: invokeMethod.scope, staticClass: value.cls, method: invokeMethod };
    if (forCall) throwError('Error', 'Object of type ' + value.cls.name + ' is not callable');
    throwError('Error', 'Object of type ' + value.cls.name + ' is not callable');
  }
  if (typeof value === 'string') {
    const separator = value.indexOf('::');
    if (separator !== -1) return staticCallable(value.slice(0, separator), value.slice(separator + 2), scope);
    const fn = runtime.functions.get(lower(value.startsWith('\\') ? value.slice(1) : value));
    if (!fn) throwError('Error', `Call to undefined function ${value}()`);
    return { fn };
  }
  if (value instanceof PhpArray && value.size === 2) {
    const target = value.get(0n);
    const method = value.get(1n);
    if (typeof method === 'string' && target instanceof PhpObject) {
      const found = lookupMethod(target.cls, lower(method.replace(/^parent::/i, '')), scope);
      if (found && canCall(found, scope)) {
        return found.isStatic
          ? { fn: found.fn, scope: found.scope, staticClass: target.cls, method: found }
          : { fn: found.fn, thisObj: target, scope: found.scope, staticClass: target.cls, method: found };
      }
      const magic = target.cls.findMethod('__call');
      if (magic) return magicTarget(target, magic, method);
      if (found) throwError('Error', `Call to ${found.visibility} method ${target.cls.name}::${found.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`);
      throwError('Error', `Call to undefined method ${target.cls.name}::${method}()`);
    }
    if (typeof method === 'string' && typeof target === 'string') return staticCallable(target, method, scope);
  }
  if (value instanceof PhpArray) throwError('Error', 'Array callback must have exactly two elements');
  throwError('Error', 'Value not callable');
}

function magicTarget(object: PhpObject, magic: Method, name: string): CallTarget {
  const native: Callable = {
    kind: 'native',
    name,
    params: [{ name: 'args', byRef: false, variadic: true, optional: true }],
    impl: ({ args }) =>
      invoke({ fn: magic.fn, thisObj: object, scope: magic.scope, staticClass: object.cls, method: magic }, [{ v: name }, { v: PhpArray.list(args) }], undefined),
  };
  return { fn: native, thisObj: object };
}

function staticCallable(className: string, methodName: string, scope: PhpClass | undefined): CallTarget {
  const frame = rt().frame;
  let cls: PhpClass;
  const word = lower(className);
  if (word === 'self' || word === 'static' || word === 'parent') {
    if (!frame.scope) throwError('Error', `Cannot use "${word}" when no class scope is active`);
    cls = word === 'self' ? frame.scope : word === 'parent' ? (frame.scope.parent as PhpClass) : (frame.staticClass as PhpClass);
  } else cls = requireClass(className);
  const method = lookupMethod(cls, lower(methodName), scope);
  if (!method) {
    const magic = cls.findMethod('__callstatic');
    if (magic) {
      const native: Callable = {
        kind: 'native',
        name: methodName,
        params: [{ name: 'args', byRef: false, variadic: true, optional: true }],
        impl: ({ args }) => invoke({ fn: magic.fn, scope: magic.scope, staticClass: cls, method: magic }, [{ v: methodName }, { v: PhpArray.list(args) }], undefined),
      };
      return { fn: native, staticClass: cls };
    }
    throwError('Error', `Call to undefined method ${cls.name}::${methodName}()`);
  }
  if (!canCall(method, scope)) throwError('Error', `Call to ${method.visibility} method ${cls.name}::${method.name}() from ${scope ? `scope ${scope.name}` : 'global scope'}`);
  if (!method.isStatic) {
    const thisObj = frame.thisObj && frame.thisObj.cls.isSubclassOf(cls) ? frame.thisObj : undefined;
    if (!thisObj) throwError('Error', `Non-static method ${method.scope.name}::${method.name}() cannot be called statically`);
    return { fn: method.fn, thisObj, scope: method.scope, staticClass: thisObj.cls, method };
  }
  return { fn: method.fn, scope: method.scope, staticClass: cls, method };
}

/** Calls a callable value with arguments already evaluated, as `call_user_func` and `$f(...)` do. */
export function callValue(callable: Value, args: ArgValue[], row: number | undefined): Value {
  const target = callTargetOf(callable, true);
  const bound = args.map((arg, index) => {
    if (arg.ref) return arg;
    if (paramIsByRef(target.fn, index, arg.name) && target.fn.kind === 'user') {
      return { ...arg, ref: new Ref(arg.v) };
    }
    return arg;
  });
  return invoke(target, bound, row);
}

/** Calls a callback from native code, such as `array_map`'s, whose frames show as `[internal function]`. */
export function callCallback(callable: Value, args: Value[]): Value {
  const target = callTargetOf(callable, true);
  return invoke(target, args.map((v) => ({ v })), undefined);
}

/** Calls a callback with references for its by-reference parameters, as `array_walk` does. */
export function callCallbackRefs(callable: Value, args: ArgValue[]): Value {
  const target = callTargetOf(callable, true);
  return invoke(target, args, undefined);
}

export function closureFromCallable(target: CallTarget): PhpObject {
  const runtime = rt();
  const closureClass = runtime.classes.get('closure') as PhpClass;
  const object = runtime.newObject(closureClass);
  const data: ClosureData = {
    fn: target.fn,
    bound: new Map(),
    thisObj: target.thisObj,
    scope: target.scope,
    calledClass: target.staticClass,
    isStatic: !target.thisObj,
    method: target.method,
  };
  object.internal = data;
  runtime.frame.temporaries.push(object);
  return object;
}

function createClosure(e: Extract<Expr, { k: 'closure' }>): PhpObject {
  const runtime = rt();
  const frame = runtime.frame;
  const fn = closureFunction(e.fn);
  const bound = new Map<string, Ref>();
  for (const use of e.uses) {
    if (use.byRef) {
      const ref = new VarPlace(frame, use.name).ref();
      ref.isRef = true;
      ref.rc++;
      bound.set(use.name, ref);
    } else {
      const ref = frame.vars.get(use.name);
      if (!ref) {
        runtime.row = e.row;
        warn(`Undefined variable $${use.name}`);
      }
      bound.set(use.name, new Ref(share(ref?.v ?? null)));
    }
  }
  return newClosure(fn, bound, e.isStatic, frame);
}

function createArrow(e: Extract<Expr, { k: 'arrow' }>): PhpObject {
  const frame = rt().frame;
  const fn = closureFunction(e.fn);
  const bound = new Map<string, Ref>();
  for (const name of e.fn.captures ?? []) {
    const ref = frame.vars.get(name);
    if (ref) bound.set(name, new Ref(share(ref.v)));
  }
  return newClosure(fn, bound, e.isStatic, frame);
}

function newClosure(fn: UserFunction, bound: Map<string, Ref>, isStatic: boolean, frame: Frame): PhpObject {
  const runtime = rt();
  const object = runtime.newObject(runtime.classes.get('closure') as PhpClass);
  object.internal = {
    fn,
    bound,
    thisObj: isStatic ? undefined : frame.thisObj,
    scope: frame.scope,
    calledClass: frame.staticClass,
    isStatic,
  } satisfies ClosureData;
  frame.temporaries.push(object);
  return object;
}

// Function bodies ----------------------------------------------------------------------------------------------------

function runBody(decl: FunctionDecl, frame: Frame): Value {
  if (frame.thisObj) {
    for (const param of decl.params) {
      if (param.promote) writeProp(frame.thisObj, param.name, frame.vars.get(param.name)?.v ?? null, frame.scope);
    }
  }
  if (decl.arrowBody) return ev(decl.arrowBody);
  const completion = execList(decl.body);
  if (completion?.t === 'return') return completion.v;
  if (completion?.t === 'goto') throw new Error(`Unresolved goto ${completion.label}`);
  return null;
}

setBodyRunner(runBody);
setDestructor((object) => {
  const destructor = object.cls.findMethod('__destruct');
  if (!destructor) return;
  invoke({ fn: destructor.fn, thisObj: object, scope: destructor.scope, staticClass: object.cls, method: destructor }, [], undefined);
});
setObjectConversions(
  (object) => {
    const method = object.cls.findMethod('__tostring');
    if (!method) throwError('Error', `Object of class ${object.cls.isAnonymous ? 'class@anonymous' : object.cls.name} could not be converted to string`);
    const result = invoke({ fn: method.fn, thisObj: object, scope: method.scope, staticClass: object.cls, method }, [], undefined);
    if (typeof result !== 'string') throwError('Error', `${object.cls.name}::__toString(): Return value must be of type string, ${debugType(result)} returned`);
    return result;
  },
  (object) => [...object.props].filter(([, slot]) => slot !== UNINIT).map(([key, slot]) => [key, slot instanceof Ref ? slot.v : (slot as Value)])
);
setDefaultEvaluator((decl, index) => {
  const param = decl.params[index];
  return param.defaultExpr ? share(ev(param.defaultExpr)) : null;
});
setClassEvaluator((e, cls) => {
  const runtime = rt();
  const frame = new Frame(undefined, undefined, false, undefined, cls, cls);
  runtime.frames.push(frame);
  try {
    return ev(e);
  } finally {
    runtime.frames.pop();
  }
});

export type { Runtime };
