def check(call, expected):
    try:
        actual = repr(call())
    except Exception as e:
        actual = type(e).__name__ + ': ' + str(e)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

check(lambda: "{:{:{}}}".format(1, 2, 3), 'ValueError: Max string recursion exceeded')
check(lambda: "{x:{w:{z}}}".format_map({"x": 1, "w": 3, "z": 2}), 'ValueError: Max string recursion exceeded')
check(lambda: "{:{}}".format(1, 2), "' 1'")
check(lambda: "{0!s:{1}}".format(1, 4), "'1   '")
check(lambda: "{0:{1}.{2}f}".format(1.5, 8, 2), "'    1.50'")
check(lambda: "{:{:{:{}}}".format(1, 2, 3, 4), "ValueError: unmatched '{' in format spec")
check(lambda: f'{1:{2:{3}}}', "ValueError: Invalid format specifier '  2' for object of type 'int'")
