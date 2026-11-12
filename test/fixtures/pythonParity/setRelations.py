def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))

a = {1, 2, 3}
b = {1, 2, 3, 4}
f = frozenset({3, 9})
check([a <= b, a < b, b <= a, b > a, a >= a, a > a, a == frozenset(a), a != b], [True, True, False, True, True, False, True, True])
check([a.issubset(b), b.issubset(a), a.issubset([3, 2, 1, 1]), a.issubset(range(3))], [True, False, True, False])
check([b.issuperset(a), a.issuperset(b), a.issuperset([1, 1]), a.issuperset(iter([4]))], [True, False, True, False])
check([a.isdisjoint(f), f.isdisjoint({9}), a.isdisjoint({7, 8, 9, 10}), set().isdisjoint(set()), a.isdisjoint([5, 6])], [False, False, True, True, True])
check([set().issubset(set()), set() <= a, a.isdisjoint(a), set().isdisjoint(set())], [True, True, False, True])
check([{1.0, 2} <= {1, 2}, {True} <= {1}, frozenset({0}).isdisjoint({0.0, -0.0})], [True, True, False])
d = {-1: 0, 2: 1}
e = dict.fromkeys(range(5))
check([d.keys().isdisjoint(set(range(100))), d.items().isdisjoint({(2, 1)}), d.keys().isdisjoint(e.keys()), d.items().isdisjoint(e.items())], [False, False, False, True])
check([{}.keys().isdisjoint(set()), d.keys().isdisjoint(d.keys()), d.keys().isdisjoint([3, 4]), d.items().isdisjoint({(-1, 0), 1, 2, 3})], [True, False, True, False])
