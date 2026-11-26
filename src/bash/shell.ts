// code-gauge-allow-file fileNcss -- Coordinates statement execution, isolated child substitution contexts, and arithmetic host wiring.
import {
  ArithmeticError,
  type ArithmeticHost,
  ArithmeticStoreError,
  type ArithmeticTarget,
  evaluateArithmetic,
  splitSubscriptText,
} from './arithmetic';
import type { ArithmeticSource, Assignment, Program, Redirect, Statement, Word } from './ast';
import { createCaptureBuffer } from './budget';
import { REGULAR_BUILTINS } from './builtins';
import {
  classifyCommandName,
  rejectUnsupportedDeclarationPrefix,
  rejectUnsupportedDynamicDeclaration,
  rejectUnsupportedFeature,
  rejectUnsupportedNamerefMutation,
  rejectUnsupportedPrefixAssignment,
} from './capabilities';
import { legalNumber } from './characters';
import { conditionalStatus } from './conditional';
import { executeCompoundAssignment, executeDeclarationCommand } from './declare';
import { BadDescriptorError, type DescriptorTable, nullFile, type OpenFile, type OutputTarget } from './descriptors';
import { Expander } from './expansion';
import { FailurePolicy, type StoreOutcome } from './failurePolicy';
import { defaultOptions, type ShellOptionValues } from './options';
import { applyRedirects, initialDescriptors, RedirectionError } from './redirection';
import {
  BreakSignal,
  ContinueSignal,
  DiscardSignal,
  ExitSignal,
  type Frame,
  type FunctionDefinition,
  ReturnSignal,
  type Runtime,
} from './runtime';
import { formatSelectMenu } from './selectMenu';
import {
  readResolvedTarget,
  resolveScalarTarget,
  resolveSubscriptTarget,
  resolveTargetName,
  writeResolvedTarget,
} from './targets';
import type { Trap, TrapCondition } from './trapBuiltins';
import { TURTLE_PREDICATE_NAMES } from './turtle';
import { isIdentifier, isValidFunctionName, VariableStore } from './variables';
import { quoteTraceWord, traceAssignment, traceLine, traceWords } from './xtrace';

export { BASH_VERSION, type FunctionDefinition } from './runtime';
export type { CompoundElement } from './variables';

type StepMode = 'statement' | 'binding' | 'skip';

/**
 * The builtins whose step a condition skips, as Java's conditions take none: tests, and the readers that decide a
 * loop such as `while read -r line`, whose variables the next step shows.
 */
const CONDITION_BUILTINS = new Set<string>([
  'test',
  '[',
  'true',
  'false',
  'read',
  'getopts',
  ...TURTLE_PREDICATE_NAMES,
]);

/** The descriptor of the first process substitution, below which Bash numbers the next ones. */
const PROCESS_SUBSTITUTION_FIRST_FD = 63;

/** What a writer to a closed descriptor gets, which fails the write as Bash's `write` does. */
const CLOSED_OUTPUT: OutputTarget = {
  write: () => {
    throw new BadDescriptorError();
  },
};

/** Where error messages go when standard error is closed: nowhere, as Bash's writes to it then fail silently. */
const DISCARDED_OUTPUT: OutputTarget = { write: () => {} };

interface ShellContextOptions {
  readonly store?: VariableStore;
  readonly fds?: DescriptorTable;
  readonly options?: ShellOptionValues;
  readonly ignoresErrexit?: boolean;
  readonly traps?: Map<TrapCondition, Trap>;
  readonly traceLevel?: number;
  readonly lineShift?: number;
  readonly readShift?: number;
  readonly loopDepth?: number;
}

/**
 * One Bash execution context (top-level script or isolated child command substitution), owning its `VariableStore`,
 * `Expander`, `FailurePolicy`, file descriptors, and control-flow counters.
 */
export class Shell implements ArithmeticHost {
  readonly store: VariableStore;
  readonly failures: FailurePolicy;
  readonly expander: Expander;
  readonly fds: DescriptorTable;
  readonly options: ShellOptionValues;
  currentRow = 0;
  /**
   * How many enclosing contexts ignore a failure for `set -e`: a condition, a command before `&&` or `||`, or one
   * after `!`, whose functions and subshells ignore it as well.
   */
  private errexitIgnored: number;
  /** How many times `set -x` repeats the first character of `PS4`: once, and once more in each command substitution. */
  readonly traceLevel: number;
  /** The commands `trap` set for the shell's exit and for failed commands. */
  readonly traps: Map<TrapCondition, Trap>;
  private runningTrap = false;
  /** The descriptors of process substitutions that the commands running now use, with what each runs when done. */
  private readonly processSubstitutions: { fd: number; file: OpenFile; finish?: () => void }[] = [];
  /** The `>(...)` commands whose input another descriptor keeps open past their command, which run as the shell ends. */
  private readonly lingeringSubstitutions: (() => void)[] = [];
  private readShift: number;
  private lineShift: number;
  private loopDepth: number;

  constructor(
    readonly runtime: Runtime,
    options?: ShellContextOptions
  ) {
    this.fds = options?.fds ?? initialDescriptors({ runtime });
    this.options = options?.options ?? defaultOptions();
    this.errexitIgnored = options?.ignoresErrexit ? 1 : 0;
    this.traps = options?.traps ?? new Map();
    this.traceLevel = options?.traceLevel ?? 1;
    this.lineShift = options?.lineShift ?? 0;
    this.readShift = options?.readShift ?? 0;
    this.loopDepth = options?.loopDepth ?? 0;
    this.store = options?.store ?? new VariableStore(runtime, () => this.currentRow + 1);
    this.store.setLineReader(() => this.currentRow + 1);
    this.failures = new FailurePolicy(
      () => this.currentRow + 1,
      () => this.fd2
    );
    this.expander = new Expander(this);
  }

  /** Standard output, where a write fails when the descriptor is closed or open only for reading. */
  get fd1(): OutputTarget {
    return this.fds.get(1)?.output ?? CLOSED_OUTPUT;
  }

  /** Standard error, where error messages go, which are lost when the descriptor is closed. */
  get fd2(): OutputTarget {
    return this.fds.get(2)?.output ?? DISCARDED_OUTPUT;
  }

  // ---------------------------------------------------------------- running

  runProgram(program: Program): number {
    this.runtime.frames.push({ callRow: undefined, isAtomic: false, store: this.store, scopeIndex: 0 });
    const status = this.runExitTrap(this.runUnits(program));
    this.finishLingeringSubstitutions();
    this.finishCoprocesses();
    return status;
  }

  /** Runs the `>(...)` commands still reading, as their input reaches its end when the shell ends. */
  finishLingeringSubstitutions(): void {
    for (const finish of this.lingeringSubstitutions.splice(0)) finish();
  }

  /** Runs the `EXIT` trap as the shell ends with `status`, returning the status it ends with, which `exit` may set. */
  runExitTrap(status: number): number {
    try {
      this.runTrap('EXIT', status);
    } catch (error) {
      if (error instanceof ExitSignal) return error.status;
      throw error;
    }
    return status;
  }

  /**
   * Runs a trap's commands with `$?` holding the status that set it off, numbering their lines as that command's,
   * and restores `$?` afterwards. A trap does not set itself off while it runs.
   */
  private runTrap(condition: TrapCondition, status: number): void {
    const trap = this.traps.get(condition);
    if (!trap || trap.statements.length === 0 || this.runningTrap) return;
    const saved = { lineShift: this.lineShift, row: this.currentRow };
    this.runningTrap = true;
    this.store.lastStatus = status;
    this.lineShift = trap.row - this.currentRow;
    try {
      this.runStatements(trap.statements);
    } finally {
      this.runningTrap = false;
      this.lineShift = saved.lineShift;
      this.currentRow = saved.row;
      this.store.lastStatus = status;
    }
  }

  private runUnits(program: Program): number {
    try {
      for (const [index, unit] of program.units.entries()) {
        this.lineShift = this.readShift;
        try {
          this.runStatements(unit);
        } catch (error) {
          if (!(error instanceof DiscardSignal)) throw error;
          // Under `set -e`, Bash exits at an error that abandons a command, even where it ignores failed statuses.
          if (this.options.errexit) throw new ExitSignal(error.status);
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
    return this.ignoringErrexit(() => {
      let status = 0;
      for (const [index, statement] of statements.entries()) {
        status = this.execute(statement, index === statements.length - 1);
      }
      return status;
    });
  }

  private ignoringErrexit(run: () => number): number {
    this.errexitIgnored++;
    try {
      return run();
    } finally {
      this.errexitIgnored--;
    }
  }

  /**
   * Handles a failed command whose context does not ignore the failure: runs the `ERR` trap, which functions run
   * only under `set -E`, and exits when `set -e` is on.
   */
  private checkErrexit(status: number): void {
    if (status === 0 || this.errexitIgnored > 0) return;
    if (this.options.errtrace || !this.isInFunction) this.runTrap('ERR', status);
    if (this.options.errexit) throw new ExitSignal(status);
  }

  execute(statement: Statement, guarded = false): number {
    const mark = this.processSubstitutions.length;
    let completed = false;
    try {
      const status = this.executeStatement(statement, guarded);
      completed = true;
      return status;
    } finally {
      this.closeProcessSubstitutions(mark, completed);
    }
  }

  /**
   * Runs `<(...)` at once with its output kept for the path it expands to, or for `>(...)` keeps what is written to
   * the path for the commands, which run once the command using the path ends, or, when a descriptor such as one
   * `exec` opened still writes to it, once the shell ends. Bash runs them alongside the shell, so these orders are
   * ones it could take.
   */
  openProcessSubstitution(direction: '<' | '>', body: Statement[]): string {
    const fd = this.highestFreeDescriptor(PROCESS_SUBSTITUTION_FIRST_FD);
    const capture = createCaptureBuffer((cost) => this.runtime.spend(cost));
    if (direction === '<') {
      this.runSubshell(body, this.descriptorsWith(1, { output: capture.target }));
      const file = { input: this.runtime.io.textReader(capture.read()) };
      this.fds.set(fd, file);
      this.processSubstitutions.push({ fd, file });
    } else {
      // The commands copy the shell's state now, as Bash forks them here, though they run later.
      const child = this.forkSubshell(this.fds.clone());
      const file = { output: capture.target };
      this.fds.set(fd, file);
      this.processSubstitutions.push({
        fd,
        file,
        finish: () => {
          child.fds.set(0, { input: this.runtime.io.textReader(capture.read()) });
          child.run(body);
        },
      });
    }
    return `/dev/fd/${fd}`;
  }

  private closeProcessSubstitutions(mark: number, completed: boolean): void {
    for (const { fd, file, finish } of this.processSubstitutions.splice(mark)) {
      this.fds.close(fd);
      if (!completed || !finish) continue;
      if (this.fds.refersTo(file)) this.lingeringSubstitutions.push(finish);
      else finish();
    }
  }

  // code-gauge-allow functionNcss -- One case per statement kind, delegating each construct to its runner.
  private executeStatement(statement: Statement, guarded: boolean): number {
    this.runtime.spend();
    this.currentRow = statement.lineRow - this.lineShift;
    let status: number;
    switch (statement.kind) {
      case 'command':
      case 'declaration':
      case 'arithmetic':
      case 'test': {
        status = this.executeSimple(statement, guarded);
        this.store.pipeStatus = [status];
        this.checkErrexit(status);
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
        status = this.defineFunction(statement);
        break;
      }
      case 'list': {
        const left = this.ignoringErrexit(() => this.execute(statement.left, true));
        const runsRight = statement.operator === '&&' ? left === 0 : left !== 0;
        status = runsRight ? this.execute(statement.right, guarded) : left;
        break;
      }
      case 'not': {
        status = this.ignoringErrexit(() => this.execute(statement.body, guarded)) === 0 ? 1 : 0;
        break;
      }
      case 'redirected': {
        let redirected = false;
        status = this.withRedirects(statement.redirects, () => {
          redirected = true;
          return this.execute(statement.body, guarded);
        });
        // A failed redirection fails the compound command itself, while its body applies the rules on its own.
        if (!redirected) this.checkErrexit(status);
        break;
      }
      case 'subshell':
      case 'pipeline':
      case 'background':
      case 'coproc': {
        status = this.executeProcessStatement(statement);
        break;
      }
    }
    this.store.lastStatus = status;
    return status;
  }

  private defineFunction(statement: Extract<Statement, { kind: 'function' }>): number {
    if (!isValidFunctionName(statement.name)) {
      this.reportError(`\`${statement.name}': not a valid identifier`);
      return 1;
    }
    this.store.setFunction({
      name: statement.name,
      body: statement.body,
      isAtomic: statement.isAtomic,
      redirects: statement.redirects,
      lineShift: this.lineShift,
    });
    return 0;
  }

  /** Runs a statement that Bash runs in other processes: a subshell, a pipeline, a background command, or a coprocess. */
  private executeProcessStatement(
    statement: Extract<Statement, { kind: 'subshell' | 'pipeline' | 'background' | 'coproc' }>
  ): number {
    switch (statement.kind) {
      case 'subshell': {
        const status = this.runSubshell(statement.body, this.fds.clone());
        this.store.pipeStatus = [status];
        this.checkErrexit(status);
        return status;
      }
      case 'pipeline': {
        const status = this.executePipeline(statement.commands);
        this.checkErrexit(status);
        return status;
      }
      case 'background': {
        return this.runInBackground(statement.body);
      }
      case 'coproc': {
        return this.startCoprocess(statement.name, statement.body);
      }
    }
  }

  private executeSimple(statement: Statement, guarded: boolean): number {
    const mark = this.runtime.steps.statementMark();
    let outcome: { status: number; stepMode: StepMode; ranFunction: boolean } = {
      status: 0,
      stepMode: 'statement',
      ranFunction: false,
    };
    const status = this.withStatus(() => {
      outcome = this.runSimpleBody(statement, guarded);
      return outcome.status;
    });
    if (outcome.stepMode === 'binding') this.runtime.steps.stepBinding(statement.row, false);
    else if (outcome.stepMode === 'statement') {
      this.runtime.steps.completeStatement(statement.row, outcome.ranFunction, mark);
    }
    return status;
  }

  private runSimpleBody(
    statement: Statement,
    guarded: boolean
  ): { status: number; stepMode: StepMode; ranFunction: boolean } {
    switch (statement.kind) {
      case 'command': {
        return this.executeCommand(statement, guarded);
      }
      case 'declaration': {
        return this.executeDeclarationStatement(statement);
      }
      case 'arithmetic': {
        return {
          status: this.arithmeticStatus(statement.expression, '(('),
          stepMode: guarded ? 'skip' : 'statement',
          ranFunction: false,
        };
      }
      case 'test': {
        return {
          status: conditionalStatus(this, statement.expression),
          stepMode: guarded ? 'skip' : 'statement',
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

  /**
   * Runs a pipeline's commands one after another, each in a subshell that reads what the one before it wrote, since
   * builtins and functions run in one process here; with `lastpipe`, the last runs in this shell.
   */
  private executePipeline(commands: readonly Statement[]): number {
    const statuses: number[] = [];
    let input: OpenFile | undefined;
    for (const [index, command] of commands.entries()) {
      const isLast = index === commands.length - 1;
      const capture = isLast ? undefined : createCaptureBuffer((cost) => this.runtime.spend(cost));
      const fds = this.fds.clone();
      if (input) fds.set(0, input);
      if (capture) fds.set(1, { output: capture.target });
      statuses.push(
        isLast && this.options.lastpipe && input
          ? this.runWithStandardInput(input, command)
          : this.runSubshell([command], fds)
      );
      if (capture) input = { input: this.runtime.io.textReader(capture.read()) };
    }
    this.store.pipeStatus = statuses;
    const last = statuses.at(-1) as number;
    if (!this.options.pipefail) return last;
    return statuses.findLast((status) => status !== 0) ?? 0;
  }

  /**
   * Runs a command started with `&` at once and to its end, before the commands after it, as if each background
   * command ran until it finished before the shell went on. Its standard input is `/dev/null`, as Bash's is without
   * job control, so it never waits for input.
   */
  private runInBackground(command: Statement): number {
    const fds = this.descriptorsWith(0, nullFile(this.runtime.io.textReader('')));
    const status = this.runSubshell([command], fds);
    const pid = this.runtime.allocateProcessId();
    this.store.jobs.set(pid, { status, reported: false });
    this.store.lastBackgroundPid = pid;
    return 0;
  }

  /**
   * Starts a coprocess, which runs once the shell first reads its output or waits for it, or when the script ends,
   * reading what the shell wrote to it until then. A coprocess that answers each line as it comes would need to run
   * alongside the shell, so writing to it after it has run is rejected.
   */
  // code-gauge-allow functionNcss -- Wires a coprocess's lazy start, its two descriptors, its job, and its variables together.
  private startCoprocess(name: string, body: Statement): number {
    const pid = this.runtime.allocateProcessId();
    const input = createCaptureBuffer((cost) => this.runtime.spend(cost));
    let output: string | undefined;
    const job: { status: number; reported: boolean; finish?: () => void } = { status: 0, reported: false };
    // The coprocess copies the shell's state when it starts, though it runs later.
    const child = this.forkSubshell(this.fds.clone());
    const run = (): void => {
      job.finish = undefined;
      const capture = createCaptureBuffer((cost) => this.runtime.spend(cost));
      child.fds.set(0, { input: this.runtime.io.textReader(input.read()) });
      child.fds.set(1, { output: capture.target });
      job.status = child.run([body]);
      output = capture.read();
    };
    job.finish = run;
    // Bash moves both ends of both pipes to high descriptors and keeps the first and the last of the four.
    const pipeEnds: number[] = [];
    for (let fd = PROCESS_SUBSTITUTION_FIRST_FD; pipeEnds.length < 4; fd--) {
      if (!this.fds.get(fd)) pipeEnds.push(fd);
    }
    const readFd = pipeEnds[0];
    const writeFd = pipeEnds[3];
    this.fds.set(readFd, {
      input: this.runtime.io.partReader(
        () => output ?? '',
        () => {
          if (output !== undefined) {
            this.store.unsetNamed(name, false);
            this.store.unsetNamed(`${name}_PID`, false);
            return false;
          }
          run();
          return output !== '';
        }
      ),
    });
    this.fds.set(writeFd, {
      output: {
        write: (text) => {
          if (output !== undefined) rejectUnsupportedFeature(`動き終わった coproc（${name}）への書き込み`);
          input.target.write(text);
        },
      },
    });
    this.store.jobs.set(pid, job);
    this.assignIndexedArray(name, [String(readFd), String(writeFd)], 'coproc');
    this.assignVariable(`${name}_PID`, String(pid));
    return 0;
  }

  private highestFreeDescriptor(limit: number): number {
    let fd = limit;
    while (this.fds.get(fd)) fd--;
    return fd;
  }

  /** Runs the coprocesses nothing has read from, as they run to their end when the script ends. */
  finishCoprocesses(): void {
    for (const job of this.store.jobs.values()) job.finish?.();
  }

  private runWithStandardInput(input: OpenFile, command: Statement): number {
    const saved = this.fds.clone();
    this.fds.set(0, input);
    try {
      return this.execute(command);
    } finally {
      this.restoreDescriptors(saved, [0]);
    }
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
    return this.loop((last) => {
      const values = statement.values
        ? this.leavingLine(() => this.expander.expandWords(statement.values as Word[]))
        : [...this.store.positionalArgs()];
      const bindsObjects = values.some((value) => this.runtime.isTurtleHandle(value) || this.namesStructure(value));
      this.restoringLine(() => {
        if (statement.select) this.runSelectIterations(statement, values, last);
        else this.runForIterations(statement, values, bindsObjects, last);
      });
    });
  }

  /**
   * Runs `select`: shows the numbered words and `PS3` on standard error, reads a line into `REPLY`, and runs the body
   * with the variable set to the chosen word, or empty for a number out of range, until `break` or the end of input.
   * An empty line shows the menu again.
   */
  // code-gauge-allow functionCognitiveComplexity -- Shows the menu, reads a reply, and binds the choice in the order of Bash's `select` loop.
  private runSelectIterations(
    statement: Extract<Statement, { kind: 'for' }>,
    values: readonly string[],
    last: { status: number }
  ): void {
    if (values.length === 0) return;
    for (let showsMenu = true; ;) {
      this.runtime.spend();
      this.currentRow = statement.row - this.lineShift;
      if (this.options.xtrace) {
        traceLine(this, `select ${statement.variable} in ${values.map(quoteTraceWord).join(' ')}`);
      }
      if (showsMenu) this.fd2.write(formatSelectMenu(values));
      this.fd2.write(this.store.readScalar('PS3') ?? '#? ');
      if (this.runBuiltin('read', []) !== 0) {
        this.fds.get(1)?.output?.write('\n');
        last.status = 1;
        return;
      }
      const reply = this.store.readScalar('REPLY') ?? '';
      showsMenu = reply === '';
      if (showsMenu) continue;
      const choice = legalNumber(reply);
      const value =
        choice !== undefined && choice >= 1n && choice <= BigInt(values.length) ? values[Number(choice) - 1] : '';
      if (!this.bindLoopVariable(statement.variable, value, false)) {
        last.status = 1;
        return;
      }
      this.runtime.steps.stepBinding(statement.row, true);
      if (this.iterate(statement.body, last) === 'stop') return;
    }
  }

  private runForIterations(
    statement: Extract<Statement, { kind: 'for' }>,
    values: readonly string[],
    bindsObjects: boolean,
    last: { status: number }
  ): void {
    for (const value of values) {
      this.runtime.spend();
      this.currentRow = statement.row - this.lineShift;
      if (this.options.xtrace) traceLine(this, `for ${statement.variable} in ${values.map(quoteTraceWord).join(' ')}`);
      if (!this.bindLoopVariable(statement.variable, value, bindsObjects)) {
        last.status = 1;
        return;
      }
      this.runtime.steps.stepBinding(statement.row, !bindsObjects);
      if (this.iterate(statement.body, last) === 'stop') return;
    }
  }

  private bindLoopVariable(name: string, value: string, bindsObjects: boolean): boolean {
    if (this.store.ownView(name)?.attributes.has('n')) {
      rejectUnsupportedNamerefMutation('for', name);
    }
    const target = resolveScalarTarget(this, name, true);
    const outcome = writeResolvedTarget(this, target, value, false);
    if (!outcome.ok) return this.failures.handleStoreFailure('forHeader', outcome);
    if (target.kind === 'scalar') {
      this.store.setNullReferenceNamed(target.name, bindsObjects && value === '');
    }
    return true;
  }

  // code-gauge-allow functionCognitiveComplexity -- Runs C-style for init, condition, body, and update while keeping arithmetic errors local.
  private executeArithmeticFor(statement: Extract<Statement, { kind: 'arithmeticFor' }>): number {
    const evaluateHeader = (source: ArithmeticSource, stepAfter: boolean): bigint | undefined => {
      this.currentRow = statement.row - this.lineShift;
      const expanded = this.expander.arithmeticText(source);
      if (this.options.xtrace) traceLine(this, `(( ${expanded.trim()} ))`);
      const value = this.tryEvaluate(expanded, '((', true);
      if (value !== undefined && stepAfter) this.runtime.steps.step(statement.row);
      return value;
    };
    return this.loop((last) => {
      if (statement.init && evaluateHeader(statement.init, true) === undefined) {
        last.status = 1;
        return;
      }
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
    if (this.options.xtrace) traceLine(this, `case ${statement.value.text} in`);
    const value = this.leavingLine(() => this.expander.expandString(statement.value));
    let status = 0;
    let falling = false;
    for (const item of statement.items) {
      const matches =
        falling ||
        item.patterns.some((pattern) =>
          this.expander.matches(value, this.expander.expandPattern(pattern, true), {
            extmatch: this.options.extglob,
            fold: this.options.nocasematch,
          })
        );
      if (!matches) continue;
      status = this.runStatements(item.body);
      if (item.terminator === ';;') return status;
      falling = item.terminator === ';&';
    }
    return status;
  }

  /** Runs a command with its redirections applied, or skips it with status 1 when one fails, as Bash does. */
  withRedirects(redirects: readonly Redirect[], run: () => number): number {
    if (redirects.length === 0) return run();
    const saved = this.fds.clone();
    const changed: number[] = [];
    try {
      try {
        applyRedirects(this, redirects, changed);
      } catch (error) {
        if (!(error instanceof RedirectionError)) throw error;
        this.reportError(error.message);
        return 1;
      }
      return run();
    } finally {
      this.restoreDescriptors(saved, changed);
    }
  }

  /**
   * Applies a command's redirections once for every part of it that runs with them, as a declaration builtin runs
   * its operands one at a time, throwing a `RedirectionError` when one fails.
   */
  redirectionSession(redirects: readonly Redirect[]): { run: <T>(body: () => T) => T } {
    let applied: DescriptorTable | undefined;
    const changed: number[] = [];
    return {
      run: <T>(body: () => T): T => {
        if (redirects.length === 0) return body();
        const saved = this.fds.clone();
        try {
          if (applied) for (const fd of changed) this.copyDescriptor(applied, fd);
          else {
            applyRedirects(this, redirects, changed);
            applied = this.fds.clone();
          }
          return body();
        } finally {
          this.restoreDescriptors(saved, changed);
        }
      },
    };
  }

  /** Applies redirections to the shell itself, as `exec` without a command does. */
  applyPermanentRedirects(redirects: readonly Redirect[]): number {
    try {
      applyRedirects(this, redirects);
      return 0;
    } catch (error) {
      if (!(error instanceof RedirectionError)) throw error;
      this.reportError(error.message);
      return 1;
    }
  }

  /**
   * Puts back the descriptors a command's redirections changed, as Bash undoes only those: descriptors that the
   * command opened otherwise, as `exec` and `{name}>file` do, stay open after it.
   */
  private restoreDescriptors(saved: DescriptorTable, changed: readonly number[]): void {
    for (const fd of changed) this.copyDescriptor(saved, fd);
  }

  /** Makes `fd` what it is in `table`, closing it when it is closed there. */
  private copyDescriptor(table: DescriptorTable, fd: number): void {
    const file = table.get(fd);
    if (file) this.fds.set(fd, file);
    else this.fds.close(fd);
  }

  /** Assigns a scalar variable as a builtin does, reporting a failure such as a readonly variable. */
  assignVariable(name: string, value: string, builtin?: string): boolean {
    const outcome = writeResolvedTarget(this, this.namedTarget(name, 'write'), value, false, builtin);
    return outcome.ok ? true : this.failures.handleStoreFailure('regularBuiltin', outcome, builtin);
  }

  /** The value of a variable or an array element named as `name` or `name[subscript]`, as a builtin reads one. */
  readNamed(name: string): string | undefined {
    return readResolvedTarget(this, this.namedTarget(name, 'read'));
  }

  private namedTarget(name: string, operation: 'read' | 'write'): ArithmeticTarget {
    const split = this.splitSubscript(name);
    if (!split) return resolveScalarTarget(this, name, operation === 'write');
    return resolveSubscriptTarget(this, {
      name: split.name,
      subscript: { kind: 'text', text: split.subscript },
      operation,
    });
  }

  /**
   * Replaces an indexed array's elements, or with `keep` sets elements from `origin` on, as `read -a` and `mapfile`
   * do, reporting a failure such as a readonly array.
   */
  assignIndexedArray(name: string, values: readonly string[], builtin: string, origin = 0, keep = false): boolean {
    const resolvedName = resolveTargetName(this, name);
    const elements =
      keep || origin > 0
        ? values.map((value, index) => ({ key: String(origin + index), value, append: false }))
        : [...values];
    if (!keep && origin > 0) this.store.unsetNamed(resolvedName, false);
    const { outcome } = this.store.writeCompoundNamed({
      resolvedName,
      intent: 'visible',
      isAssoc: false,
      preAttrs: new Set(),
      postReadonly: false,
      elements,
      hooks: {
        append: keep,
        reportedName: name,
        evalIndex: (resolved, rawKey) => this.evaluateCompoundIndex(resolved, rawKey),
        evalInt: (expr) => this.evaluateFatalReadonly(expr, false),
        onItemError: (message) => this.reportError(message),
      },
    });
    return outcome.ok ? true : this.failures.handleStoreFailure('regularBuiltin', outcome, builtin);
  }

  /** Stores the lines `mapfile` has read so far. */
  flushArray(name: string, origin: number, lines: readonly string[], keep: boolean): boolean {
    return this.assignIndexedArray(name, lines, 'mapfile', origin, keep);
  }

  isAssociativeArray(name: string): boolean {
    return this.store.isAssociativeName(resolveTargetName(this, name));
  }

  /** Runs a function or a builtin by name with arguments that need no expansion, as a builtin's callback does. */
  invokeCommand(name: string, args: string[], { skipFunctions = false } = {}): number {
    const hasFunction = !skipFunctions && this.store.hasFunction(name);
    const classified = classifyCommandName(name, hasFunction, this.isRegularBuiltin(name));
    switch (classified.kind) {
      case 'function': {
        return this.callFunction(this.store.getFunction(name) as FunctionDefinition, args, this.currentRow);
      }
      case 'builtin': {
        return this.runBuiltin(name, args);
      }
      case 'notFound': {
        this.reportError(`${name}: command not found`);
        return 127;
      }
      case 'declarationBuiltin':
      case 'exec': {
        return rejectUnsupportedDynamicDeclaration(name);
      }
      default: {
        return rejectUnsupportedFeature(classified.feature);
      }
    }
  }

  isRegularBuiltin(name: string): boolean {
    return Object.hasOwn(REGULAR_BUILTINS, name);
  }

  /** The path a file operation uses for `path`, which starts from the working directory when it is relative. */
  absolutePath(path: string): string {
    const { workingDirectory } = this.store;
    if (path.startsWith('/') || workingDirectory === '/') return path;
    return `${workingDirectory}/${path}`;
  }

  // ---------------------------------------------------------------- simple commands & declarations

  private executeCommand(
    statement: Extract<Statement, { kind: 'command' }>,
    guarded: boolean
  ): {
    status: number;
    stepMode: StepMode;
    ranFunction: boolean;
  } {
    this.expander.lastSubstitutionStatus = 0;
    const argv = this.expander.expandWords(statement.words);
    if (argv.length === 0) {
      return { status: this.executeAssignmentOnlyCommand(statement), stepMode: 'statement', ranFunction: false };
    }
    const [name, ...args] = argv;
    const lastArg = argv.at(-1) as string;
    const classified = classifyCommandName(name, this.store.hasFunction(name), Object.hasOwn(REGULAR_BUILTINS, name));
    if (classified.kind === 'declarationBuiltin') {
      rejectUnsupportedDynamicDeclaration(classified.name);
    }
    if (classified.kind === 'unsupportedBuiltin' || classified.kind === 'external') {
      rejectUnsupportedFeature(classified.feature);
    }
    if (classified.kind === 'exec') {
      return { status: this.executeExec(statement, args, lastArg), stepMode: 'statement', ranFunction: false };
    }
    const isConditionBuiltin =
      guarded && classified.kind === 'builtin' && statement.assignments.length === 0 && CONDITION_BUILTINS.has(name);
    const status = this.invokeOrdinaryCommand(statement, name, args, lastArg, classified.kind);
    return {
      status,
      stepMode: isConditionBuiltin ? 'skip' : 'statement',
      ranFunction: classified.kind === 'function',
    };
  }

  private invokeOrdinaryCommand(
    statement: Extract<Statement, { kind: 'command' }>,
    name: string,
    args: string[],
    lastArg: string,
    kind: 'function' | 'builtin' | 'notFound'
  ): number {
    return this.withTemporaryScope(statement.assignments, () =>
      this.withRedirects(statement.redirects, () => {
        if (this.options.xtrace) traceWords(this, [name, ...args]);
        let code = 127;
        if (kind === 'function') {
          code = this.callFunction(this.store.getFunction(name) as FunctionDefinition, args, statement.row);
        } else if (kind === 'builtin') {
          code = this.runBuiltin(name, args);
        } else {
          this.reportError(`${name}: command not found`);
        }
        this.store.lastArgument = lastArg;
        return code;
      })
    );
  }

  /**
   * Runs `exec`, which without a command applies its redirections to the shell itself. A command would replace the
   * shell with a program found on `PATH`, which this environment cannot run.
   */
  private executeExec(statement: Extract<Statement, { kind: 'command' }>, args: string[], lastArg: string): number {
    const [command] = operandsOf(args);
    if (command !== undefined) rejectUnsupportedFeature(`外部コマンド（exec ${command}）`);
    const status = this.withTemporaryScope(statement.assignments, () =>
      this.applyPermanentRedirects(statement.redirects)
    );
    this.store.lastArgument = lastArg;
    return status;
  }

  /**
   * Calls a function named like a declaration builtin, which receives the operands as words, where Bash keeps one
   * that looks like an assignment whole as it would for the builtin.
   */
  private callShadowingFunction(statement: Extract<Statement, { kind: 'declaration' }>): number {
    const args: string[] = [];
    for (const word of statement.words) {
      if (!('append' in word)) {
        args.push(...this.expander.expandWords([word]));
        continue;
      }
      if (word.array) rejectUnsupportedFeature(`宣言ビルトインと同名の関数への複合代入（${word.text}）`);
      const subscript = word.subscript ? `[${this.expander.expandAssignmentSubscript(word.subscript)}]` : '';
      const value = word.value ? this.expander.expandAssignmentValue(word.value) : '';
      args.push(`${word.name}${subscript}${word.append ? '+=' : '='}${value}`);
    }
    const fn = this.store.getFunction(statement.name) as FunctionDefinition;
    const status = this.withTemporaryScope(statement.assignments, () =>
      this.withRedirects(statement.redirects, () => this.callFunction(fn, args, statement.row))
    );
    this.store.lastArgument = args.at(-1) ?? statement.name;
    return status;
  }

  /** Runs a builtin, which fails with status 1 when it writes to a closed descriptor, as Bash's builtins report. */
  runBuiltin(name: string, args: string[]): number {
    try {
      return REGULAR_BUILTINS[name](this, args, name);
    } catch (error) {
      if (!(error instanceof BadDescriptorError)) throw error;
      this.reportError(`${name}: write error: ${error.message}`);
      return 1;
    }
  }

  private executeDeclarationStatement(statement: Extract<Statement, { kind: 'declaration' }>): {
    status: number;
    stepMode: StepMode;
    ranFunction: boolean;
  } {
    this.expander.lastSubstitutionStatus = 0;
    if (this.store.hasFunction(statement.name)) {
      return { status: this.callShadowingFunction(statement), stepMode: 'statement', ranFunction: true };
    }
    if (statement.assignments.length > 0) rejectUnsupportedDeclarationPrefix(statement.name);
    const session = this.redirectionSession(statement.redirects);
    try {
      const optionWords = statement.words
        .slice(0, statement.words.length - statement.args.length)
        .map((word) => ('append' in word ? word.text : word.text));
      const { status, assignsAnswer } = executeDeclarationCommand(
        this,
        statement.name,
        statement.staticOptions,
        statement.args,
        session.run,
        optionWords
      );
      return { status, stepMode: assignsAnswer ? 'statement' : 'binding', ranFunction: false };
    } catch (error) {
      if (error instanceof RedirectionError) {
        this.reportError(error.message);
        return { status: 1, stepMode: 'statement', ranFunction: false };
      }
      if (!(error instanceof BadDescriptorError)) throw error;
      this.reportError(`${statement.name}: write error: ${error.message}`);
      return { status: 1, stepMode: 'statement', ranFunction: false };
    }
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
    if (this.options.xtrace) traceAssignment(this, assignment.name, assignment.append ? '+=' : '=', value);
    const failure = this.store.bindTemporaryScalar(scopeIndex, assignment.name, value, assignment.append);
    if (failure) this.failures.handleStoreFailure('commandPrefix', failure);
  }

  // ---------------------------------------------------------------- functions & child command substitutions

  callFunction(fn: FunctionDefinition, args: string[], callRow: number): number {
    this.runtime.checkCallDepth();
    const reportedRow = this.currentRow;
    const scopeIndex = this.store.pushFunctionScope(fn.name, reportedRow + 1, args);
    const frame: Frame = { callRow, isAtomic: fn.isAtomic, store: this.store, scopeIndex };
    this.runtime.frames.push(frame);
    const saved = {
      loop: this.loopDepth,
      shift: this.lineShift,
    };
    this.loopDepth = 0;
    this.lineShift = fn.lineShift;
    try {
      return this.restoringLine(() => this.withRedirects(fn.redirects, () => this.execute(fn.body)));
    } catch (error) {
      if (error instanceof ReturnSignal) return error.status;
      throw error;
    } finally {
      this.loopDepth = saved.loop;
      this.lineShift = saved.shift;
      this.runtime.frames.pop();
      this.store.popFunctionScope(scopeIndex);
      if (fn.isAtomic) this.runtime.steps.completeAtomicCall();
      this.currentRow = reportedRow;
    }
  }

  namesStructure(word: string): boolean {
    if (!isIdentifier(word)) return false;
    const resolved = resolveTargetName(this, word);
    return this.store.ownView(resolved)?.kind === 'associative';
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

  /** Runs `$(...)` or `` `...` `` in a fresh child `Shell` context over an eager metered `VariableStore` copy. */
  captureSubshell(body: Statement[], startRow?: number): { output: string; status: number } {
    const capture = createCaptureBuffer((cost) => this.runtime.spend(cost));
    const firstRow = body[0]?.row ?? startRow;
    const status = this.runSubshell(body, this.descriptorsWith(1, { output: capture.target }), {
      lineShift: firstRow !== undefined ? firstRow - this.currentRow : this.lineShift,
      // A command substitution does not keep `set -e` unless `inherit_errexit` is on.
      options: { ...this.options, errexit: this.options.errexit && this.options.inherit_errexit },
      traceLevel: this.traceLevel + 1,
      readsFile: isFileReadSubstitution(body),
    });
    return { output: capture.read(), status };
  }

  /**
   * Runs `${ ...; }` in this shell with its output captured, or `${| ...; }` with a local `REPLY` whose value it
   * expands to. `return` ends only the substitution, while `break`, `continue`, and `exit` act on the shell.
   */
  captureCurrentShell(body: Statement[], mode: 'current' | 'reply'): { output: string; status: number } {
    const capture = createCaptureBuffer((cost) => this.runtime.spend(cost));
    const savedReply = mode === 'reply' ? this.store.readScalar('REPLY') : undefined;
    if (mode === 'reply') this.store.unsetNamed('REPLY', true);
    const saved = this.fds.clone();
    const changed = mode === 'current' ? [1] : [];
    if (mode === 'current') this.fds.set(1, { output: capture.target });
    let status: number;
    try {
      status = this.runStatements(body);
    } catch (error) {
      if (!(error instanceof ReturnSignal)) throw error;
      status = error.status;
    } finally {
      this.restoreDescriptors(saved, changed);
    }
    if (mode === 'current') return { output: capture.read(), status };
    const reply = this.store.readScalar('REPLY') ?? '';
    if (savedReply === undefined) this.store.unsetNamed('REPLY', true);
    else this.assignVariable('REPLY', savedReply);
    return { output: reply, status };
  }

  /** Runs statements in a subshell: a child shell over an eager copy of this shell's variables. */
  runSubshell(body: Statement[], fds: DescriptorTable, overrides?: SubshellOverrides): number {
    return this.forkSubshell(fds, overrides).run(body);
  }

  /**
   * Copies this shell into a child shell now, as Bash forks, returning the child's descriptors and what runs
   * statements in it, which may happen later, as a coprocess does.
   */
  private forkSubshell(
    fds: DescriptorTable,
    overrides?: SubshellOverrides
  ): { fds: DescriptorTable; run: (body: Statement[]) => number } {
    this.runtime.checkCallDepth();
    const childStore = this.store.fork(() => this.currentRow + 1);
    const lineShift = overrides?.lineShift ?? this.lineShift;
    const childShell = new Shell(this.runtime, {
      store: childStore,
      ...this.childContext(),
      ...(overrides ? { options: overrides.options, traceLevel: overrides.traceLevel } : {}),
      fds,
      lineShift,
      readShift: lineShift,
      loopDepth: this.loopDepth,
    });
    const run = (body: Statement[]): number => {
      const subshellFrame: Frame = {
        callRow: undefined,
        isAtomic: false,
        store: childStore,
        scopeIndex: childStore.topScopeIndex,
      };
      this.runtime.frames.push(subshellFrame);
      try {
        const status = overrides?.readsFile
          ? childShell.readFileSubstitution(body[0] as Extract<Statement, { kind: 'command' }>)
          : runSubshellCommands(childShell, body);
        const exitStatus = childShell.runExitTrap(status);
        childShell.finishLingeringSubstitutions();
        return exitStatus;
      } finally {
        this.runtime.frames.pop();
      }
    };
    return { fds, run };
  }

  /** Runs `$(< file)`, which Bash replaces with the file's contents without running a command. */
  private readFileSubstitution(command: Extract<Statement, { kind: 'command' }>): number {
    this.currentRow = command.lineRow - this.lineShift;
    return this.withRedirects(command.redirects, () => {
      const input = this.fds.get(0)?.input;
      if (input) this.fd1.write(input.readRest());
      return 0;
    });
  }

  /** What a subshell copies from this shell besides its variables: descriptors and options. */
  childContext(): Pick<ShellContextOptions, 'fds' | 'options' | 'ignoresErrexit' | 'traps' | 'traceLevel'> {
    // A subshell keeps the conditions the shell ignores, and with `set -E` its `ERR` trap.
    const traps = [...this.traps].filter(
      ([condition, trap]) => trap.statements.length === 0 || (condition === 'ERR' && this.options.errtrace)
    );
    return {
      fds: this.fds.clone(),
      options: { ...this.options },
      ignoresErrexit: this.errexitIgnored > 0,
      traps: new Map(traps),
      traceLevel: this.traceLevel,
    };
  }

  /** A copy of this shell's descriptors where `fd` is `file`. */
  descriptorsWith(fd: number, file: OpenFile): DescriptorTable {
    const fds = this.fds.clone();
    fds.set(fd, file);
    return fds;
  }

  /** Rejects a device this environment does not have, such as a terminal, or Bash's network paths. */
  rejectDevice(path: string): never {
    const isNetwork = path.startsWith('/dev/tcp/') || path.startsWith('/dev/udp/');
    rejectUnsupportedFeature(`${isNetwork ? 'ネットワーク' : 'デバイス'}（${path}）`);
  }

  // ---------------------------------------------------------------- errors & arithmetic

  reportError(message: string): void {
    this.failures.report(message);
  }

  discard(message: string, status = 1): never {
    this.failures.discard(message, status);
  }

  evaluate(source: ArithmeticSource, commandName: string | undefined): bigint {
    return this.evaluateText(this.expander.arithmeticText(source), commandName, true);
  }

  evaluateText(text: string, commandName: string | undefined, preExpanded = false): bigint {
    try {
      return evaluateArithmetic(text, this, commandName, this.runtime.step, preExpanded);
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
      return evaluateArithmetic(text, this, commandName, this.runtime.step, preExpanded);
    } catch (error) {
      if (error instanceof ArithmeticError) this.discard(error.message);
      if (error instanceof ArithmeticStoreError) {
        this.failures.handleStoreFailure('fatalReadonlyArithmetic', error.failure);
      }
      throw error;
    }
  }

  arithmeticStatus(source: ArithmeticSource, commandName: string): number {
    const expanded = this.expander.arithmeticText(source);
    if (this.options.xtrace) traceLine(this, `(( ${expanded} ))`);
    const value = this.tryEvaluate(expanded, commandName, true);
    return value === undefined || value === 0n ? 1 : 0;
  }

  tryEvaluate(text: string, commandName: string | undefined, preExpanded = false): bigint | undefined {
    try {
      return evaluateArithmetic(text, this, commandName, this.runtime.step, preExpanded);
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
    expandSubscript = true
  ): ArithmeticTarget {
    if (rawSubscript === undefined) {
      return resolveScalarTarget(this, name, !willRead);
    }
    return resolveSubscriptTarget(this, {
      name,
      subscript: expandSubscript ? { kind: 'text', text: rawSubscript } : { kind: 'arithmetic', text: rawSubscript },
      operation: willRead ? 'arithmeticRead' : 'arithmeticWrite',
    });
  }

  readTarget(target: ArithmeticTarget): string | undefined {
    const value = readResolvedTarget(this, target);
    if (value === undefined && this.options.nounset && target.kind !== 'invalid' && target.kind !== 'randomSeed') {
      const shown =
        target.kind === 'indexedElement'
          ? `${target.reportedName}[${target.index}]`
          : target.kind === 'associativeElement'
            ? `${target.reportedName}[${target.key}]`
            : target.reportedName;
      this.expander.failParameter(shown, 'unbound variable');
    }
    return value;
  }

  writeTarget(target: ArithmeticTarget, value: string): StoreOutcome {
    return writeResolvedTarget(this, target, value, false);
  }

  evaluateCompoundIndex(resolvedName: string, rawKey: string): bigint | undefined {
    const idx = this.evaluateFatalReadonly(rawKey, true);
    return idx >= 0n ? idx : this.store.translateNegativeIndex(resolvedName, idx, true);
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
    if (assignment.array) {
      if (this.options.xtrace) traceLine(this, assignment.text);
      return executeCompoundAssignment(this, assignment, context);
    }
    const value = assignment.value ? this.expander.expandAssignmentValue(assignment.value) : '';
    if (this.options.xtrace) {
      const target = assignment.subscript ? `${assignment.name}[${assignment.subscript.text}]` : assignment.name;
      traceAssignment(this, target, assignment.append ? '+=' : '=', value);
    }
    const target = assignment.subscript
      ? resolveSubscriptTarget(this, {
          name: assignment.name,
          subscript: { kind: 'word', word: assignment.subscript },
          operation: 'write',
          append: assignment.append,
        })
      : resolveScalarTarget(this, assignment.name, true, { append: assignment.append });
    const outcome = writeResolvedTarget(this, target, value, assignment.append);
    return outcome.ok ? true : this.failures.handleStoreFailure(context, outcome);
  }

  unsetVariable(name: string, followReference = true): boolean {
    const failure = this.store.unsetNamed(name, followReference);
    return failure ? this.failures.handleStoreFailure('regularBuiltin', failure, 'unset') : true;
  }

  splitSubscript(text: string): { name: string; subscript: string } | undefined {
    return splitSubscriptText(text);
  }
}

/** What a command substitution changes in the subshell it runs in. */
interface SubshellOverrides {
  lineShift: number;
  options: ShellOptionValues;
  traceLevel: number;
  readsFile: boolean;
}

/** Skips a leading `--`, which Bash's builtins accept before their operands. */
function operandsOf(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

/** Whether a command substitution is `$(< file)`, which Bash replaces with the file's contents without a command. */
function isFileReadSubstitution(body: readonly Statement[]): boolean {
  const [only] = body;
  return (
    body.length === 1 &&
    only.kind === 'command' &&
    only.words.length === 0 &&
    only.assignments.length === 0 &&
    only.redirects.length === 1 &&
    only.redirects[0].kind === 'file' &&
    only.redirects[0].operator === '<'
  );
}

function runSubshellCommands(childShell: Shell, body: Statement[]): number {
  try {
    return childShell.runStatements(body);
  } catch (error) {
    if (
      error instanceof ExitSignal ||
      error instanceof DiscardSignal ||
      error instanceof ReturnSignal ||
      error instanceof BreakSignal
    ) {
      return error.status;
    }
    if (error instanceof ContinueSignal) return 0;
    throw error;
  }
}
