import { UnsupportedFeatureError } from './unsupported';

/**
 * Whether the host's stack ran out, which can happen before the call depth limit when each call nests many statements,
 * as opposed to a RangeError from a string, array, or integer beyond what the host can hold.
 */
export function isHostStackOverflow(error: unknown): boolean {
  if (!(error instanceof RangeError)) return false;
  try {
    // JavaScriptCore and V8 both word it "Maximum call stack size exceeded".
    return error.message.includes('call stack');
  } catch {
    // Reading the message overflowed again, so the stack is exhausted.
    return true;
  }
}

/** The depth of a syntax tree this grader evaluates within any host's stack; deeper code may exhaust it. */
export const SAFE_NESTING_DEPTH = 300;

/**
 * The error of a program nested more deeply than the host's stack lets this grader parse or evaluate, which CPython
 * runs up to its parser's limits.
 */
export function deepNestingError(): UnsupportedFeatureError {
  return new UnsupportedFeatureError('この採点環境で扱える深さを超えて入れ子にした式や文');
}
