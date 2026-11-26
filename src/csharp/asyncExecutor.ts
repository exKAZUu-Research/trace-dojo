import { CompileError } from '../interpreter/diagnostics';
import type { BoundArgument, BoundBlock, BoundExpression, BoundInitializerEntry, BoundLValue } from './bound';
import { NULL_REFERENCE } from './evaluatorBase';
import {
  type Awaiting,
  IteratorExecutor,
  type IteratorState,
  type PendingAwaiter,
  type Steps,
  type Suspension,
} from './iterators';
import type { PendingException } from './numeric';
import type { Frame } from './runtime';
import { cancellationTokenOf, isCancellationException, taskObject, TaskState, UnhandledAsyncException } from './tasks';
import { type AsyncShape, type MethodSymbol, type NamedType, namedType } from './types';
import {
  Cell,
  copyValue,
  CsBox,
  CsDelegate,
  CsObject,
  CsStruct,
  type DelegateEntry,
  UNASSIGNED,
  type Value,
} from './values';

/**
 * Runs async functions (C# spec §15.14): a call runs the body until its first `await` of an unfinished task, then
 * returns its task, and the body goes on when that task is done, on the scheduler's one thread. An expression with an
 * `await` inside evaluates its operands in order first, suspending at the `await`, and then itself as any expression
 * does, taking the operands' values from its frame's memo; `&&`, `||`, `?:`, `??`, and `?.` keep their order of
 * evaluation explicitly.
 */
export abstract class AsyncExecutor extends IteratorExecutor {
  /** The exception of a switch expression that no arm matches, which the evaluator provides. */
  protected abstract unmatched(
    expression: Extract<BoundExpression, { kind: 'switch' }>,
    value: Value,
    frame: Frame
  ): PendingException;

  protected override *valueSteps(expression: BoundExpression, frame: Frame): Steps<Value> {
    return yield* this.evaluateSteps(expression, frame);
  }

  // code-gauge-allow functionNcss -- One case per kind of expression that orders its operands itself.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  *evaluateSteps(expression: BoundExpression, frame: Frame): Steps<Value> {
    if (!expression.suspends) return this.evaluate(expression, frame);
    switch (expression.kind) {
      case 'await': {
        return yield* this.awaitSteps(expression, frame);
      }
      case 'logical': {
        const left = (yield* this.evaluateSteps(expression.left, frame)) as boolean;
        if (expression.operator === '&&' ? !left : left) return left;
        return yield* this.evaluateSteps(expression.right, frame);
      }
      case 'conditional': {
        return (yield* this.evaluateSteps(expression.condition, frame))
          ? yield* this.evaluateSteps(expression.whenTrue, frame)
          : yield* this.evaluateSteps(expression.whenFalse, frame);
      }
      case 'coalesce': {
        const left = yield* this.evaluateSteps(expression.left, frame);
        if (left === undefined) return yield* this.evaluateSteps(expression.right, frame);
        const { leftConversion } = expression;
        return leftConversion ? this.withOperand(frame, left, () => this.evaluate(leftConversion, frame)) : left;
      }
      case 'conditionalAccess': {
        const receiver = yield* this.evaluateSteps(expression.receiver, frame);
        if (receiver === undefined) return undefined;
        this.storeLocal(frame, expression.temporary, receiver);
        return yield* this.evaluateSteps(expression.access, frame);
      }
      case 'switch': {
        return yield* this.switchExpressionSteps(expression, frame);
      }
      case 'compoundAssign': {
        return yield* this.compoundAssignSteps(expression, frame);
      }
      case 'with': {
        if (hasSuspension(expression.assignments))
          throw new CompileError([
            { row: expression.row, message: 'オブジェクト初期化子の中の `await`は、この採点環境では使えません。' },
          ]);
        return yield* this.operandsFirstSteps(expression, frame);
      }
      case 'new': {
        const { initializer } = expression;
        if (!initializer?.some((entry) => hasSuspension(entry)))
          return yield* this.operandsFirstSteps(expression, frame);
        // The object comes first, with its constructor's arguments, and then each entry of its initializer in order.
        const created = yield* this.operandsFirstSteps({ ...expression, initializer: undefined }, frame);
        frame.temporaries.push(created);
        frame.operands.push(created);
        try {
          yield* this.initializeSteps(initializer, frame);
        } finally {
          frame.operands.pop();
          frame.temporaries.pop();
        }
        return created;
      }
      default: {
        return yield* this.operandsFirstSteps(expression, frame);
      }
    }
  }

  /** Runs an object or collection initializer's entries, whose object is the frame's operand, as `initialize` does. */
  protected abstract initialize(entries: BoundInitializerEntry[], frame: Frame): void;

  /** The entries of an initializer with an `await` among them, each in order as {@link initialize} runs it. */
  private *initializeSteps(entries: BoundInitializerEntry[], frame: Frame): Steps<void> {
    for (const entry of entries) {
      if (!hasSuspension(entry)) {
        this.initialize([entry], frame);
      } else if (entry.kind === 'collectionAdd') {
        yield* this.evaluateSteps(entry.call, frame);
      } else if (entry.nested) {
        const nested = this.place(entry.target, frame).get();
        frame.operands.push(nested);
        try {
          yield* this.initializeSteps(entry.nested, frame);
        } finally {
          frame.operands.pop();
        }
      } else {
        // `[i] = await v` evaluates the index before the value, and then assigns the element.
        const operands = variableOperands(entry.target);
        const memo = (frame.memo ??= new Map());
        for (const operand of operands) memo.set(operand, yield* this.evaluateSteps(operand, frame));
        try {
          const value = yield* this.evaluateSteps(entry.value as BoundExpression, frame);
          this.place(entry.target, frame).set(copyValue(value));
        } finally {
          for (const operand of operands) frame.memo?.delete(operand);
        }
      }
    }
  }

  /**
   * `x op= await y`: the target's storage and value come first, then the operation, which reads the value as its
   * operand, may suspend, as the evaluator does it without one.
   */
  private *compoundAssignSteps(
    expression: Extract<BoundExpression, { kind: 'compoundAssign' }>,
    frame: Frame
  ): Steps<Value> {
    const operands = operandsOf(expression);
    const memo = (frame.memo ??= new Map());
    for (const operand of operands) memo.set(operand, yield* this.evaluateSteps(operand, frame));
    let place: ReturnType<AsyncExecutor['place']>;
    try {
      place = this.place(expression.target, frame);
    } finally {
      for (const operand of operands) frame.memo?.delete(operand);
    }
    const current = place.get();
    frame.operands.push(current);
    let value: Value;
    try {
      value = yield* this.evaluateSteps(expression.operation, frame);
    } finally {
      frame.operands.pop();
    }
    if (expression.operation.kind !== 'coalesce' || current === undefined) place.set(copyValue(value));
    return value;
  }

  /** A switch expression whose arms' guards or values await, as {@link evaluateSwitch} evaluates one. */
  private *switchExpressionSteps(expression: Extract<BoundExpression, { kind: 'switch' }>, frame: Frame): Steps<Value> {
    const value = yield* this.evaluateSteps(expression.value, frame);
    for (const arm of expression.arms) {
      for (const local of arm.locals) frame.slots[local.slot] = local.isCaptured ? new Cell(UNASSIGNED) : UNASSIGNED;
      try {
        if (!this.matches(arm.pattern, value, frame)) continue;
        if (arm.guard && !((yield* this.evaluateSteps(arm.guard, frame)) as boolean)) continue;
        return yield* this.evaluateSteps(arm.value, frame);
      } finally {
        for (const local of arm.locals) frame.slots[local.slot] = UNASSIGNED;
      }
    }
    throw this.unmatched(expression, value, frame);
  }

  /** Evaluates an expression's operands in order, suspending where they do, and then the expression with their values. */
  private *operandsFirstSteps(expression: BoundExpression, frame: Frame): Steps<Value> {
    const operands = operandsOf(expression);
    frame.memo ??= new Map();
    try {
      for (const operand of operands) {
        const value = yield* this.evaluateSteps(operand, frame);
        (frame.memo ??= new Map()).set(operand, value);
      }
      return this.evaluate(expression, frame);
    } finally {
      // An operand that the expression did not take, as when an earlier one threw, must not stand for a later run.
      for (const operand of operands) frame.memo?.delete(operand);
    }
  }

  /**
   * `await`: an awaiter that is not completed suspends the body until it is done, then gives its result. The
   * library's awaiters wait for their tasks; a program's awaiter is handed the continuation once the body has left
   * its frame, so that its `OnCompleted` may resume the body before it returns, as .NET's state machine allows.
   */
  private *awaitSteps(expression: Extract<BoundExpression, { kind: 'await' }>, frame: Frame): Steps<Value> {
    const awaitable = yield* this.evaluateSteps(expression.operand, frame);
    const awaiter = this.withOperand(frame, awaitable, () => this.evaluate(expression.getAwaiter, frame));
    const isCompleted = this.withOperand(frame, awaiter, () => this.evaluate(expression.isCompleted, frame));
    if (!isCompleted) yield { awaiting: this.awaitingOf(awaiter, expression.row) };
    return this.withOperand(frame, awaiter, () => this.evaluate(expression.getResult, frame));
  }

  /**
   * What an awaiter that is not completed waits for. A program's awaiter takes the continuation through
   * ICriticalNotifyCompletion when its runtime type implements it, as the state machine prefers, and otherwise through
   * INotifyCompletion, which a `dynamic` awaiter that implements neither fails to convert to; a struct awaiter takes
   * it on a copy, as the state machine keeps the awaiter apart from the one whose `GetResult` it calls.
   */
  private awaitingOf(awaiter: Value, row: number): Awaiting {
    const unboxed = awaiter instanceof CsBox ? awaiter.value : awaiter;
    if (unboxed instanceof CsStruct && unboxed.type.symbol.isLibrary) return awaitedTask(unboxed);
    const interfaceType = (name: string): NamedType =>
      namedType(this.runtime.library.typeNamed(`System.Runtime.CompilerServices.${name}`));
    const notify = interfaceType('INotifyCompletion');
    const target = copyValue(this.unbox(awaiter, notify));
    const critical = interfaceType('ICriticalNotifyCompletion');
    const [owner, name] = this.isInstanceOf(target, critical)
      ? [critical, 'UnsafeOnCompleted']
      : [notify, 'OnCompleted'];
    const onCompleted = owner.symbol.methods.find((method) => method.name === name) as MethodSymbol;
    return { awaiter: target, onCompleted, row };
  }

  /**
   * Starts an async function's body, which runs until it first suspends, and returns what the caller gets: the task
   * that its end completes, a `ValueTask` of it, or nothing for `async void`.
   */
  startAsync(method: MethodSymbol, frame: Frame): Value {
    const shape = method.async as AsyncShape;
    const state = this.runtime.scheduler.newTask();
    const steps = this.executeBlockSteps(method.body as BoundBlock, frame, true);
    this.advanceAsync(state, frame, steps, shape);
    const returnType = frame.resolve(method.returnType);
    if (shape.kind === 'void') return undefined;
    if (shape.kind === 'valueTask') {
      const taskType = this.taskType(returnType as NamedType);
      return new CsStruct(returnType as NamedType, [taskObject(taskType, state)]);
    }
    return taskObject(returnType as NamedType, state);
  }

  /** The `Task` or `Task<T>` that a `ValueTask` or `ValueTask<T>` wraps. */
  private taskType(valueTask: NamedType): NamedType {
    const task = this.runtime.library.typeNamed('System.Threading.Tasks.Task', valueTask.args.length);
    return { kind: 'named', symbol: task, args: valueTask.args };
  }

  /** Runs an async body until it suspends or ends, settling its task when it ends. */
  private advanceAsync(state: TaskState, frame: Frame, steps: Steps<unknown>, shape: AsyncShape): void {
    let result: IteratorResult<Suspension, unknown>;
    try {
      result = this.resumeBody(frame, steps);
    } catch (error) {
      const thrown = this.asThrow(error);
      if (!thrown) throw error;
      // An exception that leaves an `async void` method reaches no caller, so the process ends with it.
      if (shape.kind === 'void') throw new UnhandledAsyncException(thrown);
      // An OperationCanceledException cancels the method's task, whose `await` rethrows it.
      if (isCancellationException(thrown.exception)) state.cancel(cancellationTokenOf(thrown.exception), thrown);
      else state.fault([thrown]);
      return;
    }
    if (result.done) {
      const completion = result.value as { value?: Value } | undefined;
      state.complete(
        completion && typeof completion === 'object' && 'value' in completion ? completion.value : undefined
      );
      return;
    }
    const { awaiting } = result.value as { awaiting: Awaiting };
    const resume = (): void => this.advanceAsync(state, frame, steps, shape);
    this.resumeAfter(awaiting, frame, resume, () => methodPhase(state, frame));
  }

  /** Runs `resume` when what an `await` waits for is done. */
  private resumeAfter(awaiting: Awaiting, frame: Frame, resume: () => void, phase: () => BodyPhase): void {
    if (awaiting === 'yield') this.runtime.scheduler.queue(resume);
    else if (awaiting instanceof TaskState) awaiting.whenDone(resume);
    else this.notifyCompletion(awaiting, frame, resume, phase);
  }

  /**
   * Calls a program's awaiter's `OnCompleted` with the continuation, an Action that resumes the body wherever it is
   * suspended, as .NET's one continuation of a method does for each of its awaits. Invoked after the method ended, it
   * throws the NullReferenceException that .NET's does; invoked while the body is not suspended at an `await`, as while
   * it runs, where .NET would restart the body from its beginning, it is rejected. An exception that leaves `OnCompleted` reaches no caller, as .NET throws it on
   * the thread pool, and ends the process when the scheduler next runs.
   */
  private notifyCompletion(pending: PendingAwaiter, frame: Frame, resume: () => void, phase: () => BodyPhase): void {
    const native = (): Value => {
      const now = phase();
      if (now === 'done') throw NULL_REFERENCE();
      if (now === 'running')
        throw new CompileError([
          {
            row: pending.row,
            message: '`await` で止まっていない非同期メソッドの継続の呼び出しは、この採点環境では使えません。',
          },
        ]);
      resume();
      return undefined;
    };
    const actionType = namedType(this.runtime.library.typeNamed('System.Action'));
    const continuation = new CsDelegate(actionType, [
      { method: undefined, target: undefined, typeArgs: [], owner: undefined, isVirtual: false, native },
    ]);
    const onCompleted: DelegateEntry = {
      method: pending.onCompleted,
      target: pending.awaiter,
      typeArgs: [],
      owner: undefined,
      isVirtual: true,
    };
    // The call comes from the suspended method's frame, as .NET's comes from the state machine's MoveNext.
    this.runtime.pushFrame(frame);
    try {
      this.evaluator().invokeEntry(frame, onCompleted, [continuation], pending.row);
    } catch (error) {
      const thrown = this.asThrow(error);
      if (!thrown) throw error;
      this.runtime.scheduler.queue(() => {
        throw new UnhandledAsyncException(thrown, true);
      });
    } finally {
      this.runtime.popFrame();
    }
  }

  /**
   * `MoveNextAsync` of an async iterator: runs the body to its next `yield return`, whose value the returned task
   * completes with true, through the awaits on the way, or to its end, which completes it with false.
   */
  moveNextAsync(state: IteratorState): TaskState {
    const task = this.runtime.scheduler.newTask();
    if (state.status === 'after') task.complete(false);
    else {
      state.steps ??= this.executeBlockSteps(state.method.body as BoundBlock, state.frame, true);
      this.advanceAsyncIterator(state, task);
    }
    return task;
  }

  private advanceAsyncIterator(state: IteratorState, task: TaskState): void {
    let result: IteratorResult<Suspension, unknown>;
    state.status = 'running';
    try {
      result = this.resumeBody(state.frame, state.steps as Steps<unknown>);
    } catch (error) {
      state.status = 'after';
      const thrown = this.asThrow(error);
      if (!thrown) throw error;
      task.fault([thrown]);
      return;
    }
    if (result.done) {
      state.status = 'after';
      task.complete(false);
      return;
    }
    const suspension = result.value;
    if ('value' in suspension) {
      state.current = suspension.value;
      state.status = 'suspended';
      task.complete(true);
      return;
    }
    const resume = (): void => this.advanceAsyncIterator(state, task);
    this.resumeAfter(suspension.awaiting, state.frame, resume, () => {
      if (state.status === 'after') return 'done';
      return state.status === 'running' && state.frame.isSuspended ? 'awaiting' : 'running';
    });
  }

  /** `DisposeAsync` of an async iterator: runs the finally blocks around the `yield return` it is suspended at. */
  disposeAsyncIterator(state: IteratorState): TaskState {
    const task = this.runtime.scheduler.newTask();
    if (state.status !== 'suspended' || !state.steps) {
      if (state.status !== 'running') state.status = 'after';
      task.complete(undefined);
      return task;
    }
    const steps = state.steps;
    state.status = 'after';
    this.runtime.pushFrame(state.frame);
    try {
      steps.return(undefined);
    } finally {
      this.runtime.popFrame();
    }
    task.complete(undefined);
    return task;
  }

  /** Runs a suspended body's frame again until the body next suspends or ends. */
  protected resumeBody<T>(frame: Frame, steps: Steps<T>): IteratorResult<Suspension, T> {
    frame.isSuspended = false;
    this.runtime.pushFrame(frame);
    try {
      const result = steps.next();
      if (!result.done) frame.isSuspended = true;
      return result;
    } finally {
      this.runtime.popFrame();
    }
  }

  /** Blocks the running code until a task is done, as `Wait()` and `Result` do, running the other work meanwhile. */
  waitFor(state: TaskState): void {
    this.runtime.scheduler.runUntil(() => state.isDone);
  }
}

/** Where an async body is when its continuation is invoked: suspended at an `await`, running, or at its end. */
type BodyPhase = 'awaiting' | 'running' | 'done';

function methodPhase(state: TaskState, frame: Frame): BodyPhase {
  if (state.isDone) return 'done';
  return frame.isSuspended ? 'awaiting' : 'running';
}

/** The task that an awaiter of the library waits for, or Task.Yield's request to run the rest later. */
function awaitedTask(awaiter: Value): TaskState | 'yield' {
  const inner = awaiter instanceof CsStruct ? awaiter.fields[0] : undefined;
  if (inner instanceof CsObject) return inner.native as TaskState;
  return 'yield';
}

/** Whether a part of a bound tree suspends. */
function hasSuspension(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if ((node as { suspends?: true }).suspends) return true;
  if (Array.isArray(node)) return node.some(hasSuspension);
  if (Object.getPrototypeOf(node) !== Object.prototype) return false;
  return Object.entries(node).some(([key, value]) => key !== 'type' && hasSuspension(value));
}

/**
 * The operands an expression evaluates through `evaluate`, in the order it evaluates them, which an `await` among
 * them must keep. A variable's operands are those that finding its storage evaluates.
 */
// code-gauge-allow functionNcss -- One case per kind of expression.
function operandsOf(expression: BoundExpression): BoundExpression[] {
  switch (expression.kind) {
    case 'field': {
      return [expression.receiver];
    }
    case 'element': {
      return [expression.array, ...expression.indices];
    }
    case 'property': {
      return [...(expression.receiver ? [expression.receiver] : []), ...argumentOperands(expression.args)];
    }
    case 'call': {
      return [...(expression.receiver ? [expression.receiver] : []), ...argumentOperands(expression.args)];
    }
    case 'invokeDelegate': {
      return [expression.target, ...argumentOperands(expression.args)];
    }
    case 'new': {
      return argumentOperands(expression.args);
    }
    case 'late': {
      return argumentOperands(expression.operands);
    }
    case 'newArray': {
      return [...expression.sizes, ...(expression.elements ?? [])];
    }
    case 'newDelegate': {
      return expression.receiver ? [expression.receiver] : [];
    }
    case 'unary':
    case 'convert':
    case 'is':
    case 'as': {
      return [expression.operand];
    }
    case 'binary': {
      return [expression.left, expression.right];
    }
    case 'throw': {
      return [expression.value];
    }
    case 'tuple': {
      return expression.elements;
    }
    case 'concat': {
      return expression.parts;
    }
    case 'interpolated': {
      return expression.parts.flatMap((part) => (typeof part === 'string' ? [] : [part.value]));
    }
    case 'sequence': {
      return [...expression.sideEffects, expression.value];
    }
    case 'assign': {
      return [...variableOperands(expression.target), expression.value];
    }
    case 'compoundAssign':
    case 'increment': {
      return variableOperands(expression.target);
    }
    case 'deconstructAssign': {
      return [expression.value];
    }
    case 'eventAccessor': {
      return [...variableOperands(expression.target), expression.value];
    }
    case 'with': {
      return [expression.value];
    }
    case 'switch': {
      return [expression.value];
    }
    case 'implicitIndex': {
      return expression.setup;
    }
    default: {
      return [];
    }
  }
}

function argumentOperands(args: BoundArgument[]): BoundExpression[] {
  const order = (args as { sourceOrder?: readonly number[] }).sourceOrder;
  const ordered = order
    ? [...order.map((index) => args[index]), ...args.filter((_arg, index) => !order.includes(index))]
    : args;
  return ordered.flatMap((arg) => (arg.kind === 'refArgument' ? variableOperands(arg.target) : [arg]));
}

function variableOperands(target: BoundLValue): BoundExpression[] {
  switch (target.kind) {
    case 'field': {
      return [target.receiver];
    }
    case 'element': {
      return [target.array, ...target.indices];
    }
    case 'property': {
      return [...(target.receiver ? [target.receiver] : []), ...argumentOperands(target.args)];
    }
    case 'implicitIndex': {
      return target.setup;
    }
    default: {
      return [];
    }
  }
}
