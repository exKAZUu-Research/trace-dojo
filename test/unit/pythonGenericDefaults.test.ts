import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('generic subscription prepares defaults for type variables, parameter specs and variadic tuples', () => {
  const program = `from typing import Generic, TypeVar, ParamSpec, TypeVarTuple, Unpack
class Box[T, U=str]: pass
assert Box[int].__args__ == (int, str)
assert Box[int, float].__args__ == (int, float)
assert Box[int] is Box[int]
assert Box[int] is not Box[int, str]
class Default[T=int, U=str]: pass
assert Default[()].__args__ == (int, str)
class Ref[T, U=T]: pass
assert Ref[int].__args__ == (int, Ref.__type_params__[0])
T = TypeVar('T')
U = TypeVar('U', default=str)
class Legacy(Generic[T, U]): pass
assert Legacy[int].__args__ == (int, str)
class Callback[**P=[int, str]]: pass
assert Callback[()].__args__ == ((int, str),)
assert Callback[int, str].__args__ == ((int, str),)
assert Callback[[float]].__args__ == ((float,),)
class Sequence[*Ts=*tuple[int, str]]: pass
assert Sequence[()].__args__ == (int, str)
assert Sequence[float].__args__ == (float,)
class Head[T, *Ts=*tuple[int, str]]: pass
assert Head[float].__args__ == (float, int, str)
for subscribe in [lambda: Box[()], lambda: Box[int, str, float]]:
    try: subscribe()
    except TypeError: pass
    else: raise AssertionError('accepted wrong arity')
print('specialized')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'specialized\n',
    uncaughtException: undefined,
  });
});

test('generic aliases keep recent identities while bounded cache eviction releases old identities', () => {
  const program = `class Box[T]: pass
old = Box[int]
assert Box[int] is old
for i in range(140): Box[type('T' + str(i), (), {})]
assert Box[int] is not old
recent = Box[int]
assert Box[int] is recent
print('cached')`;
  for (let run = 0; run < 2; run++) {
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: 'cached\n',
      uncaughtException: undefined,
    });
  }
});
