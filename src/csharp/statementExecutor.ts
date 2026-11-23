// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import type { BoundBlock, BoundCatch, BoundExpression, BoundStatement, BoundSwitchSection, ForeachKind } from './bound';
import { NULL_REFERENCE } from './evaluatorBase';
import { PendingException } from './numeric';
import { PatternMatcher } from './patternMatcher';
import { CsThrow, type ExceptionState, type Frame, ProgramExit } from './runtime';
import type { MethodSymbol, Type } from './types';
import { Cell, copyValue, type CsArray, CsObject, type CsString, stringText, UNASSIGNED, type Value } from './values';

const BREAK = Symbol('break');
const CONTINUE = Symbol('continue');
interface ReturnCompletion {
  value: Value;
}
export type Completion = undefined | typeof BREAK | typeof CONTINUE | ReturnCompletion;

/** That a loop goes on to its next iteration. */
const NEXT = Symbol('next');

type ForStatement = Extract<BoundStatement, { kind: 'for' }>;
type ForeachStatement = Extract<BoundStatement, { kind: 'foreach' }>;

/** The evaluator's execution of statements. */
export abstract class StatementExecutor extends PatternMatcher {
  /** The exceptions that catch clauses are handling, which `throw;` rethrows. */
  private readonly currentExceptions: CsThrow[] = [];

  /** Runs a statement, recording its step when it completes as the trace's rules say. */
  protected withStep<T>(row: number, step: BoundStatement['step'], run: () => T): T {
    if (!this.tracing || step === 'none') return run();
    return this.runtime.steps.runStatement(row, step === 'callsOnly', run);
  }

  /**
   * Runs a block. Its locals go out of scope when it ends, so the trace stops showing them, except those of a method's
   * body (`isBody`), which the frame holds until the method exits, where the end of the program reads its locals.
   */
  executeBlock(block: BoundBlock, frame: Frame, isBody = false): Completion {
    for (const local of block.capturedLocals) frame.slots[local.slot] = new Cell(UNASSIGNED);
    try {
      for (const statement of block.statements) {
        const completion = this.execute(statement, frame);
        if (completion !== undefined) return completion;
      }
      return undefined;
    } finally {
      if (!isBody) for (const local of block.locals) if (!local.isCaptured) frame.slots[local.slot] = UNASSIGNED;
    }
  }

  // code-gauge-allow functionNcss -- One case per kind of statement.
  execute(statement: BoundStatement, frame: Frame): Completion {
    this.runtime.spend();
    switch (statement.kind) {
      case 'block': {
        return this.executeBlockStatement(statement, frame);
      }
      case 'empty': {
        return undefined;
      }
      case 'expression': {
        this.withStep(statement.row, statement.step, () => this.evaluate(statement.expression, frame));
        return undefined;
      }
      case 'localDeclaration': {
        this.withStep(statement.row, statement.step, () => {
          if (statement.value)
            this.storeLocal(frame, statement.local, copyValue(this.evaluate(statement.value, frame)));
          // A struct local without a value has its fields, which the program may assign one by one.
          else if (isStructType(statement.local.type))
            this.storeLocal(frame, statement.local, this.defaultOf(frame.resolve(statement.local.type)));
        });
        return undefined;
      }
      case 'if': {
        if (this.evaluate(statement.condition, frame) as boolean) return this.execute(statement.consequence, frame);
        return statement.alternative ? this.execute(statement.alternative, frame) : undefined;
      }
      case 'while': {
        return this.executeWhile(statement, frame);
      }
      case 'do': {
        return this.executeDo(statement, frame);
      }
      case 'for': {
        return this.executeFor(statement, frame);
      }
      case 'foreach': {
        return this.executeForeach(statement, frame);
      }
      case 'switch': {
        return this.executeSwitch(statement, frame);
      }
      case 'break': {
        return BREAK;
      }
      case 'continue': {
        return CONTINUE;
      }
      case 'return': {
        return { value: statement.value ? copyValue(this.evaluate(statement.value, frame)) : undefined };
      }
      case 'throw': {
        return this.executeThrow(statement, frame);
      }
      case 'try': {
        return this.executeTry(statement, frame);
      }
    }
  }

  private executeBlockStatement(statement: Extract<BoundStatement, { kind: 'block' }>, frame: Frame): Completion {
    if ((statement as { isDeclarationGroup?: boolean }).isDeclarationGroup) {
      return this.withStep<Completion>(statement.row, statement.step, () => {
        for (const inner of statement.statements) this.execute(inner, frame);
        return;
      });
    }
    return this.executeBlock(statement, frame);
  }

  private executeWhile(statement: Extract<BoundStatement, { kind: 'while' }>, frame: Frame): Completion {
    while (this.evaluate(statement.condition, frame) as boolean) {
      const outcome = loopOutcome(this.execute(statement.body, frame));
      if (outcome !== NEXT) return outcome;
    }
    return undefined;
  }

  private executeDo(statement: Extract<BoundStatement, { kind: 'do' }>, frame: Frame): Completion {
    do {
      const outcome = loopOutcome(this.execute(statement.body, frame));
      if (outcome !== NEXT) return outcome;
    } while (this.evaluate(statement.condition, frame) as boolean);
    return undefined;
  }

  private executeFor(statement: ForStatement, frame: Frame): Completion {
    for (const local of statement.capturedLocals) frame.slots[local.slot] = new Cell(UNASSIGNED);
    try {
      this.runForInitializers(statement, frame);
      while (!statement.condition || (this.evaluate(statement.condition, frame) as boolean)) {
        const outcome = loopOutcome(this.execute(statement.body, frame));
        if (outcome !== NEXT) return outcome;
        this.runForUpdates(statement, frame);
      }
      return undefined;
    } finally {
      for (const local of statement.locals) if (!local.isCaptured) frame.slots[local.slot] = UNASSIGNED;
    }
  }

  private runForInitializers(statement: ForStatement, frame: Frame): void {
    if (statement.initializers.length === 0) return;
    this.withStep(statement.row, headerStep(statement.initializers), () => {
      for (const initializer of statement.initializers) this.execute(withoutStep(initializer), frame);
    });
  }

  private runForUpdates(statement: ForStatement, frame: Frame): void {
    if (statement.updates.length === 0) return;
    this.withStep(statement.row, 'step', () => {
      for (const update of statement.updates) this.evaluate(update, frame);
    });
  }

  private executeForeach(statement: ForeachStatement, frame: Frame): Completion {
    const collection = this.evaluate(statement.collection, frame);
    if (collection === undefined) throw NULL_REFERENCE();
    frame.temporaries.push(collection);
    try {
      const runIteration = (element: Value): Completion => {
        const converted = statement.elementConversion
          ? this.withOperand(frame, element, () => this.evaluate(statement.elementConversion as BoundExpression, frame))
          : element;
        this.storeLocal(frame, statement.variable, copyValue(converted), true);
        if (statement.deconstruction) this.evaluate(statement.deconstruction, frame);
        if (this.tracing) this.runtime.steps.stepBinding(statement.row, statement.bindingStoresAnswer);
        return this.execute(statement.body, frame);
      };
      return this.iterate(statement, collection, frame, runIteration);
    } finally {
      frame.temporaries.pop();
      for (const local of [statement.variable, ...statement.locals])
        if (!local.isCaptured) frame.slots[local.slot] = UNASSIGNED;
    }
  }

  private iterate(
    statement: ForeachStatement,
    collection: Value,
    frame: Frame,
    runIteration: (element: Value) => Completion
  ): Completion {
    const { iteration } = statement;
    if (iteration.kind === 'array') {
      const { values } = collection as CsArray;
      return iterateIndexed(values.length, (index) => values[index], runIteration);
    }
    if (iteration.kind === 'string') {
      const text = stringText(collection as string | CsString);
      return iterateIndexed(text.length, (index) => text.charCodeAt(index), runIteration);
    }
    return this.iterateEnumerator(statement, iteration, collection, frame, runIteration);
  }

  /** Runs a foreach loop over the enumerator that the collection's `GetEnumerator` returns. */
  private iterateEnumerator(
    statement: ForeachStatement,
    iteration: Extract<ForeachKind, { kind: 'enumerator' }>,
    collection: Value,
    frame: Frame,
    runIteration: (element: Value) => Completion
  ): Completion {
    const receiverType = this.runtime.runtimeTypeOf(collection);
    const getEnumerator =
      iteration.getEnumerator.owner.kind === 'interface' || iteration.getEnumerator.isVirtual
        ? this.runtime.dispatch(iteration.getEnumerator, collection)
        : iteration.getEnumerator;
    const enumerator = this.invokeWithoutArguments(frame, getEnumerator, collection, statement.row, receiverType);
    if (enumerator === undefined) throw NULL_REFERENCE();
    frame.temporaries.push(enumerator);
    try {
      const enumeratorType = this.runtime.runtimeTypeOf(enumerator);
      const moveNext = this.runtime.dispatch(iteration.moveNext, enumerator);
      const getter = iteration.current.getter as MethodSymbol;
      const current = this.runtime.dispatch(getter, enumerator);
      while (this.invokeWithoutArguments(frame, moveNext, enumerator, statement.row, enumeratorType) as boolean) {
        const element = this.boxedAsCalled(
          getter,
          current,
          enumeratorType,
          this.invokeWithoutArguments(frame, current, enumerator, statement.row, enumeratorType)
        );
        const outcome = loopOutcome(runIteration(element));
        if (outcome !== NEXT) return outcome;
      }
      return undefined;
    } finally {
      frame.temporaries.pop();
      if (iteration.dispose) {
        const dispose = this.runtime.dispatch(iteration.dispose, enumerator);
        this.invokeWithoutArguments(frame, dispose, enumerator, statement.row, this.runtime.runtimeTypeOf(enumerator));
      }
    }
  }

  private invokeWithoutArguments(
    frame: Frame,
    method: MethodSymbol,
    receiver: Value,
    row: number,
    receiverType: Type | undefined
  ): Value {
    return this.invoke(frame, method, receiver, [], row, this.environmentFor(method, receiverType));
  }

  private executeSwitch(statement: Extract<BoundStatement, { kind: 'switch' }>, frame: Frame): Completion {
    const value = this.evaluate(statement.value, frame);
    const chosen = this.chooseSection(statement.sections, value, frame);
    if (!chosen) return undefined;
    try {
      for (const inner of chosen.statements) {
        const completion = this.execute(inner, frame);
        if (completion === BREAK) return undefined;
        if (completion !== undefined) return completion;
      }
      return undefined;
    } finally {
      // The sections' locals go out of scope with the switch block, so the trace stops showing them.
      for (const section of statement.sections)
        for (const local of section.locals) if (!local.isCaptured) frame.slots[local.slot] = UNASSIGNED;
    }
  }

  /** The section of the first label that matches, or else the default section. */
  private chooseSection(sections: BoundSwitchSection[], value: Value, frame: Frame): BoundSwitchSection | undefined {
    let defaultSection: BoundSwitchSection | undefined;
    for (const section of sections) {
      for (const label of section.labels) {
        if (label === 'default') {
          defaultSection = section;
          continue;
        }
        if (
          this.matches(label.pattern, value, frame) &&
          (!label.guard || (this.evaluate(label.guard, frame) as boolean))
        )
          return section;
      }
    }
    return defaultSection;
  }

  private executeThrow(statement: Extract<BoundStatement, { kind: 'throw' }>, frame: Frame): never {
    if (!statement.value) {
      const current = this.currentExceptions.at(-1);
      if (!current) throw NULL_REFERENCE();
      // `throw;` sends the exception on to the handlers outside, which choose its catch clause anew.
      this.catchers.delete(current);
      throw current;
    }
    throw this.throwValue(this.evaluate(statement.value, frame));
  }

  // code-gauge-allow functionNcss -- Each branch handles one case of the C# rule that the function applies.
  private executeTry(statement: Extract<BoundStatement, { kind: 'try' }>, frame: Frame): Completion {
    let completion: Completion;
    let isExiting = false;
    try {
      const hasCatches = statement.catches.length > 0;
      if (hasCatches) this.handlers.push({ statement, frame });
      let thrown: CsThrow | undefined;
      try {
        completion = this.executeBlock(statement.body, frame);
      } catch (error) {
        thrown = this.asThrow(error);
        if (!thrown) throw error;
        // .NET finds the catch clause, running the filters on the way, before it runs any finally block.
        if (!this.catchers.has(thrown)) this.catchers.set(thrown, this.findCatcher(thrown));
      } finally {
        if (hasCatches) this.handlers.pop();
      }
      if (thrown) {
        const handled = this.handle(statement, thrown, frame);
        if (handled === 'unhandled') throw thrown;
        completion = handled;
      }
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

  private runFinally(block: BoundBlock, frame: Frame): Completion {
    return this.executeBlock(block, frame);
  }

  /** The try statements whose bodies are running, innermost last, with their catch clauses. */
  private readonly handlers: { statement: Extract<BoundStatement, { kind: 'try' }>; frame: Frame }[] = [];

  /** How many of the handlers outside a running catch filter an exception the filter throws cannot reach, as .NET discards it at the filter. */
  private filterFloor = 0;

  /** The catch clause that each exception in flight goes to, or undefined when none takes it. */
  private readonly catchers = new WeakMap<CsThrow, { statement: BoundStatement; clause: BoundCatch } | undefined>();

  /** The first catch clause from the innermost try out that accepts an exception, its filter evaluated in its frame. */
  private findCatcher(thrown: CsThrow): { statement: BoundStatement; clause: BoundCatch } | undefined {
    for (const { statement, frame } of this.handlers.slice(this.filterFloor).toReversed()) {
      for (const clause of statement.catches) {
        if (!this.isInstanceOf(thrown.exception, clause.type)) continue;
        if (clause.local) this.storeLocal(frame, clause.local, thrown.exception, true);
        if (clause.filter && !this.passesFilter(clause.filter, frame)) continue;
        return { statement, clause };
      }
    }
    return undefined;
  }

  /** Whether a catch filter holds, counting an exception it throws as false, as .NET discards that exception. */
  private passesFilter(filter: BoundExpression, frame: Frame): boolean {
    const outerFloor = this.filterFloor;
    this.filterFloor = this.handlers.length;
    try {
      return this.evaluate(filter, frame) as boolean;
    } catch (error) {
      if (error instanceof CsThrow || error instanceof PendingException) return false;
      throw error;
    } finally {
      this.filterFloor = outerFloor;
    }
  }

  /** Runs the catch clause of this try that the exception goes to, or tells that it goes elsewhere. */
  private handle(
    statement: Extract<BoundStatement, { kind: 'try' }>,
    thrown: CsThrow,
    frame: Frame
  ): Completion | 'unhandled' {
    const catcher = this.catchers.get(thrown);
    if (catcher?.statement !== statement) return 'unhandled';
    const { clause } = catcher;
    if (clause.local) this.storeLocal(frame, clause.local, thrown.exception, true);
    this.currentExceptions.push(thrown);
    try {
      return this.executeBlock(clause.body, frame);
    } finally {
      this.currentExceptions.pop();
    }
  }

  /** The C# exception that a host error stands for, if the program can catch it. */
  asThrow(error: unknown): CsThrow | undefined {
    if (error instanceof CsThrow) return error;
    if (error instanceof PendingException) {
      const exception = this.runtime.materialize(error);
      (exception.native as ExceptionState).wasThrown = true;
      return new CsThrow(exception);
    }
    return undefined;
  }

  protected throwValue(value: Value): CsThrow {
    if (!(value instanceof CsObject)) throw NULL_REFERENCE();
    if (value.native) (value.native as ExceptionState).wasThrown = true;
    return new CsThrow(value);
  }
}

/** What a loop does after its body completes: go on, or end with the completion it returns. */
function loopOutcome(completion: Completion): Completion | typeof NEXT {
  if (completion === undefined || completion === CONTINUE) return NEXT;
  return completion === BREAK ? undefined : completion;
}

function iterateIndexed(
  length: number,
  elementAt: (index: number) => Value,
  runIteration: (element: Value) => Completion
): Completion {
  for (let index = 0; index < length; index++) {
    const outcome = loopOutcome(runIteration(elementAt(index)));
    if (outcome !== NEXT) return outcome;
  }
  return undefined;
}

/** A for loop's initializers record one step, unless they declare without initializing. */
function headerStep(initializers: BoundStatement[]): BoundStatement['step'] {
  const recordsStep = initializers.some(
    (initializer) => initializer.step !== 'none' || initializer.kind === 'expression'
  );
  return recordsStep ? 'step' : 'none';
}

function withoutStep(statement: BoundStatement): BoundStatement {
  return statement.step === 'none' ? statement : ({ ...statement, step: 'none' } as BoundStatement);
}

function isStructType(type: Type): boolean {
  return type.kind === 'named' && type.symbol.kind === 'struct' && type.symbol.special === undefined;
}
