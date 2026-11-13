a = []
f = a.append
g = a.append
d = {f: 1}
s = {a.pop}
b = []
x = 5
got = [f == g, hash(f) == hash(g), d.get(g), a.pop in s, a.append == b.append, x.bit_length == (5).bit_length, hash(x.bit_length) == hash((5).bit_length), len({a.append, b.append, a.pop, a.append})]
if got != [True, True, 1, True, False, True, True, 3]:
    raise AssertionError(got)
