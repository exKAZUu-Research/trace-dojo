import { CsThrow, type ExceptionState, type Runtime } from './runtime';
import type { NamedType } from './types';
import { CsObject, type Value } from './values';

/** An exception that left an `async void` method, or another one that reaches no caller, and ends the process. */
export class UnhandledAsyncException extends Error {
  constructor(
    readonly thrown: CsThrow,
    /** Whether .NET throws it again where it caught it, which splits its stack trace. */
    readonly isRethrown = false
  ) {
    super('An exception left an async void method');
  }
}

/** The Task object of a task's state, which the state remembers for `WhenAny`. */
export function taskObject(type: NamedType, state: TaskState): CsObject {
  if (state.object) return state.object;
  const object = new CsObject(type, []);
  object.native = state;
  state.object = object;
  return object;
}

/** A wait that no task, queued work, or timer can ever end, which stops the run as a runtime error. */
export class DeadlockError extends Error {
  constructor() {
    super('デッドロックが起きました。すべてのスレッドやタスクが待ったままで、どれも先に進めません。');
    this.name = 'DeadlockError';
  }
}

/** The state of a Task: pending until it completes with a result, faults with exceptions, or is canceled. */
export class TaskState {
  status: 'pending' | 'completed' | 'faulted' | 'canceled' = 'pending';
  /** The `TaskStatus` a pending task shows: `WaitingForActivation`, or `Created`, `WaitingToRun`, `Running` for work. */
  pendingStatus: number = TASK_STATUS.waitingForActivation;
  result: Value;
  /** The exceptions of a faulted task: its own, or for `WhenAll` each faulted task's in the order they faulted. */
  exceptions: CsThrow[] = [];
  /** The OperationCanceledException that canceled the task, which `await` rethrows; without one it makes its own. */
  cancellation: CsThrow | undefined;
  /** The source of the CancellationToken the task was created with or canceled by, if any. */
  token: CsObject | undefined;
  /** The Task object, which `WhenAny` returns. */
  object: CsObject | undefined;
  /** The state object given to the task's work, which `AsyncState` returns. */
  asyncState: Value;
  /**
   * Where the continuations run when the task ends: on the thread that ends it, unless this queues them, as .NET
   * queues those of a `Task.Delay` that its token cancels.
   */
  runContinuation: ((run: () => void) => void) | undefined;
  private continuations: (() => void)[] = [];

  constructor(readonly id: number) {}

  /** The exception that `await` and `GetResult` throw: the first one. */
  get firstThrown(): CsThrow {
    return this.exceptions[0];
  }

  get isDone(): boolean {
    return this.status !== 'pending';
  }

  /** Runs a continuation when the task is done: at once when it is, or when it completes or faults. */
  whenDone(run: () => void): void {
    if (this.isDone) run();
    else this.continuations.push(run);
  }

  complete(result: Value): boolean {
    if (this.isDone) return false;
    this.status = 'completed';
    this.result = result;
    this.runContinuations();
    return true;
  }

  fault(exceptions: CsThrow[]): boolean {
    if (this.isDone) return false;
    this.status = 'faulted';
    this.exceptions = exceptions;
    this.runContinuations();
    return true;
  }

  cancel(token: CsObject | undefined, cancellation?: CsThrow): boolean {
    if (this.isDone) return false;
    this.status = 'canceled';
    this.token = token;
    this.cancellation = cancellation;
    this.runContinuations();
    return true;
  }

  /** Settles the task as another one ended, as a task that wraps or unwraps it does. */
  settleAs(other: TaskState): boolean {
    if (other.status === 'faulted') return this.fault(other.exceptions);
    if (other.status === 'canceled') return this.cancel(other.token, other.cancellation);
    return this.complete(other.result);
  }

  /**
   * Runs the continuations in the order they were registered, on the thread that completes the task, as .NET runs an
   * `await`'s continuation inline when nothing asks it to run asynchronously.
   */
  private runContinuations(): void {
    const continuations = this.continuations;
    this.continuations = [];
    for (const run of continuations) {
      if (this.runContinuation) this.runContinuation(run);
      else run();
    }
  }
}

/** The values of .NET's `TaskStatus`. */
export const TASK_STATUS = {
  created: 0,
  waitingForActivation: 1,
  waitingToRun: 2,
  running: 3,
  ranToCompletion: 5,
  canceled: 6,
  faulted: 7,
} as const;

/** The state of an OperationCanceledException: the source of its token, and the task of a TaskCanceledException. */
export interface CancellationExceptionState extends ExceptionState {
  token?: CsObject | undefined;
  task?: CsObject | undefined;
}

/** Whether an exception is an OperationCanceledException, which cancels an async method's task instead of faulting it. */
export function isCancellationException(exception: CsObject): boolean {
  for (let type: NamedType | undefined = exception.type; type; type = type.symbol.baseType)
    if (type.symbol.fullName === 'System.OperationCanceledException') return true;
  return false;
}

/** The token source of an OperationCanceledException. */
export function cancellationTokenOf(exception: CsObject): CsObject | undefined {
  return (exception.native as CancellationExceptionState).token;
}

/** A new TaskCanceledException for a canceled task, which `Wait()` wraps and an `await` without a cause throws. */
export function taskCanceledException(runtime: Runtime, state: TaskState): CsThrow {
  const exception = runtime.createException('System.Threading.Tasks.TaskCanceledException', undefined);
  const native = exception.native as CancellationExceptionState;
  native.token = state.token;
  native.task = state.object;
  return new CsThrow(exception);
}

/** What `await` and `GetResult()` throw for a task that did not complete: its first exception, or its cancellation. */
export function awaitedFailure(runtime: Runtime, state: TaskState): CsThrow | undefined {
  if (state.status === 'faulted') return state.firstThrown;
  if (state.status === 'canceled') return state.cancellation ?? taskCanceledException(runtime, state);
  return undefined;
}

/** What `Wait()` and `Result` wrap in an AggregateException: a faulted task's exceptions, or a new cancellation. */
export function blockingFailures(runtime: Runtime, state: TaskState): CsThrow[] {
  if (state.status === 'canceled') return [taskCanceledException(runtime, state)];
  return state.exceptions;
}

export interface Timer {
  due: number;
  order: number;
  run: () => void;
}

/**
 * The deterministic scheduler of a run's tasks. .NET runs `Task.Run` work and the continuations after a `Task.Delay`
 * on thread-pool threads at once; here there is one thread, so queued work runs in the order it was queued whenever
 * the running code waits (an `await` of an unfinished task, `Wait()`, `Result`) or ends, and timers fire in the order of
 * a virtual clock, which jumps to the earliest one when nothing else can run. When neither can run, it is a deadlock.
 */
export class TaskScheduler {
  /** The virtual time in milliseconds, which only timers advance. */
  now = 0;
  private readonly ready: (() => void)[] = [];
  private readonly timers: Timer[] = [];
  private timerCount = 0;
  private taskCount = 0;

  constructor(private readonly spend: () => void) {}

  /** A new task's state, numbered as .NET numbers tasks from 1. */
  newTask(): TaskState {
    return new TaskState(++this.taskCount);
  }

  queue(run: () => void): void {
    this.ready.push(run);
  }

  delay(milliseconds: number, run: () => void): Timer {
    const timer = { due: this.now + milliseconds, order: this.timerCount++, run };
    this.timers.push(timer);
    return timer;
  }

  /** Removes a timer that has not fired, so that it no longer moves the clock. */
  cancelTimer(timer: Timer): void {
    const index = this.timers.indexOf(timer);
    if (index !== -1) this.timers.splice(index, 1);
  }

  /**
   * Blocks for a time on the virtual clock, as `Thread.Sleep` does: the queued work and the timers due by then run,
   * as other threads would meanwhile, and the clock then stands at the end of the sleep without waiting for it.
   */
  sleep(milliseconds: number): void {
    let isOver = false;
    this.delay(milliseconds, () => (isOver = true));
    this.runUntil(() => isOver);
  }

  /**
   * The clock that Stopwatch, Environment.TickCount, and DateTime.Now read, in milliseconds: the real time plus the
   * virtual time that sleeps and timers skipped, so that it advances at least as far as a program waited.
   */
  clock(): number {
    return performance.now() + this.now;
  }

  /** Runs queued work and timers until `isDone` holds, as a thread blocked on a task waits for the others. */
  runUntil(isDone: () => boolean): void {
    while (!isDone()) {
      this.spend();
      const next = this.ready.shift();
      if (next) {
        next();
        continue;
      }
      if (this.timers.length === 0) throw new DeadlockError();
      let earliest = 0;
      for (const [index, timer] of this.timers.entries()) {
        const best = this.timers[earliest];
        if (timer.due < best.due || (timer.due === best.due && timer.order < best.order)) earliest = index;
      }
      const [timer] = this.timers.splice(earliest, 1);
      this.now = Math.max(this.now, timer.due);
      timer.run();
    }
  }
}
