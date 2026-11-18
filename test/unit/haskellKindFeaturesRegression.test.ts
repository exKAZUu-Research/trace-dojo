import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const unsupported = [
  ['phantomKind', 'data Q f=Q\ninstance Show(Q f) where show _="Q"\na::Q Maybe\na=Q\nmain=print a'],
  ['appliedKind', 'data App f a=App(f a)\ndata Pr a=Pr\ny::App Pr Maybe\ny=App Pr\nmain=putStrLn "ok"'],
  ['mixedKinds', 'data Q f=Q\ndata R=R(Q Maybe)(Q Int)\nmain=putStrLn "ok"'],
  ['laterKind', 'data Q f=Q\ndata R=R(Q Maybe)\nx::Q Int\nx=Q\nmain=putStrLn "ok"'],
  ['reversedKinds', 'data R=R(Q Maybe)\ndata Q f=Q\nx::Q Int\nx=Q\nmain=putStrLn "ok"'],
  ['synonymKind', 'type K a=Int\nf::K Maybe\nf=1\nmain=print f'],
  [
    'classKind',
    'data P a=P\nclass C a where c::P a->String\ninstance C Maybe where c _="ok"\nmain=putStrLn(c(P::P Maybe))',
  ],
  [
    'constraintSynonym',
    'type C a=(Show a,Eq a)\nf::C a=>a->String\nf x=if x==x then show x else ""\nmain=putStrLn(f 1)',
  ],
  [
    'qualifiedConstraint',
    'import qualified Prelude as P\nimport Prelude\ntype C a=P.Show a\nf::C a=>a->String\nf=show\nmain=putStrLn(f True)',
  ],
] as const;

test.each(unsupported)('unsupported kind features have an environment diagnostic: %s', (_name, source) => {
  const result = executeProgram('haskell', source);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError')
    expect(result.diagnostics[0]?.message).toContain('は、この採点環境では使えません。');
});

const accepted = [
  [
    'ordinaryPhantom',
    'data Q f=Q\ninstance Show(Q f) where show _="Q"\na::Q Int\na=Q\nb::Q Bool\nb=Q\nmain=print(a,b)',
    '(Q,Q)\n',
  ],
  ['higherSynonym', 'type Id a=a\ntype App f a=Id f a\nmain=print(Just 1::App Maybe Int)', 'Just 1\n'],
  ['forwardHigher', 'data A f=A(B f)\ndata B f=B(f Int)\nmain=putStrLn "ok"', 'ok\n'],
  ['reverseHigher', 'data B f=B(f Int)\ndata A f=A(B f)\nmain=putStrLn "ok"', 'ok\n'],
  ['mutualHigher', 'data A f=A(B f)\ndata B f=B(f Int)(A f)\nmain=putStrLn "ok"', 'ok\n'],
  ['ordinaryTuple', 'type Pair a=(a,a)\nmain=print((1,2)::Pair Int)', '(1,2)\n'],
  ['ordinaryUnit', 'type U=()\nmain=print(()::U)', '()\n'],
  [
    'tofu',
    'class Tofu t where tofu::j a->t a j\ndata Frank a b=Frank{frankField::b a}\ninstance Tofu Frank where tofu=Frank\nmain=print(frankField(tofu(Just(1::Int))))',
    'Just 1\n',
  ],
] as const;

test.each(accepted)('monomorphic kind inference remains supported: %s', (_name, source, stdout) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', uncaughtException: undefined, stdout });
});

const rejected = [
  ['invalidConcreteKind', 'data S a=S a\nx::S Maybe\nx=undefined\nmain=putStrLn "ok"'],
  ['invalidApplication', 'data App f a=App(f a)\nx::App Maybe Maybe\nx=undefined\nmain=putStrLn "ok"'],
  ['overapplied', 'data Q a=Q\nx::Q Int Bool\nx=undefined\nmain=putStrLn "ok"'],
] as const;

test.each(rejected)('invalid kinds retain ordinary type diagnostics: %s', (_name, source) => {
  const result = executeProgram('haskell', source);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') {
    expect(result.diagnostics[0]?.message).toContain('カインド');
    expect(result.diagnostics[0]?.message).not.toContain('使えません');
  }
});
