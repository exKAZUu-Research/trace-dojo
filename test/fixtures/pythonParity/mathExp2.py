def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

import math

check(lambda: math.exp2(-0.5), '0.7071067811865476')
check(lambda: math.exp2(0.5), '1.4142135623730951')
check(lambda: math.exp2(12.889366648039484), '7587.277810328252')
check(lambda: math.exp2(3), '8.0')
check(lambda: math.exp2(-1074.5), '5e-324')
check(lambda: math.exp2(1023.9), '1.6773070034857416e+308')
check(lambda: math.exp2(1024), 'OverflowError: math range error')
check(lambda: math.exp2(0.1), '1.0717734625362931')
check(lambda: math.exp2(-7.25), '0.0065695032441696445')
