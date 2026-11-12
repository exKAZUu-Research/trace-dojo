# Random binds its arguments as Random.__init__(self, x=None) does, and OrderedDict takes at most one positional argument.
import random
from collections import OrderedDict

got = []
for call in [lambda: random.Random(seed=1), lambda: random.Random(1, x=2), lambda: random.Random(1, 2), lambda: OrderedDict({'a': 1}, {'b': 2}), lambda: OrderedDict([], []), lambda: OrderedDict(1, 2, 3)]:
    try:
        call()
    except TypeError as error:
        got.append(str(error))
got += [random.Random(x=3).random() == random.Random(3).random(), OrderedDict([('a', 1)], b=2)]
expected = ["Random.__init__() got an unexpected keyword argument 'seed'", "Random.__init__() got multiple values for argument 'x'", 'Random.__init__() takes from 1 to 2 positional arguments but 3 were given', 'expected at most 1 argument, got 2', 'expected at most 1 argument, got 2', 'expected at most 1 argument, got 3', True, OrderedDict([('a', 1), ('b', 2)])]
if got != expected:
    raise AssertionError(got)
