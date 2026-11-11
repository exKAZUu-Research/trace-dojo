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
  return !cls.isBuiltin || cls.isBaseType || isSubclassableConstruct(cls);
}

/** Whether a builtin type creates its objects by its `construct` and yet CPython lets programs subclass it. */
export function isSubclassableConstruct(cls: PyClass): boolean {
  return cls.isBuiltin && cls.construct !== undefined && SUBCLASSABLE.has(`${cls.module}.${cls.name}`);
}
