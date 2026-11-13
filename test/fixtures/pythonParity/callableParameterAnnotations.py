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

# A bracketed list in an annotation may also unpack an iterable, as any list display does.


def unpacked(x: [*range(2)], y: [*[int, str]], z: [int] * 2, w: [i for i in range(2)]) -> None:
    pass


if str(unpacked.__annotations__) != "{'x': [0, 1], 'y': [<class 'int'>, <class 'str'>], 'z': [<class 'int'>, <class 'int'>], 'w': [0, 1], 'return': None}":
    raise AssertionError(unpacked.__annotations__)
