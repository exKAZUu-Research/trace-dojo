from functools import partial
def f(*args, **kwargs):
    return [args, kwargs]
p = partial(f, 1, 2, a=3)
q = partial(p, 4, b=5)
got = [p.args, p.keywords, p.args is p.args, p.keywords is p.keywords, q.args, q.keywords, q(6, c=7), repr(q)[:28]]
p.keywords['z'] = 9
got.append(p())
p.note = 'x'
got.append(p.__dict__)
if got != [(1, 2), {'a': 3, 'z': 9}, True, True, (1, 2, 4), {'a': 3, 'b': 5}, [(1, 2, 4, 6), {'a': 3, 'b': 5, 'c': 7}], 'functools.partial(<function ', [(1, 2), {'a': 3, 'z': 9}], {'note': 'x'}]:
    raise AssertionError(got)
