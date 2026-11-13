import heapq
from itertools import islice
log = []
class V:
    def __init__(self, v):
        self.v = v
    def __lt__(self, other):
        log.append((self.v, other.v))
        return self.v < other.v
    def __repr__(self):
        return 'V(%d)' % self.v
data = [V(x) for x in [5, 1, 4, 1, 3, 9, 2, 6]]
got = [repr(heapq.nsmallest(3, data)), repr(heapq.nlargest(2, data)), len(log), heapq.nsmallest(1, [3, 1, 2]), heapq.nlargest(0, [1]), heapq.nsmallest(5, [2, 1]), heapq.nlargest(2, ['a', 'bb', 'c'], key=len)]
it = iter(range(10))
got.append([list(islice(it, 0, 5, 3)), next(it)])
it = iter(range(10))
got.append([list(islice(it, 0, 8, 3)), next(it)])
it = iter(range(10))
got.append([list(islice(it, 2, 4)), next(it), list(islice(it, 3)), next(it)])
expected = ['[V(1), V(1), V(2)]', '[V(9), V(6)]', 27, [1], [], [1, 2], ['bb', 'a'], [[0, 3], 5], [[0, 3, 6], 8], [[2, 3], 4, [5, 6, 7], 8]]
if got != expected:
    raise AssertionError(got)
