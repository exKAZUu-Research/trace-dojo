def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

import itertools
from collections import Counter, deque


class Pair:
    def __iter__(self):
        return iter([1, 2])


def reversed_after_append():
    d = deque([1, 2, 3])
    r = reversed(d)
    first = next(r)
    d.append(4)
    return first, next(r)


def reversed_exhausted_then_appended():
    d = deque([1, 2])
    r = reversed(d)
    items = list(r)
    d.append(3)
    return items, list(r)


def cycle_items():
    c = itertools.cycle(Pair())
    return [next(c) for i in range(5)]

check(lambda: cycle_items(), '[1, 2, 1, 2, 1]')
check(lambda: list(itertools.product(Pair(), "ab")), "[(1, 'a'), (1, 'b'), (2, 'a'), (2, 'b')]")
check(lambda: list(itertools.permutations(Pair())), '[(1, 2), (2, 1)]')
check(lambda: list(itertools.combinations(range(4), 3)), '[(0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)]')
check(lambda: list(itertools.combinations_with_replacement("ab", 2)), "[('a', 'a'), ('a', 'b'), ('b', 'b')]")
check(lambda: list(itertools.chain.from_iterable([Pair(), "xy"])), "[1, 2, 'x', 'y']")
check(lambda: list(itertools.pairwise(Pair())), '[(1, 2)]')
check(lambda: list(itertools.zip_longest(Pair(), "abc")), "[(1, 'a'), (2, 'b'), (None, 'c')]")
check(lambda: list(enumerate(Pair())), '[(0, 1), (1, 2)]')
check(lambda: list(map(str, Pair())), "['1', '2']")
check(lambda: list(filter(None, Pair())), '[1, 2]')
check(lambda: list(zip(Pair(), Pair())), '[(1, 1), (2, 2)]')
check(lambda: list(itertools.islice(Pair(), 1, None)), '[2]')
check(lambda: list(itertools.starmap(max, [Pair()])), '[2]')
check(lambda: list(itertools.accumulate(Pair())), '[1, 3]')
check(lambda: list(itertools.compress(Pair(), Pair())), '[1, 2]')
check(lambda: list(itertools.batched(Pair(), 1)), '[(1,), (2,)]')
check(lambda: [list(t) for t in itertools.tee(Pair())], '[[1, 2], [1, 2]]')
check(lambda: reversed_after_append(), 'RuntimeError: deque mutated during iteration')
check(lambda: reversed_exhausted_then_appended(), '([2, 1], [])')
check(lambda: list(reversed({1: 2, 3: 4})), '[3, 1]')
check(lambda: list(reversed({1: 2}.items())), '[(1, 2)]')
check(lambda: list(Counter("abca").elements()), "['a', 'a', 'b', 'c']")
check(lambda: [(k, list(g)) for k, g in itertools.groupby(Pair())], '[(1, [1]), (2, [2])]')
