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
  [
    'aliasParameter',
    'type Id a=a\nclass Show(Id a)=>D a where d::a->String\ninstance D Int where d=show\nmain=putStrLn(d(1::Int))',
    '1\n',
  ],
  [
    'forwardAliasParameter',
    'class Show(Id a)=>D a where d::a->String\ntype Id a=a\ninstance D Int where d=show\nmain=putStrLn(d(1::Int))',
    '1\n',
  ],
  [
    'nestedAliasParameter',
    'type Id a=a\nclass Show(Id(Id a))=>D a where d::a->String\ninstance D Int where d=show\nmain=putStrLn(d(1::Int))',
    '1\n',
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

const constraintKinds = [
  ['phantomClass', 'data P a=P\nx::P Show\nx=P\nmain=putStrLn "ok"'],
  ['fieldClass', 'data P a=P\ndata R=R(P Eq)\nmain=putStrLn "ok"'],
  [
    'instanceClass',
    'data P a=P\nclass C a where c::a->String\ninstance C(P Show) where c _="ok"\nmain=putStrLn(c(P::P Show))',
  ],
  ['variableConstraint', 'data P a=P\ng::c a=>P c->a->Int\ng _ _=1\nmain=print 1'],
  ['aliasSuperclass', 'type C a=Show a\nclass C a=>D a\nmain=print 1'],
  [
    'qualifiedClassType',
    'import qualified Prelude as P\nimport Prelude\ndata Q a=Q\nx::Q P.Show\nx=Q\nmain=putStrLn "ok"',
  ],
  ['userClassType', 'class C a where c::a->String\ndata P a=P\nx::P C\nx=P\nmain=putStrLn "ok"'],
  ['nestedConstraintTuple', 'type C a=((Show a,Eq a),Ord a)\nf::C a=>a->String\nf=show\nmain=putStrLn(f 1)'],
  ['constraintSynonymApply', 'type Id a=a\ntype C a=Id(Show a)\nf::C a=>a->String\nf=show\nmain=putStrLn(f 1)'],
  ['bareShowDeriving', 'type C=Show\ndata T=T deriving C\nmain=print T'],
  ['bareEqDeriving', 'type E=Eq\ndata T=T deriving(E,Show)\nmain=print(T==T)'],
  ['bareOrdDeriving', 'type O=Ord\ndata T=T deriving(Eq,O,Show)\nmain=print(compare T T)'],
  ['forwardDeriving', 'data T=T deriving C\ntype C=Show\nmain=print T'],
  ['parenthesizedDeriving', 'type C=(Show)\ndata T=T deriving C\nmain=print T'],
  ['aliasChainDeriving', 'type A=Show\ntype B=A\ndata T=T deriving B\nmain=print T'],
  ['zeroConstraintAlias', 'type C=Show Int\nf::C=>Int\nf=1\nmain=print f'],
  ['manyConstraintAlias', 'type C a b=(Show a,Eq b)\nf::C a b=>a->b->String\nf a _=show a\nmain=putStrLn(f 1 True)'],
  ['bareVariableConstraint', 'data P a=P\ng::c=>P c->Int\ng _=1\nmain=print 1'],
] as const;

test.each(constraintKinds)('well-kinded constraint uses have an environment diagnostic: %s', (_name, source) => {
  const result = executeProgram('haskell', source);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') {
    expect(result.diagnostics[0]?.message).toMatch(/PolyKinds|ConstraintKinds/);
    expect(result.diagnostics[0]?.message).toContain('は、この採点環境では使えません。');
  }
});

const kindMisuses = [
  ['nameContext', 'type Name=String\ngreet::Name a=>a->String\ngreet _="hi"\nmain=putStrLn "ok"'],
  ['pairContext', 'type Pair a=(a,a)\nf::Pair a=>a->Int\nf _=1\nmain=print 1'],
  ['printerArrow', 'type Printer a=Show a->String\nmain=putStrLn "ok"'],
  ['bareListClass', 'type Shows=[Show]\nmain=print 1'],
  ['listClass', 'type Shows a=[Show a]\nmain=putStrLn "ok"'],
  ['maybeClass', 'type M=Maybe Eq\nmain=putStrLn "ok"'],
  ['invalidShowMaybe', 'type C=Show Maybe\nmain=print 1'],
  ['invalidOverClass', 'type C a=Show a a\nmain=print 1'],
  ['invalidClassValue', 'data D=D Show\nmain=print 1'],
  ['constraintTupleEmpty', 'type C a=(Show a,())\nmain=print 1'],
  ['aliasValueContext', 'type Name=String\nclass Name a=>C a\nmain=print 1'],
  ['aliasValueInstance', 'type Point=(Int,Int)\ninstance Point Int\nmain=print 1'],
  ['aliasValueDeriving', 'type Name=String\ndata D=D deriving Name\nmain=print 1'],
  ['aliasClassInstance', 'type C a=Show a\ndata D=D\ninstance C D where show _="D"\nmain=print D'],
  ['bareAliasInstance', 'type C=Show\ndata D=D\ninstance C D where show _="D"\nmain=print D'],
  ['aliasDeriving', 'type C a=Show a\ndata D=D deriving C\nmain=print D'],
  ['tupleBareClass', 'type T a=(Show,a)\nmain=print 1'],
  ['concreteDeriving', 'type C=Show Int\ndata T=T deriving C\nmain=print T'],
  ['ordinaryDeriving', 'type C=Maybe\ndata T=T deriving C\nmain=print T'],
  ['missingClassArg', 'f::Show=>a->String\nf=undefined\nmain=putStrLn "ok"'],
  ['extraClassArg', 'f::Show a b=>a->b\nf=undefined\nmain=putStrLn "ok"'],
  ['pairConstraint', 'type Pair a b=(a,b)\nf::Pair a b=>a->b\nf=undefined\nmain=putStrLn "ok"'],
  ['eitherConstraint', 'f::Either a b=>a->b\nf=undefined\nmain=putStrLn "ok"'],
  ['nameConstraint', 'type Name=String\nf::Name=>Int\nf=1\nmain=print f'],
  ['shapeConstraint', 'data Shape=Shape\nf::Shape=>Int\nf=1\nmain=print f'],
  ['intConstraint', 'f::Int=>Int\nf=1\nmain=print f'],
  ['variableHeadKind', 'f::a Show=>a->String\nf=undefined\nmain=putStrLn "ok"'],
  ['variableArgumentKind', 'f::m a=>m->a\nf=undefined\nmain=putStrLn "ok"'],
  ['crossContextKinds', 'data P a=P\ng::(c a,Show c)=>P c->a->Int\ng _ _=1\nmain=print 1'],
  ['bareVariableKind', 'f::a=>a\nf=undefined\nmain=putStrLn "ok"'],
  ['wrongShowKind', 'class Show Maybe=>D a where d::a->String\nmain=putStrLn "ok"'],
  ['wrongFunctorKind', 'class Functor Int=>D a where d::a->String\nmain=putStrLn "ok"'],
  ['mixedWrongKind', 'class(Show[a],Eq Maybe)=>D a where d::a->String\nmain=putStrLn "ok"'],
] as const;

test.each(kindMisuses)('invalid type and class uses keep ordinary diagnostics: %s', (_name, source) => {
  const result = executeProgram('haskell', source);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') {
    expect(result.diagnostics[0]?.message).toMatch(/カインド|クラスではありません|型引数/);
    expect(result.diagnostics[0]?.message).not.toContain('使えません');
  }
});

const unsupportedSuperclasses = [
  [
    'listSuperclass',
    'class Show [a]=>D a where d::a->String\ninstance D Int where d x=show [x]\nmain=putStrLn(d(1::Int))',
  ],
  ['concreteSuperclass', 'class Show Int=>D a where d::a->String\ninstance D Bool where d=show\nmain=putStrLn(d True)'],
  [
    'maybeSuperclass',
    'class Eq(Maybe a)=>D a where d::a->Bool\ninstance D Int where d x=Just x==Just x\nmain=print(d(1::Int))',
  ],
  [
    'higherSuperclass',
    'class Show(f Int)=>D f where d::f Int->String\ninstance D Maybe where d=show\nmain=putStrLn(d(Just(1::Int)))',
  ],
] as const;

test.each(unsupportedSuperclasses)(
  'well-kinded superclass contexts have an environment diagnostic: %s',
  (_name, source) => {
    const result = executeProgram('haskell', source);
    expect(result.kind).toBe('compileError');
    if (result.kind === 'compileError') {
      expect(result.diagnostics[0]?.message).toContain('スーパークラス');
      expect(result.diagnostics[0]?.message).toContain('は、この採点環境では使えません。');
    }
  }
);
