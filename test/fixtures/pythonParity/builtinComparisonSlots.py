import bisect
got = [int.__eq__(1, 1.0), float.__eq__(1.0, 1), int.__lt__(1, True), complex.__lt__(1j, 2j), dict.__lt__({}, {}), dict.__eq__({}, {}), set.__le__({1}, frozenset({1, 2})), list.__lt__([1], (2,)), str.__eq__('a', 1), range.__eq__(range(1), range(1)), range.__lt__(range(1), range(2)), bool.__eq__(True, 1), complex.__eq__(1j, 1), float.__lt__(1.5, 2), tuple.__ge__((1,), (1,))]
got += [(1).__eq__(2), (1).__ne__(2), (1).__lt__(2), (1).__gt__(2), (1).__le__(2), (1).__ge__(2), (1).__eq__(1), int.__eq__ is object.__eq__, '__eq__' in int.__dict__, '__eq__' in bool.__dict__]
got += [1 == 1.0, [1, 2] < [1, 3], {1} < {1, 2}, 'a' < 'b', (1, 'a') == (1, 'a'), {'a': 1} == {'a': 1}]
got += [bisect.bisect_left(range(3000000000), 2500000000), bisect.bisect_right(range(3000000000), 2000000000)]
class OnlyExit:
    def __exit__(self, *a):
        pass
class OnlyEnter:
    def __enter__(self):
        return self
for manager in [OnlyExit(), OnlyEnter(), 1, 's']:
    try:
        with manager:
            pass
    except TypeError as e:
        got.append(str(e))
expected = [NotImplemented, True, False, NotImplemented, NotImplemented, True, True, NotImplemented, NotImplemented, True, NotImplemented, True, False, True, True, False, True, True, False, True, False, True, False, True, False, True, True, True, True, True, True, 2500000000, 2000000001, "'OnlyExit' object does not support the context manager protocol (missed __enter__ method)", "'OnlyEnter' object does not support the context manager protocol (missed __exit__ method)", "'int' object does not support the context manager protocol (missed __exit__ method)", "'str' object does not support the context manager protocol (missed __exit__ method)"]
if got != expected:
    raise AssertionError(got)
