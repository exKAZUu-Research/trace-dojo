import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

/** Runs a program that raises when a value it computes differs from what CPython 3.14.10 computes for it. */
function expectSameAsCPython(program: string): void {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

test('generators receive sent values, delegate with yield from, and handle throw and close as CPython does', () => {
  expectSameAsCPython(`log = []
def inner():
    try:
        x = yield 'i1'
        log.append(('inner got', x))
        yield 'i2'
    except KeyError as e:
        log.append(('inner caught', repr(e)))
        return 'inner-ret'
    finally:
        log.append('inner finally')
def outer():
    r = yield from inner()
    log.append(('outer r', r))
    try:
        yield 'o1'
    except GeneratorExit:
        log.append('closing')
        return 'closed'
o = outer()
log.append(next(o))
log.append(o.send('S'))
log.append(o.throw(KeyError('k')))
log.append(o.close())
def p():
    print((yield))
    total = (yield 1) + (yield 2)
    d = {}
    d[(yield 'key')] = yield 'value'
    return f'{total}{d}'
g = p()
sent = [next(g), g.send('A'), g.send(10), g.send(20), g.send('K')]
try:
    g.send('V')
except StopIteration as e:
    sent.append(e.value)
def bad():
    yield 1
    raise StopIteration('x')
try:
    list(bad())
except RuntimeError as e:
    sent.append((str(e), repr(e.__cause__)))
expected_log = ['i1', ('inner got', 'S'), 'i2', ('inner caught', "KeyError('k')"), 'inner finally', ('outer r', 'inner-ret'), 'o1', 'closing', 'closed']
# An assignment evaluates its value before its target.
expected_sent = [None, 1, 2, 'value', 'key', "30{'V': 'K'}", ('generator raised StopIteration', "StopIteration('x')")]
if log != expected_log:
    raise ValueError(log)
if sent != expected_sent:
    raise ValueError(sent)`);
});

test('a generator abandoned in a try block runs its finally block when CPython would free it', () => {
  expectSameAsCPython(`log = []
def gen(name):
    try:
        yield 1
        yield 2
    finally:
        log.append('cleanup ' + name)
for x in gen('loop'):
    break
log.append('after loop')
log.append(next(gen('temporary')))
g = gen('variable')
next(g)
g = None
log.append('after rebinding')
def f():
    local = gen('local')
    next(local)
f()
log.append('after call')
for i, x in enumerate(gen('wrapped')):
    break
expected = ['cleanup loop', 'after loop', 'cleanup temporary', 1, 'cleanup variable', 'after rebinding', 'cleanup local', 'after call', 'cleanup wrapped']
if log != expected:
    raise ValueError(log)`);
});

test('type parameters create TypeVars, Generic bases, and lazily evaluated type aliases', () => {
  expectSameAsCPython(`import typing
class C[T: int, *Ts, **P]:
    def m[U = str](self, x: T) -> U: pass
type G[K, V] = dict[K, V]
type Lazy = Undefined
T, Ts, P = C.__type_params__
actual = [repr(C.__type_params__), T.__bound__, C.__bases__, repr(C.__orig_bases__), repr(C.m.__type_params__[0].__default__),
          repr(C.m.__annotations__), repr(G), repr(G.__value__), repr(G[int, str]), repr(P.args), repr(C[int, str, [int]] if False else C.__parameters__)]
try:
    Lazy.__value__
except NameError as e:
    actual.append(str(e))
from typing import TypeVar, Generic
S = TypeVar('S', covariant=True)
class Box(Generic[S]):
    pass
actual += [repr(S), repr(Box[int]), Box[int] is Box[int], repr(Box.__parameters__)]
expected = ['(T, Ts, P)', int, (typing.Generic,), '(typing.Generic[T, typing.Unpack[Ts], P],)', "<class 'str'>",
            "{'x': T, 'return': U}", 'G', 'dict[K, V]', 'G[int, str]', 'P.args', '(T, Ts, P)', "name 'Undefined' is not defined",
            '+S', '__main__.Box[int]', True, '(+S,)']
if actual != expected:
    raise ValueError(actual)`);
});

test('stringified annotations keep the text CPython unparses from the annotation', () => {
  expectSameAsCPython(`from __future__ import annotations
x: dict[str,int]|None
y: 10 ** -2
z: lambda *, a: 0
w: f'{v=}'
def f(a: (1, 2), *b: 'q') -> x[a,]: pass
expected = {'x': 'dict[str, int] | None', 'y': '10 ** (-2)', 'z': 'lambda*, a: 0', 'w': "f'v={v!r}'"}
if __annotations__ != expected:
    raise ValueError(__annotations__)
if f.__annotations__ != {'a': '(1, 2)', 'b': "'q'", 'return': 'x[a,]'}:
    raise ValueError(f.__annotations__)`);
});

test.each([
  [
    'a starred target that gets too few values',
    'a, *b, c = [1]',
    'ValueError: not enough values to unpack (expected at least 2, got 1)',
  ],
  ['a failed assert with a message', "assert 1 > 2, 'too small'", 'AssertionError: too small'],
  [
    'a generator that ignores GeneratorExit',
    'def g():\n    try:\n        yield\n    except GeneratorExit:\n        yield\nx = g()\nnext(x)\nx.close()',
    'RuntimeError: generator ignored GeneratorExit',
  ],
])('%s ends the program as CPython describes it', (_, source, description) => {
  expect(executeProgram('python', source)).toMatchObject({ kind: 'executed', uncaughtException: description });
});

test.each([
  ['a binary literal with a non-binary digit', 'x = 1\ny = 0b2', 1],
  ['two starred targets', 'a, *b, *c = [1]', 0],
  ['a starred target alone', '*a = [1]', 0],
  ['a future import after other statements', 'x = 1\nfrom __future__ import annotations', 1],
  ['an unknown future feature', 'from __future__ import nothing', 0],
  ['a non-default type parameter after a default one', 'def f[T = int, U](): pass', 0],
  ['a yield in a comprehension', 'def f():\n    return [(yield) for x in []]', 1],
])('%s is a compile error at the row CPython reports', (_, source, row) => {
  const execution = executeProgram('python', source);
  expect(execution.kind).toBe('compileError');
  if (execution.kind === 'compileError') expect(execution.diagnostics[0].row).toBe(row);
});

test('a statement that suspends a generator records its step when it ends, and assert records none, like if', () => {
  const program = `def gen():
    x = yield 1
    yield x + 1
g = gen()
a = next(g)
b = g.send(5)
assert b == 6`;
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.map(({ line }) => line)).toEqual([0, 4, 5, 2, 6]);
});
