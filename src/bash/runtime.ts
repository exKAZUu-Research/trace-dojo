import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { type TurtleState, TurtleWorld } from '../interpreter/turtleWorld';
import type { Statement } from './ast';
import type { VariableStore } from './variables';

/** The name Bash reports the program by, in `$0` and in its error messages. */
export const SCRIPT_NAME = 'main.sh';

export const BASH_VERSION = '5.3.0(1)-release';

/** Where a file descriptor writes: the run's standard output or error, or the text a command substitution captures. */
export interface OutputTarget {
  write(text: string): void;
}

export interface FunctionDefinition {
  name: string;
  body: Statement;
  isAtomic: boolean;
  /** How far the lines Bash numbered the function with are behind its rows. */
  lineShift: number;
}

/** A frame of the trace: the program's top level, a command substitution, or a call of a function the program defines. */
export interface Frame extends TracedFrame {
  readonly isAtomic: boolean;
  /** The store of the shell context executing this frame. */
  readonly store: VariableStore;
  /** The index of the frame's own scope among `store`'s scopes, which the trace reads its variables from. */
  readonly scopeIndex: number;
}

/** An active execution context contributing live string roots for turtle garbage collection. */
export interface RootContext {
  reachableStrings(): Iterable<string>;
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
  constructor(readonly status: number) {}
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
const TURTLE_HANDLE_PATTERN = /Turtle@\d+/g;

/** Shared per-run services: the turtle board, step tracker, execution budget, output streams, and active root registry. */
export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly frames: Frame[] = [];
  private readonly turtles = new Map<string, TurtleState>();
  private readonly contexts = new Set<RootContext>();
  private nextTurtle = 1;
  private slots = 0;

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  allocateSlots(count = 1): void {
    this.slots += count;
    if (this.slots > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  }

  registerContext(context: RootContext): void {
    this.contexts.add(context);
  }

  unregisterContext(context: RootContext): void {
    this.contexts.delete(context);
  }

  addTurtle(turtle: TurtleState): string {
    const handle = `${TURTLE_HANDLE_PREFIX}${this.nextTurtle++}`;
    this.turtles.set(handle, turtle);
    return handle;
  }

  /** The live turtle a string names. */
  turtleOf(handle: string): TurtleState | undefined {
    const turtle = this.turtles.get(handle);
    return turtle?.isAlive ? turtle : undefined;
  }

  /** Removes the turtles whose handles no active execution context holds any longer. */
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const reached = new Set<TurtleState>();
    for (const context of this.contexts) {
      this.scanContextRoots(context, reached);
    }
    this.world.retain((turtle) => reached.has(turtle));
    for (const [handle, turtle] of this.turtles) if (!turtle.isAlive) this.turtles.delete(handle);
  }

  private scanContextRoots(context: RootContext, reached: Set<TurtleState>): void {
    for (const text of context.reachableStrings()) {
      this.spend(Math.ceil(text.length / 1024));
      for (const [handle] of text.matchAll(TURTLE_HANDLE_PATTERN)) {
        const turtle = this.turtles.get(handle);
        if (turtle) reached.add(turtle);
      }
    }
  }
}
