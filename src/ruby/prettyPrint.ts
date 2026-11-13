import { inspect } from './conversions';
import type { Gen } from './interp';
import type { Value } from './objects';

/** The text `pp` writes for a value: its inspect on one line, as PP prints values that fit the width. */
export function* prettyInspect(value: Value): Gen<string> {
  return `${yield* inspect(value)}\n`;
}
