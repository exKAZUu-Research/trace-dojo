// code-gauge-allow-file fileNcss 822 -- The statement evaluator keeps one method per kind of statement together, with the suspending variants of the simple ones.
import type {
  ClassDef,
  ExceptHandler,
  Expression,
  FunctionDef,
  MatchCase,
  Pattern,
  ScopeInfo,
  Statement,
  Target,
  TypeParam,
} from './ast';
import { AsyncEvaluator } from './asyncEvaluator';
import { createClass } from './classes';
import { pyRepr } from './conversions';
import { asyncYield } from './coroutines';
import { exceptionGroupOf, splitGroup } from './exceptionGroups';
import { mappingEntries, storeKey } from './expressionEvaluator';
import type { Frame } from './frame';
import { isMapping, isSequenceForMatch } from './matching';
import {
  bindValue,
  callValue,
  deleteAttribute,
  deleteItem,
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
import { targetSuspends } from './suspension';
import { isWaitRequest, schedulerOf, suspendingCall } from './threads';
import { genericBaseOf, newTypeParam, PyTypeAlias } from './typeParams';
import {
  baseExceptionClass,
  classOf,
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
import { UnsupportedFeatureError } from './unsupported';
import { DONE, PyClass, PyError, type PyFunction, PyInstance, PyTuple, type PyValue } from './values';

const NO_EXCEPTIONS: PyInstance[] = [];

type Completion = undefined | 'break' | 'continue' | { value: PyValue };
type Execution = Generator<PyValue, Completion, PyValue>;
/** How a part of a try statement ended: normally with a completion, or with an exception still to raise. */
interface Outcome {
  pending?: PyError;
  completion?: Completion;
}

export class Evaluator extends AsyncEvaluator {
  /** The exceptions being handled, innermost last, which a bare `raise` re-raises and new exceptions chain to. */
  private readonly handling: PyInstance[] = [];

  constructor(runtime: Runtime) {
    super(runtime);
  }

  /** The exception being handled innermost, as `sys.exception()` returns it, or undefined outside handlers. */
  get handledException(): PyInstance | undefined {
    return this.handling.at(-1);
  }

  runFunction(fn: PyFunction, frame: Frame): PyValue {
    const { body } = fn.def;
    if (!Array.isArray(body)) return this.evaluate(body, frame);
    const completion = runToEnd(this.block(body, frame));
    return typeof completion === 'object' ? completion.value : None;
  }

  *runGenerator(fn: PyFunction, frame: Frame): Generator<PyValue, PyValue, PyValue> {
    const { body } = fn.def;
    if (!Array.isArray(body)) return yield* this.evaluateSuspending(body, frame);
    const completion = yield* this.block(body, frame);
    return typeof completion === 'object' ? completion.value : None;
  }

  /** Puts back the exceptions a generator was handling when it suspended, returning the depth to take them off at. */
  attachHandling(exceptions: PyInstance[]): number {
    const depth = this.handling.length;
    if (exceptions.length > 0) this.handling.push(...exceptions);
    return depth;
  }

  get handledExceptions(): readonly PyInstance[] {
    return this.handling;
  }

  /** Takes off the exceptions a suspending generator is handling, which its caller does not handle. */
  detachHandling(depth: number): PyInstance[] {
    return this.handling.length === depth ? NO_EXCEPTIONS : this.handling.splice(depth);
  }

  /** Runs the module body in its frame. */
  runModule(body: Statement[], frame: Frame): void {
    runToEnd(this.block(body, frame));
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

  // code-gauge-allow functionNcss 60 -- One case per kind of simple statement.
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
      case 'setupAnnotations': {
        if (!frame.locals.has('__annotations__')) frame.locals.set('__annotations__', newDict());
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
        const exception = statement.exception ? this.evaluate(statement.exception, frame) : undefined;
        throw this.raise(exception, statement.cause ? this.evaluate(statement.cause, frame) : undefined);
      }
      case 'assert': {
        if (isTruthy(this.evaluate(statement.test, frame))) return undefined;
        throw assertionError(statement.message ? [this.evaluate(statement.message, frame)] : []);
      }
      case 'functionDef': {
        const decorators = statement.fn.decorators.map((decorator) => this.evaluate(decorator, frame));
        this.storeName(statement.binding, this.defineFunction(statement.fn, frame, decorators), frame);
        return undefined;
      }
      case 'classDef': {
        this.storeName(statement.binding, this.defineClass(statement.cls, frame), frame);
        return undefined;
      }
      case 'typeAlias': {
        this.defineTypeAlias(statement, frame);
        return undefined;
      }
      case 'import':
      case 'importFrom':
      case 'importStar': {
        this.importStatement(statement, frame);
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
        const { targets } = statement;
        // Garbage collection only looks for objects among the values held.
        if (typeof value !== 'object') {
          for (const target of targets) this.assign(target, value, frame);
          return;
        }
        this.hold(frame, value, () => {
          for (const target of targets) this.assign(target, value, frame);
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

  private importStatement(
    statement: Extract<Statement, { kind: 'import' | 'importFrom' | 'importStar' }>,
    frame: Frame
  ): void {
    const { runtime } = this;
    if (statement.kind === 'importFrom') {
      this.importFrom(statement, frame);
    } else if (statement.kind === 'importStar') {
      const module = runtime.importModule(statement.module);
      for (const [name, value] of module.dict) if (!name.startsWith('_')) frame.locals.set(name, value);
    } else {
      for (const { module, binding, bindsModule } of statement.names) {
        const imported = runtime.importModule(module);
        this.storeName(binding, bindsModule ? imported : runtime.importModule(module.split('.')[0]), frame);
      }
    }
  }

  private importFrom(statement: Extract<Statement, { kind: 'importFrom' }>, frame: Frame): void {
    const module = this.runtime.importModule(statement.module);
    for (const { name, binding } of statement.names) {
      const feature = module.unsupported.get(name);
      if (feature !== undefined) throw new UnsupportedFeatureError(feature);
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
      const { temporaries } = frame;
      const length = temporaries.length;
      temporaries.push(callee);
      try {
        const { args, kwargs } = this.arguments(expression.args, frame, callee);
        return [this.invoke(callee, args, kwargs, expression.row), callee instanceof PyClass];
      } finally {
        temporaries.length = length;
      }
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
    if (statement.storesAnnotation) {
      const annotations = this.loadName(
        { kind: 'name', name: '__annotations__', access: 'name', row: statement.row },
        frame
      );
      setItem(annotations, statement.target.name, this.evaluate(annotation, frame));
    }
    frame.annotations.push([statement.target.name, () => this.evaluate(annotation, frame)]);
  }

  // code-gauge-allow functionCognitiveComplexity 29 -- One case per kind of compound statement, each taking the path that can suspend when it must.
  // code-gauge-allow functionNcss 39 -- One case per kind of compound statement.
  private *compoundStatement(statement: Statement, frame: Frame): Execution {
    const { runtime } = this;
    runtime.spend();
    runtime.currentRow = statement.row;
    switch (statement.kind) {
      case 'if': {
        const { test } = statement;
        const value = test.suspends ? yield* this.evaluateSuspending(test, frame) : this.evaluate(test, frame);
        return yield* this.block(isTruthy(value) ? statement.body : statement.orelse, frame);
      }
      case 'while': {
        const { test } = statement;
        while (isTruthy(test.suspends ? yield* this.evaluateSuspending(test, frame) : this.evaluate(test, frame))) {
          runtime.spend();
          const completion = yield* this.block(statement.body, frame);
          if (completion === 'break') return undefined;
          if (completion && completion !== 'continue') return completion;
        }
        return yield* this.block(statement.orelse, frame);
      }
      case 'for': {
        return yield* statement.isAsync
          ? this.asyncForStatement(statement, frame)
          : this.forStatement(statement, frame);
      }
      case 'try':
      case 'with': {
        return yield* this.regionStatement(statement, frame);
      }
      case 'match': {
        return yield* this.matchStatement(statement, frame);
      }
      case 'expression': {
        return yield* this.suspendingExpressionStatement(statement, frame);
      }
      default: {
        if (statement.suspends) return yield* this.suspendingStatement(statement, frame);
        throw new Error(`Not a compound statement: ${statement.kind}`);
      }
    }
  }

  /** Runs a `try` or `with` statement, which closing a generator suspended in it runs code of. */
  private *regionStatement(statement: Extract<Statement, { kind: 'try' | 'with' }>, frame: Frame): Execution {
    let run: Execution;
    if (statement.kind === 'try') run = this.tryStatement(statement, frame);
    else
      run = statement.isAsync ? this.asyncWithStatement(statement, frame, 0) : this.withStatement(statement, frame, 0);
    return yield* isSuspendable(frame) ? this.protectedRegion(run, frame) : run;
  }

  private *suspendingExpressionStatement(
    statement: Extract<Statement, { kind: 'expression' }>,
    frame: Frame
  ): Execution {
    const { expression } = statement;
    // A `yield` statement, the most common one that suspends, needs no generator of its own.
    if (expression.kind === 'yield' && !expression.value?.suspends) {
      const value = expression.value ? this.evaluate(expression.value, frame) : None;
      yield frame.scope.isAsync ? asyncYield(value) : value;
      return undefined;
    }
    return yield* this.suspendingStatement(statement, frame);
  }

  /** Runs a `try` or `with` statement of a generator, where closing the suspended generator runs code. */
  private *protectedRegion(run: Execution, frame: Frame): Execution {
    frame.protectedDepth++;
    try {
      return yield* run;
    } finally {
      frame.protectedDepth--;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Follows the protocol of the for loop, closing a generator it leaves.
  // code-gauge-allow functionNcss 31 -- Follows the protocol of the for loop, closing a generator it leaves.
  // code-gauge-allow duplicateLines 29 -- Mirrors the async for loop, whose items come from an awaited `__anext__`.
  private *forStatement(statement: Extract<Statement, { kind: 'for' }>, frame: Frame): Execution {
    const { runtime } = this;
    const { target } = statement;
    const iterable = statement.iterable.suspends
      ? yield* this.evaluateSuspending(statement.iterable, frame)
      : this.evaluate(statement.iterable, frame);
    const suspendingTarget = targetSuspends(target);
    const length = frame.temporaries.length;
    frame.temporaries.push(iterable);
    // What leaves the loop along with control, which stays alive when the loop's generator closes.
    let leaving: unknown;
    try {
      const next = iterate(iterable);
      for (let item = next(); item !== DONE; item = next()) {
        runtime.spend();
        runtime.currentRow = statement.row;
        if (suspendingTarget) yield* this.assignSuspending(target, item, frame);
        else this.assign(target, item, frame);
        runtime.steps.stepBinding(statement.stepRow, !storesReference(target) || storesAnswer(item));
        const completion = yield* this.block(statement.body, frame);
        if (completion === 'break') return undefined;
        if (completion && completion !== 'continue') {
          leaving = typeof completion === 'object' ? completion.value : undefined;
          return completion;
        }
      }
    } catch (error) {
      leaving = error instanceof PyError ? error.exception : undefined;
      throw error;
    } finally {
      frame.temporaries.length = length;
      if (runtime.finalizer.mayRelease(iterable)) runtime.finalizer.closeUnreachable([leaving]);
    }
    return yield* this.block(statement.orelse, frame);
  }

  // Definitions ---------------------------------------------------------------------------------------------------------

  /** Creates a function, inside the scope of its type parameters when it has them. */
  private defineFunction(fn: FunctionDef, frame: Frame, decorators: PyValue[], defaults?: PyValue[]): PyValue {
    if (!fn.typeParams) return this.createFunction(fn, frame, decorators, defaults);
    const defaultValues =
      defaults ?? fn.params.flatMap((param) => (param.default ? [this.evaluate(param.default, frame)] : []));
    const scopeFrame = this.typeParamFrame(fn.typeParams.scope, frame);
    const params = this.createTypeParams(fn.typeParams.params, scopeFrame);
    return this.createFunction(fn, scopeFrame, decorators, defaultValues, params);
  }

  /** Creates a class, inside the scope of its type parameters when it has them, which adds `Generic[...]` to its bases. */
  private defineClass(cls: ClassDef, frame: Frame): PyValue {
    const { typeParams } = cls;
    if (!typeParams) return createClass(this, cls, frame);
    const decorators = cls.decorators.map((decorator) => this.evaluate(decorator, frame));
    const scopeFrame = this.typeParamFrame(typeParams.scope, frame);
    const params = this.createTypeParams(typeParams.params, scopeFrame);
    this.storeName(typeParams.tuple, newTuple(params), scopeFrame);
    this.storeName(typeParams.genericBase, genericBaseOf(params), scopeFrame);
    return createClass(this, cls, scopeFrame, decorators);
  }

  /** Creates a `type` statement's alias, whose value the scope of its type parameters evaluates when first read. */
  private defineTypeAlias(statement: Extract<Statement, { kind: 'typeAlias' }>, frame: Frame): void {
    const scopeFrame = this.typeParamFrame(statement.typeParams.scope, frame);
    const params = this.createTypeParams(statement.typeParams.params, scopeFrame);
    const { value } = statement;
    const alias = new PyTypeAlias(statement.name, params, () => this.evaluate(value, scopeFrame), '__main__');
    this.storeName(statement.binding, alias, frame);
  }

  /** The frame of a scope of type parameters, which captures the variables of `frame` it reads. */
  private typeParamFrame(scope: ScopeInfo, frame: Frame): Frame {
    return this.nestedFrame('function', scope, frame);
  }

  /** Creates the objects that type parameters stand for, binding them in their scope's frame. */
  private createTypeParams(params: TypeParam[], frame: Frame): PyValue[] {
    return params.map((param) => {
      const { bound, constraints, default: defaultValue } = param;
      const value = newTypeParam(param.kind, param.name, {
        bound: bound && (() => this.evaluate(bound, frame)),
        constraints: constraints && (() => newTuple(constraints.map((each) => this.evaluate(each, frame)))),
        default: defaultValue && (() => this.evaluate(defaultValue, frame)),
      });
      this.storeName(param.binding, value, frame);
      return value;
    });
  }

  // Suspending statements ----------------------------------------------------------------------------------------------

  /**
   * Runs a simple statement that may suspend the generator in the middle of an expression. When it ends, it records its
   * step whatever it called, since the code that resumed the generator ran in between.
   */
  private *suspendingStatement(statement: Statement, frame: Frame): Execution {
    if (!isSuspendable(frame) && 'stepRow' in statement) return yield* this.blockingStatement(statement, frame);
    const completion = yield* this.suspendingStatementBody(statement, frame);
    if ('stepRow' in statement) this.runtime.steps.step(statement.stepRow);
    return completion;
  }

  /**
   * Runs a simple statement of a program that may run threads, where any call may suspend the running thread. It
   * records its step as the synchronous path does, unless another thread ran in the middle of it.
   */
  private *blockingStatement(statement: Statement & { stepRow?: number }, frame: Frame): Execution {
    const { runtime } = this;
    const begun = runtime.steps.stepCount;
    const switches = runtime.threads?.switches;
    let onlyCalls = statement.kind === 'expression' && statement.expression.kind === 'call';
    let completion: Completion;
    if (statement.kind === 'assign' && statement.value.kind === 'call') {
      const { value } = statement;
      const callee = yield* this.evaluateSuspending(value.callee, frame);
      const result = yield* this.holding(frame, callee, this.callValueSuspending(callee, value.args, value.row, frame));
      for (const target of statement.targets)
        yield* this.holding(frame, result, this.assignSuspending(target, result, frame));
      onlyCalls = callee instanceof PyClass && statement.targets.every(storesReference);
    } else {
      completion = yield* this.suspendingStatementBody(statement, frame);
    }
    if (runtime.threads?.switches === switches) runtime.steps.finishStatement(statement.stepRow, onlyCalls, begun);
    else runtime.steps.step(statement.stepRow);
    return completion;
  }

  // code-gauge-allow functionNcss 45 -- One case per kind of simple statement that evaluates expressions.
  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of simple statement that evaluates expressions.
  private *suspendingStatementBody(statement: Statement, frame: Frame): Execution {
    switch (statement.kind) {
      case 'expression': {
        yield* this.evaluateSuspending(statement.expression, frame);
        return undefined;
      }
      case 'assign': {
        const value = yield* this.evaluateSuspending(statement.value, frame);
        for (const target of statement.targets) yield* this.assignSuspending(target, value, frame);
        return undefined;
      }
      case 'augmentedAssign': {
        yield* this.augmentedAssignSuspending(statement, frame);
        return undefined;
      }
      case 'annotatedAssign': {
        this.annotate(statement, frame);
        const { value } = statement;
        if (value) yield* this.assignSuspending(statement.target, yield* this.evaluateSuspending(value, frame), frame);
        return undefined;
      }
      case 'delete': {
        for (const target of statement.targets) yield* this.deleteSuspending(target, frame);
        return undefined;
      }
      case 'return': {
        return { value: statement.value ? yield* this.evaluateSuspending(statement.value, frame) : None };
      }
      case 'raise': {
        const exception = statement.exception ? yield* this.evaluateSuspending(statement.exception, frame) : undefined;
        const cause = statement.cause ? yield* this.evaluateSuspending(statement.cause, frame) : undefined;
        throw this.raise(exception, cause);
      }
      case 'assert': {
        if (isTruthy(yield* this.evaluateSuspending(statement.test, frame))) return undefined;
        throw assertionError(statement.message ? [yield* this.evaluateSuspending(statement.message, frame)] : []);
      }
      case 'functionDef': {
        const decorators: PyValue[] = [];
        for (const decorator of statement.fn.decorators)
          decorators.push(yield* this.evaluateSuspending(decorator, frame));
        const defaults = yield* this.defaultsSuspending(statement.fn.params, frame);
        this.storeName(statement.binding, this.defineFunction(statement.fn, frame, decorators, defaults), frame);
        return undefined;
      }
      default: {
        throw this.runtime.unsupported('ジェネレータの中で、クラスの基底クラスやデコレータに書いた yield');
      }
    }
  }

  private *augmentedAssignSuspending(
    statement: Extract<Statement, { kind: 'augmentedAssign' }>,
    frame: Frame
  ): Generator<PyValue, void, PyValue> {
    const { target, operator } = statement;
    const operand = (): Generator<PyValue, PyValue, PyValue> => this.evaluateSuspending(statement.value, frame);
    if (target.kind === 'name') {
      const current = this.loadName(target, frame);
      this.storeName(target, inplaceOp(operator, current, yield* this.holding(frame, current, operand())), frame);
      return;
    }
    if (target.kind === 'attribute') {
      const object = yield* this.evaluateSuspending(target.object, frame);
      const current = this.hold(frame, object, () => getAttribute(object, target.name));
      const result = inplaceOp(operator, current, yield* this.holding(frame, object, operand()));
      setAttribute(object, target.name, result);
      return;
    }
    const subscript = target as Extract<Target, { kind: 'subscript' }>;
    const object = yield* this.evaluateSuspending(subscript.object, frame);
    const index = yield* this.holding(frame, object, this.evaluateSuspending(subscript.index, frame));
    const current = getItem(object, index);
    const result = inplaceOp(operator, current, yield* this.holding(frame, object, operand()));
    setItem(object, index, result);
  }

  private *deleteSuspending(target: Target, frame: Frame): Generator<PyValue, void, PyValue> {
    if (!targetSuspends(target)) {
      this.deleteTarget(target, frame);
      return;
    }
    if (target.kind === 'attribute') {
      deleteAttribute(yield* this.evaluateSuspending(target.object, frame), target.name);
    } else if (target.kind === 'subscript') {
      const object = yield* this.evaluateSuspending(target.object, frame);
      deleteItem(object, yield* this.holding(frame, object, this.evaluateSuspending(target.index, frame)));
    } else if (target.kind === 'unpack') {
      for (const element of target.elements) yield* this.deleteSuspending(element, frame);
    }
  }

  // Exceptions --------------------------------------------------------------------------------------------------------

  /** The error a `raise` statement raises, given the values of its exception and its cause. */
  private raise(value: PyValue | undefined, cause: PyValue | undefined): PyError {
    if (value === undefined) {
      const active = this.handling.at(-1);
      if (!active) return pyError('RuntimeError', 'No active exception to reraise');
      return new PyError(active);
    }
    const exception = toException(value, 'exceptions must derive from BaseException');
    const state = exception.exception;
    if (state && cause !== undefined) {
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
  private *guarded(statements: Statement[], frame: Frame): Generator<PyValue, Outcome, PyValue> {
    try {
      return { completion: yield* this.block(statements, frame) };
    } catch (error) {
      if (!(error instanceof PyError)) throw error;
      // An exception raised by an operation while another is handled is chained to it when it reaches a try.
      this.chain(error.exception);
      return { pending: error };
    }
  }

  private *handleException(
    statement: Extract<Statement, { kind: 'try' }>,
    caught: PyError,
    frame: Frame
  ): Generator<PyValue, Outcome, PyValue> {
    if (statement.isGroup) return yield* this.exceptStar(statement, caught, frame);
    let handler: ExceptHandler | undefined;
    for (const each of statement.handlers) {
      const types = each.types && (yield* this.handlerTypes(each.types, frame));
      if (types === undefined || matchesExceptionTypes(caught.exception, types)) {
        handler = each;
        break;
      }
    }
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

  private *handlerTypes(types: Expression, frame: Frame): Generator<PyValue, PyValue, PyValue> {
    return types.suspends ? yield* this.evaluateSuspending(types, frame) : this.evaluate(types, frame);
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
  ): Generator<PyValue, Outcome, PyValue> {
    const original = caught.exception;
    let remaining: PyInstance | undefined = exceptionGroupOf(original);
    const raised: PyInstance[] = [];
    let completion: Completion;
    for (const handler of statement.handlers) {
      if (!remaining) break;
      const types = yield* this.handlerTypes(handler.types as Expression, frame);
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

  private *withStatement(statement: Extract<Statement, { kind: 'with' }>, frame: Frame, index: number): Execution {
    if (index >= statement.items.length) return yield* this.block(statement.body, frame);
    const item = statement.items[index];
    const manager = item.context.suspends
      ? yield* this.evaluateSuspending(item.context, frame)
      : this.evaluate(item.context, frame);
    const enter = lookupSpecial(manager, '__enter__');
    const exit = lookupSpecial(manager, '__exit__');
    if (enter === undefined || exit === undefined) {
      const missed = exit === undefined ? '__exit__' : '__enter__';
      throw typeError(
        `'${classOf(manager).qualifiedName}' object does not support the context manager protocol (missed ${missed} method)`
      );
    }
    const length = frame.temporaries.length;
    frame.temporaries.push(manager);
    try {
      yield* this.enterContext(statement, index, bindValue(enter, manager), frame);
      let completion: Completion;
      try {
        completion = yield* this.withStatement(statement, frame, index + 1);
      } catch (error) {
        if (!(error instanceof PyError)) throw error;
        if (!(yield* this.exitWithException(statement, bindValue(exit, manager), error.exception))) throw error;
        return undefined;
      }
      yield* this.callExit(statement, bindValue(exit, manager), [None, None, None]);
      return completion;
    } finally {
      frame.temporaries.length = length;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Records the with statement's step as the synchronous and the suspending path each do.
  /**
   * Calls a context manager's `__enter__` and stores what it returns into the item's target, recording the with
   * statement's step after its first item. In a program that may run threads, `__enter__` may suspend the thread.
   */
  private *enterContext(
    statement: Extract<Statement, { kind: 'with' }>,
    index: number,
    enter: PyValue,
    frame: Frame
  ): Execution {
    const { runtime } = this;
    const item = statement.items[index];
    const target = item.target && targetSuspends(item.target) ? item.target : undefined;
    const stepRow = index === 0 ? statement.stepRow : undefined;
    const onlyCalls = (): boolean => !statement.items.some((each) => each.target);
    const enterCall = statement.suspends ? suspendingCall(enter, [], undefined) : undefined;
    let entered: PyValue;
    if (enterCall) {
      const begun = runtime.steps.stepCount;
      const switches = runtime.threads?.switches;
      entered = yield* enterCall;
      if (item.target && !target) this.assign(item.target, entered, frame);
      if (runtime.threads?.switches === switches) runtime.steps.finishStatement(stepRow, onlyCalls(), begun);
      else runtime.steps.step(stepRow);
    } else {
      entered = runtime.steps.runStatement(stepRow, onlyCalls, () => {
        const value = callValue(enter, []);
        if (item.target && !target) this.assign(item.target, value, frame);
        return value;
      });
    }
    if (target) yield* this.assignSuspending(target, entered, frame);
    return undefined;
  }

  /** Calls `__exit__` with the exception the body raised, returning whether it suppresses the exception. */
  private *exitWithException(
    statement: Statement,
    exit: PyValue,
    exception: PyInstance
  ): Generator<PyValue, boolean, PyValue> {
    this.handling.push(exception);
    try {
      return isTruthy(yield* this.callExit(statement, exit, [exception.cls, exception, None]));
    } finally {
      this.handling.pop();
    }
  }

  /** Calls a context manager's `__exit__`, so that it may suspend the thread in a program that may run threads. */
  private *callExit(statement: Statement, exit: PyValue, args: PyValue[]): Generator<PyValue, PyValue, PyValue> {
    const call = statement.suspends ? suspendingCall(exit, args, undefined) : undefined;
    return call ? yield* call : callValue(exit, args);
  }

  // Match ---------------------------------------------------------------------------------------------------------------

  private *matchStatement(statement: Extract<Statement, { kind: 'match' }>, frame: Frame): Execution {
    const subject = statement.subject.suspends
      ? yield* this.evaluateSuspending(statement.subject, frame)
      : this.evaluate(statement.subject, frame);
    const length = frame.temporaries.length;
    frame.temporaries.push(subject);
    try {
      for (const matchCase of statement.cases) {
        if (!this.matchCase(matchCase, subject, frame)) continue;
        const { guard } = matchCase;
        if (
          guard &&
          !isTruthy(guard.suspends ? yield* this.evaluateSuspending(guard, frame) : this.evaluate(guard, frame))
        )
          continue;
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
    return true;
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

/**
 * Runs the statements of a frame that is no generator to their end. Only the waits of blocking operations may suspend
 * them, which the thread then makes on the host's stack.
 */
function runToEnd(execution: Execution): Completion {
  for (;;) {
    const step = execution.next();
    if (step.done) return step.value;
    if (!isWaitRequest(step.value)) throw new Error('A frame that is not a generator yielded');
    schedulerOf().waitFor(step.value);
  }
}

/** Whether a frame runs a generator, a coroutine, or an async generator, which closing it may resume. */
function isSuspendable(frame: Frame): boolean {
  return frame.scope.isGenerator || frame.scope.isAsync === true;
}

/** Statements that never suspend a generator, which run without the cost of a generator of their own. */
function isSimple(statement: Statement): boolean {
  if (statement.suspends) return false;
  switch (statement.kind) {
    case 'if':
    case 'while':
    case 'for':
    case 'try':
    case 'with':
    case 'match': {
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

function assertionError(args: PyValue[]): PyError {
  return new PyError(newException(exceptionClassNamed('AssertionError'), args));
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
