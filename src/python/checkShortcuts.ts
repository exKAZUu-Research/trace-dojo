import type { PyClass, PyValue } from './values';

/**
 * The native code that `__instancecheck__` and `__subclasscheck__` functions written in Python call and nothing else,
 * as ABCMeta's call `_abc`, which isinstance() and issubclass() run directly instead of the functions, saving a frame.
 */
export const checkShortcuts = new Map<PyValue, (cls: PyClass, value: PyValue) => PyValue>();
