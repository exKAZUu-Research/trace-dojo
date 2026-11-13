def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)


LIMIT = 'ValueError: Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits; use sys.set_int_max_str_digits() to increase the limit'
check(lambda: int('ff', 16), '255')
check(lambda: int('-0x_ff_ff', 16), '-65535')
check(lambda: int('zz', 36), '1295')
check(lambda: int('Zz' * 20, 36), '178689910246017054531432477289437798228285773001601743140683775')
check(lambda: int('12' * 40, 3), '92380518383966202072552006378989561000')
check(lambda: int('a' * 11, 11), '285311670610')
check(lambda: int('0' * 30 + 'z', 36), '35')
check(lambda: int('-' + 'f' * 33, 16), '-' + str(16**33 - 1))
check(lambda: int('123456789abcdefghijklmnopqrstuvwxyz' * 30, 36) % 10**40, '6413216797992529555525854319925523905275')
check(lambda: int('f' * 5000, 16) == 16**5000 - 1, 'True')
check(lambda: int('3' * 9999, 4) == 4**9999 - 1, 'True')
check(lambda: int('v' * 9999, 32) == 32**9999 - 1, 'True')
check(lambda: int('1' * 20000, 2) == 2**20000 - 1, 'True')
check(lambda: int('2' * 4300, 3) == 3**4300 - 1, 'True')
check(lambda: int('2' * 4301, 3), LIMIT)
check(lambda: int('z' * 4301, 36), LIMIT)
check(lambda: int('1_' * 4300 + '1', 7), LIMIT)
check(lambda: int('9' * 4301), LIMIT)
