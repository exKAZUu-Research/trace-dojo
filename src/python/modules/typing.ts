import { builtin, pythonFunction } from '../define';
import { importModule, registerModule, registerSharedAttributes, registerUnsupportedAttributes } from '../modules';
import { getAttribute } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { runModuleSource } from '../sourceModules';
import {
  annotatedAliasClass,
  annotatedGetItem,
  anyType,
  concatenateGetItem,
  genericAliasClass,
  literalGetItem,
  newSpecialAlias,
  newSpecialForm,
  optionalGetItem,
  singleTypeForm,
  typingAliasClass,
  typingArgs,
  typingBaseEntries,
  typingOrigin,
  unionClass,
} from '../typeHints';
import {
  genericClass,
  mroEntryHooks,
  NoDefault,
  parameterDeclaringClasses,
  paramSpecArgsClass,
  paramSpecClass,
  paramSpecKwargsClass,
  typeAliasClass,
  typeVarClass,
  typeVarTupleClass,
} from '../typeParams';
import {
  dictClass,
  frozensetClass,
  listClass,
  None,
  noneClass,
  setClass,
  strClass,
  tupleClass,
  typeClass,
  typeError,
} from '../types';
import { type PyClass, PyFunction, type PyModule, type PyValue } from '../values';
import { nativeCheckCaller } from './abc';
import { counterClass, defaultdictClass, dequeClass, orderedDictClass } from './collections';
import { isTypedDict, TYPING_CLASSES } from './typingClasses';
import { getTypeHints, newTypeClass } from './typingTypeVars';

/** The names of typing that need features this grader does not support. */
registerUnsupportedAttributes('typing', {
  NamedTupleMeta: 'typing.NamedTupleMeta（NamedTuple を CPython と違う仕組みで作るので、そのメタクラス）',
});
// typing imports annotationlib only when it needs it, as CPython's does.
registerSharedAttributes('typing', { ForwardRef: 'annotationlib:ForwardRef' });

// The functions and protocols of CPython's `typing.py` that are plain Python.
const SOURCE = String.raw`
import collections
import functools
import sys
import types
from abc import ABCMeta, abstractmethod

T = TypeVar('T')
KT = TypeVar('KT')
VT = TypeVar('VT')
T_co = TypeVar('T_co', covariant=True)
V_co = TypeVar('V_co', covariant=True)
VT_co = TypeVar('VT_co', covariant=True)
T_contra = TypeVar('T_contra', contravariant=True)
CT_co = TypeVar('CT_co', covariant=True, bound=type)
AnyStr = TypeVar('AnyStr', bytes, str)

_ASSERT_NEVER_REPR_MAX_LENGTH = 100


def cast(typ, val):
    """Cast a value to a type.

    This returns the value unchanged.  To the type checker this
    signals that the return value has the designated type, but at
    runtime we intentionally don't check anything (we want this
    to be as fast as possible).
    """
    return val


def assert_type(val, typ, /):
    return val


def assert_never(arg, /):
    value = repr(arg)
    if len(value) > _ASSERT_NEVER_REPR_MAX_LENGTH:
        value = value[:_ASSERT_NEVER_REPR_MAX_LENGTH] + '...'
    raise AssertionError(f"Expected code to be unreachable, but got: {value}")


def reveal_type(obj, /):
    print(f"Runtime type is {type(obj).__name__!r}", file=sys.stderr)
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
            if isinstance(obj, types.FunctionType):
                obj.__no_type_check__ = True
            if isinstance(obj, types.MethodType):
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
            "kwargs": kwargs }
        return cls_or_fn
    return decorator


def is_typeddict(tp):
    return _is_typeddict(tp)


class _LazyAnnotationLib:
    def __getattr__(self, attr):
        global _lazy_annotationlib
        import annotationlib
        _lazy_annotationlib = annotationlib
        return getattr(annotationlib, attr)

_lazy_annotationlib = _LazyAnnotationLib()


_TYPING_INTERNALS = frozenset({
    '__parameters__', '__orig_bases__',  '__orig_class__',
    '_is_protocol', '_is_runtime_protocol', '__protocol_attrs__',
    '__non_callable_proto_members__', '__type_params__',
})

_SPECIAL_NAMES = frozenset({
    '__abstractmethods__', '__annotations__', '__dict__', '__doc__',
    '__init__', '__module__', '__new__', '__slots__',
    '__subclasshook__', '__weakref__', '__class_getitem__',
    '__match_args__', '__static_attributes__', '__firstlineno__',
    '__annotate__', '__annotate_func__', '__annotations_cache__',
})

# These special attributes will be not collected as protocol members.
EXCLUDED_ATTRIBUTES = _TYPING_INTERNALS | _SPECIAL_NAMES | {'_MutableMapping__marker'}


def _get_protocol_attrs(cls):
    """Collect protocol members from a protocol class objects.

    This includes names actually defined in the class dictionary, as well
    as names that appear in annotations. Special names (above) are skipped.
    """
    attrs = set()
    for base in cls.__mro__[:-1]:  # without object
        if base.__name__ in {'Protocol', 'Generic'}:
            continue
        try:
            annotations = base.__annotations__
        except Exception:
            # Only go through annotationlib to handle deferred annotations if we need to
            annotations = _lazy_annotationlib.get_annotations(
                base, format=_lazy_annotationlib.Format.FORWARDREF
            )
        for attr in (*base.__dict__, *annotations):
            if not attr.startswith('_abc_') and attr not in EXCLUDED_ATTRIBUTES:
                attrs.add(attr)
    return attrs


def _no_init_or_replace_init(self, *args, **kwargs):
    cls = type(self)

    if cls._is_protocol:
        raise TypeError('Protocols cannot be instantiated')

    # Already using a custom \x60__init__\x60. No need to calculate correct
    # \x60__init__\x60 to call. This can lead to RecursionError. See bpo-45121.
    if cls.__init__ is not _no_init_or_replace_init:
        return

    # Initially, \x60__init__\x60 of a protocol subclass is set to \x60_no_init_or_replace_init\x60.
    # The first instantiation of the subclass will call \x60_no_init_or_replace_init\x60 which
    # searches for a proper new \x60__init__\x60 in the MRO. The new \x60__init__\x60
    # replaces the subclass' old \x60__init__\x60 (ie \x60_no_init_or_replace_init\x60). Subsequent
    # instantiation of the protocol subclass will thus use the new
    # \x60__init__\x60 and no longer call \x60_no_init_or_replace_init\x60.
    for base in cls.__mro__:
        init = base.__dict__.get('__init__', _no_init_or_replace_init)
        if init is not _no_init_or_replace_init:
            cls.__init__ = init
            break
    else:
        # should not happen
        cls.__init__ = object.__init__

    cls.__init__(self, *args, **kwargs)


def _caller(depth=1, default='__main__'):
    return _frame_module_name(depth + 1) or default

def _allow_reckless_class_checks(depth=2):
    """Allow instance and class checks for special stdlib modules.

    The abc and functools modules indiscriminately call isinstance() and
    issubclass() on the whole MRO of a user class, which may contain protocols.
    """
    return _caller(depth) in {'abc', 'functools', None}


_PROTO_ALLOWLIST = {
    'collections.abc': [
        'Callable', 'Awaitable', 'Iterable', 'Iterator', 'AsyncIterable',
        'AsyncIterator', 'Hashable', 'Sized', 'Container', 'Collection',
        'Reversible', 'Buffer',
    ],
    'contextlib': ['AbstractContextManager', 'AbstractAsyncContextManager'],
    'io': ['Reader', 'Writer'],
    'os': ['PathLike'],
}


@functools.cache
def _lazy_load_getattr_static():
    # Import getattr_static lazily so as not to slow down the import of typing.py
    # Cache the result so we don't slow down _ProtocolMeta.__instancecheck__ unnecessarily
    from inspect import getattr_static
    return getattr_static




# Preload these once, as globals, as a micro-optimisation.
# This makes a significant difference to the time it takes
# to do \x60isinstance()\x60/\x60issubclass()\x60 checks
# against runtime-checkable protocols with only one callable member.
_abc_instancecheck = ABCMeta.__instancecheck__
_abc_subclasscheck = ABCMeta.__subclasscheck__


def _type_check_issubclass_arg_1(arg):
    """Raise TypeError if \x60arg\x60 is not an instance of \x60type\x60
    in \x60issubclass(arg, <protocol>)\x60.

    In most cases, this is verified by type.__subclasscheck__.
    Checking it again unnecessarily would slow down issubclass() checks,
    so, we don't perform this check unless we absolutely have to.

    For various error paths, however,
    we want to ensure that *this* error message is shown to the user
    where relevant, rather than a typing.py-specific error message.
    """
    if not isinstance(arg, type):
        # Same error message as for issubclass(1, int).
        raise TypeError('issubclass() arg 1 must be a class')


class _ProtocolMeta(ABCMeta):
    # This metaclass is somewhat unfortunate,
    # but is necessary for several reasons...
    def __new__(mcls, name, bases, namespace, /, **kwargs):
        if name == "Protocol" and bases == (Generic,):
            pass
        elif Protocol in bases:
            for base in bases:
                if not (
                    base in {object, Generic}
                    or base.__name__ in _PROTO_ALLOWLIST.get(base.__module__, [])
                    or (
                        issubclass(base, Generic)
                        and getattr(base, "_is_protocol", False)
                    )
                ):
                    raise TypeError(
                        f"Protocols can only inherit from other protocols, "
                        f"got {base!r}"
                    )
        return super().__new__(mcls, name, bases, namespace, **kwargs)

    def __init__(cls, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if getattr(cls, "_is_protocol", False):
            cls.__protocol_attrs__ = _get_protocol_attrs(cls)

    def __subclasscheck__(cls, other):
        if cls is Protocol:
            return type.__subclasscheck__(cls, other)
        if (
            getattr(cls, '_is_protocol', False)
            and not _allow_reckless_class_checks()
        ):
            if not getattr(cls, '_is_runtime_protocol', False):
                _type_check_issubclass_arg_1(other)
                raise TypeError(
                    "Instance and class checks can only be used with "
                    "@runtime_checkable protocols"
                )
            if (
                # this attribute is set by @runtime_checkable:
                cls.__non_callable_proto_members__
                and cls.__dict__.get("__subclasshook__") is _proto_hook
            ):
                _type_check_issubclass_arg_1(other)
                non_method_attrs = sorted(cls.__non_callable_proto_members__)
                raise TypeError(
                    "Protocols with non-method members don't support issubclass()."
                    f" Non-method members: {str(non_method_attrs)[1:-1]}."
                )
        return _abc_subclasscheck(cls, other)

    def __instancecheck__(cls, instance):
        # We need this method for situations where attributes are
        # assigned in __init__.
        if cls is Protocol:
            return type.__instancecheck__(cls, instance)
        if not getattr(cls, "_is_protocol", False):
            # i.e., it's a concrete subclass of a protocol
            return _abc_instancecheck(cls, instance)

        if (
            not getattr(cls, '_is_runtime_protocol', False) and
            not _allow_reckless_class_checks()
        ):
            raise TypeError("Instance and class checks can only be used with"
                            " @runtime_checkable protocols")

        if _abc_instancecheck(cls, instance):
            return True

        getattr_static = _lazy_load_getattr_static()
        for attr in cls.__protocol_attrs__:
            try:
                val = getattr_static(instance, attr)
            except AttributeError:
                break
            # this attribute is set by @runtime_checkable:
            if val is None and attr not in cls.__non_callable_proto_members__:
                break
        else:
            return True

        return False


@classmethod
def _proto_hook(cls, other):
    if not cls.__dict__.get('_is_protocol', False):
        return NotImplemented

    for attr in cls.__protocol_attrs__:
        for base in other.__mro__:
            # Check if the members appears in the class dictionary...
            if attr in base.__dict__:
                if base.__dict__[attr] is None:
                    return NotImplemented
                break

            # ...or in annotations, if it is a sub-protocol.
            if issubclass(other, Generic) and getattr(other, "_is_protocol", False):
                # We avoid the slower path through annotationlib here because in most
                # cases it should be unnecessary.
                try:
                    annos = base.__annotations__
                except Exception:
                    annos = _lazy_annotationlib.get_annotations(
                        base, format=_lazy_annotationlib.Format.FORWARDREF
                    )
                if attr in annos:
                    break
        else:
            return NotImplemented
    return True


class Protocol(Generic, metaclass=_ProtocolMeta):
    """Base class for protocol classes.

    Protocol classes are defined as::

        class Proto(Protocol):
            def meth(self) -> int:
                ...

    Such classes are primarily used with static type checkers that recognize
    structural subtyping (static duck-typing).

    For example::

        class C:
            def meth(self) -> int:
                return 0

        def func(x: Proto) -> int:
            return x.meth()

        func(C())  # Passes static type check

    See PEP 544 for details. Protocol classes decorated with
    @typing.runtime_checkable act as simple-minded runtime protocols that check
    only the presence of given attributes, ignoring their type signatures.
    Protocol classes can be generic, they are defined as::

        class GenProto[T](Protocol):
            def meth(self) -> T:
                ...
    """

    __slots__ = ()
    _is_protocol = True
    _is_runtime_protocol = False

    def __init_subclass__(cls, *args, **kwargs):
        super().__init_subclass__(*args, **kwargs)

        # Determine if this is a protocol or a concrete subclass.
        if not cls.__dict__.get('_is_protocol', False):
            cls._is_protocol = any(b is Protocol for b in cls.__bases__)

        # Set (or override) the protocol subclass hook.
        if '__subclasshook__' not in cls.__dict__:
            cls.__subclasshook__ = _proto_hook

        # Prohibit instantiation for protocol classes
        if cls._is_protocol and cls.__init__ is Protocol.__init__:
            cls.__init__ = _no_init_or_replace_init


_declare_parameters(Protocol)


def runtime_checkable(cls):
    """Mark a protocol class as a runtime protocol.

    Such protocol can be used with isinstance() and issubclass().
    Raise TypeError if applied to a non-protocol class.
    This allows a simple-minded structural check very similar to
    one-trick ponies in collections.abc such as Iterable.

    For example::

        @runtime_checkable
        class Closable(Protocol):
            def close(self): ...

        assert isinstance(open('/some/file'), Closable)

    Warning: this will check only the presence of the required methods,
    not their type signatures!
    """
    if not issubclass(cls, Generic) or not getattr(cls, '_is_protocol', False):
        raise TypeError('@runtime_checkable can be only applied to protocol classes,'
                        ' got %r' % cls)
    cls._is_runtime_protocol = True
    # PEP 544 prohibits using issubclass()
    # with protocols that have non-method members.
    # See gh-113320 for why we compute this attribute here,
    # rather than in \x60_ProtocolMeta.__init__\x60
    cls.__non_callable_proto_members__ = set()
    for attr in cls.__protocol_attrs__:
        try:
            is_callable = callable(getattr(cls, attr, None))
        except Exception as e:
            raise TypeError(
                f"Failed to determine whether protocol member {attr!r} "
                "is a method member"
            ) from e
        else:
            if not is_callable:
                cls.__non_callable_proto_members__.add(attr)
    return cls


def is_protocol(tp: type, /) -> bool:
    """Return True if the given type is a Protocol.

    Example::

        >>> from typing import Protocol, is_protocol
        >>> class P(Protocol):
        ...     def a(self) -> str: ...
        ...     b: int
        >>> is_protocol(P)
        True
        >>> is_protocol(int)
        False
    """
    return (
        isinstance(tp, type)
        and getattr(tp, '_is_protocol', False)
        and tp != Protocol
    )


def get_protocol_members(tp: type, /) -> frozenset[str]:
    """Return the set of members defined in a Protocol.

    Example::

        >>> from typing import Protocol, get_protocol_members
        >>> class P(Protocol):
        ...     def a(self) -> str: ...
        ...     b: int
        >>> get_protocol_members(P) == frozenset({'a', 'b'})
        True

    Raise a TypeError for arguments that are not Protocols.
    """
    if not is_protocol(tp):
        raise TypeError(f'{tp!r} is not a Protocol')
    return frozenset(tp.__protocol_attrs__)


@runtime_checkable
class SupportsInt(Protocol):
    """An ABC with one abstract method __int__."""

    __slots__ = ()

    @abstractmethod
    def __int__(self) -> int:
        pass


@runtime_checkable
class SupportsFloat(Protocol):
    """An ABC with one abstract method __float__."""

    __slots__ = ()

    @abstractmethod
    def __float__(self) -> float:
        pass


@runtime_checkable
class SupportsComplex(Protocol):
    """An ABC with one abstract method __complex__."""

    __slots__ = ()

    @abstractmethod
    def __complex__(self) -> complex:
        pass


@runtime_checkable
class SupportsBytes(Protocol):
    """An ABC with one abstract method __bytes__."""

    __slots__ = ()

    @abstractmethod
    def __bytes__(self) -> bytes:
        pass


@runtime_checkable
class SupportsIndex(Protocol):
    """An ABC with one abstract method __index__."""

    __slots__ = ()

    @abstractmethod
    def __index__(self) -> int:
        pass


@runtime_checkable
class SupportsAbs[T](Protocol):
    """An ABC with one abstract method __abs__ that is covariant in its return type."""

    __slots__ = ()

    @abstractmethod
    def __abs__(self) -> T:
        pass


@runtime_checkable
class SupportsRound[T](Protocol):
    """An ABC with one abstract method __round__ that is covariant in its return type."""

    __slots__ = ()

    @abstractmethod
    def __round__(self, ndigits: int = 0) -> T:
        pass


class IO(Generic[AnyStr]):
    """Generic base class for TextIO and BinaryIO.

    This is an abstract, generic version of the return of open().

    NOTE: This does not distinguish between the different possible
    classes (text vs. binary, read vs. write vs. read/write,
    append-only, unbuffered).  The TextIO and BinaryIO subclasses
    below capture the distinctions between text vs. binary, which is
    pervasive in the interface. For more precise types, define a custom
    Protocol.
    """

    __slots__ = ()

    @property
    @abstractmethod
    def mode(self) -> str:
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @abstractmethod
    def close(self) -> None:
        pass

    @property
    @abstractmethod
    def closed(self) -> bool:
        pass

    @abstractmethod
    def fileno(self) -> int:
        pass

    @abstractmethod
    def flush(self) -> None:
        pass

    @abstractmethod
    def isatty(self) -> bool:
        pass

    @abstractmethod
    def read(self, n: int = -1) -> AnyStr:
        pass

    @abstractmethod
    def readable(self) -> bool:
        pass

    @abstractmethod
    def readline(self, limit: int = -1) -> AnyStr:
        pass

    @abstractmethod
    def readlines(self, hint: int = -1) -> list[AnyStr]:
        pass

    @abstractmethod
    def seek(self, offset: int, whence: int = 0) -> int:
        pass

    @abstractmethod
    def seekable(self) -> bool:
        pass

    @abstractmethod
    def tell(self) -> int:
        pass

    @abstractmethod
    def truncate(self, size: int | None = None) -> int:
        pass

    @abstractmethod
    def writable(self) -> bool:
        pass

    @abstractmethod
    def write(self, s: AnyStr) -> int:
        pass

    @abstractmethod
    def writelines(self, lines: list[AnyStr]) -> None:
        pass

    @abstractmethod
    def __enter__(self) -> IO[AnyStr]:
        pass

    @abstractmethod
    def __exit__(self, type, value, traceback) -> None:
        pass


class BinaryIO(IO[bytes]):
    """Typed approximation of the return of open() in binary mode."""

    __slots__ = ()

    @abstractmethod
    def write(self, s: bytes | bytearray) -> int:
        pass

    @abstractmethod
    def __enter__(self) -> BinaryIO:
        pass


class TextIO(IO[str]):
    """Typed approximation of the return of open() in text mode."""

    __slots__ = ()

    @property
    @abstractmethod
    def buffer(self) -> BinaryIO:
        pass

    @property
    @abstractmethod
    def encoding(self) -> str:
        pass

    @property
    @abstractmethod
    def errors(self) -> str | None:
        pass

    @property
    @abstractmethod
    def line_buffering(self) -> bool:
        pass

    @property
    @abstractmethod
    def newlines(self) -> Any:
        pass

    @abstractmethod
    def __enter__(self) -> TextIO:
        pass


import operator

# The class of a user generic class's aliases, such as Box[int], which is _GenericAlias in CPython.
_UserGenericAlias = type(Generic[T])


def evaluate_forward_ref(
    forward_ref,
    *,
    owner=None,
    globals=None,
    locals=None,
    type_params=None,
    format=None,
    _recursive_guard=frozenset(),
):
    """Evaluate a forward reference as a type hint.

    This is similar to calling the ForwardRef.evaluate() method,
    but unlike that method, evaluate_forward_ref() also
    recursively evaluates forward references nested within the type hint.

    *forward_ref* must be an instance of ForwardRef. *owner*, if given,
    should be the object that holds the annotations that the forward reference
    derived from, such as a module, class object, or function. It is used to
    infer the namespaces to use for looking up names. *globals* and *locals*
    can also be explicitly given to provide the global and local namespaces.
    *type_params* is a tuple of type parameters that are in scope when
    evaluating the forward reference. This parameter should be provided (though
    it may be an empty tuple) if *owner* is not given and the forward reference
    does not already have an owner set. *format* specifies the format of the
    annotation and is a member of the annotationlib.Format enum, defaulting to
    VALUE.

    """
    import annotationlib
    if format == annotationlib.Format.STRING:
        return forward_ref.__resolved_str__
    if forward_ref.__forward_arg__ in _recursive_guard:
        return forward_ref

    if format is None:
        format = annotationlib.Format.VALUE
    value = forward_ref.evaluate(globals=globals, locals=locals,
                                 type_params=type_params, owner=owner, format=format)

    if (isinstance(value, annotationlib.ForwardRef)
            and format == annotationlib.Format.FORWARDREF):
        return value

    if isinstance(value, str):
        value = _make_forward_ref(value, module=forward_ref.__forward_module__,
                                  owner=owner or forward_ref.__owner__,
                                  is_argument=forward_ref.__forward_is_argument__,
                                  is_class=forward_ref.__forward_is_class__)
    if owner is None:
        owner = forward_ref.__owner__
    return _eval_type(
        value,
        globals,
        locals,
        type_params,
        recursive_guard=_recursive_guard | {forward_ref.__forward_arg__},
        format=format,
        owner=owner,
        parent_fwdref=forward_ref,
    )


def _make_forward_ref(code, *, parent_fwdref=None, **kwargs):
    import annotationlib
    if parent_fwdref is not None:
        if parent_fwdref.__forward_module__ is not None:
            kwargs['module'] = parent_fwdref.__forward_module__
        if parent_fwdref.__owner__ is not None:
            kwargs['owner'] = parent_fwdref.__owner__
    return annotationlib.ForwardRef(code, **kwargs)


def _is_param_expr(arg):
    return arg is ... or isinstance(arg, (tuple, list, ParamSpec)) or (
        isinstance(arg, _GenericAlias) and arg.__origin__ is Concatenate)


def _should_unflatten_callable_args(typ, args):
    return (
        typ.__origin__ is collections.abc.Callable
        and not (len(args) == 2 and _is_param_expr(args[0]))
    )


def _eval_type(t, globalns, localns, type_params, *, recursive_guard=frozenset(),
               format=None, owner=None, parent_fwdref=None):
    """Evaluate all forward references in the given type t."""
    import annotationlib
    if isinstance(t, annotationlib.ForwardRef):
        return evaluate_forward_ref(t, globals=globalns, locals=localns,
                                    type_params=type_params, owner=owner,
                                    _recursive_guard=recursive_guard, format=format)
    if isinstance(t, (_GenericAlias, _UserGenericAlias, types.GenericAlias, types.UnionType)):
        if isinstance(t, types.GenericAlias):
            args = tuple(
                _make_forward_ref(arg, parent_fwdref=parent_fwdref) if isinstance(arg, str) else arg
                for arg in t.__args__
            )
            is_unpacked = t.__unpacked__
            if _should_unflatten_callable_args(t, args):
                t = t.__origin__[(args[:-1], args[-1])]
            else:
                t = t.__origin__[args]
            if is_unpacked:
                t = Unpack[t]

        ev_args = tuple(
            _eval_type(
                a, globalns, localns, type_params, recursive_guard=recursive_guard,
                format=format, owner=owner,
            )
            for a in t.__args__
        )
        if ev_args == t.__args__:
            return t
        if isinstance(t, types.GenericAlias):
            return types.GenericAlias(t.__origin__, ev_args)
        if isinstance(t, types.UnionType):
            return functools.reduce(operator.or_, ev_args)
        else:
            return t.copy_with(ev_args)
    return t


def _strip_annotations(t):
    """Strip the annotations from a given type."""
    if isinstance(t, _AnnotatedAlias):
        return _strip_annotations(t.__origin__)
    if hasattr(t, "__origin__") and t.__origin__ in (Required, NotRequired, ReadOnly):
        return _strip_annotations(t.__args__[0])
    if isinstance(t, (_GenericAlias, _UserGenericAlias)):
        stripped_args = tuple(_strip_annotations(a) for a in t.__args__)
        if stripped_args == t.__args__:
            return t
        return t.copy_with(stripped_args)
    if isinstance(t, GenericAlias):
        stripped_args = tuple(_strip_annotations(a) for a in t.__args__)
        if stripped_args == t.__args__:
            return t
        return GenericAlias(t.__origin__, stripped_args)
    if isinstance(t, Union):
        stripped_args = tuple(_strip_annotations(a) for a in t.__args__)
        if stripped_args == t.__args__:
            return t
        return functools.reduce(operator.or_, stripped_args)

    return t
`;

// Subscripted aliases of typing stand for their origin in the bases of a class statement.
mroEntryHooks.push(typingBaseEntries);

registerModule('typing', (runtime, namespace) => {
  const abc = importModule(runtime, 'collections.abc');
  const collections = importModule(runtime, 'collections');
  const re = importModule(runtime, 're');
  for (const [key, value] of [...specialForms(), ...aliases(abc, collections, re), ...natives()]) {
    namespace.set(key, value);
  }
  runModuleSource(runtime, namespace, SOURCE);
  return new Map();
});

function specialForms(): [string, PyValue][] {
  const single = singleTypeForm(false);
  return [
    ['Any', anyType],
    ['ClassVar', newSpecialForm('ClassVar', singleTypeForm(true))],
    ['Final', newSpecialForm('Final', singleTypeForm(true))],
    ['Optional', newSpecialForm('Optional', optionalGetItem)],
    ['Union', unionClass],
    ['Literal', newSpecialForm('Literal', literalGetItem, true)],
    ['Annotated', newSpecialForm('Annotated', annotatedGetItem, true)],
    ['Concatenate', newSpecialForm('Concatenate', concatenateGetItem)],
    ...['TypeGuard', 'TypeIs', 'Required', 'NotRequired', 'ReadOnly', 'Unpack'].map((name): [string, PyValue] => [
      name,
      newSpecialForm(name, single),
    ]),
    ...['Never', 'NoReturn', 'Self', 'LiteralString', 'TypeAlias'].map((name): [string, PyValue] => [
      name,
      newSpecialForm(name),
    ]),
  ];
}

function aliases(abc: PyModule, collections: PyModule, re: PyModule): [string, PyValue][] {
  const abcClass = (name: string): PyValue => abc.dict.get(name) as PyValue;
  const abcAliases: [string, string, number][] = [
    ['Hashable', 'Hashable', 0],
    ['Iterable', 'Iterable', 1],
    ['Iterator', 'Iterator', 1],
    ['Reversible', 'Reversible', 1],
    ['Sized', 'Sized', 0],
    ['Container', 'Container', 1],
    ['Collection', 'Collection', 1],
    ['AbstractSet', 'Set', 1],
    ['MutableSet', 'MutableSet', 1],
    ['Mapping', 'Mapping', 2],
    ['MutableMapping', 'MutableMapping', 2],
    ['Sequence', 'Sequence', 1],
    ['MutableSequence', 'MutableSequence', 1],
    ['MappingView', 'MappingView', 1],
    ['KeysView', 'KeysView', 1],
    ['ItemsView', 'ItemsView', 2],
    ['ValuesView', 'ValuesView', 1],
  ];
  return [
    ['List', newSpecialAlias(listClass, 1, { name: 'List', inst: false })],
    ['Dict', newSpecialAlias(dictClass, 2, { name: 'Dict', inst: false })],
    ['Set', newSpecialAlias(setClass, 1, { name: 'Set', inst: false })],
    ['FrozenSet', newSpecialAlias(frozensetClass, 1, { name: 'FrozenSet', inst: false })],
    ['Tuple', newSpecialAlias(tupleClass, -1, { name: 'Tuple', inst: false })],
    ['Type', newSpecialAlias(typeClass, 1, { name: 'Type', inst: false })],
    ['Callable', newSpecialAlias(abcClass('Callable'), -1, { name: 'Callable' })],
    ['Deque', newSpecialAlias(dequeClass, 1, { name: 'Deque' })],
    ['DefaultDict', newSpecialAlias(defaultdictClass, 2, { name: 'DefaultDict' })],
    ['OrderedDict', newSpecialAlias(orderedDictClass, 2, { name: 'OrderedDict' })],
    ['Counter', newSpecialAlias(counterClass, 1, { name: 'Counter' })],
    ['ChainMap', newSpecialAlias(collections.dict.get('ChainMap') as PyValue, 2, { name: 'ChainMap' })],
    ['Generator', newSpecialAlias(abcClass('Generator'), 3, { defaults: [noneClass, noneClass] })],
    ['Awaitable', newSpecialAlias(abcClass('Awaitable'), 1, { name: 'Awaitable' })],
    ['Coroutine', newSpecialAlias(abcClass('Coroutine'), 3, { name: 'Coroutine' })],
    ['AsyncIterable', newSpecialAlias(abcClass('AsyncIterable'), 1, { name: 'AsyncIterable' })],
    ['AsyncIterator', newSpecialAlias(abcClass('AsyncIterator'), 1, { name: 'AsyncIterator' })],
    ['AsyncGenerator', newSpecialAlias(abcClass('AsyncGenerator'), 2, { defaults: [noneClass] })],
    ['ByteString', newSpecialAlias(abcClass('ByteString'), 0, { name: 'ByteString' })],
    ['Pattern', newSpecialAlias(re.dict.get('Pattern') as PyValue, 1, { name: 'Pattern' })],
    ['Match', newSpecialAlias(re.dict.get('Match') as PyValue, 1, { name: 'Match' })],
    ['ParamSpecArgs', paramSpecArgsClass],
    ['ParamSpecKwargs', paramSpecKwargsClass],
    ...abcAliases.map(([name, origin, nparams]): [string, PyValue] => [
      name,
      newSpecialAlias(abcClass(origin), nparams, { name }),
    ]),
    ['Text', strClass],
    ['GenericAlias', genericAliasClass],
    ['_GenericAlias', typingAliasClass],
    ['_AnnotatedAlias', annotatedAliasClass],
    ['defaultdict', defaultdictClass],
  ];
}

/**
 * The module of the frame `depth` frames above the function calling it, as `sys._getframemodulename` names it for
 * typing's `_caller`, counting the frames of the standard library's code, and naming abc for the checks `_abc` makes,
 * which CPython's ABCMeta makes from its frame in abc.
 */
function frameModuleName(depth: PyValue): PyValue {
  if (typeof depth !== 'bigint') throw typeError('depth must be an integer');
  const { frames } = currentRuntime();
  const index = frames.length - 1 - Number(depth);
  if (nativeCheckCaller(index)) return 'abc';
  const name = index < 0 ? undefined : frames[index]?.globals.get('__name__');
  return typeof name === 'string' ? name : None;
}

function natives(): [string, PyValue][] {
  return [
    ['TYPE_CHECKING', false],
    ['TypeVar', typeVarClass],
    ['ParamSpec', paramSpecClass],
    ['TypeVarTuple', typeVarTupleClass],
    ['TypeAliasType', typeAliasClass],
    ['Generic', genericClass],
    ['NoDefault', NoDefault],
    ['NewType', newTypeClass],
    ...TYPING_CLASSES,
    ['get_origin', pythonFunction('get_origin', 'tp', ([tp]) => typingOrigin(tp))],
    ['get_args', pythonFunction('get_args', 'tp', ([tp]) => typingArgs(tp))],
    [
      'get_type_hints',
      pythonFunction(
        'get_type_hints',
        'obj, globalns=None, localns=None, include_extras=False, *, format=None',
        getTypeHints
      ),
    ],
    [
      '_firstlineno',
      builtin('_firstlineno', 'one', 1, 1, ([fn]) => {
        if (fn instanceof PyFunction) return BigInt(fn.def.row + 1);
        return getAttribute(getAttribute(fn, '__code__'), 'co_firstlineno');
      }),
    ],
    ['_is_typeddict', builtin('_is_typeddict', 'one', 1, 1, ([tp]) => isTypedDict(tp))],
    ['_frame_module_name', builtin('_frame_module_name', 'one', 1, 1, ([depth]) => frameModuleName(depth))],
    [
      '_declare_parameters',
      builtin('_declare_parameters', 'one', 1, 1, ([cls]) => {
        parameterDeclaringClasses.add(cls as PyClass);
        return None;
      }),
    ],
  ];
}
