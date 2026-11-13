import { LIMITS } from '../interpreter/limits';
import { Awaiting, type BodyResult, type Resume, type Steps, type Suspension } from './generators';
import { DONE, type ValueIterator } from './iteration';
import type { RealmBuilder } from './realm';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Frame, Runtime } from './runtime';
import { isCallable, isObject, type JsArray, type JsFunction, JsObject, JsThrow, type Value } from './values';

/** What a settled promise runs for each of its handlers, with the values that must stay reachable until then. */
interface Reaction {
  onFulfilled: (value: Value) => void;
  onRejected: (reason: Value) => void;
  roots: unknown[];
}

export interface PromiseState {
  status: 'pending' | 'fulfilled' | 'rejected';
  result: Value;
  reactions: Reaction[];
  /** Whether a handler was ever added, which keeps a rejection from ending the program as unhandled. */
  isHandled: boolean;
}

/** A job of the event loop: a promise reaction (a microtask) or a timer callback, with what it keeps reachable. */
export interface Job {
  run: () => void;
  roots: unknown[];
  /** What the job keeps reachable only until it starts, such as the result it hands to its continuation. */
  queuedRoots?: unknown[];
}

interface Timer extends Job {
  id: number;
  /** The clock's whole milliseconds when the timer was scheduled, which with its list's delay gives when it is due. */
  start: number;
  /** Whether a `setInterval` timer runs again after each run until it is cleared. */
  repeats: boolean;
}

/** Node.js's list of the timers of one delay, which run in the order they were scheduled. */
interface TimerList {
  delay: number;
  timers: Timer[];
  /** When the list's first timer is due, by which the lists run. */
  expiry: number;
  /** Orders lists due at the same time, as their creation or last reschedule does. */
  order: number;
}

/**
 * How a read of the clock moves it forward. A read that polls it, as a busy wait does (see Runtime.pollsClock), moves it
 * by the operations spent since the previous read at OPERATIONS_PER_MILLISECOND, so a busy wait as long as a run's time
 * limit spends at most a fifth of the operation budget whatever its body costs. Any other read, such as a timestamp of
 * a loop's rounds, moves it by CLOCK_STEP alone: the interpreter's operations are far slower than Node.js's, where such
 * computation takes next to no time, and a timestamp after it must not push timers scheduled after it past earlier ones.
 */
const OPERATIONS_PER_MILLISECOND = LIMITS.maxOperations / (LIMITS.maxMilliseconds * 5);
const CLOCK_STEP = 10 / OPERATIONS_PER_MILLISECOND;

/**
 * The event loop of one run: the microtasks promises queue and the timers `setTimeout` schedules, which run after the
 * program's statements on a simulated clock, so a program never waits for real time. Timers run as Node.js's
 * lib/internal/timers.js runs them: one list per delay, the lists in the order they fall due, and each list's due timers
 * in the order they were scheduled. The clock jumps to the first list due when the loop would wait and otherwise
 * advances only when the program reads it, as the constants above say.
 */
export class EventLoop {
  private readonly microtasks: Job[] = [];
  private readonly lists = new Map<number, TimerList>();
  private nextListOrder = 0;
  /** The jobs running now, innermost last. */
  private readonly running: Job[] = [];
  private readonly rejections = new Set<JsObject>();
  /** The milliseconds the simulated clock has advanced since the program started, in fractions of a millisecond. */
  private now = 0;
  /** The operations spent when the clock last moved, by a read or a jump to a timer. */
  private spentAtNow = 0;
  /** The timer whose callback is running, which clearing stops from running again. */
  private runningTimer: Timer | undefined;
  private nextTimerId = 1;
  /** The timers by their ids, which clearing looks up. */
  private readonly timerLists = new Map<number, TimerList>();

  constructor(private readonly runtime: Runtime) {}

  /** Reads the clock for `Date`, which moves it forward as the constants above say: the whole milliseconds so far. */
  readClock(): number {
    const { runtime } = this;
    const { spent } = runtime.budget;
    this.now += runtime.pollsClock()
      ? Math.max(CLOCK_STEP, (spent - this.spentAtNow) / OPERATIONS_PER_MILLISECOND)
      : CLOCK_STEP;
    this.spentAtNow = spent;
    return Math.floor(this.now);
  }

  enqueue(job: Job): void {
    this.microtasks.push(job);
  }

  addTimer(delay: number, job: Job, repeats: boolean): number {
    const id = this.nextTimerId++;
    this.insert({ ...job, id, start: Math.floor(this.now), repeats }, Math.max(1, delay));
    return id;
  }

  clearTimer(id: Value): void {
    if (typeof id !== 'number') return;
    const list = this.timerLists.get(id);
    if (list) {
      const index = list.timers.findIndex((timer) => timer.id === id);
      if (index !== -1) list.timers.splice(index, 1);
      if (list.timers.length === 0) this.lists.delete(list.delay);
      this.timerLists.delete(id);
    }
    if (this.runningTimer?.id === id) this.runningTimer = undefined;
  }

  /** Appends a timer to its delay's list, which starts due when the timer is if it is new. */
  private insert(timer: Timer, delay: number): void {
    let list = this.lists.get(delay);
    if (!list) {
      list = { delay, timers: [], expiry: timer.start + delay, order: this.nextListOrder++ };
      this.lists.set(delay, list);
    }
    list.timers.push(timer);
    this.timerLists.set(timer.id, list);
  }

  trackRejection(promise: JsObject): void {
    this.rejections.add(promise);
  }

  untrackRejection(promise: JsObject): void {
    this.rejections.delete(promise);
  }

  /** Runs the queued jobs until none is left, ending with the first exception a job throws or leaves unhandled. */
  run(): void {
    for (;;) {
      this.drainMicrotasks();
      const first = this.firstList();
      if (!first) return;
      // The loop waits for the first list due, unless the program's polling already took the clock past it.
      if (first.expiry > this.now) {
        this.now = first.expiry;
        this.spentAtNow = this.runtime.budget.spent;
      }
      this.processTimers(Math.floor(this.now));
    }
  }

  /** Node.js's processTimers: runs the lists due by `now`, the clock as the timer phase began. */
  private processTimers(now: number): void {
    // Microtasks run between lists and between timers, and may clear or schedule timers, so each step looks again.
    for (let ranList = false; ; ranList = true) {
      if (ranList) this.drainMicrotasks();
      const list = this.firstList();
      if (!list || list.expiry > now) return;
      this.listOnTimeout(list, now);
    }
  }

  /** Node.js's listOnTimeout: runs a list's due timers in order, and reschedules the list for the first one not due. */
  private listOnTimeout(list: TimerList, now: number): void {
    for (let ranTimer = false; ; ranTimer = true) {
      if (ranTimer) this.drainMicrotasks();
      const timer = list.timers.at(0);
      if (!timer) break;
      if (now - timer.start < list.delay) {
        list.expiry = Math.max(timer.start + list.delay, now + 1);
        list.order = this.nextListOrder++;
        return;
      }
      list.timers.shift();
      this.timerLists.delete(timer.id);
      // A repeat is due a delay after its run began, however long its callback takes, as Node.js schedules it.
      const started = Math.floor(this.now);
      this.runningTimer = timer;
      this.runJob(timer);
      if (this.runningTimer && timer.repeats) this.insert({ ...timer, start: started }, list.delay);
      this.runningTimer = undefined;
    }
    if (this.lists.get(list.delay) === list && list.timers.length === 0) this.lists.delete(list.delay);
  }

  /**
   * Everything the pending and running jobs keep reachable, and the unhandled rejections the loop will report, which
   * garbage collection must see.
   */
  roots(): unknown[] {
    return [
      ...this.rejections,
      ...this.running.flatMap((job) => job.roots),
      ...[...this.microtasks, ...[...this.lists.values()].flatMap((list) => list.timers)].flatMap((job) => [
        ...(job.queuedRoots ?? []),
        ...job.roots,
      ]),
    ];
  }

  /** Runs a job, whose roots stay reachable while it runs, since what it resumes may depend on them. */
  private runJob(job: Job): void {
    this.running.push(job);
    try {
      job.run();
    } finally {
      this.running.pop();
    }
  }

  private drainMicrotasks(): void {
    const { runtime } = this;
    for (let job = this.microtasks.shift(); job; job = this.microtasks.shift()) {
      runtime.spend();
      this.runJob(job);
    }
    // A rejection without a handler once the microtasks are done ends the program, as in Node.js.
    for (const promise of this.rejections) throw new JsThrow((promise.promise as PromiseState).result);
  }

  /** The list due first, the earliest created among lists due together. */
  private firstList(): TimerList | undefined {
    let first: TimerList | undefined;
    for (const list of this.lists.values()) {
      if (!first || list.expiry < first.expiry || (list.expiry === first.expiry && list.order < first.order))
        first = list;
    }
    return first;
  }
}

// Promise operations ------------------------------------------------------------------------------------------------

export function newPromise(runtime: Runtime, prototype = runtime.realm.promisePrototype): JsObject {
  const promise = runtime.newObject(prototype);
  promise.promise = { status: 'pending', result: undefined, reactions: [], isHandled: false };
  return promise;
}

function stateOf(promise: JsObject): PromiseState {
  return promise.promise as PromiseState;
}

/** Resolves a promise as its resolve function does: with a value, or with the eventual result of a thenable. */
export function resolvePromise(runtime: Runtime, promise: JsObject, resolution: Value): void {
  if (stateOf(promise).status !== 'pending') return;
  if (resolution === promise) {
    rejectPromise(runtime, promise, runtime.newError('TypeError', 'Chaining cycle detected for promise #<Promise>'));
    return;
  }
  if (!isObject(resolution)) {
    settle(runtime, promise, 'fulfilled', resolution);
    return;
  }
  let then: Value;
  try {
    then = runtime.get(resolution, 'then');
  } catch (error) {
    if (!(error instanceof JsThrow)) throw error;
    rejectPromise(runtime, promise, error.value);
    return;
  }
  if (!isCallable(then)) {
    settle(runtime, promise, 'fulfilled', resolution);
    return;
  }
  // A thenable is followed in a job of its own, so its `then` runs after the current code, as JavaScript requires.
  runtime.eventLoop.enqueue({
    run: () => {
      const { resolve, reject } = resolvingFunctions(runtime, promise);
      try {
        runtime.call(then, resolution, [resolve, reject]);
      } catch (error) {
        if (!(error instanceof JsThrow)) throw error;
        runtime.call(reject, undefined, [error.value]);
      }
    },
    roots: [promise, resolution, then],
  });
}

export function rejectPromise(runtime: Runtime, promise: JsObject, reason: Value): void {
  if (stateOf(promise).status !== 'pending') return;
  settle(runtime, promise, 'rejected', reason);
}

function settle(runtime: Runtime, promise: JsObject, status: 'fulfilled' | 'rejected', result: Value): void {
  const state = stateOf(promise);
  state.status = status;
  state.result = result;
  for (const reaction of state.reactions) queueReaction(runtime, state, reaction);
  state.reactions = [];
  if (status === 'rejected' && !state.isHandled) runtime.eventLoop.trackRejection(promise);
}

function queueReaction(runtime: Runtime, state: PromiseState, reaction: Reaction): void {
  const { result } = state;
  const run = state.status === 'fulfilled' ? reaction.onFulfilled : reaction.onRejected;
  runtime.eventLoop.enqueue({ run: () => run(result), roots: reaction.roots, queuedRoots: [result] });
}

/** Adds handlers to a promise, which run in a microtask once it settles, as `then` does without its new promise. */
export function performThen(runtime: Runtime, promise: JsObject, reaction: Reaction): void {
  const state = stateOf(promise);
  if (!state.isHandled && state.status === 'rejected') runtime.eventLoop.untrackRejection(promise);
  state.isHandled = true;
  if (state.status === 'pending') state.reactions.push(reaction);
  else queueReaction(runtime, state, reaction);
}

/** The resolve and reject functions passed to an executor, of which only the first call has an effect. */
export function resolvingFunctions(runtime: Runtime, promise: JsObject): { resolve: JsFunction; reject: JsFunction } {
  let isResolved = false;
  const once =
    (settleWith: (value: Value) => void) =>
    ({ args }: { args: Value[] }): Value => {
      if (isResolved) return undefined;
      isResolved = true;
      settleWith(args[0]);
      return undefined;
    };
  const resolve = runtime.newNativeFunction(
    '',
    1,
    once((value) => resolvePromise(runtime, promise, value))
  );
  const reject = runtime.newNativeFunction(
    '',
    1,
    once((reason) => rejectPromise(runtime, promise, reason))
  );
  resolve.captured.push(promise);
  reject.captured.push(promise);
  return { resolve, reject };
}

/** The promise `Promise.resolve(value)` returns: the value itself when it is already a promise. */
export function promiseResolve(runtime: Runtime, value: Value): JsObject {
  if (value instanceof JsObject && value.promise && value.proto === runtime.realm.promisePrototype) return value;
  const promise = newPromise(runtime);
  resolvePromise(runtime, promise, value);
  return promise;
}

/** Calls a handler of `then`, settling the promise `then` returned with its result. */
function handlerReaction(runtime: Runtime, derived: JsObject, handler: Value, isRejection: boolean) {
  return (value: Value): void => {
    if (!isCallable(handler)) {
      if (isRejection) rejectPromise(runtime, derived, value);
      else resolvePromise(runtime, derived, value);
      return;
    }
    let result: Value;
    try {
      result = runtime.call(handler, undefined, [value]);
    } catch (error) {
      if (!(error instanceof JsThrow)) throw error;
      rejectPromise(runtime, derived, error.value);
      return;
    }
    resolvePromise(runtime, derived, result);
  };
}

export function promiseThen(runtime: Runtime, promise: JsObject, onFulfilled: Value, onRejected: Value): JsObject {
  const derived = newPromise(runtime);
  performThen(runtime, promise, {
    onFulfilled: handlerReaction(runtime, derived, onFulfilled, false),
    onRejected: handlerReaction(runtime, derived, onRejected, true),
    roots: [derived, onFulfilled, onRejected],
  });
  return derived;
}

// Async functions ---------------------------------------------------------------------------------------------------

/**
 * Starts the body of an async function, which runs until its first `await` now and resumes in a microtask once the
 * awaited value settles, returning the promise of its result.
 */
export function startAsyncFunction(runtime: Runtime, frame: Frame, body: Steps<BodyResult>): JsObject {
  const promise = newPromise(runtime);
  const advance = (resume: Resume): void => {
    let result: IteratorResult<Suspension, BodyResult>;
    try {
      result = body.next(resume);
    } catch (error) {
      if (!(error instanceof JsThrow)) throw error;
      rejectPromise(runtime, promise, error.value);
      return;
    }
    if (result.done) {
      resolvePromise(runtime, promise, result.value?.kind === 'return' ? result.value.value : undefined);
      return;
    }
    // An async function's body suspends only at an `await`.
    if (!(result.value instanceof Awaiting)) throw new Error('An async function body suspended without an await');
    const awaited = result.value.value;
    awaitValue(runtime, awaited, [promise, frameRoots(frame)], (next) => inFrame(runtime, frame, () => advance(next)));
  };
  advance({ kind: 'next', value: undefined });
  return promise;
}

/** Waits for a value as `await` does, continuing with its result, or with its reason to throw, in a microtask. */
export function awaitValue(
  runtime: Runtime,
  value: Value,
  roots: unknown[],
  continueWith: (resume: Resume) => void
): void {
  performThen(runtime, promiseResolve(runtime, value), {
    onFulfilled: (result) => continueWith({ kind: 'next', value: result }),
    onRejected: (reason) => continueWith({ kind: 'throw', value: reason }),
    roots,
  });
}

/**
 * The roots of a suspended body's frame, read when garbage collection runs rather than copied at the `await`, so
 * that what the resumed body has since let go of is not kept.
 */
export function frameRoots(frame: Frame): () => unknown[] {
  return () => frame.reachableValues();
}

/** Runs `run` with a suspended body's frame pushed again. */
export function inFrame(runtime: Runtime, frame: Frame, run: () => void): void {
  runtime.resumeFrame(frame);
  try {
    run();
  } finally {
    runtime.popFrame();
  }
}

// Builtins ----------------------------------------------------------------------------------------------------------

export function definePromiseBuiltins(builder: RealmBuilder): void {
  const { promisePrototype } = builder.realm;
  const promiseConstructor = builder.defineClass('Promise', 1, promisePrototype, ({ runtime, args, newTarget }) => {
    if (!newTarget) return runtime.throwError('TypeError', "Promise constructor cannot be invoked without 'new'");
    const [executor] = args;
    if (!isCallable(executor)) {
      return runtime.throwError('TypeError', `Promise resolver ${runtime.describe(executor)} is not a function`);
    }
    const promise = newPromise(runtime, runtime.prototypeFor(newTarget, promisePrototype));
    const { resolve, reject } = resolvingFunctions(runtime, promise);
    try {
      runtime.call(executor, undefined, [resolve, reject]);
    } catch (error) {
      if (!(error instanceof JsThrow)) throw error;
      runtime.call(reject, undefined, [error.value]);
    }
    return promise;
  });
  builder.constant(promisePrototype, WELL_KNOWN_SYMBOLS.toStringTag, 'Promise');
  builder.method(promisePrototype, 'then', 2, ({ runtime, thisValue, args }) =>
    promiseThen(runtime, thisPromise(runtime, thisValue, 'then'), args[0], args[1])
  );
  builder.method(promisePrototype, 'catch', 1, ({ runtime, thisValue, args }) =>
    runtime.call(runtime.get(thisValue, 'then'), thisValue, [undefined, args[0]])
  );
  builder.method(promisePrototype, 'finally', 1, ({ runtime, thisValue, args }) => {
    const [onFinally] = args;
    if (!isCallable(onFinally)) return runtime.call(runtime.get(thisValue, 'then'), thisValue, [onFinally, onFinally]);
    // Each continuation captures the value or reason it delays, which stays reachable until it runs.
    const continuation = (run: () => Value, delayed: Value): JsFunction => {
      const fn = runtime.newNativeFunction('', 0, run);
      fn.captured.push(delayed);
      return fn;
    };
    const thenFinally = runtime.newNativeFunction('', 1, ({ args: [value] }) =>
      promiseThen(
        runtime,
        promiseResolve(runtime, runtime.call(onFinally, undefined, [])),
        continuation(() => value, value),
        undefined
      )
    );
    const catchFinally = runtime.newNativeFunction('', 1, ({ args: [reason] }) =>
      promiseThen(
        runtime,
        promiseResolve(runtime, runtime.call(onFinally, undefined, [])),
        continuation(() => {
          throw new JsThrow(reason);
        }, reason),
        undefined
      )
    );
    thenFinally.captured.push(onFinally);
    catchFinally.captured.push(onFinally);
    return runtime.call(runtime.get(thisValue, 'then'), thisValue, [thenFinally, catchFinally]);
  });
  builder.method(promiseConstructor, 'resolve', 1, ({ runtime, args }) => promiseResolve(runtime, args[0]));
  builder.method(promiseConstructor, 'reject', 1, ({ runtime, args }) => {
    const promise = newPromise(runtime);
    rejectPromise(runtime, promise, args[0]);
    return promise;
  });
  defineCombinators(builder, promiseConstructor);
  defineTimers(builder);
}

function thisPromise(runtime: Runtime, value: Value, name: string): JsObject {
  if (value instanceof JsObject && value.promise) return value;
  return runtime.throwError(
    'TypeError',
    `Method Promise.prototype.${name} called on incompatible receiver ${runtime.describe(value)}`
  );
}

/** Defines `Promise.all`, `allSettled`, `race`, and `any`, which settle as their inputs settle. */
function defineCombinators(builder: RealmBuilder, promiseConstructor: JsFunction): void {
  builder.method(promiseConstructor, 'all', 1, ({ runtime, args }) =>
    combine(runtime, args[0], {
      onFulfilled: (state, index, value, settled) => {
        state.items.elements[index] = value;
        settled();
      },
      onRejected: (state, _, reason) => rejectPromise(runtime, state.result, reason),
      onComplete: resolveWithItems(runtime),
    })
  );
  builder.method(promiseConstructor, 'allSettled', 1, ({ runtime, args }) =>
    combine(runtime, args[0], {
      onFulfilled: settledEntry(runtime, 'fulfilled', 'value'),
      onRejected: settledEntry(runtime, 'rejected', 'reason'),
      onComplete: resolveWithItems(runtime),
    })
  );
  builder.method(promiseConstructor, 'race', 1, ({ runtime, args }) =>
    combine(runtime, args[0], {
      onFulfilled: (state, _, value) => resolvePromise(runtime, state.result, value),
      onRejected: (state, _, reason) => rejectPromise(runtime, state.result, reason),
    })
  );
  builder.method(promiseConstructor, 'any', 1, ({ runtime, args }) =>
    combine(runtime, args[0], {
      onFulfilled: (state, _, value) => resolvePromise(runtime, state.result, value),
      onRejected: (state, index, reason, settled) => {
        state.items.elements[index] = reason;
        settled();
      },
      onComplete: (state) => {
        const error = runtime.newError('AggregateError', 'All promises were rejected');
        runtime.defineProperty(error, 'errors', {
          value: runtime.newArray([...state.items.elements]),
          writable: true,
          enumerable: false,
          configurable: true,
        });
        rejectPromise(runtime, state.result, error);
      },
    })
  );
}

function resolveWithItems(runtime: Runtime): (state: Combination) => void {
  return (state) => resolvePromise(runtime, state.result, runtime.newArray([...state.items.elements]));
}

/** Records an input of `allSettled` as `{ status, value }` or `{ status, reason }`. */
function settledEntry(
  runtime: Runtime,
  status: string,
  key: string
): (state: Combination, index: number, value: Value, settled: () => void) => void {
  return (state, index, value, settled) => {
    const entry = runtime.newObject();
    runtime.createDataProperty(entry, 'status', status);
    runtime.createDataProperty(entry, key, value);
    state.items.elements[index] = entry;
    settled();
  };
}

/** The promise a combinator returns and what its inputs settled with so far. */
interface Combination {
  result: JsObject;
  /** An interpreter array, which the element functions keep reachable for garbage collection until the end. */
  items: JsArray;
}

/** What a combinator does as each input settles: `settled` counts the input down toward `onComplete`. */
interface CombinatorHandlers {
  onFulfilled: (state: Combination, index: number, value: Value, settled: () => void) => void;
  onRejected: (state: Combination, index: number, reason: Value, settled: () => void) => void;
  /** Settles the result once every input has been counted down, which an empty iterable does at once. */
  onComplete?: (state: Combination) => void;
}

/**
 * Subscribes to each value of an iterable through `Promise.resolve(value).then` as the iterator produces it, so that
 * each value's `then` runs before the next value is requested, as in JavaScript.
 */
function combine(runtime: Runtime, iterable: Value, handlers: CombinatorHandlers): JsObject {
  const state: Combination = { result: newPromise(runtime), items: runtime.newArray([]) };
  // One count stands for the iteration itself, so the result settles only after it ends.
  let remaining = 1;
  const settled = (): void => {
    if (--remaining === 0) handlers.onComplete?.(state);
  };
  let iterator: ValueIterator | undefined;
  try {
    iterator = runtime.iterator(iterable);
    for (let index = 0, value = iterator.next(); value !== DONE; index++, value = iterator.next()) {
      state.items.elements.push(undefined);
      remaining++;
      subscribe(runtime, state, index, promiseResolve(runtime, value), handlers, settled);
    }
  } catch (error) {
    if (!(error instanceof JsThrow)) throw error;
    // An error from the iterator's own `next()` has already ended it; other errors close it.
    iterator?.close('throw');
    rejectPromise(runtime, state.result, error.value);
    return state.result;
  }
  settled();
  return state.result;
}

/** Calls an input's `then` with functions of which only the first call counts, as an element's functions do. */
function subscribe(
  runtime: Runtime,
  state: Combination,
  index: number,
  promise: JsObject,
  handlers: CombinatorHandlers,
  settled: () => void
): void {
  const thenMethod = runtime.get(promise, 'then');
  let isCalled = false;
  const element = (handle: CombinatorHandlers['onFulfilled']): JsFunction => {
    const fn = runtime.newNativeFunction('', 1, ({ args }) => {
      if (!isCalled) {
        isCalled = true;
        handle(state, index, args[0], settled);
      }
      return;
    });
    fn.captured.push(state.result, state.items);
    return fn;
  };
  runtime.call(thenMethod, promise, [element(handlers.onFulfilled), element(handlers.onRejected)]);
}

function defineTimers(builder: RealmBuilder): void {
  for (const [name, repeats] of [
    ['setTimeout', false],
    ['setInterval', true],
  ] as const) {
    builder.global(
      name,
      builder.function(name, 2, ({ runtime, args }) => {
        const [callback, delay, ...rest] = args;
        if (!isCallable(callback)) {
          return runtime.throwError(
            'TypeError',
            `The "callback" argument must be of type function. Received ${runtime.describe(callback)}`
          );
        }
        // Node.js runs a delay outside 1 to 2^31 - 1 milliseconds, NaN included, after 1 millisecond.
        const milliseconds = runtime.toNumber(delay);
        const job = { run: () => runtime.call(callback, undefined, rest), roots: [callback, ...rest] };
        const isInRange = milliseconds >= 1 && milliseconds <= 2 ** 31 - 1;
        return runtime.eventLoop.addTimer(isInRange ? Math.trunc(milliseconds) : 1, job, repeats);
      })
    );
  }
  // Each clears timers of both kinds, as in Node.js.
  for (const name of ['clearTimeout', 'clearInterval']) {
    builder.global(
      name,
      builder.function(name, 1, ({ runtime, args }) => {
        runtime.eventLoop.clearTimer(args[0]);
        return;
      })
    );
  }
  builder.global(
    'queueMicrotask',
    builder.function('queueMicrotask', 1, ({ runtime, args }) => {
      const [callback] = args;
      if (!isCallable(callback)) {
        return runtime.throwError(
          'TypeError',
          `The "callback" argument must be of type function. Received ${runtime.describe(callback)}`
        );
      }
      runtime.eventLoop.enqueue({ run: () => runtime.call(callback, undefined, []), roots: [callback] });
      return;
    })
  );
}
