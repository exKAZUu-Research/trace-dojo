# An Enum class refuses deleting or rebinding a member, found in its _member_map_; most_common picks as CPython does.
import enum
from collections import Counter


class Q(enum.Enum):
    A = 1
    B = 2


class I(enum.IntEnum):
    X = 1


got = []
for call in [lambda: delattr(Q, 'A'), lambda: delattr(Q, 'nope'), lambda: delattr(I, 'X')]:
    try:
        call()
    except AttributeError as error:
        got.append(str(error))
got += [hasattr(Q, 'A'), list(Q)]
del Q.A._name_
try:
    Q.A = 9
except AttributeError as error:
    got.append(str(error))
Q.extra = 1
del Q.extra
got.append(hasattr(Q, 'extra'))
c = Counter('abracadabra')
got += [c.most_common(0), c.most_common(-1), c.most_common(1), c.most_common(2), c.most_common(), Counter().most_common(1), repr(c)]
expected = ["'Q' cannot delete member 'A'.", "type object 'Q' has no attribute 'nope'", "'I' cannot delete member 'X'.", True, [Q.A, Q.B], "cannot reassign member 'A'", False, [], [], [('a', 5)], [('a', 5), ('b', 2)], [('a', 5), ('b', 2), ('r', 2), ('c', 1), ('d', 1)], [], "Counter({'a': 5, 'b': 2, 'r': 2, 'c': 1, 'd': 1})"]
if got != expected:
    raise AssertionError(got)
