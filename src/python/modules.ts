import type { Runtime } from './runtime';
import { UNSUPPORTED_SYS_ATTRIBUTES } from './sysAttributes';
import { moduleClass } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyModule, type PyValue } from './values';

/** Creates a module's attributes; a module written in Python instead runs its code in `namespace` and returns none. */
type ModuleFactory = (runtime: Runtime, namespace: Map<string, PyValue>) => Map<string, PyValue>;

const factories = new Map<string, ModuleFactory>();
const aliases = new Map<string, string>();
/** The `sys.modules` of each run that read it, which every later import adds its module to. */
const moduleTables = new WeakMap<Runtime, Map<string, PyValue>>();
const unsupportedAttributes = new Map<string, Record<string, string>>();

/**
 * Registers a standard library module, whose namespace is created once per run when first imported. `unsupported`
 * names the attributes this grader does not support, with the feature to name in the error.
 */
export function registerModule(name: string, factory: ModuleFactory, unsupported: Record<string, string> = {}): void {
  factories.set(name, factory);
  unsupportedAttributes.set(name, unsupported);
}

/** Makes `name` another name of the module `target`, as `os.path` is of `posixpath`. */
export function registerModuleAlias(name: string, target: string): void {
  aliases.set(name, target);
}

/** Makes `table` the run's `sys.modules`, which every later import adds its module to. */
export function trackModules(runtime: Runtime, table: Map<string, PyValue>): void {
  moduleTables.set(runtime, table);
}

/** Names attributes of a module that this grader does not support, with the feature to name in their error. */
export function registerUnsupportedAttributes(name: string, attributes: Record<string, string>): void {
  unsupportedAttributes.set(name, attributes);
}

export function importModule(runtime: Runtime, name: string): PyModule {
  const cached = runtime.modules.get(name);
  if (cached) return cached;
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
  const unsupported = name === 'sys' ? UNSUPPORTED_SYS_ATTRIBUTES : unsupportedAttributes.get(name);
  for (const [key, feature] of Object.entries(unsupported ?? {})) module.unsupported.set(key, feature);
  moduleTables.get(runtime)?.set(name, module);
  const dot = name.lastIndexOf('.');
  if (dot !== -1) importModule(runtime, name.slice(0, dot)).dict.set(name.slice(dot + 1), module);
  return module;
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
