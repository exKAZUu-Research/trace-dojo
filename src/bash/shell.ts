// code-gauge-allow-file fileNcss -- Bash's execution, variables, and scopes share the shell state that subshells copy, so they stay in one class.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import {
  ArithmeticError,
  type ArithmeticHost,
  ArithmeticStoreError,
  type ArithmeticTarget,
  evaluateArithmetic,
  skipSubscript,
  type WriteTargetResult,
} from './arithmetic';
import type { ArithmeticSource, Assignment, Program, Redirect, Statement, Word } from './ast';
import { BUILTINS } from './builtins';
import { capitalize, lowerCase, upperCase } from './characters';
import { conditionalStatus } from './conditional';
import { type DeclarationArgument, runDeclaration } from './declare';
import { Expander } from './expansion';
import { EXTERNAL_COMMANDS } from './externalCommands';
import {
  BreakSignal,
  ContinueSignal,
  DiscardSignal,
  ExitSignal,
  type Frame,
  ReturnSignal,
  type Runtime,
  SCRIPT_NAME,
} from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import {
  type ActiveDeclarationPrefix,
  advanceRandomState,
  AssociativeTable,
  type Attribute,
  callStackArray,
  cloneScope,
  cloneValue,
  DYNAMIC_VARIABLES,
  ensureWritable,
  ENVIRONMENT_VARIABLES,
  isIdentifier,
  isValidFunctionName,
  PERMANENT_DYNAMIC_VARIABLES,
  propagatedPrefixTargets,
  type Scope,
  selectDirectPrefix,
  sortedElements,
  type Variable,
  type VariableValue,
} from './variables';

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
  /** `$_`, which starts as the path of Bash itself, so `undefined` until a command sets it. */
  lastArgument: string | undefined;
  randomSeed: number;
  lastRandom: number;
  /** The dynamic variables the program unset, which then lose their special meaning, as in Bash. */
  unsetDynamic: Set<string>;
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
  /** Whether the last command that ran was a call of a function the program defines. */
  private ranFunction = false;
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
  private activeDeclarationPrefix: ActiveDeclarationPrefix | undefined;
  private readonlyFailure = false;

  constructor(readonly runtime: Runtime) {
    const global: Scope = new Map();
    const system = (name: string, value: VariableValue, attributes: Attribute[] = []): void => {
      global.set(name, { name, value, attributes: new Set(attributes), isSystem: true });
    };
    system('IFS', { kind: 'scalar', value: ' \t\n' });
    system('PS4', { kind: 'scalar', value: '+ ' });
    system('OPTIND', { kind: 'scalar', value: '1' });
    system('OPTERR', { kind: 'scalar', value: '1' });
    system('BASH_VERSION', { kind: 'scalar', value: BASH_VERSION });
    system(
      'BASH_VERSINFO',
      {
        kind: 'indexed',
        elements: new Map(
          ['5', '3', '0', '1', 'release', 'aarch64-apple-darwin20.0.0'].map((value, index) => [BigInt(index), value])
        ),
      },
      ['a', 'r']
    );
    this.state = {
      scopes: [global],
      functionScopes: [],
      functions: new Map(),
      positional: [[]],
      calls: [],
      lastStatus: 0,
      lastArgument: undefined,
      randomSeed: 0,
      lastRandom: 0,
      unsetDynamic: new Set(),
      subshellLevel: 0,
      fd1: runtime.io.stdout,
      fd2: runtime.io.stderr,
    };
    this.expander = new Expander(this);
    runtime.reachableStrings = () => this.reachableStrings();
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
          this.state.lastStatus = error.status;
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
    const recordsStep =
      this.conditionDepth === 0 &&
      (statement.kind !== 'declaration' || statement.args.some((arg) => 'name' in arg && 'append' in arg));
    const run = (): number => {
      this.ranFunction = false;
      switch (statement.kind) {
        case 'command': {
          return this.executeCommand(statement);
        }
        case 'declaration': {
          return this.executeDeclaration(statement);
        }
        case 'arithmetic': {
          return this.arithmeticStatus(statement.expression, '((');
        }
        case 'test': {
          return this.executeTest(statement);
        }
        default: {
          throw new Error(`Not a simple command: ${statement.kind}`);
        }
      }
    };
    if (!recordsStep) return this.withRoots(() => this.withStatus(run));
    if (this.listConditionDepth > 0 || (statement.kind === 'declaration' && declaresReferences(statement))) {
      // A list's left command (which may be a pure test) or a name reference records a step only when shown state changed.
      const status = this.withRoots(() => this.withStatus(run));
      this.runtime.steps.stepBinding(statement.row, false);
      return status;
    }
    return this.runtime.steps.runStatement(
      statement.row,
      () => this.ranFunction,
      () => this.withRoots(() => this.withStatus(run))
    );
  }

  /** Runs a command and sets `$?`, before a step records its state. */
  private withStatus(run: () => number): number {
    const status = run();
    this.state.lastStatus = status;
    return status;
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
        if (--error.count > 0) throw error;
        return 'stop';
      }
      if (error instanceof ContinueSignal) {
        last.status = 0;
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
            // A name reference as the loop variable refers to each word in turn, as Bash's `for` makes it.
            const reference = this.findVariable(statement.variable, false);
            if (reference?.attributes.has('n')) {
              if (reference.attributes.has('r')) {
                this.reportError(`${statement.variable}: readonly variable`);
                last.status = 1;
                return;
              }
              reference.value = { kind: 'scalar', value };
            } else if (!this.assignScalar(statement.variable, value)) {
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

  private executeArithmeticFor(statement: Extract<Statement, { kind: 'arithmeticFor' }>): number {
    const header = (source: ArithmeticSource | undefined): void => {
      if (!source) return;
      this.currentRow = statement.row - this.lineShift;
      this.evaluate(source, '((');
      this.runtime.steps.step(statement.row);
    };
    header(statement.init);
    return this.loop((last) => {
      for (;;) {
        this.runtime.spend();
        this.currentRow = statement.row - this.lineShift;
        if (statement.condition && this.evaluate(statement.condition, '((') === 0n) return;
        if (this.iterate(statement.body, last) === 'stop') return;
        header(statement.update);
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

  private executeCommand(statement: Extract<Statement, { kind: 'command' }>): number {
    const argv = this.expander.expandWords(statement.words);
    if (argv.length === 0) {
      // A command of assignments alone expands and commits before redirections and takes its last substitution status.
      this.expander.lastSubstitutionStatus = 0;
      for (const assignment of statement.assignments) {
        if (!this.performAssignment(assignment)) throw new DiscardSignal();
      }
      this.state.lastArgument = '';
      const status = this.expander.lastSubstitutionStatus;
      return this.withRedirects(statement.redirects, () => status);
    }
    const [name] = argv;
    const fn = this.state.functions.get(name);
    if (fn) {
      return this.withTemporaryScope(statement.assignments, () =>
        this.withRedirects(statement.redirects, () => {
          const status = this.callFunction(fn, argv.slice(1), statement.row);
          // The commands in the function reset the flag, so the call sets it after they ran.
          this.ranFunction = true;
          this.state.lastArgument = argv.at(-1) as string;
          return status;
        })
      );
    }
    const builtin = Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : undefined;
    if (builtin) {
      return this.withTemporaryScope(statement.assignments, () =>
        this.withRedirects(statement.redirects, () => {
          const status = builtin(this, argv.slice(1), name);
          this.state.lastArgument = argv.at(-1) as string;
          return status;
        })
      );
    }
    return this.withTemporaryScope(statement.assignments, () =>
      this.withRedirects(statement.redirects, () => {
        if (EXTERNAL_COMMANDS.has(name) || name.includes('/')) {
          throw new UnsupportedFeatureError(`外部コマンド（${name}）`);
        }
        this.reportError(`${name}: command not found`);
        this.state.lastArgument = argv.at(-1) as string;
        return 127;
      })
    );
  }

  private removeScope(scope: Scope): void {
    const index = this.state.scopes.lastIndexOf(scope);
    if (index !== -1) this.state.scopes.splice(index, 1);
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
    const active = forDeclaration ? { scope, propagated: new Set<string>() } : undefined;
    this.state.scopes.push(scope);
    this.activeDeclarationPrefix = active;
    try {
      for (const assignment of assignments) {
        if (assignment.subscript || assignment.array) {
          // Bash assigns array elements before a command in the shell itself.
          if (!this.performAssignment(assignment)) return 1;
          continue;
        }
        const value = assignment.value ? this.expander.expandAssignmentValue(assignment.value) : '';
        const existing = this.findOwnVariable(assignment.name);
        if (existing?.attributes.has('r')) {
          // Bash reports the assignment and runs the command without it.
          this.reportError(`${assignment.name}: readonly variable`);
          continue;
        }
        const base = assignment.append ? (this.scalarValue(assignment.name) ?? '') : '';
        scope.set(assignment.name, {
          name: assignment.name,
          value: { kind: 'scalar', value: base + value },
          attributes: new Set(['x']),
        });
      }
      return run();
    } finally {
      this.activeDeclarationPrefix = prevPrefix;
      this.removeScope(scope);
      if (active) this.commitPropagatedPrefixes(active);
    }
  }

  private commitPropagatedPrefixes(active: ActiveDeclarationPrefix): void {
    for (const { target, tempVar } of propagatedPrefixTargets(this.state.scopes, active)) {
      if (tempVar.value?.kind === 'scalar') this.assignScalarTo(target, tempVar.value.value, false);
      else if (tempVar.value) {
        target.value = tempVar.value;
        target.shared = false;
      }
      for (const attr of tempVar.attributes) target.attributes.add(attr);
    }
  }

  private executeDeclaration(statement: Extract<Statement, { kind: 'declaration' }>): number {
    const args: DeclarationArgument[] = [];
    for (const arg of statement.args) {
      if ('append' in arg) {
        args.push(
          arg.value
            ? {
                ...arg,
                value: {
                  parts: [
                    {
                      kind: 'single',
                      text: this.expander.withSpacedStar(() => this.expander.expandAssignmentValue(arg.value as Word)),
                    },
                  ],
                  row: arg.value.row,
                  text: arg.value.text,
                },
              }
            : arg
        );
      } else args.push(...this.expander.expandWords([arg]));
    }
    return this.withTemporaryScope(
      statement.assignments,
      () =>
        this.withRedirects(statement.redirects, () => {
          const status = runDeclaration(this, statement.name, args);
          const last = args.at(-1);
          this.state.lastArgument = last === undefined ? statement.name : typeof last === 'string' ? last : last.text;
          return status;
        }),
      true
    );
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
  captureSubshell(body: Statement[]): { output: string; status: number } {
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
      unsetDynamic: new Set(parent.unsetDynamic),
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
    const savedRanFunction = this.ranFunction;
    this.loopDepth = 0;
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
      this.ranFunction = savedRanFunction;
    }
    this.inFlight.at(-1)?.values.push(buffer.text);
    // Bash keeps the random generator's state across command substitutions only when they reseed it.
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

  private evaluateFatalReadonly(text: string): bigint {
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
    const index = willRead ? this.readIndex(resolved, rawSubscript) : this.arrayIndex(resolved, rawSubscript);
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
    const variable = this.findVariable(name);
    return variable?.value?.kind === 'associative' || variable?.attributes.has('A') === true;
  }

  // ---------------------------------------------------------------- variables

  /** The variable a name refers to, from the innermost scope, following name references. */
  findVariable(name: string, followReferences = true): Variable | undefined {
    let target = name;
    for (let depth = 0; depth < 8; depth++) {
      const variable = this.findOwnVariable(target);
      if (!followReferences || !variable?.attributes.has('n') || variable.value?.kind !== 'scalar') return variable;
      target = variable.value.value;
      if (target === '') return variable;
      const open = target.indexOf('[');
      if (open !== -1) return this.findOwnVariable(target.slice(0, open));
    }
    return undefined;
  }

  findOwnVariable(name: string): Variable | undefined {
    const { scopes } = this.state;
    for (let i = scopes.length - 1; i >= 0; i--) {
      const variable = scopes[i].get(name);
      if (variable) return variable;
    }
    return undefined;
  }

  selectCommandPrefix(name: string, assigns: boolean, unsetExport: boolean): Variable | undefined {
    return selectDirectPrefix(this.activeDeclarationPrefix, name, assigns, unsetExport);
  }

  /** The name a name reference finally names, or the name itself. */
  resolveName(name: string): string {
    let target = name;
    for (let depth = 0; depth < 8; depth++) {
      const variable = this.findOwnVariable(target);
      if (!variable?.attributes.has('n') || variable.value?.kind !== 'scalar' || variable.value.value === '') {
        return target;
      }
      target = variable.value.value;
    }
    return target;
  }

  /** The value of `$name`: a scalar, or element 0 of an array, or `undefined` when unset. */
  scalarValue(name: string): string | undefined {
    const resolved = this.resolveName(name);
    const open = resolved.indexOf('[');
    if (open !== -1) return this.elementValue(resolved.slice(0, open), resolved.slice(open + 1, -1));
    const dynamic = this.dynamicValue(resolved);
    if (dynamic !== undefined) return dynamic;
    const variable = this.findVariable(resolved, false);
    if (!variable) {
      if (ENVIRONMENT_VARIABLES.has(resolved)) throw new UnsupportedFeatureError(`環境変数（${resolved}）`);
      return undefined;
    }
    const { value } = variable;
    if (!value) return undefined;
    if (value.kind === 'scalar') return value.value;
    if (value.kind === 'indexed') return value.elements.get(0n);
    return value.table.get('0');
  }

  /** The value of a dynamic variable Bash computes when it is read, unless the program unset or shadowed it. */
  private dynamicValue(name: string): string | undefined {
    if (!this.isDynamic(name)) return undefined;
    switch (name) {
      case 'RANDOM': {
        return String(this.nextRandom());
      }
      case 'LINENO': {
        return String(this.currentRow + 1);
      }
      case 'BASH_SUBSHELL': {
        return String(this.state.subshellLevel);
      }
      default: {
        return this.dynamicArray(name)?.[0];
      }
    }
  }

  /** The elements of `FUNCNAME`, `BASH_LINENO`, and `BASH_SOURCE`, which describe the calls in progress. */
  dynamicArray(name: string): string[] | undefined {
    return this.isDynamic(name) ? callStackArray(name, this.state.calls, SCRIPT_NAME) : undefined;
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
    if (name === 'RANDOM' || name === 'LINENO' || name === 'BASH_SUBSHELL') {
      const attributes = new Set<Attribute>(name === 'RANDOM' ? ['i'] : []);
      return { name, attributes, value: { kind: 'scalar', value: this.dynamicValue(name) as string } };
    }
    const elements = this.dynamicArray(name);
    return {
      name,
      attributes: new Set(['a']),
      value: elements && {
        kind: 'indexed',
        elements: new Map(elements.map((element, index) => [BigInt(index), element])),
      },
    };
  }

  isDynamic(name: string): boolean {
    return DYNAMIC_VARIABLES.has(name) && !this.state.unsetDynamic.has(name) && !this.findOwnVariable(name);
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
      if (!variable && ENVIRONMENT_VARIABLES.has(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
      if (variable === undefined || !variable.attributes.has('A')) this.readIndex(name, subscript);
      return undefined;
    }
    if (variable.value.kind === 'associative') return variable.value.table.get(subscript);
    const index = this.readIndex(name, subscript);
    if (index === undefined) return undefined;
    if (variable.value.kind === 'scalar') return index === 0n ? variable.value.value : undefined;
    return this.elementAtIndex(name, index);
  }

  elementAtIndex(name: string, index: bigint): string | undefined {
    const variable = this.findVariable(name);
    const value = variable?.value;
    if (!value) {
      const dynamic = this.dynamicArray(name);
      if (dynamic) return dynamic[Number(index)];
      if (!variable && ENVIRONMENT_VARIABLES.has(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
      return undefined;
    }
    if (value.kind === 'scalar') return index === 0n ? value.value : undefined;
    if (value.kind === 'associative') return value.table.get(String(index));
    return value.elements.get(index);
  }

  /**
   * Evaluates an indexed array's subscript, counting a negative one from the end, as Bash does, or `undefined` for a
   * negative one before the first element, which each caller reports in its own way.
   */
  arrayIndex(name: string, subscript: string): bigint | undefined {
    return this.arrayIndexFor(this.findVariable(name), subscript);
  }

  private arrayIndexFor(variable: Variable | undefined, subscript: string): bigint | undefined {
    const index = this.evaluateFatalReadonly(subscript);
    if (index >= 0n) return index;
    const length = variable?.value?.kind === 'indexed' ? this.maxIndex(variable.value.elements) + 1n : 1n;
    const resolved = length + index;
    return resolved < 0n ? undefined : resolved;
  }

  /** An index to read an element at, reporting one before the first element, which reads as unset. */
  private readIndex(name: string, subscript: string): bigint | undefined {
    const index = this.arrayIndex(name, subscript);
    if (index === undefined) this.reportError(`${name}: bad array subscript`);
    return index;
  }

  maxIndex(elements: Map<bigint, string>): bigint {
    let max = -1n;
    for (const key of elements.keys()) if (key > max) max = key;
    return max;
  }

  /** The values of `${name[@]}`: the elements of an array, the value of a scalar, or none when unset. */
  arrayValues(name: string): string[] {
    const variable = this.findVariable(name);
    if (!variable?.value) {
      const dynamic = this.dynamicArray(name);
      if (dynamic) return dynamic;
      if (!variable && ENVIRONMENT_VARIABLES.has(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
      return [];
    }
    const { value } = variable;
    if (value.kind === 'scalar') return [value.value];
    if (value.kind === 'indexed') return sortedElements(value.elements).map(([, element]) => element);
    return value.table.entries().map(([, element]) => element);
  }

  /** The keys of `${!name[@]}`. */
  arrayKeys(name: string): string[] {
    const variable = this.findVariable(name);
    if (!variable?.value) {
      const dynamic = this.dynamicArray(name);
      if (dynamic) return dynamic.map((_, index) => String(index));
      if (!variable && ENVIRONMENT_VARIABLES.has(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
      return [];
    }
    const { value } = variable;
    if (value.kind === 'scalar') return ['0'];
    if (value.kind === 'indexed') return sortedElements(value.elements).map(([key]) => String(key));
    return value.table.entries().map(([key]) => key);
  }

  /** Assigns a scalar value, creating a global variable when no scope holds one, as Bash does. */
  assignScalar(name: string, value: string, append = false): boolean {
    const resolved = this.resolveName(name);
    const open = resolved.indexOf('[');
    if (open !== -1) return this.assignElement(resolved.slice(0, open), resolved.slice(open + 1, -1), value, append);
    if (this.assignDynamic(resolved, value)) return true;
    let variable = this.findVariable(resolved, false);
    if (!variable) {
      variable = { name: resolved, value: undefined, attributes: new Set() };
      this.state.scopes[0].set(resolved, variable);
    }
    return this.assignScalarTo(variable, value, append);
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
    if (this.isDynamic(name)) return this.assignDynamic(name, value);
    let variable = this.findVariable(name);
    if (variable?.attributes.has('r')) {
      this.readonlyFailure = true;
      this.reportError(`${name}: readonly variable`);
      return false;
    }
    if (!variable) {
      variable = { name, value: undefined, attributes: new Set() };
      this.state.scopes[0].set(name, variable);
    }
    return this.assignElementTo(variable, subscript, value, append, evaluated, name);
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
    const index = evaluated ? BigInt(subscript) : this.arrayIndexFor(variable, subscript);
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
    ensureWritable(variable);
    if (variable.value?.kind === 'indexed') return variable.value.elements;
    const elements = new Map<bigint, string>();
    if (variable.value?.kind === 'scalar') elements.set(0n, variable.value.value);
    variable.value = { kind: 'indexed', elements };
    variable.shared = false;
    variable.attributes.add('a');
    return elements;
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
      variable.value = { kind: 'associative', table };
      return this.assignAssociative(variable, table, elements);
    }
    const existing = append ? this.indexedElements(variable) : new Map<bigint, string>();
    if (!append) {
      variable.value = { kind: 'indexed', elements: existing };
      variable.attributes.add('a');
    }
    let next = append ? this.maxIndex(existing) + 1n : 0n;
    for (const element of elements) {
      const index = typeof element === 'string' ? next : this.arrayIndexFor(variable, element.key);
      if (index === undefined) {
        this.reportError(`${reportedName}[${(element as { key: string }).key}]: bad array subscript`);
        return false;
      }
      const keyed = typeof element === 'string' ? { value: element, append: false } : element;
      const base = keyed.append ? (existing.get(index) ?? '') : '';
      const converted = this.convertForAttributes(variable, keyed.value, base, keyed.append);
      if (converted === undefined) return false;
      this.checkLength(converted);
      if (!existing.has(index)) this.chargeSlot();
      existing.set(index, converted);
      next = index + 1n;
    }
    return true;
  }

  /** Assigns an associative array's elements, reading its plain words as alternating keys and values, as Bash 5.1 does. */
  private assignAssociative(variable: Variable, table: AssociativeTable, elements: CompoundElement[]): boolean {
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      const entry =
        typeof element === 'string'
          ? { key: element, value: typeof elements[++i] === 'string' ? (elements[i] as string) : '', append: false }
          : element;
      const base = entry.append ? (table.get(entry.key) ?? '') : '';
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
      const { elements, error } = this.expander.expandCompound(assignment.array, this.isAssociative(resolved), false);
      const ok = this.assignCompound(resolved, elements, assignment.append);
      if (error) this.discard(error);
      return ok;
    }
    const value = assignment.value ? this.expander.expandAssignmentValue(assignment.value) : '';
    if (assignment.subscript)
      return this.assignElementWord(assignment.name, assignment.subscript, value, assignment.append);
    return this.assignScalar(assignment.name, value, assignment.append);
  }

  /** `name[subscript]=value`, whose error shows the subscript as written. */
  private assignElementWord(name: string, subscript: Word, value: string, append: boolean): boolean {
    const resolved = this.resolveName(name);
    if (this.isAssociative(resolved)) {
      const key = this.expander.expandAssociativeKey(subscript);
      if (key === '') {
        this.reportError(`${name}[${subscript.text}]: bad array subscript`);
        return false;
      }
      return this.assignElement(resolved, key, value, append);
    }
    // Only a subscript written empty is an error; one that expands to nothing evaluates to 0.
    const index = this.expander.expandSubscriptString(subscript);
    return this.assignElement(resolved, index === '' && subscript.text !== '' ? '0' : index, value, append);
  }

  /** Unsets a variable, as `unset` does. */
  unsetVariable(name: string, followReference = true): boolean {
    const target = followReference ? this.resolveName(name) : name;
    if (this.isDynamic(target)) {
      if (PERMANENT_DYNAMIC_VARIABLES.has(target)) {
        this.reportError(`unset: ${target}: cannot unset`);
        return false;
      }
      this.state.unsetDynamic.add(target);
      return true;
    }
    const { scopes } = this.state;
    for (let i = scopes.length - 1; i >= 0; i--) {
      const variable = scopes[i].get(target);
      if (!variable) continue;
      if (variable.attributes.has('r')) {
        this.reportError(`unset: ${target}: cannot unset: readonly variable`);
        return false;
      }
      // Unsetting a local of the running function leaves it declared there without a value, as Bash 5 does.
      if (i > 0 && this.state.functionScopes.at(-1) === i) {
        variable.value = undefined;
        variable.shared = false;
        variable.attributes.clear();
      } else scopes[i].delete(target);
      return true;
    }
    return true;
  }

  // code-gauge-allow functionCognitiveComplexity -- Walks every value kind of every scope of the running and suspended shells.
  private *reachableStrings(): Iterable<string> {
    for (const state of [...this.suspended, this.state]) {
      for (const scope of state.scopes) {
        for (const variable of scope.values()) {
          const { value } = variable;
          if (!value) continue;
          if (value.kind === 'scalar') yield value.value;
          else if (value.kind === 'indexed') yield* value.elements.values();
          else for (const [, element] of value.table.entries()) yield element;
        }
      }
      for (const args of state.positional) yield* args;
    }
    for (const { text } of this.activeOutputs) yield text;
    for (const { values } of this.inFlight) yield* values;
  }

  /** Copies a value for `local` to inherit, as `declare -I` does; plain `local` starts unset. */
  copyValue(value: VariableValue | undefined): VariableValue | undefined {
    return cloneValue(value);
  }

  /** Evaluates a subscript of a name like `a[i+1]`, as `printf -v` and `unset` read one. */
  splitSubscript(text: string): { name: string; subscript: string } | undefined {
    const open = text.indexOf('[');
    if (open === -1) return undefined;
    const close = skipSubscript(text, open);
    if (close !== text.length - 1) return undefined;
    return { name: text.slice(0, open), subscript: text.slice(open + 1, close) };
  }
}

/** An element of a compound assignment: a plain word, or `[key]=value`. */
export type CompoundElement = { key: string; value: string; append: boolean } | string;

/** Whether a declaration declares name references (`local -n this=$1`), which hold no value of their own. */
function declaresReferences(statement: Extract<Statement, { kind: 'declaration' }>): boolean {
  return statement.args.some((arg) => !('append' in arg) && /^-[A-Za-z]*n[A-Za-z]*$/.test(arg.text));
}
