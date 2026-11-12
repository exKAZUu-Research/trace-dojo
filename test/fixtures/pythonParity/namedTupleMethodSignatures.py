from collections import namedtuple
P = namedtuple('P', 'x y')
got = []
for call in [lambda: P._make(), lambda: P._make(1, 2), lambda: P(1, 2)._asdict(1), lambda: P(1, 2).__getnewargs__(1), lambda: P(1, 2).__repr__(1), lambda: P(1, 2)._replace(1), lambda: P._make(iterable=[1, 2]), lambda: P(1, 2)._replace(x=3), lambda: P._asdict(5), lambda: P._replace(5)]:
    try:
        got.append(repr(call()))
    except Exception as e:
        got.append(type(e).__name__ + ': ' + str(e))
got.append(' '.join([P._make.__qualname__, P._asdict.__qualname__, P.__repr__.__qualname__, P._replace.__qualname__, P.__getnewargs__.__qualname__]))
expected = ["TypeError: P._make() missing 1 required positional argument: 'iterable'", 'TypeError: P._make() takes 2 positional arguments but 3 were given', 'TypeError: P._asdict() takes 1 positional argument but 2 were given', 'TypeError: P.__getnewargs__() takes 1 positional argument but 2 were given', 'TypeError: P.__repr__() takes 1 positional argument but 2 were given', 'TypeError: P._replace() takes 1 positional argument but 2 were given', 'P(x=1, y=2)', 'P(x=3, y=2)', "AttributeError: 'int' object has no attribute '_fields'", "AttributeError: 'int' object has no attribute '_make'", 'P._make P._asdict P.__repr__ P._replace P.__getnewargs__']
if got != expected:
    raise AssertionError(got)
# __new__ reports its argument counts as every function does: with the default range and a singular noun for one.
D = namedtuple('D', 'x y z', defaults=(0, 0))
E = namedtuple('E', '')
messages = []
for call in [lambda: D(1, 2, 3, 4), lambda: E(1), lambda: D(), lambda: P()]:
    try:
        call()
    except TypeError as error:
        messages.append(str(error))
expected = ['D.__new__() takes from 2 to 4 positional arguments but 5 were given', 'E.__new__() takes 1 positional argument but 2 were given', "D.__new__() missing 1 required positional argument: 'x'", "P.__new__() missing 2 required positional arguments: 'x' and 'y'"]
if messages != expected:
    raise AssertionError(messages)
