import { defineConstructingNew } from './instances';
import type { PyClass } from './values';

/** The C types CPython lets programs subclass whose objects this grader makes by their `construct`. */
const SUBCLASSABLE = new Set([
  'builtins.enumerate',
  'builtins.filter',
  'builtins.map',
  'builtins.reversed',
  'builtins.zip',
  'functools.partial',
  'types.GenericAlias',
  '_io.StringIO',
  '_io.BytesIO',
  '_struct.Struct',
  ...[
    'accumulate',
    'batched',
    'chain',
    'combinations',
    'combinations_with_replacement',
    'compress',
    'count',
    'cycle',
    'dropwhile',
    'filterfalse',
    'groupby',
    'islice',
    'pairwise',
    'permutations',
    'product',
    'repeat',
    'starmap',
    'takewhile',
    'zip_longest',
  ].map((name) => `itertools.${name}`),
]);

/** Whether a program's class may derive from a builtin class, as CPython's Py_TPFLAGS_BASETYPE tells. */
export function isBaseType(cls: PyClass): boolean {
  if (!cls.isBuiltin || cls.isBaseType) return true;
  if (!SUBCLASSABLE.has(`${cls.module}.${cls.name}`)) return false;
  // A subclass's objects come from the type's __new__, as CPython's tp_new makes them.
  if (!cls.dict.has('__new__')) defineConstructingNew(cls);
  return true;
}
