import { UnsupportedFeatureError } from './unsupported';

/**
 * Whether the host's stack ran out, which can happen before the call depth limit when each call nests many statements.
 * Only a type check is safe here: on an exhausted stack, even testing the message may overflow again.
 */
export function isHostStackOverflow(error: unknown): boolean {
  return error instanceof RangeError;
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
