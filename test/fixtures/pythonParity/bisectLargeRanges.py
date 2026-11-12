# Searching a lazy range keeps its bounds exact, however close they come to the largest index.
import bisect

n = 4503599627370500
m = 9007199254740991
results = [bisect.bisect_left(range(n), n - 1), bisect.bisect_right(range(n), n - 1), bisect.bisect_left(range(m), m - 1), bisect.bisect_right(range(2 ** 62), 2 ** 61 + 7), bisect.bisect_left(range(0, 2 ** 62, 3), 2 ** 61)]
calls = []


class Index:
    def __init__(self, value):
        self.value = value

    def __index__(self):
        calls.append(self.value)
        return self.value


a = [1, 3, 5, 7]
results.append(bisect.bisect_left(a, 4, Index(0), Index(4)))
bisect.insort(a, 4, Index(1), Index(4))
results += [a, calls]
for call in [lambda: bisect.bisect_left([1], 1, 2 ** 63), lambda: bisect.bisect_left([1], 1, 0, 2 ** 63), lambda: bisect.bisect_left(range(2 ** 63), 1)]:
    try:
        call()
    except OverflowError as error:
        results.append(str(error))
expected = [4503599627370499, 4503599627370500, 9007199254740990, 2305843009213693960, 768614336404564651, 2, [1, 3, 4, 5, 7], [0, 4, 1, 4], 'Python int too large to convert to C ssize_t', "cannot fit 'int' into an index-sized integer", 'Python int too large to convert to C ssize_t']
if results != expected:
    raise AssertionError(results)
