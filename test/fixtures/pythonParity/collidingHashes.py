import math
import statistics

# Multiples of 2**61 - 1 all hash to 0.
a = [i * 2305843009213693951 for i in range(300)]
d = dict.fromkeys(a)
s = set(a)
results = [len(d), len(s), a[7] in s, a[299] in d, 5 in s, -1 in s, -2 in s, len({-1, -2}), {-1: 1, -2: 2}[-2]]
if results != [300, 300, True, True, False, False, False, 2, 2]:
    raise AssertionError(repr(results))
if statistics.mode(a + [a[5]]) != a[5]:
    raise AssertionError('mode')
s.discard(a[3])
d.pop(a[4])
if [a[3] in s, a[4] in d, len(s), len(d), list(d)[4] == a[5]] != [False, False, 299, 299, True]:
    raise AssertionError('after removal')

big = 3**2000 * 12345
if [math.gcd(big, 7**1100 * 12345), math.gcd(-big, 0), math.gcd(2**70, 2**69 * 3) == 2**69] != [12345, big, True]:
    raise AssertionError('gcd')
if [math.lcm(2**400, 6**300) == 2**400 * 3**300, math.lcm(big, 0), math.lcm(-(2**70), 3)] != [True, 0, 3 * 2**70]:
    raise AssertionError('lcm')
