import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const accepted = [
  [
    'instanceLet',
    'data T a=T a\ninstance Show a=>Show(T a) where show(T x)=let {y::a;y=x} in show y\nmain=print(T 1)',
    '1\n',
  ],
  [
    'instanceAnnotation',
    'data T a=T a\ninstance Show a=>Show(T a) where show(T x)=show(x::a)\nmain=print(T True)',
    'True\n',
  ],
  [
    'instanceWhere',
    'data T a=T a\ninstance Show a=>Show(T a) where\n show(T x)=one x\n  where\n   one::a->String\n   one=show\nmain=print(T True)',
    'True\n',
  ],
  [
    'classLet',
    'class C a where\n m::a->[a]\n m x=let {r::[a];r=[x]} in r\ninstance C Int\nmain=print(m(1::Int))',
    '[1]\n',
  ],
  [
    'classHigherKind',
    'class C f where\n m::f Int->f Int\n m x=let {r::f Int;r=x} in r\ninstance C []\nmain=print(m[1::Int])',
    '[1]\n',
  ],
  [
    'classWhere',
    'class C a where\n m::a->[a]\n m x=one x\n  where\n   one::a->[a]\n   one y=[y]\ninstance C Int\nmain=print(m(1::Int))',
    '[1]\n',
  ],
  [
    'instanceTwoParams',
    'data T a b=T a b\ninstance(Show a,Show b)=>Show(T a b) where show(T x y)=show(x::a)++show(y::b)\nmain=print(T True (3::Int))',
    'True3\n',
  ],
  [
    'freshHelper',
    'data T a=T a\ninstance Show a=>Show(T a) where show(T x)=let {g::b->b;g z=z} in show(g True)++show(x::a)\nmain=print(T True)',
    'TrueTrue\n',
  ],
] as const;

test.each(accepted)('method head variables remain scoped: %s', (_name, source, stdout) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', uncaughtException: undefined, stdout });
});

const rejected = [
  [
    'invalidInstance',
    "data T a=T a\nclass C x where c::x->Int\ninstance C(T a) where c(T v)=let {g::a->a;g y=y} in g True `seq` 1\nmain=print(c(T 'x'))",
  ],
  ['implicitTopControl', 'f::a->a\nf x=(x::a)\nmain=print(f True)'],
  [
    'invalidDefault',
    'class C a where\n m::a->Int\n m _=let {g::a->a;g y=y} in g True `seq` 1\ninstance C Int\nmain=print(m(1::Int))',
  ],
  ['implicitMethodControl', 'class C a where\n m::a->b->b\n m _ x=(x::b)\ninstance C Int\nmain=print(m(1::Int)True)'],
] as const;

test.each(rejected)('scoped signatures reject invalid specialization: %s', (_name, source) => {
  const result = executeProgram('haskell', source);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError')
    expect(result.diagnostics[0]?.message).not.toContain('この採点環境では使えません');
});
