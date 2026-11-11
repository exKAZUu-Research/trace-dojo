// The deterministic scheduler of Python threads. CPython may switch threads every 5 ms, so the order of their steps
// differs from run to run; here a thread runs until it waits (for a lock, an event, a queue, a join, or a sleep), ends,
// or has run SLICE_OPERATIONS operations since it last started running and reaches the next iteration of a loop while
// another thread can run, which stands in for CPython's switch interval so that a thread that never waits, such as one
// spinning on a flag, cannot starve the others. The scheduler then runs the first thread, in the order they stopped
// running, whose wait is over. When no thread can run, the virtual clock jumps to the earliest timeout; when none is
// pending either, it is a deadlock.
import { sleepFor, virtualNanoseconds } from './clock';
import type { Frame } from './frame';
import { type ArgStyle, checkArgs } from './nativeArgs';
import type { Runtime } from './runtime';
import { currentRuntime } from './runtimeContext';
import type { Suspension } from './suspendingEvaluator';
import { methodDescriptorClass, nativeFunction } from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  type Kwargs,
  PyBoundMethod,
  PyBuiltinFunction,
  type PyClass,
  PyFunction,
  type PyInstance,
  type PyValue,
} from './values';

/**
 * What a thread waits for: until `ready()` holds, or until the virtual clock reaches `deadline`. A blocking operation
 * yields one each time it must wait and checks again what it waits for when resumed.
 */
export class WaitRequest {
  constructor(
    readonly ready: () => boolean,
    readonly deadline?: bigint
  ) {}
}

/** A blocking operation, which yields the waits it must make and returns its result. */
export type Blocking<T = PyValue> = Generator<WaitRequest, T, unknown>;

/** Stops a program whose threads all wait for each other, which no `except` clause may catch. */
export class DeadlockError extends Error {
  constructor() {
    super('デッドロックが起きました。すべてのスレッドやタスクが待ったままで、どれも先に進めません。');
    this.name = 'DeadlockError';
  }
}

export class PyThreadState {
  /** The frames above the module's while the thread is not running. */
  frames: Frame[] = [];
  handling: PyInstance[] = [];
  currentRow: number | undefined;
  wait: WaitRequest | undefined;
  finished = false;
  /** Whether the thread waits inside a native call, so that only returning from that call can resume it. */
  pinned = false;

  constructor(
    readonly ident: bigint,
    readonly daemon: boolean,
    /** The thread's code, or undefined for the main thread, which the module's run drives. */
    readonly run: Suspension | undefined
  ) {}
}

/** The operations a thread runs before a loop lets another thread run, about what CPython runs in its 5 ms. */
const SLICE_OPERATIONS = 100_000;

/** What a loop yields to let the other threads run, which the thread is ready to resume from at once. */
export const PREEMPTION = new WaitRequest(() => true);

const MAIN_IDENT = 8_452_461_312n;
const IDENT_STEP = 0x5_00_00n;

export class Scheduler {
  readonly main = new PyThreadState(MAIN_IDENT, false, undefined);
  current = this.main;
  /** The threads started and not finished, in the order they started. */
  readonly alive: PyThreadState[] = [this.main];
  /** How many times a thread stopped running for another, which tells a statement whether others ran during it. */
  switches = 0;
  /** The threads not running, in the order they stopped. */
  private readonly queue: PyThreadState[] = [];
  private started = 0;
  /** The operation count of the runtime when the current thread last started running. */
  private sliceStart = 0;

  constructor(private readonly runtime: Runtime) {}

  /** Starts a thread running `run`, which runs once the starting thread lets it, as CPython's `start()` waits for it. */
  start(run: Suspension, daemon: boolean): PyThreadState {
    this.started++;
    const thread = new PyThreadState(MAIN_IDENT - IDENT_STEP * BigInt(this.started) - 0x2_27_00_00n, daemon, run);
    this.alive.push(thread);
    this.queue.push(thread);
    return thread;
  }

  now(): bigint {
    return virtualNanoseconds(this.runtime);
  }

  /**
   * Waits in the current thread, on the host's stack, until `request` is over and the scheduler picks the thread
   * again, running the other threads meanwhile.
   */
  waitFor(request: WaitRequest): void {
    const me = this.current;
    me.wait = request;
    me.pinned = true;
    this.queue.push(me);
    this.save(me);
    try {
      for (;;) {
        this.runtime.spend();
        const next = this.pick(me);
        if (next === me) break;
        if (next) {
          this.runSlice(next);
          continue;
        }
        this.advanceClock(me);
      }
    } finally {
      me.pinned = false;
      me.wait = undefined;
      this.restore(me);
    }
  }

  /** Whether the running thread has used its slice and another thread can run, at a loop's next iteration. */
  shouldPreempt(): boolean {
    if (this.alive.length < 2 || this.runtime.operations - this.sliceStart < SLICE_OPERATIONS) return false;
    return this.queue.some((thread) => this.isReady(thread));
  }

  /** Whether a thread's wait is over. */
  isReady(thread: PyThreadState): boolean {
    const { wait } = thread;
    return wait === undefined || wait.ready() || (wait.deadline !== undefined && this.now() >= wait.deadline);
  }

  /** The values the threads not running keep reachable, for garbage collection. */
  *roots(): Iterable<unknown> {
    for (const thread of this.alive) {
      if (thread === this.current) continue;
      for (const frame of thread.frames) {
        yield* frame.locals.values();
        for (const cell of frame.cells.values()) yield cell.value;
        yield* frame.temporaries;
      }
      yield* thread.handling;
    }
  }

  /** The first stopped thread whose wait is over, skipping the threads waiting in native calls below `me`. */
  private pick(me: PyThreadState): PyThreadState | undefined {
    const index = this.queue.findIndex((thread) => (!thread.pinned || thread === me) && this.isReady(thread));
    if (index === -1) return undefined;
    return this.queue.splice(index, 1)[0];
  }

  private advanceClock(me: PyThreadState): void {
    let earliest: bigint | undefined;
    for (const thread of this.queue) {
      const deadline = thread.wait?.deadline;
      if ((thread.pinned && thread !== me) || deadline === undefined) continue;
      if (earliest === undefined || deadline < earliest) earliest = deadline;
    }
    if (earliest !== undefined) {
      sleepFor(this.runtime, earliest > this.now() ? earliest - this.now() : 0n);
      return;
    }
    if (this.queue.some((thread) => thread.pinned && thread !== me && this.isReady(thread))) {
      throw new UnsupportedFeatureError(
        '組み込み関数（map() や sorted() など）から呼ばれた関数の中で、ほかのスレッドを待つこと'
      );
    }
    throw new DeadlockError();
  }

  /** Runs a stopped thread until it waits or ends. */
  private runSlice(thread: PyThreadState): void {
    this.switches++;
    this.restore(thread);
    thread.wait = undefined;
    let step: IteratorResult<PyValue, PyValue>;
    try {
      step = (thread.run as Suspension).next();
    } catch (error) {
      this.finish(thread);
      throw error;
    }
    if (step.done) this.finish(thread);
    else {
      thread.wait = step.value as unknown as WaitRequest;
      this.queue.push(thread);
    }
    this.save(thread);
  }

  private finish(thread: PyThreadState): void {
    thread.finished = true;
    this.alive.splice(this.alive.indexOf(thread), 1);
  }

  private save(thread: PyThreadState): void {
    const { runtime } = this;
    thread.frames = runtime.frames.splice(1);
    thread.handling = runtime.evaluator.detachHandling(0);
    thread.currentRow = runtime.currentRow;
  }

  private restore(thread: PyThreadState): void {
    const { runtime } = this;
    this.current = thread;
    this.sliceStart = runtime.operations;
    runtime.frames.push(...thread.frames);
    thread.frames = [];
    runtime.evaluator.attachHandling(thread.handling);
    thread.handling = [];
    runtime.currentRow = thread.currentRow;
  }
}

/** The scheduler of the running program, created when it first waits or starts a thread. */
export function schedulerOf(runtime: Runtime = currentRuntime()): Scheduler {
  runtime.threads ??= new Scheduler(runtime);
  return runtime.threads;
}

/** Runs a blocking operation on the host's stack, waiting in the current thread whenever it must. */
export function runBlocking<T>(operation: Blocking<T>): T {
  for (;;) {
    const step = operation.next();
    if (step.done) return step.value;
    schedulerOf().waitFor(step.value);
  }
}

/** Whether a value a frame yielded is a wait of a blocking operation rather than a value of a generator. */
export function isWaitRequest(value: unknown): value is WaitRequest {
  return value instanceof WaitRequest;
}

/** Waits until the virtual clock has advanced by `nanoseconds`, letting the other threads run meanwhile. */
export function* sleepWait(nanoseconds: bigint): Blocking<void> {
  const scheduler = schedulerOf();
  const deadline = scheduler.now() + nanoseconds;
  // Even a zero-length sleep lets the other threads run, as it releases the GIL in CPython.
  do yield new WaitRequest(() => false, deadline);
  while (scheduler.now() < deadline);
}

type BlockingNative = (args: PyValue[], kwargs: Kwargs) => Blocking;

/** The blocking operations of builtin functions, by the function a builtin and its bound methods run. */
const blockingNatives = new WeakMap<object, BlockingNative>();

/**
 * A builtin function running a blocking operation: called where the thread can suspend, the operation's waits suspend
 * the thread; called elsewhere, such as from another builtin, the thread waits on the host's stack.
 */
export function blockingBuiltin(
  name: string,
  style: ArgStyle,
  [min, max]: [number, number],
  operation: BlockingNative,
  keywords?: readonly string[]
): PyBuiltinFunction {
  const spec = { qualified: name, min, max, style, keywords };
  const checked: BlockingNative = (args, kwargs) => {
    checkArgs(spec, args, kwargs);
    return operation(args, kwargs);
  };
  const fn = nativeFunction(name, (args, kwargs) => runBlocking(checked(args, kwargs)));
  blockingNatives.set(fn.run, checked);
  return fn;
}

/** Adds a method running a blocking operation to a class, which receives the instance as its first argument. */
export function blockingMethod(
  cls: PyClass,
  name: string,
  style: ArgStyle,
  [min, max]: [number, number],
  operation: (self: PyValue, args: PyValue[], kwargs: Kwargs) => Blocking,
  keywords?: readonly string[]
): void {
  const spec = { qualified: `${cls.name}.${name}`, short: name, min, max, style, keywords };
  const checked: BlockingNative = ([self, ...args], kwargs) => {
    checkArgs(spec, args, kwargs);
    return operation(self, args, kwargs);
  };
  const fn = new PyBuiltinFunction(
    methodDescriptorClass,
    name,
    (args, kwargs) => runBlocking(checked(args, kwargs)),
    undefined,
    'method',
    cls.name
  );
  blockingNatives.set(fn.run, checked);
  cls.dict.set(name, fn);
}

/**
 * Calls a value so that the waits of blocking operations it makes suspend the calling thread: a function of the
 * program runs its frame step by step, and a blocking builtin runs its operation. Returns undefined for a value that
 * runs synchronously, such as a class or another builtin.
 */
export function suspendingCall(callee: PyValue, args: PyValue[], kwargs: Kwargs): Suspension | undefined {
  if (callee instanceof PyBoundMethod) return suspendingCall(callee.fn, [callee.self, ...args], kwargs);
  if (callee instanceof PyBuiltinFunction) {
    const blocking = blockingNatives.get(callee.run);
    if (!blocking) return undefined;
    return blocking(callee.self === undefined ? args : [callee.self, ...args], kwargs) as unknown as Suspension;
  }
  if (callee instanceof PyFunction && !callee.def.scope.isGenerator && !callee.def.scope.isAsync) {
    return callFunctionSuspending(callee, args, kwargs);
  }
  return undefined;
}

function* callFunctionSuspending(fn: PyFunction, args: PyValue[], kwargs: Kwargs): Suspension {
  const runtime = currentRuntime();
  const frame = runtime.newFunctionFrame(fn, args, kwargs);
  runtime.pushFrame(frame);
  try {
    return yield* runtime.evaluator.runGenerator(fn, frame);
  } finally {
    runtime.popFrame();
  }
}
