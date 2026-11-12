nan = float("nan")
inf = float("inf")


def same(actual, expected):
    return repr(actual) == repr(expected)


for a, b in ((nan, 1), (1, nan), (nan, nan), (inf, 1), (-inf, 2), (inf, inf), (inf, -inf), (nan, inf), (3, nan), (inf, 2.5)):
    if not same([a // b, a % b, divmod(a, b)], [nan, nan, (nan, nan)]):
        raise AssertionError((a, b, a // b, a % b, divmod(a, b)))

finite = [
    (divmod(1, inf), (0.0, 1.0)),
    (divmod(-1, inf), (-1.0, inf)),
    (divmod(1, -inf), (-1.0, -inf)),
    (divmod(-5.0, -inf), (0.0, -5.0)),
    (divmod(0.0, inf), (0.0, 0.0)),
    (divmod(-0.0, inf), (-0.0, 0.0)),
    (divmod(0.0, -inf), (-0.0, -0.0)),
    (3.5 // inf, 0.0),
    (-3.5 % inf, inf),
    (float("1e308") * 10 // 1, nan),
]
for actual, expected in finite:
    if not same(actual, expected):
        raise AssertionError((actual, expected))
