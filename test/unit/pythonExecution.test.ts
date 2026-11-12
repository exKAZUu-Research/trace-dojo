import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('a program that draws reports its final board and the turtles still reachable', () => {
  const execution = executeProgram(
    'python',
    `keep = Turtle(1, 1, 'G')
def draw():
    temporary = Turtle(4, 4, 'Y')
    temporary.forward()
draw()
keep.右を向く()
keep.前に進む()`
  );
  expect(execution).toEqual({
    kind: 'executed',
    finalBoard: ['.......', '.GG....', '.......', '.......', '....Y..', '....Y..', '.......'].join('\n'),
    finalTurtles: [{ x: 2, y: 1, color: 'G', dir: 'E' }],
    uncaughtException: undefined,
  });
});

// CPython 3.14.10 prints these values for the same expressions.
test('values print as CPython prints them', () => {
  const program = `import random
random.seed(42)
r = [random.randint(1, 100) for _ in range(3)]
l = list(range(8))
random.shuffle(l)
actual = [str({3, 1, 2}), str({10, 1, 100}), str({8, 1}), str({-1, -2, 5}), repr(0.1 + 0.2), repr(10.0 ** 16), repr(1/3), str(2 ** 100), f'{2.5:.0f}', f'{1234.5:012,.1f}', f'{0.125:.2f}', str(round(2.675, 2)), str(sum([0.1] * 10)), str(r), str(l), str(random.random())]
expected = ['{1, 2, 3}', '{1, 10, 100}', '{8, 1}', '{5, -1, -2}', '0.30000000000000004', '1e+16', '0.3333333333333333', '1267650600228229401496703205376', '2', '00,001,234.5', '0.12', '2.67', '1.0', '[82, 15, 4]', '[7, 3, 2, 0, 5, 6, 1, 4]', '0.5904925124490397']
for a, e in zip(actual, expected):
    if a != e:
        raise ValueError(a + ' != ' + e)`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['a misspelled name', "pritn('x')", "NameError: name 'pritn' is not defined. Did you mean: 'print'?"],
  [
    'a misspelled method',
    't = Turtle()\nt.foward()',
    "AttributeError: 'Turtle' object has no attribute 'foward'. Did you mean: 'forward'?",
  ],
  ['a module not imported', 'math.pi', "NameError: name 'math' is not defined. Did you forget to import 'math'?"],
  [
    'an attribute of self used as a name',
    'class A:\n    def __init__(self):\n        self.value = 1\n    def show(self):\n        return value\nA().show()',
    "NameError: name 'value' is not defined. Did you mean: 'self.value'?",
  ],
  [
    'a misspelled keyword argument',
    'def f(action=1):\n    pass\nf(actoin=2)',
    "TypeError: f() got an unexpected keyword argument 'actoin'. Did you mean 'action'?",
  ],
  ['a missing key', "{'a': 1}['b']", "KeyError: 'b'"],
  ['an exception with notes', "e = ValueError('x')\ne.add_note('one')\nraise e", 'ValueError: x\none'],
  ['a user exception', 'class Stop(Exception):\n    pass\nraise Stop()', 'Stop'],
  ['a turtle leaving the board', 't = Turtle(0, 6)\nt.前に進む()', 'RuntimeError: Out of bounds: (0, 7)'],
  ['an invalid color', "Turtle(0, 0, 'Z')", 'RuntimeError: Invalid color: Z'],
  ['unbounded recursion', 'def f(n):\n    return f(n + 1)\nf(0)', 'RecursionError: maximum recursion depth exceeded'],
  ['standard input', 'input()', '標準入力（input()）は、この採点環境では使えません。'],
  [
    'a subclass of a builtin type',
    'class Stack(list):\n    pass',
    '組み込み型 list を継承するクラスは、この採点環境では使えません。',
  ],
])('%s ends the program as CPython describes it', (_, source, description) => {
  expect(executeProgram('python', source)).toMatchObject({ kind: 'executed', uncaughtException: description });
});

test('a class defined in a function captures the variables of the function in its body, methods, and nested classes', () => {
  const program = `def outer():
    x = 7
    y = 1
    class C:
        value = x
        y = 2
        doubled = [x * 2 for _ in range(2)]
        def get(self):
            return x + y
        class D:
            def get(self):
                nonlocal x
                x += 1
                return x
    return [C.value, C.y, C.doubled, C().get(), C.D().get(), x]
actual = str(outer())
if actual != '[7, 2, [14, 14], 8, 8, 8]':
    raise ValueError(actual)`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('sys.exit ends the program without an uncaught exception', () => {
  expect(executeProgram('python', 'import sys\nsys.exit(3)\nraise ValueError')).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
  });
});

test.each([
  ['an unexpected indent', 'x = 1\n    y = 2', 1],
  ['a missing indented block', 'if True:\nprint(1)', 1],
  ['a dedent to no outer level', 'if True:\n    x = 1\n  y = 2', 2],
  ['return outside a function', 'return 1', 0],
  ['a positional argument after a keyword argument', 'f(a=1, 2)', 0],
  ['a capture pattern before another case', 'match 1:\n    case x:\n        pass\n    case 2:\n        pass', 1],
  ['nonlocal at module level', 'nonlocal x', 0],
  ['a Python 2 print statement', "print 'x'", 0],
  ['a conditional expression, which this grader does not support', 'x = 1 if True else 2', 0],
  ['an import of a file', 'import mymodule', 0],
])('%s is a compile error', (_, source, row) => {
  const execution = executeProgram('python', source);
  expect(execution.kind).toBe('compileError');
  if (execution.kind === 'compileError') expect(execution.diagnostics[0].row).toBe(row);
});

test.each([
  ['an infinite loop', 'while True:\n    pass', { kind: 'limitExceeded', limit: 'operations' }],
  ['endless output', "while True:\n    print('x' * 1000)", { kind: 'limitExceeded', limit: 'output' }],
  ['a huge integer', 'x = 2 ** (10 ** 9)', { kind: 'executed', uncaughtException: 'MemoryError' }],
  ['a huge string', "s = 'x'\nwhile True:\n    s += s", { kind: 'executed', uncaughtException: 'MemoryError' }],
  [
    'an endless generator',
    'def g():\n    while True:\n        yield 1\nfor x in g():\n    pass',
    { kind: 'limitExceeded' },
  ],
])('%s ends within the limits', (_, source, expected) => {
  const startedAt = performance.now();
  expect(executeProgram('python', source)).toMatchObject(expected);
  expect(performance.now() - startedAt).toBeLessThan(5000);
});

// CPython 3.14.10 gives these values; the library code written in Python (dataclasses, functools, collections, json)
// and the natives under it must keep giving them.
test('the standard library gives what CPython gives', () => {
  const program = `import functools, json, random, typing
from collections import ChainMap, Counter, UserDict
from dataclasses import dataclass, field, replace
@dataclass(frozen=True)
class P:
    x: int
    tags: list = field(default_factory=list, compare=False, hash=False)
@dataclass(unsafe_hash=True, order=True)
class Q:
    a: int
    b: str = 'z'
class D(UserDict):
    def __setitem__(self, key, value):
        super().__setitem__(key, value * 2)
@functools.singledispatch
def kind(x):
    return 'object'
@kind.register
def _(x: int):
    return 'int'
class Enc(json.JSONEncoder):
    def default(self, o):
        return sorted(o)
r = random.Random(7)
try:
    P(1).x = 2
except AttributeError as e:
    frozen = type(e).__name__ + ': ' + str(e)
try:
    Q()
except TypeError as e:
    missing = str(e)
actual = [hash(P(1)) == hash((1,)), {P(1), P(1, [2])} == {P(1)}, hash(Q(1)) == hash((1, 'z')), Q(1) < Q(2), frozen, missing,
          repr(replace(Q(1), b='y')), P.__doc__, str(D(a=1)), repr(ChainMap({'a': 1}, {'a': 2, 'b': 3})['b']),
          repr(+Counter(a=2, b=-1)), kind(True), kind('x'), json.dumps({'s': {3, 1}}, cls=Enc),
          repr(json.loads('[1.5]', parse_float=str)), repr(typing.get_args(typing.Callable[[int], str])),
          repr(typing.get_origin(typing.List[int])), repr(r.triangular(1, 5, 2)), repr(r.binomialvariate(20, 0.3)),
          'ǅ'.swapcase(), 'ǆa ΣΑΣ'.title(), 'ΑΣ'.lower()]
expected = [True, True, True, True, "FrozenInstanceError: cannot assign to field 'x'",
            "Q.__init__() missing 1 required positional argument: 'a'", "Q(a=1, b='y')", 'P(x: int, tags: list = <factory>)',
            "{'a': 2}", '3', "Counter({'a': 2})", 'int', 'object', '{"s": [1, 3]}', "['1.5']",
            "([<class 'int'>], <class 'str'>)", "<class 'list'>", '2.151490420939039', '4',
            'ǅ', 'ǅa Σας', 'ας']
for a, e in zip(actual, expected):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['a list in a set display', '{[]}', "TypeError: cannot use 'list' as a set element (unhashable type: 'list')"],
  ['a list looked up in a dict', '{}.get([])', "TypeError: cannot use 'list' as a dict key (unhashable type: 'list')"],
  ['a list in a set', '[] in set()', "TypeError: cannot use 'list' as a set element (unhashable type: 'list')"],
  ['hash() of a list', 'hash([])', "TypeError: unhashable type: 'list'"],
  ['a Counter of lists', 'import collections\ncollections.Counter([[]])', "TypeError: unhashable type: 'list'"],
  [
    'the traceback of a raised exception',
    'try:\n    1 / 0\nexcept Exception as e:\n    e.__traceback__',
    '例外のトレースバック（__traceback__）は、この採点環境では使えません。',
  ],
  [
    'math.gamma, which CPython takes from the C library',
    'import math\nmath.gamma(1.5)',
    'math.gamma()（C ライブラリの tgamma と最後の桁まで同じ値を出せないため）は、この採点環境では使えません。',
  ],
])('%s ends as in CPython', (_, source, uncaughtException) => {
  expect(executeProgram('python', source)).toMatchObject({ kind: 'executed', uncaughtException });
});

test('dir() of builtin objects lists their attributes', () => {
  const program = `names = [('real', dir(1)), ('start', dir(range(1))), ('__name__', dir(len)), ('indices', dir(slice(1))), ('__closure__', dir(lambda: 0)), ('fget', dir(property())), ('mapping', dir({}.keys()))]
for name, listed in names:
    if name not in listed:
        raise ValueError(name)
if dir(1) != sorted(dir(int)) or '__dict__' in dir(object()):
    raise ValueError('dir')`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});
