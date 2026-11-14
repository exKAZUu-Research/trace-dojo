import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['None', '{}', 'retained'])(
  'partial restoration releases displaced attributes while preserving %s owners',
  (replacement) => {
    const program = `import functools
class Resource:
    def __del__(self): print('released')
p = functools.partial(pow, 2)
p.resource = Resource()
${replacement === 'retained' ? 'retained = p.__dict__' : 'pass'}
p.__setstate__((pow, (3,), {}, ${replacement === 'retained' ? 'None' : replacement}))
print('restored', p(2))
${replacement === 'retained' ? 'del retained' : 'pass'}
print('end')`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: replacement === 'retained' ? 'restored 9\nreleased\nend\n' : 'released\nrestored 9\nend\n',
      uncaughtException: undefined,
    });
  }
);

test('partial state replacements release each field in CPython order with reentrant state visibility', () => {
  const program = `import functools
class Resource:
    def __init__(self, name): self.name = name
    def __call__(self, *args, **kwargs): pass
    def __del__(self): print(self.name, p.func is pow, p.args == (3,), p.keywords == {})
p = functools.partial(Resource('fn'), Resource('arg'), key=Resource('kw'))
p.attr = Resource('attr')
p.__setstate__((pow, (3,), {}, None))
print('restored')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'fn True False False\narg True True False\nkw True True True\nattr True True True\nrestored\n',
    uncaughtException: undefined,
  });
});

test('partial state preserves exact containers and bypasses subclass attribute hooks', () => {
  const program = `from functools import partial
class P(partial):
    def __setattr__(self, name, value): raise AssertionError(name)
args = (3,)
keywords = {}
attributes = {}
p = P(pow, 2)
p.__setstate__((pow, args, keywords, attributes))
assert p.args is args and p.keywords is keywords and p.__dict__ is attributes
print(p(2))`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '9\n',
    uncaughtException: undefined,
  });
});
