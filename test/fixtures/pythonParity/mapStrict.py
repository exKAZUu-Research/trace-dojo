def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)


def add(*numbers):
    return sum(numbers)


check(lambda: list(map(add, [1, 2], [3], strict=True)), 'ValueError: map() argument 2 is shorter than argument 1')
check(lambda: list(map(add, [1], [3, 4], strict=True)), 'ValueError: map() argument 2 is longer than argument 1')
check(lambda: list(map(add, [1], [3], [5, 6], strict=True)), 'ValueError: map() argument 3 is longer than arguments 1-2')
check(lambda: list(map(add, [1, 2], [3, 4], [5], strict=True)), 'ValueError: map() argument 3 is shorter than arguments 1-2')
check(lambda: list(map(add, [1, 2], [3], [5], strict=True)), 'ValueError: map() argument 2 is shorter than argument 1')
check(lambda: list(map(add, [], [3], strict=True)), 'ValueError: map() argument 2 is longer than argument 1')
check(lambda: list(map(add, [], [], [3], strict=True)), 'ValueError: map() argument 3 is longer than arguments 1-2')
check(lambda: list(map(add, [1, 2], [3, 4], strict=True)), '[4, 6]')
check(lambda: list(map(add, [1, 2], strict=True)), '[1, 2]')
check(lambda: list(map(add, [1, 2], [3], strict=False)), '[4]')
check(lambda: list(map(add, [1, 2], [3])), '[4]')
check(lambda: list(map(add, [1, 2], [3], strict=1)), 'ValueError: map() argument 2 is shorter than argument 1')
check(lambda: list(map(add, [1], x=True)), "TypeError: map() got an unexpected keyword argument 'x'")
check(lambda: list(map(add, strict=True)), 'TypeError: map() must have at least two arguments.')

pairs = map(add, [1, 2], [3], strict=True)
check(lambda: next(pairs), '4')
check(lambda: next(pairs), 'ValueError: map() argument 2 is shorter than argument 1')
check(lambda: list(zip([1], [3], [4, 5], strict=True)), 'ValueError: zip() argument 3 is longer than arguments 1-2')
