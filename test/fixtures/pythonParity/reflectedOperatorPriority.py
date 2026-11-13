def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))

class Base:
    def __add__(self, other): return 'add(' + type(self).__name__ + ', ' + type(other).__name__ + ')'
    def __radd__(self, other): return 'radd(' + type(self).__name__ + ', ' + type(other).__name__ + ')'
    def __mul__(self, other): return 'mul(' + type(self).__name__ + ', ' + type(other).__name__ + ')'
    def __rmul__(self, other): return 'rmul(' + type(self).__name__ + ', ' + type(other).__name__ + ')'
class Sub(Base): pass
class Child(Base):
    def __add__(self, other): return 'child add'
class Rev(Base):
    def __radd__(self, other): return 'rev radd'
class NoR:
    def __add__(self, other): return 'nor add'
class NoRSub(NoR):
    def __radd__(self, other): return 'norsub radd'
class Alias(Base):
    __radd__ = Base.__radd__
check([Base() + Sub(), Base() * Sub(), Base() + Child(), Base() + Rev(), Base() + Base(), NoR() + NoRSub(), Base() + Alias()], ['add(Base, Sub)', 'mul(Base, Sub)', 'add(Base, Child)', 'rev radd', 'add(Base, Base)', 'norsub radd', 'add(Base, Alias)'])
class Money:
    def __init__(self, amount): self.amount = amount
    def __add__(self, other): return Money(self.amount + other.amount)
    def __radd__(self, other): return Money(other + self.amount)
class Discount(Money): pass
check((Money(2) + Discount(3)).amount, 5)
