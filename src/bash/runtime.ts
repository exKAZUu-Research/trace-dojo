import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { type TurtleState, TurtleWorld } from '../interpreter/turtleWorld';
import type { Redirect, Statement } from './ast';
import { chargeStoreSlots, type StepMeter } from './budget';
import type { VariableStore } from './variables';

/** The name Bash reports the program by, in `$0` and in its error messages. */
export const SCRIPT_NAME = 'main.sh';

export const BASH_VERSION = '5.3.0(1)-release';

export interface FunctionDefinition {
  name: string;
  body: Statement;
  isAtomic: boolean;
  redirects: Redirect[];
  /** How far the lines Bash numbered the function with are behind its rows. */
  lineShift: number;
  /** The line where the definition starts, 0-based, which errors of the function's own redirections name. */
  definitionRow: number;
}

/** A frame of the trace: the program's top level, a command substitution, or a call of a function the program defines. */
export interface Frame extends TracedFrame {
  readonly isAtomic: boolean;
  /** The store of the shell context executing this frame. */
  readonly store: VariableStore;
  /** The index of the frame's own scope among `store`'s scopes, which the trace reads its variables from. */
  readonly scopeIndex: number;
}

/** Leaves loops, as `break n` does. */
export class BreakSignal {
  /** @param status The loop's status: 1 when `break` or `continue` got a count below 1 and leaves every loop. */
  constructor(
    public count: number,
    readonly status = 0
  ) {}
}

/** Starts the next iteration of an enclosing loop, as `continue n` does. */
export class ContinueSignal {
  constructor(public count: number) {}
}

/** Returns from a function with a status. */
export class ReturnSignal {
  constructor(readonly status: number) {}
}

/** Exits the shell, or the subshell running a command substitution, with a status. */
export class ExitSignal {
  /**
   * `byExpansionError` marks an expansion error that ends a non-interactive shell, such as `${x?}` or an unset
   * variable under `set -u`, which keeps the status the shell was ending with when it happens in the `EXIT` trap.
   */
  constructor(
    readonly status: number,
    readonly byExpansionError = false
  ) {}
}

/**
 * Abandons the command Bash is running after an error in an expansion: Bash discards the rest of the line it read,
 * or the rest of a command substitution, with status 1.
 */
export class DiscardSignal {
  /**
   * The line Bash's line counter is left at, 0-based, when a `case` or the words of a `for` set it and no command
   * restored it, which makes Bash number the lines it reads next from there.
   */
  leftRow: number | undefined;

  constructor(readonly status = 1) {}
}

const TURTLE_HANDLE_PREFIX = 'Turtle@';

/**
 * The process number of the first background command. Bash shows the operating system's, which differ from run to
 * run, so any fixed numbering is one Bash could show.
 */
const FIRST_PROCESS_ID = 1000;

/** Shared per-run services: the turtle board, step tracker, execution budget, output streams, and trace frame stack. */
export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly frames: Frame[] = [];
  readonly step: StepMeter = () => {
    this.budget.spend(1);
  };
  private readonly turtles = new Map<string, TurtleState>();
  private nextTurtle = 1;
  private turtleRevision = 0;
  private slots = 0;
  private nextProcessId = FIRST_PROCESS_ID;

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  allocateSlots(count = 1): void {
    if (count <= 0) return;
    this.slots = chargeStoreSlots(this.slots, count);
  }

  checkCallDepth(): void {
    if (this.frames.length >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
  }

  /** A new process number for a background command or a coprocess. */
  allocateProcessId(): number {
    return this.nextProcessId++;
  }

  reserveTurtleHandle(): string {
    return `${TURTLE_HANDLE_PREFIX}${this.nextTurtle++}`;
  }

  commitTurtle(handle: string, turtle: TurtleState): void {
    this.turtles.set(handle, turtle);
    this.turtleRevision++;
  }

  get turtleEpoch(): number {
    return this.turtleRevision;
  }

  bumpTurtleEpoch(): void {
    this.turtleRevision++;
  }

  /** Whether `text` is a turtle handle created in this run, whether still alive or removed. */
  isTurtleHandle(text: string): boolean {
    return this.turtles.has(text);
  }

  /** The live turtle a string names, remaining alive until explicit removal or run end. */
  turtleOf(handle: string): TurtleState | undefined {
    const turtle = this.turtles.get(handle);
    return turtle?.isAlive ? turtle : undefined;
  }

  /** No-op for `TracedRuntime`: Bash string-handle turtles persist until explicit removal or run end. */
  collectGarbage(): void {}
}

/**
 * Stops a program at a wait that never ends, where Bash would wait forever: reading from a coprocess that waits for
 * input the shell can still write, or waiting for such a coprocess or `>(...)`.
 */
export class DeadlockError extends Error {
  constructor() {
    super(
      'デッドロックが起きました。シェルとコプロセスやプロセス置換が互いの入出力を待ったままで、どれも先に進めません。'
    );
    this.name = 'DeadlockError';
  }
}

/** Stops a coprocess that has read all the shell wrote to it while the shell can still write more, as Bash's waits. */
export class CoprocessWaitSignal {
  /** The `while read` loop whose condition waited, which ends with nothing more to run once the input ends. */
  waitingLoop: Statement | undefined;
}

/** Whether `error` is how the shell leaves commands as Bash does, rather than a stop of the whole program. */
export function isShellSignal(
  error: unknown
): error is ExitSignal | DiscardSignal | ReturnSignal | BreakSignal | ContinueSignal {
  return (
    error instanceof ExitSignal ||
    error instanceof DiscardSignal ||
    error instanceof ReturnSignal ||
    error instanceof BreakSignal ||
    error instanceof ContinueSignal
  );
}
