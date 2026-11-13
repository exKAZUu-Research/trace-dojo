# Keys and items views order like sets against each other and against sets, from either side; values views refuse.
a = {1: 2}
b = {1: 2, 2: 3}
got = [a.keys() <= b.keys(), a.keys() < b.keys(), b.keys() >= a.keys(), b.keys() > a.keys(), a.keys() > b.keys(), a.keys() <= {1, 2}, {1, 2} >= a.keys(), {1, 2} < a.keys(), a.items() <= {(1, 2), (2, 3)}, a.keys() < {1, 2}, a.keys() <= frozenset([1, 2]), a.items() <= b.items(), b.items() > a.items(), a.keys() == {1}, {1} == a.keys(), a.keys() <= a.keys(), a.keys() < a.keys(), {2: [1]}.items() <= {2: [1]}.items(), a.keys().__lt__([1]), set.__le__({1}, a.keys())]
for call in [lambda: a.values() <= b.values(), lambda: a.keys() <= [1], lambda: a.keys() < a.values(), lambda: {1: [2]}.items() <= {(1, 2)}]:
    try:
        call()
    except TypeError as error:
        got.append(str(error))
expected = [True, True, True, True, False, True, True, False, True, True, True, True, True, True, True, True, False, True, NotImplemented, NotImplemented, "'<=' not supported between instances of 'dict_values' and 'dict_values'", "'<=' not supported between instances of 'dict_keys' and 'list'", "'<' not supported between instances of 'dict_keys' and 'dict_values'", "cannot use 'tuple' as a set element (unhashable type: 'list')"]
if got != expected:
    raise AssertionError(got)
