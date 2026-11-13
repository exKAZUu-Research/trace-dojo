// Calling and iterating where the running thread can suspend: a wait in a function called back, or in a generator
// read, suspends the thread, as the scheduler expects, instead of waiting on the host's stack.
import { resumeGeneratorSuspending } from './generators';
import { bindValue, callValue, getIterator, lookupSpecial, type NextFunction } from './objects';
import { releaseCaughtException } from './runtimeContext';
import type { Suspension } from './suspendingEvaluator';
import { suspendingCall } from './threads';
import { exceptionClassNamed, isIteratorGenerator, None, typeError, typeName } from './types';
import { DONE, type Kwargs, PyError, PyIterator, type PyValue } from './values';

/** Reads the next item of an iterator, or DONE at its end, suspending the thread where reading it waits. */
export type SuspendingNext = () => Suspension<PyValue | typeof DONE>;

/** Calls a value, suspending the thread where a wait in the call suspends it. */
export function* callSuspending(callee: PyValue, args: PyValue[], kwargs?: Kwargs): Suspension {
  const suspension = suspendingCall(callee, args, kwargs);
  return suspension ? yield* suspension : callValue(callee, args, kwargs);
}

/** The ways native iterators that call back into Python, such as a map object's, read their next item suspending. */
const suspendingNexts = new WeakMap<NextFunction, SuspendingNext>();

/** Records how a native iterator's next function reads its next item where the thread can suspend. */
export function withSuspendingNext(next: NextFunction, suspending: SuspendingNext): NextFunction {
  suspendingNexts.set(next, suspending);
  return next;
}

/** Iterates a value as `iter()` would, reading each item so that a wait while reading it suspends the thread. */
export function iterateSuspending(iterable: PyValue): SuspendingNext {
  return suspendingNextOf(getIterator(iterable));
}

/** How to read the next item of an iterator so that a wait while reading it suspends the thread. */
export function suspendingNextOf(iterator: PyValue): SuspendingNext {
  if (isIteratorGenerator(iterator)) {
    return function* () {
      const step = yield* resumeGeneratorSuspending(iterator, { value: None });
      return step.done ? DONE : step.value;
    };
  }
  if (iterator instanceof PyIterator && iterator.cls.isBuiltin) {
    const { next } = iterator;
    return (
      suspendingNexts.get(next) ??
      // oxlint-disable-next-line require-yield -- The items of other native iterators need no suspension.
      function* () {
        return next();
      }
    );
  }
  const method = lookupSpecial(iterator, '__next__');
  if (method === undefined) throw typeError(`'${typeName(iterator)}' object is not an iterator`);
  const bound = bindValue(method, iterator);
  return function* () {
    try {
      return yield* callSuspending(bound, []);
    } catch (error) {
      if (error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('StopIteration'))) {
        releaseCaughtException(error);
        return DONE;
      }
      throw error;
    }
  };
}

/** The items of an iterable, read so that a wait while reading them suspends the thread. */
export function* itemsSuspending(iterable: PyValue): Suspension<PyValue[]> {
  const next = iterateSuspending(iterable);
  const items: PyValue[] = [];
  for (let item = yield* next(); item !== DONE; item = yield* next()) items.push(item);
  return items;
}
