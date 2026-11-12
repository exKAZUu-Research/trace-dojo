# Membership, discard, and remove look a mutable set up as the frozenset of its elements; add and isdisjoint do not.
s = {frozenset([1]), frozenset([2])}
results = [{1} in s, {3} in s, set.__contains__(s, {2}), {1} in frozenset([frozenset([1])])]
s.discard({1})
s.remove({2})
results.append(s == set())
try:
    s.remove({5})
except KeyError as error:
    results.append(repr(error))
for call in [lambda: {1}.add({2}), lambda: {1}.isdisjoint([{3}]), lambda: [1] in {1}]:
    try:
        call()
    except TypeError as error:
        results.append(str(error))
expected = [True, False, True, True, True, 'KeyError({5})', "cannot use 'set' as a set element (unhashable type: 'set')", "cannot use 'set' as a set element (unhashable type: 'set')", "cannot use 'list' as a set element (unhashable type: 'list')"]
if results != expected:
    raise AssertionError(results)
