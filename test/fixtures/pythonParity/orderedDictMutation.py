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


def run_after_first(mutate, make):
    o = O(a=1, b=2, c=3)
    it = make(o)
    try:
        first = next(it)
        mutate(o)
        return (first, list(it))
    except RuntimeError as e:
        return 'RuntimeError: ' + str(e)


check(run_after_first(lambda o: o.move_to_end('a', last=False), lambda o: iter(o)), ('a', ['b', 'c']))
check(run_after_first(lambda o: o.move_to_end('c'), lambda o: iter(o)), ('a', ['b', 'c']))
check(run_after_first(lambda o: (o.move_to_end('c'), o.move_to_end('c')), lambda o: iter(o)), ('a', ['b', 'c']))
check(run_after_first(lambda o: o.move_to_end('b'), lambda o: iter(o)), 'RuntimeError: OrderedDict mutated during iteration')
check(run_after_first(lambda o: o.move_to_end('a', last=False), lambda o: iter(o.values())), (1, [2, 3]))
check(run_after_first(lambda o: o.move_to_end('c'), lambda o: iter(o.values())), (1, [2, 3]))
check(run_after_first(lambda o: (o.move_to_end('c'), o.move_to_end('c')), lambda o: iter(o.values())), (1, [2, 3]))
check(run_after_first(lambda o: o.move_to_end('b'), lambda o: iter(o.values())), 'RuntimeError: OrderedDict mutated during iteration')
check(run_after_first(lambda o: o.move_to_end('a', last=False), lambda o: reversed(o)), ('c', ['b', 'a']))
check(run_after_first(lambda o: o.move_to_end('c'), lambda o: reversed(o)), ('c', ['b', 'a']))
check(run_after_first(lambda o: (o.move_to_end('c'), o.move_to_end('c')), lambda o: reversed(o)), ('c', ['b', 'a']))
check(run_after_first(lambda o: o.move_to_end('b'), lambda o: reversed(o)), 'RuntimeError: OrderedDict mutated during iteration')
o = O(a=1, b=2)
seen = []
for k in o:
    o['b'] = 2
    o.move_to_end('b')
    seen.append(k)
check([seen, list(o)], [['a', 'b'], ['a', 'b']])
