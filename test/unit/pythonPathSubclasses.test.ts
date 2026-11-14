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

test('path protocols reject mutable buffers both directly and as fspath results', () => {
  const program = `import os, os.path
class Path:
    def __fspath__(self): return bytearray(b'a')
class Buffer(bytearray): pass
for value in [bytearray(b'a'), Buffer(b'a'), Path()]:
    for use in [os.fspath, os.fsencode, os.fsdecode, lambda x: os.path.join(x, b'b'), os.path.split]:
        try: use(value)
        except TypeError: pass
        else: raise AssertionError('accepted')
print('paths')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'paths\n',
    uncaughtException: undefined,
  });
});

test('path joins diagnose mutable components before checking mixed encodings', () => {
  const program = `import os.path
class Buffer(bytearray): pass
for component in [bytearray(b'b'), Buffer(b'b')]:
    for start in ['a', b'a']:
        try: os.path.join(start, component)
        except TypeError as error:
            assert str(error) == "join() argument must be str, bytes, or os.PathLike object, not '" + type(component).__name__ + "'"
        else: raise AssertionError('accepted')
print('joined')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'joined\n',
    uncaughtException: undefined,
  });
});

test('string-valued enum paths use string payloads and preserve a single join argument', () => {
  const program = `import os.path
from enum import Enum
class Path(str, Enum): A = 'a'
assert os.fspath(Path.A) is Path.A
assert os.path.join(Path.A) is Path.A
assert os.path.split(Path.A) == ('', 'a')
assert os.path.join('x', Path.A) == 'x/a'
assert os.fsencode(Path.A) == b'a'
assert os.fsdecode(Path.A) is Path.A
print('enum paths')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'enum paths\n',
    uncaughtException: undefined,
  });
});

test('path operations preserve string and byte enum objects when CPython returns the original path', () => {
  const program = `import os.path
from enum import Enum
class Text(str, Enum): NAME = 'name'
class Binary(bytes, Enum): NAME = b'name'
for path in [Text.NAME, Binary.NAME]:
    assert os.fspath(path) is path
    assert os.path.normcase(path) is path
    assert os.path.join(path) is path
    assert os.path.splitext(path)[0] is path
    assert os.path.splitdrive(path)[1] is path
    assert os.path.expanduser(path) is path
    assert os.path.expandvars(path) is path
    assert os.path.basename(path) == path[:]
assert os.path.join(Binary.NAME, b'child') == b'name/child'
assert os.fsencode(Binary.NAME) is Binary.NAME
assert os.fsdecode(Binary.NAME) == 'name'
assert repr(Binary.NAME) == "<Binary.NAME: b'name'>"
assert bytes(Binary.NAME) == b'name'
assert bytes.__len__(Binary.NAME) == 4
assert Binary.NAME.upper() == b'NAME'
assert list(Binary.NAME) == list(b'name')
assert memoryview(Binary.NAME).tobytes() == b'name'
import re
assert re.search(b'n', Binary.NAME).group() == b'n'
assert Binary.NAME == b'name' and hash(Binary.NAME) == hash(b'name')
print('preserved')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'preserved\n',
    uncaughtException: undefined,
  });
});
