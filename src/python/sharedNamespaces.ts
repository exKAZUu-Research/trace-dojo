import type { PyValue } from './values';

/**
 * The namespaces where a module's code ran once for the classes every run shares, such as abc's for ABCMeta, by the
 * module's name: the functions defined there give each run's module namespace as their `__globals__`, as CPython's
 * functions of that module give its namespace.
 */
export const sharedNamespaceModules = new WeakMap<Map<string, PyValue>, string>();
