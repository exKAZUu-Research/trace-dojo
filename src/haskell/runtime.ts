import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { FunctionInfo, GlobalDef } from './core';
import type { InstanceInfo } from './entities';
import { markReachable } from './gc';
import type { TraceContext } from './ioBlocks';
import { Machine } from './machine';
import { Dict, type Env, type Slot, Thunk } from './values';

/** Stops evaluating a value for a trace's display, which leaves the value as it was. */
export class DisplayAbort extends Error {
  constructor() {
    super('Display evaluation took too long');
    this.name = 'DisplayAbort';
  }
}

/** A call shown in a trace: a named function (or the program's `main`) running `IO` statements. */
export class TraceFrame implements TracedFrame {
  readonly contexts: TraceContext[] = [];

  constructor(
    /** The frame of the call whose statements this trace frame shows. */
    readonly invocation: Env | undefined,
    readonly callRow: number | undefined
  ) {}

  get info(): FunctionInfo | undefined {
    return this.invocation?.info;
  }

  get isAtomic(): boolean {
    return this.info?.isAtomic ?? false;
  }

  /** The row of the statement running in this frame, which a call it makes shows as its call line. */
  currentRow(): number | undefined {
    for (let index = this.contexts.length - 1; index >= 0; index--) {
      const row = this.contexts[index].row;
      if (row !== undefined) return row;
    }
    return undefined;
  }
}

/** The state of one run: its globals, its machine, its trace frames, its turtles, and its output. */
export class Runtime implements TracedRuntime<TraceFrame> {
  readonly world = new TurtleWorld();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly steps = new StepTracker();
  readonly frames: TraceFrame[] = [];
  readonly machine: Machine;
  readonly displayAborted = new WeakSet<Thunk>();
  private readonly globals = new Map<GlobalDef, Slot>();
  private readonly dictCache = new Map<InstanceInfo, Dict>();
  private allocated = 0;

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
    this.machine = new Machine(this);
  }

  spend(cost = 1): void {
    if (this.displayRemaining !== undefined) {
      this.displayRemaining -= cost;
      if (this.displayRemaining < 0) throw new DisplayAbort();
    } else this.budget.spend(cost);
  }

  private displayRemaining: number | undefined;

  /** Runs evaluation for a trace's display, which stops with `DisplayAbort` after `operations`. */
  withDisplayBudget<T>(operations: number, run: () => T): T {
    const saved = this.displayRemaining;
    this.displayRemaining = operations;
    try {
      return this.budget.excludingTime(run);
    } finally {
      this.displayRemaining = saved;
    }
  }

  /**
   * The error for a thunk that demands its own value, which never finishes: runghc keeps running instead of reporting
   * `<<loop>>` as compiled programs do, so the run ends as any endless loop does, and a display leaves the value as it is.
   */
  selfDependencyError(): Error {
    return this.displayRemaining === undefined ? new ExecutionLimitError('operations') : new DisplayAbort();
  }

  /** Counts slots a run allocates, bounding its memory. */
  allocate(count: number): void {
    if (this.displayRemaining !== undefined) {
      this.spend(count);
      return;
    }
    this.allocated += count;
    if (this.allocated > LIMITS.maxSlots * 8) throw new ExecutionLimitError('operations');
  }

  global(def: GlobalDef): Slot {
    let slot = this.globals.get(def);
    if (slot === undefined) {
      if (!def.code) throw new Error(`The global ${def.name} has no code`);
      slot = new Thunk(def.code, undefined);
      this.globals.set(def, slot);
    }
    return slot;
  }

  makeDict(instance: InstanceInfo, args: Slot[]): Dict {
    if (args.length === 0) {
      const cached = this.dictCache.get(instance);
      if (cached) return cached;
    }
    const dict = createDict(this, instance, args);
    if (args.length === 0) this.dictCache.set(instance, dict);
    return dict;
  }

  pushFrame(invocation: Env | undefined, callRow: number | undefined): TraceFrame {
    const frame = new TraceFrame(invocation, callRow);
    this.frames.push(frame);
    return frame;
  }

  /** Pops a trace frame; a call that returns from an atomic function leaves an effect the next step shows. */
  popFrame(frame: TraceFrame, returned = true): void {
    const index = this.frames.lastIndexOf(frame);
    if (index !== -1) this.frames.splice(index);
    if (returned && frame.isAtomic) this.steps.completeAtomicCall();
  }

  /** Runs before each collection; a trace evaluates the variables it shows, which may drop references to turtles. */
  beforeCollect: (() => void) | undefined;

  /** Removes the turtles that nothing the program can still use reaches. */
  collectGarbage(): void {
    this.beforeCollect?.();
    const reached = markReachable(this);
    this.world.retain((turtle) => reached.has(turtle));
  }
}

/**
 * Builds an instance's dictionary: each method from the instance's implementation applied to the context's
 * dictionaries, or from the class's default applied to the dictionary itself.
 */
function createDict(runtime: Runtime, instance: InstanceInfo, args: Slot[]): Dict {
  const methods: Slot[] = [];
  const supers: Slot[] = [];
  const dict = new Dict(instance, methods, supers, args);
  const builders = dictBuilders.get(instance);
  if (!builders) throw new Error(`The instance ${instance.cls.name} has no code`);
  for (const build of builders.methods) methods.push(build(runtime, dict, args));
  for (const build of builders.supers) supers.push(build(runtime, dict, args));
  return dict;
}

export interface DictBuilders {
  methods: ((runtime: Runtime, dict: Dict, args: Slot[]) => Slot)[];
  supers: ((runtime: Runtime, dict: Dict, args: Slot[]) => Slot)[];
}

/** How each instance's dictionary is built, which code generation registers. */
export const dictBuilders = new WeakMap<InstanceInfo, DictBuilders>();
