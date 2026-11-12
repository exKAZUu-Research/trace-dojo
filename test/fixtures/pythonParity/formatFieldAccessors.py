def check(call, expected):
    try:
        actual = repr(call())
    except Exception as e:
        actual = type(e).__name__ + ': ' + str(e)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

class A:
    b = [10, 20]
    c = {'k': 'v', 1: 'one'}

check(lambda: '{0.}'.format([7, 8], a=A()), 'ValueError: Empty attribute in format string')
check(lambda: '{0..a}'.format([7, 8], a=A()), 'ValueError: Empty attribute in format string')
check(lambda: '{.}'.format([7, 8], a=A()), 'ValueError: Empty attribute in format string')
check(lambda: '{..}'.format([7, 8], a=A()), 'ValueError: Empty attribute in format string')
check(lambda: '{0[]}'.format([7, 8], a=A()), 'ValueError: Empty attribute in format string')
check(lambda: '{0[]]}'.format([7, 8], a=A()), 'ValueError: Empty attribute in format string')
check(lambda: '{0.a.}'.format([7, 8], a=A()), "AttributeError: 'list' object has no attribute 'a'")
check(lambda: '{a.b.}'.format([7, 8], a=A()), 'ValueError: Empty attribute in format string')
check(lambda: '{0[a]b}'.format([7, 8], a=A()), 'TypeError: list indices must be integers or slices, not str')
check(lambda: '{0[a[a]]}'.format([7, 8], a=A()), 'TypeError: list indices must be integers or slices, not str')
check(lambda: '{0[[a]]}'.format([7, 8], a=A()), 'TypeError: list indices must be integers or slices, not str')
check(lambda: '{0[a]x[b]}'.format([7, 8], a=A()), 'TypeError: list indices must be integers or slices, not str')
check(lambda: '{a.b[1]}'.format([7, 8], a=A()), "'20'")
check(lambda: '{a.c[k]}'.format([7, 8], a=A()), "'v'")
check(lambda: '{a.c[1]}'.format([7, 8], a=A()), "'one'")
check(lambda: '{a.b[1]!r:>4}'.format([7, 8], a=A()), "'  20'")
check(lambda: '{a.b[01]}'.format([7, 8], a=A()), "'20'")
check(lambda: '{a.b[99999999999999999999]}'.format([7, 8], a=A()), 'ValueError: Too many decimal digits in format string')
check(lambda: '{99999999999999999999}'.format([7, 8], a=A()), 'ValueError: Too many decimal digits in format string')
check(lambda: '{a.x}'.format([7, 8], a=A()), "AttributeError: 'A' object has no attribute 'x'")
check(lambda: '{a.b[0]}{}'.format([7, 8], a=A()), "'10[7, 8]'")
