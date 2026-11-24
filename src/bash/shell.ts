// code-gauge-allow-file fileNcss -- Bash's execution, variables, and scopes share the shell state that subshells copy, so they stay in one class.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import {
  ArithmeticError,
  type ArithmeticHost,
  ArithmeticStoreError,
  type ArithmeticTarget,
  evaluateArithmetic,
  splitSubscriptText,
  type WriteTargetResult,
} from './arithmetic';
import type { ArithmeticSource, Assignment, Program, Redirect, Statement, Word } from './ast';
import { BUILTINS, unsetElement } from './builtins';
import { capitalize, lowerCase, upperCase } from './characters';
import { conditionalStatus } from './conditional';
import { declarationAssignsAnswer, expandDeclarationArguments, runDeclaration } from './declare';
import { Expander } from './expansion';
import { EXTERNAL_COMMANDS } from './externalCommands';
import {
  BreakSignal,
  ContinueSignal,
  DiscardSignal,
  ExitSignal,
  type Frame,
  ObservationAbortError,
  ReturnSignal,
  type Runtime,
  SCRIPT_NAME,
} from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import {
  advanceRandomState,
  AssociativeTable,
  buildDynamicDeclaration,
  callStackArray,
  cloneScope,
  collectReachableStrings,
  type CompoundElement,
  createInitialGlobalScope,
  deriveSubshellSeed,
  DYNAMIC_VARIABLES,
  ensureIndexedElements,
  ensureWritable,
  ENVIRONMENT_VARIABLES,
  findEnclosingVariable,
  findOwnVariableInScopes,
  findVariableInScopes,
  hasNamerefCycleInScopes,
  initialRandomSeed,
  isIdentifier,
  isValidFunctionName,
  maxElementIndex,
  PERMANENT_DYNAMIC_VARIABLES,
  readAssociativePair,
  removeScopedVariable,
  resolveNameInScopes,
  SCALAR_DYNAMIC_VARIABLES,
  type Scope,
  translateNegativeIndex,
  unpackIndexedElement,
  type Variable,
  variableElementAt,
  variableElementKeys,
  variableElementValues,
  variableScalarZero,
  type VariableValue,
} from './variables';

export type { CompoundElement } from './variables';

/** Where a file descriptor writes: the run's standard output or error, or the text a command substitution captures. */
export interface OutputTarget {
  write(text: string): void;
}

export interface FunctionDefinition {
  name: string;
  body: Statement;
  isAtomic: boolean;
  /** How far the lines Bash numbered the function with are behind its rows (see `Shell.lineShift`). */
  lineShift: number;
}

interface CallInfo {
  name: string;
  /** The 1-based line of the call, which `BASH_LINENO` reports. */
  line: number;
}

/** The state that a subshell copies and discards: variables, functions, positional parameters, and descriptors. */
export interface ShellState {
  scopes: Scope[];
  /** The scope index of each function call's own locals, the innermost last. */
  functionScopes: number[];
  functions: Map<string, FunctionDefinition>;
  /** The positional parameters of the script and of each function call, the innermost last. */
  positional: string[][];
  calls: CallInfo[];
  lastStatus: number;
  pipeStatus: string[];
  /** `$_`, which starts as the path of Bash itself, so `undefined` until a command sets it. */
  lastArgument: string | undefined;
  randomSeed: number;
  lastRandom: number;
  subshellDraws: number;
  /** The dynamic variables the program unset, which then lose their special meaning, as in Bash. */
  unsetDynamic: Set<string>;
  /** Host environment variable names explicitly cleared by `unset`, which then read as unset rather than unsupported. */
  unsetEnv: Set<string>;
  subshellLevel: number;
  fd1: OutputTarget;
  fd2: OutputTarget;
}

export const BASH_VERSION = '5.3.0(1)-release';

/** Runs a parsed program as Bash 5.3 does. */
export class Shell implements ArithmeticHost {
  state: ShellState;
  readonly expander: Expander;
  /** The 0-based row of the command running, which `LINENO` and error messages report. */
  currentRow = 0;
  /**
   * How far behind their rows Bash numbers the lines it reads next. Its parser counts lines with the counter that
   * commands also set for their error messages, and an expansion error in a `case` or in the words of a `for` can
   * leave it at that command's line, so the lines read after are numbered from there.
   */
  private readShift = 0;
  /** How far behind its rows Bash numbered the code running now, which keeps the numbers it was read with. */
  private lineShift = 0;
  /** The states of the shells that are waiting for the subshells they started, the outermost first. */
  private readonly suspended: ShellState[] = [];
  /** The loops running in the current function call or at the top level. */
  private loopDepth = 0;
  /** Whether the shell is reading a statement's condition, whose commands record no steps. */
  private conditionDepth = 0;
  /** Nesting depth on the left side of `&&` or `||`, where pure tests record no step unless shown state changed. */
  private listConditionDepth = 0;
  /** The converted string written by the most recent scalar or element store. */
  lastStored = '';
  /** Outputs of running and pending command substitutions and loop word lists, whose turtle handles stay live. */
  private readonly inFlight: { values: string[] }[] = [];
  private readonly activeOutputs: { text: string }[] = [];
  /** Prefix-assignment scope owned by the currently executing declaration command, if any. */
  private activeDeclarationPrefix: Scope | undefined;
  private readonlyFailure = false;

  constructor(readonly runtime: Runtime) {
    this.state = {
      scopes: [createInitialGlobalScope(BASH_VERSION)],
      functionScopes: [],
      functions: new Map(),
      positional: [[]],
      calls: [],
      lastStatus: 0,
      pipeStatus: [],
      lastArgument: undefined,
      randomSeed: initialRandomSeed(),
      lastRandom: 0,
      subshellDraws: 0,
      unsetDynamic: new Set(),
      unsetEnv: new Set(),
      subshellLevel: 0,
      fd1: runtime.io.stdout,
      fd2: runtime.io.stderr,
    };
    this.expander = new Expander(this);
    runtime.reachableStrings = () =>
      collectReachableStrings([...this.suspended, this.state], this.activeOutputs, this.inFlight);
  }

  // ---------------------------------------------------------------- running

  /** Runs the program's lines one at a time, as Bash reads them, returning the shell's exit status. */
  runProgram(program: Program): number {
    this.runtime.frames.push({ callRow: undefined, isAtomic: false, scopeIndex: 0 });
    try {
      for (const [index, unit] of program.units.entries()) {
        this.lineShift = this.readShift;
        try {
          this.runStatements(unit);
        } catch (error) {
          if (!(error instanceof DiscardSignal)) throw error;
          this.setCommandStatus(error.status);
          // The line after the unit is numbered one after the line the counter was left at.
          if (error.leftRow !== undefined) this.readShift = (program.unitEndRows[index] as number) - error.leftRow;
        }
      }
    } catch (error) {
      if (error instanceof ExitSignal) return error.status;
      throw error;
    }
    return this.state.lastStatus;
  }

  runStatements(statements: Statement[]): number {
    let status = 0;
    for (const statement of statements) status = this.execute(statement);
    return status;
  }

  /** Runs a function while keeping any command-substitution outputs it produces rooted for turtle GC. */
  private withRoots<T>(run: (roots: string[]) => T): T {
    const frame = { values: [] as string[] };
    this.inFlight.push(frame);
    try {
      return run(frame.values);
    } finally {
      this.inFlight.pop();
    }
  }

  /** Runs statements whose exit status decides a branch, recording no steps for their commands. */
  private runCondition(statements: Statement[]): number {
    this.conditionDepth++;
    try {
      return this.runStatements(statements);
    } finally {
      this.conditionDepth--;
    }
  }

  // code-gauge-allow functionNcss -- One case per statement kind, each delegating to its own runner.
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
        this.state.functions.set(statement.name, {
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
    this.state.lastStatus = status;
    return status;
  }

  /** Runs a command that records a step after it completes, unless it is part of a condition. */
  private executeSimple(statement: Statement): number {
    if (this.conditionDepth > 0)
      return this.withRoots(() => this.withStatus(() => this.runSimpleBody(statement).status));
    const mark = this.runtime.steps.statementMark();
    let outcome = { status: 0, conditionalStep: false, ranFunction: false };
    const status = this.withRoots(() =>
      this.withStatus(() => {
        outcome = this.runSimpleBody(statement);
        return outcome.status;
      })
    );
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
        const { status, assignsAnswer } = this.executeDeclaration(statement);
        return { status, conditionalStep: !assignsAnswer, ranFunction: false };
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
          status: this.executeTest(statement),
          conditionalStep: this.listConditionDepth > 0,
          ranFunction: false,
        };
      }
      default: {
        throw new Error(`Not a simple command: ${statement.kind}`);
      }
    }
  }

  /** Runs a command and sets `$?`, before a step records its state. */
  private withStatus(run: () => number): number {
    const status = run();
    this.setCommandStatus(status);
    return status;
  }

  setCommandStatus(status: number): void {
    this.state.lastStatus = status;
    this.state.unsetDynamic.delete('PIPESTATUS');
    this.state.pipeStatus = [String(status)];
  }

  private executeIf(statement: Extract<Statement, { kind: 'if' }>): number {
    for (const clause of statement.clauses) {
      if (this.runCondition(clause.condition) === 0) return this.runStatements(clause.body);
    }
    return statement.elseBody ? this.runStatements(statement.elseBody) : 0;
  }

  /** Runs one iteration of a loop body, telling whether the loop goes on. */
  private iterate(body: Statement[], last: { status: number }): 'next' | 'stop' {
    try {
      last.status = this.runStatements(body);
      return 'next';
    } catch (error) {
      if (error instanceof BreakSignal) {
        last.status = error.status;
        this.setCommandStatus(error.status);
        if (--error.count > 0) throw error;
        return 'stop';
      }
      if (error instanceof ContinueSignal) {
        last.status = 0;
        this.setCommandStatus(0);
        if (--error.count > 0) throw error;
        return 'next';
      }
      throw error;
    }
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

  private executeWhile(statement: Extract<Statement, { kind: 'while' }>): number {
    return this.loop((last) => {
      for (;;) {
        this.runtime.spend();
        const condition = this.runCondition(statement.condition);
        if ((condition === 0) === statement.until) return;
        if (this.iterate(statement.body, last) === 'stop') return;
      }
    });
  }

  // code-gauge-allow functionCognitiveComplexity -- Bash's for: its words, which leave the line counter, and its loop, which restores it.
  private executeFor(statement: Extract<Statement, { kind: 'for' }>): number {
    if (!isIdentifier(statement.variable)) {
      this.reportError(`\`${statement.variable}': not a valid identifier`);
      return 1;
    }
    return this.withRoots((roots) => {
      const values = statement.values
        ? this.leavingLine(() => this.expander.expandWords(statement.values as Word[]))
        : [...(this.state.positional.at(-1) as string[])];
      roots.push(...values);
      // A list holding turtles is a list of objects, as Java's `Turtle[]` is, and an empty string stands for null; a
      // binding of either records a step only when it changes what the trace shows.
      const bindsObjects = values.some(
        (value) => this.runtime.turtleOf(value) !== undefined || this.namesStructure(value)
      );
      // The words' expansion leaves Bash's line counter at the `for`, but the loop restores it however it ends.
      return this.restoringLine(() =>
        this.loop((last) => {
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
        })
      );
    });
  }

  private bindLoopVariable(name: string, value: string, bindsObjects: boolean): boolean {
    const reference = this.findVariable(name, false);
    if (reference?.attributes.has('n')) {
      if (reference.attributes.has('r')) {
        this.reportError(`${name}: readonly variable`);
        return false;
      }
      if (!this.isValidNamerefTarget(value)) {
        this.reportError(`\`${value}': not a valid identifier`);
        return false;
      }
      if (!this.isInFunction && value === reference.name) {
        this.reportError(`${name}: nameref variable self reference not allowed`);
        return false;
      }
      reference.value = { kind: 'scalar', value };
      if (this.hasNamerefCycle(reference)) {
        this.reportError(`warning: ${reference.name}: circular name reference`);
      }
      return true;
    }
    if (!this.assignScalar(name, value)) return false;
    const targetVar = this.findVariable(name);
    if (targetVar) targetVar.nullReference = bindsObjects && value === '';
    return true;
  }

  // code-gauge-allow functionCognitiveComplexity -- Runs C-style for init, condition, body, and update while keeping arithmetic errors local to the loop.
  private executeArithmeticFor(statement: Extract<Statement, { kind: 'arithmeticFor' }>): number {
    const evaluateHeader = (source: ArithmeticSource, stepAfter: boolean): bigint | undefined => {
      this.currentRow = statement.row - this.lineShift;
      const value = this.tryEvaluate(this.expander.arithmeticText(source), '((');
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

  /** Runs a command that restores Bash's line counter however it ends, as a simple command or a `for` loop does. */
  private restoringLine<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof DiscardSignal) error.leftRow = undefined;
      throw error;
    }
  }

  /**
   * Expands the words of a `for` or the word of a `case`, for which Bash sets its line counter to the command's line
   * without arranging to restore it, so that an expansion error leaves the counter there.
   */
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
    let status = 0;
    let falling = false;
    for (const item of statement.items) {
      const matches =
        falling || item.patterns.some((pattern) => this.expander.matches(value, this.expander.expandPattern(pattern)));
      if (!matches) continue;
      status = this.runStatements(item.body);
      if (item.terminator === ';;') return status;
      falling = item.terminator === ';&';
    }
    return status;
  }

  private executeTest(statement: Extract<Statement, { kind: 'test' }>): number {
    return conditionalStatus(this, statement.expression);
  }

  /** Runs with standard output or error pointed at the other, for `>&2` and `2>&1`. */
  withRedirects<T>(redirects: Redirect[], run: () => T): T {
    if (redirects.length === 0) return run();
    const saved = { fd1: this.state.fd1, fd2: this.state.fd2 };
    for (const { fd, target } of redirects) {
      const destination = target === 1 ? this.state.fd1 : this.state.fd2;
      if (fd === 1) this.state.fd1 = destination;
      else this.state.fd2 = destination;
    }
    try {
      return run();
    } finally {
      this.state.fd1 = saved.fd1;
      this.state.fd2 = saved.fd2;
    }
  }

  // ---------------------------------------------------------------- simple commands

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
    const [name] = argv;
    const fn = this.state.functions.get(name);
    const builtin = !fn && Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : undefined;
    const isTestCommand = !fn && statement.assignments.length === 0 && (name === 'test' || name === '[');
    const status = this.withTemporaryScope(statement.assignments, () =>
      this.withRedirects(statement.redirects, () => this.dispatchCommand(argv, fn, builtin, statement.row))
    );
    return {
      status,
      conditionalStep: this.listConditionDepth > 0 && isTestCommand,
      ranFunction: Boolean(fn),
    };
  }

  private dispatchCommand(
    argv: string[],
    fn: ReturnType<ShellState['functions']['get']>,
    builtin: (typeof BUILTINS)[string] | undefined,
    row: number
  ): number {
    const [name, ...args] = argv;
    let status = 127;
    if (fn) status = this.callFunction(fn, args, row);
    else if (builtin) status = builtin(this, args, name);
    else if (EXTERNAL_COMMANDS.has(name) || name.includes('/')) {
      throw new UnsupportedFeatureError(`外部コマンド（${name}）`);
    } else this.reportError(`${name}: command not found`);
    this.state.lastArgument = argv.at(-1) as string;
    return status;
  }

  private executeAssignmentOnlyCommand(statement: Extract<Statement, { kind: 'command' }>): number {
    // A command of assignments alone expands and commits before redirections and takes its last substitution status.
    for (const assignment of statement.assignments) {
      if (!this.performAssignment(assignment)) throw new DiscardSignal();
    }
    this.state.lastArgument = '';
    const status = this.expander.lastSubstitutionStatus;
    return this.withRedirects(statement.redirects, () => status);
  }

  /** Runs a command with the assignments written before it visible both to later assignments and to the command. */
  private withTemporaryScope(assignments: Assignment[], run: () => number, forDeclaration = false): number {
    const prevPrefix = this.activeDeclarationPrefix;
    if (assignments.length === 0) {
      this.activeDeclarationPrefix = undefined;
      try {
        return run();
      } finally {
        this.activeDeclarationPrefix = prevPrefix;
      }
    }
    const scope: Scope = new Map();
    this.state.scopes.push(scope);
    this.activeDeclarationPrefix = forDeclaration ? scope : undefined;
    try {
      if (!this.populateTemporaryScope(scope, assignments)) return 1;
      return run();
    } finally {
      this.activeDeclarationPrefix = prevPrefix;
      this.removeScope(scope);
    }
  }

  private populateTemporaryScope(scope: Scope, assignments: Assignment[]): boolean {
    for (const assignment of assignments) {
      if (assignment.subscript || assignment.array) {
        // Bash assigns array elements before a command in the shell itself.
        if (!this.performAssignment(assignment)) return false;
        continue;
      }
      const value = assignment.value ? this.expander.expandAssignmentValue(assignment.value) : '';
      if (this.findOwnVariable(assignment.name)?.attributes.has('r')) {
        // Bash reports the assignment and runs the command without it.
        this.reportError(`${assignment.name}: readonly variable`);
        continue;
      }
      const combined = this.combineTemporaryValue(assignment.name, value, assignment.append);
      scope.set(assignment.name, {
        name: assignment.name,
        value: { kind: 'scalar', value: combined },
        attributes: new Set(['x']),
        fromTempEnv: true,
      });
    }
    return true;
  }

  private combineTemporaryValue(name: string, value: string, append: boolean): string {
    if (!append) return value;
    const base = this.scalarValue(name) ?? '';
    if (!this.findVariable(name)?.attributes.has('i')) return base + value;
    return String(BigInt.asIntN(64, this.evaluateFatalReadonly(base || '0') + this.evaluateFatalReadonly(value)));
  }

  private removeScope(scope: Scope): void {
    const index = this.state.scopes.lastIndexOf(scope);
    if (index !== -1) this.state.scopes.splice(index, 1);
  }

  private executeDeclaration(statement: Extract<Statement, { kind: 'declaration' }>): {
    status: number;
    assignsAnswer: boolean;
  } {
    const args = expandDeclarationArguments(this, statement.name, statement.args);
    let assignsAnswer = declarationAssignsAnswer(statement.name, args);
    const status = this.withTemporaryScope(
      statement.assignments,
      () =>
        this.withRedirects(statement.redirects, () => {
          const declStatus = runDeclaration(this, statement.name, args, () => {
            assignsAnswer = true;
          });
          const last = args.at(-1);
          this.state.lastArgument = last === undefined ? statement.name : typeof last === 'string' ? last : last.text;
          return declStatus;
        }),
      true
    );
    return { status, assignsAnswer };
  }

  // ---------------------------------------------------------------- functions

  // code-gauge-allow functionNcss -- Sets up and restores every part of the shell state a function call changes.
  callFunction(fn: FunctionDefinition, args: string[], callRow: number): number {
    if (this.runtime.frames.length >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
    const { state } = this;
    const scope: Scope = new Map();
    state.scopes.push(scope);
    const scopeIndex = state.scopes.length - 1;
    state.functionScopes.push(scopeIndex);
    state.positional.push(args);
    // `BASH_LINENO` gives the line Bash numbered the call with; the trace keeps the row of the call's step.
    const reportedRow = this.currentRow;
    state.calls.push({ name: fn.name, line: reportedRow + 1 });
    const frame: Frame = { callRow, isAtomic: fn.isAtomic, scopeIndex };
    this.runtime.frames.push(frame);
    const savedLoopDepth = this.loopDepth;
    const savedCondition = this.conditionDepth;
    const savedListCondition = this.listConditionDepth;
    const savedShift = this.lineShift;
    this.loopDepth = 0;
    this.conditionDepth = 0;
    this.listConditionDepth = 0;
    this.lineShift = fn.lineShift;
    try {
      // The call is a simple command, which restores Bash's line counter however it ends.
      return this.restoringLine(() => this.execute(fn.body));
    } catch (error) {
      if (error instanceof ReturnSignal) return error.status;
      throw error;
    } finally {
      this.loopDepth = savedLoopDepth;
      this.conditionDepth = savedCondition;
      this.listConditionDepth = savedListCondition;
      this.lineShift = savedShift;
      this.runtime.frames.pop();
      // A subshell's state replaces the caller's while it runs, so the call cleans up the state it started in.
      state.calls.pop();
      state.positional.pop();
      state.functionScopes.pop();
      state.scopes.length = scopeIndex;
      if (fn.isAtomic) this.runtime.steps.completeAtomicCall();
      this.currentRow = reportedRow;
    }
  }

  /** Whether a word names an associative array, which a program uses as a structure, as Java uses an object. */
  namesStructure(word: string): boolean {
    return isIdentifier(word) && this.findVariable(word)?.value?.kind === 'associative';
  }

  get isInFunction(): boolean {
    return this.state.functionScopes.length > 0;
  }

  get isInLoop(): boolean {
    return this.loopDepth > 0;
  }

  get loopCount(): number {
    return this.loopDepth;
  }

  // ---------------------------------------------------------------- subshells

  /** Runs statements in a copy of the shell, capturing what they write to standard output. */
  // code-gauge-allow functionNcss -- Copies and restores every part of the shell state a command substitution changes.
  captureSubshell(body: Statement[], startRow?: number): { output: string; status: number } {
    if (this.runtime.observing) throw new ObservationAbortError();
    const buffer = { text: '' };
    const capture: OutputTarget = {
      write: (text) => {
        buffer.text += text;
        if (buffer.text.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
      },
    };
    const parent = this.state;
    const child: ShellState = {
      ...parent,
      scopes: parent.scopes.map((scope) => cloneScope(scope)),
      functionScopes: [...parent.functionScopes],
      functions: new Map(parent.functions),
      positional: parent.positional.map((args) => [...args]),
      calls: [...parent.calls],
      pipeStatus: [...parent.pipeStatus],
      randomSeed: deriveSubshellSeed(parent.randomSeed, ++parent.subshellDraws, parent.subshellLevel + 1),
      lastRandom: 0,
      subshellDraws: 0,
      unsetDynamic: new Set(parent.unsetDynamic),
      unsetEnv: new Set(parent.unsetEnv),
      subshellLevel: parent.subshellLevel + 1,
      fd1: capture,
    };
    this.suspended.push(parent);
    this.activeOutputs.push(buffer);
    this.state = child;
    const savedLoop = this.loopDepth;
    const savedCondition = this.conditionDepth;
    const savedListCondition = this.listConditionDepth;
    const savedRow = this.currentRow;
    const savedLineShift = this.lineShift;
    const savedReadShift = this.readShift;
    this.loopDepth = 0;
    if (startRow !== undefined) {
      this.lineShift = startRow - this.currentRow;
      this.readShift = this.lineShift;
    }
    let status: number;
    try {
      status = this.runStatements(body);
    } catch (error) {
      if (error instanceof ExitSignal || error instanceof DiscardSignal) status = error.status;
      else if (error instanceof ReturnSignal) status = error.status;
      else if (error instanceof BreakSignal || error instanceof ContinueSignal) status = 0;
      else throw error;
    } finally {
      this.activeOutputs.pop();
      this.state = this.suspended.pop() as ShellState;
      this.loopDepth = savedLoop;
      this.conditionDepth = savedCondition;
      this.listConditionDepth = savedListCondition;
      this.currentRow = savedRow;
      this.lineShift = savedLineShift;
      this.readShift = savedReadShift;
    }
    this.inFlight.at(-1)?.values.push(buffer.text);
    return { output: buffer.text, status };
  }

  // ---------------------------------------------------------------- errors

  /** Writes an error as Bash does, prefixed with the script's name and the line of the running command. */
  reportError(message: string): void {
    this.state.fd2.write(`${SCRIPT_NAME}: line ${this.currentRow + 1}: ${message}\n`);
  }

  /** Reports an error in an expansion and abandons the command, as Bash does for a non-interactive shell. */
  discard(message: string, status = 1): never {
    this.reportError(message);
    throw new DiscardSignal(status);
  }

  // ---------------------------------------------------------------- arithmetic

  evaluate(source: ArithmeticSource, commandName: string | undefined): bigint {
    return this.evaluateText(this.expander.arithmeticText(source), commandName);
  }

  evaluateText(text: string, commandName: string | undefined): bigint {
    try {
      return evaluateArithmetic(text, this, commandName, () => this.runtime.spend());
    } catch (error) {
      if (error instanceof ArithmeticError) this.discard(error.message);
      if (error instanceof ArithmeticStoreError) throw new DiscardSignal();
      throw error;
    }
  }

  evaluateFatalReadonly(text: string): bigint {
    try {
      return evaluateArithmetic(text, this, undefined, () => this.runtime.spend());
    } catch (error) {
      if (error instanceof ArithmeticError) this.discard(error.message);
      if (error instanceof ArithmeticStoreError) {
        if (error.isReadonly) throw new ExitSignal(1);
        throw new DiscardSignal();
      }
      throw error;
    }
  }

  /** The status of `((...))`: 0 when the value is not zero; an error reports and gives 1. */
  arithmeticStatus(source: ArithmeticSource, commandName: string): number {
    const value = this.tryEvaluate(this.expander.arithmeticText(source), commandName);
    return value === undefined || value === 0n ? 1 : 0;
  }

  /** Evaluates arithmetic for a command that fails on an error instead of abandoning the line, as `let` does. */
  tryEvaluate(text: string, commandName: string | undefined): bigint | undefined {
    try {
      return evaluateArithmetic(text, this, commandName, () => this.runtime.spend());
    } catch (error) {
      if (error instanceof ArithmeticStoreError) return undefined;
      if (!(error instanceof ArithmeticError)) throw error;
      this.reportError(error.message);
      return undefined;
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Resolves scalar, associative, indexed, and invalid arithmetic subscripts once for reads and writes.
  resolveTarget(name: string, rawSubscript: string | undefined, willRead: boolean): ArithmeticTarget {
    if (rawSubscript === undefined) return { kind: 'scalar', name };
    if (rawSubscript === '') {
      if (willRead) {
        this.reportError(`${name}[]: bad array subscript`);
        this.reportError(`${name}[]: bad array subscript`);
      }
      return { kind: 'invalidElement', raw: `${name}[]`, emptyWrite: !willRead };
    }
    const resolved = this.resolveName(name);
    if (this.isAssociative(resolved)) {
      const key = this.expander.expandSubscriptText(rawSubscript);
      if (key === '') {
        if (willRead) this.reportError(`${name}[${rawSubscript}]: bad array subscript`);
        return { kind: 'invalidElement', raw: `${name}[${rawSubscript}]` };
      }
      return { kind: 'associativeElement', name: resolved, key };
    }
    if (rawSubscript === '@' || rawSubscript === '*') {
      return willRead
        ? { kind: 'indexedElement', name: resolved, index: 0n }
        : { kind: 'invalidElement', raw: `${name}[${rawSubscript}]` };
    }
    const index = willRead
      ? this.readIndex(resolved, this.expander.expandSubscriptText(rawSubscript))
      : this.arrayIndex(resolved, this.expander.expandSubscriptText(rawSubscript), true);
    if (index === undefined) return { kind: 'invalidElement', raw: `${name}[${rawSubscript}]` };
    return { kind: 'indexedElement', name: resolved, index };
  }

  readTarget(target: ArithmeticTarget): string | undefined {
    if (target.kind === 'scalar') return this.scalarValue(target.name);
    if (target.kind === 'associativeElement') return this.elementValue(target.name, target.key);
    if (target.kind === 'indexedElement') return this.elementAtIndex(target.name, target.index);
    return undefined;
  }

  writeTarget(target: ArithmeticTarget, value: string): WriteTargetResult {
    this.readonlyFailure = false;
    let ok = false;
    if (target.kind === 'scalar') ok = this.assignScalar(target.name, value);
    else if (target.kind === 'associativeElement') ok = this.assignElement(target.name, target.key, value, false, true);
    else if (target.kind === 'indexedElement') {
      ok = this.assignElement(target.name, String(target.index), value, false, true);
    } else this.reportError(`${target.raw}: bad array subscript`);
    if (ok) return 'ok';
    return this.readonlyFailure ? 'readonly' : 'invalid';
  }

  /** Whether a name holds an associative array, including one declared with `-A` that has no elements yet. */
  isAssociative(name: string): boolean {
    return (
      this.findVariable(name)?.value?.kind === 'associative' || this.findVariable(name)?.attributes.has('A') === true
    );
  }

  // ---------------------------------------------------------------- variables

  /** Whether `target` has the syntax of a valid `declare -n` / `for` nameref destination (`id` or `id[nonempty]`). */
  isValidNamerefTarget(target: string): boolean {
    const split = this.splitSubscript(target);
    return isIdentifier(target) || Boolean(split && isIdentifier(split.name) && split.subscript !== '');
  }

  /** Whether following `start`'s nameref chain reaches an already-seen nameref cell. */
  hasNamerefCycle(start: Variable): boolean {
    return hasNamerefCycleInScopes(this.state.scopes, start);
  }

  /** Expands a runtime string subscript (`$k`, `${i}`, `$(...)`) once, preserving `@` and `*` verbatim. */
  expandDynamicSubscript(rawSubscript: string): string {
    return rawSubscript === '@' || rawSubscript === '*'
      ? rawSubscript
      : this.expander.expandSubscriptText(rawSubscript);
  }

  /** The variable a name refers to, from the innermost scope, following name references. */
  findVariable(name: string, followReferences = true): Variable | undefined {
    return findVariableInScopes(this.state.scopes, name, followReferences);
  }

  findOwnVariable(name: string): Variable | undefined {
    return findOwnVariableInScopes(this.state.scopes, name);
  }

  declarationPrefixVariable(name: string): Variable | undefined {
    return this.activeDeclarationPrefix?.get(name);
  }

  findEnclosingForPrefix(name: string): Variable | undefined {
    return this.activeDeclarationPrefix
      ? findEnclosingVariable(this.state.scopes, this.activeDeclarationPrefix, name)
      : this.findOwnVariable(name);
  }

  /** Resolves `name` through name references, returning `undefined` (and optionally warning) on a reference cycle. */
  resolveNameOrUndefined(name: string, warnCycle = true): string | undefined {
    const outcome = resolveNameInScopes(this.state.scopes, name);
    if ('resolved' in outcome) return outcome.resolved;
    if (warnCycle) this.reportError(`warning: ${outcome.cyclicName}: circular name reference`);
    return undefined;
  }

  /** The name a name reference finally names, or the name itself. */
  resolveName(name: string): string {
    return this.resolveNameOrUndefined(name, false) ?? name;
  }

  private isUnreadHostEnv(name: string): boolean {
    return ENVIRONMENT_VARIABLES.has(name) && !this.state.unsetEnv.has(name);
  }

  /** The value of `$name`: a scalar, or element 0 of an array, or `undefined` when unset. */
  scalarValue(name: string): string | undefined {
    const resolved = this.resolveNameOrUndefined(name);
    if (resolved === undefined) return undefined;
    const split = this.splitSubscript(resolved);
    if (split) return this.readReferencedElement(split);
    const dynamic = this.dynamicValue(resolved);
    if (dynamic !== undefined) return dynamic;
    const variable = this.findVariable(resolved, false);
    if (!variable) {
      if (this.isUnreadHostEnv(resolved)) throw new UnsupportedFeatureError(`環境変数（${resolved}）`);
      return undefined;
    }
    return variableScalarZero(variable.value);
  }

  private readReferencedElement(split: { name: string; subscript: string }): string | undefined {
    const arr = this.resolveNameOrUndefined(split.name);
    if (arr === undefined) return undefined;
    if (split.subscript === '@' || split.subscript === '*') {
      const values = this.arrayValues(arr);
      const sep = split.subscript === '*' ? this.expander.ifsJoiner() : this.expander.ifsJoiner() || ' ';
      return values.length === 0 ? undefined : values.join(sep);
    }
    const sub = this.expandDynamicSubscript(split.subscript);
    if (this.isAssociative(arr)) {
      if (sub !== '') return this.elementValue(arr, sub);
      this.reportError(`${arr}: bad array subscript`);
      return undefined;
    }
    return this.elementValue(arr, sub === '' && split.subscript !== '' ? '0' : sub);
  }

  /** The value of a dynamic variable Bash computes when it is read, unless the program unset or shadowed it. */
  private dynamicValue(name: string): string | undefined {
    if (!this.isDynamic(name)) return undefined;
    if (name === 'RANDOM') return String(this.nextRandom());
    if (name === 'LINENO') return String(this.currentRow + 1);
    if (name === 'BASH_SUBSHELL') return String(this.state.subshellLevel);
    return this.dynamicArray(name)?.[0];
  }

  /** The elements of `FUNCNAME`, `BASH_LINENO`, `BASH_SOURCE`, and `PIPESTATUS`. */
  dynamicArray(name: string): string[] | undefined {
    return this.isDynamic(name)
      ? callStackArray(name, this.state.calls, SCRIPT_NAME, this.state.pipeStatus)
      : undefined;
  }

  /**
   * Assigns a dynamic variable as Bash does, telling whether the name is one: `RANDOM` takes a seed, `BASH_SUBSHELL` a
   * new level, and the others ignore the value, since Bash computes them when they are read.
   */
  assignDynamic(name: string, value: string): boolean {
    if (!this.isDynamic(name)) return false;
    if (name === 'RANDOM') this.seedRandom(value);
    if (name === 'BASH_SUBSHELL') this.state.subshellLevel = /^\s*[-+]?\d+\s*$/.test(value) ? Number(value) : 0;
    this.lastStored = value;
    return true;
  }

  /** A dynamic variable as `declare -p` shows it, whose value is computed as reading it computes it. */
  dynamicDeclaration(name: string): Variable | undefined {
    if (!this.isDynamic(name)) return undefined;
    return buildDynamicDeclaration(
      name,
      SCALAR_DYNAMIC_VARIABLES.has(name) ? this.dynamicValue(name) : undefined,
      this.dynamicArray(name)
    );
  }

  isDynamic(name: string): boolean {
    return DYNAMIC_VARIABLES.has(name) && !this.state.unsetDynamic.has(name) && !this.findOwnVariable(name);
  }

  private isScalarDynamic(name: string): boolean {
    return this.isDynamic(name) && SCALAR_DYNAMIC_VARIABLES.has(name);
  }

  /** Bash's `RANDOM`: Park and Miller's generator, folded to 15 bits, never repeating the last value. */
  private nextRandom(): number {
    const next = advanceRandomState(this.state.randomSeed, this.state.lastRandom);
    this.state.randomSeed = next.seed;
    this.state.lastRandom = next.value;
    return next.value;
  }

  /** Seeds `RANDOM`, whose value Bash evaluates as arithmetic because the variable has the integer attribute. */
  private seedRandom(value: string): void {
    const seed = this.tryEvaluate(value, undefined);
    if (seed === undefined) return;
    this.state.randomSeed = Number(BigInt.asUintN(32, seed));
    this.state.lastRandom = 0;
    this.state.subshellDraws = 0;
  }

  /** The value of `${name[subscript]}`, where the subscript is already expanded text. */
  // code-gauge-allow functionCognitiveComplexity -- Bash's element reads for dynamic, environment, associative, scalar, and indexed variables.
  elementValue(name: string, subscript: string): string | undefined {
    const variable = this.findVariable(name);
    if (!variable?.value) {
      const dynamic = this.dynamicArray(name);
      if (dynamic) {
        const index = this.readIndex(name, subscript);
        return index === undefined ? undefined : dynamic[Number(index)];
      }
      if (this.isScalarDynamic(name)) {
        const index = this.readIndex(name, subscript);
        return index === 0n ? this.dynamicValue(name) : undefined;
      }
      if (!variable && this.isUnreadHostEnv(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
      if (variable === undefined || !variable.attributes.has('A')) this.readIndex(name, subscript);
      return undefined;
    }
    if (variable.value.kind === 'associative') return variable.value.table.get(subscript);
    const index = this.readIndex(name, subscript);
    if (index === undefined) return undefined;
    return variableElementAt(variable.value, index);
  }

  elementAtIndex(name: string, index: bigint): string | undefined {
    const variable = this.findVariable(name);
    if (!variable?.value) {
      const dynamic = this.dynamicArray(name);
      if (dynamic) return dynamic[Number(index)];
      if (this.isScalarDynamic(name)) return index === 0n ? this.dynamicValue(name) : undefined;
      if (!variable && this.isUnreadHostEnv(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
      return undefined;
    }
    return variableElementAt(variable.value, index);
  }

  /**
   * Evaluates an indexed array's subscript, counting a negative one from the end, as Bash does, or `undefined` for a
   * negative one before the first element, which each caller reports in its own way.
   */
  arrayIndex(name: string, subscript: string, allowScalarWrite = false): bigint | undefined {
    const dynamicLen =
      this.isDynamic(name) && !SCALAR_DYNAMIC_VARIABLES.has(name) ? this.dynamicArray(name)?.length : undefined;
    return this.arrayIndexFor(this.findVariable(name), subscript, dynamicLen, allowScalarWrite);
  }

  private arrayIndexFor(
    variable: Variable | undefined,
    subscript: string,
    dynamicLength?: number,
    allowScalarWrite = false
  ): bigint | undefined {
    const index = this.evaluateFatalReadonly(subscript);
    return index >= 0n ? index : translateNegativeIndex(variable, index, dynamicLength, allowScalarWrite);
  }

  /** An index to read an element at, reporting one before the first element, which reads as unset. */
  private readIndex(name: string, subscript: string): bigint | undefined {
    const index = this.arrayIndex(name, subscript);
    if (index === undefined) this.reportError(`${name}: bad array subscript`);
    return index;
  }

  /** The values of `${name[@]}`: the elements of an array, the value of a scalar, or none when unset. */
  arrayValues(name: string): string[] {
    const variable = this.findVariable(name);
    if (!variable?.value) {
      const dynamic = this.dynamicArray(name);
      if (dynamic) return dynamic;
      if (this.isScalarDynamic(name)) return [this.dynamicValue(name) as string];
      if (!variable && this.isUnreadHostEnv(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
      return [];
    }
    return variableElementValues(variable.value);
  }

  /** The keys of `${!name[@]}`. */
  arrayKeys(name: string): string[] {
    const variable = this.findVariable(name);
    if (!variable?.value) {
      const dynamic = this.dynamicArray(name);
      if (dynamic) return dynamic.map((_, index) => String(index));
      if (this.isScalarDynamic(name)) return ['0'];
      if (!variable && this.isUnreadHostEnv(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
      return [];
    }
    return variableElementKeys(variable.value);
  }

  /** Assigns a scalar value, creating a global variable when no scope holds one, as Bash does. */
  assignScalar(name: string, value: string, append = false): boolean {
    const resolved = this.resolveNameOrUndefined(name);
    if (resolved === undefined) return false;
    const split = this.splitSubscript(resolved);
    if (split) return this.assignReferencedElement(split, value, append);
    if (this.assignDynamic(resolved, value)) return true;
    let variable = this.findVariable(resolved, false);
    if (!variable) {
      variable = { name: resolved, value: undefined, attributes: new Set() };
      this.state.scopes[0].set(resolved, variable);
    }
    return this.assignScalarTo(variable, value, append);
  }

  private assignReferencedElement(split: { name: string; subscript: string }, value: string, append: boolean): boolean {
    const arr = this.resolveNameOrUndefined(split.name);
    if (arr === undefined) return false;
    if (split.subscript === '@' || split.subscript === '*') {
      this.reportError(`${arr}[${split.subscript}]: cannot assign in this way`);
      return false;
    }
    const sub = this.expandDynamicSubscript(split.subscript);
    if (this.isAssociative(arr)) {
      if (sub !== '') return this.assignElement(arr, sub, value, append, true);
      this.reportError(`${split.name}[${split.subscript}]: bad array subscript`);
      return false;
    }
    return this.assignElement(arr, sub === '' && split.subscript !== '' ? '0' : sub, value, append);
  }

  assignScalarTo(variable: Variable, value: string, append = false): boolean {
    if (variable.attributes.has('r')) {
      this.readonlyFailure = true;
      this.reportError(`${variable.name}: readonly variable`);
      return false;
    }
    if (
      variable.value?.kind === 'indexed' ||
      variable.value?.kind === 'associative' ||
      variable.attributes.has('a') ||
      variable.attributes.has('A')
    ) {
      return this.assignElementTo(variable, '0', value, append);
    }
    const base = append && variable.value?.kind === 'scalar' ? variable.value.value : '';
    const converted = this.convertForAttributes(variable, value, base, append);
    if (converted === undefined) return false;
    this.checkLength(converted);
    variable.value = { kind: 'scalar', value: converted };
    variable.shared = false;
    variable.nullReference = false;
    this.lastStored = converted;
    return true;
  }

  /** Applies the integer and case attributes to a value about to be stored, or `undefined` after an error. */
  private convertForAttributes(variable: Variable, value: string, base: string, append: boolean): string | undefined {
    let result: string;
    if (variable.attributes.has('i')) {
      const number = this.evaluateFatalReadonly(value);
      result = append ? String(this.evaluateFatalReadonly(base || '0') + number) : String(number);
      result = String(BigInt.asIntN(64, BigInt(result)));
    } else result = base + value;
    if (variable.attributes.has('u')) result = upperCase(result);
    else if (variable.attributes.has('l')) result = lowerCase(result);
    else if (variable.attributes.has('c')) result = capitalize(result);
    return result;
  }

  private checkLength(value: string): void {
    this.runtime.spend(Math.ceil(value.length / 256));
    if (value.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  }

  /**
   * Assigns `name[subscript]=value`, making `name` an indexed array unless it is an associative one. The subscript
   * is expanded text, which an indexed array evaluates as arithmetic.
   */
  assignElement(name: string, subscript: string, value: string, append: boolean, evaluated = false): boolean {
    if (!isIdentifier(name)) {
      this.reportError(`\`${name}': not a valid identifier`);
      return false;
    }
    if (this.isDynamic(name)) return this.assignDynamic(name, value);
    const existing = this.findVariable(name);
    if (existing?.attributes.has('r')) {
      this.readonlyFailure = true;
      this.reportError(`${name}: readonly variable`);
      return false;
    }
    const target = existing ?? { name, value: undefined, attributes: new Set() };
    const ok = this.assignElementTo(target, subscript, value, append, evaluated, name);
    if (ok && !existing) this.state.scopes[0].set(name, target);
    return ok;
  }

  // code-gauge-allow functionCognitiveComplexity -- Bash's element assignments for associative and indexed arrays, with their subscript errors.
  // code-gauge-allow functionNcss -- Bash's element assignments for associative and indexed arrays, with their subscript errors.
  assignElementTo(
    variable: Variable,
    subscript: string,
    value: string,
    append: boolean,
    evaluated = false,
    reportedName = variable.name
  ): boolean {
    if (variable.attributes.has('r')) {
      this.readonlyFailure = true;
      this.reportError(`${reportedName}: readonly variable`);
      return false;
    }
    ensureWritable(variable);
    if (variable.value?.kind === 'associative' || variable.attributes.has('A')) {
      variable.value ??= { kind: 'associative', table: new AssociativeTable() };
      const table = (variable.value as Extract<VariableValue, { kind: 'associative' }>).table;
      if (subscript === '' && !evaluated) {
        this.reportError(`${reportedName}[${subscript}]: bad array subscript`);
        return false;
      }
      const base = append ? (table.get(subscript) ?? '') : '';
      const converted = this.convertForAttributes(variable, value, base, append);
      if (converted === undefined) return false;
      this.checkLength(converted);
      table.set(subscript, converted);
      this.lastStored = converted;
      return true;
    }
    if (subscript === '') {
      this.reportError(`${reportedName}[]: bad array subscript`);
      return false;
    }
    const declared = this.state.scopes.some((scope) => scope.get(variable.name) === variable) ? variable : undefined;
    const index = evaluated ? BigInt(subscript) : this.arrayIndexFor(declared, subscript, undefined, true);
    if (index === undefined) {
      this.reportError(`${reportedName}[${subscript}]: bad array subscript`);
      return false;
    }
    const elements = this.indexedElements(variable);
    const base = append ? (elements.get(index) ?? '') : '';
    const converted = this.convertForAttributes(variable, value, base, append);
    if (converted === undefined) return false;
    this.checkLength(converted);
    if (!elements.has(index)) this.chargeSlot();
    elements.set(index, converted);
    this.lastStored = converted;
    return true;
  }

  get slotCount(): number {
    return this.slots;
  }

  restoreSlots(count: number): void {
    this.slots = count;
  }

  private chargeSlot(): void {
    this.slots++;
    if (this.slots > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  }

  private slots = 0;

  /** The elements of a variable as an indexed array, converting a scalar into element 0 as Bash does. */
  indexedElements(variable: Variable): Map<bigint, string> {
    return ensureIndexedElements(variable);
  }

  /** Assigns the words of `name=(...)` or `name+=(...)`, already expanded into keyed and plain elements. */
  assignCompound(name: string, elements: CompoundElement[], append: boolean): boolean {
    if (this.isDynamic(name)) return true;
    let variable = this.findVariable(name);
    if (variable?.attributes.has('r')) {
      this.reportError(`${name}: readonly variable`);
      return false;
    }
    if (!variable) {
      variable = { name, value: undefined, attributes: new Set() };
      this.state.scopes[0].set(name, variable);
    }
    return this.assignCompoundTo(variable, elements, append, name);
  }

  // code-gauge-allow functionCognitiveComplexity -- Bash's compound assignments for associative and indexed arrays, keyed and plain elements.
  // code-gauge-allow functionNcss -- Bash's compound assignments for associative and indexed arrays, keyed and plain elements.
  assignCompoundTo(
    variable: Variable,
    elements: CompoundElement[],
    append: boolean,
    reportedName = variable.name
  ): boolean {
    if (variable.attributes.has('r')) {
      this.reportError(`${reportedName}: readonly variable`);
      return false;
    }
    ensureWritable(variable);
    if (variable.value?.kind === 'associative' || variable.attributes.has('A')) {
      const previous = variable.value?.kind === 'associative' ? variable.value.table : undefined;
      const table = append && previous ? previous : new AssociativeTable(previous?.bucketCount);
      const baseTable = append ? table : previous;
      if (append) variable.value = { kind: 'associative', table };
      const ok = this.assignAssociative(variable, table, baseTable, elements, reportedName);
      variable.value = { kind: 'associative', table };
      variable.attributes.add('A');
      return ok;
    }
    const existing = append ? this.indexedElements(variable) : new Map<bigint, string>();
    if (!append) {
      variable.value = { kind: 'indexed', elements: existing };
      variable.attributes.add('a');
    }
    let next = append ? maxElementIndex(existing) + 1n : 0n;
    for (const rawElement of elements) {
      const item = unpackIndexedElement(rawElement);
      const index = item.key === undefined ? next : this.arrayIndexFor(variable, item.key);
      if (index === undefined) {
        this.reportError(`${reportedName}[${item.key ?? ''}]: bad array subscript`);
        return false;
      }
      const base = item.append ? (existing.get(index) ?? '') : '';
      const converted = this.convertForAttributes(variable, item.value, base, item.append);
      if (converted === undefined) return false;
      this.checkLength(converted);
      if (!existing.has(index)) this.chargeSlot();
      existing.set(index, converted);
      next = index + 1n;
    }
    return true;
  }

  /** Assigns an associative array's elements, reading its plain words as alternating keys and values, as Bash 5.1 does. */
  private assignAssociative(
    variable: Variable,
    table: AssociativeTable,
    baseTable: AssociativeTable | undefined,
    elements: CompoundElement[],
    reportedName: string
  ): boolean {
    for (let i = 0; i < elements.length; i++) {
      const entry = readAssociativePair(elements, i, elements[i], reportedName);
      if (entry.consumedNext) i++;
      if (entry.error !== undefined) {
        this.reportError(entry.error);
        continue;
      }
      const base = entry.append ? (baseTable?.get(entry.key) ?? '') : '';
      const converted = this.convertForAttributes(variable, entry.value, base, entry.append);
      if (converted === undefined) return false;
      this.checkLength(converted);
      if (!table.has(entry.key)) this.chargeSlot();
      table.set(entry.key, converted);
    }
    return true;
  }

  /** Performs an assignment word, reporting an error and returning false when it fails. */
  performAssignment(assignment: Assignment): boolean {
    if (!isIdentifier(assignment.name)) {
      this.reportError(`\`${assignment.text}': not a valid identifier`);
      return false;
    }
    if (assignment.array) {
      if (assignment.subscript) {
        this.reportError(`${assignment.name}[${assignment.subscript.text}]: cannot assign list to array member`);
        return false;
      }
      const resolved = this.resolveName(assignment.name);
      if (this.findVariable(resolved)?.attributes.has('r')) {
        this.readonlyFailure = true;
        this.reportError(`${resolved}: readonly variable`);
        return false;
      }
      const { elements, error } = this.expander.expandCompound(assignment.array, this.isAssociative(resolved), false);
      const ok = this.assignCompound(resolved, elements, assignment.append);
      if (error) this.discard(error);
      return ok;
    }
    const value = assignment.value ? this.expander.expandAssignmentValue(assignment.value) : '';
    return assignment.subscript
      ? this.assignElementWord(assignment.name, assignment.subscript, value, assignment.append)
      : this.assignScalar(assignment.name, value, assignment.append);
  }

  /** `name[subscript]=value`, whose error shows the subscript as written. */
  private assignElementWord(name: string, subscript: Word, value: string, append: boolean): boolean {
    const resolved = this.resolveName(name);
    if (!this.isAssociative(resolved)) {
      // Only a subscript written empty is an error; one that expands to nothing evaluates to 0.
      const index = this.expander.expandSubscriptString(subscript);
      return this.assignElement(resolved, index === '' && subscript.text !== '' ? '0' : index, value, append);
    }
    const key = this.expander.expandAssociativeKey(subscript);
    if (key !== '') return this.assignElement(resolved, key, value, append);
    this.reportError(`${name}[${subscript.text}]: bad array subscript`);
    return false;
  }

  /** Unsets a variable, as `unset` does. */
  unsetVariable(name: string, followReference = true): boolean {
    const target = followReference ? this.resolveName(name) : name;
    const split = followReference ? this.splitSubscript(target) : undefined;
    if (split && isIdentifier(split.name)) return unsetElement(this, split.name, split.subscript, true);
    if (this.isDynamic(target)) {
      if (!PERMANENT_DYNAMIC_VARIABLES.has(target)) {
        this.state.unsetDynamic.add(target);
        return true;
      }
      this.reportError(`unset: ${target}: cannot unset`);
      return false;
    }
    const removed = removeScopedVariable(this.state.scopes, this.state.functionScopes.at(-1), target);
    if (removed === 'global' && ENVIRONMENT_VARIABLES.has(target)) this.state.unsetEnv.add(target);
    if (removed !== 'readonly') return true;
    this.reportError(`unset: ${target}: cannot unset: readonly variable`);
    return false;
  }

  /** Evaluates a subscript of a name like `a[i+1]`, as `printf -v` and `unset` read one. */
  splitSubscript(text: string): { name: string; subscript: string } | undefined {
    return splitSubscriptText(text);
  }
}
