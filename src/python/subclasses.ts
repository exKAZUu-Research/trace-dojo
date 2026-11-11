import { runningRuntime } from './runtimeContext';
import type { PyClass } from './values';

/**
 * The direct subclasses of each class, in the order they were created: those created while no program runs, as the
 * builtin classes are, under `BUILTIN`, and those of a run under its runtime, since builtin classes outlive runs.
 */
const tables = new WeakMap<object, Map<PyClass, PyClass[]>>();
const BUILTIN = {};

/** The order of the classes each run created and of the modules it imported, in one count per run. */
const counters = new WeakMap<object, { next: number }>();
const sequences = new WeakMap<PyClass, number>();
/** The classes a run's program created, as opposed to the code of a standard library module. */
const programClasses = new WeakSet<PyClass>();
/** Tells whether the running code is the program's, which the runtime answers once it exists. */
let inProgramCode: (runtime: object) => boolean = () => false;

export function setProgramCodeCheck(check: (runtime: object) => boolean): void {
  inProgramCode = check;
}

/** The next number in a run's order of classes and modules. */
export function nextSequence(runtime: object): number {
  let counter = counters.get(runtime);
  if (!counter) counters.set(runtime, (counter = { next: 0 }));
  return counter.next++;
}

/** Records a new class as a subclass of each of its bases, which `type.__subclasses__` returns. */
export function recordSubclass(cls: PyClass): void {
  const run = runningRuntime();
  const key = run ?? BUILTIN;
  let table = tables.get(key);
  if (!table) tables.set(key, (table = new Map()));
  for (const base of cls.bases) table.set(base, [...(table.get(base) ?? []), cls]);
  if (!run) return;
  sequences.set(cls, nextSequence(run));
  if (inProgramCode(run)) programClasses.add(cls);
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

/** The subclasses of `cls` this grader created while no program runs, which every run shares. */
export function builtinSubclasses(cls: PyClass): PyClass[] {
  return tables.get(BUILTIN)?.get(cls) ?? [];
}

/** The subclasses of `cls` a run created, with the place of each in the run's order. */
export function runSubclasses(run: object, cls: PyClass): [PyClass, number][] {
  return (tables.get(run)?.get(cls) ?? []).map((each) => [each, sequences.get(each) ?? 0]);
}

/** Whether a run's program created a class, as opposed to a module's code or this grader. */
export function isProgramClass(cls: PyClass): boolean {
  return programClasses.has(cls);
}

/** Drops from a run's lists the classes that `gc.collect()` frees, which nothing reaches. */
export function collectSubclasses(run: object, reachable: Set<object>): void {
  const table = tables.get(run);
  if (!table) return;
  for (const [base, subclasses] of table) {
    const alive = subclasses.filter((each) => reachable.has(each));
    if (alive.length !== subclasses.length) table.set(base, alive);
  }
}

/** Records that a class assigned `__bases__` now derives from `base` too, after the run's classes so far. */
export function recordNewBase(cls: PyClass, base: PyClass): void {
  const run = runningRuntime();
  const key = run ?? BUILTIN;
  let table = tables.get(key);
  if (!table) tables.set(key, (table = new Map()));
  table.set(base, [...(table.get(base) ?? []).filter((each) => each !== cls), cls]);
  if (run) sequences.set(cls, nextSequence(run));
}

/** The classes recorded as deriving from `cls` directly, in a run or shared, which still do. */
export function recordedSubclasses(run: object, cls: PyClass): PyClass[] {
  const all = [...builtinSubclasses(cls), ...(tables.get(run)?.get(cls) ?? [])];
  return all.filter((each) => each.bases.includes(cls));
}

/** Every class created while no program ran, as the builtin classes are, from `object` down. */
export function allBuiltinClasses(): PyClass[] {
  const table = tables.get(BUILTIN);
  const found: PyClass[] = [];
  const seen = new Set<PyClass>();
  const visit = (cls: PyClass): void => {
    if (seen.has(cls)) return;
    seen.add(cls);
    found.push(cls);
    for (const sub of table?.get(cls) ?? []) visit(sub);
  };
  for (const root of roots) visit(root);
  return found;
}

/** The classes without bases, from which every builtin class descends. */
const roots: PyClass[] = [];

/** Records a class without bases, such as `object`, whose subclasses `allBuiltinClasses` walks. */
export function recordRootClass(cls: PyClass): void {
  roots.push(cls);
}
