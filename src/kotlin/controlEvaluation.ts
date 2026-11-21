import type { Eval } from './compilerBase';
import { type Frame, KotlinThrow, ReturnSignal, UNASSIGNED } from './runtime';
import { type KObject, UNIT, type Value } from './values';

interface CatchClause {
  test: (value: KObject) => boolean;
  write: (frame: Frame, value: KObject) => void;
  slot: number;
  value: Eval;
}

export function ifEval(test: Eval, thenEval: Eval, elseEval: Eval | undefined): Eval {
  if (elseEval) return (frame) => (test(frame) ? thenEval(frame) : elseEval(frame));
  return (frame) => {
    if (test(frame)) thenEval(frame);
    return UNIT;
  };
}

export function tryEval(body: Eval, catches: CatchClause[], finallyEval: Eval | undefined): Eval {
  const execute: Eval = (frame) => evaluateTryBody(frame, body, catches);
  if (!finallyEval) return execute;
  return (frame) => {
    let pending: Value;
    try {
      pending = execute(frame);
      return pending;
    } catch (error) {
      if (error instanceof ReturnSignal || error instanceof KotlinThrow) pending = error.value;
      throw error;
    } finally {
      frame.runtime.withNativeRoots([pending], () => finallyEval(frame));
    }
  };
}

function evaluateTryBody(frame: Frame, body: Eval, catches: CatchClause[]): Value {
  try {
    return body(frame);
  } catch (error) {
    const thrown = throwableOf(frame, error);
    if (!thrown) throw error;
    const clause = catches.find((candidate) => candidate.test(thrown));
    if (!clause) throw error instanceof KotlinThrow ? error : new KotlinThrow(thrown);
    clause.write(frame, thrown);
    try {
      return clause.value(frame);
    } finally {
      frame.locals[clause.slot] = UNASSIGNED;
    }
  }
}

/** The exception a `catch` sees: a Kotlin exception, or the host's stack overflow as `StackOverflowError`. */
function throwableOf(frame: Frame, error: unknown): KObject | undefined {
  if (error instanceof KotlinThrow) return error.value;
  if (error instanceof RangeError && /call stack/i.test(error.message)) {
    return frame.runtime.exceptions.create(frame, 'java.lang.StackOverflowError', undefined);
  }
  return undefined;
}

/** Runs the first branch of a `when` whose conditions hold, with the subject held in its slot meanwhile. */
export function whenEval(
  subjectEval: Eval | undefined,
  subjectSlot: number,
  entries: { tests: ((frame: Frame) => boolean)[]; body: Eval }[]
): Eval {
  return (frame) => {
    if (subjectEval) frame.locals[subjectSlot] = subjectEval(frame);
    try {
      for (const entry of entries) {
        if (entry.tests.length === 0 || entry.tests.some((test) => test(frame))) return entry.body(frame);
      }
      return UNIT;
    } finally {
      if (subjectEval) frame.locals[subjectSlot] = UNASSIGNED;
    }
  };
}

export function discardResult(evaluate: Eval): Eval {
  return (frame) => {
    evaluate(frame);
    return UNIT;
  };
}
