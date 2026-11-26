import type { Frame } from './runtime';
import type { Value } from './values';

/** Reads a `lateinit` property's value, which throws before the property is first assigned. */
export function uninitializedCheck(frame: Frame, value: Value, name: string): Value {
  if (value === undefined)
    frame.runtime.throwError(
      frame,
      'kotlin.UninitializedPropertyAccessException',
      `lateinit property ${name} has not been initialized`
    );
  return value;
}
