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
