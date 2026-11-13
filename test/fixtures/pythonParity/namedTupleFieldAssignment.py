from collections import namedtuple
def message(action):
    try:
        action()
    except (AttributeError, TypeError) as e:
        return type(e).__name__ + ': ' + str(e)
    return 'no error'
def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))
P = namedtuple('P', 'x y')
p = P(1, 2)
def set_field():
    p.x = 3
def delete_field():
    del p.x
def set_unknown():
    p.z = 3
def delete_unknown():
    del p.z
def set_method():
    p.count = 3
def delete_method():
    del p.count
check(message(set_field), "AttributeError: can't set attribute")
check(message(delete_field), "AttributeError: can't delete attribute")
check(message(set_unknown), "AttributeError: 'P' object has no attribute 'z' and no __dict__ for setting new attributes")
check(message(delete_unknown), "AttributeError: 'P' object has no attribute 'z' and no __dict__ for setting new attributes")
check(message(set_method), "AttributeError: 'P' object attribute 'count' is read-only")
check(message(delete_method), "AttributeError: 'P' object attribute 'count' is read-only")
check(p, P(1, 2))
check(message(lambda: delattr([1], 'x')), "AttributeError: 'list' object has no attribute 'x' and no __dict__ for setting new attributes")
check(message(lambda: delattr('a', 'upper')), "AttributeError: 'str' object attribute 'upper' is read-only")
check(message(lambda: delattr(1, 'real')), "AttributeError: attribute 'real' of 'int' objects is not writable")
check(message(lambda: setattr(1.5, 'real', 2)), "AttributeError: attribute 'real' of 'float' objects is not writable")
check(message(lambda: setattr(1j, 'real', 2)), 'AttributeError: readonly attribute')
check(message(lambda: delattr(1j, 'imag')), 'AttributeError: readonly attribute')
check(message(lambda: setattr(range(3), 'start', 2)), 'AttributeError: readonly attribute')
check(message(lambda: delattr(range(3), 'stop')), 'AttributeError: readonly attribute')
check(repr(complex.real), "<member 'real' of 'complex' objects>")
