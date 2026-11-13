// Coroutines and async generators: the objects `async def` creates, which share the machinery of generators, and the
// protocols of `await`, `async for`, and `async with`.
import { addressOf } from './conversions';
import { FINALIZER_FEATURE, method, unsupportedMethod, unsupportedSizeof } from './define';
import type { Frame } from './frame';
import {
  closeGenerator,
  delegateStep,
  generatorNext,
  isGeneratorExit,
  resumeGenerator,
  setDelegate,
  thrownError,
} from './generators';
import { bindValue, callValue, getAttributeOrUndefined, isTruthy, lookupSpecial } from './objects';
import type { Runtime } from './runtime';
import { currentRuntime } from './runtimeContext';
import type { Suspension } from './suspendingEvaluator';
import { peekThreadAsyncGenHooks, type ThreadAsyncGenHooks, threadAsyncGenHooks } from './threads';
import {
  asyncGeneratorClass,
  builtinClass,
  coroutineClass,
  exceptionClassNamed,
  isIteratorGenerator,
  newException,
  None,
  pyError,
  typeError,
  typeName,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  type GeneratorInput,
  PyBoundMethod,
  type PyClass,
  PyError,
  PyFunction,
  PyGenerator,
  PyOpaque,
  type PyValue,
} from './values';

type Step = IteratorResult<PyValue, PyValue>;

const coroutineWrapperClass = builtinClass('coroutine_wrapper');
const asendClass = builtinClass('async_generator_asend');
const athrowClass = builtinClass('async_generator_athrow');
const anextAwaitableClass = builtinClass('anext_awaitable');

/** The value an async generator's `yield` passes out, which its awaitables tell from what its `await` passes on. */
class AsyncYield {
  constructor(readonly value: PyValue) {}
}

/** What an async generator's frame yields for `yield value`. */
export function asyncYield(value: PyValue): PyValue {
  return new AsyncYield(value) as unknown as PyValue;
}

/** The state of an async generator that its awaitables share, which CPython keeps in the generator object. */
interface AsyncGeneratorState {
  /** Whether an awaitable of it is running its frame, which another awaitable must not start meanwhile. */
  runningAsync: boolean;
  closed: boolean;
  hooksInitialized: boolean;
  /** What closes the generator when nothing refers to it any more, from the hooks when it was first iterated. */
  finalizer?: PyValue;
  /** Whether the finalizer is the program's, from `sys.set_asyncgen_hooks()`, rather than the event loop's. */
  finalizerFromProgram?: boolean;
  hooks?: ThreadAsyncGenHooks;
}

const asyncGeneratorStates = new WeakMap<PyGenerator, AsyncGeneratorState>();

function stateOf(generator: PyGenerator): AsyncGeneratorState {
  let state = asyncGeneratorStates.get(generator);
  if (!state) {
    state = { runningAsync: false, closed: false, hooksInitialized: false };
    asyncGeneratorStates.set(generator, state);
  }
  return state;
}

/** Sets the finalizer of the event loop, which may not run while the program's own hooks are set. */
export function setAsyncGeneratorFinalizer(runtime: Runtime, finalizer: PyValue | undefined): void {
  const hooks = threadAsyncGenHooks(runtime);
  const { program } = hooks;
  if (program.firstiter !== undefined || program.finalizer !== undefined) {
    throw new UnsupportedFeatureError('sys.set_asyncgen_hooks() で設定したフックのままの asyncio のイベントループ');
  }
  hooks.finalizer = finalizer;
}

/** The hooks the program set with `sys.set_asyncgen_hooks()`, which `sys.get_asyncgen_hooks()` gives. */
export function programAsyncGeneratorHooks(runtime: Runtime): ThreadAsyncGenHooks['program'] {
  return threadAsyncGenHooks(runtime).program;
}

/** Whether an async generator's finalizer is the program's, which calling at the end of the program is not matched. */
export function hasProgramFinalizer(generator: PyGenerator): boolean {
  return stateOf(generator).finalizerFromProgram === true;
}

/** Whether nothing referring to an unfinished async generator any more calls a finalizer. */
export function hasAsyncGeneratorFinalizer(generator: PyGenerator): boolean {
  return asyncGeneratorStates.get(generator)?.finalizer !== undefined;
}

/** Takes the async generators first iterated under the thread's hooks that have not finished, as the loop closes them. */
export function takeUnfinishedAsyncGenerators(runtime: Runtime): PyGenerator[] {
  const hooks = peekThreadAsyncGenHooks(runtime);
  if (!hooks) return [];
  const unfinished = hooks.started.filter((generator) => !generator.finished && !stateOf(generator).closed);
  hooks.started.length = 0;
  return unfinished;
}

/**
 * Hands an async generator that nothing refers to any more to its finalizer, which schedules its `aclose()`, returning
 * whether it had one; one without is closed as a generator is.
 */
export function finalizeAsyncGenerator(generator: PyGenerator): boolean {
  const state = stateOf(generator);
  const { finalizer, hooks } = state;
  if (finalizer === undefined) return false;
  if (hooks) hooks.started.splice(hooks.started.indexOf(generator) >>> 0, hooks.started.includes(generator) ? 1 : 0);
  callValue(finalizer, [generator]);
  return true;
}

// Coroutines ----------------------------------------------------------------------------------------------------------

const generatorRepr = (self: PyValue): string => {
  const generator = self as PyGenerator;
  return `<${generator.cls.name} object ${generator.qualifiedName} at ${addressOf(generator)}>`;
};

method(coroutineClass, '__repr__', 'none', 0, 0, generatorRepr);
method(coroutineClass, 'send', 'one', 1, 1, (self, [value]) => generatorNext(self as PyGenerator, { value }));
method(coroutineClass, 'throw', 'expected', 1, 3, (self, args) =>
  generatorNext(self as PyGenerator, { error: thrownError(args) })
);
method(coroutineClass, 'close', 'none', 0, 0, (self) => closeGenerator(self as PyGenerator));
method(coroutineClass, '__await__', 'none', 0, 0, (self) => {
  const coroutine = self as PyGenerator;
  return new PyGenerator(
    coroutineWrapperClass,
    coroutine.name,
    coroutine.qualifiedName,
    (input) => resumeGenerator(coroutine, input),
    () => [coroutine]
  );
});
const wrappedCoroutine = (self: PyValue): PyGenerator => [...(self as PyGenerator).holds()][0] as PyGenerator;
method(coroutineWrapperClass, '__iter__', 'none', 0, 0, (self) => self);
method(coroutineWrapperClass, '__next__', 'none', 0, 0, (self) =>
  generatorNext(wrappedCoroutine(self), { value: None })
);
method(coroutineWrapperClass, 'send', 'one', 1, 1, (self, [value]) => generatorNext(wrappedCoroutine(self), { value }));
method(coroutineWrapperClass, 'throw', 'expected', 1, 3, (self, args) =>
  generatorNext(wrappedCoroutine(self), { error: thrownError(args) })
);
method(coroutineWrapperClass, 'close', 'none', 0, 0, (self) => closeGenerator(wrappedCoroutine(self)));

/** Gives an awaitable helper object the methods of an iterator that a coroutine delegates to. */
function defineIteratorMethods(cls: PyClass): void {
  method(cls, '__iter__', 'none', 0, 0, (self) => self);
  method(cls, '__await__', 'none', 0, 0, (self) => self);
  method(cls, '__next__', 'none', 0, 0, (self) => generatorNext(self as PyGenerator, { value: None }));
  method(cls, 'send', 'one', 1, 1, (self, [value]) => generatorNext(self as PyGenerator, { value }));
  method(cls, 'throw', 'expected', 1, 3, (self, args) =>
    generatorNext(self as PyGenerator, { error: thrownError(args) })
  );
  method(cls, 'close', 'none', 0, 0, (self) => {
    try {
      return closeGenerator(self as PyGenerator);
    } catch (error) {
      if (isStopAsyncIteration(error)) return None;
      throw error;
    }
  });
}

// Kinds ---------------------------------------------------------------------------------------------------------------

/** The generator functions `types.coroutine` decorated, whose generators an `await` accepts. */
const iterableCoroutineFunctions = new WeakSet<PyFunction>();
/** The generators of those functions, which CPython marks with CO_ITERABLE_COROUTINE. */
const iterableCoroutines = new WeakSet<PyGenerator>();

/** `types.coroutine` of a generator function: its generators become awaitable, as CO_ITERABLE_COROUTINE makes them. */
export function makeIterableCoroutine(fn: PyFunction): void {
  iterableCoroutineFunctions.add(fn);
}

/** Marks a generator whose function `types.coroutine` decorated, or that its wrapper returned, as awaitable. */
export function markIterableCoroutine(generator: PyGenerator, fn?: PyFunction): void {
  if (fn === undefined || iterableCoroutineFunctions.has(fn)) iterableCoroutines.add(generator);
}

export function isCoroutine(value: PyValue): boolean {
  return value instanceof PyGenerator && value.cls === coroutineClass;
}

export function isAsyncGenerator(value: PyValue): boolean {
  return value instanceof PyGenerator && value.cls === asyncGeneratorClass;
}

function isIterableCoroutine(value: PyValue): boolean {
  return value instanceof PyGenerator && iterableCoroutines.has(value);
}

/** Whether a value is a coroutine, or implements `collections.abc.Coroutine` as the awaitables of async generators do. */
export function isCoroutineLike(value: PyValue): boolean {
  if (isCoroutine(value)) return true;
  return ['__await__', 'send', 'throw', 'close'].every((name) => lookupSpecial(value, name) !== undefined);
}

/** `inspect.isawaitable`. */
export function isAwaitable(value: PyValue): boolean {
  return isCoroutine(value) || isIterableCoroutine(value) || lookupSpecial(value, '__await__') !== undefined;
}

/** The function a method or a `functools.partial` calls, as `inspect` unwraps them. */
function unwrapFunction(value: PyValue): PyValue {
  let fn = value;
  for (;;) {
    if (fn instanceof PyBoundMethod) fn = fn.fn;
    else if (fn instanceof PyOpaque && fn.text === 'partial') fn = (fn.data as { fn: PyValue }).fn;
    else return fn;
  }
}

/** `inspect.iscoroutinefunction`: an `async def` without `yield`, or one `inspect.markcoroutinefunction` marked. */
export function isCoroutineFunction(value: PyValue): boolean {
  const fn = unwrapFunction(value);
  if (!(fn instanceof PyFunction)) return false;
  if (fn.def.scope.isAsync === true && !fn.def.scope.isGenerator) return true;
  const marker = getAttributeOrUndefined(fn, '_is_coroutine_marker');
  return marker !== undefined && isTruthy(marker);
}

/** `inspect.isasyncgenfunction`: an `async def` with `yield`. */
export function isAsyncGeneratorFunction(value: PyValue): boolean {
  const fn = unwrapFunction(value);
  return fn instanceof PyFunction && fn.def.scope.isAsync === true && fn.def.scope.isGenerator;
}

// Await ---------------------------------------------------------------------------------------------------------------

/** The coroutines an `await` is delegating to, which another `await` must not resume meanwhile. */
const awaited = new WeakSet<PyGenerator>();

/** The iterator an `await` delegates to: a coroutine itself, or what the awaitable's `__await__` returns. */
export function awaitIterator(value: PyValue): PyValue {
  if (value instanceof PyGenerator && value.cls === coroutineClass) {
    if (value.finished) throw pyError('RuntimeError', 'cannot reuse already awaited coroutine');
    if (awaited.has(value)) throw pyError('RuntimeError', 'coroutine is being awaited already');
    return value;
  }
  if (isIterableCoroutine(value)) return value;
  const awaitMethod = lookupSpecial(value, '__await__');
  if (awaitMethod === undefined) throw typeError(`'${typeName(value)}' object can't be awaited`);
  const iterator = callValue(bindValue(awaitMethod, value), []);
  if (iterator instanceof PyGenerator && iterator.cls === coroutineClass) {
    throw typeError('__await__() returned a coroutine');
  }
  if (!isIteratorGenerator(iterator) && lookupSpecial(iterator, '__next__') === undefined) {
    throw typeError(`__await__() returned non-iterator of type '${typeName(iterator)}'`);
  }
  return iterator;
}

/**
 * `await value` at `row`: passes what the running coroutine receives to the awaitable's iterator until it ends, giving
 * what it returns. An awaited coroutine's frame reports `row` as its call line.
 */
export function* awaitValue(value: PyValue, frame: Frame, row: number | undefined): Suspension {
  const iterator = awaitIterator(value);
  const runtime = currentRuntime();
  const length = frame.temporaries.length;
  frame.temporaries.push(iterator);
  const isCoroutine = iterator instanceof PyGenerator && iterator.cls === coroutineClass;
  if (isCoroutine) awaited.add(iterator);
  setDelegate(frame, iterator);
  try {
    let input: GeneratorInput = { value: None };
    for (;;) {
      const outerRow = runtime.currentRow;
      runtime.currentRow = row;
      let step: Step;
      try {
        step = delegateStep(iterator, input);
      } finally {
        runtime.currentRow = outerRow;
      }
      if (step.done) return step.value;
      try {
        input = { value: yield step.value };
      } catch (error) {
        if (!(error instanceof PyError)) throw error;
        input = { error };
      }
    }
  } finally {
    if (isCoroutine) awaited.delete(iterator);
    setDelegate(frame, undefined);
    frame.temporaries.length = length;
  }
}

// Async iteration -----------------------------------------------------------------------------------------------------

/** The async iterator an `async for` loops over, from the iterable's `__aiter__`. */
export function asyncIterator(iterable: PyValue, context = "'async for'"): PyValue {
  const aiter = lookupSpecial(iterable, '__aiter__');
  if (aiter === undefined)
    throw typeError(`${context} requires an object with __aiter__ method, got ${typeName(iterable)}`);
  const iterator = callValue(bindValue(aiter, iterable), []);
  if (lookupSpecial(iterator, '__anext__') === undefined) {
    throw typeError(
      `${context} received an object from __aiter__ that does not implement __anext__: ${typeName(iterator)}`
    );
  }
  return iterator;
}

/** The awaitable of an async iterator's next item, from its `__anext__`. */
export function nextAwaitable(iterator: PyValue): PyValue {
  const anext = lookupSpecial(iterator, '__anext__');
  if (anext === undefined) throw typeError(`'${typeName(iterator)}' object is not an async iterator`);
  const awaitable = callValue(bindValue(anext, iterator), []);
  if (!(awaitable instanceof PyGenerator) && lookupSpecial(awaitable, '__await__') === undefined) {
    throw typeError(`'async for' received an invalid object from __anext__: ${typeName(awaitable)}`);
  }
  return awaitable;
}

export function isStopAsyncIteration(error: unknown): error is PyError {
  return error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('StopAsyncIteration'));
}

/** `aiter(iterable)`. */
export function aiter(iterable: PyValue): PyValue {
  const method = lookupSpecial(iterable, '__aiter__');
  if (method === undefined) throw typeError(`'${typeName(iterable)}' object is not an async iterable`);
  const iterator = callValue(bindValue(method, iterable), []);
  if (lookupSpecial(iterator, '__anext__') === undefined) {
    throw typeError(`aiter() returned not an async iterator of type '${typeName(iterator)}'`);
  }
  return iterator;
}

/** `anext(iterator[, default])`: an awaitable giving the next item, or `fallback` when the iterator is exhausted. */
export function anext(iterator: PyValue, fallback: PyValue | undefined): PyValue {
  const anextMethod = lookupSpecial(iterator, '__anext__');
  if (anextMethod === undefined) throw typeError(`'${typeName(iterator)}' object is not an async iterator`);
  const awaitable = callValue(bindValue(anextMethod, iterator), []);
  if (fallback === undefined) return awaitable;
  let inner: PyValue | undefined;
  return new PyGenerator(
    anextAwaitableClass,
    'anext_awaitable',
    'anext_awaitable',
    (input) => {
      inner ??= awaitIterator(awaitable);
      try {
        return delegateStep(inner, input);
      } catch (error) {
        if (isStopAsyncIteration(error)) return { done: true, value: fallback };
        throw error;
      }
    },
    () => [awaitable, inner, fallback]
  );
}
defineIteratorMethods(anextAwaitableClass);

// Async generators ----------------------------------------------------------------------------------------------------

method(asyncGeneratorClass, '__repr__', 'none', 0, 0, generatorRepr);
method(asyncGeneratorClass, '__aiter__', 'none', 0, 0, (self) => self);
method(asyncGeneratorClass, '__anext__', 'none', 0, 0, (self) => asend(self as PyGenerator, None, '__anext__'));
method(asyncGeneratorClass, 'asend', 'one', 1, 1, (self, [value]) => asend(self as PyGenerator, value, 'asend'));
method(asyncGeneratorClass, 'athrow', 'expected', 1, 3, (self, args) => athrow(self as PyGenerator, args));
method(asyncGeneratorClass, 'aclose', 'none', 0, 0, (self) => athrow(self as PyGenerator, undefined));
defineIteratorMethods(asendClass);
defineIteratorMethods(athrowClass);
for (const cls of [coroutineClass, asyncGeneratorClass, asendClass, athrowClass]) {
  unsupportedMethod(cls, '__del__', FINALIZER_FEATURE);
}
unsupportedSizeof(coroutineClass);
unsupportedSizeof(asyncGeneratorClass);

function initializeHooks(generator: PyGenerator): AsyncGeneratorState {
  const state = stateOf(generator);
  if (!state.hooksInitialized) {
    state.hooksInitialized = true;
    const hooks = peekThreadAsyncGenHooks(currentRuntime());
    const program = hooks?.program;
    if (program?.finalizer !== undefined) {
      state.finalizer = program.finalizer;
      state.finalizerFromProgram = true;
    } else if (hooks?.finalizer !== undefined) {
      state.finalizer = hooks.finalizer;
      state.hooks = hooks;
      hooks.started.push(generator);
    }
    if (program?.firstiter !== undefined) callValue(program.firstiter, [generator]);
  }
  return state;
}

/** Reads what an async generator's frame did: yielded a value (which ends the awaitable), awaited, or returned. */
function unwrap(state: AsyncGeneratorState, run: () => Step): Step {
  let step: Step;
  try {
    step = run();
  } catch (error) {
    state.runningAsync = false;
    throw error;
  }
  if (step.done) {
    state.runningAsync = false;
    throw pyError('StopAsyncIteration');
  }
  if (step.value instanceof AsyncYield) {
    state.runningAsync = false;
    return { done: true, value: (step.value as AsyncYield).value };
  }
  return step;
}

/** `agen.asend(value)` and `agen.__anext__()`: an awaitable that runs the generator to its next `yield`. */
function asend(generator: PyGenerator, value: PyValue, name: string): PyValue {
  const state = initializeHooks(generator);
  let started = false;
  return new PyGenerator(
    asendClass,
    name,
    name,
    (input) => {
      if (!started) {
        if (state.runningAsync) {
          throw pyError('RuntimeError', 'anext(): asynchronous generator is already running');
        }
        started = true;
        state.runningAsync = true;
        const first: GeneratorInput = input.error || input.value !== None ? input : { value };
        return unwrap(state, () => resumeGenerator(generator, first));
      }
      return unwrap(state, () => resumeGenerator(generator, input));
    },
    () => [generator, value]
  );
}

// code-gauge-allow functionCognitiveComplexity 18 -- Follows the states of CPython's async_generator_athrow.
/** `agen.athrow(...)`, or `agen.aclose()` when `args` is undefined: an awaitable that raises in the generator. */
function athrow(generator: PyGenerator, args: PyValue[] | undefined): PyValue {
  const state = initializeHooks(generator);
  const thrown = args && thrownError(args);
  let started = false;
  const name = args ? 'athrow' : 'aclose';
  return new PyGenerator(
    athrowClass,
    name,
    name,
    (input) => {
      try {
        if (started) return athrowStep(generator, state, args === undefined, () => resumeGenerator(generator, input));
        if (state.runningAsync) throw pyError('RuntimeError', `${name}(): asynchronous generator is already running`);
        if (state.closed || generator.finished) throw pyError('StopAsyncIteration');
        started = true;
        state.runningAsync = true;
        if (args === undefined) state.closed = true;
        const error = thrown ?? new PyError(newException(exceptionClassNamed('GeneratorExit'), []));
        return athrowStep(generator, state, args === undefined, () => resumeGenerator(generator, { error }));
      } catch (error) {
        state.runningAsync = false;
        if (args === undefined && error instanceof PyError && (isStopAsyncIteration(error) || isGeneratorExit(error))) {
          return { done: true, value: None };
        }
        throw error;
      }
    },
    () => [generator, thrown?.exception]
  );
}

function athrowStep(generator: PyGenerator, state: AsyncGeneratorState, closing: boolean, run: () => Step): Step {
  if (!closing) return unwrap(state, run);
  const step = run();
  if (step.done) throw pyError('StopAsyncIteration');
  if (step.value instanceof AsyncYield) {
    throw pyError('RuntimeError', 'async generator ignored GeneratorExit');
  }
  return step;
}

/** The async generators started and not finished, which an event loop closes when it shuts down. */
export function isUnfinishedAsyncGenerator(value: PyValue): boolean {
  return value instanceof PyGenerator && value.cls === asyncGeneratorClass && value.started && !value.finished;
}
