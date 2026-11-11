import type { Runtime } from './runtime';
import { UNSUPPORTED_SYS_ATTRIBUTES } from './sysAttributes';
import { moduleClass } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyModule, type PyValue } from './values';

type ModuleFactory = (runtime: Runtime) => Map<string, PyValue>;

const factories = new Map<string, ModuleFactory>();
const lazyAttributes = new Map<string, Map<string, (runtime: Runtime) => PyValue>>();
const unsupportedAttributes = new Map<string, Record<string, string>>([['sys', UNSUPPORTED_SYS_ATTRIBUTES]]);

/** Registers the attributes of a module this grader does not support, with the feature each error names. */
export function registerUnsupportedAttributes(module: string, features: Record<string, string>): void {
  unsupportedAttributes.set(module, { ...unsupportedAttributes.get(module), ...features });
}

/** Registers a standard library module, whose namespace is created once per run when first imported. */
export function registerModule(name: string, factory: ModuleFactory): void {
  factories.set(name, factory);
}

/**
 * Registers attributes of a module that are created when a program first reads them, such as the classes of
 * collections that standard library code written in Python defines, so that importing the module stays cheap.
 */
export function registerLazyAttributes(
  module: string,
  names: readonly string[],
  create: (runtime: Runtime, name: string) => PyValue
): void {
  let attributes = lazyAttributes.get(module);
  if (!attributes) {
    attributes = new Map();
    lazyAttributes.set(module, attributes);
  }
  for (const name of names) attributes.set(name, (runtime) => create(runtime, name));
}

export function importModule(runtime: Runtime, name: string): PyModule {
  const cached = runtime.modules.get(name);
  if (cached) return cached;
  const factory = factories.get(name);
  if (!factory) throw new UnsupportedFeatureError(`モジュール ${name}`);
  const module = new PyModule(moduleClass, name, new Map());
  runtime.modules.set(name, module);
  module.dict.set('__name__', name);
  for (const [key, value] of factory(runtime)) module.dict.set(key, value);
  for (const [key, create] of lazyAttributes.get(name) ?? []) module.lazy.set(key, () => create(runtime));
  for (const [key, feature] of Object.entries(unsupportedAttributes.get(name) ?? {})) {
    if (!module.dict.has(key)) module.unsupported.set(key, feature);
  }
  return module;
}
