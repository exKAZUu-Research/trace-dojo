import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('array iterators retain native identity, cursor state and pickle reconstruction', () => {
  const program = `import array, pickle, copy, operator, types
for code, values in [('b', [1, 2, 3]), ('d', [1.5, 2.5, 3.5]), ('w', 'abc')]:
    data = array.array(code, values)
    it = iter(data)
    assert type(it).__name__ == 'arrayiterator' and type(it).__module__ == 'array'
    assert not isinstance(it, types.GeneratorType)
    assert not hasattr(it, 'send') and not hasattr(it, 'gi_frame')
    assert str(it).startswith('<array.arrayiterator object at ')
    assert next(it) == values[0]
    for restored in [copy.copy(it), pickle.loads(pickle.dumps(it))]:
        assert list(restored) == list(values[1:])
    it.__setstate__(0)
    data.append(values[0])
    assert list(it) == list(values) + [values[0]]
    data.append(values[1])
    it.__setstate__(0)
    assert list(it) == []
class Index:
    def __index__(self): return 1
it = iter(array.array('b', [1, 2, 3]))
try: it.__setstate__(Index())
except TypeError as error: assert str(error) == 'an integer is required'
else: raise AssertionError('accepted index protocol')
class Integer(int):
    def __index__(self): raise AssertionError('override')
it.__setstate__(Integer(1))
assert list(it) == [2, 3]
class Array(array.array):
    def __del__(self): print('released')
it = iter(Array('b', [1]))
assert next(it) == 1
print('yielded')
assert next(it, None) is None
print('exhausted')
print('restored')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'yielded\nreleased\nexhausted\nrestored\n',
    uncaughtException: undefined,
  });
});

test('RegexFlag iteration uses the shared Flag generator protocol', () => {
  const program = `import re, inspect, types
for flag in [re.RegexFlag(0), re.I | re.M, re.I | re.M | re.S]:
    it = iter(flag)
    assert inspect.isgenerator(it) and isinstance(it, types.GeneratorType)
    assert list(it) == [member for member in re.RegexFlag if member in flag]
it = iter(re.I | re.M)
assert next(it) is re.I
it.close()
assert list(it) == []
it = iter(re.I | re.M)
try: it.throw(ValueError('stop'))
except ValueError as error: assert str(error) == 'stop'
assert list(it) == []
print('generated')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'generated\n',
    uncaughtException: undefined,
  });
});

test('array subclasses retain their type name in all representations', () => {
  const program = `import array
class A(array.array): pass
for code, values in [('i', []), ('i', [1, 2]), ('u', 'ab')]:
    plain = array.array(code, values)
    custom = A(code, values)
    assert repr(custom) == 'A' + repr(plain)[5:]
    assert list(custom) == list(plain)
print('arrays')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'arrays\n',
    uncaughtException: undefined,
  });
});
