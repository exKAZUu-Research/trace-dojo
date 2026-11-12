import itertools


def then_fail():
    yield 1
    raise ValueError('read past the common item')


d = {1: 2, 3: 4}
results = [
    d.keys().isdisjoint(then_fail()),
    d.items().isdisjoint(itertools.repeat((1, 2))),
    d.keys().isdisjoint(itertools.count()),
    d.keys().isdisjoint([5, 6]),
    d.items().isdisjoint([(1, 3), (3, 2)]),
    d.keys().isdisjoint(d.keys()),
    {}.keys().isdisjoint({}.keys()),
    d.keys().isdisjoint({3}),
    d.keys().isdisjoint(''),
]
if results != [False, False, False, True, True, False, True, False, True]:
    raise AssertionError(repr(results))

try:
    d.keys().isdisjoint(5)
    raise AssertionError('isdisjoint(5) did not raise')
except TypeError as error:
    if str(error) != "'int' object is not iterable":
        raise AssertionError(str(error))
try:
    d.keys().isdisjoint([[]])
    raise AssertionError('isdisjoint([[]]) did not raise')
except TypeError as error:
    if str(error) != "cannot use 'list' as a dict key (unhashable type: 'list')":
        raise AssertionError(str(error))
