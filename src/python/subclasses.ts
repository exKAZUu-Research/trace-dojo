import { runningRuntime } from './runtimeContext';
import type { PyClass } from './values';

/**
 * The direct subclasses of each class, in the order they were created: those created while no program runs, as the
 * builtin classes are, under `BUILTIN`, and those of a run under its runtime, since builtin classes outlive runs.
 */
const tables = new WeakMap<object, WeakMap<PyClass, PyClass[]>>();
const BUILTIN = {};

/** Records a new class as a subclass of each of its bases, which `type.__subclasses__` returns. */
export function recordSubclass(cls: PyClass): void {
  const key = runningRuntime() ?? BUILTIN;
  let table = tables.get(key);
  if (!table) tables.set(key, (table = new WeakMap()));
  for (const base of cls.bases) table.set(base, [...(table.get(base) ?? []), cls]);
}

/** Leaves out of `type.__subclasses__` a class that stands in for its base where CPython uses the base itself. */
export function hideSubclass(cls: PyClass): void {
  for (const base of cls.bases) {
    const table = tables.get(BUILTIN);
    table?.set(
      base,
      (table.get(base) ?? []).filter((each) => each !== cls)
    );
  }
}

/**
 * `type.__subclasses__()`: the direct subclasses of a class, those builtin first. A builtin class of a module not
 * loaded yet, such as `enum.IntEnum`, is one CPython has not created yet.
 */
export function subclassesOf(cls: PyClass, isLoaded: (module: string) => boolean): PyClass[] {
  const run = runningRuntime();
  const builtin = (tables.get(BUILTIN)?.get(cls) ?? []).filter(
    (each) => each.module === 'builtins' || isLoaded(each.module)
  );
  const created = run === undefined ? [] : (tables.get(run)?.get(cls) ?? []);
  return [...builtin, ...created].filter((each) => each.bases.includes(cls));
}
