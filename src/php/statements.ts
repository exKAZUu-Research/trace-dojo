// code-gauge-allow-file fileNcss 532 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { assignTo, bindRef, destructure, placeOf, unsetTarget } from './assignment';
import type { Expr, FunctionDecl, Program, Stmt } from './ast';
import { nestedBodies } from './astAnalysis';
import { lower } from './bytes';
import { callMethod } from './callables';
import { asInternal, invoke, setBodyRunner, setDefaultEvaluator } from './calls';
import {
  canDeclareEarly,
  declareClass,
  findClass,
  propRef,
  readProp,
  setClassEvaluator,
  visibleProps,
  writeProp,
} from './classes';
import { toBool, valueName } from './conversions';
import { E_DEPRECATED, E_WARNING, emitError, setPrevious, throwError, warn } from './errors';
import { collectBeforeAllocation, setDestructor } from './garbage';
import { ev, evBool, evQuiet, evReturn } from './interp';
import { looseEquals, setObjectConversions, toStr } from './operators';
import { ElementPlace, RefPlace, share, ValuePlace, VarPlace, writableContainer } from './places';
import { FatalError, Frame, PhpThrow, rt, type Runtime } from './runtime';
import {
  type Callable,
  type Key,
  PhpArray,
  PhpClass,
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
    if (runtime.classes.has(lower(statement.decl.name)) || !canDeclareEarly(statement.decl, declared)) continue;
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
  const fn: UserFunction = { kind: 'user', name: decl.name, decl, params: decl.params, statics: new Map() };
  runtime.functions.set(key, fn);
  runtime.userFunctions.push(fn);
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
        if (statement.e.k === 'var') evQuiet(statement.e);
        else ev(statement.e);
        runtime.steps.completeStatement(statement.row, statement.onlyCalls, mark);
        return undefined;
      }
      case 'echo': {
        const mark = runtime.steps.statementMark();
        for (const arg of statement.args) {
          runtime.echo(toStr(ev(arg)));
          runtime.dropTemporaries(frame, held);
        }
        runtime.steps.completeStatement(statement.row, true, mark);
        return undefined;
      }
      case 'inline': {
        runtime.echo(statement.text);
        return undefined;
      }
      case 'if': {
        if (evBool(statement.cond)) return execList(statement.consequent);
        return statement.alternate ? execList(statement.alternate) : undefined;
      }
      case 'while': {
        for (;;) {
          runtime.dropTemporaries(frame, held);
          runtime.row = statement.row;
          if (!evBool(statement.cond)) return undefined;
          const result = loopBody(statement.body);
          if (result !== 'next') return result;
          runtime.spend();
        }
      }
      case 'do': {
        for (;;) {
          runtime.dropTemporaries(frame, held);
          const result = loopBody(statement.body);
          if (result !== 'next') return result;
          runtime.row = statement.row;
          if (!evBool(statement.cond)) return undefined;
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
        frame.returning = share(value);
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
          const name =
            nameExpr.k === 'var' ? nameExpr.name : toStr(ev((nameExpr as Extract<Expr, { k: 'varvar' }>).name));
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
        for (const item of statement.items) defineConstant(item.name, ev(item.value));
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
    runtime.dropTemporaries(frame, held);
  }
}
/** Enters the statement that holds a label without running what comes before the label inside it. */
function seekInto(statement: Stmt, label: string): Completion {
  switch (statement.k) {
    case 'label': {
      return undefined;
    }
    case 'if': {
      if (statement.consequent.some((inner) => containsLabel(inner, label)))
        return execList(statement.consequent, label);
      return execList(statement.alternate as Stmt[], label);
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

export function defineConstant(name: string, value: Value): boolean {
  const runtime = rt();
  const key = constantKey(name);
  if (runtime.constants.has(key) || ['true', 'false', 'null'].includes(lower(name))) {
    warn(`Constant ${name} already defined, this will be an error in PHP 9`);
    return false;
  }
  runtime.constants.set(key, share(value));
  if (value instanceof PhpArray || value instanceof PhpObject) runtime.rootConstants.add(value);
  if (value instanceof PhpArray) value.persistentHolder = true;
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

// code-gauge-allow functionCognitiveComplexity 19 -- One case per statement kind, as PHP runs each kind differently.
function forStatement(statement: Extract<Stmt, { k: 'for' }>, held: number): Completion {
  const runtime = rt();
  const frame = runtime.frame;
  if (statement.init.length > 0) {
    for (const e of statement.init) ev(e);
    runtime.steps.step(statement.row);
  }
  for (;;) {
    runtime.dropTemporaries(frame, held);
    runtime.row = statement.row;
    let proceed = true;
    for (const [index, e] of statement.cond.entries()) {
      if (index === statement.cond.length - 1) proceed = evBool(e);
      else {
        ev(e);
        runtime.dropTemporaries(frame, held);
      }
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

// code-gauge-allow functionCognitiveComplexity 16 -- One case per statement kind, as PHP runs each kind differently.
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

// code-gauge-allow functionCognitiveComplexity 25 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function tryStatement(statement: Extract<Stmt, { k: 'try' }>, seek?: string): Completion {
  const runtime = rt();
  let completion: Completion;
  let pending: unknown;
  let failed = false;
  const inFinally = seek !== undefined && statement.fin?.some((inner) => containsLabel(inner, seek));
  if (!inFinally) {
    try {
      completion = tryCatchStatement(statement, seek);
    } catch (error) {
      if (!(error instanceof PhpThrow) || runtime.exhausted || !statement.fin) throw error;
      pending = error;
      failed = true;
    }
  }
  if (statement.fin) {
    const frame = runtime.frame;
    if (completion?.t === 'return') frame.temporaries.push(share(completion.v));
    if (pending instanceof PhpThrow) frame.temporaries.push(pending.object);
    let finalCompletion: Completion;
    try {
      finalCompletion = execList(statement.fin, inFinally ? seek : undefined);
    } catch (error) {
      // An exception thrown while another one unwinds takes that one as its previous one.
      if (error instanceof PhpThrow && pending instanceof PhpThrow) setPrevious(error.object, pending.object);
      throw error;
    }
    if (finalCompletion) return finalCompletion;
    if (failed) throw pending;
  }
  return completion;
}

function tryCatchStatement(statement: Extract<Stmt, { k: 'try' }>, seek?: string): Completion {
  const inCatch =
    seek === undefined
      ? undefined
      : statement.catches.find((item) => item.body.some((inner) => containsLabel(inner, seek)));
  if (inCatch) return execList(inCatch.body, seek);
  try {
    return execList(statement.body, seek);
  } catch (error) {
    if (!(error instanceof PhpThrow)) throw error;
    const handler = statement.catches.find((item) => item.types.some((name) => catches(error.object, name)));
    if (!handler) throw error;
    const runtime = rt();
    runtime.row = handler.row;
    runtime.frame.temporaries.push(error.object);
    runtime.thrown = undefined;
    collectBeforeAllocation(runtime);
    if (handler.varName !== undefined) new VarPlace(runtime.frame, handler.varName).set(error.object);
    return execList(handler.body);
  }
}

function catches(object: PhpObject, name: string): boolean {
  const cls = findClass(name);
  return cls !== undefined && object.cls.isSubclassOf(cls);
}

// code-gauge-allow functionCognitiveComplexity 27 -- One case per statement kind, as PHP runs each kind differently.
// code-gauge-allow functionNcss 34 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function foreachStatement(statement: Extract<Stmt, { k: 'foreach' }>): Completion {
  const runtime = rt();
  const frame = runtime.frame;
  if (statement.byRef) {
    runtime.lastReturnRef = undefined;
    const resolved = placeOf(statement.subject);
    const returned = ['call', 'mcall', 'scall'].includes(statement.subject.k)
      ? (runtime.lastReturnRef as Ref | undefined)
      : undefined;
    runtime.lastReturnRef = undefined;
    const place = resolved instanceof ValuePlace ? new RefPlace(returned ?? new Ref(resolved.value)) : resolved;
    const container = place.get();
    if (container instanceof PhpObject) return foreachObject(statement, container);
    if (!(container instanceof PhpArray)) {
      if (container === undefined || container === null) {
        warn(`foreach() argument must be of type array|object, ${valueName(container ?? null)} given`);
        return undefined;
      }
      warn(`foreach() argument must be of type array|object, ${valueName(container)} given`);
      return undefined;
    }
    return foreachArrayByRef(statement, writableContainer(place) as PhpArray);
  }
  const subject = ev(statement.subject);
  if (subject instanceof PhpObject) return foreachObject(statement, subject);
  if (!(subject instanceof PhpArray)) {
    warn(`foreach() argument must be of type array|object, ${valueName(subject)} given`);
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

function foreachArrayByRef(statement: Extract<Stmt, { k: 'foreach' }>, array: PhpArray): Completion {
  const runtime = rt();
  const cursor = array.cursor();
  while (cursor.key !== undefined) {
    runtime.spend();
    const key = cursor.key;
    const ref = new ElementPlace(array, key).ref();
    cursor.next();
    bindForeachRef(statement.value, ref);
    if (statement.key) assignTo(statement.key, key);
    runtime.steps.stepBinding(statement.row, true);
    const result = loopBody(statement.body);
    if (result !== 'next') return result;
  }
  return undefined;
}

function foreachIteration(
  statement: Extract<Stmt, { k: 'foreach' }>,
  key: Key | Value,
  value: Value
): 'next' | Completion {
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

/** The class of the iterator objects PHP's engine makes for foreach, which programs never see. */
const FOREACH_ITERATOR = new PhpClass('InternalIterator');

// code-gauge-allow functionCognitiveComplexity 27 -- One case per statement kind, as PHP runs each kind differently.
// code-gauge-allow functionNcss 44 -- One case per statement kind, as PHP runs each kind differently.
function foreachObject(statement: Extract<Stmt, { k: 'foreach' }>, object: PhpObject): Completion {
  const runtime = rt();
  const iterator = iteratorOf(object);
  // PHP's own array iterators let foreach change their elements by reference.
  const storage = iterator?.internal as { writable?: () => PhpArray } | undefined;
  if (iterator && statement.byRef && typeof storage?.writable === 'function') {
    return foreachArrayByRef(statement, storage.writable());
  }
  if (iterator) {
    if (statement.byRef) throwError('Error', 'An iterator cannot be used with foreach by reference');
    // PHP's engine wraps the iterator in an iterator object of its own, which takes an object handle while the loop
    // runs and releases the iterator before itself.
    const handle = runtime.newObject(FOREACH_ITERATOR);
    handle.internal = { held: () => [iterator] };
    runtime.frame.temporaries.push(handle);
    callMethod(iterator, 'rewind', []);
    while (toBool(callMethod(iterator, 'valid', []))) {
      runtime.spend();
      const value = callMethod(iterator, 'current', []);
      const key = statement.key ? callMethod(iterator, 'key', []) : null;
      const completion = foreachIteration(statement, key, value);
      if (completion !== 'next') return completion;
      callMethod(iterator, 'next', []);
    }
    return undefined;
  }
  const scope = runtime.frame.scope;
  // PHP walks the property table as it is, so a property the loop adds is visited too.
  const visited = new Set<string>();
  for (;;) {
    const name = visibleProps(object, scope).find(([candidate]) => !visited.has(candidate))?.[0];
    if (name === undefined) break;
    visited.add(name);
    runtime.spend();
    if (statement.byRef) {
      const ref = propRef(object, name, scope, 'foreach');
      bindForeachRef(statement.value, ref);
      if (statement.key) assignTo(statement.key, name);
      runtime.steps.stepBinding(statement.row, true);
      const result = loopBody(statement.body);
      if (result !== 'next') return result;
      continue;
    }
    const completion = foreachIteration(statement, name, readProp(object, name, scope, 'quiet'));
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
      throwError(
        'Exception',
        `Objects returned by ${current.cls.name}::getIterator() must be traversable or implement interface Iterator`
      );
    }
    current = next;
  }
  return current;
}

function runBody(decl: FunctionDecl, frame: Frame): Value {
  if (frame.thisObj) {
    for (const param of decl.params) {
      if (param.promote) writeProp(frame.thisObj, param.name, frame.vars.get(param.name)?.v ?? null, frame.scope);
    }
  }
  if (decl.arrowBody) return evReturn(decl.arrowBody);
  const completion = execList(decl.body);
  if (completion?.t === 'return') return completion.v;
  if (completion?.t === 'goto') throw new Error(`Unresolved goto ${completion.label}`);
  return null;
}

setBodyRunner(runBody);
setDestructor((object, row) => {
  const destructor = object.cls.findMethod('__destruct');
  if (!destructor) return;
  const run = (): Value =>
    invoke(
      { fn: destructor.fn, thisObj: object, scope: destructor.scope, staticClass: object.cls, method: destructor },
      [],
      row
    );
  if (row === undefined) asInternal(run);
  else run();
});
setObjectConversions(
  (object) => {
    const method = object.cls.findMethod('__tostring');
    if (!method) throwError('Error', `Object of class ${object.cls.name} could not be converted to string`);
    const result = invoke(
      { fn: method.fn, thisObj: object, scope: method.scope, staticClass: object.cls, method },
      [],
      undefined
    );
    return result as string;
  },
  (object) =>
    [...object.props]
      .filter(([, slot]) => slot !== UNINIT)
      .map(([key, slot]) => [key, slot instanceof Ref ? slot.v : (slot as Value)])
);
setDefaultEvaluator((decl, index) => {
  const param = decl.params[index];
  return param.defaultExpr ? share(ev(param.defaultExpr)) : null;
});
setClassEvaluator((e, cls) => {
  const runtime = rt();
  const frame = new Frame(undefined, undefined, false, undefined, cls, cls);
  frame.constantExpression = true;
  runtime.frames.push(frame);
  try {
    return ev(e);
  } finally {
    runtime.frames.pop();
  }
});

export type { Runtime };
