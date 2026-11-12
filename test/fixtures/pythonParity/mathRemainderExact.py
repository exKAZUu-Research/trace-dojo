import math

inf = float('inf')
cases = [
    (0.3, 0.1, '-2.7755575615628914e-17'),
    (float('1e20'), 3.0, '1.0'),
    (5.0, 2.0, '1.0'),
    (7.0, 2.0, '-1.0'),
    (-7.5, 2.0, '0.5'),
    (float('1e308'), 7.3, '2.886445454538679'),
    (1.0, inf, '1.0'),
    (float('5e-324'), 3.0, '5e-324'),
    (3, float('5e-324'), '0.0'),
    (-0.0, 1.0, '-0.0'),
    (4.0, 2.0, '0.0'),
    (-4.0, 2.0, '-0.0'),
    (float('1.7e308'), float('1.1e-300'), '5.162882329255188e-301'),
    (2.5, 1.0, '0.5'),
    (3.5, 1.0, '-0.5'),
    (-2.5, 1.0, '-0.5'),
    (10, -3, '1.0'),
]
for x, y, expected in cases:
    actual = repr(math.remainder(x, y))
    if actual != expected:
        raise AssertionError('remainder(' + repr(x) + ', ' + repr(y) + ') = ' + actual + ', not ' + expected)

if not math.isnan(math.remainder(float('nan'), 1.0)):
    raise AssertionError('remainder(nan, 1.0)')
for x, y in [(1.0, 0.0), (inf, 1.0)]:
    try:
        math.remainder(x, y)
        raise AssertionError('remainder(' + repr(x) + ', ' + repr(y) + ') did not raise')
    except ValueError as error:
        if str(error) != 'math domain error':
            raise AssertionError(str(error))
