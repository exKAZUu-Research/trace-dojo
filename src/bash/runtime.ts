import { ExecutionBudget } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { type TurtleState, TurtleWorld } from '../interpreter/turtleWorld';
import type { Statement } from './ast';
import {
  type Attribute,
  type CallFrameEntry,
  createInitialGlobalScope,
  initialRandomSeed,
  type Scope,
} from './variables';

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
  /** How far the lines Bash numbered the function with are behind its rows (see `Shell.lineShift`). */
  lineShift: number;
}

export interface ShellState {
  scopes: Scope[];
  /** The scope index of each function call's own locals, the innermost last. */
  functionScopes: number[];
  functions: Map<string, FunctionDefinition>;
  /** The positional parameters of the script and of each function call, the innermost last. */
  positional: string[][];
  calls: CallFrameEntry[];
  funcname: Map<bigint, string>;
  lastStatus: number;
  pipeStatus: Map<bigint, string>;
  /** `$_`, which starts as the path of Bash itself, so `undefined` until a command sets it. */
  lastArgument: string | undefined;
  randomSeed: number;
  lastRandom: number;
  subshellDraws: number;
  /** The dynamic variables the program unset, which then lose their special meaning, as in Bash. */
  unsetDynamic: Set<string>;
  dynamicAttributes: Map<string, Set<Attribute>>;
  /** Host environment variable names explicitly cleared by `unset`, which then read as unset rather than unsupported. */
  unsetEnv: Set<string>;
  subshellLevel: number;
  fd1: OutputTarget;
  fd2: OutputTarget;
}

export function createInitialShellState(runtime: Runtime): ShellState {
  return {
    scopes: [createInitialGlobalScope(BASH_VERSION)],
    functionScopes: [],
    functions: new Map(),
    positional: [[]],
    calls: [],
    funcname: new Map([[0n, 'main']]),
    lastStatus: 0,
    pipeStatus: new Map(),
    lastArgument: undefined,
    randomSeed: initialRandomSeed(),
    lastRandom: 0,
    subshellDraws: 0,
    unsetDynamic: new Set(),
    dynamicAttributes: new Map(),
    unsetEnv: new Set(),
    subshellLevel: 0,
    fd1: runtime.io.stdout,
    fd2: runtime.io.stderr,
  };
}

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
  /**
   * The line Bash's line counter is left at, 0-based, when a `case` or the words of a `for` set it and no command
   * restored it, which makes Bash number the lines it reads next from there.
   */
  leftRow: number | undefined;

  constructor(readonly status = 1) {}
}

/** A turtle's handle, which a variable holds as a string, since every Bash value is one. */
const TURTLE_HANDLE_PREFIX = 'Turtle@';
const TURTLE_HANDLE_PATTERN = /Turtle@\d+/g;

/** Aborts a read-only trace observation before mutating external devices or writing output. */
export class ObservationAbortError extends Error {}

/** What every part of the interpreter shares while a program runs: the board, the trace, and the limits. */
export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly frames: Frame[] = [];
  observing = false;
  private observationOps = 0;
  private readonly turtles = new Map<string, TurtleState>();
  private nextTurtle = 1;
  /** Gives the strings that the program can still reach, for the turtles' garbage collection. */
  reachableStrings: () => Iterable<string> = () => [];

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
  }

  spend(cost = 1): void {
    if (this.observing) {
      this.observationOps += Math.max(cost, 0);
      if (this.observationOps > 4096) throw new ObservationAbortError();
      return;
    }
    this.budget.spend(cost);
  }

  beginObservation(): { savedObserving: boolean; savedOps: number } {
    const saved = { savedObserving: this.observing, savedOps: this.observationOps };
    this.observing = true;
    this.observationOps = 0;
    return saved;
  }

  endObservation(saved: { savedObserving: boolean; savedOps: number }): void {
    this.observing = saved.savedObserving;
    this.observationOps = saved.savedOps;
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
    if (this.observing || !this.world.hasTurtles) return;
    const reached = new Set<TurtleState>();
    for (const text of this.reachableStrings()) {
      for (const [handle] of text.matchAll(TURTLE_HANDLE_PATTERN)) {
        const turtle = this.turtles.get(handle);
        if (turtle) reached.add(turtle);
      }
    }
    this.world.retain((turtle) => reached.has(turtle));
    for (const [handle, turtle] of this.turtles) if (!turtle.isAlive) this.turtles.delete(handle);
  }
}
