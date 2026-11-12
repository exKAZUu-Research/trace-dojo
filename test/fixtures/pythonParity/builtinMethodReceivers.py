import collections
import enum
import functools
import operator
import random


def error_of(call):
    try:
        call()
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)
    return 'no error'


calls = [
    lambda: str.upper(1),
    lambda: str.upper(None),
    lambda: str.upper(),
    lambda: str.__add__(1, 'a'),
    lambda: str.__add__(),
    lambda: list.append(1, 2),
    lambda: list.__len__(1),
    lambda: list.__getitem__(1, 0),
    lambda: dict.get(1, 'a'),
    lambda: dict.update(1),
    lambda: int.__add__('a', 1),
    lambda: int.bit_length('a'),
    lambda: bool.__and__(1, 1),
    lambda: float.is_integer(1),
    lambda: complex.conjugate(1),
    lambda: tuple.index([], 1),
    lambda: set.add(frozenset(), 1),
    lambda: frozenset.union(set(), 1),
    lambda: range.count(1, 2),
    lambda: collections.deque.append(1, 2),
    lambda: collections.deque.append(),
    lambda: collections.deque.__len__(1),
    lambda: collections.OrderedDict.keys({}),
    lambda: collections.defaultdict.copy({}),
    lambda: random.Random.random(1),
    lambda: operator.itemgetter.__call__(1, 2),
    lambda: functools.partial.__call__(1),
    lambda: BaseException.__init__(1),
    lambda: object.__init__(),
    lambda: type.mro(1),
    lambda: list(map(str.upper, ['a', 1])),
    lambda: collections.Counter.most_common(1),
    lambda: collections.Counter.__repr__(),
    lambda: collections.Counter.__iadd__({'x': 1}, collections.Counter(a=1)),
    lambda: random.Random.randint(1, 2, 3),
    lambda: random.Random.choice(None, []),
    lambda: random.Random.seed(1),
    lambda: enum.Enum.__repr__(1),
    lambda: enum.Enum.__str__('a'),
]
expected = [
    "TypeError: descriptor 'upper' for 'str' objects doesn't apply to a 'int' object",
    "TypeError: descriptor 'upper' for 'str' objects doesn't apply to a 'NoneType' object",
    'TypeError: unbound method str.upper() needs an argument',
    "TypeError: descriptor '__add__' requires a 'str' object but received a 'int'",
    "TypeError: descriptor '__add__' of 'str' object needs an argument",
    "TypeError: descriptor 'append' for 'list' objects doesn't apply to a 'int' object",
    "TypeError: descriptor '__len__' requires a 'list' object but received a 'int'",
    "TypeError: descriptor '__getitem__' for 'list' objects doesn't apply to a 'int' object",
    "TypeError: descriptor 'get' for 'dict' objects doesn't apply to a 'int' object",
    "TypeError: descriptor 'update' for 'dict' objects doesn't apply to a 'int' object",
    "TypeError: descriptor '__add__' requires a 'int' object but received a 'str'",
    "TypeError: descriptor 'bit_length' for 'int' objects doesn't apply to a 'str' object",
    "TypeError: descriptor '__and__' requires a 'bool' object but received a 'int'",
    "TypeError: descriptor 'is_integer' for 'float' objects doesn't apply to a 'int' object",
    "TypeError: descriptor 'conjugate' for 'complex' objects doesn't apply to a 'int' object",
    "TypeError: descriptor 'index' for 'tuple' objects doesn't apply to a 'list' object",
    "TypeError: descriptor 'add' for 'set' objects doesn't apply to a 'frozenset' object",
    "TypeError: descriptor 'union' for 'frozenset' objects doesn't apply to a 'set' object",
    "TypeError: descriptor 'count' for 'range' objects doesn't apply to a 'int' object",
    "TypeError: descriptor 'append' for 'collections.deque' objects doesn't apply to a 'int' object",
    'TypeError: unbound method deque.append() needs an argument',
    "TypeError: descriptor '__len__' requires a 'collections.deque' object but received a 'int'",
    "TypeError: descriptor 'keys' for 'collections.OrderedDict' objects doesn't apply to a 'dict' object",
    "TypeError: descriptor 'copy' for 'collections.defaultdict' objects doesn't apply to a 'dict' object",
    "TypeError: descriptor 'random' for '_random.Random' objects doesn't apply to a 'int' object",
    "TypeError: descriptor '__call__' requires a 'operator.itemgetter' object but received a 'int'",
    "TypeError: descriptor '__call__' requires a 'functools.partial' object but received a 'int'",
    "TypeError: descriptor '__init__' requires a 'BaseException' object but received a 'int'",
    "TypeError: descriptor '__init__' of 'object' object needs an argument",
    "TypeError: descriptor 'mro' for 'type' objects doesn't apply to a 'int' object",
    "TypeError: descriptor 'upper' for 'str' objects doesn't apply to a 'int' object",
    "AttributeError: 'int' object has no attribute 'items'",
    "TypeError: Counter.__repr__() missing 1 required positional argument: 'self'",
    "KeyError: 'a'",
    "AttributeError: 'int' object has no attribute '_randbelow'",
    'IndexError: Cannot choose from an empty sequence',
    'TypeError: super(type, obj): obj (instance of int) is not an instance or subtype of type (Random).',
    "AttributeError: type object 'int' has no attribute '_value_repr_'",
    "AttributeError: 'str' object has no attribute '_name_'",
]
got = [error_of(call) for call in calls]
if got != expected:
    raise AssertionError([(g, e) for g, e in zip(got, expected) if g != e])

results = [
    str.upper('a'),
    int.__add__(True, 1),
    bool.__and__(True, 1),
    collections.Counter.copy(1),
    collections.Counter.__add__(1, 2),
    collections.Counter.update(1),
    collections.Counter.__repr__(None),
    collections.Counter.most_common({'x': 2, 'y': 3}),
    enum.Enum.__format__(1, ''),
    enum.IntEnum.__str__(1),
    sorted(['b', 'A', 'c'], key=str.lower),
]
if results != ['A', 2, 1, 1, NotImplemented, None, 'NoneType()', [('y', 3), ('x', 2)], '1', '1', ['A', 'b', 'c']]:
    raise AssertionError(results)
