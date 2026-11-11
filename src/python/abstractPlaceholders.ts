import type { PyValue } from './values';

/**
 * The builtin placeholders of abstract methods, such as those of `numbers`, which a subclass must override and whose
 * `__isabstractmethod__` is true, as for CPython's abstract methods.
 */
export const abstractPlaceholders = new Set<PyValue>();
