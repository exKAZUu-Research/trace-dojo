# A subclass of a namedtuple is built by the namedtuple's __new__, keeps its methods, and has a __dict__.
from collections import namedtuple

Point = namedtuple('Point', 'x y')


class NamedPoint(Point):
    def total(self):
        return self.x + self.y


class WithInit(Point):
    def __init__(self, x, y):
        self.extra = x * y


One = namedtuple('One', 'a')


class Sub(One):
    pass


p = NamedPoint(2, 3)
w = WithInit(3, 4)
w.tag = 'a'
got = [p.total(), repr(p), isinstance(p, Point), repr(p._replace(x=5)), repr(NamedPoint._make([1, 2])), repr(Sub(1)), repr(Sub(a=4)), repr(w), w.extra, vars(w), 'tag' in dir(w)]
del w.tag
got.append(w.__dict__)
for call in [lambda: NamedPoint(1), lambda: NamedPoint(1, 2, 3), lambda: Sub(), lambda: setattr(Point(1, 2), 'tag', 1), lambda: delattr(w, 'tag')]:
    try:
        call()
    except (TypeError, AttributeError) as error:
        got.append(str(error))
expected = [5, 'NamedPoint(x=2, y=3)', True, 'NamedPoint(x=5, y=3)', 'NamedPoint(x=1, y=2)', 'Sub(a=1)', 'Sub(a=4)', 'WithInit(x=3, y=4)', 12, {'extra': 12}, True, {'extra': 12}, "Point.__new__() missing 1 required positional argument: 'y'", 'Point.__new__() takes 3 positional arguments but 4 were given', "One.__new__() missing 1 required positional argument: 'a'", "'Point' object has no attribute 'tag' and no __dict__ for setting new attributes", "'WithInit' object has no attribute 'tag'"]
if got != expected:
    raise AssertionError(got)


class WithMethod(Point):
    def m(self):
        return 1


m = WithMethod(1, 2)
got = []
for call in [lambda: setattr(m, 'x', 5), lambda: delattr(m, 'x')]:
    try:
        call()
    except AttributeError as error:
        got.append(str(error))
m.m = 7
got += [m.m, m.__dict__]
del m.m
got.append(m.m())
if got != ["can't set attribute", "can't delete attribute", 7, {}, 1]:
    raise AssertionError(got)

# Copies made by _make and _replace are instances of the subclass with a __dict__ too.
replaced = NamedPoint(1, 2)._replace(x=3)
replaced.label = 'A'
made = NamedPoint._make([1, 2])
made.label = 'B'
plain = Point._make([1, 2])
got = [replaced.label, replaced.__dict__, made.label, repr(replaced), hasattr(plain, '__dict__')]
if got != ['A', {'label': 'A'}, 'B', 'NamedPoint(x=3, y=2)', False]:
    raise AssertionError(got)
