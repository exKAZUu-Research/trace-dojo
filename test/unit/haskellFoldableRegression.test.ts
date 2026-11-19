import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const cases = [
  {
    name: 'toList override',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 toList _=[]
main=let b=Box(2::Int) in print(F.length b,F.sum b,F.product b,F.maximum b,F.minimum b,F.foldl (+) 3 b,F.foldr1 (+) b,F.foldl1 (+) b,F.find (==2) b,F.elem 2 b)`,
    stdout: '(1,2,2,2,2,5,2,2,Just 2,True)\n',
    uncaughtException: undefined,
  },
  {
    name: 'strict toList',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 toList(Box x)=x \`seq\` [x]
main=let b=Box(undefined::Int) in print(F.length b,F.null b,F.foldl (\\z _->z) 7 b,F.any (const True) b,F.all (const False) b,F.find (const False) b)`,
    stdout: '(1,False,7,True,False,Nothing)\n',
    uncaughtException: undefined,
  },
  {
    name: 'foldr override',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldr _ z _=z
main=let b=Box(2::Int) in print(F.foldl (+) 3 b,F.foldl' (+) 3 b,F.length b,F.sum b,F.elem 2 b,F.null b,F.find (==2) b,F.foldl1 (+) b)`,
    stdout: '(5,3,0,0,True,True,Just 2,2)\n',
    uncaughtException: undefined,
  },
  {
    name: 'foldMap override',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap _ _=mempty
 foldr f z(Box x)=f x z
main=let b=Box(2::Int) in print(F.foldl (+) 3 b,F.foldl' (+) 3 b,F.length b,F.sum b,F.elem 2 b,F.null b,F.find (==2) b,F.any (const True) b,F.all (const False) b,F.and(Box False),F.or(Box True))`,
    stdout: '(3,5,1,2,False,False,Nothing,False,True,True,False)\n',
    uncaughtException: undefined,
  },
  {
    name: 'foldl _ z _=z/folds',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldl _ z _=z
main=let b=Box(2::Int) in print(F.foldl (+) 3 b,F.foldl' (+) 3 b,F.foldr' (+) 3 b,F.length b,F.sum b,F.product b)`,
    stdout: '(3,5,3,1,2,2)\n',
    uncaughtException: undefined,
  },
  {
    name: 'foldl _ z _=z/maximum',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldl _ z _=z
main=let b=Box(2::Int) in print(F.maximum b)`,
    stdout: '2\n',
    uncaughtException: undefined,
  },
  {
    name: 'foldl _ z _=z/minimum',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldl _ z _=z
main=let b=Box(2::Int) in print(F.minimum b)`,
    stdout: '2\n',
    uncaughtException: undefined,
  },
  {
    name: 'foldl _ z _=z/foldl1',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldl _ z _=z
main=let b=Box(2::Int) in print(F.foldl1 (+) b)`,
    stdout: '',
    uncaughtException: 'foldl1: empty structure',
  },
  {
    name: 'foldl _ z _=z/foldr1',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldl _ z _=z
main=let b=Box(2::Int) in print(F.foldr1 (+) b)`,
    stdout: '2\n',
    uncaughtException: undefined,
  },
  {
    name: "foldl' _ z _=z/folds",
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldl' _ z _=z
main=let b=Box(2::Int) in print(F.foldl (+) 3 b,F.foldl' (+) 3 b,F.foldr' (+) 3 b,F.length b,F.sum b,F.product b)`,
    stdout: '(5,3,5,0,0,1)\n',
    uncaughtException: undefined,
  },
  {
    name: "foldl' _ z _=z/maximum",
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldl' _ z _=z
main=let b=Box(2::Int) in print(F.maximum b)`,
    stdout: '',
    uncaughtException: 'maximum: empty structure',
  },
  {
    name: "foldl' _ z _=z/minimum",
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldl' _ z _=z
main=let b=Box(2::Int) in print(F.minimum b)`,
    stdout: '',
    uncaughtException: 'minimum: empty structure',
  },
  {
    name: "foldl' _ z _=z/foldl1",
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldl' _ z _=z
main=let b=Box(2::Int) in print(F.foldl1 (+) b)`,
    stdout: '2\n',
    uncaughtException: undefined,
  },
  {
    name: "foldl' _ z _=z/foldr1",
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldl' _ z _=z
main=let b=Box(2::Int) in print(F.foldr1 (+) b)`,
    stdout: '2\n',
    uncaughtException: undefined,
  },
  {
    name: "foldMap' _ _=mempty/folds",
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldMap' _ _=mempty
main=let b=Box(2::Int) in print(F.foldl (+) 3 b,F.foldl' (+) 3 b,F.foldr' (+) 3 b,F.length b,F.sum b,F.product b)`,
    stdout: '(5,5,5,1,0,1)\n',
    uncaughtException: undefined,
  },
  {
    name: "foldMap' _ _=mempty/maximum",
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldMap' _ _=mempty
main=let b=Box(2::Int) in print(F.maximum b)`,
    stdout: '',
    uncaughtException: 'maximum: empty structure',
  },
  {
    name: "foldMap' _ _=mempty/minimum",
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldMap' _ _=mempty
main=let b=Box(2::Int) in print(F.minimum b)`,
    stdout: '',
    uncaughtException: 'minimum: empty structure',
  },
  {
    name: "foldMap' _ _=mempty/foldl1",
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldMap' _ _=mempty
main=let b=Box(2::Int) in print(F.foldl1 (+) b)`,
    stdout: '2\n',
    uncaughtException: undefined,
  },
  {
    name: "foldMap' _ _=mempty/foldr1",
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where
 foldMap f(Box x)=f x
 foldMap' _ _=mempty
main=let b=Box(2::Int) in print(F.foldr1 (+) b)`,
    stdout: '2\n',
    uncaughtException: undefined,
  },
  {
    name: 'foldMap default uses mappend',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where foldr f z(Box x)=f x z
data M=M Int deriving Show
instance Semigroup M where M a <> M b=M(a+b)
instance Monoid M where
 mempty=M 0
 mappend _ _=error "mappend"
main=print(F.foldMap (\\x->M x)(Box(2::Int)))`,
    stdout: '',
    uncaughtException: 'mappend',
  },
  {
    name: 'list overrides use mconcat',
    source: `import qualified Data.Foldable as F
data M=M Int deriving Show
instance Semigroup M where M a <> M b=M(a+b)
instance Monoid M where
 mempty=M 0
 mconcat _=M 99
main=print(F.foldMap M [1,2],F.fold[M 1,M 2])`,
    stdout: '(M 99,M 99)\n',
    uncaughtException: undefined,
  },
  {
    name: 'noncommutative fold order and empty structures',
    source: `import qualified Data.Foldable as F
data Box a=Box[a]
instance Foldable Box where
 foldMap f(Box xs)=mconcat(map f xs)
 toList _=[]
main=let b=Box[1,2,3::Int] in print(F.foldl (\\a x->10*a+x) 0 b,F.foldr (\\x a->10*a+x) 0 b,F.foldl1 (-) b,F.foldr1 (-) b,F.length(Box[]::Box Int),F.sum(Box[]::Box Int),F.product(Box[]::Box Int))`,
    stdout: '(123,321,-4,2,0,0,1)\n',
    uncaughtException: undefined,
  },
  {
    name: 'maxima retain first equal element',
    source: `import qualified Data.Foldable as F
data K=K Int Char deriving Show
instance Eq K where K x _==K y _=x==y
instance Ord K where compare(K x _)(K y _)=compare x y
data Box a=Box[a]
instance Foldable Box where foldMap f(Box xs)=mconcat(map f xs)
main=print(F.maximum(Box[K 1 'a',K 1 'b']),F.minimum(Box[K 1 'a',K 1 'b']))`,
    stdout: "(K 1 'a',K 1 'a')\n",
    uncaughtException: undefined,
  },
  {
    name: 'boolean and search short circuits',
    source: `import qualified Data.Foldable as F
data Stream a=Stream a(Stream a)
instance Foldable Stream where foldMap f(Stream x xs)=f x<>foldMap f xs
main=print(F.any id(Stream True undefined),F.all id(Stream False undefined),F.and(Stream False undefined),F.or(Stream True undefined),F.find (const True)(Stream(2::Int)undefined))`,
    stdout: '(True,False,False,True,Just 2)\n',
    uncaughtException: undefined,
  },
  {
    name: 'numeric wrappers preserve ignored bottom arguments',
    source: `import qualified Data.Foldable as F
data K=K Int deriving Show
instance Num K where
 _ + _=K 7
 _ * _=K 9
 fromInteger n=K(fromInteger n)
data Box a=Box a
instance Foldable Box where foldMap f(Box x)=f x
main=print(F.sum(Box(undefined::K)),F.product(Box(undefined::K)))`,
    stdout: '(K 7,K 9)\n',
    uncaughtException: undefined,
  },
  {
    name: 'left folds preserve newtype composition laziness',
    source: `import qualified Data.Foldable as F
data Box a=Box a
instance Foldable Box where foldMap f(Box x)=undefined<>f x
main=print(F.foldl (\\_ x->x) (0::Int)(Box 2))`,
    stdout: '2\n',
    uncaughtException: undefined,
  },
];

test.each(cases)('$name', ({ source, stdout, uncaughtException }) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException });
});

const independentFolds = `import qualified Data.Foldable as F
data Two a = Two a a
instance Foldable Two where
  foldMap f (Two x y) = f x <> f y
  foldr f z (Two x y) = f y (f x z)
  toList _ = []`;

test('uses each primitive fold in the direction its default requires', () => {
  const source = `${independentFolds}
main = print (F.foldl (flip (:)) [] (Two (1 :: Int) 2), F.foldl' (flip (:)) [] (Two (1 :: Int) 2), F.foldr1 (-) (Two (1 :: Int) 2), F.foldl1 (-) (Two (1 :: Int) 2))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '([2,1],[1,2],1,-1)\n',
    uncaughtException: undefined,
  });
});

test.each(['F.elem 2', 'F.any (> 0)', 'F.all (< 0)', 'F.find (== 2)'])(
  'searches through foldMap for %s',
  (operation) => {
    const source = `${independentFolds}
main = print (${operation} (Two (error "first" :: Int) 2))`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: 'first',
    });
  }
);

test.each([
  [
    'and(replicate 1000 True),or(replicate 1000 False),all (>=0)[1..1000::Int],any (==1000)[1..1000::Int]',
    '(True,False,True,True)\n',
  ],
  ['and(replicate 10000 True)', 'True\n'],
])('Boolean folds retain bounded work through newtype indirections: %s', (expression, stdout) => {
  expect(executeProgram('haskell', `main=print(${expression})`)).toMatchObject({
    kind: 'executed',
    stdout,
    uncaughtException: undefined,
  });
});
