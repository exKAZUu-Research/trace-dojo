def check(*values):
    if not all(values):
        raise ValueError(str(values))
t = set()
for x in [72, 155, 129, 91, 57, 140, 154, 158, 81]:
    t.add(x)
u = set()
u.update(t)
expected = [129, 72, 155, 140, 81, 57, 154, 91, 158]
check(list(t) == expected, list(set(t)) == expected, list(frozenset(t)) == expected, list(u) == expected)
check(list(t ^ {1}) == [1, 129, 72, 91, 140, 81, 57, 154, 155, 158], list({1, 2} | t) == [1, 2, 129, 72, 91, 140, 81, 57, 154, 155, 158])
