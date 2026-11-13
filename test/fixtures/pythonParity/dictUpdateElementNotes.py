def check(call, expected):
    try:
        call()
        actual = 'no error'
    except Exception as e:
        actual = repr(e) + ' ' + repr(getattr(e, '__notes__', None))
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

class B:
    def __iter__(self):
        raise TypeError('boom')

class V:
    def __iter__(self):
        raise ValueError('v')

check(lambda: dict([1]), "TypeError('object is not iterable') ['Cannot convert dictionary update sequence element #0 to a sequence']")
check(lambda: {}.update([(1, 2), 3]), "TypeError('object is not iterable') ['Cannot convert dictionary update sequence element #1 to a sequence']")
check(lambda: dict([1], a=1), "TypeError('object is not iterable') ['Cannot convert dictionary update sequence element #0 to a sequence']")
check(lambda: dict([B()]), "TypeError('object is not iterable') ['Cannot convert dictionary update sequence element #0 to a sequence']")
check(lambda: dict([V()]), "ValueError('v') None")
check(lambda: dict([[1]]), "ValueError('dictionary update sequence element #0 has length 1; 2 is required') None")
