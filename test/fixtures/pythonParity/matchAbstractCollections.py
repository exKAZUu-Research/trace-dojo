from collections import UserList, UserDict
from collections.abc import Sequence
def check(*values):
    if not all(values):
        raise ValueError(str(values))
class Registered:
    def __len__(self):
        return 1
    def __iter__(self):
        return iter([5])
    def __getitem__(self, index):
        return [5][index]
def kind(value):
    match value:
        case [x]:
            return ('sequence', x)
        case {'a': x}:
            return ('mapping', x)
        case _:
            return 'other'
before = kind(Registered())
Sequence.register(Registered)
check(kind(UserList([7])) == ('sequence', 7), kind(UserDict(a=7)) == ('mapping', 7))
check(before == 'other', kind(Registered()) == ('sequence', 5), kind('a') == 'other')
