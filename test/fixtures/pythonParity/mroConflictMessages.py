def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))


try:
    class N0(M3, M4):
        pass
except TypeError as error:
    check('TypeError: ' + str(error), 'TypeError: Cannot create a consistent method resolution order (MRO) for bases M1, M2')
try:
    class N1(X, Y, Z):
        pass
except TypeError as error:
    check('TypeError: ' + str(error), 'TypeError: Cannot create a consistent method resolution order (MRO) for bases A, B, C')
try:
    class N2(Right, Wrong):
        pass
except TypeError as error:
    check('TypeError: ' + str(error), 'TypeError: Cannot create a consistent method resolution order (MRO) for bases Left, Middle')
try:
    class N3(X, BA):
        pass
except TypeError as error:
    check('TypeError: ' + str(error), 'TypeError: Cannot create a consistent method resolution order (MRO) for bases A, B')
try:
    class N4(A, X):
        pass
except TypeError as error:
    check('TypeError: ' + str(error), 'TypeError: Cannot create a consistent method resolution order (MRO) for bases A, X')
try:
    class N5(A, B, A):
        pass
except TypeError as error:
    check('TypeError: ' + str(error), 'TypeError: duplicate base class A')
