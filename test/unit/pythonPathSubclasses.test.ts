import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('filesystem encoding returns bytes for string subclasses and preserves byte paths', () => {
  const program = String.raw`import os
class Path(str): pass
class BinaryPath(bytes): pass
for text in ['file.txt', '教材.txt', '\udcff']:
    path = Path(text)
    encoded = os.fsencode(path)
    assert type(encoded) is bytes
    assert encoded == str(path).encode('utf8', 'surrogateescape')
    assert os.fsdecode(encoded) == text
binary = BinaryPath(b'file.txt')
assert os.fsencode(binary) is binary
print('encoded')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'encoded\n',
    uncaughtException: undefined,
  });
});

test('path-like return values accept the same string and byte subclasses as direct paths', () => {
  const program = `import os
class Text(str): pass
class Binary(bytes): pass
class Path(os.PathLike):
    def __init__(self, value): self.value = value
    def __fspath__(self): return self.value
for value in [Text('abc'), Text('教材.txt'), Binary(b'abc')]:
    path = Path(value)
    assert os.fspath(path) is value
    assert os.fsencode(path) == os.fsencode(value)
    assert os.fsdecode(path) == os.fsdecode(value)
try: os.fspath(Path(1))
except TypeError as error: assert str(error) == 'expected Path.__fspath__() to return str or bytes, not int'
else: raise AssertionError('accepted invalid path')
print('converted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'converted\n',
    uncaughtException: undefined,
  });
});
