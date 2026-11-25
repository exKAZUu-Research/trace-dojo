import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { FunctionInfo, GlobalDef } from './core';
import type { InstanceInfo } from './entities';
import { markReachable, thunkReferences } from './gc';
import type { DoFrame, TraceContext } from './ioBlocks';
import { Machine } from './machine';
import { DisplayAbort, PreviewBudget, type PreviewView } from './previewBudget';
import type { Type } from './types';
import { withTypeWorkBudget } from './typeWorkBudget';
import { Dict, type Env, type Slot, Thunk, untypedSlot, type Value } from './values';

export { DisplayAbort } from './previewBudget';

const ALLOCATION_OVERHEAD = 8;
const ALLOCATION_LIMIT = LIMITS.maxSlots * ALLOCATION_OVERHEAD;
export const MAX_DISPLAY_NODES = Math.floor(LIMITS.maxSlots / ALLOCATION_OVERHEAD);

export class TraceFrame implements TracedFrame {
  readonly contexts: TraceContext[] = [];

  constructor(
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

export type PreviewContext = Pick<PreviewView, 'owner' | 'scope'> & { frame: TraceFrame };

export class Runtime implements TracedRuntime<TraceFrame> {
  readonly world = new TurtleWorld();
  readonly budget: ExecutionBudget;
  readonly io: ProgramIO;
  /** What a Template Haskell splice's program, run while a program compiles, stores for the compiler. */
  readonly splice: { result?: Slot; errors: string[]; exit?: string } = { errors: [] };
  readonly steps = new StepTracker();
  readonly frames: TraceFrame[] = [];
  readonly machine: Machine;
  displaysAnswer?: (name: string, slot: Slot, type: Type, context: PreviewContext) => boolean;
  private readonly globals = new Map<GlobalDef, Slot>();
  private readonly dictCache = new Map<InstanceInfo, Dict>();
  private allocated = 0;
  private gcMilliseconds = 0;
  private readonly previews = new PreviewBudget();

  constructor(input?: ProgramInput, budget = new ExecutionBudget()) {
    this.budget = budget;
    this.io = new ProgramIO(this.budget, input);
    this.machine = new Machine(this);
  }

  spend(cost = 1): void {
    if (this.displayRemaining !== undefined) {
      this.spendDisplay(cost, cost);
    } else this.budget.spend(cost);
  }

  private displayRemaining: number | undefined;
  private renderDeadline: number | undefined;
  private readonly renderMilliseconds = { answer: 0, reference: 0 };
  private displayAllocated = 0;
  private displayRetained = 0;
  private renderExcludedMilliseconds = 0;

  withRenderBudget<T>(kind: 'answer' | 'reference', run: () => T): T {
    if (this.renderDeadline !== undefined) return run();
    const started = performance.now();
    const excluded = this.renderExcludedMilliseconds;
    this.renderDeadline = started + LIMITS.maxMilliseconds - this.renderMilliseconds[kind];
    const allocated = this.displayAllocated;
    const retained = this.displayRetained;
    try {
      if (started >= this.renderDeadline) throw new DisplayAbort();
      return run();
    } catch (error) {
      this.displayAllocated = allocated + this.displayRetained - retained;
      throw error;
    } finally {
      this.renderMilliseconds[kind] += performance.now() - started - (this.renderExcludedMilliseconds - excluded);
      this.renderDeadline = undefined;
    }
  }

  /** Runs evaluation for a trace's display, which stops with `DisplayAbort` after `operations`. */
  withDisplayBudget<T>(operations: number, run: () => T): T {
    if (this.displayRemaining !== undefined) return run();
    this.displayRemaining = operations;
    try {
      return this.budget.excludingTime(() => withTypeWorkBudget(() => this.spendDisplay(1, 0), run));
    } finally {
      this.displayRemaining = undefined;
    }
  }

  /**
   * Stops a trace's display before a value's evaluation performs an effect (a lazy read, `Debug.Trace` output), so the
   * display shows the value unevaluated and the program's own run performs the effect when it needs the value.
   */
  beginEffect(): void {
    if (this.displayRemaining !== undefined) throw new DisplayAbort();
  }

  endPreviewStatement(owner: DoFrame, frame: TraceFrame): void {
    this.previews.endScope(frame, owner.env);
  }

  previewScope(frame: TraceFrame, owner: Env): object {
    for (const context of frame.contexts) {
      if (owner === context.env || owner === context.prefixEnv) return context.env;
    }
    for (let index = frame.contexts.length - 1; index >= 0; index--) {
      const context = frame.contexts[index];
      for (let env = context.env.parent; env; env = env.parent) {
        if (frame.contexts.some((outer) => env === outer.env || env === outer.prefixEnv)) break;
        if (env === owner) return context.env;
      }
    }
    return frame.contexts[0]?.env ?? owner;
  }

  withPreviewBudget<T>(view: PreviewView, run: () => T): T {
    return this.previews.run(view, run);
  }

  forcePreview(slot: Thunk): Value {
    const started = this.renderDeadline === undefined ? undefined : performance.now();
    try {
      return this.previews.force(slot, () => this.machine.force(slot));
    } finally {
      if (started !== undefined) {
        const elapsed = performance.now() - started;
        this.renderDeadline! += elapsed;
        this.renderExcludedMilliseconds += elapsed;
      }
    }
  }

  trackPreview(slot: Slot): boolean {
    slot = untypedSlot(slot);
    return slot instanceof Thunk && this.previews.track(slot);
  }

  previewRoots(slot: Thunk): readonly Slot[] | undefined {
    return this.previews.rootsFor(slot);
  }

  completePreview(...slots: Slot[]): void {
    for (const slot of slots) this.trackPreview(slot);
    this.previews.completeView();
  }

  incompletePreview(): void {
    this.previews.incompleteView();
  }

  consumePreview(slot: Thunk): void {
    const cost = this.previews.consume(slot, this.displayRemaining === undefined);
    if (cost) {
      this.budget.spend(cost.operations);
      this.recordAllocation(cost.allocations);
    }
  }

  beginPreview(slot: Thunk): void {
    this.previews.enter(slot, this.world.hasTurtles ? () => thunkReferences(slot) : undefined);
  }

  endPreview(slot: Thunk, aborted = false): void {
    this.previews.leave(slot, aborted);
  }

  evaluationLimitError(): Error {
    return this.displayRemaining === undefined ? new ExecutionLimitError('operations') : new DisplayAbort();
  }

  allocate(count: number): void {
    if (this.displayRemaining !== undefined) {
      this.spendDisplay(count, Math.max(0, count - ALLOCATION_OVERHEAD), count);
      return;
    }
    // Calls and thunk entries cover fixed-size bookkeeping; charging it again rejects ordinary library work.
    if (count > ALLOCATION_OVERHEAD) this.spend(count - ALLOCATION_OVERHEAD);
    this.recordAllocation(count);
  }

  private recordAllocation(count: number): void {
    this.allocated += count;
    if (this.allocated > ALLOCATION_LIMIT) throw new ExecutionLimitError('operations');
  }

  allocateDisplay(): void {
    if (this.displayAllocated + ALLOCATION_OVERHEAD > LIMITS.maxSlots) throw new DisplayAbort();
    this.displayAllocated += ALLOCATION_OVERHEAD;
  }

  retainDisplay(): void {
    this.displayRetained += ALLOCATION_OVERHEAD;
  }

  private spendDisplay(cost: number, executionCost: number, allocations = 0): void {
    if (this.renderDeadline !== undefined && !this.previews.forcing && performance.now() >= this.renderDeadline)
      throw new DisplayAbort();
    this.displayRemaining = (this.displayRemaining as number) - cost;
    if (this.displayRemaining < 0) throw new DisplayAbort();
    this.previews.spend(cost, executionCost, allocations);
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
    if (index !== -1) for (const removed of this.frames.splice(index)) this.previews.endFrame(removed);
    if (returned && frame.isAtomic) this.steps.completeAtomicCall();
  }

  collectGarbage(temporaryRoots: readonly Slot[] = []): void {
    if (!this.world.hasTurtles) return;
    this.budget.excludingTime(() => {
      const started = performance.now();
      const deadline = started + LIMITS.maxMilliseconds - this.gcMilliseconds;
      const checkTime = (): void => {
        if (performance.now() > deadline) throw new ExecutionLimitError('trace');
      };
      try {
        const reached = withTypeWorkBudget(checkTime, () => markReachable(this, checkTime, temporaryRoots));
        this.world.retain((turtle) => reached.has(turtle));
        checkTime();
      } finally {
        this.gcMilliseconds += performance.now() - started;
      }
    });
  }
}

function createDict(runtime: Runtime, instance: InstanceInfo, args: Slot[]): Dict {
  const builders = dictBuilders.get(instance);
  if (!builders) throw new Error(`The instance ${instance.cls.name} has no code`);
  const slots = 1 + args.length + builders.methods.length + builders.supers.length + builders.superclassSlots;
  runtime.allocate(slots);
  const methods: Slot[] = [];
  const supers: Slot[] = [];
  const dict = new Dict(instance, methods, supers, args);
  for (const build of builders.methods) methods.push(build(runtime, dict, args));
  for (const build of builders.supers) supers.push(build(runtime, dict, args));
  return dict;
}

export interface DictBuilders {
  superclassSlots: number;
  methods: ((runtime: Runtime, dict: Dict, args: Slot[]) => Slot)[];
  supers: ((runtime: Runtime, dict: Dict, args: Slot[]) => Slot)[];
}

/** How each instance's dictionary is built, which code generation registers. */
export const dictBuilders = new WeakMap<InstanceInfo, DictBuilders>();
