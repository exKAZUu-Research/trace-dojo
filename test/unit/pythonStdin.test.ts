import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

test('input prompts and text reads consume one shared input stream through EOF', () => {
  const program = `import sys
print(sum(map(int, input('numbers> ').split())))
print(repr(input()))
print(repr(sys.stdin.readline(2)))
print(repr(sys.stdin.read()))
try: input()
except EOFError as error: print(type(error).__name__, str(error))`;
  expect(executeProgram('python', program, { stdin: '1 2 3\n\nlast' })).toMatchObject({
    kind: 'executed',
    stdout: "numbers> 6\n''\n'la'\n'st'\nEOFError EOF when reading a line\n",
    uncaughtException: undefined,
  });
});

test.each([1, 2, 3, 4, 8191])('raw stdin preserves UTF-8 when reading %i bytes at a time', (size) => {
  const prefixLength = size === 8191 ? 8190 : 5;
  const program = `import sys
raw = sys.stdin.buffer.raw
parts = []
while chunk := raw.read(${size}): parts.append(chunk)
expected = ('x' * ${prefixLength} + chr(233) + chr(0x1f600) + chr(0x3042) + '\\r\\nz').encode()
assert b''.join(parts) == expected
assert raw.read() == b''
print('read')`;
  expect(executeProgram('python', program, { stdin: `${'x'.repeat(prefixLength)}é😀あ\r\nz` })).toMatchObject({
    kind: 'executed',
    stdout: 'read\n',
    uncaughtException: undefined,
  });
});

test('text decoding retains prefetched bytes and supports reconfiguring newline translation', () => {
  const program = `import sys
assert sys.stdin.read(1) == 'A'
assert sys.stdin.buffer.read() == b''
assert sys.stdin.read() == chr(233) + '\\r\\nB\\rC\\n'
print('buffered')`;
  expect(executeProgram('python', program, { stdin: 'Aé\r\nB\rC\n' })).toMatchObject({
    kind: 'executed',
    stdout: 'buffered\n',
    uncaughtException: undefined,
  });
  expect(
    executeProgram(
      'python',
      `import sys
sys.stdin.reconfigure(newline=None)
assert list(sys.stdin) == ['x' * 8191 + '\\n', 'z']
print('lines')`,
      { stdin: `${'x'.repeat(8191)}\r\nz` }
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'lines\n',
    uncaughtException: undefined,
  });
});

test('binary stdin reads into writable views and closes the transport for every wrapper', () => {
  const program = `import io, sys
stream = sys.stdin
raw = stream.buffer.raw
assert isinstance(raw, io.RawIOBase) and type(raw) is io.FileIO
assert raw.name == '<stdin>'
raw.name = 'changed'
assert "name='changed'" in repr(raw)
del raw.name
assert 'fd=0' in repr(raw)
target = bytearray(b'------')
assert stream.buffer.readinto(memoryview(target)[1:5]) == 4
assert target == b'-abcd-'
assert stream.buffer.read() == b'ef'
for operation in (raw.tell, lambda: raw.seek(0)):
    try: operation()
    except OSError as error: assert error.errno == 29
    else: raise AssertionError('seekable stdin')
stream.close()
assert stream.closed and stream.buffer.closed and raw.closed
for operation in (input, stream.read, stream.buffer.read, raw.read):
    try: operation()
    except ValueError: pass
    else: raise AssertionError('closed stdin remained readable')
print('closed')`;
  expect(executeProgram('python', program, { stdin: 'abcdef' })).toMatchObject({
    kind: 'executed',
    stdout: 'closed\n',
    uncaughtException: undefined,
  });
});

test('input follows replacement standard streams while preserving the original stream', () => {
  const program = `import io, sys
original = sys.__stdin__
output = sys.stdout
sys.stdin = io.StringIO('abc\\r\\nlast')
sys.stdout = io.StringIO()
assert input('prompt> ') == 'abc\\r'
assert input() == 'last'
assert sys.stdout.getvalue() == 'prompt> '
sys.stdin = io.BytesIO(b'binary\\n')
assert input() == b'binary'
sys.stdin = None
try: input()
except RuntimeError as error: assert str(error) == 'lost sys.stdin'
else: raise AssertionError('missing stream accepted')
sys.stdin, sys.stdout = original, output
assert input() == 'original'
print('replaced')`;
  expect(executeProgram('python', program, { stdin: 'original\n' })).toMatchObject({
    kind: 'executed',
    stdout: 'replaced\n',
    uncaughtException: undefined,
  });
});

test('input tolerates flush errors but requires all three standard streams', () => {
  const program = `import io, sys
streams = {name: getattr(sys, name) for name in ('stdin', 'stdout', 'stderr')}
events = []
class Sink:
    def __init__(self, name): self.name = name
    def write(self, text): events.append((self.name, text))
    def flush(self):
        events.append((self.name, 'flush'))
        raise ValueError('flush')
sys.stdin = io.StringIO('line\\n')
sys.stdout, sys.stderr = Sink('out'), Sink('err')
assert input('prompt') == 'line'
assert events == [('err', 'flush'), ('out', 'prompt'), ('out', 'flush')]
for name in streams: setattr(sys, name, streams[name])
for name in streams:
    setattr(sys, name, None)
    try: input()
    except RuntimeError as error: assert str(error) == 'lost sys.' + name
    else: raise AssertionError('missing stream accepted')
    delattr(sys, name)
    try: input()
    except RuntimeError as error: assert str(error) == 'lost sys.' + name
    else: raise AssertionError('deleted stream accepted')
    setattr(sys, name, streams[name])
print('flushed')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'flushed\n',
    uncaughtException: undefined,
  });
});

test('tracing receives input and separate executions start with fresh streams', () => {
  const program = 'value = int(input())\nprint(value + 1)';
  const trace = traceProgram('python', program, program, { stdin: '41\n' });
  expect(trace).toMatchObject({ stdout: '42\n', uncaughtException: undefined });
  expect(trace.traceItems.at(-1)?.vars).toMatchObject({ value: 41 });
  for (const stdin of ['7\n', '8\n']) {
    expect(executeProgram('python', 'print(input())', { stdin })).toMatchObject({
      kind: 'executed',
      stdout: stdin,
      uncaughtException: undefined,
    });
  }
});
