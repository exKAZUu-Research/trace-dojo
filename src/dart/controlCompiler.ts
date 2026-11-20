// code-gauge-allow-file fileNcss 515 -- One compiler phase per file; splitting it further would scatter the cases of one construct.
import type { Block, CatchClause, Pattern, Statement, SwitchCase } from './ast';
import type { FunctionSpec } from './callCompiler';
import type { Eval } from './compilerBase';
import { checkExhaustive } from './exhaustiveness';
import { type CompiledPattern } from './patternCompiler';
import { DartThrow, type Frame } from './runtime';
import { Flow } from './scope';
import {
  advanceCountedLoop,
  type Completion,
  type CountedLoop,
  type Exec,
  type GenExec,
  loopCompletion,
  startCountedLoop,
  StatementCompiler,
} from './statementCompiler';
import { coreTypes, type DartType, DYNAMIC, interfaceType, isSubtype, iterableElementOf } from './types';
import { Cell, type Value } from './values';

/** Switch, try, and the bodies of sync* generators. */
export abstract class ControlCompiler extends StatementCompiler {
  protected compileSwitch(statement: Extract<Statement, { kind: 'switch' }>): Exec {
    const labels = this.takeLoopLabels();
    const subject = this.compileExpression(statement.subject);
    const before = this.flow;
    this.breakFlows.push(undefined);
    const { groups, after: afterCases } = this.compileSwitchGroups(statement, subject.type, before, labels);
    let after = afterCases;
    const breakFlow = this.breakFlows.pop();
    if (!this.isSwitchExhaustive(statement, subject.type)) after = after ? Flow.join(after, before) : before;
    if (statement.cases.length === 0) after = before;
    this.flow = breakFlow ? Flow.join(after ?? before.unreachable, breakFlow) : (after ?? before);
    const test = subject.run;
    return (frame) => {
      const value = test(frame);
      frame.temporaries.push(value);
      let index: number;
      try {
        index = selectSwitchGroup(frame, value, groups);
      } finally {
        frame.temporaries.pop();
      }
      return runSwitchFrom(frame, index, groups, labels);
    };
  }

  /** The groups of cases that share a body, each in a scope of its own, with the labels the switch declares. */
  private compileSwitchGroups(
    statement: Extract<Statement, { kind: 'switch' }>,
    subjectType: DartType,
    before: Flow,
    labels: string[]
  ): { groups: SwitchGroup[]; after: Flow | undefined } {
    this.fn.switchDepth++;
    for (const label of labels) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: false });
    const caseLabels = statement.cases.flatMap((switchCase) => switchCase.labels);
    for (const label of caseLabels) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: true });
    let after: Flow | undefined;
    const groups: SwitchGroup[] = [];
    try {
      for (const group of groupCases(statement.cases)) {
        this.flow = before;
        const { result, slots } = this.withScope(() => {
          const matchers = group.cases.map((switchCase) => this.compileCaseHead(switchCase, subjectType, before));
          let joined = matchers[0].flow;
          for (const matcher of matchers.slice(1)) joined = Flow.join(joined, matcher.flow);
          this.flow = joined;
          if (group.cases.length > 1)
            this.checkSharedCaseVariables(
              group.cases,
              matchers.map((matcher) => matcher.pattern)
            );
          // A case body may end without `break`; Dart then leaves the switch.
          const body = this.compileStatements(group.statements);
          return { matchers: matchers.map(({ pattern, guard }) => ({ pattern, guard })), body };
        });
        after = after ? Flow.join(after, this.flow) : this.flow;
        groups.push({ ...result, slots, labels: group.labels });
      }
    } finally {
      this.fn.switchDepth--;
      this.fn.labels.splice(
        this.fn.labels.length - labels.length - caseLabels.length,
        labels.length + caseLabels.length
      );
    }
    return { groups, after };
  }

  private isSwitchExhaustive(statement: Extract<Statement, { kind: 'switch' }>, subjectType: DartType): boolean {
    if (statement.cases.some((switchCase) => switchCase.pattern === undefined)) return true;
    return checkExhaustive(
      this,
      subjectType,
      statement.cases
        .filter((switchCase) => switchCase.guard === undefined)
        .map((switchCase) => switchCase.pattern as Pattern),
      statement,
      true
    );
  }

  private compileCaseHead(
    switchCase: SwitchCase,
    subjectType: DartType,
    before: Flow
  ): { pattern: CompiledPattern | undefined; guard: Eval | undefined; flow: Flow } {
    this.flow = before;
    if (!switchCase.pattern) return { pattern: undefined, guard: undefined, flow: before };
    const pattern = this.compilePattern(switchCase.pattern, subjectType, { mode: 'match', isFinal: false });
    for (const variable of pattern.variables.values()) this.flow = this.flow.assign(variable);
    let guard: Eval | undefined;
    if (switchCase.guard) {
      const compiled = this.compileCondition(switchCase.guard);
      guard = compiled.compiled.run;
      this.flow = compiled.flow.whenTrue;
    }
    return { pattern, guard, flow: this.flow };
  }

  /** Cases that share a body must declare the same variables, which the body may then use. */
  private checkSharedCaseVariables(cases: SwitchCase[], patterns: (CompiledPattern | undefined)[]): void {
    const first = patterns[0]?.variables;
    for (const [index, pattern] of patterns.entries()) {
      const names = [...(pattern?.variables.keys() ?? [])].toSorted().join(',');
      if (names !== [...(first?.keys() ?? [])].toSorted().join(',')) {
        // Variables not declared by every case are not in scope in the shared body; Dart reports uses of them.
        void cases[index];
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- on/catch clauses, rethrow, and finally.
  // code-gauge-allow functionNcss 43 -- on/catch clauses, rethrow, and finally.
  protected compileTry(statement: Extract<Statement, { kind: 'try' }>): Exec {
    const before = this.flow;
    const body = this.compileBlock(statement.body);
    let after = this.flow;
    const exceptionalFlow = before.forget(this.writtenLocals(statement.body));
    const catches = statement.catches.map((clause) => {
      this.flow = exceptionalFlow;
      const compiled = this.compileCatch(clause);
      after = Flow.join(after, this.flow);
      return compiled;
    });
    const finallyExec = this.compileFinally(statement, before, after, (block) => this.compileBlock(block));
    const tryCatch: Exec =
      catches.length === 0
        ? body
        : (frame) => {
            const mark = frame.temporaries.length;
            try {
              return body(frame);
            } catch (error) {
              if (!(error instanceof DartThrow)) throw error;
              frame.temporaries.length = mark;
              for (const handler of catches) {
                if (handler.matches(frame, error.value)) return handler.run(frame, error);
              }
              throw error;
            }
          };
    if (!finallyExec) return tryCatch;
    const runFinally = finallyExec;
    return (frame) => {
      let completion: Completion | undefined;
      try {
        completion = tryCatch(frame);
      } catch (error) {
        if (!(error instanceof DartThrow)) throw error;
        const finallyCompletion = runFinally(frame);
        if (finallyCompletion) return finallyCompletion;
        throw error;
      }
      const finallyCompletion = runFinally(frame);
      return finallyCompletion ?? completion;
    };
  }

  private compileFinally<T>(
    statement: Extract<Statement, { kind: 'try' }>,
    before: Flow,
    afterTry: Flow,
    compile: (block: Block) => T
  ): T | undefined {
    const block = statement.finally;
    this.flow = afterTry;
    if (!block) return undefined;

    const tryBlocks = [statement.body, ...statement.catches.map((clause) => clause.body)];
    this.flow = Flow.join(afterTry, before.forget(this.writtenLocals(tryBlocks)));
    const run = compile(block);
    const afterFinally = this.flow;
    const promotions = new Map(afterTry.forget(this.writtenLocals(block)).promotions);
    for (const [variable, type] of afterFinally.promotions) {
      const promoted = promotions.get(variable);
      if (!promoted || isSubtype(type, promoted)) promotions.set(variable, type);
    }
    this.flow = new Flow(
      afterTry.reachable && afterFinally.reachable,
      promotions,
      new Set([...afterTry.assigned, ...afterFinally.assigned]),
      new Set([...afterTry.maybeAssigned, ...afterFinally.maybeAssigned])
    );
    return run;
  }

  private compileCatch(clause: CatchClause): {
    matches: (frame: Frame, value: Value) => boolean;
    run: (frame: Frame, error: DartThrow) => Completion | undefined;
  } {
    const { matches, enter, leave, body } = this.compileCatchClause(clause, (block) => this.compileBlock(block));
    return {
      matches,
      run: (frame, error) => {
        enter(frame, error);
        try {
          return body(frame);
        } finally {
          leave(frame);
        }
      },
    };
  }

  /** A catch clause whose body compiles as `compileBody` does, as a statement or as part of a sync* body. */
  private compileCatchClause<B>(
    clause: CatchClause,
    compileBody: (block: Block) => B
  ): {
    matches: (frame: Frame, value: Value) => boolean;
    enter: (frame: Frame, error: DartThrow) => void;
    leave: (frame: Frame) => void;
    body: B;
  } {
    const type = clause.type ? this.resolveType(clause.type) : undefined;
    const resolve = type ? this.runtimeType(type) : undefined;
    const { result, slots } = this.withScope(() => {
      const exceptionType = type ?? interfaceType(coreTypes.object);
      const exception = clause.exception
        ? this.declareLocal(clause, clause.exception, exceptionType, {
            isFinal: true,
            isLate: false,
            isConst: false,
            isParameter: false,
            hasInitializer: true,
          })
        : undefined;
      const stackTrace = clause.stackTrace
        ? this.declareLocal(clause, clause.stackTrace, interfaceType(coreTypes.stackTrace), {
            isFinal: true,
            isLate: false,
            isConst: false,
            isParameter: false,
            hasInitializer: true,
          })
        : undefined;
      const thrownSlot = this.fn.allocateSlot();
      this.fn.info.locals[thrownSlot] = { name: '\0', type: DYNAMIC };
      this.rethrowSlots.push(thrownSlot);
      this.fn.catchDepth++;
      try {
        const body = compileBody(clause.body);
        return { body, exception, stackTrace, thrownSlot };
      } finally {
        this.fn.catchDepth--;
        this.rethrowSlots.pop();
      }
    });
    const { body, exception, stackTrace, thrownSlot } = result;
    return {
      matches: (frame, value) => !resolve || this.valueIsAt(frame, value, resolve(frame)),
      enter: (frame, error) => {
        frame.locals[thrownSlot] = new Cell(error as unknown as Value);
        if (exception) frame.locals[exception.slot] = new Cell(error.value);
        if (stackTrace) frame.locals[stackTrace.slot] = new Cell(this.stackTraceValue(frame, error));
      },
      leave: (frame) => {
        for (const slot of [...slots, thrownSlot]) frame.locals[slot] = undefined;
      },
      body,
    };
  }

  protected compileRethrow(statement: Extract<Statement, { kind: 'rethrow' }>): Exec {
    const slot = this.rethrowSlots.at(-1);
    if (slot === undefined || this.fn.catchDepth === 0)
      return this.error(statement, 'rethrow は catch の中にしか書けません。');
    this.flow = this.flow.unreachable;
    return (frame) => {
      throw (frame.locals[slot] as Cell).v as unknown as DartThrow;
    };
  }

  protected compileGeneratorBody(spec: FunctionSpec, expectedReturn: DartType | undefined): (frame: Frame) => Value {
    if (spec.body.kind === 'expression') return this.error(spec.body, 'sync* の関数には、=> の本体は書けません。');
    const elementType = expectedReturn ? iterableElementOf(expectedReturn) : undefined;
    if (expectedReturn && !elementType && expectedReturn.kind !== 'dynamic') {
      this.error(spec.span, 'sync* の関数の戻り値の型は、Iterable でなければなりません。');
    }
    this.fn.yieldElement = elementType;
    const body = this.compileGenBlock(spec.body.block);
    const resolveElement = this.runtimeType(elementType ?? DYNAMIC);
    return (frame) => this.makeSyncStarIterable(frame, resolveElement(frame), body);
  }

  private compileGenBlock(block: Block): GenExec {
    const { result, slots } = this.withScope(() => {
      const compiled = block.statements.map((statement) => this.compileGenStatement(statement));
      return function* (frame: Frame): Generator<Value, Completion | undefined, undefined> {
        for (const exec of compiled) {
          const completion = yield* exec(frame);
          if (completion) return completion;
        }
        return undefined;
      };
    });
    return clearingSlots(result, slots);
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- One case per statement that may yield, in a sync* body.
  // code-gauge-allow functionNcss 42 -- One case per form of the construct, which reads best together.
  private compileGenStatement(statement: Statement): GenExec {
    switch (statement.kind) {
      case 'yield': {
        return this.compileYield(statement);
      }
      case 'block': {
        return this.compileGenBlock(statement);
      }
      case 'if': {
        if (!containsYield(statement)) break;
        if (statement.casePattern) return this.compileGenIfCase(statement);
        return this.compileGenIf(statement);
      }
      case 'while': {
        if (!containsYield(statement)) break;
        return this.compileGenWhile(statement);
      }
      case 'for': {
        if (!containsYield(statement)) break;
        return this.compileGenFor(statement);
      }
      case 'forIn': {
        if (!containsYield(statement)) break;
        return this.compileGenForIn(statement);
      }
      case 'labeled': {
        if (!containsYield(statement)) break;
        return this.compileGenLabeled(statement);
      }
      case 'try': {
        if (!containsYield(statement)) break;
        return this.compileGenTry(statement);
      }
      case 'switch':
      case 'do': {
        if (containsYield(statement)) return this.unsupported(statement, 'sync* の中の、yield を含むこの文');
        break;
      }
      default: {
        break;
      }
    }
    const exec = this.compileStatement(statement);
    // oxlint-disable-next-line require-yield -- A statement without yield runs as one step of the generator.
    return function* (frame) {
      return exec(frame);
    };
  }

  /** try in a sync* body: a body that yields runs in the generator, and an abandoned iterator skips `finally`. */
  // code-gauge-allow functionNcss 46 -- A try statement in a generator: its body, catch clauses, and finally, as compileTry.
  // code-gauge-allow functionCognitiveComplexity 21 -- A try statement in a generator: its body, catch clauses, and finally, as compileTry.
  private compileGenTry(statement: Extract<Statement, { kind: 'try' }>): GenExec {
    const before = this.flow;
    const body = this.compileGenBlock(statement.body);
    let after = this.flow;
    const exceptionalFlow = before.forget(this.writtenLocals(statement.body));
    const catches = statement.catches.map((clause) => {
      this.flow = exceptionalFlow;
      const compiled = this.compileCatchClause(clause, (block) => this.compileGenBlock(block));
      after = Flow.join(after, this.flow);
      return compiled;
    });
    const finallyBody = this.compileFinally(statement, before, after, (block) => this.compileGenBlock(block));
    const tryCatch: GenExec = function* (frame) {
      const mark = frame.temporaries.length;
      try {
        return yield* body(frame);
      } catch (error) {
        if (!(error instanceof DartThrow)) throw error;
        frame.temporaries.length = mark;
        const handler = catches.find((candidate) => candidate.matches(frame, error.value));
        if (!handler) throw error;
        handler.enter(frame, error);
        try {
          return yield* handler.body(frame);
        } finally {
          handler.leave(frame);
        }
      }
    };
    if (!finallyBody) return tryCatch;
    const runFinally = finallyBody;
    return function* (frame) {
      let completion: Completion | undefined | void;
      try {
        completion = yield* tryCatch(frame);
      } catch (error) {
        if (!(error instanceof DartThrow)) throw error;
        const finallyCompletion = yield* runFinally(frame);
        if (finallyCompletion) return finallyCompletion;
        throw error;
      }
      const finallyCompletion = yield* runFinally(frame);
      return finallyCompletion ?? completion;
    };
  }

  private compileGenLabeled(statement: Extract<Statement, { kind: 'labeled' }>): GenExec {
    const { labels, body } = statement;
    const isLoop = ['for', 'forIn', 'while', 'do', 'switch'].includes(body.kind);
    if (isLoop) this.pendingLabels = labels;
    for (const label of labels) if (!isLoop) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: false });
    this.breakFlows.push(undefined);
    let exec: GenExec;
    try {
      exec = this.compileGenStatement(body);
    } finally {
      if (!isLoop) this.fn.labels.splice(this.fn.labels.length - labels.length, labels.length);
      this.pendingLabels = [];
    }
    const breakFlow = this.breakFlows.pop();
    if (breakFlow) this.flow = Flow.join(this.flow, breakFlow);
    return function* (frame) {
      const completion = yield* exec(frame);
      if (completion?.kind === 'break' && completion.label !== undefined && labels.includes(completion.label)) return;
      return completion;
    };
  }

  private compileGenIf(statement: Extract<Statement, { kind: 'if' }>): GenExec {
    const { compiled: condition, flow } = this.compileCondition(statement.condition);
    this.flow = flow.whenTrue;
    const consequence = this.compileGenScoped(statement.consequence);
    const afterThen = this.flow;
    this.flow = flow.whenFalse;
    const { alternative } = statement;
    const otherwise = alternative ? this.compileGenScoped(alternative) : undefined;
    this.flow = Flow.join(afterThen, this.flow);
    const test = condition.run;
    return function* (frame) {
      if (test(frame)) return yield* consequence(frame);
      if (otherwise) return yield* otherwise(frame);
      return;
    };
  }

  private compileGenIfCase(statement: Extract<Statement, { kind: 'if' }>): GenExec {
    const { match, consequence, otherwise, slots } = this.compileIfCaseParts(statement, (body) =>
      this.compileGenScoped(body)
    );
    return function* (frame) {
      try {
        if (match(frame)) return yield* consequence(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
      if (otherwise) return yield* otherwise(frame);
      return;
    };
  }

  // code-gauge-allow duplicateLines 21 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private compileGenWhile(statement: Extract<Statement, { kind: 'while' }>): GenExec {
    const labels = this.takeLoopLabels();
    this.enterLoop(statement);
    const { compiled: condition, flow } = this.compileCondition(statement.condition);
    this.flow = flow.whenTrue;
    const body = this.compileGenLoopBody(statement.body, labels);
    this.flow = flow.whenFalse;
    const test = condition.run;
    return function* (frame) {
      while (test(frame)) {
        const completion = yield* body(frame);
        if (completion) {
          const outcome = loopCompletion(completion, labels);
          if (outcome !== 'continue') return outcome;
        }
        frame.runtime.spend();
      }
      return;
    };
  }

  private compileGenScoped(statement: Statement): GenExec {
    if (statement.kind === 'block') return this.compileGenBlock(statement);
    const { result, slots } = this.withScope(() => this.compileGenStatement(statement));
    return clearingSlots(result, slots);
  }

  private compileGenFor(statement: Extract<Statement, { kind: 'for' }>): GenExec {
    const labels = this.takeLoopLabels();
    const { result, slots } = this.withScope(() => {
      const { initExec, initRow, loopVariables } = this.compileForInit(statement);
      this.enterLoop(statement);
      const condition = statement.condition ? this.compileCondition(statement.condition) : undefined;
      if (condition) this.flow = condition.flow.whenTrue;
      const body = this.compileGenLoopBody(statement.body, labels);
      const updates = statement.updates.map((update) => this.compileExpression(update).run);
      if (condition) this.flow = condition.flow.whenFalse;
      return genForLoop({
        initExec,
        initRow,
        test: condition?.compiled.run,
        body,
        updates,
        labels,
        loopSlots: loopVariables.map((variable) => variable.slot),
        updateRow: updates.length > 0 ? this.stepRowOf(statement) : undefined,
      });
    });
    return clearingSlots(result, slots);
  }

  // code-gauge-allow duplicateLines 15 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  // code-gauge-allow functionCognitiveComplexity 19 -- Each branch is one of the cases Dart distinguishes for this construct.
  private compileGenForIn(statement: Extract<Statement, { kind: 'forIn' }>): GenExec {
    const labels = this.takeLoopLabels();
    const iterable = this.compileExpression(statement.iterable);
    const elementType = this.elementTypeOfIterable(iterable, statement.iterable);
    const { result, slots } = this.withScope(() => {
      this.enterLoop(statement);
      const before = this.flow;
      const bind = this.compileForInBinding(statement.binding, elementType, statement);
      const body = this.compileGenLoopBody(statement.body, labels);
      this.flow = before;
      const source = iterable.run;
      return function* (frame: Frame): Generator<Value, Completion | undefined, undefined> {
        const { runtime } = frame;
        const values = source(frame);
        const iterator = runtime.getProperty(values, 'iterator', undefined);
        frame.temporaries.push(iterator);
        try {
          for (;;) {
            if (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) !== true)
              return undefined;
            bind(frame, runtime.getProperty(iterator, 'current', undefined));
            const completion = yield* body(frame);
            if (completion) {
              const outcome = loopCompletion(completion, labels);
              if (outcome !== 'continue') return outcome;
            }
          }
        } finally {
          const index = frame.temporaries.lastIndexOf(iterator);
          if (index !== -1) frame.temporaries.splice(index, 1);
        }
      };
    });
    return clearingSlots(result, slots);
  }

  private compileGenLoopBody(body: Statement, labels: string[]): GenExec {
    this.fn.loopDepth++;
    for (const label of labels) this.fn.labels.push({ name: label, isLoop: true, isSwitchCase: false });
    this.breakFlows.push(undefined);
    try {
      return this.compileGenScoped(body);
    } finally {
      this.fn.loopDepth--;
      this.fn.labels.splice(this.fn.labels.length - labels.length, labels.length);
      this.breakFlows.pop();
    }
  }

  // code-gauge-allow functionNcss 37 -- One case per form of the construct, which reads best together.
  private compileYield(statement: Extract<Statement, { kind: 'yield' }>): GenExec {
    if (!this.fn.kind.isGenerator) return this.error(statement, 'yield は sync* の関数の中にしか書けません。');
    const elementType = this.fn.yieldElement;
    const context = statement.isEach
      ? elementType
        ? interfaceType(coreTypes.iterable, [elementType])
        : undefined
      : elementType;
    let compiled = this.compileExpression(statement.value, context);
    if (statement.isEach) {
      const element = this.elementTypeOfIterable(compiled, statement.value);
      this.fn.yieldTypes?.push(element);
      compiled = this.coerce(
        compiled,
        context ?? interfaceType(coreTypes.iterable, [DYNAMIC]),
        statement.value,
        (from, to) => `${from} 型の値は、${to} 型の Iterable に yield* できません。`
      );
      const { run } = compiled;
      const row = this.stepRowOf(statement);
      return function* (frame) {
        const { runtime } = frame;
        const values = run(frame);
        const mark = frame.temporaries.length;
        frame.temporaries.push(values);
        try {
          const iterator = runtime.getProperty(values, 'iterator', undefined);
          frame.temporaries.push(iterator);
          while (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) === true) {
            if (row !== undefined) runtime.steps.step(row);
            yield runtime.getProperty(iterator, 'current', undefined);
          }
        } finally {
          frame.temporaries.length = mark;
        }
        return;
      };
    }
    this.fn.yieldTypes?.push(compiled.type);
    if (elementType) {
      compiled = this.coerce(
        compiled,
        elementType,
        statement.value,
        (from, to) => `${from} 型の値は、${to} 型の Iterable に yield できません。`
      );
    }
    const { run } = compiled;
    const row = this.stepRowOf(statement);
    return function* (frame) {
      const value = run(frame);
      if (row !== undefined) frame.runtime.steps.step(row);
      yield value;
      return;
    };
  }
}

function genForLoop(loop: CountedLoop<GenExec>): GenExec {
  const { test, body, labels } = loop;
  return function* (frame: Frame): Generator<Value, Completion | undefined, undefined> {
    startCountedLoop(loop, frame);
    for (;;) {
      if (test && !test(frame)) return undefined;
      const completion = yield* body(frame);
      if (completion) {
        const outcome = loopCompletion(completion, labels);
        if (outcome !== 'continue') return outcome;
      }
      advanceCountedLoop(loop, frame);
    }
  };
}

/** Clears the slots of a scope's variables once its statements finish, so that traces stop showing them. */
function clearingSlots(result: GenExec, slots: number[]): GenExec {
  if (slots.length === 0) return result;
  return function* (frame) {
    try {
      return yield* result(frame);
    } finally {
      for (const slot of slots) frame.locals[slot] = undefined;
    }
  };
}

interface SwitchGroup {
  matchers: { pattern: CompiledPattern | undefined; guard: Eval | undefined }[];
  body: Exec;
  slots: number[];
  labels: string[];
}

/** The index of the first group with a case that matches, clearing the variables of the groups that do not. */
function selectSwitchGroup(frame: Frame, value: Value, groups: readonly SwitchGroup[]): number {
  for (const [index, group] of groups.entries()) {
    const matches = group.matchers.some(
      (matcher) =>
        !matcher.pattern || (matcher.pattern.match(frame, value) && (!matcher.guard || matcher.guard(frame) === true))
    );
    if (matches) return index;
    for (const slot of group.slots) frame.locals[slot] = undefined;
  }
  return -1;
}

/** Runs a group's body, and the bodies that `continue label;` jumps to. */
function runSwitchFrom(
  frame: Frame,
  start: number,
  groups: readonly SwitchGroup[],
  labels: readonly string[]
): Completion | undefined {
  let index = start;
  while (index >= 0) {
    const group = groups[index];
    let completion: Completion | undefined;
    try {
      completion = group.body(frame);
    } finally {
      for (const slot of group.slots) frame.locals[slot] = undefined;
    }
    if (!completion) return undefined;
    if (completion.kind === 'break' && (completion.label === undefined || labels.includes(completion.label)))
      return undefined;
    if (completion.kind !== 'continue' || completion.label === undefined) return completion;
    const label = completion.label;
    const target = groups.findIndex((other) => other.labels.includes(label));
    if (target === -1) return completion;
    index = target;
  }
  return undefined;
}

function groupCases(cases: SwitchCase[]): { cases: SwitchCase[]; statements: Statement[]; labels: string[] }[] {
  const groups: { cases: SwitchCase[]; statements: Statement[]; labels: string[] }[] = [];
  let pending: SwitchCase[] = [];
  for (const switchCase of cases) {
    pending.push(switchCase);
    if (switchCase.statements.length > 0 || switchCase === cases.at(-1)) {
      groups.push({
        cases: pending,
        statements: switchCase.statements,
        labels: pending.flatMap((entry) => entry.labels),
      });
      pending = [];
    }
  }
  return groups;
}

function containsYield(node: unknown): boolean {
  if (Array.isArray(node)) return node.some((item) => containsYield(item));
  if (typeof node !== 'object' || node === null) return false;
  const record = node as { kind?: string };
  if (record.kind === 'yield') return true;
  if (record.kind === 'function' || record.kind === 'localFunction') return false;
  return Object.values(record).some((value) => typeof value === 'object' && containsYield(value));
}
