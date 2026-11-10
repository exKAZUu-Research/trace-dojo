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
