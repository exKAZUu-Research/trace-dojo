import enum
def outcome(f):
    try: return repr(f())
    except Exception as e: return type(e).__name__ + ': ' + str(e)
out = []
for c in [enum.Enum, enum.IntEnum, enum.ReprEnum, enum.Flag]:
    for f in [lambda: list(c.__iter__()), lambda: c.__len__(), lambda: list(c.__reversed__()), lambda: c.__getitem__('X'), lambda: c.__contains__(1), lambda: dict(c.__members__), lambda: c._member_map_, lambda: c._member_names_, lambda: len(c), lambda: list(c)]:
        out.append(outcome(f))
class Empty(enum.Enum): pass
class Color(enum.Enum):
    RED = 1
out.append(outcome(lambda: [len(Empty), list(Empty), dict(Color.__members__), Color._member_names_]))
expected = ['[]', '0', '[]', "KeyError: 'X'", 'False', '{}', '{}', '[]', '0', '[]', '[]', '0', '[]', "KeyError: 'X'", 'False', '{}', '{}', '[]', '0', '[]', '[]', '0', '[]', "KeyError: 'X'", 'False', '{}', '{}', '[]', '0', '[]', "TypeError: Flag.__iter__() missing 1 required positional argument: 'self'", "TypeError: Flag.__len__() missing 1 required positional argument: 'self'", '[]', "KeyError: 'X'", "TypeError: Flag.__contains__() missing 1 required positional argument: 'other'", '{}', '{}', '[]', '0', '[]', "[0, [], {'RED': <Color.RED: 1>}, ['RED']]"]
if out != expected:
    raise AssertionError([(a, b) for a, b in zip(out, expected) if a != b])
