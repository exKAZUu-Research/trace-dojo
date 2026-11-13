import copy
import enum
from enum import (CONTINUOUS, NAMED_FLAGS, UNIQUE, Enum, EnumCheck, EnumMeta, EnumType, Flag, IntEnum, ReprEnum, StrEnum,
                  auto, member, nonmember, unique, verify)


class Color(Enum):
    RED = 1
    GREEN = 2
    CRIMSON = 1

    def __str__(self):
        return self.name.title()


class Direction(StrEnum):
    NORTH = auto()
    SOUTH = 'S'
    EAST_WEST = auto()


class Shape(IntEnum):
    SQUARE = 4
    TRIANGLE = 3
    HEXAGON = auto()


class Planet(Enum):
    MERCURY = (3.5, 2.4)
    EARTH = (5.9, 6.3)

    def __init__(self, mass, radius):
        self.mass = mass
        self.radius = radius

    @property
    def ratio(self):
        return self.mass / self.radius


class Labeled(Enum):
    A = (1, 'one')
    B = (2, 'two')

    def __init__(self, number, label):
        self._value_ = number
        self.label = label


class Named(Enum):
    def _generate_next_value_(name, start, count, last_values):
        return name.lower() + str(count)

    A = auto()
    B = auto()
    C = 'x'
    D = auto()


class Lookup(Enum):
    A = 1
    B = 2

    @classmethod
    def _missing_(cls, value):
        if value == 'a':
            return cls.A
        if value == 'bad':
            return 5
        if value == 'err':
            raise KeyError('boom')
        return None


class Values(Enum):
    A = 1
    B = 'two'
    C = [3]
    D = [3]
    E = {'k': 1}


class Members(Enum):
    A = 1
    B = nonmember(5)
    C = member(len)

    def plain(self):
        return self.value

    class Inner:
        pass

    _ignore_ = ['tmp']
    tmp = 9


class Chained(Enum):
    A = 1
    B = A + 1
    C = B * 2


class Tuples(Enum):
    A = (auto(), 'x')
    B = (auto(), 'y')
    C = auto()


class Ordered(Enum):
    _order_ = 'A B'
    A = 1
    B = 2


@unique
class Distinct(Enum):
    A = 1
    B = 2


@verify(UNIQUE, CONTINUOUS)
class Verified(Enum):
    A = 1
    B = 2


class Outer:
    class Nested(Enum):
        A = 1


def define(kind):
    if kind == 'unique':
        @unique
        class E(Enum):
            A = 1
            B = 1
            C = 2
            D = 2
    elif kind == 'verify unique':
        @verify(UNIQUE)
        class E(Enum):
            A = 1
            B = 1
    elif kind == 'continuous':
        @verify(CONTINUOUS)
        class E(Enum):
            A = 1
            B = 3
            C = 6
    elif kind == 'continuous flag':
        @verify(CONTINUOUS)
        class E(Flag):
            A = 1
            C = 8
    elif kind == 'named flags':
        @verify(NAMED_FLAGS)
        class E(Flag):
            A = 1
            B = 2
            E = 25
    elif kind == 'str value':
        class E(StrEnum):
            A = 1
    elif kind == 'duplicate':
        class E(Enum):
            A = 1
            A = 2
    elif kind == 'auto after str':
        class E(Enum):
            A = 'x'
            B = auto()
    elif kind == 'late generator':
        class E(Enum):
            A = auto()

            def _generate_next_value_(name, start, count, last_values):
                return 1
    elif kind == 'ignore':
        class E(Enum):
            A = 1
            _ignore_ = 'A B'
    elif kind == 'order':
        class E(Enum):
            _order_ = 'B A'
            A = 1
            B = 2
    elif kind == 'sunder':
        class E(Enum):
            _foo_ = 1
    elif kind == 'repr enum':
        class E(ReprEnum):
            A = 1
    elif kind == 'extend':
        class E(Color):
            BLUE = 3
    elif kind == 'reassign':
        Color.RED = 5


def outcome(thunk):
    try:
        return repr(thunk())
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)


def check(thunk, expected):
    actual = outcome(thunk)
    if actual != expected:
        raise AssertionError('expected ' + expected + ' but got ' + actual)


check(lambda: (str(Color.RED), f"{Color.RED}", f"{Color.RED:>6}", format(Color.GREEN, '^9'), repr(Color.RED), Color.CRIMSON, Color(1)), "('Red', 'Red', '   Red', '  Green  ', '<Color.RED: 1>', <Color.RED: 1>, <Color.RED: 1>)")
check(lambda: (list(Color), Color.__members__, Color['CRIMSON'], len(Color), bool(Color), Color.RED.name, Color.CRIMSON.name, Color.RED.value), "([<Color.RED: 1>, <Color.GREEN: 2>], mappingproxy({'RED': <Color.RED: 1>, 'GREEN': <Color.GREEN: 2>, 'CRIMSON': <Color.RED: 1>}), <Color.RED: 1>, 2, True, 'RED', 'RED', 1)")
check(lambda: (Color.RED is Color.RED, Color.RED == Color.CRIMSON, Color.RED != Color.GREEN, {Color.RED: 1}[Color.CRIMSON], Color.RED in {Color.RED}), '(True, True, True, 1, True)')
check(lambda: (Color._member_names_, Color._member_map_, Color._value2member_map_, list(reversed(Color)), 1 in Color, 9 in Color, Color.RED in Color), "(['RED', 'GREEN'], {'RED': <Color.RED: 1>, 'GREEN': <Color.GREEN: 2>, 'CRIMSON': <Color.RED: 1>}, {1: <Color.RED: 1>, 2: <Color.GREEN: 2>}, [<Color.GREEN: 2>, <Color.RED: 1>], True, False, True)")
check(lambda: (type(Color), type(Color.RED), Color, Enum, IntEnum, StrEnum, ReprEnum, type(Enum), EnumType is EnumMeta), "(<class 'enum.EnumType'>, <enum 'Color'>, <enum 'Color'>, <enum 'Enum'>, <enum 'IntEnum'>, <enum 'StrEnum'>, <enum 'ReprEnum'>, <class 'enum.EnumType'>, True)")
check(lambda: (isinstance(Color, EnumType), isinstance(int, EnumType), issubclass(Color, Enum), Color.__name__, Color.__mro__ == (Color, Enum, object)), "(True, False, True, 'Color', True)")
check(lambda: (copy.copy(Color.RED) is Color.RED, copy.deepcopy([Color.RED])[0] is Color.RED, auto(), auto(5), auto().value), '(True, True, auto(_auto_null), auto(5), _auto_null)')
check(lambda: Color(5), 'ValueError: 5 is not a valid Color')
check(lambda: Color['X'], "KeyError: 'X'")
check(lambda: Color(1, 2), 'ValueError: (1, 2) is not a valid Color')
check(lambda: Color(), "TypeError: EnumType.__call__() missing 1 required positional argument: 'value'")
check(lambda: Enum('X'), "TypeError: <enum 'Enum'> has no members; specify `names=()` if you meant to create a new, empty, enum")
check(lambda: (list(Direction), Direction.NORTH, str(Direction.NORTH), Direction.NORTH.value, Direction('S'), Direction.EAST_WEST, Direction.NORTH.name), "([<Direction.NORTH: 'north'>, <Direction.SOUTH: 'S'>, <Direction.EAST_WEST: 'east_west'>], <Direction.NORTH: 'north'>, 'north', 'north', <Direction.SOUTH: 'S'>, <Direction.EAST_WEST: 'east_west'>, 'NORTH')")
check(lambda: (Direction.NORTH == 'north', 'north' == Direction.NORTH, Direction.NORTH != 'x', Direction.NORTH == Direction.NORTH, Direction.NORTH == 1), '(True, True, True, True, False)')
check(lambda: (f"{Direction.NORTH}|{Direction.SOUTH:>3}", '%s' % Direction.NORTH, Direction.NORTH.upper(), Direction.NORTH.startswith('n')), "('north|  S', 'north', 'NORTH', True)")
check(lambda: (Direction.NORTH + '!', '>' + Direction.NORTH, Direction.NORTH + Direction.SOUTH, Direction.NORTH * 2, len(Direction.NORTH)), "('north!', '>north', 'northS', 'northnorth', 5)")
check(lambda: (Direction.NORTH[0], Direction.NORTH[1:3], 'or' in Direction.NORTH, list(Direction.SOUTH), [c for c in Direction.SOUTH]), "('n', 'or', True, ['S'], ['S'])")
check(lambda: ({'north': 1}[Direction.NORTH], {Direction.NORTH: 1}['north'], sorted([Direction.SOUTH, Direction.NORTH]), Direction.NORTH < 'z'), "(1, 1, [<Direction.SOUTH: 'S'>, <Direction.NORTH: 'north'>], True)")
check(lambda: (hash(Direction.NORTH) == hash('north'), 'north' in Direction, Direction.NORTH in Direction, repr(Direction.NORTH)), '(True, True, True, "<Direction.NORTH: \'north\'>")')
check(lambda: Direction('x'), "ValueError: 'x' is not a valid Direction")
check(lambda: Direction.NORTH.foo, "AttributeError: 'Direction' object has no attribute 'foo'")
check(lambda: Direction.NORTH + 1, 'TypeError: can only concatenate str (not "int") to str')
check(lambda: (Shape.HEXAGON, Shape.SQUARE + 1, Shape.SQUARE < Shape.HEXAGON, Shape.SQUARE == 4, [0, 1, 2, 3, 4][Shape.SQUARE], sorted(Shape)), '(<Shape.HEXAGON: 5>, 5, True, True, 4, [<Shape.TRIANGLE: 3>, <Shape.SQUARE: 4>, <Shape.HEXAGON: 5>])')
check(lambda: (f"{Shape.SQUARE:03d}|{Shape.SQUARE}|{Shape.SQUARE!r}", str(Shape.SQUARE), '%d %s %r' % (Shape.SQUARE, Shape.SQUARE, Shape.SQUARE)), "('004|4|<Shape.SQUARE: 4>', '4', '4 4 <Shape.SQUARE: 4>')")
check(lambda: (Shape.SQUARE.bit_length(), abs(Shape.SQUARE), divmod(Shape.SQUARE, Shape.TRIANGLE), round(Shape.SQUARE), Shape.SQUARE.real), '(3, 4, (1, 1), 4, 4)')
check(lambda: (Shape.SQUARE.numerator, bool(Shape.SQUARE), float(Shape.TRIANGLE), Shape(3), Shape.SQUARE.conjugate(), hash(Shape.SQUARE) == hash(4)), '(4, True, 3.0, <Shape.TRIANGLE: 3>, 4, True)')
check(lambda: (Planet.EARTH.mass, Planet.EARTH.value, Planet.MERCURY.ratio, Planet((5.9, 6.3)), list(Planet)), '(5.9, (5.9, 6.3), 1.4583333333333335, <Planet.EARTH: (5.9, 6.3)>, [<Planet.MERCURY: (3.5, 2.4)>, <Planet.EARTH: (5.9, 6.3)>])')
check(lambda: (Labeled.A.value, Labeled.B.label, Labeled.A, Labeled((2, 'two'))), "(1, 'two', <Labeled.A: 1>, <Labeled.B: 2>)")
check(lambda: Labeled(2), 'ValueError: 2 is not a valid Labeled')
check(lambda: [item.value for item in Named], "['a0', 'b1', 'x', 'd3']")
check(lambda: (Lookup('a'), Lookup(2)), '(<Lookup.A: 1>, <Lookup.B: 2>)')
check(lambda: Lookup('bad'), 'TypeError: error in Lookup._missing_: returned 5 instead of None or a valid member')
check(lambda: Lookup('err'), "KeyError: 'boom'")
check(lambda: Lookup('zz'), "ValueError: 'zz' is not a valid Lookup")
check(lambda: (list(Values), Values([3]), Values({'k': 1}), Values.D, [3] in Values, 'two' in Values, 9 in Values, Values.A in Values), "([<Values.A: 1>, <Values.B: 'two'>, <Values.C: [3]>, <Values.E: {'k': 1}>], <Values.C: [3]>, <Values.E: {'k': 1}>, <Values.C: [3]>, True, True, False, True)")
check(lambda: Values({1}), 'ValueError: {1} is not a valid Values')
check(lambda: (list(Members), Members.B, Members.A.plain(), Members.C.value([1, 2]), Members.Inner.__name__, hasattr(Members, 'tmp')), "([<Members.A: 1>, <Members.C: <built-in function len>>], 5, 1, 2, 'Inner', False)")
check(lambda: ([item.value for item in Chained], [item.value for item in Tuples], list(Ordered), list(Distinct), list(Verified)), "([1, 2, 4], [(1, 'x'), (2, 'y'), 3], [<Ordered.A: 1>, <Ordered.B: 2>], [<Distinct.A: 1>, <Distinct.B: 2>], [<Verified.A: 1>, <Verified.B: 2>])")
check(lambda: (Outer.Nested.A, str(Outer.Nested.A), Outer.Nested, Outer.Nested(1)), "(<Nested.A: 1>, 'Nested.A', <enum 'Nested'>, <Nested.A: 1>)")
check(lambda: (Enum('Animal', 'ANT BEE CAT'), list(Enum('Animal', 'ANT BEE CAT')), list(Enum('A2', 'x, y', start=5))), "(<enum 'Animal'>, [<Animal.ANT: 1>, <Animal.BEE: 2>, <Animal.CAT: 3>], [<A2.x: 5>, <A2.y: 6>])")
check(lambda: (list(Enum('A3', [('p', 10), ('q', 20)])), list(Enum('A4', {'m': 'M', 'n': 'N'})), list(StrEnum('S', 'a b')), Enum('Z', ()).__members__), "([<A3.p: 10>, <A3.q: 20>], [<A4.m: 'M'>, <A4.n: 'N'>], [<S.a: 'a'>, <S.b: 'b'>], mappingproxy({}))")
check(lambda: (Enum('A5', ['u', 'v']).v.value, Enum('Q', 'a', module='m').__module__, Enum('Q', 'a', qualname='X.Q').__qualname__), "(2, 'm', 'X.Q')")
check(lambda: define('unique'), "ValueError: duplicate values found in <enum 'E'>: B -> A, D -> C")
check(lambda: define('verify unique'), "ValueError: aliases found in <enum 'E'>: B -> A")
check(lambda: define('continuous'), "ValueError: invalid enum 'E': missing values 2, 4, 5")
check(lambda: define('continuous flag'), "ValueError: invalid flag 'E': missing values 2, 4")
check(lambda: define('named flags'), "ValueError: invalid Flag 'E': alias E is missing combined values of 0x18 [use enum.show_flag_values(value) for details]")
check(lambda: define('str value'), 'TypeError: 1 is not a string')
check(lambda: define('duplicate'), "TypeError: 'A' already defined as 1")
check(lambda: define('auto after str'), "TypeError: unable to increment 'x'")
check(lambda: define('late generator'), 'TypeError: _generate_next_value_ must be defined before members')
check(lambda: define('ignore'), "ValueError: _ignore_ cannot specify already set names: {'A'}")
check(lambda: define('order'), "TypeError: member order does not match _order_:\n  ['A', 'B']\n  ['B', 'A']")
check(lambda: define('sunder'), "ValueError: _sunder_ names, such as '_foo_', are reserved for future Enum use")
check(lambda: define('repr enum'), 'TypeError: ReprEnum subclasses must be mixed with a data type (i.e. int, str, float, etc.)')
check(lambda: define('extend'), "TypeError: <enum 'E'> cannot extend <enum 'Color'>")
check(lambda: define('reassign'), "AttributeError: cannot reassign member 'RED'")
check(lambda: verify(UNIQUE)(int), "TypeError: the 'verify' decorator only works with Enum and Flag")
check(lambda: (verify, UNIQUE, CONTINUOUS, NAMED_FLAGS, list(EnumCheck)), "(<class 'enum.verify'>, <EnumCheck.UNIQUE: 'one name per value'>, <EnumCheck.CONTINUOUS: 'no skipped integer values'>, <EnumCheck.NAMED_FLAGS: 'multi-flag aliases may not contain unnamed flags'>, [<EnumCheck.CONTINUOUS: 'no skipped integer values'>, <EnumCheck.NAMED_FLAGS: 'multi-flag aliases may not contain unnamed flags'>, <EnumCheck.UNIQUE: 'one name per value'>])")
check(lambda: (enum.global_str(Color.RED), enum.global_enum_repr(Color.RED), enum.pickle_by_global_name(Color.RED, 2), enum.pickle_by_enum_name(Color.RED, 2)[1]), "('RED', '__main__.RED', 'RED', (<enum 'Color'>, 'RED'))")
check(lambda: sorted(name for name in dir(enum) if not name.startswith('_')), "['CONFORM', 'CONTINUOUS', 'DynamicClassAttribute', 'EJECT', 'Enum', 'EnumCheck', 'EnumDict', 'EnumMeta', 'EnumType', 'Flag', 'FlagBoundary', 'IntEnum', 'IntFlag', 'KEEP', 'MappingProxyType', 'NAMED_FLAGS', 'ReprEnum', 'STRICT', 'StrEnum', 'UNIQUE', 'auto', 'bin', 'bltns', 'global_enum', 'global_enum_repr', 'global_flag_repr', 'global_str', 'member', 'nonmember', 'pickle_by_enum_name', 'pickle_by_global_name', 'property', 'show_flag_values', 'sys', 'unique', 'verify']")
