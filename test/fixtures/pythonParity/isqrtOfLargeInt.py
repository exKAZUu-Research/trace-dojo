import math
if math.isqrt(10 ** 1000) != 10 ** 500:
    raise AssertionError("isqrt of a 3322-bit int")
if [math.isqrt(n) for n in (0, 1, 3, 4, 2 ** 106 - 1, 10 ** 30)] != [0, 1, 1, 2, 9007199254740991, 10 ** 15]:
    raise AssertionError("isqrt")
