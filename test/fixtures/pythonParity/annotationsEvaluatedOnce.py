evaluated = []
def hint():
    evaluated.append(1)
    return int
def f(a: hint()):
    pass
class C:
    x: hint()
same = [f.__annotations__ is f.__annotations__, C.__annotations__ is C.__annotations__]
f.__annotations__['b'] = str
C.__annotations__['y'] = str
got = [same, len(evaluated), str(f.__annotations__), str(C.__annotations__)]
if got != [[True, True], 2, "{'a': <class 'int'>, 'b': <class 'str'>}", "{'x': <class 'int'>, 'y': <class 'str'>}"]:
    raise AssertionError(got)
