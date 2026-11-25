// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import type {
  BoundBlock,
  BoundCatch,
  BoundExpression,
  BoundLValue,
  BoundStatement,
  BoundSwitchSection,
  ForeachKind,
  LabelSymbol,
} from './bound';
import { NULL_REFERENCE, type Reference } from './evaluatorBase';
import { PendingException } from './numeric';
import { PatternMatcher } from './patternMatcher';
import { CsThrow, type ExceptionState, type Frame, ProgramExit, type Slot } from './runtime';
import type { LocalSymbol, MethodSymbol, Type } from './types';
import { Cell, copyValue, type CsArray, CsObject, type CsString, stringText, UNASSIGNED, type Value } from './values';

export const BREAK = Symbol('break');
export const CONTINUE = Symbol('continue');
interface ReturnCompletion {
  value: Value;
}
/** A `goto` on its way to the block or switch that holds its target. */
export class GotoCompletion {
  constructor(readonly target: LabelSymbol | BoundSwitchSection) {}
}
export type Completion = undefined | typeof BREAK | typeof CONTINUE | ReturnCompletion | GotoCompletion;

/** The index of each label among a statement list's statements, for the lists that `goto` has jumped in. */
const labelIndices = new WeakMap<BoundStatement[], Map<LabelSymbol | BoundSwitchSection, number>>();

/** Where a label stands among a list of statements, or undefined when the list does not hold it. */
export function labelIndexIn(
  statements: BoundStatement[],
  target: LabelSymbol | BoundSwitchSection
): number | undefined {
  let indices = labelIndices.get(statements);
  if (!indices) {
    indices = new Map();
    for (const [index, statement] of statements.entries())
      for (let inner = statement; inner.kind === 'labeled'; inner = inner.statement) indices.set(inner.label, index);
    labelIndices.set(statements, indices);
  }
  return indices.get(target);
}

/** That a loop goes on to its next iteration. */
export const NEXT = Symbol('next');

/** The elements of a foreach loop's collection, which `next` gives one by one until it gives none. */
export interface ElementCursor {
  next(): { value: Value } | undefined;
  close(): void;
}

type ForStatement = Extract<BoundStatement, { kind: 'for' }>;
type ForeachStatement = Extract<BoundStatement, { kind: 'foreach' }>;

/** The catch clause an exception goes to, with the slots its filter left for the clause's body. */
interface Catcher {
  statement: BoundStatement;
  clause: BoundCatch;
  filterSlots: Slot[];
}

/** The evaluator's execution of statements. */
export abstract class StatementExecutor extends PatternMatcher {
  /** The exceptions that catch clauses are handling, which `throw;` rethrows. */
  protected readonly currentExceptions: CsThrow[] = [];

  abstract referenceTo(target: BoundLValue, frame: Frame): Reference;

  /** Makes a ref local refer to a variable; a lambda never captures one, so it is in its own frame's slots. */
  bindReference(frame: Frame, local: LocalSymbol, reference: Reference): void {
    frame.slots[local.slot] = reference;
  }

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
    return this.inScope(frame, isBody ? [] : block.locals, block.capturedLocals, () =>
      this.runStatements(block.statements, frame, 0)
    );
  }

  /** Runs statements from an index, going on from a label of theirs that a `goto` among them jumps to. */
  protected runStatements(statements: BoundStatement[], frame: Frame, start: number): Completion {
    for (let index = start; index < statements.length; index++) {
      const completion = this.execute(statements[index], frame);
      if (completion === undefined) continue;
      const target = completion instanceof GotoCompletion ? labelIndexIn(statements, completion.target) : undefined;
      if (target === undefined) return completion;
      index = target - 1;
    }
    return undefined;
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
          if (statement.refTarget)
            this.bindReference(frame, statement.local, this.referenceTo(statement.refTarget, frame));
          else if (statement.value)
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
        // A method that returns by reference returns the variable itself, which its call reads or assigns.
        if (statement.refTarget) return { value: this.referenceTo(statement.refTarget, frame) as unknown as Value };
        return { value: statement.value ? copyValue(this.evaluate(statement.value, frame)) : undefined };
      }
      case 'throw': {
        return this.executeThrow(statement, frame);
      }
      case 'try': {
        return this.executeTry(statement, frame);
      }
      case 'labeled': {
        return this.execute(statement.statement, frame);
      }
      case 'goto': {
        return new GotoCompletion(statement.target as LabelSymbol | BoundSwitchSection);
      }
      case 'lock': {
        // Monitor.Enter rejects null; with one thread, taking the lock never waits.
        if (this.evaluate(statement.value, frame) === undefined)
          throw new PendingException('System.ArgumentNullException', 'Value cannot be null.');
        return this.execute(statement.body, frame);
      }
      case 'using': {
        return this.executeUsing(statement, frame);
      }
      case 'yieldBreak': {
        return { value: undefined };
      }
      case 'yieldReturn': {
        throw new Error('A yield return runs only in an iterator body');
      }
    }
  }

  private executeUsing(statement: Extract<BoundStatement, { kind: 'using' }>, frame: Frame): Completion {
    let isExiting = false;
    try {
      return this.execute(statement.body, frame);
    } catch (error) {
      // `Environment.Exit` ends the process without disposing, as it skips finally blocks.
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
    return this.inScope(frame, statement.locals, statement.capturedLocals, () => {
      this.runForInitializers(statement, frame);
      while (!statement.condition || (this.evaluate(statement.condition, frame) as boolean)) {
        const outcome = loopOutcome(this.execute(statement.body, frame));
        if (outcome !== NEXT) return outcome;
        this.runForUpdates(statement, frame);
      }
      return;
    });
  }

  protected runForInitializers(statement: ForStatement, frame: Frame): void {
    if (statement.initializers.length === 0) return;
    this.withStep(statement.row, headerStep(statement.initializers), () => {
      for (const initializer of statement.initializers) this.execute(withoutStep(initializer), frame);
    });
  }

  protected runForUpdates(statement: ForStatement, frame: Frame): void {
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
      return this.inScope(frame, [statement.variable, ...statement.locals], [], () => {
        const cursor = this.elementsOf(statement, collection, frame);
        try {
          for (let element = cursor.next(); element; element = cursor.next()) {
            this.bindIteration(statement, frame, element.value);
            const outcome = loopOutcome(this.execute(statement.body, frame));
            if (outcome !== NEXT) return outcome;
          }
          return;
        } finally {
          cursor.close();
        }
      });
    } finally {
      frame.temporaries.pop();
    }
  }

  /** Stores an element in a foreach loop's variable, or deconstructs it into the loop's variables. */
  protected bindIteration(statement: ForeachStatement, frame: Frame, element: Value): void {
    const converted = statement.elementConversion
      ? this.withOperand(frame, element, () => this.evaluate(statement.elementConversion as BoundExpression, frame))
      : element;
    this.storeLocal(frame, statement.variable, copyValue(converted), true);
    if (statement.deconstruction) {
      // Each iteration declares the deconstructed variables anew, so a closure keeps its own iteration's values.
      for (const local of statement.locals) if (local.isCaptured) frame.slots[local.slot] = new Cell(UNASSIGNED);
      this.evaluate(statement.deconstruction, frame);
    }
    if (this.tracing) this.runtime.steps.stepBinding(statement.row, statement.bindingStoresAnswer);
  }

  /**
   * The elements a foreach loop goes through, one at a time: an array's or a string's, or those the collection's
   * `GetEnumerator` returns, whose enumerator `close` disposes, when it implements IDisposable, as the loop ends.
   */
  protected elementsOf(statement: ForeachStatement, collection: Value, frame: Frame): ElementCursor {
    const { iteration } = statement;
    if (iteration.kind === 'array' || iteration.kind === 'string') {
      const values = iteration.kind === 'array' ? (collection as CsArray).values : undefined;
      const text = iteration.kind === 'string' ? stringText(collection as string | CsString) : '';
      const length = values ? values.length : text.length;
      let index = 0;
      return {
        next: () => {
          if (index >= length) return;
          const value = values ? values[index] : text.charCodeAt(index);
          index++;
          return { value };
        },
        close: () => {},
      };
    }
    return this.enumeratorElements(statement, iteration, collection, frame);
  }

  private enumeratorElements(
    statement: ForeachStatement,
    iteration: Extract<ForeachKind, { kind: 'enumerator' }>,
    collection: Value,
    frame: Frame
  ): ElementCursor {
    const receiverType = this.runtime.runtimeTypeOf(collection);
    const getEnumerator =
      iteration.getEnumerator.owner.kind === 'interface' || iteration.getEnumerator.isVirtual
        ? this.runtime.dispatch(iteration.getEnumerator, collection)
        : iteration.getEnumerator;
    const enumerator = this.invokeWithoutArguments(frame, getEnumerator, collection, statement.row, receiverType);
    if (enumerator === undefined) throw NULL_REFERENCE();
    frame.temporaries.push(enumerator);
    const enumeratorType = this.runtime.runtimeTypeOf(enumerator);
    const moveNext = this.runtime.dispatch(iteration.moveNext, enumerator);
    const getter = iteration.current.getter as MethodSymbol;
    const current = this.runtime.dispatch(getter, enumerator);
    return {
      next: () => {
        if (!(this.invokeWithoutArguments(frame, moveNext, enumerator, statement.row, enumeratorType) as boolean))
          return;
        const value = this.invokeWithoutArguments(frame, current, enumerator, statement.row, enumeratorType);
        return { value: this.boxedAsCalled(getter, current, enumeratorType, value) };
      },
      close: () => {
        frame.temporaries.pop();
        // Only an enumerator that implements IDisposable is disposed, through its implementation of the interface.
        if (this.isInstanceOf(enumerator, iteration.disposable)) {
          const dispose = this.runtime.dispatch(iteration.dispose, enumerator, iteration.disposable);
          this.invokeWithoutArguments(
            frame,
            dispose,
            enumerator,
            statement.row,
            this.runtime.runtimeTypeOf(enumerator)
          );
        }
      },
    };
  }

  protected invokeWithoutArguments(
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
    // Choosing the section binds the patterns' variables, so it runs in the switch block's scope.
    return this.inScope(
      frame,
      statement.sections.flatMap((section) => section.locals),
      [],
      () => {
        let section = this.chooseSection(statement.sections, value, frame);
        let start = 0;
        while (section) {
          const completion = this.runStatements(section.statements, frame, start);
          if (completion === BREAK) return;
          if (!(completion instanceof GotoCompletion)) return completion;
          // `goto case` and `goto default` go to a section of this switch; `goto` to a label in another section.
          const { target } = completion;
          section = statement.sections.find(
            (candidate) => candidate === target || labelIndexIn(candidate.statements, target) !== undefined
          );
          if (!section) return completion;
          start = section === target ? 0 : (labelIndexIn(section.statements, target) as number);
        }
        return;
      }
    );
  }

  /** The section of the first label that matches, or else the default section. */
  protected chooseSection(sections: BoundSwitchSection[], value: Value, frame: Frame): BoundSwitchSection | undefined {
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
        // A rejected label's pattern variables belong to its section, which is not entered, so the trace drops them.
        for (const local of section.locals) frame.slots[local.slot] = UNASSIGNED;
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

  protected runFinally(block: BoundBlock, frame: Frame): Completion {
    return this.executeBlock(block, frame);
  }

  /** The try statements whose bodies are running, innermost last, with their catch clauses. */
  private readonly handlers: { statement: Extract<BoundStatement, { kind: 'try' }>; frame: Frame }[] = [];

  /** How many of the handlers outside a running catch filter an exception the filter throws cannot reach, as .NET discards it at the filter. */
  private filterFloor = 0;

  /** The catch clause that each exception in flight goes to, or undefined when none takes it. */
  private readonly catchers = new WeakMap<CsThrow, Catcher | undefined>();

  /** The first catch clause from the innermost try out that accepts an exception, its filter evaluated in its frame. */
  private findCatcher(thrown: CsThrow): Catcher | undefined {
    for (const { statement, frame } of this.handlers.slice(this.filterFloor).toReversed()) {
      for (const clause of statement.catches) {
        if (!this.isInstanceOf(thrown.exception, clause.type)) continue;
        const filterSlots = this.acceptingFilterSlots(clause, thrown, frame);
        if (filterSlots) return { statement, clause, filterSlots };
      }
    }
    return undefined;
  }

  /** The slots of a catch clause's filter locals when the clause accepts an exception, or undefined when it does not. */
  private acceptingFilterSlots(clause: BoundCatch, thrown: CsThrow, frame: Frame): Slot[] | undefined {
    const { filter, local } = clause;
    if (!filter) return [];
    // The filter's locals leave scope with it, since a finally that throws can abandon the clause before its body
    // runs; the body gets them back from the slots kept here, cells included, so closures keep sharing them.
    return this.inScope(frame, clause.locals, [], () => {
      if (local) this.storeLocal(frame, local, thrown.exception, true);
      return this.passesFilter(filter, frame) ? clause.locals.map((symbol) => frame.slots[symbol.slot]) : undefined;
    });
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
    const { clause, filterSlots } = catcher;
    const { local } = clause;
    this.currentExceptions.push(thrown);
    try {
      return this.inScope(frame, clause.locals, [], () => {
        for (const [index, slot] of filterSlots.entries()) frame.slots[clause.locals[index].slot] = slot;
        if (local) this.storeLocal(frame, local, thrown.exception, true);
        return this.executeBlock(clause.body, frame);
      });
    } finally {
      this.currentExceptions.pop();
    }
  }

  /**
   * Runs code in a scope that declares locals: captured ones get fresh cells, and every way out drops them all from the
   * frame, so the trace stops showing a local once control leaves its scope. A closure keeps a captured cell itself.
   */
  protected inScope<T>(
    frame: Frame,
    locals: readonly LocalSymbol[],
    captured: readonly LocalSymbol[],
    run: () => T
  ): T {
    for (const local of captured) frame.slots[local.slot] = new Cell(UNASSIGNED);
    try {
      return run();
    } finally {
      for (const local of locals) frame.slots[local.slot] = UNASSIGNED;
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
export function loopOutcome(completion: Completion): Completion | typeof NEXT {
  if (completion === undefined || completion === CONTINUE) return NEXT;
  return completion === BREAK ? undefined : completion;
}

/** A for loop's initializers record one step, unless they declare without initializing. */
export function headerStep(initializers: BoundStatement[]): BoundStatement['step'] {
  const recordsStep = initializers.some(
    (initializer) => initializer.step !== 'none' || initializer.kind === 'expression'
  );
  return recordsStep ? 'step' : 'none';
}

export function withoutStep(statement: BoundStatement): BoundStatement {
  return statement.step === 'none' ? statement : ({ ...statement, step: 'none' } as BoundStatement);
}

function isStructType(type: Type): boolean {
  return type.kind === 'named' && type.symbol.kind === 'struct' && type.symbol.special === undefined;
}
