def make():
    yield 1
    return 'end'
class W:
    def __init__(self):
        self.gen = make()
    def __iter__(self):
        return self.gen
got = []
for consume in [list, tuple, sum, set, max, sorted, lambda w: list(enumerate(w)), lambda w: [x for x in w]]:
    w = W()
    consume(w)
    try:
        next(w.gen)
    except StopIteration as e:
        got.append(e.value)
if got != [None] * 8:
    raise AssertionError(got)
