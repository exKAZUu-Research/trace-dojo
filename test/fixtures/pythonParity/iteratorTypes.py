import itertools, collections
from collections import deque, OrderedDict, Counter, defaultdict


def mask(text):
    out = ''
    i = 0
    while i < len(text):
        if text.startswith('0x', i):
            out += '0xADDR'
            i += 2
            while i < len(text) and text[i] in '0123456789abcdef':
                i += 1
        else:
            out += text[i]
            i += 1
    return out


seen = []


def show(e, make):
    try:
        v = make()
        t = type(v)
        seen.append(e + ' | ' + t.__module__ + ' ' + t.__qualname__ + ' | ' + mask(repr(v)))
    except Exception as ex:
        seen.append(e + ' | ERR ' + type(ex).__name__ + ' ' + str(ex))


d = deque([1, 2])

def gen():
    yield 1


def outer():
    def inner():
        yield 1
    return inner(), (x for x in [1])


class K:
    def m(self):
        yield 1


c = itertools.count(3)
next(c)
r = itertools.repeat('a', 2)
next(r)
show('iter([1])', lambda: iter([1]))
show('iter((1,))', lambda: iter((1,)))
show("iter('a')", lambda: iter('a'))
show("iter('é')", lambda: iter('é'))
show('iter({1: 2})', lambda: iter({1: 2}))
show('iter({1: 2}.keys())', lambda: iter({1: 2}.keys()))
show('iter({1: 2}.values())', lambda: iter({1: 2}.values()))
show('iter({1: 2}.items())', lambda: iter({1: 2}.items()))
show('iter({1})', lambda: iter({1}))
show('iter(frozenset({1}))', lambda: iter(frozenset({1})))
show('iter(range(2))', lambda: iter(range(2)))
show('iter(d)', lambda: iter(d))
show('reversed(d)', lambda: reversed(d))
show('reversed([1])', lambda: reversed([1]))
show('reversed((1,))', lambda: reversed((1,)))
show("reversed('ab')", lambda: reversed('ab'))
show('reversed(range(2))', lambda: reversed(range(2)))
show('reversed({1: 2})', lambda: reversed({1: 2}))
show('enumerate([1])', lambda: enumerate([1]))
show('zip([1])', lambda: zip([1]))
show('map(abs, [1])', lambda: map(abs, [1]))
show('filter(None, [1])', lambda: filter(None, [1]))
show('(x for x in [1])', lambda: (x for x in [1]))
show('iter(lambda: 1, 2)', lambda: iter(lambda: 1, 2))
show('iter(OrderedDict(a=1))', lambda: iter(OrderedDict(a=1)))
show('iter(Counter(a=1))', lambda: iter(Counter(a=1)))
show('iter(defaultdict(int))', lambda: iter(defaultdict(int)))
show('itertools.count()', lambda: itertools.count())
show('itertools.count(5, 2)', lambda: itertools.count(5, 2))
show('itertools.count(1.5)', lambda: itertools.count(1.5))
show('itertools.count(0, 0.5)', lambda: itertools.count(0, 0.5))
show('itertools.count(-1)', lambda: itertools.count(-1))
show('itertools.count(2**70)', lambda: itertools.count(2**70))
show('itertools.repeat(7)', lambda: itertools.repeat(7))
show("itertools.repeat('x', 3)", lambda: itertools.repeat('x', 3))
show('itertools.repeat(None, 0)', lambda: itertools.repeat(None, 0))
show('itertools.repeat(1, -2)', lambda: itertools.repeat(1, -2))
show('itertools.cycle([1])', lambda: itertools.cycle([1]))
show('itertools.accumulate([1])', lambda: itertools.accumulate([1]))
show('itertools.chain([1])', lambda: itertools.chain([1]))
show('itertools.chain.from_iterable([[1]])', lambda: itertools.chain.from_iterable([[1]]))
show('itertools.compress([1], [1])', lambda: itertools.compress([1], [1]))
show('itertools.dropwhile(bool, [1])', lambda: itertools.dropwhile(bool, [1]))
show('itertools.filterfalse(None, [1])', lambda: itertools.filterfalse(None, [1]))
show('itertools.groupby([1])', lambda: itertools.groupby([1]))
show('next(itertools.groupby([1]))[1]', lambda: next(itertools.groupby([1]))[1])
show('itertools.islice([1], 1)', lambda: itertools.islice([1], 1))
show('itertools.pairwise([1])', lambda: itertools.pairwise([1]))
show('itertools.starmap(abs, [(1,)])', lambda: itertools.starmap(abs, [(1,)]))
show('itertools.takewhile(bool, [1])', lambda: itertools.takewhile(bool, [1]))
show('itertools.tee([1])[0]', lambda: itertools.tee([1])[0])
show('itertools.zip_longest([1])', lambda: itertools.zip_longest([1]))
show('itertools.product([1])', lambda: itertools.product([1]))
show('itertools.permutations([1])', lambda: itertools.permutations([1]))
show('itertools.combinations([1], 1)', lambda: itertools.combinations([1], 1))
show('itertools.combinations_with_replacement([1], 1)', lambda: itertools.combinations_with_replacement([1], 1))
show('itertools.batched([1], 1)', lambda: itertools.batched([1], 1))
show('gen()', lambda: gen())
show('outer()[0]', lambda: outer()[0])
show('outer()[1]', lambda: outer()[1])
show('K().m()', lambda: K().m())
show('count after next', lambda: c)
show('repeat after next', lambda: r)
show('count(True)', lambda: itertools.count(True))
show('count(1, 1.0)', lambda: itertools.count(1, 1.0))
show('count(1, True)', lambda: itertools.count(1, True))
if seen != ['iter([1]) | builtins list_iterator | <list_iterator object at 0xADDR>', 'iter((1,)) | builtins tuple_iterator | <tuple_iterator object at 0xADDR>', "iter('a') | builtins str_ascii_iterator | <str_ascii_iterator object at 0xADDR>", "iter('é') | builtins str_iterator | <str_iterator object at 0xADDR>", 'iter({1: 2}) | builtins dict_keyiterator | <dict_keyiterator object at 0xADDR>', 'iter({1: 2}.keys()) | builtins dict_keyiterator | <dict_keyiterator object at 0xADDR>', 'iter({1: 2}.values()) | builtins dict_valueiterator | <dict_valueiterator object at 0xADDR>', 'iter({1: 2}.items()) | builtins dict_itemiterator | <dict_itemiterator object at 0xADDR>', 'iter({1}) | builtins set_iterator | <set_iterator object at 0xADDR>', 'iter(frozenset({1})) | builtins set_iterator | <set_iterator object at 0xADDR>', 'iter(range(2)) | builtins range_iterator | <range_iterator object at 0xADDR>', 'iter(d) | collections _deque_iterator | <collections._deque_iterator object at 0xADDR>', 'reversed(d) | collections _deque_reverse_iterator | <collections._deque_reverse_iterator object at 0xADDR>', 'reversed([1]) | builtins list_reverseiterator | <list_reverseiterator object at 0xADDR>', 'reversed((1,)) | builtins reversed | <reversed object at 0xADDR>', "reversed('ab') | builtins reversed | <reversed object at 0xADDR>", 'reversed(range(2)) | builtins range_iterator | <range_iterator object at 0xADDR>', 'reversed({1: 2}) | builtins dict_reversekeyiterator | <dict_reversekeyiterator object at 0xADDR>', 'enumerate([1]) | builtins enumerate | <enumerate object at 0xADDR>', 'zip([1]) | builtins zip | <zip object at 0xADDR>', 'map(abs, [1]) | builtins map | <map object at 0xADDR>', 'filter(None, [1]) | builtins filter | <filter object at 0xADDR>', '(x for x in [1]) | builtins generator | <generator object <lambda>.<locals>.<genexpr> at 0xADDR>', 'iter(lambda: 1, 2) | builtins callable_iterator | <callable_iterator object at 0xADDR>', 'iter(OrderedDict(a=1)) | builtins odict_iterator | <odict_iterator object at 0xADDR>', 'iter(Counter(a=1)) | builtins dict_keyiterator | <dict_keyiterator object at 0xADDR>', 'iter(defaultdict(int)) | builtins dict_keyiterator | <dict_keyiterator object at 0xADDR>', 'itertools.count() | itertools count | count(0)', 'itertools.count(5, 2) | itertools count | count(5, 2)', 'itertools.count(1.5) | itertools count | count(1.5)', 'itertools.count(0, 0.5) | itertools count | count(0, 0.5)', 'itertools.count(-1) | itertools count | count(-1)', 'itertools.count(2**70) | itertools count | count(1180591620717411303424)', 'itertools.repeat(7) | itertools repeat | repeat(7)', "itertools.repeat('x', 3) | itertools repeat | repeat('x', 3)", 'itertools.repeat(None, 0) | itertools repeat | repeat(None, 0)', 'itertools.repeat(1, -2) | itertools repeat | repeat(1, 0)', 'itertools.cycle([1]) | itertools cycle | <itertools.cycle object at 0xADDR>', 'itertools.accumulate([1]) | itertools accumulate | <itertools.accumulate object at 0xADDR>', 'itertools.chain([1]) | itertools chain | <itertools.chain object at 0xADDR>', 'itertools.chain.from_iterable([[1]]) | itertools chain | <itertools.chain object at 0xADDR>', 'itertools.compress([1], [1]) | itertools compress | <itertools.compress object at 0xADDR>', 'itertools.dropwhile(bool, [1]) | itertools dropwhile | <itertools.dropwhile object at 0xADDR>', 'itertools.filterfalse(None, [1]) | itertools filterfalse | <itertools.filterfalse object at 0xADDR>', 'itertools.groupby([1]) | itertools groupby | <itertools.groupby object at 0xADDR>', 'next(itertools.groupby([1]))[1] | itertools _grouper | <itertools._grouper object at 0xADDR>', 'itertools.islice([1], 1) | itertools islice | <itertools.islice object at 0xADDR>', 'itertools.pairwise([1]) | itertools pairwise | <itertools.pairwise object at 0xADDR>', 'itertools.starmap(abs, [(1,)]) | itertools starmap | <itertools.starmap object at 0xADDR>', 'itertools.takewhile(bool, [1]) | itertools takewhile | <itertools.takewhile object at 0xADDR>', 'itertools.tee([1])[0] | itertools _tee | <itertools._tee object at 0xADDR>', 'itertools.zip_longest([1]) | itertools zip_longest | <itertools.zip_longest object at 0xADDR>', 'itertools.product([1]) | itertools product | <itertools.product object at 0xADDR>', 'itertools.permutations([1]) | itertools permutations | <itertools.permutations object at 0xADDR>', 'itertools.combinations([1], 1) | itertools combinations | <itertools.combinations object at 0xADDR>', 'itertools.combinations_with_replacement([1], 1) | itertools combinations_with_replacement | <itertools.combinations_with_replacement object at 0xADDR>', 'itertools.batched([1], 1) | itertools batched | <itertools.batched object at 0xADDR>', 'gen() | builtins generator | <generator object gen at 0xADDR>', 'outer()[0] | builtins generator | <generator object outer.<locals>.inner at 0xADDR>', 'outer()[1] | builtins generator | <generator object outer.<locals>.<genexpr> at 0xADDR>', 'K().m() | builtins generator | <generator object K.m at 0xADDR>', 'count after next | itertools count | count(4)', "repeat after next | itertools repeat | repeat('a', 1)", 'count(True) | itertools count | count(1)', 'count(1, 1.0) | itertools count | count(1, 1.0)', 'count(1, True) | itertools count | count(1)']:
    raise AssertionError([(a, b) for a, b in zip(seen, ['iter([1]) | builtins list_iterator | <list_iterator object at 0xADDR>', 'iter((1,)) | builtins tuple_iterator | <tuple_iterator object at 0xADDR>', "iter('a') | builtins str_ascii_iterator | <str_ascii_iterator object at 0xADDR>", "iter('é') | builtins str_iterator | <str_iterator object at 0xADDR>", 'iter({1: 2}) | builtins dict_keyiterator | <dict_keyiterator object at 0xADDR>', 'iter({1: 2}.keys()) | builtins dict_keyiterator | <dict_keyiterator object at 0xADDR>', 'iter({1: 2}.values()) | builtins dict_valueiterator | <dict_valueiterator object at 0xADDR>', 'iter({1: 2}.items()) | builtins dict_itemiterator | <dict_itemiterator object at 0xADDR>', 'iter({1}) | builtins set_iterator | <set_iterator object at 0xADDR>', 'iter(frozenset({1})) | builtins set_iterator | <set_iterator object at 0xADDR>', 'iter(range(2)) | builtins range_iterator | <range_iterator object at 0xADDR>', 'iter(d) | collections _deque_iterator | <collections._deque_iterator object at 0xADDR>', 'reversed(d) | collections _deque_reverse_iterator | <collections._deque_reverse_iterator object at 0xADDR>', 'reversed([1]) | builtins list_reverseiterator | <list_reverseiterator object at 0xADDR>', 'reversed((1,)) | builtins reversed | <reversed object at 0xADDR>', "reversed('ab') | builtins reversed | <reversed object at 0xADDR>", 'reversed(range(2)) | builtins range_iterator | <range_iterator object at 0xADDR>', 'reversed({1: 2}) | builtins dict_reversekeyiterator | <dict_reversekeyiterator object at 0xADDR>', 'enumerate([1]) | builtins enumerate | <enumerate object at 0xADDR>', 'zip([1]) | builtins zip | <zip object at 0xADDR>', 'map(abs, [1]) | builtins map | <map object at 0xADDR>', 'filter(None, [1]) | builtins filter | <filter object at 0xADDR>', '(x for x in [1]) | builtins generator | <generator object <lambda>.<locals>.<genexpr> at 0xADDR>', 'iter(lambda: 1, 2) | builtins callable_iterator | <callable_iterator object at 0xADDR>', 'iter(OrderedDict(a=1)) | builtins odict_iterator | <odict_iterator object at 0xADDR>', 'iter(Counter(a=1)) | builtins dict_keyiterator | <dict_keyiterator object at 0xADDR>', 'iter(defaultdict(int)) | builtins dict_keyiterator | <dict_keyiterator object at 0xADDR>', 'itertools.count() | itertools count | count(0)', 'itertools.count(5, 2) | itertools count | count(5, 2)', 'itertools.count(1.5) | itertools count | count(1.5)', 'itertools.count(0, 0.5) | itertools count | count(0, 0.5)', 'itertools.count(-1) | itertools count | count(-1)', 'itertools.count(2**70) | itertools count | count(1180591620717411303424)', 'itertools.repeat(7) | itertools repeat | repeat(7)', "itertools.repeat('x', 3) | itertools repeat | repeat('x', 3)", 'itertools.repeat(None, 0) | itertools repeat | repeat(None, 0)', 'itertools.repeat(1, -2) | itertools repeat | repeat(1, 0)', 'itertools.cycle([1]) | itertools cycle | <itertools.cycle object at 0xADDR>', 'itertools.accumulate([1]) | itertools accumulate | <itertools.accumulate object at 0xADDR>', 'itertools.chain([1]) | itertools chain | <itertools.chain object at 0xADDR>', 'itertools.chain.from_iterable([[1]]) | itertools chain | <itertools.chain object at 0xADDR>', 'itertools.compress([1], [1]) | itertools compress | <itertools.compress object at 0xADDR>', 'itertools.dropwhile(bool, [1]) | itertools dropwhile | <itertools.dropwhile object at 0xADDR>', 'itertools.filterfalse(None, [1]) | itertools filterfalse | <itertools.filterfalse object at 0xADDR>', 'itertools.groupby([1]) | itertools groupby | <itertools.groupby object at 0xADDR>', 'next(itertools.groupby([1]))[1] | itertools _grouper | <itertools._grouper object at 0xADDR>', 'itertools.islice([1], 1) | itertools islice | <itertools.islice object at 0xADDR>', 'itertools.pairwise([1]) | itertools pairwise | <itertools.pairwise object at 0xADDR>', 'itertools.starmap(abs, [(1,)]) | itertools starmap | <itertools.starmap object at 0xADDR>', 'itertools.takewhile(bool, [1]) | itertools takewhile | <itertools.takewhile object at 0xADDR>', 'itertools.tee([1])[0] | itertools _tee | <itertools._tee object at 0xADDR>', 'itertools.zip_longest([1]) | itertools zip_longest | <itertools.zip_longest object at 0xADDR>', 'itertools.product([1]) | itertools product | <itertools.product object at 0xADDR>', 'itertools.permutations([1]) | itertools permutations | <itertools.permutations object at 0xADDR>', 'itertools.combinations([1], 1) | itertools combinations | <itertools.combinations object at 0xADDR>', 'itertools.combinations_with_replacement([1], 1) | itertools combinations_with_replacement | <itertools.combinations_with_replacement object at 0xADDR>', 'itertools.batched([1], 1) | itertools batched | <itertools.batched object at 0xADDR>', 'gen() | builtins generator | <generator object gen at 0xADDR>', 'outer()[0] | builtins generator | <generator object outer.<locals>.inner at 0xADDR>', 'outer()[1] | builtins generator | <generator object outer.<locals>.<genexpr> at 0xADDR>', 'K().m() | builtins generator | <generator object K.m at 0xADDR>', 'count after next | itertools count | count(4)', "repeat after next | itertools repeat | repeat('a', 1)", 'count(True) | itertools count | count(1)', 'count(1, 1.0) | itertools count | count(1, 1.0)', 'count(1, True) | itertools count | count(1)']) if a != b])
