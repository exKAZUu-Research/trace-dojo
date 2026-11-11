import { makeIterableCoroutine, markIterableCoroutine } from '../coroutines';
import { builtin } from '../define';
import { registerUnsupportedAttributes } from '../modules';
import { registerSourceModule } from '../sourceModules';
import { codeClass, frameClass, tracebackClass } from '../tracebacks';
import { asyncGeneratorClass, cellClass, coroutineClass, generatorClass, methodClass, newDict, None } from '../types';
import { PyFunction, PyGenerator, type PyValue } from '../values';

// CPython's `types.py`, with `SimpleNamespace` and `MappingProxyType`, which CPython writes in C, written in Python.
const SOURCE = String.raw`
import sys


def _f(): pass
FunctionType = type(_f)
LambdaType = type(lambda: None)
MethodType = _builtin_types['method']
BuiltinFunctionType = type(len)
BuiltinMethodType = type([].append)
MethodDescriptorType = type(str.join)
ModuleType = type(sys)
GeneratorType = _builtin_types['generator']
CoroutineType = _builtin_types['coroutine']
AsyncGeneratorType = _builtin_types['async_generator']
CellType = _builtin_types['cell']
CodeType = _builtin_types['code']
FrameType = _builtin_types['frame']
TracebackType = _builtin_types['traceback']
EllipsisType = type(Ellipsis)
NoneType = type(None)
NotImplementedType = type(NotImplemented)
GenericAlias = type(list[int])
UnionType = type(int | str)


class SimpleNamespace:
    def __init__(self, mapping_or_iterable=(), /, **kwargs):
        for key, value in dict(mapping_or_iterable).items():
            if not isinstance(key, str):
                raise TypeError("keywords must be strings")
            setattr(self, key, value)
        for key, value in kwargs.items():
            setattr(self, key, value)

    def __repr__(self):
        if type(self) is SimpleNamespace:
            name = 'namespace'
        else:
            name = type(self).__name__
        if id(self) in _repr_running:
            return name + '(...)'
        _repr_running.add(id(self))
        try:
            items = [f'{key}={value!r}' for key, value in self.__dict__.items()]
        finally:
            _repr_running.discard(id(self))
        return f"{name}({', '.join(items)})"

    def __eq__(self, other):
        if isinstance(self, SimpleNamespace) and isinstance(other, SimpleNamespace):
            return self.__dict__ == other.__dict__
        return NotImplemented

    def __replace__(self, /, **changes):
        result = type(self)(**self.__dict__)
        for key, value in changes.items():
            setattr(result, key, value)
        return result


_repr_running = set()
_c_type_name(SimpleNamespace, 'types.SimpleNamespace')


class mappingproxy:
    __module__ = 'builtins'

    def __init__(self, mapping):
        if not hasattr(mapping, 'keys') or not hasattr(mapping, '__getitem__') or isinstance(mapping, (list, tuple)):
            raise TypeError(f'mappingproxy() argument must be a mapping, not {type(mapping).__name__}')
        object.__setattr__(self, '_mapping', mapping)

    def __setattr__(self, name, value):
        raise AttributeError(f"'mappingproxy' object has no attribute '{name}' and no __dict__ for setting new attributes")

    def __getitem__(self, key):
        return self._mapping[key]

    def __contains__(self, key):
        return key in self._mapping

    def __iter__(self):
        return iter(self._mapping)

    def __reversed__(self):
        return reversed(self._mapping)

    def __len__(self):
        return len(self._mapping)

    def __eq__(self, other):
        return self._mapping == other

    def __or__(self, other):
        return dict(self._mapping) | other

    def __ror__(self, other):
        return other | dict(self._mapping)

    def __repr__(self):
        return f'mappingproxy({self._mapping!r})'

    def __str__(self):
        return str(self._mapping)

    def get(self, key, default=None):
        return self._mapping.get(key, default)

    def keys(self):
        return self._mapping.keys()

    def values(self):
        return self._mapping.values()

    def items(self):
        return self._mapping.items()

    def copy(self):
        return self._mapping.copy()


MappingProxyType = mappingproxy


def coroutine(func):
    if not callable(func):
        raise TypeError('types.coroutine() expects a callable')
    if _make_iterable_coroutine(func):
        return func

    def wrapped(*args, **kwargs):
        coro = func(*args, **kwargs)
        _mark_iterable_coroutine(coro)
        return coro

    for name in ('__module__', '__name__', '__qualname__', '__doc__'):
        try:
            setattr(wrapped, name, getattr(func, name))
        except AttributeError:
            pass
    wrapped.__wrapped__ = func
    return wrapped


def new_class(name, bases=(), kwds=None, exec_body=None):
    """Create a class object dynamically using the appropriate metaclass."""
    resolved_bases = resolve_bases(bases)
    meta, ns, kwds = prepare_class(name, resolved_bases, kwds)
    if exec_body is not None:
        exec_body(ns)
    if resolved_bases is not bases:
        ns['__orig_bases__'] = bases
    return meta(name, resolved_bases, ns, **kwds)

def resolve_bases(bases):
    """Resolve MRO entries dynamically as specified by PEP 560."""
    new_bases = list(bases)
    updated = False
    shift = 0
    for i, base in enumerate(bases):
        if isinstance(base, type):
            continue
        if not hasattr(base, "__mro_entries__"):
            continue
        new_base = base.__mro_entries__(bases)
        updated = True
        if not isinstance(new_base, tuple):
            raise TypeError("__mro_entries__ must return a tuple")
        else:
            new_bases[i+shift:i+shift+1] = new_base
            shift += len(new_base) - 1
    if not updated:
        return bases
    return tuple(new_bases)

def prepare_class(name, bases=(), kwds=None):
    """Call the __prepare__ method of the appropriate metaclass.

    Returns (metaclass, namespace, kwds) as a 3-tuple

    *metaclass* is the appropriate metaclass
    *namespace* is the prepared class namespace
    *kwds* is an updated copy of the passed in kwds argument with any
    'metaclass' entry removed. If no kwds argument is passed in, this will
    be an empty dict.
    """
    if kwds is None:
        kwds = {}
    else:
        kwds = dict(kwds) # Don't alter the provided mapping
    if 'metaclass' in kwds:
        meta = kwds.pop('metaclass')
    else:
        if bases:
            meta = type(bases[0])
        else:
            meta = type
    if isinstance(meta, type):
        # when meta is a type, we first determine the most-derived metaclass
        # instead of invoking the initial candidate directly
        meta = _calculate_meta(meta, bases)
    if hasattr(meta, '__prepare__'):
        ns = meta.__prepare__(name, bases, **kwds)
    else:
        ns = {}
    return meta, ns, kwds

def _calculate_meta(meta, bases):
    """Calculate the most derived metaclass."""
    winner = meta
    for base in bases:
        base_meta = type(base)
        if issubclass(winner, base_meta):
            continue
        if issubclass(base_meta, winner):
            winner = base_meta
            continue
        # else:
        raise TypeError("metaclass conflict: "
                        "the metaclass of a derived class "
                        "must be a (non-strict) subclass "
                        "of the metaclasses of all its bases")
    return winner


def get_original_bases(cls, /):
    """Return the class's "original" bases prior to modification by \x60__mro_entries__\x60.

    Examples::

        from typing import TypeVar, Generic, NamedTuple, TypedDict

        T = TypeVar("T")
        class Foo(Generic[T]): ...
        class Bar(Foo[int], float): ...
        class Baz(list[str]): ...
        Eggs = NamedTuple("Eggs", [("a", int), ("b", str)])
        Spam = TypedDict("Spam", {"a": int, "b": str})

        assert get_original_bases(Bar) == (Foo[int], float)
        assert get_original_bases(Baz) == (list[str],)
        assert get_original_bases(Eggs) == (NamedTuple,)
        assert get_original_bases(Spam) == (TypedDict,)
        assert get_original_bases(int) == (object,)
    """
    try:
        return cls.__dict__.get("__orig_bases__", cls.__bases__)
    except AttributeError:
        raise TypeError(
            f"Expected an instance of type, not {type(cls).__name__!r}"
        ) from None


class DynamicClassAttribute:
    """Route attribute access on a class to __getattr__.

    This is a descriptor, used to define attributes that act differently
    when accessed through an instance and through a class.  Instance access
    remains normal, but access to an attribute through a class will be
    routed to the class's __getattr__ method; this is done by raising
    AttributeError.

    This allows one to have properties active on an instance, and have
    virtual attributes on the class with the same name.  (Enum used this
    between Python versions 3.4 - 3.9 .)

    Subclass from this to use a different method of accessing virtual
    attributes and still be treated properly by the inspect module.  (Enum
    uses this since Python 3.10 .)

    """
    def __init__(self, fget=None, fset=None, fdel=None, doc=None):
        self.fget = fget
        self.fset = fset
        self.fdel = fdel
        # next two lines make DynamicClassAttribute act the same as property
        self.__doc__ = doc or fget.__doc__
        self.overwrite_doc = doc is None
        # support for abstract methods
        self.__isabstractmethod__ = bool(getattr(fget, '__isabstractmethod__', False))

    def __get__(self, instance, ownerclass=None):
        if instance is None:
            if self.__isabstractmethod__:
                return self
            raise AttributeError()
        elif self.fget is None:
            raise AttributeError("unreadable attribute")
        return self.fget(instance)

    def __set__(self, instance, value):
        if self.fset is None:
            raise AttributeError("can't set attribute")
        self.fset(instance, value)

    def __delete__(self, instance):
        if self.fdel is None:
            raise AttributeError("can't delete attribute")
        self.fdel(instance)

    def getter(self, fget):
        fdoc = fget.__doc__ if self.overwrite_doc else None
        result = type(self)(fget, self.fset, self.fdel, fdoc or self.__doc__)
        result.overwrite_doc = self.overwrite_doc
        return result

    def setter(self, fset):
        result = type(self)(self.fget, fset, self.fdel, self.__doc__)
        result.overwrite_doc = self.overwrite_doc
        return result

    def deleter(self, fdel):
        result = type(self)(self.fget, self.fset, fdel, self.__doc__)
        result.overwrite_doc = self.overwrite_doc
        return result


del _f, _builtin_types, _c_type_name, mappingproxy
`;

registerSourceModule(
  'types',
  SOURCE,
  () =>
    new Map<string, PyValue>([
      [
        '_builtin_types',
        newDict([
          ['method', methodClass],
          ['generator', generatorClass],
          ['coroutine', coroutineClass],
          ['async_generator', asyncGeneratorClass],
          ['cell', cellClass],
          ['code', codeClass],
          ['frame', frameClass],
          ['traceback', tracebackClass],
        ]),
      ],
      [
        '_make_iterable_coroutine',
        builtin('_make_iterable_coroutine', 'one', 1, 1, ([fn]) => {
          // A generator function's own generators become awaitable, as CPython sets CO_ITERABLE_COROUTINE on its code.
          if (!(fn instanceof PyFunction) || !fn.def.scope.isGenerator || fn.def.scope.isAsync) return false;
          makeIterableCoroutine(fn);
          return true;
        }),
      ],
      [
        '_mark_iterable_coroutine',
        builtin('_mark_iterable_coroutine', 'one', 1, 1, ([value]) => {
          if (value instanceof PyGenerator && value.cls === generatorClass) markIterableCoroutine(value);
          return None;
        }),
      ],
    ])
);

registerUnsupportedAttributes('types', {
  WrapperDescriptorType: 'types.WrapperDescriptorType',
  MethodWrapperType: 'types.MethodWrapperType',
  ClassMethodDescriptorType: 'types.ClassMethodDescriptorType',
  GetSetDescriptorType: 'types.GetSetDescriptorType',
  MemberDescriptorType: 'types.MemberDescriptorType',
  CapsuleType: 'types.CapsuleType',
});
