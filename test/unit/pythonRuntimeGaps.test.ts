import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Runs a program that raises when a value it computes differs from what CPython 3.14.10 computes for it. */
function expectSameAsCPython(program: string): void {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

/** `count` nested for loops around `inner`. */
function nested(count: number, inner = 'pass'): string {
  const loops = Array.from({ length: count }, (_, i) => `${' '.repeat(i)}for x${i} in y:`).join('\n');
  return `${loops}\n${' '.repeat(count)}${inner}\n`;
}

function compileErrorRow(program: string): number | undefined {
  const result = executeProgram('python', program);
  return result.kind === 'compileError' ? result.diagnostics[0]?.row : undefined;
}

test('a thread waiting in a function a builtin calls back lets the other threads run', () => {
  expectSameAsCPython(`import threading, queue
q = queue.Queue()
log = []
def key(x):
    v = q.get()
    log.append(('key', x, v))
    return v
def consumer():
    log.append(('sorted', sorted([1, 2, 3], key=key)))
    log.append(('sum', sum(q.get() for _ in range(2))))
    log.append(('map', list(map(lambda x: x + q.get(), [100, 200]))))
    log.append(('comp', [q.get() * 2 for _ in range(2)]))
def producer():
    for v in [30, 10, 20, 5, 6, 1, 2, 7, 8]:
        log.append(('put', v))
        q.put(v)
threads = [threading.Thread(target=consumer), threading.Thread(target=producer)]
for t in threads: t.start()
for t in threads: t.join()
expected = [('put', 30), ('put', 10), ('put', 20), ('put', 5), ('put', 6), ('put', 1), ('put', 2), ('put', 7),
            ('put', 8), ('key', 1, 30), ('key', 2, 10), ('key', 3, 20), ('sorted', [2, 3, 1]), ('sum', 11),
            ('map', [101, 202]), ('comp', [14, 16])]
if log != expected: raise AssertionError(log)
`);
});

test('the compiler refuses statically nested blocks past 21, counted per code object', () => {
  expect(compileErrorRow(`print(1)\n${nested(21)}`)).toBeUndefined();
  expect(compileErrorRow(`print(1)\n${nested(22)}`)).toBe(22);
  expect(compileErrorRow(`print(1)\n${nested(21, '[a for a in b]')}`)).toBe(22);
  expect(compileErrorRow(`x = ${'('.repeat(201)}1${')'.repeat(201)}\n`)).toBe(0);
});

test('builtin iterators pickle and copy at their position', () => {
  expectSameAsCPython(`import pickle, copy
it = iter([1, 2, 3])
next(it)
if it.__reduce__() != (iter, ([1, 2, 3],), 1): raise AssertionError(it.__reduce__())
if list(pickle.loads(pickle.dumps(it))) != [2, 3]: raise AssertionError
c = copy.copy(it)
if (list(c), list(it)) != ([2, 3], [2, 3]): raise AssertionError
r = iter(range(0, 10, 3)); next(r)
if r.__reduce__() != (iter, (range(3, 12, 3),), None): raise AssertionError(r.__reduce__())
m = map(abs, [-1, -2])
if list(pickle.loads(pickle.dumps(m))) != [1, 2]: raise AssertionError
`);
});

test('help() of a class renders it with pydoc, as CPython does', () => {
  expectSameAsCPython(`import io, contextlib
class Base:
    """Base doc."""
    def run(self, n=1):
        """Run n times."""
    def __eq__(self, other):
        return True
class Child(Base):
    limit = 3
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    help(Child)
expected = 'Help on class Child in module __main__:\\n\\nclass Child(Base)\\n |  Method resolution order:\\n |      Child\\n |      Base\\n |      builtins.object\\n |\\n |  Data and other attributes defined here:\\n |\\n |  limit = 3\\n |\\n |  ----------------------------------------------------------------------\\n |  Methods inherited from Base:\\n |\\n |  __eq__(self, other)\\n |      Return self==value.\\n |\\n |  run(self, n=1)\\n |      Run n times.\\n |\\n |  ----------------------------------------------------------------------\\n |  Data descriptors inherited from Base:\\n |\\n |  __dict__\\n |      dictionary for instance variables\\n |\\n |  __weakref__\\n |      list of weak references to the object\\n |\\n |  ----------------------------------------------------------------------\\n |  Data and other attributes inherited from Base:\\n |\\n |  __hash__ = None\\n\\n'
if buf.getvalue() != expected: raise AssertionError(buf.getvalue())
`);
});

test('deep nesting runs as CPython runs it, or stops with the unsupported error past the host stack', () => {
  expectSameAsCPython(`x = ${Array.from({ length: 1000 }, () => '1').join(' + ')}
if x != 1000: raise AssertionError(x)
if ${'-'.repeat(1000)}1 != 1: raise AssertionError
`);
  expect(compileErrorRow(`x = ${'-'.repeat(25_000)}1\n`)).toBe(0);
});

test("abc.ABCMeta and the numbers ABCs are the classes of CPython's Python code, with their registries and token", () => {
  expectSameAsCPython(`import abc, io, inspect, numbers, re
meta = abc.ABCMeta
if list(meta.__dict__) != ['__module__', '__firstlineno__', '__doc__', '__new__', 'register', '__instancecheck__', '__subclasscheck__', '_dump_registry', '_abc_registry_clear', '_abc_caches_clear', '__static_attributes__']: raise AssertionError(list(meta.__dict__))
if list(abc.ABC.__dict__) != ['__module__', '__firstlineno__', '__doc__', '__slots__', '__static_attributes__', '__abstractmethods__', '_abc_impl']: raise AssertionError(list(abc.ABC.__dict__))
if not re.fullmatch(r'<function ABCMeta.register at 0x[0-9a-f]+>', repr(meta.register)): raise AssertionError(repr(meta.register))
if (meta.register.__qualname__, meta.register.__module__, str(inspect.signature(meta._dump_registry))) != ('ABCMeta.register', 'abc', '(cls, file=None)'): raise AssertionError
if meta.register.__globals__ is not abc.__dict__: raise AssertionError
if [k for k in dir(meta) if k not in dir(type)] != ['__firstlineno__', '__static_attributes__', '_abc_caches_clear', '_abc_registry_clear', '_dump_registry', 'register']: raise AssertionError(dir(meta))
if (abc.ABC.__annotations__, abc.ABC.__annotate__, meta.__annotations__, numbers.Real.__annotate__) != ({}, None, {}, None): raise AssertionError
if (hex(meta.__flags__), hex(numbers.Real.__flags__), hex(abc.ABC.__flags__)) != ('0x80805e00', '0x105600', '0x5600'): raise AssertionError
if type(numbers.Complex.__dict__['__bool__']).__name__ != 'function' or numbers.Complex.__bool__.__qualname__ != 'Complex.__bool__': raise AssertionError
class A(abc.ABC): pass
class B: pass
A.register(int)
isinstance(3, A); isinstance('x', A); issubclass(float, A); issubclass(B, A)
buf = io.StringIO()
A._dump_registry(buf)
lines = re.sub(r'0x[0-9a-f]+', 'X', buf.getvalue()).splitlines()
if lines[:4] != ['Class: __main__.A', 'Inv. counter: 31', "_abc_registry: {<weakref at X; to 'type' at X (int)>}", '_abc_cache: set()'] or lines[5] != '_abc_negative_cache_version: 31': raise AssertionError(lines)
buf = io.StringIO()
numbers.Complex._dump_registry(buf)
if buf.getvalue().splitlines()[-1] != '_abc_negative_cache_version: 27': raise AssertionError(buf.getvalue())
import collections.abc
class S:
    def __len__(self): return 2
    def __getitem__(self, i):
        if i > 1: raise IndexError
        return i
collections.abc.Sequence.register(S)
match S():
    case [a, b]: pass
    case _: raise AssertionError('not a sequence')
class V(numbers.Real): pass
try:
    V()
    raise AssertionError('instantiated')
except TypeError as e:
    if not str(e).startswith("Can't instantiate abstract class V without an implementation for abstract methods '__abs__', '__add__'"): raise
`);
});
