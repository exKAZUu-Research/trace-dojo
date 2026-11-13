import { builtin } from '../define';
import { absentModule, isSupportedModule, missingCodecModule, unsupportedModuleFeature } from '../moduleNames';
import { getModuleTable, moduleNotFoundError, registerModule, reloadModule, resolveImport } from '../modules';
import { getAttribute, isTruthy } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { nativeFunction, None, typeError, valueError } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { type Kwargs, PyInstance, PyModule, type PyValue } from '../values';
import { bindArguments } from './numberSupport';

/** `__import__(name, globals=None, locals=None, fromlist=(), level=0)`, for the modules this grader implements. */
export function dunderImport(args: PyValue[], kwargs: Kwargs): PyValue {
  const bound = bindArguments(
    {
      qualified: '__import__',
      params: ['name', 'globals', 'locals', 'fromlist', 'level'],
      required: 1,
      isFunction: true,
    },
    args,
    kwargs
  );
  const [name, fromlist, level] = [bound[0], bound[3], bound[4]];
  if (typeof name !== 'string') throw typeError('module name must be a string');
  if (level !== undefined && level !== 0n) throw new UnsupportedFeatureError('相対 import（__import__() の level）');
  const module = importByName(name);
  if (fromlist !== undefined && fromlist !== None && isTruthy(fromlist)) return module;
  return importByName(name.split('.')[0]);
}

/** Imports a module by its absolute name, as an import statement would. */
function importByName(name: string): PyValue {
  if (name === '') throw valueError('Empty module name');
  const missing = missingCodecModule(name);
  if (missing !== undefined) throw moduleNotFoundError(`No module named '${missing}'`, missing);
  const runtime = currentRuntime();
  if (!isSupportedModule(name) && !runtime.modules.has(name) && !getModuleTable(runtime)?.has(name)) {
    const absent = absentModule(name, runtime.inLibraryCode());
    if (absent) throw moduleNotFoundError(absent.message, absent.name);
    throw new UnsupportedFeatureError(unsupportedModuleFeature(name));
  }
  return resolveImport(runtime, name);
}

registerModule(
  'importlib',
  () =>
    new Map<string, PyValue>([
      ['__doc__', 'A pure Python implementation of import.'],
      [
        'import_module',
        nativeFunction('import_module', (args, kwargs) => {
          const [name] = bindArguments(
            { qualified: 'import_module', params: ['name', 'package'], required: 1, isFunction: true },
            args,
            kwargs
          );
          const text = name instanceof PyInstance && typeof name.primitive === 'string' ? name.primitive : name;
          if (typeof text !== 'string') getAttribute(name as PyValue, 'startswith');
          if ((text as string).startsWith('.')) throw new UnsupportedFeatureError('相対 import（from . import）');
          return importByName(text as string);
        }),
      ],
      // The finders of the standard library, the only modules a program may import here, cache nothing to drop.
      ['invalidate_caches', builtin('invalidate_caches', 'none', 0, 0, () => None)],
      [
        'reload',
        builtin('reload', 'one', 1, 1, ([module]) => {
          if (!(module instanceof PyModule)) throw typeError('reload() argument must be a module');
          return reloadModule(currentRuntime(), module);
        }),
      ],
    ]),
  {
    resources: 'importlib.resources',
    metadata: 'importlib.metadata',
    util: 'importlib.util',
    machinery: 'importlib.machinery',
  }
);
