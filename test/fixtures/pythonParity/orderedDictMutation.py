from collections import OrderedDict as O


def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))


def run(mutate, make):
    o = O(a=1, b=2, c=3)
    it = make(o)
    try:
        next(it)
        mutate(o)
        return list(it)
    except RuntimeError as e:
        return 'RuntimeError: ' + str(e)


check(run(lambda o: o.__setitem__('d', 4), lambda o: iter(o)), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: (o.__delitem__('c'), o.__setitem__('d', 4)), lambda o: iter(o)), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('b', 9), lambda o: iter(o)), ['b', 'c'])
check(run(lambda o: o.move_to_end('a'), lambda o: iter(o)), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('d', 4), lambda o: iter(o.keys())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: (o.__delitem__('c'), o.__setitem__('d', 4)), lambda o: iter(o.keys())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('b', 9), lambda o: iter(o.keys())), ['b', 'c'])
check(run(lambda o: o.move_to_end('a'), lambda o: iter(o.keys())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('d', 4), lambda o: iter(o.values())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: (o.__delitem__('c'), o.__setitem__('d', 4)), lambda o: iter(o.values())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('b', 9), lambda o: iter(o.values())), [9, 3])
check(run(lambda o: o.move_to_end('a'), lambda o: iter(o.values())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('d', 4), lambda o: iter(o.items())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: (o.__delitem__('c'), o.__setitem__('d', 4)), lambda o: iter(o.items())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('b', 9), lambda o: iter(o.items())), [('b', 9), ('c', 3)])
check(run(lambda o: o.move_to_end('a'), lambda o: iter(o.items())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('d', 4), lambda o: reversed(o)), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: (o.__delitem__('c'), o.__setitem__('d', 4)), lambda o: reversed(o)), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('b', 9), lambda o: reversed(o)), ['b', 'a'])
check(run(lambda o: o.move_to_end('a'), lambda o: reversed(o)), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('d', 4), lambda o: reversed(o.keys())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: (o.__delitem__('c'), o.__setitem__('d', 4)), lambda o: reversed(o.keys())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('b', 9), lambda o: reversed(o.keys())), ['b', 'a'])
check(run(lambda o: o.move_to_end('a'), lambda o: reversed(o.keys())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('d', 4), lambda o: reversed(o.values())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: (o.__delitem__('c'), o.__setitem__('d', 4)), lambda o: reversed(o.values())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('b', 9), lambda o: reversed(o.values())), [9, 1])
check(run(lambda o: o.move_to_end('a'), lambda o: reversed(o.values())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('d', 4), lambda o: reversed(o.items())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: (o.__delitem__('c'), o.__setitem__('d', 4)), lambda o: reversed(o.items())), 'RuntimeError: OrderedDict mutated during iteration')
check(run(lambda o: o.__setitem__('b', 9), lambda o: reversed(o.items())), [('b', 9), ('a', 1)])
check(run(lambda o: o.move_to_end('a'), lambda o: reversed(o.items())), 'RuntimeError: OrderedDict mutated during iteration')
d = {'a': 1, 'b': 2, 'c': 3}
it = iter(d)
next(it)
del d['c']
d['d'] = 4
check(list(it), ['b', 'd'])
