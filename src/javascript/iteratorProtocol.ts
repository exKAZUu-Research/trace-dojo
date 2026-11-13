import { Awaiting, DelegatedResult, GeneratorReturn, type Resume, resumedValue, type Steps } from './generators';
import { awaitValue, newPromise, rejectPromise, resolvePromise } from './promises';
import { iteratorResult, WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import { isCallable, isObject, type JsObject, JsThrow, toBoolean, type Value } from './values';

/** An iterator object's methods, each returning the iterator's result, or for an async iterator, a promise of it. */
export interface ProtocolIteration {
  /** The iterator object and the `next` method read from it, which must stay reachable while the iteration lasts. */
  iterator: JsObject;
  nextMethod: Value;
  /** Calls the iterator's `next` with the given arguments: one for `yield*`, none for a loop. */
  next: (...args: Value[]) => Value;
  /** Calls the iterator's `return`, or is undefined when it has none. */
  return: ((...args: Value[]) => Value) | undefined;
  /** Calls the iterator's `throw`, or is undefined when it has none. */
  throw: ((...args: Value[]) => Value) | undefined;
}

/** The iteration a sync `yield*` runs: the object the value's `Symbol.iterator` method returns. */
export function syncIteratorOf(runtime: Runtime, iterable: Value): ProtocolIteration {
  return iterationOf(
    runtime,
    iteratorObject(
      runtime,
      iterable,
      WELL_KNOWN_SYMBOLS.iterator,
      methodOf(runtime, iterable, WELL_KNOWN_SYMBOLS.iterator)
    )
  );
}

/**
 * The iteration `for await` and an async `yield*` run: the async iterator of the value, or its sync iterator, whose
 * results become promises of the same results with their values awaited, as `CreateAsyncFromSyncIterator` does.
 */
export function asyncIteratorOf(
  runtime: Runtime,
  iterable: Value,
  methods?: { async: Value; sync?: Value }
): ProtocolIteration {
  const factory = methods ? methods.async : methodOf(runtime, iterable, WELL_KNOWN_SYMBOLS.asyncIterator);
  if (factory !== undefined && factory !== null) {
    return iterationOf(runtime, iteratorObject(runtime, iterable, WELL_KNOWN_SYMBOLS.asyncIterator, factory));
  }
  const iterator = iteratorObject(
    runtime,
    iterable,
    WELL_KNOWN_SYMBOLS.iterator,
    methods ? methods.sync : methodOf(runtime, iterable, WELL_KNOWN_SYMBOLS.iterator)
  );
  const iteration = iterationOf(runtime, iterator, (step, method) =>
    asyncFromSyncStep(runtime, iterator, step, method)
  );
  return {
    iterator,
    nextMethod: iteration.nextMethod,
    next: iteration.next,
    // The async-from-sync iterator always has `return`, which resolves at once, without awaiting the value, when the
    // sync iterator has none.
    get return() {
      return (
        iteration.return ??
        ((...args: Value[]) => {
          const promise = newPromise(runtime);
          resolvePromise(runtime, promise, iteratorResult(runtime, args[0], true));
          return promise;
        })
      );
    },
    // Its `throw` also always exists: without the sync iterator's, it closes the sync iterator and rejects.
    get throw() {
      return (
        iteration.throw ??
        (() => {
          const promise = newPromise(runtime);
          try {
            const close = runtime.get(iterator, 'return');
            if (close !== undefined && close !== null) {
              checkResult(runtime, runtime.call(close, iterator, [], runtime.currentRow));
            }
            runtime.throwError('TypeError', "The iterator does not provide a 'throw' method.");
          } catch (error) {
            if (!(error instanceof JsThrow)) throw error;
            rejectPromise(runtime, promise, error.value);
          }
          return promise;
        })
      );
    },
  };
}

/**
 * Runs `yield*`, which passes each value of the iterator out and forwards each resumption to its `next`, `throw`, or
 * `return`; in an async generator, it awaits each of the iterator's results.
 */
export function* delegateYield(runtime: Runtime, iterable: Value, isAsync: boolean): Steps<Value> {
  const iteration = isAsync ? asyncIteratorOf(runtime, iterable) : syncIteratorOf(runtime, iterable);
  // The suspended body's frame keeps the delegate alive, with the values it has yet to yield.
  const { temporaries } = runtime.frame;
  const held = temporaries.length;
  temporaries.push(iteration.iterator, iteration.nextMethod);
  try {
    return yield* delegateTo(runtime, iteration, isAsync);
  } finally {
    temporaries.length = held;
  }
}

function* awaitedReturn(value: Value): Steps<Resume> {
  try {
    return { kind: 'return', value: resumedValue(yield new Awaiting(value)) };
  } catch (error) {
    if (!(error instanceof JsThrow)) throw error;
    return { kind: 'throw', value: error.value };
  }
}

function* delegateTo(runtime: Runtime, iteration: ProtocolIteration, isAsync: boolean): Steps<Value> {
  function* settle(result: Value): Steps<Value> {
    return isAsync ? resumedValue(yield new Awaiting(result)) : result;
  }
  let resume: Resume = { kind: 'next', value: undefined };
  for (;;) {
    let request: Value;
    if (resume.kind === 'next') {
      request = iteration.next(resume.value);
    } else if (resume.kind === 'throw') {
      const throwMethod = iteration.throw;
      if (!throwMethod) {
        const close = iteration.return;
        if (close) checkResult(runtime, yield* settle(close()));
        return runtime.throwError('TypeError', "The iterator does not provide a 'throw' method.");
      }
      request = throwMethod(resume.value);
    } else {
      const close = iteration.return;
      if (!close) throw new GeneratorReturn(yield* settle(resume.value));
      request = close(resume.value);
    }
    const result = checkResult(runtime, yield* settle(request));
    if (toBoolean(runtime.get(result, 'done'))) {
      const value = runtime.get(result, 'value');
      if (resume.kind === 'return') throw new GeneratorReturn(value);
      return value;
    }
    // A sync generator passes the delegate's result through as it is; an async one yields its value.
    resume = isAsync ? yield runtime.get(result, 'value') : yield new DelegatedResult(result);
    // An async generator awaits a return value it resumes with, as AsyncGeneratorUnwrapYieldResumption does.
    if (isAsync && resume.kind === 'return') resume = yield* awaitedReturn(resume.value);
  }
}

function checkResult(runtime: Runtime, result: Value): JsObject {
  if (isObject(result)) return result;
  return runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
}

function methodOf(runtime: Runtime, iterable: Value, key: symbol): Value {
  return iterable === undefined || iterable === null ? undefined : runtime.get(iterable, key);
}

/** Calls `factory`, the method under `key` that the caller read from `iterable`, to get an iterator. */
function iteratorObject(runtime: Runtime, iterable: Value, key: symbol, factory: Value): JsObject {
  if (!isCallable(factory)) {
    const what = key === WELL_KNOWN_SYMBOLS.iterator ? 'iterable' : 'async iterable';
    return runtime.throwError('TypeError', `${runtime.describe(iterable)} is not ${what}`);
  }
  const iterator = runtime.call(factory, iterable, [], runtime.currentRow);
  if (!isObject(iterator))
    return runtime.throwError('TypeError', `Result of the ${key.description} method is not an object`);
  return iterator;
}

/** Calls an iterator object's methods, each step through `adapt`, which may turn its result into a promise of it. */
function iterationOf(
  runtime: Runtime,
  iterator: JsObject,
  adapt: (step: () => Value, method: 'next' | 'return' | 'throw') => Value = (step) => step()
): ProtocolIteration {
  const next = runtime.get(iterator, 'next');
  const method = (name: 'return' | 'throw'): ((...args: Value[]) => Value) | undefined => {
    const fn = runtime.get(iterator, name);
    if (fn === undefined || fn === null) return undefined;
    // The arguments go as given: none for an implicit close, one for a forwarded `return(value)` or `throw(error)`.
    return (...args) => adapt(() => runtime.call(fn, iterator, args, runtime.currentRow), name);
  };
  return {
    iterator,
    nextMethod: next,
    next: (...args) => adapt(() => runtime.call(next, iterator, args, runtime.currentRow), 'next'),
    get return() {
      return method('return');
    },
    get throw() {
      return method('throw');
    },
  };
}

/**
 * Runs one step of a sync iterator used as an async one, as `CreateAsyncFromSyncIterator` does: the promise of the
 * step's result with its value awaited. A `next` or `throw` step that fails anywhere, by throwing, by giving no result
 * object, or by a rejected value of an unfinished result, closes the sync iterator first, as V8 does.
 */
function asyncFromSyncStep(
  runtime: Runtime,
  iterator: JsObject,
  step: () => Value,
  method: 'next' | 'return' | 'throw'
): JsObject {
  const promise = newPromise(runtime);
  const fail = (reason: Value, closes: boolean): void => {
    if (closes && method !== 'return') closeQuietly(runtime, iterator);
    rejectPromise(runtime, promise, reason);
  };
  let done: boolean;
  let value: Value;
  try {
    const result = checkResult(runtime, step());
    done = toBoolean(runtime.get(result, 'done'));
    value = runtime.get(result, 'value');
  } catch (error) {
    if (!(error instanceof JsThrow)) throw error;
    fail(error.value, true);
    return promise;
  }
  awaitValue(runtime, value, [promise, iterator], (settled) => {
    if (settled.kind === 'throw') fail(settled.value, !done);
    else resolvePromise(runtime, promise, iteratorResult(runtime, settled.value, done));
  });
  return promise;
}

/** Calls an iterator's `return` after an error, discarding whatever it throws. */
function closeQuietly(runtime: Runtime, iterator: JsObject): void {
  try {
    const close = runtime.get(iterator, 'return');
    if (close !== undefined && close !== null) runtime.call(close, iterator, [], runtime.currentRow);
  } catch (error) {
    if (!(error instanceof JsThrow)) throw error;
  }
}
