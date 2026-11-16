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

test.each(['Data.Map', 'Data.Map.Strict'])('tree updates preserve stored key representatives in %s', (module) => {
  const source = `import qualified ${module} as M
import Data.Maybe(fromJust)
data K=K Int String deriving Show
instance Eq K where K x _==K y _=x==y
instance Ord K where compare(K x _)(K y _)=compare x y
stored=M.singleton(K 1 "old")(1::Int)
key=K 1 "new"
label(K _ text)=text
main=do
  print(M.toList(M.adjustWithKey (\\k _->length(label k)) key stored))
  print(M.toList(M.updateWithKey (\\k _->Just(length(label k))) key stored))
  print(M.toList(M.update (Just . (+1)) key stored))
  print(M.toList(M.alter (Just . (+1) . fromJust) key stored))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '[(K 1 "old",3)]\n[(K 1 "old",3)]\n[(K 1 "old",2)]\n[(K 1 "old",2)]\n',
  });
});

test.each(['Data.Map', 'Data.Map.Strict'])('alter searches the tree before invoking its callback in %s', (module) => {
  for (const [key, tree, uncaughtException] of [
    ['error "key"', 'M.empty', 'key'],
    ['1', 'error "tree"', 'tree'],
    ['error "key"', 'error "tree"', 'key'],
  ]) {
    const source = `import qualified ${module} as M\nmain=print(M.alter (\\_->error "callback") (${key}::Int) (${tree}::M.Map Int Int) \`seq\` 1)`;
    expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
  }
});

test.each(['Data.Map', 'Data.Map.Strict'])(
  'map accumulation inspects the input tree before returning its pair in %s',
  (module) => {
    for (const call of ['M.mapAccum undefined', 'M.mapAccumWithKey undefined', 'M.mapAccumRWithKey undefined']) {
      const source = `import qualified ${module} as M\nmain=print((${call} (undefined::Int) (error "tree"::M.Map Int Int)::(Int,M.Map Int Int)) \`seq\` 1)`;
      expect(executeProgram('haskell', source)).toMatchObject({
        kind: 'executed',
        stdout: '',
        uncaughtException: 'tree',
      });
    }
  }
);

test('lazy difference inspects the second tree and preserves untouched values', () => {
  for (const [first, second, uncaughtException] of [
    ['M.empty', 'error "second"', 'second'],
    ['error "first"', 'error "second"', 'second'],
  ]) {
    const source = `import qualified Data.Map as M\nmain=print(M.differenceWith undefined (${first}::M.Map Int Int) (${second}::M.Map Int Int) \`seq\` 1)`;
    expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
  }
});

test.each([
  [String.raw`M.fromSet (\k->error(show k)::Int) (S.fromList[1..7::Int])`, '4'],
  [String.raw`M.mapMaybeWithKey (\k _->Just(error(show k)::Int)) m`, '4'],
  [String.raw`M.intersectionWithKey (\k _ _->error(show k)::Int) m m`, '1'],
  [String.raw`M.mapAccumWithKey (\a k _->(a,error(show k)::Int)) () m`, '4'],
])('strict tree transformations follow containers demand: %s', (expression, uncaughtException) => {
  const source = `import qualified Data.Map.Strict as M\nimport qualified Data.Set as S\nm=M.fromList[(k,k)|k<-[1..7::Int]]\nmain=print((${expression}) \`seq\` 1)`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
});

test.each(['Data.Map', 'Data.Map.Strict', 'Data.Set'])(
  'repeated singleton intersections use %s tree searches',
  (module) => {
    const isSet = module === 'Data.Set';
    const tree = isSet ? 'M.fromList[1..500::Int]' : 'M.fromList[(k,k)|k<-[1..500::Int]]';
    const single = isSet ? 'M.singleton k' : 'M.singleton k ()';
    const source = `import qualified ${module} as M\nm=${tree}\nmain=print(sum[M.size(M.intersection m (${single}))|k<-[1..500::Int]])`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '500\n',
      uncaughtException: undefined,
    });
  }
);

test.each([
  ['fromAscList', 6, '4'],
  ['fromDistinctAscList', 10, '4'],
  ['fromDescList', 2, '2'],
  ['fromDistinctDescList', 4, '3'],
  ['fromDescList', 8, '5'],
  ['fromDistinctDescList', 10, '7'],
])('ordered builder %s retains containers shape at size %i', (builder, count, uncaughtException) => {
  const descending = builder.includes('Desc');
  const keys = descending ? `[${count},${count - 1}..1::Int]` : `[1..${count}::Int]`;
  const source = `import qualified Data.Map as L\nimport qualified Data.Map.Strict as S\nm=L.${builder}[(k,())|k<-${keys}]\nmain=print(S.size(S.mapWithKey (\\k _->error(show k)::Int) m))`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
});

test.each(['Data.Map', 'Data.Map.Strict'])('lazy union traverses right before left in %s', (module) => {
  const source = `import qualified ${module} as M
import qualified Data.Map as L
data K=K Int deriving Show
instance Eq K where K a==K b=a==b
instance Ord K where compare(K a)(K b)=if a==2 || a==6 then error(show(a,b)) else compare a b
a=L.fromDistinctAscList[(K k,())|k<-[1..7]]
b=L.fromDistinctAscList[(K k,())|k<-[0,1,3,4,5,7,8]]
main=print(M.size(M.union a b))`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: '(6,7)' });
});

test.each(['Data.Set', 'Data.Map', 'Data.Map.Strict'])(
  'repeated differences retain unaffected %s subtrees',
  (module) => {
    const isSet = module === 'Data.Set';
    const initial = isSet ? 'M.fromList[1..500::Int]' : 'M.fromList[(k,k)|k<-[1..500::Int]]';
    const single = isSet ? 'M.singleton k' : 'M.singleton k ()';
    const source = `import qualified ${module} as M\nimport Data.List(foldl')\nmain=print(M.size(foldl' (\\tree k->M.difference tree (${single})) (${initial}) [1..500]))`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '0\n',
      uncaughtException: undefined,
    });
  }
);

test.each(['Data.Set', 'Data.Map', 'Data.Map.Strict'])('ordered take/drop use %s subtree sizes', (module) => {
  const initial = module === 'Data.Set' ? 'M.fromList[1..500::Int]' : 'M.fromList[(k,k)|k<-[1..500::Int]]';
  for (const [operation, stdout] of [
    ['take', '125250\n'],
    ['drop', '124750\n'],
  ]) {
    const source = `import qualified ${module} as M\nm=${initial}\nmain=print(sum[M.size(M.${operation} n m)|n<-[1..500]])`;
    expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
  }
});

test.each([
  ['Data.Set', String.raw`M.filter (\x->error(show x)) (M.fromList[1,2,3::Int])`],
  ['Data.Set', String.raw`M.mapMonotonic (\x->error(show x)::Int) (M.fromList[1,2,3::Int])`],
  ['Data.Map', String.raw`M.filterWithKey (\k _->error(show k)) m`],
  ['Data.Map.Strict', String.raw`M.filterWithKey (\k _->error(show k)) m`],
])('collection transformations retain containers traversal order: %s %s', (module, expression) => {
  const source = `import qualified ${module} as M\n${module === 'Data.Set' ? '' : 'm=M.fromList[(k,())|k<-[1,2,3::Int]]\n'}main=print(M.size(${expression}))`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: '3' });
});

test.each(['Data.Map', 'Data.Map.Strict'])('alterF searches before invoking the callback in %s', (module) => {
  for (const [key, tree, uncaughtException] of [
    ['error "key"', 'M.empty', 'key'],
    ['1', 'error "tree"', 'tree'],
    ['error "key"', 'error "tree"', 'key'],
  ]) {
    const source = `import qualified ${module} as M\nmain=print(M.alterF (\\_->error "function"::Maybe(Maybe Int)) (${key}::Int) (${tree}::M.Map Int Int) \`seq\` 1)`;
    expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
  }
});

test.each([
  ['Data.Map', 'M.lookup key tree'],
  ['Data.Map', 'M.insert key (1::Int) tree'],
  ['Data.Map', 'M.insertWith (+) key (1::Int) tree'],
  ['Data.Map.Strict', 'M.insertWith (+) key (1::Int) tree'],
  ['Data.Map', 'M.delete key tree'],
  ['Data.Map', 'M.adjust (+1) key tree'],
  ['Data.Map', 'M.update (Just . (+1)) key tree'],
  ['Data.Map', 'M.alter (const Nothing) key tree'],
  ['Data.Set', 'M.insert key tree'],
  ['Data.Set', 'M.delete key tree'],
  ['Data.Set', 'M.member key tree'],
])('keyed operations demand the key before the tree: %s %s', (module, expression) => {
  const treeType = module === 'Data.Set' ? 'M.Set Int' : 'M.Map Int Int';
  const source = `import qualified ${module} as M\nkey=error "key"::Int\ntree=error "tree"::${treeType}\nmain=print((${expression}) \`seq\` 1)`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'key' });
});

test.each(['Just', 'Right'])('strict map traversal forces produced values at construction: %s', (constructor) => {
  const result = constructor === 'Just' ? 'Maybe Int' : 'Either () Int';
  const source = `import qualified Data.Map.Strict as M\nmain=print(fmap M.size(M.traverseWithKey (\\k _->${constructor}(error(show k))::${result})(M.fromList[(k,())|k<-[1,2,3::Int]])))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: constructor + ' ',
    uncaughtException: '2',
  });
});

test.each(['Data.Map', 'Data.Map.Strict'])(
  'monotonic key transformations preserve tree order and lazy payloads in %s',
  (module) => {
    for (const count of [3, 7]) {
      const source = `import qualified ${module} as M\nm=M.fromList[(k,())|k<-[1..${count}::Int]]\nmain=print(M.size(M.mapKeysMonotonic (\\k->error(show k)::Int) m))`;
      expect(executeProgram('haskell', source)).toMatchObject({
        kind: 'executed',
        stdout: '',
        uncaughtException: String(count),
      });
    }
    const source = `import qualified ${module} as M\nimport qualified Data.Map as L\nmain=do\n  print(M.size(M.mapKeysMonotonic (+1)(L.singleton (1::Int)(undefined::Int))))\n  print(M.toList(M.mapKeysMonotonic (+1)(L.fromList[(1,'a'),(2,'b'),(3,'c')::(Int,Char)])))`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: "1\n[(2,'a'),(3,'b'),(4,'c')]\n",
      uncaughtException: undefined,
    });
  }
);

test.each(['Data.Set', 'Data.Map', 'Data.Map.Strict'])(
  'neighboring searches preserve Ord method argument order in %s',
  (module) => {
    const single = module === 'Data.Set' ? 'M.singleton(K 1 (error "stored"))' : 'M.singleton(K 1 (error "stored")) ()';
    for (const search of ['lookupLT', 'lookupLE', 'lookupGT', 'lookupGE']) {
      const source = `import qualified ${module} as M\ndata K=K Int Int deriving Show\ninstance Eq K where K a b==K c d=a==c && b==d\ninstance Ord K where compare(K a b)(K c d)=case compare a c of EQ->compare b d; x->x\nmain=print(M.${search}(K 1(error "key"))(${single}))`;
      expect(executeProgram('haskell', source)).toMatchObject({
        kind: 'executed',
        stdout: '',
        uncaughtException: 'key',
      });
    }
  }
);

test.each(['Data.Set', 'Data.Map', 'Data.Map.Strict'])('bulk merges force earlier results in %s', (module) => {
  const type = module === 'Data.Set' ? 'M.Set Int' : 'M.Map Int Int';
  const operations = module === 'Data.Set' ? ['unions'] : ['unions', 'unionsWith (+)'];
  for (const operation of operations) {
    expect(
      executeProgram(
        'haskell',
        `import qualified ${module} as M\nmain=print(M.size(M.${operation} [error "first",error "second"]::${type}))`
      )
    ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'first' });
  }
});

test.each(['Data.Set', 'Data.Map', 'Data.Map.Strict'])('Foldable uses strict tree folds in %s', (module) => {
  const singleton = module === 'Data.Set' ? 'M.singleton(1::Int)' : 'M.singleton(1::Int) ()';
  const type = module === 'Data.Set' ? 'M.Set Int' : 'M.Map Int ()';
  for (const operation of ["foldr'", "foldl'"]) {
    expect(
      executeProgram(
        'haskell',
        `import qualified ${module} as M\nimport qualified Data.Foldable as F\nmain=print(F.${operation} (\\_ _->1::Int) undefined (${singleton}))`
      )
    ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'Prelude.undefined' });
    expect(
      executeProgram(
        'haskell',
        `import qualified ${module} as M\nmain=print(M.${operation} (\\_ _->1::Int) (error "seed") (error "tree"::${type}))`
      )
    ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'seed' });
  }
});

test.each(['Data.Map', 'Data.Map.Strict'])('key-set operations traverse collection trees in %s', (module) => {
  const imports = `import qualified ${module} as M\nimport qualified Data.Set as S\nimport Data.List(foldl')\n`;
  for (const [expression, stdout] of [
    ['sum[M.size(M.restrictKeys m(S.singleton k))|k<-[1..500::Int]]', '500\n'],
    [String.raw`M.size(foldl' (\tree k->M.withoutKeys tree(S.singleton k)) m [1..500::Int])`, '0\n'],
  ]) {
    expect(
      executeProgram('haskell', `${imports}m=M.fromList[(k,k)|k<-[1..500::Int]]\nmain=print(${expression})`)
    ).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
  }
  expect(
    executeProgram(
      'haskell',
      `${imports}import qualified Data.Map as L\nm=L.singleton (1::Int)(undefined::Int)\nmain=print(M.size(M.restrictKeys m(S.singleton 1)),M.size(M.withoutKeys m S.empty))`
    )
  ).toMatchObject({ kind: 'executed', stdout: '(1,1)\n', uncaughtException: undefined });
});

test.each(['Data.Map', 'Data.Map.Strict'])('key-set traversals preserve comparison order in %s', (module) => {
  const source = `import qualified ${module} as M\nimport qualified Data.Set as S\ndata K=K Int String deriving(Eq,Show)\ninstance Ord K where\n compare(K x a)(K y b)=case compare x y of\n  EQ->if x==2 then EQ else compare a b\n  ordering->ordering\nm=M.fromList[(K k(show k),())|k<-[1..3]]\ns=S.fromList[K k(error(show k))|k<-[1..3]]\n`;
  for (const [operation, uncaughtException] of [
    ['restrictKeys', '1'],
    ['withoutKeys', '3'],
  ]) {
    expect(executeProgram('haskell', `${source}main=print(M.size(M.${operation} m s))`)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException,
    });
  }
});

test.each(['Data.Set', 'Data.Map'])('list builders force keys in input order in %s', (module) => {
  const type = module === 'Data.Set' ? 'M.Set Int' : 'M.Map Int Int';
  const input = module === 'Data.Set' ? '[error "first",error "second"]' : '[(error "first",0),(error "second",0)]';
  const builders =
    module === 'Data.Set' ? ['fromList'] : ['fromList', 'fromListWith (+)', String.raw`fromListWithKey (\_->(+))`];
  for (const builder of builders) {
    expect(
      executeProgram('haskell', `import qualified ${module} as M\nmain=print(M.size(M.${builder} ${input}::${type}))`)
    ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'first' });
  }
});

test('Set mapping transforms the first ascending element first', () => {
  expect(
    executeProgram(
      'haskell',
      'import qualified Data.Set as S\nmain=print(S.size(S.map (\\x->error(show x)::Int)(S.fromList[1,2,3::Int])))'
    )
  ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: '1' });
  expect(
    executeProgram('haskell', 'import qualified Data.Map as M\nmain=print(M.size(M.fromList[(1::Int,undefined::Int)]))')
  ).toMatchObject({ kind: 'executed', stdout: '1\n', uncaughtException: undefined });
});

test.each(['Data.Map', 'Data.Map.Strict'])(
  'submaps inspect the right tree and compare root values first in %s',
  (module) => {
    const imports = `import qualified ${module} as M\n`;
    for (const left of ['M.empty', 'error "first"']) {
      expect(
        executeProgram('haskell', `${imports}main=print(M.isSubmapOf (${left}::M.Map Int Int)(error "second"))`)
      ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'second' });
    }
    const source = `${imports}import qualified Data.Map as L\na=L.fromList[(1,error "left"),(2,error "root"),(3,error "right")]\nb=M.fromList[(k,0::Int)|k<-[1,2,3::Int]]\nmain=print(M.isSubmapOf a b)`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: 'root',
    });
    expect(
      executeProgram(
        'haskell',
        `${imports}import qualified Data.Map as L\nmain=print(M.isSubmapOf(L.singleton(1::Int)(undefined::Int)) M.empty)`
      )
    ).toMatchObject({ kind: 'executed', stdout: 'False\n', uncaughtException: undefined });
  }
);

test.each(['Data.Set', 'Data.Map', 'Data.Map.Strict'])(
  'strict left folds demand every previous subtree in %s',
  (module) => {
    const tree = module === 'Data.Set' ? 'M.fromList[1,2,3::Int]' : 'M.fromList[(x,x)|x<-[1,2,3::Int]]';
    const folds = ["M.foldl'", "F.foldl'"];
    for (const fold of folds) {
      for (const [callback, uncaughtException] of [
        [String.raw`\_ x->if x==1 then error "bad" else 0::Int`, 'bad'],
        [String.raw`\_ x->error(show x)::Int`, '1'],
      ]) {
        const source = `import qualified ${module} as M\nimport qualified Data.Foldable as F\nmain=print(${fold} (${callback}) 0 (${tree}))`;
        expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
      }
    }
    if (module !== 'Data.Set') {
      expect(
        executeProgram(
          'haskell',
          `import qualified ${module} as M\nmain=print(M.foldlWithKey' (\\_ k _->error(show k)::Int) 0 (${tree}))`
        )
      ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: '1' });
    }
  }
);

test.each(['Data.Map', 'Data.Map.Strict'])('key sets preserve map shape and payload laziness in %s', (module) => {
  for (const [keys, failures, uncaughtException] of [
    ['[8,3,4,5,7,9,6,1,2::Int]', '[8,5]', '8'],
    ['[1,2,4,8,6,9,5,3,7::Int]', '[6,2]', '2'],
  ]) {
    const source = `import qualified ${module} as M\nimport qualified Data.Set as S\nimport Data.List(foldl')\nm=foldl' (\\tree k->M.insert k () tree) M.empty ${keys}\nmain=print(S.size(S.filter (\\k->if k \`elem\` ${failures} then error(show k) else True)(M.keysSet m)))`;
    expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
  }
  expect(
    executeProgram(
      'haskell',
      `import qualified ${module} as M\nimport qualified Data.Map as L\nimport qualified Data.Set as S\nmain=print(S.toList(M.keysSet(L.singleton(1::Int)(undefined::Int))))`
    )
  ).toMatchObject({ kind: 'executed', stdout: '[1]\n', uncaughtException: undefined });
});

test.each(['Data.Set', 'Data.Map', 'Data.Map.Strict'])(
  'fromList builders retain ascending-prefix and fallback tree order in %s',
  (module) => {
    const builders =
      module === 'Data.Set'
        ? ['fromList']
        : ['fromList', 'fromListWith const', String.raw`fromListWithKey (\_ -> const)`];
    for (const [keys, expected] of [
      ['[1..5]', '4'],
      ['[1..11]', '8'],
      ['[1,2,3,4,5,2,0,6]', '2'],
      ['[1,2,3,2,4,5]', '2'],
    ]) {
      const entries = module === 'Data.Set' ? `map K (${keys}::[Int])` : `[(K k,())|k<-(${keys}::[Int])]`;
      for (const builder of builders) {
        const source = `import qualified ${module} as M\ndata K=K Int deriving(Eq,Show)\ninstance Ord K where\n compare(K x)(K y)=if x == -999 then error(show y) else compare x y\nmain=print(M.member(K(-999))(M.${builder}(${entries})))`;
        expect(executeProgram('haskell', source)).toMatchObject({
          kind: 'executed',
          stdout: '',
          uncaughtException: expected,
        });
      }
    }
  }
);

test.each([
  ['M.fromList[(error "key",error "value")]', 'value'],
  ['M.fromListWith const [(error "key",error "value")]', 'key'],
  [String.raw`M.fromListWithKey (\_ -> const) [(error "key",error "value")]`, 'key'],
  ['M.fromList[(1,error "first"),(1,2)]', 'first'],
  ['M.fromListWith const [(1,1),(1,error "new")]', 'new'],
])('strict list builder payload demand matches GHC: %s', (expression, uncaughtException) => {
  expect(
    executeProgram('haskell', `import qualified Data.Map.Strict as M\nmain=print(M.size(${expression}::M.Map Int Int))`)
  ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
});

test.each(['Data.Map', 'Data.Map.Strict'])(
  'list builder combinations retain incoming keys through fallback in %s',
  (module) => {
    const source = `import qualified ${module} as M\ndata K=K Int Char deriving Show\ninstance Eq K where K x _ == K y _ = x==y\ninstance Ord K where compare(K x _)(K y _)=compare x y\nmain=print(M.toList(M.fromListWithKey (\\(K _ c) new old -> c:new++old) [(K 1 'a',"A"),(K 1 'b',"B"),(K 0 'c',"C"),(K 1 'd',"D")] ))`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: `[(K 0 'c',"C"),(K 1 'd',"dDbBA")]\n`,
      uncaughtException: undefined,
    });
  }
);

test('strict combining builders skip discarded new payloads while lazy builders defer combinations', () => {
  expect(
    executeProgram(
      'haskell',
      'import qualified Data.Map.Strict as M\nmain=print(M.elems(M.fromListWith (flip const)[(1,1::Int),(1,error "new")]))'
    )
  ).toMatchObject({ kind: 'executed', stdout: '[1]\n', uncaughtException: undefined });
  expect(
    executeProgram(
      'haskell',
      'import qualified Data.Map as M\nmain=print(M.size(M.fromListWith (error "combine")[(1,1::Int),(1,2)]))'
    )
  ).toMatchObject({ kind: 'executed', stdout: '1\n', uncaughtException: undefined });
});
