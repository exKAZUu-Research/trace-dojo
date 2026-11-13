import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('BytesIO line batching stops at its hint and preserves incremental writes before failure', () => {
  const program = `import io
for hint in (-1, 0, 1, 2, 3, 4):
    f = io.BytesIO(b'a\\nb\\n')
    print(f.readlines(hint), f.tell())
f = io.BytesIO()
def chunks():
    for _ in range(3): yield str(f.tell()).encode()
    raise ValueError()
try: f.writelines(chunks())
except ValueError: print(f.getvalue())
def invalid():
    yield b'ok'
    yield 'bad'
try: f.writelines(invalid())
except TypeError: print(f.getvalue())`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "[b'a\\n', b'b\\n'] 4\n[b'a\\n', b'b\\n'] 4\n[b'a\\n'] 2\n[b'a\\n'] 2\n[b'a\\n', b'b\\n'] 4\n[b'a\\n', b'b\\n'] 4\nb'012'\nb'012ok'\n",
    uncaughtException: undefined,
  });
});

test('universal newline tracking is independent of translation and fixed modes report None', () => {
  const program = `import io
for newline in (None, '', '\\n', '\\r', '\\r\\n'):
    f = io.StringIO('a\\r\\nb\\n', newline=newline)
    print(repr(f.newlines), repr(f.read()))
    f.write('c\\r')
    print(repr(f.newlines))
    f = io.TextIOWrapper(io.BytesIO(b'a\\r\\nb\\n'), newline=newline)
    print(repr(f.read()), repr(f.newlines))`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "('\\n', '\\r\\n') 'a\\nb\\n'\n('\\r', '\\n', '\\r\\n')\n'a\\nb\\n' ('\\n', '\\r\\n')\n('\\n', '\\r\\n') 'a\\r\\nb\\n'\n('\\r', '\\n', '\\r\\n')\n'a\\r\\nb\\n' ('\\n', '\\r\\n')\nNone 'a\\r\\nb\\n'\nNone\n'a\\r\\nb\\n' None\nNone 'a\\r\\rb\\r'\nNone\n'a\\r\\nb\\n' None\nNone 'a\\r\\r\\nb\\r\\n'\nNone\n'a\\r\\nb\\n' None\n",
    uncaughtException: undefined,
  });
});

test.each(['BufferedWriter', 'BufferedRandom'])(
  '%s distinguishes a full chunk from smaller buffered writes',
  (kind) => {
    const program = `import io
for chunks in ((b'ab',), (b'a', b'b'), (b'a', b'bc'), (b'a', b'bcde'), (b'abc', b'd')):
    raw = io.BytesIO()
    f = io.${kind}(raw, 2)
    for chunk in chunks:
        print(f.write(chunk), raw.getvalue(), f.tell())
    f.flush()
    print(raw.getvalue())`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout:
        "2 b'ab' 2\nb'ab'\n1 b'' 1\n1 b'' 2\nb'ab'\n1 b'' 1\n2 b'abc' 3\nb'abc'\n1 b'' 1\n4 b'abcde' 5\nb'abcde'\n3 b'abc' 3\n1 b'abc' 4\nb'abcd'\n",
      uncaughtException: undefined,
    });
  }
);

test('text positions preserve codec state across rereads and byte-order transitions', () => {
  const program = `import io
for encoding in ('utf8', 'utf-8-sig', 'utf-16', 'utf-16-le', 'utf-16-be', 'utf-32', 'utf-32-le', 'utf-32-be',
                 'iso2022_jp', 'iso2022_jp_1', 'iso2022_jp_2', 'iso2022_jp_3', 'iso2022_jp_2004', 'iso2022_jp_ext', 'hz'):
    f = io.TextIOWrapper(io.BytesIO('あいうえお'.encode(encoding)), encoding=encoding)
    first = f.read(1)
    p = f.tell()
    f.seek(0)
    f.seek(p)
    print(encoding, first + f.read())
for encoding, prefix in (('utf-8', b''), ('utf-16-be', b''), ('utf-16', b'\\xfe\\xff'), ('utf-32', b'\\x00\\x00\\xfe\\xff')):
    data = prefix + 'abc'.encode('utf-16-be' if encoding == 'utf-16' else 'utf-32-be' if encoding == 'utf-32' else encoding)
    f = io.TextIOWrapper(io.BytesIO(data), encoding=encoding)
    print(f.read(1), f.tell())`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      [
        'utf8',
        'utf-8-sig',
        'utf-16',
        'utf-16-le',
        'utf-16-be',
        'utf-32',
        'utf-32-le',
        'utf-32-be',
        'iso2022_jp',
        'iso2022_jp_1',
        'iso2022_jp_2',
        'iso2022_jp_3',
        'iso2022_jp_2004',
        'iso2022_jp_ext',
        'hz',
      ]
        .map((encoding) => `${encoding} あいうえお\n`)
        .join('') + 'a 1\na 2\na 36893488147419103236\na 36893488147419103240\n',
    uncaughtException: undefined,
  });
});

test('buffered direct writes preserve accepted data across blocking and short raw writes', () => {
  const program = `import io
class Raw(io.RawIOBase):
    def __init__(self):
        self.blocked = True
        self.data = bytearray()
    def writable(self): return True
    def write(self, data):
        if self.blocked: return None
        self.data.extend(data[:1])
        return min(1, len(data))
for data in (b'ab', b'abc', b'abcd'):
    raw = Raw()
    f = io.BufferedWriter(raw, 2)
    try: print(f.write(data))
    except BlockingIOError as error: print('blocked', error.characters_written)
    raw.blocked = False
    f.flush()
    print(bytes(raw.data))
    f.write(b'xyz')
    print(bytes(raw.data))
    f.flush()
    print(bytes(raw.data))`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: "2\nb'ab'\nb'abxy'\nb'abxyz'\nblocked 2\nb'ab'\nb'abxy'\nb'abxyz'\nblocked 2\nb'ab'\nb'abxy'\nb'abxyz'\n",
    uncaughtException: undefined,
  });
});

test('text readline preserves Unicode positions and newline state across buffered and refill paths', () => {
  const program = String.raw`import io
text = (chr(128512) + 'a\r\nb' + chr(233) + '\rc\nz') * 7
for newline in [None, '', '\n', '\r', '\r\n']:
    def stream():
        result = io.TextIOWrapper(io.BytesIO(text.encode()), encoding='utf-8', newline=newline)
        result._CHUNK_SIZE = 5
        return result
    expected = stream().read()
    for size in [0, 1, 2, 7, -1]:
        source = stream()
        parts = []
        if size == 0:
            assert source.readline(0) == ''
            size = -1
        while part := source.readline(size):
            if size > 0: assert len(part) <= size
            parts.append(part)
        assert ''.join(parts) == expected
        try: source.readline(None)
        except TypeError: pass
        else: raise AssertionError('accepted None size')
print('lines')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'lines\n',
    uncaughtException: undefined,
  });
});

test('text iteration uses the builtin reader for exact streams and dispatches subclass readline overrides', () => {
  const program = `import io
stream = io.TextIOWrapper(io.BytesIO(b'a\\nb\\n'))
stream.readline = lambda: 'shadowed'
assert next(stream) == 'a\\n' and next(stream) == 'b\\n'
class Text(str): pass
line = Text('subclass')
class Stream(io.TextIOWrapper):
    def readline(self): return line
stream = Stream(io.BytesIO())
assert next(stream) is line
line = ''
assert next(stream, 'finished') == 'finished'
print('iterated')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'iterated\n',
    uncaughtException: undefined,
  });
});
