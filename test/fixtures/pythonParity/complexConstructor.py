def message(action):
    try:
        return repr(action())
    except (TypeError, ValueError) as e:
        return type(e).__name__ + ': ' + str(e)
def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))
class Complexish:
    def __complex__(self):
        return complex(1, -0.0)
class BadComplexish:
    def __complex__(self):
        return 1
class Floatish:
    def __float__(self):
        return -0.0
class Indexish:
    def __index__(self):
        return 3
nz = -0.0
# The sign of a zero part is kept: a part is not added to a zero the other argument does not have.
check(repr(complex(0.0, nz)), '-0j')
check(repr(complex(1.0, nz)), '(1-0j)')
check(repr(complex(0.0, nz).imag), '-0.0')
check(repr(complex(nz, nz)), '(-0-0j)')
check(repr(complex(nz, 0.0)), '(-0+0j)')
check(repr(complex(nz)), '(-0+0j)')
check(repr(complex(real=nz)), '(-0+0j)')
check(repr(complex(imag=nz)), '-0j')
check(repr(complex(0, nz)), '-0j')
check(repr(complex(True, Floatish())), '(1-0j)')
check(repr(complex(Floatish())), '(-0+0j)')
check(repr(complex(Indexish(), Indexish())), '(3+3j)')
check(repr(complex('-0-0j')), '(-0-0j)')
check(repr(complex()), '0j')
check(repr(complex(Complexish())), '(1-0j)')
check(repr(complex(2, 3)), '(2+3j)')
check(message(lambda: complex(BadComplexish())), 'TypeError: __complex__ returned non-complex (type int)')
for value, name in [([], 'list'), (None, 'NoneType'), ((1,), 'tuple'), (int, 'type')]:
    check(message(lambda: complex(value)), 'TypeError: complex() argument must be a string or a number, not ' + name)
    check(message(lambda: complex(value, 2)), "TypeError: complex() argument 'real' must be a real number, not " + name)
    check(message(lambda: complex(2, value)), "TypeError: complex() argument 'imag' must be a real number, not " + name)
    check(message(lambda: complex(imag=value)), "TypeError: complex() argument 'imag' must be a real number, not " + name)
check(message(lambda: complex('1', 2)), "TypeError: complex() argument 'real' must be a real number, not str")
check(message(lambda: complex(1, '2')), "TypeError: complex() argument 'imag' must be a real number, not str")
check(message(lambda: complex('x', [])), "TypeError: complex() argument 'real' must be a real number, not str")
check(message(lambda: complex(2, Complexish())), "TypeError: complex() argument 'imag' must be a real number, not Complexish")
check(message(lambda: complex('x')), 'ValueError: complex() arg is a malformed string')
