from collections import deque

def check(call, expected):
    try:
        actual = repr(call())
    except Exception as e:
        actual = type(e).__name__ + ': ' + str(e)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

class I:
    def __index__(self):
        return 1

check(lambda: [1, 2, 3].index(2, None), 'TypeError: slice indices must be integers or have an __index__ method')
check(lambda: [1, 2, 3].index(2, 1.5), 'TypeError: slice indices must be integers or have an __index__ method')
check(lambda: (1, 2).index(1, 0, None), 'TypeError: slice indices must be integers or have an __index__ method')
check(lambda: deque([1, 2, 3]).index(1, None), 'TypeError: slice indices must be integers or have an __index__ method')
check(lambda: [1, 2, 3].index(2, -2), '1')
check(lambda: [1, 2, 3].index(3, 0, 2**70), '2')
check(lambda: [1, 2, 3].index(2, -2**70), '1')
check(lambda: [1].index(1, True), 'ValueError: list.index(x): x not in list')
check(lambda: [1, 2, 3].index(3, 0, -1), 'ValueError: list.index(x): x not in list')
check(lambda: [1, 2, 3].index(2, I()), '1')
check(lambda: (1, 2, 3).index(3, -1, 99), '2')
check(lambda: deque([1, 2, 3]).index(3, -1), '2')
check(lambda: [1, 2].index(2, '1'), 'TypeError: slice indices must be integers or have an __index__ method')
check(lambda: 'abc'.index('b', None), '1')
check(lambda: [1, 2, 3].index(1, 5, 2), 'ValueError: list.index(x): x not in list')
