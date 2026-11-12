# math.trunc truncates ints and floats and leaves anything else to its __trunc__, as math_trunc does.
import math


class Idx:
    def __index__(self): return 9
class Flt:
    def __float__(self): return 2.5
class T:
    def __trunc__(self): return 'custom'
got = []
for v in ['x', Idx(), Flt(), 1j, None, 3.9, -3.9, True, 10**30, float(10 ** 300), float('nan'), float('inf'), T()]:
    try:
        got.append(repr(math.trunc(v)))
    except (TypeError, ValueError, OverflowError) as error:
        got.append(type(error).__name__ + ': ' + str(error))

if got != ["TypeError: type str doesn't define __trunc__ method", "TypeError: type Idx doesn't define __trunc__ method", "TypeError: type Flt doesn't define __trunc__ method", "TypeError: type complex doesn't define __trunc__ method", "TypeError: type NoneType doesn't define __trunc__ method", '3', '-3', '1', '1000000000000000000000000000000', '1000000000000000052504760255204420248704468581108159154915854115511802457988908195786371375080447864043704443832883878176942523235360430575644792184786706982848387200926575803737830233794788090059368953234970799945081119038967640880074652742780142494579258788820056842838115669472196386865459400540160', 'ValueError: cannot convert float NaN to integer', 'OverflowError: cannot convert float infinity to integer', "'custom'"]:
    raise AssertionError(got)
