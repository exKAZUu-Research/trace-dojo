def message(action):
    try:
        return repr(action())
    except ZeroDivisionError as e:
        return 'ZeroDivisionError: ' + str(e)
def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))
ZERO_POWER = 'ZeroDivisionError: zero to a negative or complex power'
tiny = float('1e-200')
for base in [0j, complex(0, 0), complex(-0.0, -0.0), complex(tiny, 0)]:
    for exponent in [-2, -100, -2.0, True - 3, complex(-2, 0), complex(-2, -0.0)]:
        check(message(lambda: base ** exponent), ZERO_POWER)
        check(message(lambda: pow(base, exponent)), ZERO_POWER)
for base in [0j, complex(-0.0, 0.0)]:
    for exponent in [-1, -101, -2.5, 1j, -1j, complex(-2, 1)]:
        check(message(lambda: base ** exponent), ZERO_POWER)
for base in [0, 0.0, -0.0, False]:
    for exponent in [complex(-1, 0), -1j, 1j, complex(-2.5, 0)]:
        check(message(lambda: base ** exponent), ZERO_POWER)
check(message(lambda: 0j ** 0), '(1+0j)')
check(message(lambda: 0j ** 2), '0j')
check(message(lambda: 0j ** 0.5), '0j')
check(message(lambda: 2j ** -2), '(-0.25-0j)')
check(message(lambda: 1 / 0j), 'ZeroDivisionError: division by zero')
check(message(lambda: (1 + 2j) / 0), 'ZeroDivisionError: division by zero')
check(message(lambda: (1 + 2j) / complex(0, 0)), 'ZeroDivisionError: division by zero')
