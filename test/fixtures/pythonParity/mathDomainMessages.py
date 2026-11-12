import math


def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)


inf = float('inf')
check(lambda: math.log(-2), 'ValueError: expected a positive input')
check(lambda: math.log(0), 'ValueError: expected a positive input')
check(lambda: math.log(False), 'ValueError: expected a positive input')
check(lambda: math.log(-(10**400)), 'ValueError: expected a positive input')
check(lambda: math.log2(-(10**400)), 'ValueError: expected a positive input')
check(lambda: math.log(-2.5), 'ValueError: expected a positive input, got -2.5')
check(lambda: math.log(0.0), 'ValueError: expected a positive input, got 0.0')
check(lambda: math.log(-0.0), 'ValueError: expected a positive input, got -0.0')
check(lambda: math.log(-inf), 'ValueError: expected a positive input, got -inf')
check(lambda: math.log(-731.2715117751975), 'ValueError: expected a positive input, got -731.2715117751975')
check(lambda: math.log2(-2.0), 'ValueError: expected a positive input, got -2.0')
check(lambda: math.log2(0), 'ValueError: expected a positive input')
check(lambda: math.log10(-2.5), 'ValueError: expected a positive input, got -2.5')
check(lambda: math.log10(0.0), 'ValueError: expected a positive input, got 0.0')
check(lambda: math.log10(-inf), 'ValueError: expected a positive input, got -inf')
check(lambda: math.log(2, -1.5), 'ValueError: expected a positive input, got -1.5')
check(lambda: math.log(2, 0), 'ValueError: expected a positive input')
check(lambda: math.log(-2.5, 0), 'ValueError: expected a positive input, got -2.5')
check(lambda: math.log(2, 1), 'ZeroDivisionError: division by zero')
check(lambda: math.log(float('nan')), 'nan')
check(lambda: math.log(10**400), '921.0340371976182')
check(lambda: math.log1p(-1.0), 'ValueError: expected argument value > -1, got -1.0')
check(lambda: math.sin(inf), 'ValueError: expected a finite input, got inf')
check(lambda: math.cos(-inf), 'ValueError: expected a finite input, got -inf')
check(lambda: math.tan(inf), 'ValueError: expected a finite input, got inf')
check(lambda: math.sin(float('nan')), 'nan')
check(lambda: math.sqrt(-inf), 'ValueError: expected a nonnegative input, got -inf')
check(lambda: math.fmod(inf, 1), 'ValueError: math domain error')
