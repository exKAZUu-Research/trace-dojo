import type { BoundBlock, BoundStatement, BoundSwitchSection, LabelSymbol } from './bound';
import { NULL_REFERENCE } from './evaluatorBase';
import { PendingException } from './numeric';
import { type Frame, ProgramExit } from './runtime';
import {
  BREAK,
  type Completion,
  GotoCompletion,
  labelIndexIn,
  loopOutcome,
  NEXT,
  StatementExecutor,
} from './statementExecutor';
import type { LocalSymbol, MethodSymbol, Type } from './types';
import { Cell, UNASSIGNED, type Value } from './values';

/** What a suspended iterator body yields to its driver: the value of a `yield return`. */
export interface Yielded {
  value: Value;
}

/** The execution of a statement that may suspend at a `yield return`, as a generator of the values it yields. */
export type Steps<T> = Generator<Yielded, T, undefined>;

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
      state.current = result.value.value;
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

  *executeSteps(statement: BoundStatement, frame: Frame): Steps<Completion> {
    if (!statement.suspends) return this.execute(statement, frame);
    this.runtime.spend();
    switch (statement.kind) {
      case 'yieldReturn': {
        const value = this.withStep(statement.row, statement.step, () => this.evaluate(statement.value, frame));
        yield { value };
        return undefined;
      }
      case 'block': {
        return yield* this.executeBlockSteps(statement, frame);
      }
      case 'if': {
        if (this.evaluate(statement.condition, frame) as boolean)
          return yield* this.executeSteps(statement.consequence, frame);
        return statement.alternative ? yield* this.executeSteps(statement.alternative, frame) : undefined;
      }
      case 'while': {
        while (this.evaluate(statement.condition, frame) as boolean) {
          const outcome = loopOutcome(yield* this.executeSteps(statement.body, frame));
          if (outcome !== NEXT) return outcome;
        }
        return undefined;
      }
      case 'do': {
        do {
          const outcome = loopOutcome(yield* this.executeSteps(statement.body, frame));
          if (outcome !== NEXT) return outcome;
        } while (this.evaluate(statement.condition, frame) as boolean);
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
        if (this.evaluate(statement.value, frame) === undefined)
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

  private *executeBlockSteps(block: BoundBlock, frame: Frame, isBody = false): Steps<Completion> {
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
    while (!statement.condition || (this.evaluate(statement.condition, frame) as boolean)) {
      const outcome = loopOutcome(yield* this.executeSteps(statement.body, frame));
      if (outcome !== NEXT) return outcome;
      this.runForUpdates(statement, frame);
    }
    return undefined;
  }

  private *foreachSteps(statement: Extract<BoundStatement, { kind: 'foreach' }>, frame: Frame): Steps<Completion> {
    const collection = this.evaluate(statement.collection, frame);
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
    const value = this.evaluate(statement.value, frame);
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

  /** A try statement around a `yield return`, which C# allows only without catch clauses (CS1626). */
  private *trySteps(statement: Extract<BoundStatement, { kind: 'try' }>, frame: Frame): Steps<Completion> {
    let completion: Completion;
    let isExiting = false;
    try {
      completion = yield* this.executeBlockSteps(statement.body, frame);
    } catch (error) {
      // `Environment.Exit` ends the process without running finally blocks.
      isExiting = error instanceof ProgramExit;
      throw error;
    } finally {
      if (statement.finally && !isExiting) {
        const finallyCompletion = this.runFinally(statement.finally, frame);
        if (finallyCompletion !== undefined) completion = finallyCompletion;
      }
    }
    return completion;
  }

  private *usingSteps(statement: Extract<BoundStatement, { kind: 'using' }>, frame: Frame): Steps<Completion> {
    let isExiting = false;
    try {
      return yield* this.executeSteps(statement.body, frame);
    } catch (error) {
      isExiting = error instanceof ProgramExit;
      throw error;
    } finally {
      const resource = this.readLocal(frame, statement.local);
      if (!isExiting && resource !== undefined) {
        const dispose = this.runtime.dispatch(statement.dispose, resource, statement.disposable);
        this.invokeWithoutArguments(frame, dispose, resource, statement.row, this.runtime.runtimeTypeOf(resource));
      }
    }
  }
}
