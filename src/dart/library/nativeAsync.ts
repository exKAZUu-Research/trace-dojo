import { AsyncTask } from '../asyncTask';
import { AwaitRequest, LISTENER_CANCELLED, YieldEachRequest } from '../awaitSteps';
import { scopedMemberName } from '../classes';
import { DartThrow, type Frame, type Runtime } from '../runtime';
import type { DartType } from '../types';
import type { DartObject, Value } from '../values';
import { define } from './nativeSupport';

type AsyncBody = (frame: Frame) => Generator<unknown, unknown, Value>;

/** How a suspended body continues: with the value it waited for, or with an error thrown at its `await`. */
type Resumption = { kind: 'next'; value: unknown } | { kind: 'throw'; error: DartThrow };

/** An `async` or `async*` function's body in flight, which its `_SuspendState` object carries. */
interface SuspendedBody {
  frame: Frame;
  generator: Generator<unknown, unknown, Value> | undefined;
  /** Whether the body suspended once, after which the VM completes its future with an error synchronously. */
  hasSuspended: boolean;
  /** For `async*`: whether the body waits at a `yield` for its stream's listener rather than at an `await`. */
  atYield: boolean;
  /** For `async*`: whether the body has not started, which it does once its stream is listened to. */
  atStart: boolean;
  isStar: boolean;
  task: AsyncTask;
  values(): Iterable<Value>;
}

/** Starts an `async` function's body in its frame, which runs until its first `await`, and returns its future. */
export function startAsync(frame: Frame, valueType: DartType, body: AsyncBody): Value {
  const { runtime } = frame;
  const future = runtime.links.construct(runtime, '_Future', '', [], undefined, [valueType]);
  const state = suspendState(runtime, future, frame, body, false);
  // The caller leaves the frame once this returns; nothing waits on the new future that could resume inside it.
  let next: Resumption | undefined = { kind: 'next', value: undefined };
  while (next) next = perform(runtime, state, advanceTask(state, next));
  frame.isSuspended = state.generator !== undefined;
  return future;
}

/** Creates an `async*` function's stream, whose body starts when the stream is listened to. */
export function startAsyncStar(frame: Frame, elementType: DartType, body: AsyncBody): Value {
  const { runtime } = frame;
  const controller = runtime.links.construct(runtime, '_AsyncStarStreamController', '', [], undefined, [elementType]);
  const state = suspendState(runtime, controller, frame, body, true);
  frame.isSuspended = true;
  return runtime.invoke(
    state.object,
    asyncMember('_startAsyncStar'),
    { positional: [], named: undefined },
    [],
    undefined
  );
}

function suspendState(
  runtime: Runtime,
  functionData: Value,
  frame: Frame,
  body: AsyncBody,
  isStar: boolean
): SuspendedBody & { object: DartObject } {
  const object = runtime.links.construct(runtime, '_SuspendState', '', [functionData]);
  const state: SuspendedBody & { object: DartObject } = {
    object,
    frame,
    generator: body(frame),
    hasSuspended: false,
    atYield: false,
    atStart: isStar,
    isStar,
    task: new AsyncTask(runtime.steps),
    *values() {
      if (!this.generator) return;
      for (const cell of frame.locals) yield cell?.v;
      for (const cell of frame.captured) yield cell.v;
      yield frame.receiver;
      yield* frame.temporaries;
    },
  };
  object.native = state as unknown as DartObject['native'];
  frame.asyncTask = state.task;
  return state;
}

/** The key of a private member of dart:async. */
function asyncMember(name: string): string {
  return scopedMemberName(name, 'dart:async');
}

/** What a body that stopped running asks for: to wait, to add to its stream, or to end its future or stream. */
type Outcome =
  | { kind: 'await'; value: Value; isNotFuture: boolean }
  | { kind: 'yield'; value: Value }
  | { kind: 'yieldEach'; stream: Value }
  | { kind: 'return'; value: Value }
  | { kind: 'throw'; error: DartThrow };

/** Runs the body from where it waits until it suspends again or ends, counting the steps it records meanwhile. */
function advanceTask(state: SuspendedBody, resumption: Resumption): Outcome {
  return state.task.run(() => advance(state, resumption));
}

function advance(state: SuspendedBody, resumption: Resumption): Outcome {
  const generator = state.generator as NonNullable<SuspendedBody['generator']>;
  let result: IteratorResult<unknown, unknown>;
  try {
    result =
      resumption.kind === 'throw' ? generator.throw(resumption.error) : generator.next(resumption.value as Value);
  } catch (error) {
    state.generator = undefined;
    if (error instanceof DartThrow) return { kind: 'throw', error };
    throw error;
  }
  if (result.done) {
    state.generator = undefined;
    const completion = result.value as { kind: string; value?: Value } | undefined;
    return { kind: 'return', value: completion?.kind === 'return' ? completion.value : undefined };
  }
  const request = result.value;
  if (request instanceof AwaitRequest) return { kind: 'await', value: request.value, isNotFuture: request.isNotFuture };
  if (request instanceof YieldEachRequest) return { kind: 'yieldEach', stream: request.stream };
  return { kind: 'yield', value: request as Value };
}

/**
 * Does what a suspended or finished body asked for, as the VM's `_SuspendState` does, giving how the body continues
 * at once when its stream's listener has gone.
 */
function perform(
  runtime: Runtime,
  state: SuspendedBody & { object: DartObject },
  outcome: Outcome
): Resumption | undefined {
  const call = (name: string, ...positional: Value[]): Value =>
    runtime.invoke(state.object, asyncMember(name), { positional, named: undefined }, [], undefined);
  const wasSuspended = state.hasSuspended;
  switch (outcome.kind) {
    case 'return': {
      if (state.isStar) call('_returnAsyncStar');
      else call('_returnAsync', outcome.value);
      return undefined;
    }
    case 'throw': {
      call('_handleException', wasSuspended, outcome.error.value, outcome.error.stackTrace);
      return undefined;
    }
    case 'await': {
      state.hasSuspended = true;
      call(outcome.isNotFuture ? '_awaitNotFutureOfType' : '_await', outcome.value);
      return undefined;
    }
    default: {
      state.hasSuspended = true;
      const cancelled =
        outcome.kind === 'yieldEach'
          ? call('_yieldEachAsyncStar', outcome.stream)
          : call('_yieldAsyncStar', outcome.value);
      // An `async*` body's `yield` ends it when the stream's listener has gone, and otherwise waits for the listener.
      if (cancelled === true) return { kind: 'next', value: LISTENER_CANCELLED };
      state.atYield = true;
      return undefined;
    }
  }
}

define('_SuspendState._resume', (runtime, self, [value, exception, stackTrace]) => {
  const state = (self as DartObject).native as unknown as SuspendedBody & { object: DartObject };
  const { frame } = state;
  let next: Resumption | undefined;
  if (exception !== undefined) {
    next = { kind: 'throw', error: runtime.newThrow(exception, stackTrace) };
  } else if (state.atYield && value === true) {
    next = { kind: 'next', value: LISTENER_CANCELLED };
  } else {
    next = { kind: 'next', value: state.atStart || state.atYield ? undefined : value };
  }
  state.atStart = false;
  while (next && state.generator) {
    state.atYield = false;
    frame.isSuspended = false;
    runtime.enter(frame);
    let outcome: Outcome;
    try {
      outcome = advanceTask(state, next);
    } finally {
      frame.isSuspended = state.generator !== undefined;
      runtime.exit(frame);
    }
    // The body has left its frame, so that code its future or stream runs now does not run inside it.
    next = perform(runtime, state, outcome);
  }
  return;
});

define('_scheduleImmediate', (runtime, _self, [callback]) => {
  runtime.events.scheduleImmediate(callback);
  return;
});

define('_Timer._schedule', (runtime, self, [delay]) => {
  runtime.events.schedule(self as DartObject, Number(delay));
  return;
});

define('_Timer._reschedule', (runtime, self, [period]) => {
  runtime.events.reschedule(self as DartObject, Number(period));
  return;
});

define('_Timer._skipMissedTicks', (runtime, self, [period]) =>
  BigInt(runtime.events.skipMissedTicks(self as DartObject, Number(period)))
);

define('_Timer._unschedule', (runtime, self) => {
  runtime.events.unschedule(self as DartObject);
  return;
});

define('_DeferredLoading._markLoaded', (runtime, _self, [prefix]) => {
  runtime.loadedPrefixes.add(prefix as string);
  return;
});
