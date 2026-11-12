# A set display of constants keeps one of equal tuples, complex numbers, and frozensets, as CPython's folded constant does.
got = [{(1, 2), (1, 2), (3, 4)}, {(1+2j), (1+2j), (2+3j)}, {frozenset([1]), frozenset([1]), 2}, {(1, (2, 3)), (1, (2, 3)), 0}, 5 in {(1, 2), (1, 2), (3, 4)}, (1, 2) in {(1, 2), (1, 2), (3, 4)}]
if got != [{(1, 2), (3, 4)}, {1+2j, 2+3j}, {frozenset([1]), 2}, {0, (1, (2, 3))}, False, True] or repr(got[0]) != '{(1, 2), (3, 4)}':
    raise AssertionError(got)
