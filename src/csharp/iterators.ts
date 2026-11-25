import type { BoundBlock, BoundCatch, BoundExpression, BoundStatement, BoundSwitchSection, LabelSymbol } from './bound';
import { NULL_REFERENCE } from './evaluatorBase';
import { PendingException } from './numeric';
import { type CsThrow, type Frame, ProgramExit } from './runtime';
import {
  BREAK,
  type Completion,
  GotoCompletion,
  labelIndexIn,
  loopOutcome,
  NEXT,
  StatementExecutor,
} from './statementExecutor';
import type { TaskState } from './tasks';
import type { LocalSymbol, MethodSymbol, Type } from './types';
import { Cell, copyValue, type CsObject, type CsStruct, UNASSIGNED, type Value } from './values';

/**
 * What a suspended body yields to its driver: the value of a `yield return`, or the task an `await` waits for, or
 * `Task.Yield()`'s request to run the rest later.
 */
export type Suspension = { value: Value } | { awaiting: TaskState | 'yield' };

/** The execution of code that may suspend at a `yield return` or an `await`, as a generator of its suspensions. */
export type Steps<T> = Generator<Suspension, T, undefined>;

/** The run of one iterator: its body's frame and generator, and where `MoveNext` has taken it. */
export interface IteratorState {
  method: MethodSymbol;
  frame: Frame;
  elementType: Type;
  steps: Steps<Completion> | undefined;
  status: 'before' | 'suspended' | 'running' | 'after';
  current: Value;
  /** Makes a fresh run for another `GetEnumerator` call of an enumerable, with the arguments the call gave. */
  restart: (() => IteratorState) | undefined;
  /** Whether an enumerable's own `GetEnumerator` has already handed out this run. */
  isTaken: boolean;
}

/**
 * Runs iterator bodies (C# spec §15.15): the statements with a `yield return` inside run as generators, which suspend
 * at each `yield return` with its value, and every other statement runs as {@link StatementExecutor.execute} runs it.
 * A suspended body keeps its frame, which each `MoveNext` pushes again while the body runs.
 */
export abstract class IteratorExecutor extends StatementExecutor {
  /** Moves an iterator to its next value, telling whether it has one. */
  moveIterator(state: IteratorState): boolean {
    if (state.status === 'after') return false;
    if (state.status === 'running')
      throw new PendingException(
        'System.InvalidOperationException',
        'Collection was modified; enumeration operation may not execute.'
      );
    const body = state.method.body as BoundBlock;
    state.steps ??= this.executeBlockSteps(body, state.frame, true);
    state.status = 'running';
    this.runtime.pushFrame(state.frame);
    try {
      const result = state.steps.next();
      if (result.done) {
        state.status = 'after';
        return false;
      }
      state.current = (result.value as { value: Value }).value;
      state.status = 'suspended';
      return true;
    } catch (error) {
      state.status = 'after';
      throw error;
    } finally {
      this.runtime.popFrame();
    }
  }

  /** Disposes an iterator, running the finally blocks around the `yield return` it is suspended at. */
  disposeIterator(state: IteratorState): void {
    if (state.status !== 'suspended' || !state.steps) {
      if (state.status !== 'running') state.status = 'after';
      return;
    }
    state.status = 'running';
    this.runtime.pushFrame(state.frame);
    try {
      state.steps.return(undefined);
    } finally {
      state.status = 'after';
      this.runtime.popFrame();
    }
  }

  /** Evaluates an expression of a suspending statement, which an `await` inside may suspend in async code. */
  // oxlint-disable-next-line require-yield -- An iterator's expressions never suspend; the async executor overrides this.
  protected *valueSteps(expression: BoundExpression, frame: Frame): Steps<Value> {
    return this.evaluate(expression, frame);
  }

  // code-gauge-allow functionNcss -- One case per kind of statement that may suspend.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  *executeSteps(statement: BoundStatement, frame: Frame): Steps<Completion> {
    if (!statement.suspends) return this.execute(statement, frame);
    this.runtime.spend();
    switch (statement.kind) {
      case 'yieldReturn': {
        const value = yield* this.stepSteps(statement.row, statement.step, this.valueSteps(statement.value, frame));
        yield { value };
        return undefined;
      }
      case 'expression': {
        yield* this.stepSteps(statement.row, statement.step, this.valueSteps(statement.expression, frame));
        return undefined;
      }
      case 'localDeclaration': {
        const { local, value } = statement;
        yield* this.stepSteps(
          statement.row,
          statement.step,
          this.declarationSteps(local, value as BoundExpression, frame)
        );
        return undefined;
      }
      case 'return': {
        return { value: statement.value ? copyValue(yield* this.valueSteps(statement.value, frame)) : undefined };
      }
      case 'throw': {
        throw this.throwValue(yield* this.valueSteps(statement.value as BoundExpression, frame));
      }
      case 'block': {
        if ((statement as { isDeclarationGroup?: boolean }).isDeclarationGroup)
          return yield* this.stepSteps(
            statement.row,
            statement.step,
            this.runStatementSteps(statement.statements, frame, 0)
          );
        return yield* this.executeBlockSteps(statement, frame);
      }
      case 'if': {
        if ((yield* this.valueSteps(statement.condition, frame)) as boolean)
          return yield* this.executeSteps(statement.consequence, frame);
        return statement.alternative ? yield* this.executeSteps(statement.alternative, frame) : undefined;
      }
      case 'while': {
        while ((yield* this.valueSteps(statement.condition, frame)) as boolean) {
          const outcome = loopOutcome(yield* this.executeSteps(statement.body, frame));
          if (outcome !== NEXT) return outcome;
        }
        return undefined;
      }
      case 'do': {
        do {
          const outcome = loopOutcome(yield* this.executeSteps(statement.body, frame));
          if (outcome !== NEXT) return outcome;
        } while ((yield* this.valueSteps(statement.condition, frame)) as boolean);
        return undefined;
      }
      case 'for': {
        return yield* this.forSteps(statement, frame);
      }
      case 'foreach': {
        return yield* this.foreachSteps(statement, frame);
      }
      case 'switch': {
        return yield* this.switchSteps(statement, frame);
      }
      case 'try': {
        return yield* this.trySteps(statement, frame);
      }
      case 'labeled': {
        return yield* this.executeSteps(statement.statement, frame);
      }
      case 'lock': {
        if ((yield* this.valueSteps(statement.value, frame)) === undefined)
          throw new PendingException('System.ArgumentNullException', 'Value cannot be null.');
        return yield* this.executeSteps(statement.body, frame);
      }
      case 'using': {
        return yield* this.usingSteps(statement, frame);
      }
      default: {
        return this.execute(statement, frame);
      }
    }
  }

  /** Runs a statement's suspending work, then records its step as {@link StatementExecutor.withStep} does. */
  private *stepSteps<T>(row: number, step: BoundStatement['step'], run: Steps<T>): Steps<T> {
    if (!this.tracing || step === 'none') return yield* run;
    const { steps } = this.runtime;
    const mark = steps.statementMark();
    const result = yield* run;
    steps.completeStatement(row, step === 'callsOnly', mark);
    return result;
  }

  private *declarationSteps(local: LocalSymbol, value: BoundExpression, frame: Frame): Steps<undefined> {
    this.storeLocal(frame, local, copyValue(yield* this.valueSteps(value, frame)));
    return undefined;
  }

  protected *executeBlockSteps(block: BoundBlock, frame: Frame, isBody = false): Steps<Completion> {
    return yield* this.inScopeSteps(
      frame,
      isBody ? [] : block.locals,
      block.capturedLocals,
      this.runStatementSteps(block.statements, frame, 0)
    );
  }

  /** A scope's locals get fresh cells when captured, and leave scope when the generator ends or is disposed. */
  private *inScopeSteps<T>(
    frame: Frame,
    locals: readonly LocalSymbol[],
    captured: readonly LocalSymbol[],
    run: Steps<T>
  ): Steps<T> {
    for (const local of captured) frame.slots[local.slot] = new Cell(UNASSIGNED);
    try {
      return yield* run;
    } finally {
      for (const local of locals) frame.slots[local.slot] = UNASSIGNED;
    }
  }

  private *runStatementSteps(statements: BoundStatement[], frame: Frame, start: number): Steps<Completion> {
    for (let index = start; index < statements.length; index++) {
      const completion = yield* this.executeSteps(statements[index], frame);
      if (completion === undefined) continue;
      const target = completion instanceof GotoCompletion ? labelIndexIn(statements, completion.target) : undefined;
      if (target === undefined) return completion;
      index = target - 1;
    }
    return undefined;
  }

  private *forSteps(statement: Extract<BoundStatement, { kind: 'for' }>, frame: Frame): Steps<Completion> {
    return yield* this.inScopeSteps(
      frame,
      statement.locals,
      statement.capturedLocals,
      this.forLoopSteps(statement, frame)
    );
  }

  private *forLoopSteps(statement: Extract<BoundStatement, { kind: 'for' }>, frame: Frame): Steps<Completion> {
    this.runForInitializers(statement, frame);
    while (!statement.condition || ((yield* this.valueSteps(statement.condition, frame)) as boolean)) {
      const outcome = loopOutcome(yield* this.executeSteps(statement.body, frame));
      if (outcome !== NEXT) return outcome;
      this.runForUpdates(statement, frame);
    }
    return undefined;
  }

  private *foreachSteps(statement: Extract<BoundStatement, { kind: 'foreach' }>, frame: Frame): Steps<Completion> {
    const collection = yield* this.valueSteps(statement.collection, frame);
    if (collection === undefined) throw NULL_REFERENCE();
    frame.temporaries.push(collection);
    try {
      const locals = [statement.variable, ...statement.locals];
      return yield* this.inScopeSteps(frame, locals, [], this.foreachLoopSteps(statement, collection, frame));
    } finally {
      frame.temporaries.pop();
    }
  }

  private *foreachLoopSteps(
    statement: Extract<BoundStatement, { kind: 'foreach' }>,
    collection: Value,
    frame: Frame
  ): Steps<Completion> {
    const cursor = this.elementsOf(statement, collection, frame);
    try {
      for (let element = cursor.next(); element; element = cursor.next()) {
        this.bindIteration(statement, frame, element.value);
        const outcome = loopOutcome(yield* this.executeSteps(statement.body, frame));
        if (outcome !== NEXT) return outcome;
      }
      return undefined;
    } finally {
      cursor.close();
    }
  }

  private *switchSteps(statement: Extract<BoundStatement, { kind: 'switch' }>, frame: Frame): Steps<Completion> {
    const value = yield* this.valueSteps(statement.value, frame);
    const locals = statement.sections.flatMap((section) => section.locals);
    return yield* this.inScopeSteps(frame, locals, [], this.sectionSteps(statement, value, frame));
  }

  private *sectionSteps(
    statement: Extract<BoundStatement, { kind: 'switch' }>,
    value: Value,
    frame: Frame
  ): Steps<Completion> {
    let section = this.chooseSection(statement.sections, value, frame);
    let start = 0;
    while (section) {
      const completion = yield* this.runStatementSteps(section.statements, frame, start);
      if (completion === BREAK) return undefined;
      if (!(completion instanceof GotoCompletion)) return completion;
      const target: LabelSymbol | BoundSwitchSection = completion.target;
      section = statement.sections.find(
        (candidate) => candidate === target || labelIndexIn(candidate.statements, target) !== undefined
      );
      if (!section) return completion;
      start = section === target ? 0 : (labelIndexIn(section.statements, target) as number);
    }
    return undefined;
  }

  /**
   * A try statement around a suspension. An iterator's has no catch clauses (CS1626); an async function's may, whose
   * filters run when its body throws, after the finally blocks inside it, as one pass over the handlers.
   */
  private *trySteps(statement: Extract<BoundStatement, { kind: 'try' }>, frame: Frame): Steps<Completion> {
    let completion: Completion;
    let isExiting = false;
    try {
      completion = yield* this.tryBodySteps(statement, frame);
    } catch (error) {
      // `Environment.Exit` ends the process without running finally blocks.
      isExiting = error instanceof ProgramExit;
      throw error;
    } finally {
      if (statement.finally && !isExiting) {
        const finallyCompletion = yield* this.executeBlockSteps(statement.finally, frame);
        if (finallyCompletion !== undefined) completion = finallyCompletion;
      }
    }
    return completion;
  }

  private *tryBodySteps(statement: Extract<BoundStatement, { kind: 'try' }>, frame: Frame): Steps<Completion> {
    try {
      return yield* this.executeBlockSteps(statement.body, frame);
    } catch (error) {
      const thrown = statement.catches.length > 0 ? this.asThrow(error) : undefined;
      if (!thrown) throw error;
      for (const clause of statement.catches) {
        if (!this.isInstanceOf(thrown.exception, clause.type)) continue;
        const handled = yield* this.catchSteps(clause, thrown, frame);
        if (handled !== 'declined') return handled;
      }
      throw thrown;
    }
  }

  private *catchSteps(clause: BoundCatch, thrown: CsThrow, frame: Frame): Steps<Completion | 'declined'> {
    for (const local of clause.locals) frame.slots[local.slot] = local.isCaptured ? new Cell(UNASSIGNED) : UNASSIGNED;
    try {
      if (clause.local) this.storeLocal(frame, clause.local, thrown.exception, true);
      if (clause.filter && !((yield* this.valueSteps(clause.filter, frame)) as boolean)) return 'declined';
      return yield* this.withExceptionSteps(thrown, this.executeBlockSteps(clause.body, frame));
    } finally {
      for (const local of clause.locals) frame.slots[local.slot] = UNASSIGNED;
    }
  }

  /**
   * Runs a catch clause's body, with its exception the one `throw;` rethrows while the body runs, which other code
   * running while it is suspended does not see.
   */
  private *withExceptionSteps<T>(thrown: CsThrow, run: Steps<T>): Steps<T> {
    for (;;) {
      this.currentExceptions.push(thrown);
      let result: IteratorResult<Suspension, T>;
      try {
        result = run.next();
      } finally {
        this.currentExceptions.pop();
      }
      if (result.done) return result.value;
      yield result.value;
    }
  }

  private *usingSteps(statement: Extract<BoundStatement, { kind: 'using' }>, frame: Frame): Steps<Completion> {
    let isExiting = false;
    try {
      return yield* this.executeSteps(statement.body, frame);
    } catch (error) {
      isExiting = error instanceof ProgramExit;
      throw error;
    } finally {
      const result = isExiting ? undefined : this.disposeResource(statement, frame);
      // `await using` waits for the ValueTask that DisposeAsync returns.
      if (statement.isAwait && result !== undefined) {
        const task = ((result as CsStruct).fields[0] as CsObject | undefined)?.native as TaskState | undefined;
        if (task && !task.isDone) yield { awaiting: task };
        // An exception from disposal replaces the one leaving the body, as it does in C#.
        // oxlint-disable-next-line no-unsafe-finally
        if (task?.status === 'faulted') throw task.firstThrown;
      }
    }
  }
}
