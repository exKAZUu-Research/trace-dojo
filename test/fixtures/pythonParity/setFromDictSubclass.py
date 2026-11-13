from collections import Counter, OrderedDict, defaultdict
def check(*values):
    if not all(values):
        raise ValueError(str(values))
keys = [97, 5, 33, 64, 1, 12, 130, 77, 41, 8, 90, 19, 55, 3, 200, 14, 60, 71, 23, 36, 9]
expected = [1, 130, 3, 5, 8, 9, 12, 14, 19, 23, 33, 36, 41, 55, 60, 64, 71, 200, 77, 90, 97]
check(list(set(OrderedDict.fromkeys(keys))) == expected)
check(list(set(Counter(keys))) == expected)
check(list(frozenset(defaultdict(int, dict.fromkeys(keys)))) == expected)
check(list(set(dict.fromkeys(keys))) == [64, 1, 130, 3, 5, 71, 8, 200, 9, 12, 77, 14, 19, 23, 90, 97, 33, 36, 41, 55, 60])
