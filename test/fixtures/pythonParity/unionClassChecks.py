# isinstance and issubclass check a union's members in order, as they check a tuple's.
import typing
from collections.abc import Sequence

got = []
for call in [lambda: isinstance(1, int | str), lambda: isinstance(1.0, int | str), lambda: isinstance(None, int | None), lambda: issubclass(bool, typing.Union[int, str]), lambda: isinstance(1, typing.Optional[str]), lambda: isinstance(1, int | list[int]), lambda: isinstance('a', int | list[int]), lambda: isinstance([], (str, int | list)), lambda: issubclass(1, int | str), lambda: isinstance([1], Sequence | int), lambda: issubclass(list, Sequence | int), lambda: isinstance('x', int | typing.List[int])]:
    try:
        got.append(call())
    except TypeError as error:
        got.append(str(error))
expected = [True, False, True, True, False, True, 'isinstance() argument 2 cannot be a parameterized generic', True, 'issubclass() arg 1 must be a class', True, True, 'Subscripted generics cannot be used with class and instance checks']
if got != expected:
    raise AssertionError(got)
