import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('Counter initialization and operations dispatch through subclass protocols', () => {
  const program = `from collections import Counter
class Lower(Counter):
    def update(self, values=(), **kw):
        print('update')
        super().update((x.lower() for x in values), **kw)
c = Lower('Aa')
assert c['a'] == 2 and c['A'] == 0
class Capped(Counter):
    def __setitem__(self, key, value): super().__setitem__(key, min(value, 1))
c = Capped()
c.update('aa')
assert c['a'] == 1
c.subtract('aaa')
assert c['a'] == -2
class Views(Counter):
    def items(self): return [('virtual', 9)]
    def values(self): return [4, 5]
c = Views(actual=2)
assert c.most_common() == [('virtual', 9)]
assert c.most_common(1) == [('virtual', 9)]
assert list(c.elements()) == ['virtual'] * 9
assert c.total() == 9
assert dict(+c) == {'virtual': 9}
assert dict(c + Counter()) == {'virtual': 9}
print('counted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'update\ncounted\n',
    uncaughtException: undefined,
  });
});

test('collection copies and unions run subclass constructors and preserve their data', () => {
  const program = `from collections import deque, defaultdict, OrderedDict
class D(deque):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.ready = True
for bound in [None, 3]:
    d = D([1, 2], bound)
    for result in [d.copy(), d.__copy__(), d + deque([3]), d * 2]:
        assert type(result) is D and result.ready
        assert result.maxlen == bound
    assert list(d) == [1, 2]
class Default(defaultdict):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.ready = True
class Ordered(OrderedDict):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.ready = True
    def __getitem__(self, key): return super().__getitem__(key) * 2
for d in [Default(list, a=1), Ordered(a=1)]:
    for result in [d.copy(), d | {'b': 2}, {'b': 2} | d]:
        assert type(result) is type(d) and result.ready
        assert 'a' in result
    plain = dict.copy(d)
    assert type(plain) is dict
    assert plain == {'a': 1 if isinstance(d, defaultdict) else 2}
    if isinstance(d, defaultdict):
        assert d.copy().default_factory is list
        assert (d | {})['missing'] == []
    else:
        assert list(d.copy().items()) == [('a', 2)]
print('copied')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'copied\n',
    uncaughtException: undefined,
  });
});

test('Counter class changes remain confined to their execution', () => {
  expect(
    executeProgram(
      'python',
      `from collections import Counter
Counter.marker = 'local'
assert Counter.marker == 'local'
print(Counter('aa')['a'])`
    )
  ).toMatchObject({ kind: 'executed', stdout: '2\n', uncaughtException: undefined });
  expect(
    executeProgram(
      'python',
      `from collections import Counter
assert not hasattr(Counter, 'marker')
print(Counter('aaa')['a'])`
    )
  ).toMatchObject({ kind: 'executed', stdout: '3\n', uncaughtException: undefined });
});
