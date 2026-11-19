import { ExecutionBudget } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { type TurtleState, TurtleWorld } from '../interpreter/turtleWorld';

/** The name Bash reports the program by, in `$0` and in its error messages. */
export const SCRIPT_NAME = 'main.sh';

/** A frame of the trace: the program's top level, or a call of a function the program defines. */
export interface Frame extends TracedFrame {
  readonly isAtomic: boolean;
  /** The index of the frame's own scope among the shell's scopes, which the trace reads its variables from. */
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
  constructor(readonly status: number) {}
}

/**
 * Abandons the command Bash is running after an error in an expansion: Bash discards the rest of the line it read,
 * or the rest of a command substitution, with status 1.
 */
export class DiscardSignal {
  constructor(readonly status = 1) {}
}

/** A turtle's handle, which a variable holds as a string, since every Bash value is one. */
const TURTLE_HANDLE_PREFIX = 'Turtle@';

/** What every part of the interpreter shares while a program runs: the board, the trace, and the limits. */
export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly frames: Frame[] = [];
  private readonly turtles = new Map<string, TurtleState>();
  private nextTurtle = 1;
  /** Gives the strings that the program can still reach, for the turtles' garbage collection. */
  reachableStrings: () => Iterable<string> = () => [];

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
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

  /** Removes the turtles whose handles no variable holds any longer. */
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const reached = new Set<TurtleState>();
    for (const text of this.reachableStrings()) {
      const turtle = this.turtles.get(text);
      if (turtle) reached.add(turtle);
    }
    this.world.retain((turtle) => reached.has(turtle));
    for (const [handle, turtle] of this.turtles) if (!turtle.isAlive) this.turtles.delete(handle);
  }
}
