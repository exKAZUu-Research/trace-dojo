from typing import Annotated, get_type_hints, get_origin, get_args, List, Optional

def check(actual, expected):
    if actual != expected:
        raise AssertionError(repr(actual) + ' != ' + repr(expected))

def f(x: Annotated[int, 'meta']) -> Annotated[str, 'm2']:
    return 'a'

check(get_type_hints(f), {'x': int, 'return': str})
check(repr(get_type_hints(f, include_extras=True)), "{'x': typing.Annotated[int, 'meta'], 'return': typing.Annotated[str, 'm2']}")
a = Annotated[int, 'x']
check([a.__origin__, a.__args__, a.__metadata__, get_origin(a), get_args(a)], [int, (int,), ('x',), Annotated, (int, 'x')])

class C:
    z: Annotated[int, 'm']
    w: list[Annotated[int, 'm']]
    v: List[Annotated[str, 1]]
    u: Annotated[int, 'a'] | None
    t: Optional[Annotated[int, 'b']]
    s: dict[str, list[Annotated[int, 'c']]]
    r: Annotated[Annotated[int, 1], 2]

check(repr(get_type_hints(C)), "{'z': <class 'int'>, 'w': list[int], 'v': typing.List[str], 'u': int | None, 't': int | None, 's': dict[str, list[int]], 'r': <class 'int'>}")
check([repr(get_type_hints(C, include_extras=True)['r']), Annotated[Annotated[int, 1], 2].__metadata__], ['typing.Annotated[int, 1, 2]', (1, 2)])
check([Annotated[int, 'x'] == Annotated[int, 'x'], Annotated[int, 'x'] == Annotated[int, 'y'], Annotated[int, 'x']('5')], [True, False, 5])
