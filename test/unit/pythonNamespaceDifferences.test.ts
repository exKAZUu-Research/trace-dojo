import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// CPython 3.14.10 computes `expected`.
test('code objects, cells, dict reverse iterators, and site builtins behave as CPython', () => {
  const program = String.raw`import json.decoder, ast
actual = []
c, d = compile('x = 1', 'a', 'exec'), compile('x = 1', 'b', 'exec')
actual += [c == d, hash(c) == hash(d), c == compile('x = 2', 'a', 'exec')]
def outer():
    x = 1
    return lambda: x
f = outer()
actual += [f.__closure__[0] is f.__closure__[0], f.__closure__[0] == outer().__closure__[0]]
d = {1: 2, 3: 4}
it = reversed(d)
next(it)
d[5] = 6
try:
    next(it)
except RuntimeError as e:
    actual.append(str(e))
actual += [repr(quit), type(help).__name__, json.decoder.scanstring.__module__]
try:
    exit(3)
except SystemExit as e:
    actual.append(e.code)
actual += [sorted(vars(ast.expr)), len(dir(ast.parse('x')))]
expected = [True, True, False, True, True, 'dictionary changed size during iteration', 'Use quit() or Ctrl-D (i.e. EOF) to exit', '_Helper', '_json', 3, ['__doc__', '__match_args__', '__module__', '__weakref__', '_attributes', '_fields', 'end_col_offset', 'end_lineno'], 35]
for a, e in zip(actual, expected, strict=True):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('listing a namespace that differs from CPython fails loudly, while matching ones list', () => {
  const lists = String.raw`import math
names = dir(math), dir(str), dir(list), vars(math)`;
  expect(executeProgram('python', lists)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
  for (const listing of ['vars(Color)', 'dir(Color.RED)', 'Color.__dict__', 'help(Color)']) {
    const program = `import enum\nclass Color(enum.Enum):\n    RED = 1\n${listing}`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('この採点環境では使えません'),
    });
  }
});

// CPython 3.14.10 computes `expected`.
test('reading a name CPython serves outside its namespace works, while reading a grader-only name fails loudly', () => {
  const program = String.raw`import concurrent.futures as cf, decimal, io, json, typing
actual = [cf.ThreadPoolExecutor.__module__, typing.ForwardRef('int'), typing.Pattern, typing.Match]
c = decimal.Context()
actual += [c.traps[decimal.DivisionByZero], c.flags[decimal.Inexact]]
actual.append(list(vars(json.JSONDecoder()))[6:9])
f = io.StringIO('a\nb\n')
actual += [f.readlines(), io.StringIO('ab\ncd\n').readlines(3), f.isatty(), f.encoding, f.errors]
f.writelines(['c']); f.flush()
actual.append(f.getvalue())
b = io.BytesIO(b'xyz')
buf = bytearray(2)
actual += [b.readinto1(buf), buf]
for stream in (io.StringIO(), io.BytesIO()):
    try:
        stream.detach()
    except io.UnsupportedOperation as e:
        actual.append(str(e))
class Upper(io.TextIOBase):
    def write(self, s):
        return len(s)
u = Upper()
actual += [u.writable(), u.closed]
u.close()
actual.append(u.closed)
class Raw(io.RawIOBase):
    pass
try:
    Raw().read()
except NotImplementedError as e:
    actual.append(repr(e))
actual += [[c.__name__ for c in io.StringIO.__mro__], [c.__name__ for c in io.BytesIO.__mro__],
           [c.__name__ for c in io.TextIOBase.__mro__], isinstance(io.StringIO(), io.IOBase),
           issubclass(io.BufferedReader, io.BufferedIOBase)]
expected = ['concurrent.futures.thread', typing.ForwardRef('int'), typing.Pattern, typing.Match, True, False,
            ['parse_object', 'parse_array', 'parse_string'], ['a\n', 'b\n'], ['ab\n', 'cd\n'], False, None, None,
            'a\nb\nc', 2, bytearray(b'xy'), 'detach', 'detach', False, False, True, 'NotImplementedError()',
            ['StringIO', '_TextIOBase', '_IOBase', 'object'], ['BytesIO', '_BufferedIOBase', '_IOBase', 'object'],
            ['TextIOBase', '_TextIOBase', 'IOBase', '_IOBase', 'object'], True, True]
for a, e in zip(actual, expected, strict=True):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
  for (const read of ['decimal.Context.traps', 'from io import os', 'import io\nio.os']) {
    expect(executeProgram('python', `import decimal\n${read}`)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('この採点環境では使えません'),
    });
  }
});

test('an uncaught AttributeError on an object whose namespace differs suggests a name as CPython does', () => {
  expect(executeProgram('python', 'import collections\ncollections.deque().pp')).toMatchObject({
    kind: 'executed',
    uncaughtException: "AttributeError: 'collections.deque' object has no attribute 'pp'. Did you mean: 'pop'?",
  });
});

test('lazy iterator namespaces expose complete matching classes and stop on unmatched classes', () => {
  const program = `values = [iter('é'), reversed({}), iter(lambda: 0, 0), iter(memoryview(b''))]
for iterator in values:
    namespace = type(iterator).__dict__
    print(list(namespace), namespace['__doc__'])`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout:
      "['__iter__', '__next__', '__length_hint__', '__reduce__', '__setstate__', '__doc__'] None\n" +
      "['__iter__', '__next__', '__length_hint__', '__reduce__', '__doc__'] None\n" +
      "['__iter__', '__next__', '__reduce__', '__doc__'] None\n" +
      "['__iter__', '__next__', '__doc__'] None\n",
    uncaughtException: undefined,
  });
  for (const factory of ['iter', 'reversed']) {
    const unmatched = `import collections
try:
    print(list(type(${factory}(collections.deque())).__dict__))
except BaseException:
    print('caught')
print('after')`;
    expect(executeProgram('python', unmatched)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: expect.stringContaining('この採点環境では使えません'),
    });
  }
});
