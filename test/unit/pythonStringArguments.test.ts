import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('string subclasses flow through numeric, date, CSV and XML native APIs', () => {
  const program = `import decimal, fractions, datetime, time, csv, xml.etree.ElementTree as ET
class Text(str):
    def __str__(self): raise AssertionError('conversion hook')
assert decimal.Decimal(Text('1.25')) == decimal.Decimal('1.25')
assert fractions.Fraction(Text('3/4')) == fractions.Fraction(3, 4)
assert complex(Text('1+2j')) == 1+2j
assert datetime.datetime.strptime(Text('2024-01-02'), Text('%Y-%m-%d')) == datetime.datetime(2024, 1, 2)
assert datetime.date.fromisoformat(Text('2024-01-02')) == datetime.date(2024, 1, 2)
assert datetime.datetime.fromisoformat(Text('2024-01-02T03:04:05')) == datetime.datetime(2024, 1, 2, 3, 4, 5)
assert datetime.time.fromisoformat(Text('03:04:05')) == datetime.time(3, 4, 5)
assert time.strftime(Text('%Y'), time.gmtime(0)) == '1970'
assert datetime.date(2024, 1, 2).strftime(Text('%Y')) == '2024'
assert next(csv.reader([Text('a,b')])) == ['a', 'b']
reader = csv.reader(['a;b'], delimiter=Text(';'))
assert type(reader.dialect.delimiter) is str
assert next(reader) == ['a', 'b']
assert next(csv.reader(['"a,b",c'], quotechar=Text('"'))) == ['a,b', 'c']
assert next(csv.reader(['a!;b;c'], delimiter=Text(';'), escapechar=Text('!'))) == ['a;b', 'c']
assert ET.fromstring(Text('<a/>')).tag == 'a'
try: ET.fromstring(3)
except TypeError as error: assert str(error) == "a bytes-like object is required, not 'int'"
else: raise AssertionError('accepted')
print('values')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'values\n',
    uncaughtException: undefined,
  });
});

test('string subclasses name attributes, types, compiled code, enum and tuple factories', () => {
  const program = `import collections, enum, operator
class Text(str): pass
class Value: pass
value = Value()
setattr(value, Text('x'), 3)
assert getattr(value, Text('x')) == 3
assert object.__getattribute__(value, Text('x')) == 3
assert getattr(int, Text('real')) is int.real
delattr(value, Text('x'))
assert not hasattr(value, Text('x'))
assert type(Text('T'), (), {}).__name__ == 'T'
assert __import__(Text('math')).e > 2
code = compile(Text('1+2'), Text('<tagged>'), Text('eval'))
assert code.co_filename == '<tagged>' and eval(code) == 3
class Path:
    def __fspath__(self): return Text('<path>')
assert compile('1', Path(), 'eval').co_filename == '<path>'
assert compile('1', b'<bytes>', 'eval').co_filename == '<bytes>'
Pair = collections.namedtuple(Text('Pair'), Text('a b'))
assert Pair(1, 2).b == 2
Color = enum.Enum(Text('Color'), Text('RED BLUE'))
assert Color.BLUE.value == 2
assert operator.attrgetter(Text('real'))(3) == 3
assert operator.methodcaller(Text('upper'))('ab') == 'AB'
print('names')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'names\n',
    uncaughtException: undefined,
  });
});

test('operator callables defer argument repr and preserve string-subclass repr', () => {
  const program = `import operator
seen = []
class Text(str):
    def __repr__(self):
        seen.append('repr')
        return "'tagged'"
for create, target, expected in [(operator.attrgetter, 3, 3), (operator.itemgetter, {'real': 4}, 4)]:
    getter = create(Text('real'))
    assert seen == []
    assert getter(target) == expected
    assert seen == []
    assert repr(getter).endswith("('tagged')")
    assert seen == ['repr']
    seen.clear()
caller = operator.methodcaller(Text('upper'))
assert seen == [] and caller('ab') == 'AB'
assert repr(caller) == "operator.methodcaller('tagged')"
assert seen == ['repr']
print('repr')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'repr\n',
    uncaughtException: undefined,
  });
});

test('type names and compiled filenames retain supplied string objects and their ownership', () => {
  const program = `import gc
class Text(str):
    def __del__(self): print('released', str.__str__(self))
name = Text('Tagged')
module = Text('tagged.module')
Type = type(name, (), {'__module__': module})
assert Type.__module__ is module
Type.__module__ = '__main__'
del module
assert Type.__name__ is name and Type.__qualname__ is name
del name
gc.collect()
print('type retained')
type.__setattr__(Type, '__name__', 'Renamed')
type.__setattr__(Type, '__qualname__', 'Renamed')
print('type renamed')
filename = Text('<tagged>')
code = compile('1', filename, 'eval')
assert code.co_filename is filename
del filename
gc.collect()
print('code retained')
del code
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      'released tagged.module\ntype retained\nreleased Tagged\ntype renamed\ncode retained\nreleased <tagged>\nend\n',
    uncaughtException: undefined,
  });
});
