/**
 * The part of CPython 3.14's Lib/enum.py that this interpreter runs as Python. A class statement cannot name a
 * metaclass here, so the interpreter runs `_enum_dict_setitem` for each name the class body binds, as
 * `EnumDict.__setitem__`, and `_build_enum_class` for the class it creates, as `EnumType.__new__` and
 * `_proto_member.__set_name__`; `EnumType.__call__` and `EnumType.__contains__` are registered as hooks. Members
 * cannot be instances of int or str, so `StrEnum` and `IntFlag` define the operations of their values themselves.
 */
export const ENUM_SOURCE = `
Flag = ReprEnum = IntFlag = StrEnum = EJECT = None


class nonmember(object):
    def __init__(self, value):
        self.value = value


class member(object):
    def __init__(self, value):
        self.value = value


def _is_descriptor(obj):
    return (
            hasattr(obj, '__get__') or
            hasattr(obj, '__set__') or
            hasattr(obj, '__delete__')
            )


def _is_dunder(name):
    return (
            len(name) > 4 and
            name[:2] == name[-2:] == '__' and
            name[2] != '_' and
            name[-3] != '_'
            )


def _is_sunder(name):
    return (
            len(name) > 2 and
            name[0] == name[-1] == '_' and
            name[1] != '_' and
            name[-2] != '_'
            )


def _is_internal_class(cls_name, obj):
    if not isinstance(obj, type):
        return False
    qualname = getattr(obj, '__qualname__', '')
    s_pattern = cls_name + '.' + getattr(obj, '__name__', '')
    e_pattern = '.' + s_pattern
    return qualname == s_pattern or qualname.endswith(e_pattern)


def _is_private(cls_name, name):
    pattern = '_%s__' % (cls_name, )
    pat_len = len(pattern)
    if (
            len(name) > pat_len
            and name.startswith(pattern)
            and (name[-1] != '_' or name[-2] != '_')
        ):
        return True
    else:
        return False


def _is_single_bit(num):
    if num == 0:
        return False
    num &= num - 1
    return num == 0


def _iter_bits_lsb(num):
    original = num
    if isinstance(num, Enum):
        num = num.value
    if num < 0:
        raise ValueError('%r is not a positive integer' % original)
    while num:
        b = num & (~num + 1)
        yield b
        num ^= b


def show_flag_values(value):
    return list(_iter_bits_lsb(value))


_builtin_bin = bin


def bin(num, max_bits=None):
    num = num.__index__()
    ceiling = 2 ** (num).bit_length()
    if num >= 0:
        s = _builtin_bin(num + ceiling).replace('1', '0', 1)
    else:
        s = _builtin_bin(~num ^ (ceiling - 1) + ceiling)
    sign = s[:3]
    digits = s[3:]
    if max_bits is not None:
        if len(digits) < max_bits:
            digits = (sign[-1] * max_bits + digits)[-max_bits:]
    return "%s %s" % (sign, digits)


class _not_given:
    def __repr__(self):
        return('<not given>')
_not_given = _not_given()


class _auto_null:
    def __repr__(self):
        return '_auto_null'
_auto_null = _auto_null()


class auto:
    def __init__(self, value=_auto_null):
        self.value = value

    def __repr__(self):
        return "auto(%r)" % self.value


_SUNDER_NAMES = (
    '_order_',
    '_generate_next_value_', '_numeric_repr_', '_missing_', '_ignore_',
    '_iter_member_', '_iter_member_by_value_', '_iter_member_by_def_',
    '_add_alias_', '_add_value_alias_',
)


def _default_generate_next_value_(name, start, count, last_values):
    if not last_values:
        return start
    try:
        last_value = sorted(last_values).pop()
    except TypeError:
        raise TypeError('unable to sort non-numeric values') from None
    try:
        return last_value + 1
    except TypeError:
        raise TypeError('unable to increment %r' % (last_value, )) from None


def _enum_dict_new(cls_name, bases, internal):
    # Follows EnumType.__prepare__; the state is what EnumDict keeps beside the namespace.
    member_type, first_enum = _get_mixins_(cls_name, bases)
    gnv = getattr(first_enum, '_generate_next_value_', None)
    if gnv is None:
        gnv = _default_generate_next_value_
    return {
        'cls_name': cls_name, 'internal': internal, 'gnv': gnv,
        'member_names': {}, 'last_values': [], 'ignore': [], 'auto_called': False,
    }


def _enum_dict_setitem(state, key, value, defined, old_value):
    # Follows EnumDict.__setitem__ and returns the value to store under the key.
    member_names = state['member_names']
    if _is_private(state['cls_name'], key):
        pass
    elif _is_sunder(key):
        if state['internal']:
            return value
        if key not in _SUNDER_NAMES and not key.startswith('_repr_'):
            raise ValueError(
                    '_sunder_ names, such as %r, are reserved for future Enum use'
                    % (key, )
                    )
        if key == '_generate_next_value_':
            if state['auto_called']:
                raise TypeError("_generate_next_value_ must be defined before members")
            if isinstance(value, staticmethod):
                state['gnv'] = value.__func__
            else:
                state['gnv'] = value
                value = staticmethod(value)
        elif key == '_ignore_':
            if isinstance(value, str):
                value = value.replace(',',' ').split()
            else:
                value = list(value)
            state['ignore'] = value
            already = set(value) & set(member_names)
            if already:
                raise ValueError(
                        '_ignore_ cannot specify already set names: %r'
                        % (already, )
                        )
    elif _is_dunder(key):
        pass
    elif key in member_names:
        raise TypeError('%r already defined as %r' % (key, old_value))
    elif key in state['ignore']:
        pass
    elif isinstance(value, nonmember):
        value = value.value
    elif _is_descriptor(value):
        pass
    elif _is_internal_class(state['cls_name'], value):
        pass
    else:
        if defined:
            raise TypeError('%r already defined as %r' % (key, old_value))
        elif isinstance(value, member):
            value = value.value
        non_auto_store = True
        single = False
        if isinstance(value, auto):
            single = True
            value = (value, )
        if isinstance(value, tuple) and any(isinstance(v, auto) for v in value):
            auto_valued = []
            t = type(value)
            for v in value:
                if isinstance(v, auto):
                    non_auto_store = False
                    if v.value == _auto_null:
                        v.value = state['gnv'](
                                key, 1, len(member_names), state['last_values'][:],
                                )
                        state['auto_called'] = True
                    v = v.value
                    state['last_values'].append(v)
                auto_valued.append(v)
            if single:
                value = auto_valued[0]
            else:
                try:
                    value = t(auto_valued)
                except TypeError:
                    value = t(*auto_valued)
        member_names[key] = None
        if non_auto_store:
            state['last_values'].append(value)
    return value


def _get_mixins_(class_name, bases):
    first_enum = bases[-1]
    if not isinstance(first_enum, _EnumType):
        raise TypeError("new enumerations should be created as "
                "\`EnumName([mixin_type, ...] [data_type,] enum_type)\`")
    member_type = object
    for chain in bases:
        for base in chain.__mro__:
            if isinstance(base, _EnumType) and base._member_type_ is not object:
                member_type = base._member_type_
                break
    return member_type, first_enum


def _str_member_value(values):
    # Follows StrEnum.__new__.
    if len(values) > 3:
        raise TypeError('too many arguments for str(): %r' % (values, ))
    if len(values) == 1:
        if not isinstance(values[0], str):
            raise TypeError('%r is not a string' % (values[0], ))
    if len(values) >= 2:
        if not isinstance(values[1], str):
            raise TypeError('encoding must be a string, not %r' % (values[1], ))
    if len(values) == 3:
        if not isinstance(values[2], str):
            raise TypeError('errors must be a string, not %r' % (values[2]))
    return str(*values)


def _add_enum_member(enum_class, member_name, value, member_type, is_flag):
    # Follows _proto_member.__set_name__.
    if not isinstance(value, tuple):
        args = (value, )
    else:
        args = value
    if member_type is object:
        member_value = value
    elif member_type is str:
        member_value = _str_member_value(args)
    else:
        member_value = member_type(*args)
    enum_member = _new_member(enum_class, member_name, member_value)
    if any('__init__' in base.__dict__ for base in enum_class.__mro__[:-1]):
        enum_member.__init__(*args)
    _finish_member(enum_member)
    value = member_value
    if is_flag:
        if isinstance(value, int):
            enum_class._flag_mask_ |= value
            if _is_single_bit(value):
                enum_class._singles_mask_ |= value
        enum_class._all_bits_ = 2 ** ((enum_class._flag_mask_).bit_length()) - 1
    try:
        try:
            enum_member = enum_class._value2member_map_[value]
        except TypeError:
            found = False
            for name, canonical_member in enum_class._member_map_.items():
                if canonical_member._value_ == value:
                    enum_member = canonical_member
                    found = True
                    break
            if not found:
                raise KeyError
    except KeyError:
        if not is_flag:
            enum_class._member_names_.append(member_name)
        elif isinstance(value, int) and _is_single_bit(value):
            enum_class._member_names_.append(member_name)
    setattr(enum_class, member_name, enum_member)
    enum_class._member_map_[member_name] = enum_member
    try:
        enum_class._value2member_map_.setdefault(value, enum_member)
        if value not in enum_class._hashable_values_:
            enum_class._hashable_values_.append(value)
    except TypeError:
        enum_class._unhashable_values_.append(value)
        enum_class._unhashable_values_map_.setdefault(member_name, []).append(value)


def _build_enum_class(enum_class, state, boundary):
    # Follows EnumType.__new__ for a class the interpreter has created from the namespace of its body.
    cls = enum_class.__name__
    bases = enum_class.__bases__
    member_type, first_enum = _get_mixins_(cls, bases)
    for key in state['ignore'] + ['_ignore_']:
        if key in enum_class.__dict__:
            delattr(enum_class, key)
        state['member_names'].pop(key, None)
    classdict = dict(enum_class.__dict__)
    members = {name: classdict[name] for name in state['member_names']}
    invalid_names = set(members) & {'mro', ''}
    if invalid_names:
        raise ValueError('invalid enum member name(s) %s' % (
                ','.join(repr(n) for n in invalid_names)
                ))
    _order_ = classdict.get('_order_', None)
    if '_order_' in enum_class.__dict__:
        delattr(enum_class, '_order_')
    is_flag = (Flag is None and cls == 'Flag') or (Flag is not None and issubclass(enum_class, Flag))
    if '_member_type_' in classdict:
        member_type = classdict['_member_type_']
    enum_class._member_names_ = []
    enum_class._member_map_ = {}
    enum_class._value2member_map_ = {}
    enum_class._hashable_values_ = []
    enum_class._unhashable_values_ = []
    enum_class._unhashable_values_map_ = {}
    enum_class._member_type_ = member_type
    enum_class.__members__ = MappingProxyType(enum_class._member_map_)
    if is_flag:
        enum_class._boundary_ = boundary or classdict.get('_boundary_') or getattr(first_enum, '_boundary_', None)
        enum_class._flag_mask_ = 0
        enum_class._singles_mask_ = 0
        enum_class._all_bits_ = 0
        enum_class._iter_by_def_ = False
    if ReprEnum is not None and ReprEnum in bases:
        if member_type is object:
            raise TypeError(
                    'ReprEnum subclasses must be mixed with a data type (i.e.'
                    ' int, str, float, etc.)'
                    )
    for name, value in members.items():
        _add_enum_member(enum_class, name, value, member_type, is_flag)
    canonical = [enum_class._member_map_[name] for name in enum_class._member_names_]
    _set_enum_members(enum_class, canonical)
    if _order_ is not None:
        if isinstance(_order_, str):
            _order_ = _order_.replace(',', ' ').split()
    if is_flag:
        member_list = [m._value_ for m in canonical]
        if member_list != sorted(member_list):
            enum_class._iter_by_def_ = True
        if _order_:
            _order_ = [
                    o
                    for o in _order_
                    if o not in enum_class._member_map_ or _is_single_bit(enum_class._member_map_[o]._value_)
                    ]
    if _order_:
        _order_ = [
                o
                for o in _order_
                if (
                    o not in enum_class._member_map_
                    or
                    (o in enum_class._member_map_ and o in enum_class._member_names_)
                    )]
        if _order_ != enum_class._member_names_:
            raise TypeError(
                    'member order does not match _order_:\\n  %r\\n  %r'
                    % (enum_class._member_names_, _order_)
                    )


def _create_(cls, class_name, names, *, module=None, qualname=None, type=None, start=1, boundary=None):
    # Follows EnumType._create_, the functional API.
    if type is not None:
        _unsupported('Enum の関数形式での type= の指定（組み込み型を継承するクラス）')
    bases = (cls, )
    first_enum = cls
    state = _enum_dict_new(class_name, bases, False)
    classdict = {}
    if isinstance(names, str):
        names = names.replace(',', ' ').split()
    if isinstance(names, (tuple, list)) and names and isinstance(names[0], str):
        original_names, names = names, []
        last_values = []
        for count, name in enumerate(original_names):
            value = state['gnv'](name, start, count, last_values[:])
            last_values.append(value)
            names.append((name, value))
    if names is None:
        names = ()
    for item in names:
        if isinstance(item, str):
            member_name, member_value = item, names[item]
        else:
            member_name, member_value = item
        classdict[member_name] = _enum_dict_setitem(
                state, member_name, member_value, member_name in classdict, classdict.get(member_name),
                )
    if module is None:
        module = '__main__'
    enum_class = _new_class(class_name, bases, list(classdict.items()), module)
    if qualname is not None:
        enum_class.__qualname__ = qualname
    _build_enum_class(enum_class, state, boundary)
    return enum_class


def _enum_new(cls, value):
    # Follows Enum.__new__, which looks a member up by its value.
    if type(value) is cls:
        return value
    try:
        return cls._value2member_map_[value]
    except KeyError:
        pass
    except TypeError:
        for name, unhashable_values in cls._unhashable_values_map_.items():
            if value in unhashable_values:
                return cls._member_map_[name]
        for name, member in cls._member_map_.items():
            if value == member._value_:
                return cls._member_map_[name]
    try:
        exc = None
        result = cls._missing_(value)
    except Exception as e:
        exc = e
        result = None
    if isinstance(result, cls):
        return result
    elif (
            Flag is not None and issubclass(cls, Flag)
            and cls._boundary_ is EJECT and isinstance(result, int)
        ):
        return result
    else:
        ve_exc = ValueError("%r is not a valid %s" % (value, cls.__qualname__))
        if result is None and exc is None:
            raise ve_exc
        elif exc is None:
            exc = TypeError(
                    'error in %s._missing_: returned %r instead of None or a valid member'
                    % (cls.__name__, result)
                    )
        if not isinstance(exc, ValueError):
            exc.__context__ = ve_exc
        raise exc


class EnumType:
    def __call__(cls, value, names=_not_given, *values, module=None, qualname=None, type=None, start=1, boundary=None):
        if getattr(cls, '_member_map_', None):
            if names is not _not_given:
                value = (value, names) + values
            return _enum_new(cls, value)
        if names is _not_given and type is None:
            raise TypeError(
                    f"{cls} has no members; specify \`names=()\` if you meant to create a new, empty, enum"
                    )
        if names is _not_given:
            names = None
        return _create_(
                cls,
                class_name=value,
                names=names,
                module=module,
                qualname=qualname,
                type=type,
                start=start,
                boundary=boundary,
                )

    def __contains__(cls, value):
        if isinstance(value, cls):
            return True
        if Flag is not None and issubclass(cls, Flag):
            try:
                result = cls._missing_(value)
                return isinstance(result, cls)
            except ValueError:
                pass
        return (
                value in cls._unhashable_values_    # both structures are lists
                or value in cls._hashable_values_
                )

    def __bool__(cls):
        return True

    def __getitem__(cls, name):
        return cls._member_map_[name]

    def __iter__(cls):
        return (cls._member_map_[name] for name in cls._member_names_)

    def __len__(cls):
        return len(cls._member_names_)

    def __reversed__(cls):
        return (cls._member_map_[name] for name in reversed(cls._member_names_))

    def __repr__(cls):
        if Flag is not None and issubclass(cls, Flag):
            return "<flag %r>" % cls.__name__
        else:
            return "<enum %r>" % cls.__name__


_register_enum_hooks(
        _enum_dict_new,
        _enum_dict_setitem,
        _build_enum_class,
        EnumType.__call__,
        EnumType.__contains__,
        {
                '__bool__': EnumType.__bool__,
                '__call__': EnumType.__call__,
                '__contains__': EnumType.__contains__,
                '__getitem__': EnumType.__getitem__,
                '__iter__': EnumType.__iter__,
                '__len__': EnumType.__len__,
                '__reversed__': EnumType.__reversed__,
                '__repr__': EnumType.__repr__,
                },
        )
del EnumType


class ReprEnum(Enum):
    pass


class StrEnum(ReprEnum):
    _member_type_ = str

    @staticmethod
    def _generate_next_value_(name, start, count, last_values):
        return name.lower()

    def __str__(self):
        return self._value_

    def __format__(self, format_spec):
        return format(self._value_, format_spec)

    def __hash__(self):
        return hash(self._value_)

    def __eq__(self, other):
        other = _str_operand(other)
        if other is NotImplemented:
            return NotImplemented
        return self._value_ == other

    def __ne__(self, other):
        other = _str_operand(other)
        if other is NotImplemented:
            return NotImplemented
        return self._value_ != other

    def __lt__(self, other):
        other = _str_operand(other)
        if other is NotImplemented:
            return NotImplemented
        return self._value_ < other

    def __le__(self, other):
        other = _str_operand(other)
        if other is NotImplemented:
            return NotImplemented
        return self._value_ <= other

    def __gt__(self, other):
        other = _str_operand(other)
        if other is NotImplemented:
            return NotImplemented
        return self._value_ > other

    def __ge__(self, other):
        other = _str_operand(other)
        if other is NotImplemented:
            return NotImplemented
        return self._value_ >= other

    def __len__(self):
        return len(self._value_)

    def __iter__(self):
        return iter(self._value_)

    def __getitem__(self, key):
        return self._value_[key]

    def __contains__(self, key):
        other = _str_operand(key)
        if other is NotImplemented:
            other = key
        return other in self._value_

    def __add__(self, other):
        if isinstance(other, StrEnum):
            other = other._value_
        return self._value_ + other

    def __radd__(self, other):
        other = _str_operand(other)
        if other is NotImplemented:
            return NotImplemented
        return other + self._value_

    def __mul__(self, other):
        return self._value_ * other

    def __rmul__(self, other):
        return other * self._value_

    def __mod__(self, other):
        return self._value_ % other

    def __getattr__(self, name):
        try:
            return getattr(self._value_, name)
        except AttributeError:
            raise AttributeError(
                    "%r object has no attribute %r" % (type(self).__name__, name)
                    ) from None


def _str_operand(other):
    if isinstance(other, str):
        return other
    if StrEnum is not None and isinstance(other, StrEnum):
        return other._value_
    return NotImplemented


def pickle_by_global_name(self, proto):
    return self.name


def pickle_by_enum_name(self, proto):
    return getattr, (self.__class__, self._name_)


class FlagBoundary(StrEnum):
    STRICT = auto()
    CONFORM = auto()
    EJECT = auto()
    KEEP = auto()
STRICT, CONFORM, EJECT, KEEP = FlagBoundary


def _high_bit(value):
    return value.bit_length() - 1


class Flag(Enum):
    _boundary_ = STRICT
    _numeric_repr_ = repr

    @staticmethod
    def _generate_next_value_(name, start, count, last_values):
        if not count:
            if start is not None:
                return start
            return 1
        last_value = max(last_values)
        try:
            high_bit = _high_bit(last_value)
        except Exception:
            raise TypeError('invalid flag value %r' % last_value) from None
        return 2 ** (high_bit+1)

    @classmethod
    def _iter_member_by_value_(cls, value):
        for val in _iter_bits_lsb(value & cls._flag_mask_):
            yield cls._value2member_map_.get(val)

    @classmethod
    def _iter_member_by_def_(cls, value):
        names = cls._member_names_
        for m in sorted(
                cls._iter_member_by_value_(value),
                key=lambda m: names.index(m._name_),
                ):
            yield m

    @classmethod
    def _iter_member_(cls, value):
        if cls._iter_by_def_:
            return cls._iter_member_by_def_(value)
        return cls._iter_member_by_value_(value)

    @classmethod
    def _missing_(cls, value):
        if not isinstance(value, int):
            raise ValueError(
                    "%r is not a valid %s" % (value, cls.__qualname__)
                    )
        flag_mask = cls._flag_mask_
        singles_mask = cls._singles_mask_
        all_bits = cls._all_bits_
        neg_value = None
        if (
                not ~all_bits <= value <= all_bits
                or value & (all_bits ^ flag_mask)
            ):
            if cls._boundary_ is STRICT:
                max_bits = max(value.bit_length(), flag_mask.bit_length())
                raise ValueError(
                        "%r invalid value %r\\n    given %s\\n  allowed %s" % (
                            cls, value, bin(value, max_bits), bin(flag_mask, max_bits),
                            ))
            elif cls._boundary_ is CONFORM:
                value = value & flag_mask
            elif cls._boundary_ is EJECT:
                return value
            elif cls._boundary_ is KEEP:
                if value < 0:
                    value = (
                            max(all_bits+1, 2**(value.bit_length()))
                            + value
                            )
            else:
                raise ValueError(
                        '%r unknown flag boundary %r' % (cls, cls._boundary_, )
                        )
        if value < 0:
            neg_value = value
            value = all_bits + 1 + value
        unknown = value & ~flag_mask
        aliases = value & ~singles_mask
        member_value = value & singles_mask
        if unknown and cls._boundary_ is not KEEP:
            raise ValueError(
                    '%s(%r) -->  unknown values %r [%s]'
                    % (cls.__name__, value, unknown, bin(unknown))
                    )
        pseudo_value = value
        pseudo_name = None
        if member_value or aliases:
            members = []
            combined_value = 0
            for m in cls._iter_member_(member_value):
                members.append(m)
                combined_value |= m._value_
            if aliases:
                value = member_value | aliases
                for n, pm in cls._member_map_.items():
                    if pm not in members and pm._value_ and pm._value_ & value == pm._value_:
                        members.append(pm)
                        combined_value |= pm._value_
            unknown = value ^ combined_value
            pseudo_name = '|'.join([m._name_ for m in members])
            if not combined_value:
                pseudo_name = None
            elif unknown and cls._boundary_ is STRICT:
                raise ValueError(
                        '%r: no members with value %r' % (cls, unknown)
                        )
            elif unknown:
                pseudo_name += '|%s' % cls._numeric_repr_(unknown)
        pseudo_member = _new_member(cls, pseudo_name, pseudo_value)
        _finish_member(pseudo_member)
        pseudo_member = cls._value2member_map_.setdefault(value, pseudo_member)
        if neg_value is not None:
            cls._value2member_map_[neg_value] = pseudo_member
        return pseudo_member

    def __contains__(self, other):
        if not isinstance(other, self.__class__):
            raise TypeError(
                "unsupported operand type(s) for 'in': %r and %r" % (
                    type(other).__qualname__, self.__class__.__qualname__))
        return other._value_ & self._value_ == other._value_

    def __iter__(self):
        for m in self._iter_member_(self._value_):
            yield m

    def __len__(self):
        return self._value_.bit_count()

    def __repr__(self):
        cls_name = self.__class__.__name__
        if self._name_ is None:
            return "<%s: %r>" % (cls_name, self._value_)
        else:
            return "<%s.%s: %r>" % (cls_name, self._name_, self._value_)

    def __str__(self):
        cls_name = self.__class__.__name__
        if self._name_ is None:
            return '%s(%r)' % (cls_name, self._value_)
        else:
            return "%s.%s" % (cls_name, self._name_)

    def __bool__(self):
        return bool(self._value_)

    def _get_value(self, flag):
        if isinstance(flag, self.__class__):
            return flag._value_
        elif self._member_type_ is not object and isinstance(flag, self._member_type_):
            return flag
        elif self._member_type_ is int and isinstance(flag, (IntFlag, IntEnum)):
            return flag._value_
        return NotImplemented

    def __or__(self, other):
        other_value = self._get_value(other)
        if other_value is NotImplemented:
            return NotImplemented

        for flag in self, other:
            if self._get_value(flag) is None:
                raise TypeError(f"'{flag}' cannot be combined with other flags with |")
        value = self._value_
        return self.__class__(value | other_value)

    def __and__(self, other):
        other_value = self._get_value(other)
        if other_value is NotImplemented:
            return NotImplemented

        for flag in self, other:
            if self._get_value(flag) is None:
                raise TypeError(f"'{flag}' cannot be combined with other flags with &")
        value = self._value_
        return self.__class__(value & other_value)

    def __xor__(self, other):
        other_value = self._get_value(other)
        if other_value is NotImplemented:
            return NotImplemented

        for flag in self, other:
            if self._get_value(flag) is None:
                raise TypeError(f"'{flag}' cannot be combined with other flags with ^")
        value = self._value_
        return self.__class__(value ^ other_value)

    def __invert__(self):
        if self._get_value(self) is None:
            raise TypeError(f"'{self}' cannot be inverted")

        if self._boundary_ in (EJECT, KEEP):
            return self.__class__(~self._value_)
        else:
            return self.__class__(self._singles_mask_ & ~self._value_)

    __rand__ = __and__
    __ror__ = __or__
    __rxor__ = __xor__


class IntFlag(Flag):
    _member_type_ = int
    _boundary_ = KEEP

    def __str__(self):
        return repr(self._value_)

    def __format__(self, format_spec):
        return format(self._value_, format_spec)

    def __hash__(self):
        return hash(self._value_)

    def __index__(self):
        return self._value_

    def __int__(self):
        return self._value_

    def __float__(self):
        return float(self._value_)

    def __eq__(self, other):
        return self._value_ == _int_operand(other)

    def __ne__(self, other):
        return self._value_ != _int_operand(other)

    def __lt__(self, other):
        return self._value_ < _int_operand(other)

    def __le__(self, other):
        return self._value_ <= _int_operand(other)

    def __gt__(self, other):
        return self._value_ > _int_operand(other)

    def __ge__(self, other):
        return self._value_ >= _int_operand(other)

    def __add__(self, other):
        return self._value_ + _int_operand(other)

    def __radd__(self, other):
        return _int_operand(other) + self._value_

    def __sub__(self, other):
        return self._value_ - _int_operand(other)

    def __rsub__(self, other):
        return _int_operand(other) - self._value_

    def __mul__(self, other):
        return self._value_ * _int_operand(other)

    def __rmul__(self, other):
        return _int_operand(other) * self._value_

    def __truediv__(self, other):
        return self._value_ / _int_operand(other)

    def __rtruediv__(self, other):
        return _int_operand(other) / self._value_

    def __floordiv__(self, other):
        return self._value_ // _int_operand(other)

    def __rfloordiv__(self, other):
        return _int_operand(other) // self._value_

    def __mod__(self, other):
        return self._value_ % _int_operand(other)

    def __rmod__(self, other):
        return _int_operand(other) % self._value_

    def __divmod__(self, other):
        return divmod(self._value_, _int_operand(other))

    def __rdivmod__(self, other):
        return divmod(_int_operand(other), self._value_)

    def __pow__(self, other):
        return self._value_ ** _int_operand(other)

    def __rpow__(self, other):
        return _int_operand(other) ** self._value_

    def __lshift__(self, other):
        return self._value_ << _int_operand(other)

    def __rlshift__(self, other):
        return _int_operand(other) << self._value_

    def __rshift__(self, other):
        return self._value_ >> _int_operand(other)

    def __rrshift__(self, other):
        return _int_operand(other) >> self._value_

    def __neg__(self):
        return -self._value_

    def __pos__(self):
        return +self._value_

    def __abs__(self):
        return abs(self._value_)

    def __round__(self, ndigits=None):
        return round(self._value_, ndigits)

    def __getattr__(self, name):
        try:
            return getattr(self._value_, name)
        except AttributeError:
            raise AttributeError(
                    "%r object has no attribute %r" % (type(self).__name__, name)
                    ) from None


def _int_operand(other):
    if IntFlag is not None and isinstance(other, IntFlag):
        return other._value_
    return other


def unique(enumeration):
    duplicates = []
    for name, member in enumeration.__members__.items():
        if name != member.name:
            duplicates.append((name, member.name))
    if duplicates:
        alias_details = ', '.join(
                ["%s -> %s" % (alias, name) for (alias, name) in duplicates])
        raise ValueError('duplicate values found in %r: %s' %
                (enumeration, alias_details))
    return enumeration


def global_enum_repr(self):
    module = self.__class__.__module__.split('.')[-1]
    return '%s.%s' % (module, self._name_)


def global_flag_repr(self):
    module = self.__class__.__module__.split('.')[-1]
    cls_name = self.__class__.__name__
    if self._name_ is None:
        return "%s.%s(%r)" % (module, cls_name, self._value_)
    if _is_single_bit(self._value_):
        return '%s.%s' % (module, self._name_)
    if self._boundary_ is not FlagBoundary.KEEP:
        return '|'.join(['%s.%s' % (module, name) for name in self.name.split('|')])
    else:
        name = []
        for n in self._name_.split('|'):
            if n[0].isdigit():
                name.append(n)
            else:
                name.append('%s.%s' % (module, n))
        return '|'.join(name)


def global_str(self):
    if self._name_ is None:
        cls_name = self.__class__.__name__
        return "%s(%r)" % (cls_name, self._value_)
    else:
        return self._name_


class EnumCheck(StrEnum):
    CONTINUOUS = "no skipped integer values"
    NAMED_FLAGS = "multi-flag aliases may not contain unnamed flags"
    UNIQUE = "one name per value"
CONTINUOUS, NAMED_FLAGS, UNIQUE = EnumCheck


class verify:
    def __init__(self, *checks):
        self.checks = checks

    def __call__(self, enumeration):
        checks = self.checks
        cls_name = enumeration.__name__
        if Flag is not None and issubclass(enumeration, Flag):
            enum_type = 'flag'
        elif issubclass(enumeration, Enum):
            enum_type = 'enum'
        else:
            raise TypeError("the 'verify' decorator only works with Enum and Flag")
        for check in checks:
            if check is UNIQUE:
                duplicates = []
                for name, member in enumeration.__members__.items():
                    if name != member.name:
                        duplicates.append((name, member.name))
                if duplicates:
                    alias_details = ', '.join(
                            ["%s -> %s" % (alias, name) for (alias, name) in duplicates])
                    raise ValueError('aliases found in %r: %s' %
                            (enumeration, alias_details))
            elif check is CONTINUOUS:
                values = set(e.value for e in enumeration)
                if len(values) < 2:
                    continue
                low, high = min(values), max(values)
                missing = []
                if enum_type == 'flag':
                    for i in range(_high_bit(low)+1, _high_bit(high)):
                        if 2**i not in values:
                            missing.append(2**i)
                elif enum_type == 'enum':
                    for i in range(low+1, high):
                        if i not in values:
                            missing.append(i)
                else:
                    raise Exception('verify: unknown type %r' % enum_type)
                if missing:
                    raise ValueError(('invalid %s %r: missing values %s' % (
                            enum_type, cls_name, ', '.join((str(m) for m in missing)))
                            )[:256])
            elif check is NAMED_FLAGS:
                member_names = enumeration._member_names_
                member_values = [m.value for m in enumeration]
                missing_names = []
                missing_value = 0
                for name, alias in enumeration._member_map_.items():
                    if name in member_names:
                        continue
                    if alias.value < 0:
                        continue
                    values = list(_iter_bits_lsb(alias.value))
                    missed = [v for v in values if v not in member_values]
                    if missed:
                        missing_names.append(name)
                        for val in missed:
                            missing_value |= val
                if missing_names:
                    if len(missing_names) == 1:
                        alias = 'alias %s is missing' % missing_names[0]
                    else:
                        alias = 'aliases %s and %s are missing' % (
                                ', '.join(missing_names[:-1]), missing_names[-1]
                                )
                    if _is_single_bit(missing_value):
                        value = 'value 0x%x' % missing_value
                    else:
                        value = 'combined values of 0x%x' % missing_value
                    raise ValueError(
                            'invalid Flag %r: %s %s [use enum.show_flag_values(value) for details]'
                            % (cls_name, alias, value)
                            )
        return enumeration
`;
