# An enum member refuses writes and deletions of name and value only; _value_ is where value reads from.
import enum


class Q(enum.Enum):
    A = 1


class I(enum.IntEnum):
    B = 2


class F(enum.Flag):
    C = 1


Q.A.extra = 5
got = [Q.A.extra, Q.A.__dict__.get('extra')]
del Q.A.extra
got.append(hasattr(Q.A, 'extra'))
for call in [lambda: setattr(Q.A, 'value', 9), lambda: delattr(Q.A, 'value'), lambda: setattr(Q.A, 'name', 'z'), lambda: delattr(Q.A, 'name'), lambda: setattr(I.B, 'value', 3), lambda: setattr(F.C, 'name', 'x'), lambda: delattr(Q.A, 'nope')]:
    try:
        call()
    except AttributeError as error:
        got.append(str(error))
Q.A._value_ = 5
Q.A._name_ = 'Z'
got += [Q.A.value, Q.A._value_, Q.A.name, repr(Q.A)]
expected = [5, 5, False, "<enum 'Enum'> cannot set attribute 'value'", "<enum 'Enum'> cannot delete attribute 'value'", "<enum 'Enum'> cannot set attribute 'name'", "<enum 'Enum'> cannot delete attribute 'name'", "<enum 'Enum'> cannot set attribute 'value'", "<enum 'Enum'> cannot set attribute 'name'", "'Q' object has no attribute 'nope'", 5, 5, 'Z', '<Q.Z: 5>']
if got != expected:
    raise AssertionError(got)
