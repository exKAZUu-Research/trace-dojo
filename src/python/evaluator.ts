// code-gauge-allow-file fileNcss 574 -- The statement evaluator keeps one method per kind of statement together.
import type { ExceptHandler, Expression, MatchCase, Pattern, Statement, Target } from './ast';
import { createClass } from './classes';
import { pyRepr } from './conversions';
import { exceptionGroupOf, splitGroup } from './exceptionGroups';
import { ExpressionEvaluator, mappingEntries, storeKey } from './expressionEvaluator';
import type { Frame } from './frame';
import { isMapping, isSequenceForMatch } from './matching';
import {
  bindValue,
  callValue,
  getAttribute,
  getAttributeOrUndefined,
  getItem,
  isTruthy,
  iterate,
  lookupSpecial,
  setAttribute,
  setItem,
} from './objects';
import { equals, inplaceOp, isSame } from './operators';
import type { Runtime } from './runtime';
import {
  baseExceptionClass,
  exceptionClassNamed,
  isInstanceOf,
  newDict,
  newException,
  newList,
  newTuple,
  None,
  pyError,
  typeError,
  typeName,
} from './types';
import { DONE, PyClass, PyError, type PyFunction, PyInstance, PyTuple, type PyValue } from './values';

type Completion = undefined | 'break' | 'continue' | { value: PyValue };
type Execution = Generator<PyValue, Completion, unknown>;
/** How a part of a try statement ended: normally with a completion, or with an exception still to raise. */
interface Outcome {
  pending?: PyError;
  completion?: Completion;
}

export class Evaluator extends ExpressionEvaluator {
  /** The exceptions being handled, innermost last, which a bare `raise` re-raises and new exceptions chain to. */
  private readonly handling: PyInstance[] = [];

  constructor(runtime: Runtime) {
    super(runtime);
  }

  runFunction(fn: PyFunction, frame: Frame): PyValue {
    const { body } = fn.def;
    if (!Array.isArray(body)) return this.evaluate(body, frame);
    const result = this.block(body, frame).next();
    if (!result.done) throw new Error('A function that is not a generator yielded');
    const completion = result.value;
    return typeof completion === 'object' ? completion.value : None;
  }

  *runGenerator(fn: PyFunction, frame: Frame): Generator<PyValue, PyValue, unknown> {
    const completion = yield* this.block(fn.def.body as Statement[], frame);
    return typeof completion === 'object' ? completion.value : None;
  }

  /** Runs the module body in its frame. */
  runModule(body: Statement[], frame: Frame): void {
    const result = this.block(body, frame).next();
    if (!result.done) throw new Error('The module yielded');
  }

  // Statements --------------------------------------------------------------------------------------------------------

  *block(statements: Statement[], frame: Frame): Execution {
    for (const statement of statements) {
      const completion = isSimple(statement)
        ? this.simpleStatement(statement, frame)
        : yield* this.compoundStatement(statement, frame);
      if (completion) return completion;
    }
    return undefined;
  }

  // code-gauge-allow functionNcss 57 -- One case per kind of simple statement.
  // code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of simple statement.
  private simpleStatement(statement: Statement, frame: Frame): Completion {
    const { runtime } = this;
    runtime.spend();
    runtime.currentRow = statement.row;
    switch (statement.kind) {
      case 'expression': {
        const { expression } = statement;
        runtime.steps.runStatement(statement.stepRow, expression.kind === 'call', () =>
          this.evaluate(expression, frame)
        );
        return undefined;
      }
      case 'assign': {
        this.assignStatement(statement, frame);
        return undefined;
      }
      case 'augmentedAssign': {
        runtime.steps.runStatement(statement.stepRow, false, () => this.augmentedAssign(statement, frame));
        return undefined;
      }
      case 'annotatedAssign': {
        this.annotatedAssign(statement, frame);
        return undefined;
      }
      case 'delete': {
        runtime.steps.runStatement(statement.stepRow, false, () => {
          for (const target of statement.targets) this.deleteTarget(target, frame);
        });
        return undefined;
      }
      case 'pass':
      case 'global':
      case 'nonlocal': {
        return undefined;
      }
      case 'break':
      case 'continue': {
        return statement.kind;
      }
      case 'return': {
        return { value: statement.value ? this.evaluate(statement.value, frame) : None };
      }
      case 'raise': {
        throw this.raise(statement, frame);
      }
      case 'functionDef': {
        const decorators = statement.fn.decorators.map((decorator) => this.evaluate(decorator, frame));
        this.storeName(statement.binding, this.createFunction(statement.fn, frame, decorators), frame);
        return undefined;
      }
      case 'classDef': {
        this.storeName(statement.binding, createClass(this, statement.cls, frame), frame);
        return undefined;
      }
      case 'import': {
        for (const { module, binding, bindsModule } of statement.names) {
          const imported = runtime.importModule(module);
          this.storeName(binding, bindsModule ? imported : runtime.importModule(module.split('.')[0]), frame);
        }
        return undefined;
      }
      case 'importFrom': {
        this.importFrom(statement, frame);
        return undefined;
      }
      case 'importStar': {
        const module = runtime.importModule(statement.module);
        for (const [name, value] of module.dict) if (!name.startsWith('_')) frame.locals.set(name, value);
        return undefined;
      }
      default: {
        throw new Error(`Not a simple statement: ${statement.kind}`);
      }
    }
  }

  private assignStatement(statement: Extract<Statement, { kind: 'assign' }>, frame: Frame): void {
    let created = false;
    this.runtime.steps.runStatement(
      statement.stepRow,
      () => created && statement.targets.every(storesReference),
      () => {
        const [value, isCreation] = this.evaluateCreation(statement.value, frame);
        created = isCreation;
        this.hold(frame, value, () => {
          for (const target of statement.targets) this.assign(target, value, frame);
        });
      }
    );
  }

  private annotatedAssign(statement: Extract<Statement, { kind: 'annotatedAssign' }>, frame: Frame): void {
    this.annotate(statement, frame);
    const valueExpression = statement.value;
    if (!valueExpression) return;
    this.runtime.steps.runStatement(statement.stepRow, false, () =>
      this.assign(statement.target, this.evaluate(valueExpression, frame), frame)
    );
  }

  private importFrom(statement: Extract<Statement, { kind: 'importFrom' }>, frame: Frame): void {
    const module = this.runtime.importModule(statement.module);
    for (const { name, binding } of statement.names) {
      const value = module.dict.get(name);
      if (value === undefined) {
        throw pyError('ImportError', `cannot import name '${name}' from '${statement.module}' (unknown location)`);
      }
      this.storeName(binding, value, frame);
    }
  }

  /** Evaluates an assignment's value, telling whether it only creates objects, whose constructors' steps show it. */
  private evaluateCreation(expression: Expression, frame: Frame): [PyValue, boolean] {
    if (expression.kind === 'call') {
      const callee = this.evaluate(expression.callee, frame);
      const value = this.hold(frame, callee, () => {
        const { args, kwargs } = this.arguments(expression.args, frame, callee);
        const outerRow = this.runtime.currentRow;
        this.runtime.currentRow = expression.row;
        try {
          return callValue(callee, args, kwargs);
        } finally {
          this.runtime.currentRow = outerRow;
        }
      });
      return [value, callee instanceof PyClass];
    }
    if (
      (expression.kind === 'list' || expression.kind === 'tuple') &&
      expression.elements.length > 0 &&
      expression.elements.every((element) => element.kind === 'call')
    ) {
      {
        const length = frame.temporaries.length;
        try {
          let created = true;
          const items: PyValue[] = [];
          for (const element of expression.elements) {
            const [item, isCreation] = this.evaluateCreation(element as Expression, frame);
            created &&= isCreation;
            items.push(item);
            frame.temporaries.push(item);
          }
          this.runtime.allocate(items.length + 1);
          return [expression.kind === 'list' ? newList(items) : newTuple(items), created];
        } finally {
          frame.temporaries.length = length;
        }
      }
    }
    return [this.evaluate(expression, frame), false];
  }

  private augmentedAssign(statement: Extract<Statement, { kind: 'augmentedAssign' }>, frame: Frame): void {
    const { target, operator } = statement;
    switch (target.kind) {
      case 'name': {
        const current = this.loadName(target, frame);
        this.storeName(target, inplaceOp(operator, current, this.evaluate(statement.value, frame)), frame);
        return;
      }
      case 'attribute': {
        const object = this.evaluate(target.object, frame);
        this.hold(frame, object, () => {
          const current = getAttribute(object, target.name);
          const result = inplaceOp(operator, current, this.evaluate(statement.value, frame));
          setAttribute(object, target.name, result);
        });
        return;
      }
      case 'subscript': {
        const object = this.evaluate(target.object, frame);
        this.hold(frame, object, () => {
          const index = this.evaluate(target.index, frame);
          const current = getItem(object, index);
          const result = this.hold(frame, index, () =>
            inplaceOp(operator, current, this.evaluate(statement.value, frame))
          );
          setItem(object, index, result);
        });
        return;
      }
      default: {
        throw new Error('Unexpected target of an augmented assignment');
      }
    }
  }

  private annotate(statement: Extract<Statement, { kind: 'annotatedAssign' }>, frame: Frame): void {
    if (frame.kind === 'function' || statement.target.kind !== 'name') return;
    const { annotation } = statement;
    frame.annotations.push([statement.target.name, () => this.evaluate(annotation, frame)]);
  }

  // code-gauge-allow functionNcss 32 -- One case per kind of compound statement.
  private *compoundStatement(statement: Statement, frame: Frame): Execution {
    const { runtime } = this;
    runtime.spend();
    runtime.currentRow = statement.row;
    switch (statement.kind) {
      case 'if': {
        if (isTruthy(this.evaluate(statement.test, frame))) return yield* this.block(statement.body, frame);
        return yield* this.block(statement.orelse, frame);
      }
      case 'while': {
        while (isTruthy(this.evaluate(statement.test, frame))) {
          runtime.spend();
          const completion = yield* this.block(statement.body, frame);
          if (completion === 'break') return undefined;
          if (completion && completion !== 'continue') return completion;
        }
        return yield* this.block(statement.orelse, frame);
      }
      case 'for': {
        return yield* this.forStatement(statement, frame);
      }
      case 'try': {
        return yield* this.tryStatement(statement, frame);
      }
      case 'with': {
        return yield* this.withStatement(statement, frame, 0);
      }
      case 'match': {
        return yield* this.matchStatement(statement, frame);
      }
      case 'yield': {
        const value = statement.value ? this.evaluate(statement.value, frame) : None;
        yield value;
        return undefined;
      }
      default: {
        throw new Error(`Not a compound statement: ${statement.kind}`);
      }
    }
  }

  private *forStatement(statement: Extract<Statement, { kind: 'for' }>, frame: Frame): Execution {
    const { runtime } = this;
    const iterable = this.evaluate(statement.iterable, frame);
    const length = frame.temporaries.length;
    frame.temporaries.push(iterable);
    try {
      const next = iterate(iterable);
      for (let item = next(); item !== DONE; item = next()) {
        runtime.spend();
        runtime.currentRow = statement.row;
        this.assign(statement.target, item, frame);
        runtime.steps.stepBinding(statement.stepRow, !storesReference(statement.target) || storesAnswer(item));
        const completion = yield* this.block(statement.body, frame);
        if (completion === 'break') return undefined;
        if (completion && completion !== 'continue') return completion;
      }
    } finally {
      frame.temporaries.length = length;
    }
    return yield* this.block(statement.orelse, frame);
  }

  // Exceptions --------------------------------------------------------------------------------------------------------

  private raise(statement: Extract<Statement, { kind: 'raise' }>, frame: Frame): PyError {
    if (!statement.exception) {
      const active = this.handling.at(-1);
      if (!active) return pyError('RuntimeError', 'No active exception to reraise');
      return new PyError(active);
    }
    const exception = toException(
      this.evaluate(statement.exception, frame),
      'exceptions must derive from BaseException'
    );
    const state = exception.exception;
    if (state && statement.cause) {
      const cause = this.evaluate(statement.cause, frame);
      state.cause = cause === None ? None : toException(cause, 'exception causes must derive from BaseException');
      state.suppressContext = true;
    }
    this.chain(exception);
    return new PyError(exception);
  }

  /** Sets the context of a new exception to the exception being handled, as Python chains them implicitly. */
  private chain(exception: PyInstance): void {
    const active = this.handling.at(-1);
    const state = exception.exception;
    if (!active || !state || active === exception || state.context !== undefined) return;
    state.context = active;
  }

  /** Runs try, except, else, and finally in the order Python does. */
  private *tryStatement(statement: Extract<Statement, { kind: 'try' }>, frame: Frame): Execution {
    let { completion, pending } = yield* this.guarded(statement.body, frame);
    if (pending) {
      ({ completion, pending } = yield* this.handleException(statement, pending, frame));
    } else if (!completion && statement.orelse.length > 0) {
      ({ completion, pending } = yield* this.guarded(statement.orelse, frame));
    }
    if (statement.finalbody.length > 0) {
      const finalCompletion = yield* this.finallyBlock(statement.finalbody, pending, frame);
      if (finalCompletion) return finalCompletion;
    }
    if (pending) throw pending;
    return completion;
  }

  /** Runs a block, catching the Python exception it raises as the pending one. */
  private *guarded(statements: Statement[], frame: Frame): Generator<PyValue, Outcome, unknown> {
    try {
      return { completion: yield* this.block(statements, frame) };
    } catch (error) {
      if (!(error instanceof PyError)) throw error;
      return { pending: error };
    }
  }

  private *handleException(
    statement: Extract<Statement, { kind: 'try' }>,
    caught: PyError,
    frame: Frame
  ): Generator<PyValue, Outcome, unknown> {
    if (statement.isGroup) return yield* this.exceptStar(statement, caught, frame);
    const handler = this.findHandler(statement.handlers, caught.exception, frame);
    if (!handler) return { pending: caught };
    try {
      return { completion: yield* this.runHandler(handler, caught.exception, frame) };
    } catch (error) {
      if (!(error instanceof PyError)) throw error;
      return { pending: error };
    }
  }

  private *finallyBlock(finalbody: Statement[], pending: PyError | undefined, frame: Frame): Execution {
    const length = frame.temporaries.length;
    if (pending) {
      frame.temporaries.push(pending.exception);
      this.handling.push(pending.exception);
    }
    try {
      return yield* this.block(finalbody, frame);
    } catch (error) {
      if (error instanceof PyError && pending) this.chainTo(error.exception, pending.exception);
      throw error;
    } finally {
      if (pending) this.handling.pop();
      frame.temporaries.length = length;
    }
  }

  private chainTo(exception: PyInstance, context: PyInstance): void {
    const state = exception.exception;
    if (state && exception !== context && state.context === undefined) state.context = context;
  }

  private findHandler(handlers: ExceptHandler[], exception: PyInstance, frame: Frame): ExceptHandler | undefined {
    for (const handler of handlers) {
      if (!handler.types) return handler;
      const types = this.evaluate(handler.types, frame);
      if (matchesExceptionTypes(exception, types)) return handler;
    }
    return undefined;
  }

  private *runHandler(handler: ExceptHandler, exception: PyInstance, frame: Frame): Execution {
    if (handler.name) this.storeName(handler.name, exception, frame);
    this.handling.push(exception);
    try {
      return yield* this.block(handler.body, frame);
    } catch (error) {
      if (error instanceof PyError) this.chainTo(error.exception, exception);
      throw error;
    } finally {
      this.handling.pop();
      // Python deletes the name after the handler, so that the exception does not stay reachable.
      if (handler.name) {
        try {
          this.deleteName(handler.name, frame);
        } catch {
          // The handler may have deleted the name itself.
        }
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Splits an exception group among except* clauses as Python does.
  private *exceptStar(
    statement: Extract<Statement, { kind: 'try' }>,
    caught: PyError,
    frame: Frame
  ): Generator<PyValue, Outcome, unknown> {
    const original = caught.exception;
    let remaining: PyInstance | undefined = exceptionGroupOf(original);
    const raised: PyInstance[] = [];
    let completion: Completion;
    for (const handler of statement.handlers) {
      if (!remaining) break;
      const types = this.evaluate(handler.types as Expression, frame);
      checkExceptStarTypes(types);
      const [match, rest] = splitGroup(remaining, (exception) => matchesExceptionTypes(exception, types));
      remaining = rest;
      if (!match) continue;
      try {
        completion = yield* this.runHandler(handler, match, frame);
      } catch (error) {
        if (!(error instanceof PyError)) throw error;
        raised.push(error.exception);
      }
    }
    if (raised.length === 0) {
      if (!remaining) return { completion };
      return {
        pending: new PyError(
          remaining === exceptionGroupOf(original) && original.exception?.exceptions === undefined
            ? original
            : remaining
        ),
      };
    }
    const all = remaining ? [...raised, remaining] : raised;
    if (all.length === 1 && remaining === undefined && raised[0] !== original)
      return { pending: new PyError(raised[0]) };
    const group = newException(exceptionClassNamed('ExceptionGroup'), ['', all as never]);
    return { pending: new PyError(exceptionGroupOf(group, all)) };
  }

  // With ----------------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 34 -- Follows the protocol of the with statement.
  private *withStatement(statement: Extract<Statement, { kind: 'with' }>, frame: Frame, index: number): Execution {
    if (index >= statement.items.length) return yield* this.block(statement.body, frame);
    const { runtime } = this;
    const item = statement.items[index];
    const manager = this.evaluate(item.context, frame);
    const enter = lookupSpecial(manager, '__enter__');
    const exit = lookupSpecial(manager, '__exit__');
    if (enter === undefined || exit === undefined) {
      throw typeError(`'${typeName(manager)}' object does not support the context manager protocol`);
    }
    const length = frame.temporaries.length;
    frame.temporaries.push(manager);
    try {
      runtime.steps.runStatement(
        index === 0 ? statement.stepRow : undefined,
        () => !statement.items.some((each) => each.target),
        () => {
          const value = callValue(bindValue(enter, manager), []);
          if (item.target) this.assign(item.target, value, frame);
        }
      );
      let completion: Completion;
      try {
        completion = yield* this.withStatement(statement, frame, index + 1);
      } catch (error) {
        if (!(error instanceof PyError)) throw error;
        const exception = error.exception;
        this.handling.push(exception);
        let suppress: boolean;
        try {
          suppress = isTruthy(callValue(bindValue(exit, manager), [exception.cls, exception, None]));
        } finally {
          this.handling.pop();
        }
        if (!suppress) throw error;
        return undefined;
      }
      callValue(bindValue(exit, manager), [None, None, None]);
      return completion;
    } finally {
      frame.temporaries.length = length;
    }
  }

  // Match ---------------------------------------------------------------------------------------------------------------

  private *matchStatement(statement: Extract<Statement, { kind: 'match' }>, frame: Frame): Execution {
    const subject = this.evaluate(statement.subject, frame);
    const length = frame.temporaries.length;
    frame.temporaries.push(subject);
    try {
      for (const matchCase of statement.cases) {
        if (!this.matchCase(matchCase, subject, frame)) continue;
        return yield* this.block(matchCase.body, frame);
      }
      return undefined;
    } finally {
      frame.temporaries.length = length;
    }
  }

  private matchCase(matchCase: MatchCase, subject: PyValue, frame: Frame): boolean {
    const bindings = new Map<Target, PyValue>();
    if (!this.matchPattern(matchCase.pattern, subject, bindings, frame)) return false;
    for (const [target, value] of bindings) this.assign(target, value, frame);
    return !matchCase.guard || isTruthy(this.evaluate(matchCase.guard, frame));
  }

  private matchPattern(pattern: Pattern, subject: PyValue, bindings: Map<Target, PyValue>, frame: Frame): boolean {
    this.runtime.spend();
    switch (pattern.kind) {
      case 'value': {
        return equals(subject, this.evaluate(pattern.value, frame));
      }
      case 'singleton': {
        return isSame(subject, pattern.value ?? None);
      }
      case 'capture': {
        if (pattern.name) bindings.set(pattern.name, subject);
        return true;
      }
      case 'star': {
        return true;
      }
      case 'as': {
        if (!this.matchPattern(pattern.pattern, subject, bindings, frame)) return false;
        bindings.set(pattern.name, subject);
        return true;
      }
      case 'or': {
        return this.matchOr(pattern, subject, bindings, frame);
      }
      case 'sequence': {
        return this.matchSequence(pattern, subject, bindings, frame);
      }
      case 'mapping': {
        return this.matchMapping(pattern, subject, bindings, frame);
      }
      case 'class': {
        return this.matchClass(pattern, subject, bindings, frame);
      }
    }
  }

  private matchOr(
    pattern: Extract<Pattern, { kind: 'or' }>,
    subject: PyValue,
    bindings: Map<Target, PyValue>,
    frame: Frame
  ): boolean {
    for (const alternative of pattern.patterns) {
      const own = new Map<Target, PyValue>();
      if (this.matchPattern(alternative, subject, own, frame)) {
        for (const [target, value] of own) bindings.set(target, value);
        return true;
      }
    }
    return false;
  }

  private matchSequence(
    pattern: Extract<Pattern, { kind: 'sequence' }>,
    subject: PyValue,
    bindings: Map<Target, PyValue>,
    frame: Frame
  ): boolean {
    if (!isSequenceForMatch(subject)) return false;
    const items = toItems(subject);
    const { patterns, starIndex } = pattern;
    if (starIndex === undefined) {
      if (items.length !== patterns.length) return false;
      return patterns.every((each, index) => this.matchPattern(each, items[index], bindings, frame));
    }
    const after = patterns.length - starIndex - 1;
    if (items.length < patterns.length - 1) return false;
    for (let index = 0; index < starIndex; index++) {
      if (!this.matchPattern(patterns[index], items[index], bindings, frame)) return false;
    }
    for (let index = 0; index < after; index++) {
      const item = items[items.length - after + index];
      if (!this.matchPattern(patterns[starIndex + 1 + index], item, bindings, frame)) return false;
    }
    const star = patterns[starIndex];
    if (star.kind === 'star' && star.name) {
      bindings.set(star.name, this.listOf(items.slice(starIndex, items.length - after)));
    }
    return true;
  }

  private matchMapping(
    pattern: Extract<Pattern, { kind: 'mapping' }>,
    subject: PyValue,
    bindings: Map<Target, PyValue>,
    frame: Frame
  ): boolean {
    if (!isMapping(subject)) return false;
    const seen: PyValue[] = [];
    for (const [index, keyExpression] of pattern.keys.entries()) {
      const key = this.evaluate(keyExpression, frame);
      if (seen.some((other) => equals(other, key)))
        throw pyError('ValueError', `mapping pattern checks duplicate key (${this.reprOf(key)})`);
      seen.push(key);
      const value = mappingGet(subject, key);
      if (value === undefined) return false;
      if (!this.matchPattern(pattern.patterns[index], value, bindings, frame)) return false;
    }
    if (pattern.rest) {
      const rest = newDict();
      for (const [key, value] of mappingEntries(subject)) {
        if (!seen.some((other) => equals(other, key))) storeKey(rest, key, value);
      }
      bindings.set(pattern.rest, rest);
    }
    return true;
  }

  private matchClass(
    pattern: Extract<Pattern, { kind: 'class' }>,
    subject: PyValue,
    bindings: Map<Target, PyValue>,
    frame: Frame
  ): boolean {
    const cls = this.evaluate(pattern.cls, frame);
    if (!(cls instanceof PyClass)) throw typeError('called match pattern must be a class');
    if (!isInstanceOf(subject, cls)) return false;
    const names = this.matchClassPositional(pattern, cls, subject, bindings, frame);
    if (!names) return false;
    for (const [index, keyword] of pattern.keywords.entries()) {
      if (names.includes(keyword))
        throw typeError(`${cls.name}() got multiple sub-patterns for attribute '${keyword}'`);
      const value = getAttributeOrUndefined(subject, keyword);
      if (value === undefined || !this.matchPattern(pattern.keywordPatterns[index], value, bindings, frame))
        return false;
    }
    return true;
  }

  /** Matches a class pattern's positional sub-patterns, returning the attribute names they matched or `undefined` on a mismatch. */
  private matchClassPositional(
    pattern: Extract<Pattern, { kind: 'class' }>,
    cls: PyClass,
    subject: PyValue,
    bindings: Map<Target, PyValue>,
    frame: Frame
  ): string[] | undefined {
    const { patterns } = pattern;
    if (patterns.length === 0) return [];
    if (SELF_MATCHING.has(cls.name) && cls.isBuiltin) {
      if (patterns.length > 1)
        throw typeError(`${cls.name}() accepts 1 positional sub-pattern (${patterns.length} given)`);
      return this.matchPattern(patterns[0], subject, bindings, frame) ? [] : undefined;
    }
    const allowed = matchArgsOf(cls, patterns.length);
    const names: string[] = [];
    for (const [index, sub] of patterns.entries()) {
      const name = allowed[index];
      if (typeof name !== 'string') throw typeError(`__match_args__ elements must be strings (got ${typeName(name)})`);
      names.push(name);
      const value = getAttributeOrUndefined(subject, name);
      if (value === undefined || !this.matchPattern(sub, value, bindings, frame)) return undefined;
    }
    return names;
  }

  private listOf(items: PyValue[]): PyValue {
    this.runtime.allocate(items.length + 1);
    return newList(items);
  }

  private reprOf(value: PyValue): string {
    return pyRepr(value);
  }
}

// Helpers ---------------------------------------------------------------------------------------------------------------

const SELF_MATCHING = new Set([
  'bool',
  'bytearray',
  'bytes',
  'dict',
  'float',
  'frozenset',
  'int',
  'list',
  'set',
  'str',
  'tuple',
]);

/** Statements that never suspend a generator, which run without the cost of a generator of their own. */
function isSimple(statement: Statement): boolean {
  switch (statement.kind) {
    case 'if':
    case 'while':
    case 'for':
    case 'try':
    case 'with':
    case 'match':
    case 'yield': {
      return false;
    }
    default: {
      return true;
    }
  }
}

/** Whether a target stores the value itself, unlike unpacking, which stores values read out of it. */
function storesReference(target: Target): boolean {
  return target.kind !== 'unpack';
}

/** Whether a value is one learners answer in a trace: a number, a string, or a boolean. */
function storesAnswer(value: PyValue): boolean {
  return typeof value !== 'object';
}

function toException(value: PyValue, message: string): PyInstance {
  if (value instanceof PyClass && value.isSubclassOf(baseExceptionClass)) {
    const instance = callValue(value, []);
    if (!(instance instanceof PyInstance) || !instance.exception) {
      throw typeError(
        `calling ${value.name} should have returned an instance of BaseException, not ${typeName(instance)}`
      );
    }
    return instance;
  }
  if (value instanceof PyInstance && value.exception) return value;
  throw typeError(message);
}

function matchesExceptionTypes(exception: PyInstance, types: PyValue): boolean {
  if (types instanceof PyTuple) return types.items.some((type) => matchesExceptionTypes(exception, type));
  if (!(types instanceof PyClass) || !types.isSubclassOf(baseExceptionClass)) {
    throw typeError('catching classes that do not inherit from BaseException is not allowed');
  }
  return exception.cls.isSubclassOf(types);
}

function checkExceptStarTypes(types: PyValue): void {
  const list = types instanceof PyTuple ? types.items : [types];
  for (const type of list) {
    if (type instanceof PyClass && type.isSubclassOf(exceptionClassNamed('BaseExceptionGroup'))) {
      throw typeError('catching ExceptionGroup with except* is not allowed. Use except instead.');
    }
  }
}

function toItems(subject: PyValue): PyValue[] {
  const next = iterate(subject);
  const items: PyValue[] = [];
  for (let item = next(); item !== DONE; item = next()) items.push(item);
  return items;
}

function mappingGet(mapping: PyValue, key: PyValue): PyValue | undefined {
  const get = lookupSpecial(mapping, 'get');
  if (get === undefined) return undefined;
  const sentinel = newDict();
  const value = callValue(bindValue(get, mapping), [key, sentinel]);
  return value === sentinel ? undefined : value;
}

/** Returns a class's `__match_args__`, checking it allows `count` positional sub-patterns. */
function matchArgsOf(cls: PyClass, count: number): readonly PyValue[] {
  const matchArgs = cls.lookup('__match_args__');
  const allowed = matchArgs instanceof PyTuple ? matchArgs.items : [];
  if (matchArgs !== undefined && !(matchArgs instanceof PyTuple))
    throw typeError(`${cls.name}.__match_args__ must be a tuple (got ${typeName(matchArgs)})`);
  if (count > allowed.length) {
    throw typeError(
      `${cls.name}() accepts ${allowed.length} positional sub-pattern${allowed.length === 1 ? '' : 's'} (${count} given)`
    );
  }
  return allowed;
}

export type { Completion };
