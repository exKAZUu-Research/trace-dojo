def mapping(value):
    match value:
        case {-2: x}:
            return ('a', x)
        case {-1.5: x, 3: y}:
            return ('b', x, y)
        case {-0.0: x}:
            return ('c', x)
        case {'k': -5}:
            return 'negative value'
        case {'k': -5.5 | - 6}:
            return 'negative alternatives'
        case {-7: -8, **rest}:
            return ('r', rest)
    return None


def alternatives(value):
    match value:
        case -5.5 | -6:
            return 'u'
        case 1 | -2 | 3:
            return 'v'
        case [-1, -2 | -3]:
            return 'w'
        case (-4 | 4) as z:
            return z
    return None


results = [
    mapping({-2: 7}),
    mapping({-1.5: 1, 3: 2}),
    mapping({0.0: 5}),
    mapping({'k': -5}),
    mapping({'k': -6}),
    mapping({'k': 6}),
    mapping({-7: -8, 1: 2}),
    mapping({-7: 8}),
    mapping({2: 7}),
]
expected = [('a', 7), ('b', 1, 2), ('c', 5), 'negative value', 'negative alternatives', None, ('r', {1: 2}), None, None]
if results != expected:
    raise AssertionError(repr(results))

results = [alternatives(v) for v in [-6, -5.5, 6, -2, 2, [-1, -3], [-1, 3], -4, 4, 5.5]]
expected = ['u', 'u', None, 'v', None, 'w', None, -4, 4, None]
if results != expected:
    raise AssertionError(repr(results))
