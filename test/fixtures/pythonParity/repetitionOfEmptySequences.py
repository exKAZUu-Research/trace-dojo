from collections import deque, UserList
def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))
def message(action):
    try:
        return repr(action())
    except OverflowError as e:
        return 'OverflowError: ' + str(e)
def repeated_in_place(value, count):
    value *= count
    return value
# Repeating nothing costs nothing, whatever the count.
for count in [10 ** 9, 10 ** 12, 2 ** 63 - 1]:
    for empty in [[], (), '', deque(), deque(maxlen=0), deque(maxlen=2), UserList()]:
        check(len(repeated_in_place(empty, count)), 0)
        check(len(empty * count), 0)
        check(len(count * empty), 0)
    check([].__imul__(count), [])
    check(deque([7], maxlen=3) * count, deque([7, 7, 7]))
    check(repeated_in_place(deque([7], maxlen=1), count), deque([7]))
OVERFLOW = "OverflowError: cannot fit 'int' into an index-sized integer"
for count in [2 ** 63, 10 ** 30, -(2 ** 63) - 1]:
    for value in [[], [1], (), (1, 2), '', 'ab', deque(), deque([1])]:
        check(message(lambda: repeated_in_place(value, count)), OVERFLOW)
        check(message(lambda: value * count), OVERFLOW)
for count in [-(10 ** 9), -(2 ** 63), 0, False]:
    for value in [[1], (1, 2), 'ab', deque([1, 2]), deque([1, 2, 3], maxlen=5)]:
        check(len(repeated_in_place(value, count)), 0)
        check(len(value * count), 0)
check(repeated_in_place(deque([1, 2, 3], maxlen=5), 2), deque([2, 3, 1, 2, 3]))
check(deque([1, 2, 3], maxlen=5) * 7, deque([2, 3, 1, 2, 3]))
check(deque([1, 2], maxlen=7) * 3, deque([1, 2, 1, 2, 1, 2]))
check(repeated_in_place(deque([1, 2, 3], maxlen=3), 4), deque([1, 2, 3]))
items = [1, 2]
alias = items
items *= 2
check(alias, [1, 2, 1, 2])
