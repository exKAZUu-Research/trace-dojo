# copy and deepcopy rebuild a namedtuple or its subclass from __getnewargs__ and then copy its __dict__, as
# copy._reconstruct does.
import copy
from collections import namedtuple

Base = namedtuple('Base', 'x')


class Point(Base):
    pass


b = Base([1])
p = Point([1])
p.label = ['A']
q = copy.copy(p)
d = copy.deepcopy(p)
q.label = ['B']
r = Point([])
r.x.append(r)
r.me = r
e = copy.deepcopy(r)
got = [copy.copy(b) is b, copy.deepcopy(b) is b, copy.deepcopy(b).x is b.x, copy.copy(b).x is b.x, q is p, type(q).__name__, d.label is p.label, d.x is p.x, d.label, p.label, q.label, copy.copy((1, 2)) == (1, 2), e.me is e, e.x[0] is e, e is r]
expected = [False, False, False, True, False, 'Point', False, False, ['A'], ['A'], ['B'], True, False, False, False]
if got != expected:
    raise AssertionError(got)
