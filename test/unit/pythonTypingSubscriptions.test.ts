import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('typing subscriptions cache supplied keys while resolving annotations and callable lists', () => {
  const program = `from typing import List, Dict, Optional, Callable, Tuple, Literal, Annotated, get_type_hints
for make in [lambda: List[int], lambda: Dict[str, int], lambda: Optional[int], lambda: Callable[[int], str], lambda: Tuple[int, str], lambda: Literal[1], lambda: Annotated[int, 'tag']]:
    assert make() is make()
assert Literal[1] is not Literal[True]
assert List[int] is not List[(int,)]
def f(x: List[int]) -> Callable[[int], str]: pass
hints = get_type_hints(f)
assert hints['x'] is List[int]
assert hints['return'] is Callable[[int], str]
assert list[int] is not list[int]
print('cached')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'cached\n',
    uncaughtException: undefined,
  });
});

test('get_type_hints accepts unannotated callables and rejects objects without annotations', () => {
  const program = `import typing, math
class Empty: pass
class Callable:
    def __call__(self): pass
for value in [len, Callable(), Empty, math]:
    assert typing.get_type_hints(value) == {}
for value in [42, Empty()]:
    try: typing.get_type_hints(value)
    except TypeError as error: assert 'does not have annotations' in str(error)
    else: raise AssertionError('accepted')
print('annotations')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'annotations\n',
    uncaughtException: undefined,
  });
});

test('explicit Unpack declarations and tuple arguments use the variadic substitution protocol', () => {
  const program = `from typing import Generic, TypeVarTuple, TypeVar, Unpack, get_args, get_origin
Ts = TypeVarTuple('Ts')
T = TypeVar('T')
class Box(Generic[Unpack[Ts]]): pass
class Mixed(Generic[T, Unpack[Ts]]): pass
assert Box.__parameters__ == (Ts,)
assert Box[int, str].__args__ == (int, str)
assert Box[Unpack[tuple[int, str]]].__args__ == (Unpack[tuple[int, str]],)
assert Mixed[int, Unpack[tuple[str, float]]].__args__ == (int, Unpack[tuple[str, float]])
assert get_origin(Unpack[Ts]) is Unpack
assert get_args(Unpack[Ts]) == (Ts,)
for params in [(Unpack[int],), (Unpack[Ts], Unpack[Ts])]:
    try: Generic[params]
    except TypeError: pass
    else: raise AssertionError('accepted')
print('unpacked')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'unpacked\n',
    uncaughtException: undefined,
  });
});
