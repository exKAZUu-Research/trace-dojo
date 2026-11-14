import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
// code-gauge-allow-file fileNcss 931 -- The interp module keeps one concern's cases together.
import type {
  BlockDef,
  Body,
  Call,
  Expr,
  MethodDef,
  MultiTarget,
  Params,
  ParamTarget,
  Stmt,
  StrPart,
  Target,
} from './ast';
import { caseEquals, combinedStringEncoding, inspect, numericCompare, toS, toSValue } from './conversions';
import {
  argumentCountError,
  argumentError,
  frozenError,
  implicitConversionError,
  nameError,
  noMethodError,
  receiverDescription,
  rubyError,
  typeError,
} from './errors';
import { hashGet, hashSet, hashSetStored } from './hashes';
import { makeRational } from './libRational';
import { lastMatch, makeRegexp, matchGlobal } from './libRegexp';
import {
  boxFloat,
  invalidateMethodCaches,
  NIL,
  RArray,
  RBasic,
  RClass,
  RFloat,
  RHash,
  type RMethod,
  RObject,
  RProc,
  RString,
  RSymbol,
  type Value,
  type Visibility,
} from './objects';
import { bindParams } from './params';
import { guardFailed, matchPattern, noMatchingPattern } from './patterns';
import {
  BreakSignal,
  Frame,
  NextSignal,
  RedoSignal,
  RetrySignal,
  ReturnSignal,
  rootValues,
  rt,
  RubyError,
  Scope,
  ThrowSignal,
  UnsupportedFeatureError,
  whileHeld,
} from './runtime';
import { CORE_CLASSES, CORE_MODULES, UNSUPPORTED_CONSTANTS } from './unsupportedNames';
import {
  arr,
  classOf,
  isA,
  newHash,
  range,
  realClassOf,
  singletonClassOf,
  str,
  stringBytes,
  stringFromBytes,
  truthy,
} from './values';

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
  const flattened = flattenGenerator(generator);
  const result = flattened.next();
  if (!result.done) {
    flattened.return(undefined as T);
    throw new Error('A Ruby evaluation suspended outside an enumerator');
  }
  return result.value;
}

export function* flattenGenerator<T>(generator: Generator<unknown, T, unknown>): Generator<unknown, T, unknown> {
  const stack: Generator<unknown, unknown, unknown>[] = [generator];
  let input: unknown;
  let pendingError: unknown;
  let failed = false;
  try {
    while (stack.length > 0) {
      let result: IteratorResult<unknown, unknown>;
      try {
        result = failed ? stack.at(-1)!.throw(pendingError) : stack.at(-1)!.next(input);
        failed = false;
        input = undefined;
      } catch (error) {
        stack.pop();
        if (stack.length === 0) throw error;
        pendingError = error;
        failed = true;
        continue;
      }
      if (result.done) {
        stack.pop();
        if (stack.length === 0) return result.value as T;
        input = result.value;
      } else if (isGenerator(result.value)) stack.push(result.value);
      else input = yield result.value;
    }
    throw new Error('A Ruby generator ended without a result');
  } finally {
    for (let index = stack.length - 1; index >= 0; index--) stack[index].return(undefined);
  }
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
  const { e } = statement;
  let { step } = statement;
  if (step === 'none' && e.k === 'call' && e.fcall && classOf(frame.self).findMethod(e.name)?.body.kind === 'user')
    step = 'call';
  if (step === 'none') return yield* ev(e, frame);
  if (step === 'constant') {
    const mark = runtime.steps.statementMark();
    const userCalls = runtime.userCallVersion;
    const value = yield* ev(e, frame);
    if (runtime.userCallVersion !== userCalls) runtime.steps.completeStatement(statement.row, false, mark);
    return value;
  }
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
  return e.k === 'asgn' && e.target.k !== 'mlhs' && createsObjects(e.value);
}

/** Whether a value expression only creates objects: `Foo.new(...)`, or an array literal of such creations. */
function createsObjects(e: Expr): boolean {
  if (e.k === 'call') return e.name === 'new' && !!e.recv;
  return e.k === 'array' && e.items.length > 0 && e.items.every((item) => createsObjects(item));
}

// Expressions ---------------------------------------------------------------------------------------------------------

export function* ev(e: Expr, frame: Frame): Gen {
  switch (e.k) {
    case 'int': {
      return e.v;
    }
    case 'float': {
      return boxFloat(e.v);
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
      return yield* interpolateString(e.parts, frame);
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
      const mark = frame.temporaries.length;
      frame.temporaries.push(from);
      try {
        const to = e.to ? yield* ev(e.to, frame) : NIL;
        return yield* makeRange(from, to, e.exclusive);
      } finally {
        frame.temporaries.length = mark;
      }
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
      const prepared = yield* prepareAssignment(e.target, frame);
      if (prepared.skip) return NIL;
      const mark = frame.temporaries.length;
      rootValues(frame, prepared.roots);
      try {
        const value = yield* ev(e.value, frame);
        frame.temporaries.push(value);
        yield* prepared.write(value);
        return value;
      } finally {
        frame.temporaries.length = mark;
      }
    }
    case 'opasgn': {
      return yield* operatorAssign(e, frame);
    }
    case 'call': {
      return yield* atCallRow(e.row, () => evalCall(e, frame));
    }
    case 'super': {
      return yield* atCallRow(e.row, () => evalSuper(e, frame));
    }
    case 'yield': {
      return yield* atCallRow(e.row, function* () {
        const { args, keywords } = yield* evalArgs(e.args, frame);
        const block = frame.home.extra.block;
        if (!block) throw rubyError(rt().c.LocalJumpError, 'no block given (yield)');
        const used = e.used === 1 || (e.used === 2 && frame.resultUsed);
        rt().currentRow = e.row;
        return yield* callProc(block, args, { keywords, used, callRow: rt().currentRow });
      });
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
      if (truthy(yield* ev(e.cond, frame))) return yield* evalBody(e.consequent, frame);
      return e.alternative ? yield* evalBody(e.alternative, frame) : NIL;
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
      if (!proc.isLambda && !proc.callSiteState?.active)
        throw rubyError(rt().c.LocalJumpError, 'break from proc-closure');
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
    case 'sclass': {
      const target = yield* ev(e.target, frame);
      if (!(target instanceof RBasic)) throw typeError("can't define singleton");
      return yield* runModuleBody(singletonClassOf(target), e.body, frame);
    }
    case 'alias': {
      const owner = frame.kind === 'class' ? (frame.self as RClass) : (frame.extra.definee ?? frame.cref[0]);
      const method = owner.findMethod(e.oldName);
      if (!method) {
        throw nameError(`undefined method '${e.oldName}' for class '${owner.name}'`, owner, e.oldName);
      }
      owner.methods.set(e.newName, { ...method });
      invalidateMethodCaches();
      return NIL;
    }
    case 'undef': {
      const owner = frame.kind === 'class' ? (frame.self as RClass) : frame.cref[0];
      for (const name of e.names) {
        if (!owner.findMethod(name))
          throw nameError(`undefined method '${name}' for class '${owner.name}'`, owner, name);
        addMethod(owner, { name, owner, visibility: 'public', body: { kind: 'undefined' } });
      }
      return NIL;
    }
    case 'redo': {
      throw new RedoSignal();
    }
    case 'defined': {
      return yield* definedText(e.e, frame);
    }
    case 'caseIn': {
      const subject = yield* ev(e.subject, frame);
      for (const clause of e.clauses) {
        rt().currentRow = clause.row;
        if (!(yield* matchPattern(clause.pattern, subject, frame))) continue;
        if (clause.guard && truthy(yield* ev(clause.guard.cond, frame)) === clause.guard.unless) {
          guardFailed();
          continue;
        }
        return yield* evalBody(clause.body, frame);
      }
      if (e.else) return yield* evalBody(e.else, frame);
      throw yield* noMatchingPattern(subject, e.clauses.length === 1);
    }
    case 'matchPattern': {
      const value = yield* ev(e.value, frame);
      const matched = yield* matchPattern(e.pattern, value, frame);
      if (e.raise && !matched) throw yield* noMatchingPattern(value, true);
      return e.raise ? NIL : matched;
    }
    case 'rational': {
      return makeRational(e.numerator, e.denominator);
    }
    case 'atExit': {
      const proc = makeBlock(e.block, frame);
      rt().atExit.push(proc);
      return proc;
    }
    case 'encoding': {
      return constInModule(rt().c.Encoding, 'UTF_8');
    }
    case 'regex': {
      let source = '';
      for (const part of e.parts) {
        if (typeof part === 'string') source += part;
        else if ('text' in part) source += part.text;
        else {
          const value = yield* ev(part, frame);
          source += yield* toS(value);
        }
      }
      return makeRegexp(source, {
        ignoreCase: e.flags.includes('i'),
        multiline: e.flags.includes('m'),
        extended: e.flags.includes('x'),
      });
    }
    case 'matchWrite': {
      const result = yield* ev(e.match, frame);
      const match = lastMatch();
      for (const target of e.names) {
        const value = match === NIL ? NIL : yield* callMethod(match, '[]', [str(target.name)]);
        frame.scope.assign(target.name, target.depth, value);
      }
      return result;
    }
  }
}

function* atCallRow<T>(row: number, action: () => Gen<T>): Gen<T> {
  const runtime = rt();
  const saved = runtime.currentRow;
  runtime.currentRow = row;
  try {
    return yield* action();
  } finally {
    runtime.currentRow = saved;
  }
}

function* interpolate(parts: StrPart[], frame: Frame): Gen<string> {
  let text = '';
  for (const part of parts) {
    text += typeof part === 'string' ? part : 'text' in part ? part.text : yield* toS(yield* ev(part, frame));
  }
  if (text.length > 1_000_000) throw rubyError(rt().c.NoMemoryError, 'failed to allocate memory');
  return text;
}

function* interpolateString(parts: StrPart[], frame: Frame): Gen<RString> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let binary = false;
  let ascii = true;
  for (const [index, part] of parts.entries()) {
    const segment =
      typeof part === 'string'
        ? stringFromBytes(new TextEncoder().encode(part))
        : 'text' in part
          ? stringFromBytes(Uint8Array.from(part.bytes ?? new TextEncoder().encode(part.text)))
          : yield* toSValue(yield* ev(part, frame));
    const bytes = stringBytes(segment);
    binary =
      index === 0
        ? segment.binary && (bytes.length > 0 || parts.length > 1)
        : combinedStringEncoding(binary, ascii, segment);
    length += bytes.length;
    if (length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
    rt().spend(Math.ceil(bytes.length / 256));
    chunks.push(bytes);
    ascii &&= bytes.every((byte) => byte < 0x80);
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const bytes of chunks) {
    joined.set(bytes, offset);
    offset += bytes.length;
  }
  return stringFromBytes(joined, binary);
}

/** The values of a list of expressions, with splats (`*a`) expanded. */
function* evalList(items: Expr[], frame: Frame): Gen<Value[]> {
  const values: Value[] = [];
  // The values evaluated so far stay reachable while later ones run, as turtles they hold must not vanish.
  const mark = frame.temporaries.length;
  try {
    for (const item of items) {
      if (item.k === 'splat') {
        for (const value of yield* splatItems(yield* ev(item.e, frame))) {
          values.push(value);
          frame.temporaries.push(value);
        }
      } else {
        const value = yield* ev(item, frame);
        values.push(value);
        frame.temporaries.push(value);
      }
    }
  } finally {
    frame.temporaries.length = mark;
  }
  return values;
}

export function* splatItems(value: Value): Gen<Value[]> {
  if (value instanceof RArray) return [...value.items];
  if (value === NIL) return [];
  if (respondsTo(value, 'to_a', true)) {
    const converted = yield* callMethod(value, 'to_a', [], undefined, undefined, { fcall: true });
    if (converted instanceof RArray) return [...converted.items];
    if (converted === NIL) return [value];
    throw typeError(
      `can't convert ${realClassOf(value).name} to Array (${realClassOf(value).name}#to_a gives ${realClassOf(converted).name})`
    );
  }
  return [value];
}

function* evalHash(e: Extract<Expr, { k: 'hash' }>, frame: Frame): Gen<RHash> {
  const hash = newHash();
  const mark = frame.temporaries.length;
  frame.temporaries.push(hash);
  try {
    yield* fillHash(hash, e, frame);
  } finally {
    frame.temporaries.length = mark;
  }
  return hash;
}

function* fillHash(hash: RHash, e: Extract<Expr, { k: 'hash' }>, frame: Frame): Gen<void> {
  for (const item of e.items) {
    if ('splat' in item) {
      yield* copyHashSplat(hash, yield* ev(item.splat, frame), frame, e.braces);
      continue;
    }
    const key = yield* ev(item.key, frame);
    const mark = frame.temporaries.length;
    frame.temporaries.push(key);
    try {
      yield* hashSet(hash, key, yield* ev(item.value, frame));
    } finally {
      frame.temporaries.length = mark;
    }
  }
}

function* copyHashSplat(hash: RHash, value: Value, frame: Frame, literal: boolean): Gen<void> {
  if (value === NIL) return;
  if (!(value instanceof RHash)) {
    const source = value;
    if (!respondsTo(source, 'to_hash', true)) throw implicitConversionError(source, 'Hash');
    value = yield* callMethod(source, 'to_hash', [], undefined, undefined, { fcall: true });
    if (!(value instanceof RHash))
      throw typeError(
        `can't convert ${realClassOf(source).name} to Hash (${realClassOf(source).name}#to_hash gives ${realClassOf(value).name})`
      );
  }
  const sourceMark = frame.temporaries.length;
  frame.temporaries.push(value);
  value.iterating++;
  try {
    for (const [slot, entry] of value.map)
      yield* literal ? hashSet(hash, entry.key, entry.value) : hashSetStored(hash, slot, entry);
  } finally {
    value.iterating--;
    frame.temporaries.length = sourceMark;
  }
}

export function* makeRange(from: Value, to: Value, exclusive: boolean): Gen {
  if (from !== NIL && to !== NIL) {
    const comparable =
      (typeof from === 'bigint' || typeof from === 'number') && (typeof to === 'bigint' || typeof to === 'number');
    if (comparable && numericCompare(from as bigint | number, to as bigint | number) === undefined)
      throw argumentError('bad value for range');
    const nativeStrings =
      from instanceof RString &&
      to instanceof RString &&
      from.cls === rt().c.String &&
      to.cls === rt().c.String &&
      classOf(from).findMethod('<=>')?.body.kind === 'native';
    if (!comparable && !nativeStrings) {
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
    throw frozenError(self, runToEnd(inspect(self)));
  }
  if (self.frozen) throw frozenError(self, inspectForFrozen(self));
  self.ivars ??= new Map();
  if (!self.ivars.has(name)) rt().chargeSlots(1);
  self.ivars.set(name, value);
}

function inspectForFrozen(self: RBasic): string {
  return runToEnd(inspect(self));
}

function globalGet(name: string): Value {
  if (/^\$(?:[~&`'+]|[1-9]\d*)$/.test(name)) return matchGlobal(name);
  const unsupported = unsupportedGlobal(name);
  if (unsupported) throw new UnsupportedFeatureError(unsupported);
  if (name === '$_') return rt().frame.home.scope.vars.get(name) ?? NIL;
  return rt().globals.get(name) ?? NIL;
}

function unsupportedGlobal(name: string): string | undefined {
  if (/^\$(?:[&`'+~]|[1-9]\d*)$/.test(name)) return `正規表現のマッチの結果（${name}）`;
  if (name === '$$') return 'プロセス ID（$$）';
  if (/^\$-[a-zA-Z]$/.test(name)) return `起動オプション（${name}）`;
  return UNSUPPORTED_GLOBALS[name];
}

const UNSUPPORTED_GLOBALS: Record<string, string> = {
  $stdin: '標準入力（$stdin）',
  $0: '$0',
  $PROGRAM_NAME: '$PROGRAM_NAME',
  $LOAD_PATH: '$LOAD_PATH',
  $LOADED_FEATURES: '$LOADED_FEATURES',
  '$:': '$:',
  '$*': 'コマンドライン引数（$*）',
  $DEBUG: '$DEBUG',
  $VERBOSE: '$VERBOSE',
  $FILENAME: '$FILENAME',
  '$<': '標準入力（$<）',
  '$;': '$;',
};

function globalSet(name: string, value: Value): void {
  const unsupported = unsupportedGlobal(name);
  if (unsupported) throw new UnsupportedFeatureError(unsupported);
  if (name === '$!') throw nameError('$! is a read-only variable');
  if (name === '$_') {
    rt().frame.home.scope.vars.set(name, value);
    return;
  }
  if ((name === '$stdout' || name === '$stderr') && !respondsTo(value, 'write')) {
    throw typeError(`${name} must have write method, ${realClassOf(value).name} given`);
  }
  if (name === '$/' && value !== NIL && !(value instanceof RString)) throw typeError('value of $/ must be String');
  if ((name === '$,' || name === '$\\') && value !== NIL && !(value instanceof RString)) {
    throw typeError(`value of ${name} must be String`);
  }
  if (name === '$/' && value instanceof RString) {
    const separator = stringFromBytes(stringBytes(value), value.binary, value.usAscii);
    separator.frozen = true;
    rt().globals.set(name, separator);
    return;
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
      assertMutableClass(module);
      module.classVariables.set(name, value);
      return;
    }
  }
  assertMutableClass(holder);
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
  assertMutableClass(module);
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

interface PreparedAssignment {
  skip: boolean;
  roots: Value[];
  write: (value: Value) => Gen<void>;
}

function* prepareAssignment(target: Target, frame: Frame): Gen<PreparedAssignment> {
  if (target.k === 'index') {
    const recv = yield* ev(target.recv, frame);
    const mark = frame.temporaries.length;
    frame.temporaries.push(recv);
    let args: Value[];
    try {
      ({ args } = yield* evalArgs(target.args, frame));
    } finally {
      frame.temporaries.length = mark;
    }
    return {
      skip: false,
      roots: [recv, ...args],
      *write(value) {
        yield* atCallRow(target.row, () =>
          callMethod(recv, '[]=', [...args, value], undefined, undefined, { fcall: target.recv.k === 'self' })
        );
      },
    };
  }
  if (target.k === 'attr') {
    const recv = yield* ev(target.recv, frame);
    return {
      skip: target.safe && recv === NIL,
      roots: [recv],
      *write(value) {
        yield* atCallRow(target.row, () =>
          callMethod(recv, `${target.name}=`, [value], undefined, undefined, { fcall: target.recv.k === 'self' })
        );
      },
    };
  }
  if (target.k === 'const') {
    const module = yield* constantTargetModule(target, frame);
    return {
      skip: false,
      roots: [module],
      *write(value) {
        yield* [];
        constSet(module, target.name, value);
      },
    };
  }
  if (target.k === 'mlhs') {
    const targets: PreparedAssignment[] = [];
    const mark = frame.temporaries.length;
    try {
      for (const item of target.items) {
        const prepared = yield* prepareAssignment(item, frame);
        targets.push(prepared);
        rootValues(frame, prepared.roots);
      }
    } finally {
      frame.temporaries.length = mark;
    }
    return {
      skip: false,
      roots: targets.flatMap((prepared) => prepared.roots),
      write: (value) => assignPreparedMulti(target, targets, value),
    };
  }
  return { skip: false, roots: [], write: (value) => assign(target, value, frame) };
}

function* constantTargetModule(target: Extract<Target, { k: 'const' }>, frame: Frame): Gen<RClass> {
  if (!target.scope) return target.top ? rt().c.Object : frame.cref[0];
  const scope = yield* ev(target.scope, frame);
  if (!(scope instanceof RClass)) throw typeError(`${yield* inspect(scope)} is not a class/module`);
  return scope;
}

function* assignPreparedMulti(target: MultiTarget, prepared: PreparedAssignment[], value: Value): Gen<void> {
  const runtime = rt();
  const heldMark = runtime.held.length;
  const arraysMark = runtime.heldArrays.length;
  runtime.held.push(value);
  try {
    const items = yield* toAryForAssignment(value);
    runtime.heldArrays.push(items);
    const splat = target.splat;
    if (splat === undefined) {
      for (const [index, item] of prepared.entries()) if (!item.skip) yield* item.write(items[index] ?? NIL);
      return;
    }
    const after = prepared.length - splat - 1;
    for (let index = 0; index < splat; index++)
      if (!prepared[index].skip) yield* prepared[index].write(items[index] ?? NIL);
    const restEnd = Math.max(splat, items.length - after);
    if (!prepared[splat].skip && (target.items[splat].k !== 'mlhs' || target.items[splat].items.length > 0))
      yield* prepared[splat].write(arr(items.slice(splat, restEnd)));
    for (let index = 0; index < after; index++) {
      const item = prepared[splat + 1 + index];
      if (!item.skip) yield* item.write(items[restEnd + index] ?? NIL);
    }
  } finally {
    runtime.heldArrays.length = arraysMark;
    runtime.held.length = heldMark;
  }
}

// code-gauge-allow functionNcss 39 -- Assignment handles each target kind and its receiver/index evaluation order.
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
      frame.temporaries.push(recv);
      try {
        const { args } = yield* evalArgs(target.args, frame);
        yield* atCallRow(target.row, () =>
          callMethod(recv, '[]=', [...args, value], undefined, undefined, { fcall: target.recv.k === 'self' })
        );
      } finally {
        frame.temporaries.pop();
      }
      return;
    }
    case 'attr': {
      const recv = yield* ev(target.recv, frame);
      if (target.safe && recv === NIL) return;
      yield* atCallRow(target.row, () =>
        callMethod(recv, `${target.name}=`, [value], undefined, undefined, { fcall: target.recv.k === 'self' })
      );
      return;
    }
    case 'mlhs': {
      yield* destructure(target, value, frame);
    }
  }
}

export function* destructure(target: MultiTarget, value: Value, frame: Frame): Gen<void> {
  const runtime = rt();
  const heldMark = runtime.held.length;
  const arraysMark = runtime.heldArrays.length;
  runtime.held.push(value);
  try {
    const items = yield* toAryForAssignment(value);
    runtime.heldArrays.push(items);
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
  } finally {
    runtime.heldArrays.length = arraysMark;
    runtime.held.length = heldMark;
  }
}

function* toAryForAssignment(value: Value): Gen<Value[]> {
  if (value instanceof RArray) return assignmentItems(value.items);
  if (respondsTo(value, 'to_ary', true)) {
    const converted = yield* callMethod(value, 'to_ary', [], undefined, undefined, { fcall: true });
    if (converted instanceof RArray) return assignmentItems(converted.items);
    if (converted !== NIL)
      throw typeError(
        `can't convert ${realClassOf(value).name} to Array (${realClassOf(value).name}#to_ary gives ${realClassOf(converted).name})`
      );
  }
  return [value];
}

function assignmentItems(items: Value[]): Value[] {
  rt().spend(Math.ceil(items.length / 64));
  return [...items];
}

function* operatorAssign(e: Extract<Expr, { k: 'opasgn' }>, frame: Frame): Gen {
  const mark = frame.temporaries.length;
  try {
    return yield* operatorAssignInner(e, frame);
  } finally {
    frame.temporaries.length = mark;
  }
}

function* operatorAssignInner(e: Extract<Expr, { k: 'opasgn' }>, frame: Frame): Gen {
  const { target, op } = e;
  let read: () => Gen;
  let write: (value: Value) => Gen<void>;
  switch (target.k) {
    case 'index': {
      const recv = yield* ev(target.recv, frame);
      frame.temporaries.push(recv);
      const { args } = yield* evalArgs(target.args, frame);
      rootValues(frame, args);
      const fcall = target.recv.k === 'self';
      read = () => atCallRow(target.row, () => callMethod(recv, '[]', args, undefined, undefined, { fcall }));
      write = function* (value) {
        yield* atCallRow(target.row, () => callMethod(recv, '[]=', [...args, value], undefined, undefined, { fcall }));
      };
      break;
    }
    case 'attr': {
      const recv = yield* ev(target.recv, frame);
      if (target.safe && recv === NIL) return NIL;
      frame.temporaries.push(recv);
      const fcall = target.recv.k === 'self';
      read = () => atCallRow(target.row, () => callMethod(recv, target.name, [], undefined, undefined, { fcall }));
      write = function* (value) {
        yield* atCallRow(target.row, () =>
          callMethod(recv, `${target.name}=`, [value], undefined, undefined, { fcall })
        );
      };
      break;
    }
    case 'const': {
      const module = yield* constantTargetModule(target, frame);
      frame.temporaries.push(module);
      read = function* () {
        yield* [];
        try {
          return target.scope || target.top
            ? constInModule(module, target.name)
            : constLexical(frame.cref, target.name);
        } catch (error) {
          if (op === '||' && error instanceof RubyError && error.exception.cls === rt().c.NameError) return NIL;
          throw error;
        }
      };
      write = function* (value) {
        yield* [];
        constSet(module, target.name, value);
      };
      break;
    }
    case 'cvar': {
      read = function* () {
        yield* [];
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
    frame.temporaries.push(value);
    yield* write(value);
    return value;
  }
  if (op === '&&') {
    if (!truthy(current)) return current;
    const value = yield* ev(e.value, frame);
    frame.temporaries.push(value);
    yield* write(value);
    return value;
  }
  frame.temporaries.push(current);
  const operand = yield* ev(e.value, frame);
  frame.temporaries.push(operand);
  const value = yield* callMethod(current, op, [operand]);
  frame.temporaries.push(value);
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
      yield* evalRedoable(e.body, frame);
    } catch (error) {
      if (error instanceof BreakSignal && error.tag === undefined) return error.value;
      if (error instanceof NextSignal) continue;
      throw error;
    }
  }
  return NIL;
}

/** Runs a loop's or block's body, running it again from its start on `redo`. */
function* evalRedoable(body: Body, frame: Frame): Gen {
  for (;;) {
    try {
      return (yield evalBody(body, frame)) as Value;
    } catch (error) {
      if (error instanceof RedoSignal) continue;
      throw error;
    }
  }
}

/** What `defined?` says an expression is, without evaluating it except for a receiver. */
function text(value: string | undefined): Value {
  return value === undefined ? NIL : str(value);
}

function* definedText(e: Expr, frame: Frame): Gen {
  switch (e.k) {
    case 'seq': {
      return e.body.length === 1 ? yield* definedText(e.body[0].e, frame) : text('expression');
    }
    case 'lvar': {
      return text('local-variable');
    }
    case 'ivar': {
      return text(frame.self instanceof RBasic && frame.self.ivars?.has(e.name) ? 'instance-variable' : undefined);
    }
    case 'gvar': {
      return text(rt().globals.has(e.name) ? 'global-variable' : undefined);
    }
    case 'cvar': {
      const holder = frame.cref[0];
      return text(
        holder.ancestors().some((module) => module.classVariables.has(e.name)) ? 'class variable' : undefined
      );
    }
    case 'const': {
      try {
        yield* ev(e, frame);
        return text('constant');
      } catch (error) {
        if (error instanceof RubyError) return NIL;
        throw error;
      }
    }
    case 'call': {
      let recv: Value = frame.self;
      if (e.recv) {
        try {
          recv = yield* ev(e.recv, frame);
        } catch (error) {
          if (error instanceof RubyError) return NIL;
          throw error;
        }
      }
      const method = classOf(recv).findMethod(e.name);
      if (!method || (method.visibility === 'private' && !e.fcall)) return NIL;
      return text('method');
    }
    case 'yield': {
      return text(frame.home.extra.block ? 'yield' : undefined);
    }
    case 'super': {
      const method = frame.home.extra.method;
      return text(
        method && classOf(frame.home.self).findSuperMethod(method.name, method.owner, method.lookupIndex)
          ? 'super'
          : undefined
      );
    }
    case 'self': {
      return text('self');
    }
    case 'asgn':
    case 'opasgn': {
      return text('assignment');
    }
    default: {
      return text('expression');
    }
  }
}

function* evalFor(e: Extract<Expr, { k: 'for' }>, frame: Frame): Gen {
  const runtime = rt();
  const iterable = yield* ev(e.iter, frame);
  const body = function* (item: Value): Gen {
    yield* whileHeld(item, function* () {
      runtime.currentRow = e.row;
      yield* assign(e.target, item, frame);
      runtime.steps.stepBinding(e.row, e.target.k === 'mlhs' || storesAnswer(item));
    });
    try {
      yield* evalRedoable(e.body, frame);
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

/**
 * Whether a value is one learners answer in a trace: a number, a string, a symbol, or a boolean. nil counts as a
 * reference, as Java's null in a variable of a class type does.
 */
export function storesAnswer(value: Value): boolean {
  return typeof value !== 'object' || value instanceof RFloat || value instanceof RString || value instanceof RSymbol;
}

// code-gauge-allow functionCognitiveComplexity 19 -- Case evaluates optional subjects, when predicates, guards, and the else body in Ruby order.
function* evalCase(e: Extract<Expr, { k: 'case' }>, frame: Frame): Gen {
  const runtime = rt();
  const subject = e.subject ? yield* ev(e.subject, frame) : undefined;
  const mark = frame.temporaries.length;
  const arraysMark = runtime.heldArrays.length;
  if (subject !== undefined) frame.temporaries.push(subject);
  try {
    for (const when of e.whens) {
      runtime.currentRow = when.row;
      for (const condition of when.conds) {
        const candidates =
          condition.k === 'splat' ? yield* splatItems(yield* ev(condition.e, frame)) : [yield* ev(condition, frame)];
        runtime.heldArrays.push(candidates);
        for (const candidate of candidates) {
          const matched = subject === undefined ? truthy(candidate) : yield* caseEquals(candidate, subject);
          if (matched) return yield* evalBody(when.body, frame);
        }
        runtime.heldArrays.pop();
      }
    }
    return e.else ? yield* evalBody(e.else, frame) : NIL;
  } finally {
    runtime.heldArrays.length = arraysMark;
    frame.temporaries.length = mark;
  }
}

function returnTarget(frame: Frame): Frame {
  let target = frame;
  while (target.kind === 'block' && !target.extra.isLambda) target = target.extra.outer as Frame;
  if (target.kind === 'class') throw rubyError(rt().c.LocalJumpError, 'unexpected return');
  if (target.extra.finished) throw rubyError(rt().c.LocalJumpError, 'unexpected return');
  return target;
}

function* evalBegin(e: Extract<Expr, { k: 'begin' }>, frame: Frame): Gen {
  const runtime = rt();
  const mark = frame.temporaries.length;
  let pendingException: RObject | undefined;
  let fatalError: UnsupportedFeatureError | ExecutionLimitError | undefined;
  try {
    for (;;) {
      let value: Value;
      try {
        value = yield* evalBody(e.body, frame);
      } catch (error) {
        if (!(error instanceof RubyError) || e.rescues.length === 0) throw error;
        const handled = yield* rescueClause(e, error, frame);
        if (handled === RETRY) continue;
        frame.temporaries.push(handled.value);
        return handled.value;
      }
      if (e.else) value = yield* evalBody(e.else, frame);
      frame.temporaries.push(value);
      return value;
    }
  } catch (error) {
    if (error instanceof RubyError) pendingException = error.exception;
    if (
      error instanceof ReturnSignal ||
      error instanceof BreakSignal ||
      error instanceof NextSignal ||
      error instanceof ThrowSignal
    )
      frame.temporaries.push(error.value);
    if (error instanceof UnsupportedFeatureError || error instanceof ExecutionLimitError) fatalError = error;
    throw error;
  } finally {
    try {
      if (e.ensure) {
        const saved = runtime.currentRow;
        const savedException = runtime.globals.get('$!') ?? NIL;
        if (pendingException) {
          frame.handling.push(pendingException);
          runtime.globals.set('$!', pendingException);
        }
        try {
          yield* evalBody(e.ensure, frame);
        } catch (error) {
          throw fatalError ?? error;
        } finally {
          if (pendingException) {
            frame.handling.pop();
            runtime.globals.set('$!', savedException);
          }
          runtime.currentRow = saved;
        }
      }
    } finally {
      frame.temporaries.length = mark;
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
  const savedError = runtime.globals.get('$!') ?? NIL;
  runtime.globals.set('$!', exception);
  frame.handling.push(exception);
  try {
    for (const rescue of e.rescues) {
      runtime.currentRow = rescue.row;
      const matched =
        rescue.classes.length === 0
          ? truthy(yield* callMethod(runtime.c.StandardError, '===', [exception]))
          : yield* matchesRescueClass(rescue.classes, exception, frame);
      if (!matched) continue;
      try {
        if (rescue.variable) {
          yield* assign(rescue.variable, exception, frame);
          runtime.steps.stepBinding(rescue.row, false);
        }
        return { value: yield* evalBody(rescue.body, frame) };
      } catch (error_) {
        if (error_ instanceof RetrySignal) return RETRY;
        throw error_;
      }
    }
    throw error;
  } finally {
    frame.handling.pop();
    runtime.globals.set('$!', savedError);
  }
}

function* matchesRescueClass(expressions: Expr[], exception: Value, frame: Frame): Gen<boolean> {
  for (const expression of expressions) {
    const classes =
      expression.k === 'splat' ? yield* splatItems(yield* ev(expression.e, frame)) : [yield* ev(expression, frame)];
    const mark = frame.temporaries.length;
    for (const cls of classes) frame.temporaries.push(cls);
    try {
      for (const cls of classes) {
        if (!(cls instanceof RClass)) throw typeError('class or module required for rescue clause');
        if (truthy(yield* callMethod(cls, '===', [exception]))) return true;
      }
    } finally {
      frame.temporaries.length = mark;
    }
  }
  return false;
}

// Definitions ---------------------------------------------------------------------------------------------------------

// code-gauge-allow functionNcss 33 -- One case per kind of expression or Ruby rule.
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
  } else if (frame.extra.definee) {
    owner = frame.extra.definee;
    visibility = frame.defaultVisibility;
  } else if (frame.extra.definitionTarget) {
    owner = frame.extra.definitionTarget;
    visibility = frame.defaultVisibility;
  } else if (frame.home.kind === 'main') {
    owner = runtime.c.Object;
    visibility = frame.kind === 'main' ? frame.defaultVisibility : 'public';
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
  assertMutableClass(owner);
  owner.methods.set(method.name, method);
  invalidateMethodCaches();
}

export function assertMutableClass(owner: RClass): void {
  const target = owner.attached instanceof RBasic ? owner.attached : owner;
  if (target.frozen)
    throw frozenError(target, target instanceof RClass ? (target.name ?? '') : (realClassOf(target).name ?? ''));
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

// code-gauge-allow functionCognitiveComplexity 20 -- Class definition resolves its namespace, superclass, reopened class, and body frame.
function* defineClass(e: Extract<Expr, { k: 'class' }>, frame: Frame): Gen {
  const runtime = rt();
  const container = yield* moduleContainer(e, frame);
  const superclass = e.superclass ? yield* ev(e.superclass, frame) : undefined;
  if (superclass !== undefined && (!(superclass instanceof RClass) || superclass.isModule)) {
    throw typeError(`superclass must be an instance of Class (given an instance of ${realClassOf(superclass).name})`);
  }
  const existing = container.constants.get(e.name);
  if (existing === undefined && container === runtime.c.Object) checkCoreName(e.name, 'class');
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
    assertMutableClass(container);
    container.constants.set(e.name, cls);
    invalidateMethodCaches();
    yield* callHook(parent, 'inherited', [cls]);
  }
  return yield* runModuleBody(cls, e.body, frame);
}

/** Rejects defining a class or module that Ruby already has but this grader leaves out, as Ruby would reopen it. */
function checkCoreName(name: string, kind: 'class' | 'module'): void {
  const isModule = CORE_MODULES.has(name);
  if (!isModule && !CORE_CLASSES.has(name)) return;
  if (isModule !== (kind === 'module')) throw typeError(`${name} is not a ${kind}`);
  throw new UnsupportedFeatureError(UNSUPPORTED_CONSTANTS[name] ?? name);
}

function* callHook(target: RClass, name: string, args: Value[]): Gen<void> {
  const method = classOf(target).findMethod(name);
  if (method && method.body.kind === 'user') yield* invoke(method, target, args, undefined, undefined, false);
}

function* defineModule(e: Extract<Expr, { k: 'module' }>, frame: Frame): Gen {
  const runtime = rt();
  const container = yield* moduleContainer(e, frame);
  const existing = container.constants.get(e.name);
  if (existing === undefined && container === runtime.c.Object) checkCoreName(e.name, 'module');
  let module: RClass;
  if (existing !== undefined) {
    if (!(existing instanceof RClass) || !existing.isModule) throw typeError(`${e.name} is not a module`);
    module = existing;
  } else {
    module = new RClass(runtime.c.Module, e.name, undefined, true);
    module.isUserDefined = true;
    if (container !== runtime.c.Object) module.lexicalParent = container;
    assertMutableClass(container);
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
    classFrame.extra.finished = true;
    runtime.popFrame();
  }
}

// Calls ---------------------------------------------------------------------------------------------------------------

export interface CallOptions {
  /** Whether the call has no explicit receiver, which may call private methods. */
  fcall?: boolean;
  explicitSelf?: boolean;
  /** Whether the call is a bare name, which reports a missing method as a missing variable too. */
  vcall?: boolean;
  /** Whether the caller uses the result, which decides whether the method's last statement is a step. */
  used?: boolean;
}

// code-gauge-allow functionNcss 33 -- Calls retain receiver and argument roots while forwarding blocks, keywords, and break signals.
function* evalCall(e: Call, frame: Frame): Gen {
  let recv: Value;
  if (e.recv) {
    recv = yield* ev(e.recv, frame);
    if (e.safe && recv === NIL) return NIL;
  } else {
    recv = frame.self;
  }
  const mark = frame.temporaries.length;
  frame.temporaries.push(recv);
  try {
    const { args, keywords } = yield* evalArgs(e.args, frame);
    for (const arg of args) frame.temporaries.push(arg);
    if (keywords) frame.temporaries.push(keywords);
    let block: RProc | undefined;
    if (e.block) block = makeBlock(e.block, frame);
    else if (e.blockArg) block = yield* toBlock(yield* ev(e.blockArg, frame));
    const previousLiteralAtCall = block?.literalAtCall;
    if (block) block.literalAtCall = e.block !== undefined;
    const used = e.used === 1 || (e.used === 2 && frame.resultUsed);
    rt().currentRow = e.row;
    try {
      if (!e.block)
        return yield* callMethod(recv, e.name, args, keywords, block, {
          fcall: e.fcall,
          explicitSelf: e.recv?.k === 'self',
          vcall: e.vcall,
          used,
        });
      const proc = block as RProc;
      if (proc.callSiteState) proc.callSiteState.active = true;
      try {
        return yield* callMethod(recv, e.name, args, keywords, proc, {
          fcall: e.fcall,
          explicitSelf: e.recv?.k === 'self',
          vcall: e.vcall,
          used,
        });
      } catch (error) {
        if (error instanceof BreakSignal && error.tag === proc.breakTag) return error.value;
        throw error;
      } finally {
        if (proc.callSiteState) proc.callSiteState.active = false;
      }
    } finally {
      if (block) block.literalAtCall = previousLiteralAtCall;
    }
  } finally {
    frame.temporaries.length = mark;
  }
}

/** Converts the value of a `&blk` argument into the block to pass: a proc, or what `to_proc` makes of it. */
export function* toBlock(value: Value): Gen<RProc | undefined> {
  if (value === NIL) return undefined;
  if (value instanceof RProc) return value;
  if (respondsTo(value, 'to_proc', true)) {
    const converted = yield* callMethod(value, 'to_proc', [], undefined, undefined, { fcall: true });
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
    const mark = frame.temporaries.length;
    for (const arg of args) frame.temporaries.push(arg);
    try {
      const keywords = yield* evalHash(last, frame);
      return { args, keywords: keywords.map.size > 0 ? keywords : undefined };
    } finally {
      frame.temporaries.length = mark;
    }
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
  if (!method) return yield* callMethodMissing(recv, name, args, keywords, block, options);
  if (recv instanceof RClass && !recv.isModule && name === 'module_function' && method.owner === rt().c.Module)
    methodMissing(recv, name, options);
  if (method.visibility !== 'public' && !options.fcall && !options.explicitSelf) {
    if (method.visibility === 'private') {
      return yield* callMethodMissing(recv, name, args, keywords, block, options, 'private');
    }
    if (method.visibility === 'protected' && !isA(rt().frame.self, method.owner)) {
      return yield* callMethodMissing(recv, name, args, keywords, block, options, 'protected');
    }
  }
  return yield* invoke(method, recv, args, keywords, block, options.used ?? true);
}

/** Calls the program's `method_missing` for a method no class defines, or raises Ruby's error for it. */
function* callMethodMissing(
  recv: Value,
  name: string,
  args: Value[],
  keywords: RHash | undefined,
  block: RProc | undefined,
  options: CallOptions,
  visibility?: 'private' | 'protected'
): Gen {
  const handler = classOf(recv).findMethod('method_missing');
  if (handler && handler.body.kind !== 'native') {
    return yield* invoke(handler, recv, [RSymbol.of(name), ...args], keywords, block, options.used ?? true);
  }
  if (visibility)
    throw noMethodError(`${visibility} method '${name}' called for ${receiverDescription(recv)}`, recv, name);
  methodMissing(recv, name, options);
}

export function methodMissing(recv: Value, name: string, options: CallOptions): never {
  if (options.vcall) {
    throw nameError(`undefined local variable or method '${name}' for ${receiverDescription(recv)}`, recv, name);
  }
  throw noMethodError(`undefined method '${name}' for ${receiverDescription(recv)}`, recv, name);
}

/** Calls a method that lookup found. */
// code-gauge-allow functionNcss 34 -- Invocation dispatches native, accessor, and user methods with their distinct arity and root rules.
// code-gauge-allow functionCognitiveComplexity 22 -- Invocation dispatches native, accessor, and user methods with their distinct arity and root rules.
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
      const previousNumericReceiver = runtime.currentNumericReceiver;
      runtime.held.push(recv);
      for (const arg of actual) runtime.held.push(arg);
      if (block) runtime.held.push(block);
      try {
        const numericMethod =
          method.owner === runtime.c.Float || method.owner === runtime.c.Integer || method.owner === runtime.c.Numeric;
        if (numericMethod) runtime.currentNumericReceiver = recv;
        const nativeRecv = numericMethod && recv instanceof RFloat ? recv.value : recv;
        const nativeArgs = numericMethod ? actual.map((arg) => (arg instanceof RFloat ? arg.value : arg)) : actual;
        const result = body.fn(nativeRecv, nativeArgs, block, body.takesKeywords ? keywords : undefined);
        const value = isGenerator(result) ? yield* result : result;
        if (recv instanceof RFloat && Object.is(value, recv.value) && (method.name === 'to_f' || method.name === 'dup'))
          return recv;
        return typeof value === 'number' ? boxFloat(value) : value;
      } finally {
        runtime.currentNumericReceiver = previousNumericReceiver;
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
    case 'proc': {
      return yield* callProc(body.proc, args, { keywords, block, self: recv, used, method, lambdaArgs: true });
    }
    case 'undefined': {
      throw noMethodError(`undefined method '${method.name}' for ${receiverDescription(recv)}`, recv, method.name);
    }
    case 'visibility': {
      throw new Error(`Unresolved visibility marker: ${method.name}`);
    }
  }
}

// code-gauge-allow functionParameterCount 8 -- User calls need method metadata, receiver, arguments, keywords, block, call row, and result usage to build a frame.
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
  runtime.userCallVersion++;
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
    return (yield evalBody(def.body, frame)) as Value;
  } catch (error) {
    if (error instanceof ReturnSignal && error.target === frame) return error.value;
    throw hostStackOverflow(error, runtime.frames.length);
  } finally {
    frame.extra.finished = true;
    runtime.popFrame();
    runtime.currentRow = savedRow;
    if (def.isAtomic) runtime.steps.completeAtomicCall();
  }
}

/**
 * The host's stack may run out before the call depth reaches its limit, which Ruby reports as SystemStackError. The
 * error becomes one only after unwinding some calls, since building it needs stack.
 */
function hostStackOverflow(error: unknown, depth: number): unknown {
  const isOverflow =
    error === STACK_OVERFLOW || (error instanceof RangeError && error.message.startsWith('Maximum call stack'));
  if (!isOverflow) return error;
  overflowDepth ??= depth;
  if (depth > overflowDepth - 32) return STACK_OVERFLOW;
  overflowDepth = undefined;
  return rubyError(rt().c.SystemStackError, 'stack level too deep');
}

/** Stands for the host's stack overflow while the calls nearest to it unwind. */
export const STACK_OVERFLOW = { stackOverflow: true };
let overflowDepth: number | undefined;

// code-gauge-allow functionNcss 32 -- Super forwards explicit or implicit arguments and the active block to the next method owner.
function* evalSuper(e: Extract<Expr, { k: 'super' }>, frame: Frame): Gen {
  const home = frame.home;
  const method = home.extra.method;
  const procMethod = home.kind === 'block' && method?.body.kind === 'proc';
  if (!method || (home.kind !== 'method' && !procMethod)) {
    throw rubyError(rt().c.RuntimeError, 'super called outside of method');
  }
  let args: Value[];
  let keywords: RHash | undefined;
  if (e.args) {
    ({ args, keywords } = yield* evalArgs(e.args, frame));
  } else {
    if (procMethod)
      throw rubyError(
        rt().c.RuntimeError,
        'implicit argument passing of super from method defined by define_method() is not supported. Specify all arguments explicitly.'
      );
    ({ args, keywords } = yield* implicitSuperArgs(home));
  }
  const mark = frame.temporaries.length;
  rootValues(frame, args);
  if (keywords) frame.temporaries.push(keywords);
  try {
    let block: RProc | undefined = home.extra.block;
    if (e.block) block = makeBlock(e.block, frame);
    else if (e.blockArg) block = yield* toBlock(yield* ev(e.blockArg, frame));
    const superMethod = classOf(home.self).findSuperMethod(method.name, method.owner, method.lookupIndex);
    if (!superMethod) {
      throw noMethodError(
        `super: no superclass method '${method.name}' for ${receiverDescription(home.self)}`,
        home.self,
        method.name
      );
    }
    const used = e.used === 1 || (e.used === 2 && frame.resultUsed);
    rt().currentRow = e.row;
    if (!e.block) return yield* invoke(superMethod, home.self, args, keywords, block, used);
    const proc = block as RProc;
    if (proc.callSiteState) proc.callSiteState.active = true;
    try {
      return yield* invoke(superMethod, home.self, args, keywords, proc, used);
    } catch (error) {
      if (error instanceof BreakSignal && error.tag === proc.breakTag) return error.value;
      throw error;
    } finally {
      if (proc.callSiteState) proc.callSiteState.active = false;
    }
  } finally {
    frame.temporaries.length = mark;
  }
}

/** The arguments `super` without parentheses passes: the method's parameters' current values. */
// code-gauge-allow functionCognitiveComplexity 28 -- Implicit super converts current positional and keyword rests alongside declared parameters.
// code-gauge-allow functionNcss 38 -- Implicit super roots reconstructed arguments while their conversions run.
function* implicitSuperArgs(frame: Frame): Gen<{ args: Value[]; keywords: RHash | undefined }> {
  const def = frame.extra.def as MethodDef;
  const { params } = def;
  const scope = frame.scope;
  const original = frame.extra.args ?? [];
  const value = (name: ParamTarget, originalValue: Value): Value =>
    typeof name === 'string' ? scope.lookup(name, 0) : originalValue;
  const args: Value[] = params.required.map((param, index) => value(param, original[index] ?? NIL));
  rt().heldArrays.push(args);
  try {
    for (const param of params.optional) args.push(scope.lookup(param.name, 0));
    if (params.rest !== undefined) {
      const passedOptional = Math.min(
        params.optional.length,
        Math.max(0, original.length - params.required.length - params.post.length)
      );
      const anonymous = original.slice(params.required.length + passedOptional, original.length - params.post.length);
      const rest = params.rest === '' ? arr(anonymous) : scope.lookup(params.rest, 0);
      for (const item of yield* splatItems(rest)) args.push(item);
    }
    for (const [index, param] of params.post.entries())
      args.push(value(param, original[original.length - params.post.length + index] ?? NIL));
    let keywords: RHash | undefined;
    if (params.keywords.length > 0 || params.keywordRest !== undefined) {
      const keywordHash = newHash();
      keywords = keywordHash;
      rt().held.push(keywordHash);
      try {
        for (const keyword of params.keywords) {
          yield* hashSet(keywordHash, RSymbol.of(keyword.name), scope.lookup(keyword.name, 0));
        }
        if (params.keywordRest !== undefined) {
          const rest = params.keywordRest === '' ? frame.extra.keywords : scope.lookup(params.keywordRest, 0);
          if (rest !== undefined && rest !== NIL) {
            const converted = yield* superKeywordRest(rest);
            const named =
              params.keywordRest === '' ? new Set(params.keywords.map((keyword) => keyword.name)) : undefined;
            yield* whileHeld(converted, () => addSuperKeywordRest(keywordHash, converted, named));
          }
        }
        if (keywordHash.map.size === 0) keywords = undefined;
      } finally {
        rt().held.pop();
      }
    }
    return { args, keywords };
  } finally {
    rt().heldArrays.pop();
  }
}

function* superKeywordRest(value: Value): Gen<RHash> {
  if (value instanceof RHash) return value;
  if (respondsTo(value, 'to_hash', true)) {
    const converted = yield* callMethod(value, 'to_hash', [], undefined, undefined, { fcall: true });
    if (converted instanceof RHash) return converted;
    const name = realClassOf(value).name;
    throw typeError(`can't convert ${name} to Hash (${name}#to_hash gives ${realClassOf(converted).name})`);
  }
  throw implicitConversionError(value, 'Hash');
}

function* addSuperKeywordRest(target: RHash, rest: RHash, named: Set<string> | undefined): Gen<void> {
  for (const [slot, entry] of rest.map) {
    const key = entry.key;
    if (key instanceof RSymbol && named?.has(key.name)) continue;
    yield* hashSetStored(target, slot, entry);
  }
}

// Blocks --------------------------------------------------------------------------------------------------------------

declare module './objects' {
  interface RProc {
    /** Shared by block copies so `break` uses the original call's lifetime. */
    callSiteState?: { active: boolean };
    literalAtCall?: boolean;
  }
}

export function makeBlock(def: BlockDef, frame: Frame): RProc {
  const proc = new RProc(rt().c.Proc, { kind: 'block', def }, frame.self, frame as never);
  proc.breakTag = {};
  proc.callSiteState = { active: false };
  return proc;
}

export function nativeProc(
  arity: number,
  call: (args: Value[], block: RProc | undefined, used: boolean) => Value | Gen,
  lambda = false
): RProc {
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
  /** The module where `def` in the block defines methods, for `class_eval` and `instance_eval`. */
  definee?: RClass;
  /** The method a proc is the body of (`define_method`), which `super` in it continues. */
  method?: RMethod;
  /** Whether the arguments bind strictly, as a method's do, for a proc that is a method's body. */
  lambdaArgs?: boolean;
  definitionTarget?: RClass;
}

/** Calls a block or proc with arguments, binding them as a block (or a lambda) does. */
// code-gauge-allow functionNcss 36 -- Proc calls handle native and Ruby bodies, lambda arity, parameter binding, and control signals.
// code-gauge-allow functionCognitiveComplexity 30 -- Proc calls handle native and Ruby bodies, lambda arity, parameter binding, and control signals.
export function* callProc(proc: RProc, args: Value[], options: ProcCallOptions = {}): Gen {
  const runtime = rt();
  runtime.spend();
  const { body } = proc;
  if (body.kind === 'native') {
    if (body.lambda && body.arity >= 0 && args.length !== body.arity) {
      throw argumentCountError(args.length, body.arity, body.arity);
    }
    const result = body.call(args, options.block, options.used ?? true);
    const value = isGenerator(result) ? yield* result : result;
    return typeof value === 'number' ? boxFloat(value) : value;
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
      home: options.method ? undefined : outer.home,
      outer,
      proc,
      args,
      keywords: options.keywords,
      blockDef: def,
      isLambda: proc.isLambda || options.lambdaArgs,
      block: options.method ? options.block : (options.block ?? outer.home.extra.block),
      method: options.method ?? outer.home.extra.method,
      def: outer.home.extra.def,
      definee: options.definee ?? outer.extra.definee,
      definitionTarget: options.definitionTarget ?? outer.extra.definitionTarget,
    }
  );
  if (options.block) frame.extra.block = options.block;
  runtime.pushFrame(frame);
  const savedRow = runtime.currentRow;
  try {
    if (!def.params && (proc.isLambda || options.lambdaArgs) && (args.length > 0 || options.keywords)) {
      throw argumentCountError(args.length + (options.keywords ? 1 : 0), 0, 0);
    }
    if (def.params) {
      yield* bindParams(
        def.params,
        frame,
        args,
        options.keywords,
        proc.isLambda || options.lambdaArgs ? 'lambda' : 'proc'
      );
      if (hasParams(def.params)) {
        runtime.currentRow = def.row;
        runtime.steps.stepBinding(def.row, storesAnswers(def.params, frame));
      }
    }
    return yield* evalRedoable(def.body, frame);
  } catch (error) {
    if (error instanceof NextSignal) return error.value;
    if (proc.isLambda || options.lambdaArgs) {
      if (error instanceof ReturnSignal && error.target === frame) return error.value;
      if (error instanceof BreakSignal && error.tag === proc.breakTag) return error.value;
    }
    throw hostStackOverflow(error, runtime.frames.length);
  } finally {
    frame.extra.finished = true;
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
