import { type Resume, type Steps } from './generators';
import type { RealmBuilder } from './realm';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Frame, Runtime } from './runtime';
import { isCallable, isObject, type JsFunction, JsObject, JsThrow, type Value } from './values';

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
}

interface Timer extends Job {
  id: number;
  time: number;
}

/**
 * The event loop of one run: the microtasks promises queue and the timers `setTimeout` schedules, which run after the
 * program's statements in Node.js's order on a simulated clock, so a program never waits for real time.
 */
export class EventLoop {
  private readonly microtasks: Job[] = [];
  private readonly timers: Timer[] = [];
  private readonly rejections = new Set<JsObject>();
  private now = 0;
  private nextTimerId = 1;

  constructor(private readonly runtime: Runtime) {}

  /** The milliseconds the simulated clock has advanced since the program started. */
  get time(): number {
    return this.now;
  }

  enqueue(job: Job): void {
    this.microtasks.push(job);
  }

  addTimer(delay: number, job: Job): number {
    const id = this.nextTimerId++;
    this.timers.push({ ...job, id, time: this.now + Math.max(1, delay) });
    return id;
  }

  clearTimer(id: Value): void {
    const index = this.timers.findIndex((timer) => timer.id === id);
    if (index !== -1) this.timers.splice(index, 1);
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
      const timer = this.nextTimer();
      if (!timer) return;
      this.now = timer.time;
      timer.run();
    }
  }

  /** Everything the pending jobs and promises keep reachable, which garbage collection must see. */
  roots(): unknown[] {
    return [...this.microtasks, ...this.timers].flatMap((job) => job.roots);
  }

  private drainMicrotasks(): void {
    const { runtime } = this;
    for (let job = this.microtasks.shift(); job; job = this.microtasks.shift()) {
      runtime.spend();
      job.run();
    }
    // A rejection without a handler once the microtasks are done ends the program, as in Node.js.
    for (const promise of this.rejections) throw new JsThrow((promise.promise as PromiseState).result);
  }

  private nextTimer(): Timer | undefined {
    if (this.timers.length === 0) return undefined;
    let next = 0;
    for (const [index, timer] of this.timers.entries()) if (timer.time < this.timers[next].time) next = index;
    return this.timers.splice(next, 1)[0];
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
  runtime.eventLoop.enqueue({ run: () => run(result), roots: [result, ...reaction.roots] });
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
export function startAsyncFunction(
  runtime: Runtime,
  frame: Frame,
  body: Steps<{ kind: string; value?: Value } | undefined>
): JsObject {
  const promise = newPromise(runtime);
  const advance = (resume: Resume): void => {
    let result: IteratorResult<Value, { kind: string; value?: Value } | undefined>;
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
    const resumeInFrame = (next: Resume): void => {
      runtime.resumeFrame(frame);
      try {
        advance(next);
      } finally {
        runtime.popFrame();
      }
    };
    performThen(runtime, promiseResolve(runtime, result.value), {
      onFulfilled: (value) => resumeInFrame({ kind: 'next', value }),
      onRejected: (reason) => resumeInFrame({ kind: 'throw', value: reason }),
      roots: [promise, frame.scope, ...frame.temporaries],
    });
  };
  advance({ kind: 'next', value: undefined });
  return promise;
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
    const thenFinally = runtime.newNativeFunction('', 1, ({ args: [value] }) =>
      promiseThen(
        runtime,
        promiseResolve(runtime, runtime.call(onFinally, undefined, [])),
        runtime.newNativeFunction('', 0, () => value),
        undefined
      )
    );
    const catchFinally = runtime.newNativeFunction('', 1, ({ args: [reason] }) =>
      promiseThen(
        runtime,
        promiseResolve(runtime, runtime.call(onFinally, undefined, [])),
        runtime.newNativeFunction('', 0, () => {
          throw new JsThrow(reason);
        }),
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
    combine(runtime, args[0], (result, items, index, remaining) => ({
      onFulfilled: (value) => {
        items[index] = value;
        if (--remaining.count === 0) resolvePromise(runtime, result, runtime.newArray(items));
      },
      onRejected: (reason) => rejectPromise(runtime, result, reason),
    }))
  );
  builder.method(promiseConstructor, 'allSettled', 1, ({ runtime, args }) =>
    combine(runtime, args[0], (result, items, index, remaining) => {
      const record = (status: string, key: string) => (value: Value) => {
        const entry = runtime.newObject();
        runtime.createDataProperty(entry, 'status', status);
        runtime.createDataProperty(entry, key, value);
        items[index] = entry;
        if (--remaining.count === 0) resolvePromise(runtime, result, runtime.newArray(items));
      };
      return { onFulfilled: record('fulfilled', 'value'), onRejected: record('rejected', 'reason') };
    })
  );
  builder.method(promiseConstructor, 'race', 1, ({ runtime, args }) =>
    combine(
      runtime,
      args[0],
      (result) => ({
        onFulfilled: (value) => resolvePromise(runtime, result, value),
        onRejected: (reason) => rejectPromise(runtime, result, reason),
      }),
      false
    )
  );
  builder.method(promiseConstructor, 'any', 1, ({ runtime, args }) =>
    combine(
      runtime,
      args[0],
      (result, items, index, remaining) => ({
        onFulfilled: (value) => resolvePromise(runtime, result, value),
        onRejected: (reason) => {
          items[index] = reason;
          if (--remaining.count === 0) {
            const error = runtime.newError('AggregateError', 'All promises were rejected');
            runtime.defineProperty(error, 'errors', {
              value: runtime.newArray(items),
              writable: true,
              enumerable: false,
              configurable: true,
            });
            rejectPromise(runtime, result, error);
          }
        },
      }),
      true,
      true
    )
  );
}

/**
 * Subscribes to each value of an iterable through `Promise.resolve(value).then`, settling the returned promise once
 * every value has (or, for `race`, once the first has).
 */
function combine(
  runtime: Runtime,
  iterable: Value,
  reactionFor: (
    result: JsObject,
    items: Value[],
    index: number,
    remaining: { count: number }
  ) => Pick<Reaction, 'onFulfilled' | 'onRejected'>,
  settlesWhenEmpty = true,
  rejectsWhenEmpty = false
): JsObject {
  const result = newPromise(runtime);
  const values = runtime.iterate(iterable);
  const items: Value[] = Array.from({ length: values.length });
  const remaining = { count: values.length };
  for (const [index, value] of values.entries()) {
    const promise = promiseResolve(runtime, value);
    const thenMethod = runtime.get(promise, 'then');
    const { onFulfilled, onRejected } = reactionFor(result, items, index, remaining);
    const fulfill = runtime.newNativeFunction('', 1, ({ args }) => {
      onFulfilled(args[0]);
      return;
    });
    const reject = runtime.newNativeFunction('', 1, ({ args }) => {
      onRejected(args[0]);
      return;
    });
    fulfill.captured.push(result);
    reject.captured.push(result);
    runtime.call(thenMethod, promise, [fulfill, reject]);
  }
  if (values.length === 0 && settlesWhenEmpty) {
    if (rejectsWhenEmpty) {
      const error = runtime.newError('AggregateError', 'All promises were rejected');
      runtime.defineProperty(error, 'errors', {
        value: runtime.newArray([]),
        writable: true,
        enumerable: false,
        configurable: true,
      });
      rejectPromise(runtime, result, error);
    } else {
      resolvePromise(runtime, result, runtime.newArray([]));
    }
  }
  return result;
}

function defineTimers(builder: RealmBuilder): void {
  builder.global(
    'setTimeout',
    builder.function('setTimeout', 2, ({ runtime, args }) => {
      const [callback, delay, ...rest] = args;
      if (!isCallable(callback)) {
        return runtime.throwError(
          'TypeError',
          `The "callback" argument must be of type function. Received ${runtime.describe(callback)}`
        );
      }
      const milliseconds = Math.trunc(runtime.toNumber(delay));
      return runtime.eventLoop.addTimer(Number.isNaN(milliseconds) ? 1 : milliseconds, {
        run: () => runtime.call(callback, undefined, rest),
        roots: [callback, ...rest],
      });
    })
  );
  builder.global(
    'clearTimeout',
    builder.function('clearTimeout', 1, ({ runtime, args }) => {
      runtime.eventLoop.clearTimer(args[0]);
      return;
    })
  );
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
