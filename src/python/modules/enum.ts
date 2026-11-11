import { builtin } from '../define';
import {
  autoClass,
  enumClass,
  enumTypeClass,
  flagClass,
  globalEnum,
  intEnumClass,
  intFlagClass,
  memberClass,
  newAuto,
  nonmemberClass,
  reprEnumClass,
  strEnumClass,
  uniqueEnum,
} from '../enums';
import { registerSourceModule } from '../sourceModules';
import { None } from '../types';
import { type PyClass, PyOpaque, type PyValue } from '../values';

autoClass.construct = () => newAuto();
memberClass.construct = (_cls, [value]) => new PyOpaque(memberClass, 'member', value);
nonmemberClass.construct = (_cls, [value]) => new PyOpaque(nonmemberClass, 'nonmember', value);

// The parts of CPython's `enum.py` written in Python here: FlagBoundary, EnumCheck and verify, enum.property, EnumDict,
// and the helpers for flags and pickling. The natives of enums.ts provide the enum classes themselves.
const SOURCE = String.raw`import builtins as _builtins
from types import DynamicClassAttribute

_builtin_property = _builtins.property


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


def _high_bit(value):
    return value.bit_length() - 1


class property(DynamicClassAttribute):
    """
    This is a descriptor, used to define attributes that act differently
    when accessed through an enum member and through an enum class.
    Instance access is the same as property(), but access to an attribute
    through the enum class will instead look in the class' _member_map_ for
    a corresponding enum member.
    """

    member = None
    _attr_type = None
    _cls_type = None

    def __get__(self, instance, ownerclass=None):
        if instance is None:
            if self.member is not None:
                return self.member
            else:
                raise AttributeError(
                        '%r has no attribute %r' % (ownerclass, self.name)
                        )
        if self.fget is not None:
            return self.fget(instance)
        elif self._attr_type == 'attr':
            return getattr(self._cls_type, self.name)
        elif self._attr_type == 'desc':
            return getattr(instance._value_, self.name)
        try:
            return ownerclass._member_map_[self.name]
        except KeyError:
            raise AttributeError(
                    '%r has no attribute %r' % (ownerclass, self.name)
                    ) from None

    def __set__(self, instance, value):
        if self.fset is not None:
            return self.fset(instance, value)
        raise AttributeError(
                "<enum %r> cannot set attribute %r" % (self.clsname, self.name)
                )

    def __delete__(self, instance):
        if self.fdel is not None:
            return self.fdel(instance)
        raise AttributeError(
                "<enum %r> cannot delete attribute %r" % (self.clsname, self.name)
                )

    def __set_name__(self, ownerclass, name):
        self.name = name
        self.clsname = ownerclass.__name__


class EnumDict(dict):
    """
    Track enum member order and ensure member names are not reused.

    EnumType will use the names found in self._member_names as the
    enumeration member names.
    """
    def __init__(self, cls_name=None):
        super().__init__()
        self._member_names = {}
        self._last_values = []
        self._ignore = []
        self._auto_called = False
        self._cls_name = cls_name

    def __setitem__(self, key, value):
        """
        Changes anything not dundered or not a descriptor.

        If an enum member name is used twice, an error is raised; duplicate
        values are not checked for.

        Single underscore (sunder) names are reserved.
        """
        if self._cls_name is not None and _is_private(self._cls_name, key):
            pass
        elif _is_sunder(key):
            if key not in (
                    '_order_',
                    '_generate_next_value_', '_numeric_repr_', '_missing_', '_ignore_',
                    '_iter_member_', '_iter_member_by_value_', '_iter_member_by_def_',
                    '_add_alias_', '_add_value_alias_',
                    ) and not key.startswith('_repr_'):
                raise ValueError(
                        '_sunder_ names, such as %r, are reserved for future Enum use'
                        % (key, )
                        )
            if key == '_generate_next_value_':
                if self._auto_called:
                    raise TypeError("_generate_next_value_ must be defined before members")
                _gnv = value.__func__ if isinstance(value, staticmethod) else value
                setattr(self, '_generate_next_value', _gnv)
            elif key == '_ignore_':
                if isinstance(value, str):
                    value = value.replace(',',' ').split()
                else:
                    value = list(value)
                self._ignore = value
                already = set(value) & set(self._member_names)
                if already:
                    raise ValueError(
                            '_ignore_ cannot specify already set names: %r'
                            % (already, )
                            )
        elif _is_dunder(key):
            if key == '__order__':
                key = '_order_'
        elif key in self._member_names:
            raise TypeError('%r already defined as %r' % (key, self[key]))
        elif key in self._ignore:
            pass
        elif isinstance(value, nonmember):
            value = _nonmember_value(value)
        elif _is_descriptor(value):
            pass
        elif self._cls_name is not None and _is_internal_class(self._cls_name, value):
            pass
        else:
            if key in self:
                raise TypeError('%r already defined as %r' % (key, self[key]))
            elif isinstance(value, member):
                value = _member_value(value)
            non_auto_store = True
            if isinstance(value, auto):
                non_auto_store = False
                value = self._generate_next_value(
                        key, 1, len(self._member_names), self._last_values[:],
                        )
                self._auto_called = True
                self._last_values.append(value)
            self._member_names[key] = None
            if non_auto_store:
                self._last_values.append(value)
        super().__setitem__(key, value)

    @_builtin_property
    def member_names(self):
        return list(self._member_names)

    def update(self, members, **more_members):
        try:
            for name in members.keys():
                self[name] = members[name]
        except AttributeError:
            for name, value in members:
                self[name] = value
        for name, value in more_members.items():
            self[name] = value


_EnumDict = EnumDict


def pickle_by_global_name(self, proto):
    return self.name
_reduce_ex_by_global_name = pickle_by_global_name


def pickle_by_enum_name(self, proto):
    return getattr, (self.__class__, self._name_)


class FlagBoundary(StrEnum):
    """
    control how out of range values are handled
    "strict" -> error is raised             [default for Flag]
    "conform" -> extra bits are discarded
    "eject" -> lose flag status
    "keep" -> keep flag status and all bits [default for IntFlag]
    """
    STRICT = auto()
    CONFORM = auto()
    EJECT = auto()
    KEEP = auto()
STRICT, CONFORM, EJECT, KEEP = FlagBoundary
_set_class_attribute(Flag, '_boundary_', STRICT)
_set_class_attribute(IntFlag, '_boundary_', KEEP)


class EnumCheck(StrEnum):
    """
    various conditions to check an enumeration for
    """
    CONTINUOUS = "no skipped integer values"
    NAMED_FLAGS = "multi-flag aliases may not contain unnamed flags"
    UNIQUE = "one name per value"
CONTINUOUS, NAMED_FLAGS, UNIQUE = EnumCheck


class verify:
    """
    Check an enumeration for various constraints. (see EnumCheck)
    """
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


import builtins as bltns
import sys
from types import MappingProxyType


def bin(num, max_bits=None):
    """
    Like built-in bin(), except negative values are represented in
    twos-complement, and the leading bit always indicates sign
    (0=positive, 1=negative).

    >>> bin(10)
    '0b0 1010'
    >>> bin(~10)   # ~10 is -11
    '0b1 0101'
    """

    num = num.__index__()
    ceiling = 2 ** (num).bit_length()
    if num >= 0:
        s = bltns.bin(num + ceiling).replace('1', '0', 1)
    else:
        s = bltns.bin(~num ^ (ceiling - 1) + ceiling)
    sign = s[:3]
    digits = s[3:]
    if max_bits is not None:
        if len(digits) < max_bits:
            digits = (sign[-1] * max_bits + digits)[-max_bits:]
    return "%s %s" % (sign, digits)


def global_enum_repr(self):
    """
    use module.enum_name instead of class.enum_name

    the module is the last module in case of a multi-module name
    """
    module = self.__class__.__module__.split('.')[-1]
    return '%s.%s' % (module, self._name_)


def global_flag_repr(self):
    """
    use module.flag_name instead of class.flag_name

    the module is the last module in case of a multi-module name
    """
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
    """
    use enum_name instead of class.enum_name
    """
    if self._name_ is None:
        cls_name = self.__class__.__name__
        return "%s(%r)" % (cls_name, self._value_)
    else:
        return self._name_


del _set_class_attribute, _c_type_name, _handled_exception, _standard_stderr, _unsupported
`;

registerSourceModule(
  'enum',
  SOURCE,
  () =>
    new Map<string, PyValue>([
      ['EnumType', enumTypeClass],
      ['EnumMeta', enumTypeClass],
      ['Enum', enumClass],
      ['ReprEnum', reprEnumClass],
      ['IntEnum', intEnumClass],
      ['StrEnum', strEnumClass],
      ['Flag', flagClass],
      ['IntFlag', intFlagClass],
      ['auto', autoClass],
      ['member', memberClass],
      ['nonmember', nonmemberClass],
      ['unique', builtin('unique', 'one', 1, 1, ([cls]) => uniqueEnum(cls))],
      ['global_enum', builtin('global_enum', 'one', 1, 1, ([cls]) => globalEnum(cls))],
      [
        '_set_class_attribute',
        builtin('_set_class_attribute', 'expected', 3, 3, ([cls, name, value]) => {
          (cls as PyClass).dict.set(name as string, value);
          return None;
        }),
      ],
      ['_member_value', builtin('_member_value', 'one', 1, 1, ([value]) => (value as PyOpaque).data as PyValue)],
      ['_nonmember_value', builtin('_nonmember_value', 'one', 1, 1, ([value]) => (value as PyOpaque).data as PyValue)],
    ])
);
