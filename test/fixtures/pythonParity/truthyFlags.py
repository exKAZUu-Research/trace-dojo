import abc
def f():
    pass
f.__isabstractmethod__ = 1
class A(abc.ABC):
    m = f
got = [int.from_bytes([255], 'big', signed=1), int.from_bytes([255], 'big', signed='x'), int.from_bytes([255], 'big', signed=0), property(f).__isabstractmethod__]
try:
    A()
except TypeError as e:
    got.append(str(e))
if got != [-1, -1, 255, True, "Can't instantiate abstract class A without an implementation for abstract method 'm'"]:
    raise AssertionError(got)
