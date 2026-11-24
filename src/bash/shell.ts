// code-gauge-allow-file fileNcss -- Bash's execution, variables, and scopes share the shell state that subshells copy, so they stay in one class.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { ArithmeticError, type ArithmeticHost, evaluateArithmetic, skipSubscript } from './arithmetic';
import type { ArithmeticSource, Assignment, Program, Redirect, Statement, Word } from './ast';
import { BUILTINS } from './builtins';
import { charactersOf } from './characters';
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
  AssociativeTable,
  type Attribute,
  cloneScope,
  cloneValue,
  isIdentifier,
  type Scope,
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

/** The shell variables that hold the shell's environment, which this environment does not have. */
const ENVIRONMENT_VARIABLES = new Set([
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'TMPDIR',
  'HOSTNAME',
  'HOSTTYPE',
  'OSTYPE',
  'MACHTYPE',
  'UID',
  'EUID',
  'PPID',
  'BASHPID',
  'BASH',
  'SHLVL',
  'SECONDS',
  'EPOCHSECONDS',
  'EPOCHREALTIME',
  'SRANDOM',
  'GROUPS',
  'DIRSTACK',
  'MAIL',
  'MAILCHECK',
  'BASH_ARGV',
  'BASH_ARGC',
  'BASH_ARGV0',
  'BASH_COMMAND',
  'BASH_EXECUTION_STRING',
  'BASHOPTS',
  'SHELLOPTS',
  'BASH_ALIASES',
  'BASH_CMDS',
  'BASH_LOADABLES_PATH',
  'COMP_WORDBREAKS',
  'HISTCMD',
  'COLUMNS',
  'LINES',
  'EDITOR',
  'PS1',
  'PS2',
  '_',
]);

/** The variables Bash computes whenever a program reads them. */
const DYNAMIC_VARIABLES = new Set(['RANDOM', 'LINENO', 'FUNCNAME', 'BASH_LINENO', 'BASH_SOURCE', 'BASH_SUBSHELL']);
/** The dynamic variables Bash refuses to unset. */
const PERMANENT_DYNAMIC_VARIABLES = new Set(['BASH_LINENO', 'BASH_SOURCE']);

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
        this.conditionDepth++;
        let left: number;
        try {
          left = this.execute(statement.left);
        } finally {
          this.conditionDepth--;
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
    if (!recordsStep) return this.withStatus(run);
    if (statement.kind === 'declaration' && declaresReferences(statement)) {
      // A name reference stores no value learners answer, as Java's `this` binds none, so it records a step only
      // when it changes what the trace shows.
      const status = this.withStatus(run);
      this.runtime.steps.stepBinding(statement.row, false);
      return status;
    }
    return this.runtime.steps.runStatement(
      statement.row,
      () => this.ranFunction,
      () => this.withStatus(run)
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
    const values = statement.values
      ? this.leavingLine(() => this.expander.expandWords(statement.values as Word[]))
      : [...(this.state.positional.at(-1) as string[])];
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
          const reference = this.findOwnVariable(statement.variable);
          if (reference?.attributes.has('n')) reference.value = { kind: 'scalar', value };
          else this.assignScalar(statement.variable, value);
          this.runtime.steps.stepBinding(statement.row, !bindsObjects && value !== '');
          if (this.iterate(statement.body, last) === 'stop') return;
        }
      })
    );
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

  // code-gauge-allow functionCognitiveComplexity -- Bash's order of expansion, assignment, and lookup of functions, builtins, and external commands.
  // code-gauge-allow functionNcss -- Bash's order of expansion, assignment, and lookup of functions, builtins, and external commands.
  private executeCommand(statement: Extract<Statement, { kind: 'command' }>): number {
    const argv = this.expander.expandWords(statement.words);
    if (argv.length === 0) {
      // A command of assignments alone takes the status of its last command substitution.
      this.expander.lastSubstitutionStatus = 0;
      // A failed assignment, as to a readonly variable, abandons the line, as it does in Bash.
      for (const assignment of statement.assignments) {
        if (!this.performAssignment(assignment)) throw new DiscardSignal();
      }
      this.state.lastArgument = '';
      return this.expander.lastSubstitutionStatus;
    }
    return this.withRedirects(statement.redirects, () => {
      const [name] = argv;
      const fn = this.state.functions.get(name);
      if (fn) {
        const temporary = this.temporaryScope(statement.assignments);
        if (temporary === undefined) return 1;
        const status = this.callFunction(fn, argv.slice(1), statement.row, temporary);
        // The commands in the function reset the flag, so the call sets it after they ran.
        this.ranFunction = true;
        this.state.lastArgument = argv.at(-1) as string;
        return status;
      }
      const builtin = BUILTINS[name];
      if (builtin) {
        const temporary = this.temporaryScope(statement.assignments);
        if (temporary === undefined) return 1;
        this.state.scopes.push(temporary);
        let status: number;
        try {
          status = builtin(this, argv.slice(1), name);
        } finally {
          this.removeScope(temporary);
        }
        this.state.lastArgument = argv.at(-1) as string;
        return status;
      }
      if (EXTERNAL_COMMANDS.has(name) || name.includes('/')) {
        throw new UnsupportedFeatureError(`外部コマンド（${name}）`);
      }
      this.reportError(`${name}: command not found`);
      this.state.lastArgument = argv.at(-1) as string;
      return 127;
    });
  }

  private removeScope(scope: Scope): void {
    const index = this.state.scopes.lastIndexOf(scope);
    if (index !== -1) this.state.scopes.splice(index, 1);
  }

  /** The scope of the assignments written before a command, which hold only while it runs. */
  private temporaryScope(assignments: Assignment[]): Scope | undefined {
    const scope: Scope = new Map();
    for (const assignment of assignments) {
      if (assignment.subscript || assignment.array) {
        // Bash assigns array elements before a command in the shell itself.
        if (!this.performAssignment(assignment)) return undefined;
        continue;
      }
      const value = assignment.value ? this.expander.expandAssignmentValue(assignment.value) : '';
      const existing = this.findVariable(assignment.name);
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
    return scope;
  }

  private executeDeclaration(statement: Extract<Statement, { kind: 'declaration' }>): number {
    return this.withRedirects(statement.redirects, () => {
      const args: DeclarationArgument[] = [];
      for (const arg of statement.args) {
        if ('append' in arg) args.push(arg);
        else args.push(...this.expander.expandWords([arg]));
      }
      const status = runDeclaration(this, statement.name, args);
      const last = args.at(-1);
      this.state.lastArgument = last === undefined ? statement.name : typeof last === 'string' ? last : last.text;
      return status;
    });
  }

  // ---------------------------------------------------------------- functions

  // code-gauge-allow functionNcss -- Sets up and restores every part of the shell state a function call changes.
  callFunction(fn: FunctionDefinition, args: string[], callRow: number, temporary?: Scope): number {
    if (this.runtime.frames.length >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
    const { state } = this;
    if (temporary && temporary.size > 0) state.scopes.push(temporary);
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
    const savedShift = this.lineShift;
    this.loopDepth = 0;
    this.conditionDepth = 0;
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
      this.lineShift = savedShift;
      this.runtime.frames.pop();
      // A subshell's state replaces the caller's while it runs, so the call cleans up the state it started in.
      state.calls.pop();
      state.positional.pop();
      state.functionScopes.pop();
      state.scopes.length = scopeIndex;
      if (temporary && temporary.size > 0) state.scopes.splice(state.scopes.lastIndexOf(temporary), 1);
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
    let output = '';
    const capture: OutputTarget = {
      write: (text) => {
        output += text;
        if (output.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
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
    this.state = child;
    const savedLoop = this.loopDepth;
    const savedCondition = this.conditionDepth;
    const savedRow = this.currentRow;
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
      this.state = this.suspended.pop() as ShellState;
      this.loopDepth = savedLoop;
      this.conditionDepth = savedCondition;
      this.currentRow = savedRow;
    }
    // Bash keeps the random generator's state across command substitutions only when they reseed it.
    return { output, status };
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
      if (!(error instanceof ArithmeticError)) throw error;
      this.reportError(error.message);
      return undefined;
    }
  }

  valueOf(token: string, isElement: boolean): { value: string | undefined; index: bigint } {
    if (!isElement) return { value: this.scalarValue(token), index: -1n };
    const open = token.indexOf('[');
    const name = token.slice(0, open);
    const subscript = token.slice(open + 1, -1);
    if (subscript === '') {
      // Bash checks the subscript twice before it reads an element, reporting an empty one each time, and reads 0.
      this.reportError(`${name}[]: bad array subscript`);
      this.reportError(`${name}[]: bad array subscript`);
      return { value: undefined, index: -1n };
    }
    if (this.isAssociative(name)) {
      return { value: this.elementValue(name, this.expander.expandSubscriptText(subscript)), index: -1n };
    }
    if (subscript === '@' || subscript === '*') {
      return { value: this.elementValue(name, '0'), index: -1n };
    }
    const index = this.readIndex(name, subscript);
    return index === undefined ? { value: undefined, index: -1n } : { value: this.indexedElement(name, index), index };
  }

  assign(lhs: string, value: string): void {
    const open = lhs.indexOf('[');
    if (open === -1) {
      this.assignScalar(lhs, value);
      return;
    }
    this.assignElement(lhs.slice(0, open), lhs.slice(open + 1, -1), value, false, true);
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
    if (!this.isDynamic(name)) return undefined;
    const calls = this.state.calls.toReversed();
    switch (name) {
      case 'FUNCNAME': {
        // Outside every function, `FUNCNAME` is declared without elements, while the others describe the script.
        return calls.length === 0 ? undefined : [...calls.map((call) => call.name), 'main'];
      }
      case 'BASH_LINENO': {
        return [...calls.map((call) => String(call.line)), '0'];
      }
      case 'BASH_SOURCE': {
        return [...calls.map(() => SCRIPT_NAME), SCRIPT_NAME];
      }
      default: {
        return undefined;
      }
    }
  }

  /**
   * Assigns a dynamic variable as Bash does, telling whether the name is one: `RANDOM` takes a seed, `BASH_SUBSHELL` a
   * new level, and the others ignore the value, since Bash computes them when they are read.
   */
  assignDynamic(name: string, value: string): boolean {
    if (!this.isDynamic(name)) return false;
    if (name === 'RANDOM') this.seedRandom(value);
    if (name === 'BASH_SUBSHELL') this.state.subshellLevel = /^\s*[-+]?\d+\s*$/.test(value) ? Number(value) : 0;
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
    let value: number;
    do {
      let seed = this.state.randomSeed === 0 ? 123_459_876 : this.state.randomSeed;
      const high = Math.trunc(seed / 127_773);
      const low = seed % 127_773;
      seed = 16_807 * low - 2836 * high;
      if (seed < 0) seed += 0x7f_ff_ff_ff;
      this.state.randomSeed = seed;
      value = ((seed >>> 16) ^ (seed & 0xff_ff)) & 0x7f_ff;
    } while (value === this.state.lastRandom);
    this.state.lastRandom = value;
    return value;
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
    return this.indexedElement(name, index);
  }

  private indexedElement(name: string, index: bigint): string | undefined {
    const variable = this.findVariable(name);
    const value = variable?.value;
    if (!value) {
      const dynamic = this.dynamicArray(name);
      return dynamic?.[Number(index)];
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
    const index = this.evaluateText(subscript, undefined);
    if (index >= 0n) return index;
    const variable = this.findVariable(name);
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

  private maxIndex(elements: Map<bigint, string>): bigint {
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
    if (variable?.attributes.has('r')) {
      this.reportError(`${resolved}: readonly variable`);
      return false;
    }
    if (!variable) {
      variable = { name: resolved, value: undefined, attributes: new Set() };
      this.state.scopes[0].set(resolved, variable);
    }
    if (variable.value?.kind === 'indexed' || variable.value?.kind === 'associative') {
      return this.assignElement(resolved, variable.value.kind === 'indexed' ? '0' : '0', value, append);
    }
    const base = append && variable.value?.kind === 'scalar' ? variable.value.value : '';
    const converted = this.convertForAttributes(variable, value, base, append);
    if (converted === undefined) return false;
    this.checkLength(converted);
    variable.value = { kind: 'scalar', value: converted };
    return true;
  }

  /** Applies the integer and case attributes to a value about to be stored, or `undefined` after an error. */
  private convertForAttributes(variable: Variable, value: string, base: string, append: boolean): string | undefined {
    let result: string;
    if (variable.attributes.has('i')) {
      const number = this.evaluateText(value, undefined);
      result = append ? String(this.evaluateText(base || '0', undefined) + number) : String(number);
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
  // code-gauge-allow functionCognitiveComplexity -- Bash's element assignments for associative and indexed arrays, with their subscript errors.
  // code-gauge-allow functionNcss -- Bash's element assignments for associative and indexed arrays, with their subscript errors.
  assignElement(name: string, subscript: string, value: string, append: boolean, evaluated = false): boolean {
    if (this.isDynamic(name)) return this.assignDynamic(name, value);
    let variable = this.findVariable(name);
    if (variable?.attributes.has('r')) {
      this.reportError(`${name}: readonly variable`);
      return false;
    }
    if (!variable) {
      variable = { name, value: undefined, attributes: new Set() };
      this.state.scopes[0].set(name, variable);
    }
    if (variable.value?.kind === 'associative' || variable.attributes.has('A')) {
      variable.value ??= { kind: 'associative', table: new AssociativeTable() };
      const table = (variable.value as Extract<VariableValue, { kind: 'associative' }>).table;
      if (subscript === '' && !evaluated) {
        this.reportError(`${name}[${subscript}]: bad array subscript`);
        return false;
      }
      const base = append ? (table.get(subscript) ?? '') : '';
      const converted = this.convertForAttributes(variable, value, base, append);
      if (converted === undefined) return false;
      this.checkLength(converted);
      table.set(subscript, converted);
      return true;
    }
    if (subscript === '') {
      this.reportError(`${name}[]: bad array subscript`);
      return false;
    }
    const index = evaluated ? BigInt(subscript) : this.arrayIndex(name, subscript);
    if (index === undefined) {
      this.reportError(`${name}[${subscript}]: bad array subscript`);
      return false;
    }
    const elements = this.indexedElements(variable);
    const base = append ? (elements.get(index) ?? '') : '';
    const converted = this.convertForAttributes(variable, value, base, append);
    if (converted === undefined) return false;
    this.checkLength(converted);
    if (!elements.has(index)) this.chargeSlot();
    elements.set(index, converted);
    return true;
  }

  private chargeSlot(): void {
    this.slots++;
    if (this.slots > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  }

  private slots = 0;

  /** The elements of a variable as an indexed array, converting a scalar into element 0 as Bash does. */
  indexedElements(variable: Variable): Map<bigint, string> {
    if (variable.value?.kind === 'indexed') return variable.value.elements;
    const elements = new Map<bigint, string>();
    if (variable.value?.kind === 'scalar') elements.set(0n, variable.value.value);
    variable.value = { kind: 'indexed', elements };
    variable.attributes.add('a');
    return elements;
  }

  /** Assigns the words of `name=(...)` or `name+=(...)`, already expanded into keyed and plain elements. */
  // code-gauge-allow functionCognitiveComplexity -- Bash's compound assignments for associative and indexed arrays, keyed and plain elements.
  // code-gauge-allow functionNcss -- Bash's compound assignments for associative and indexed arrays, keyed and plain elements.
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
      const index = typeof element === 'string' ? next : this.arrayIndex(name, element.key);
      if (index === undefined) {
        this.reportError(`${name}[${(element as { key: string }).key}]: bad array subscript`);
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
      const key = this.expander.expandString(subscript);
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
        variable.attributes.clear();
      } else scopes[i].delete(target);
      return true;
    }
    return true;
  }

  // ---------------------------------------------------------------- traces

  /** The variables a frame sees: its locals and its callers', then the globals, the innermost first. */
  visibleVariables(frame: Frame): Variable[] {
    const scopes = this.state.scopes.slice(0, frame.scopeIndex + 1);
    const seen = new Set<string>();
    const result: Variable[] = [];
    for (let i = scopes.length - 1; i >= 0; i--) {
      for (const variable of scopes[i].values()) {
        if (seen.has(variable.name)) continue;
        seen.add(variable.name);
        if (!variable.isSystem && variable.value) result.push(variable);
      }
    }
    return result.toSorted((a, b) => scopeRank(scopes, b) - scopeRank(scopes, a));
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

function scopeRank(scopes: Scope[], variable: Variable): number {
  for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].get(variable.name) === variable) return i;
  return -1;
}

/** Whether a function's name is one Bash accepts outside POSIX mode: any word without `$` or a slash at its start. */
function isValidFunctionName(name: string): boolean {
  return name !== '' && !name.includes('$') && !/^[0-9]+$/.test(name);
}

export function upperCase(text: string): string {
  return charactersOf(text)
    .map((c) => mapCase(c, c.toUpperCase()))
    .join('');
}

export function lowerCase(text: string): string {
  return charactersOf(text)
    .map((c) => mapCase(c, c.toLowerCase()))
    .join('');
}

function capitalize(text: string): string {
  const [first = '', ...rest] = charactersOf(text);
  return upperCase(first) + lowerCase(rest.join(''));
}

/** A character's case mapping as `towupper` gives it: one character for one, or the character itself. */
function mapCase(c: string, mapped: string): string {
  return charactersOf(mapped).length === 1 ? mapped : c;
}
