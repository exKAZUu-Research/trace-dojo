def g():
    yield 1
    return 42
got = []
it = g()
got.append(list(it))
try:
    next(it)
except StopIteration as e:
    got.append([e.value, e.args])
it = g()
for x in it:
    pass
try:
    next(it)
except StopIteration as e:
    got.append([e.value, e.args])
it = g()
next(it)
try:
    next(it)
except StopIteration as e:
    got.append([e.value, e.args])
if got != [[1], [None, ()], [None, ()], [42, (42,)]]:
    raise AssertionError(got)
