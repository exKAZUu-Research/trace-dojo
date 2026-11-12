from collections import OrderedDict as O

def check(call, expected):
    try:
        actual = repr(call())
    except Exception as e:
        actual = type(e).__name__ + ': ' + str(e)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

class M:
    def keys(self):
        return ['a', 'b']
    def __getitem__(self, k):
        return k * 2

class I:
    def items(self):
        return [(1, 2)]

check(lambda: O(1, 2), 'TypeError: expected at most 1 argument, got 2')
check(lambda: O().update(1, 2), 'TypeError: update() takes at most 1 positional argument (2 given)')
check(lambda: O([1]), "TypeError: 'int' object is not iterable")
check(lambda: O('ab'), 'ValueError: need more than 1 value to unpack')
check(lambda: O().update([(1, 2, 3)]), 'ValueError: too many values to unpack (expected 2)')
check(lambda: O([()]), 'ValueError: need more than 0 values to unpack')
check(lambda: O(5), "TypeError: 'int' object is not iterable")
check(lambda: O([(1, 2), 3]), "TypeError: 'int' object is not iterable")
check(lambda: O().update([1]), "TypeError: 'int' object is not iterable")
check(lambda: O([(1, 2)], a=3), "OrderedDict({1: 2, 'a': 3})")
check(lambda: O({'x': 1, 'y': 2}), "OrderedDict({'x': 1, 'y': 2})")
check(lambda: O(M()), "OrderedDict({'a': 'aa', 'b': 'bb'})")
check(lambda: O(I()), 'OrderedDict({1: 2})')
check(lambda: O(a=1).update(b=2), 'None')
check(lambda: O(O(a=1)), "OrderedDict({'a': 1})")
check(lambda: O(iter([[1, 2]])), 'OrderedDict({1: 2})')
d = O()
d.update(O(b=1))
d.update({'c': 2}, d=3)
check(lambda: d, "OrderedDict({'b': 1, 'c': 2, 'd': 3})")
