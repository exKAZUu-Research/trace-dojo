from collections import deque, Counter, OrderedDict
import itertools
import math
def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))
# A container finds an object by identity before it asks ==, so a NaN is found through the object that was stored.
for v in [float('nan'), math.nan, math.inf - math.inf]:
    check(v == v, False)
    check(v != v, True)
    check([v in [v], v in (v,), v in deque([v]), v in {v}, v in frozenset([v]), v in {v: 1}], [True] * 6)
    check([v in {v: 1}.keys(), (v, 1) in {v: 1}.items(), v in {1: v}.values()], [True] * 3)
    check([[v].index(v), (v,).index(v), deque([v]).index(v)], [0, 0, 0])
    check([[v, 1, v].count(v), (v, v).count(v), deque([v]).count(v)], [2, 2, 1])
    check([{v: 1}[v], {v: 1}.get(v), {v: 1}.pop(v)], [1, 1, 1])
    check([len({v, v}), len({v: 1, v: 2}), len(set([v, v, 1.0])), len(Counter([v, v]))], [1, 1, 2, 1])
    check([[v] == [v], (v,) == (v,), {v} == {v}, {v: 1} == {v: 1}, {1: v} == {1: v}], [True] * 5)
    check([deque([v]) == deque([v]), OrderedDict([(v, 1)]) == OrderedDict([(v, 1)]), [[v]] == [[v]]], [True] * 3)
    check([[v] != [v], [v] < [v], [v] <= [v], (v, 1) < (v, 2), [v] == [0.0], 0.0 in [v]], [False, False, True, True, False, False])
    items = [1, v, 2]
    items.remove(v)
    check(items, [1, 2])
    queue = deque([1, v, 2])
    queue.remove(v)
    check(list(queue), [1, 2])
    numbers = {v, 1}
    numbers.remove(v)
    check(numbers, {1})
    table = {v: 1}
    table[v] = 5
    check(list(table.values()), [5])
    del table[v]
    check(table, {})
    check(len(list(itertools.groupby([v, v, 1]))), 2)
    check([{v}.issubset({v}), len({v} & {v}), len({v} - {v}), len({v} | {v})], [True, 1, 0, 1])
    matched = 'no'
    match v:
        case math.nan:
            matched = 'yes'
    check(matched, 'no')
