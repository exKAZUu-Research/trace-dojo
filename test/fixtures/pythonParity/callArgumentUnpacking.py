def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

import math
from collections import Counter, namedtuple


def f(*args, **kwargs):
    return len(args) + len(kwargs)


def outer():
    def inner(*args):
        return len(args)
    return inner


class C:
    def m(self, *args, **kwargs):
        return 0

    @staticmethod
    def s(*args):
        return 0

    @classmethod
    def c(cls, *args):
        return 0


lam = lambda *args: 0
log = []


def numbers():
    log.append('numbers')
    yield 1


def mark(value):
    log.append(value)
    return value


def unpacked_after_keywords():
    log.clear()
    f(*numbers(), x=mark('x'), **{'y': mark('y')})
    f(0, *numbers(), z=mark('z'))
    return log

check(lambda: f(*1), 'TypeError: __main__.f() argument after * must be an iterable, not int')
check(lambda: f(*1, x=2), 'TypeError: __main__.f() argument after * must be an iterable, not int')
check(lambda: f(**3), 'TypeError: __main__.f() argument after ** must be a mapping, not int')
check(lambda: f(**[4]), 'TypeError: __main__.f() argument after ** must be a mapping, not list')
check(lambda: f(x=1, **{'x': 2}), "TypeError: __main__.f() got multiple values for keyword argument 'x'")
check(lambda: lam(*1), 'TypeError: __main__.<lambda>() argument after * must be an iterable, not int')
check(lambda: lam(*1, x=2), 'TypeError: __main__.<lambda>() argument after * must be an iterable, not int')
check(lambda: lam(**3), 'TypeError: __main__.<lambda>() argument after ** must be a mapping, not int')
check(lambda: lam(**[4]), 'TypeError: __main__.<lambda>() argument after ** must be a mapping, not list')
check(lambda: lam(x=1, **{'x': 2}), "TypeError: __main__.<lambda>() got multiple values for keyword argument 'x'")
check(lambda: outer()(*1), 'TypeError: __main__.outer.<locals>.inner() argument after * must be an iterable, not int')
check(lambda: outer()(*1, x=2), 'TypeError: __main__.outer.<locals>.inner() argument after * must be an iterable, not int')
check(lambda: outer()(**3), 'TypeError: __main__.outer.<locals>.inner() argument after ** must be a mapping, not int')
check(lambda: outer()(**[4]), 'TypeError: __main__.outer.<locals>.inner() argument after ** must be a mapping, not list')
check(lambda: outer()(x=1, **{'x': 2}), "TypeError: __main__.outer.<locals>.inner() got multiple values for keyword argument 'x'")
check(lambda: C().m(*1), 'TypeError: __main__.C.m() argument after * must be an iterable, not int')
check(lambda: C().m(*1, x=2), 'TypeError: __main__.C.m() argument after * must be an iterable, not int')
check(lambda: C().m(**3), 'TypeError: __main__.C.m() argument after ** must be a mapping, not int')
check(lambda: C().m(**[4]), 'TypeError: __main__.C.m() argument after ** must be a mapping, not list')
check(lambda: C().m(x=1, **{'x': 2}), "TypeError: __main__.C.m() got multiple values for keyword argument 'x'")
check(lambda: C.m(*1), 'TypeError: __main__.C.m() argument after * must be an iterable, not int')
check(lambda: C.m(*1, x=2), 'TypeError: __main__.C.m() argument after * must be an iterable, not int')
check(lambda: C.m(**3), 'TypeError: __main__.C.m() argument after ** must be a mapping, not int')
check(lambda: C.m(**[4]), 'TypeError: __main__.C.m() argument after ** must be a mapping, not list')
check(lambda: C.m(x=1, **{'x': 2}), "TypeError: __main__.C.m() got multiple values for keyword argument 'x'")
check(lambda: C.s(*1), 'TypeError: __main__.C.s() argument after * must be an iterable, not int')
check(lambda: C.s(*1, x=2), 'TypeError: __main__.C.s() argument after * must be an iterable, not int')
check(lambda: C.s(**3), 'TypeError: __main__.C.s() argument after ** must be a mapping, not int')
check(lambda: C.s(**[4]), 'TypeError: __main__.C.s() argument after ** must be a mapping, not list')
check(lambda: C.s(x=1, **{'x': 2}), "TypeError: __main__.C.s() got multiple values for keyword argument 'x'")
check(lambda: C.c(*1), 'TypeError: __main__.C.c() argument after * must be an iterable, not int')
check(lambda: C.c(*1, x=2), 'TypeError: __main__.C.c() argument after * must be an iterable, not int')
check(lambda: C.c(**3), 'TypeError: __main__.C.c() argument after ** must be a mapping, not int')
check(lambda: C.c(**[4]), 'TypeError: __main__.C.c() argument after ** must be a mapping, not list')
check(lambda: C.c(x=1, **{'x': 2}), "TypeError: __main__.C.c() got multiple values for keyword argument 'x'")
check(lambda: C(*1), 'TypeError: __main__.C() argument after * must be an iterable, not int')
check(lambda: C(*1, x=2), 'TypeError: __main__.C() argument after * must be an iterable, not int')
check(lambda: C(**3), 'TypeError: __main__.C() argument after ** must be a mapping, not int')
check(lambda: C(**[4]), 'TypeError: __main__.C() argument after ** must be a mapping, not list')
check(lambda: C(x=1, **{'x': 2}), "TypeError: __main__.C() got multiple values for keyword argument 'x'")
check(lambda: len(*1), 'TypeError: len() argument after * must be an iterable, not int')
check(lambda: len(*1, x=2), 'TypeError: len() argument after * must be an iterable, not int')
check(lambda: len(**3), 'TypeError: len() argument after ** must be a mapping, not int')
check(lambda: len(**[4]), 'TypeError: len() argument after ** must be a mapping, not list')
check(lambda: len(x=1, **{'x': 2}), "TypeError: len() got multiple values for keyword argument 'x'")
check(lambda: print(*1), 'TypeError: print() argument after * must be an iterable, not int')
check(lambda: print(*1, x=2), 'TypeError: print() argument after * must be an iterable, not int')
check(lambda: print(**3), 'TypeError: print() argument after ** must be a mapping, not int')
check(lambda: print(**[4]), 'TypeError: print() argument after ** must be a mapping, not list')
check(lambda: print(x=1, **{'x': 2}), "TypeError: print() got multiple values for keyword argument 'x'")
check(lambda: [].append(*1), 'TypeError: list.append() argument after * must be an iterable, not int')
check(lambda: [].append(*1, x=2), 'TypeError: list.append() argument after * must be an iterable, not int')
check(lambda: [].append(**3), 'TypeError: list.append() argument after ** must be a mapping, not int')
check(lambda: [].append(**[4]), 'TypeError: list.append() argument after ** must be a mapping, not list')
check(lambda: [].append(x=1, **{'x': 2}), "TypeError: list.append() got multiple values for keyword argument 'x'")
check(lambda: math.sqrt(*1), 'TypeError: math.sqrt() argument after * must be an iterable, not int')
check(lambda: math.sqrt(*1, x=2), 'TypeError: math.sqrt() argument after * must be an iterable, not int')
check(lambda: math.sqrt(**3), 'TypeError: math.sqrt() argument after ** must be a mapping, not int')
check(lambda: math.sqrt(**[4]), 'TypeError: math.sqrt() argument after ** must be a mapping, not list')
check(lambda: math.sqrt(x=1, **{'x': 2}), "TypeError: math.sqrt() got multiple values for keyword argument 'x'")
check(lambda: Counter(*1), 'TypeError: collections.Counter() argument after * must be an iterable, not int')
check(lambda: Counter(*1, x=2), 'TypeError: collections.Counter() argument after * must be an iterable, not int')
check(lambda: Counter(**3), 'TypeError: collections.Counter() argument after ** must be a mapping, not int')
check(lambda: Counter(**[4]), 'TypeError: collections.Counter() argument after ** must be a mapping, not list')
check(lambda: Counter(x=1, **{'x': 2}), "TypeError: collections.Counter() got multiple values for keyword argument 'x'")
check(lambda: namedtuple(*1), 'TypeError: collections.namedtuple() argument after * must be an iterable, not int')
check(lambda: namedtuple(*1, x=2), 'TypeError: collections.namedtuple() argument after * must be an iterable, not int')
check(lambda: namedtuple(**3), 'TypeError: collections.namedtuple() argument after ** must be a mapping, not int')
check(lambda: namedtuple(**[4]), 'TypeError: collections.namedtuple() argument after ** must be a mapping, not list')
check(lambda: namedtuple(x=1, **{'x': 2}), "TypeError: collections.namedtuple() got multiple values for keyword argument 'x'")
check(lambda: str.join(*1), 'TypeError: str.join() argument after * must be an iterable, not int')
check(lambda: str.join(*1, x=2), 'TypeError: str.join() argument after * must be an iterable, not int')
check(lambda: str.join(**3), 'TypeError: str.join() argument after ** must be a mapping, not int')
check(lambda: str.join(**[4]), 'TypeError: str.join() argument after ** must be a mapping, not list')
check(lambda: str.join(x=1, **{'x': 2}), "TypeError: str.join() got multiple values for keyword argument 'x'")
check(lambda: f(1, *2), 'TypeError: Value after * must be an iterable, not int')
check(lambda: f(*3, 1), 'TypeError: Value after * must be an iterable, not int')
check(lambda: f(*[1], *4), 'TypeError: Value after * must be an iterable, not int')
check(lambda: f(*5, *[1]), 'TypeError: Value after * must be an iterable, not int')
check(lambda: f(*1, **2), 'TypeError: __main__.f() argument after ** must be a mapping, not int')
check(lambda: f(*1, **{1: 2}), 'TypeError: __main__.f() argument after * must be an iterable, not int')
check(lambda: f(**{1: 2}, **{1: 3}), "TypeError: __main__.f() got multiple values for keyword argument '1'")
check(lambda: f(**{1: 2}, **3), 'TypeError: __main__.f() argument after ** must be a mapping, not int')
check(lambda: f(*1, **{'a': 1}, **{'a': 2}), "TypeError: __main__.f() got multiple values for keyword argument 'a'")
check(lambda: f(x=1, **{'x': 2}, **3), "TypeError: __main__.f() got multiple values for keyword argument 'x'")
check(lambda: f(**{'x': 1}, x=2), "TypeError: __main__.f() got multiple values for keyword argument 'x'")
check(lambda: f(**{1: 2}), 'TypeError: keywords must be strings')
check(lambda: f(*[1, 2], **{}), '2')
check(lambda: unpacked_after_keywords(), "['x', 'y', 'numbers', 'numbers', 'z']")
