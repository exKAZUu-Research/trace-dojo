import type { PyClass, PyValue } from './values';

/**
 * The functions a native metaclass has as Python functions in CPython, by metaclass: what a program reading one gets,
 * while the interpreter's own dispatch keeps using the native method.
 */
const metaclassFunctions = new Map<PyClass, (name: string) => PyValue | undefined>();

export function registerMetaclassFunctions(metaclass: PyClass, lookup: (name: string) => PyValue | undefined): void {
  metaclassFunctions.set(metaclass, lookup);
}

/** The Python function a program reads as attribute `name` of a native metaclass, if CPython defines one. */
export function metaclassFunction(metaclass: PyClass, name: string): PyValue | undefined {
  return metaclassFunctions.get(metaclass)?.(name);
}
