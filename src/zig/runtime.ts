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

/** A `break`, `continue`, or `return` inside an expression, which unwinds to the construct it leaves. */
export class Jump {
  constructor(
    readonly kind: 'break' | 'continue' | 'return',
    /** The block or loop it leaves, or the function for a return. */
    readonly target: object,
    readonly value: Value
  ) {}
}

/** A function's activation: its locals, which pointers may refer into, and the deferred code of its open scopes. */
export class Frame implements Slots, TracedFrame {
  slots: Value[];
  /** Values that are reachable while the frame computes them, such as a for loop's operands. */
  readonly temporaries: Value[] = [];
  /** The deferred statements of the scopes entered, innermost last. */
  readonly defers: Deferred[] = [];

  constructor(
    readonly runtime: Runtime,
    readonly fn: FunctionInstance,
    readonly callRow: number | undefined,
    slotCount: number
  ) {
    this.slots = Array.from<Value>({ length: slotCount }).fill(UNASSIGNED);
  }
}

export interface Deferred {
  isErrdefer: boolean;
  run: (frame: Frame) => void;
}

export class Runtime {
  readonly bufferMemory = new BufferMemorySpace();
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
  private readonly identities = new WeakMap<object, bigint>();
  private nextIdentity = 1n;

  constructor(input?: ProgramInput, budget = new ExecutionBudget()) {
    this.budget = budget;
    this.io = new ProgramIO(this.budget, input);
  }

  identityOf(value: object): bigint {
    let identity = this.identities.get(value);
    if (identity === undefined) {
      identity = this.nextIdentity++;
      this.identities.set(value, identity);
    }
    return identity;
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
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
    this.allocated += count;
    if (this.allocated > LIMITS.maxSlots || count > LIMITS.maxSlots) throw new OutOfMemory();
  }

  /** Whether allocating `count` more slots stays within the limit, for allocators that return `error.OutOfMemory`. */
  canAllocate(count: number): boolean {
    return this.allocated + count <= LIMITS.maxSlots && count <= LIMITS.maxSlots;
  }

  pushFrame(frame: Frame): void {
    if (this.frames.length >= LIMITS.maxCallDepth) throw new StackOverflow();
    this.frames.push(frame);
  }

  popFrame(): void {
    this.frames.pop();
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

export function withHeldValues<T>(frame: Frame, values: readonly Value[], run: () => T): T {
  const mark = frame.temporaries.length;
  for (const value of values) frame.temporaries.push(value);
  try {
    return run();
  } finally {
    frame.temporaries.length = mark;
  }
}
