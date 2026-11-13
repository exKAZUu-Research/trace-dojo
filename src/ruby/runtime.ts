import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { BlockDef, MethodDef } from './ast';
import type { CoreClasses } from './bootstrap';
import { collectGarbage } from './garbageCollection';
import { NIL, type RClass, type RMethod, type RObject, type RProc, type Value, type Visibility } from './objects';

/** The local variables of a method, class body, program, or block; a block's scope reaches its parent's. */
export class Scope {
  readonly vars = new Map<string, Value>();

  constructor(readonly parent?: Scope) {}

  lookup(name: string, depth: number): Value {
    return (depth === 0 ? this : outerScope(this, depth)).vars.get(name) ?? NIL;
  }

  assign(name: string, depth: number, value: Value): void {
    (depth === 0 ? this : outerScope(this, depth)).vars.set(name, value);
  }
}

function outerScope(start: Scope, depth: number): Scope {
  let scope = start;
  for (let index = 0; index < depth; index++) scope = scope.parent as Scope;
  return scope;
}

export type FrameKind = 'main' | 'method' | 'block' | 'class';

/** One activation on the call stack: the program, a method, a class body, or a block. */
export class Frame implements TracedFrame {
  /** Values that only native code holds, which garbage collection must keep. */
  readonly temporaries: Value[] = [];
  /** The visibility that `def` gives in a class body after `private` or `public` without arguments. */
  defaultVisibility: Visibility = 'public';
  /** Whether `module_function` without arguments is in effect in a module body. */
  moduleFunction = false;
  /** The exception being handled by a `rescue` of this frame, which a bare `raise` re-raises. */
  handling: RObject[] = [];

  // code-gauge-allow functionParameterCount 8 -- Each language wires its own parser and runtime into the shared modules alike.
  constructor(
    readonly kind: FrameKind,
    readonly self: Value,
    readonly scope: Scope,
    /** The lexical nesting of modules, innermost first, where constants and class variables are found. */
    readonly cref: RClass[],
    public callRow: number | undefined,
    readonly isAtomic: boolean,
    /** Whether the caller uses the value of the body, which decides whether its last statement is a step. */
    readonly resultUsed: boolean,
    readonly extra: FrameExtra
  ) {}

  /** The method frame (or program frame) a block was written in. */
  get home(): Frame {
    return this.extra.home ?? this;
  }
}

export interface FrameExtra {
  /** The running method. */
  method?: RMethod;
  def?: MethodDef;
  /** The block the method received, which `yield` calls. */
  block?: RProc;
  /** The arguments the method received, which `super` without arguments passes on. */
  args?: Value[];
  keywords?: Value;
  /** For a block's frame: the frame it was written in. */
  home?: Frame;
  /** For a block's frame: the frame of the block that defines it, or of the method. */
  outer?: Frame;
  proc?: RProc;
  blockDef?: BlockDef;
  /** For a lambda's frame, where `return` returns from the lambda itself. */
  isLambda?: boolean;
  /** The MatchData of the last match a method this frame called made, which `$~` and `$1` read. */
  lastMatch?: Value;
  /** The module where `def` defines methods, for a block that `class_eval` or `instance_eval` runs. */
  definee?: RClass;
  /** Whether this frame's method has returned, after which a `return` in a block it made cannot reach it. */
  finished?: boolean;
}

/** A Ruby exception raised in the program, carrying the exception object. */
export class RubyError {
  constructor(readonly exception: RObject) {}
}

/** Leaves a loop (`inBlock` false) or the call that received a block (`tag` is the call's tag). */
export class BreakSignal {
  constructor(
    readonly value: Value,
    readonly tag: object | undefined
  ) {}
}

export class NextSignal {
  constructor(readonly value: Value) {}
}

export class ReturnSignal {
  constructor(
    readonly value: Value,
    readonly target: Frame
  ) {}
}

export class RetrySignal {}

export class RedoSignal {}

export class ThrowSignal {
  constructor(
    readonly tag: Value,
    readonly value: Value
  ) {}
}

/** Ends the program as `exit` does, which the trace and the grader do not count as a failure. */
export class ExitSignal {
  constructor(readonly status: number) {}
}

/** Stops a program at a feature this grader does not support, which no `rescue` clause may catch. */
export class UnsupportedFeatureError extends Error {
  constructor(feature: string) {
    super(`${feature}${/[!-~]$/.test(feature) ? ' ' : ''}は、この採点環境では使えません。`);
    this.name = 'UnsupportedFeatureError';
  }
}

export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly frames: Frame[] = [];
  readonly globals = new Map<string, Value>();
  /** Values native code holds while it calls back into the program, such as the array `each` iterates. */
  readonly held: Value[] = [];
  /** The tags of the `catch` blocks running now, innermost last, which `throw` must match. */
  readonly catchTags: Value[] = [];
  /** The blocks `at_exit` and `END` registered, which run when the program ends, the last first. */
  readonly atExit: RProc[] = [];
  /** The row of the statement running now, which a call records as its frame's call row. */
  currentRow = 0;
  /** The fake addresses `inspect` shows for objects, assigned in the order the program shows them. */
  readonly addresses = new Map<object, number>();
  c!: CoreClasses;
  mainObject!: RObject;
  /** The state of the default random number generator, which `srand` reseeds. */
  random: unknown;

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  pushFrame(frame: Frame): void {
    if (this.frames.length >= LIMITS.maxCallDepth) throw stackTooDeep();
    this.frames.push(frame);
  }

  popFrame(): void {
    this.frames.pop();
  }

  get frame(): Frame {
    return this.frames.at(-1) as Frame;
  }

  collectGarbage(): void {
    collectGarbage(this);
  }
}

/** Ruby's error for too deep recursion, built by the bootstrap once the classes exist. */
export const stackTooDeepFactory: { create?: () => unknown } = {};

function stackTooDeep(): unknown {
  return stackTooDeepFactory.create?.() ?? new Error('stack level too deep');
}

let current: Runtime | undefined;

export function rt(): Runtime {
  if (!current) throw new Error('No Ruby runtime is running');
  return current;
}

export function withRuntime<T>(runtime: Runtime, run: () => T): T {
  const outer = current;
  current = runtime;
  try {
    return run();
  } finally {
    current = outer;
  }
}
