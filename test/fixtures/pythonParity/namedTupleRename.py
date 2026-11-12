from collections import namedtuple
P = namedtuple('P', ['x', 'class', 'x', '_y', '1a', 'z'], rename=True)
Q = namedtuple('Q', 'a, b c', rename=True)
R = namedtuple('R', [1, 2], rename=True)
S = namedtuple('S', 'a b', defaults=None, module=None)
T = namedtuple('T', 'a b', defaults=iter([2]))
got = [P._fields, Q._fields, R.__name__, R._fields, P(1, 2, 3, 4, 5, 6)._2, S._field_defaults, T._field_defaults, T(1)]
messages = []
for typename, fields in [('P', ['x', 'class']), ('P', ['x', 'x']), ('P', ['_x']), ('class', ['x']), ('P', ['1a']), (7, ['x'])]:
    try:
        namedtuple(typename, fields)
    except ValueError as e:
        messages.append(str(e))
expected = [('x', '_1', '_2', '_3', '_4', 'z'), ('a', 'b', 'c'), 'R', ('_0', '_1'), 3, {}, {'b': 2}, T(a=1, b=2)]
expected_messages = ["Type names and field names cannot be a keyword: 'class'", "Encountered duplicate field name: 'x'", "Field names cannot start with an underscore: '_x'", "Type names and field names cannot be a keyword: 'class'", "Type names and field names must be valid identifiers: '1a'", "Type names and field names must be valid identifiers: '7'"]
if got != expected or messages != expected_messages:
    raise AssertionError([got, messages])
