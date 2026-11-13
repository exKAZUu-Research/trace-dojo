out = []


def show(*values):
    out.append(' '.join(str(value) for value in values))


import enum
class Color(enum.Enum):
    RED = 1
    GREEN = 2
class Nums(enum.IntEnum):
    A = 1
class F(enum.Flag):
    X = 1
    Y = 2
class S(enum.StrEnum):
    P = 'p'
for v in [iter(Color), reversed(Color), iter(reversed(Color)), iter(Nums), iter(F), reversed(F), iter(S)]:
    t = type(v)
    show(t.__module__, t.__qualname__, v.__qualname__, v.__name__, repr(v)[:60].split(' at ')[0])
show(list(Color), list(reversed(Color)), list(F), [m for m in Nums], list(iter(iter(Color))))
g = iter(Color)
show(next(g), list(g), list(g))
for v in [Color.__iter__(), Color.__reversed__()]:
    show(type(v).__name__, v.__qualname__, list(v))
show(Color.__len__(), Color.__contains__(Color.RED), Color.mro()[0].__name__)

expected = ['builtins generator EnumType.__iter__.<locals>.<genexpr> <genexpr> <generator object EnumType.__iter__.<locals>.<genexpr>', 'builtins generator EnumType.__reversed__.<locals>.<genexpr> <genexpr> <generator object EnumType.__reversed__.<locals>.<genexpr> a', 'builtins generator EnumType.__reversed__.<locals>.<genexpr> <genexpr> <generator object EnumType.__reversed__.<locals>.<genexpr> a', 'builtins generator EnumType.__iter__.<locals>.<genexpr> <genexpr> <generator object EnumType.__iter__.<locals>.<genexpr>', 'builtins generator EnumType.__iter__.<locals>.<genexpr> <genexpr> <generator object EnumType.__iter__.<locals>.<genexpr>', 'builtins generator EnumType.__reversed__.<locals>.<genexpr> <genexpr> <generator object EnumType.__reversed__.<locals>.<genexpr> a', 'builtins generator EnumType.__iter__.<locals>.<genexpr> <genexpr> <generator object EnumType.__iter__.<locals>.<genexpr>', '[<Color.RED: 1>, <Color.GREEN: 2>] [<Color.GREEN: 2>, <Color.RED: 1>] [<F.X: 1>, <F.Y: 2>] [<Nums.A: 1>] [<Color.RED: 1>, <Color.GREEN: 2>]', 'Color.RED [<Color.GREEN: 2>] []', 'generator EnumType.__iter__.<locals>.<genexpr> [<Color.RED: 1>, <Color.GREEN: 2>]', 'generator EnumType.__reversed__.<locals>.<genexpr> [<Color.GREEN: 2>, <Color.RED: 1>]', '2 True Color']
if out != expected:
    raise AssertionError([(a, b) for a, b in zip(out, expected) if a != b])
