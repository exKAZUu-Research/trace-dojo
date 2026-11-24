import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import { BufferMemorySpace } from './bufferMemory';
import { rejectRuntimeEffect } from './comptimeMemory';
import type { FunctionInstance } from './functions';
import { TurtleReachability } from './turtleReachability';
import type { Type } from './types';
import { createUtf8Decoder } from './utf8';
import { type Slots, UNASSIGNED, type Value } from './values';

/** A panic, which ends the program: Zig's safety checks and `@panic` cannot be caught. */
export class ZigPanic extends Error {
  constructor(readonly text: string) {
    super(`panic: ${text}`);
    this.name = 'ZigPanic';
  }
}

/** Ends the program as `std.process.exit` does. */
export class ProgramExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'ProgramExit';
  }
}

/** How many backward branches (loop iterations and calls) one analysis has evaluated at compile time, and its limit. */
export interface BranchCount {
  count: number;
  quota: number;
}

/** Compile-time evaluation that took more backward branches than `@setEvalBranchQuota` allows. */
export class BranchQuotaExceeded extends Error {
  constructor(
    readonly row: number | undefined,
    readonly quota: number
  ) {
    super(`evaluation exceeded ${quota} backwards branches`);
    this.name = 'BranchQuotaExceeded';
  }
}

/** A `break`, `continue`, or `return` inside an expression, which unwinds to the construct it leaves. */
export class Jump {
  constructor(
    readonly kind: 'break' | 'continue' | 'return',
    /** The block or loop it leaves, or the function for a return. */
    readonly target: object,
    readonly value: Value,
    readonly type?: Type
  ) {}
}

/** A function's activation: its locals, which pointers may refer into, and the deferred code of its open scopes. */
export class Frame implements Slots, TracedFrame {
  slots: Value[];
  /** Values that are reachable while the frame computes them, such as a for loop's operands. */
  readonly temporaries: { value: Value; type?: Type }[] = [];
  /** The deferred statements of the scopes entered, innermost last. */
  readonly defers: Deferred[] = [];

  constructor(
    readonly runtime: Runtime,
    readonly fn: FunctionInstance,
    readonly callRow: number | undefined,
    slotCount: number,
    readonly nativeCallRow?: number
  ) {
    this.slots = Array.from({ length: slotCount }, () => UNASSIGNED);
  }
}

export interface Deferred {
  isErrdefer: boolean;
  run: (frame: Frame) => void;
}

export class Runtime {
  bufferMemory = new BufferMemorySpace();
  readonly budget: ExecutionBudget;
  readonly io: ProgramIO;
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly frames: Frame[] = [];
  private readonly outputDecoders = [createUtf8Decoder(), createUtf8Decoder()];
  /** The storage of container-level variables, which garbage collection starts from. */
  readonly globals: { cell: Slots; type: Type }[] = [];
  private readonly turtleReachability = new TurtleReachability((cost) => this.spend(cost));
  private allocated = 0;
  private activeFrameSlots = 0;
  /** The backward branches of the analysis that evaluates code at compile time, which a run of the program lacks. */
  branchCount: BranchCount | undefined;

  constructor(input?: ProgramInput, budget = new ExecutionBudget()) {
    this.budget = budget;
    this.io = new ProgramIO(this.budget, input);
  }

  identityOf(value: object): bigint {
    return this.bufferMemory.identityOf(value);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Counts a loop's iteration or a call while the compiler evaluates code, as Zig's evaluation quota does. */
  backwardBranch(row: number | undefined): void {
    const count = this.branchCount;
    if (count && ++count.count > count.quota) throw new BranchQuotaExceeded(row, count.quota);
  }

  writeOutput(fd: number, bytes: readonly number[]): void {
    rejectRuntimeEffect();
    const index = fd === 2 ? 1 : 0;
    const text = this.outputDecoders[index].decode(new Uint8Array(bytes), { stream: true });
    (index === 1 ? this.io.stderr : this.io.stdout).write(text);
  }

  finishOutput(): void {
    this.io.stdout.write(this.outputDecoders[0].decode());
    this.io.stderr.write(this.outputDecoders[1].decode());
  }

  /** Counts slots that a program allocates, ending it as Zig does when memory runs out. */
  reserveStorage(count: number): void {
    if (!this.canAllocate(count)) throw new ExecutionLimitError('storage');
    this.allocate(count);
  }

  allocate(count: number): void {
    if (!this.canAllocate(count)) throw new OutOfMemory();
    this.allocated += count;
  }

  /** Whether allocating `count` more slots stays within the limit, for allocators that return `error.OutOfMemory`. */
  canAllocate(count: number): boolean {
    return this.allocated + this.activeFrameSlots + count <= LIMITS.maxSlots && count <= LIMITS.maxSlots;
  }

  withFrame<T>(
    fn: FunctionInstance,
    callRow: number | undefined,
    nativeCallRow: number | undefined,
    run: (frame: Frame) => T
  ): T {
    if (this.frames.length >= LIMITS.maxCallDepth) throw new StackOverflow();
    const slots = fn.slotCount;
    if (!this.canAllocate(slots)) throw new ExecutionLimitError('storage');
    this.spend(Math.ceil(slots / 16));
    const frame = new Frame(this, fn, callRow, slots, nativeCallRow);
    this.activeFrameSlots += slots;
    this.frames.push(frame);
    try {
      return run(frame);
    } finally {
      this.frames.pop();
      this.activeFrameSlots -= slots;
    }
  }

  /** Removes the turtles that no variable reaches any longer, as Java's garbage collector does. */
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const turtles = this.turtleReachability.collect(this.globals, this.frames);
    this.world.retain((turtle) => turtles.has(turtle));
  }
}

export class OutOfMemory extends Error {
  constructor() {
    super('out of memory');
    this.name = 'OutOfMemory';
  }
}

/** Deeper recursion than the grader allows, which ends the program as a stack overflow ends Zig's. */
export class StackOverflow extends Error {
  constructor() {
    super('stack overflow');
    this.name = 'StackOverflow';
  }
}

export function withHeldValues<T>(frame: Frame, values: readonly Value[], run: () => T, types?: readonly Type[]): T {
  const mark = frame.temporaries.length;
  for (const [index, value] of values.entries()) frame.temporaries.push({ value, type: types?.[index] });
  try {
    return run();
  } finally {
    frame.temporaries.length = mark;
  }
}
