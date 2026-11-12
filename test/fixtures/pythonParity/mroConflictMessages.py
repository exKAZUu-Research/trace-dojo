def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))


class M1: pass
class M2: pass
class M3(M1, M2): pass
class M4(M2, M1): pass
class A: pass
class B: pass
class C: pass
class X(A, B): pass
class Y(B, C): pass
class Z(C, A): pass
class Left: pass
class Middle: pass
class Right(Left, Middle): pass
class Wrong(Middle, Left): pass
class BA(B, A): pass


def outcome(make):
    try:
        make()
    except TypeError as error:
        return 'TypeError: ' + str(error)
    return 'made'


def n0():
    class N(M3, M4): pass
def n1():
    class N(X, Y, Z): pass
def n2():
    class N(Right, Wrong): pass
def n3():
    class N(X, BA): pass
def n4():
    class N(A, X): pass
def n5():
    class N(A, B, A): pass


mro = 'TypeError: Cannot create a consistent method resolution order (MRO) for bases '
check(outcome(n0), mro + 'M1, M2')
check(outcome(n1), mro + 'A, B, C')
check(outcome(n2), mro + 'Left, Middle')
check(outcome(n3), mro + 'A, B')
check(outcome(n4), mro + 'A, X')
check(outcome(n5), 'TypeError: duplicate base class A')
