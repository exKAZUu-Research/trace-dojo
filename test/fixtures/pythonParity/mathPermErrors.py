import math

def check(call, expected):
    try:
        actual = repr(call())
    except Exception as e:
        actual = type(e).__name__ + ': ' + str(e)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

check(lambda: math.perm(-1), 'ValueError: factorial() not defined for negative values')
check(lambda: math.perm(-5), 'ValueError: factorial() not defined for negative values')
check(lambda: math.perm(-1, None), 'ValueError: factorial() not defined for negative values')
check(lambda: math.perm(-1, 2), 'ValueError: n must be a non-negative integer')
check(lambda: math.comb(-1, 1), 'ValueError: n must be a non-negative integer')
check(lambda: math.perm(5, -1), 'ValueError: k must be a non-negative integer')
check(lambda: math.perm(0), '1')
check(lambda: math.perm(4), '24')
check(lambda: math.perm(4, 2), '12')
check(lambda: math.perm(2.0), "TypeError: 'float' object cannot be interpreted as an integer")
check(lambda: math.perm(True), '1')
