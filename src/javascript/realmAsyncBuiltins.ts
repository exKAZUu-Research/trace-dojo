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
  const method = isAsync ? asyncMethod : runtime.get(items, WELL_KNOWN_SYMBOLS.iterator);
  return runtime.hold(array, () => {
    if (method === undefined || method === null) return fromArrayLike(context, items, add, array);
    const iterator = runtime.call(method, items, []);
    if (!isObject(iterator)) runtime.throwError('TypeError', 'Result of the Symbol.iterator method is not an object');
    const nextMethod = runtime.get(iterator, 'next');
    context.roots.push(iterator, nextMethod);
    const step = isAsync ? asyncStep : syncStep;
    const loop = (): Step => step(context, iterator, runtime.call(nextMethod, iterator, []), add, loop, array);
    return loop();
  });
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

/** Awaits the result of an async iterator's `next`, closing the iterator when appending its value fails. */
function asyncStep(
  context: AwaitContext,
  iterator: JsObject,
  result: Value,
  add: Add,
  loop: () => Step,
  array: JsArray
): Step {
  const { runtime, promise } = context;
  const reject: Failure = (reason) => rejectPromise(runtime, promise, reason);
  // AsyncIteratorClose awaits what `return` returns before the failure is reported.
  const closeAndReject: Failure = (reason) =>
    settleWith(runtime, promise, reject, () => {
      const close = runtime.get(iterator, 'return');
      if (close === undefined || close === null) throw new JsThrow(reason);
      return awaitValue(context, runtime.call(close, iterator, []), reject, () => {
        throw new JsThrow(reason);
      });
    });
  return awaitValue(context, result, reject, (settledResult) => {
    if (!isObject(settledResult)) {
      runtime.throwError('TypeError', `Iterator result ${runtime.describe(settledResult)} is not an object`);
    }
    if (toBoolean(runtime.get(settledResult, 'done'))) return array;
    const value = runtime.get(settledResult, 'value');
    return guarded(closeAndReject, () => add(value, closeAndReject, loop));
  });
}

/**
 * Steps a sync iterator as the async-from-sync iterator does: awaits each value to settle the step's result, which the
 * loop then awaits. A failure closes the iterator through the async-from-sync `return`, whose result takes one more
 * await before the rejection.
 */
function syncStep(
  context: AwaitContext,
  iterator: JsObject,
  result: Value,
  add: Add,
  loop: () => Step,
  array: JsArray
): Step {
  const { runtime, promise } = context;
  if (!isObject(result))
    runtime.throwError('TypeError', `Iterator result ${runtime.describe(result)} is not an object`);
  const done = toBoolean(runtime.get(result, 'done'));
  const value = runtime.get(result, 'value');
  const reject: Failure = (reason) => rejectPromise(runtime, promise, reason);
  const closeAndReject: Failure = (reason) =>
    settleWith(runtime, promise, reject, () => {
      const close = runtime.get(iterator, 'return');
      if (close !== undefined && close !== null) runtime.call(close, iterator, []);
      return awaitValue(context, undefined, reject, () => {
        throw new JsThrow(reason);
      });
    });
  // A rejected value rejects the step's result, which the loop's await of it then reports.
  const rejectStep: Failure = (reason) =>
    awaitValue(context, undefined, reject, () =>
      guarded(closeAndReject, () => {
        throw new JsThrow(reason);
      })
    );
  return awaitValue(context, value, rejectStep, (settled) =>
    awaitValue(context, undefined, reject, () =>
      done ? array : guarded(closeAndReject, () => add(settled, closeAndReject, loop))
    )
  );
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
