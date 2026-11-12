import type {
  Block,
  DeclarationKind,
  Expression,
  Pattern,
  ScopeDeclarations,
  Statement,
  VariableDeclaration,
} from './ast';
import { AwaitingIterator, type LoopIterator } from './asyncGenerators';
import { Awaiting, GeneratorReturn, resumedValue, runToEnd, type Steps } from './generators';
import { DONE, ValueIterator } from './iteration';
import { asyncIteratorOf } from './iteratorProtocol';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import { StepEvaluator } from './stepEvaluator';
import { onlyCalls, onlyCreates, storesReference } from './stepRules';
import { type Binding, isCallable, isObject, JsObject, JsThrow, Scope, toBoolean, type Value } from './values';

export type Completion = undefined | { kind: 'break' | 'continue'; label?: string } | { kind: 'return'; value: Value };

/** What running code in a scope gives: a statement's completion, a loop body's `'next'`, or an expression's value. */
export type Outcome = Completion | 'next' | Value;

/**
 * Runs the statements of generator and async function bodies as host generators, which suspend at each `yield` and
 * `await` with what it yields or awaits. Other code runs through the synchronous statements of `Evaluator`, which
 * nest only one host frame per statement and so leave programs the recursion depth they have in Node.js.
 */
export abstract class SuspendableStatementEvaluator extends StepEvaluator {
  private *statementsSteps(statements: Statement[]): Steps<Completion> {
    for (const statement of statements) {
      const completion = yield* this.statementSteps(statement, []);
      if (completion) return completion;
    }
    return undefined;
  }

  /** Evaluates an expression, step by step when it contains a `yield`. */
  protected *valueSteps(expression: Expression): Steps<Value> {
    return expression.suspends ? yield* this.evaluateSteps(expression) : this.evaluate(expression);
  }

  /** Records the step of binding a loop's target, whose destructuring stores the values it reads out of an object. */
  protected stepBinding({ target, stepRow }: Extract<Statement, { kind: 'forOf' | 'forIn' }>, value: Value): void {
    this.runtime.steps.stepBinding(stepRow, !storesReference(target) || (!isObject(value) && value !== null));
  }

  // code-gauge-allow functionNcss 54 -- One case per statement kind, each delegating where it grows.
  // code-gauge-allow functionCognitiveComplexity 20 -- One case per statement kind, each delegating where it grows.
  private *statementSteps(statement: Statement, labels: string[]): Steps<Completion> {
    const { runtime } = this;
    runtime.spend();
    switch (statement.kind) {
      case 'expression': {
        const { expression } = statement;
        if (!expression.suspends) {
          runtime.steps.runStatement(statement.stepRow, onlyCalls(expression), () => this.evaluate(expression));
          return undefined;
        }
        yield* this.evaluateSteps(expression);
        runtime.steps.step(statement.stepRow);
        return undefined;
      }
      case 'declaration': {
        if (!statement.declarators.some(({ init }) => init?.suspends)) {
          runtime.steps.runStatement(statement.stepRow, onlyCreates(statement), () =>
            runToEnd(this.declarationSteps(statement))
          );
          return undefined;
        }
        yield* this.declarationSteps(statement);
        runtime.steps.step(statement.stepRow);
        return undefined;
      }
      case 'function':
      case 'empty': {
        return undefined;
      }
      case 'class': {
        this.writeVariable(statement.cls.name, this.evaluateClass(statement.cls), 'initialize');
        return undefined;
      }
      case 'return': {
        const value = statement.value ? yield* this.valueSteps(statement.value) : undefined;
        return { kind: 'return', value: statement.awaitsValue ? resumedValue(yield new Awaiting(value)) : value };
      }
      case 'if': {
        if (toBoolean(yield* this.valueSteps(statement.test)))
          return yield* this.statementSteps(statement.consequent, []);
        return statement.alternate ? yield* this.statementSteps(statement.alternate, []) : undefined;
      }
      case 'block': {
        return yield* this.blockSteps(statement);
      }
      case 'for': {
        return yield* this.forStatementSteps(statement, labels);
      }
      case 'forOf':
      case 'forIn': {
        return yield* this.forEachStatementSteps(statement, labels);
      }
      case 'while':
      case 'doWhile': {
        for (let first = true; ; first = false) {
          if (!(first && statement.kind === 'doWhile') && !toBoolean(yield* this.valueSteps(statement.test)))
            return undefined;
          const result = yield* this.loopBodySteps(statement.body, labels);
          if (result !== 'next') return result;
          runtime.spend();
        }
      }
      case 'break':
      case 'continue': {
        return { kind: statement.kind, label: statement.label };
      }
      case 'labeled': {
        const completion = yield* this.statementSteps(statement.body, [...labels, statement.label]);
        return completion?.kind === 'break' && completion.label === statement.label ? undefined : completion;
      }
      case 'switch': {
        return yield* this.switchStatementSteps(statement);
      }
      case 'throw': {
        throw new JsThrow(yield* this.valueSteps(statement.argument));
      }
      case 'try': {
        return yield* this.tryStatementSteps(statement);
      }
    }
  }

  /** Runs `run` in a new scope with `declarations`, or in the current one when nothing is declared. */
  private *scopedSteps<T extends Outcome>(declarations: ScopeDeclarations, run: () => Steps<T>): Steps<T> {
    if (declarations.lexical.length === 0 && declarations.functions.length === 0 && declarations.vars.length === 0) {
      return yield* run();
    }
    const frame = this.runtime.frame;
    const outer = frame.scope;
    frame.scope = new Scope(outer);
    try {
      this.instantiate(frame.scope, declarations);
      return yield* declarations.disposes ? this.disposingSteps(run) : run();
    } finally {
      frame.scope = outer;
    }
  }

  /** Runs the statements of a function body or the program, disposing of what their `using` declarations declared. */
  protected bodySteps(statements: Statement[], declarations: ScopeDeclarations): Steps<Completion> {
    return declarations.disposes
      ? this.disposingSteps(() => this.statementsSteps(statements))
      : this.statementsSteps(statements);
  }

  /**
   * Runs `run`, then disposes of the values the `using` declarations in the current scope declared, the last first. An
   * error a disposal throws suppresses the error before it, which a SuppressedError then holds.
   */
  private *disposingSteps<T extends Outcome>(run: () => Steps<T>): Steps<T> {
    const { runtime } = this;
    const scope = runtime.frame.scope;
    let result: T | undefined;
    let completion: JsThrow | GeneratorReturn | undefined;
    try {
      result = yield* run();
    } catch (error) {
      if (!(error instanceof JsThrow) && !(error instanceof GeneratorReturn)) throw error;
      completion = error;
    }
    const disposables = scope.disposables ?? [];
    scope.disposables = undefined;
    // The value the scope returns or throws stays reachable while the disposers run.
    const { temporaries } = runtime.frame;
    const held = temporaries.length;
    temporaries.push(pendingValue(result, completion));
    for (const { value, method, isAsync, awaitsResult } of disposables.toReversed()) {
      try {
        const disposed = method ? runtime.call(method, value, []) : undefined;
        if (isAsync) resumedValue(yield new Awaiting(awaitsResult ? disposed : undefined));
      } catch (error) {
        if (!(error instanceof JsThrow)) throw error;
        completion =
          completion instanceof JsThrow ? new JsThrow(suppressedError(runtime, error.value, completion.value)) : error;
      }
    }
    temporaries.length = held;
    if (completion) throw completion;
    return result as T;
  }

  /** Records a value a `using` declaration declares in the current scope, which disposes of it when it ends. */
  protected addDisposable(value: Value, kind: DeclarationKind): void {
    const { runtime } = this;
    const isAsync = kind === 'await using';
    const scope = runtime.frame.scope;
    scope.disposables ??= [];
    // An `await using` of null or undefined still awaits when its scope ends.
    if (value === null || value === undefined) {
      if (isAsync) scope.disposables.push({ value, method: undefined, isAsync, awaitsResult: false });
      return;
    }
    if (!isObject(value)) runtime.throwError('TypeError', 'An object is expected with `using` declarations');
    const asyncMethod = isAsync ? runtime.get(value, WELL_KNOWN_SYMBOLS.asyncDispose) : undefined;
    const method = asyncMethod ?? runtime.get(value, WELL_KNOWN_SYMBOLS.dispose);
    if (!isCallable(method)) {
      const key = isAsync ? WELL_KNOWN_SYMBOLS.asyncDispose : WELL_KNOWN_SYMBOLS.dispose;
      return runtime.throwError('TypeError', `${key.toString()} is not a function`);
    }
    scope.disposables.push({ value, method, isAsync, awaitsResult: asyncMethod !== undefined && asyncMethod !== null });
  }

  /** Keeps `value` reachable for garbage collection while `run` computes with it. */
  private *holdingValue<T>(value: Value, run: () => Steps<T>): Steps<T> {
    const { temporaries } = this.runtime.frame;
    temporaries.push(value);
    try {
      return yield* run();
    } finally {
      temporaries.pop();
    }
  }

  private blockSteps(block: Block): Steps<Completion> {
    return this.scopedSteps(block.scope, () => this.statementsSteps(block.body));
  }

  private *declarationSteps(declaration: VariableDeclaration): Steps<void> {
    for (const { target, init } of declaration.declarators) {
      if (init === undefined) {
        // `var x;` keeps the value x has, while `let x;` initializes it; either shows x from now on.
        if (declaration.declarationKind !== 'var') this.bindPattern(target, undefined, 'initialize');
        else if (target.kind === 'identifier') this.revealVar(target.name);
        continue;
      }
      this.bindDeclared(target, yield* this.valueSteps(init), declaration.declarationKind);
    }
  }

  /** Initializes the variables a declaration declares, recording the value of a `using` one for disposal. */
  protected bindDeclared(target: Pattern, value: Value, kind: DeclarationKind): void {
    // A `using` declaration gets its value's disposal method while its variable is still uninitialized.
    if (kind === 'using' || kind === 'await using') this.addDisposable(value, kind);
    this.bindPattern(target, value, 'initialize');
  }

  /** Runs a loop body, returning `'next'` to continue the loop or the completion that ends it. */
  private *loopBodySteps(body: Statement, labels: string[]): Steps<'next' | Completion> {
    const completion = yield* this.statementSteps(body, []);
    if (!completion) return 'next';
    if (completion.kind === 'return') return completion;
    const isOwn = completion.label === undefined || labels.includes(completion.label);
    if (!isOwn) return completion;
    return completion.kind === 'continue' ? 'next' : undefined;
  }

  private forStatementSteps(statement: Extract<Statement, { kind: 'for' }>, labels: string[]): Steps<Completion> {
    const { runtime } = this;
    return this.scopedSteps(
      statement.scope,
      function* (this: SuspendableStatementEvaluator): Steps<Completion> {
        const { update, stepRow, perIterationNames } = statement;
        yield* this.forInitSteps(statement);
        const frame = runtime.frame;
        const outer = frame.scope;
        try {
          this.copyIterationScope(perIterationNames);
          for (;;) {
            if (statement.test && !toBoolean(yield* this.valueSteps(statement.test))) return;
            const result = yield* this.loopBodySteps(statement.body, labels);
            if (result !== 'next') return result;
            this.copyIterationScope(perIterationNames);
            if (update) {
              yield* this.valueSteps(update);
              runtime.steps.step(stepRow);
            }
            runtime.spend();
          }
        } finally {
          frame.scope = outer;
        }
      }.bind(this)
    );
  }

  /** Runs the init of a `for` header, which records the header's step when it assigns something. */
  private *forInitSteps({ init, stepRow }: Extract<Statement, { kind: 'for' }>): Steps<void> {
    if (init?.kind === 'declaration') {
      yield* this.declarationSteps(init);
      if (init.declarators.some((declarator) => declarator.init)) this.runtime.steps.step(stepRow);
    } else if (init) {
      yield* this.valueSteps(init);
      this.runtime.steps.step(stepRow);
    }
  }

  /** Gives the next iteration its own copy of the `let` variables, which closures created in an iteration keep. */
  protected copyIterationScope(names: string[]): void {
    if (names.length === 0) return;
    const frame = this.runtime.frame;
    const current = frame.scope;
    const next = new Scope(current.parent);
    for (const name of names) next.bindings.set(name, { ...(current.bindings.get(name) as Binding) });
    frame.scope = next;
  }

  private *forEachStatementSteps(
    statement: Extract<Statement, { kind: 'forOf' | 'forIn' }>,
    labels: string[]
  ): Steps<Completion> {
    const { runtime } = this;
    // The loop's let or const names are uninitialized while the iterable is evaluated, so `for (let x of x)` throws.
    const iterable =
      statement.declarationKind && statement.declarationKind !== 'var'
        ? yield* this.scopedSteps(statement.scope, () => this.valueSteps(statement.iterable))
        : yield* this.valueSteps(statement.iterable);
    const iterator: LoopIterator =
      statement.kind === 'forIn'
        ? syncLoopIterator(new ValueIterator(this.enumerableKeys(iterable)))
        : statement.isAwait
          ? new AwaitingIterator(runtime, asyncIteratorOf(runtime, iterable))
          : syncLoopIterator(runtime.iterator(iterable));
    return yield* this.holdingValue(iterable, () => this.forEachIterationsSteps(statement, labels, iterator));
  }

  private *forEachIterationsSteps(
    statement: Extract<Statement, { kind: 'forOf' | 'forIn' }>,
    labels: string[],
    iterator: LoopIterator
  ): Steps<Completion> {
    const { runtime } = this;
    const frame = runtime.frame;
    let isExhausted = false;
    let completion: 'normal' | 'throw' = 'normal';
    let pending: Value;
    try {
      for (;;) {
        const value = yield* iterator.next();
        if (value === DONE) {
          isExhausted = true;
          return;
        }
        runtime.spend();
        const outer = frame.scope;
        try {
          const { declarationKind } = statement;
          if (declarationKind && declarationKind !== 'var') {
            frame.scope = new Scope(outer);
            this.instantiate(frame.scope, statement.scope);
          }
          const iteration = (): Steps<'next' | Completion> => {
            if (declarationKind) this.bindDeclared(statement.target, value, declarationKind);
            else this.bindPattern(statement.target, value, 'assign');
            this.stepBinding(statement, value);
            return this.loopBodySteps(statement.body, labels);
          };
          const result = yield* statement.scope.disposes ? this.disposingSteps(iteration) : iteration();
          if (result !== 'next') {
            pending = pendingValue(result);
            return result;
          }
        } finally {
          frame.scope = outer;
        }
      }
    } catch (error) {
      if (error instanceof JsThrow) {
        completion = 'throw';
        pending = error.value;
      }
      throw error;
    } finally {
      // Leaving the loop early closes the iterator, which runs a generator's `finally` blocks, while the value the loop
      // returns or throws stays reachable.
      if (!isExhausted) yield* this.holdingValue(pending, () => iterator.close(completion));
    }
  }

  /** The keys `for...in` visits: enumerable string keys of the object and its prototypes, each once. */
  protected enumerableKeys(value: Value): string[] {
    const { runtime } = this;
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') return Array.from({ length: value.length }, (_, index) => String(index));
    if (!isObject(value)) return [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (let current: JsObject | null = value; current; current = current.proto) {
      for (const key of runtime.ownKeys(current)) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (runtime.getOwnProperty(current, key)?.enumerable) keys.push(key);
      }
    }
    return keys;
  }

  private *switchStatementSteps(statement: Extract<Statement, { kind: 'switch' }>): Steps<Completion> {
    const discriminant = yield* this.valueSteps(statement.discriminant);
    return yield* this.holdingValue(discriminant, () =>
      this.scopedSteps(
        statement.scope,
        function* (this: SuspendableStatementEvaluator): Steps<Completion> {
          const { cases } = statement;
          for (const switchCase of cases.slice(yield* this.matchingCaseSteps(statement, discriminant))) {
            const completion = yield* this.statementsSteps(switchCase.body);
            if (completion?.kind === 'break' && completion.label === undefined) return;
            if (completion) return completion;
          }
          return;
        }.bind(this)
      )
    );
  }

  /** The index of the case to start from: the first whose value is strictly equal, else the default, else none. */
  private *matchingCaseSteps({ cases }: Extract<Statement, { kind: 'switch' }>, discriminant: Value): Steps<number> {
    for (const [index, switchCase] of cases.entries()) {
      if (switchCase.test !== undefined && (yield* this.valueSteps(switchCase.test)) === discriminant) return index;
    }
    const defaultIndex = cases.findIndex((switchCase) => switchCase.test === undefined);
    return defaultIndex === -1 ? cases.length : defaultIndex;
  }

  private *tryStatementSteps(statement: Extract<Statement, { kind: 'try' }>): Steps<Completion> {
    const { handler, finalizer } = statement;
    let outcome = yield* this.catchThrowSteps(() => this.blockSteps(statement.block));
    if (outcome.thrown && handler) {
      const { value } = outcome.thrown;
      outcome = yield* this.catchThrowSteps(() =>
        this.scopedSteps(handler.scope, () => {
          if (handler.param) this.bindPattern(handler.param, value, 'initialize');
          return this.blockSteps(handler.body);
        })
      );
    }
    if (finalizer) {
      // The exception or the return value that the finalizer delays must keep its turtles alive meanwhile.
      const delayed = outcome.thrown
        ? outcome.thrown.value
        : outcome.completion?.kind === 'return'
          ? outcome.completion.value
          : undefined;
      const finalCompletion = yield* this.holdingValue(delayed, () => this.blockSteps(finalizer));
      if (finalCompletion) return finalCompletion;
    }
    if (outcome.thrown) throw outcome.thrown;
    return outcome.completion;
  }

  /**
   * Runs `run`, catching the JavaScript exception it throws; limits and host errors still propagate. A generator's
   * `return()` resuming it inside `run` completes it as a `return` statement would, so that finalizers run.
   */
  private *catchThrowSteps(run: () => Steps<Completion>): Steps<{ completion?: Completion; thrown?: JsThrow }> {
    try {
      return { completion: yield* run() };
    } catch (error) {
      if (error instanceof GeneratorReturn) return { completion: { kind: 'return', value: error.value } };
      if (!(error instanceof JsThrow)) throw error;
      return { thrown: error };
    }
  }
}

function syncLoopIterator(iterator: ValueIterator): LoopIterator {
  return {
    // oxlint-disable-next-line require-yield -- A sync iterator steps without suspending the loop.
    *next() {
      return iterator.next();
    },
    // oxlint-disable-next-line require-yield -- A sync iterator closes without suspending the loop.
    *close(completion) {
      iterator.close(completion);
    },
  };
}

/** The error that a disposal throws over an earlier one, which it suppresses. */
export function suppressedError(runtime: Runtime, error: Value, suppressed: Value): JsObject {
  const object = runtime.newError('SuppressedError', 'An error was suppressed during disposal');
  for (const [key, value] of [
    ['error', error],
    ['suppressed', suppressed],
  ] as const) {
    runtime.defineProperty(object, key, { value, writable: true, enumerable: false, configurable: true });
  }
  return object;
}

/** The value a completing scope or loop returns or throws, which must stay reachable while cleanup code runs. */
export function pendingValue(result: Outcome, thrown?: { value: Value }): Value {
  if (thrown) return thrown.value;
  return isCompletion(result) && result.kind === 'return' ? result.value : undefined;
}

function isCompletion(value: Outcome): value is Exclude<Completion, undefined> {
  return typeof value === 'object' && value !== null && !(value instanceof JsObject) && 'kind' in value;
}
