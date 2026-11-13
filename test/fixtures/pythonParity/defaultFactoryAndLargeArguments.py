from collections import defaultdict, deque
d = defaultdict(list)
d.default_factory = int
got = [d['m']]
d.default_factory = None
try:
    d['x']
except KeyError as e:
    got.append(repr(e))
d.default_factory = 5
got.append(d.default_factory)
try:
    d['y']
except TypeError as e:
    got.append(str(e))
del d.default_factory
got.append(d.default_factory)
got.append(type(defaultdict.__dict__['default_factory']).__name__)
q = deque(range(10))
q.rotate(3)
got.append(list(q))
q.rotate(-4)
got.append(list(q))
big = deque([1] * 200000)
big.rotate(100000)
got.append([len(big), big[0]])
def f(*args):
    return len(args)
got.append(f(*([0] * 200000)))
expected = [0, "KeyError('x')", 5, "'int' object is not callable", None, 'member_descriptor', [7, 8, 9, 0, 1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6, 7, 8, 9, 0], [200000, 1], 200000]
if got != expected:
    raise AssertionError(got)
