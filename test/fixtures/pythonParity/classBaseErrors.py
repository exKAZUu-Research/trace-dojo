# A repeated base is reported before the method resolution order is computed, naming the first base that repeats.
class A: pass
class D: pass
class E: pass
class X: pass
class Y(X): pass


def b1():
    class B(A, A): pass


def b2():
    class G(D, E, E, D): pass


def b3():
    class Z(X, Y): pass


def b4():
    class W(X, Y, X): pass


messages = []
for make in [b1, b2, b3, b4]:
    try:
        make()
    except TypeError as error:
        messages.append(str(error))
expected = ['duplicate base class A', 'duplicate base class D', 'Cannot create a consistent method resolution order (MRO) for bases X, Y', 'duplicate base class X']
if messages != expected:
    raise AssertionError(messages)
