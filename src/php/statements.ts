// code-gauge-allow-file fileNcss 830 -- Runs PHP statements iteratively on a heap block stack with shared loop/try/foreach helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { CompileError } from '../interpreter/diagnostics';
import type { ArrayCursor } from './arrayOrder';
import { assignTo, bindRef, destructure, foreachSubjectPlace, unsetTarget } from './assignment';
import type { Expr, FunctionDecl, Program, Stmt } from './ast';
import { foreachReferences, nestedBodies } from './astAnalysis';
import { lower } from './bytes';
import { consumeInvokedResult, discardInvokedResult } from './callables';
import { asInternal, invoke, setBodyRunner, setDefaultEvaluator } from './calls';
import {
  bindPropertyReference,
  canDeclareEarly,
  declareClass,
  findClass,
  propNameOf,
  propRef,
  readProp,
  setClassEvaluator,
  visiblePropertyKeys,
  writeProp,
} from './classes';
import { valueName } from './conversions';
import { E_DEPRECATED, E_WARNING, emitError, setPrevious, throwError, warn, withPendingException } from './errors';
import { collectBeforeAllocation, setDestructor } from './garbage';
import { binary, consumeExpression, ev, evBool, evOpcodeOperand, evQuiet, evReturn, prepareOperand } from './interp';
import { acquireIterator, InnerIterator } from './iteratorAcquisition';
import { builtinLiteralKey } from './native';
import { compiledOperandRow } from './opcodeRows';
import { looseEquals, setObjectToString, toStr } from './operators';
import { ElementPlace, RefPlace, share, ValuePlace, VarPlace, writableContainer } from './places';
import { ExitSignal, FatalError, Frame, PhpThrow, rt, type Runtime } from './runtime';
import {
  type Callable,
  deref,
  type Key,
  nativeOwnershipChanged,
  PhpArray,
  type PhpClass,
  PhpObject,
  Ref,
  UNDEFINED_RESULT,
  type UserFunction,
  type Value,
} from './values';

type Completion =
  | undefined
  | { t: 'break' | 'continue'; depth: number }
  | { t: 'return'; slot: Value | Ref; row: number }
  | { t: 'goto'; label: string };

// Program --------------------------------------------------------------------------------------------------------------

/** Declares the functions and classes PHP binds before running, then runs the program's statements. */
export function runStatements(program: Program, conversionError?: CompileError): void {
  const runtime = rt();
  runtime.strictTypes = program.strictTypes;
  hoist(program.body, conversionError);
  if (conversionError) throw conversionError;
  const completion = execList(program.body);
  if (completion?.t === 'goto') throw new Error(`Unresolved goto ${completion.label}`);
}

const hoisted = new WeakSet<Stmt>();

function hoist(body: Stmt[], conversionError?: CompileError): void {
  const runtime = rt();
  const declared = new Set<string>();
  let noticeIndex = 0;
  const publishNotices = (through: number): void => {
    while (runtime.notices[noticeIndex]?.row <= through) {
      const notice = runtime.notices[noticeIndex++];
      emitError(notice.level === 'Deprecated' ? E_DEPRECATED : E_WARNING, notice.message, notice.row);
    }
  };
  for (const statement of body) {
    if (statement.k === 'func') {
      publishNotices(statement.decl.endRow);
      declareFunction(statement.decl);
      hoisted.add(statement);
      continue;
    }
    if (statement.k !== 'class') continue;
    publishNotices(statement.decl.endRow);
    if (runtime.classes.has(lower(statement.decl.name)) || !canDeclareEarly(statement.decl, declared)) continue;
    runtime.row = statement.row;
    declareClass(statement.decl, statement.row);
    declared.add(lower(statement.decl.name));
    hoisted.add(statement);
  }
  if (!conversionError) publishNotices(Number.POSITIVE_INFINITY);
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

type BlockFrame =
  | { k: 'list'; stmts: Stmt[]; index: number; seek?: string; stmtHeld?: number }
  | { k: 'while'; stmt: Extract<Stmt, { k: 'while' }>; held: number; started: boolean }
  | { k: 'do'; stmt: Extract<Stmt, { k: 'do' }>; held: number; started: boolean }
  | { k: 'for'; stmt: Extract<Stmt, { k: 'for' }>; held: number; started: boolean }
  | { k: 'switch'; cases: Extract<Stmt, { k: 'switch' }>['cases']; index: number }
  | {
      k: 'foreachArray';
      stmt: Extract<Stmt, { k: 'foreach' }>;
      subject: PhpArray;
      iter: Iterator<[Key, Value | Ref]>;
    }
  | {
      k: 'try';
      stmt: Extract<Stmt, { k: 'try' }>;
      phase: 'try' | 'catch' | 'finally';
      completion?: Completion;
      pending?: PhpThrow;
      finMark?: number;
    };

/** Runs statements iteratively on a heap block stack so nested control flow does not grow the host stack. */
// code-gauge-allow functionCognitiveComplexity 29 -- Keeps the active list/statement hot path in one JS frame so deep PHP recursion fits the host stack.
// code-gauge-allow functionNcss 50 -- Keeps return and expr inline in the iterative block loop.
export function execList(statements: Stmt[], seek?: string): Completion {
  const runtime = rt();
  const frame = runtime.frame;
  const byRefReturn = frame.fn?.kind === 'user' && frame.fn.decl.byRefReturn;
  const stack: BlockFrame[] = [
    { k: 'list', stmts: statements, index: seek === undefined ? 0 : Math.max(labelIndex(statements, seek), 0), seek },
  ];
  let completion: Completion;
  while (stack.length > 0) {
    try {
      if (completion !== undefined) {
        completion = propagateCompletion(stack, completion, runtime, frame);
        continue;
      }
      const top = stack.at(-1) as BlockFrame;
      if (top.k !== 'list') {
        completion = stepNonListFrame(stack, top, runtime, frame);
        continue;
      }
      releaseListHeld(top, runtime, frame);
      if (top.index >= top.stmts.length) {
        stack.pop();
        continue;
      }
      const statement = top.stmts[top.index++];
      if (top.seek !== undefined) {
        seekIntoStack(stack, statement, top.seek, frame);
        top.seek = undefined;
        continue;
      }
      runtime.row = statement.row;
      runtime.spend();
      const held = frame.temporaries.length;
      top.stmtHeld = held;
      if (statement.k === 'return' && !byRefReturn && statement.e) {
        const value = statement.e.k === 'bin' ? (statement.e.foldedString ?? binary(statement.e)) : ev(statement.e);
        frame.returning = share(value);
        releaseListHeld(top, runtime, frame);
        completion = { t: 'return', slot: frame.returning, row: statement.e.row };
      } else if (statement.k === 'expr') {
        const mark = runtime.steps.statementMark();
        if (statement.e.k === 'var') evQuiet(statement.e);
        else ev(statement.e, true);
        runtime.steps.completeStatement(statement.row, statement.onlyCalls, mark);
        releaseListHeld(top, runtime, frame);
      } else {
        completion = dispatchOtherStatement(stack, statement, runtime, frame, held);
        if (stack.at(-1) === top) releaseListHeld(top, runtime, frame);
      }
    } catch (error) {
      unwindStackOnThrow(stack, error, runtime, frame);
      completion = undefined;
    }
  }
  return completion;
}

function releaseListHeld(top: Extract<BlockFrame, { k: 'list' }>, runtime: Runtime, frame: Frame): void {
  if (top.stmtHeld === undefined) return;
  const held = top.stmtHeld;
  top.stmtHeld = undefined;
  runtime.dropTemporaries(frame, held);
}

function pushListFrame(stack: BlockFrame[], statements: Stmt[], seek?: string): void {
  stack.push({
    k: 'list',
    stmts: statements,
    index: seek === undefined ? 0 : Math.max(labelIndex(statements, seek), 0),
    seek,
  });
}

// code-gauge-allow functionCognitiveComplexity 23 -- Flat switch over non-list iterative block frame kinds.
// code-gauge-allow functionNcss 55 -- One case per control-flow frame kind (while, do, for, switch, foreach, try).
function stepNonListFrame(
  stack: BlockFrame[],
  top: Exclude<BlockFrame, { k: 'list' }>,
  runtime: Runtime,
  frame: Frame
): Completion {
  switch (top.k) {
    case 'while': {
      if (top.started) runtime.spend();
      top.started = true;
      runtime.dropTemporaries(frame, top.held);
      runtime.row = top.stmt.row;
      if (!evBool(top.stmt.cond)) {
        stack.pop();
        return undefined;
      }
      pushListFrame(stack, top.stmt.body);
      return undefined;
    }
    case 'do': {
      if (top.started) {
        runtime.row = top.stmt.row;
        if (!evBool(top.stmt.cond)) {
          stack.pop();
          return undefined;
        }
        runtime.spend();
      }
      top.started = true;
      runtime.dropTemporaries(frame, top.held);
      pushListFrame(stack, top.stmt.body);
      return undefined;
    }
    case 'for': {
      if (top.started) {
        runForClause(top.stmt.update, top.stmt.row, frame, top.held);
        runtime.spend();
      }
      top.started = true;
      runtime.row = top.stmt.row;
      for (const [index, e] of top.stmt.cond.entries()) {
        if (!evaluateForExpression(e, frame, top.held, index === top.stmt.cond.length - 1)) {
          stack.pop();
          return undefined;
        }
      }
      pushListFrame(stack, top.stmt.body);
      return undefined;
    }
    case 'switch': {
      if (top.index >= top.cases.length) {
        stack.pop();
        return undefined;
      }
      pushListFrame(stack, top.cases[top.index++].body);
      return undefined;
    }
    case 'foreachArray': {
      const next = top.iter.next();
      if (next.done) {
        frame.foreachSubjects.pop();
        stack.pop();
        return undefined;
      }
      runtime.spend();
      const [key, slot] = next.value;
      bindForeachValue(top.stmt, key, slot instanceof Ref ? slot.v : slot);
      pushListFrame(stack, top.stmt.body);
      return undefined;
    }
    case 'try': {
      return finishTryNormal(stack, top, runtime, frame);
    }
  }
}

// code-gauge-allow functionNcss 47 -- Flat dispatch over non-hot PHP statement kinds.
function dispatchOtherStatement(
  stack: BlockFrame[],
  statement: Exclude<Stmt, { k: 'expr' }>,
  runtime: Runtime,
  frame: Frame,
  held: number
): Completion {
  switch (statement.k) {
    case 'if': {
      if (evBool(statement.cond)) pushListFrame(stack, statement.consequent);
      else if (statement.alternate) pushListFrame(stack, statement.alternate);
      return undefined;
    }
    case 'return': {
      const value = statement.e ? evReturn(statement.e) : null;
      frame.returning = value instanceof Ref ? value : share(value);
      return { t: 'return', slot: frame.returning, row: statement.e?.row ?? statement.row };
    }
    case 'block': {
      pushListFrame(stack, statement.body);
      return undefined;
    }
    case 'while': {
      stack.push({ k: 'while', stmt: statement, held, started: false });
      return undefined;
    }
    case 'do': {
      stack.push({ k: 'do', stmt: statement, held, started: false });
      return undefined;
    }
    case 'for': {
      runForClause(statement.init, statement.row, frame, held);
      stack.push({ k: 'for', stmt: statement, held, started: false });
      return undefined;
    }
    case 'foreach': {
      return enterForeach(stack, statement, runtime, frame);
    }
    case 'switch': {
      const start = resolveSwitchStart(statement);
      if (start !== -1) stack.push({ k: 'switch', cases: statement.cases, index: start });
      return undefined;
    }
    case 'try': {
      stack.push({ k: 'try', stmt: statement, phase: 'try' });
      pushListFrame(stack, statement.body);
      return undefined;
    }
    case 'break':
    case 'continue': {
      return { t: statement.k, depth: statement.depth };
    }
    case 'goto': {
      return { t: 'goto', label: statement.label };
    }
    case 'label':
    case 'nop': {
      return undefined;
    }
    default: {
      return dispatchSimpleStatement(statement, runtime, frame, held);
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 16 -- Flat dispatch over leaf PHP statement kinds.
// code-gauge-allow functionNcss 40 -- One case per leaf PHP statement kind.
function dispatchSimpleStatement(
  statement: Extract<Stmt, { k: 'echo' | 'inline' | 'global' | 'static' | 'unset' | 'func' | 'class' | 'const' }>,
  runtime: Runtime,
  frame: Frame,
  held: number
): Completion {
  switch (statement.k) {
    case 'echo': {
      const mark = runtime.steps.statementMark();
      for (const arg of statement.args) {
        runtime.echo(toStr(evOpcodeOperand(arg)));
        runtime.dropTemporaries(frame, held);
      }
      runtime.steps.completeStatement(statement.row, true, mark);
      return undefined;
    }
    case 'inline': {
      runtime.echo(statement.text);
      return undefined;
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
      for (const item of statement.items) {
        const value = evaluateInitializer(item.value, frame, item.opcodeRow);
        runtime.row = item.opcodeRow;
        defineConstant(item.name, value);
      }
      return undefined;
    }
  }
}

function propagateCompletion(
  stack: BlockFrame[],
  completion: NonNullable<Completion>,
  runtime: Runtime,
  frame: Frame
): Completion {
  const top = stack.at(-1) as BlockFrame;
  if (top.k === 'list') {
    releaseListHeld(top, runtime, frame);
    if (completion.t === 'goto') {
      const next = labelIndex(top.stmts, completion.label);
      if (next !== -1) {
        top.index = next;
        top.seek = completion.label;
        runtime.spend();
        return undefined;
      }
    }
    stack.pop();
    return completion;
  }
  if (top.k === 'try') return propagateTryCompletion(stack, top, completion, runtime, frame);
  if (top.k === 'switch') {
    stack.pop();
    return decrementLoopCompletion(completion);
  }
  if (completion.t === 'continue' && completion.depth === 1) return undefined;
  if (top.k === 'foreachArray') frame.foreachSubjects.pop();
  stack.pop();
  return decrementLoopCompletion(completion);
}

function decrementLoopCompletion(completion: NonNullable<Completion>): Completion {
  if (completion.t === 'break' || completion.t === 'continue')
    return completion.depth > 1 ? { t: completion.t, depth: completion.depth - 1 } : undefined;
  return completion;
}

function unwindStackOnThrow(stack: BlockFrame[], error: unknown, runtime: Runtime, frame: Frame): void {
  let activeError = error;
  let fromExit = error instanceof ExitSignal;
  while (stack.length > 0) {
    const top = stack.at(-1) as BlockFrame;
    if (top.k === 'list') {
      if (top.stmtHeld !== undefined) {
        const held = top.stmtHeld;
        top.stmtHeld = undefined;
        activeError = releaseTemporariesKeepingError(runtime, frame, held, activeError);
      }
      stack.pop();
      continue;
    }
    if (top.k === 'foreachArray') {
      frame.foreachSubjects.pop();
      stack.pop();
      continue;
    }
    if (top.k === 'try') {
      const result = handleTryThrow(stack, top, activeError, runtime, frame, fromExit);
      if (result.handled) return;
      activeError = result.error;
      fromExit = result.fromExit;
      continue;
    }
    stack.pop();
  }
  throw activeError;
}

function releaseTemporariesKeepingError(runtime: Runtime, frame: Frame, mark: number, error: unknown): unknown {
  try {
    if (error instanceof PhpThrow && frame.temporaries.length > mark)
      withPendingException(runtime, error, () => runtime.dropTemporaries(frame, mark));
    else runtime.dropTemporaries(frame, mark);
  } catch (destructorError) {
    return destructorError;
  }
  return error;
}

/** Enters the statement that holds a label without running what comes before the label inside it. */
function seekIntoStack(stack: BlockFrame[], statement: Stmt, label: string, frame: Frame): void {
  switch (statement.k) {
    case 'if': {
      if (statement.consequent.some((inner) => containsLabel(inner, label)))
        pushListFrame(stack, statement.consequent, label);
      else pushListFrame(stack, statement.alternate as Stmt[], label);
      return;
    }
    case 'block': {
      pushListFrame(stack, statement.body, label);
      return;
    }
    case 'try': {
      if (statement.fin?.some((inner) => containsLabel(inner, label))) {
        stack.push({ k: 'try', stmt: statement, phase: 'finally', finMark: frame.temporaries.length });
        pushListFrame(stack, statement.fin, label);
        return;
      }
      const inCatch = statement.catches.find((item) => item.body.some((inner) => containsLabel(inner, label)));
      if (inCatch) {
        stack.push({ k: 'try', stmt: statement, phase: 'catch' });
        pushListFrame(stack, inCatch.body, label);
        return;
      }
      stack.push({ k: 'try', stmt: statement, phase: 'try' });
      pushListFrame(stack, statement.body, label);
      return;
    }
  }
}

export function defineConstant(name: string, value: Value): boolean {
  const runtime = rt();
  const key = constantKey(name);
  if (runtime.constants.has(key)) {
    warn(`Constant ${name.includes('\\') ? key : name} already defined, this will be an error in PHP 9`);
    return false;
  }
  runtime.constants.set(key, share(value));
  if (value instanceof PhpArray || value instanceof PhpObject) runtime.declarationRoots.add(value);
  if (value instanceof PhpArray) value.persistentHolder = true;
  return true;
}

/** The key of a constant: its namespace is case-insensitive, its own name is not. */
export function constantKey(name: string): string {
  const slash = name.lastIndexOf('\\');
  if (slash === -1) return builtinLiteralKey(name) ?? name;
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

function runForClause(expressions: Expr[], row: number, frame: Frame, held: number): void {
  if (expressions.length === 0) return;
  const runtime = rt();
  runtime.row = row;
  for (const expression of expressions) evaluateForExpression(expression, frame, held);
  runtime.steps.step(row);
}

function evaluateForExpression(e: Expr, frame: Frame, held: number, condition = false): boolean {
  if (condition) return evBool(e);
  if (e.k === 'var') evQuiet(e);
  else ev(e, true);
  rt().dropTemporaries(frame, held);
  return true;
}

function resolveSwitchStart(statement: Extract<Stmt, { k: 'switch' }>): number {
  const readSubject = prepareOperand(statement.subject);
  for (const [index, item] of statement.cases.entries()) {
    if (item.test === undefined) continue;
    rt().row = item.row;
    const row = item.test.row;
    if (consumeExpression(item.test, (value) => looseEquals(readSubject(row), value))) return index;
  }
  return statement.cases.findIndex((item) => item.test === undefined);
}

function staticDeclaration(statement: Extract<Stmt, { k: 'static' }>, frame: Frame): void {
  const statics = frame.fn?.kind === 'user' ? frame.fn.statics : rt().globalStatics;
  for (const { name, init } of statement.vars) declareStaticVar(statics, name, init, frame);
}

function declareStaticVar(statics: Map<string, Ref>, name: string, init: Expr | undefined, frame: Frame): void {
  const existing = statics.get(name);
  if (existing) {
    new VarPlace(frame, name).bind(existing);
    return;
  }
  const value = init ? share(ev(init)) : null;
  const reentrant = statics.get(name);
  if (reentrant) {
    bindStaticDiscardingUnused(frame, name, reentrant, value);
    return;
  }
  const ref = new Ref(value);
  ref.isRef = true;
  statics.set(name, ref);
  if (frame.closure) nativeOwnershipChanged(frame.closure);
  new VarPlace(frame, name).bind(ref);
}

function bindStaticDiscardingUnused(frame: Frame, name: string, ref: Ref, unused: Value): void {
  const runtime = rt();
  runtime.held.push(unused);
  let bindError: unknown;
  try {
    new VarPlace(frame, name).bind(ref);
  } catch (error) {
    bindError = error;
  } finally {
    runtime.held.pop();
  }
  if (bindError === undefined) {
    runtime.release([unused]);
    return;
  }
  if (bindError instanceof PhpThrow) withPendingException(runtime, bindError, () => runtime.release([unused]));
  else runtime.release([unused]);
  throw bindError;
}

function finishTryNormal(
  stack: BlockFrame[],
  top: Extract<BlockFrame, { k: 'try' }>,
  runtime: Runtime,
  frame: Frame
): Completion {
  if (top.phase !== 'finally') {
    if (!top.stmt.fin) {
      stack.pop();
      return undefined;
    }
    enterFinallyFrame(stack, top, runtime, frame, undefined, undefined);
    return undefined;
  }
  if (top.pending) {
    runtime.held.pop();
    const pending = top.pending;
    top.pending = undefined;
    stack.pop();
    runtime.thrown = pending.object;
    throw pending;
  }
  if (top.completion?.t === 'return') frame.returning = top.completion.slot;
  stack.pop();
  return top.completion;
}

function propagateTryCompletion(
  stack: BlockFrame[],
  top: Extract<BlockFrame, { k: 'try' }>,
  completion: NonNullable<Completion>,
  runtime: Runtime,
  frame: Frame
): Completion {
  if (top.phase !== 'finally') {
    if (!top.stmt.fin) {
      stack.pop();
      return completion;
    }
    enterFinallyFrame(stack, top, runtime, frame, completion, undefined);
    return undefined;
  }
  const pending = top.pending;
  top.pending = undefined;
  stack.pop();
  if (pending) {
    runtime.held.pop();
    if (runtime.thrown === pending.object) runtime.thrown = undefined;
    try {
      runtime.release([pending.object]);
    } catch (error) {
      cancelPendingReturn(runtime, frame, completion, error);
      throw error;
    }
  }
  return completion;
}

function cancelPendingReturn(
  runtime: Runtime,
  frame: Frame,
  completion: NonNullable<Completion>,
  error: unknown
): void {
  if (completion.t !== 'return') return;
  frame.returning = undefined;
  if (error instanceof PhpThrow) withPendingException(runtime, error, () => runtime.release([completion.slot]));
  else runtime.release([completion.slot]);
}

// code-gauge-allow functionCognitiveComplexity 19 -- Handles catch matching, finally transition, and exception chaining in one unwind step.
function handleTryThrow(
  stack: BlockFrame[],
  top: Extract<BlockFrame, { k: 'try' }>,
  error: unknown,
  runtime: Runtime,
  frame: Frame,
  fromExit = false
): { handled: boolean; error: unknown; fromExit: boolean } {
  let exitOrigin = fromExit;
  if (top.phase === 'try' && error instanceof PhpThrow) {
    if (top.stmt.catches.length > 0) exitOrigin = false;
    const handler = top.stmt.catches.find((item) => item.types.some((name) => catches(error.object, name)));
    if (handler) {
      try {
        bindCatchVariable(handler, error.object, runtime, frame);
      } catch (bindError) {
        top.phase = 'catch';
        return handleTryThrow(stack, top, bindError, runtime, frame, exitOrigin);
      }
      top.phase = 'catch';
      pushListFrame(stack, handler.body);
      return { handled: true, error, fromExit: exitOrigin };
    }
  }
  if (top.phase !== 'finally') {
    if (error instanceof PhpThrow && !exitOrigin && !runtime.exhausted && top.stmt.fin) {
      enterFinallyFrame(stack, top, runtime, frame, undefined, error);
      return { handled: true, error, fromExit: exitOrigin };
    }
    stack.pop();
    return { handled: false, error, fromExit: exitOrigin };
  }
  if (top.pending) runtime.held.pop();
  if (top.completion?.t === 'return') frame.returning = undefined;
  if (error instanceof PhpThrow && top.pending) setPrevious(error.object, top.pending.object);
  const nextError =
    top.finMark === undefined ? error : releaseTemporariesKeepingError(runtime, frame, top.finMark, error);
  stack.pop();
  return { handled: false, error: nextError, fromExit: exitOrigin };
}

function bindCatchVariable(
  handler: Extract<Stmt, { k: 'try' }>['catches'][number],
  object: PhpObject,
  runtime: Runtime,
  frame: Frame
): void {
  runtime.row = handler.row;
  const mark = frame.temporaries.length;
  frame.temporaries.push(object);
  runtime.thrown = undefined;
  try {
    collectBeforeAllocation(runtime);
    if (handler.varName !== undefined) new VarPlace(frame, handler.varName).set(object);
  } finally {
    runtime.dropTemporaries(frame, mark);
  }
}

function enterFinallyFrame(
  stack: BlockFrame[],
  top: Extract<BlockFrame, { k: 'try' }>,
  runtime: Runtime,
  frame: Frame,
  completion: Completion,
  pending: PhpThrow | undefined
): void {
  top.phase = 'finally';
  top.completion = completion;
  top.pending = pending;
  top.finMark = frame.temporaries.length;
  const returning = completion?.t === 'return' ? completion.slot : undefined;
  if (returning instanceof Ref) runtime.holdTemporaryReference(returning);
  else if (returning !== undefined) frame.temporaries.push(returning);
  if (pending) runtime.held.push(pending.object);
  pushListFrame(stack, top.stmt.fin as Stmt[]);
}

function catches(object: PhpObject, name: string): boolean {
  const cls = findClass(name);
  return cls !== undefined && object.cls.isSubclassOf(cls);
}

function withForeachSubject<T>(subject: PhpArray | PhpObject | Ref, run: () => T): T {
  const subjects = rt().frame.foreachSubjects;
  subjects.push(subject);
  try {
    return run();
  } finally {
    subjects.pop();
  }
}

function enterForeach(
  stack: BlockFrame[],
  statement: Extract<Stmt, { k: 'foreach' }>,
  runtime: Runtime,
  frame: Frame
): Completion {
  if (foreachReferences(statement.value, statement.byRef)) return foreachReferenceSubject(statement);
  const subjectMark = frame.temporaries.length;
  const nativeMark = runtime.nativeHeld.at(-1)?.length ?? 0;
  const subject = ev(statement.subject);
  if (!(subject instanceof PhpArray || (subject instanceof PhpObject && !subject.isResource)))
    return warnForeachSubject(statement, subject);
  frame.temporaries.push(subject);
  if (subject instanceof PhpObject) {
    return withForeachSubject(subject, () =>
      foreachObject(statement, subject, false, () => runtime.discardNativeResult(subject, nativeMark, subjectMark))
    );
  }
  subject.shared = true;
  frame.foreachSubjects.push(subject);
  stack.push({ k: 'foreachArray', stmt: statement, subject, iter: subject.foreachEntries()[Symbol.iterator]() });
  return undefined;
}

const FOREACH_REPLACED = Symbol();
type ForeachCompletion = Completion | typeof FOREACH_REPLACED;

function foreachReferenceSubject(statement: Extract<Stmt, { k: 'foreach' }>): Completion {
  const runtime = rt();
  const place = foreachSubjectPlace(statement.subject);
  const initial = place.get();
  if (!(initial instanceof PhpArray || (initial instanceof PhpObject && !initial.isResource)))
    return warnForeachSubject(statement, initial);
  const reference = place instanceof ValuePlace ? Ref.temporary(initial) : place.ref();
  runtime.holdTemporaryReference(reference);
  return withForeachSubject(reference, () => foreachReferenceLoop(statement, initial, reference));
}

function foreachReferenceLoop(
  statement: Extract<Stmt, { k: 'foreach' }>,
  initial: PhpArray | PhpObject,
  reference: Ref
): Completion {
  const traversable = rt().classes.get('traversable') as PhpClass;
  for (;;) {
    const container = reference.v;
    let result: ForeachCompletion;
    if (container instanceof PhpArray) {
      const array = writableContainer(new RefPlace(reference), container) as PhpArray;
      result = foreachArrayByRef(statement, array, reference);
    } else if (container instanceof PhpObject && !container.isResource) {
      if (container.cls.isSubclassOf(traversable))
        return container === initial ? foreachObject(statement, container, true) : undefined;
      result = foreachPropertyByRef(statement, container, reference);
    } else return warnForeachSubject(statement, container);
    if (result !== FOREACH_REPLACED) return result;
  }
}

interface NativeForeachStorage {
  cursor(): ArrayCursor;
  writable(): PhpArray;
}

function foreachArrayByRef(
  statement: Extract<Stmt, { k: 'foreach' }>,
  array: PhpArray,
  subject: Ref
): ForeachCompletion {
  const runtime = rt();
  let current = array;
  let cursor = current.foreachCursor();
  try {
    for (;;) {
      const next = subject.v;
      if (next !== current) {
        if (!(next instanceof PhpArray)) return FOREACH_REPLACED;
        current = writableContainer(new RefPlace(subject), next) as PhpArray;
        cursor = current.foreachCursor(cursor);
      }
      const key = cursor.key;
      if (key === undefined) return undefined;
      runtime.spend();
      cursor.next();
      if (current.map.get(key) === UNDEFINED_RESULT) continue;
      const result = foreachRefIteration(statement, current, key);
      if (result !== 'next') return result;
    }
  } finally {
    cursor.close();
  }
}

function foreachPropertyByRef(
  statement: Extract<Stmt, { k: 'foreach' }>,
  object: PhpObject,
  subject: Ref
): ForeachCompletion {
  const runtime = rt();
  const scope = runtime.frame.scope;
  const keys = visiblePropertyKeys(object, scope, true);
  for (const key of keys) {
    const name = propNameOf(key);
    const ref = propRef(object, name, scope, 'foreach');
    bindForeachRef(statement, ref);
    if (statement.key) assignTo(statement.key, name);
    runtime.steps.stepBinding(statement.row, true);
    const result = loopBody(statement.body);
    if (result !== 'next') return result;
    if (subject.v !== object) return FOREACH_REPLACED;
  }
  return undefined;
}

function warnForeachSubject(statement: Extract<Stmt, { k: 'foreach' }>, value: Value | undefined): undefined {
  rt().row = statement.subject.row;
  warn(`foreach() argument must be of type array|object, ${valueName(value ?? null)} given`);
  return undefined;
}

function foreachIteration(
  statement: Extract<Stmt, { k: 'foreach' }>,
  key: Key | Value,
  value: Value
): 'next' | Completion {
  bindForeachValue(statement, key, value);
  return loopBody(statement.body);
}

function bindForeachValue(statement: Extract<Stmt, { k: 'foreach' }>, key: Key | Value, value: Value): void {
  const runtime = rt();
  runtime.row = statement.row;
  if (statement.value.k === 'list')
    destructure(statement.value, value, undefined, compiledOperandRow(statement.subject));
  else assignTo(statement.value, share(value));
  if (statement.key) assignTo(statement.key, key as Value);
  runtime.steps.stepBinding(statement.row, statement.value.k === 'list' || storesAnswer(value));
}

/** Whether a foreach binding stores a value learners answer, as Java's primitives and strings are. */
function storesAnswer(value: Value): boolean {
  return value !== null && !(value instanceof PhpObject) && !(value instanceof PhpArray);
}

function bindForeachRef(statement: Extract<Stmt, { k: 'foreach' }>, ref: Ref): void {
  const target = statement.value;
  if (target.k === 'list') destructure(target, ref.v, new RefPlace(ref), compiledOperandRow(statement.subject));
  else if (target.k === 'var') new VarPlace(rt().frame, target.name).bind(ref);
  else bindRef(target, ref);
}

function foreachObject(
  statement: Extract<Stmt, { k: 'foreach' }>,
  object: PhpObject,
  byRef = false,
  releaseSubject?: () => void
): Completion {
  const runtime = rt();
  runtime.row = statement.subjectEndRow;
  const acquired = acquireIterator(object, byRef);
  if (acquired) {
    const { iterator, handle } = acquired;
    let failure: PhpThrow | undefined;
    try {
      if (byRef) return foreachStorageByRef(statement, iterator.internal as NativeForeachStorage);
      return foreachIteratorByValue(statement, new InnerIterator(iterator, handle), releaseSubject);
    } catch (error) {
      if (error instanceof PhpThrow) failure = error;
      throw error;
    } finally {
      withPendingException(runtime, failure, () => runtime.discardNativeResult(handle, Infinity, 0));
    }
  }
  const scope = runtime.frame.scope;
  for (const key of visiblePropertyKeys(object, scope, true)) {
    const name = propNameOf(key);
    const completion = foreachIteration(statement, name, readProp(object, name, scope, 'quiet'));
    if (completion !== 'next') return completion;
  }
  return undefined;
}

function foreachStorageByRef(statement: Extract<Stmt, { k: 'foreach' }>, storage: NativeForeachStorage): Completion {
  const runtime = rt();
  storage.cursor().rewind();
  for (;;) {
    const key = storage.cursor().key;
    if (key === undefined) return undefined;
    runtime.spend();
    const array = storage.writable();
    if (array.map.get(key) !== UNDEFINED_RESULT) {
      const result = foreachRefIteration(statement, array, key);
      if (result !== 'next') return result;
    }
    storage.cursor().next();
  }
}

function foreachRefIteration(
  statement: Extract<Stmt, { k: 'foreach' }>,
  array: PhpArray,
  key: Key
): 'next' | Completion {
  bindForeachRef(statement, new ElementPlace(array, key).ref());
  if (statement.key) assignTo(statement.key, key);
  rt().steps.stepBinding(statement.row, true);
  return loopBody(statement.body);
}

function foreachIteratorByValue(
  statement: Extract<Stmt, { k: 'foreach' }>,
  iterator: InnerIterator,
  releaseSubject: (() => void) | undefined
): Completion {
  const runtime = rt();
  iterator.rewind();
  let valid = iterator.valid();
  releaseSubject?.();
  while (valid) {
    runtime.spend();
    const slot = iterator.currentSlot();
    if (statement.key) {
      consumeInvokedResult(
        () => iterator.key(),
        (key) => bindForeachValue(statement, key, deref(slot))
      );
    } else bindForeachValue(statement, null, deref(slot));
    const completion = loopBody(statement.body);
    if (completion !== 'next') return completion;
    runtime.row = statement.subjectEndRow;
    iterator.next();
    valid = iterator.valid();
  }
}

function runBody(decl: FunctionDecl, frame: Frame): Value {
  if (frame.thisObj) promoteParameters(decl, frame, frame.thisObj);
  if (decl.arrowBody) {
    frame.returning = evReturn(decl.arrowBody);
    frame.returnRow = decl.arrowBody.row;
  } else {
    const completion = execList(decl.body);
    if (completion?.t === 'goto') throw new Error(`Unresolved goto ${completion.label}`);
    frame.returning = completion?.t === 'return' ? completion.slot : undefined;
    frame.returnRow = completion?.t === 'return' ? completion.row : undefined;
  }
  const result = frame.returning;
  return result instanceof Ref ? result.v : (result ?? null);
}

function promoteParameters(decl: FunctionDecl, frame: Frame, object: PhpObject): void {
  const runtime = rt();
  for (const param of decl.params) {
    if (!param.promote) continue;
    runtime.row = param.row;
    const ref = frame.vars.get(param.name);
    if (param.byRef && ref) bindPropertyReference(object, param.name, ref, frame.scope);
    else writeProp(object, param.name, ref?.v ?? null, frame.scope);
    runtime.steps.step(param.row);
  }
}

setBodyRunner(runBody, execList);
setDestructor((object, row) => {
  const destructor = object.cls.findMethod('__destruct');
  if (!destructor) return;
  const run = (): void =>
    discardInvokedResult(() =>
      invoke(
        { fn: destructor.fn, thisObj: object, scope: destructor.scope, staticClass: object.cls, method: destructor },
        [],
        row
      )
    );
  const runtime = rt();
  const releasingGlobals = runtime.releasingGlobalsAtShutdown;
  runtime.releasingGlobalsAtShutdown = false;
  try {
    if (row === undefined) asInternal(run);
    else run();
  } finally {
    runtime.releasingGlobalsAtShutdown = releasingGlobals;
  }
});
setObjectToString((object) => {
  const method = object.cls.findMethod('__tostring');
  if (!method) throwError('Error', `Object of class ${object.cls.name} could not be converted to string`);
  const result = invoke(
    { fn: method.fn, thisObj: object, scope: method.scope, staticClass: object.cls, method },
    [],
    undefined
  );
  return result as string;
});
function parameterDefault(decl: FunctionDecl, index: number, frame: Frame): Value {
  const expression = decl.params[index].defaultExpr;
  if (!expression) return null;
  const runtime = rt();
  const values = runtime.parameterDefaults.get(expression);
  const stored = values?.get(frame.scope);
  if (stored !== undefined) return share(stored);
  runtime.row = expression.row;
  const value = share(evaluateInitializer(expression, frame, decl.params[index].defaultReportRow));
  if ((value === null || typeof value !== 'object') && !containsDefaultAllocation(expression)) {
    const cache = values ?? new Map<PhpClass | undefined, Value>();
    cache.set(frame.scope, value);
    runtime.parameterDefaults.set(expression, cache);
  }
  return value;
}

function containsDefaultAllocation(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if ('k' in node && (node.k === 'new' || node.k === 'newAnon' || node.k === 'closure' || node.k === 'arrow'))
    return true;
  return Object.values(node).some(containsDefaultAllocation);
}

function evaluateInitializer(expression: Expr, frame: Frame, row: number | undefined): Value {
  const outer = frame.initializerOpcodeRow;
  const wasConstant = frame.constantExpression;
  frame.initializerOpcodeRow = row;
  frame.constantExpression = true;
  try {
    return ev(expression);
  } finally {
    frame.initializerOpcodeRow = outer;
    frame.constantExpression = wasConstant;
  }
}

setDefaultEvaluator(parameterDefault);
setClassEvaluator((e, cls) => {
  const runtime = rt();
  const trigger = runtime.instructionRow;
  const previousRow = runtime.row;
  const frame = new Frame(undefined, undefined, false, undefined, cls, cls);
  runtime.frames.push(frame);
  try {
    return evaluateInitializer(e, frame, trigger);
  } finally {
    runtime.frames.pop();
    runtime.row = previousRow;
  }
});

export type { Runtime };
