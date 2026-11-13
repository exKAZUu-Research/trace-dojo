import enum
class Color(enum.Enum):
    RED = 1
    GREEN = 2
class F(enum.Flag):
    X = 1
def outcome(f):
    try: return repr(f())[:60].split(' at ')[0]
    except Exception as e: return type(e).__name__ + ': ' + str(e)
out = []
for f in [lambda: Color.__iter__(1), lambda: Color.__iter__(x=1), lambda: Color.__len__(1), lambda: Color.__contains__(Color.RED, 2), lambda: Color.__reversed__(1), lambda: Color.__bool__(1), lambda: Color.__getitem__('RED'), lambda: Color.__len__(), lambda: list(Color.__iter__()), lambda: Color.__repr__(), lambda: F.__repr__(), lambda: Color.__iter__, lambda: type(Color).__iter__, lambda: type(Color.__iter__).__name__, lambda: type(type(Color).__iter__).__name__, lambda: Color['GREEN'], lambda: len(Color), lambda: Color.RED in Color, lambda: list(reversed(Color)), lambda: bool(Color), lambda: repr(Color), lambda: Color(1), lambda: Color.__iter__.__qualname__, lambda: Color.__call__(2)]:
    out.append(outcome(f))

expected = ['TypeError: EnumType.__iter__() takes 1 positional argument but 2 were given', "TypeError: EnumType.__iter__() got an unexpected keyword argument 'x'", 'TypeError: EnumType.__len__() takes 1 positional argument but 2 were given', 'TypeError: EnumType.__contains__() takes 2 positional arguments but 3 were given', 'TypeError: EnumType.__reversed__() takes 1 positional argument but 2 were given', 'TypeError: EnumType.__bool__() takes 1 positional argument but 2 were given', '<Color.RED: 1>', '2', '[<Color.RED: 1>, <Color.GREEN: 2>]', "TypeError: Enum.__repr__() missing 1 required positional argument: 'self'", "TypeError: Flag.__repr__() missing 1 required positional argument: 'self'", "<bound method EnumType.__iter__ of <enum 'Color'>>", '<function EnumType.__iter__', "'method'", "'function'", '<Color.GREEN: 2>', '2', 'True', '[<Color.GREEN: 2>, <Color.RED: 1>]', 'True', '"<enum \'Color\'>"', '<Color.RED: 1>', "'EnumType.__iter__'", '<Color.GREEN: 2>']
if out != expected:
    raise AssertionError([(a, b) for a, b in zip(out, expected) if a != b])
