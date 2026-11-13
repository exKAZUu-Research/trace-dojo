class Seq:
    def __init__(self):
        self.reads = []
    def __len__(self):
        return 5
    def __getitem__(self, index):
        self.reads.append(index)
        if index < 0 or index >= 5:
            raise IndexError(index)
        return index * 10
from collections.abc import Sequence
Sequence.register(Seq)
def m(x):
    match x:
        case [a, b]:
            return ('two', a, b)
        case [a, *_, b]:
            return ('ends', a, b)
        case _:
            return 'other'
s = Seq()
got = [m(range(1000000)), m([1, 2]), m((1, 2, 3)), m(s), s.reads, m('ab'), m(range(2))]
t = Seq()
match t:
    case [first, *rest]:
        got.append([first, rest])
if got != [('ends', 0, 999999), ('two', 1, 2), ('ends', 1, 3), ('ends', 0, 40), [0, 4], 'other', ('two', 0, 1), [0, [10, 20, 30, 40]]]:
    raise AssertionError(got)
