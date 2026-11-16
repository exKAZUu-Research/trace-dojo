import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { FunctionInstance } from './functions';
import {
  NativeHandle,
  Pointer,
  Slice,
  type Slots,
  Some,
  UNASSIGNED,
  type Value,
  ZArray,
  ZStruct,
  ZUnion,
} from './values';

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
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly frames: Frame[] = [];
  private readonly outputDecoders = [new TextDecoder(), new TextDecoder()];
  /** The storage of container-level variables, which garbage collection starts from. */
  readonly globals: Slots[] = [];
  /** Values that native objects hold, such as a hash map's entries, reached through their handles. */
  private allocated = 0;

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  writeOutput(fd: number, bytes: readonly number[]): void {
    const index = fd === 2 ? 1 : 0;
    const text = this.outputDecoders[index].decode(new Uint8Array(bytes), { stream: true });
    (index === 1 ? this.io.stderr : this.io.stdout).write(text);
  }

  finishOutput(): void {
    this.io.stdout.write(this.outputDecoders[0].decode());
    this.io.stderr.write(this.outputDecoders[1].decode());
  }

  /** Counts slots that a program allocates, ending it as Zig does when memory runs out. */
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
    const reached = new Set<unknown>();
    const stack: unknown[] = [];
    for (const global of this.globals) stack.push(global);
    for (const frame of this.frames) stack.push(...frame.slots, ...frame.temporaries);
    const turtles = new Set<unknown>();
    while (stack.length > 0) {
      const item = stack.pop();
      if (item === undefined || item === null || typeof item !== 'object' || reached.has(item)) continue;
      reached.add(item);
      pushChildren(item, stack, turtles);
    }
    this.world.retain((turtle) => turtles.has(turtle));
  }
}

function pushChildren(item: object, stack: unknown[], turtles: Set<unknown>): void {
  if (item instanceof ZArray || item instanceof ZStruct || item instanceof ZUnion) {
    stack.push(...item.slots);
  } else if (item instanceof Pointer) {
    stack.push(item.target);
  } else if (item instanceof Slice) {
    stack.push(item.target);
  } else if (item instanceof Some) {
    stack.push(item.value);
  } else if (item instanceof NativeHandle) {
    if (item.state.turtle) turtles.add(item.state.turtle);
    for (const value of Object.values(item.state)) stack.push(value);
  } else if (Array.isArray(item)) {
    stack.push(...(item as unknown[]));
  } else if ('slots' in item && Array.isArray((item as Slots).slots)) {
    stack.push(...(item as Slots).slots);
  }
}

/** Running out of the slots a run may allocate, which ends it as Zig's allocator failing would not: see Notes. */
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
