import type { CsThrow } from './runtime';
import type { NamedType } from './types';
import { CsObject, type Value } from './values';

/** An exception that left an `async void` method, which reaches no caller and ends the process. */
export class UnhandledAsyncException extends Error {
  constructor(readonly thrown: CsThrow) {
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

/** The state of a Task: pending until it completes with a result or faults with exceptions. */
export class TaskState {
  status: 'pending' | 'completed' | 'faulted' = 'pending';
  result: Value;
  /** The exceptions of a faulted task: its own, or for `WhenAll` each faulted task's in the order they faulted. */
  exceptions: CsThrow[] = [];
  /** The Task object, which `WhenAny` returns. */
  object: CsObject | undefined;
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

  /**
   * Runs the continuations in the order they were registered, on the thread that completes the task, as .NET runs an
   * `await`'s continuation inline when nothing asks it to run asynchronously.
   */
  private runContinuations(): void {
    const continuations = this.continuations;
    this.continuations = [];
    for (const run of continuations) run();
  }
}

interface Timer {
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

  delay(milliseconds: number, run: () => void): void {
    this.timers.push({ due: this.now + milliseconds, order: this.timerCount++, run });
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
