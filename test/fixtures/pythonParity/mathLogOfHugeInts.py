def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

import math

check(lambda: math.log2(2**2000), '2000.0')
check(lambda: math.log10(10**400), '400.0')
check(lambda: math.log(10**400), '921.0340371976182')
check(lambda: math.log(3**1000), '1098.6122886681096')
check(lambda: math.log10(7**900), '760.5882360128312')
check(lambda: math.log2(3**1500), '2377.4437510817343')
check(lambda: math.log(10**400, 10), '399.99999999999994')
check(lambda: math.log(2**1100-1), '762.4618986159398')
check(lambda: math.log2(2**1024-1), '1024.0')
check(lambda: math.log10(2**1023), '307.95368556425274')
check(lambda: math.log(5**600, 7**500), '0.9925049704162994')
check(lambda: math.log(2**1024 - 2**970), '709.782712893384')
