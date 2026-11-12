import { createDynamicClass } from '../classes';
import { builtin } from '../define';
import { runLibrarySource } from '../librarySource';
import { mappingProxyClass } from '../mappingProxy';
import { importModule, registerModule } from '../modules';
import { toArray } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { genericAliasClass } from '../typeHints';
import { newDict, None, typeError } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { PyClass, type PyDict, type PyValue } from '../values';
import { DATACLASSES_SOURCE } from './dataclassesSource';
import { PYTHON_KEYWORDS } from './keywords';

registerModule('dataclasses', () => runLibrarySource('dataclasses', DATACLASSES_SOURCE, nativeHelpers()));

/** The natives the Python source of dataclasses uses in place of `exec` and of the modules CPython's imports. */
function nativeHelpers(): Map<string, PyValue> {
  return new Map<string, PyValue>([
    ['_MappingProxyType', mappingProxyClass],
    ['_GenericAlias', genericAliasClass],
    [
      '_exec_source',
      builtin('_exec_source', 'expected', 2, 2, ([source, module]) =>
        newDict(runLibrarySource(module as string, source as string).entries())
      ),
    ],
    ['_imported_module', builtin('_imported_module', 'expected', 1, 2, ([name, force]) => importedModule(name, force))],
    ['_module_namespace', builtin('_module_namespace', 'one', 1, 1, ([name]) => moduleNamespace(name as string))],
    [
      '_get_annotations',
      builtin('_get_annotations', 'one', 1, 1, ([cls]) => newDict(currentRuntime().classAnnotations(cls as PyClass))),
    ],
    [
      '_set_annotations',
      builtin('_set_annotations', 'expected', 2, 2, ([cls, annotations]) => {
        const entries = (annotations as PyDict).store.ordered().map((entry): [string, () => PyValue] => {
          const { value } = entry;
          return [entry.key as string, () => value];
        });
        (cls as PyClass).annotationNames = entries.map(([name]) => name);
        (cls as PyClass).annotations = undefined;
        currentRuntime().classAnnotationThunks.set(cls as PyClass, entries);
        return None;
      }),
    ],
    ['_iskeyword', builtin('_iskeyword', 'one', 1, 1, ([name]) => PYTHON_KEYWORDS.has(name as string))],
    [
      '_new_class',
      builtin('_new_class', 'expected', 4, 4, ([name, bases, namespace, module]) => {
        const classes = toArray(bases);
        for (const base of classes) if (!(base instanceof PyClass)) throw typeError('bases must be types');
        const entries = (namespace as PyDict).store
          .ordered()
          .map((entry): [string, PyValue] => [entry.key as string, entry.value]);
        return createDynamicClass(name as string, classes as PyClass[], new Map(entries), module as string);
      }),
    ],
    [
      '_unsupported',
      builtin('_unsupported', 'one', 1, 1, ([feature]) => {
        throw new UnsupportedFeatureError(feature as string);
      }),
    ],
  ]);
}

function importedModule(name: PyValue, force: PyValue | undefined): PyValue {
  const runtime = currentRuntime();
  if (force === true) return importModule(runtime, name as string);
  return runtime.modules.get(name as string) ?? None;
}

/** The namespace of a module as a dict, the program's for `__main__`, or None for a module not imported. */
function moduleNamespace(name: string): PyValue {
  const runtime = currentRuntime();
  if (name === '__main__') return newDict(runtime.frames[0].globals.entries());
  const module = runtime.modules.get(name);
  return module === undefined ? None : newDict(module.dict.entries());
}
