import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Runs a program that raises when a value it computes differs from what CPython 3.14.10 computes for it. */
function expectSameAsCPython(program: string): void {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

test('template strings carry their interpolations and annotations are evaluated only when asked for', () => {
  expectSameAsCPython(`from string.templatelib import Template, Interpolation
import annotationlib, traceback, sys, weakref, threading, io, enum
name = 'World'
t = t'Hello {name!r:>8}!'
assert type(t) is Template and t.strings == ('Hello ', '!')
i = t.interpolations[0]
assert (i.value, i.expression, i.conversion, i.format_spec) == ('World', 'name', 'r', '>8')
assert list(t) == ['Hello ', i, '!']
def f(x: Undefined) -> int: pass
assert annotationlib.get_annotations(f, format=annotationlib.Format.STRING) == {'x': 'Undefined', 'return': 'int'}
try:
    f.__annotations__
except NameError as e:
    assert str(e) == "name 'Undefined' is not defined"
else:
    raise AssertionError('no NameError')
`);
});

test('tracebacks link the frames an exception passed through, outermost first', () => {
  expectSameAsCPython(`from string.templatelib import Template, Interpolation
import annotationlib, traceback, sys, weakref, threading, io, enum
def inner(): 1 / 0
def outer(): inner()
try:
    outer()
except ZeroDivisionError as e:
    tb = e.__traceback__
    names = []
    while tb:
        names.append(tb.tb_frame.f_code.co_name)
        tb = tb.tb_next
    assert names == ['<module>', 'outer', 'inner'], names
    assert sys._getframe().f_code.co_name == '<module>'
`);
});

test('finalizers run when the last reference goes, and a busy-waiting thread lets the others run', () => {
  expectSameAsCPython(`from string.templatelib import Template, Interpolation
import annotationlib, traceback, sys, weakref, threading, io, enum
class Node: pass
log = []
n = Node()
weakref.finalize(n, log.append, 'gone')
del n
assert log == ['gone']
done = []
def setter():
    while not done:
        pass
    done.append('seen')
worker = threading.Thread(target=setter)
worker.start()
done.append('set')
worker.join()
assert done == ['set', 'seen']
`);
});

test('TextIOWrapper translates newlines and a strict flag rejects unknown bits', () => {
  expectSameAsCPython(`from string.templatelib import Template, Interpolation
import annotationlib, traceback, sys, weakref, threading, io, enum
w = io.TextIOWrapper(io.BytesIO(), encoding='utf-8', newline='\\r\\n')
w.write('a\\nb\\n'); w.flush()
assert w.buffer.getvalue() == b'a\\r\\nb\\r\\n'
class Color(enum.Flag, boundary=enum.STRICT):
    RED = 1
    GREEN = 2
try:
    Color(7)
except ValueError as e:
    assert str(e).startswith('<flag \\'Color\\'> invalid value 7'), str(e)
else:
    raise AssertionError('no ValueError')
`);
});

test('the charmap, Chinese, Korean, UTF-7, and IDNA codecs convert as CPython does, as does Unicode 3.2.0', () => {
  expectSameAsCPython(`import codecs, random, unicodedata
assert '€Ł'.encode('cp1250') == b'\\x80\\xa3' and b'\\xd0\\xd1'.decode('koi8_r') == 'пя'
assert '中文한국'.encode('gb18030') == b'\\xd6\\xd0\\xce\\xc4\\x836\\x843\\x827\\xf40'
assert '中文'.encode('hz') == b'~{VPND~}' and '갂'.encode('euc_kr') == b'\\xa4\\xd4\\xa4\\xa1\\xa4\\xbf\\xa4\\xa2'
assert 'Hi ☺+'.encode('utf-7') == b'Hi +JjoAKw-' and 'münchen.de'.encode('idna') == b'xn--mnchen-3ya.de'
try:
    b'\\x81'.decode('big5')
except UnicodeDecodeError as e:
    assert (e.start, e.end, e.reason) == (0, 1, 'incomplete multibyte sequence')
else:
    raise AssertionError('no UnicodeDecodeError')
assert codecs.charmap_decode(b'\\x00\\x01', 'strict', {0: 'ab', 1: 66}) == ('abB', 2)
assert unicodedata.ucd_3_2_0.category('ȡ') == 'Cn' and unicodedata.category('ȡ') == 'Ll'
`);
});

test('a subclass of random.Random that overrides random() chooses with it', () => {
  expectSameAsCPython(`import random
class Quarter(random.Random):
    def random(self):
        return 0.25
q = Quarter(1)
assert (q.choice('abcd'), q.randrange(10), q._randbelow.__name__) == ('a', 8, '_randbelow_without_getrandbits')
assert random.Random(7).random() == 0.32383276483316237
`);
});

test("the JIS X 0213 and ISO-2022 codecs, incremental decoding, quopri, and random's bound methods are as in CPython", () => {
  expectSameAsCPython(`import codecs, quopri, random
assert 'か゚か'.encode('shift_jis_2004') == b'\\x82\\xf5\\x82\\xa9' and '俱'.encode('euc_jis_2004') == b'\\xae\\xa1'
assert 'か゚日a'.encode('iso2022_jp_2004') == b'\\x1b$(Q$w\\x1b$BF|\\x1b(Ba' and '한a'.encode('iso2022_kr') == b'\\x1b$)C\\x0eGQ\\x0fa'
assert b'\\x1b$B$+\\x1b(Bx'.decode('iso2022_jp_3') == 'かx'
decoder = codecs.getincrementaldecoder('hz')()
assert [decoder.decode(bytes([b])) for b in b'~{VP~}a'] == ['', '', '', '中', '', '', 'a']
assert quopri.encodestring(b'caf\\xe9 = ok') == b'caf=E9 =3D ok'
assert repr(random.randint).startswith('<bound method Random.randint of <random.Random object at ')
`);
});
