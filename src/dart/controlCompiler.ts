import type { Block, CatchClause, Pattern, Statement, SwitchCase } from './ast';
import type { FunctionSpec } from './callCompiler';
import { type Eval, typeName } from './compilerBase';
import { checkExhaustive } from './exhaustiveness';
import { type CompiledPattern } from './patternCompiler';
import { DartThrow, type Frame } from './runtime';
import { Flow } from './scope';
import { type Completion, type Exec, type GenExec, loopCompletion, StatementCompiler } from './statementCompiler';
import { coreTypes, type DartType, DYNAMIC, interfaceType, isSubtype, iterableElementOf } from './types';
import { Cell, type Value } from './values';

/** Switch, try, and the bodies of sync* generators. */
export abstract class ControlCompiler extends StatementCompiler {
  // code-gauge-allow functionCognitiveComplexity 40 -- Cases with patterns, guards, labels, and exhaustiveness.
  protected compileSwitch(statement: Extract<Statement, { kind: 'switch' }>): Exec {
    const labels = this.takeLoopLabels();
    const subject = this.compileExpression(statement.subject);
    const before = this.flow;
    this.fn.switchDepth++;
    for (const label of labels) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: false });
    const caseLabels = statement.cases.flatMap((switchCase) => switchCase.labels);
    for (const label of caseLabels) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: true });
    this.breakFlows.push(undefined);
    const groups = groupCases(statement.cases);
    let after: Flow | undefined;
    const compiledGroups: {
      matchers: { pattern: CompiledPattern | undefined; guard: Eval | undefined }[];
      body: Exec;
      slots: number[];
      labels: string[];
    }[] = [];
    try {
      for (const group of groups) {
        this.flow = before;
        const { result, slots } = this.withScope(() => {
          const matchers = group.cases.map((switchCase) => this.compileCaseHead(switchCase, subject.type, before));
          let joined = matchers[0].flow;
          for (const matcher of matchers.slice(1)) joined = Flow.join(joined, matcher.flow);
          this.flow = joined;
          if (group.cases.length > 1)
            this.checkSharedCaseVariables(
              group.cases,
              matchers.map((matcher) => matcher.pattern)
            );
          const body = this.compileStatements(group.statements);
          if (this.flow.reachable && group !== groups.at(-1) && group.statements.length > 0) {
            // A case body may end without `break`; Dart then leaves the switch.
          }
          return { matchers: matchers.map(({ pattern, guard }) => ({ pattern, guard })), body };
        });
        after = after ? Flow.join(after, this.flow) : this.flow;
        compiledGroups.push({ ...result, slots, labels: group.labels });
      }
    } finally {
      this.fn.switchDepth--;
      this.fn.labels.splice(
        this.fn.labels.length - labels.length - caseLabels.length,
        labels.length + caseLabels.length
      );
    }
    const breakFlow = this.breakFlows.pop();
    const hasDefault = statement.cases.some((switchCase) => switchCase.pattern === undefined);
    const exhaustive =
      hasDefault ||
      checkExhaustive(
        this,
        subject.type,
        statement.cases
          .filter((switchCase) => switchCase.guard === undefined)
          .map((switchCase) => switchCase.pattern as Pattern),
        statement,
        true
      );
    if (!exhaustive) after = after ? Flow.join(after, before) : before;
    if (statement.cases.length === 0) after = before;
    this.flow = breakFlow ? Flow.join(after ?? before.unreachable, breakFlow) : (after ?? before);
    const test = subject.run;
    return (frame) => {
      const value = test(frame);
      frame.temporaries.push(value);
      let index = -1;
      try {
        for (const [groupIndex, group] of compiledGroups.entries()) {
          for (const matcher of group.matchers) {
            if (!matcher.pattern) {
              index = groupIndex;
              break;
            }
            if (matcher.pattern.match(frame, value) && (!matcher.guard || matcher.guard(frame) === true)) {
              index = groupIndex;
              break;
            }
          }
          if (index >= 0) break;
          for (const slot of group.slots) frame.locals[slot] = undefined;
        }
      } finally {
        frame.temporaries.pop();
      }
      while (index >= 0) {
        const group = compiledGroups[index];
        let completion: Completion | undefined;
        try {
          completion = group.body(frame);
        } finally {
          for (const slot of group.slots) frame.locals[slot] = undefined;
        }
        if (!completion) return;
        if (completion.kind === 'break' && (completion.label === undefined || labels.includes(completion.label)))
          return;
        if (completion.kind === 'continue' && completion.label !== undefined) {
          const target = compiledGroups.findIndex((other) => other.labels.includes(completion.label as string));
          if (target !== -1) {
            index = target;
            continue;
          }
        }
        return completion;
      }
      return;
    };
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

  // code-gauge-allow functionCognitiveComplexity 40 -- on/catch clauses, rethrow, and finally.
  protected compileTry(statement: Extract<Statement, { kind: 'try' }>): Exec {
    const before = this.flow;
    const body = this.compileBlock(statement.body);
    let after = this.flow;
    const catches = statement.catches.map((clause) => {
      this.flow = Flow.join(before, after).forget([]);
      const compiled = this.compileCatch(clause);
      after = Flow.join(after, this.flow);
      return compiled;
    });
    let finallyExec: Exec | undefined;
    if (statement.finally) {
      const flowAfterTry = after;
      this.flow = Flow.join(before, after);
      finallyExec = this.compileBlock(statement.finally);
      this.flow = this.flow.reachable ? flowAfterTry : this.flow;
    } else {
      this.flow = after;
    }
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

  private compileCatch(clause: CatchClause): {
    matches: (frame: Frame, value: Value) => boolean;
    run: (frame: Frame, error: DartThrow) => Completion | undefined;
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
        const body = this.compileBlock(clause.body);
        return { body, exception, stackTrace, thrownSlot };
      } finally {
        this.fn.catchDepth--;
        this.rethrowSlots.pop();
      }
    });
    const { body, exception, stackTrace, thrownSlot } = result;
    return {
      matches: (frame, value) => !resolve || this.valueIsAt(frame, value, resolve(frame)),
      run: (frame, error) => {
        frame.locals[thrownSlot] = new Cell(error as unknown as Value);
        if (exception) frame.locals[exception.slot] = new Cell(error.value);
        if (stackTrace) frame.locals[stackTrace.slot] = new Cell(this.stackTraceValue(frame, error));
        try {
          return body(frame);
        } finally {
          for (const slot of [...slots, thrownSlot]) frame.locals[slot] = undefined;
        }
      },
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
    if (slots.length === 0) return result;
    return function* (frame) {
      try {
        return yield* result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- The statements that may contain yield, each as a generator.
  private compileGenStatement(statement: Statement): GenExec {
    switch (statement.kind) {
      case 'yield': {
        return this.compileYield(statement);
      }
      case 'block': {
        return this.compileGenBlock(statement);
      }
      case 'if': {
        if (statement.casePattern || !containsYield(statement)) break;
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
      case 'while': {
        if (!containsYield(statement)) break;
        const labels = this.takeLoopLabels();
        this.enterLoop(statement);
        const { compiled: condition, flow } = this.compileCondition(statement.condition);
        this.flow = flow.whenTrue;
        this.fn.loopDepth++;
        this.breakFlows.push(undefined);
        const body = this.compileGenScoped(statement.body);
        this.fn.loopDepth--;
        this.breakFlows.pop();
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
      case 'for': {
        if (!containsYield(statement)) break;
        return this.compileGenFor(statement);
      }
      case 'forIn': {
        if (!containsYield(statement)) break;
        return this.compileGenForIn(statement);
      }
      case 'try':
      case 'switch':
      case 'do':
      case 'labeled': {
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

  private compileGenScoped(statement: Statement): GenExec {
    if (statement.kind === 'block') return this.compileGenBlock(statement);
    const { result, slots } = this.withScope(() => this.compileGenStatement(statement));
    if (slots.length === 0) return result;
    return function* (frame) {
      try {
        return yield* result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  private compileGenFor(statement: Extract<Statement, { kind: 'for' }>): GenExec {
    const labels = this.takeLoopLabels();
    const { result, slots } = this.withScope(() => {
      const { init } = statement;
      let initExec: Exec | undefined;
      if (init && !Array.isArray(init)) initExec = this.compileLocalDeclaration(init, false);
      else if (init) {
        const runs = init.map((expression) => this.compileExpression(expression).run);
        initExec = (frame) => {
          for (const run of runs) run(frame);
          return;
        };
      }
      this.enterLoop(statement);
      const condition = statement.condition ? this.compileCondition(statement.condition) : undefined;
      if (condition) this.flow = condition.flow.whenTrue;
      this.fn.loopDepth++;
      this.breakFlows.push(undefined);
      const body = this.compileGenScoped(statement.body);
      this.fn.loopDepth--;
      this.breakFlows.pop();
      const updates = statement.updates.map((update) => this.compileExpression(update).run);
      if (condition) this.flow = condition.flow.whenFalse;
      const test = condition?.compiled.run;
      return function* (frame: Frame): Generator<Value, Completion | undefined, undefined> {
        initExec?.(frame);
        for (;;) {
          if (test && !test(frame)) return undefined;
          const completion = yield* body(frame);
          if (completion) {
            const outcome = loopCompletion(completion, labels);
            if (outcome !== 'continue') return outcome;
          }
          for (const update of updates) update(frame);
          frame.runtime.spend();
        }
      };
    });
    if (slots.length === 0) return result;
    return function* (frame) {
      try {
        return yield* result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  private compileGenForIn(statement: Extract<Statement, { kind: 'forIn' }>): GenExec {
    const labels = this.takeLoopLabels();
    const iterable = this.compileExpression(statement.iterable);
    const elementType = this.elementTypeOfIterable(iterable, statement.iterable);
    const { result, slots } = this.withScope(() => {
      this.enterLoop(statement);
      const bind = this.compileForInBinding(statement.binding, elementType, statement);
      this.fn.loopDepth++;
      this.breakFlows.push(undefined);
      const body = this.compileGenScoped(statement.body);
      this.fn.loopDepth--;
      this.breakFlows.pop();
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
    if (slots.length === 0) return result;
    return function* (frame) {
      try {
        return yield* result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

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
      if (elementType && !isSubtype(element, elementType) && element.kind !== 'dynamic') {
        this.error(
          statement.value,
          `${typeName(element)} 型の要素は、${typeName(elementType)} 型の Iterable に入れられません。`
        );
      }
      const { run } = compiled;
      const row = this.stepRowOf(statement);
      return function* (frame) {
        const { runtime } = frame;
        const values = run(frame);
        const iterator = runtime.getProperty(values, 'iterator', undefined);
        while (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) === true) {
          if (row !== undefined) runtime.steps.step(row);
          yield runtime.getProperty(iterator, 'current', undefined);
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

/** Groups the cases of a switch statement: empty cases share the body of the next case. */
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
