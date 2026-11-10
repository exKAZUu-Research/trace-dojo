import type { Runtime } from './runtime';
import { UNSUPPORTED_SYS_ATTRIBUTES } from './sysAttributes';
import { moduleClass } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyModule, type PyValue } from './values';

type ModuleFactory = (runtime: Runtime) => Map<string, PyValue>;

const factories = new Map<string, ModuleFactory>();

/** Registers a standard library module, whose namespace is created once per run when first imported. */
export function registerModule(name: string, factory: ModuleFactory): void {
  factories.set(name, factory);
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
  if (name === 'sys')
    for (const [key, feature] of Object.entries(UNSUPPORTED_SYS_ATTRIBUTES)) module.unsupported.set(key, feature);
  return module;
}
