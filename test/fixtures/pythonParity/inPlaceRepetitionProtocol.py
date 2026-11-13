from collections import deque


class Index:
    def __index__(self):
        return 2


class BadIndex:
    def __index__(self):
        return "x"


class Reflected:
    def __rmul__(self, other):
        return ("rmul", other)


class ReflectedIndex(Reflected):
    def __index__(self):
        return 3


class Declines:
    calls = 0

    def __rmul__(self, other):
        Declines.calls += 1
        return NotImplemented

    def __index__(self):
        return 3


class Neither:
    pass


class ReflectedAdd:
    def __radd__(self, other):
        return ("radd", other)


def repeat(sequence, count):
    return sequence * count


def repeat_in_place(sequence, count):
    original = sequence
    sequence *= count
    if type(original) in (list, deque) and type(count) in (int, bool, Index, Declines) and sequence is not original:
        raise AssertionError("not in place")
    return sequence


def outcome(operation, sequence, count):
    try:
        return operation(sequence, count)
    except Exception as error:
        return type(error).__name__ + ": " + str(error)


def check(actual, expected):
    if actual != expected:
        raise AssertionError((actual, expected))


kinds = (
    (lambda: [1, 2], [], "list"),
    (lambda: (1, 2), (), "tuple"),
    (lambda: "ab", "", "str"),
    (lambda: deque([1, 2]), deque(), "collections.deque"),
)
non_int = "TypeError: can't multiply sequence by non-int of type '"
for make, empty, name in kinds:
    double = make() + make()
    cases = [
        (2, double),
        (True, make()),
        (False, empty),
        (-1, empty),
        (Index(), double),
        (Declines(), double + make()),
        (2.0, non_int + "float'"),
        (None, non_int + "NoneType'"),
        (Neither(), non_int + "Neither'"),
        ("s", non_int + "str'"),
        (BadIndex(), "TypeError: __index__ returned non-int (type str)"),
        (1 << 70, "OverflowError: cannot fit 'int' into an index-sized integer"),
        (Reflected(), ("rmul", make())),
        (ReflectedIndex(), ("rmul", make())),
    ]
    for count, expected in cases:
        check(outcome(repeat, make(), count), expected)
        check(outcome(repeat_in_place, make(), count), expected)
    Declines.calls = 0
    repeat_in_place(make(), Declines())
    check(Declines.calls, 1)
    for count in (Index(), ReflectedIndex(), Neither()):
        expected = "TypeError: unsupported operand type(s) for *=: '" + type(count).__name__ + "' and '" + name + "'"
        check(outcome(repeat_in_place, count, make()), expected)
    check(outcome(repeat_in_place, 2, make()), double)

empty = []
check(repeat_in_place(empty, 1000000000000), [])
pair = (1, 2)
check(pair * 1 is pair, True)

items = [1]
original = items
items += ReflectedAdd()
check((items, original), (("radd", [1]), [1]))
queue = deque([1])
original = queue
queue += ReflectedAdd()
check((queue, original), (("radd", deque([1])), deque([1])))
