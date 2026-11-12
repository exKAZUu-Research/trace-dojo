def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

import math
import operator
from enum import Enum, Flag, IntEnum, IntFlag


class Color(Enum):
    RED = 1


class Perm(Flag):
    R = 4


class Size(IntEnum):
    BIG = 3


class Mode(IntFlag):
    X = 2


class Truncating:
    def __trunc__(self):
        return 3


class Indexed:
    def __index__(self):
        return 7


class Floating:
    def __float__(self):
        return 2.5

check(lambda: int(Color.RED), "TypeError: int() argument must be a string, a bytes-like object or a real number, not 'Color'")
check(lambda: float(Color.RED), "TypeError: float() argument must be a string or a real number, not 'Color'")
check(lambda: complex(Color.RED), 'TypeError: complex() argument must be a string or a number, not Color')
check(lambda: operator.index(Color.RED), "TypeError: 'Color' object cannot be interpreted as an integer")
check(lambda: math.floor(Color.RED), 'TypeError: must be real number, not Color')
check(lambda: '%d' % Color.RED, 'TypeError: %d format: a real number is required, not Color')
check(lambda: '%f' % Color.RED, 'TypeError: must be real number, not Color')
check(lambda: '%x' % Color.RED, 'TypeError: %x format: an integer is required, not Color')
check(lambda: int(Perm.R), "TypeError: int() argument must be a string, a bytes-like object or a real number, not 'Perm'")
check(lambda: float(Perm.R), "TypeError: float() argument must be a string or a real number, not 'Perm'")
check(lambda: complex(Perm.R), 'TypeError: complex() argument must be a string or a number, not Perm')
check(lambda: operator.index(Perm.R), "TypeError: 'Perm' object cannot be interpreted as an integer")
check(lambda: math.floor(Perm.R), 'TypeError: must be real number, not Perm')
check(lambda: '%d' % Perm.R, 'TypeError: %d format: a real number is required, not Perm')
check(lambda: '%f' % Perm.R, 'TypeError: must be real number, not Perm')
check(lambda: '%x' % Perm.R, 'TypeError: %x format: an integer is required, not Perm')
check(lambda: int(Size.BIG), '3')
check(lambda: float(Size.BIG), '3.0')
check(lambda: complex(Size.BIG), '(3+0j)')
check(lambda: operator.index(Size.BIG), '3')
check(lambda: math.floor(Size.BIG), '3')
check(lambda: '%d' % Size.BIG, "'3'")
check(lambda: '%f' % Size.BIG, "'3.000000'")
check(lambda: '%x' % Size.BIG, "'3'")
check(lambda: int(Mode.X), '2')
check(lambda: float(Mode.X), '2.0')
check(lambda: complex(Mode.X), '(2+0j)')
check(lambda: operator.index(Mode.X), '2')
check(lambda: math.floor(Mode.X), '2')
check(lambda: '%d' % Mode.X, "'2'")
check(lambda: '%f' % Mode.X, "'2.000000'")
check(lambda: '%x' % Mode.X, "'2'")
check(lambda: int(Truncating()), "TypeError: int() argument must be a string, a bytes-like object or a real number, not 'Truncating'")
check(lambda: '%d' % Truncating(), 'TypeError: %d format: a real number is required, not Truncating')
check(lambda: '%d' % Indexed(), "'7'")
check(lambda: '%x' % Indexed(), "'7'")
check(lambda: '%f' % Indexed(), "'7.000000'")
check(lambda: '%d' % Floating(), 'TypeError: %d format: a real number is required, not Floating')
check(lambda: '%x' % Floating(), 'TypeError: %x format: an integer is required, not Floating')
check(lambda: '%f' % Floating(), "'2.500000'")
check(lambda: '%d' % 3.7, "'3'")
check(lambda: '%x' % 3.7, 'TypeError: %x format: an integer is required, not float')
check(lambda: '%d' % 1j, 'TypeError: %d format: a real number is required, not complex')
check(lambda: '%f' % 1j, 'TypeError: must be real number, not complex')
check(lambda: '%d' % '5', 'TypeError: %d format: a real number is required, not str')
check(lambda: '%f' % '5', 'TypeError: must be real number, not str')
check(lambda: '%d' % None, 'TypeError: %d format: a real number is required, not NoneType')
check(lambda: '%f' % (1 << 2000), 'OverflowError: int too large to convert to float')
check(lambda: '%d' % float('nan'), 'ValueError: cannot convert float NaN to integer')
check(lambda: '%o' % True, "'1'")
check(lambda: '%e' % Indexed(), "'7.000000e+00'")
