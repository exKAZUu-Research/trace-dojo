# Slicing a range and slice.indices() resolve the bounds with exact integers, however large the length.
n = 9007199254740993
got = [range(n)[-1:], range(n)[-3::2], range(n)[::-1][:2], range(10 ** 30)[-5:-1:3], range(0, 10 ** 20, 7)[10 ** 18::-2][:3], range(5)[10 ** 30:], range(5)[-10 ** 30:2], slice(None).indices(n), slice(-1, None, -2).indices(10 ** 30), slice(10 ** 40, -10 ** 40, -1).indices(3), slice(None, None, 10 ** 25).indices(5)]
expected = [range(9007199254740992, 9007199254740993), range(9007199254740990, 9007199254740993, 2), range(9007199254740992, 9007199254740990, -1), range(999999999999999999999999999995, 999999999999999999999999999999, 3), range(7000000000000000000, 6999999999999999958, -14), range(5, 5), range(0, 2), (0, 9007199254740993, 1), (999999999999999999999999999999, -1, -2), (2, -1, -1), (0, 5, 10000000000000000000000000)]
if got != expected:
    raise AssertionError(got)
