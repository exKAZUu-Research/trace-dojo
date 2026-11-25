// code-gauge-allow-file fileNcss -- Switches and loops share flow analysis with their generator forms.
import type { Block, CatchClause, Expression, Pattern, Span, Statement, SwitchCase } from './ast';
import { localNamesIn } from './astWalk';
import {
  AwaitRequest,
  type AwaitRoot,
  containsSuspension,
  evaluateParts,
  LISTENER_CANCELLED,
  newAwaitRoot,
  suspensionStarts,
  YieldEachRequest,
} from './awaitSteps';
import type { FunctionSpec } from './callCompiler';
import { type ClassInfo, scopedMemberName } from './classes';
import { at, type Compiled, type Eval, typeName } from './compilerBase';
import { checkExhaustive } from './exhaustiveness';
import { type CompiledPattern, PatternCache } from './patternCompiler';
import { DartThrow, type Frame } from './runtime';
import { type ConditionFlow, Flow, type LocalVar } from './scope';
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
  asInstanceOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  futureValueType,
  interfaceType,
  isNullable,
  isObject,
  isSubtype,
  iterableElementOf,
  NEVER,
  nonNullable,
  NULL,
  resolveBound,
  sameType,
} from './types';
import { Cell, NO_ARGUMENTS, type Value } from './values';

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

  // code-gauge-allow functionCognitiveComplexity -- on/catch clauses, rethrow, and finally.
  // code-gauge-allow functionNcss -- on/catch clauses, rethrow, and finally.
  // code-gauge-allow duplicateLines -- A synchronous finally and a yielding finally preserve the same pending completions.
  protected compileTry(statement: Extract<Statement, { kind: 'try' }>): Exec {
    const before = this.flow;
    const body = this.compileBlock(statement.body);
    let after = this.flow;
    const exceptionalFlow = this.forgetWrites(before, statement.body);
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
    this.flow = Flow.join(afterTry, this.forgetWrites(before, tryBlocks));
    const run = compile(block);
    const afterFinally = this.flow;
    const afterPossibleWrites = this.forgetWrites(afterTry, block);
    const promotions = new Map(afterPossibleWrites.promotions);
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
      afterFinally.writes,
      { ...afterFinally.facts, conditions: afterPossibleWrites.facts.conditions }
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
    const { isAsync } = spec.kind;
    const modifier = isAsync ? 'async*' : 'sync*';
    if (spec.body.kind === 'expression')
      return this.error(spec.body, `${modifier} の関数には、=> の本体は書けません。`);
    const container = isAsync ? coreTypes.stream : coreTypes.iterable;
    const elementType = expectedReturn ? this.elementTypeOf(nonNullable(expectedReturn), container) : undefined;
    const sequence = interfaceType(container, [elementType ?? DYNAMIC]);
    if (expectedReturn && (spec.returnType?.kind === 'void' || !isSubtype(sequence, expectedReturn))) {
      this.error(spec.span, `${modifier} の関数の戻り値の型には、${container.name} を代入できる必要があります。`);
    }
    this.fn.yieldElement = elementType;
    const body = this.compileGenBlock(spec.body.block);
    if (!spec.returnType && (!elementType || elementType.kind === 'dynamic')) {
      this.fn.yieldElement = this.inferYieldElement(this.fn);
    }
    const resolveElement = this.runtimeType(this.fn.yieldElement ?? DYNAMIC);
    if (isAsync) return (frame) => frame.runtime.links.startAsyncStar(frame, resolveElement(frame), body);
    return (frame) => this.makeSyncStarIterable(frame, resolveElement(frame), body);
  }

  private elementTypeOf(type: DartType, container: ClassInfo): DartType | undefined {
    if (container === coreTypes.iterable) return iterableElementOf(type);
    const base = resolveBound(type);
    if (base.kind === 'dynamic') return DYNAMIC;
    return base.kind === 'interface' && !base.nullable ? asInstanceOf(base, container)?.args[0] : undefined;
  }

  /** The body of an `async` function, which runs until its first `await` and returns its future. */
  protected compileAsyncBody(spec: FunctionSpec, expectedReturn: DartType | undefined): (frame: Frame) => Value {
    const declared = spec.returnType;
    const futureOfNever = interfaceType(coreTypes.future, [NEVER]);
    if (declared && (declared.kind === 'void' ? false : !isSubtype(futureOfNever, declared))) {
      this.error(spec.span, 'async の関数の戻り値の型は、Future か FutureOr にしてください。');
    }
    const { body: functionBody } = spec;
    const body =
      functionBody.kind === 'expression'
        ? this.compileGenStatement({ kind: 'return', value: functionBody.expression, ...at(functionBody.expression) })
        : this.compileGenBlock(functionBody.block, false);
    if (functionBody.kind === 'block' && this.flow.reachable) {
      this.fn.returnTypes?.push(NULL);
      // A function declared to return Object completes a Future<Object?>, yet must still return a value.
      const valueType = expectedReturn && (isObject(expectedReturn) ? expectedReturn : futureValueType(expectedReturn));
      if (declared && valueType && this.requiresReturn(valueType)) {
        this.error(
          { row: functionBody.block.row },
          `戻り値の型が ${typeName(declared)} の関数 ${spec.name} は、最後に値を return しなければなりません。`
        );
      }
    }
    const value = declared ? futureValueType(declared) : this.inferredFutureValue(this.fn, spec);
    const resolveValue = this.runtimeType(value);
    return (frame) => frame.runtime.links.startAsync(frame, resolveValue(frame), body);
  }

  /**
   * Compiles the parts of a statement that `heads` holds, whose `await`s suspend the statement's generator: the steps
   * that evaluate the parts that await, or undefined when none does.
   */
  private resuming<T>(
    heads: readonly (Span | undefined)[],
    compile: () => T
  ): { result: T; parts: AwaitRoot | undefined } {
    const ranges = heads.filter((head) => head !== undefined);
    const awaitStarts = ranges.flatMap((head) => suspensionStarts(head, false));
    if (!this.fn.kind.isAsync || awaitStarts.length === 0) return { result: compile(), parts: undefined };
    const root = newAwaitRoot(this.fn, ranges, awaitStarts);
    const savedRoot = this.awaitRoot;
    const savedStaging = this.staging;
    this.awaitRoot = root;
    this.staging = root.staging;
    try {
      return { result: compile(), parts: root };
    } finally {
      this.awaitRoot = savedRoot;
      this.staging = savedStaging;
    }
  }

  /** A statement without nested statements that awaits, which records its step once it completes. */
  private compileResumingStatement(statement: Statement): GenExec {
    const capture: NonNullable<typeof this.stepCapture> = { statement, step: undefined };
    const savedCapture = this.stepCapture;
    this.stepCapture = capture;
    let compiled: { result: Exec; parts: AwaitRoot | undefined };
    try {
      compiled = this.resuming([statement], () => this.compileStatement(statement));
    } finally {
      this.stepCapture = savedCapture;
    }
    const { result: exec, parts } = compiled;
    const { step } = capture;
    return function* (frame) {
      const mark = frame.runtime.steps.statementMark();
      const completion = yield* evaluateParts(frame, parts, () => exec(frame));
      if (step) frame.runtime.steps.completeStatement(step.row, step.onlyCalls, mark);
      return completion;
    };
  }

  /** @param clear Whether the block's variables end with it, which the body of a function keeps for its trace's end. */
  private compileGenBlock(block: Block, clear = true): GenExec {
    const { result, slots } = this.withScope(() => this.compileGenStatements(block.statements), clear);
    return clear ? clearingSlots(result, slots) : result;
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
    if (!containsSuspension(statement)) {
      const exec = this.compileStatement(statement);
      // oxlint-disable-next-line require-yield -- A statement without yield runs as one step of the generator.
      return function* (frame) {
        return exec(frame);
      };
    }
    switch (statement.kind) {
      case 'yield': {
        const { isGenerator, isAsync } = this.fn.kind;
        return isGenerator && isAsync ? this.compileAsyncYield(statement) : this.compileYield(statement);
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
        return this.compileResumingStatement(statement);
      }
    }
  }

  private compileGenSwitch(statement: Extract<Statement, { kind: 'switch' }>): GenExec {
    const guards = statement.cases.flatMap((switchCase) => ('guard' in switchCase ? [switchCase.guard] : []));
    const {
      result: { groups, select, route },
      parts: selectParts,
    } = this.resuming([statement.subject, ...(guards as Span[])], () =>
      this.compileSwitchPlan(statement, (body) => this.compileGenStatements(body))
    );
    return function* (frame) {
      frame.runtime.spend();
      let index = yield* evaluateParts(frame, selectParts, () => select(frame));
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
  // code-gauge-allow functionNcss -- A try statement in a generator: its body, catch clauses, and finally, as compileTry.
  // code-gauge-allow functionCognitiveComplexity -- A try statement in a generator: its body, catch clauses, and finally, as compileTry.
  // code-gauge-allow duplicateLines -- A synchronous finally and a yielding finally preserve the same pending completions.
  private compileGenTry(statement: Extract<Statement, { kind: 'try' }>): GenExec {
    const before = this.flow;
    const body = this.compileGenBlock(statement.body);
    let after = this.flow;
    const exceptionalFlow = this.forgetWrites(before, statement.body);
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
    const { test, flow, parts: testParts } = this.compileResumingCondition(statement.condition);
    this.flow = flow.whenTrue;
    const consequence = this.compileGenScoped(statement.consequence);
    const afterThen = this.flow;
    this.flow = flow.whenFalse;
    const { alternative } = statement;
    const otherwise = alternative ? this.compileGenScoped(alternative) : undefined;
    this.flow = Flow.join(afterThen, this.flow);
    return function* (frame) {
      if (yield* evaluateParts(frame, testParts, () => test(frame))) return yield* consequence(frame);
      if (otherwise) return yield* otherwise(frame);
      return;
    };
  }

  /** A condition of a statement in a generator, with the steps that evaluate its parts that await. */
  private compileResumingCondition(condition: Expression): {
    test: Eval;
    flow: ConditionFlow;
    parts: AwaitRoot | undefined;
  } {
    const { result, parts } = this.resuming([condition], () => this.compileCondition(condition));
    return { test: result.compiled.run, flow: result.flow, parts };
  }

  private compileGenIfCase(statement: Extract<Statement, { kind: 'if' }>): GenExec {
    const {
      result: { match, consequence, otherwise, slots },
      parts: matchParts,
    } = this.resuming([statement.condition, statement.casePattern?.guard], () =>
      this.compileIfCaseParts(statement, (body) => this.compileGenScoped(body))
    );
    return function* (frame) {
      try {
        if (yield* evaluateParts(frame, matchParts, () => match(frame))) return yield* consequence(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
      if (otherwise) return yield* otherwise(frame);
      return;
    };
  }

  // code-gauge-allow duplicateLines -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private compileGenWhile(statement: Extract<Statement, { kind: 'while' }>): GenExec {
    const labels = this.takeLoopLabels();
    this.enterLoop(statement);
    const { test, flow, parts: testParts } = this.compileResumingCondition(statement.condition);
    this.flow = flow.whenTrue;
    const body = this.compileGenLoopBody(statement.body, labels);
    this.finishLoop(flow.whenFalse, this.fn.jumpTargets.pop());
    return function* (frame) {
      while (yield* evaluateParts(frame, testParts, () => test(frame))) {
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

  private compileGenDo(statement: Extract<Statement, { kind: 'do' }>): GenExec {
    const {
      result: { labels, body, test },
      parts: testParts,
    } = this.resuming([statement.condition], () =>
      this.compileDoPlan(statement, (body, labels) => this.compileGenLoopBody(body, labels))
    );
    return function* (frame) {
      do {
        const completion = yield* body(frame);
        if (completion) {
          const outcome = loopCompletion(completion, labels);
          if (outcome !== 'continue') return outcome;
        }
        frame.runtime.spend();
      } while (yield* evaluateParts(frame, testParts, () => test(frame)));
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
      const init = Array.isArray(statement.init) ? statement.init : [statement.init];
      const {
        result: { initExec, initRow, loopSlots },
        parts: initParts,
      } = this.resuming(init, () => this.compileForInit(statement));
      this.enterLoop(statement);
      const { condition: conditionSyntax } = statement;
      const { result: condition, parts: testParts } = this.resuming([conditionSyntax], () =>
        conditionSyntax ? this.compileCondition(conditionSyntax) : undefined
      );
      const exit = condition?.flow.whenFalse ?? this.flow.unreachable;
      if (condition) this.flow = condition.flow.whenTrue;
      const body = this.compileGenLoopBody(statement.body, labels);
      const target = this.fn.jumpTargets.pop();
      if (target?.continueFlow) this.flow = Flow.join(this.flow, target.continueFlow);
      const { result: updates, parts: updateParts } = this.resuming(statement.updates, () =>
        statement.updates.map((update) => this.compileExpression(update).run)
      );
      this.finishLoop(exit, target);
      return genForLoop(
        {
          initExec,
          initRow,
          test: condition?.compiled.run,
          body,
          updates,
          labels,
          loopSlots,
          updateRow: updates.length > 0 ? this.stepRowOf(statement) : undefined,
        },
        { init: initParts, test: testParts, update: updateParts }
      );
    });
    return clearingSlots(result, slots);
  }

  private compileGenForIn(statement: Extract<Statement, { kind: 'forIn' }>): GenExec {
    const labels = this.takeLoopLabels();
    const { isAwait } = statement;
    if (isAwait && !this.fn.kind.isAsync) this.error(statement, 'await for は async の関数の中にしか書けません。');
    const { result: iterable, parts: sourceParts } = this.resuming([statement.iterable], () =>
      this.compileExpression(statement.iterable)
    );
    const elementType = isAwait
      ? this.elementTypeOfStream(iterable, statement.iterable)
      : this.elementTypeOfIterable(iterable, statement.iterable);
    const { result, slots } = this.withScope(() => {
      this.enterLoop(statement);
      const before = this.flow;
      const bind = this.compileForInBinding(statement.binding, elementType, statement);
      const body = this.compileGenLoopBody(statement.body, labels);
      this.finishLoop(before, this.fn.jumpTargets.pop());
      if (isAwait)
        return awaitForLoop(iterable.run, sourceParts, this.runtimeType(elementType), { bind, body, labels });
      const source = this.iterableSource(iterable);
      const loop: IteratorLoop = { bind, body, labels };
      return function* (frame: Frame): ReturnType<GenExec> {
        const { runtime } = frame;
        const values = yield* evaluateParts(frame, sourceParts, () => source(frame));
        const iterator = runtime.getProperty(values, 'iterator', undefined);
        frame.temporaries.push(iterator);
        try {
          // oxlint-disable-next-line require-yield -- An Iterator's moveNext answers at once; a stream's is awaited.
          return yield* iterate(frame, iterator, loop, function* () {
            return runtime.invoke(iterator, 'moveNext', NO_ARGUMENTS, [], undefined);
          });
        } finally {
          const index = frame.temporaries.lastIndexOf(iterator);
          if (index !== -1) frame.temporaries.splice(index, 1);
        }
      };
    });
    return clearingSlots(result, slots);
  }

  protected elementTypeOfStream(stream: Compiled, span: Span): DartType {
    const type = resolveBound(stream.type);
    if (type.kind === 'dynamic') return DYNAMIC;
    if (isNullable(type)) {
      this.error(span, `${typeName(stream.type)} 型の値は null かもしれないので、await for では使えません。`);
    }
    const element = type.kind === 'interface' ? asInstanceOf(type, coreTypes.stream)?.args[0] : undefined;
    return (
      element ?? this.error(span, `${typeName(stream.type)} 型の値は Stream ではないので、await for では使えません。`)
    );
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

  // code-gauge-allow functionNcss -- One case per form of the construct, which reads best together.
  private compileYield(statement: Extract<Statement, { kind: 'yield' }>): GenExec {
    if (!this.fn.kind.isGenerator)
      return this.error(statement, 'yield は sync* か async* の関数の中にしか書けません。');
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

  /** `yield` and `yield*` in an `async*` body, which add to the function's stream and may await in their value. */
  private compileAsyncYield(statement: Extract<Statement, { kind: 'yield' }>): GenExec {
    const elementType = this.fn.yieldElement;
    const { isEach } = statement;
    const context = isEach ? (elementType ? interfaceType(coreTypes.stream, [elementType]) : undefined) : elementType;
    const { result: compiled, parts } = this.resuming([statement.value], () => {
      const value = this.compileExpression(statement.value, context);
      if (!isEach) {
        this.fn.yieldTypes?.push(value.type);
        if (!elementType) return value;
        return this.coerce(
          value,
          elementType,
          statement.value,
          (from, to) => `${from} 型の値は、${to} 型の Stream に yield できません。`
        );
      }
      this.fn.yieldTypes?.push(this.elementTypeOfStream(value, statement.value));
      return this.coerce(
        value,
        context ?? interfaceType(coreTypes.stream, [DYNAMIC]),
        statement.value,
        (from, to) => `${from} 型の値は、${to} 型の Stream に yield* できません。`
      );
    });
    const { run } = compiled;
    const row = this.stepRowOf(statement);
    return function* (frame) {
      const value = yield* evaluateParts(frame, parts, () => run(frame));
      if (row !== undefined) frame.runtime.steps.step(row);
      const resumed: unknown = yield isEach ? new YieldEachRequest(value) : value;
      return resumed === LISTENER_CANCELLED ? CANCELLED_RETURN : undefined;
    };
  }
}

function rootCompletion(frame: Frame, completion: Completion | DartThrow | undefined): number {
  const mark = frame.temporaries.length;
  if (completion instanceof DartThrow) frame.temporaries.push(completion.value, completion.stackTrace);
  else if (completion?.kind === 'return') frame.temporaries.push(completion.value);
  return mark;
}

const CANCELLED_RETURN: Completion = { kind: 'return', value: undefined };

/**
 * `await for`, which reads the stream through a `StreamIterator` and cancels its subscription when the loop ends
 * before the stream does, as the SDK lowers it.
 */
function awaitForLoop(
  source: Eval,
  sourceParts: AwaitRoot | undefined,
  resolveElement: (frame: Frame) => DartType,
  loop: IteratorLoop
): GenExec {
  return function* (frame) {
    const { runtime } = frame;
    const stream = yield* evaluateParts(frame, sourceParts, () => source(frame));
    const iterator = runtime.links.construct(runtime, '_StreamIterator', '', [stream], undefined, [
      resolveElement(frame),
    ]);
    frame.temporaries.push(iterator);
    try {
      return yield* iterate(frame, iterator, loop, function* () {
        return yield new AwaitRequest(runtime.invoke(iterator, 'moveNext', NO_ARGUMENTS, [], undefined));
      });
    } finally {
      yield* cancelUnfinished(frame, iterator);
    }
  };
}

/** What a for-in loop in a generator does with each element. */
interface IteratorLoop {
  bind: (frame: Frame, value: Value) => void;
  body: GenExec;
  labels: string[];
}

/** Runs a for-in loop's body for each element of an iterator, whose `moveNext` may be awaited. */
function* iterate(
  frame: Frame,
  iterator: Value,
  { bind, body, labels }: IteratorLoop,
  moveNext: () => Generator<AwaitRequest, Value, Value>
): ReturnType<GenExec> {
  const { runtime } = frame;
  for (;;) {
    runtime.spend();
    if ((yield* moveNext()) !== true) return undefined;
    bind(frame, runtime.getProperty(iterator, 'current', undefined));
    const completion = yield* body(frame);
    if (completion) {
      const outcome = loopCompletion(completion, labels);
      if (outcome !== 'continue') return outcome;
    }
  }
}

/** Ends an `await for` loop, cancelling its subscription when the stream has not ended. */
export function* cancelUnfinished(frame: Frame, iterator: Value): Generator<AwaitRequest, undefined, Value> {
  const { runtime } = frame;
  const index = frame.temporaries.lastIndexOf(iterator);
  if (index !== -1) frame.temporaries.splice(index, 1);
  if (runtime.getProperty(iterator, scopedMemberName('_subscription', 'dart:async'), undefined) !== undefined) {
    yield new AwaitRequest(runtime.invoke(iterator, 'cancel', NO_ARGUMENTS, [], undefined));
  }
}

/** A counted loop in a generator, whose header parts may await through the steps `resume` gives them. */
function genForLoop(
  loop: CountedLoop<GenExec>,
  resume: { init?: AwaitRoot; test?: AwaitRoot; update?: AwaitRoot }
): GenExec {
  const { test, body, labels } = loop;
  return function* (frame: Frame): ReturnType<GenExec> {
    yield* evaluateParts(frame, resume.init, () => startCountedLoop(loop, frame));
    for (;;) {
      if (test && !(yield* evaluateParts(frame, resume.test, () => test(frame)))) return undefined;
      const completion = yield* body(frame);
      if (completion) {
        const outcome = loopCompletion(completion, labels);
        if (outcome !== 'continue') return outcome;
      }
      yield* evaluateParts(frame, resume.update, () => advanceCountedLoop(loop, frame));
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
// code-gauge-allow functionCognitiveComplexity -- Clear the failed matcher while keeping the selected body bindings live.
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
