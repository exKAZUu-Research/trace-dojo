import type { Comprehension, Expression, Statement } from './ast';
import { asyncIterator, asyncYield, awaitValue, isStopAsyncIteration, nextAwaitable } from './coroutines';
import type { Frame } from './frame';
import { bindValue, callValue, isTruthy, iterate, lookupSpecial, type NextFunction } from './objects';
import { SuspendingEvaluator, type Suspension } from './suspendingEvaluator';
import { asyncGeneratorClass, classOf, fullyQualifiedName, newDict, newList, newSet, None, typeError } from './types';
import { DONE, PyError, PyGenerator, type PyInstance, PyList, type PyValue } from './values';

type ComprehensionExpression = Extract<Expression, { kind: 'comprehension' }>;
type Completion = undefined | 'break' | 'continue' | { value: PyValue };
type Execution = Generator<PyValue, Completion, PyValue>;

/** Where a clause of a comprehension takes its items from: an iterator, or an async iterator it awaits. */
type Source = { next: NextFunction } | { asyncIterator: PyValue };

/** Evaluates what coroutines add to generators: `async for`, `async with`, and comprehensions that await. */
export abstract class AsyncEvaluator extends SuspendingEvaluator {
  abstract block(statements: Statement[], frame: Frame): Execution;
  abstract attachHandling(exceptions: PyInstance[]): number;
  abstract detachHandling(depth: number): PyInstance[];

  // Statements --------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 19 -- Follows the protocol of the async for loop, finalizing an async generator it leaves.
  // code-gauge-allow functionNcss 32 -- Follows the protocol of the async for loop.
  /** `async for`: awaits the async iterator's `__anext__` for each item until it raises StopAsyncIteration. */
  protected *asyncForStatement(statement: Extract<Statement, { kind: 'for' }>, frame: Frame): Execution {
    const { runtime } = this;
    const iterable = statement.iterable.suspends
      ? yield* this.evaluateSuspending(statement.iterable, frame)
      : this.evaluate(statement.iterable, frame);
    const iterator = asyncIterator(iterable);
    const length = frame.temporaries.length;
    frame.temporaries.push(iterator);
    // What leaves the loop along with control, which stays alive when the loop's async generator is finalized.
    let leaving: unknown;
    try {
      for (;;) {
        let item: PyValue;
        try {
          item = yield* awaitValue(nextAwaitable(iterator), frame, statement.row);
        } catch (error) {
          if (isStopAsyncIteration(error)) break;
          throw error;
        }
        runtime.spend();
        runtime.currentRow = statement.row;
        yield* this.assignSuspending(statement.target, item, frame);
        runtime.steps.step(statement.stepRow);
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
      runtime.finalizer.release([iterator], [leaving]);
    }
    return yield* this.block(statement.orelse, frame);
  }

  /** `async with`: awaits the manager's `__aenter__` before the body and its `__aexit__` after it. */
  // code-gauge-allow functionNcss 42 -- Follows the protocol of the async with statement.
  protected *asyncWithStatement(
    statement: Extract<Statement, { kind: 'with' }>,
    frame: Frame,
    index: number
  ): Execution {
    if (index >= statement.items.length) return yield* this.block(statement.body, frame);
    const item = statement.items[index];
    const manager = item.context.suspends
      ? yield* this.evaluateSuspending(item.context, frame)
      : this.evaluate(item.context, frame);
    const exit = lookupSpecial(manager, '__aexit__');
    const enter = lookupSpecial(manager, '__aenter__');
    if (exit === undefined || enter === undefined) {
      const missed = exit === undefined ? '__aexit__' : '__aenter__';
      throw typeError(
        `'${fullyQualifiedName(classOf(manager))}' object does not support the asynchronous context manager protocol (missed ${missed} method)`
      );
    }
    const length = frame.temporaries.length;
    frame.temporaries.push(manager);
    try {
      let entered = false;
      let completion: Completion;
      try {
        const value = yield* awaitValue(callValue(bindValue(enter, manager), []), frame, statement.row);
        entered = true;
        if (index === 0) this.runtime.steps.step(statement.stepRow);
        if (item.target) yield* this.assignSuspending(item.target, value, frame);
        completion = yield* this.asyncWithStatement(statement, frame, index + 1);
      } catch (error) {
        if (!(error instanceof PyError) || !entered) throw error;
        this.runtime.currentRow = statement.row;
        const { exception } = error;
        const depth = this.attachHandling([exception]);
        let suppress: boolean;
        try {
          const exited = callValue(bindValue(exit, manager), [exception.cls, exception, None]);
          suppress = isTruthy(yield* awaitValue(exited, frame, statement.row));
        } finally {
          this.detachHandling(depth);
        }
        if (!suppress) throw error;
        return undefined;
      }
      this.runtime.currentRow = statement.row;
      if (typeof completion === 'object') frame.temporaries.push(completion.value);
      yield* awaitValue(callValue(bindValue(exit, manager), [None, None, None]), frame, statement.row);
      return completion;
    } finally {
      frame.temporaries.length = length;
    }
  }

  // Comprehensions ----------------------------------------------------------------------------------------------------

  protected override comprehension(
    expression: ComprehensionExpression,
    frame: Frame,
    firstIterable?: PyValue
  ): PyValue {
    if (expression.type !== 'generator' || !expression.scope.isAsync)
      return super.comprehension(expression, frame, firstIterable);
    const first = firstIterable ?? this.evaluateIterable(expression.generators[0].iterable, frame);
    const inner = this.comprehensionFrame(expression, frame, first);
    const source = this.sourceOf(expression.generators[0], first);
    const body = this.comprehensionLevel(expression, inner, 0, source, function* (value) {
      yield asyncYield(value);
    });
    const { runtime } = this;
    return new PyGenerator(
      asyncGeneratorClass,
      '<genexpr>',
      expression.qualifiedName ?? '<genexpr>',
      (input) => {
        runtime.pushFrame(inner);
        try {
          return input.error ? body.throw(input.error) : body.next(input.value);
        } finally {
          runtime.popFrame();
        }
      },
      () => [first, ...inner.locals.values(), ...inner.temporaries]
    );
  }

  /** Runs a list, set, or dict comprehension that awaits, in its own frame on top of the coroutine's. */
  protected *asyncComprehension(expression: ComprehensionExpression, frame: Frame, first: PyValue): Suspension {
    const inner = this.comprehensionFrame(expression, frame);
    inner.temporaries.push(first);
    const source = this.sourceOf(expression.generators[0], first);
    const container = expression.type === 'dict' ? newDict() : expression.type === 'list' ? newList([]) : newSet();
    inner.temporaries.push(container);
    const store = function* (this: AsyncEvaluator, value: PyValue): Suspension<void> {
      if (container instanceof PyList) container.append(value);
      else if (expression.type === 'dict') {
        const dict = container as ReturnType<typeof newDict>;
        dict.store.set(value, yield* this.evaluateSuspending(expression.value as Expression, inner));
      } else (container as ReturnType<typeof newSet>).table.add(value);
    };
    yield* this.inFrame(inner, this.comprehensionLevel(expression, inner, 0, source, store.bind(this)));
    return container;
  }

  /** Runs `run` with `frame` on top of the stack, taking it off while `run` is suspended. */
  private *inFrame<T>(frame: Frame, run: Suspension<T>): Suspension<T> {
    const { runtime } = this;
    let input: { value: PyValue } | { error: unknown } = { value: None };
    for (;;) {
      runtime.pushFrame(frame);
      let step: IteratorResult<PyValue, T>;
      try {
        step = 'error' in input ? run.throw(input.error) : run.next(input.value);
      } finally {
        runtime.popFrame();
      }
      if (step.done) return step.value;
      try {
        input = { value: yield step.value };
      } catch (error) {
        input = { error };
      }
    }
  }

  private sourceOf(generator: Comprehension, iterable: PyValue): Source {
    return generator.isAsync ? { asyncIterator: asyncIterator(iterable) } : { next: iterate(iterable) };
  }

  /** Runs the clauses of a comprehension from the one at `index`, passing each element to `emit`. */
  // code-gauge-allow functionCognitiveComplexity 22 -- Follows how a comprehension runs its clauses, each sync or async.
  // code-gauge-allow functionNcss 32 -- Follows how a comprehension runs its clauses, each sync or async.
  private *comprehensionLevel(
    expression: ComprehensionExpression,
    frame: Frame,
    index: number,
    source: Source,
    emit: (value: PyValue) => Suspension<void>
  ): Suspension<PyValue> {
    const { generators } = expression;
    const { runtime } = this;
    const generator = generators[index];
    for (;;) {
      let item: PyValue | typeof DONE;
      if ('next' in source) item = source.next();
      else {
        try {
          item = yield* awaitValue(nextAwaitable(source.asyncIterator), frame, expression.row);
        } catch (error) {
          if (isStopAsyncIteration(error)) break;
          throw error;
        }
      }
      if (item === DONE) break;
      runtime.spend();
      yield* this.assignSuspending(generator.target, item, frame);
      let passes = true;
      for (const condition of generator.conditions) {
        if (!isTruthy(yield* this.evaluateSuspending(condition, frame))) {
          passes = false;
          break;
        }
      }
      if (!passes) continue;
      if (index + 1 < generators.length) {
        const next = generators[index + 1];
        const iterable = yield* this.evaluateSuspending(next.iterable, frame);
        yield* this.holding(
          frame,
          iterable,
          this.comprehensionLevel(expression, frame, index + 1, this.sourceOf(next, iterable), emit)
        );
        continue;
      }
      yield* emit(yield* this.evaluateSuspending(expression.element, frame));
    }
    return None;
  }
}
