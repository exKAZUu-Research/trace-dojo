import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import { BufferMemorySpace } from './bufferMemory';
import { rejectRuntimeEffect } from './comptimeMemory';
import type { FunctionInstance } from './functions';
import { FileStream, InputStream, type OpenFile, OutputStream, type Stream } from './streams';
import { TurtleReachability } from './turtleReachability';
import type { Type } from './types';
import { unavailableMessage } from './unavailable';
import { type Slots, UNASSIGNED, type Value } from './values';

/** A panic, which ends the program: Zig's safety checks and `@panic` cannot be caught. */
export class ZigPanic extends Error {
  constructor(readonly text: string) {
    super(`panic: ${text}`);
    this.name = 'ZigPanic';
  }
}

/** Ends the program at an operation that the grader does not run, with the 「使えません」 diagnostic. */
export class UnavailableOperation extends Error {
  constructor(key: string) {
    super(unavailableMessage(key));
    this.name = 'UnavailableOperation';
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

/** Calls nested deeper than the grader's call depth while the compiler evaluates code, which ends the analysis. */
export class CompileTimeCallDepthExceeded extends Error {
  constructor(readonly row: number | undefined) {
    super('compile-time calls nested too deep');
    this.name = 'CompileTimeCallDepthExceeded';
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
  /** The storage of container-level variables, which garbage collection starts from. */
  readonly globals: { cell: Slots; type: Type }[] = [];
  private readonly turtleReachability = new TurtleReachability((cost) => this.spend(cost));
  private allocated = 0;
  private activeFrameSlots = 0;
  /** The backward branches of the analysis that evaluates code at compile time, which a run of the program lacks. */
  branchCount: BranchCount | undefined;
  /** The stream each descriptor that a `std.Io.File` holds refers to, standard streams included. */
  private readonly descriptors = new Map<number, Stream>();
  private nextDescriptor = 3;

  constructor(input?: ProgramInput, budget = new ExecutionBudget()) {
    this.budget = budget;
    this.io = new ProgramIO(this.budget, input);
    this.descriptors.set(0, new InputStream(this.io.stdin.reader));
    this.descriptors.set(1, new OutputStream(this.io.stdout));
    this.descriptors.set(2, new OutputStream(this.io.stderr));
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

  openFile(file: OpenFile): number {
    const descriptor = this.nextDescriptor++;
    this.descriptors.set(
      descriptor,
      new FileStream(file, () => {
        throw new UnavailableOperation('io:nonUtf8File');
      })
    );
    return descriptor;
  }

  closeDescriptor(descriptor: number): void {
    const stream = this.descriptors.get(descriptor);
    // Closing a closed descriptor is the use after free that a Debug build's close asserts against.
    if (!stream || stream.closed) throw new ZigPanic('reached unreachable code');
    stream.closed = true;
    stream.finish();
  }

  /** The file that a descriptor refers to, when it is open and not a standard stream. */
  openFileAt(descriptor: number): OpenFile | undefined {
    const stream = this.openStream(descriptor);
    return stream instanceof FileStream ? stream.file : undefined;
  }

  /**
   * Reads up to `limit` bytes of standard input or of an open file, none at its end, and `undefined` from a descriptor
   * that is unknown, closed, or not open for reading, as the OS refuses them.
   */
  readInput(descriptor: number, limit: number): Uint8Array | undefined {
    rejectRuntimeEffect();
    const stream = this.openStream(descriptor);
    return stream?.mode.read ? stream.read(limit, (cost) => this.spend(cost)) : undefined;
  }

  /** Whether a read of the descriptor has met its end, which is when Zig's `File.Reader` learns the size. */
  sawInputEnd(descriptor: number): boolean {
    return this.openStream(descriptor)?.sawEnd === true;
  }

  /** Whether reading standard input or an open file would give no more bytes. */
  inputAtEnd(descriptor: number): boolean {
    const stream = this.openStream(descriptor);
    return !stream?.mode.read || stream.atEnd();
  }

  /**
   * Writes to standard output, standard error, or a file open for writing, telling whether the descriptor accepts
   * writes: an unknown or closed descriptor, or one not open for writing, does not, as the OS refuses them.
   */
  writeOutput(fd: number, bytes: readonly number[]): boolean {
    rejectRuntimeEffect();
    const stream = this.openStream(fd);
    if (!stream?.mode.write) return false;
    stream.write(bytes);
    return true;
  }

  private openStream(descriptor: number): Stream | undefined {
    const stream = this.descriptors.get(descriptor);
    return stream && !stream.closed ? stream : undefined;
  }

  finishOutput(): void {
    for (const fd of [1, 2]) this.descriptors.get(fd)?.finish();
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
    if (this.frames.length >= LIMITS.maxCallDepth) {
      if (this.branchCount) throw new CompileTimeCallDepthExceeded(callRow);
      throw new StackOverflow();
    }
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
