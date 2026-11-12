import {
  Awaiting,
  type BodyResult,
  DelegatedResult,
  GeneratorReturn,
  type Resume,
  resumedValue,
  type Steps,
  type Suspension,
} from './generators';
import { DONE } from './iteration';
import type { ProtocolIteration } from './iteratorProtocol';
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
  /** The generator object, which an awaiting body keeps reachable with the calls it has yet to answer. */
  object: JsObject;
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
  object.asyncGenerator = { object, frame, body, status: 'suspendedStart', queue: [] };
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
      awaitValue(runtime, resume.value, [state.object, request.promise], (settled) => {
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
  let result: IteratorResult<Suspension, BodyResult>;
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
  const roots = [state.object, frame.scope, ...frame.temporaries];
  if (result.done) {
    state.status = 'completed';
    answer(runtime, state, result.value?.kind === 'return' ? result.value.value : undefined, false, true);
    resumeNext(runtime, state);
    return;
  }
  if (result.value instanceof DelegatedResult) throw new Error('A sync yield* ran in an async generator');
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
  /** The iterator object and its `next` method, which must stay reachable while the loop runs. */
  roots: readonly Value[];
  next: () => Steps<Value | typeof DONE>;
  /** Closes the iterator when the loop ends before it is done, by a `break` or `return`, or by an exception. */
  close: (completion: 'normal' | 'throw') => Steps<void>;
}

/**
 * Awaits each result of an async iteration, as `for await` reads them. An iteration whose `next` failed is done and
 * not closed; closing after the loop body threw keeps the body's error over the iterator's.
 */
export class AwaitingIterator implements LoopIterator {
  private isDone = false;

  readonly roots: readonly Value[];

  constructor(
    private readonly runtime: Runtime,
    private readonly iteration: ProtocolIteration
  ) {
    this.roots = [iteration.iterator, iteration.nextMethod];
  }

  *next(): Steps<Value | typeof DONE> {
    const { runtime } = this;
    if (this.isDone) return DONE;
    let result: Value;
    try {
      result = resumedValue(yield new Awaiting(this.iteration.next()));
    } catch (error) {
      this.isDone = true;
      throw error;
    }
    if (!isObject(result)) {
      this.isDone = true;
      return runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
    }
    if (!toBoolean(runtime.get(result, 'done'))) return runtime.get(result, 'value');
    this.isDone = true;
    return DONE;
  }

  *close(completion: 'normal' | 'throw'): Steps<void> {
    const { runtime } = this;
    if (this.isDone) return;
    this.isDone = true;
    const close = this.iteration.return;
    if (!close) return;
    try {
      const result = resumedValue(yield new Awaiting(close()));
      if (!isObject(result))
        runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
    } catch (error) {
      if (completion === 'throw' && error instanceof JsThrow) return;
      throw error;
    }
  }
}
