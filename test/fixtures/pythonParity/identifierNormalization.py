def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))

ｘ = 1
x = 2
check([ｘ, x], [2, 2])


def ｆ(ａ):
    return ａ


check(f(1), 1)


class C:
    pass


c = C()
setattr(c, 'x', 1)
check(c.ｘ, 1)


def g(**kw):
    return kw


check(g(ｋ=1), {'k': 1})
ﬁ = 3
check(fi, 3)
check([len('ｘ'), f'{ｘ}'], [1, '2'])
try:
    ｙ
except NameError as error:
    check(str(error), "name 'y' is not defined")
