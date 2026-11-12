import { asyncIteratorOf, type ProtocolIteration } from './iteratorProtocol';
import { newPromise, performThen, promiseResolve, rejectPromise, resolvePromise, resolvingFunctions } from './promises';
import type { RealmBuilder } from './realm';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  isCallable,
  isObject,
  type JsArray,
  JsFunction,
  type JsObject,
  JsThrow,
  toBoolean,
  type Value,
} from './values';

/** Defines `Promise.withResolvers`, `Promise.try`, and `Array.fromAsync`. */
export function defineAsyncBuiltins(builder: RealmBuilder): void {
  const promiseConstructor = globalFunction(builder, 'Promise');
  builder.method(promiseConstructor, 'withResolvers', 0, ({ runtime }) => {
    const promise = newPromise(runtime);
    const { resolve, reject } = resolvingFunctions(runtime, promise);
    const result = runtime.newObject();
    runtime.createDataProperty(result, 'promise', promise);
    runtime.createDataProperty(result, 'resolve', resolve);
    runtime.createDataProperty(result, 'reject', reject);
    return result;
  });
  builder.method(promiseConstructor, 'try', 1, ({ runtime, args, callRow }) => {
    const promise = newPromise(runtime);
    const reject = (reason: Value): void => rejectPromise(runtime, promise, reason);
    runtime.hold(promise, () =>
      settleWith(runtime, promise, reject, () => runtime.call(args[0], undefined, args.slice(1), callRow))
    );
    return promise;
  });
  builder.method(globalFunction(builder, 'Array'), 'fromAsync', 1, ({ runtime, args }) => {
    const promise = newPromise(runtime);
    const reject = (reason: Value): void => rejectPromise(runtime, promise, reason);
    runtime.hold(promise, () => settleWith(runtime, promise, reject, () => startFromAsync(runtime, promise, args)));
    return promise;
  });
}

function globalFunction(builder: RealmBuilder, name: string): JsFunction {
  const fn = builder.realm.globals.bindings.get(name)?.value;
  if (!(fn instanceof JsFunction)) throw new Error(`${name} must be defined first`);
  return fn;
}

/** What a step of `Array.fromAsync` returns when it settles its promise later, after an await. */
const PENDING = Symbol('pending');

type Step = Value | typeof PENDING;

/** What fails the promise of `Array.fromAsync`: rejecting it, or closing its iterator first. */
type Failure = (reason: Value) => void;

/** Resolves the promise with what `run` returns, unless it is still pending, or fails it with what `run` throws. */
function settleWith(runtime: Runtime, promise: JsObject, fail: Failure, run: () => Step): void {
  let result: Step;
  try {
    result = run();
  } catch (error) {
    if (!(error instanceof JsThrow)) throw error;
    fail(error.value);
    return;
  }
  if (result !== PENDING) resolvePromise(runtime, promise, result);
}

interface AwaitContext {
  runtime: Runtime;
  promise: JsObject;
  roots: Value[];
}

/** The spec's Await: runs `then` with the settled value in a microtask, failing when it rejects or `then` throws. */
function awaitValue(
  context: AwaitContext,
  value: Value,
  fail: Failure,
  then: (settled: Value) => Step
): typeof PENDING {
  const { runtime, promise, roots } = context;
  performThen(runtime, promiseResolve(runtime, value), {
    onFulfilled: (settled) => settleWith(runtime, promise, fail, () => then(settled)),
    onRejected: fail,
    roots: [promise, ...roots],
  });
  return PENDING;
}

/** Appends a value, mapped and awaited first when there is a mapper, then takes the next step. */
type Add = (value: Value, fail: Failure, next: () => Step) => Step;

/** The spec's Array.fromAsync, which awaits each value (and each mapped value) before taking the next. */
function startFromAsync(runtime: Runtime, promise: JsObject, args: Value[]): Step {
  const [items, mapper, thisArg] = args;
  if (mapper !== undefined && !isCallable(mapper)) {
    runtime.throwError('TypeError', `${runtime.describe(mapper)} is not a function`);
  }
  if (items === undefined || items === null) runtime.throwError('TypeError', `${String(items)} is not iterable`);
  const array = runtime.newArray([]);
  const context: AwaitContext = { runtime, promise, roots: [array, items, mapper, thisArg] };
  let index = 0;
  const add: Add = (value, fail, next) => {
    const append = (item: Value): Step => {
      runtime.allocate(1);
      array.elements.push(item);
      return next();
    };
    return mapper ? awaitValue(context, runtime.call(mapper, thisArg, [value, index++]), fail, append) : append(value);
  };
  const asyncMethod = runtime.get(items, WELL_KNOWN_SYMBOLS.asyncIterator);
  const isAsync = asyncMethod !== undefined && asyncMethod !== null;
  const method = isAsync ? undefined : runtime.get(items, WELL_KNOWN_SYMBOLS.iterator);
  return runtime.hold(array, () => {
    if (!isAsync && (method === undefined || method === null)) return fromArrayLike(context, items, add, array);
    const iteration = asyncIteratorOf(runtime, items, { async: asyncMethod, sync: method });
    context.roots.push(iteration.iterator, iteration.nextMethod);
    const loop = (): Step => iterationStep(context, iteration, add, loop, array);
    return loop();
  });
}

/**
 * Takes one step of the iteration, awaiting its result. As V8's Array.fromAsync does, every failure, of `next`, of its
 * promise, of reading its result, or of appending its value, closes the iterator before the promise rejects; a sync
 * iterator's own adapter has closed it once already when its step failed.
 */
function iterationStep(
  context: AwaitContext,
  iteration: ProtocolIteration,
  add: Add,
  loop: () => Step,
  array: JsArray
): Step {
  const { runtime, promise } = context;
  const reject: Failure = (reason) => rejectPromise(runtime, promise, reason);
  // AsyncIteratorClose awaits what `return` returns, and the failure that closed the iterator wins over its own.
  const closeAndReject: Failure = (reason) => {
    const rejectWithReason = (): void => reject(reason);
    let closed: Value;
    try {
      const close = iteration.return;
      if (!close) return reject(reason);
      closed = close();
    } catch (error) {
      if (!(error instanceof JsThrow)) throw error;
      return reject(reason);
    }
    awaitValue(context, closed, rejectWithReason, () => {
      rejectWithReason();
      return PENDING;
    });
  };
  return guarded(closeAndReject, () =>
    awaitValue(context, iteration.next(), closeAndReject, (result) =>
      guarded(closeAndReject, () => {
        if (!isObject(result)) runtime.throwError('TypeError', 'Iterator result Array.fromAsync is not an object');
        if (toBoolean(runtime.get(result, 'done'))) return array;
        return add(runtime.get(result, 'value'), closeAndReject, loop);
      })
    )
  );
}

/** Runs a step whose exceptions fail through `fail`, as the steps after an iterator's value is taken do. */
function guarded(fail: Failure, run: () => Step): Step {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof JsThrow)) throw error;
    fail(error.value);
    return PENDING;
  }
}

function fromArrayLike(context: AwaitContext, items: Value, add: Add, array: JsArray): Step {
  const { runtime, promise } = context;
  const reject: Failure = (reason) => rejectPromise(runtime, promise, reason);
  const object = runtime.toObject(items);
  const length = Math.max(0, Math.min(Math.trunc(runtime.toNumber(runtime.get(object, 'length'))) || 0, 2 ** 53 - 1));
  context.roots.push(object);
  const loop = (index: number): Step => {
    if (index >= length) return array;
    return awaitValue(context, runtime.get(object, String(index)), reject, (value) =>
      add(value, reject, () => loop(index + 1))
    );
  };
  return loop(0);
}
