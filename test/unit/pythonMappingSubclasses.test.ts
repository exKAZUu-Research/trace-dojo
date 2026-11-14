import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('fromkeys applies subclass and factory-result item assignment', () => {
  const program = `class Lower(dict):
    def __setitem__(self, key, value):
        print('set', key)
        super().__setitem__(key.lower(), value)
print(Lower.fromkeys(['A', 'B'], 3))
class Factory(dict):
    def __new__(cls): return Lower()
print(Factory.fromkeys(['X'], 4))`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: "set A\nset B\n{'a': 3, 'b': 3}\nset X\n{'x': 4}\n",
    uncaughtException: undefined,
  });
});

test('mapping merges honor overridden iteration and preserve the builtin-iteration fast path', () => {
  const program = `class View(dict):
    def __iter__(self): return iter(['a'])
    def keys(self): print('keys'); return ['a']
    def __getitem__(self, key): print('get', key); return 42
class Plain(dict):
    def keys(self): raise AssertionError('unexpected keys')
    def __getitem__(self, key): raise AssertionError('unexpected item')
def collect(**kwargs): return kwargs
source = View(a=1, b=2)
for merge in [dict, lambda x: {**x}, lambda x: collect(**x)]:
    print(merge(source))
out = {}
out.update(source)
print(out)
assert dict(Plain(a=1)) == {'a': 1}
class Mapping:
    def __getitem__(self, key): return 8
mapping = Mapping()
mapping.keys = lambda: ['k']
out.update(mapping)
assert out == {'a': 42, 'k': 8}`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: "keys\nget a\n{'a': 42}\n".repeat(4),
    uncaughtException: undefined,
  });
});
