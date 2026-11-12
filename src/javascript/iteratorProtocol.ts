import { Awaiting, DelegatedResult, GeneratorReturn, type Resume, resumedValue, type Steps } from './generators';
import { awaitValue, newPromise, rejectPromise, resolvePromise } from './promises';
import { iteratorResult, WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import { isCallable, isObject, type JsObject, toBoolean, type Value } from './values';

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
  return iterationOf(runtime, iteratorObject(runtime, iterable, WELL_KNOWN_SYMBOLS.iterator), (result) => result);
}

/**
 * The iteration `for await` and an async `yield*` run: the async iterator of the value, or its sync iterator, whose
 * results become promises of the same results with their values awaited, as `CreateAsyncFromSyncIterator` does.
 */
export function asyncIteratorOf(runtime: Runtime, iterable: Value): ProtocolIteration {
  const factory =
    iterable === undefined || iterable === null ? undefined : runtime.get(iterable, WELL_KNOWN_SYMBOLS.asyncIterator);
  if (factory !== undefined && factory !== null) {
    return iterationOf(
      runtime,
      iteratorObject(runtime, iterable, WELL_KNOWN_SYMBOLS.asyncIterator, factory),
      (result) => result
    );
  }
  const iterator = iteratorObject(runtime, iterable, WELL_KNOWN_SYMBOLS.iterator);
  return iterationOf(runtime, iterator, (result) => awaitedResult(runtime, result));
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
  }
}

function checkResult(runtime: Runtime, result: Value): JsObject {
  if (isObject(result)) return result;
  return runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
}

/** Calls the method under `key` to get an iterator, reading the method unless the caller has already read it. */
function iteratorObject(
  runtime: Runtime,
  iterable: Value,
  key: symbol,
  factory = iterable === undefined || iterable === null ? undefined : runtime.get(iterable, key)
): JsObject {
  if (!isCallable(factory)) {
    const what = key === WELL_KNOWN_SYMBOLS.iterator ? 'iterable' : 'async iterable';
    return runtime.throwError('TypeError', `${runtime.describe(iterable)} is not ${what}`);
  }
  const iterator = runtime.call(factory, iterable, [], runtime.currentRow);
  if (!isObject(iterator))
    return runtime.throwError('TypeError', `Result of the ${key.description} method is not an object`);
  return iterator;
}

/** Calls an iterator object's methods, passing each result through `adapt`. */
function iterationOf(runtime: Runtime, iterator: JsObject, adapt: (result: Value) => Value): ProtocolIteration {
  const next = runtime.get(iterator, 'next');
  const method = (name: string): ((...args: Value[]) => Value) | undefined => {
    const fn = runtime.get(iterator, name);
    if (fn === undefined || fn === null) return undefined;
    // The arguments go as given: none for an implicit close, one for a forwarded `return(value)` or `throw(error)`.
    return (...args) => adapt(runtime.call(fn, iterator, args, runtime.currentRow));
  };
  return {
    iterator,
    nextMethod: next,
    next: (...args) => adapt(runtime.call(next, iterator, args, runtime.currentRow)),
    get return() {
      return method('return');
    },
    get throw() {
      return method('throw');
    },
  };
}

/** A promise of a sync iterator's result with its value awaited, keeping whether the iterator is done. */
function awaitedResult(runtime: Runtime, result: Value): JsObject {
  const checked = checkResult(runtime, result);
  const done = toBoolean(runtime.get(checked, 'done'));
  const promise = newPromise(runtime);
  awaitValue(runtime, runtime.get(checked, 'value'), [promise], (settled) => {
    if (settled.kind === 'throw') rejectPromise(runtime, promise, settled.value);
    else resolvePromise(runtime, promise, iteratorResult(runtime, settled.value, done));
  });
  return promise;
}
