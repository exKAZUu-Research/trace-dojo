// code-gauge-allow-file fileNcss 900 -- The evaluator keeps one function per kind of node together.
import type { BlockDef, Body, Call, Expr, MethodDef, MultiTarget, Params, ParamTarget, Stmt, Target } from './ast';
import { caseEquals, inspect, toS } from './conversions';
import {
  argumentCountError,
  argumentError,
  expectedArity,
  frozenError,
  implicitConversionError,
  nameError,
  noMethodError,
  receiverDescription,
  rubyError,
  typeError,
} from './errors';
import { hashGet, hashSet } from './hashes';
import {
  invalidateMethodCaches,
  NIL,
  RArray,
  RBasic,
  RClass,
  RHash,
  type RMethod,
  RObject,
  RProc,
  RString,
  RSymbol,
  type Value,
  type Visibility,
} from './objects';
import {
  BreakSignal,
  Frame,
  NextSignal,
  RetrySignal,
  ReturnSignal,
  rt,
  RubyError,
  Scope,
  UnsupportedFeatureError,
} from './runtime';
import { UNSUPPORTED_CONSTANTS } from './unsupportedNames';
import { arr, classOf, isA, newHash, range, realClassOf, singletonClassOf, str, sym, truthy } from './values';

export type Gen<T = Value> = Generator<unknown, T, unknown>;

const GENERATOR_PROTOTYPE = Object.getPrototypeOf(Object.getPrototypeOf((function* () {})()));

export function isGenerator(value: unknown): value is Gen {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(Object.getPrototypeOf(value)) === GENERATOR_PROTOTYPE
  );
}

/** Runs a generator that must not suspend, such as a program's body outside any enumerator. */
export function runToEnd<T>(generator: Generator<unknown, T, unknown>): T {
  const result = generator.next();
  if (!result.done) throw new Error('A Ruby evaluation suspended outside an enumerator');
  return result.value;
}

// Statements ----------------------------------------------------------------------------------------------------------

export function* evalBody(body: Body, frame: Frame): Gen {
  let last: Value = NIL;
  for (const statement of body) last = yield* evalStmt(statement, frame);
  return last;
}

function* evalStmt(statement: Stmt, frame: Frame): Gen {
  const runtime = rt();
  runtime.currentRow = statement.row;
  runtime.spend();
  const { step, e } = statement;
  if (step === 'none' || step === 'constant') return yield* ev(e, frame);
  const used = statement.use === 1 || (statement.use === 2 && frame.resultUsed);
  if (used && step !== 'assign') return yield* ev(e, frame);
  const { steps } = runtime;
  const mark = steps.statementMark();
  const value = yield* ev(e, frame);
  const onlyCalls = step === 'call' || (step === 'assign' && isCreation(e));
  steps.completeStatement(statement.row, onlyCalls, mark);
  return value;
}

/** Whether an assignment stores a newly created object (`x = Foo.new`), which only calls the constructor. */
function isCreation(e: Expr): boolean {
  return e.k === 'asgn' && e.target.k !== 'mlhs' && e.value.k === 'call' && e.value.name === 'new' && !!e.value.recv;
}

// Expressions ---------------------------------------------------------------------------------------------------------

// code-gauge-allow functionNcss 150 -- One case per kind of expression.
// code-gauge-allow functionCognitiveComplexity 60 -- One case per kind of expression.
export function* ev(e: Expr, frame: Frame): Gen {
  switch (e.k) {
    case 'int': {
      return e.v;
    }
    case 'float': {
      return e.v;
    }
    case 'nil': {
      return NIL;
    }
    case 'true': {
      return true;
    }
    case 'false': {
      return false;
    }
    case 'self': {
      return frame.self;
    }
    case 'str': {
      return str(yield* interpolate(e.parts, frame));
    }
    case 'sym': {
      return RSymbol.of(e.name);
    }
    case 'dsym': {
      return RSymbol.of(yield* interpolate(e.parts, frame));
    }
    case 'array': {
      return arr(yield* evalList(e.items, frame));
    }
    case 'hash': {
      return yield* evalHash(e, frame);
    }
    case 'range': {
      const from = e.from ? yield* ev(e.from, frame) : NIL;
      const to = e.to ? yield* ev(e.to, frame) : NIL;
      return yield* makeRange(from, to, e.exclusive);
    }
    case 'lvar': {
      return frame.scope.lookup(e.name, e.depth);
    }
    case 'ivar': {
      return ivarGet(frame.self, e.name);
    }
    case 'gvar': {
      return globalGet(e.name);
    }
    case 'cvar': {
      return classVariableGet(frame, e.name);
    }
    case 'const': {
      return yield* constGet(e, frame);
    }
    case 'splat': {
      return arr(yield* splatItems(yield* ev(e.e, frame)));
    }
    case 'asgn': {
      const value = yield* ev(e.value, frame);
      yield* assign(e.target, value, frame);
      return value;
    }
    case 'opasgn': {
      return yield* operatorAssign(e, frame);
    }
    case 'call': {
      return yield* evalCall(e, frame);
    }
    case 'super': {
      return yield* evalSuper(e, frame);
    }
    case 'yield': {
      const { args, keywords } = yield* evalArgs(e.args, frame);
      const block = frame.home.extra.block;
      if (!block) throw rubyError(rt().c.LocalJumpError, 'no block given (yield)');
      const used = e.used === 1 || (e.used === 2 && frame.resultUsed);
      return yield* callProc(block, args, { keywords, used, callRow: rt().currentRow });
    }
    case 'and': {
      const left = yield* ev(e.l, frame);
      return truthy(left) ? yield* ev(e.r, frame) : left;
    }
    case 'or': {
      const left = yield* ev(e.l, frame);
      return truthy(left) ? left : yield* ev(e.r, frame);
    }
    case 'not': {
      const value = yield* ev(e.e, frame);
      const method = classOf(value).findMethod('!');
      if (method && method.body.kind !== 'native') return yield* invoke(method, value, [], undefined, undefined, true);
      return !truthy(value);
    }
    case 'if': {
      if (truthy(yield* ev(e.cond, frame))) return yield* evalBody(e.then, frame);
      return e.else ? yield* evalBody(e.else, frame) : NIL;
    }
    case 'while': {
      return yield* evalWhile(e, frame);
    }
    case 'for': {
      return yield* evalFor(e, frame);
    }
    case 'case': {
      return yield* evalCase(e, frame);
    }
    case 'break': {
      const value = e.value ? yield* ev(e.value, frame) : NIL;
      if (!e.inBlock) throw new BreakSignal(value, undefined);
      const proc = frame.extra.proc as RProc;
      if (!proc.isLambda && !proc.callSiteActive) throw rubyError(rt().c.LocalJumpError, 'break from proc-closure');
      throw new BreakSignal(value, proc.breakTag);
    }
    case 'next': {
      throw new NextSignal(e.value ? yield* ev(e.value, frame) : NIL);
    }
    case 'return': {
      const value = e.value ? yield* ev(e.value, frame) : NIL;
      throw new ReturnSignal(value, returnTarget(frame));
    }
    case 'retry': {
      throw new RetrySignal();
    }
    case 'begin': {
      return yield* evalBegin(e, frame);
    }
    case 'seq': {
      return yield* evalBody(e.body, frame);
    }
    case 'def': {
      return yield* defineMethod(e.def, e.singleton, frame);
    }
    case 'class': {
      return yield* defineClass(e, frame);
    }
    case 'module': {
      return yield* defineModule(e, frame);
    }
    case 'lambda': {
      const proc = makeBlock(e.block, frame);
      proc.isLambda = true;
      return proc;
    }
    case 'rescueMod': {
      try {
        return yield* ev(e.body, frame);
      } catch (error) {
        if (error instanceof RubyError && isA(error.exception, rt().c.StandardError)) {
          const saved = rt().globals.get('$!') ?? NIL;
          rt().globals.set('$!', error.exception);
          try {
            return yield* ev(e.handler, frame);
          } finally {
            rt().globals.set('$!', saved);
          }
        }
        throw error;
      }
    }
    case 'blockpass': {
      throw new Error('A block argument outside a call');
    }
  }
}

function* interpolate(parts: (string | Expr)[], frame: Frame): Gen<string> {
  let text = '';
  for (const part of parts) {
    if (typeof part === 'string') text += part;
    else text += yield* toS(yield* ev(part, frame));
  }
  if (text.length > 1_000_000) throw rubyError(rt().c.NoMemoryError, 'failed to allocate memory');
  return text;
}

/** The values of a list of expressions, with splats (`*a`) expanded. */
function* evalList(items: Expr[], frame: Frame): Gen<Value[]> {
  const values: Value[] = [];
  for (const item of items) {
    if (item.k === 'splat') values.push(...(yield* splatItems(yield* ev(item.e, frame))));
    else values.push(yield* ev(item, frame));
  }
  return values;
}

export function* splatItems(value: Value): Gen<Value[]> {
  if (value instanceof RArray) return [...value.items];
  if (value === NIL) return [];
  if (respondsTo(value, 'to_a')) {
    const converted = yield* callMethod(value, 'to_a', []);
    if (converted instanceof RArray) return [...converted.items];
    throw typeError(
      `can't convert ${realClassOf(value).name} to Array (${realClassOf(value).name}#to_a gives ${realClassOf(converted).name})`
    );
  }
  return [value];
}

function* evalHash(e: Extract<Expr, { k: 'hash' }>, frame: Frame): Gen<RHash> {
  const hash = newHash();
  for (const item of e.items) {
    if ('splat' in item) {
      const value = yield* ev(item.splat, frame);
      if (value === NIL) continue;
      if (!(value instanceof RHash)) throw implicitConversionError(value, 'Hash');
      for (const entry of [...value.map.values()]) yield* hashSet(hash, entry.key, entry.value);
      continue;
    }
    const key = yield* ev(item.key, frame);
    yield* hashSet(hash, key, yield* ev(item.value, frame));
  }
  return hash;
}

export function* makeRange(from: Value, to: Value, exclusive: boolean): Gen {
  if (from !== NIL && to !== NIL) {
    const comparable =
      (typeof from === 'bigint' || typeof from === 'number') && (typeof to === 'bigint' || typeof to === 'number');
    if (!comparable && !(from instanceof RString && to instanceof RString)) {
      const order = respondsTo(from, '<=>') ? yield* callMethod(from, '<=>', [to]) : NIL;
      if (order === NIL) throw argumentError('bad value for range');
    }
  }
  return range(from, to, exclusive);
}

// Variables -----------------------------------------------------------------------------------------------------------

export function ivarGet(self: Value, name: string): Value {
  return self instanceof RBasic ? (self.ivars?.get(name) ?? NIL) : NIL;
}

export function ivarSet(self: Value, name: string, value: Value): void {
  if (!(self instanceof RBasic)) {
    throw frozenError(self, String(self));
  }
  if (self.frozen) throw frozenError(self, inspectForFrozen(self));
  self.ivars ??= new Map();
  self.ivars.set(name, value);
}

function inspectForFrozen(self: RBasic): string {
  return runToEnd(inspect(self));
}

function globalGet(name: string): Value {
  if (UNSUPPORTED_GLOBALS[name]) throw new UnsupportedFeatureError(UNSUPPORTED_GLOBALS[name]);
  return rt().globals.get(name) ?? NIL;
}

const UNSUPPORTED_GLOBALS: Record<string, string> = {
  $stdin: '標準入力（$stdin）',
  $0: '$0',
  $PROGRAM_NAME: '$PROGRAM_NAME',
  $LOAD_PATH: '$LOAD_PATH',
  $LOADED_FEATURES: '$LOADED_FEATURES',
  '$:': '$:',
  '$~': '正規表現のマッチの結果（$~）',
  $1: '正規表現のマッチの結果（$1）',
  '$*': 'コマンドライン引数（$*）',
  $DEBUG: '$DEBUG',
  $VERBOSE: '$VERBOSE',
  $FILENAME: '$FILENAME',
  '$<': '標準入力（$<）',
  '$;': '$;',
};

function globalSet(name: string, value: Value): void {
  if (UNSUPPORTED_GLOBALS[name]) throw new UnsupportedFeatureError(UNSUPPORTED_GLOBALS[name]);
  if (name === '$stdout' || name === '$stderr') {
    if (!respondsTo(value, 'write')) {
      throw typeError(`${name} must have write method, ${realClassOf(value).name} given`);
    }
  }
  rt().globals.set(name, value);
}

/** The class whose class variables a frame sees: the innermost module of its lexical scope. */
function classVariableHolder(frame: Frame): RClass {
  const holder = frame.cref[0];
  if (holder.isSingleton && holder.attached instanceof RClass) return holder.attached;
  return holder;
}

function classVariableGet(frame: Frame, name: string): Value {
  const holder = classVariableHolder(frame);
  if (holder === rt().c.Object) throw rubyError(rt().c.RuntimeError, 'class variable access from toplevel');
  for (const module of holder.ancestors()) {
    const value = module.classVariables.get(name);
    if (value !== undefined) return value;
  }
  throw nameError(`uninitialized class variable ${name} in ${holder.name}`, holder, name);
}

function classVariableSet(frame: Frame, name: string, value: Value): void {
  const holder = classVariableHolder(frame);
  if (holder === rt().c.Object) throw rubyError(rt().c.RuntimeError, 'class variable access from toplevel');
  for (const module of holder.ancestors()) {
    if (module.classVariables.has(name)) {
      module.classVariables.set(name, value);
      return;
    }
  }
  holder.classVariables.set(name, value);
}

function* constGet(e: Extract<Expr, { k: 'const' }>, frame: Frame): Gen {
  if (e.scope) {
    const scope = yield* ev(e.scope, frame);
    if (!(scope instanceof RClass)) throw typeError(`${yield* inspect(scope)} is not a class/module`);
    return constInModule(scope, e.name);
  }
  if (e.top) return constInModule(rt().c.Object, e.name);
  return constLexical(frame.cref, e.name);
}

export function constLexical(cref: RClass[], name: string): Value {
  for (const module of cref) {
    if (module === rt().c.Object) break;
    const value = module.constants.get(name);
    if (value !== undefined) return value;
  }
  const found = findConstInAncestors(cref[0], name) ?? findConstInAncestors(rt().c.Object, name);
  if (found !== undefined) return found;
  return missingConstant(cref[0], name);
}

export function constInModule(module: RClass, name: string): Value {
  const found = findConstInAncestors(module, name);
  if (found !== undefined) return found;
  if (module === rt().c.Object) return missingConstant(module, name);
  return missingConstant(module, name, true);
}

function findConstInAncestors(module: RClass, name: string): Value | undefined {
  for (const ancestor of module.ancestors()) {
    const value = ancestor.constants.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function missingConstant(module: RClass, name: string, scoped = false): never {
  const feature = UNSUPPORTED_CONSTANTS[name];
  if (feature && (module === rt().c.Object || !scoped)) throw new UnsupportedFeatureError(feature);
  const prefix = module === rt().c.Object || !module.name ? '' : `${module.name}::`;
  throw nameError(`uninitialized constant ${prefix}${name}`, module, name);
}

function constSet(module: RClass, name: string, value: Value): void {
  if (module.constants.has(name)) {
    rt().io.stderr.write(`warning: already initialized constant ${name}\n`);
  }
  module.constants.set(name, value);
  if (value instanceof RClass && value.baseName === undefined) {
    value.baseName = name;
    if (module !== rt().c.Object) value.lexicalParent = module;
  }
}

// Assignment ----------------------------------------------------------------------------------------------------------

export function* assign(target: Target, value: Value, frame: Frame): Gen<void> {
  switch (target.k) {
    case 'lvar': {
      frame.scope.assign(target.name, target.depth, value);
      return;
    }
    case 'ivar': {
      ivarSet(frame.self, target.name, value);
      return;
    }
    case 'gvar': {
      globalSet(target.name, value);
      return;
    }
    case 'cvar': {
      classVariableSet(frame, target.name, value);
      return;
    }
    case 'const': {
      let module = frame.cref[0];
      if (target.scope) {
        const scope = yield* ev(target.scope, frame);
        if (!(scope instanceof RClass)) throw typeError(`${yield* inspect(scope)} is not a class/module`);
        module = scope;
      } else if (target.top) {
        module = rt().c.Object;
      }
      constSet(module, target.name, value);
      return;
    }
    case 'index': {
      const recv = yield* ev(target.recv, frame);
      const { args } = yield* evalArgs(target.args, frame);
      yield* callMethod(recv, '[]=', [...args, value], undefined, undefined, { fcall: target.recv.k === 'self' });
      return;
    }
    case 'attr': {
      const recv = yield* ev(target.recv, frame);
      if (target.safe && recv === NIL) return;
      yield* callMethod(recv, `${target.name}=`, [value], undefined, undefined, { fcall: target.recv.k === 'self' });
      return;
    }
    case 'mlhs': {
      yield* destructure(target, value, frame);
    }
  }
}

function* destructure(target: MultiTarget, value: Value, frame: Frame): Gen<void> {
  const items = yield* toAryForAssignment(value);
  const { splat } = target;
  if (splat === undefined) {
    for (const [index, item] of target.items.entries()) yield* assign(item, items[index] ?? NIL, frame);
    return;
  }
  const after = target.items.length - splat - 1;
  for (let index = 0; index < splat; index++) yield* assign(target.items[index], items[index] ?? NIL, frame);
  const restEnd = Math.max(splat, items.length - after);
  const rest = target.items[splat];
  if (rest.k !== 'mlhs' || rest.items.length > 0) yield* assign(rest, arr(items.slice(splat, restEnd)), frame);
  for (let index = 0; index < after; index++) {
    yield* assign(target.items[splat + 1 + index], items[restEnd + index] ?? NIL, frame);
  }
}

function* toAryForAssignment(value: Value): Gen<Value[]> {
  if (value instanceof RArray) return value.items;
  if (respondsTo(value, 'to_ary')) {
    const converted = yield* callMethod(value, 'to_ary', []);
    if (converted instanceof RArray) return converted.items;
  }
  return [value];
}

function* operatorAssign(e: Extract<Expr, { k: 'opasgn' }>, frame: Frame): Gen {
  const { target, op } = e;
  let read: () => Gen;
  let write: (value: Value) => Gen<void>;
  switch (target.k) {
    case 'index': {
      const recv = yield* ev(target.recv, frame);
      const { args } = yield* evalArgs(target.args, frame);
      read = () => callMethod(recv, '[]', args);
      write = function* (value) {
        yield* callMethod(recv, '[]=', [...args, value]);
      };
      break;
    }
    case 'attr': {
      const recv = yield* ev(target.recv, frame);
      if (target.safe && recv === NIL) return NIL;
      const fcall = target.recv.k === 'self';
      read = () => callMethod(recv, target.name, [], undefined, undefined, { fcall });
      write = function* (value) {
        yield* callMethod(recv, `${target.name}=`, [value], undefined, undefined, { fcall });
      };
      break;
    }
    case 'const': {
      read = () => ev({ k: 'const', name: target.name, scope: target.scope, top: target.top, row: target.row }, frame);
      write = (value) => assign(target, value, frame);
      if (op === '||') {
        const module = frame.cref[0];
        if (!target.scope && !target.top && findConstInAncestors(module, target.name) === undefined) {
          const value = yield* ev(e.value, frame);
          yield* write(value);
          return value;
        }
      }
      break;
    }
    case 'cvar': {
      read = function* () {
        if (op === '||') {
          try {
            return classVariableGet(frame, target.name);
          } catch (error) {
            if (error instanceof RubyError && error.exception.cls === rt().c.NameError) return NIL;
            throw error;
          }
        }
        return classVariableGet(frame, target.name);
      };
      write = (value) => assign(target, value, frame);
      break;
    }
    default: {
      read = () => ev(target as Expr, frame);
      write = (value) => assign(target, value, frame);
    }
  }
  const current = yield* read();
  if (op === '||') {
    if (truthy(current)) return current;
    const value = yield* ev(e.value, frame);
    yield* write(value);
    return value;
  }
  if (op === '&&') {
    if (!truthy(current)) return current;
    const value = yield* ev(e.value, frame);
    yield* write(value);
    return value;
  }
  const operand = yield* ev(e.value, frame);
  const value = yield* callMethod(current, op, [operand]);
  yield* write(value);
  return value;
}

// Control structures --------------------------------------------------------------------------------------------------

function* evalWhile(e: Extract<Expr, { k: 'while' }>, frame: Frame): Gen {
  const runtime = rt();
  let first = e.doWhile;
  for (;;) {
    runtime.spend();
    if (!first) {
      const cond = truthy(yield* ev(e.cond, frame));
      if (cond === e.until) break;
    }
    first = false;
    try {
      yield* evalBody(e.body, frame);
    } catch (error) {
      if (error instanceof BreakSignal && error.tag === undefined) return error.value;
      if (error instanceof NextSignal) continue;
      throw error;
    }
  }
  return NIL;
}

function* evalFor(e: Extract<Expr, { k: 'for' }>, frame: Frame): Gen {
  const runtime = rt();
  const iterable = yield* ev(e.iter, frame);
  const body = function* (item: Value): Gen {
    runtime.currentRow = e.row;
    yield* assign(e.target, item, frame);
    runtime.steps.stepBinding(e.row, e.target.k === 'mlhs' || storesAnswer(item));
    try {
      yield* evalBody(e.body, frame);
    } catch (error) {
      if (error instanceof NextSignal) return NIL;
      throw error;
    }
    return NIL;
  };
  const proc = nativeProc(1, (args) => body(args.length === 1 ? args[0] : arr(args)));
  try {
    yield* callMethod(iterable, 'each', [], undefined, proc);
  } catch (error) {
    if (error instanceof BreakSignal && error.tag === undefined) return error.value;
    throw error;
  }
  return iterable;
}

/** Whether a value is one learners answer in a trace: a number, a string, a symbol, a boolean, or nil. */
export function storesAnswer(value: Value): boolean {
  return typeof value !== 'object' || value === NIL || value instanceof RString || value instanceof RSymbol;
}

function* evalCase(e: Extract<Expr, { k: 'case' }>, frame: Frame): Gen {
  const runtime = rt();
  const subject = e.subject ? yield* ev(e.subject, frame) : undefined;
  for (const when of e.whens) {
    runtime.currentRow = when.row;
    for (const condition of when.conds) {
      const candidates =
        condition.k === 'splat' ? yield* splatItems(yield* ev(condition.e, frame)) : [yield* ev(condition, frame)];
      for (const candidate of candidates) {
        const matched = subject === undefined ? truthy(candidate) : yield* caseEquals(candidate, subject);
        if (matched) return yield* evalBody(when.body, frame);
      }
    }
  }
  return e.else ? yield* evalBody(e.else, frame) : NIL;
}

function returnTarget(frame: Frame): Frame {
  let target = frame;
  while (target.kind === 'block' && !target.extra.isLambda) target = target.extra.outer as Frame;
  if (target.kind === 'main' && frame.kind === 'block') {
    throw rubyError(rt().c.LocalJumpError, 'unexpected return');
  }
  if (target.extra.finished) throw rubyError(rt().c.LocalJumpError, 'unexpected return');
  return target;
}

function* evalBegin(e: Extract<Expr, { k: 'begin' }>, frame: Frame): Gen {
  const runtime = rt();
  try {
    for (;;) {
      let value: Value;
      try {
        value = yield* evalBody(e.body, frame);
      } catch (error) {
        if (!(error instanceof RubyError) || e.rescues.length === 0) throw error;
        const handled = yield* rescueClause(e, error, frame);
        if (handled === RETRY) continue;
        return handled.value;
      }
      if (e.else) value = yield* evalBody(e.else, frame);
      return value;
    }
  } finally {
    if (e.ensure) {
      const saved = runtime.currentRow;
      yield* evalBody(e.ensure, frame);
      runtime.currentRow = saved;
    }
  }
}

const RETRY = Symbol('retry');

function* rescueClause(
  e: Extract<Expr, { k: 'begin' }>,
  error: RubyError,
  frame: Frame
): Gen<{ value: Value } | typeof RETRY> {
  const runtime = rt();
  const { exception } = error;
  for (const rescue of e.rescues) {
    runtime.currentRow = rescue.row;
    let matched = false;
    if (rescue.classes.length === 0) {
      matched = isA(exception, runtime.c.StandardError);
    } else {
      const classes = yield* evalList(rescue.classes, frame);
      for (const cls of classes) {
        if (!(cls instanceof RClass)) throw typeError('class or module required for rescue clause');
        if (isA(exception, cls)) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) continue;
    const savedError = runtime.globals.get('$!') ?? NIL;
    runtime.globals.set('$!', exception);
    frame.handling.push(exception);
    try {
      if (rescue.variable) {
        yield* assign(rescue.variable, exception, frame);
        runtime.steps.stepBinding(rescue.row, false);
      }
      return { value: yield* evalBody(rescue.body, frame) };
    } catch (error_) {
      if (error_ instanceof RetrySignal) return RETRY;
      throw error_;
    } finally {
      frame.handling.pop();
      runtime.globals.set('$!', savedError);
    }
  }
  throw error;
}

// Definitions ---------------------------------------------------------------------------------------------------------

function* defineMethod(def: MethodDef, singleton: Expr | undefined, frame: Frame): Gen {
  const runtime = rt();
  let owner: RClass;
  let visibility: Visibility = 'public';
  if (singleton) {
    const object = yield* ev(singleton, frame);
    if (!(object instanceof RBasic)) throw typeError(`can't define singleton`);
    owner = singletonClassOf(object);
  } else if (frame.kind === 'class') {
    owner = frame.self as RClass;
    visibility = frame.defaultVisibility;
  } else if (frame.home.kind === 'main') {
    owner = runtime.c.Object;
    visibility = frame.kind === 'main' ? 'private' : 'public';
    if (frame.kind === 'block') visibility = 'private';
  } else {
    owner = frame.cref[0];
  }
  if (PRIVATE_METHOD_NAMES.has(def.name)) visibility = 'private';
  const method: RMethod = {
    name: def.name,
    owner,
    visibility,
    body: { kind: 'user', def, cref: frame.cref },
  };
  addMethod(owner, method);
  if (!singleton && frame.kind === 'class' && frame.moduleFunction) {
    const copy: RMethod = { ...method, owner: singletonClassOf(owner), visibility: 'public' };
    addMethod(copy.owner, copy);
    method.visibility = 'private';
  }
  return RSymbol.of(def.name);
}

const PRIVATE_METHOD_NAMES = new Set(['initialize', 'initialize_copy', 'initialize_clone', 'initialize_dup']);

export function addMethod(owner: RClass, method: RMethod): void {
  owner.methods.set(method.name, method);
  invalidateMethodCaches();
}

function* moduleContainer(e: { scope?: Expr; top?: boolean }, frame: Frame): Gen<RClass> {
  if (e.scope) {
    const scope = yield* ev(e.scope, frame);
    if (!(scope instanceof RClass)) throw typeError(`${yield* inspect(scope)} is not a class/module`);
    return scope;
  }
  if (e.top) return rt().c.Object;
  return frame.cref[0];
}

function* defineClass(e: Extract<Expr, { k: 'class' }>, frame: Frame): Gen {
  const runtime = rt();
  const container = yield* moduleContainer(e, frame);
  const superclass = e.superclass ? yield* ev(e.superclass, frame) : undefined;
  if (superclass !== undefined && (!(superclass instanceof RClass) || superclass.isModule)) {
    throw typeError(`superclass must be an instance of Class (given an instance of ${realClassOf(superclass).name})`);
  }
  const existing = container.constants.get(e.name);
  let cls: RClass;
  if (existing !== undefined) {
    if (!(existing instanceof RClass) || existing.isModule) throw typeError(`${e.name} is not a class`);
    if (superclass && existing.superclass !== superclass) throw typeError(`superclass mismatch for class ${e.name}`);
    cls = existing;
  } else {
    const parent = (superclass as RClass | undefined) ?? runtime.c.Object;
    if (parent.isSingleton) throw typeError("can't make subclass of singleton class");
    if (parent === runtime.c.Class) throw typeError("can't make subclass of Class");
    cls = new RClass(runtime.c.Class, e.name, parent, false);
    cls.isUserDefined = true;
    if (container !== runtime.c.Object) cls.lexicalParent = container;
    container.constants.set(e.name, cls);
    invalidateMethodCaches();
    yield* callHook(parent, 'inherited', [cls]);
  }
  return yield* runModuleBody(cls, e.body, frame);
}

function* callHook(target: RClass, name: string, args: Value[]): Gen<void> {
  const method = classOf(target).findMethod(name);
  if (method && method.body.kind === 'user') yield* invoke(method, target, args, undefined, undefined, false);
}

function* defineModule(e: Extract<Expr, { k: 'module' }>, frame: Frame): Gen {
  const runtime = rt();
  const container = yield* moduleContainer(e, frame);
  const existing = container.constants.get(e.name);
  let module: RClass;
  if (existing !== undefined) {
    if (!(existing instanceof RClass) || !existing.isModule) throw typeError(`${e.name} is not a module`);
    module = existing;
  } else {
    module = new RClass(runtime.c.Module, e.name, undefined, true);
    module.isUserDefined = true;
    if (container !== runtime.c.Object) module.lexicalParent = container;
    container.constants.set(e.name, module);
  }
  return yield* runModuleBody(module, e.body, frame);
}

function* runModuleBody(module: RClass, body: Body, frame: Frame): Gen {
  const runtime = rt();
  const classFrame = new Frame('class', module, new Scope(), [module, ...frame.cref], undefined, false, false, {});
  runtime.pushFrame(classFrame);
  try {
    return yield* evalBody(body, classFrame);
  } finally {
    runtime.popFrame();
  }
}

// Calls ---------------------------------------------------------------------------------------------------------------

export interface CallOptions {
  /** Whether the call has no explicit receiver, which may call private methods. */
  fcall?: boolean;
  /** Whether the call is a bare name, which reports a missing method as a missing variable too. */
  vcall?: boolean;
  /** Whether the caller uses the result, which decides whether the method's last statement is a step. */
  used?: boolean;
}

function* evalCall(e: Call, frame: Frame): Gen {
  let recv: Value;
  if (e.recv) {
    recv = yield* ev(e.recv, frame);
    if (e.safe && recv === NIL) return NIL;
  } else {
    recv = frame.self;
  }
  const { args, keywords } = yield* evalArgs(e.args, frame);
  let block: RProc | undefined;
  if (e.block) {
    block = makeBlock(e.block, frame);
  } else if (e.blockArg) {
    block = yield* toBlock(yield* ev(e.blockArg, frame));
  }
  const used = e.used === 1 || (e.used === 2 && frame.resultUsed);
  if (!e.block) return yield* callMethod(recv, e.name, args, keywords, block, { fcall: e.fcall, vcall: e.vcall, used });
  const proc = block as RProc;
  proc.callSiteActive = true;
  try {
    return yield* callMethod(recv, e.name, args, keywords, proc, { fcall: e.fcall, vcall: e.vcall, used });
  } catch (error) {
    if (error instanceof BreakSignal && error.tag === proc.breakTag) return error.value;
    throw error;
  } finally {
    proc.callSiteActive = false;
  }
}

/** Converts the value of a `&blk` argument into the block to pass: a proc, or what `to_proc` makes of it. */
export function* toBlock(value: Value): Gen<RProc | undefined> {
  if (value === NIL) return undefined;
  if (value instanceof RProc) return value;
  if (respondsTo(value, 'to_proc')) {
    const converted = yield* callMethod(value, 'to_proc', []);
    if (converted instanceof RProc) return converted;
    const name = realClassOf(value).name;
    throw typeError(`can't convert ${name} to Proc (${name}#to_proc gives ${realClassOf(converted).name})`);
  }
  throw typeError(`wrong argument type ${realClassOf(value).name} (expected Proc)`);
}

/** Evaluates call arguments: splats expand, and a trailing braceless hash becomes the keyword arguments. */
export function* evalArgs(items: Expr[], frame: Frame): Gen<{ args: Value[]; keywords: RHash | undefined }> {
  const last = items.at(-1);
  if (last?.k === 'hash' && !last.braces) {
    const args = yield* evalList(items.slice(0, -1), frame);
    const keywords = yield* evalHash(last, frame);
    return { args, keywords: keywords.map.size > 0 ? keywords : undefined };
  }
  return { args: yield* evalList(items, frame), keywords: undefined };
}

export function respondsTo(value: Value, name: string, includePrivate = false): boolean {
  const method = classOf(value).findMethod(name);
  return method !== undefined && (includePrivate || method.visibility !== 'private');
}

/** Calls a method by name, as `recv.name(*args, **keywords, &block)` does. */
export function* callMethod(
  recv: Value,
  name: string,
  args: Value[],
  keywords?: RHash,
  block?: RProc,
  options: CallOptions = {}
): Gen {
  rt().spend();
  const method = classOf(recv).findMethod(name);
  if (!method) return yield* methodMissing(recv, name, args, options);
  if (method.visibility !== 'public' && !options.fcall) {
    if (method.visibility === 'private' && !name.endsWith('=')) {
      throw noMethodError(`private method '${name}' called for ${receiverDescription(recv)}`, recv, name);
    }
    if (method.visibility === 'protected' && !isA(rt().frame.self, method.owner)) {
      throw noMethodError(`protected method '${name}' called for ${receiverDescription(recv)}`, recv, name);
    }
  }
  return yield* invoke(method, recv, args, keywords, block, options.used ?? true);
}

function* methodMissing(recv: Value, name: string, args: Value[], options: CallOptions): Gen {
  if (options.vcall) {
    throw nameError(`undefined local variable or method '${name}' for ${receiverDescription(recv)}`, recv, name);
  }
  void args;
  throw noMethodError(`undefined method '${name}' for ${receiverDescription(recv)}`, recv, name);
}

/** Calls a method that lookup found. */
export function* invoke(
  method: RMethod,
  recv: Value,
  args: Value[],
  keywords: RHash | undefined,
  block: RProc | undefined,
  used: boolean
): Gen {
  const runtime = rt();
  const { body } = method;
  switch (body.kind) {
    case 'native': {
      let actual = args;
      if (!body.takesKeywords && keywords) actual = [...args, keywords];
      if (actual.length < body.min || (body.max >= 0 && actual.length > body.max)) {
        throw argumentCountError(actual.length, body.min, body.max);
      }
      const held = runtime.held.length;
      runtime.held.push(recv, ...actual);
      if (block) runtime.held.push(block);
      try {
        const result = body.fn(recv, actual, block, body.takesKeywords ? keywords : undefined);
        return isGenerator(result) ? yield* result : result;
      } finally {
        runtime.held.length = held;
      }
    }
    case 'reader': {
      const count = args.length + (keywords ? 1 : 0);
      if (count !== 0) throw argumentCountError(count, 0, 0);
      return ivarGet(recv, body.ivar);
    }
    case 'writer': {
      const count = args.length + (keywords ? 1 : 0);
      if (count !== 1) throw argumentCountError(count, 1, 1);
      const value = args[0] ?? keywords;
      ivarSet(recv, body.ivar, value as Value);
      return value as Value;
    }
    case 'user': {
      return yield* invokeUser(method, body.def, body.cref, recv, args, keywords, block, used);
    }
    case 'undefined': {
      throw noMethodError(`undefined method '${method.name}' for ${receiverDescription(recv)}`, recv, method.name);
    }
  }
}

function* invokeUser(
  method: RMethod,
  def: MethodDef,
  cref: RClass[],
  recv: Value,
  args: Value[],
  keywords: RHash | undefined,
  block: RProc | undefined,
  used: boolean
): Gen {
  const runtime = rt();
  const frame = new Frame('method', recv, new Scope(), cref, runtime.currentRow, def.isAtomic, used, {
    method,
    def,
    block,
    args,
    keywords,
  });
  runtime.pushFrame(frame);
  const savedRow = runtime.currentRow;
  try {
    yield* bindParams(def.params, frame, args, keywords, 'method');
    return yield* evalBody(def.body, frame);
  } catch (error) {
    if (error instanceof ReturnSignal && error.target === frame) return error.value;
    throw error;
  } finally {
    frame.extra.finished = true;
    runtime.popFrame();
    runtime.currentRow = savedRow;
    if (def.isAtomic) runtime.steps.completeAtomicCall();
  }
}

function* evalSuper(e: Extract<Expr, { k: 'super' }>, frame: Frame): Gen {
  const home = frame.home;
  const method = home.extra.method;
  if (!method || home.kind !== 'method') {
    throw rubyError(rt().c.RuntimeError, 'super called outside of method');
  }
  let args: Value[];
  let keywords: RHash | undefined;
  if (e.args) {
    ({ args, keywords } = yield* evalArgs(e.args, frame));
  } else {
    ({ args, keywords } = implicitSuperArgs(home));
  }
  let block: RProc | undefined = home.extra.block;
  if (e.block) block = makeBlock(e.block, frame);
  else if (e.blockArg) block = yield* toBlock(yield* ev(e.blockArg, frame));
  const superMethod = classOf(home.self).findSuperMethod(method.name, method.owner);
  if (!superMethod) {
    throw noMethodError(
      `super: no superclass method '${method.name}' for ${receiverDescription(home.self)}`,
      home.self,
      method.name
    );
  }
  const used = e.used === 1 || (e.used === 2 && frame.resultUsed);
  if (!e.block) return yield* invoke(superMethod, home.self, args, keywords, block, used);
  const proc = block as RProc;
  proc.callSiteActive = true;
  try {
    return yield* invoke(superMethod, home.self, args, keywords, proc, used);
  } catch (error) {
    if (error instanceof BreakSignal && error.tag === proc.breakTag) return error.value;
    throw error;
  } finally {
    proc.callSiteActive = false;
  }
}

/** The arguments `super` without parentheses passes: the method's parameters' current values. */
function implicitSuperArgs(frame: Frame): { args: Value[]; keywords: RHash | undefined } {
  const def = frame.extra.def as MethodDef;
  const { params } = def;
  const scope = frame.scope;
  const value = (name: ParamTarget): Value => (typeof name === 'string' ? scope.lookup(name, 0) : NIL);
  const args: Value[] = [...params.required.map(value), ...params.optional.map((param) => value(param.name))];
  if (params.rest !== undefined) {
    const rest = params.rest === '' ? NIL : scope.lookup(params.rest, 0);
    if (rest instanceof RArray) args.push(...rest.items);
  }
  args.push(...params.post.map(value));
  let keywords: RHash | undefined;
  if (params.keywords.length > 0 || params.keywordRest) {
    keywords = newHash();
    for (const keyword of params.keywords) {
      runToEnd(hashSet(keywords, RSymbol.of(keyword.name), scope.lookup(keyword.name, 0)));
    }
    if (params.keywordRest) {
      const rest = scope.lookup(params.keywordRest, 0);
      if (rest instanceof RHash)
        for (const entry of rest.map.values()) runToEnd(hashSet(keywords, entry.key, entry.value));
    }
    if (keywords.map.size === 0) keywords = undefined;
  }
  return { args, keywords };
}

// Parameters ----------------------------------------------------------------------------------------------------------

type BindMode = 'method' | 'lambda' | 'proc';

// code-gauge-allow functionCognitiveComplexity 40 -- Ruby's argument binding rules.
export function* bindParams(
  params: Params,
  frame: Frame,
  given: Value[],
  keywords: RHash | undefined,
  mode: BindMode
): Gen<void> {
  const { scope } = frame;
  const takesKeywords = params.keywords.length > 0 || params.keywordRest !== undefined;
  let args = given;
  if (keywords && !takesKeywords) {
    args = [...args, keywords];
    keywords = undefined;
  }
  const required = params.required.length + params.post.length;
  const optional = params.optional.length;
  if (mode === 'proc') {
    if (args.length === 1 && args[0] instanceof RArray && autoSplats(params)) args = [...args[0].items];
  } else if (args.length < required || (params.rest === undefined && args.length > required + optional)) {
    const missingKeywords = params.keywords.filter((keyword) => !keyword.value).map((keyword) => keyword.name);
    const max = params.rest === undefined ? required + optional : -1;
    let message = `wrong number of arguments (given ${args.length}, expected ${expectedArity(required, max)}`;
    if (missingKeywords.length > 0 && !keywords) {
      message += `; required keyword${missingKeywords.length > 1 ? 's' : ''}: ${missingKeywords.join(', ')}`;
    }
    throw argumentError(`${message})`);
  }
  let index = 0;
  for (const param of params.required) yield* bindParam(param, args[index++] ?? NIL, frame);
  const available = Math.max(0, args.length - required);
  const optionalCount = Math.min(optional, available);
  for (const [position, param] of params.optional.entries()) {
    if (position < optionalCount) scope.vars.set(param.name, args[index++]);
    else scope.vars.set(param.name, yield* ev(param.value, frame));
  }
  if (params.rest !== undefined) {
    const restCount = Math.max(0, args.length - index - params.post.length);
    const rest = arr(args.slice(index, index + restCount));
    if (params.rest !== '') scope.vars.set(params.rest, rest);
    index += restCount;
  }
  for (const param of params.post) yield* bindParam(param, args[index++] ?? NIL, frame);
  if (takesKeywords) yield* bindKeywords(params, frame, keywords);
  if (params.block !== undefined) scope.vars.set(params.block, frame.extra.block ?? NIL);
}

function* bindParam(param: ParamTarget, value: Value, frame: Frame): Gen<void> {
  if (typeof param === 'string') frame.scope.vars.set(param, value);
  else yield* destructure(param, value, frame);
}

function autoSplats(params: Params): boolean {
  const positional = params.required.length + params.optional.length + params.post.length;
  return positional > 1 || params.trailingComma || (params.rest !== undefined && positional > 0);
}

function* bindKeywords(params: Params, frame: Frame, keywords: RHash | undefined): Gen<void> {
  const { scope } = frame;
  const given = new Map<string, Value>();
  const extra = newHash();
  if (keywords) {
    for (const entry of keywords.map.values()) {
      if (
        entry.key instanceof RSymbol &&
        params.keywords.some((keyword) => keyword.name === (entry.key as RSymbol).name)
      ) {
        given.set(entry.key.name, entry.value);
      } else {
        yield* hashSet(extra, entry.key, entry.value);
      }
    }
  }
  const missing = params.keywords.filter((keyword) => !keyword.value && !given.has(keyword.name));
  if (missing.length > 0) {
    const names = missing.map((keyword) => `:${keyword.name}`).join(', ');
    throw argumentError(`missing keyword${missing.length > 1 ? 's' : ''}: ${names}`);
  }
  if (params.keywordRest === undefined && extra.map.size > 0) {
    const names = [];
    for (const entry of extra.map.values()) names.push(yield* inspect(entry.key));
    throw argumentError(`unknown keyword${names.length > 1 ? 's' : ''}: ${names.join(', ')}`);
  }
  for (const keyword of params.keywords) {
    const value = given.get(keyword.name);
    scope.vars.set(keyword.name, value ?? (keyword.value ? yield* ev(keyword.value, frame) : NIL));
  }
  if (params.keywordRest) scope.vars.set(params.keywordRest, extra);
}

// Blocks --------------------------------------------------------------------------------------------------------------

declare module './objects' {
  interface RProc {
    /** Whether the call that received this block literal is still running, so that `break` can leave it. */
    callSiteActive?: boolean;
  }
}

export function makeBlock(def: BlockDef, frame: Frame): RProc {
  const proc = new RProc(rt().c.Proc, { kind: 'block', def }, frame.self, frame as never);
  proc.breakTag = {};
  return proc;
}

export function nativeProc(arity: number, call: (args: Value[], block?: RProc) => Value | Gen, lambda = false): RProc {
  const proc = new RProc(rt().c.Proc, { kind: 'native', arity, lambda, call }, NIL, undefined);
  proc.isLambda = lambda;
  proc.breakTag = {};
  return proc;
}

export interface ProcCallOptions {
  keywords?: RHash;
  block?: RProc;
  /** Whether the caller uses the block's value, which decides whether its last statement is a step. */
  used?: boolean;
  /** The row of the `yield` or `call` that runs the block; undefined when library code runs it. */
  callRow?: number;
  self?: Value;
}

/** Calls a block or proc with arguments, binding them as a block (or a lambda) does. */
export function* callProc(proc: RProc, args: Value[], options: ProcCallOptions = {}): Gen {
  const runtime = rt();
  runtime.spend();
  const { body } = proc;
  if (body.kind === 'native') {
    if (body.lambda && body.arity >= 0 && args.length !== body.arity) {
      throw argumentCountError(args.length, body.arity, body.arity);
    }
    const result = body.call(args, options.block);
    return isGenerator(result) ? yield* result : result;
  }
  const { def } = body;
  const outer = proc.outer as unknown as Frame;
  const frame = new Frame(
    'block',
    options.self ?? proc.self,
    new Scope(outer.scope),
    outer.cref,
    options.callRow,
    false,
    options.used ?? true,
    {
      home: outer.home,
      outer,
      proc,
      blockDef: def,
      isLambda: proc.isLambda,
      block: options.block ?? outer.home.extra.block,
      method: outer.home.extra.method,
      def: outer.home.extra.def,
    }
  );
  if (options.block) frame.extra.block = options.block;
  runtime.pushFrame(frame);
  const savedRow = runtime.currentRow;
  try {
    if (!def.params && proc.isLambda && (args.length > 0 || options.keywords)) {
      throw argumentCountError(args.length + (options.keywords ? 1 : 0), 0, 0);
    }
    if (def.params) {
      yield* bindParams(def.params, frame, args, options.keywords, proc.isLambda ? 'lambda' : 'proc');
      if (hasParams(def.params)) {
        runtime.currentRow = def.row;
        runtime.steps.stepBinding(def.row, storesAnswers(def.params, frame));
      }
    }
    return yield* evalBody(def.body, frame);
  } catch (error) {
    if (error instanceof NextSignal) return error.value;
    if (proc.isLambda) {
      if (error instanceof ReturnSignal && error.target === frame) return error.value;
      if (error instanceof BreakSignal && error.tag === proc.breakTag) return error.value;
    }
    throw error;
  } finally {
    runtime.popFrame();
    runtime.currentRow = savedRow;
  }
}

function hasParams(params: Params): boolean {
  return (
    params.required.length + params.optional.length + params.post.length + params.keywords.length > 0 ||
    params.rest !== undefined ||
    params.keywordRest !== undefined
  );
}

/** Whether a block's parameters store values learners answer: several parameters destructure, as JavaScript's do. */
function storesAnswers(params: Params, frame: Frame): boolean {
  const names = [...params.required, ...params.optional.map((param) => param.name), ...params.post];
  if (names.length !== 1 || params.rest !== undefined) return true;
  const [name] = names;
  return typeof name !== 'string' || storesAnswer(frame.scope.vars.get(name) ?? NIL);
}

/** Calls the block a native method received; `used` tells whether the method uses the block's value. */
export function callBlock(block: RProc, args: Value[], used = true): Gen {
  return callProc(block, args, { used });
}

/** Raises when a native method that needs a block received none. */
export function requireBlock(block: RProc | undefined): RProc {
  if (!block) throw rubyError(rt().c.LocalJumpError, 'no block given (yield)');
  return block;
}

export function objectFrame(): Frame {
  return rt().frame;
}

export { hashGet, RObject, RString };

export function truthyValue(value: Value): boolean {
  return truthy(value);
}
