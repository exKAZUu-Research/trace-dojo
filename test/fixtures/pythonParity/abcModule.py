import abc
from abc import ABC, ABCMeta, abstractmethod


class Shape(ABC):
    @abstractmethod
    def area(self): ...

    @property
    @abstractmethod
    def name(self): ...

    @classmethod
    @abstractmethod
    def make(cls): ...

    @staticmethod
    @abstractmethod
    def sides(): ...

    def describe(self):
        return self.name + ' ' + str(self.area())


class Square(Shape):
    def area(self):
        return 4


class NamedSquare(Square):
    name = 'square'

    @classmethod
    def make(cls):
        return cls()

    @staticmethod
    def sides():
        return 4


class WithMetaclass(metaclass=ABCMeta):
    @abstractmethod
    def f(self):
        pass

    @abc.abstractproperty
    def p(self):
        pass


class Patched(WithMetaclass):
    pass


Patched.f = lambda self: 1
Patched.p = 3


class Virtual(ABC):
    pass


@Virtual.register
class Registered:
    pass


class Deprecated(ABC):
    @abc.abstractclassmethod
    def c(cls):
        pass

    @abc.abstractstaticmethod
    def s():
        pass


def outcome(thunk):
    try:
        return repr(thunk())
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)


def check(thunk, expected):
    actual = outcome(thunk)
    if actual != expected:
        raise AssertionError('expected ' + expected + ' but got ' + actual)


check(lambda: sorted(Shape.__abstractmethods__), "['area', 'make', 'name', 'sides']")
check(lambda: sorted(Square.__abstractmethods__), "['make', 'name', 'sides']")
check(lambda: Shape(), "TypeError: Can't instantiate abstract class Shape without an implementation for abstract methods 'area', 'make', 'name', 'sides'")
check(lambda: Square(), "TypeError: Can't instantiate abstract class Square without an implementation for abstract methods 'make', 'name', 'sides'")
check(lambda: NamedSquare.make().describe(), "'square 4'")
check(lambda: NamedSquare.sides(), '4')
check(lambda: (isinstance(NamedSquare(), Shape), issubclass(NamedSquare, Shape), issubclass(int, Shape)), '(True, True, False)')
check(lambda: (Shape, type(Shape), ABC, type(ABC), ABCMeta, type(ABCMeta), Shape.__mro__), "(<class '__main__.Shape'>, <class 'abc.ABCMeta'>, <class 'abc.ABC'>, <class 'abc.ABCMeta'>, <class 'abc.ABCMeta'>, <class 'type'>, (<class '__main__.Shape'>, <class 'abc.ABC'>, <class 'object'>))")
check(lambda: WithMetaclass(), "TypeError: Can't instantiate abstract class WithMetaclass without an implementation for abstract methods 'f', 'p'")
check(lambda: (type(WithMetaclass), WithMetaclass.__abstractmethods__ == frozenset({'f', 'p'})), "(<class 'abc.ABCMeta'>, True)")
check(lambda: Patched(), "TypeError: Can't instantiate abstract class Patched without an implementation for abstract methods 'f', 'p'")
check(lambda: (abc.update_abstractmethods(Patched) is Patched, Patched.__abstractmethods__, Patched().f(), Patched().p), '(True, frozenset(), 1, 3)')
check(lambda: abc.update_abstractmethods(int), "<class 'int'>")
check(lambda: (Virtual.register(int) is int, isinstance(3, Virtual), issubclass(bool, Virtual), issubclass(str, Virtual)), '(True, True, True, False)')
check(lambda: (isinstance(Registered(), Virtual), issubclass(Registered, Virtual)), '(True, True)')
check(lambda: Virtual.register(3), 'TypeError: Can only register classes')
check(lambda: Deprecated(), "TypeError: Can't instantiate abstract class Deprecated without an implementation for abstract methods 'c', 's'")
check(lambda: abstractmethod(3), "AttributeError: 'int' object has no attribute '__isabstractmethod__' and no __dict__ for setting new attributes")
check(lambda: abstractmethod(), "TypeError: abstractmethod() missing 1 required positional argument: 'funcobj'")
check(lambda: (Shape.area.__isabstractmethod__, Shape.__dict__['name'].__isabstractmethod__), '(True, True)')
check(lambda: (isinstance(Shape, ABCMeta), isinstance(int, ABCMeta), issubclass(ABCMeta, type)), '(True, False, True)')
check(lambda: type(abc.get_cache_token()), "<class 'int'>")
check(lambda: sorted(name for name in dir(abc) if not name.startswith('_')), "['ABC', 'ABCMeta', 'abstractclassmethod', 'abstractmethod', 'abstractproperty', 'abstractstaticmethod', 'get_cache_token', 'update_abstractmethods']")
