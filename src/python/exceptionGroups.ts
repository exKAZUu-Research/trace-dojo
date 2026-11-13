import { callValue, getAttribute } from './objects';
import { currentRuntime } from './runtimeContext';
import { exceptionClassNamed, newException, newTuple, typeError } from './types';
import { type PyClass, PyInstance, PyList, type PyValue } from './values';

/** Creates an exception group of `cls` holding `exceptions`, with its message and sub-exceptions set. */
export function makeExceptionGroup(cls: PyClass, message: string, exceptions: readonly PyValue[]): PyInstance {
  const group = newException(cls, [message, newTuple(exceptions)]);
  const state = group.exception;
  if (state) {
    state.message = message;
    state.exceptions = newTuple(exceptions);
  }
  return group;
}

/**
 * The exception group an `except*` clause splits: the exception itself if it is a group, or a new ExceptionGroup
 * holding it, as Python wraps a naked exception.
 */
export function exceptionGroupOf(exception: PyInstance, exceptions?: PyInstance[]): PyInstance {
  if (exceptions) {
    const group = makeExceptionGroup(exceptionClassNamed('ExceptionGroup'), '', exceptions);
    return group;
  }
  if (exception.exception?.exceptions) return exception;
  const wrapped = wrappedGroups.get(exception);
  if (wrapped) return wrapped;
  const group = makeExceptionGroup(exceptionClassNamed('ExceptionGroup'), '', [exception]);
  wrappedGroups.set(exception, group);
  return group;
}

const wrappedGroups = new WeakMap<PyInstance, PyInstance>();

export function deriveGroup(group: PyInstance, exceptions: PyInstance[]): PyInstance {
  return callValue(exceptionClassNamed('BaseExceptionGroup'), [
    group.exception?.message ?? '',
    newTuple(exceptions),
  ]) as PyInstance;
}

function derivePartition(group: PyInstance, exceptions: PyInstance[]): PyInstance {
  const derived = callValue(getAttribute(group, 'derive'), [newTuple(exceptions)]);
  if (!(derived instanceof PyInstance) || !derived.cls.isSubclassOf(exceptionClassNamed('BaseExceptionGroup'))) {
    throw typeError('derive must return an instance of BaseExceptionGroup');
  }
  const state = group.exception;
  const derivedState = derived.exception;
  if (state && derivedState) {
    derivedState.traceback = state.traceback;
    derivedState.cause = state.cause;
    derivedState.context = state.context;
    derivedState.suppressContext = state.suppressContext;
  }
  const notes = group.dict.get('__notes__');
  if (notes !== undefined) {
    derived.dict.set('__notes__', notes instanceof PyList ? new PyList(notes.cls, [...notes.items]) : notes);
  }
  return derived;
}

/** Splits a group into the exceptions that satisfy `predicate` and the rest, keeping its nesting. */
export function splitGroup(
  group: PyInstance,
  predicate: (exception: PyInstance) => boolean
): [PyInstance | undefined, PyInstance | undefined] {
  if (predicate(group)) return [group, undefined];
  const exceptions = (group.exception?.exceptions?.items ?? []) as PyInstance[];
  if (!group.exception?.exceptions) return [undefined, group];
  const matched: PyInstance[] = [];
  const rest: PyInstance[] = [];
  for (const exception of exceptions) {
    currentRuntime().spend();
    if (exception.exception?.exceptions) {
      const [match, remaining] = splitGroup(exception, predicate);
      if (match) matched.push(match);
      if (remaining) rest.push(remaining);
    } else if (predicate(exception)) {
      matched.push(exception);
    } else {
      rest.push(exception);
    }
  }
  return [
    matched.length === 0 ? undefined : derivePartition(group, matched),
    rest.length === 0 ? undefined : derivePartition(group, rest),
  ];
}

export { PyInstance };
