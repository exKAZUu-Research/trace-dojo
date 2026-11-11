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

test("Counter unions, namedtuple fields, weak reference lists, and signatures of wrapped functions are CPython's", () => {
  expectSameAsCPython(`import io as _io, contextlib as _contextlib
_buf = _io.StringIO()
_ctx = _contextlib.redirect_stdout(_buf)
_ctx.__enter__()
from collections import Counter, OrderedDict, defaultdict
print(Counter(a=3) | Counter(a=1, b=2), Counter(a=3) & Counter(a=1, b=2))
c = Counter(a=1); c |= Counter(a=5, b=1); print(c)
c &= Counter(a=2); print(c)
c += Counter(z=1); print(c)
print({'a': 1} | Counter(b=2), Counter(b=2) | {'a': 1} if False else '', OrderedDict(a=1) | {'b': 2}, defaultdict(int, a=1) | {'b': 2})
d = defaultdict(list); d |= {'x': [1]}; print(d)
from collections import namedtuple
P = namedtuple('P', 'x')
p = P(1)
for f in (lambda: setattr(p, 'x', 2), lambda: delattr(p, 'x'), lambda: setattr(p, 'y', 2)):
    try: f()
    except AttributeError as e: print(e)
print(type(P.x).__name__, P.x, P.x.__doc__)
import weakref
class O: pass
class R(weakref.ref): pass
def show(o, names):
    print([names.get(id(r), '?') for r in weakref.getweakrefs(o)])
o = O(); names = {}
a = weakref.ref(o, lambda r: None); names[id(a)] = 'a'
show(o, names)
d = R(o); names[id(d)] = 'd'
show(o, names)
c = weakref.ref(o); names[id(c)] = 'c'
show(o, names)
p = weakref.proxy(o); names[id(p)] = 'p'
show(o, names)
e = R(o); names[id(e)] = 'e'
show(o, names)
f = weakref.ref(o, lambda r: None); names[id(f)] = 'f'
show(o, names)
q = weakref.proxy(o, lambda r: None); names[id(q)] = 'q'
show(o, names)
o2 = O(); n2 = {}
x = R(o2); n2[id(x)] = 'x'
y = weakref.ref(o2); n2[id(y)] = 'y'
show(o2, n2)
import functools, inspect
def logged(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)
    return wrapper
@logged
def area(w: float, h: float = 1.0) -> float:
    """Area of a rectangle."""
    return w * h
print(area.__name__, area.__doc__, area.__annotations__, inspect.signature(area), area.__wrapped__.__name__)
print(area.__qualname__, area.__module__, functools.WRAPPER_ASSIGNMENTS)
_ctx.__exit__(None, None, None)
EXPECTED = "Counter({'a': 3, 'b': 2}) Counter({'a': 1})\\nCounter({'a': 5, 'b': 1})\\nCounter({'a': 2})\\nCounter({'a': 2, 'z': 1})\\n{'a': 1, 'b': 2}  OrderedDict({'a': 1, 'b': 2}) defaultdict(<class 'int'>, {'a': 1, 'b': 2})\\ndefaultdict(<class 'list'>, {'x': [1]})\\ncan't set attribute\\ncan't delete attribute\\n'P' object has no attribute 'y' and no __dict__ for setting new attributes\\n_tuplegetter _tuplegetter(0, 'Alias for field number 0') Alias for field number 0\\n['a']\\n['d', 'a']\\n['c', 'd', 'a']\\n['c', 'p', 'd', 'a']\\n['c', 'p', 'e', 'd', 'a']\\n['c', 'p', 'f', 'e', 'd', 'a']\\n['c', 'p', 'q', 'f', 'e', 'd', 'a']\\n['y', 'x']\\narea Area of a rectangle. {'w': <class 'float'>, 'h': <class 'float'>, 'return': <class 'float'>} (w: float, h: float = 1.0) -> float area\\narea __main__ ('__module__', '__name__', '__qualname__', '__doc__', '__annotate__', '__type_params__')\\n"
if _buf.getvalue() != EXPECTED: raise AssertionError(_buf.getvalue())
`);
});

test("co_varnames, co_nlocals, co_cellvars, and co_names follow the order CPython's compiler emits names in", () => {
  expectSameAsCPython(`import io as _io, contextlib as _contextlib
_buf = _io.StringIO()
_ctx = _contextlib.redirect_stdout(_buf)
_ctx.__enter__()
def show(f):
    c = f.__code__
    print(f.__name__, c.co_varnames, c.co_nlocals, c.co_argcount, c.co_cellvars, c.co_freevars, c.co_names)
def f1(a, b=1, *args, c, d=2, **kw):
    x = a + b
    y = [i * x for i in args]
    return y
def f2():
    if 0:
        dead = 1
    while False:
        dead2 = 2
    x: int
    z: int = 3
    return z
def f3(n):
    total = undefined_before
    undefined_before = 0
    for i, (j, k) in enumerate(n):
        total += i
    with open('x') as fh, open('y') as (g, h):
        pass
    try:
        pass
    except ValueError as err:
        msg = str(err)
    except TypeError as eg:
        pass
    else:
        other = 1
    finally:
        fin = 2
    del fin
    try:
        pass
    except* KeyError as kg:
        pass
    return total
def f4(seq):
    def inner():
        return captured
    captured = 1
    lam = lambda q, r=seq: q
    gen = (v for v in seq if v)
    d = {k: v for k, v in seq}
    s = {w for w in seq for w2 in w}
    if (walrus := len(seq)) > 1:
        pass
    ys = [last := y for y in seq]
    return inner, lam
def f5(subject):
    match subject:
        case [a, *rest]:
            pass
        case {'k': v, **others}:
            pass
        case Point(x=px, y=py) | Point(y=py, x=px):
            pass
        case str() as s if s:
            pass
        case _:
            pass
class K:
    def m(self):
        return super().m()
    def n(self):
        return __class__
async def f6(xs):
    async for a in xs:
        pass
    async with xs as b:
        pass
    r = await xs
    return [c async for c in xs]
def f7(a, /, b, *, c):
    import os.path
    import collections.abc as cabc
    from json import dumps as d, loads
    global G
    G = 1
    nonlocal_free = a
    class Inner:
        pass
    @staticmethod
    def deco(): pass
    x = y = a.attr.sub
    a.attr = b[c]
    a.b += 1
    print(f'{a!r:{b}}')
    return os, cabc, d, loads
def f8():
    x = 1
    del x
    x = [x for x in range(3)]
    y = [z for z in range(3) if z] + [z for z in range(2)]
    return x, y
for f in (f1, f2, f3, f4, f5, K.m, K.n, f6, f7, f8):
    show(f)
co = compile('[q for q in range(3)]\\nr = 1\\n{s: 1 for s in "ab"}\\nclass C:\\n    t = [u for u in "x"]\\n', '<m>', 'exec')
print(co.co_varnames, co.co_nlocals, co.co_names)
g = (i for i in range(3))
print(g.gi_code.co_varnames, (lambda x, *y: 0).__code__.co_varnames)
class Acct:
    def __init__(self, n):
        self.__n = n
        __tmp = n * 2
        self._Acct__z = __tmp
    def get(self):
        return [self.__n for _ in range(1)]
def outer(a):
    b = 1
    def mid():
        nonlocal b
        b += 1
        def inner():
            return a + b
        return inner
    return mid
def comps(xs, ys):
    p = [[x * y for y in ys] for x in xs]
    q = {x: [y for y in ys if y > x] for x in xs}
    r = [lambda: x for x in xs]
    s = [(lambda: z)() for z in xs]
    t = [w for w in (v for v in xs)]
    u = sorted(xs, key=lambda e: -e)
    return p, q, r, s, t, u
def flow(items):
    i = 0
    while i < 3:
        i += 1
        if i == 2:
            continue
    else:
        done = True
    for a, *rest in items:
        first, (second, third) = a, rest
    try:
        return 1
    finally:
        cleanup = i
    unreachable = 5
def mutate(d, k):
    d[k] += 1
    d.x.y = 2
    del d.x, d[k]
    del d
    x = y = z = 0
    x, y = y, x
    print(*[x], sep=str(y), **{'end': z})
async def acomp(src):
    res = [x async for x in src if await x]
    gen = (y async for y in src)
    async with src as (m, n):
        await m
    return res, gen
def matcher(v):
    match v:
        case {'a': [1, x, *_], 'b': y} if x > y:
            return x
        case (1 | 2 | 3) as small:
            return small
        case object(real=re, imag=im):
            return re
        case [*_, last]:
            return last
def defaults(a=len, *, b=print, c=lambda q=min: q):
    @staticmethod
    def k(z=max): pass
    class C(object, metaclass=type):
        attr = a
    return k, C
def gen_func(n):
    total = yield n
    yield from range(total)
for f in (Acct.__init__, Acct.get, outer, outer(1), outer(1)(), comps, flow, mutate, acomp, matcher, defaults, gen_func):
    show(f)
g = (k * 2 for k in range(3) if k for m in range(k))
print(g.gi_code.co_varnames, g.gi_code.co_names, g.gi_code.co_argcount, g.gi_code.co_nlocals)
print((lambda *a, **k: a).__code__.co_varnames, (lambda: [i for i in 'ab']).__code__.co_varnames)
def generic[T](x: T, *ys: T) -> T:
    return x
def annotated():
    Local = int
    def inner(a: Local) -> Local:
        return a
    return inner
class B:
    def m(self, r):
        return [super().m() for _ in r]
    @classmethod
    def c(cls):
        return cls.__name__
    @property
    def p(self):
        return self.__dict__
def walrus_mod(xs):
    if any((hit := x) > 2 for x in xs):
        return hit
    print([(y := v) for v in xs], y)
def exc_names():
    try:
        pass
    except* (ValueError, TypeError) as group:
        handled = group
    try:
        pass
    except Exception:
        raise
    finally:
        pass
def shadow(x):
    x = [x for x in x]
    return [x for x in x]
def imports():
    from os import path as p, sep
    import json, re as regex
    from collections.abc import Mapping
    return p, sep, json, regex, Mapping
def strings(n):
    return f'{n:>{n}}' + t'{n!r}'.strings[0] + '%s' % n + 'x'.join([str(n)])
def deleted():
    a = 1
    b = 2
    del b
    del a
for f in (generic, annotated, B.m, B.c, B.p.fget, walrus_mod, exc_names, shadow, imports, strings, deleted):
    show(f)
co = compile('import os, sys as s\\nfrom json import loads\\n[x for x in range(2) if (w := x)]\\nprint(w)\\n', '<m>', 'exec')
print(co.co_names, co.co_varnames, co.co_nlocals, co.co_argcount)
co2 = compile('a + b * len(c)', '<e>', 'eval')
print(co2.co_names, co2.co_varnames)
co3 = compile('"""doc"""\\nfrom __future__ import annotations\\nx: int = 1\\n', '<m>', 'exec')
print(co3.co_names)
ns = {}
exec('def h(q):\\n    return [q * i for i in range(q)]', ns)
print(ns['h'].__code__.co_varnames, ns['h'].__code__.co_names)
_ctx.__exit__(None, None, None)
EXPECTED = "f1 ('a', 'b', 'c', 'd', 'args', 'kw', 'x', 'i', 'y') 9 2 () () ()\\nf2 ('dead', 'dead2', 'z') 3 0 () () ()\\nf3 ('n', 'undefined_before', 'total', 'i', 'j', 'k', 'fh', 'g', 'h', 'other', 'err', 'msg', 'eg', 'fin', 'kg') 15 1 () () ('enumerate', 'open', 'ValueError', 'str', 'TypeError', 'KeyError')\\nf4 ('seq', 'inner', 'lam', 'gen', 'k', 'v', 'd', 'w', 'w2', 's', 'walrus', 'y', 'last', 'ys') 14 1 ('captured',) () ('len',)\\nf5 ('subject', 'a', 'rest', 'v', 'others', 'px', 'py', 's') 8 1 () () ('Point', 'str')\\nm ('self',) 1 1 () ('__class__',) ('super', 'm')\\nn ('self',) 1 1 () ('__class__',) ()\\nf6 ('xs', 'a', 'b', 'r', 'c') 5 1 () () ()\\nf7 ('a', 'b', 'c', 'os', 'cabc', 'd', 'loads', 'nonlocal_free', 'Inner', 'deco', 'x', 'y') 12 2 () () ('os.path', 'collections.abc', 'abc', 'json', 'dumps', 'loads', 'G', 'staticmethod', 'attr', 'sub', 'b', 'print')\\nf8 ('x', 'z', 'y') 3 0 () () ('range',)\\n('q', 's') 2 ('range', 'r', 'C')\\n('.0', 'i') ('x', 'y')\\n__init__ ('self', 'n', '_Acct__tmp') 3 2 () () ('_Acct__n', '_Acct__z')\\nget ('self', '_') 2 1 () () ('range', '_Acct__n')\\nouter ('a', 'mid') 2 1 ('a', 'b') () ()\\nmid ('inner',) 1 0 () ('a', 'b') ()\\ninner () 0 0 () ('a', 'b') ()\\ncomps ('xs', 'ys', 'x', 'y', 'p', 'q', 'r', 'z', 's', 'w', 't', 'u') 12 2 ('x', 'z') () ('sorted',)\\nflow ('items', 'i', 'done', 'a', 'rest', 'first', 'second', 'third', 'cleanup', 'unreachable') 10 1 () () ()\\nmutate ('d', 'k', 'x', 'y', 'z') 5 2 () () ('x', 'y', 'print', 'str')\\nacomp ('src', 'x', 'res', 'gen', 'm', 'n') 6 1 () () ()\\nmatcher ('v', 'x', 'y', 'small', 're', 'im', 'last') 7 1 () () ('object',)\\ndefaults ('a', 'b', 'c', 'k', 'C') 5 1 ('a',) () ('staticmethod', 'max', 'object', 'type')\\ngen_func ('n', 'total') 2 1 () () ('range',)\\n('.0', 'k', 'm') ('range',) 1 3\\n('a', 'k') ('i',)\\ngeneric ('x', 'ys') 2 1 () () ()\\nannotated ('inner',) 1 0 ('Local',) () ('int',)\\nm ('self', 'r', '_') 3 2 () ('__class__',) ('super', 'm')\\nc ('cls',) 1 1 () () ('__name__',)\\np ('self',) 1 1 () () ('__dict__',)\\nwalrus_mod ('xs', 'v', 'y') 3 1 ('hit',) () ('any', 'print')\\nexc_names ('group', 'handled') 2 0 () () ('ValueError', 'TypeError', 'Exception')\\nshadow ('x',) 1 1 () () ()\\nimports ('p', 'sep', 'json', 'regex', 'Mapping') 5 0 () () ('os', 'path', 'sep', 'json', 're', 'collections.abc', 'Mapping')\\nstrings ('n',) 1 1 () () ('strings', 'join', 'str')\\ndeleted ('a', 'b') 2 0 () () ()\\n('os', 'sys', 's', 'json', 'loads', 'range', 'w', 'print') ('x', 'w') 2 0\\n('a', 'b', 'len', 'c') ()\\n('__conditional_annotations__', '__doc__', '__future__', 'annotations', 'x', '__annotations__')\\n('q', 'i') ('range',)\\n"
if _buf.getvalue() != EXPECTED: raise AssertionError(_buf.getvalue())
`);
});
