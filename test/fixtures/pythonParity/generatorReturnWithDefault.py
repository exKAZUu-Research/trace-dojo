def g():
    yield 1
    return 42
def h():
    if False:
        yield
    return 42
def y7():
    yield 1
    return 7
def report(it):
    try:
        next(it)
    except StopIteration as e:
        return [repr(e), e.value]
got = []
it = g()
got.append([next(it, 'dflt'), next(it, 'dflt')])
got.append(report(it))
it = h()
got.append(next(it, 'd'))
got.append(report(it))
it = y7()
next(it)
got.append(next(it, 'd'))
got.append(report(it))
it = g()
next(it)
got.append(report(it))
got.append(report(it))
it = g()
got.append(list(it))
got.append(report(it))
if got != [[1, 'dflt'], ['StopIteration()', None], 'd', ['StopIteration()', None], 'd', ['StopIteration()', None], ['StopIteration(42)', 42], ['StopIteration()', None], [1], ['StopIteration()', None]]:
    raise AssertionError(got)
