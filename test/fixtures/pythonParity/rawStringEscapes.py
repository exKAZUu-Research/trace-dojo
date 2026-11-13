def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))

check([r'\\', len(r'\\'), 'C:' + r'\\'], ['\\\\', 2, 'C:\\\\'])
check([r'\\\\', fr'\\', r'\'', r'''\\''', r'a\\', fr'{1}\\'], ['\\\\\\\\', '\\\\', "\\'", '\\\\', 'a\\\\', '1\\\\'])
