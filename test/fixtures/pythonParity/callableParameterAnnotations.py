# Callable's bracketed parameter list is an annotation like any other type.
from collections.abc import Callable
from typing import Optional


def apply(f: Callable[[int], int], x: int) -> int:
    return f(x)


def make(f: Optional[Callable[[int], int]] = None) -> Callable[[], int]:
    return lambda: 1


x: Callable[[int, str], int] = abs


class K:
    cb: Callable[[int], None]


got = [apply(lambda v: v * 2, 3), make()(), str(apply.__annotations__['f']), str(make.__annotations__), str(K.__annotations__)]
expected = [6, 1, 'collections.abc.Callable[[int], int]', "{'f': collections.abc.Callable[[int], int] | None, 'return': collections.abc.Callable[[], int]}", "{'cb': collections.abc.Callable[[int], None]}"]
if got != expected:
    raise AssertionError(got)
