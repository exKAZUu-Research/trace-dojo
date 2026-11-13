def check(call, expected):
    try:
        call()
        actual = 'ok'
    except TypeError as error:
        actual = str(error)
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))


class A:
    pass


class Outer:
    class In:
        pass


check(lambda: A.mro(1), 'A.mro() takes no arguments (1 given)')
check(lambda: list.mro(1), 'list.mro() takes no arguments (1 given)')
check(lambda: type.mro(A, 1), 'type.mro() takes no arguments (1 given)')
check(lambda: A.mro(x=1), 'A.mro() takes no keyword arguments')
check(lambda: A.__subclasses__(1), 'A.__subclasses__() takes no arguments (1 given)')
check(lambda: Outer.In.mro(1), 'Outer.In.mro() takes no arguments (1 given)')
check(lambda: type.__subclasses__(A, 1), 'type.__subclasses__() takes no arguments (1 given)')
check(lambda: A.__instancecheck__(), 'A.__instancecheck__() takes exactly one argument (0 given)')
check(lambda: [].append(1, 2), 'list.append() takes exactly one argument (2 given)')
