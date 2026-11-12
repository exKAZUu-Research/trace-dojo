from functools import total_ordering
class A:
    def __lt__(self, other):
        return True
    def __eq__(self, other):
        return False
@total_ordering
class B(A):
    pass
class C:
    def __le__(self, other):
        return False
@total_ordering
class D(C):
    def __lt__(self, other):
        return True
@total_ordering
class V:
    def __init__(self, v):
        self.v = v
    def __eq__(self, other):
        return self.v == other.v
    def __gt__(self, other):
        return self.v > other.v
got = [B() < B(), B() > B(), D() <= D(), V(1) < V(2), V(2) <= V(2), V(3) >= V(2), V.__lt__.__name__, V.__lt__.__doc__]
try:
    @total_ordering
    class E:
        pass
except ValueError as e:
    got.append(str(e))
if got != [True, False, False, True, True, True, '__lt__', 'Return a < b.  Computed by @total_ordering from (not a > b) and (a != b).', 'must define at least one ordering operation: < > <= >=']:
    raise AssertionError(got)
