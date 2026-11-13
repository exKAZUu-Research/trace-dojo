def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

from collections import namedtuple

P = namedtuple('P', 'x y')
Q = namedtuple('Q', 'a')

check(lambda: P.__doc__, "'P(x, y)'")
check(lambda: Q.__doc__, "'Q(a,)'")
check(lambda: namedtuple("E", "").__doc__, "'E()'")
check(lambda: P._make([1]), 'TypeError: Expected 2 arguments, got 1')
check(lambda: P._make([1, 2, 3]), 'TypeError: Expected 2 arguments, got 3')
check(lambda: P._make([]), 'TypeError: Expected 2 arguments, got 0')
check(lambda: P._make(iter([1, 2])), 'P(x=1, y=2)')
check(lambda: P._make(5), "TypeError: 'int' object is not iterable")
check(lambda: P._make({"x": 1, "y": 2}), "P(x='x', y='y')")
check(lambda: P(1, 2)._replace(z=1), "TypeError: Got unexpected field names: ['z']")
check(lambda: P(1, 2)._replace(x=1, z=2, w=3), "TypeError: Got unexpected field names: ['z', 'w']")
check(lambda: P(1, 2)._replace(w=1, z=2, y=5), "TypeError: Got unexpected field names: ['w', 'z']")
check(lambda: P(1, 2)._replace(), 'P(x=1, y=2)')
check(lambda: P(1, 2)._replace(y=7), 'P(x=1, y=7)')
check(lambda: Q._make("a"), "Q(a='a')")
check(lambda: P(1, 2).__replace__(q=0), "TypeError: Got unexpected field names: ['q']")
