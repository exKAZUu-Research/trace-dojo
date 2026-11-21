// code-gauge-allow-file fileNcss 596 -- Switches and loops share flow analysis with their generator forms.
import type { Block, CatchClause, Pattern, Span, Statement, SwitchCase } from './ast';
import { localNamesIn } from './astWalk';
import type { FunctionSpec } from './callCompiler';
import type { Compiled, Eval } from './compilerBase';
import { checkExhaustive } from './exhaustiveness';
import { type CompiledPattern, PatternCache } from './patternCompiler';
import { DartThrow, type Frame } from './runtime';
import { Flow, type LocalVar } from './scope';
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
import {
  coreTypes,
  type DartType,
  DYNAMIC,
  interfaceType,
  isSubtype,
  iterableElementOf,
  nonNullable,
  sameType,
} from './types';
import { Cell, type Value } from './values';

/** Switch, try, and the bodies of sync* generators. */
export abstract class ControlCompiler extends StatementCompiler {
  protected compileSwitch(statement: Extract<Statement, { kind: 'switch' }>): Exec {
    const { groups, select, route } = this.compileSwitchPlan(statement, (body) => this.compileStatements(body));
    return (frame) => runSwitchFrom(frame, select(frame), groups, route);
  }

  private compileSwitchPlan<T>(
    statement: Extract<Statement, { kind: 'switch' }>,
    compileBody: (body: Statement[]) => T
  ): { groups: SwitchGroup<T>[]; select: (frame: Frame) => number; route: SwitchRoute } {
    const labels = this.takeLoopLabels();
    const subject = this.compileExpression(statement.subject);
    const before = this.flow;
    this.enterJumpTarget('switch', labels);
    const {
      groups,
      after: afterCases,
      unmatched,
    } = this.compileSwitchGroups(statement, this.switchSubject(subject, statement.cases), before, labels, compileBody);
    let after = afterCases;
    const breakFlow = this.fn.jumpTargets.pop()?.breakFlow;
    if (!this.isSwitchExhaustive(statement, subject.type)) after = after ? Flow.join(after, unmatched) : unmatched;
    if (statement.cases.length === 0) after = before;
    this.flow = breakFlow ? Flow.join(after ?? before.unreachable, breakFlow) : (after ?? before);
    const test = subject.run;
    const select = (frame: Frame): number => {
      const value = test(frame);
      frame.temporaries.push(value);
      try {
        return PatternCache.run(frame, (cache) => selectSwitchGroup(frame, value, groups, cache));
      } finally {
        frame.temporaries.pop();
      }
    };
    return { groups, select, route: (completion) => routeSwitchCompletion(completion, labels, groups) };
  }

  /** The groups of cases that share a body, each in a scope of its own, with the labels the switch declares. */
  private compileSwitchGroups<T>(
    statement: Extract<Statement, { kind: 'switch' }>,
    subject: Compiled,
    before: Flow,
    labels: string[],
    compileBody: (body: Statement[]) => T
  ): { groups: SwitchGroup<T>[]; after: Flow | undefined; unmatched: Flow } {
    this.fn.switchDepth++;
    for (const label of labels) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: false });
    const caseLabels = statement.cases.flatMap((switchCase) => switchCase.labels);
    for (const label of caseLabels) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: true });
    let after: Flow | undefined;
    let unmatched = before;
    const groups: SwitchGroup<T>[] = [];
    try {
      for (const group of groupCases(statement.cases)) {
        this.flow = unmatched;
        const { result, slots } = this.withScope(() => {
          const compiled = this.compileSwitchMatchers(group.cases, subject, unmatched, group.labels.length > 0);
          unmatched = compiled.unmatched;
          if (group.labels.length > 0) this.flow = Flow.join(this.flow, before);
          const body = compileBody(group.statements);
          return { matchers: compiled.matchers, body };
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
    return { groups, after, unmatched };
  }

  private compileSwitchMatchers(
    cases: SwitchCase[],
    subject: Compiled,
    before: Flow,
    hasLabel: boolean
  ): { matchers: SwitchMatcher[]; unmatched: Flow } {
    let unmatched = before;
    const compileHead = (switchCase: SwitchCase): ReturnType<ControlCompiler['compileCaseHead']> => {
      const head = this.compileCaseHead(switchCase, subject, unmatched);
      unmatched = head.whenFalse;
      return head;
    };
    if (cases.length === 1 && !hasLabel) {
      const { pattern, guard, flow } = compileHead(cases[0]);
      this.flow = flow;
      return { matchers: [{ pattern, guard, slots: [], bindings: [] }], unmatched };
    }
    const heads = cases.map((switchCase) => this.withScope(() => compileHead(switchCase)));
    let joined = heads[0].result.flow;
    for (const head of heads.slice(1)) joined = Flow.join(joined, head.result.flow);
    this.flow = joined;
    const variables = this.sharedCaseVariables(
      cases[0],
      heads.map(({ result }) => result.pattern),
      hasLabel
    );
    const matchers = heads.map(({ result: { pattern, guard }, slots: headSlots }): SwitchMatcher => ({
      pattern,
      guard,
      slots: headSlots,
      bindings: variables.flatMap((variable) => {
        const binding = pattern?.variables.get(variable.name);
        return binding ? [{ from: binding.slot, to: variable.slot }] : [];
      }),
    }));
    return { matchers, unmatched };
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
    subject: Compiled,
    before: Flow
  ): { pattern: CompiledPattern | undefined; guard: Eval | undefined; flow: Flow; whenFalse: Flow } {
    this.flow = before;
    if (!switchCase.pattern) return { pattern: undefined, guard: undefined, flow: before, whenFalse: before };
    const matched = this.compileCasePattern(switchCase.pattern, subject, switchCase.guard);
    return { ...matched, flow: this.flow };
  }

  private sharedCaseVariables(span: Span, patterns: (CompiledPattern | undefined)[], hasLabel: boolean): LocalVar[] {
    const known = new Map(patterns.flatMap((pattern) => [...(pattern?.variables ?? [])]));
    const variables: LocalVar[] = [];
    for (const [name, example] of known) {
      const variable = this.declareLocal(span, name, example.type, example.options);
      if (hasLabel || patterns.some((pattern) => !pattern?.variables.has(name))) {
        variable.unavailable = `変数 ${name} は、この case の本体のすべての入口で使えるわけではありません。`;
        continue;
      }
      const matches = patterns.every((pattern) => {
        const other = pattern?.variables.get(name);
        return other && other.options.isFinal === example.options.isFinal && sameType(other.type, example.type);
      });
      if (!matches) {
        variable.unavailable = `変数 ${name} の型と final は、同じ本体を持つすべての case でそろえてください。`;
        continue;
      }
      this.flow = this.flow.assign(variable);
      variables.push(variable);
    }
    return variables;
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- on/catch clauses, rethrow, and finally.
  // code-gauge-allow functionNcss 43 -- on/catch clauses, rethrow, and finally.
  // code-gauge-allow duplicateLines 18 -- A synchronous finally and a yielding finally preserve the same pending completions.
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
      let completion: Completion | DartThrow | undefined;
      try {
        completion = tryCatch(frame);
      } catch (error) {
        if (!(error instanceof DartThrow)) throw error;
        completion = error;
      }
      const mark = rootCompletion(frame, completion);
      try {
        const finallyCompletion = runFinally(frame);
        if (finallyCompletion) return finallyCompletion;
        if (completion instanceof DartThrow) throw completion;
        return completion;
      } finally {
        frame.temporaries.length = mark;
      }
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
    for (const [variable, chain] of afterFinally.promotions) {
      const existing = promotions.get(variable) ?? [];
      const current = existing.at(-1);
      const narrowed = current ? chain.filter((type) => isSubtype(type, current) && !sameType(type, current)) : chain;
      if (narrowed.length > 0) promotions.set(variable, [...existing, ...narrowed]);
    }
    this.flow = new Flow(
      afterTry.reachable && afterFinally.reachable,
      promotions,
      new Set([...afterTry.assigned, ...afterFinally.assigned]),
      new Set([...afterTry.maybeAssigned, ...afterFinally.maybeAssigned]),
      afterFinally.writes
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
        if (stackTrace) frame.locals[stackTrace.slot] = new Cell(error.stackTrace);
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
    const elementType = expectedReturn ? iterableElementOf(nonNullable(expectedReturn)) : undefined;
    const iterable = interfaceType(coreTypes.iterable, [elementType ?? DYNAMIC]);
    if (expectedReturn && (spec.returnType?.kind === 'void' || !isSubtype(iterable, expectedReturn))) {
      this.error(spec.span, 'sync* の関数の戻り値の型には、Iterable を代入できる必要があります。');
    }
    this.fn.yieldElement = elementType;
    const body = this.compileGenBlock(spec.body.block);
    if (!spec.returnType && (!elementType || elementType.kind === 'dynamic')) {
      this.fn.yieldElement = this.inferYieldElement(this.fn);
    }
    const resolveElement = this.runtimeType(this.fn.yieldElement ?? DYNAMIC);
    return (frame) => this.makeSyncStarIterable(frame, resolveElement(frame), body);
  }

  private compileGenBlock(block: Block): GenExec {
    const { result, slots } = this.withScope(() => this.compileGenStatements(block.statements));
    return clearingSlots(result, slots);
  }

  private compileGenStatements(statements: Statement[]): GenExec {
    this.reserveLocals(localNamesIn(statements));
    const compiled = statements.map((statement) => this.compileGenStatement(statement));
    return function* (frame) {
      for (const exec of compiled) {
        const completion = yield* exec(frame);
        if (completion) return completion;
      }
      return;
    };
  }

  private compileGenStatement(statement: Statement): GenExec {
    if (statement.kind === 'block') return this.compileGenBlock(statement);
    if (!containsYield(statement)) {
      const exec = this.compileStatement(statement);
      // oxlint-disable-next-line require-yield -- A statement without yield runs as one step of the generator.
      return function* (frame) {
        return exec(frame);
      };
    }
    switch (statement.kind) {
      case 'yield': {
        return this.compileYield(statement);
      }
      case 'if': {
        return statement.casePattern ? this.compileGenIfCase(statement) : this.compileGenIf(statement);
      }
      case 'while': {
        return this.compileGenWhile(statement);
      }
      case 'for': {
        return this.compileGenFor(statement);
      }
      case 'forIn': {
        return this.compileGenForIn(statement);
      }
      case 'labeled': {
        return this.compileGenLabeled(statement);
      }
      case 'try': {
        return this.compileGenTry(statement);
      }
      case 'switch': {
        return this.compileGenSwitch(statement);
      }
      case 'do': {
        return this.compileGenDo(statement);
      }
      default: {
        return this.unsupported(statement, 'sync* の中の、yield を含むこの文');
      }
    }
  }

  private compileGenSwitch(statement: Extract<Statement, { kind: 'switch' }>): GenExec {
    const { groups, select, route } = this.compileSwitchPlan(statement, (body) => this.compileGenStatements(body));
    return function* (frame) {
      frame.runtime.spend();
      let index = select(frame);
      while (index >= 0) {
        const group = groups[index];
        let completion: Completion | void;
        try {
          completion = yield* group.body(frame);
        } finally {
          for (const slot of group.slots) frame.locals[slot] = undefined;
        }
        const next = route(completion);
        if (typeof next !== 'number') return next;
        index = next;
      }
      return;
    };
  }

  /** try in a sync* body: a body that yields runs in the generator, and an abandoned iterator skips `finally`. */
  // code-gauge-allow functionNcss 46 -- A try statement in a generator: its body, catch clauses, and finally, as compileTry.
  // code-gauge-allow functionCognitiveComplexity 21 -- A try statement in a generator: its body, catch clauses, and finally, as compileTry.
  // code-gauge-allow duplicateLines 18 -- A synchronous finally and a yielding finally preserve the same pending completions.
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
      let completion: Completion | DartThrow | undefined | void;
      try {
        completion = yield* tryCatch(frame);
      } catch (error) {
        if (!(error instanceof DartThrow)) throw error;
        completion = error;
      }
      const mark = rootCompletion(frame, completion ?? undefined);
      try {
        const finallyCompletion = yield* runFinally(frame);
        if (finallyCompletion) return finallyCompletion;
        if (completion instanceof DartThrow) throw completion;
        return completion;
      } finally {
        frame.temporaries.length = mark;
      }
    };
  }

  private compileGenLabeled(statement: Extract<Statement, { kind: 'labeled' }>): GenExec {
    const { labels, body } = statement;
    const isLoop = ['for', 'forIn', 'while', 'do', 'switch'].includes(body.kind);
    if (isLoop) this.pendingLabels = labels;
    for (const label of labels) if (!isLoop) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: false });
    this.enterJumpTarget('label', labels);
    let exec: GenExec;
    try {
      exec = this.compileGenStatement(body);
    } finally {
      if (!isLoop) this.fn.labels.splice(this.fn.labels.length - labels.length, labels.length);
      this.pendingLabels = [];
    }
    const breakFlow = this.fn.jumpTargets.pop()?.breakFlow;
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
    const breakFlow = this.fn.jumpTargets.pop()?.breakFlow;
    this.flow = breakFlow ? Flow.join(flow.whenFalse, breakFlow) : flow.whenFalse;
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

  // code-gauge-allow duplicateLines 15 -- The synchronous and yielding loops share flow analysis and differ in how the body resumes.
  private compileGenDo(statement: Extract<Statement, { kind: 'do' }>): GenExec {
    const { labels, body, test } = this.compileDoPlan(statement, (body, labels) =>
      this.compileGenLoopBody(body, labels)
    );
    return function* (frame) {
      do {
        const completion = yield* body(frame);
        if (completion) {
          const outcome = loopCompletion(completion, labels);
          if (outcome !== 'continue') return outcome;
        }
        frame.runtime.spend();
      } while (test(frame));
      return;
    };
  }

  private compileGenScoped(statement: Statement): GenExec {
    if (statement.kind === 'block') return this.compileGenBlock(statement);
    const { result, slots } = this.withScope(() => this.compileGenStatement(statement));
    return clearingSlots(result, slots);
  }

  // code-gauge-allow duplicateLines 21 -- A generator shares the loop header and suspends around the body.
  private compileGenFor(statement: Extract<Statement, { kind: 'for' }>): GenExec {
    const labels = this.takeLoopLabels();
    const { result, slots } = this.withScope(() => {
      const { initExec, initRow, loopVariables } = this.compileForInit(statement);
      this.enterLoop(statement);
      const condition = statement.condition ? this.compileCondition(statement.condition) : undefined;
      const exit = condition?.flow.whenFalse ?? this.flow.unreachable;
      if (condition) this.flow = condition.flow.whenTrue;
      const body = this.compileGenLoopBody(statement.body, labels);
      const target = this.fn.jumpTargets.pop();
      if (target?.continueFlow) this.flow = Flow.join(this.flow, target.continueFlow);
      const updates = statement.updates.map((update) => this.compileExpression(update).run);
      this.flow = target?.breakFlow ? Flow.join(exit, target.breakFlow) : exit;
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
  // code-gauge-allow functionCognitiveComplexity 21 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss 31 -- Iteration retains source state while its body suspends.
  private compileGenForIn(statement: Extract<Statement, { kind: 'forIn' }>): GenExec {
    const labels = this.takeLoopLabels();
    const iterable = this.compileExpression(statement.iterable);
    const elementType = this.elementTypeOfIterable(iterable, statement.iterable);
    const { result, slots } = this.withScope(() => {
      this.enterLoop(statement);
      const before = this.flow;
      const bind = this.compileForInBinding(statement.binding, elementType, statement);
      const body = this.compileGenLoopBody(statement.body, labels);
      const breakFlow = this.fn.jumpTargets.pop()?.breakFlow;
      this.flow = breakFlow ? Flow.join(before, breakFlow) : before;
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
    this.enterJumpTarget('loop', labels);
    try {
      return this.compileGenScoped(body);
    } finally {
      this.fn.loopDepth--;
      this.fn.labels.splice(this.fn.labels.length - labels.length, labels.length);
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

function rootCompletion(frame: Frame, completion: Completion | DartThrow | undefined): number {
  const mark = frame.temporaries.length;
  if (completion instanceof DartThrow) frame.temporaries.push(completion.value, completion.stackTrace);
  else if (completion?.kind === 'return') frame.temporaries.push(completion.value);
  return mark;
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

interface SwitchMatcher {
  pattern: CompiledPattern | undefined;
  guard: Eval | undefined;
  slots: number[];
  bindings: { from: number; to: number }[];
}

interface SwitchGroup<T> {
  matchers: SwitchMatcher[];
  body: T;
  slots: number[];
  labels: string[];
}

type SwitchRoute = (completion: Completion | void) => number | Completion | undefined;

/** The index of the first group with a case that matches, clearing the variables of the groups that do not. */
// code-gauge-allow functionCognitiveComplexity 17 -- Clear the failed matcher while keeping the selected body bindings live.
function selectSwitchGroup(
  frame: Frame,
  value: Value,
  groups: readonly SwitchGroup<unknown>[],
  cache: PatternCache
): number {
  for (const [index, group] of groups.entries()) {
    for (const { pattern, guard, slots, bindings } of group.matchers) {
      try {
        if (pattern && (!pattern.match(frame, value, cache) || (guard && guard(frame) !== true))) continue;
        for (const { from, to } of bindings) frame.locals[to] = new Cell((frame.locals[from] as Cell).v);
        return index;
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    }
    for (const slot of group.slots) frame.locals[slot] = undefined;
  }
  return -1;
}

/** Runs a group's body, and the bodies that `continue label;` jumps to. */
function runSwitchFrom(
  frame: Frame,
  start: number,
  groups: readonly SwitchGroup<Exec>[],
  route: SwitchRoute
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
    const next = route(completion);
    if (typeof next !== 'number') return next;
    index = next;
  }
  return undefined;
}

function routeSwitchCompletion(
  completion: Completion | void,
  labels: readonly string[],
  groups: readonly SwitchGroup<unknown>[]
): number | Completion | undefined {
  if (!completion) return undefined;
  if (completion.kind === 'break' && (completion.label === undefined || labels.includes(completion.label)))
    return undefined;
  if (completion.kind !== 'continue' || completion.label === undefined) return completion;
  const label = completion.label;
  const target = groups.findIndex((group) => group.labels.includes(label));
  return target === -1 ? completion : target;
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
