def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))


class MyIndexError(IndexError):
    pass


class MyStop(StopIteration):
    pass


class Seq:
    def __getitem__(self, i):
        if i > 2:
            raise MyIndexError(i)
        return i * 10


class Seq2:
    def __getitem__(self, i):
        if i > 1:
            raise MyStop(i)
        return i


check([list(Seq()), [x for x in Seq()], tuple(Seq()), list(Seq2())], [[0, 10, 20], [0, 10, 20], (0, 10, 20), [0, 1]])


def g():
    yield 1
    raise MyStop('x')


try:
    list(g())
except RuntimeError as error:
    check([str(error), type(error.__cause__).__name__, type(error.__context__).__name__, error.__suppress_context__], ['generator raised StopIteration', 'MyStop', 'MyStop', True])
