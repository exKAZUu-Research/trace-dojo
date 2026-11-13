from collections import OrderedDict as O


def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))


o = O([('b', 2), ('a', 1)])
d = {'x': 1}
check([repr(o.keys()), repr(o.values()), repr(o.items()), repr(O().items())], ["odict_keys(['b', 'a'])", 'odict_values([2, 1])', "odict_items([('b', 2), ('a', 1)])", 'odict_items([])'])
check([type(x).__name__ for x in [o.keys(), o.values(), o.items(), iter(o), iter(o.keys()), iter(o.values()), iter(o.items()), reversed(o), reversed(o.keys()), reversed(o.values()), reversed(o.items())]], ['odict_keys', 'odict_values', 'odict_items', 'odict_iterator', 'odict_iterator', 'odict_iterator', 'odict_iterator', 'odict_iterator', 'odict_iterator', 'odict_iterator', 'odict_iterator'])
check([isinstance(o.keys(), type({}.keys())), o.keys() == {'a', 'b'}, o.keys() & {'a'}, list(reversed(o.items()))], [True, True, {'a'}, [('a', 1), ('b', 2)]])
check([repr(d.keys()), [type(x).__name__ for x in [iter(d), iter(d.values()), reversed(d)]]], ["dict_keys(['x'])", ['dict_keyiterator', 'dict_valueiterator', 'dict_reversekeyiterator']])
check([cls.__name__ for cls in type(o.keys()).__mro__], ['odict_keys', 'dict_keys', 'object'])
