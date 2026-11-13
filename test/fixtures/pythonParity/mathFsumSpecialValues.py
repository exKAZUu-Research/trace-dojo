def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

import math

inf = float('inf')
nan = float('nan')
big = float('1.7976931348623157e308')

check(lambda: math.fsum([-0.0]), '0.0')
check(lambda: math.fsum([-0.0, -0.0]), '0.0')
check(lambda: math.fsum([]), '0.0')
check(lambda: math.fsum([0.0, -0.0]), '0.0')
check(lambda: math.fsum([-1.0, 1.0]), '0.0')
check(lambda: math.copysign(1.0, math.fsum([-0.0])), '1.0')
check(lambda: math.fsum([nan, inf, -inf]), 'ValueError: -inf + inf in fsum')
check(lambda: math.fsum([inf, -inf, nan]), 'ValueError: -inf + inf in fsum')
check(lambda: math.fsum([inf, nan]), 'nan')
check(lambda: math.fsum([inf, inf]), 'inf')
check(lambda: math.fsum([-inf, 1.0]), '-inf')
check(lambda: math.fsum([big, big, -big]), 'OverflowError: intermediate overflow in fsum')
check(lambda: math.fsum([inf, big, big]), 'OverflowError: intermediate overflow in fsum')
check(lambda: math.fsum([big, float("1e292")]), 'OverflowError: intermediate overflow in fsum')
check(lambda: math.fsum([1, 2**1023, -2**1023]), '1.0')
check(lambda: math.fsum([float("1e-16"), 1.0, float("1e16")]), '1.0000000000000002e+16')
check(lambda: math.fsum([0.1] * 10), '1.0')
check(lambda: math.fsum([inf, -inf, "x"]), 'TypeError: must be real number, not str')
check(lambda: math.fsum([2**1024]), 'OverflowError: int too large to convert to float')
check(lambda: math.fsum(iter([1.5, 2, True])), '4.5')
