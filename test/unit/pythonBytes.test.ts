import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// CPython 3.14.10 gives these values for the same expressions.
test('bytes, codecs, and the modules built on bytes give the values CPython gives', () => {
  const program = `import base64, hashlib, io, struct, unicodedata
buffer = io.StringIO()
print(b'a\\x00\\'"', bytearray(b"it's"), file=buffer)
actual = [buffer.getvalue(), repr(b'\\xff\\t' * 2), b'%s=%d' % (b'x', 5), b'a,b'.split(b','), 'あ€'.encode('shift_jis', 'replace'), b'\\x82\\xa0'.decode('cp932'), 'ｱ'.encode('euc_jp'), '日本'.encode('iso2022_jp'), 'é'.encode('utf-16'), b'\\xe3\\x81'.decode('utf-8', 'replace'), struct.pack('<hId', -2, 7, 0.5), struct.unpack('>2H', b'\\x01\\x02\\x03\\x04'), base64.b64encode(b'trace'), base64.b32decode('MZXW6==='), hashlib.md5(b'abc').hexdigest(), hashlib.sha256(b'abc').hexdigest()[:16], hashlib.sha3_256(b'').hexdigest()[:16], hashlib.blake2b(b'x', digest_size=8).hexdigest(), unicodedata.name('あ'), unicodedata.normalize('NFKC', 'ｶﾞ①'), '\\N{BULLET}', (258).to_bytes(2, 'little'), int.from_bytes(b'\\xff\\xfe', 'big', signed=True)]
expected = ["b'a\\\\x00\\\\'\\"' bytearray(b\\"it\\\\'s\\")\\n", "b'\\\\xff\\\\t\\\\xff\\\\t'", b'x=5', [b'a', b'b'], b'\\x82\\xa0?', 'あ', b'\\x8e\\xb1', b'\\x1b$BF|K\\\\\\x1b(B', b'\\xff\\xfe\\xe9\\x00', '�', b'\\xfe\\xff\\x07\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\xe0?', (258, 772), b'dHJhY2U=', b'foo', '900150983cd24fb0d6963f7d28e17f72', 'ba7816bf8f01cfea', 'a7ffc6f8bf1ed766', '4adf4367f96e584f', 'HIRAGANA LETTER A', 'ガ1', '•', b'\\x02\\x01', -2]
for a, e in zip(actual, expected):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('a bytearray cannot be resized while a reachable memoryview exports it', () => {
  const program = `b = bytearray(b'abc')
m = memoryview(b)
try:
    b.append(1)
    raise ValueError('resized while exported')
except BufferError:
    pass
del m
b.append(100)
memoryview(b)[0]
b.extend(b'!')
if b != bytearray(b'abcd!'):
    raise ValueError(repr(b))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

// CPython 3.14.10 gives these values for the same expressions.
test('subclasses of bytes and bytearray and bytes patterns of re behave as in CPython', () => {
  const program = `import re
class Tag(bytes):
    def __new__(cls, value, name):
        tag = super().__new__(cls, value)
        tag.name = name
        return tag
class Log(bytearray):
    pass
tag = Tag(b'ab', 'x')
log = Log(b'q')
log += b'!'
match = re.search(rb'(?P<word>\\w+)@', b'caf\\xe9 bob@x')
actual = [tag + b'c', type(tag.upper()).__name__, tag.name, repr(log), type(log[:1]).__name__, match, match['word'], re.sub(rb'(\\d)', rb'<\\1>', bytearray(b'a1')), re.findall(rb'(?i)[a-z]+', b'AB\\xc0cd'), re.compile(b'a', re.L)]
expected = [b'abc', 'bytes', 'x', "Log(b'q!')", 'bytearray', "<re.Match object; span=(5, 9), match=b'bob@'>", b'bob', b'a<1>', [b'AB', b'cd'], "re.compile(b'a', re.LOCALE)"]
for a, e in zip(actual, expected):
    if (repr(a) if isinstance(e, str) and not isinstance(a, str) else a) != e:
        raise ValueError(repr(a) + ' != ' + repr(e))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  [
    'a strict decoding error',
    `b'a\\xff'.decode()`,
    "UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff in position 1: invalid start byte",
  ],
  [
    'an encoding error of a Japanese codec',
    `'\\u20ac'.encode('cp932')`,
    String.raw`UnicodeEncodeError: 'cp932' codec can't encode character '\u20ac' in position 0: illegal multibyte sequence`,
  ],
  [
    'a struct error',
    `import struct
struct.pack('<h', 70000)`,
    "struct.error: 'h' format requires -32768 <= number <= 32767",
  ],
  [
    'a base64 padding error',
    `import base64
base64.b64decode('abc')`,
    'binascii.Error: Incorrect padding',
  ],
  ['a codec this grader lacks', `'x'.encode('gbk')`, '文字コード gbk は、この採点環境では使えません。'],
  [
    'an unknown name in a regular expression',
    `import re
assert re.sub(r'\\N{EM DASH}', '-', 'a\\u2014b') == 'a-b'
re.compile(r'\\N{NOPE}')`,
    "re.PatternError: undefined character name 'NOPE' at position 0",
  ],
  [
    'a str pattern on bytes',
    "import re\nre.search('a', b'a')",
    'TypeError: cannot use a string pattern on a bytes-like object',
  ],
])('%s ends the program as CPython does', (_name, program, uncaughtException) => {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException });
});
