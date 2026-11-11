import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// CPython 3.14.10 computes `expected`.
test('code objects, cells, dict reverse iterators, and site builtins behave as CPython', () => {
  const program = String.raw`import json.decoder, ast
actual = []
c, d = compile('x = 1', 'a', 'exec'), compile('x = 1', 'b', 'exec')
actual += [c == d, hash(c) == hash(d), c == compile('x = 2', 'a', 'exec')]
def outer():
    x = 1
    return lambda: x
f = outer()
actual += [f.__closure__[0] is f.__closure__[0], f.__closure__[0] == outer().__closure__[0]]
d = {1: 2, 3: 4}
it = reversed(d)
next(it)
d[5] = 6
try:
    next(it)
except RuntimeError as e:
    actual.append(str(e))
actual += [repr(quit), type(help).__name__, json.decoder.scanstring.__module__]
try:
    exit(3)
except SystemExit as e:
    actual.append(e.code)
actual += [sorted(vars(ast.expr)), len(dir(ast.parse('x')))]
expected = [True, True, False, True, True, 'dictionary changed size during iteration', 'Use quit() or Ctrl-D (i.e. EOF) to exit', '_Helper', '_json', 3, ['__doc__', '__match_args__', '__module__', '__weakref__', '_attributes', '_fields', 'end_col_offset', 'end_lineno'], 35]
for a, e in zip(actual, expected, strict=True):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('listing a namespace that differs from CPython fails loudly, while matching ones list', () => {
  const lists = String.raw`import math
names = dir(math), dir(str), dir(list), vars(math)`;
  expect(executeProgram('python', lists)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
  for (const listing of ['vars(Color)', 'dir(Color.RED)', 'Color.__dict__', 'help(Color)']) {
    const program = `import enum\nclass Color(enum.Enum):\n    RED = 1\n${listing}`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('この採点環境では使えません'),
    });
  }
});
