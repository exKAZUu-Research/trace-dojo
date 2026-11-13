import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('regex iterators read live bytes and release their exports at exhaustion', () => {
  const program = `import re, array
for data in [bytearray(b'abc'), array.array('B', b'abc')]:
    it = re.finditer(b'.', data)
    first = next(it)
    assert first.group() == b'a'
    data[1] = ord('X')
    try: data.append(100)
    except BufferError: pass
    else: raise AssertionError('resized while scanning')
    assert [match.group() for match in it] == [b'X', b'c']
    data.append(100)
    data[0] = ord('Y')
    assert first.group() == b'Y'
    del data[:]
    assert first.group() == b''
print('live')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'live\n',
    uncaughtException: undefined,
  });
});

test('scanner exports protect memoryview release and end with the scanner owner', () => {
  const program = `import re, gc
data = bytearray(b'abc')
view = memoryview(data)
it = re.finditer(b'.', view)
first = next(it)
try: view.release()
except BufferError: pass
else: raise AssertionError('released active view')
assert len(list(it)) == 2
view.release()
try: first.group()
except TypeError as error: assert str(error) == "expected string or bytes-like object, got 'memoryview'"
else: raise AssertionError('read released view')
scanner = re.compile(b'.').scanner(data)
assert scanner.search().group() == b'a'
assert scanner.search().group() == b'b'
assert scanner.search().group() == b'c'
assert scanner.search() is None
try: data.append(100)
except BufferError: pass
else: raise AssertionError('scanner lost its export')
del scanner
gc.collect()
data.append(100)
it = re.finditer(b'.', data)
next(it)
del it
gc.collect()
data.append(101)
print('released')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'released\n',
    uncaughtException: undefined,
  });
});

test('regex substitution reads mutable input after callbacks and releases exports on errors', () => {
  const program = `import re
data = bytearray(b'abc')
def replace(match):
    if match.start() == 0: data[1] = ord('X')
    return match.group()
assert re.sub(b'.', replace, data) == b'aXc'
def fail(match): raise ValueError('stop')
try: re.sub(b'.', fail, data)
except ValueError: pass
data.append(100)
assert re.split(b'X', data) == [b'a', b'cd']
assert re.findall(b'.', data) == [b'a', b'X', b'c', b'd']
print('substituted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'substituted\n',
    uncaughtException: undefined,
  });
});
