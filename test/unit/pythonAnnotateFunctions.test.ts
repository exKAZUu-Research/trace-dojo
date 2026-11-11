import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Runs a program whose list `actual` must equal `expected`, the list CPython 3.14.10 computes. */
function expectSameAsCPython(program: string): void {
  const checked = `${program}
for a, e in zip(actual, expected):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))
if len(actual) != len(expected):
    raise ValueError('lengths differ')`;
  expect(executeProgram('python', checked)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

test('the __annotate__ of a class, function, and module is a Python function as in CPython', () => {
  expectSameAsCPython(`import sys, types
class C:
    x: int
def f(a: 'str') -> float: pass
z: int = 1
actual = []
for annotate in (C.__annotate__, f.__annotate__, sys.modules[__name__].__annotate__):
    actual.append((type(annotate).__name__, annotate.__qualname__, isinstance(annotate, types.FunctionType),
                   annotate.__code__.co_qualname, annotate.__code__.co_freevars, annotate(1)))
    for call in (lambda: annotate(3), lambda: annotate(), lambda: annotate(format=1)):
        try:
            call()
        except Exception as e:
            actual.append((type(e).__name__, str(e)))
actual.append((types.ModuleType('m').__annotate__, f.__annotate__.__closure__))
expected = [
    ('function', 'C.__annotate__', True, 'C.__annotate__', ('__classdict__',), {'x': int}),
    ('NotImplementedError', ''),
    ('TypeError', "C.__annotate__() missing 1 required positional argument: 'format'"),
    ('TypeError', "C.__annotate__() got some positional-only arguments passed as keyword arguments: 'format'"),
    ('function', 'f.__annotate__', True, '__annotate__', (), {'a': 'str', 'return': float}),
    ('NotImplementedError', ''),
    ('TypeError', "f.__annotate__() missing 1 required positional argument: 'format'"),
    ('TypeError', "f.__annotate__() got some positional-only arguments passed as keyword arguments: 'format'"),
    ('function', '__annotate__', True, '__annotate__', (), {'z': int}),
    ('NotImplementedError', ''),
    ('TypeError', "__annotate__() missing 1 required positional argument: 'format'"),
    ('TypeError', "__annotate__() got some positional-only arguments passed as keyword arguments: 'format'"),
    (None, None),
]`);
});
