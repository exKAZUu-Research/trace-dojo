import { makeIterableCoroutine, markIterableCoroutine } from '../coroutines';
import { builtin } from '../define';
import { registerUnsupportedAttributes } from '../modules';
import { registerSourceModule } from '../sourceModules';
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
WrapperDescriptorType = type(object.__init__)
MethodWrapperType = type(object().__str__)
ModuleType = type(sys)
GeneratorType = _builtin_types['generator']
CoroutineType = _builtin_types['coroutine']
AsyncGeneratorType = _builtin_types['async_generator']
CellType = _builtin_types['cell']
EllipsisType = type(Ellipsis)
NoneType = type(None)
GenericAlias = type(list[int])
NotImplementedType = type(NotImplemented)


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
ClassMethodDescriptorType = type(dict.__dict__['fromkeys'])


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


def resolve_bases(bases):
    """Resolve MRO entries dynamically as specified by PEP 560."""
    return tuple(bases)


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
  CodeType: 'コードオブジェクト（types.CodeType）',
  FrameType: 'フレームオブジェクト（types.FrameType）',
  TracebackType: 'トレースバックオブジェクト（types.TracebackType）',
  new_class: 'クラスを動的に作る types.new_class()',
  prepare_class: 'メタクラスを使う types.prepare_class()',
  get_original_bases: 'types.get_original_bases()',
  DynamicClassAttribute: 'types.DynamicClassAttribute',
  UnionType: 'types.UnionType',
  GetSetDescriptorType: 'types.GetSetDescriptorType',
  MemberDescriptorType: 'types.MemberDescriptorType',
  CapsuleType: 'types.CapsuleType',
});
