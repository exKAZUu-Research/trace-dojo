import enum
from enum import CONFORM, EJECT, KEEP, STRICT, Enum, Flag, FlagBoundary, IntEnum, IntFlag, auto


class Perm(Flag):
    R = auto()
    W = auto()
    X = auto()
    RW = R | W
    NONE = 0

    def allows(self, other):
        return other in self

    @classmethod
    def everything(cls):
        result = cls(0)
        for flag in cls:
            result |= flag
        return result


class Color(IntFlag):
    RED = 1
    GREEN = 2
    BLUE = 4
    WHITE = 7


class Unordered(Flag):
    A = 1
    C = 4
    AC = 5
    B = 2


class Sparse(Flag):
    HI = 8
    LO = 1


class Mixed(Flag):
    A = auto()
    B = auto()
    C = A | B
    D = auto()
    E = 32
    F = auto()


class Conform(Flag, boundary=CONFORM):
    A = 1
    B = 2


class Eject(Flag, boundary=EJECT):
    A = 1
    B = 2


class Keep(Flag, boundary=KEEP):
    A = 1
    B = 2


class Strict(IntFlag, boundary=STRICT):
    A = 1
    B = 2


class Empty(Flag):
    pass


class FromEmpty(Empty):
    A = 1


def define_bad_auto():
    class Bad(Flag):
        A = 'x'
        B = auto()


def define_extension():
    class More(Perm):
        Q = 16


def toggle():
    flags = Perm.R
    flags |= Perm.W
    flags &= ~Perm.R
    flags ^= Perm.X
    return flags


def outcome(thunk):
    try:
        return repr(thunk())
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)


def check(thunk, expected):
    actual = outcome(thunk)
    if actual != expected:
        raise AssertionError('expected ' + expected + ' but got ' + actual)


check(lambda: (list(Perm), Perm.R, Perm.RW, Perm.NONE, Perm.__members__, len(Perm), Perm), "([<Perm.R: 1>, <Perm.W: 2>, <Perm.X: 4>], <Perm.R: 1>, <Perm.RW: 3>, <Perm.NONE: 0>, mappingproxy({'R': <Perm.R: 1>, 'W': <Perm.W: 2>, 'X': <Perm.X: 4>, 'RW': <Perm.RW: 3>, 'NONE': <Perm.NONE: 0>}), 3, <flag 'Perm'>)")
check(lambda: (Perm.R | Perm.W, Perm.R | Perm.X, Perm.RW & Perm.R, Perm.R ^ Perm.RW, Perm.R & Perm.W, Perm(7), Perm(0), Perm(5)), '(<Perm.RW: 3>, <Perm.R|X: 5>, <Perm.R: 1>, <Perm.W: 2>, <Perm.NONE: 0>, <Perm.R|W|X: 7>, <Perm.NONE: 0>, <Perm.R|X: 5>)')
check(lambda: (~Perm.R, ~Perm.RW, ~Perm.NONE, ~Perm(7), ~~Perm.R), '(<Perm.W|X: 6>, <Perm.X: 4>, <Perm.R|W|X: 7>, <Perm.NONE: 0>, <Perm.R: 1>)')
check(lambda: (str(Perm.R | Perm.X), str(Perm(0)), (Perm.R | Perm.X).name, (Perm.R | Perm.X).value, Perm(7).name, Perm(0).name), "('Perm.R|X', 'Perm.NONE', 'R|X', 5, 'R|W|X', 'NONE')")
check(lambda: (bool(Perm.NONE), bool(Perm.R), Perm.R in Perm.RW, Perm.X in Perm.RW, list(Perm.RW), list(Perm(7)), len(Perm(7))), '(False, True, True, False, [<Perm.R: 1>, <Perm.W: 2>], [<Perm.R: 1>, <Perm.W: 2>, <Perm.X: 4>], 3)')
check(lambda: (Perm.RW is Perm(3), Perm(5) is Perm(5), Perm.R == Perm.R, Perm.R == 1, hash(Perm.R) == hash(Perm.R), Perm['RW']), '(True, True, True, False, True, <Perm.RW: 3>)')
check(lambda: (1 in Perm, 7 in Perm, 8 in Perm, Perm.R in Perm, 'a' in Perm), '(True, True, False, True, False)')
check(lambda: (f"{Perm.R} {Perm.RW:>10} {Perm.R!r}", sorted(Perm, key=lambda flag: -flag.value), list(reversed(Perm))), "('Perm.R    Perm.RW <Perm.R: 1>', [<Perm.X: 4>, <Perm.W: 2>, <Perm.R: 1>], [<Perm.X: 4>, <Perm.W: 2>, <Perm.R: 1>])")
check(lambda: (type(Perm), type(Perm.R), isinstance(Perm.R, Flag), isinstance(Perm.R, Enum), Flag, IntFlag, type(Enum)), "(<class 'enum.EnumType'>, <flag 'Perm'>, True, True, <flag 'Flag'>, <flag 'IntFlag'>, <class 'enum.EnumType'>)")
check(lambda: (Perm._flag_mask_, Perm._singles_mask_, Perm._all_bits_, Perm._boundary_, Perm._member_names_), "(7, 7, 7, <FlagBoundary.STRICT: 'strict'>, ['R', 'W', 'X'])")
check(lambda: (Perm.everything(), Perm.everything().allows(Perm.R), Perm.R.allows(Perm.W), toggle()), '(<Perm.R|W|X: 7>, True, False, <Perm.W|X: 6>)')
check(lambda: Perm(8), "ValueError: <flag 'Perm'> invalid value 8\n    given 0b0 1000\n  allowed 0b0 0111")
check(lambda: Perm(-1), '<Perm.R|W|X: 7>')
check(lambda: Perm(16), "ValueError: <flag 'Perm'> invalid value 16\n    given 0b0 10000\n  allowed 0b0 00111")
check(lambda: Perm('a'), "ValueError: 'a' is not a valid Perm")
check(lambda: Perm.R | 1, "TypeError: unsupported operand type(s) for |: 'Perm' and 'int'")
check(lambda: 1 in Perm.R, "TypeError: unsupported operand type(s) for 'in': 'int' and 'Perm'")
check(lambda: Perm.R < Perm.W, "TypeError: '<' not supported between instances of 'Perm' and 'Perm'")
check(lambda: (list(Color), Color.RED | Color.GREEN, Color.WHITE, Color(3), Color(8), Color(12), Color(-1), Color(0)), '([<Color.RED: 1>, <Color.GREEN: 2>, <Color.BLUE: 4>], <Color.RED|GREEN: 3>, <Color.WHITE: 7>, <Color.RED|GREEN: 3>, <Color: 8>, <Color.BLUE|8: 12>, <Color.WHITE: 7>, <Color: 0>)')
check(lambda: (~Color.RED, Color.RED | 8, 8 | Color.RED, Color.RED & 3, Color.RED ^ 5, ~Color(0), Color.RED & ~Color.RED, ~Color(16)), '(<Color.GREEN|BLUE: 6>, <Color.RED|8: 9>, <Color.RED|8: 9>, <Color.RED: 1>, <Color.BLUE: 4>, <Color.WHITE: 7>, <Color: 0>, <Color.RED|GREEN|BLUE|WHITE|8: 15>)')
check(lambda: (Color.RED + 1, 1 + Color.RED, Color.RED == 1, Color.RED != 1, Color.RED < 2, Color.RED < Color.GREEN, Color.BLUE >= 4), '(2, 2, True, False, True, True, True)')
check(lambda: (str(Color.RED), f"{Color.RED} {Color.GREEN:03d}", '%d' % Color.BLUE, int(Color.BLUE), float(Color.RED), [0, 1, 2, 3, 4][Color.BLUE]), "('1', '1 002', '4', 4, 1.0, 4)")
check(lambda: (list(range(Color.GREEN)), str(Color.RED | Color.GREEN), repr(Color(8)), str(Color(8)), Color(9).name, Color(16).name, Color(21).name), "([0, 1], '3', '<Color: 8>', '8', 'RED|8', None, 'RED|BLUE|16')")
check(lambda: (hash(Color.RED) == hash(1), {1: 'a'}[Color.RED], Color.RED in Color.WHITE, Color.RED * 3, Color.BLUE / 2, Color.BLUE // 3, -Color.RED), "(True, 'a', True, 3, 2.0, 1, -1)")
check(lambda: (abs(Color.RED), divmod(Color.WHITE, 2), Color.BLUE.bit_length(), Color.BLUE.real, sorted([Color.BLUE, Color.RED]), max(Color), sum(Color)), '(1, (3, 1), 3, 4, [<Color.RED: 1>, <Color.BLUE: 4>], <Color.BLUE: 4>, 7)')
check(lambda: (2 ** Color.GREEN, Color.GREEN ** 2, Color.BLUE >> 1, 1 << Color.GREEN, Color.WHITE % 4, 9 - Color.RED, bool(Color(0)), Color._boundary_), "(4, 4, 2, 4, 3, 8, False, <FlagBoundary.KEEP: 'keep'>)")
check(lambda: (list(Color(7)), list(Color.WHITE), Color.WHITE in Color, 9 in Color, (Color.RED | Color.BLUE) in Color, Color(-2), Color(-8)), '([<Color.RED: 1>, <Color.GREEN: 2>, <Color.BLUE: 4>], [<Color.RED: 1>, <Color.GREEN: 2>, <Color.BLUE: 4>], True, True, True, <Color.GREEN|BLUE: 6>, <Color: 0>)')
check(lambda: Color('a'), "ValueError: 'a' is not a valid Color")
check(lambda: Color.RED.foo, "AttributeError: 'Color' object has no attribute 'foo'")
check(lambda: (list(Unordered), Unordered(7), Unordered(3), list(Unordered(7)), ~Unordered.A, Unordered.AC, Unordered(6).name), "([<Unordered.A: 1>, <Unordered.C: 4>, <Unordered.B: 2>], <Unordered.A|C|B: 7>, <Unordered.A|B: 3>, [<Unordered.A: 1>, <Unordered.C: 4>, <Unordered.B: 2>], <Unordered.C|B: 6>, <Unordered.AC: 5>, 'C|B')")
check(lambda: (list(Sparse), Sparse.HI | Sparse.LO, list(Sparse.HI | Sparse.LO), ~Sparse.HI), '([<Sparse.HI: 8>, <Sparse.LO: 1>], <Sparse.HI|LO: 9>, [<Sparse.HI: 8>, <Sparse.LO: 1>], <Sparse.LO: 1>)')
check(lambda: Sparse(2), "ValueError: <flag 'Sparse'> invalid value 2\n    given 0b0 0010\n  allowed 0b0 1001")
check(lambda: Sparse(6), "ValueError: <flag 'Sparse'> invalid value 6\n    given 0b0 0110\n  allowed 0b0 1001")
check(lambda: [(name, flag.value) for name, flag in Mixed.__members__.items()], "[('A', 1), ('B', 2), ('C', 3), ('D', 4), ('E', 32), ('F', 64)]")
check(lambda: (list(Mixed), Mixed.C, Mixed(3) is Mixed.C, Mixed(96)), '([<Mixed.A: 1>, <Mixed.B: 2>, <Mixed.D: 4>, <Mixed.E: 32>, <Mixed.F: 64>], <Mixed.C: 3>, True, <Mixed.E|F: 96>)')
check(lambda: (Conform(7), Conform(-1), Conform._boundary_, ~Conform.A), "(<Conform.A|B: 3>, <Conform.A|B: 3>, <FlagBoundary.CONFORM: 'conform'>, <Conform.B: 2>)")
check(lambda: (Eject(7), Eject(3), Eject(-1), ~Eject.A), '(7, <Eject.A|B: 3>, <Eject.A|B: 3>, <Eject.B: 2>)')
check(lambda: (Keep(7), Keep(12), ~Keep.A, Keep(-1), Keep(7).name, str(Keep(12)), Keep(13).value, list(Keep(13)), len(Keep(13))), "(<Keep.A|B|4: 7>, <Keep: 12>, <Keep.B: 2>, <Keep.A|B: 3>, 'A|B|4', 'Keep(12)', 13, [<Keep.A: 1>], 3)")
check(lambda: Strict(7), "ValueError: <flag 'Strict'> invalid value 7\n    given 0b0 111\n  allowed 0b0 011")
check(lambda: Strict(-1), '<Strict.A|B: 3>')
check(lambda: Strict.A | 4, "ValueError: <flag 'Strict'> invalid value 5\n    given 0b0 101\n  allowed 0b0 011")
check(lambda: (Strict.A | Strict.B, Strict.A + 1, ~Strict.A), '(<Strict.A|B: 3>, 2, <Strict.B: 2>)')
check(lambda: (FromEmpty.A, list(Empty), Empty.__members__, FromEmpty(1), FromEmpty(0)), '(<FromEmpty.A: 1>, [], mappingproxy({}), <FromEmpty.A: 1>, <FromEmpty: 0>)')
check(lambda: Empty(1), "TypeError: <flag 'Empty'> has no members; specify `names=()` if you meant to create a new, empty, enum")
check(lambda: Empty(), "TypeError: EnumType.__call__() missing 1 required positional argument: 'value'")
check(lambda: define_bad_auto(), "TypeError: invalid flag value 'x'")
check(lambda: define_extension(), "TypeError: <enum 'More'> cannot extend <flag 'Perm'>")
check(lambda: (list(FlagBoundary), STRICT, str(KEEP), KEEP == 'keep', FlagBoundary('eject') is EJECT), "([<FlagBoundary.STRICT: 'strict'>, <FlagBoundary.CONFORM: 'conform'>, <FlagBoundary.EJECT: 'eject'>, <FlagBoundary.KEEP: 'keep'>], <FlagBoundary.STRICT: 'strict'>, 'keep', True, True)")
check(lambda: (enum.show_flag_values(13), enum.show_flag_values(Perm.RW), enum.bin(5), enum.bin(-5), enum.bin(5, 8), enum.bin(0)), "([1, 4, 8], [1, 2], '0b0 101', '0b1 011', '0b0 00000101', '0b0 ')")
check(lambda: enum.show_flag_values(-1), 'ValueError: -1 is not a positive integer')
check(lambda: (list(Flag('F', 'a b c')), IntFlag('G', 'x y').y + 1, list(IntEnum('I', 'a b'))), '([<F.a: 1>, <F.b: 2>, <F.c: 4>], 3, [<I.a: 1>, <I.b: 2>])')
check(lambda: [str(flag) for flag in (Perm.R, Perm.RW, Perm(5), Perm(0), Color.RED, Color(3), Color(0), Color(8))], "['Perm.R', 'Perm.RW', 'Perm.R|X', 'Perm.NONE', '1', '3', '0', '8']")
check(lambda: [repr(flag) for flag in (Perm(5), Perm(0), Color(3), Color(0), Color(8), Color(9))], "['<Perm.R|X: 5>', '<Perm.NONE: 0>', '<Color.RED|GREEN: 3>', '<Color: 0>', '<Color: 8>', '<Color.RED|8: 9>']")
check(lambda: (enum.global_flag_repr(Perm.RW), enum.global_flag_repr(Perm(0)), enum.global_flag_repr(Keep(12)), enum.global_str(Perm(0))), "('__main__.RW', '__main__.NONE', '__main__.Keep(12)', 'NONE')")
