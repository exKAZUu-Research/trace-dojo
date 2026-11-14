// `type.__subclasses__()`: the direct subclasses of a class alive in a run, in the order CPython created them. The
// builtin classes of a module come with the module, imported as CPython's imports would import it, and a class is in
// a reference cycle with its `__mro__`, so one that nothing reaches stays until `gc.collect()` frees it.
import { cpythonImports, derivesFrom, STARTUP_MODULES, STARTUP_SUBCLASSED } from './data/moduleImports';
import { addModuleCreationHook, isSourceModule } from './modules';
import type { Runtime } from './runtime';
import { builtinSubclasses, isProgramClass, nextSequence, runSubclasses, setProgramCodeCheck } from './subclasses';
import { UnsupportedFeatureError } from './unsupported';
import type { PyClass } from './values';

/** The place in each run's order where the run imported each module. */
const moduleOrders = new WeakMap<object, Map<string, number>>();
/** How many modules each run is creating, inside one another. */
const creatingModules = new WeakMap<object, number>();

addModuleCreationHook((runtime, name) => {
  let orders = moduleOrders.get(runtime);
  if (!orders) moduleOrders.set(runtime, (orders = new Map()));
  // Only the program's imports: the ones this grader's modules make may not be CPython's.
  const byProgram = (creatingModules.get(runtime) ?? 0) === 0 && !runtime.inLibraryCode();
  if (byProgram && !orders.has(name)) orders.set(name, nextSequence(runtime));
  creatingModules.set(runtime, (creatingModules.get(runtime) ?? 0) + 1);
  return () => creatingModules.set(runtime, (creatingModules.get(runtime) ?? 1) - 1);
});

setProgramCodeCheck((runtime) => !(runtime as Runtime).inLibraryCode() && (creatingModules.get(runtime) ?? 0) === 0);

/**
 * The modules CPython would have imported by now, with the place in the run's order where it would have: those of its
 * startup first, then those the run's imports import in CPython, from the first import that does.
 */
function cpythonModules(runtime: Runtime): Map<string, number> {
  const loaded = new Map<string, number>();
  for (const name of STARTUP_MODULES) loaded.set(name, -1);
  const orders = [...(moduleOrders.get(runtime) ?? [])].toSorted(([, a], [, b]) => a - b);
  for (const [name, order] of orders) {
    for (const each of [name, ...cpythonImports(name)]) if (!loaded.has(each)) loaded.set(each, order);
  }
  return loaded;
}

function unsupported(): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    '標準ライブラリのクラスの __subclasses__() のうち、CPython の起動時やモジュールの読み込みで作られるサブクラスを含むもの'
  );
}

/** `cls.__subclasses__()`, failing as unsupported where CPython's answer has classes this grader cannot tell. */
export function subclassesOf(runtime: Runtime, cls: PyClass): PyClass[] {
  // The standard library's code, such as pydoc's listing of a builtin type's builtin subclasses, reads what there is.
  const strict = !runtime.inLibraryCode();
  const modules = cpythonModules(runtime);
  if (strict) refuseUnknowable(runtime, cls, modules);
  const entries: [PyClass, number][] = [];
  for (const each of builtinSubclasses(cls)) {
    const order = each.module === 'builtins' ? -1 : modules.get(each.module);
    if (order !== undefined) entries.push([each, order]);
  }
  // The classes of a module's code count only where CPython would have run that code.
  const created = runSubclasses(runtime, cls).filter(([each]) => isProgramClass(each) || modules.has(each.module));
  if (strict && created.length > 0) {
    const reachable = runtime.reachableObjects([cls]);
    if (created.some(([each]) => !reachable.has(each))) {
      throw new UnsupportedFeatureError(
        '参照されなくなったクラスが、ガベージコレクションで回収されるまでの __subclasses__()'
      );
    }
  }
  return [...entries, ...created]
    .filter(([each]) => each.bases.includes(cls))
    .toSorted(([, a], [, b]) => a - b)
    .map(([each]) => each);
}

/**
 * Refuses a class whose subclasses CPython's startup creates in modules a program cannot import, or the code of a
 * module CPython would have run, but this run has not, may create.
 */
function refuseUnknowable(runtime: Runtime, cls: PyClass, modules: Map<string, number>): void {
  const key = `${cls.module ?? 'builtins'}.${cls.qualifiedName}`;
  if (STARTUP_SUBCLASSED.has(key)) throw unsupported();
  if (isProgramClass(cls)) return;
  for (const name of modules.keys()) {
    const notRun = !STARTUP_MODULES.has(name) && !runtime.modules.has(name) && isSourceModule(name);
    if (notRun && derivesFrom(name, key)) throw unsupported();
  }
}
