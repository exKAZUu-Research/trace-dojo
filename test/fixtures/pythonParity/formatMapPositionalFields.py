def check(call, expected):
    try:
        actual = repr(call())
    except Exception as e:
        actual = type(e).__name__ + ': ' + str(e)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

check(lambda: '{0}'.format_map({"0": "zero"}), 'ValueError: Format string contains positional fields')
check(lambda: '{}'.format_map({}), 'ValueError: Format string contains positional fields')
check(lambda: '{x} {}'.format_map({"x": 1}), 'ValueError: Format string contains positional fields')
check(lambda: '{0[x]}'.format_map({0: {"x": 1}}), 'ValueError: Format string contains positional fields')
check(lambda: '{1}'.format_map({1: "one"}), 'ValueError: Format string contains positional fields')
check(lambda: '{007}'.format_map({}), 'ValueError: Format string contains positional fields')
check(lambda: '{x}'.format_map({"x": 1}), "'1'")
check(lambda: '{x[a]}'.format_map({"x": {"a": 2}}), "'2'")
check(lambda: '{} {0}'.format_map({}), 'ValueError: Format string contains positional fields')
check(lambda: '{x:{}}'.format_map({"x": 1}), 'ValueError: Format string contains positional fields')
check(lambda: '{99999999999999999999}'.format_map({}), 'ValueError: Too many decimal digits in format string')
check(lambda: '{y}'.format_map({}), "KeyError: 'y'")
check(lambda: '{x!r:>{w}}'.format_map({"x": 1, "w": 3}), "'  1'")
check(lambda: '{}'.format(), 'IndexError: Replacement index 0 out of range for positional args tuple')
