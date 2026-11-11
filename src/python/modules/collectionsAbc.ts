import { checkMethods, initAbstractClass } from '../abstractClasses';
import { builtin } from '../define';
import { runLibrarySource } from '../librarySource';
import { importModule, registerLazyAttributes, registerModule } from '../modules';
import { callableGenericAliasClass } from '../typeHints';
import { None, typeError } from '../types';
import { PyClass, PyFunction, type PyValue } from '../values';
import { dequeClass } from './collections';
import { COLLECTIONS_ABC_SOURCE } from './collectionsAbcSource';

registerModule('collections.abc', () =>
  runLibrarySource('collections.abc', COLLECTIONS_ABC_SOURCE, new Map(nativeHelpers()))
);
// As in CPython, where importing any module imports collections.abc, `collections.abc` needs no import of its own.
registerLazyAttributes('collections', ['abc'], (runtime) => importModule(runtime, 'collections.abc'));

function nativeHelpers(): [string, PyValue][] {
  return [
    [
      'abstractmethod',
      builtin('abstractmethod', 'one', 1, 1, ([fn]) => {
        if (fn instanceof PyFunction) fn.dict.set('__isabstractmethod__', true);
        return fn;
      }),
    ],
    [
      '_abc_init',
      builtin('_abc_init', 'one', 1, 1, ([cls]) => {
        initAbstractClass(cls as PyClass);
        return None;
      }),
    ],
    [
      '_check_methods',
      builtin('_check_methods', 'expected', 1, Number.POSITIVE_INFINITY, ([cls, ...methods]) => {
        if (!(cls instanceof PyClass)) throw typeError("'__mro__' attribute missing");
        return checkMethods(cls, methods as string[]);
      }),
    ],
    ['_CallableGenericAlias', callableGenericAliasClass],
    ['_maxsize', 2n ** 63n - 1n],
    ['_deque', dequeClass],
  ];
}
