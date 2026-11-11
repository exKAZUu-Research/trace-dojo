import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Runs a program that raises when a value it computes differs from what CPython 3.14.10 computes for it. */
function expectSameAsCPython(program: string): void {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

test("expat reports CPython's well-formedness errors at CPython's positions", () => {
  expectSameAsCPython(String.raw`import xml.parsers.expat as E
def error(doc):
    p = E.ParserCreate()
    try:
        p.Parse(doc, True)
    except E.ExpatError as e:
        return (e.code, e.lineno, e.offset, str(e))
expected = {
    '<a>&</a>': (4, 1, 4, 'not well-formed (invalid token): line 1, column 4'),
    '<a b="1" b="2"/>': (8, 1, 9, 'duplicate attribute: line 1, column 9'),
    '<a>\n\n  <b>\n</a>': (7, 4, 2, 'mismatched tag: line 4, column 2'),
    '<?xml version="2.0"?><a/>': (30, 1, 15, 'XML declaration not well-formed: line 1, column 15'),
    '<!DOCTYPE a [<!ENTITY e "&e;">]><a>&e;</a>': (12, 1, 35, 'recursive entity reference: line 1, column 35'),
    '<a/><b/>': (9, 1, 4, 'junk after document element: line 1, column 4'),
}
for doc, value in expected.items():
    assert error(doc) == value, (doc, error(doc))
`);
});

test("expat delivers fed data as CPython's expat defers partial tokens", () => {
  expectSameAsCPython(String.raw`import xml.parsers.expat as E
log = []
p = E.ParserCreate()
p.StartElementHandler = lambda name, attrs: log.append(('start', name))
p.CharacterDataHandler = lambda data: log.append(('data', data))
doc = '<a>hel<b/>lo</a>'
for i in range(0, len(doc), 3):
    p.Parse(doc[i:i + 3], False)
    log.append('feed')
p.Parse('', True)
assert log == [('start', 'a'), 'feed', ('data', 'hel'), 'feed', 'feed', ('start', 'b'), ('data', 'lo'),
               'feed', 'feed', 'feed'], log
`);
});

test('ElementTree, minidom, and sax build and write documents as CPython does', () => {
  expectSameAsCPython(String.raw`import xml.etree.ElementTree as ET, io
from xml.dom import minidom
import xml.sax
root = ET.fromstring('<r a="1"><c>t &amp; u</c><!--x--><d/></r>')
ET.SubElement(root, 'e', k='v').text = '<'
assert ET.tostring(root) == b'<r a="1"><c>t &amp; u</c><d /><e k="v">&lt;</e></r>'
assert root.items() == [('a', '1')]
try:
    root.append('x')
except TypeError as e:
    assert str(e) == 'append() argument 1 must be xml.etree.ElementTree.Element, not str'
try:
    ET.fromstring('<a><b></a>')
except ET.ParseError as e:
    assert (str(e), e.position) == ('mismatched tag: line 1, column 8', (1, 8))
doc = minidom.parseString('<a><b>1</b></a>')
assert doc.toprettyxml(indent=' ') == '<?xml version="1.0" ?>\n<a>\n <b>1</b>\n</a>\n'
seen = []
class H(xml.sax.ContentHandler):
    def startElement(self, name, attrs):
        seen.append((name, dict(attrs)))
xml.sax.parseString('<a x="1"><b/></a>', H())
assert seen == [('a', {'x': '1'}), ('b', {})]
`);
});

test('codeop tells complete, incomplete, and invalid input as CPython does', () => {
  expectSameAsCPython(String.raw`import codeop
def kind(source, symbol='single'):
    try:
        return 'code' if codeop.compile_command(source, symbol=symbol) else None
    except SyntaxError:
        return 'error'
assert [kind(s) for s in ['x = 1', 'if x:', 'if x:\n  pass', 'if x:\n  pass\n', '(1,', '1 +', 'lambda:']] == \
    ['code', None, None, 'code', None, 'error', 'error']
assert kind('for i in range(3): print(i)', 'exec') == 'code'
`);
});

test("builtins carry CPython's docstrings and signatures, which help() prints as pydoc does", () => {
  expectSameAsCPython(String.raw`import inspect, io, sys, math
assert len.__doc__ == 'Return the number of items in a container.'
assert str.split.__text_signature__ == '($self, /, sep=None, maxsplit=-1)'
assert str(inspect.signature(sorted)) == '(iterable, /, *, key=None, reverse=False)'
assert str(inspect.signature(list.index)) == '(self, value, start=0, stop=9223372036854775807, /)'
out = io.StringIO()
sys.stdout, saved = out, sys.stdout
help(len)
help(math.sqrt)
sys.stdout = saved
assert out.getvalue() == ('Help on built-in function len in module builtins:\n\nlen(obj, /)\n'
                          '    Return the number of items in a container.\n\n'
                          'Help on built-in function sqrt in module math:\n\nsqrt(x, /)\n'
                          '    Return the square root of x.\n\n'), out.getvalue()
`);
});

test("native functions name CPython's C accelerator as their module", () => {
  expectSameAsCPython(String.raw`import operator, heapq, bisect, struct, functools, sys
assert operator.add.__module__ == '_operator' and heapq.heappush.__module__ == '_heapq'
assert bisect.insort.__module__ == '_bisect' and struct.pack.__module__ == '_struct'
assert functools.reduce.__module__ == '_functools'
assert sys.modules['_heapq'].heappush is heapq.heappush
`);
});

test("the modules CPython's macOS build lacks fail with ModuleNotFoundError, which takes ImportError's keywords", () => {
  expectSameAsCPython(String.raw`for name in ['msvcrt', 'winreg', 'winsound', '_overlapped', '_wmi', '_gdbm', 'nt']:
    try:
        __import__(name)
    except ModuleNotFoundError as e:
        assert (str(e), e.name) == (f"No module named '{name}'", name)
    else:
        raise AssertionError(name)
e = ImportError('x', name='m', path='p')
assert (e.name, e.path, e.msg, e.name_from, e.args) == ('m', 'p', 'x', None, ('x',))
try:
    ImportError(foo=1)
except TypeError as t:
    assert str(t) == "ImportError() got an unexpected keyword argument 'foo'"
e = AttributeError('a', name='n', obj=4)
assert (e.name, e.obj) == ('n', 4)
e.name = 7
assert e.name == 7
`);
});

test("help() on a builtin type lists CPython's methods and builtin subclasses", () => {
  expectSameAsCPython(String.raw`import io, contextlib
def text(value):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        help(value)
    return out.getvalue()
assert ' |  Built-in subclasses:\n |      asyncgen_hooks\n |      UnraisableHookArgs\n' in text(tuple)
assert ' |  __sizeof__(self, /)\n |      Return the size of the list in memory, in bytes.\n' in text(list)
assert ' |  Static methods defined here:\n |\n |  __new__(*args, **kwargs)\n' in text(zip)
assert ' |  maketrans(' in text(str) and '__repr__' not in text(map)
class A: pass
class B(A): pass
assert A.__subclasses__() == [B]
assert (5).__format__('x') == '5' and (1.5).__sizeof__() == 24 and 'ab'.__sizeof__() == 43
`);
});

test('opcode, nturl2path, genericpath, and pydoc_data hold what CPython has', () => {
  expectSameAsCPython(String.raw`import opcode, nturl2path, genericpath, io, contextlib
assert opcode.opmap['LOAD_CONST'] == 82 and opcode.hasconst == [82] and opcode.opname[82] == 'LOAD_CONST'
assert opcode.hasjump[:3] == [68, 70, 75] and opcode.cmp_op[2] == '=='
assert nturl2path.pathname2url(r'C:\foo\bar spam.txt') == '///C:/foo/bar%20spam.txt'
assert nturl2path.url2pathname('///C:/foo/bar%20spam.txt') == r'C:\foo\bar spam.txt'
assert genericpath.commonprefix(['abc', 'abd']) == 'ab'
out = io.StringIO()
with contextlib.redirect_stdout(out):
    help('pass')
assert out.getvalue().startswith('The "pass" statement\n********************\n'), out.getvalue()[:60]
`);
});
