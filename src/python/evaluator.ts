// code-gauge-allow-file fileNcss 985 -- The statement evaluator keeps one method per kind of statement together, with the suspending variants of the simple ones.
import { newAnnotate, recordAnnotation } from './annotations';
import type {
  BinaryOperator,
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
import { mappingEntries } from './callArguments';
import { buildClass, createClass } from './classes';
import { pyRepr, pyStr } from './conversions';
import { asyncYield } from './coroutines';
import { exceptionGroupOf, splitGroup } from './exceptionGroups';
import { addArgument, type CallArguments } from './expressionEvaluator';
import type { Frame } from './frame';
import { isMapping, isSequenceForMatch } from './matching';
import { isRegisteredModule } from './modules';
import { checkExtraName, checkNamespaceListing, missingNamespaceName } from './namespaceDifferences';
import {
  bindValue,
  callValue,
  deleteAttribute,
  deleteItem,
  getAttribute,
  getAttributeOrUndefined,
  getItem,
  importedModule,
  isTruthy,
  iterateHeld,
  lengthOf,
  lookupSpecial,
  setItem,
  toArray,
} from './objects';
import { compareOp, equals, inplaceOp, isSame } from './operators';
import type { Runtime } from './runtime';
import type { Suspension } from './suspendingEvaluator';
import { targetSuspends } from './suspension';
import { TemporaryScope } from './temporaryScope';
import { iterateSuspending, type SuspendingNext } from './threadIteration';
import { isWaitRequest, PREEMPTION, schedulerOf, suspendingCall } from './threads';
import { noteCaught, prependTraceback } from './tracebacks';
import { genericBaseOf, newTypeParam, PyTypeAlias } from './typeParams';
import {
  baseExceptionClass,
  classOf,
  exceptionClassNamed,
  fullyQualifiedName,
  isInstanceOf,
  nativeFunction,
  newDict,
  newException,
  newList,
  newSet,
  newTuple,
  None,
  pyError,
  typeError,
  typeName,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import { DONE, PyClass, PyError, type PyFunction, PyInstance, PyModule, PyTuple, type PyValue } from './values';
import { hasWeakCallbacks, runWeakCallbacks } from './weakReferences';

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
    if (!Array.isArray(body)) return this.evaluateValue(body, frame);
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
      // An object a statement left unreachable is freed before the next one runs, calling its weakref callbacks.
      if (hasWeakCallbacks(this.runtime)) runWeakCallbacks();
      if (completion) return completion;
    }
    return undefined;
  }

  // code-gauge-allow functionNcss 60 -- One case per kind of simple statement.
  private simpleStatement(statement: Statement, frame: Frame): Completion {
    const { runtime } = this;
    runtime.spend();
    runtime.currentRow = statement.row;
    switch (statement.kind) {
      case 'expression': {
        this.expressionStatement(statement, frame);
        return undefined;
      }
      case 'assign': {
        this.assignValue(statement.stepRow, statement.targets, statement.value, frame);
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
      case 'setupAnnotations':
      case 'setupAnnotate': {
        setUpAnnotations(statement.kind, frame);
        return undefined;
      }
      case 'break':
      case 'continue': {
        return statement.kind;
      }
      case 'return': {
        return { value: statement.value ? this.returnedValue(statement.value, frame) : None };
      }
      case 'raise': {
        const exception = statement.exception ? this.evaluate(statement.exception, frame) : undefined;
        throw this.raise(exception, statement.cause ? this.evaluate(statement.cause, frame) : undefined, frame);
      }
      case 'assert': {
        if (isTruthy(this.evaluate(statement.test, frame))) return undefined;
        throw assertionError(statement.message ? [this.evaluate(statement.message, frame)] : []);
      }
      case 'functionDef': {
        this.storeName(statement.binding, this.defineFunction(statement.fn, frame), frame);
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

  /** Evaluates a returned value, which a function hands to its caller, and a generator to whatever resumed it. */
  private returnedValue(expression: Expression, frame: Frame): PyValue {
    const { scope } = frame;
    return scope.isGenerator || scope.isAsync
      ? this.evaluate(expression, frame)
      : this.evaluateValue(expression, frame);
  }

  /** Evaluates an expression statement, handing its value to sys.displayhook in compile()'s 'single' mode. */
  private expressionStatement(statement: Extract<Statement, { kind: 'expression' }>, frame: Frame): void {
    const { runtime } = this;
    const { expression } = statement;
    const result = runtime.steps.runStatement(statement.stepRow, expression.kind === 'call', () =>
      this.evaluateValue(expression, frame)
    );
    this.discard(statement, result);
  }

  /** Ends an expression statement, which drops its value after handing it to sys.displayhook in 'single' mode. */
  private discard(statement: Extract<Statement, { kind: 'expression' }>, result: PyValue): void {
    const { runtime } = this;
    if (statement.displays) {
      runtime.finalizer.locals.escape(result);
      callValue(getAttribute(runtime.importModule('sys'), 'displayhook'), [result]);
    }
    if (runtime.finalizer.pending.size > 0) this.release(result);
  }

  private annotatedAssign(statement: Extract<Statement, { kind: 'annotatedAssign' }>, frame: Frame): void {
    this.annotate(statement, frame);
    if (statement.value) this.assignValue(statement.stepRow, [statement.target], statement.value, frame);
  }

  /** Assigns a value to the targets as one step, which is left out when the value only created objects. */
  private assignValue(stepRow: number | undefined, targets: Target[], expression: Expression, frame: Frame): void {
    let created = false;
    this.runtime.steps.runStatement(
      stepRow,
      () => created && targets.every(storesReference),
      () => {
        const [value, isCreation] = this.evaluateCreation(expression, frame);
        created = isCreation;
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

  private importStatement(
    statement: Extract<Statement, { kind: 'import' | 'importFrom' | 'importStar' }>,
    frame: Frame
  ): void {
    const { runtime } = this;
    if (statement.kind === 'importFrom') {
      this.importFrom(statement, frame);
    } else if (statement.kind === 'importStar') {
      const module = runtime.resolveImport(statement.module);
      for (const [name, value] of starNames(module)) frame.locals.set(name, value);
    } else {
      for (const { module, binding, bindsModule } of statement.names) {
        const imported = runtime.resolveImport(module);
        this.storeName(binding, bindsModule ? imported : runtime.resolveImport(module.split('.')[0] as string), frame);
      }
    }
  }

  private importFrom(statement: Extract<Statement, { kind: 'importFrom' }>, frame: Frame): void {
    const module = this.runtime.resolveImport(statement.module);
    for (const { name, binding } of statement.names) {
      const value =
        module instanceof PyModule
          ? this.moduleName(module, statement.module, name)
          : getAttributeOrUndefined(module, name);
      if (value === undefined) {
        const error = pyError(
          'ImportError',
          `cannot import name '${name}' from '${statement.module}' (unknown location)`
        );
        const state = error.exception.exception;
        if (state) state.fields = new Map([...(state.fields ?? []), ['name', statement.module], ['name_from', name]]);
        throw error;
      }
      this.storeName(binding, value, frame);
    }
  }

  /** The value `from module import name` binds from a module, or undefined when it has no such name. */
  private moduleName(module: PyModule, moduleName: string, name: string): PyValue | undefined {
    const feature = module.unsupported.get(name);
    if (feature !== undefined) throw new UnsupportedFeatureError(feature);
    checkExtraName(module, name);
    // As in CPython, a name a package lacks may be a submodule, which importing it adds to the package.
    const submodule = `${moduleName}.${name}`;
    const value =
      module.dict.get(name) ??
      importedModule(module, name) ??
      (module.dict.has('__getattr__') ? getAttributeOrUndefined(module, name) : undefined) ??
      (isRegisteredModule(submodule) ? this.runtime.resolveImport(submodule) : undefined);
    if (value === undefined && !this.runtime.inLibraryCode()) {
      const missing = missingNamespaceName(module, name);
      if (missing !== undefined) throw new UnsupportedFeatureError(missing);
    }
    return value;
  }

  /** Evaluates an assignment's value, telling whether it only creates objects, whose constructors' steps show it. */
  // code-gauge-allow duplicateLines 23 -- The synchronous and suspending paths evaluate a creation the same way.
  private evaluateCreation(expression: Expression, frame: Frame): [PyValue, boolean] {
    if (expression.kind === 'call') {
      const callee = this.evaluateValue(expression.callee, frame);
      return [this.call(expression, frame, callee), callee instanceof PyClass];
    }
    if (
      (expression.kind === 'list' || expression.kind === 'tuple') &&
      expression.elements.length > 0 &&
      expression.elements.every((element) => element.kind === 'call')
    ) {
      {
        const temporaryScope = new TemporaryScope(frame.temporaries);
        try {
          let created = true;
          const items: PyValue[] = [];
          for (const element of expression.elements) {
            const [item, isCreation] = this.evaluateCreation(element as Expression, frame);
            created &&= isCreation;
            items.push(item);
            frame.temporaries.push(item);
          }
          for (const item of items) this.runtime.finalizer.locals.escape(item);
          return temporaryScope.keep([expression.kind === 'list' ? newList(items) : newTuple(items), created]);
        } catch (error) {
          throw temporaryScope.capture(error);
        } finally {
          temporaryScope.release();
        }
      }
    }
    return [this.evaluateValue(expression, frame), false];
  }

  private augmentedAssign(statement: Extract<Statement, { kind: 'augmentedAssign' }>, frame: Frame): void {
    const { target, operator } = statement;
    switch (target.kind) {
      case 'name': {
        const current = this.loadName(target, frame);
        this.storeName(target, this.inplace(operator, current, this.evaluate(statement.value, frame)), frame);
        return;
      }
      case 'attribute': {
        const object = this.evaluateValue(target.object, frame);
        this.hold(frame, object, () => {
          const current = getAttribute(object, target.name);
          const result = this.inplace(operator, current, this.evaluate(statement.value, frame));
          this.storeInto(object, target.name, true, result);
        });
        return;
      }
      case 'subscript': {
        const object = this.evaluateValue(target.object, frame);
        this.hold(frame, object, () => {
          const index = this.evaluateValue(target.index, frame);
          const current = getItem(object, index);
          const result = this.hold(frame, index, () =>
            this.inplace(operator, current, this.evaluate(statement.value, frame))
          );
          this.storeInto(object, index, false, result);
        });
        return;
      }
      default: {
        throw new Error('Unexpected target of an augmented assignment');
      }
    }
  }

  /**
   * Applies an augmented assignment's operator to a target's value, freeing what `items *= 0` drops from a container
   * changed in place, and handing on the items `items += (x,)` copied into a new one.
   */
  private inplace(operator: BinaryOperator, current: PyValue, value: PyValue): PyValue {
    const { finalizer } = this.runtime;
    const result = finalizer.mutating(current, () => inplaceOp(operator, current, value), [value]);
    if (finalizer.locals.marking && result !== current) finalizer.locals.escapeItems(result);
    return result;
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
    recordAnnotation(frame, { name: statement.target.name, expression: annotation, frame });
    if (statement.annotationIndex !== undefined) {
      const conditional = frame.locals.get('__conditional_annotations__');
      if (conditional !== undefined) callValue(getAttribute(conditional, 'add'), [BigInt(statement.annotationIndex)]);
    }
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
        const value = test.suspends ? yield* this.evaluateSuspending(test, frame) : this.evaluateValue(test, frame);
        return yield* this.block(isTruthy(value) ? statement.body : statement.orelse, frame);
      }
      case 'while': {
        const { test } = statement;
        while (
          isTruthy(test.suspends ? yield* this.evaluateSuspending(test, frame) : this.evaluateValue(test, frame))
        ) {
          runtime.spend();
          if (runtime.threads?.shouldPreempt()) yield PREEMPTION as unknown as PyValue;
          const completion = yield* this.block(statement.body, frame);
          if (completion === 'break') return undefined;
          if (completion && completion !== 'continue') return completion;
          runtime.currentRow = statement.row;
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

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows the protocol of the for loop, closing a generator it leaves.
  // code-gauge-allow functionNcss 42 -- Follows the protocol of the for loop, closing a generator it leaves.
  private *forStatement(statement: Extract<Statement, { kind: 'for' }>, frame: Frame): Execution {
    const { runtime } = this;
    const { target } = statement;
    // The loop holds its iterable among the frame's values, and its iterator only reads it.
    const iterable = statement.iterable.suspends
      ? yield* this.evaluateSuspending(statement.iterable, frame)
      : this.evaluateIterable(statement.iterable, frame);
    const suspendingTarget = targetSuspends(target);
    const temporaryScope2 = new TemporaryScope(frame.temporaries);
    frame.temporaries.push(iterable);
    try {
      let held: PyValue | undefined;
      // A thread reads its loop's iterable where it can suspend, so that waiting in a generator it reads suspends it.
      const suspendingNext = runtime.threads ? iterateSuspending(iterable, frame.temporaries) : undefined;
      let next: (() => PyValue | typeof DONE) | undefined;
      if (!suspendingNext) {
        ({ next, held } = iterateHeld(iterable));
        frame.temporaries.push(held);
      }
      const read = function* (): Suspension<PyValue | typeof DONE> {
        runtime.currentRow = statement.row;
        return next ? next() : yield* (suspendingNext as SuspendingNext)();
      };
      runtime.currentRow = statement.row;
      for (
        let item = next ? next() : yield* read();
        item !== DONE;
        item = next ? ((runtime.currentRow = statement.row), next()) : yield* read()
      ) {
        runtime.spend();
        if (runtime.threads?.shouldPreempt()) yield PREEMPTION as unknown as PyValue;
        runtime.currentRow = statement.row;
        if (suspendingTarget) yield* this.assignSuspending(target, item, frame);
        else this.assign(target, item, frame);
        runtime.steps.stepBinding(statement.stepRow, !storesReference(target) || storesAnswer(item));
        const completion = yield* this.block(statement.body, frame);
        if (completion === 'break') return temporaryScope2.keep(undefined);
        if (completion && completion !== 'continue') {
          return temporaryScope2.keep(completion);
        }
      }
    } catch (error) {
      throw temporaryScope2.capture(error);
    } finally {
      temporaryScope2.release();
    }
    return yield* this.block(statement.orelse, frame);
  }

  // Definitions ---------------------------------------------------------------------------------------------------------

  /** Creates a function, inside the scope of its type parameters when it has them. */
  private defineFunction(fn: FunctionDef, frame: Frame, decorators?: PyValue[], defaults?: PyValue[]): PyValue {
    const temporaryScope3 = new TemporaryScope(frame.temporaries);
    try {
      const resolvedDecorators =
        decorators ??
        fn.decorators.map((decorator) => {
          const value = this.evaluate(decorator, frame);
          frame.temporaries.push(value);
          return value;
        });
      if (!fn.typeParams) return temporaryScope3.keep(this.createFunction(fn, frame, resolvedDecorators, defaults));
      const defaultValues =
        defaults ??
        fn.params.flatMap((param) => {
          if (!param.default) return [];
          const value = this.evaluate(param.default, frame);
          frame.temporaries.push(value);
          return [value];
        });
      const scopeFrame = this.typeParamFrame(fn.typeParams.scope, frame);
      const params = this.createTypeParams(fn.typeParams.params, scopeFrame);
      return temporaryScope3.keep(this.createFunction(fn, scopeFrame, resolvedDecorators, defaultValues, params));
    } catch (error) {
      throw temporaryScope3.capture(error);
    } finally {
      temporaryScope3.release();
    }
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

  /** Creates a class whose decorators or bases suspend the generator or coroutine running it, as `yield` does. */
  private *defineClassSuspending(cls: ClassDef, frame: Frame): Generator<PyValue, PyValue, PyValue> {
    const decorators: PyValue[] = [];
    for (const decorator of cls.decorators) decorators.push(yield* this.evaluateSuspending(decorator, frame));
    const scopeFrame = cls.typeParams ? this.typeParamFrame(cls.typeParams.scope, frame) : frame;
    if (cls.typeParams) {
      const params = this.createTypeParams(cls.typeParams.params, scopeFrame);
      this.storeName(cls.typeParams.tuple, newTuple(params), scopeFrame);
      this.storeName(cls.typeParams.genericBase, genericBaseOf(params), scopeFrame);
    }
    const collected: CallArguments = { args: [], kwargs: undefined };
    const temporaryScope4 = new TemporaryScope(scopeFrame.temporaries);
    try {
      for (const argument of cls.bases) {
        const value = yield* this.evaluateSuspending(argument.value, scopeFrame);
        addArgument(
          collected,
          argument,
          value,
          { callee: buildClass, argumentList: cls.bases, leading: 2 },
          scopeFrame
        );
      }
      return temporaryScope4.keep(createClass(this, cls, scopeFrame, decorators, collected));
    } catch (error) {
      throw temporaryScope4.capture(error);
    } finally {
      temporaryScope4.release();
    }
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
    if (statement.kind === 'assign') {
      const [result, created] = yield* this.evaluateCreationSuspending(statement.value, frame);
      for (const target of statement.targets)
        yield* this.holding(frame, result, this.assignSuspending(target, result, frame));
      onlyCalls = created && statement.targets.every(storesReference);
    } else if (statement.kind === 'annotatedAssign') {
      this.annotate(statement, frame);
      if (statement.value) {
        const [result, created] = yield* this.evaluateCreationSuspending(statement.value, frame);
        yield* this.holding(frame, result, this.assignSuspending(statement.target, result, frame));
        onlyCalls = created && storesReference(statement.target);
      }
    } else {
      completion = yield* this.suspendingStatementBody(statement, frame);
    }
    if (runtime.threads?.switches === switches) runtime.steps.finishStatement(statement.stepRow, onlyCalls, begun);
    else runtime.steps.step(statement.stepRow);
    return completion;
  }

  /** Suspending counterpart of `evaluateCreation`: evaluates an assignment's value and tells whether it only creates objects. */
  // code-gauge-allow duplicateLines 23 -- The synchronous and suspending paths evaluate a creation the same way.
  private *evaluateCreationSuspending(expression: Expression, frame: Frame): Suspension<[PyValue, boolean]> {
    if (expression.kind === 'call') {
      const callee = yield* this.evaluateSuspending(expression.callee, frame);
      const result = yield* this.holding(
        frame,
        callee,
        this.callValueSuspending(callee, expression.args, expression.row, frame)
      );
      return [result, callee instanceof PyClass];
    }
    if (
      (expression.kind === 'list' || expression.kind === 'tuple') &&
      expression.elements.length > 0 &&
      expression.elements.every((element) => element.kind === 'call')
    ) {
      const temporaryScope5 = new TemporaryScope(frame.temporaries);
      try {
        let created = true;
        const items: PyValue[] = [];
        for (const element of expression.elements) {
          const [item, isCreation] = yield* this.evaluateCreationSuspending(element as Expression, frame);
          created &&= isCreation;
          items.push(item);
          frame.temporaries.push(item);
        }
        for (const item of items) this.runtime.finalizer.locals.escape(item);
        return temporaryScope5.keep([expression.kind === 'list' ? newList(items) : newTuple(items), created]);
      } catch (error) {
        throw temporaryScope5.capture(error);
      } finally {
        temporaryScope5.release();
      }
    }
    return [yield* this.evaluateSuspending(expression, frame), false];
  }

  // code-gauge-allow functionNcss 45 -- One case per kind of simple statement that evaluates expressions.
  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of simple statement that evaluates expressions.
  private *suspendingStatementBody(statement: Statement, frame: Frame): Execution {
    switch (statement.kind) {
      case 'expression': {
        this.discard(statement, yield* this.evaluateSuspending(statement.expression, frame));
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
        throw this.raise(exception, cause, frame);
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
      case 'classDef': {
        this.storeName(statement.binding, yield* this.defineClassSuspending(statement.cls, frame), frame);
        return undefined;
      }
      default: {
        throw new Error(`Not a suspending statement: ${statement.kind}`);
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
      const value = yield* this.holding(frame, current, operand());
      this.storeName(target, this.inplace(operator, current, value), frame);
      return;
    }
    if (target.kind === 'attribute') {
      const object = yield* this.evaluateSuspending(target.object, frame);
      const current = this.hold(frame, object, () => getAttribute(object, target.name));
      const value = yield* this.holding(frame, object, operand());
      this.hold(frame, object, () => this.storeInto(object, target.name, true, this.inplace(operator, current, value)));
      return;
    }
    const subscript = target as Extract<Target, { kind: 'subscript' }>;
    const object = yield* this.evaluateSuspending(subscript.object, frame);
    const index = yield* this.holding(frame, object, this.evaluateSuspending(subscript.index, frame));
    const current = getItem(object, index);
    const value = yield* this.holding(frame, object, operand());
    this.hold(frame, object, () => this.storeInto(object, index, false, this.inplace(operator, current, value)));
  }

  private *deleteSuspending(target: Target, frame: Frame): Generator<PyValue, void, PyValue> {
    if (!targetSuspends(target)) {
      this.deleteTarget(target, frame);
      return;
    }
    if (target.kind === 'attribute') {
      const object = yield* this.evaluateSuspending(target.object, frame);
      this.runtime.finalizer.replacing(object, target.name, true, () => deleteAttribute(object, target.name));
    } else if (target.kind === 'subscript') {
      const object = yield* this.evaluateSuspending(target.object, frame);
      const index = yield* this.holding(frame, object, this.evaluateSuspending(target.index, frame));
      this.runtime.finalizer.replacing(object, index, false, () => deleteItem(object, index));
    } else if (target.kind === 'unpack') {
      for (const element of target.elements) yield* this.deleteSuspending(element, frame);
    }
  }

  // Exceptions --------------------------------------------------------------------------------------------------------

  /**
   * The error a `raise` statement in `frame` raises, given the values of its exception and its cause. Raising an
   * exception adds the frame to its traceback, while a bare `raise` keeps the traceback it has.
   */
  private raise(value: PyValue | undefined, cause: PyValue | undefined, frame: Frame): PyError {
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
    if (state) prependTraceback(state, frame, this.runtime.currentRow);
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
      const finalCompletion = yield* this.finallyBlock(statement.finalbody, pending, completion, frame);
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
    noteCaught(caught, frame);
    try {
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
      return { completion: yield* this.runHandler(handler, caught.exception, frame) };
    } catch (error) {
      if (!(error instanceof PyError)) throw error;
      this.chainTo(error.exception, caught.exception);
      return { pending: error };
    }
  }

  /** Runs a finally block, holding the exception or the returned value it delays until it ends. */
  private *finallyBlock(
    finalbody: Statement[],
    pending: PyError | undefined,
    completion: Completion,
    frame: Frame
  ): Execution {
    const temporaryScope6 = new TemporaryScope(frame.temporaries, (result) =>
      result === undefined ? [pending?.exception, typeof completion === 'object' ? completion.value : undefined] : []
    );
    if (typeof completion === 'object') frame.temporaries.push(completion.value);
    if (pending) {
      frame.temporaries.push(pending.exception);
      this.handling.push(pending.exception);
    }
    try {
      return temporaryScope6.keep(yield* this.block(finalbody, frame));
    } catch (error) {
      if (error instanceof PyError && pending) this.chainTo(error.exception, pending.exception);
      throw temporaryScope6.capture(error);
    } finally {
      if (pending) this.handling.pop();
      temporaryScope6.release();
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
    const temporaryScope = new TemporaryScope(frame.temporaries);
    frame.temporaries.push(exception);
    if (handler.name) this.storeName(handler.name, exception, frame);
    this.handling.push(exception);
    try {
      return temporaryScope.keep(yield* this.block(handler.body, frame));
    } catch (error) {
      if (error instanceof PyError) this.chainTo(error.exception, exception);
      throw temporaryScope.capture(error);
    } finally {
      this.handling.pop();
      // Python deletes the name after the handler, so that the exception does not stay reachable.
      if (handler.name) {
        try {
          this.deleteName(handler.name, frame);
        } catch (error) {
          // The handler may have deleted the name itself; what freeing the exception ran may still stop the program.
          // oxlint-disable-next-line no-unsafe-finally -- A refusal while freeing the exception stops the program, whatever the handler raised.
          if (!(error instanceof PyError)) throw error;
        }
      }
      temporaryScope.release();
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

  // code-gauge-allow functionNcss 35 -- Enters, runs the body, and exits with or without an exception, as a with statement does.
  private *withStatement(statement: Extract<Statement, { kind: 'with' }>, frame: Frame, index: number): Execution {
    if (index >= statement.items.length) return yield* this.block(statement.body, frame);
    const { runtime } = this;
    const item = statement.items[index];
    const manager = item.context.suspends
      ? yield* this.evaluateSuspending(item.context, frame)
      : this.evaluate(item.context, frame);
    const enter = lookupSpecial(manager, '__enter__');
    const exit = lookupSpecial(manager, '__exit__');
    if (enter === undefined || exit === undefined) {
      // CPython looks up __exit__ first, so an object with neither method reports __exit__.
      const missed = exit === undefined ? '__exit__' : '__enter__';
      throw typeError(
        `'${fullyQualifiedName(classOf(manager))}' object does not support the context manager protocol (missed ${missed} method)`
      );
    }
    const temporaryScope7 = new TemporaryScope(frame.temporaries);
    frame.temporaries.push(manager);
    try {
      let entered = false;
      let completion: Completion;
      try {
        yield* this.enterContext(statement, index, bindValue(enter, manager), frame, () => {
          entered = true;
        });
        completion = yield* this.withStatement(statement, frame, index + 1);
      } catch (error) {
        if (!(error instanceof PyError) || !entered) throw error;
        noteCaught(error, frame);
        runtime.currentRow = statement.row;
        if (!(yield* this.exitWithException(statement, bindValue(exit, manager), error.exception))) throw error;
        return temporaryScope7.keep(undefined);
      }
      runtime.currentRow = statement.row;
      // The value the body returns stays reachable while __exit__ runs.
      if (typeof completion === 'object') frame.temporaries.push(completion.value);
      yield* this.callExit(statement, bindValue(exit, manager), [None, None, None]);
      return temporaryScope7.keep(completion);
    } catch (error) {
      throw temporaryScope7.capture(error);
    } finally {
      temporaryScope7.release();
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
    frame: Frame,
    onEntered: () => void
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
      onEntered();
      if (item.target && !target) this.assign(item.target, entered, frame);
      if (runtime.threads?.switches === switches) runtime.steps.finishStatement(stepRow, onlyCalls(), begun);
      else runtime.steps.step(stepRow);
    } else {
      entered = runtime.steps.runStatement(stepRow, onlyCalls, () => {
        const value = callValue(enter, []);
        onEntered();
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
    let suppresses: boolean;
    try {
      const tb = exception.exception?.traceback ?? None;
      suppresses = isTruthy(yield* this.callExit(statement, exit, [exception.cls, exception, tb]));
    } finally {
      this.handling.pop();
    }
    // A suppressed exception dies here, and with it the frames its traceback kept.
    const { finalizer } = this.runtime;
    if (suppresses && finalizer.pending.size > 0) finalizer.release([exception]);
    return suppresses;
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
    const temporaryScope8 = new TemporaryScope(frame.temporaries);
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
        return temporaryScope8.keep(yield* this.block(matchCase.body, frame));
      }
      return temporaryScope8.keep(undefined);
    } catch (error) {
      throw temporaryScope8.capture(error);
    } finally {
      temporaryScope8.release();
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
        return isTruthy(compareOp('==', subject, this.evaluate(pattern.value, frame)));
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
    // As CPython does, the length decides first and only the items the pattern names are read by index; a starred
    // capture alone takes the items between.
    const length = Number(lengthOf(subject));
    const item = (index: number): PyValue => getItem(subject, BigInt(index));
    const { patterns, starIndex } = pattern;
    if (starIndex === undefined) {
      if (length !== patterns.length) return false;
      return patterns.every((each, index) => this.matchPattern(each, item(index), bindings, frame));
    }
    const after = patterns.length - starIndex - 1;
    if (length < patterns.length - 1) return false;
    for (let index = 0; index < starIndex; index++) {
      if (!this.matchPattern(patterns[index], item(index), bindings, frame)) return false;
    }
    for (let index = 0; index < after; index++) {
      if (!this.matchPattern(patterns[starIndex + 1 + index], item(length - after + index), bindings, frame)) {
        return false;
      }
    }
    const star = patterns[starIndex];
    if (star.kind === 'star' && star.name) {
      bindings.set(star.name, newList(toArray(subject).slice(starIndex, length - after)));
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
        if (!seen.some((other) => equals(other, key))) rest.store.set(key, value);
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

/** The names `from module import *` binds: those of the module's `__all__`, or its public names without one. */
function starNames(module: PyValue): [string, PyValue][] {
  const all = getAttributeOrUndefined(module, '__all__');
  if (all === undefined) {
    if (!(module instanceof PyModule)) {
      return toArray(getAttribute(module, '__dict__'))
        .filter((name): name is string => typeof name === 'string' && !name.startsWith('_'))
        .map((name) => [name, getAttribute(module, name)]);
    }
    checkNamespaceListing(module, 'from ... import *');
    return [...module.dict].filter(([name]) => !name.startsWith('_'));
  }
  return toArray(all).map((name) => {
    if (typeof name !== 'string') {
      const owner = module instanceof PyModule ? module.name : pyStr(getAttribute(module, '__name__'));
      throw typeError(`Item in ${owner}.__all__ must be str, not ${typeName(name)}`);
    }
    // A name this grader does not support is bound all the same, failing when the program uses it.
    const feature = module instanceof PyModule ? module.unsupported.get(name) : undefined;
    if (feature === undefined) return [name, getAttribute(module, name)];
    return [
      name,
      nativeFunction(name, () => {
        throw new UnsupportedFeatureError(feature);
      }),
    ];
  });
}

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

/** Creates the __annotations__ dict of a module or class body, or its __annotate__ function for lazy annotations. */
function setUpAnnotations(kind: 'setupAnnotations' | 'setupAnnotate', frame: Frame): void {
  if (kind === 'setupAnnotations') {
    if (!frame.locals.has('__annotations__')) frame.locals.set('__annotations__', newDict());
    return;
  }
  frame.locals.set(
    '__annotate__',
    newAnnotate(undefined, frame.globals, () => frame.annotations)
  );
  frame.locals.set('__conditional_annotations__', newSet());
}

function matchesExceptionTypes(exception: PyInstance, types: PyValue): boolean {
  return exceptionTypes(types).some((type) => exception.cls.isSubclassOf(type));
}

function checkExceptStarTypes(types: PyValue): void {
  for (const type of exceptionTypes(types)) {
    if (type.isSubclassOf(exceptionClassNamed('BaseExceptionGroup'))) {
      throw typeError('catching ExceptionGroup with except* is not allowed. Use except instead.');
    }
  }
}

/**
 * The classes an `except` clause names, every one checked before any is matched, as CPython's
 * check_except_type_valid does: a tuple's members must be exception classes themselves, not nested tuples.
 */
function exceptionTypes(types: PyValue): PyClass[] {
  const list = types instanceof PyTuple ? types.items : [types];
  return list.map((type) => {
    if (!(type instanceof PyClass) || !type.isSubclassOf(baseExceptionClass)) {
      throw typeError('catching classes that do not inherit from BaseException is not allowed');
    }
    return type;
  });
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
