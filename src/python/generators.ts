import { addressOf } from './conversions';
import { method } from './define';
import type { Frame } from './frame';
import { bindValue, callValue, getAttribute, getIterator, lookupSpecial } from './objects';
import type { Suspension } from './suspendingEvaluator';
import { isWaitRequest, schedulerOf } from './threads';
import {
  asyncGeneratorClass,
  baseExceptionClass,
  coroutineClass,
  exceptionClassNamed,
  generatorClass,
  isInstanceOf,
  newException,
  None,
  pyError,
  typeError,
  typeName,
} from './types';
import {
  DONE,
  type GeneratorInput,
  PyClass,
  PyError,
  PyGenerator,
  PyInstance,
  PyIterator,
  type PyObject,
  PyTuple,
  type PyValue,
} from './values';

type Step = IteratorResult<PyValue, PyValue>;

method(
  generatorClass,
  '__repr__',
  'none',
  0,
  0,
  (self) => `<generator object ${(self as PyGenerator).qualifiedName} at ${addressOf(self as PyObject)}>`
);
method(generatorClass, '__iter__', 'none', 0, 0, (self) => self);
method(generatorClass, '__next__', 'none', 0, 0, (self) => generatorNext(self as PyGenerator, { value: None }));
method(generatorClass, 'send', 'one', 1, 1, (self, [value]) => generatorNext(self as PyGenerator, { value }));
method(generatorClass, 'throw', 'expected', 1, 3, (self, args) =>
  generatorNext(self as PyGenerator, { error: thrownError(args) })
);
method(generatorClass, 'close', 'none', 0, 0, (self) => closeGenerator(self as PyGenerator));

/** Resumes a generator as `next()` or `send()` does, raising StopIteration with its return value when it ends. */
export function generatorNext(generator: PyGenerator, input: GeneratorInput): PyValue {
  const step = resumeGenerator(generator, input);
  if (!step.done) return step.value;
  throw step.value === None
    ? pyError('StopIteration')
    : new PyError(newException(exceptionClassNamed('StopIteration'), [step.value]));
}

// code-gauge-allow functionCognitiveComplexity 17 -- Checks each state of a generator object as CPython does before resuming its frame.
/**
 * Resumes a generator with the value its `yield` evaluates to or the exception it raises there, returning what it
 * yields next or, when it ends, what it returns.
 */
export function resumeGenerator(generator: PyGenerator, input: GeneratorInput): Step {
  const kind = generatorKind(generator);
  if (generator.running)
    throw pyError(kind === 'generator' ? 'ValueError' : 'RuntimeError', `${kind} already executing`);
  if (generator.finished) {
    if (kind === 'coroutine') throw pyError('RuntimeError', 'cannot reuse already awaited coroutine');
    if (input.error) throw input.error;
    return { done: true, value: None };
  }
  if (!generator.started && !input.error && input.value !== None) {
    throw typeError(`can't send non-None value to a just-started ${kind}`);
  }
  generator.started = true;
  generator.running = true;
  try {
    let step = generator.resume(input);
    // A blocking operation in the generator's frame waits in the thread resuming it, which a native call runs.
    while (!step.done && isWaitRequest(step.value)) {
      schedulerOf().waitFor(step.value);
      step = generator.resume({ value: None });
    }
    if (step.done) generator.finished = true;
    return step;
  } catch (error) {
    generator.finished = true;
    throw error instanceof PyError && leaks(error, kind) ? stopIterationLeak(error, kind) : error;
  } finally {
    generator.running = false;
  }
}

/** What error messages call a generator object, which coroutines and async generators share the machinery of. */
function generatorKind(generator: PyGenerator): 'generator' | 'coroutine' | 'async generator' {
  if (generator.cls === coroutineClass) return 'coroutine';
  return generator.cls === asyncGeneratorClass ? 'async generator' : 'generator';
}

/** Whether an exception escaping a generator's frame becomes a RuntimeError, as PEP 479 and PEP 525 require. */
function leaks(error: PyError, kind: string): boolean {
  return isStopIteration(error) || (kind === 'async generator' && isStopAsyncIteration(error));
}

/** `generator.close()`: raises GeneratorExit where the generator is suspended, returning what it then returns. */
export function closeGenerator(generator: PyGenerator): PyValue {
  if (generator.finished) return None;
  if (!generator.started) {
    generator.finished = true;
    return None;
  }
  try {
    const step = resumeGenerator(generator, {
      error: new PyError(newException(exceptionClassNamed('GeneratorExit'), [])),
    });
    if (!step.done) throw pyError('RuntimeError', 'generator ignored GeneratorExit');
    return step.value;
  } catch (error) {
    if (error instanceof PyError && isGeneratorExit(error)) return None;
    throw error;
  }
}

/** `yield from iterable`: passes what the generator receives to the iterator until it ends, giving what it returns. */
export function* delegateTo(iterable: PyValue, frame: Frame): Suspension {
  const iterator = getIterator(iterable);
  const length = frame.temporaries.length;
  frame.temporaries.push(iterator);
  try {
    let input: GeneratorInput = { value: None };
    for (;;) {
      const step = delegateStep(iterator, input);
      if (step.done) return step.value;
      try {
        input = { value: yield step.value };
      } catch (error) {
        if (!(error instanceof PyError)) throw error;
        input = { error };
      }
    }
  } finally {
    frame.temporaries.length = length;
  }
}

/** Passes one input to the iterator a `yield from` or an `await` delegates to, returning what it yields or returns. */
// code-gauge-allow functionCognitiveComplexity 17 -- Follows how `yield from` passes each kind of input to a generator or another iterator.
export function delegateStep(iterator: PyValue, input: GeneratorInput): Step {
  const { error } = input;
  if (error && isGeneratorExit(error)) {
    if (iterator instanceof PyGenerator) closeGenerator(iterator);
    else {
      const close = lookupSpecial(iterator, 'close');
      if (close !== undefined) callValue(bindValue(close, iterator), []);
    }
    throw error;
  }
  if (iterator instanceof PyGenerator) return resumeGenerator(iterator, input);
  if (error) {
    const throwMethod = lookupSpecial(iterator, 'throw');
    if (throwMethod === undefined) throw error;
    return untilStopIteration(() => callValue(bindValue(throwMethod, iterator), [error.exception]));
  }
  if (input.value !== None) return untilStopIteration(() => callValue(getAttribute(iterator, 'send'), [input.value]));
  if (iterator instanceof PyIterator) {
    const value = iterator.next();
    return value === DONE ? { done: true, value: None } : { done: false, value };
  }
  const next = lookupSpecial(iterator, '__next__');
  if (next === undefined) throw typeError(`'${typeName(iterator)}' object is not an iterator`);
  return untilStopIteration(() => callValue(bindValue(next, iterator), []));
}

/** Runs a step of an iterator that is no generator, reading the StopIteration that ends it as its return value. */
function untilStopIteration(run: () => PyValue): Step {
  try {
    return { done: false, value: run() };
  } catch (error) {
    if (!(error instanceof PyError) || !isStopIteration(error)) throw error;
    return { done: true, value: error.exception.exception?.args.items[0] ?? None };
  }
}

/** The exception `generator.throw()` raises: a class, called with the value, or an instance. */
// code-gauge-allow functionCognitiveComplexity 21 -- Follows how `generator.throw()` normalizes each form of its arguments.
export function thrownError([type, value, traceback]: PyValue[]): PyError {
  if (traceback !== undefined && traceback !== None)
    throw typeError('throw() third argument must be a traceback object');
  if (type instanceof PyClass && type.isSubclassOf(baseExceptionClass)) {
    if (value !== undefined && value !== None && isInstanceOf(value, type)) return new PyError(value as PyInstance);
    const args = value === undefined || value === None ? [] : value instanceof PyTuple ? value.items : [value];
    const instance = callValue(type, [...args]);
    if (!(instance instanceof PyInstance) || !instance.exception) {
      throw typeError(
        `calling ${pyClassText(type)} should have returned an instance of BaseException, not ${typeName(instance)}`
      );
    }
    return new PyError(instance);
  }
  if (type instanceof PyInstance && type.exception) {
    if (value !== undefined && value !== None) throw typeError('instance exception may not have a separate value');
    return new PyError(type);
  }
  throw typeError(`exceptions must be classes or instances deriving from BaseException, not ${typeName(type)}`);
}

function pyClassText(cls: PyClass): string {
  return `<class '${cls.module === 'builtins' ? '' : `${cls.module}.`}${cls.qualifiedName}'>`;
}

/** The RuntimeError that replaces a StopIteration escaping a generator, as PEP 479 requires. */
function stopIterationLeak(error: PyError, kind: string): PyError {
  const name = isStopIteration(error) ? 'StopIteration' : 'StopAsyncIteration';
  const replacement = pyError('RuntimeError', `${kind} raised ${name}`);
  const state = replacement.exception.exception;
  if (state) {
    state.cause = error.exception;
    state.context = error.exception;
    state.suppressContext = true;
  }
  return replacement;
}

function isStopIteration(error: PyError): boolean {
  return error.exception.cls.isSubclassOf(exceptionClassNamed('StopIteration'));
}

function isStopAsyncIteration(error: PyError): boolean {
  return error.exception.cls.isSubclassOf(exceptionClassNamed('StopAsyncIteration'));
}

export function isGeneratorExit(error: PyError): boolean {
  return error.exception.cls.isSubclassOf(exceptionClassNamed('GeneratorExit'));
}
