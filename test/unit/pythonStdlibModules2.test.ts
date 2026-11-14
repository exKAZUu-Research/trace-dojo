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

test('csv reads, writes, and sniffs as CPython does, with the messages of _csv', () => {
  expectSameAsCPython(`import csv, io
def error(f):
    try:
        return repr(f())
    except Exception as e:
        return f'{type(e).__module__}.{type(e).__name__}: {e}'
out = io.StringIO()
w = csv.writer(out, quoting=csv.QUOTE_NONNUMERIC)
w.writerows([['a,b', 'say "hi"', 1, 2.5, None], ['line\\nbreak', True]])
actual = [
    repr(list(csv.reader(['a,"b,c",d', '"multi', 'line",x', ' ,  "q" ,z'], skipinitialspace=True))),
    repr(list(csv.reader(['1,"2",,3'], quoting=csv.QUOTE_STRINGS))),
    out.getvalue(),
    repr(list(csv.DictReader(io.StringIO('a,b\\n1,2\\n3\\n4,5,6\\n')))),
    csv.Sniffer().sniff('a;b;c\\n1;2;3\\n').delimiter,
    error(lambda: list(csv.reader(['a,"b'], strict=True))),
    error(lambda: list(csv.reader(['a\\rb']))),
    error(lambda: csv.writer(io.StringIO(), quoting=csv.QUOTE_NONE).writerow(['a,b'])),
    error(lambda: csv.reader([], delimiter='ab')),
    error(lambda: csv.reader([], delimiter=';', quotechar=';')),
]
expected = ["[['a', 'b,c', 'd'], ['multiline', 'x'], ['', 'q ', 'z']]", "[[1.0, '2', None, 3.0]]", "\\"a,b\\",\\"say \\"\\"hi\\"\\"\\",1,2.5,\\"\\"\\r\\n\\"line\\nbreak\\",True\\r\\n", "[{'a': '1', 'b': '2'}, {'a': '3', 'b': None}, {'a': '4', 'b': '5', None: ['6']}]", ";", "_csv.Error: unexpected end of data", "_csv.Error: new-line character seen in unquoted field - do you need to open the file with newline=''?", "_csv.Error: need to escape, but no escapechar set", "builtins.TypeError: \\"delimiter\\" must be a unicode character, not a string of length 2", "builtins.ValueError: bad delimiter or quotechar value"]`);
});

test('codecs decodes incrementally and uses registered error handlers and search functions as CPython does', () => {
  expectSameAsCPython(`import codecs, io, sys
def error(f):
    try:
        return repr(f())
    except Exception as e:
        return f'{type(e).__name__}: {e}'
decoder = codecs.getincrementaldecoder('utf-8')()
sjis = codecs.getincrementaldecoder('shift_jis')()
data = 'あい'.encode('shift_jis')
codecs.register_error('angle', lambda e: ('<%d>' % e.start, e.end))
def search(name):
    if name == 'shout':
        return codecs.CodecInfo(lambda s, errors='strict': (s.upper().encode(), len(s)),
                                lambda b, errors='strict': (bytes(b).decode().lower(), len(b)), name='shout')
codecs.register(search)
stream = io.BytesIO()
codecs.getwriter('utf-16')(stream).write('hi')
actual = [
    sys.byteorder,
    codecs.encode('Hello', 'rot13'),
    repr(codecs.decode(b'68656c6c6f', 'hex')),
    codecs.lookup('UTF8').name,
    repr([decoder.decode(bytes([b])) for b in 'あ'.encode()]),
    repr([sjis.decode(data[i:i + 1]) for i in range(len(data))]),
    repr(codecs.utf_8_decode(b'a\\xe3\\x81', 'strict', False)),
    repr('aé€'.encode('ascii', 'angle')),
    b'a\\xffb'.decode('utf-8', 'angle'),
    repr('abc'.encode('shout')),
    repr(stream.getvalue()),
    repr(codecs.lookup_error('xmlcharrefreplace')(UnicodeEncodeError('ascii', 'aé', 1, 2, 'x'))),
    error(lambda: codecs.encode(b'x', 'utf-8')),
    error(lambda: 'x'.encode('rot13')),
    error(lambda: codecs.lookup('nope')),
]
expected = ["little", "Uryyb", "b'hello'", "utf-8", "['', '', 'あ']", "['', 'あ', '', 'い']", "('a', 1)", "b'a<1>'", "a<1>b", "b'ABC'", "b'\\\\xff\\\\xfeh\\\\x00i\\\\x00'", "('&#233;', 2)", "TypeError: utf_8_encode() argument 1 must be str, not bytes", "LookupError: 'rot13' is not a text encoding; use codecs.encode() to handle arbitrary codecs", "LookupError: unknown encoding: nope"]`);
});

test("argparse, configparser, difflib, urllib.parse, and pathlib give CPython's output, and OSError picks the subclass of its errno", () => {
  expectSameAsCPython(`import argparse, configparser, difflib, errno, urllib.parse
from pathlib import PurePosixPath, PureWindowsPath
parser = argparse.ArgumentParser(prog='tool', description='Sum the integers.')
parser.add_argument('integers', metavar='N', type=int, nargs='+', help='an integer for the accumulator')
parser.add_argument('--sum', dest='accumulate', action='store_const', const=sum, default=max, help='sum the integers (default: find the max)')
args = parser.parse_args(['1', '2', '3', '--sum'])
config = configparser.ConfigParser()
config.read_string('[DEFAULT]\\nhome = /home/%(user)s\\n[me]\\nuser = alice\\n')
error = OSError(errno.ENOENT, 'No such file or directory', 'data.txt')
actual = [
    parser.format_help(),
    str(args.accumulate(args.integers)),
    config['me']['home'],
    ''.join(difflib.unified_diff(['a\\n', 'b\\n'], ['a\\n', 'c\\n'], 'x', 'y')),
    repr(urllib.parse.urlsplit('https://user@example.com:8080/p?q=1#f')),
    str(PurePosixPath('/usr/lib') / 'x.tar.gz'),
    repr(PureWindowsPath('C:\\\\Users\\\\me').parts),
    f'{type(error).__name__}: {error} {error.args}',
]
expected = ["usage: tool [-h] [--sum] N [N ...]\\n\\nSum the integers.\\n\\npositional arguments:\\n  N           an integer for the accumulator\\n\\noptions:\\n  -h, --help  show this help message and exit\\n  --sum       sum the integers (default: find the max)\\n", "6", "/home/alice", "--- x\\n+++ y\\n@@ -1,2 +1,2 @@\\n a\\n-b\\n+c\\n", "SplitResult(scheme='https', netloc='user@example.com:8080', path='/p', query='q=1', fragment='f')", "/usr/lib/x.tar.gz", "('C:\\\\\\\\', 'Users', 'me')", "FileNotFoundError: [Errno 2] No such file or directory: 'data.txt' (2, 'No such file or directory')"]`);
});
