import { Awaiting, type BodyResult, GeneratorReturn, type Resume, resumedValue, type Steps } from './generators';
import { DONE } from './iteration';
import { awaitValue, newPromise, rejectPromise, resolvePromise } from './promises';
import type { RealmBuilder } from './realm';
import { iteratorResult, WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Frame, Runtime } from './runtime';
import { isCallable, isObject, JsObject, JsThrow, toBoolean, type Value } from './values';

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
    state.status = 'completed';
    answer(runtime, state, result.value?.kind === 'return' ? result.value.value : undefined, false, true);
    resumeNext(runtime, state);
    return;
  }
  if (result.value instanceof Awaiting) {
    awaitValue(runtime, result.value.value, roots, (next) => advance(runtime, state, next));
    return;
  }
  state.status = 'suspendedYield';
  answer(runtime, state, result.value, false, false);
  resumeNext(runtime, state);
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
  next: (value?: Value) => Value;
  /** Calls the iterator's `return`, giving undefined when it has none. */
  close: (value?: Value) => Value;
  /** Calls the iterator's `throw`, which `yield*` forwards an exception to, or is undefined when it has none. */
  throw: ((value: Value) => Value) | undefined;
}

/**
 * The iteration `for await` and an async `yield*` run: the async iterator of the value, or its sync iterator, whose
 * results become promises of the same results with their values awaited, as `CreateAsyncFromSyncIterator` does.
 */
export function asyncIteratorOf(runtime: Runtime, iterable: Value): AsyncIteration {
  const factory =
    iterable === undefined || iterable === null ? undefined : runtime.get(iterable, WELL_KNOWN_SYMBOLS.asyncIterator);
  if (factory !== undefined && factory !== null) {
    const iterator = runtime.call(factory, iterable, [], runtime.currentRow);
    if (!isObject(iterator)) {
      return runtime.throwError('TypeError', 'Result of the Symbol.asyncIterator method is not an object');
    }
    return iterationOf(runtime, iterator, (result) => result);
  }
  const syncFactory =
    iterable === undefined || iterable === null ? undefined : runtime.get(iterable, WELL_KNOWN_SYMBOLS.iterator);
  if (!isCallable(syncFactory))
    return runtime.throwError('TypeError', `${runtime.describe(iterable)} is not async iterable`);
  const iterator = runtime.call(syncFactory, iterable, [], runtime.currentRow);
  if (!isObject(iterator)) {
    return runtime.throwError('TypeError', 'Result of the Symbol.iterator method is not an object');
  }
  return iterationOf(runtime, iterator, (result) => awaitedResult(runtime, result));
}

/** Calls an iterator object's methods, passing each result through `adapt`. */
function iterationOf(runtime: Runtime, iterator: JsObject, adapt: (result: Value) => Value): AsyncIteration {
  const next = runtime.get(iterator, 'next');
  const method = (name: string): ((value?: Value) => Value) | undefined => {
    const fn = runtime.get(iterator, name);
    if (fn === undefined || fn === null) return undefined;
    return (value) => adapt(runtime.call(fn, iterator, [value], runtime.currentRow));
  };
  return {
    next: (value) => adapt(runtime.call(next, iterator, value === undefined ? [] : [value], runtime.currentRow)),
    close: (value) => method('return')?.(value),
    get throw() {
      return method('throw');
    },
  };
}

/** A promise of a sync iterator's result with its value awaited, keeping whether the iterator is done. */
function awaitedResult(runtime: Runtime, result: Value): JsObject {
  if (!isObject(result)) {
    return runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
  }
  const done = toBoolean(runtime.get(result, 'done'));
  const promise = newPromise(runtime);
  awaitValue(runtime, runtime.get(result, 'value'), [promise], (settled) => {
    if (settled.kind === 'throw') rejectPromise(runtime, promise, settled.value);
    else resolvePromise(runtime, promise, iteratorResult(runtime, settled.value, done));
  });
  return promise;
}

/**
 * Runs `yield*` in an async generator: each result of the async iterator is awaited and its value yielded, and each
 * resumption is forwarded to the iterator's `next`, `throw`, or `return`.
 */
export function* delegateAsync(runtime: Runtime, iterable: Value): Steps<Value> {
  const iteration = asyncIteratorOf(runtime, iterable);
  let resume: Resume = { kind: 'next', value: undefined };
  for (;;) {
    let request: Value;
    if (resume.kind === 'next') {
      request = iteration.next(resume.value);
    } else if (resume.kind === 'throw') {
      const throwMethod = iteration.throw;
      if (!throwMethod) {
        const closed = iteration.close();
        if (closed !== undefined) resumedValue(yield new Awaiting(closed));
        return runtime.throwError('TypeError', "The iterator does not provide a 'throw' method");
      }
      request = throwMethod(resume.value);
    } else {
      request = iteration.close(resume.value);
      if (request === undefined) throw new GeneratorReturn(resumedValue(yield new Awaiting(resume.value)));
    }
    const result = resumedValue(yield new Awaiting(request));
    if (!isObject(result)) {
      return runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
    }
    const value = runtime.get(result, 'value');
    if (toBoolean(runtime.get(result, 'done'))) {
      if (resume.kind === 'return') throw new GeneratorReturn(value);
      return value;
    }
    resume = yield value;
  }
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
