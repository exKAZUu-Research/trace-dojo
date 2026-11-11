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
  expect(executeProgram('python', checked)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
  });
}

test('zlib and gzip compress byte for byte as zlib 1.2.12 does, and decompress with its errors', () => {
  expectSameAsCPython(`import zlib, gzip, io
def error(f):
    try:
        return repr(f())
    except Exception as e:
        return f'{type(e).__module__}.{type(e).__name__}: {e}'
text = b''.join(b'%d bottles of beer on the wall, ' % i for i in range(3000))
noise = bytes((i * 7919 + (i >> 5) * 31) % 251 for i in range(70000))
stream = zlib.compressobj(6, zlib.DEFLATED, 31, 9, zlib.Z_FILTERED)
parts = [stream.compress(text[:5000]), stream.flush(zlib.Z_SYNC_FLUSH), stream.compress(text[5000:]), stream.flush()]
reader = zlib.decompressobj(47)
first = reader.decompress(b''.join(parts), 1000)
actual = [
    [(level, zlib.crc32(zlib.compress(data, level))) for data in (text, noise) for level in (0, 1, 4, 9)],
    [zlib.crc32(zlib.compress(text, 6, wbits)) for wbits in (9, -12, 31)],
    [len(part) for part in parts],
    (len(first), len(reader.unconsumed_tail), reader.decompress(reader.unconsumed_tail) + reader.flush() == text[1000:]),
    zlib.crc32(gzip.compress(text, mtime=1)),
    gzip.decompress(gzip.compress(b'a') + gzip.compress(b'b')),
    error(lambda: zlib.decompress(zlib.compress(b'abc')[:-1])),
    error(lambda: zlib.decompress(b'x\\x9c\\xff')),
    error(lambda: zlib.compressobj(10)),
    error(lambda: gzip.decompress(b'xx')),
]
expected = [[(0, 1277312336), (1, 2192038582), (4, 156371340), (9, 2511575681), (0, 362804242), (1, 3424847365), (4, 2812389539), (9, 2727373401)], [3531908186, 1939343927, 3353301471], [10, 392, 0, 6689], (1000, 6954, True), 2616556511, b'ab', 'zlib.error: Error -5 while decompressing data: incomplete or truncated stream', 'zlib.error: Error -3 while decompressing data: invalid block type', 'builtins.ValueError: Invalid initialization option', "gzip.BadGzipFile: Not a gzipped file (b'xx')"]`);
});

test('pickle and marshal write the bytes CPython writes, and pickle raises the errors of _pickle', () => {
  expectSameAsCPython(`import pickle, marshal, io, collections, datetime, fractions
def error(f):
    try:
        return repr(f())
    except Exception as e:
        return f'{type(e).__module__}.{type(e).__name__}: ' + str(e).split(' at 0x')[0]
class Point:
    def __init__(self, x, y):
        self.x, self.y = x, y
class Celsius:
    def __init__(self, degrees):
        self.degrees = degrees
    def __reduce__(self):
        return (Celsius, (self.degrees,))
class Secret:
    def __init__(self):
        self.shown, self.hidden = 1, 2
    def __getstate__(self):
        return {'shown': self.shown}
    def __setstate__(self, state):
        self.__dict__.update(state, restored=True)
shared = [1, 2]
data = {'name': 'Alice', 'scores': [90, 85.5], 'tags': {'a'}, 'pair': (shared, shared), 'when': datetime.date(2024, 5, 6)}
buffer = io.BytesIO()
pickle.Pickler(buffer, 2).dump(Point(1, 'é'))
restored = pickle.loads(pickle.dumps(data))
secret = pickle.loads(pickle.dumps(Secret()))
values = {'k': [1, 2.5, 'text', b'raw', None, (True, 1180591620717411303424)]}
actual = [
    [pickle.dumps(data, protocol) for protocol in (0, 2, 5)],
    buffer.getvalue(),
    [pickle.dumps(value) for value in (Celsius(21.5), collections.Counter('aab'), fractions.Fraction(1, 3), print)],
    (restored == data, restored['pair'][0] is restored['pair'][1]),
    (secret.__dict__, pickle.loads(pickle.dumps(Celsius(3))).degrees),
    error(lambda: pickle.dumps(lambda: 1)),
    error(lambda: pickle.loads(b'')),
    error(lambda: pickle.loads(b'\\x80\\x05K')),
    error(lambda: pickle.loads(b'z.')),
    marshal.dumps(values),
    marshal.loads(marshal.dumps(values)) == values,
    error(lambda: marshal.loads(b'\\x00')),
]
expected = [[b'(dp0\\nVname\\np1\\nVAlice\\np2\\nsVscores\\np3\\n(lp4\\nI90\\naF85.5\\nasVtags\\np5\\nc__builtin__\\nset\\np6\\n((lp7\\nVa\\np8\\natp9\\nRp10\\nsVpair\\np11\\n((lp12\\nI1\\naI2\\nag12\\ntp13\\nsVwhen\\np14\\ncdatetime\\ndate\\np15\\n(c_codecs\\nencode\\np16\\n(V\\x07\\xe8\\x05\\x06\\np17\\nVlatin1\\np18\\ntp19\\nRp20\\ntp21\\nRp22\\ns.', b'\\x80\\x02}q\\x00(X\\x04\\x00\\x00\\x00nameq\\x01X\\x05\\x00\\x00\\x00Aliceq\\x02X\\x06\\x00\\x00\\x00scoresq\\x03]q\\x04(KZG@U\`\\x00\\x00\\x00\\x00\\x00eX\\x04\\x00\\x00\\x00tagsq\\x05c__builtin__\\nset\\nq\\x06]q\\x07X\\x01\\x00\\x00\\x00aq\\x08a\\x85q\\tRq\\nX\\x04\\x00\\x00\\x00pairq\\x0b]q\\x0c(K\\x01K\\x02eh\\x0c\\x86q\\rX\\x04\\x00\\x00\\x00whenq\\x0ecdatetime\\ndate\\nq\\x0fc_codecs\\nencode\\nq\\x10X\\x05\\x00\\x00\\x00\\x07\\xc3\\xa8\\x05\\x06q\\x11X\\x06\\x00\\x00\\x00latin1q\\x12\\x86q\\x13Rq\\x14\\x85q\\x15Rq\\x16u.', b'\\x80\\x05\\x95t\\x00\\x00\\x00\\x00\\x00\\x00\\x00}\\x94(\\x8c\\x04name\\x94\\x8c\\x05Alice\\x94\\x8c\\x06scores\\x94]\\x94(KZG@U\`\\x00\\x00\\x00\\x00\\x00e\\x8c\\x04tags\\x94\\x8f\\x94(\\x8c\\x01a\\x94\\x90\\x8c\\x04pair\\x94]\\x94(K\\x01K\\x02eh\\t\\x86\\x94\\x8c\\x04when\\x94\\x8c\\x08datetime\\x94\\x8c\\x04date\\x94\\x93\\x94C\\x04\\x07\\xe8\\x05\\x06\\x94\\x85\\x94R\\x94u.'], b'\\x80\\x02c__main__\\nPoint\\nq\\x00)\\x81q\\x01}q\\x02(X\\x01\\x00\\x00\\x00xq\\x03K\\x01X\\x01\\x00\\x00\\x00yq\\x04X\\x02\\x00\\x00\\x00\\xc3\\xa9q\\x05ub.', [b'\\x80\\x05\\x95%\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x8c\\x08__main__\\x94\\x8c\\x07Celsius\\x94\\x93\\x94G@5\\x80\\x00\\x00\\x00\\x00\\x00\\x85\\x94R\\x94.', b'\\x80\\x05\\x95/\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x8c\\x0bcollections\\x94\\x8c\\x07Counter\\x94\\x93\\x94}\\x94(\\x8c\\x01a\\x94K\\x02\\x8c\\x01b\\x94K\\x01u\\x85\\x94R\\x94.', b'\\x80\\x05\\x95"\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x8c\\tfractions\\x94\\x8c\\x08Fraction\\x94\\x93\\x94K\\x01K\\x03\\x86\\x94R\\x94.', b'\\x80\\x05\\x95\\x16\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x8c\\x08builtins\\x94\\x8c\\x05print\\x94\\x93\\x94.'], (True, True), ({'shown': 1, 'restored': True}, 3), "_pickle.PicklingError: Can't pickle local object <function <lambda>.<locals>.<lambda>", 'builtins.EOFError: Ran out of input', '_pickle.UnpicklingError: pickle data was truncated', "_pickle.UnpicklingError: invalid load key, 'z'.", b'\\xfb\\xda\\x01k[\\x06\\x00\\x00\\x00\\xe9\\x01\\x00\\x00\\x00\\xe7\\x00\\x00\\x00\\x00\\x00\\x00\\x04@\\xda\\x04text\\xf3\\x03\\x00\\x00\\x00rawN\\xa9\\x02T\\xec\\x05\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x040', True, 'builtins.ValueError: bad marshal data (unknown type code)']`);
});

test("unittest and doctest report as CPython does, with CPython's assertion messages", () => {
  expectSameAsCPython(`import unittest, doctest, io, contextlib

class Calculator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.log = []
    def setUp(self):
        self.log.append(self._testMethodName)
    def test_add(self):
        self.assertEqual(1 + 2, 3)
    def test_items(self):
        for i in range(3):
            with self.subTest(i=i):
                self.assertLess(i, 3)
    @unittest.skip('later')
    def test_skipped(self):
        pass
    @unittest.expectedFailure
    def test_known_bug(self):
        self.assertEqual(0.1 + 0.2, 0.3)

def message(check):
    try:
        check()
    except AssertionError as e:
        return str(e)

case = unittest.TestCase()
stream = io.StringIO()
result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.TestLoader().loadTestsFromTestCase(Calculator))

def area(width, height):
    """Return the area.

    >>> area(2, 3)
    6
    >>> area(-1, 2)
    Traceback (most recent call last):
    ValueError: negative size
    """
    if width < 0 or height < 0:
        raise ValueError('negative size')
    return width * height

out = io.StringIO()
with contextlib.redirect_stdout(out):
    results = doctest.testmod(verbose=True)
actual = [
    stream.getvalue(),
    (result.testsRun, len(result.skipped), len(result.expectedFailures), result.wasSuccessful(), Calculator.log),
    message(lambda: case.assertEqual([1, 2, 3], [1, 2, 4])),
    message(lambda: case.assertEqual('one\\ntwo\\n', 'one\\nthree\\n')),
    message(lambda: case.assertDictEqual({'a': 1}, {'a': 2})),
    message(lambda: case.assertIn(4, [1, 2], 'not there')),
    message(lambda: case.assertRaises(ValueError, int, '5')),
    message(lambda: case.assertAlmostEqual(1.0, 1.1)),
    out.getvalue(),
    results,
]
expected = ["test_add (__main__.Calculator.test_add) ... ok\\ntest_items (__main__.Calculator.test_items) ... ok\\ntest_known_bug (__main__.Calculator.test_known_bug) ... expected failure\\ntest_skipped (__main__.Calculator.test_skipped) ... skipped 'later'\\n\\n----------------------------------------------------------------------\\nRan 4 tests in 0.000s\\n\\nOK (skipped=1, expected failures=1)\\n", (4, 1, 1, True, ['test_add', 'test_items', 'test_known_bug']), 'Lists differ: [1, 2, 3] != [1, 2, 4]\\n\\nFirst differing element 2:\\n3\\n4\\n\\n- [1, 2, 3]\\n?        ^\\n\\n+ [1, 2, 4]\\n?        ^\\n', "'one\\\\ntwo\\\\n' != 'one\\\\nthree\\\\n'\\n  one\\n- two\\n+ three\\n", "{'a': 1} != {'a': 2}\\n- {'a': 1}\\n?       ^\\n\\n+ {'a': 2}\\n?       ^\\n", '4 not found in [1, 2] : not there', 'ValueError not raised by int', '1.0 != 1.1 within 7 places (0.10000000000000009 difference)', 'Trying:\\n    area(2, 3)\\nExpecting:\\n    6\\nok\\nTrying:\\n    area(-1, 2)\\nExpecting:\\n    Traceback (most recent call last):\\n    ValueError: negative size\\nok\\n9 items had no tests:\\n    __main__\\n    __main__.Calculator\\n    __main__.Calculator.setUp\\n    __main__.Calculator.setUpClass\\n    __main__.Calculator.test_add\\n    __main__.Calculator.test_items\\n    __main__.Calculator.test_known_bug\\n    __main__.Calculator.test_skipped\\n    __main__.message\\n1 item passed all tests:\\n   2 tests in __main__.area\\n2 tests in 10 items.\\n2 passed.\\nTest passed.\\n', doctest.TestResults(failed=0, attempted=2)]`);
});
