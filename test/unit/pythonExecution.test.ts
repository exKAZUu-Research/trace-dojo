import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

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
    stdout: '',
    stderr: '',
    finalFiles: {},
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
    'a misspelled class variable in a class-body comprehension',
    'class A:\n    alpha = 1\n    beta = 2\n    gamma = [alpah for beta in [1]]',
    "NameError: name 'alpah' is not defined. Did you mean: 'alpha'?",
  ],
  [
    'a misspelled class variable in a class-body generator expression',
    'class D:\n    alpha = 1\n    g = list(alpah for _ in [1])',
    "NameError: name 'alpah' is not defined",
  ],
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

// CPython 3.14.10 runs this program without raising.
test('evaluation order, cleanup, and library protocols follow CPython', () => {
  const program = `import copy
import statistics
import sys
out = []
def mark(x):
    out.append(x)
    return []
def f(*args, **kwargs):
    pass
f(a=mark(1), *mark(2))
match {None: 5, True: 6}:
    case {None: x, True: y}:
        out.append(x + y)
try:
    try:
        raise ValueError()
    except Missing:
        pass
    finally:
        out.append('finally')
except NameError as e:
    out.append(type(e.__context__).__name__)
class Manager:
    def __enter__(self):
        return [1]
    def __exit__(self, kind, value, traceback):
        out.append(kind.__name__)
        return True
with Manager() as (a, b):
    pass
def once(value):
    yield value
    out.append('overconsumed')
out.append([all(once(False)), any(once(True))])
def outer():
    X = int
    def inner(a: X):
        pass
    return inner
out.append(outer().__annotations__['a'].__name__)
class Node:
    def __init__(self, value):
        self.value = value
        self.next = self
    def __deepcopy__(self, memo):
        new = Node(self.value * 10)
        memo[id(self)] = new
        new.next = copy.deepcopy(self.next, memo)
        return new
node = copy.deepcopy([Node(1)])[0]
out.append([node.value, node.next is node])
out.append(statistics.mean([0.1] * 60))
sys.stderr.write('hidden')
expected = "[2, 1, 11, 'finally', 'ValueError', 'ValueError', [False, True], 'int', [10, True], 0.1]"
if str(out) != expected:
    raise ValueError(str(out))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

// CPython 3.14.10 runs this program without raising.
test('limits, generators, copies, views, and builtin argument handling follow CPython', () => {
  const program = `import bisect
import copy
import itertools
import statistics
out = []
out.append([[] * 1000000000000, statistics.mode(range(30000)), hash(float('5e-324'))])
def handler():
    try:
        raise ValueError('inside')
    except ValueError:
        yield 1
suspended = handler()
next(suspended)
try:
    raise
except RuntimeError as e:
    out.append(str(e))
class Item:
    pass
item = Item()
item.values = [1]
next(iter(copy.deepcopy({item}))).values.append(2)
cycle = []
pair = (cycle,)
cycle.append(pair)
copied = copy.deepcopy(pair)
out.append([item.values, copied[0][0] is copied])
out.append([{'x': 1}.keys() == {'x': 2}.keys(), {'x': 1}.items() == {('x', 1)}, {'x': 1}.items() == {'x': 2}.items()])
out.append([list(enumerate(iterable=['a'])), bisect.bisect_left(a=[1, 2], x=2)])
total = sum([1, \\
    2])
out.append(total)
class Fallback:
    @property
    def missing(self):
        raise AttributeError()
    def __getattr__(self, name):
        return 7
out.append(Fallback().missing)
out.append([next(itertools.permutations(range(9))), next(itertools.product(range(1000), range(1000)))])
class Times:
    def __rmul__(self, other):
        return 'rmul'
out.append([1, 2] * Times())
for bad in [lambda: 'a' * 1.5, lambda: 'abc'.split(1), lambda: 'abc'.strip(1), lambda: bisect.bisect_left(x=2)]:
    try:
        bad()
    except TypeError as e:
        out.append(str(e))
expected = "[[[], 0, 16777216], 'No active exception to reraise', [[1], True], [True, True, False], [[(0, 'a')], 1], 3, 7, [(0, 1, 2, 3, 4, 5, 6, 7, 8), (0, 0)], 'rmul', \\"can't multiply sequence by non-int of type 'float'\\", 'must be str or None, not int', 'strip arg must be None or str', \\"bisect_left() missing required argument 'a' (pos 1)\\"]"
if str(out) != expected:
    raise ValueError(str(out))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('a turtle stays while a class attribute, a bound method, or a library object reaches it', () => {
  const program = `import functools
class Base:
    kept = Turtle(0, 0)
class Derived(Base):
    pass
del Base
move = Turtle(1, 0).forward
step = functools.partial(Turtle.forward, Turtle(2, 0))
move()
step()
Derived.kept.forward()`;
  expect(executeProgram('python', program)).toMatchObject({
    finalTurtles: [
      { x: 0, y: 1, color: '#', dir: 'N' },
      { x: 1, y: 1, color: '#', dir: 'N' },
      { x: 2, y: 1, color: '#', dir: 'N' },
    ],
  });
});

test('a run does not see the classes an earlier run defined', () => {
  executeProgram('python', 'class Leaked:\n    pass');
  const program = `names = [cls.__name__ for cls in object.__subclasses__()]
if 'Leaked' in names:
    raise ValueError(str(names))`;
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
  ['a wildcard before another alternative', 'match 5:\n    case _ | 1:\n        pass', 1],
  ['a name as a mapping pattern key', 'match 1:\n    case {k: v}:\n        pass', 1],
  ['a double star before another key', 'match 1:\n    case {**rest, "a": 1}:\n        pass', 1],
  ['two double stars in a mapping pattern', 'match 1:\n    case {**a, **b}:\n        pass', 1],
  ['a star in a class pattern', 'match 1:\n    case P(*a):\n        pass', 1],
  [
    'a case after an or-pattern with a wildcard',
    'match 5:\n    case 1 | _:\n        pass\n    case _:\n        pass',
    1,
  ],
  ['a try without except or finally', 'try:\n    pass\nelse:\n    pass', 0],
  ['an else clause after a statement on its line', 'if True: x = 1; else: x = 2', 0],
  ['a bare * followed only by **kwargs', 'def f(*, **kwargs):\n    pass', 0],
  [
    'return in a loop of an except* clause',
    'def f():\n    try:\n        pass\n    except* ValueError:\n        for i in range(1):\n            return 2',
    5,
  ],
  ['a type hint on a name declared global', 'def f():\n    global x\n    x: int = 1', 2],
  ['a Python 2 print statement', "print 'x'", 0],
  ['a Python 2 long literal', 'x = 1\ny = 1_0L', 1],
  ['a Python 2 raise with a comma', "try:\n    raise ValueError, 'x'\nexcept TypeError:\n    pass", 1],
  ['a Python 2 backtick repr', 'x = 1\ny = `x` + "b"', 1],
  ['a * splat in a mapping pattern', "match {}:\n    case {'k': 1, *a}:\n        pass", 1],
  ['a ** splat in a sequence pattern', 'match []:\n    case [1, **b]:\n        pass', 1],
  ['a repeated string prefix', "x = 1\ny = rr'x'", 1],
  ['a string prefix with a repeated f', "x = ffr'{1}'", 0],
  ['a conditional expression, which this grader does not support', 'x = 1 if True else 2', 0],
  ['an import of a file', 'import mymodule', 0],
  ['a missing indented block at the end', 'x = 1\nif x:\n', 1],
  ['an unexpected indent after a syntax error', 'x = = 1\n    y = 2', 0],
  ['a decorated function indented too far', 'class A:\n    @staticmethod\n        def f():\n            pass', 2],
  ['a handler indented too little', 'try:\n    pass\n  except ValueError:\n    pass', 2],
  ['a sole generator argument with a trailing comma', 'print(sum(i for i in [1, 2],))', 0],
  ['a list comprehension with a comma after its iterable', 'x = [i for i in [1],]', 0],
  ['a generator with a comma after its iterable', 'x = (i for i in [1],)', 0],
  ['a match without case clauses', "match 1:\n    print('hi')", 0],
  ['a try with else and finally but no except', 'try:\n    x = 1\nelse:\n    x = 2\nfinally:\n    x = 3', 2],
  ['a star pattern as a whole case pattern', "match 5:\n    case *a:\n        print('x')", 1],
  ['a star pattern in a group', "match 5:\n    case (*a):\n        print('x')", 1],
  ['a star pattern in an or-pattern', "match [5]:\n    case [*a | 1]:\n        print('x')", 1],
  ['mapping pattern keys quoted differently', 'match {}:\n    case {\'k\': a, "k": b}:\n        pass', 1],
  ['mapping pattern keys 1 and True', 'match {}:\n    case {1: a, True: b}:\n        pass', 1],
  ['mapping pattern keys 0 and -0.0', 'match {}:\n    case {0: a, -0.0: b}:\n        pass', 1],
  ['a match without case clauses in a function', 'def f(x):\n    match x:\n        y = 1\n    return 2', 1],
])('%s is a compile error', (_, source, row) => {
  const execution = executeProgram('python', source);
  expect(execution.kind).toBe('compileError');
  if (execution.kind === 'compileError') expect(execution.diagnostics[0].row).toBe(row);
});

test.each([
  ['if before an indented body', 'x = 1\nif x\n    y = 2', 1, 'if'],
  ['if before a body that is not indented', 'x = 5\nif x > 3\nprint(x)', 1, 'if'],
  ['if at the end', 'if True', 0, 'if'],
  ['if before a dedent to no outer level', 'if x\n    pass\n  y = 1', 0, 'if'],
  ['elif', 'if x:\n    pass\nelif y\n    pass', 2, 'elif'],
  ['else', 'if x:\n    pass\nelse\n    pass', 2, 'else'],
  ['for', 'for i in range(3)\n    print(i)', 0, 'for'],
  ['while', 'while True\n    break', 0, 'while'],
  ['def', 'def f()\n    return 1', 0, 'def'],
  ['def with parameters on several lines', 'def f(\n    a,\n    b\n)\n    return a', 3, 'def'],
  ['a decorated def', '@d\ndef f()\n    pass', 1, 'def'],
  ['class', 'class C\n    pass', 0, 'class'],
  ['with', "with open('f') as f\n    pass", 0, 'with'],
  ['try', 'try\n    pass\nexcept ValueError:\n    pass', 0, 'try'],
  ['except', 'try:\n    pass\nexcept ValueError\n    pass', 2, 'except'],
  ['finally', 'try:\n    pass\nfinally\n    pass', 2, 'finally'],
  ['match', 'match x\n    case 1:\n        pass', 0, 'match'],
  ['case', 'match x:\n    case 1\n        pass', 1, 'case'],
  ['a nested if in a try statement', 'try:\n    if x\n        pass\nexcept ValueError:\n    pass', 1, 'if'],
  ['if with a comment', 'if x  # why:\n    pass', 0, 'if'],
  ['if with an assignment expression', 'if (y := 5) and y\n    pass', 0, 'if'],
])('a missing colon after %s is reported on the header', (_, source, row, keyword) => {
  expect(executeProgram('python', source)).toEqual({
    kind: 'compileError',
    diagnostics: [{ row, message: `「${keyword}」で始まる行の終わりに「:」が足りません。` }],
  });
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
  const startedAt = Date.now();
  expect(executeProgram('python', source)).toMatchObject(expected);
  expect(Date.now() - startedAt).toBeLessThan(5000);
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
    'math.erf, which CPython takes from the C library',
    'import math\nmath.erf(1.5)',
    'math.erf()（C ライブラリの erf と最後の桁まで同じ値を出せないため）は、この採点環境では使えません。',
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

test.each([
  ['a default', 'def draw(t=Turtle(), count=n()):\n    t.forward()\ndraw()'],
  ['a keyword-only default', 'def draw(*, t=Turtle(), count=n()):\n    t.forward()\ndraw()'],
  [
    'a class decorator argument',
    'def keep(t):\n    def deco(c):\n        c.t = t\n        return c\n    return deco\n@keep(Turtle())\n@keep(n())\nclass C:\n    x = n()\nC.t.forward()',
  ],
  [
    'a decorator argument',
    'def keep(t):\n    def deco(f):\n        f.t = t\n        return f\n    return deco\n@keep(Turtle())\n@keep(n())\ndef g():\n    pass\ng.t.forward()',
  ],
])(
  'a turtle created for %s stays on every step while later defaults, decorators, and class bodies run',
  (_name, body) => {
    const program = `def n():\n    x = 2\n    return x\n${body}`;
    const trace = traceProgram('python', program, program);
    expect(trace.traceItems.slice(1).map(({ turtles }) => turtles.length)).not.toContain(0);
    expect(trace.finalTurtles).toHaveLength(1);
  }
);

test.each([
  ['sorting by a key', 'ws = [W(1), W(0)]\nws.sort(key=key)', 2],
  ['building a list from a generator', 'ws = list(gen())', 3],
  ['building a set from a generator', 'ws = set(gen())', 3],
  ['sorting a generator by a key', 'ws = sorted(gen(), key=key)', 3],
  ['unpacking a generator', 'a, b, c = gen()', 3],
  ['building a deque from a generator', 'from collections import deque\nws = deque(gen())', 3],
  ['taking a product of a generator', 'import itertools\nws = list(itertools.product(gen(), [1]))', 3],
  ['grouping a generator', 'import itertools\nws = [list(v) for k, v in itertools.groupby(gen(), key=key)]', 3],
])('turtles of objects that %s holds stay on every step while it runs Python code', (_name, body, count) => {
  const program = `class W:
    def __init__(self, n):
        self.t = Turtle(n, 0)
        self.n = n
    def __hash__(self):
        return self.n
def key(w):
    n = w.n
    return n
def gen():
    for i in range(3):
        w = W(i)
        yield w
${body}`;
  const trace = traceProgram('python', program, program);
  const counts = trace.traceItems.map(({ turtles }) => turtles.length);
  expect(counts.slice(counts.indexOf(1)).every((each, index, all) => index === 0 || each >= all[index - 1])).toBe(true);
  expect(trace.finalTurtles).toHaveLength(count);
});

test.each([
  ['called directly', 'answer = check(1)', true],
  ['called by map', 'answer = list(map(check, [1]))', [true]],
  ['called by sorted as its key', 'answer = sorted([1], key=check)', [1]],
])('a turtle a callback drops is gone when it asks canMoveForward, %s', (_name, call, answer) => {
  const program = `t = Turtle(0, 0)
seen = []
def check(i):
    blocker = Turtle(0, 1)
    blocker = None
    seen.append(t.canMoveForward())
    return seen[-1]
${call}`;
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.at(-1)?.vars).toMatchObject({ answer, seen: [true] });
});

test('a run reports what the program prints, leaves standard error empty, and keeps its files', () => {
  const program = "import sys\nprint('out')\nsys.stdout.write('more')\nprint('err', file=sys.stderr)";
  expect(executeProgram('python', program, { files: { 'data.txt': 'x' } })).toMatchObject({
    kind: 'executed',
    stdout: 'out\nmore',
    stderr: '',
    finalFiles: { 'data.txt': 'x' },
  });
});

test.each([
  ['a finally block', 'def make():\n    try:\n        return Turtle()\n    finally:\n        x = 1'],
  [
    "a context manager's __exit__",
    'class C:\n    def __enter__(self):\n        return self\n    def __exit__(self, *a):\n        y = 2\n        return False\ndef make():\n    with C():\n        return Turtle()',
  ],
])('a turtle returned through %s stays while it runs', (_name, factory) => {
  const program = `${factory}\nt = make()\nt.forward()`;
  const trace = traceProgram('python', program, program);
  const counts = trace.traceItems.map(({ turtles }) => turtles.length);
  expect(counts.slice(counts.indexOf(1))).not.toContain(0);
  expect(trace.finalTurtles).toHaveLength(1);
});
