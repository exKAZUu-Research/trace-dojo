import { currentRuntime } from './runtimeContext';
import { exceptionClassNamed, newException, newTuple } from './types';
import { type PyClass, PyInstance, type PyValue } from './values';

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

/** Copies a group with other sub-exceptions, keeping its message, cause, context, and notes, as `derive` does. */
export function deriveGroup(group: PyInstance, exceptions: PyInstance[]): PyInstance {
  const state = group.exception;
  const cls = group.cls.isBuiltin
    ? group.cls
    : exceptionClassNamed(isBaseOnly(exceptions) ? 'BaseExceptionGroup' : 'ExceptionGroup');
  const derived = makeExceptionGroup(cls, state?.message ?? '', exceptions);
  const derivedState = derived.exception;
  if (state && derivedState) {
    derivedState.cause = state.cause;
    derivedState.context = state.context;
    derivedState.notes = state.notes;
    derivedState.suppressContext = state.suppressContext;
  }
  return derived;
}

function isBaseOnly(exceptions: PyInstance[]): boolean {
  return exceptions.some((exception) => !exception.cls.isSubclassOf(exceptionClassNamed('Exception')));
}

/** Splits a group into the exceptions that satisfy `predicate` and the rest, keeping its nesting. */
// code-gauge-allow functionCognitiveComplexity 21 -- Follows BaseExceptionGroup.split, which recurses into nested groups.
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
  const match =
    matched.length === 0
      ? undefined
      : matched.length === exceptions.length && rest.length === 0
        ? group
        : deriveGroup(group, matched);
  const remaining =
    rest.length === 0
      ? undefined
      : rest.length === exceptions.length && matched.length === 0
        ? group
        : deriveGroup(group, rest);
  return [match, remaining];
}

export { PyInstance };
