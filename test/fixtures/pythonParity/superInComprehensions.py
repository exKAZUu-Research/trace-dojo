def check(call, expected):
    try:
        actual = repr(call())
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)
    if actual != expected:
        raise AssertionError(actual + ' != ' + expected)


class A:
    def __init__(self):
        self.x = 1

    def m(self):
        return 'A'


class B(A):
    def inline(self):
        return (
            [super().m() for _ in range(2)],
            {super().m() for _ in range(1)},
            {i: super().m() for i in range(1)},
            [[super().m() for _ in range(1)] for _ in range(1)],
            [super().__init__() for _ in range(1)],
        )

    def generator_over_range(self):
        return list(super().m() for _ in range(1))

    def generator_over_text(self):
        return list(super().m() for _ in 'ab')


mismatch = 'TypeError: super(type, obj): obj ({}) is not an instance or subtype of type (B).'
check(lambda: B().inline(), "(['A', 'A'], {'A'}, {0: 'A'}, [['A']], [None])")
check(lambda: B().generator_over_range(), mismatch.format('instance of range_iterator'))
check(lambda: B().generator_over_text(), mismatch.format('instance of str_ascii_iterator'))
check(lambda: super(B, 1), mismatch.format('instance of int'))
check(lambda: super(B, int), mismatch.format('type int'))
check(lambda: super(B, B()).m(), "'A'")
