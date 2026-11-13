import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Runs a program whose list `actual` must equal `expected`, the list CPython 3.14.10 computes. */
function expectSameAsCPython(program: string): void {
  const checked = `${program}
for a, e in zip(actual, expected):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))
if len(actual) != len(expected):
    raise ValueError('lengths differ')`;
  expect(executeProgram('python', checked)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

test("unittest.mock, contextvars, and IsolatedAsyncioTestCase behave as CPython's", () => {
  expectSameAsCPython(`from unittest import mock
from unittest.mock import Mock, MagicMock, patch, call, ANY, sentinel
import math, contextvars, asyncio, unittest
actual = []
m = Mock()
m.foo(1, a=2)
try:
    m.foo.assert_called_with(9)
except AssertionError as e:
    actual.append(str(e))
mm = MagicMock()
mm.__len__.return_value = 3
actual += [len(mm), m.mock_calls == [call.foo(1, a=ANY)], repr(sentinel.x)]
with patch('math.floor', return_value=7):
    actual.append(math.floor(1.5))
class C:
    def meth(self, a, b=2): pass
auto = mock.create_autospec(C, instance=True)
try:
    auto.meth(1, 2, 3)
except TypeError as e:
    actual.append(str(e))
actual.append(isinstance(Mock(spec=int), int))
v = contextvars.ContextVar('v', default=0)
async def task(n):
    v.set(n)
    await asyncio.sleep(0)
    return v.get()
async def main():
    return await asyncio.gather(task(1), task(2)), v.get()
actual.append(asyncio.run(main()))
class T(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.x = await asyncio.sleep(0, 5)
    async def test_ok(self):
        self.assertEqual(self.x, 5)
    async def test_fail(self):
        self.assertEqual(self.x, 6)
r = unittest.TestResult()
unittest.defaultTestLoader.loadTestsFromTestCase(T).run(r)
actual.append((r.testsRun, len(r.failures)))
expected = ['expected call not found.\\nExpected: foo(9)\\n  Actual: foo(1, a=2)', 3, True, 'sentinel.x', 7, 'too many positional arguments', True, ([1, 2], 0), (2, 1)]`);
});

test("bz2 and lzma compress byte for byte as libbzip2 and liblzma do, and zipfile and tarfile write CPython's archives", () => {
  expectSameAsCPython(`import bz2, lzma, zlib, io, zipfile, tarfile
actual = []
for data in [b'', b'abc' * 3000, bytes((i * 7919) % 251 for i in range(5000)), b'ab' * 6000]:
    for c in [bz2.compress(data, 1), bz2.compress(data), lzma.compress(data), lzma.compress(data, preset=1, check=lzma.CHECK_CRC32), lzma.compress(data, format=lzma.FORMAT_ALONE)]:
        actual.append((len(c), zlib.crc32(c)))
    assert bz2.decompress(bz2.compress(data)) == data and lzma.decompress(lzma.compress(data)) == data
d = bz2.BZ2Decompressor()
c = bz2.compress(b'hello' * 1000)
actual.append((len(d.decompress(c[:20], 10)), d.needs_input, d.eof))
for bad in [lambda: bz2.decompress(b'BZh9xxxxxxxx'), lambda: lzma.decompress(b'not xz')]:
    try:
        bad()
    except Exception as e:
        actual.append((type(e).__name__, str(e)))
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w') as zf:
    for i, kind in enumerate([zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA]):
        zi = zipfile.ZipInfo(f'f{i}', (2024, 1, 2, 3, 4, 6))
        zi.compress_type = kind
        zf.writestr(zi, b'data %d ' % i * 100)
actual.append((len(buf.getvalue()), zlib.crc32(buf.getvalue())))
with zipfile.ZipFile(buf) as zf:
    actual.append([(i.filename, i.compress_size, zf.read(i)[:7]) for i in zf.infolist()])
tbuf = io.BytesIO()
with tarfile.open(fileobj=tbuf, mode='w', format=tarfile.PAX_FORMAT) as tf:
    ti = tarfile.TarInfo('dir/' + 'x' * 120)
    ti.size, ti.mtime = 4, 1700000000
    tf.addfile(ti, io.BytesIO(b'abcd'))
actual.append((len(tbuf.getvalue()), zlib.crc32(tbuf.getvalue())))
tbuf.seek(0)
with tarfile.open(fileobj=tbuf) as tf:
    actual.append([(m.name[-5:], m.size, tf.extractfile(m).read()) for m in tf])
expected = [(14, 3109940351), (14, 60689722), (32, 458167726), (32, 11232342), (23, 2010682358), (46, 86355085), (46, 1344868758), (108, 805854792), (104, 3395091577), (64, 2606449433), (712, 1101508947), (712, 3645228145), (332, 1310791560), (328, 1237005247), (286, 2904332106), (43, 2758236027), (43, 3725907588), (116, 3355739023), (112, 295058063), (69, 1760317542), (0, True, False), ('OSError', 'Invalid data stream'), ('LZMAError', 'Input format not supported by decoder'), (1148, 4278263686), [('f0', 700, b'data 0 '), ('f1', 16, b'data 1 '), ('f2', 58, b'data 2 '), ('f3', 32, b'data 3 ')], (10240, 1786901020), [('xxxxx', 4, b'abcd')]]`);
});

test("email parses and generates messages as CPython does, and symtable gives CPython's tables", () => {
  expectSameAsCPython(`import email, symtable
from email import policy
from email.message import EmailMessage
from email.header import decode_header, make_header
from email.utils import parseaddr, formatdate
actual = []
m = email.message_from_string('From: A <a@x.org>\\nSubject: =?utf-8?q?H=C3=A9?=\\nContent-Type: text/plain; charset=utf-8\\nContent-Transfer-Encoding: quoted-printable\\n\\nCaf=C3=A9\\n')
actual += [str(make_header(decode_header(m['Subject']))), parseaddr(m['From']), m.get_payload(decode=True), formatdate(0)]
e = EmailMessage()
e['Subject'] = 'Ünïcode subject long enough to need folding when it is generated by the policy'
e['To'] = 'You <you@example.com>'
e.set_content('Hello\\n')
e.add_attachment(b'\\x00\\x01', maintype='application', subtype='octet-stream', filename='a.bin')
e.set_boundary('B')
actual.append(e.as_string())
actual.append([p.get_content_type() for p in email.message_from_bytes(e.as_bytes(), policy=policy.default).walk()])
t = symtable.symtable('def f(a, *b):\\n    global g\\n    def h():\\n        return a + c\\n    c = 1\\n    return h\\nclass K:\\n    __p = 1\\n    def m(self): return __class__\\n', 'm', 'exec')
def dump(tab):
    out = [tab.get_type().name, tab.get_name(), tab.get_lineno()]
    for s in sorted(tab.get_symbols(), key=lambda s: s.get_name()):
        out.append((s.get_name(), s.is_local(), s.is_global(), s.is_free(), s.is_parameter(), s.is_referenced()))
    return [out] + [dump(c) for c in tab.get_children()]
actual.append(dump(t))
try:
    symtable.symtable('def f(x):\\n    global x\\n', 'm', 'exec')
except SyntaxError as err:
    actual.append((err.msg, err.lineno, err.offset))
expected = ['Hé', ('A', 'a@x.org'), b'Caf\\xc3\\xa9\\n', 'Thu, 01 Jan 1970 00:00:00 -0000', 'Subject: =?utf-8?b?w5xuw69jb2Rl?= subject long enough to need folding when it\\n is generated by the policy\\nTo: You <you@example.com>\\nMIME-Version: 1.0\\nContent-Type: multipart/mixed; boundary="B"\\n\\n--B\\nContent-Type: text/plain; charset="utf-8"\\nContent-Transfer-Encoding: 7bit\\n\\nHello\\n\\n--B\\nContent-Type: application/octet-stream\\nContent-Transfer-Encoding: base64\\nContent-Disposition: attachment; filename="a.bin"\\nMIME-Version: 1.0\\n\\nAAE=\\n\\n--B--\\n', ['multipart/mixed', 'text/plain', 'application/octet-stream'], [['MODULE', 'top', 0, ('K', True, True, False, False, False), ('f', True, True, False, False, False), ('g', False, True, False, False, False)], [['ANNOTATION', '__annotate__', 1, ('.format', True, False, False, True, True)]], [['FUNCTION', 'f', 1, ('a', True, False, False, True, False), ('b', True, False, False, True, False), ('c', True, False, False, False, False), ('g', False, True, False, False, False), ('h', True, False, False, False, True)], [['ANNOTATION', '__annotate__', 3, ('.format', True, False, False, True, True)]], [['FUNCTION', 'h', 3, ('a', False, False, True, False, True), ('c', False, False, True, False, True)]]], [['CLASS', 'K', 7, ('_K__p', True, False, False, False, False), ('m', True, False, False, False, False)], [['ANNOTATION', '__annotate__', 9, ('.format', True, False, False, True, True), ('__classdict__', False, False, True, False, True)]], [['FUNCTION', 'm', 9, ('__class__', False, False, True, False, True), ('self', True, False, False, True, False)]]]], ("name 'x' is parameter and global", 2, 5)]`);
});

test('BLAKE2 initial data binding preserves hashing and rejects ambiguous argument sources', () => {
  const program = `import hashlib
for constructor in [hashlib.blake2b, hashlib.blake2s]:
    positional = constructor(b'abc')
    keyword = constructor(data=b'abc')
    assert positional.digest() == keyword.digest() == constructor(string=b'abc').digest()
    for make in [lambda: constructor(b'a', data=b'b'), lambda: constructor(b'a', string=b'b'), lambda: constructor(data=b'a', string=b'b')]:
        try: make()
        except TypeError: pass
        else: raise AssertionError('ambiguous initial data')
    keyword.update(b'def')
    assert keyword.digest() == constructor(data=b'abcdef').digest()
print('digests')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'digests\n',
    uncaughtException: undefined,
  });
});
