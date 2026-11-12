import operator
from functools import reduce
from operator import attrgetter, itemgetter, methodcaller


class Person:
    def __init__(self, name, age):
        self.name = name
        self.age = age

    def __repr__(self):
        return 'Person(%r)' % self.name

    def greet(self, greeting, mark='!'):
        return greeting + ' ' + self.name + mark


class Hinted:
    def __init__(self, hint):
        self.hint = hint

    def __length_hint__(self):
        return self.hint


def extend_in_place():
    items = [1]
    same = operator.iadd(items, [2])
    return (items, same is items)


people = [Person('b', 3), Person('a', 3), Person('c', 1)]


def outcome(thunk):
    try:
        return repr(thunk())
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)


def check(thunk, expected):
    actual = outcome(thunk)
    if actual != expected:
        raise AssertionError('expected ' + expected + ' but got ' + actual)


check(lambda: sorted(people, key=attrgetter('age', 'name')), "[Person('c'), Person('a'), Person('b')]")
check(lambda: max(people, key=attrgetter('age')), "Person('b')")
check(lambda: list(map(methodcaller('greet', 'hi', mark='?'), people)), "['hi b?', 'hi a?', 'hi c?']")
check(lambda: sorted({'a': 2, 'b': 1}.items(), key=itemgetter(1)), "[('b', 1), ('a', 2)]")
check(lambda: (itemgetter(1)([1, 2]), itemgetter(0, -1)('abc'), itemgetter(slice(1, None))('abc'), itemgetter('a')({'a': 1})), "(2, ('a', 'c'), 'bc', 1)")
check(lambda: (reduce(operator.add, [1, 2, 3]), reduce(operator.mul, [1, 2, 3], 10)), '(6, 60)')
check(lambda: (attrgetter('real')(3), attrgetter('real.imag', 'imag')(3)), '(3, (0, 0))')
check(lambda: (operator.add, operator.itemgetter, itemgetter(1), itemgetter(1, 'a')), "(<built-in function add>, <class 'operator.itemgetter'>, operator.itemgetter(1), operator.itemgetter(1, 'a'))")
check(lambda: (attrgetter('a.b', 'c'), methodcaller('upper'), methodcaller('f', 1, 'a', k=2, j=[1])), "(operator.attrgetter('a.b', 'c'), operator.methodcaller('upper'), operator.methodcaller('f', 1, 'a', k=2, j=[1]))")
check(lambda: (type(itemgetter(1)), itemgetter(1) == itemgetter(1), callable(itemgetter(0)), str(attrgetter('a'))), '(<class \'operator.itemgetter\'>, False, True, "operator.attrgetter(\'a\')")')
check(lambda: itemgetter(), 'TypeError: itemgetter expected 1 argument, got 0')
check(lambda: itemgetter(k=1), 'TypeError: itemgetter() takes no keyword arguments')
check(lambda: itemgetter(5)([1]), 'IndexError: list index out of range')
check(lambda: itemgetter(1)([1], 2), 'TypeError: itemgetter expected 1 argument, got 2')
check(lambda: itemgetter(1)(), 'TypeError: itemgetter expected 1 argument, got 0')
check(lambda: itemgetter(1)(x=1), 'TypeError: itemgetter() takes no keyword arguments')
check(lambda: attrgetter(), 'TypeError: attrgetter expected 1 argument, got 0')
check(lambda: attrgetter(1), 'TypeError: attribute name must be a string')
check(lambda: attrgetter('x')(3), "AttributeError: 'int' object has no attribute 'x'")
check(lambda: attrgetter('a')(1, 2), 'TypeError: attrgetter expected 1 argument, got 2')
check(lambda: methodcaller(), 'TypeError: methodcaller needs at least one argument, the method name')
check(lambda: methodcaller(1), 'TypeError: method name must be a string')
check(lambda: methodcaller('a')(1, 2), 'TypeError: methodcaller expected 1 argument, got 2')
check(lambda: methodcaller('split', 'b', maxsplit=1)('abcbd'), "['a', 'cbd']")
check(lambda: (operator.sub(5, 2.5), operator.truediv(1, 2), operator.floordiv(7, 2), operator.mod(7, 3), operator.pow(2, -1)), '(2.5, 0.5, 3, 1, 0.5)')
check(lambda: (operator.lshift(1, 3), operator.rshift(8, 1), operator.and_({1, 2}, {2}), operator.or_(1, 2), operator.xor(True, False)), '(8, 4, {2}, 3, True)')
check(lambda: (operator.lt(1, 2), operator.le(2, 2), operator.eq(1, 1.0), operator.ne([1], [1]), operator.ge('a', 'b'), operator.gt(2, 1)), '(True, True, True, False, False, True)')
check(lambda: (operator.neg(3), operator.pos(-3), operator.abs(-3), operator.inv(1), operator.invert(2), operator.index(True)), '(-3, -3, 3, -2, -3, 1)')
check(lambda: (operator.not_(0), operator.truth([]), operator.is_(None, None), operator.is_not(None, 1), operator.is_none(None), operator.is_not_none(None)), '(True, False, True, True, True, False)')
check(lambda: (operator.concat([1], [2]), operator.contains('abc', 'b'), operator.countOf([1, 1.0, True, 2], 1), operator.indexOf('abc', 'c')), '([1, 2], True, 3, 2)')
check(lambda: (operator.getitem([1, 2], 1), operator.setitem([1], 0, 2), operator.delitem({1: 2}, 1)), '(2, None, None)')
check(lambda: (operator.length_hint([1, 2]), operator.length_hint(3), operator.length_hint(3, 5), operator.length_hint(iter([1, 2])), operator.length_hint(Hinted(7))), '(2, 0, 5, 2, 7)')
check(lambda: (operator.length_hint(Hinted(NotImplemented), 4), operator.call(len, [1]), operator.call(int, '3', base=5)), '(4, 1, 3)')
check(lambda: (operator.iadd(1, 2), operator.imul('a', 2), operator.isub(1, 2), operator.iand(6, 3), operator.ior({1: 2}, {3: 4}), operator.ixor({1}, {2})), "(3, 'aa', -1, 2, {1: 2, 3: 4}, {1, 2})")
check(lambda: (operator.itruediv(1, 2), operator.ifloordiv(7, 2), operator.imod(7, 3), operator.ipow(2, 3), operator.ilshift(1, 3), operator.irshift(4, 1)), '(0.5, 3, 1, 8, 8, 2)')
check(lambda: extend_in_place(), '([1, 2], True)')
check(lambda: (operator.__add__ is operator.add, operator.__not__(1), operator.__lt__(1, 2), operator.__concat__('a', 'b'), operator.__index__(5)), "(True, False, True, 'ab', 5)")
check(lambda: (operator.add.__name__, operator.__name__, operator.itemgetter.__module__), "('add', 'operator', 'operator')")
check(lambda: operator.add(1), 'TypeError: add expected 2 arguments, got 1')
check(lambda: operator.neg(), 'TypeError: _operator.neg() takes exactly one argument (0 given)')
check(lambda: operator.add(1, b=2), 'TypeError: _operator.add() takes no keyword arguments')
check(lambda: operator.neg(a=1), 'TypeError: _operator.neg() takes no keyword arguments')
check(lambda: operator.pow(1, 2, 3), 'TypeError: pow expected 2 arguments, got 3')
check(lambda: operator.truth(1, 2), 'TypeError: _operator.truth() takes exactly one argument (2 given)')
check(lambda: operator.setitem([1], 0), 'TypeError: setitem expected 3 arguments, got 2')
check(lambda: operator.length_hint(), 'TypeError: length_hint expected at least 1 argument, got 0')
check(lambda: operator.length_hint([1], 2, 3), 'TypeError: length_hint expected at most 2 arguments, got 3')
check(lambda: operator.length_hint(3, 'a'), "TypeError: 'str' object cannot be interpreted as an integer")
check(lambda: operator.length_hint(Hinted(-1)), 'ValueError: __length_hint__() should return >= 0')
check(lambda: operator.length_hint(Hinted('a')), 'TypeError: __length_hint__ must be an integer, not str')
check(lambda: operator.call(), 'TypeError: call expected at least 1 argument, got 0')
check(lambda: operator.concat(1, 2), "TypeError: 'int' object can't be concatenated")
check(lambda: operator.concat([1], (2,)), 'TypeError: can only concatenate list (not "tuple") to list')
check(lambda: operator.iconcat(1, 2), "TypeError: 'int' object can't be concatenated")
check(lambda: operator.indexOf([1, 2], 3), 'ValueError: sequence.index(x): x not in sequence')
check(lambda: operator.countOf(1, 1), "TypeError: argument of type 'int' is not iterable")
check(lambda: operator.contains(1, 1), "TypeError: argument of type 'int' is not a container or iterable")
check(lambda: operator.getitem(1, 1), "TypeError: 'int' object is not subscriptable")
check(lambda: operator.index('a'), "TypeError: 'str' object cannot be interpreted as an integer")
check(lambda: operator.index(1.5), "TypeError: 'float' object cannot be interpreted as an integer")
check(lambda: operator.neg('a'), "TypeError: bad operand type for unary -: 'str'")
check(lambda: operator.matmul(1, 2), "TypeError: unsupported operand type(s) for @: 'int' and 'int'")
check(lambda: operator.imatmul(1, 2), "TypeError: unsupported operand type(s) for @=: 'int' and 'int'")
check(lambda: operator.lt(1, 'a'), "TypeError: '<' not supported between instances of 'int' and 'str'")
check(lambda: operator.truediv(1, 0), 'ZeroDivisionError: division by zero')
check(lambda: operator.lshift(1, -1), 'ValueError: negative shift count')
check(lambda: operator.__all__, "['abs', 'add', 'and_', 'attrgetter', 'call', 'concat', 'contains', 'countOf', 'delitem', 'eq', 'floordiv', 'ge', 'getitem', 'gt', 'iadd', 'iand', 'iconcat', 'ifloordiv', 'ilshift', 'imatmul', 'imod', 'imul', 'index', 'indexOf', 'inv', 'invert', 'ior', 'ipow', 'irshift', 'is_', 'is_none', 'is_not', 'is_not_none', 'isub', 'itemgetter', 'itruediv', 'ixor', 'le', 'length_hint', 'lshift', 'lt', 'matmul', 'methodcaller', 'mod', 'mul', 'ne', 'neg', 'not_', 'or_', 'pos', 'pow', 'rshift', 'setitem', 'sub', 'truediv', 'truth', 'xor']")
