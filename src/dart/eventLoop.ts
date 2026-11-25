import { scopedMemberName } from './classes';
import type { Runtime } from './runtime';
import { type DartObject, NO_ARGUMENTS, type Value } from './values';

interface TimerEntry {
  timer: DartObject;
  /** The time, on the run's clock, when the timer is due. */
  wakeup: number;
  /** The order of timers due at the same time: the order they were scheduled in. */
  id: number;
}

/**
 * The VM's event loop for one run: the microtask queue's pending callback and the timers, on a clock that jumps to
 * each timer's due time instead of waiting for it, so that a run takes no real time and its order never depends on
 * how fast the host is. Timers fire in the order of their due times, and timers due at once in the order they were
 * scheduled, as the VM orders its timer heap.
 */
export class EventLoop {
  /** Milliseconds since the run started, which advance only when a timer fires or the program sleeps. */
  now = 0;
  /** The callback dart:async asked to run once the current event ends: the loop that drains its microtasks. */
  private immediate: Value | undefined;
  private readonly timers: TimerEntry[] = [];
  private readonly entries = new WeakMap<DartObject, TimerEntry>();
  private nextId = 0;

  constructor(private readonly runtime: Runtime) {
    runtime.roots.add(() => this.values());
  }

  scheduleImmediate(callback: Value): void {
    this.immediate = callback;
  }

  /** Schedules a timer due `delay` milliseconds from now. */
  schedule(timer: DartObject, delay: number): void {
    this.add({ timer, wakeup: this.now + delay, id: this.nextId++ });
  }

  /** Schedules a periodic timer's next tick, `period` milliseconds after the tick that just fired. */
  reschedule(timer: DartObject, period: number): void {
    const previous = this.entries.get(timer);
    const wakeup = period > 0 && previous ? previous.wakeup + period : this.now;
    this.add({ timer, wakeup, id: this.nextId++ });
  }

  /**
   * Moves the due time of a periodic tick that fires more than a period late, as after `sleep`, past the ticks it
   * missed, giving how many it missed, as the VM's `_runTimers` does before the tick's callback.
   */
  skipMissedTicks(timer: DartObject, period: number): number {
    const entry = this.entries.get(timer);
    const overdue = entry ? this.now - entry.wakeup : 0;
    if (!entry || overdue <= period) return 0;
    const missed = Math.floor(overdue / period);
    entry.wakeup += missed * period;
    return missed;
  }

  unschedule(timer: DartObject): void {
    const entry = this.entries.get(timer);
    const index = entry ? this.timers.indexOf(entry) : -1;
    if (index !== -1) this.timers.splice(index, 1);
  }

  /** Whether any callback ran after the entry point returned. */
  hasRun = false;

  /** Runs the microtasks, then each timer as it comes due with the microtasks it schedules, until none remain. */
  run(): void {
    this.hasRun = this.immediate !== undefined || this.timers.length > 0;
    this.runMicrotasks();
    for (let entry = this.timers.shift(); entry; entry = this.timers.shift()) {
      this.now = Math.max(this.now, entry.wakeup);
      this.runtime.spend();
      this.runtime.invoke(entry.timer, scopedMemberName('_run', 'dart:async'), NO_ARGUMENTS, [], undefined);
      this.runMicrotasks();
    }
  }

  /** When the run started on the host's monotonic clock, in milliseconds. */
  private readonly realStart = performance.now();

  /**
   * Nanoseconds since the run started, as `Stopwatch` reads them: the time the host took plus the time the run's
   * clock skipped to fire timers and to sleep.
   */
  elapsedNanoseconds(): bigint {
    return BigInt(Math.round((performance.now() - this.realStart + this.now) * 1_000_000));
  }

  /** Microseconds since the Unix epoch, as `DateTime.now` reads them: the host's time plus the time the run skipped. */
  currentMicroseconds(): bigint {
    return BigInt(Math.round((performance.timeOrigin + performance.now() + this.now) * 1000));
  }

  /** Advances the clock, as `sleep` does while the VM blocks the isolate. */
  advance(milliseconds: number): void {
    this.now += Math.max(milliseconds, 0);
  }

  runMicrotasks(): void {
    for (let callback = this.immediate; callback !== undefined; callback = this.immediate) {
      this.immediate = undefined;
      this.runtime.callValue(callback, NO_ARGUMENTS, [], undefined);
    }
  }

  private add(entry: TimerEntry): void {
    this.entries.set(entry.timer, entry);
    let index = this.timers.length;
    while (index > 0 && compareEntries(this.timers[index - 1], entry) > 0) index--;
    this.timers.splice(index, 0, entry);
  }

  private *values(): Iterable<Value> {
    yield this.immediate;
    for (const entry of this.timers) yield entry.timer;
  }
}

function compareEntries(a: TimerEntry, b: TimerEntry): number {
  return a.wakeup - b.wakeup || a.id - b.id;
}
