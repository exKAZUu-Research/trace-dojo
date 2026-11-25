// code-gauge-allow-file fileNcss -- Coordinates statement execution, child substitution contexts, arithmetic host wiring, and scoped GC roots.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import {
  ArithmeticError,
  type ArithmeticHost,
  ArithmeticStoreError,
  type ArithmeticTarget,
  evaluateArithmetic,
  splitSubscriptText,
} from './arithmetic';
import type { ArithmeticSource, Assignment, Program, Redirect, Statement, Word } from './ast';
import { REGULAR_BUILTINS } from './builtins';
import {
  classifyCommandName,
  rejectUnsupportedDeclarationPrefix,
  rejectUnsupportedFeature,
  rejectUnsupportedPrefixAssignment,
} from './capabilities';
import { conditionalStatus } from './conditional';
import {
  executeCompoundAssignment,
  executeDeclarationCommand,
  expandShadowedDeclarationArgs,
  runDynamicDeclarationBuiltin,
} from './declare';
import { Expander } from './expansion';
import { FailurePolicy, type StoreOutcome } from './failurePolicy';
import {
  BreakSignal,
  ContinueSignal,
  DiscardSignal,
  ExitSignal,
  type Frame,
  type FunctionDefinition,
  type OutputTarget,
  ReturnSignal,
  type RootContext,
  type Runtime,
} from './runtime';
import {
  readResolvedTarget,
  resolveScalarTarget,
  resolveSubscriptTarget,
  resolveTargetName,
  writeResolvedTarget,
} from './targets';
import { type CellHandle, isIdentifier, isValidFunctionName, VariableStore } from './variables';

export { BASH_VERSION, type FunctionDefinition, type OutputTarget } from './runtime';
export type { CompoundElement } from './variables';

interface ShellContextOptions {
  readonly store?: VariableStore;
  readonly fd1?: OutputTarget;
  readonly fd2?: OutputTarget;
  readonly lineShift?: number;
  readonly readShift?: number;
}

/**
 * One Bash execution context (top-level script or isolated child command substitution), owning its `VariableStore`,
 * `Expander`, `FailurePolicy`, file descriptors, control-flow counters, and scoped GC roots.
 */
export class Shell implements ArithmeticHost, RootContext {
  readonly store: VariableStore;
  readonly failures: FailurePolicy;
  readonly expander: Expander;
  fd1: OutputTarget;
  fd2: OutputTarget;
  currentRow = 0;
  private readShift: number;
  private lineShift: number;
  private loopDepth = 0;
  private conditionDepth = 0;
  private listConditionDepth = 0;
  private readonly valueRoots: (readonly string[])[] = [];
  private readonly builderRoots: { text: string }[] = [];
  private readonly captureRoots: { text: string }[] = [];

  constructor(
    readonly runtime: Runtime,
    options?: ShellContextOptions
  ) {
    this.fd1 = options?.fd1 ?? runtime.io.stdout;
    this.fd2 = options?.fd2 ?? runtime.io.stderr;
    this.lineShift = options?.lineShift ?? 0;
    this.readShift = options?.readShift ?? 0;
    this.store = options?.store ?? new VariableStore(runtime, () => this.currentRow + 1);
    this.store.setLineReader(() => this.currentRow + 1);
    this.failures = new FailurePolicy(
      () => this.currentRow + 1,
      () => this.fd2
    );
    this.expander = new Expander(this);
    if (!options?.store) runtime.registerContext(this);
  }

  // ---------------------------------------------------------------- scoped GC roots

  withValuesRoot<T>(values: readonly string[], run: () => T): T {
    this.valueRoots.push(values);
    try {
      return run();
    } finally {
      this.valueRoots.pop();
    }
  }

  withBuilderRoot<T>(run: (builder: { text: string }) => T): T {
    const builder = { text: '' };
    this.builderRoots.push(builder);
    try {
      return run(builder);
    } finally {
      this.builderRoots.pop();
    }
  }

  *reachableStrings(): Iterable<string> {
    yield* this.store.storedReachableStrings();
    for (const values of this.valueRoots) yield* values;
    for (const builder of this.builderRoots) if (builder.text !== '') yield builder.text;
    for (const capture of this.captureRoots) if (capture.text !== '') yield capture.text;
  }

  // ---------------------------------------------------------------- running

  runProgram(program: Program): number {
    this.runtime.frames.push({ callRow: undefined, isAtomic: false, store: this.store, scopeIndex: 0 });
    try {
      for (const [index, unit] of program.units.entries()) {
        this.lineShift = this.readShift;
        try {
          this.runStatements(unit);
        } catch (error) {
          if (!(error instanceof DiscardSignal)) throw error;
          this.store.lastStatus = error.status;
          if (error.leftRow !== undefined) this.readShift = (program.unitEndRows[index] as number) - error.leftRow;
        }
      }
    } catch (error) {
      if (error instanceof ExitSignal) return error.status;
      throw error;
    }
    return this.store.lastStatus;
  }

  runStatements(statements: Statement[]): number {
    let status = 0;
    for (const statement of statements) status = this.execute(statement);
    return status;
  }

  private runCondition(statements: Statement[]): number {
    this.conditionDepth++;
    try {
      return this.runStatements(statements);
    } finally {
      this.conditionDepth--;
    }
  }

  // code-gauge-allow functionNcss -- One case per statement kind, delegating each construct to its runner.
  execute(statement: Statement): number {
    this.runtime.spend();
    this.currentRow = statement.lineRow - this.lineShift;
    let status: number;
    switch (statement.kind) {
      case 'command':
      case 'declaration':
      case 'arithmetic':
      case 'test': {
        status = this.executeSimple(statement);
        break;
      }
      case 'if': {
        status = this.executeIf(statement);
        break;
      }
      case 'while': {
        status = this.executeWhile(statement);
        break;
      }
      case 'for': {
        status = this.executeFor(statement);
        break;
      }
      case 'arithmeticFor': {
        status = this.executeArithmeticFor(statement);
        break;
      }
      case 'case': {
        status = this.executeCase(statement);
        break;
      }
      case 'group': {
        status = this.runStatements(statement.body);
        break;
      }
      case 'function': {
        if (!isValidFunctionName(statement.name)) {
          this.reportError(`\`${statement.name}': not a valid identifier`);
          status = 1;
          break;
        }
        this.store.setFunction({
          name: statement.name,
          body: statement.body,
          isAtomic: statement.isAtomic,
          lineShift: this.lineShift,
        });
        status = 0;
        break;
      }
      case 'list': {
        this.listConditionDepth++;
        let left: number;
        try {
          left = this.execute(statement.left);
        } finally {
          this.listConditionDepth--;
        }
        const runsRight = statement.operator === '&&' ? left === 0 : left !== 0;
        status = runsRight ? this.execute(statement.right) : left;
        break;
      }
      case 'not': {
        status = this.execute(statement.body) === 0 ? 1 : 0;
        break;
      }
      case 'redirected': {
        status = this.withRedirects(statement.redirects, () => this.execute(statement.body));
        break;
      }
    }
    this.store.lastStatus = status;
    return status;
  }

  private executeSimple(statement: Statement): number {
    if (this.conditionDepth > 0) {
      return this.withStatus(() => this.runSimpleBody(statement).status);
    }
    const mark = this.runtime.steps.statementMark();
    let outcome = { status: 0, conditionalStep: false, ranFunction: false };
    const status = this.withStatus(() => {
      outcome = this.runSimpleBody(statement);
      return outcome.status;
    });
    if (outcome.conditionalStep) this.runtime.steps.stepBinding(statement.row, false);
    else this.runtime.steps.completeStatement(statement.row, outcome.ranFunction, mark);
    return status;
  }

  private runSimpleBody(statement: Statement): { status: number; conditionalStep: boolean; ranFunction: boolean } {
    switch (statement.kind) {
      case 'command': {
        return this.executeCommand(statement);
      }
      case 'declaration': {
        return this.executeDeclarationStatement(statement);
      }
      case 'arithmetic': {
        return {
          status: this.arithmeticStatus(statement.expression, '(('),
          conditionalStep: this.listConditionDepth > 0,
          ranFunction: false,
        };
      }
      case 'test': {
        return {
          status: conditionalStatus(this, statement.expression),
          conditionalStep: this.listConditionDepth > 0,
          ranFunction: false,
        };
      }
      default: {
        throw new Error(`Not a simple command: ${statement.kind}`);
      }
    }
  }

  private withStatus(run: () => number): number {
    const status = run();
    this.store.lastStatus = status;
    return status;
  }

  private executeIf(statement: Extract<Statement, { kind: 'if' }>): number {
    for (const clause of statement.clauses) {
      if (this.runCondition(clause.condition) === 0) return this.runStatements(clause.body);
    }
    return statement.elseBody ? this.runStatements(statement.elseBody) : 0;
  }

  private executeWhile(statement: Extract<Statement, { kind: 'while' }>): number {
    return this.loop((last) => {
      for (;;) {
        this.runtime.spend();
        const cond = this.runWhileCondition(statement.condition, last);
        if (cond.action === 'break' || (cond.status === 0) === statement.until) return;
        if (cond.action === 'continue') continue;
        if (this.iterate(statement.body, last) === 'stop') return;
      }
    });
  }

  private runWhileCondition(
    condition: Statement[],
    last: { status: number }
  ): { action: 'normal' | 'continue' | 'break'; status: number } {
    try {
      return { action: 'normal', status: this.runCondition(condition) };
    } catch (error) {
      const loopAction = this.consumeLoopSignal(error, last, false);
      return { action: loopAction.action, status: loopAction.status };
    }
  }

  private executeFor(statement: Extract<Statement, { kind: 'for' }>): number {
    if (!isIdentifier(statement.variable)) {
      this.reportError(`\`${statement.variable}': not a valid identifier`);
      return 1;
    }
    const values = statement.values
      ? this.leavingLine(() => this.expander.expandWords(statement.values as Word[]))
      : [...this.store.positionalArgs()];
    return this.withValuesRoot(values, () => {
      const bindsObjects = values.some(
        (value) => this.runtime.turtleOf(value) !== undefined || this.namesStructure(value)
      );
      return this.restoringLine(() => this.runForIterations(statement, values, bindsObjects));
    });
  }

  private runForIterations(
    statement: Extract<Statement, { kind: 'for' }>,
    values: readonly string[],
    bindsObjects: boolean
  ): number {
    return this.loop((last) => {
      for (const value of values) {
        this.runtime.spend();
        this.currentRow = statement.row - this.lineShift;
        if (!this.bindLoopVariable(statement.variable, value, bindsObjects)) {
          last.status = 1;
          return;
        }
        this.runtime.steps.stepBinding(statement.row, !bindsObjects);
        if (this.iterate(statement.body, last) === 'stop') return;
      }
    });
  }

  private bindLoopVariable(name: string, value: string, bindsObjects: boolean): boolean {
    const own = this.store.ownView(name);
    if (own?.attributes.has('n') && own.handle) {
      const bound = this.store.bindNameref(own.handle, value, this.isInFunction);
      if (!bound.ok) return this.failures.handleStoreFailure('forHeader', bound);
      if (bound.cycleWarning) this.reportError(bound.cycleWarning);
      return true;
    }
    const target = resolveScalarTarget(this, name, true);
    if (!target) return false;
    const outcome = writeResolvedTarget(this, target, value, false);
    if (!outcome.ok) return this.failures.handleStoreFailure('forHeader', outcome);
    if (target.kind === 'scalar') {
      const targetView = target.cell ? this.store.viewOfHandle(target.cell) : this.store.ownView(target.name);
      if (targetView?.handle && !targetView.attributes.has('n')) {
        this.store.setNullReference(targetView.handle, bindsObjects && value === '');
      }
    }
    return true;
  }

  // code-gauge-allow functionCognitiveComplexity -- Runs C-style for init, condition, body, and update while keeping arithmetic errors local.
  private executeArithmeticFor(statement: Extract<Statement, { kind: 'arithmeticFor' }>): number {
    const evaluateHeader = (source: ArithmeticSource, stepAfter: boolean): bigint | undefined => {
      this.currentRow = statement.row - this.lineShift;
      const expanded = this.expander.arithmeticTextWithMask(source);
      const value = this.tryEvaluate(expanded.text, '((', expanded.quoted);
      if (value !== undefined && stepAfter) this.runtime.steps.step(statement.row);
      return value;
    };
    if (statement.init && evaluateHeader(statement.init, true) === undefined) return 1;
    return this.loop((last) => {
      for (;;) {
        this.runtime.spend();
        if (statement.condition) {
          const cond = evaluateHeader(statement.condition, false);
          if (cond === undefined) {
            last.status = 1;
            return;
          }
          if (cond === 0n) return;
        }
        if (this.iterate(statement.body, last) === 'stop') return;
        if (statement.update && evaluateHeader(statement.update, true) === undefined) {
          last.status = 1;
          return;
        }
      }
    });
  }

  private loop(run: (last: { status: number }) => void): number {
    const last = { status: 0 };
    this.loopDepth++;
    try {
      run(last);
    } finally {
      this.loopDepth--;
    }
    return last.status;
  }

  private iterate(body: Statement[], last: { status: number }): 'next' | 'stop' {
    return this.runLoopIteration(last, () => {
      last.status = this.runStatements(body);
      return 'next';
    });
  }

  private runLoopIteration(last: { status: number }, step: () => 'next' | 'stop'): 'next' | 'stop' {
    try {
      return step();
    } catch (error) {
      return this.consumeLoopSignal(error, last, true).action === 'break' ? 'stop' : 'next';
    }
  }

  private consumeLoopSignal(
    error: unknown,
    last: { status: number },
    resetLastOnContinue: boolean
  ): { action: 'break' | 'continue'; status: number } {
    if (error instanceof BreakSignal) {
      last.status = error.status;
      this.store.lastStatus = error.status;
      if (--error.count > 0) throw error;
      return { action: 'break', status: error.status };
    }
    if (error instanceof ContinueSignal) {
      if (resetLastOnContinue) last.status = 0;
      this.store.lastStatus = 0;
      if (--error.count > 0) throw error;
      return { action: 'continue', status: 0 };
    }
    throw error;
  }

  private restoringLine<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof DiscardSignal) error.leftRow = undefined;
      throw error;
    }
  }

  private leavingLine<T>(run: () => T): T {
    const row = this.currentRow;
    try {
      return run();
    } catch (error) {
      if (error instanceof DiscardSignal) error.leftRow ??= row;
      throw error;
    }
  }

  private executeCase(statement: Extract<Statement, { kind: 'case' }>): number {
    const value = this.leavingLine(() => this.expander.expandString(statement.value));
    return this.withValuesRoot([value], () => {
      let status = 0;
      let falling = false;
      for (const item of statement.items) {
        const matches =
          falling ||
          item.patterns.some((pattern) => this.expander.matches(value, this.expander.expandPattern(pattern)));
        if (!matches) continue;
        status = this.runStatements(item.body);
        if (item.terminator === ';;') return status;
        falling = item.terminator === ';&';
      }
      return status;
    });
  }

  withRedirects<T>(redirects: Redirect[], run: () => T): T {
    if (redirects.length === 0) return run();
    const saved = { fd1: this.fd1, fd2: this.fd2 };
    for (const { fd, target } of redirects) {
      const destination = target === 1 ? this.fd1 : this.fd2;
      if (fd === 1) this.fd1 = destination;
      else this.fd2 = destination;
    }
    try {
      return run();
    } finally {
      this.fd1 = saved.fd1;
      this.fd2 = saved.fd2;
    }
  }

  // ---------------------------------------------------------------- simple commands & declarations

  private executeCommand(statement: Extract<Statement, { kind: 'command' }>): {
    status: number;
    conditionalStep: boolean;
    ranFunction: boolean;
  } {
    this.expander.lastSubstitutionStatus = 0;
    const argv = this.expander.expandWords(statement.words);
    if (argv.length === 0) {
      return { status: this.executeAssignmentOnlyCommand(statement), conditionalStep: false, ranFunction: false };
    }
    return this.withValuesRoot(argv, () => {
      const [name, ...args] = argv;
      const lastArg = argv.at(-1) as string;
      const classified = classifyCommandName(name, this.store.hasFunction(name), Object.hasOwn(REGULAR_BUILTINS, name));
      if (classified.kind === 'declarationBuiltin') {
        return this.executeDynamicDeclaration(statement, name, args, lastArg);
      }
      if (classified.kind === 'unsupportedBuiltin' || classified.kind === 'external') {
        rejectUnsupportedFeature(classified.feature);
      }
      return this.invokeOrdinaryCommand(statement, name, args, lastArg, classified.kind);
    });
  }

  private executeDynamicDeclaration(
    statement: Extract<Statement, { kind: 'command' }>,
    name: string,
    args: readonly string[],
    lastArg: string
  ): { status: number; conditionalStep: boolean; ranFunction: boolean } {
    if (statement.assignments.length > 0) rejectUnsupportedDeclarationPrefix(name);
    const status = this.withRedirects(statement.redirects, () => {
      const code = runDynamicDeclarationBuiltin(this, name, args);
      this.store.lastArgument = lastArg;
      return code;
    });
    return { status, conditionalStep: false, ranFunction: false };
  }

  private invokeOrdinaryCommand(
    statement: Extract<Statement, { kind: 'command' }>,
    name: string,
    args: string[],
    lastArg: string,
    kind: 'function' | 'builtin' | 'notFound'
  ): { status: number; conditionalStep: boolean; ranFunction: boolean } {
    const isTestCommand = kind === 'builtin' && statement.assignments.length === 0 && (name === 'test' || name === '[');
    const status = this.withTemporaryScope(statement.assignments, () =>
      this.withRedirects(statement.redirects, () => {
        let code = 127;
        if (kind === 'function') {
          code = this.callFunction(this.store.getFunction(name) as FunctionDefinition, args, statement.row);
        } else if (kind === 'builtin') {
          code = REGULAR_BUILTINS[name](this, args, name);
        } else {
          this.reportError(`${name}: command not found`);
        }
        this.store.lastArgument = lastArg;
        return code;
      })
    );
    return {
      status,
      conditionalStep: this.listConditionDepth > 0 && isTestCommand,
      ranFunction: kind === 'function',
    };
  }

  private executeDeclarationStatement(statement: Extract<Statement, { kind: 'declaration' }>): {
    status: number;
    conditionalStep: boolean;
    ranFunction: boolean;
  } {
    this.expander.lastSubstitutionStatus = 0;
    const shadowingFn = this.store.getFunction(statement.name);
    if (shadowingFn) {
      const argv = expandShadowedDeclarationArgs(this, statement.name, statement.args);
      return this.withValuesRoot(argv, () => {
        const status = this.withTemporaryScope(statement.assignments, () =>
          this.withRedirects(statement.redirects, () => {
            const code = this.callFunction(shadowingFn, argv.slice(1), statement.row);
            this.store.lastArgument = argv.at(-1) as string;
            return code;
          })
        );
        return { status, conditionalStep: false, ranFunction: true };
      });
    }
    if (statement.assignments.length > 0) rejectUnsupportedDeclarationPrefix(statement.name);
    const { status, assignsAnswer } = executeDeclarationCommand(this, statement.name, statement.args, (run) =>
      this.withRedirects(statement.redirects, run)
    );
    return { status, conditionalStep: !assignsAnswer, ranFunction: false };
  }

  private executeAssignmentOnlyCommand(statement: Extract<Statement, { kind: 'command' }>): number {
    for (const assignment of statement.assignments) {
      this.performAssignment(assignment, 'scriptAssignment');
    }
    this.store.lastArgument = '';
    const status = this.expander.lastSubstitutionStatus;
    return this.withRedirects(statement.redirects, () => status);
  }

  private withTemporaryScope(assignments: Assignment[], run: () => number): number {
    if (assignments.length === 0) return run();
    const scopeIndex = this.store.pushTemporaryScope();
    try {
      for (const assignment of assignments) {
        this.bindPrefixAssignment(scopeIndex, assignment);
      }
      return run();
    } finally {
      this.store.popTemporaryScope(scopeIndex);
    }
  }

  private bindPrefixAssignment(scopeIndex: number, assignment: Assignment): void {
    if (!isIdentifier(assignment.name)) {
      this.failures.handleStoreFailure('commandPrefix', {
        ok: false,
        reason: 'invalidIdentifier',
        message: `\`${assignment.text}': not a valid identifier`,
      });
      return;
    }
    const existing = this.store.ownView(assignment.name);
    const isArray =
      existing?.kind === 'indexed' ||
      existing?.kind === 'associative' ||
      existing?.attributes.has('a') === true ||
      existing?.attributes.has('A') === true;
    rejectUnsupportedPrefixAssignment(assignment, existing?.attributes, isArray);
    const value = assignment.value ? this.expander.expandAssignmentValue(assignment.value) : '';
    if (existing?.attributes.has('r')) {
      this.failures.handleStoreFailure('commandPrefix', {
        ok: false,
        reason: 'readonly',
        message: `${assignment.name}: readonly variable`,
      });
      return;
    }
    this.store.bindTemporaryScalar(scopeIndex, assignment.name, value, assignment.append);
  }

  // ---------------------------------------------------------------- functions & child command substitutions

  callFunction(fn: FunctionDefinition, args: string[], callRow: number): number {
    if (this.runtime.frames.length >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
    const reportedRow = this.currentRow;
    const scopeIndex = this.store.pushFunctionScope(fn.name, reportedRow + 1, args);
    const frame: Frame = { callRow, isAtomic: fn.isAtomic, store: this.store, scopeIndex };
    this.runtime.frames.push(frame);
    const saved = {
      loop: this.loopDepth,
      cond: this.conditionDepth,
      listCond: this.listConditionDepth,
      shift: this.lineShift,
    };
    this.loopDepth = 0;
    this.conditionDepth = 0;
    this.listConditionDepth = 0;
    this.lineShift = fn.lineShift;
    try {
      return this.restoringLine(() => this.execute(fn.body));
    } catch (error) {
      if (error instanceof ReturnSignal) return error.status;
      throw error;
    } finally {
      this.loopDepth = saved.loop;
      this.conditionDepth = saved.cond;
      this.listConditionDepth = saved.listCond;
      this.lineShift = saved.shift;
      this.runtime.frames.pop();
      this.store.popFunctionScope(scopeIndex);
      if (fn.isAtomic) this.runtime.steps.completeAtomicCall();
      this.currentRow = reportedRow;
    }
  }

  namesStructure(word: string): boolean {
    if (!isIdentifier(word)) return false;
    const resolved = resolveTargetName(this, word, false);
    return resolved !== undefined && this.store.ownView(resolved)?.kind === 'associative';
  }

  get isInFunction(): boolean {
    return this.store.isInFunction;
  }

  get isInLoop(): boolean {
    return this.loopDepth > 0;
  }

  get loopCount(): number {
    return this.loopDepth;
  }

  /** Runs `$(...)` or `` `...` `` in a fresh child `Shell` context over a forked `VariableStore`. */
  captureSubshell(body: Statement[], startRow?: number): { output: string; status: number } {
    const buffer = { text: '' };
    const captureTarget: OutputTarget = {
      write: (text) => {
        buffer.text += text;
        if (buffer.text.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
      },
    };
    if (this.runtime.frames.length >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
    const firstRow = body[0]?.row ?? startRow;
    const childShift = firstRow !== undefined ? firstRow - this.currentRow : this.lineShift;
    const childStore = this.store.fork(() => this.currentRow + 1);
    const childShell = new Shell(this.runtime, {
      store: childStore,
      fd1: captureTarget,
      fd2: this.fd2,
      lineShift: childShift,
      readShift: childShift,
    });
    const subshellFrame: Frame = {
      callRow: undefined,
      isAtomic: false,
      store: childStore,
      scopeIndex: childStore.topScopeIndex,
    };
    this.captureRoots.push(buffer);
    this.runtime.registerContext(childShell);
    this.runtime.frames.push(subshellFrame);
    try {
      const status = runSubshellBody(childShell, body);
      return { output: buffer.text, status };
    } finally {
      this.runtime.frames.pop();
      this.runtime.unregisterContext(childShell);
      this.captureRoots.pop();
    }
  }

  // ---------------------------------------------------------------- errors & arithmetic

  reportError(message: string): void {
    this.failures.report(message);
  }

  discard(message: string, status = 1): never {
    this.failures.discard(message, status);
  }

  evaluate(source: ArithmeticSource, commandName: string | undefined): bigint {
    const expanded = this.expander.arithmeticTextWithMask(source);
    return this.evaluateText(expanded.text, commandName, expanded.quoted);
  }

  evaluateText(
    text: string,
    commandName: string | undefined,
    preExpanded: boolean | ReadonlySet<number> = false
  ): bigint {
    try {
      return evaluateArithmetic(text, this, commandName, () => this.runtime.spend(), preExpanded);
    } catch (error) {
      if (error instanceof ArithmeticError) this.discard(error.message);
      if (error instanceof ArithmeticStoreError) {
        this.failures.handleStoreFailure('expansion', error.failure);
      }
      throw error;
    }
  }

  evaluateFatalReadonly(text: string, preExpanded = false, commandName?: string): bigint {
    try {
      return evaluateArithmetic(text, this, commandName, () => this.runtime.spend(), preExpanded);
    } catch (error) {
      if (error instanceof ArithmeticError) this.discard(error.message);
      if (error instanceof ArithmeticStoreError) {
        this.failures.handleStoreFailure('fatalReadonlyArithmetic', error.failure);
      }
      throw error;
    }
  }

  arithmeticStatus(source: ArithmeticSource, commandName: string): number {
    const expanded = this.expander.arithmeticTextWithMask(source);
    const value = this.tryEvaluate(expanded.text, commandName, expanded.quoted);
    return value === undefined || value === 0n ? 1 : 0;
  }

  tryEvaluate(
    text: string,
    commandName: string | undefined,
    preExpanded: boolean | ReadonlySet<number> = false
  ): bigint | undefined {
    try {
      return evaluateArithmetic(text, this, commandName, () => this.runtime.spend(), preExpanded);
    } catch (error) {
      if (error instanceof ArithmeticStoreError) {
        this.failures.handleStoreFailure('letBuiltin', error.failure);
        return undefined;
      }
      if (!(error instanceof ArithmeticError)) throw error;
      this.reportError(error.message);
      return undefined;
    }
  }

  resolveTarget(
    name: string,
    rawSubscript: string | undefined,
    willRead: boolean,
    expandSubscript = true,
    subscriptQuoted?: ReadonlySet<number>
  ): ArithmeticTarget {
    if (rawSubscript === undefined) {
      return (
        resolveScalarTarget(this, name, !willRead) ?? {
          kind: 'invalid',
          raw: name,
          failure: { ok: false, reason: 'cannotAssign', message: '' },
        }
      );
    }
    return (
      resolveSubscriptTarget(this, {
        name,
        subscript: {
          kind: 'text',
          text: rawSubscript,
          preExpanded: !expandSubscript,
          ...(!expandSubscript ? { quotedMask: subscriptQuoted ?? new Set<number>() } : {}),
        },
        operation: willRead ? 'arithmeticRead' : 'arithmeticWrite',
      }) ?? {
        kind: 'invalid',
        raw: `${name}[${rawSubscript}]`,
        failure: { ok: false, reason: 'cannotAssign', message: '' },
      }
    );
  }

  readTarget(target: ArithmeticTarget): string | undefined {
    return readResolvedTarget(this, target);
  }

  writeTarget(target: ArithmeticTarget, value: string): StoreOutcome {
    return writeResolvedTarget(this, target, value, false);
  }

  evaluateCompoundIndex(cellHandle: CellHandle, rawKey: string): bigint | undefined {
    const view = this.store.viewOfHandle(cellHandle);
    const idx = this.evaluateFatalReadonly(rawKey, true);
    return idx >= 0n ? idx : this.store.translateNegativeIndex(view.name, idx, true);
  }

  // ---------------------------------------------------------------- assignments & unset

  performAssignment(assignment: Assignment, context: 'scriptAssignment'): boolean {
    if (!isIdentifier(assignment.name)) {
      return this.failures.handleStoreFailure(context, {
        ok: false,
        reason: 'invalidIdentifier',
        message: `\`${assignment.text}': not a valid identifier`,
      });
    }
    if (assignment.array) return executeCompoundAssignment(this, assignment, context);
    const value = assignment.value ? this.expander.expandAssignmentValue(assignment.value) : '';
    return this.withValuesRoot([value], () => this.commitScalarOrElementAssignment(assignment, value, context));
  }

  private commitScalarOrElementAssignment(assignment: Assignment, value: string, context: 'scriptAssignment'): boolean {
    const target = assignment.subscript
      ? resolveSubscriptTarget(this, {
          name: assignment.name,
          subscript: { kind: 'word', word: assignment.subscript },
          operation: 'write',
          append: assignment.append,
        })
      : resolveScalarTarget(this, assignment.name, true, { append: assignment.append });
    if (!target) return this.failures.handleStoreFailure(context, { ok: false, reason: 'cannotAssign', message: '' });
    const outcome = writeResolvedTarget(this, target, value, assignment.append);
    return outcome.ok ? true : this.failures.handleStoreFailure(context, outcome);
  }

  unsetVariable(name: string, followReference = true): boolean {
    const target = followReference ? (resolveTargetName(this, name, false) ?? name) : name;
    const failure = this.store.unsetNamed(target);
    return failure ? this.failures.handleStoreFailure('regularBuiltin', failure, 'unset') : true;
  }

  splitSubscript(text: string): { name: string; subscript: string } | undefined {
    return splitSubscriptText(text);
  }
}

function runSubshellBody(childShell: Shell, body: Statement[]): number {
  try {
    return childShell.runStatements(body);
  } catch (error) {
    if (error instanceof ExitSignal || error instanceof DiscardSignal || error instanceof ReturnSignal) {
      return error.status;
    }
    if (error instanceof BreakSignal || error instanceof ContinueSignal) return 0;
    throw error;
  }
}
