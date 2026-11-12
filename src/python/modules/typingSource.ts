/**
 * The functions and protocols of CPython 3.14's Lib/typing.py that are plain Python, in the Python this interpreter
 * runs. The protocols are abstract base classes whose `__subclasshook__` checks their methods, as
 * `@runtime_checkable` makes them.
 */
export const TYPING_SOURCE = String.raw`
import collections
import functools

_ASSERT_NEVER_REPR_MAX_LENGTH = 100


def cast(typ, val):
    return val


def assert_type(val, typ, /):
    return val


def assert_never(arg, /):
    value = repr(arg)
    if len(value) > _ASSERT_NEVER_REPR_MAX_LENGTH:
        value = value[:_ASSERT_NEVER_REPR_MAX_LENGTH] + '...'
    raise AssertionError(f"Expected code to be unreachable, but got: {value}")


def reveal_type(obj, /):
    return obj


def no_type_check(arg):
    if isinstance(arg, type):
        for key in dir(arg):
            obj = getattr(arg, key)
            if (
                not hasattr(obj, '__qualname__')
                or obj.__qualname__ != f'{arg.__qualname__}.{obj.__name__}'
                or getattr(obj, '__module__', None) != arg.__module__
            ):
                continue
            if isinstance(obj, _FunctionType):
                obj.__no_type_check__ = True
            if isinstance(obj, _MethodType):
                obj.__func__.__no_type_check__ = True
            if isinstance(obj, type):
                no_type_check(obj)
    try:
        arg.__no_type_check__ = True
    except TypeError:
        pass
    return arg


def no_type_check_decorator(decorator):
    @functools.wraps(decorator)
    def wrapped_decorator(*args, **kwds):
        func = decorator(*args, **kwds)
        func = no_type_check(func)
        return func

    return wrapped_decorator


def _overload_dummy(*args, **kwds):
    raise NotImplementedError(
        "You should not call an overloaded function. "
        "A series of @overload-decorated functions "
        "outside a stub module should always be followed "
        "by an implementation that is not @overload-ed.")


_overload_registry = collections.defaultdict(functools.partial(collections.defaultdict, dict))


def overload(func):
    f = getattr(func, "__func__", func)
    try:
        _overload_registry[f.__module__][f.__qualname__][_firstlineno(f)] = func
    except AttributeError:
        pass
    return _overload_dummy


def get_overloads(func):
    f = getattr(func, "__func__", func)
    if f.__module__ not in _overload_registry:
        return []
    mod_dict = _overload_registry[f.__module__]
    if f.__qualname__ not in mod_dict:
        return []
    return list(mod_dict[f.__qualname__].values())


def clear_overloads():
    _overload_registry.clear()


def final(f):
    try:
        f.__final__ = True
    except (AttributeError, TypeError):
        pass
    return f


def override(method, /):
    try:
        method.__override__ = True
    except (AttributeError, TypeError):
        pass
    return method


def dataclass_transform(
    *,
    eq_default=True,
    order_default=False,
    kw_only_default=False,
    frozen_default=False,
    field_specifiers=(),
    **kwargs,
):
    def decorator(cls_or_fn):
        cls_or_fn.__dataclass_transform__ = {
            "eq_default": eq_default,
            "order_default": order_default,
            "kw_only_default": kw_only_default,
            "frozen_default": frozen_default,
            "field_specifiers": field_specifiers,
            "kwargs": kwargs,
        }
        return cls_or_fn
    return decorator


def is_typeddict(tp):
    return False


def is_protocol(tp, /):
    return (
        isinstance(tp, type)
        and tp in _PROTOCOLS
    )


def get_protocol_members(tp, /):
    if not is_protocol(tp):
        raise TypeError(f'{tp!r} is not a Protocol')
    return frozenset(_PROTOCOLS[tp])


class _Protocol:
    def __init__(self, *args, **kwargs):
        if type(self) in _PROTOCOLS:
            raise TypeError('Protocols cannot be instantiated')

    @classmethod
    def __subclasshook__(cls, other):
        if cls not in _PROTOCOLS:
            return NotImplemented
        for attr in _PROTOCOLS[cls]:
            for base in other.__mro__:
                if attr in base.__dict__:
                    if base.__dict__[attr] is None:
                        return NotImplemented
                    break
            else:
                return NotImplemented
        return True


class SupportsInt(_Protocol):
    def __int__(self):
        pass


class SupportsFloat(_Protocol):
    def __float__(self):
        pass


class SupportsComplex(_Protocol):
    def __complex__(self):
        pass


class SupportsBytes(_Protocol):
    def __bytes__(self):
        pass


class SupportsIndex(_Protocol):
    def __index__(self):
        pass


class SupportsAbs(_Protocol):
    def __abs__(self):
        pass


class SupportsRound(_Protocol):
    def __round__(self, ndigits=0):
        pass


_PROTOCOLS = {
    SupportsInt: ['__int__'],
    SupportsFloat: ['__float__'],
    SupportsComplex: ['__complex__'],
    SupportsBytes: ['__bytes__'],
    SupportsIndex: ['__index__'],
    SupportsAbs: ['__abs__'],
    SupportsRound: ['__round__'],
}
for _protocol in _PROTOCOLS:
    _abc_init(_protocol)
del _protocol
`;
