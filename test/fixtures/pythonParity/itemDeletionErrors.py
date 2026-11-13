# Deleting an item a value cannot delete raises as PyObject_DelItem does: AttributeError for a class with
# __setitem__, "doesn't" for a sequence type given an index, and "does not" otherwise.
class M:
    def __setitem__(self, k, v):
        pass
class G:
    def __getitem__(self, k):
        return 1
class C:
    pass
def gen():
    yield 1
n = None
x5 = 5
g = gen()
t = (1, 2)
s = 'ab'
r = range(3)
got = []
def f0():
    del n[0]
def f1():
    del x5[0]
def f2():
    del g[0]
def f3():
    del C.__dict__["x"]
def f4():
    del t[0:1]
def f5():
    del s[0:1]
def f6():
    del r[0:1]
def f7():
    del M()[0]
def f8():
    del G()[0]
def f9():
    del G()[0:1]
def f10():
    del G()["a"]
def f11():
    del C()[0]
def f12():
    del C()["a"]
def f13():
    del t[0]
def f14():
    del s[0]
def f15():
    del frozenset()[0]
def f16():
    del frozenset()["a"]
def f17():
    del {}.keys()[0]
def f18():
    del r[0]
def f19():
    del t[True]
for i, f in enumerate([f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, f19]):
    try:
        f()
    except (TypeError, AttributeError) as error:
        got.append(type(error).__name__ + ': ' + str(error))
if got != ["TypeError: 'NoneType' object does not support item deletion", "TypeError: 'int' object does not support item deletion", "TypeError: 'generator' object does not support item deletion", "TypeError: 'mappingproxy' object does not support item deletion", "TypeError: 'tuple' object does not support item deletion", "TypeError: 'str' object does not support item deletion", "TypeError: 'range' object does not support item deletion", 'AttributeError: __delitem__', "TypeError: 'G' object doesn't support item deletion", "TypeError: 'G' object does not support item deletion", "TypeError: 'G' object does not support item deletion", "TypeError: 'C' object doesn't support item deletion", "TypeError: 'C' object does not support item deletion", "TypeError: 'tuple' object doesn't support item deletion", "TypeError: 'str' object doesn't support item deletion", "TypeError: 'frozenset' object doesn't support item deletion", "TypeError: 'frozenset' object does not support item deletion", "TypeError: 'dict_keys' object doesn't support item deletion", "TypeError: 'range' object doesn't support item deletion", "TypeError: 'tuple' object doesn't support item deletion"]:
    raise AssertionError(got)
