def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))

def outcome(call):
    try:
        return repr(call())
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)

d = {'a': 1, 'b': 2, 'c': 3}
del d['b']
d['d'] = 4
check(list(reversed(d)), ['d', 'c', 'a'])
check(list(reversed(d.keys())), ['d', 'c', 'a'])
check(list(reversed(d.values())), [4, 3, 1])
check(list(reversed(d.items())), [('d', 4), ('c', 3), ('a', 1)])
check([type(reversed(d)).__name__, type(reversed(d.values())).__name__, type(reversed(d.items())).__name__], ['dict_reversekeyiterator', 'dict_reversevalueiterator', 'dict_reverseitemiterator'])
it = reversed(d)
check([it.__length_hint__(), next(it), it.__length_hint__()], [3, 'd', 2])
d['e'] = 5
check([it.__length_hint__(), outcome(lambda: next(it)), outcome(lambda: next(it))], [0, 'RuntimeError: dictionary changed size during iteration', 'RuntimeError: dictionary changed size during iteration'])
e = {1: 1}
it = reversed(e)
check(next(it), 1)
check(outcome(lambda: next(it)), 'StopIteration: ')
e[2] = 2
check([outcome(lambda: next(it)), it.__length_hint__()], ['StopIteration: ', 0])
f = {1: 1, 2: 2}
it = reversed(f)
f[1] = 9
check(list(it), [2, 1])
big = dict.fromkeys(range(100000))
for i in range(5000):
    last = next(reversed(big))
check(last, 99999)
