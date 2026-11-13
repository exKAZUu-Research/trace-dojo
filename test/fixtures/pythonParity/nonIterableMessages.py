import functools
def message(action):
    try:
        return action()
    except TypeError as e:
        return 'TypeError: ' + str(e)
def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))
class NoIter:
    __iter__ = None
class BadIter:
    def __iter__(self):
        return 5
class RaisingIter:
    def __iter__(self):
        raise TypeError('mine')
class RaisingNext:
    def __iter__(self):
        return self
    def __next__(self):
        raise TypeError('next')
class Items:
    def __getitem__(self, index):
        if index > 1:
            raise IndexError
        return 'x'
def assign_slice(value):
    items = [1, 2, 3]
    items[0:1] = value
    return items
def assign_extended_slice(value):
    items = [1, 2, 3]
    items[::2] = value
    return items
not_iterable = [1, 1.5, None, NoIter(), BadIter(), RaisingIter(), len, int]
for value in not_iterable:
    check(message(lambda: ','.join(value)), 'TypeError: can only join an iterable')
    check(message(lambda: str.join(',', value)), 'TypeError: can only join an iterable')
    check(message(lambda: assign_slice(value)), 'TypeError: must assign iterable to extended slice')
    check(message(lambda: assign_extended_slice(value)), 'TypeError: must assign iterable to extended slice')
    check(message(lambda: functools.reduce(max, value)), 'TypeError: reduce() arg 2 must support iteration')
    check(
        message(lambda: 1 in value),
        "TypeError: argument of type '" + type(value).__name__ + "' is not a container or iterable",
    )
check(message(lambda: ','.join(RaisingNext())), 'TypeError: next')
check(message(lambda: assign_slice(RaisingNext())), 'TypeError: next')
check(message(lambda: functools.reduce(max, RaisingNext())), 'TypeError: next')
check(message(lambda: 1 in RaisingNext()), 'TypeError: next')
check(','.join(Items()), 'x,x')
check(assign_slice(Items()), ['x', 'x', 2, 3])
check(assign_extended_slice(Items()), ['x', 2, 'x'])
check('x' in Items(), True)
check(message(lambda: ','.join(['a', 1])), 'TypeError: sequence item 1: expected str instance, int found')
check(message(lambda: list(1)), "TypeError: 'int' object is not iterable")
