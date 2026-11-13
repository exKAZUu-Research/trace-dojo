# The caches of functools hash their key themselves, so an unhashable argument reports its own type.
import functools


@functools.cache
def f(x=0, y=0):
    return 1


@functools.lru_cache(maxsize=4)
def g(x):
    return 2


got = []
for call in [lambda: f([1, 2]), lambda: f(x=[1]), lambda: f({}), lambda: g({1}), lambda: f(1, [2]), lambda: f((1, [2]))]:
    try:
        call()
    except TypeError as error:
        got.append(str(error))
got += [f(1), f(1), f.cache_info().hits, g(3), g(3), g.cache_info().hits]
expected = ["unhashable type: 'list'", "unhashable type: 'list'", "unhashable type: 'dict'", "unhashable type: 'set'", "unhashable type: 'list'", "unhashable type: 'list'", 1, 1, 1, 2, 2, 1]
if got != expected:
    raise AssertionError(got)
