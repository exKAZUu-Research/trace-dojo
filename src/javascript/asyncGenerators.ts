import { Awaiting, type BodyResult, GeneratorReturn, type Resume, resumedValue, type Steps } from './generators';
import { DONE, type ValueIterator } from './iteration';
import { awaitValue, newPromise, rejectPromise, resolvePromise } from './promises';
import type { RealmBuilder } from './realm';
import { iteratorResult, WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Frame, Runtime } from './runtime';
import { isObject, JsObject, JsThrow, toBoolean, type Value } from './values';

/** A call of an async generator's `next`, `throw`, or `return`, whose promise settles once the body answers it. */
interface Request {
  resume: Resume;
  promise: JsObject;
}

export interface AsyncGeneratorState {
  /** The frame of the body, which every resumption pushes again. */
  frame: Frame;
  body: Steps<BodyResult>;
  status: 'suspendedStart' | 'suspendedYield' | 'executing' | 'awaitingReturn' | 'completed';
  /** The calls not answered yet, which the body answers in order. */
  queue: Request[];
}

/** Creates an async generator object, whose body starts at its first `next()`. */
export function createAsyncGeneratorObject(
  runtime: Runtime,
  prototype: Value,
  frame: Frame,
  body: Steps<BodyResult>
): JsObject {
  const object = runtime.newObject(prototype instanceof JsObject ? prototype : runtime.realm.asyncGeneratorPrototype);
  object.asyncGenerator = { frame, body, status: 'suspendedStart', queue: [] };
  return object;
}

/** Defines `%AsyncGeneratorPrototype%`, whose methods queue a request and return the promise of its answer. */
export function defineAsyncGeneratorBuiltins(builder: RealmBuilder): void {
  const { asyncGeneratorPrototype, asyncIteratorPrototype } = builder.realm;
  builder.method(asyncIteratorPrototype, WELL_KNOWN_SYMBOLS.asyncIterator, 0, ({ thisValue }) => thisValue);
  builder.constant(asyncGeneratorPrototype, WELL_KNOWN_SYMBOLS.toStringTag, 'AsyncGenerator');
  for (const kind of ['next', 'return', 'throw'] as const) {
    builder.method(asyncGeneratorPrototype, kind, 1, ({ runtime, thisValue, args }) => {
      const promise = newPromise(runtime);
      const state = thisValue instanceof JsObject ? thisValue.asyncGenerator : undefined;
      if (!state) {
        rejectPromise(
          runtime,
          promise,
          runtime.newError('TypeError', `${kind} method called on incompatible receiver ${runtime.describe(thisValue)}`)
        );
        return promise;
      }
      state.queue.push({ resume: { kind, value: args[0] }, promise });
      if (state.status !== 'executing' && state.status !== 'awaitingReturn') resumeNext(runtime, state);
      return promise;
    });
  }
}

/** Answers the queued requests in order: a completed generator answers at once, a suspended one resumes its body. */
function resumeNext(runtime: Runtime, state: AsyncGeneratorState): void {
  for (let request = state.queue.at(0); request; request = state.queue.at(0)) {
    const { resume } = request;
    if (state.status === 'suspendedStart' && resume.kind !== 'next') state.status = 'completed';
    if (state.status !== 'completed') {
      state.status = 'executing';
      advance(runtime, state, resume);
      return;
    }
    if (resume.kind === 'return') {
      // Returning from a completed generator awaits the value first.
      state.status = 'awaitingReturn';
      awaitValue(runtime, resume.value, [request.promise], (settled) => {
        state.status = 'completed';
        answer(
          runtime,
          state,
          settled.kind === 'next' ? settled.value : undefined,
          settled.kind === 'throw',
          true,
          settled.value
        );
        resumeNext(runtime, state);
      });
      return;
    }
    answer(runtime, state, undefined, resume.kind === 'throw', true, resume.value);
  }
}

/** Runs the body to its next `await`, `yield`, or end, answering the first request when it yields or ends. */
function advance(runtime: Runtime, state: AsyncGeneratorState, resume: Resume): void {
  const { frame } = state;
  runtime.resumeFrame(frame);
  let result: IteratorResult<Value | Awaiting, BodyResult>;
  try {
    result = state.body.next(resume);
  } catch (error) {
    state.status = 'completed';
    if (error instanceof JsThrow) answer(runtime, state, undefined, true, true, error.value);
    else if (error instanceof GeneratorReturn) answer(runtime, state, error.value, false, true);
    else throw error;
    resumeNext(runtime, state);
    return;
  } finally {
    runtime.popFrame();
  }
  const roots = [frame.scope, ...frame.temporaries, ...state.queue.map((request) => request.promise)];
  if (result.done) {
    // A `return` awaits its value before the generator answers with it.
    const returned = result.value?.kind === 'return' ? result.value.value : undefined;
    awaitValue(runtime, returned, roots, (settled) => {
      state.status = 'completed';
      answer(runtime, state, settled.value, settled.kind === 'throw', true, settled.value);
      resumeNext(runtime, state);
    });
    return;
  }
  if (result.value instanceof Awaiting) {
    awaitValue(runtime, result.value.value, roots, (next) => advance(runtime, state, next));
    return;
  }
  // A `yield` awaits its value too, and an awaited rejection throws at the `yield`.
  awaitValue(runtime, result.value, roots, (settled) => {
    if (settled.kind === 'throw') {
      advance(runtime, state, settled);
      return;
    }
    state.status = 'suspendedYield';
    answer(runtime, state, settled.value, false, false);
    resumeNext(runtime, state);
  });
}

/** Settles the first request's promise with an iterator result, or rejects it with `reason`. */
function answer(
  runtime: Runtime,
  state: AsyncGeneratorState,
  value: Value,
  isRejection: boolean,
  done: boolean,
  reason?: Value
): void {
  const request = state.queue.shift();
  if (!request) return;
  if (isRejection) rejectPromise(runtime, request.promise, reason);
  else resolvePromise(runtime, request.promise, iteratorResult(runtime, value, done));
}

// for await ---------------------------------------------------------------------------------------------------------

/** How a `for...of` or `for await` loop steps through its iterable, suspending its body while it awaits. */
export interface LoopIterator {
  next: () => Steps<Value | typeof DONE>;
  close: () => Steps<void>;
}

/** An async iterator's methods, each returning what `for await` awaits. */
interface AsyncIteration {
  next: () => Value;
  close: () => Value;
}

/** The iteration `for await` runs: the async iterator of the value, or its sync iterator with each value awaited. */
export function asyncIteratorOf(runtime: Runtime, iterable: Value): AsyncIteration {
  const method =
    iterable === undefined || iterable === null ? undefined : runtime.get(iterable, WELL_KNOWN_SYMBOLS.asyncIterator);
  if (method === undefined || method === null) return fromSyncIterator(runtime, runtime.iterator(iterable));
  const iterator = runtime.call(method, iterable, [], runtime.currentRow);
  if (!isObject(iterator)) {
    return runtime.throwError('TypeError', 'Result of the Symbol.asyncIterator method is not an object');
  }
  const next = runtime.get(iterator, 'next');
  return {
    next: () => runtime.call(next, iterator, [], runtime.currentRow),
    close: () => {
      const close = runtime.get(iterator, 'return');
      return close === undefined || close === null ? undefined : runtime.call(close, iterator, [], runtime.currentRow);
    },
  };
}

/** Steps through a sync iterator for `for await`, which awaits each of its values as an async iterator's result. */
function fromSyncIterator(runtime: Runtime, iterator: ValueIterator): AsyncIteration {
  return {
    next: () => {
      const value = iterator.next();
      const result = newPromise(runtime);
      if (value === DONE) {
        resolvePromise(runtime, result, iteratorResult(runtime, undefined, true));
        return result;
      }
      awaitValue(runtime, value, [result], (settled) => {
        if (settled.kind === 'throw') rejectPromise(runtime, result, settled.value);
        else resolvePromise(runtime, result, iteratorResult(runtime, settled.value, false));
      });
      return result;
    },
    close: () => {
      iterator.close();
      return;
    },
  };
}

/** Awaits each result of an async iteration, as `for await` reads them. */
export class AwaitingIterator implements LoopIterator {
  constructor(
    private readonly runtime: Runtime,
    private readonly iteration: AsyncIteration
  ) {}

  *next(): Steps<Value | typeof DONE> {
    const { runtime } = this;
    const result = resumedValue(yield new Awaiting(this.iteration.next()));
    if (!isObject(result)) {
      return runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
    }
    return toBoolean(runtime.get(result, 'done')) ? DONE : runtime.get(result, 'value');
  }

  *close(): Steps<void> {
    const result = this.iteration.close();
    if (result !== undefined) resumedValue(yield new Awaiting(result));
  }
}
