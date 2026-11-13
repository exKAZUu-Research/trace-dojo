# OrderedDict answers != as the negation of its order-sensitive ==, and compares with a plain dict ignoring order.
from collections import OrderedDict

x = OrderedDict(a=1, b=2)
y = OrderedDict(b=2, a=1)
moved = x.copy()
moved.move_to_end('a')
got = [x == y, x != y, x != dict(b=2, a=1), dict(b=2, a=1) != x, x != moved, x != x.copy(), x.__ne__(1), x != [1], y.__ne__(dict(a=1, b=2))]
if got != [False, True, False, False, True, False, NotImplemented, True, False]:
    raise AssertionError(got)
