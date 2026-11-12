# sum compensates float and complex totals as builtin_sum_impl does, moving on to complex totals after floats.
got = [sum([0.1] * 10 + [0.1j] * 10), sum([0.1j] * 10), sum([0.1 + 0.1j] * 10), sum([0.1j] * 10, 0.0), sum([1, 0.1j] + [0.1j] * 9), sum([0.1 + 0.1j] * 10, 0j), sum([0.1j, 0.1] * 10), sum([0.1j] * 5 + [10 ** 30] + [0.1j] * 5), sum([0.1j] * 5 + [True] + [0.1j] * 5), sum([float(10 ** 100), 1j, -float(10 ** 100), 1.0])]
expected = [1 + 1j, 1j, 1 + 1j, 1j, 1 + 1j, 1 + 1j, 1 + 1j, float(10 ** 30) + 1j, 1 + 1j, 1 + 1j]
try:
    sum([1j, 10 ** 400])
except OverflowError as error:
    got.append(str(error))
expected.append('int too large to convert to float')
# A frozenset keeps its hash, which equal frozensets share.
s = frozenset(range(10000))
d = {s: 1}
got += [d[frozenset(range(10000))], hash(frozenset([1, 2])) == hash(frozenset([2, 1])), hash(frozenset([1, 2, 3])) == hash(frozenset([1, 2, 3]))]
expected += [1, True, True]
if got != expected or [repr(v) for v in got[:3]] != ['(1+1j)', '1j', '(1+1j)']:
    raise AssertionError(got)
