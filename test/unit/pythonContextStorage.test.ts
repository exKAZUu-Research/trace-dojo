import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['contextvars.copy_context()', 'original.copy()'])(
  'context copies account for retained entries: %s',
  (copy) => {
    const program = `import contextvars
variables = [contextvars.ContextVar(str(i)) for i in range(2000)]
for variable in variables: variable.set(1)
original = contextvars.copy_context()
copies = [${copy} for _ in range(1000)]`;
    expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: 'MemoryError' });
  }
);

test('copied contexts preserve independent values and token resets', () => {
  const program = `import contextvars
value = contextvars.ContextVar('value', default=0)
token = value.set(1)
first = contextvars.copy_context()
second = first.copy()
first.run(value.set, 2)
value.reset(token)
print(value.get(), first[value], second[value])
print(first.run(value.get), second.run(value.get))
new = contextvars.ContextVar('new', default=9)
other = new.set(3)
new.reset(other)
print(new.get())`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '0 2 1\n2 1\n9\n',
    uncaughtException: undefined,
  });
});

test('sys.implementation owns attributes before and after importing types', () => {
  const program = `import sys
print(sys.implementation.name)
print(sorted(vars(sys.implementation)))
sys.implementation.name = 'changed'
import types
print(sys.implementation.name)
sys.implementation.extra = 7
print(vars(sys.implementation)['extra'])`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "cpython\n['_multiarch', 'cache_tag', 'hexversion', 'name', 'supports_isolated_interpreters', 'version']\nchanged\n7\n",
    uncaughtException: undefined,
  });
  expect(executeProgram('python', 'import sys\nprint(sys.implementation.name)')).toMatchObject({
    kind: 'executed',
    stdout: 'cpython\n',
    uncaughtException: undefined,
  });
});

test.each([false, true])(
  'context resets release displaced values after restoring the binding (with=%s)',
  (withToken) => {
    const program = `import contextvars
value = contextvars.ContextVar('value')
class Resource:
    def __init__(self, name): self.name = name
    def __del__(self): print('released', self.name, value.get('missing'))
${withToken ? "with value.set(Resource('scoped')):\n    print('inside')" : "token = value.set(Resource('scoped'))\nvalue.reset(token)"}
print('reset')
previous = value.set('old')
token = value.set(Resource('copied'))
copy = contextvars.copy_context()
value.reset(token)
print(value.get(), type(copy[value]).__name__)
del copy
print('end')`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: `${withToken ? 'inside\n' : ''}released scoped missing\nreset\nold Resource\nreleased copied old\nend\n`,
      uncaughtException: undefined,
    });
  }
);
