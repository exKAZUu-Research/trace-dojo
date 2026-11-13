import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('partial reconstruction retains attributes and replaces or clears its dictionary', () => {
  const program = `import functools, pickle, copy
value = functools.partial(pow, 2)
value.label = 'power of two'
value.settings = ['setting']
for restored in [pickle.loads(pickle.dumps(value)), copy.copy(value), copy.deepcopy(value)]:
    assert restored(3) == 8 and restored.label == value.label
    assert restored.settings == value.settings
attributes = {'label': 'replacement'}
value.__setstate__((pow, (3,), {}, attributes))
assert value(2) == 9 and not hasattr(value, 'settings')
assert value.__dict__ is attributes
attributes['label'] = 'changed'
assert value.label == 'changed'
value.__setstate__((pow, (2,), None, None))
assert value(3) == 8 and not vars(value)
for state in [(None, (), {}, None), (pow, [], {}, None), (pow, (), [], None), (pow, (), {}, [])]:
    try: value.__setstate__(state)
    except TypeError as error: assert str(error) == 'invalid partial state'
    else: raise AssertionError('accepted invalid state')
assert value(3) == 8
print('reconstructed')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'reconstructed\n',
    uncaughtException: undefined,
  });
});

test('functools caches preserve scalar fast keys and callable identity through copies', () => {
  const program = `import functools, copy
for decorate in [functools.cache, functools.lru_cache(maxsize=4), functools.lru_cache(maxsize=4, typed=True)]:
    @decorate
    def identity(value): return value
    assert type(identity(1)) is int
    assert type(identity(1.0)) is float
    assert type(identity(1)) is int
    info = identity.cache_info()
    assert (info.hits, info.misses) == (1, 2)
    assert copy.copy(identity) is identity and copy.deepcopy(identity) is identity
    @decorate
    def keyword(*, value): return value
    keyword(value=1)
    result = keyword(value=1.0)
    assert type(result) is (float if keyword.cache_parameters()['typed'] else int)
print('cached')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'cached\n',
    uncaughtException: undefined,
  });
});

test('enum aliases initialize every declared candidate and retain canonical identity', () => {
  const program = `from enum import Enum, IntEnum
for base in [Enum, IntEnum]:
    events = []
    class Status(base):
        def __init__(self, value): events.append((self.name, value))
        OK = 1
        SUCCESS = 1
        ERROR = 2
    assert events == [('OK', 1), ('SUCCESS', 1), ('ERROR', 2)]
    assert Status.OK is Status.SUCCESS
    assert list(Status) == [Status.OK, Status.ERROR]
print('initialized')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'initialized\n',
    uncaughtException: undefined,
  });
});
