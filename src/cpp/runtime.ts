import { ByteStream } from '../c/library/support';
import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { type TurtleState, TurtleWorld } from '../interpreter/turtleWorld';
import { byteAt } from './bytes';
import { type CppException, CppRuntimeError, ProgramAbort } from './errors';
import { StreamValue } from './library/iostream';
import type { FunctionInfo, Type } from './types';
import { Box, childValues, CObject, endLifetime, Liveness, Ptr, Store, type Value } from './values';

/** How a statement ended: normally (undefined), or by `break`, `continue`, or `return`. */
export const BREAK = 1;
export const CONTINUE = 2;
export const RETURN = 3;
export type Completion = number | undefined;

export type Exec = (frame: Frame) => Completion;
export type Eval<T = Value> = (frame: Frame) => T;

/** A variable of a function, which the trace shows while it is in scope. */
export interface LocalInfo {
  name: string;
  slot: number;
  type: Type;
  isParameter: boolean;
}

export interface CompiledFunction {
  slotCount: number;
  /** The variables in the order of their declarations. */
  locals: LocalInfo[];
  /** Runs the body in a frame whose parameters are bound, leaving the result in `frame.returnValue`. */
  body: (frame: Frame) => void;
}

/** What a slot of a frame holds: the storage of a variable, or the location a reference variable designates. */
export type Slot = Store | Ptr | undefined;

/** An object waiting for the end of the full-expression that created it, when its destructor runs. */
export interface Temporary {
  object: Value;
  destroy: (frame: Frame, object: Value) => void;
}

export class Frame implements TracedFrame {
  readonly slots: Slot[];
  returnValue: Value | Ptr = undefined;
  readonly temporaries: Temporary[] = [];
  /** Values the frame holds outside its variables, such as an exception a handler runs for. */
  readonly pending: (Value | Ptr)[] = [];
  /** The slot of the local variable that a `return` returned without copying (the named return value). */
  nrvoSlot: number | undefined;

  /**
   * @param self The location of the object a member function runs for, which `this` points to.
   */
  constructor(
    readonly runtime: Runtime,
    readonly fn: FunctionInfo | undefined,
    readonly callRow: number | undefined,
    slotCount: number,
    readonly self: Ptr | undefined,
    readonly compiled: CompiledFunction | undefined
  ) {
    this.slots = Array.from({ length: slotCount });
  }

  /** The object a member function runs for. */
  get thisObject(): CObject | undefined {
    const store = this.self?.store;
    if (!store) return undefined;
    const value = store instanceof Box ? store.value : (store as Store).get(this.self?.index ?? 0);
    return value instanceof CObject ? value : undefined;
  }
}

/**
 * Evaluates values in order, keeping each one reachable (for collecting garbage) until `use` returns, as a call's
 * arguments and a list's elements are while the rest of them are evaluated.
 */
export function holdAll<T>(frame: Frame, runs: readonly Eval<unknown>[], use: (values: unknown[]) => T): T {
  const mark = frame.pending.length;
  try {
    const values: unknown[] = [];
    for (const run of runs) {
      const value = run(frame);
      frame.pending.push(value as Value);
      values.push(value);
    }
    return use(values);
  } finally {
    frame.pending.length = mark;
  }
}

/** The state of one run: the call stack, the static storage, the turtles, and the output. */
export class Runtime implements TracedRuntime<Frame> {
  isStdioSynchronized = true;
  readonly world = new TurtleWorld();
  readonly frames: Frame[] = [];
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly steps = new StepTracker();
  /** The storage of each variable with static storage duration, by its index. */
  globals: Store[] = [];
  private allocatedSlots = 0;
  private readonly writers: Record<'stdout' | 'stderr', ByteStream>;
  /** The state of `rand`. */
  randomState = 1;
  /** The objects with static storage duration that have destructors, in the order their construction completed. */
  readonly staticObjects: { box: Box; destroy: (frame: Frame, value: Value) => void }[] = [];

  /** Destroys the objects with static storage duration, the last constructed first, as exiting the program does. */
  destroyStaticObjects(): void {
    const frame = this.pushFrame(undefined, undefined, undefined, undefined);
    try {
      while (this.staticObjects.length > 0) {
        const { box, destroy } = this.staticObjects.pop() as {
          box: Box;
          destroy: (frame: Frame, value: Value) => void;
        };
        destroy(frame, box.value);
        endLifetime(box);
      }
    } finally {
      this.popFrame();
    }
  }

  /** The exceptions whose handlers are running, the innermost last, which `throw;` rethrows. */
  readonly handling: CppException[] = [];
  /**
   * The handlers of the `try` blocks running now, the innermost last. A `throw` that no handler matches ends the
   * program at once, without unwinding the stack, as libc++abi's two-phase exception handling does.
   */
  readonly tryBlocks: ((exception: CppException) => boolean)[] = [];
  private tryBoundary = 0;
  /** Describes an exception that no handler catches, as libc++abi does when it terminates the program. */
  describeUncaught: (frame: Frame, exception: CppException) => string = () => 'libc++abi: terminating';
  /** Receives `main`'s frame when its body completes, before its variables end their lifetime. */
  onMainEnd: ((frame: Frame) => void) | undefined;

  private readonly streams = new Map<string, StreamValue>();

  /** `std::cout` or `std::cerr` of this run, whose formatting state persists across the run. */
  standardStream(target: 'stdout' | 'stderr' | 'clog'): StreamValue {
    let stream = this.streams.get(target);
    if (!stream) {
      stream = new StreamValue(target === 'clog' ? 'stderr' : target);
      if (target === 'stderr') stream.tied = new Ptr(this.standardStream('stdout'), 0);
      this.streams.set(target, stream);
    }
    return stream;
  }

  withoutOuterHandlers<T>(run: () => T): T {
    const previous = this.tryBoundary;
    this.tryBoundary = this.tryBlocks.length;
    try {
      return run();
    } finally {
      this.tryBoundary = previous;
    }
  }

  /** Throws a C++ exception, or ends the program when no reachable handler catches it. */
  throwException(frame: Frame, exception: CppException): never {
    for (let index = this.tryBlocks.length - 1; index >= this.tryBoundary; index--)
      if (this.tryBlocks[index](exception)) throw exception;
    throw new ProgramAbort(this.describeUncaught(frame, exception));
  }

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
    this.writers = {
      stdout: new ByteStream((text) => this.io.stdout.write(text)),
      stderr: new ByteStream((text) => this.io.stderr.write(text)),
    };
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Charges `count` values of storage, stopping the program when it allocates too much. */
  reserve(count: number): void {
    this.allocatedSlots += count;
    if (this.allocatedSlots > LIMITS.maxSlots) throw new CppRuntimeError('custom', 'メモリを確保しすぎました。');
    this.spend(Math.ceil(count / 64));
  }

  /** Writes bytes (a string of character codes below 256) to standard output or standard error. */
  write(stream: 'stdout' | 'stderr', bytes: string): void {
    if (bytes.length === 0) return;
    // oxlint-disable-next-line no-control-regex -- ASCII text decodes to itself.
    if (/^[\u0000-\u007F]*$/.test(bytes)) {
      this.writers[stream].flush();
      if (stream === 'stdout') this.io.stdout.write(bytes);
      else this.io.stderr.write(bytes);
      return;
    }
    const array = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index++) array[index] = byteAt(bytes, index);
    this.writers[stream].bytes(array);
  }

  flushOutput(): void {
    this.writers.stdout.flush();
    this.writers.stderr.flush();
  }

  withReceiver<T>(parent: Frame, self: Ptr, evaluate: (frame: Frame) => T): T {
    const frame = this.pushFrame(undefined, undefined, undefined, self);
    try {
      return evaluate(frame);
    } finally {
      this.popFrame();
      for (const temporary of frame.temporaries) parent.temporaries.push(temporary);
    }
  }

  pushFrame(
    fn: FunctionInfo | undefined,
    callRow: number | undefined,
    compiled: CompiledFunction | undefined,
    self: Ptr | undefined
  ): Frame {
    this.spend();
    if (this.frames.length >= LIMITS.maxCallDepth) throw new CppRuntimeError('stackOverflow');
    const frame = new Frame(this, fn, callRow, compiled?.slotCount ?? 0, self, compiled);
    this.frames.push(frame);
    return frame;
  }

  popFrame(): void {
    const frame = this.frames.pop();
    if (frame?.fn?.isAtomic) this.steps.completeAtomicCall();
  }

  /** Removes the turtles that no variable, static storage, or reachable object reaches any more. */
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const reached = new Set<Store>();
    const turtles = new Set<TurtleState>();
    const pending: Store[] = [];
    let scanned = 0;
    const visit = (value: Value | Ptr | Store | undefined): void => {
      if (value instanceof Ptr) value = value.store;
      if (!(value instanceof Store) || reached.has(value)) return;
      reached.add(value);
      pending.push(value);
    };
    for (const frame of this.frames) {
      for (const slot of frame.slots) visit(slot);
      visit(frame.self);
      visit(frame.returnValue);
      for (const { object } of frame.temporaries) visit(object);
      for (const value of frame.pending) visit(value);
    }
    for (const exception of this.handling) visit(exception.value);
    for (const global of this.globals) visit(global);
    while (pending.length > 0) {
      const store = pending.pop() as Store;
      scanned++;
      if (store.liveness !== Liveness.Alive) continue;
      if (store instanceof CObject && store.turtle) turtles.add(store.turtle);
      for (const value of childValues(store)) visit(value);
    }
    this.spend(Math.ceil(scanned / 64));
    this.world.retain((turtle) => turtles.has(turtle));
  }
}
