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

test("typing.Protocol is the code of CPython's typing, with its runtime checks and their errors", () => {
  expectSameAsCPython(`import io as _io, contextlib as _contextlib, re as _re
_buf = _io.StringIO()
_ctx = _contextlib.redirect_stdout(_buf)
_ctx.__enter__()
import typing, abc, functools, collections.abc as cabc
from typing import Protocol, runtime_checkable, Generic, TypeVar
T = TypeVar('T')
@runtime_checkable
class P(Protocol):
    def quack(self): ...
class Duck:
    def quack(self): pass
print(P.__protocol_attrs__, P.__non_callable_proto_members__, P._is_protocol, P._is_runtime_protocol)
print(isinstance(Duck(), P), isinstance(3, P), issubclass(Duck, P), issubclass(int, P))
class NR(Protocol):
    x: int
for f in (lambda: isinstance(1, NR), lambda: issubclass(int, NR)):
    try: f()
    except TypeError as e: print(e)
@runtime_checkable
class D(Protocol):
    x: int
    def m(self): ...
print(sorted(D.__protocol_attrs__), D.__non_callable_proto_members__)
class HasX:
    x = 1
    def m(self): pass
print(isinstance(HasX(), D))
try: issubclass(HasX, D)
except TypeError as e: print(e)
try: issubclass(1, D)
except TypeError as e: print(e)
@runtime_checkable
class G(Protocol[T]):
    def get(self) -> T: ...
class GG[T](Protocol):
    def put(self, x: T): ...
print(G.__parameters__, G[int], GG.__parameters__, GG.__bases__, G.__mro__)
class Sub(P, Protocol):
    def other(self): ...
print(Sub.__protocol_attrs__ == {'quack', 'other'}, Sub._is_protocol, Sub._is_runtime_protocol)
class Impl(P):
    pass
print(Impl._is_protocol, isinstance(Impl(), P), Impl())
try: P()
except TypeError as e: print(e)
try:
    class Bad(int, Protocol): pass
except TypeError as e: print(e)
try: runtime_checkable(int)
except TypeError as e: print(e)
print(typing.is_protocol(P), typing.is_protocol(Impl), typing.get_protocol_members(D) == {'x', 'm'})
print(isinstance(3, typing.SupportsInt), isinstance('x', typing.SupportsInt), issubclass(float, typing.SupportsIndex))
print(type(P), type(Protocol), Protocol.__mro__, list(Protocol.__dict__))
@functools.singledispatch
def f(x): return 'base'
@f.register
def _(x: cabc.Iterable): return 'iter'
print(f([1]), f(P))
class MyAbc(abc.ABC): pass
print(issubclass(Duck, MyAbc))
print(isinstance(Duck(), typing.SupportsAbs))
class WithInit(Protocol):
    def __init__(self): self.a = 1
class C2(WithInit):
    pass
print(C2().a)
_ctx.__exit__(None, None, None)
EXPECTED = "{'quack'} set() True True\\nTrue False True False\\nInstance and class checks can only be used with @runtime_checkable protocols\\nInstance and class checks can only be used with @runtime_checkable protocols\\n['m', 'x'] {'x'}\\nTrue\\nProtocols with non-method members don't support issubclass(). Non-method members: 'x'.\\nissubclass() arg 1 must be a class\\n(~T,) __main__.G[int] (T,) (<class 'typing.Protocol'>,) (<class '__main__.G'>, <class 'typing.Protocol'>, <class 'typing.Generic'>, <class 'object'>)\\nTrue True True\\nFalse True <__main__.Impl object>\\nProtocols cannot be instantiated\\nProtocols can only inherit from other protocols, got <class 'int'>\\n@runtime_checkable can be only applied to protocol classes, got <class 'int'>\\nTrue False True\\nTrue False False\\n<class 'typing._ProtocolMeta'> <class 'typing._ProtocolMeta'> (<class 'typing.Protocol'>, <class 'typing.Generic'>, <class 'object'>) ['__module__', '__firstlineno__', '__doc__', '__slots__', '_is_protocol', '_is_runtime_protocol', '__init_subclass__', '__static_attributes__', '__parameters__', '__abstractmethods__', '_abc_impl', '__protocol_attrs__']\\niter base\\nFalse\\nFalse\\n1\\n"
if _re.sub(' at 0x[0-9a-f]*', '', _buf.getvalue()) != EXPECTED: raise AssertionError(_buf.getvalue())
`);
});

test("type.__subclasses__() lists the live subclasses in order, and refuses lists CPython's startup fills", () => {
  expectSameAsCPython(`import io as _io, contextlib as _contextlib
_buf = _io.StringIO()
_ctx = _contextlib.redirect_stdout(_buf)
_ctx.__enter__()
import gc, abc, collections.abc, numbers, enum, typing, weakref
class A: pass
class B(A): pass
class C(A): pass
class D(B, C): pass
print(A.__subclasses__(), B.__subclasses__(), C.__subclasses__(), D.__subclasses__())
del D
gc.collect()
print(B.__subclasses__(), C.__subclasses__())
def make():
    class L(A): pass
    return L
x = make()
r = weakref.ref(x)
print(A.__subclasses__())
x = None
gc.collect()
print(A.__subclasses__(), r())
class F(float): pass
print(float.__subclasses__(), complex.__subclasses__(), int.__subclasses__())
class E(KeyError): pass
print(KeyError.__subclasses__())
T = type('T', (A,), {})
print(A.__subclasses__())
class Color(enum.Enum):
    RED = 1
print(Color.__subclasses__(), enum.Enum.__subclasses__(), enum.IntFlag.__subclasses__())
class MyAbc(abc.ABC): pass
class Impl(MyAbc): pass
MyAbc.register(int)
print(MyAbc.__subclasses__(), issubclass(int, MyAbc))
print(collections.abc.Sequence.__subclasses__(), collections.abc.MutableSequence.__subclasses__())
class R(numbers.Real): pass
print(numbers.Real.__subclasses__(), numbers.Rational.__subclasses__())
class P(typing.Protocol):
    def f(self): ...
class Q(P, typing.Protocol): pass
print(P.__subclasses__())
A.__bases__
class Z(A): pass
Z.__bases__ = (C,)
print(A.__subclasses__(), C.__subclasses__())
class A: pass
class C: pass
class Z(A): pass
Z.__bases__ = (C,)
print(Z.__bases__, Z.__mro__, Z.__dict__.get("__bases__"))
class Y(Z): pass
print(Y.__mro__)
Z.__bases__ = (A, C)
print(Y.__mro__, A.__subclasses__(), C.__subclasses__())
for v in ([A], (), (1,), (Y,)):
    try: Z.__bases__ = v
    except TypeError as e: print(e)
class M(A, C): pass
try: M.__bases__ = (C, A, C)
except TypeError as e: print(e)
z = Z()
print(isinstance(z, C), Z.f if hasattr(Z, 'f') else None)
_ctx.__exit__(None, None, None)
EXPECTED = "[<class '__main__.B'>, <class '__main__.C'>] [<class '__main__.D'>] [<class '__main__.D'>] []\\n[] []\\n[<class '__main__.B'>, <class '__main__.C'>, <class '__main__.make.<locals>.L'>]\\n[<class '__main__.B'>, <class '__main__.C'>] None\\n[<class '__main__.F'>] [] [<class 'bool'>, <enum 'IntEnum'>, <flag 'IntFlag'>]\\n[<class '__main__.E'>]\\n[<class '__main__.B'>, <class '__main__.C'>, <class '__main__.T'>]\\n[] [<enum 'ReprEnum'>, <flag 'Flag'>, <enum 'Color'>] []\\n[<class '__main__.Impl'>] True\\n[<class 'collections.abc.ByteString'>, <class 'collections.abc.MutableSequence'>, <class 'collections.UserString'>] [<class 'collections.UserList'>]\\n[<class 'numbers.Rational'>, <class '__main__.R'>] [<class 'numbers.Integral'>]\\n[<class '__main__.Q'>]\\n[<class '__main__.B'>, <class '__main__.C'>, <class '__main__.T'>] [<class '__main__.Z'>]\\n(<class '__main__.C'>,) (<class '__main__.Z'>, <class '__main__.C'>, <class 'object'>) None\\n(<class '__main__.Y'>, <class '__main__.Z'>, <class '__main__.C'>, <class 'object'>)\\n(<class '__main__.Y'>, <class '__main__.Z'>, <class '__main__.A'>, <class '__main__.C'>, <class 'object'>) [<class '__main__.Z'>] [<class '__main__.Z'>]\\ncan only assign tuple to Z.__bases__, not list\\ncan only assign non-empty tuple to Z.__bases__, not ()\\nZ.__bases__ must be tuple of classes, not 'int'\\na __bases__ item causes an inheritance cycle\\nduplicate base class C\\nTrue None\\n"
if _buf.getvalue() != EXPECTED: raise AssertionError(_buf.getvalue())
`);
  const result = executeProgram('python', 'import pydoc\nint.__subclasses__()\n');
  expect(result).toMatchObject({ kind: 'executed' });
  expect(result.kind === 'executed' ? result.uncaughtException : '').toContain('使えません');
});
