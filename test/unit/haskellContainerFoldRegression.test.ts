import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['Data.Set', 'Data.Map', 'Data.Map.Strict'])('%s numeric folds demand the seed before the tree', (module) => {
  const collection = module === 'Data.Set' ? 'C.Set N' : 'C.Map Int N';
  for (const method of ['sum', 'product']) {
    const source = `import qualified ${module} as C
data N=N Int deriving Show
instance Num N where
 fromInteger _=error "seed"
 (+) _ _=N 1
 (*) _ _=N 2
main=print(${method}(error "tree"::${collection}))`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: 'seed',
    });
  }
});

test.each(['Data.Set', 'Data.Map', 'Data.Map.Strict'])(
  '%s monoidal folds retain tree grouping and primitive demand',
  (module) => {
    const set = module === 'Data.Set';
    const collection = set ? 'C.fromList[M(show x)|x<-[1..n::Int]]' : 'C.fromList[(x,M(show x))|x<-[1..n::Int]]';
    const keyed = set ? '' : String.raw` print([C.foldMapWithKey (\_ x->x)(build n)|n<-[0..4::Int]])`;
    const source = `import qualified ${module} as C
import Data.Foldable(fold)
data M=M String deriving(Eq,Ord,Show)
instance Semigroup M where M x<>M y=M("s("++x++","++y++")")
instance Monoid M where
 mempty=M "z"
 mappend(M x)(M y)=M("m("++x++","++y++")")
build n=${collection}
main=do
 print([fold(build n)|n<-[0..4::Int]])
 print([foldMap id(build n)|n<-[0..4::Int]])
${keyed}`;
    const row = '[M "z",M "1",M "m(z,m(1,2))",M "m(1,m(2,3))",M "m(1,m(2,m(z,m(3,4))))"]\n';
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: row.repeat(set ? 2 : 3),
      uncaughtException: undefined,
    });
  }
);

test.each(['Data.Map', 'Data.Map.Strict'])(
  '%s foldMapWithKey skips unused monoid primitives for a singleton',
  (module) => {
    const source = `import qualified ${module} as C
data M=M Int deriving Show
instance Semigroup M where _<>_=error "append"
instance Monoid M where
 mempty=error "empty"
 mappend _ _=error "mappend"
main=print(C.foldMapWithKey (\\k _->M k)(C.singleton(1::Int)()))`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: 'M 1\n',
      uncaughtException: undefined,
    });
  }
);

test.each(['Data.Map', 'Data.Map.Strict'])('%s Foldable queries preserve tree demand', (module) => {
  for (const method of ['maximum', 'minimum']) {
    const source = `import qualified ${module} as M
main=print(${method}(M.empty::M.Map Int Int))`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: `Data.Foldable.${method} (for Data.Map): empty map`,
    });
  }
  const source = `import qualified ${module} as M
import qualified Data.Map as L
main=do
 print(elem 2(L.fromList[(1,undefined),(2,2),(3,3)]::M.Map Int Int))
 print(elem (undefined::Int)(M.empty::M.Map Int Int))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: 'True\n',
    uncaughtException: 'Prelude.undefined',
  });
});

test.each(['maximum', 'minimum'])('%s on Map uses its strict root-first traversal', (method) => {
  const source = `import qualified Data.Map as M
data N=N String deriving Show
instance Eq N where _==_=False
instance Ord N where
 compare _ _=EQ
 max(N x)(N y)=N("("++x++","++y++")")
 min(N x)(N y)=N("("++x++","++y++")")
main=print(${method}(M.fromList[(1,N "left"),(2,N "root"),(3,N "right")]::M.Map Int N))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: 'N "((root,left),right)"\n',
    uncaughtException: undefined,
  });
});
