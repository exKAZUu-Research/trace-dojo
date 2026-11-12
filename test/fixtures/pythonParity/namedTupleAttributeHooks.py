# A namedtuple subclass's __setattr__ and __delattr__ run for its attributes, and object's methods bypass them.
from collections import namedtuple

Base = namedtuple('Base', 'x')


class Guarded(Base):
    def __setattr__(self, name, value):
        if name == 'score' and value < 0:
            raise ValueError('negative')
        object.__setattr__(self, name, value)

    def __delattr__(self, name):
        if name == 'score':
            raise AttributeError('keep score')
        object.__delattr__(self, name)


g = Guarded(1)
g.score = 3
got = [g.score]
for call in [lambda: setattr(g, 'score', -1), lambda: delattr(g, 'score'), lambda: setattr(g, 'x', 2)]:
    try:
        call()
    except (ValueError, AttributeError) as error:
        got.append(str(error))
g.tag = 1
del g.tag
got.append(hasattr(g, 'tag'))
if got != [3, 'negative', 'keep score', "can't set attribute", False]:
    raise AssertionError(got)
