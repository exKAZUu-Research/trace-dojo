import { CompileError } from '../interpreter/diagnostics';
import type { BoundArgument, BoundBlock, BoundExpression, BoundLValue } from './bound';
import { IteratorExecutor, type Steps, type Suspension } from './iterators';
import type { PendingException } from './numeric';
import type { CsThrow, Frame } from './runtime';
import { taskObject, type TaskState, UnhandledAsyncException } from './tasks';
import { type AsyncShape, type MethodSymbol, type NamedType } from './types';
import { Cell, copyValue, CsObject, CsStruct, UNASSIGNED, type Value } from './values';

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
      case 'with':
      case 'new': {
        if (
          expression.kind === 'with'
            ? hasSuspension(expression.assignments)
            : expression.initializer?.some((entry) => hasSuspension(entry))
        )
          throw new CompileError([
            { row: expression.row, message: 'オブジェクト初期化子の中の `await`は、この採点環境では使えません。' },
          ]);
        return yield* this.operandsFirstSteps(expression, frame);
      }
      default: {
        return yield* this.operandsFirstSteps(expression, frame);
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

  /** `await`: an awaiter that is not completed suspends the body until its task is done, then gives its result. */
  private *awaitSteps(expression: Extract<BoundExpression, { kind: 'await' }>, frame: Frame): Steps<Value> {
    const awaitable = yield* this.evaluateSteps(expression.operand, frame);
    const awaiter = this.withOperand(frame, awaitable, () => this.evaluate(expression.getAwaiter, frame));
    const isCompleted = this.withOperand(frame, awaiter, () => this.evaluate(expression.isCompleted, frame));
    if (!isCompleted) yield { awaiting: awaitedTask(awaiter) };
    return this.withOperand(frame, awaiter, () => this.evaluate(expression.getResult, frame));
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
      state.fault([thrown]);
      return;
    }
    if (result.done) {
      const completion = result.value as { value?: Value } | undefined;
      state.complete(
        completion && typeof completion === 'object' && 'value' in completion ? completion.value : undefined
      );
      return;
    }
    const { awaiting } = result.value as { awaiting: TaskState | 'yield' };
    const resume = (): void => this.advanceAsync(state, frame, steps, shape);
    if (awaiting === 'yield') this.runtime.scheduler.queue(resume);
    else awaiting.whenDone(resume);
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

  /** The first exception of a faulted task, which `await` and `GetResult` throw. */
  firstException(state: TaskState): CsThrow {
    return state.exceptions[0];
  }
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
