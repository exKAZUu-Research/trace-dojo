# len() is exact up to Py_ssize_t, for ranges and for __len__, and the functions built on it use the exact length.
import operator
import random


class Sized:
    def __init__(self, value):
        self.value = value

    def __len__(self):
        return self.value

    def __getitem__(self, index):
        if index == 9007199254740992:
            return 'last'
        raise IndexError(index)


class Index:
    def __index__(self):
        return 3


got = [len(range(9007199254740993)), len(range(2 ** 63 - 1)), len(Sized(9007199254740993)), len(Sized(True)), len(Sized(Index())), bool(Sized(2 ** 63 - 1)), next(reversed(Sized(9007199254740993))), operator.length_hint(range(9007199254740993))]
for call in [lambda: len(Sized(2 ** 63)), lambda: len(Sized(-1)), lambda: len(Sized(1.5)), lambda: len(range(2 ** 63)), lambda: bool(Sized(2 ** 63))]:
    try:
        call()
    except (OverflowError, ValueError, TypeError) as error:
        got.append(type(error).__name__ + ': ' + str(error))
random.seed(5)
got += [random.choice(range(2 ** 60)), random.sample(range(2 ** 60), 3)]
expected = [9007199254740993, 9223372036854775807, 9007199254740993, 1, 3, True, 'last', 9007199254740993, "OverflowError: cannot fit 'int' into an index-sized integer", 'ValueError: __len__() should return >= 0', "TypeError: 'float' object cannot be interpreted as an integer", 'OverflowError: Python int too large to convert to C ssize_t', "OverflowError: cannot fit 'int' into an index-sized integer", 589016108321111109, [826726605746716825, 574276327398429556, 119565462741922389]]
if got != expected:
    raise AssertionError(got)
