import itertools

def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))

def outcome(f):
    try:
        return repr(list(f()))
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)

check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], -1, 2)), 'ValueError: Indices for islice() must be None or an integer: 0 <= x <= sys.maxsize.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 'a', 2)), 'ValueError: Indices for islice() must be None or an integer: 0 <= x <= sys.maxsize.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 0, 2, -1)), 'ValueError: Step for islice() must be a positive integer or None.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 0, 2, 'x')), 'ValueError: Step for islice() must be a positive integer or None.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 0, 2, 2**70)), 'ValueError: Step for islice() must be a positive integer or None.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 2**70, 2)), 'ValueError: Indices for islice() must be None or an integer: 0 <= x <= sys.maxsize.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 0, -1)), 'ValueError: Stop argument for islice() must be None or an integer: 0 <= x <= sys.maxsize.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 0, -5)), 'ValueError: Indices for islice() must be None or an integer: 0 <= x <= sys.maxsize.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 0, 'x')), 'ValueError: Stop argument for islice() must be None or an integer: 0 <= x <= sys.maxsize.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 0, 2**70)), 'ValueError: Stop argument for islice() must be None or an integer: 0 <= x <= sys.maxsize.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], -1)), 'ValueError: Stop argument for islice() must be None or an integer: 0 <= x <= sys.maxsize.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], None)), '[1, 2, 3, 4, 5]')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 2)), '[1, 2]')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 1, None)), '[2, 3, 4, 5]')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 1, 5, 2)), '[2, 4]')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], 0, 2, 0)), 'ValueError: Step for islice() must be a positive integer or None.')
check(outcome(lambda: itertools.islice([1, 2, 3, 4, 5], True, 3)), '[2, 3]')
check(outcome(lambda: itertools.islice(5, -1)), 'ValueError: Stop argument for islice() must be None or an integer: 0 <= x <= sys.maxsize.')
