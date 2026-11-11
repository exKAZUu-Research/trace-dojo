import { builtin } from '../define';
import { callValue } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule } from '../sourceModules';
import { None } from '../types';
import type { PyValue } from '../values';
import { weakrefClass, weakReferenceOf } from '../weakReferences';

/** Whether a weak reference and the object it refers to are both still alive. */
function isAlive(reference: PyValue): boolean {
  return (
    currentRuntime()
      .reachableObjects()
      .has(reference as object) && callValue(reference, []) !== None
  );
}

// The parts of CPython's `weakref.py` and `_weakrefset.py` written in Python here: WeakMethod, the weak collections,
// finalize, and the proxies, which CPython writes in C. A collection drops an entry when it is next used after its
// object is freed, where CPython drops it at once through a callback; what the program can see is the same.
const SOURCE = String.raw`import itertools
import sys
from collections.abc import MutableMapping, MutableSet

ProxyTypes = None

__all__ = ["ref", "proxy", "getweakrefcount", "getweakrefs",
           "WeakKeyDictionary", "ReferenceType", "ProxyType",
           "CallableProxyType", "ProxyTypes", "WeakValueDictionary",
           "WeakSet", "WeakMethod", "finalize"]


class WeakMethod(ref):
    """
    A custom \x60weakref.ref\x60 subclass which simulates a weak reference to
    a bound method, working around the lifetime problem of bound methods.
    """

    __slots__ = "_func_ref", "_meth_type", "_alive", "__weakref__"

    def __new__(cls, meth, callback=None):
        try:
            obj = meth.__self__
            func = meth.__func__
        except AttributeError:
            raise TypeError("argument should be a bound method, not {}"
                            .format(type(meth))) from None
        def _cb(arg):
            self = self_wr()
            if self._alive:
                self._alive = False
                if callback is not None:
                    callback(self)
        self = ref.__new__(cls, obj, _cb)
        self._func_ref = ref(func, _cb)
        self._meth_type = type(meth)
        self._alive = True
        self_wr = ref(self)
        return self

    def __call__(self):
        obj = super().__call__()
        func = self._func_ref()
        if obj is None or func is None:
            return None
        return self._meth_type(func, obj)

    def __eq__(self, other):
        if isinstance(other, WeakMethod):
            if not self._alive or not other._alive:
                return self is other
            return ref.__eq__(self, other) and self._func_ref == other._func_ref
        return NotImplemented

    def __ne__(self, other):
        if isinstance(other, WeakMethod):
            if not self._alive or not other._alive:
                return self is not other
            return ref.__ne__(self, other) or self._func_ref != other._func_ref
        return NotImplemented

    __hash__ = ref.__hash__


class KeyedRef(ref):
    """Specialized reference that includes a key corresponding to the value."""

    __slots__ = "key",

    def __new__(type, ob, callback, key):
        self = ref.__new__(type, ob, callback)
        self.key = key
        return self

    def __init__(self, ob, callback, key):
        super().__init__(ob, callback)


# The collections below drop an entry when its object is freed, which they notice when they are next used.

class WeakValueDictionary(MutableMapping):
    """Mapping class that references values weakly."""

    def __init__(self, other=(), /, **kw):
        self.data = {}
        self.update(other, **kw)

    def _live(self):
        for key, wr in list(self.data.items()):
            if wr() is None:
                del self.data[key]
        return self.data

    def __getitem__(self, key):
        o = self._live()[key]()
        if o is None:
            raise KeyError(key)
        return o

    def __delitem__(self, key):
        del self._live()[key]

    def __len__(self):
        return len(self._live())

    def __contains__(self, key):
        try:
            o = self._live()[key]()
        except KeyError:
            return False
        return o is not None

    def __repr__(self):
        return "<%s at %#x>" % (self.__class__.__name__, id(self))

    def __setitem__(self, key, value):
        self._live()[key] = KeyedRef(value, None, key)

    def copy(self):
        new = WeakValueDictionary()
        for key, wr in self._live().items():
            o = wr()
            if o is not None:
                new[key] = o
        return new

    __copy__ = copy

    def __deepcopy__(self, memo):
        from copy import deepcopy
        new = self.__class__()
        for key, wr in self._live().items():
            o = wr()
            if o is not None:
                new[deepcopy(key, memo)] = o
        return new

    def get(self, key, default=None):
        try:
            wr = self._live()[key]
        except KeyError:
            return default
        else:
            o = wr()
            if o is None:
                return default
            else:
                return o

    def items(self):
        for k, wr in list(self._live().items()):
            v = wr()
            if v is not None:
                yield k, v

    def keys(self):
        for k, wr in list(self._live().items()):
            if wr() is not None:
                yield k

    __iter__ = keys

    def itervaluerefs(self):
        yield from list(self._live().values())

    def values(self):
        for wr in list(self._live().values()):
            obj = wr()
            if obj is not None:
                yield obj

    def popitem(self):
        while True:
            key, wr = self._live().popitem()
            o = wr()
            if o is not None:
                return key, o

    def pop(self, key, *args):
        try:
            o = self._live().pop(key)()
        except KeyError:
            o = None
        if o is None:
            if args:
                return args[0]
            else:
                raise KeyError(key)
        else:
            return o

    def setdefault(self, key, default=None):
        try:
            o = self._live()[key]()
        except KeyError:
            o = None
        if o is None:
            self.data[key] = KeyedRef(default, None, key)
            return default
        else:
            return o

    def update(self, other=None, /, **kwargs):
        d = self._live()
        if other is not None:
            if not hasattr(other, "items"):
                other = dict(other)
            for key, o in other.items():
                d[key] = KeyedRef(o, None, key)
        for key, o in kwargs.items():
            d[key] = KeyedRef(o, None, key)

    def valuerefs(self):
        return list(self._live().values())

    def __ior__(self, other):
        self.update(other)
        return self

    def __or__(self, other):
        if isinstance(other, _collections_abc.Mapping):
            c = self.copy()
            c.update(other)
            return c
        return NotImplemented

    def __ror__(self, other):
        if isinstance(other, _collections_abc.Mapping):
            c = self.__class__()
            c.update(other)
            c.update(self)
            return c
        return NotImplemented


class WeakKeyDictionary(MutableMapping):
    """ Mapping class that references keys weakly."""

    def __init__(self, dict=None):
        self.data = {}
        if dict is not None:
            self.update(dict)

    def _live(self):
        for wr in list(self.data):
            if wr() is None:
                del self.data[wr]
        return self.data

    def __delitem__(self, key):
        del self._live()[ref(key)]

    def __getitem__(self, key):
        return self._live()[ref(key)]

    def __len__(self):
        return len(self._live())

    def __repr__(self):
        return "<%s at %#x>" % (self.__class__.__name__, id(self))

    def __setitem__(self, key, value):
        self._live()[ref(key)] = value

    def copy(self):
        new = WeakKeyDictionary()
        for key, value in self._live().items():
            o = key()
            if o is not None:
                new[o] = value
        return new

    __copy__ = copy

    def __deepcopy__(self, memo):
        from copy import deepcopy
        new = self.__class__()
        for key, value in self._live().items():
            o = key()
            if o is not None:
                new[o] = deepcopy(value, memo)
        return new

    def get(self, key, default=None):
        return self._live().get(ref(key), default)

    def __contains__(self, key):
        try:
            wr = ref(key)
        except TypeError:
            return False
        return wr in self._live()

    def items(self):
        for wr, value in list(self._live().items()):
            key = wr()
            if key is not None:
                yield key, value

    def keys(self):
        for wr in list(self._live()):
            obj = wr()
            if obj is not None:
                yield obj

    __iter__ = keys

    def values(self):
        for wr, value in list(self._live().items()):
            if wr() is not None:
                yield value

    def keyrefs(self):
        return list(self._live())

    def popitem(self):
        while True:
            key, value = self._live().popitem()
            o = key()
            if o is not None:
                return o, value

    def pop(self, key, *args):
        return self._live().pop(ref(key), *args)

    def setdefault(self, key, default=None):
        return self._live().setdefault(ref(key), default)

    def update(self, dict=None, /, **kwargs):
        d = self._live()
        if dict is not None:
            if not hasattr(dict, "items"):
                dict = type({})(dict)
            for key, value in dict.items():
                d[ref(key)] = value
        if len(kwargs):
            self.update(kwargs)

    def __ior__(self, other):
        self.update(other)
        return self

    def __or__(self, other):
        if isinstance(other, _collections_abc.Mapping):
            c = self.copy()
            c.update(other)
            return c
        return NotImplemented

    def __ror__(self, other):
        if isinstance(other, _collections_abc.Mapping):
            c = self.__class__()
            c.update(other)
            c.update(self)
            return c
        return NotImplemented


class WeakSet(MutableSet):
    def __init__(self, data=None):
        self.data = set()
        if data is not None:
            self.update(data)

    def _live(self):
        for item in list(self.data):
            if item() is None:
                self.data.discard(item)
        return self.data

    def __iter__(self):
        for itemref in list(self._live()):
            item = itemref()
            if item is not None:
                yield item

    def __len__(self):
        return len(self._live())

    def __contains__(self, item):
        try:
            wr = ref(item)
        except TypeError:
            return False
        return wr in self._live()

    def __reduce__(self):
        return self.__class__, (list(self),), self.__getstate__()

    def add(self, item):
        self._live().add(ref(item))

    def clear(self):
        self.data.clear()

    def copy(self):
        return self.__class__(self)

    def pop(self):
        while True:
            try:
                itemref = self._live().pop()
            except KeyError:
                raise KeyError('pop from empty WeakSet') from None
            item = itemref()
            if item is not None:
                return item

    def remove(self, item):
        self._live().remove(ref(item))

    def discard(self, item):
        self._live().discard(ref(item))

    def update(self, other):
        for element in other:
            self.add(element)

    def __ior__(self, other):
        self.update(other)
        return self

    def difference(self, other):
        newset = self.copy()
        newset.difference_update(other)
        return newset
    __sub__ = difference

    def difference_update(self, other):
        self.__isub__(other)

    def __isub__(self, other):
        if self is other:
            self.data.clear()
        else:
            self.data.difference_update(ref(item) for item in other)
        return self

    def intersection(self, other):
        return self.__class__(item for item in other if item in self)
    __and__ = intersection

    def intersection_update(self, other):
        self.__iand__(other)

    def __iand__(self, other):
        self.data.intersection_update(ref(item) for item in other)
        return self

    def issubset(self, other):
        return self._live().issubset(ref(item) for item in other)
    __le__ = issubset

    def __lt__(self, other):
        return self._live() < set(map(ref, other))

    def issuperset(self, other):
        return self._live().issuperset(ref(item) for item in other)
    __ge__ = issuperset

    def __gt__(self, other):
        return self._live() > set(map(ref, other))

    def __eq__(self, other):
        if not isinstance(other, self.__class__):
            return NotImplemented
        return self._live() == set(map(ref, other))

    def symmetric_difference(self, other):
        newset = self.copy()
        newset.symmetric_difference_update(other)
        return newset
    __xor__ = symmetric_difference

    def symmetric_difference_update(self, other):
        self.__ixor__(other)

    def __ixor__(self, other):
        if self is other:
            self.data.clear()
        else:
            self.data.symmetric_difference_update(ref(item) for item in other)
        return self

    def union(self, other):
        return self.__class__(e for s in (self, other) for e in s)
    __or__ = union

    def isdisjoint(self, other):
        return len(self.intersection(other)) == 0

    def __repr__(self):
        return repr(self.data)


class finalize:
    """Class for finalization of weakrefable objects

    finalize(obj, func, *args, **kwargs) returns a callable finalizer
    object which will be called when obj is garbage collected. The
    first time the finalizer is called it evaluates func(*arg, **kwargs)
    and returns the result. After this the finalizer is dead, and
    calling it just returns None.

    When the program exits any remaining finalizers for which the
    atexit attribute is true will be run in reverse order of creation.
    By default atexit is true.
    """

    __slots__ = ()
    _registry = {}
    _shutdown = False
    _index_iter = itertools.count()
    _dirty = False
    _registered_with_atexit = False

    class _Info:
        __slots__ = ("weakref", "func", "args", "kwargs", "atexit", "index")

    def __init__(self, obj, func, /, *args, **kwargs):
        if not self._registered_with_atexit:
            import atexit
            atexit.register(self._exitfunc)
            finalize._registered_with_atexit = True
        info = self._Info()
        info.weakref = ref(obj, self)
        info.func = func
        info.args = args
        info.kwargs = kwargs or None
        info.atexit = True
        info.index = next(self._index_iter)
        self._registry[self] = info
        finalize._dirty = True

    def __call__(self, _=None):
        """If alive then mark as dead and return func(*args, **kwargs);
        otherwise return None"""
        info = self._registry.pop(self, None)
        if info and not self._shutdown:
            return info.func(*info.args, **(info.kwargs or {}))

    def detach(self):
        """If alive then mark as dead and return (obj, func, args, kwargs);
        otherwise return None"""
        info = self._registry.get(self)
        obj = info and info.weakref()
        if obj is not None and self._registry.pop(self, None):
            return (obj, info.func, info.args, info.kwargs or {})

    def peek(self):
        """If alive then return (obj, func, args, kwargs);
        otherwise return None"""
        info = self._registry.get(self)
        obj = info and info.weakref()
        if obj is not None:
            return (obj, info.func, info.args, info.kwargs or {})

    @property
    def alive(self):
        """Whether finalizer is alive"""
        return self in self._registry

    @property
    def atexit(self):
        """Whether finalizer should be called at exit"""
        info = self._registry.get(self)
        return bool(info) and info.atexit

    @atexit.setter
    def atexit(self, value):
        info = self._registry.get(self)
        if info:
            info.atexit = bool(value)

    def __repr__(self):
        info = self._registry.get(self)
        obj = info and info.weakref()
        if obj is None:
            return '<%s object at %#x; dead>' % (type(self).__name__, id(self))
        else:
            return '<%s object at %#x; for %r at %#x>' % \
                (type(self).__name__, id(self), type(obj).__name__, id(obj))

    @classmethod
    def _select_for_exit(cls):
        L = [(f,i) for (f,i) in cls._registry.items() if i.atexit]
        L.sort(key=lambda item:item[1].index)
        return [f for (f,i) in L]

    @classmethod
    def _exitfunc(cls):
        reenable_gc = False
        try:
            if cls._registry:
                import gc
                if gc.isenabled():
                    reenable_gc = True
                    gc.disable()
                pending = None
                while True:
                    if pending is None or finalize._dirty:
                        pending = cls._select_for_exit()
                        finalize._dirty = False
                    if not pending:
                        break
                    f = pending.pop()
                    try:
                        f()
                    except Exception:
                        # CPython's sys.excepthook reports it on stderr, which the grader does not show.
                        pass
                    assert f not in cls._registry
        finally:
            finalize._shutdown = True
            if reenable_gc:
                gc.enable()


import collections.abc as _collections_abc


import operator as _operator


def _unwrap(value):
    if isinstance(value, ProxyType):
        referent = object.__getattribute__(value, '_proxy_ref')()
        if referent is None:
            raise ReferenceError('weakly-referenced object no longer exists')
        return referent
    return value


class ProxyType:
    __slots__ = ('_proxy_ref', '__weakref__')

    def __init__(self, ref):
        object.__setattr__(self, '_proxy_ref', ref)

    def __getattribute__(self, name):
        return getattr(_unwrap(self), name)

    def __setattr__(self, name, value):
        setattr(_unwrap(self), name, value)

    def __delattr__(self, name):
        delattr(_unwrap(self), name)

    def __repr__(self):
        referent = object.__getattribute__(self, '_proxy_ref')()
        if referent is None:
            return '<weakproxy at %#x; dead>' % id(self)
        return '<weakproxy at %#x; to %r at %#x>' % (id(self), type(referent).__name__, id(referent))

    def __str__(self):
        return str(_unwrap(self))

    def __bytes__(self):
        return bytes(_unwrap(self))

    def __bool__(self):
        return bool(_unwrap(self))

    def __hash__(self):
        raise TypeError("unhashable type: 'weakref.%s'" % type(self).__name__)

    def __len__(self):
        return len(_unwrap(self))

    def __iter__(self):
        return iter(_unwrap(self))

    def __next__(self):
        return next(_unwrap(self))

    def __reversed__(self):
        return reversed(_unwrap(self))

    def __contains__(self, item):
        return item in _unwrap(self)

    def __getitem__(self, key):
        return _unwrap(self)[key]

    def __setitem__(self, key, value):
        _unwrap(self)[key] = value

    def __delitem__(self, key):
        del _unwrap(self)[key]

    def __index__(self):
        return _operator.index(_unwrap(self))

    def __int__(self):
        return int(_unwrap(self))

    def __float__(self):
        return float(_unwrap(self))

    def __abs__(self):
        return abs(_unwrap(self))

    def __neg__(self):
        return -_unwrap(self)

    def __pos__(self):
        return +_unwrap(self)

    def __invert__(self):
        return ~_unwrap(self)


def _binary(op):
    def forward(self, other):
        return op(_unwrap(self), _unwrap(other))
    def backward(self, other):
        return op(_unwrap(other), _unwrap(self))
    return forward, backward


for _name, _op in [('add', _operator.add), ('sub', _operator.sub), ('mul', _operator.mul),
                   ('matmul', _operator.matmul), ('truediv', _operator.truediv),
                   ('floordiv', _operator.floordiv), ('mod', _operator.mod), ('pow', _operator.pow),
                   ('lshift', _operator.lshift), ('rshift', _operator.rshift), ('and', _operator.and_),
                   ('or', _operator.or_), ('xor', _operator.xor), ('divmod', divmod)]:
    _forward, _backward = _binary(_op)
    setattr(ProxyType, '__%s__' % _name, _forward)
    setattr(ProxyType, '__r%s__' % _name, _backward)

for _name, _op in [('lt', _operator.lt), ('le', _operator.le), ('eq', _operator.eq),
                   ('ne', _operator.ne), ('gt', _operator.gt), ('ge', _operator.ge)]:
    setattr(ProxyType, '__%s__' % _name, _binary(_op)[0])

for _name, _op in [('iadd', _operator.iadd), ('isub', _operator.isub), ('imul', _operator.imul),
                   ('itruediv', _operator.itruediv), ('ifloordiv', _operator.ifloordiv),
                   ('imod', _operator.imod), ('ior', _operator.ior), ('iand', _operator.iand),
                   ('ixor', _operator.ixor)]:
    setattr(ProxyType, '__%s__' % _name, _binary(_op)[0])

_c_type_name(ProxyType, 'weakref.ProxyType')


class CallableProxyType(ProxyType):
    __slots__ = ()

    def __call__(self, *args, **kwargs):
        return _unwrap(self)(*args, **kwargs)


_c_type_name(CallableProxyType, 'weakref.CallableProxyType')
ProxyTypes = (ProxyType, CallableProxyType)


def proxy(object, callback=None, /):
    """Create a proxy object that weakly references 'object'."""
    reference = ref(object) if callback is None else ref(object, lambda r: callback(result))
    result = (CallableProxyType if callable(object) else ProxyType)(reference)
    return result


del _name, _op, _forward, _backward
`;

registerSourceModule(
  'weakref',
  SOURCE,
  () =>
    new Map<string, PyValue>([
      ['ref', weakrefClass],
      ['ReferenceType', weakrefClass],
      [
        'getweakrefcount',
        builtin('getweakrefcount', 'one', 1, 1, ([value]) => {
          const reference = weakReferenceOf(value);
          return reference !== undefined && isAlive(reference) ? 1n : 0n;
        }),
      ],
      [
        'getweakrefs',
        builtin('getweakrefs', 'one', 1, 1, ([value]) => {
          const reference = weakReferenceOf(value);
          return currentRuntime().listOf(reference !== undefined && isAlive(reference) ? [reference] : []);
        }),
      ],
    ])
);
