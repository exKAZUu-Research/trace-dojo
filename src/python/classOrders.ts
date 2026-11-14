import { CLASS_ORDERS } from './data/namespaceDifferences';
import { PyClass } from './values';

let enabled = true;

/** Turns the ordering off, for scripts/checkPythonDicts.ts, which compares the orders this grader gives. */
export function applyClassOrders(on: boolean): void {
  enabled = on;
}

/** Orders the namespace of a builtin or library class as CPython's, whose order its type's creation gives. */
export function orderClassNamespace(cls: PyClass): void {
  const order = enabled ? CLASS_ORDERS[`${cls.module}.${cls.qualifiedName}`] : undefined;
  if (order === undefined) return;
  const entries = new Map(cls.dict);
  cls.dict.clear();
  for (const key of order.split(' ')) {
    const value = entries.get(key);
    if (value === undefined) continue;
    cls.dict.set(key, value);
    entries.delete(key);
  }
  for (const [key, value] of entries) cls.dict.set(key, value);
}

/** Orders the namespaces of the classes a module defines, and of the classes they define. */
export function orderModuleClasses(values: Iterable<unknown>, seen = new Set<PyClass>()): void {
  for (const value of values) {
    if (!(value instanceof PyClass) || seen.has(value)) continue;
    seen.add(value);
    orderClassNamespace(value);
    orderModuleClasses(value.dict.values(), seen);
  }
}
