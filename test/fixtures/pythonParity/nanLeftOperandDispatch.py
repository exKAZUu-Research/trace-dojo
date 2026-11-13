def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)

class V:
    def __radd__(self, other):
        return 'radd ' + repr(other)
    def __rsub__(self, other):
        return 'rsub'

x = float('nan')
check(lambda: x + V(), "'radd nan'")
check(lambda: x - V(), "'rsub'")
check(lambda: x + (1,), "TypeError: unsupported operand type(s) for +: 'float' and 'tuple'")
check(lambda: x - None, "TypeError: unsupported operand type(s) for -: 'float' and 'NoneType'")
check(lambda: x + 'a', "TypeError: unsupported operand type(s) for +: 'float' and 'str'")
check(lambda: x * [1], "TypeError: can't multiply sequence by non-int of type 'float'")
check(lambda: x + 1, 'nan')
