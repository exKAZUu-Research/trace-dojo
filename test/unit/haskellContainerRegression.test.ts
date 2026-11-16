import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([
  ['Data.Set', 'C.singleton', 500],
  ['Data.Map', String.raw`\k -> C.singleton k k`, 300],
])('repeated singleton unions share %s trees within the budget', (module, singleton, count) => {
  const source = `import qualified ${module} as C\nimport Data.List(foldl')\nmain=print(C.size(foldl' C.union C.empty(map (${singleton}) [1..${count}::Int])))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: `${count}\n`,
    uncaughtException: undefined,
  });
});

test.each([
  ['Data.Set', 'C.split undefined (C.singleton(1::Int))', 'Prelude.undefined'],
  ['Data.Set', 'C.splitMember undefined (C.singleton(1::Int))', 'Prelude.undefined'],
  ['Data.Map', 'C.split undefined (C.singleton (1::Int) ())', 'Prelude.undefined'],
  ['Data.Map', 'C.splitLookup undefined (C.singleton (1::Int) ())', 'Prelude.undefined'],
  ['Data.Set', 'C.elemAt (-1) (error "tree"::C.Set Int)', 'tree'],
  ['Data.Map', 'C.elemAt (-1) (error "tree"::C.Map Int Int)', 'tree'],
  ['Data.Map', String.raw`C.insertLookupWithKey (\_ _ _->1::Int) (error "key"::Int) 1 C.empty`, 'key'],
  ['Data.Map.Strict', String.raw`C.insertLookupWithKey (\_ _ _->1::Int) (1::Int) (error "value") C.empty`, 'value'],
  ['Data.Map', String.raw`C.mapEither (\_ -> error "classify"::Either Int Int) (C.singleton (1::Int) ())`, 'classify'],
  [
    'Data.Map.Strict',
    String.raw`C.mapEither (\_ -> Left(error "value")::Either Int Int) (C.singleton (1::Int) ())`,
    'value',
  ],
  ['Data.Set', String.raw`C.partition (\_ -> error "predicate") (C.singleton(1::Int))`, 'predicate'],
  ['Data.Map', String.raw`C.partitionWithKey (\_ _->error "predicate") (C.singleton (1::Int) ())`, 'predicate'],
  ['Data.Map.Strict', 'C.fromAscList [(1,error "discarded"),(1,1::Int)]', 'discarded'],
  ['Data.Map.Strict', 'C.fromDescList [(1,error "discarded"),(1,1::Int)]', 'discarded'],
  ['Data.Map.Strict', 'C.fromDistinctDescList [(2,error "first"),(1,error "second"::Int)]', 'first'],
  ['Data.Set', 'C.splitAt (error "index") (error "tree"::C.Set Int)', 'index'],
  ['Data.Map', 'C.splitAt (error "index") (error "tree"::C.Map Int Int)', 'index'],
])('collection demand matches GHC for %s %s', (module, expression, uncaughtException) => {
  const source = `import qualified ${module} as C\nmain=print((${expression}) \`seq\` (1::Int))`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
});

test('generic splitting demands its index and only the necessary list prefix', () => {
  const source =
    'import Data.List\nmain=print(genericSplitAt (0::Integer) (undefined::[Int]) `seq` 1,genericSplitAt (-1::Integer) (undefined::[Int]) `seq` 2,genericSplitAt (2::Integer) [1..5::Int])';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '(1,2,([1,2],[3,4,5]))\n',
    uncaughtException: undefined,
  });
  expect(
    executeProgram('haskell', 'import Data.List\nmain=print(genericSplitAt (undefined::Integer) [1::Int] `seq` 1)')
  ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'Prelude.undefined' });
});

test('tree splits and transformations retain lazy payloads and ordered results', () => {
  const source = `import qualified Data.Map as M
import qualified Data.Set as S
main=do
  print(S.split (undefined::Int) S.empty \`seq\` 1)
  print(S.splitMember (undefined::Int) S.empty \`seq\` 1)
  print(S.splitMember 3(S.fromList[1..5::Int]),S.splitAt 2(S.fromList[1..5::Int]))
  print(M.splitLookup 3(M.fromList[(k,k)|k<-[1..5::Int]]),M.splitAt 2(M.fromList[(k,k)|k<-[1..5::Int]]))
  print(M.mapEither (\\x -> Left(error "lazy")::Either Int Int)(M.singleton (1::Int) ()) \`seq\` 1)
  print(M.insertLookupWithKey (\\_ x y->x+y) 2 10(M.fromList[(1,1),(2,2),(3,3::Int)]))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      '1\n1\n((fromList [1,2],True,fromList [4,5]),(fromList [1,2],fromList [3,4,5]))\n((fromList [(1,1),(2,2)],Just 3,fromList [(4,4),(5,5)]),(fromList [(1,1),(2,2)],fromList [(3,3),(4,4),(5,5)]))\n1\n(Just 2,fromList [(1,1),(2,12),(3,3)])\n',
  });
});

test.each([
  ['Data.Set', String.raw`C.partition (\k->error(show k)) (C.fromList[1..7::Int])`, '1'],
  ['Data.Map', String.raw`C.partitionWithKey (\k _->error(show k)) m`, '4'],
  ['Data.Map', String.raw`C.mapEitherWithKey (\k _->error(show k)::Either Int Int) m`, '1'],
  [
    'Data.Map.Strict',
    String.raw`C.mapEitherWithKey (\k _->if k==4 then Left 4 else error(show k)::Either Int Int) m`,
    '2',
  ],
  ['Data.Map.Strict', String.raw`C.unionWithKey (\k x _->if k==4 then x else error(show k)) m m`, '6'],
])('tree traversal order follows GHC in %s %s', (module, expression, uncaughtException) => {
  const source = `import qualified ${module} as C\nm=C.fromList[(k,k)|k<-[1..7::Int]]\nmain=print((${expression}) \`seq\` (1::Int))`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
});

test('singleton unions retain the left key representative in lazy and strict maps', () => {
  const source = `import qualified Data.Set as S
import qualified Data.Map as M
import qualified Data.Map.Strict as T
data K=K Int Int deriving Show
instance Eq K where K x _ == K y _ = x==y
instance Ord K where compare(K x _)(K y _)=compare x y
left=M.singleton(K 2 10)(1::Int)
right=M.fromList[(K 1 20,2),(K 2 20,2),(K 3 20,2)]
main=do
  print(S.union(S.singleton(K 2 10))(S.fromList[K 1 20,K 2 20,K 3 20]))
  print(M.unionWithKey (\\(K _ tag) x y->tag+x+y) left right)
  print(T.unionWithKey (\\(K _ tag) x y->tag+x+y) left right)
  print(T.unionWithKey (\\(K _ tag) x y->tag+x+y) right left)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      'fromList [K 1 20,K 2 10,K 3 20]\nfromList [(K 1 20,2),(K 2 10,13),(K 3 20,2)]\nfromList [(K 1 20,2),(K 2 10,13),(K 3 20,2)]\nfromList [(K 1 20,2),(K 2 20,23),(K 3 20,2)]\n',
  });
});
