import { addLayoutAttributes } from './modules/moduleLayout';
import type { Runtime } from './runtime';
import { UNSUPPORTED_SYS_ATTRIBUTES } from './sysAttributes';
import { moduleClass } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyBuiltinFunction, PyModule, type PyValue } from './values';

/** Creates a module's attributes; a module written in Python instead runs its code in `namespace` and returns none. */
type ModuleFactory = (runtime: Runtime, namespace: Map<string, PyValue>) => Map<string, PyValue>;

const factories = new Map<string, ModuleFactory>();
const aliases = new Map<string, string>();
/** The `sys.modules` of each run that read it, which every later import adds its module to. */
const moduleTables = new WeakMap<Runtime, Map<string, PyValue>>();
const unsupportedAttributes = new Map<string, Record<string, string>>();
/** The module each builtin function of a module's namespace belongs to, which its `__module__` names. */
const functionModules = new WeakMap<PyBuiltinFunction, string>();

/**
 * Registers a standard library module, whose namespace is created once per run when first imported. `unsupported`
 * names the attributes this grader does not support, with the feature to name in the error.
 */
export function registerModule(name: string, factory: ModuleFactory, unsupported: Record<string, string> = {}): void {
  factories.set(name, factory);
  registerUnsupportedAttributes(name, unsupported);
}

/** Whether a module of this name is registered, as a submodule a package imports on demand may be. */
export function isRegisteredModule(name: string): boolean {
  return factories.has(name) || aliases.has(name);
}

/** Makes `name` another name of the module `target`, as `os.path` is of `posixpath`. */
export function registerModuleAlias(name: string, target: string): void {
  aliases.set(name, target);
}

/** Makes `table` the run's `sys.modules`, which every later import adds its module to. */
export function trackModules(runtime: Runtime, table: Map<string, PyValue>): void {
  moduleTables.set(runtime, table);
}

const moduleAlls = new Map<string, readonly string[]>();

/** Registers a module's `__all__`, for the modules whose code does not define it. */
export function registerModuleAll(module: string, all: readonly string[]): void {
  moduleAlls.set(module, all);
}

/** Names attributes of a module that this grader does not support, with the feature to name in their error. */
export function registerUnsupportedAttributes(name: string, attributes: Record<string, string>): void {
  unsupportedAttributes.set(name, { ...unsupportedAttributes.get(name), ...attributes });
}

/** Sets how a run creates its `__main__` module, whose namespace is the program's globals. */
export function registerMainModule(create: (runtime: Runtime) => PyModule): void {
  createMainModule = create;
}

let createMainModule: ((runtime: Runtime) => PyModule) | undefined;

export function importModule(runtime: Runtime, name: string): PyModule {
  const cached = runtime.modules.get(name);
  if (cached) return cached;
  if (name === '__main__' && createMainModule) {
    const module = createMainModule(runtime);
    runtime.modules.set(name, module);
    moduleTables.get(runtime)?.set(name, module);
    return module;
  }
  const target = aliases.get(name);
  if (target !== undefined) {
    const module = importModule(runtime, target);
    runtime.modules.set(name, module);
    moduleTables.get(runtime)?.set(name, module);
    return module;
  }
  const factory = factories.get(name);
  if (!factory) throw new UnsupportedFeatureError(`モジュール ${name}`);
  // The builtins module's namespace is the one names fall back to, so that changing either changes the other.
  const module = new PyModule(moduleClass, name, name === 'builtins' ? runtime.builtins : new Map());
  runtime.modules.set(name, module);
  module.dict.set('__name__', name);
  for (const [key, value] of runFactory(runtime, name, factory, module)) module.dict.set(key, value);
  recordFunctionModules(module);
  addRegisteredAttributes(runtime, module);
  addLayoutAttributes(module, name);
  moduleTables.get(runtime)?.set(name, module);
  const dot = name.lastIndexOf('.');
  if (dot !== -1) importModule(runtime, name.slice(0, dot)).dict.set(name.slice(dot + 1), module);
  return module;
}

/** Adds to a new module the names this grader does not support, which its code did not define, and its `__all__`. */
function addRegisteredAttributes(runtime: Runtime, module: PyModule): void {
  const { name, dict } = module;
  const unsupported = name === 'sys' ? UNSUPPORTED_SYS_ATTRIBUTES : unsupportedAttributes.get(name);
  for (const [key, feature] of Object.entries(unsupported ?? {})) {
    if (!dict.has(key)) module.unsupported.set(key, feature);
  }
  const all = moduleAlls.get(name);
  if (all && !dict.has('__all__')) dict.set('__all__', runtime.listOf([...all]));
}

/** Records the module of the builtin functions a module creates, which their `__module__` names. */
function recordFunctionModules(module: PyModule): void {
  for (const value of module.dict.values()) {
    if (value instanceof PyBuiltinFunction && value.self === undefined && !functionModules.has(value)) {
      functionModules.set(value, module.name);
    }
  }
}

function runFactory(runtime: Runtime, name: string, factory: ModuleFactory, module: PyModule): Map<string, PyValue> {
  try {
    return factory(runtime, module.dict);
  } catch (error) {
    // As in CPython, a module whose code failed leaves sys.modules, so that importing it again runs it again.
    runtime.modules.delete(name);
    moduleTables.get(runtime)?.delete(name);
    throw error;
  }
}

/** Makes a builtin function created in one module's namespace say it belongs to another, as `_pickle.dumps` does. */
export function setBuiltinFunctionModule(fn: PyBuiltinFunction, module: string): void {
  functionModules.set(fn, module);
}

/** The `__module__` of a builtin function: the module whose namespace it was created in, if any. */
export function builtinFunctionModule(runtime: Runtime, fn: PyBuiltinFunction): string | undefined {
  if (fn.self instanceof PyModule) return fn.self.name;
  return functionModules.get(fn) ?? (runtime.builtins.get(fn.name) === fn ? 'builtins' : undefined);
}
