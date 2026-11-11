import { builtin } from '../define';
import { importModule, registerModule, registerUnsupportedAttributes } from '../modules';
import { runModuleSource } from '../sourceModules';
import {
  annotatedGetItem,
  anyType,
  concatenateGetItem,
  forwardRefClass,
  genericAliasClass,
  literalGetItem,
  newSpecialAlias,
  newSpecialForm,
  optionalGetItem,
  singleTypeForm,
  typingArgs,
  typingOrigin,
  unionClass,
} from '../typeHints';
import {
  genericClass,
  NoDefault,
  paramSpecClass,
  typeAliasClass,
  typeVarClass,
  typeVarTupleClass,
} from '../typeParams';
import {
  dictClass,
  frozensetClass,
  listClass,
  newSet,
  noneClass,
  setClass,
  strClass,
  tupleClass,
  typeClass,
  typeError,
} from '../types';
import { type PyClass, PyFunction, type PyModule, type PyValue } from '../values';
import { counterClass, defaultdictClass, dequeClass, orderedDictClass } from './collections';
import { isProtocol, isTypedDict, protocolMemberNames, TYPING_CLASSES } from './typingClasses';
import { getTypeHints, newTypeClass } from './typingTypeVars';

/** The names of typing that need features this grader does not support. */
registerUnsupportedAttributes('typing', {
  ParamSpecArgs: 'typing.ParamSpecArgs',
  ParamSpecKwargs: 'typing.ParamSpecKwargs',
  NamedTupleMeta: 'typing.NamedTupleMeta（メタクラス）',
  IO: 'typing.IO（ファイルの読み書き）',
  TextIO: 'typing.TextIO（ファイルの読み書き）',
  BinaryIO: 'typing.BinaryIO（ファイルの読み書き）',
  ByteString: 'typing.ByteString（bytes 型）',
  Pattern: 'typing.Pattern（re モジュール）',
  Match: 'typing.Match（re モジュール）',
  evaluate_forward_ref: 'typing.evaluate_forward_ref（文字列の型ヒントの評価）',
  ContextManager: 'typing.ContextManager（contextlib モジュール）',
  AsyncContextManager: 'typing.AsyncContextManager（contextlib モジュール）',
  Awaitable: '非同期処理（typing.Awaitable）',
  Coroutine: '非同期処理（typing.Coroutine）',
  AsyncIterable: '非同期処理（typing.AsyncIterable）',
  AsyncIterator: '非同期処理（typing.AsyncIterator）',
  AsyncGenerator: '非同期処理（typing.AsyncGenerator）',
  copyreg: 'モジュール copyreg',
  operator: 'モジュール operator',
});

/** `typing.EXCLUDED_ATTRIBUTES`, the attributes a protocol's members leave out. */
const EXCLUDED_ATTRIBUTES = [
  '__parameters__',
  '__orig_bases__',
  '__orig_class__',
  '_is_protocol',
  '_is_runtime_protocol',
  '__protocol_attrs__',
  '__non_callable_proto_members__',
  '__type_params__',
  '__abstractmethods__',
  '__annotations__',
  '__dict__',
  '__doc__',
  '__init__',
  '__module__',
  '__new__',
  '__slots__',
  '__subclasshook__',
  '__weakref__',
  '__class_getitem__',
  '__match_args__',
  '__static_attributes__',
  '__firstlineno__',
  '__annotate__',
  '__annotate_func__',
  '__annotations_cache__',
  '_MutableMapping__marker',
];

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
            "kwargs": kwargs,
        }
        return cls_or_fn
    return decorator


def is_typeddict(tp):
    return _is_typeddict(tp)


def is_protocol(tp, /):
    return _is_protocol(tp)


def get_protocol_members(tp, /):
    if not is_protocol(tp):
        raise TypeError(f'{tp!r} is not a Protocol')
    return frozenset(_protocol_members(tp))


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
`;

registerModule('typing', (runtime, namespace) => {
  const abc = importModule(runtime, 'collections.abc');
  const collections = importModule(runtime, 'collections');
  for (const [key, value] of [...specialForms(), ...aliases(abc, collections), ...natives()]) {
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

function aliases(abc: PyModule, collections: PyModule): [string, PyValue][] {
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
    ...abcAliases.map(([name, origin, nparams]): [string, PyValue] => [
      name,
      newSpecialAlias(abcClass(origin), nparams, { name }),
    ]),
    ['Text', strClass],
    ['GenericAlias', genericAliasClass],
    ['ForwardRef', forwardRefClass],
    ['defaultdict', defaultdictClass],
  ];
}

function natives(): [string, PyValue][] {
  return [
    ['TYPE_CHECKING', false],
    ['EXCLUDED_ATTRIBUTES', newSet(EXCLUDED_ATTRIBUTES, true)],
    ['TypeVar', typeVarClass],
    ['ParamSpec', paramSpecClass],
    ['TypeVarTuple', typeVarTupleClass],
    ['TypeAliasType', typeAliasClass],
    ['Generic', genericClass],
    ['NoDefault', NoDefault],
    ['NewType', newTypeClass],
    ...TYPING_CLASSES,
    ['get_origin', builtin('get_origin', 'one', 1, 1, ([tp]) => typingOrigin(tp))],
    ['get_args', builtin('get_args', 'one', 1, 1, ([tp]) => typingArgs(tp))],
    [
      'get_type_hints',
      builtin('get_type_hints', 'takes', 1, 3, getTypeHints, {
        keywords: ['obj', 'globalns', 'localns', 'include_extras', 'format'],
      }),
    ],
    [
      '_firstlineno',
      builtin('_firstlineno', 'one', 1, 1, ([fn]) => {
        if (!(fn instanceof PyFunction)) throw typeError('not a function');
        return BigInt(fn.def.row + 1);
      }),
    ],
    ['_is_typeddict', builtin('_is_typeddict', 'one', 1, 1, ([tp]) => isTypedDict(tp))],
    ['_is_protocol', builtin('_is_protocol', 'one', 1, 1, ([tp]) => isProtocol(tp))],
    [
      '_protocol_members',
      builtin('_protocol_members', 'one', 1, 1, ([tp]) => newSet(protocolMemberNames(tp as PyClass), true)),
    ],
  ];
}
