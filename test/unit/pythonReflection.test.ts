import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

/** Runs a program that raises when a value it computes differs from what CPython 3.14.10 computes for it. */
function expectSameAsCPython(program: string): void {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

test('exec and eval run in the namespaces CPython gives them, which globals() and locals() share', () => {
  expectSameAsCPython(`results = []
x = 10
def f():
    x = 1
    snapshot = locals()
    snapshot['y'] = 2
    exec("x = 5; z = 3")
    results.append((x, sorted(locals()), eval("x + 1")))
f()
class C:
    exec("w = 7")
    n = eval("w + 1")
results.append((C.w, C.n))
g = {}
exec("def h(): return q\\nq = 4\\nclass K: pass", g)
results.append((sorted(g), g['h'](), g['K'].__module__, g['h'].__module__))
loc = {}
exec("a = 1\\nb = a + x", {'x': 100}, loc)
results.append(loc)
globals()['made'] = 'yes'
results.append((made, globals() is globals(), locals() is globals(), list(globals())[:8]))
code = compile("total = sum(range(5))", "<calc>", "exec")
exec(code)
results.append((total, code.co_filename, eval(compile("2 ** 10", "", "eval"))))
def outer():
    a = 1
    def inner():
        b = 2
        return locals(), a
    return inner()[0]
results.append(outer())
expected = [
    (1, ['snapshot', 'x'], 2),
    (7, 8),
    (['K', '__builtins__', 'h', 'q'], 4, 'builtins', None),
    {'a': 1, 'b': 101},
    ('yes', True, True, ['__name__', '__doc__', '__package__', '__loader__', '__spec__', '__builtins__', 'results', 'x']),
    (10, '<calc>', 1024),
    {'b': 2, 'a': 1},
]
if results != expected:
    raise ValueError(results)`);
});

test('a generator expression has a frame of its own, while other comprehensions share the function frame', () => {
  expectSameAsCPython(`def g():
    x = 1
    return [sorted(locals()) for k in range(1)][0], list(sorted(locals()) for k in range(1))[0]
if g() != (['k', 'x'], ['.0', 'k']):
    raise ValueError(g())`);
});

test('a syntax error in source text is catchable, but showing its message stops the program', () => {
  expectSameAsCPython(`try:
    eval("1 +")
except SyntaxError as e:
    caught = type(e).__name__
if caught != 'SyntaxError':
    raise ValueError(caught)`);
  const result = executeProgram('python', 'eval("1 +")');
  expect(result).toMatchObject({ kind: 'executed' });
  expect(result.kind === 'executed' && result.uncaughtException).toContain('この採点環境では使えません');
});

test('sys.setrecursionlimit lowers the depth at which recursion fails, as in CPython', () => {
  expectSameAsCPython(`import sys
depth = 0
def f(n):
    global depth
    depth = n
    f(n + 1)
sys.setrecursionlimit(50)
try:
    f(1)
except RecursionError:
    pass
try:
    sys.setrecursionlimit(1)
except RecursionError as e:
    message = str(e)
if (depth, message, sys.getrecursionlimit()) != (49, 'cannot set the recursion limit to 1 at the recursion depth 1: the limit is too low', 50):
    raise ValueError((depth, message))`);
});

test('the functions atexit registers run last first after the program ends', () => {
  const program = `import atexit
order = ''
def add(letter):
    global order
    order += letter
atexit.register(add, 'a')
atexit.register(add, 'b')
atexit.register(add, 'c')
atexit.unregister(add)
atexit.register(add, 'd')
atexit.register(add, 'e')`;
  expect(traceProgram('python', program, program).finalVars).toMatchObject({ order: 'ed' });
});

test('code run by exec records no steps of its own, as an atomic function', () => {
  const program = 'x = 1\nexec("y = x + 1\\nz = y * 2")\nw = 3';
  expect(traceProgram('python', program, program).traceItems.map(({ line }) => line)).toEqual([0, 1, 2, 3]);
});
