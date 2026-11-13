import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['readinto', 'readinto1'])('%s validates writable targets before closure without consuming input', (name) => {
  const program = `import io
released = memoryview(bytearray(2))
released.release()
invalid = [
    ('str', 'x'), ('none', None), ('int', 1), ('bytes', b'ab'),
    ('readonly', memoryview(b'ab')), ('strided', memoryview(bytearray(4))[::2]), ('released', released),
]
messages = set()
for kind in (io.BytesIO, io.BufferedReader, io.BufferedRandom):
    for closed in (False, True):
        for label, value in invalid:
            source = io.BytesIO(b'abcdef')
            stream = source if kind is io.BytesIO else kind(source)
            if closed: stream.close()
            try: stream.${name}(value)
            except TypeError as error: messages.add((label, str(error)))
            else: raise AssertionError('invalid target accepted')
            if not closed:
                assert stream.tell() == 0
                assert stream.read() == b'abcdef'
for label, message in sorted(messages): print(label, message)`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: `bytes ${name}() argument must be read-write bytes-like object, not bytes
int ${name}() argument must be read-write bytes-like object, not int
none ${name}() argument must be read-write bytes-like object, not None
readonly ${name}() argument must be read-write bytes-like object, not memoryview
released ${name}() argument must be read-write bytes-like object, not memoryview
str ${name}() argument must be read-write bytes-like object, not str
strided ${name}() argument must be read-write bytes-like object, not memoryview
`,
    uncaughtException: undefined,
  });
});

test('raw readinto preserves C argument positions and writable view rejection', () => {
  const program = `import sys
raw = sys.stdin.buffer.raw
for target in ('text', None, b'ab', memoryview(bytearray(4))[::2]):
    try: raw.readinto(target)
    except TypeError as error: print(str(error))
    else: raise AssertionError('invalid raw target accepted')
raw.close()
try: raw.readinto('text')
except TypeError as error: print(str(error))
else: raise AssertionError('closed raw target accepted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: `readinto() argument 1 must be read-write bytes-like object, not str
readinto() argument 1 must be read-write bytes-like object, not None
readinto() argument 1 must be read-write bytes-like object, not bytes
readinto() argument 1 must be read-write bytes-like object, not memoryview
readinto() argument 1 must be read-write bytes-like object, not str
`,
    uncaughtException: undefined,
  });
});

test('writable buffer leases preserve acquisition flags, release identity and callback failures', () => {
  const program = `import io, sys
class Buffer:
    def __init__(self): self.target, self.events = bytearray(4), []
    def __buffer__(self, flags):
        self.events.append(('acquire', flags))
        self.view = memoryview(self.target)
        return self.view
    def __release_buffer__(self, view):
        assert view is self.view
        self.events.append(('release', view.nbytes))
class Generic(io.BufferedIOBase):
    def read(self, size=-1): return b'ab'[:size]
for stream in (io.BytesIO(b'ab'), io.BufferedReader(io.BytesIO(b'ab')), io.BufferedRandom(io.BytesIO(b'ab')), Generic()):
    target = Buffer()
    assert stream.readinto(target) == 2
    assert target.target == b'ab' + bytes(2)
    assert target.events == [('acquire', 1), ('release', 4)]
    target.view.release()
    target.target.extend(b'z')
class BadBuffer:
    def __buffer__(self, flags): raise ValueError('acquire')
try: io.BytesIO().readinto(BadBuffer())
except TypeError as error: print(str(error))
else: raise AssertionError('acquisition error escaped')
unraisable = []
sys.unraisablehook = lambda error: unraisable.append((str(error.exc_value), error.err_msg, error.object))
class BadRelease(Buffer):
    def __release_buffer__(self, view):
        super().__release_buffer__(view)
        raise ValueError('release')
target = BadRelease()
assert io.BytesIO(b'ab').readinto(target) == 2
assert target.events == [('acquire', 1), ('release', 4)]
assert unraisable == [('release', 'Exception ignored in __release_buffer__ of BadRelease', None)]
source = io.BytesIO()
source.close()
target = Buffer()
try: source.readinto(target)
except ValueError: pass
else: raise AssertionError('closed stream accepted')
assert target.events == [('acquire', 1), ('release', 4)]
print('released')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'readinto() argument must be read-write bytes-like object, not BadBuffer\nreleased\n',
    uncaughtException: undefined,
  });
});

test('writable buffer leases skip release callbacks after a grader stop', () => {
  const program = `import io
class Buffer:
    def __buffer__(self, flags): return memoryview(bytearray(4))
    def __release_buffer__(self, view): print('released')
class Raw(io.RawIOBase):
    def readable(self): return True
    def readinto(self, view):
        open('file')
io.BufferedReader(Raw()).readinto(Buffer())`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'ファイルの読み書き（open()）は、この採点環境では使えません。',
  });
});
