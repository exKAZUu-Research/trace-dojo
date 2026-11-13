import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('shared mutable library classes cannot leak changes to another program', () => {
  for (const operation of ["Counter.marker = 'leaked'", 'del Counter.update']) {
    expect(
      executeProgram(
        'python',
        `from collections import Counter
try:
    ${operation}
except Exception:
    print('caught')
print('after')`
      )
    ).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: '標準ライブラリのクラス collections.Counter の属性の書き換えは、この採点環境では使えません。',
    });
    expect(
      executeProgram(
        'python',
        `from collections import Counter
assert not hasattr(Counter, 'marker')
assert Counter('aa')['a'] == 2
print('isolated')`
      )
    ).toMatchObject({ kind: 'executed', stdout: 'isolated\n', uncaughtException: undefined });
  }
});

test('prepared class namespaces supply and observe the implicit module name', () => {
  const program = `lookups = []
class Namespace(dict):
    def __getitem__(self, name):
        lookups.append(name)
        return super().__getitem__(name)
class Meta(type):
    @classmethod
    def __prepare__(cls, name, bases): return Namespace(__name__='example')
class C(metaclass=Meta): pass
assert C.__module__ == 'example'
assert lookups[0] == '__name__'
print(C.__module__)`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'example\n',
    uncaughtException: undefined,
  });
});
