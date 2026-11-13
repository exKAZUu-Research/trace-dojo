# list.pop converts its index before it looks at the list, as argument clinic does.
got = []
for call in [lambda: [].pop('0'), lambda: [].pop(1.0), lambda: [1].pop(2 ** 63), lambda: [].pop(2 ** 63), lambda: [1].pop(-2 ** 63 - 1), lambda: [].pop(0), lambda: [1].pop(5)]:
    try:
        call()
    except (TypeError, OverflowError, IndexError) as error:
        got.append(type(error).__name__ + ': ' + str(error))
expected = ["TypeError: 'str' object cannot be interpreted as an integer", "TypeError: 'float' object cannot be interpreted as an integer", 'OverflowError: Python int too large to convert to C ssize_t', 'OverflowError: Python int too large to convert to C ssize_t', 'OverflowError: Python int too large to convert to C ssize_t', 'IndexError: pop from empty list', 'IndexError: pop index out of range']
if got != expected or [1, 2, 3].pop() != 3 or [1, 2, 3].pop(-3) != 1:
    raise AssertionError(got)
