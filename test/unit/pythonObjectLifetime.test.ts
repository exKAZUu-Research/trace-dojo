import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';
import { parsePython } from '../../src/python/parse';
import { runModule } from '../../src/python/run';
import { Runtime } from '../../src/python/runtime';

/** Runs a program that raises when a value it computes differs from what CPython 3.14.10 computes for it. */
function expectSameAsCPython(program: string): void {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

test('suspended generators close when reference counting would free them, not when a cycle keeps them', () => {
  expectSameAsCPython(`import gc
log = []
def gen(tag):
    try:
        yield 1
    finally:
        log.append(tag)
def opened(tag):
    g = gen(tag)
    next(g)
    return g
def take(it):
    return next(it)
def raiser(tag):
    g = opened(tag)
    raise KeyError(tag)
g = opened('rebound')
g = None
log.append('-')
x = take(gen('argument'))
log.append('-')
items = [opened('item')]
items.pop()
log.append('-')
box = {'k': opened('value')}
box['k'] = 0
log.append('-')
try:
    raiser('traceback')
except KeyError:
    log.append('handler')
log.append('-')
class Node:
    pass
a, b = Node(), Node()
a.other, b.other, a.g = b, a, opened('cycle')
a = b = None
log.append('dropped cycle')
gc.collect()
expected = ['rebound', '-', 'argument', '-', 'item', '-', 'value', '-', 'handler', 'traceback', '-', 'dropped cycle', 'cycle']
if log != expected:
    raise AssertionError(log)
`);
});

test('objects keep one live __dict__, and builtin methods have the types CPython gives them', () => {
  expectSameAsCPython(`class B:
    pass
b = B()
d = b.__dict__
d['x'] = 1
replacement = {'y': 2}
b.__dict__ = replacement
b.z = 3
results = (d is not b.__dict__, b.__dict__ is replacement, replacement, type(B.__dict__).__name__)
if results != (True, True, {'y': 2, 'z': 3}, 'mappingproxy'):
    raise AssertionError(results)
kinds = [type(value).__name__ for value in (str.upper, 'x'.upper, int.__add__, (1).__add__, len, object.__new__)]
expected = ['method_descriptor', 'builtin_function_or_method', 'wrapper_descriptor', 'method-wrapper',
            'builtin_function_or_method', 'builtin_function_or_method']
if kinds != expected:
    raise AssertionError(kinds)
texts = [repr(value) for value in (str.upper, int.__add__, len)]
if texts != ["<method 'upper' of 'str' objects>", "<slot wrapper '__add__' of 'int' objects>", '<built-in function len>']:
    raise AssertionError(texts)
`);
});

/** The text a program writes, with how it ended. */
function outputOf(program: string): string {
  const run = runModule(new Runtime(), parsePython(program));
  return `${run.stdout}=== ${run.uncaughtException ?? 'ok'}\n`;
}

test('__del__ runs when reference counting would free the object, and at the end in the order CPython clears it', () => {
  // The expected text is what CPython 3.14.10 prints.
  expect(
    outputOf(`import gc, sys, weakref
class A:
    def __init__(self, n, *kids): self.n = n; self.kids = list(kids)
    def __del__(self): print('del', self.n)
a = A(1); a = None
def f(p, q):
    r = A('r'); s = A('s')
    del p
    return 0
f(A('p'), A('q'))
x = [A('l1'), A('l2')]; x.clear()
d = {1: A('d1'), 2: A('d2')}; d.clear()
n = A('n', A('n1'), A('n2')); n = None
try:
    raise ValueError(A('exc'))
except ValueError as e:
    print('handler')
c1 = A('c1'); c2 = A('c2'); c1.o = c2; c2.o = c1
c1 = c2 = None
print('cycle dropped')
gc.collect()
saved = []
class R:
    def __del__(self): print('R del'); saved.append(self)
r = R(); r = None; saved.clear()
w = A('w')
weakref.finalize(w, print, 'finalize')
r1 = weakref.ref(w, lambda ref: print('cb1'))
r2 = weakref.ref(w, lambda ref: print('cb2'))
w = None
class E:
    def __del__(self): raise ValueError('boom')
sys.unraisablehook = lambda u: print('hook', u.exc_type.__name__, u.err_msg.split(' at ')[0])
e = E(); e = None
sys.unraisablehook = sys.__unraisablehook__
print('end')
z = [A('z1'), A('z2')]
q = A('q')
`)
  ).toBe(
    `${[
      'del 1',
      'del p',
      'del s',
      'del r',
      'del q',
      'del l2',
      'del l1',
      'del d1',
      'del d2',
      'del n',
      'del n2',
      'del n1',
      'handler',
      'del exc',
      'cycle dropped',
      'del c1',
      'del c2',
      'R del',
      'del w',
      'cb2',
      'cb1',
      'finalize',
      'hook ValueError Exception ignored while calling deallocator <function E.__del__',
      'end',
      'del q',
      'del z2',
      'del z1',
    ].join('\n')}\n=== ok\n`
  );
});

test('async generator hooks run when an async generator is first iterated and when it is freed unfinished', () => {
  expectSameAsCPython(`import sys
log = []
async def agen():
    yield 1
    yield 2
sys.set_asyncgen_hooks(lambda g: log.append('first'), lambda g: log.append('finalizer'))
g = agen()
log.append('created')
try:
    g.__anext__().send(None)
except StopIteration as e:
    log.append(e.value)
g = None
unstarted = agen()
unstarted = None
sys.set_asyncgen_hooks(None, None)
if log != ['created', 'first', 1, 'finalizer'] or sys.get_asyncgen_hooks() != (None, None):
    raise AssertionError(log)
`);
});

test('cyclic garbage with __del__ that the automatic collector would free at an unknown time stops the program', () => {
  expect(
    outputOf(`class A:
    def __del__(self): print('del')
a = A(); a.self = a; a = None
for i in range(1000):
    b = [i]
`)
  ).toContain('この採点環境では使えません');
});

test('freeing objects with __del__ costs what is dropped, not every object the program holds', () => {
  expectSameAsCPython(`class R:
    count = 0
    def __init__(self, n): self.n = n
    def __del__(self): R.count += 1
    def get(self): return self.n
data = [[i] for i in range(100000)]
for i in range(1000):
    r = R(i)
    r.get()
objs = [R(i) for i in range(500)]
while objs:
    objs.pop()
d = {i: R(i) for i in range(200)}
for i in range(200):
    d[i] = R(-i)
for k in list(d):
    del d[k]
if R.count != 1899:
    raise AssertionError(R.count)
`);
});
