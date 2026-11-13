import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('native formatting, codecs and buffered I/O read string payloads without conversion hooks', () => {
  const program = `import array, codecs, datetime, decimal, fractions, hmac, io, logging, string
class Text(str):
    def __str__(self): raise AssertionError('conversion hook')
assert format(5, Text('>3')) == '  5'
assert datetime.date(2024, 1, 2).__format__(Text('%Y')) == '2024'
assert decimal.Decimal(1).__format__(Text('.2f')) == '1.00'
assert fractions.Fraction(1, 3).__format__(Text('.2f')) == '0.33'
assert datetime.datetime(2024, 1, 2).isoformat(Text('T'), Text('hours')) == '2024-01-02T00'
assert datetime.time(3).isoformat(Text('hours')) == '03'
assert str.maketrans(Text('a'), Text('b')) == {97: 98}
assert 'a'.translate({97: Text('changed')}) == 'changed'
assert string.Formatter().format(Text('{}'), 1) == '1'
assert codecs.lookup(Text('utf-8')).name == 'utf-8'
assert codecs.encode(Text('abc'), Text('utf-7'), Text('strict')) == b'abc'
assert codecs.charmap_decode(b'a', Text('strict'), {97: Text('changed')})[0] == 'changed'
codecs.register_error('tagged', lambda error: (Text('replacement'), error.end))
assert b'\\xff'.decode('ascii', 'tagged') == 'replacement'
assert chr(233).encode('ascii', 'tagged') == b'replacement'
assert hmac.compare_digest(Text('same'), Text('same'))
assert b'ab'.hex(Text('-')) == '61-62'
assert array.array(Text('w'), [Text('a')]).tounicode() == 'a'
errors = Text('strict')
stream = io.TextIOWrapper(io.BytesIO(b'abc'), encoding=Text('utf-8'), errors=errors)
assert type(stream.encoding) is str and stream.errors is errors
assert stream.read() == 'abc'
assert logging.Formatter(Text('%(message)s')).format(logging.makeLogRecord({'msg': 'm'})) == 'm'
output = io.StringIO()
class Separator(str): pass
print('a', 'b', sep=Separator('-'), end=Separator('!'), file=output)
assert output.getvalue() == 'a-b!'
print('formatted')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'formatted\n',
    uncaughtException: undefined,
  });
});

test('enum factories retain string-subclass member names and dispatch name methods', () => {
  const program = `from enum import Enum, StrEnum
class Text(str): pass
name = Text('RED')
for members in [[name], [(name, 1)], {name: 1}]:
    Color = Enum('Color', members)
    assert Color.RED.name is name
    assert next(iter(Color.__members__)) is name
    assert Color[name] is Color.RED
    assert repr(Color.RED) == '<Color.RED: 1>'
class Lower(Text):
    def lower(self): return 'converted'
Color = StrEnum('Color', [Lower('RED')])
assert Color.RED.value == 'converted'
Color = StrEnum('Color', {'RED': Text('red')})
assert type(Color.RED.value) is str
print('enums')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'enums\n',
    uncaughtException: undefined,
  });
});

test('keyword and namespace keys retain Python identity, hashing and equality', () => {
  const program = `import functools, operator, types
class Text(str): pass
key = Text('field')
def collect(**kwargs): return kwargs
for mapping in [collect(**{key: 1}), dict(**{key: 2}), vars(types.SimpleNamespace(**{key: 3}))]:
    assert next(iter(mapping)) is key
def named(field): return field
assert named(**{key: 4}) == 4
partial = functools.partial(collect, **{key: 5})
assert next(iter(partial.keywords)) is key
assert next(iter(partial())) is key
class Target:
    def collect(self, **kwargs): return kwargs
assert next(iter(operator.methodcaller('collect', **{key: 6})(Target()))) is key
class Descriptor:
    def __set_name__(self, owner, name): assert name is key
class ClassNamespace:
    locals()[key] = Descriptor()
assert next(k for k in vars(ClassNamespace) if k == key) is key
Dynamic = type('Dynamic', (), {key: 1})
assert next(k for k in vars(Dynamic) if k == key) is key
global_key = Text('tagged_global')
globals()[global_key] = 7
assert tagged_global == 7
assert next(k for k in globals() if k == global_key) is global_key
class Different(Text):
    def __hash__(self): return 3
    def __eq__(self, other): return False
different = Different('tagged_global')
mapping = collect(**{different: 8, 'tagged_global': 9})
assert len(mapping) == 2 and mapping[different] == 8 and mapping['tagged_global'] == 9
import io
output = io.StringIO()
print('x', **{Different('file'): output, Different('end'): '!'}, flush=True)
assert output.getvalue() == 'x!'
assert sum([], **{Different('start'): 5}) == 5
assert sorted([1, 2], **{Different('reverse'): True}) == [2, 1]
assert round(1.23, **{Different('ndigits'): 1}) == 1.2
try: int('10', **{Different('base'): 16})
except TypeError as error: assert str(error) == "int() got an unexpected keyword argument 'base'"
else: raise AssertionError('accepted nonmatching keyword')
globals()[different] = 10
assert tagged_global == 7 and globals()[different] == 10
del globals()[different]
del globals()[global_key]
print('keys')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'keys\n',
    uncaughtException: undefined,
  });
});

test('attribute access passes original names to hooks and stores original dictionary keys', () => {
  const program = `class Text(str): pass
name = Text('field')
events = []
class Value:
    def __setattr__(self, key, value):
        events.append(key is name)
        object.__setattr__(self, key, value)
    def __getattribute__(self, key):
        if key == 'field': events.append(key is name)
        return object.__getattribute__(self, key)
    def __delattr__(self, key):
        events.append(key is name)
        object.__delattr__(self, key)
value = Value()
setattr(value, name, 3)
assert next(iter(vars(value))) is name
assert getattr(value, name) == 3
delattr(value, name)
assert events == [True, True, True]
assert vars(value) == {}
print('attributes')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'attributes\n',
    uncaughtException: undefined,
  });
});

test('native metadata retains supplied string objects', () => {
  const program = `import contextvars, datetime, inspect, types, typing
class Text(str): pass
name = Text('Tagged')
tag = typing.NewType(name, int)
assert tag.__name__ == name and tag.__qualname__ is name and tag(3) == 3
assert (tag | None).__args__ == (tag, type(None))
for make in [typing.TypeVar, typing.ParamSpec, typing.TypeVarTuple, lambda n: typing.TypeAliasType(n, int)]:
    assert make(name).__name__ is name
assert contextvars.ContextVar(name).name is name
zone = datetime.timezone(datetime.timedelta(hours=1), name)
assert zone.tzname(None) is name and str(zone) is name
assert types.ModuleType(name).__name__ is name
assert inspect.Parameter(name, inspect.Parameter.POSITIONAL_ONLY).name is name
def function(): pass
function.__name__ = name
function.__qualname__ = name
assert function.__name__ is name and function.__qualname__ is name
group = ExceptionGroup(name, [ValueError()])
assert group.message is name and group.derive([TypeError()]).message is name
group.add_note(name)
assert group.__notes__[0] is name
class Formatted:
    def __format__(self, spec):
        assert spec is name
        return name
assert format(Formatted(), name) is name
class Rendered:
    def __str__(self): return name
    def __repr__(self): return name
assert str(Rendered()) is name and repr(Rendered()) is name and ascii(Rendered()) is name
assert type(Text(Rendered())) is Text
seen = []
class Separator(Text):
    def __str__(self):
        seen.append('separator')
        return '-'
import io
output = io.StringIO()
print('a', 'b', 'c', sep=Separator('ignored'), file=output)
assert output.getvalue() == 'a-b-c\\n' and seen == ['separator', 'separator']
print('metadata')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'metadata\n',
    uncaughtException: undefined,
  });
});

test('native namespace keys and function names retain their values until replacement or deletion', () => {
  const program = `import gc
class Key(str):
    def __del__(self): print('key', str.__str__(self))
class Value:
    def __del__(self): print('value')
class Holder: pass
holder = Holder()
holder.__dict__[Key('field')] = Value()
gc.collect()
print('retained')
delattr(holder, 'field')
print('deleted')
def function(): pass
function.__name__ = Key('function')
gc.collect()
print('named')
function.__name__ = 'renamed'
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'retained\nkey field\nvalue\ndeleted\nnamed\nkey function\nend\n',
    uncaughtException: undefined,
  });
});

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
