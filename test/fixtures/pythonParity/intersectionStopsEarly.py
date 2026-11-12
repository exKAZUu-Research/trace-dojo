# Intersecting a set with an iterable stops reading once every element of the set has been found.
import itertools

consumed = []


def gen():
    for i in range(10):
        consumed.append(i)
        yield i


s = {3, 4}
s.intersection_update(itertools.count())
got = [{1, 2}.intersection(itertools.count(1)), frozenset({1}).intersection(itertools.count()), s, {1, 2}.intersection(gen()), list(consumed), set().intersection(gen()), len(consumed)]
if got != [{1, 2}, frozenset({1}), {3, 4}, {1, 2}, [0, 1, 2], set(), 13]:
    raise AssertionError(got)
