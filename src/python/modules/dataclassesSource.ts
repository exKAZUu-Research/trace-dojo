/**
 * CPython 3.14's Lib/dataclasses.py, rewritten in the Python this interpreter runs: conditional expressions become
 * statements, `exec` is the native `_exec_source`, and the modules it imports are native helpers.
 */
export const DATACLASSES_SOURCE = String.raw`
import copy
import itertools
import sys

__all__ = ['dataclass', 'field', 'Field', 'FrozenInstanceError', 'InitVar', 'KW_ONLY', 'MISSING', 'fields', 'asdict',
           'astuple', 'make_dataclass', 'replace', 'is_dataclass']


class FrozenInstanceError(AttributeError): pass


class _HAS_DEFAULT_FACTORY_CLASS:
    def __repr__(self):
        return '<factory>'
_HAS_DEFAULT_FACTORY = _HAS_DEFAULT_FACTORY_CLASS()


class _MISSING_TYPE:
    pass
MISSING = _MISSING_TYPE()


class _KW_ONLY_TYPE:
    pass
KW_ONLY = _KW_ONLY_TYPE()

_EMPTY_METADATA = _MappingProxyType({})


class _FIELD_BASE:
    def __init__(self, name):
        self.name = name
    def __repr__(self):
        return self.name
_FIELD = _FIELD_BASE('_FIELD')
_FIELD_CLASSVAR = _FIELD_BASE('_FIELD_CLASSVAR')
_FIELD_INITVAR = _FIELD_BASE('_FIELD_INITVAR')

_FIELDS = '__dataclass_fields__'
_PARAMS = '__dataclass_params__'
_POST_INIT_NAME = '__post_init__'

_ATOMIC_TYPES = frozenset({
    type(None),
    bool,
    int,
    float,
    str,
    complex,
    type(...),
    type(NotImplemented),
    type(len),
    type(lambda: None),
    type,
    range,
    property,
})

_ANY_MARKER = object()


def _module_identifier(annotation):
    # Matches r'^(?:\s*(\w+)\s*\.)?\s*(\w+)', returning its two groups or None.
    def word(start):
        end = start
        while end < len(annotation) and (annotation[end].isalnum() or annotation[end] == '_'):
            end += 1
        return end
    def spaces(start):
        while start < len(annotation) and annotation[start].isspace():
            start += 1
        return start
    first_start = spaces(0)
    first_end = word(first_start)
    if first_end > first_start:
        dot = spaces(first_end)
        if dot < len(annotation) and annotation[dot] == '.':
            second_start = spaces(dot + 1)
            second_end = word(second_start)
            if second_end > second_start:
                return annotation[first_start:first_end], annotation[second_start:second_end]
        return None, annotation[first_start:first_end]
    return None


def recursive_repr(fillvalue='...'):
    def decorating_function(user_function):
        repr_running = set()

        def wrapper(self):
            key = id(self)
            if key in repr_running:
                return fillvalue
            repr_running.add(key)
            try:
                result = user_function(self)
            finally:
                repr_running.discard(key)
            return result

        wrapper.__module__ = getattr(user_function, '__module__')
        wrapper.__doc__ = getattr(user_function, '__doc__')
        wrapper.__name__ = getattr(user_function, '__name__')
        wrapper.__qualname__ = getattr(user_function, '__qualname__')
        wrapper.__wrapped__ = user_function
        return wrapper

    return decorating_function


class InitVar:
    def __init__(self, type):
        self.type = type

    def __repr__(self):
        if isinstance(self.type, type):
            type_name = self.type.__name__
        else:
            type_name = repr(self.type)
        return f'dataclasses.InitVar[{type_name}]'

    def __class_getitem__(cls, type):
        return InitVar(type)


class Field:
    def __init__(self, default, default_factory, init, repr, hash, compare,
                 metadata, kw_only, doc):
        self.name = None
        self.type = None
        self.default = default
        self.default_factory = default_factory
        self.init = init
        self.repr = repr
        self.hash = hash
        self.compare = compare
        if metadata is None:
            self.metadata = _EMPTY_METADATA
        else:
            self.metadata = _MappingProxyType(metadata)
        self.kw_only = kw_only
        self.doc = doc
        self._field_type = None

    @recursive_repr()
    def __repr__(self):
        return ('Field('
                f'name={self.name!r},'
                f'type={self.type!r},'
                f'default={self.default!r},'
                f'default_factory={self.default_factory!r},'
                f'init={self.init!r},'
                f'repr={self.repr!r},'
                f'hash={self.hash!r},'
                f'compare={self.compare!r},'
                f'metadata={self.metadata!r},'
                f'kw_only={self.kw_only!r},'
                f'doc={self.doc!r},'
                f'_field_type={self._field_type}'
                ')')


class _DataclassParams:
    def __init__(self,
                 init, repr, eq, order, unsafe_hash, frozen,
                 match_args, kw_only, slots, weakref_slot):
        self.init = init
        self.repr = repr
        self.eq = eq
        self.order = order
        self.unsafe_hash = unsafe_hash
        self.frozen = frozen
        self.match_args = match_args
        self.kw_only = kw_only
        self.slots = slots
        self.weakref_slot = weakref_slot

    def __repr__(self):
        return ('_DataclassParams('
                f'init={self.init!r},'
                f'repr={self.repr!r},'
                f'eq={self.eq!r},'
                f'order={self.order!r},'
                f'unsafe_hash={self.unsafe_hash!r},'
                f'frozen={self.frozen!r},'
                f'match_args={self.match_args!r},'
                f'kw_only={self.kw_only!r},'
                f'slots={self.slots!r},'
                f'weakref_slot={self.weakref_slot!r}'
                ')')


def field(*, default=MISSING, default_factory=MISSING, init=True, repr=True,
          hash=None, compare=True, metadata=None, kw_only=MISSING, doc=None):
    if default is not MISSING and default_factory is not MISSING:
        raise ValueError('cannot specify both default and default_factory')
    return Field(default, default_factory, init, repr, hash, compare,
                 metadata, kw_only, doc)


def _fields_in_init_order(fields):
    return (tuple(f for f in fields if f.init and not f.kw_only),
            tuple(f for f in fields if f.init and f.kw_only)
            )


def _tuple_str(obj_name, fields):
    if not fields:
        return '()'
    return '(' + ','.join([f'{obj_name}.{f.name}' for f in fields]) + ',)'


class _FuncBuilder:
    def __init__(self, globals):
        self.names = []
        self.src = []
        self.globals = globals
        self.locals = {}
        self.overwrite_errors = {}
        self.unconditional_adds = {}

    def add_fn(self, name, args, body, *, locals=None, overwrite_error=False, unconditional_add=False,
               decorator=None):
        if locals is not None:
            self.locals.update(locals)
        if overwrite_error:
            self.overwrite_errors[name] = overwrite_error
        if unconditional_add:
            self.unconditional_adds[name] = True
        self.names.append(name)
        args = ','.join(args)
        body = '\n'.join(body)
        decoration = ''
        if decorator:
            decoration = f' {decorator}\n'
        self.src.append(f'{decoration} def {name}({args}):\n{body}')

    def add_fns_to_class(self, cls):
        fns_src = '\n'.join(self.src)
        local_vars = ','.join(self.locals.keys())
        if len(self.names) == 0:
            return_names = '()'
        else:
            return_names = '(' + ','.join(self.names) + ',)'
        txt = f"def __create_fn__({local_vars}):\n{fns_src}\n return {return_names}"
        ns = _exec_source(txt, cls.__module__)
        fns = ns['__create_fn__'](**self.locals)

        for name, fn in zip(self.names, fns):
            fn.__qualname__ = f"{cls.__qualname__}.{fn.__name__}"
            if self.unconditional_adds.get(name, False):
                setattr(cls, name, fn)
            else:
                already_exists = _set_new_attribute(cls, name, fn)
                msg_extra = self.overwrite_errors.get(name)
                if already_exists and msg_extra:
                    error_msg = (f'Cannot overwrite attribute {fn.__name__} '
                                 f'in class {cls.__name__}')
                    if not msg_extra is True:
                        error_msg = f'{error_msg} {msg_extra}'
                    raise TypeError(error_msg)


def _field_assign(frozen, name, value, self_name):
    if frozen:
        return f'  __dataclass_builtins_object__.__setattr__({self_name},{name!r},{value})'
    return f'  {self_name}.{name}={value}'


def _field_init(f, frozen, globals, self_name, slots):
    # Returns the lines of __init__ that initialize this field. A default factory is applied by an if statement, since
    # this interpreter does not run conditional expressions.
    default_name = f'__dataclass_dflt_{f.name}__'
    lines = []
    if f.default_factory is not MISSING:
        if f.init:
            globals[default_name] = f.default_factory
            lines.append(f'  if {f.name} is __dataclass_HAS_DEFAULT_FACTORY__:')
            lines.append(f'   {f.name} = {default_name}()')
            value = f.name
        else:
            globals[default_name] = f.default_factory
            value = f'{default_name}()'
    else:
        if f.init:
            if f.default is MISSING:
                value = f.name
            elif f.default is not MISSING:
                globals[default_name] = f.default
                value = f.name
        else:
            return []

    if f._field_type is _FIELD_INITVAR:
        return []

    lines.append(_field_assign(frozen, f.name, value, self_name))
    return lines


def _init_param(f):
    if f.default is MISSING and f.default_factory is MISSING:
        default = ''
    elif f.default is not MISSING:
        default = f'=__dataclass_dflt_{f.name}__'
    elif f.default_factory is not MISSING:
        default = '=__dataclass_HAS_DEFAULT_FACTORY__'
    return f'{f.name}{default}'


def _init_fn(fields, std_fields, kw_only_fields, frozen, has_post_init,
             self_name, func_builder, slots):
    seen_default = None
    for f in std_fields:
        if f.init:
            if not (f.default is MISSING and f.default_factory is MISSING):
                seen_default = f
            elif seen_default:
                raise TypeError(f'non-default argument {f.name!r} '
                                f'follows default argument {seen_default.name!r}')

    locals = {'__dataclass_HAS_DEFAULT_FACTORY__': _HAS_DEFAULT_FACTORY,
              '__dataclass_builtins_object__': object}

    body_lines = []
    for f in fields:
        body_lines.extend(_field_init(f, frozen, locals, self_name, slots))

    if has_post_init:
        params_str = ','.join(f.name for f in fields
                              if f._field_type is _FIELD_INITVAR)
        body_lines.append(f'  {self_name}.{_POST_INIT_NAME}({params_str})')

    if not body_lines:
        body_lines = ['  pass']

    _init_params = [_init_param(f) for f in std_fields]
    if kw_only_fields:
        _init_params += ['*']
        _init_params += [_init_param(f) for f in kw_only_fields]
    func_builder.add_fn('__init__',
                        [self_name] + _init_params,
                        body_lines,
                        locals=locals)


def _frozen_set_del_attr(cls, fields, func_builder):
    locals = {'__dataclass_class__': cls,
              'FrozenInstanceError': FrozenInstanceError}
    condition = 'type(self) is __dataclass_class__'
    if fields:
        condition += ' or name in {' + ', '.join(repr(f.name) for f in fields) + '}'

    func_builder.add_fn('__setattr__',
                        ('self', 'name', 'value'),
                        (f'  if {condition}:',
                          '   raise FrozenInstanceError(f"cannot assign to field {name!r}")',
                         f'  super(__dataclass_class__, self).__setattr__(name, value)'),
                        locals=locals,
                        overwrite_error=True)
    func_builder.add_fn('__delattr__',
                        ('self', 'name'),
                        (f'  if {condition}:',
                          '   raise FrozenInstanceError(f"cannot delete field {name!r}")',
                         f'  super(__dataclass_class__, self).__delattr__(name)'),
                        locals=locals,
                        overwrite_error=True)


def _is_classvar(a_type, typing):
    return (a_type is typing.ClassVar
            or (typing.get_origin(a_type) is typing.ClassVar))


def _is_initvar(a_type, dataclasses):
    return (a_type is dataclasses.InitVar
            or type(a_type) is dataclasses.InitVar)

def _is_kw_only(a_type, dataclasses):
    return a_type is dataclasses.KW_ONLY


def _is_type(annotation, cls, a_module, a_type, is_type_predicate):
    match = _module_identifier(annotation)
    if match:
        ns = None
        module_name = match[0]
        if not module_name:
            ns = _module_namespace(cls.__module__)
        else:
            module = _module_namespace(cls.__module__)
            if module and module.get(module_name) is a_module:
                ns = _module_namespace(a_type.__module__)
        if ns and is_type_predicate(ns.get(match[1]), a_module):
            return True
    return False


def _get_field(cls, a_name, a_type, default_kw_only):
    default = getattr(cls, a_name, MISSING)
    if isinstance(default, Field):
        f = default
    else:
        f = field(default=default)

    f.name = a_name
    f.type = a_type

    f._field_type = _FIELD

    typing = _imported_module('typing')
    if typing:
        if (_is_classvar(a_type, typing)
            or (isinstance(f.type, str)
                and _is_type(f.type, cls, typing, typing.ClassVar,
                             _is_classvar))):
            f._field_type = _FIELD_CLASSVAR

    if f._field_type is _FIELD:
        dataclasses = _imported_module('dataclasses')
        if (_is_initvar(a_type, dataclasses)
            or (isinstance(f.type, str)
                and _is_type(f.type, cls, dataclasses, dataclasses.InitVar,
                             _is_initvar))):
            f._field_type = _FIELD_INITVAR

    if f._field_type in (_FIELD_CLASSVAR, _FIELD_INITVAR):
        if f.default_factory is not MISSING:
            raise TypeError(f'field {f.name} cannot have a '
                            'default factory')

    if f._field_type in (_FIELD, _FIELD_INITVAR):
        if f.kw_only is MISSING:
            f.kw_only = default_kw_only
    else:
        if f.kw_only is not MISSING:
            raise TypeError(f'field {f.name} is a ClassVar but specifies '
                            'kw_only')

    if f._field_type is _FIELD and f.default.__class__.__hash__ is None:
        raise ValueError(f'mutable default {type(f.default)} for field '
                         f'{f.name} is not allowed: use default_factory')

    return f

def _set_new_attribute(cls, name, value):
    if name in cls.__dict__:
        return True
    setattr(cls, name, value)
    return False


def _hash_set_none(cls, fields, func_builder):
    cls.__hash__ = None

def _hash_add(cls, fields, func_builder):
    flds = []
    for f in fields:
        if f.hash is None:
            if f.compare:
                flds.append(f)
        elif f.hash:
            flds.append(f)
    self_tuple = _tuple_str('self', flds)
    func_builder.add_fn('__hash__',
                        ('self',),
                        [f'  return hash({self_tuple})'],
                        unconditional_add=True)

def _hash_exception(cls, fields, func_builder):
    raise TypeError(f'Cannot overwrite attribute __hash__ '
                    f'in class {cls.__name__}')

_hash_action = {(False, False, False, False): None,
                (False, False, False, True ): None,
                (False, False, True,  False): None,
                (False, False, True,  True ): None,
                (False, True,  False, False): _hash_set_none,
                (False, True,  False, True ): None,
                (False, True,  True,  False): _hash_add,
                (False, True,  True,  True ): None,
                (True,  False, False, False): _hash_add,
                (True,  False, False, True ): _hash_exception,
                (True,  False, True,  False): _hash_add,
                (True,  False, True,  True ): _hash_exception,
                (True,  True,  False, False): _hash_add,
                (True,  True,  False, True ): _hash_exception,
                (True,  True,  True,  False): _hash_add,
                (True,  True,  True,  True ): _hash_exception,
                }


def _process_class(cls, init, repr, eq, order, unsafe_hash, frozen,
                   match_args, kw_only, slots, weakref_slot):
    fields = {}

    setattr(cls, _PARAMS, _DataclassParams(init, repr, eq, order,
                                           unsafe_hash, frozen,
                                           match_args, kw_only,
                                           slots, weakref_slot))

    any_frozen_base = False
    all_frozen_bases = None
    has_dataclass_bases = False
    for b in cls.__mro__[-1:0:-1]:
        base_fields = getattr(b, _FIELDS, None)
        if base_fields is not None:
            has_dataclass_bases = True
            for f in base_fields.values():
                fields[f.name] = f
            if all_frozen_bases is None:
                all_frozen_bases = True
            current_frozen = getattr(b, _PARAMS).frozen
            all_frozen_bases = all_frozen_bases and current_frozen
            any_frozen_base = any_frozen_base or current_frozen

    cls_annotations = _get_annotations(cls)

    cls_fields = []
    KW_ONLY_seen = False
    dataclasses = _imported_module('dataclasses')
    for name, type in cls_annotations.items():
        if (_is_kw_only(type, dataclasses)
            or (isinstance(type, str)
                and _is_type(type, cls, dataclasses, dataclasses.KW_ONLY,
                             _is_kw_only))):
            if KW_ONLY_seen:
                raise TypeError(f'{name!r} is KW_ONLY, but KW_ONLY '
                                'has already been specified')
            KW_ONLY_seen = True
            kw_only = True
        else:
            cls_fields.append(_get_field(cls, name, type, kw_only))

    for f in cls_fields:
        fields[f.name] = f
        if isinstance(getattr(cls, f.name, None), Field):
            if f.default is MISSING:
                delattr(cls, f.name)
            else:
                setattr(cls, f.name, f.default)

    for name, value in cls.__dict__.items():
        if isinstance(value, Field) and not name in cls_annotations:
            raise TypeError(f'{name!r} is a field but has no type annotation')

    if has_dataclass_bases:
        if any_frozen_base and not frozen:
            raise TypeError('cannot inherit non-frozen dataclass from a '
                            'frozen one')
        if all_frozen_bases is False and frozen:
            raise TypeError('cannot inherit frozen dataclass from a '
                            'non-frozen one')

    setattr(cls, _FIELDS, fields)

    class_hash = cls.__dict__.get('__hash__', MISSING)
    has_explicit_hash = not (class_hash is MISSING or
                             (class_hash is None and '__eq__' in cls.__dict__))

    if order and not eq:
        raise ValueError('eq must be true if order is true')

    all_init_fields = [f for f in fields.values()
                       if f._field_type in (_FIELD, _FIELD_INITVAR)]
    (std_init_fields,
     kw_only_init_fields) = _fields_in_init_order(all_init_fields)

    func_builder = _FuncBuilder({})

    if init:
        has_post_init = hasattr(cls, _POST_INIT_NAME)
        self_name = 'self'
        if 'self' in fields:
            self_name = '__dataclass_self__'
        _init_fn(all_init_fields,
                 std_init_fields,
                 kw_only_init_fields,
                 frozen,
                 has_post_init,
                 self_name,
                 func_builder,
                 slots,
                 )

    _set_new_attribute(cls, '__replace__', _replace)

    field_list = [f for f in fields.values() if f._field_type is _FIELD]

    if repr:
        flds = [f for f in field_list if f.repr]
        func_builder.add_fn('__repr__',
                            ('self',),
                            ['  return f"{self.__class__.__qualname__}(' +
                             ', '.join([f"{f.name}={{self.{f.name}!r}}"
                                        for f in flds]) + ')"'],
                            locals={'__dataclasses_recursive_repr': recursive_repr},
                            decorator="@__dataclasses_recursive_repr()")

    if eq:
        cmp_fields = (field for field in field_list if field.compare)
        terms = [f'self.{field.name}==other.{field.name}' for field in cmp_fields]
        field_comparisons = ' and '.join(terms) or 'True'
        func_builder.add_fn('__eq__',
                            ('self', 'other'),
                            [ '  if self is other:',
                              '   return True',
                              '  if other.__class__ is self.__class__:',
                             f'   return {field_comparisons}',
                              '  return NotImplemented'])

    if order:
        flds = [f for f in field_list if f.compare]
        self_tuple = _tuple_str('self', flds)
        other_tuple = _tuple_str('other', flds)
        for name, op in [('__lt__', '<'),
                         ('__le__', '<='),
                         ('__gt__', '>'),
                         ('__ge__', '>='),
                         ]:
            func_builder.add_fn(name,
                            ('self', 'other'),
                            [ '  if other.__class__ is self.__class__:',
                             f'   return {self_tuple}{op}{other_tuple}',
                              '  return NotImplemented'],
                            overwrite_error='Consider using functools.total_ordering')

    if frozen:
        _frozen_set_del_attr(cls, field_list, func_builder)

    hash_action = _hash_action[bool(unsafe_hash),
                               bool(eq),
                               bool(frozen),
                               has_explicit_hash]
    if hash_action:
        cls.__hash__ = hash_action(cls, field_list, func_builder)

    func_builder.add_fns_to_class(cls)

    if not getattr(cls, '__doc__'):
        cls.__doc__ = (cls.__name__ + _init_signature_text(cls, std_init_fields, kw_only_init_fields))

    if match_args:
        _set_new_attribute(cls, '__match_args__',
                           tuple(f.name for f in std_init_fields))

    if weakref_slot and not slots:
        raise TypeError('weakref_slot is True but slots is False')
    if slots:
        _unsupported('dataclass の slots=True（__slots__）')

    return cls


def _init_signature_text(cls, std_fields, kw_only_fields):
    # The text of str(inspect.signature(cls)) without ' -> None', as dataclass() puts it in the class docstring.
    if '__init__' not in cls.__dict__:
        return ''
    params = []
    for f in std_fields:
        params.append(_parameter_text(f))
    if kw_only_fields:
        params.append('*')
        for f in kw_only_fields:
            params.append(_parameter_text(f))
    return '(' + ', '.join(params) + ')'


def _parameter_text(f):
    text = f'{f.name}: {_formatannotation(f.type)}'
    if f.default is not MISSING:
        text += f' = {f.default!r}'
    elif f.default_factory is not MISSING:
        text += ' = <factory>'
    return text


def _formatannotation(annotation):
    if getattr(annotation, '__module__', None) == 'typing':
        words = []
        word = ''
        for char in repr(annotation):
            if char.isalnum() or char in '_.':
                word += char
            else:
                words.append(word.removeprefix('typing.'))
                words.append(char)
                word = ''
        words.append(word.removeprefix('typing.'))
        return ''.join(words)
    if isinstance(annotation, _GenericAlias):
        return str(annotation)
    if isinstance(annotation, type):
        if annotation.__module__ == 'builtins':
            return annotation.__qualname__
        return annotation.__module__ + '.' + annotation.__qualname__
    return repr(annotation)


def dataclass(cls=None, /, *, init=True, repr=True, eq=True, order=False,
              unsafe_hash=False, frozen=False, match_args=True,
              kw_only=False, slots=False, weakref_slot=False):
    def wrap(cls):
        return _process_class(cls, init, repr, eq, order, unsafe_hash,
                              frozen, match_args, kw_only, slots,
                              weakref_slot)

    if cls is None:
        return wrap

    return wrap(cls)


def fields(class_or_instance):
    try:
        fields = getattr(class_or_instance, _FIELDS)
    except AttributeError:
        raise TypeError('must be called with a dataclass type or instance') from None

    return tuple(f for f in fields.values() if f._field_type is _FIELD)


def _is_dataclass_instance(obj):
    return hasattr(type(obj), _FIELDS)


def is_dataclass(obj):
    if isinstance(obj, type):
        cls = obj
    else:
        cls = type(obj)
    return hasattr(cls, _FIELDS)


def asdict(obj, *, dict_factory=dict):
    if not _is_dataclass_instance(obj):
        raise TypeError("asdict() should be called on dataclass instances")
    return _asdict_inner(obj, dict_factory)


def _asdict_inner(obj, dict_factory):
    obj_type = type(obj)
    if obj_type in _ATOMIC_TYPES:
        return obj
    elif hasattr(obj_type, _FIELDS):
        if dict_factory is dict:
            return {
                f.name: _asdict_inner(getattr(obj, f.name), dict)
                for f in fields(obj)
            }
        else:
            return dict_factory([
                (f.name, _asdict_inner(getattr(obj, f.name), dict_factory))
                for f in fields(obj)
            ])
    elif obj_type is list:
        return [_asdict_inner(v, dict_factory) for v in obj]
    elif obj_type is dict:
        return {
            _asdict_inner(k, dict_factory): _asdict_inner(v, dict_factory)
            for k, v in obj.items()
        }
    elif obj_type is tuple:
        return tuple([_asdict_inner(v, dict_factory) for v in obj])
    elif issubclass(obj_type, tuple):
        if hasattr(obj, '_fields'):
            return obj_type(*[_asdict_inner(v, dict_factory) for v in obj])
        else:
            return obj_type(_asdict_inner(v, dict_factory) for v in obj)
    elif issubclass(obj_type, dict):
        if hasattr(obj_type, 'default_factory'):
            result = obj_type(obj.default_factory)
            for k, v in obj.items():
                result[_asdict_inner(k, dict_factory)] = _asdict_inner(v, dict_factory)
            return result
        return obj_type((_asdict_inner(k, dict_factory),
                         _asdict_inner(v, dict_factory))
                        for k, v in obj.items())
    elif issubclass(obj_type, list):
        return obj_type(_asdict_inner(v, dict_factory) for v in obj)
    else:
        return copy.deepcopy(obj)


def astuple(obj, *, tuple_factory=tuple):
    if not _is_dataclass_instance(obj):
        raise TypeError("astuple() should be called on dataclass instances")
    return _astuple_inner(obj, tuple_factory)


def _astuple_inner(obj, tuple_factory):
    if type(obj) in _ATOMIC_TYPES:
        return obj
    elif _is_dataclass_instance(obj):
        return tuple_factory([
            _astuple_inner(getattr(obj, f.name), tuple_factory)
            for f in fields(obj)
        ])
    elif isinstance(obj, tuple) and hasattr(obj, '_fields'):
        return type(obj)(*[_astuple_inner(v, tuple_factory) for v in obj])
    elif isinstance(obj, (list, tuple)):
        return type(obj)(_astuple_inner(v, tuple_factory) for v in obj)
    elif isinstance(obj, dict):
        obj_type = type(obj)
        if hasattr(obj_type, 'default_factory'):
            result = obj_type(getattr(obj, 'default_factory'))
            for k, v in obj.items():
                result[_astuple_inner(k, tuple_factory)] = _astuple_inner(v, tuple_factory)
            return result
        return obj_type((_astuple_inner(k, tuple_factory), _astuple_inner(v, tuple_factory))
                          for k, v in obj.items())
    else:
        return copy.deepcopy(obj)


def make_dataclass(cls_name, fields, *, bases=(), namespace=None, init=True,
                   repr=True, eq=True, order=False, unsafe_hash=False,
                   frozen=False, match_args=True, kw_only=False, slots=False,
                   weakref_slot=False, module=None, decorator=dataclass):
    if namespace is None:
        namespace = {}

    seen = set()
    annotations = {}
    defaults = {}
    for item in fields:
        if isinstance(item, str):
            name = item
            tp = _ANY_MARKER
        elif len(item) == 2:
            name, tp, = item
        elif len(item) == 3:
            name, tp, spec = item
            defaults[name] = spec
        else:
            raise TypeError(f'Invalid field: {item!r}')

        if not isinstance(name, str) or not name.isidentifier():
            raise TypeError(f'Field names must be valid identifiers: {name!r}')
        if _iskeyword(name):
            raise TypeError(f'Field names must not be keywords: {name!r}')
        if name in seen:
            raise TypeError(f'Field name duplicated: {name!r}')

        seen.add(name)
        annotations[name] = tp

    ns = {}
    ns.update(namespace)
    ns.update(defaults)
    if module is None:
        module = '__main__'
    cls = _new_class(cls_name, bases, ns, module)
    typing_any = None
    for name, tp in annotations.items():
        if tp is _ANY_MARKER:
            if typing_any is None:
                typing_any = _imported_module('typing', True).Any
            annotations[name] = typing_any
    _set_annotations(cls, annotations)

    cls = decorator(cls, init=init, repr=repr, eq=eq, order=order,
                    unsafe_hash=unsafe_hash, frozen=frozen,
                    match_args=match_args, kw_only=kw_only, slots=slots,
                    weakref_slot=weakref_slot)
    return cls


def replace(obj, /, **changes):
    if not _is_dataclass_instance(obj):
        raise TypeError("replace() should be called on dataclass instances")
    return _replace(obj, **changes)


def _replace(self, /, **changes):
    for f in getattr(self, _FIELDS).values():
        if f._field_type is _FIELD_CLASSVAR:
            continue

        if not f.init:
            if f.name in changes:
                raise TypeError(f'field {f.name} is declared with '
                                f'init=False, it cannot be specified with '
                                f'replace()')
            continue

        if f.name not in changes:
            if f._field_type is _FIELD_INITVAR and f.default is MISSING:
                raise TypeError(f"InitVar {f.name!r} "
                                f'must be specified with replace()')
            changes[f.name] = getattr(self, f.name)

    return self.__class__(**changes)
`;
