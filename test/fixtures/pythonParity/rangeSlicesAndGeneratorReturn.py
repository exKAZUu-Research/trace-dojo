def g():
    yield 1
    return 42
def h():
    return 'done'
    yield
got = [str(range(10)[1:8:2]), range(10)[1:8:2].stop, str(range(10)[::3]), str(range(10)[9::-3]), str(range(5)[3:1]), str(range(2, 20, 3)[1:-1]), str(range(20, 2, -3)[::-2]), list(range(10)[::3]), range(10)[::3] == range(0, 12, 3)]
it = g()
next(it)
try:
    next(it)
except StopIteration as e:
    got.append([repr(e), e.value])
try:
    next(it)
except StopIteration as e:
    got.append([repr(e), e.value])
got.append(list(g()))
try:
    h().__next__()
except StopIteration as e:
    got.append(repr(e))
expected = ['range(1, 8, 2)', 8, 'range(0, 10, 3)', 'range(9, -1, -3)', 'range(3, 1)', 'range(5, 17, 3)', 'range(5, 23, 6)', [0, 3, 6, 9], True, ['StopIteration(42)', 42], ['StopIteration()', None], [1], "StopIteration('done')"]
if got != expected:
    raise AssertionError(got)
