from collections import defaultdict


def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)


class RaisingIter:
    def __iter__(self):
        raise ValueError('boom')


class RaisingNext:
    def __iter__(self):
        return self

    def __next__(self):
        raise KeyError('k')


class TypeErrorIter:
    def __iter__(self):
        raise TypeError('mine')


def late():
    yield 1
    raise ValueError('late')


def pairs():
    yield (1, 2)
    raise ValueError('outer')


check(lambda: dict([RaisingIter()]), 'ValueError: boom')
check(lambda: dict([RaisingNext()]), "KeyError: 'k'")
check(lambda: dict([TypeErrorIter()]), 'TypeError: object is not iterable')
check(lambda: dict([late()]), 'ValueError: late')
check(lambda: dict(pairs()), 'ValueError: outer')
check(lambda: {}.update([RaisingIter()]), 'ValueError: boom')
check(lambda: defaultdict(int, [RaisingIter()]), 'ValueError: boom')
check(lambda: dict([1]), 'TypeError: object is not iterable')
check(lambda: dict([(1, 2), 3]), 'TypeError: object is not iterable')
check(lambda: dict([None]), 'TypeError: object is not iterable')
check(lambda: {}.update([[1, 2], 7]), 'TypeError: object is not iterable')
check(lambda: dict(5), "TypeError: 'int' object is not iterable")
check(lambda: dict([(1, 2, 3)]), 'ValueError: dictionary update sequence element #0 has length 3; 2 is required')
check(lambda: dict(['ab', 'c']), 'ValueError: dictionary update sequence element #1 has length 1; 2 is required')
check(lambda: dict([iter([1, 2, 3])]), 'ValueError: dictionary update sequence element #0 has length 3; 2 is required')
check(lambda: dict([iter([1, 2]), {1: 2, 3: 4}, 'ab']), "{1: 3, 'a': 'b'}")
