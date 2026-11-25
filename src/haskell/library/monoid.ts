/**
 * The monoids of `Data.Monoid`, the non-empty lists of `Data.List.NonEmpty`, and the functors of
 * `Data.Functor.Identity`, `Data.Functor.Const`, and `Data.Functor.Compose`, as GHC's base defines them.
 */
export const BASE_MONOID = String.raw`
-- Non-empty lists

infixr 5 :|

data NonEmpty a = a :| [a] deriving (Eq, Ord, Show, Read)

instance Functor NonEmpty where
  fmap f (a :| as) = f a :| map f as

instance Foldable NonEmpty where
  foldr f z (a :| as) = f a (foldr f z as)
  toList (a :| as) = a : as
  null _ = False
  length (_ :| as) = 1 + length as

instance Traversable NonEmpty where
  traverse f (a :| as) = liftA2 (:|) (f a) (traverse f as)

instance Applicative NonEmpty where
  pure a = a :| []
  fs <*> xs = fs >>= \f -> fmap f xs

instance Monad NonEmpty where
  (a :| as) >>= f = case f a of
    b :| bs -> b :| (bs ++ (as >>= \x -> case f x of c :| cs -> c : cs))

instance Semigroup (NonEmpty a) where
  (a :| as) <> (b :| bs) = a :| (as ++ b : bs)

-- Monoids

newtype Dual a = Dual { getDual :: a } deriving (Eq, Ord, Show, Read, Bounded)

instance Semigroup a => Semigroup (Dual a) where
  Dual a <> Dual b = Dual (b <> a)

instance Monoid a => Monoid (Dual a) where
  mempty = Dual mempty

instance Functor Dual where
  fmap f (Dual a) = Dual (f a)

newtype Endo a = Endo { appEndo :: a -> a }

instance Semigroup (Endo a) where
  Endo f <> Endo g = Endo (f . g)

instance Monoid (Endo a) where
  mempty = Endo id

newtype All = All { getAll :: Bool } deriving (Eq, Ord, Show, Read, Bounded)

instance Semigroup All where
  All a <> All b = All (a && b)

instance Monoid All where
  mempty = All True

newtype Any = Any { getAny :: Bool } deriving (Eq, Ord, Show, Read, Bounded)

instance Semigroup Any where
  Any a <> Any b = Any (a || b)

instance Monoid Any where
  mempty = Any False

newtype Sum a = Sum { getSum :: a } deriving (Eq, Ord, Show, Read, Bounded, Num)

instance Num a => Semigroup (Sum a) where
  Sum a <> Sum b = Sum (a + b)
  stimes n (Sum a) = Sum (fromIntegral n * a)

instance Num a => Monoid (Sum a) where
  mempty = Sum 0

instance Functor Sum where
  fmap f (Sum a) = Sum (f a)

instance Applicative Sum where
  pure = Sum
  Sum f <*> Sum a = Sum (f a)

instance Monad Sum where
  Sum a >>= f = f a

newtype Product a = Product { getProduct :: a } deriving (Eq, Ord, Show, Read, Bounded, Num)

instance Num a => Semigroup (Product a) where
  Product a <> Product b = Product (a * b)
  stimes n (Product a) = Product (a ^ n)

instance Num a => Monoid (Product a) where
  mempty = Product 1

instance Functor Product where
  fmap f (Product a) = Product (f a)

instance Applicative Product where
  pure = Product
  Product f <*> Product a = Product (f a)

instance Monad Product where
  Product a >>= f = f a

newtype First a = First { getFirst :: Maybe a } deriving (Eq, Ord, Show, Read)

instance Semigroup (First a) where
  First Nothing <> b = b
  a <> _ = a

instance Monoid (First a) where
  mempty = First Nothing

instance Functor First where
  fmap f (First a) = First (fmap f a)

newtype Last a = Last { getLast :: Maybe a } deriving (Eq, Ord, Show, Read)

instance Semigroup (Last a) where
  a <> Last Nothing = a
  _ <> b = b

instance Monoid (Last a) where
  mempty = Last Nothing

instance Functor Last where
  fmap f (Last a) = Last (fmap f a)

newtype Alt f a = Alt { getAlt :: f a }

instance Eq (f a) => Eq (Alt f a) where
  Alt a == Alt b = a == b

instance Ord (f a) => Ord (Alt f a) where
  compare (Alt a) (Alt b) = compare a b

instance Show (f a) => Show (Alt f a) where
  showsPrec d (Alt a) = showParen (d >= 11) (showString "Alt {getAlt = " . showsPrec 0 a . showChar '}')

instance Alternative f => Semigroup (Alt f a) where
  Alt a <> Alt b = Alt (a <|> b)

instance Alternative f => Monoid (Alt f a) where
  mempty = Alt empty

instance Functor f => Functor (Alt f) where
  fmap f (Alt a) = Alt (fmap f a)

newtype Ap f a = Ap { getAp :: f a }

instance Eq (f a) => Eq (Ap f a) where
  Ap a == Ap b = a == b

instance Ord (f a) => Ord (Ap f a) where
  compare (Ap a) (Ap b) = compare a b

instance Show (f a) => Show (Ap f a) where
  showsPrec d (Ap a) = showParen (d >= 11) (showString "Ap {getAp = " . showsPrec 0 a . showChar '}')

instance (Applicative f, Semigroup a) => Semigroup (Ap f a) where
  Ap a <> Ap b = Ap (liftA2 (<>) a b)

instance (Applicative f, Monoid a) => Monoid (Ap f a) where
  mempty = Ap (pure mempty)

instance Functor f => Functor (Ap f) where
  fmap f (Ap a) = Ap (fmap f a)

-- Functors

newtype Identity a = Identity { runIdentity :: a } deriving (Eq, Ord)

instance Show a => Show (Identity a) where
  showsPrec d (Identity a) = showParen (d >= 11) (showString "Identity " . showsPrec 11 a)

instance Functor Identity where
  fmap f (Identity a) = Identity (f a)

instance Foldable Identity where
  foldr f z (Identity a) = f a z

instance Traversable Identity where
  traverse f (Identity a) = fmap Identity (f a)

instance Applicative Identity where
  pure = Identity
  Identity f <*> Identity a = Identity (f a)

instance Monad Identity where
  Identity a >>= f = f a

instance MonadFix Identity where
  mfix f = let x = f (runIdentity x) in x

newtype Const a b = Const { getConst :: a } deriving (Eq, Ord)

instance Show a => Show (Const a b) where
  showsPrec d (Const a) = showParen (d >= 11) (showString "Const " . showsPrec 11 a)

instance Functor (Const m) where
  fmap _ (Const a) = Const a

instance Foldable (Const m) where
  foldr _ z _ = z

instance Traversable (Const m) where
  traverse _ (Const a) = pure (Const a)

instance Monoid m => Applicative (Const m) where
  pure _ = Const mempty
  Const a <*> Const b = Const (a <> b)

newtype Compose f g a = Compose { getCompose :: f (g a) }

instance Eq (f (g a)) => Eq (Compose f g a) where
  Compose a == Compose b = a == b

instance Ord (f (g a)) => Ord (Compose f g a) where
  compare (Compose a) (Compose b) = compare a b

instance Show (f (g a)) => Show (Compose f g a) where
  showsPrec d (Compose a) = showParen (d >= 11) (showString "Compose " . showsPrec 11 a)

instance (Functor f, Functor g) => Functor (Compose f g) where
  fmap f (Compose a) = Compose (fmap (fmap f) a)

instance (Foldable f, Foldable g) => Foldable (Compose f g) where
  foldr f z (Compose a) = foldr (\ga acc -> foldr f acc ga) z a

instance (Traversable f, Traversable g) => Traversable (Compose f g) where
  traverse f (Compose a) = fmap Compose (traverse (traverse f) a)

instance (Applicative f, Applicative g) => Applicative (Compose f g) where
  pure a = Compose (pure (pure a))
  Compose f <*> Compose a = Compose (liftA2 (<*>) f a)
`;

/** `Data.Semigroup`'s own types: the semigroups of the least, the greatest, the first, and the last value. */
export const SEMIGROUP_SOURCE = String.raw`module Data.Semigroup.Internal
  ( Min(..), Max(..), First(..), Last(..), WrappedMonoid(..), Arg(..), ArgMin, ArgMax
  , diff, cycle1, mtimesDefault, stimesMonoid, stimesIdempotent
  , Semigroup(..), Dual(..), Endo(..), All(..), Any(..), Sum(..), Product(..), NonEmpty(..)
  ) where

import Base hiding (First(..), Last(..))

newtype Min a = Min { getMin :: a } deriving (Eq, Ord, Show, Read, Bounded, Num)

instance Ord a => Semigroup (Min a) where
  Min a <> Min b = Min (min a b)
  stimes = stimesIdempotent

instance (Ord a, Bounded a) => Monoid (Min a) where
  mempty = maxBound

instance Functor Min where
  fmap f (Min a) = Min (f a)

instance Enum a => Enum (Min a) where
  toEnum = Min . toEnum
  fromEnum (Min a) = fromEnum a
  succ (Min a) = Min (succ a)
  pred (Min a) = Min (pred a)
  enumFrom (Min a) = map Min (enumFrom a)
  enumFromThen (Min a) (Min b) = map Min (enumFromThen a b)
  enumFromTo (Min a) (Min b) = map Min (enumFromTo a b)
  enumFromThenTo (Min a) (Min b) (Min c) = map Min (enumFromThenTo a b c)

newtype Max a = Max { getMax :: a } deriving (Eq, Ord, Show, Read, Bounded, Num)

instance Ord a => Semigroup (Max a) where
  Max a <> Max b = Max (max a b)
  stimes = stimesIdempotent

instance (Ord a, Bounded a) => Monoid (Max a) where
  mempty = minBound

instance Functor Max where
  fmap f (Max a) = Max (f a)

instance Enum a => Enum (Max a) where
  toEnum = Max . toEnum
  fromEnum (Max a) = fromEnum a
  succ (Max a) = Max (succ a)
  pred (Max a) = Max (pred a)
  enumFrom (Max a) = map Max (enumFrom a)
  enumFromThen (Max a) (Max b) = map Max (enumFromThen a b)
  enumFromTo (Max a) (Max b) = map Max (enumFromTo a b)
  enumFromThenTo (Max a) (Max b) (Max c) = map Max (enumFromThenTo a b c)

newtype First a = First { getFirst :: a } deriving (Eq, Ord, Show, Read, Bounded)

instance Semigroup (First a) where
  a <> _ = a
  stimes = stimesIdempotent

instance Functor First where
  fmap f (First a) = First (f a)

newtype Last a = Last { getLast :: a } deriving (Eq, Ord, Show, Read, Bounded)

instance Semigroup (Last a) where
  _ <> b = b
  stimes = stimesIdempotent

instance Functor Last where
  fmap f (Last a) = Last (f a)

newtype WrappedMonoid m = WrapMonoid { unwrapMonoid :: m } deriving (Eq, Ord, Show, Read, Bounded)

instance Monoid m => Semigroup (WrappedMonoid m) where
  WrapMonoid a <> WrapMonoid b = WrapMonoid (a ${'`'}mappend${'`'} b)

instance Monoid m => Monoid (WrappedMonoid m) where
  mempty = WrapMonoid mempty

data Arg a b = Arg a b deriving (Show, Read)

type ArgMin a b = Min (Arg a b)

type ArgMax a b = Max (Arg a b)

instance Eq a => Eq (Arg a b) where
  Arg a _ == Arg b _ = a == b

instance Ord a => Ord (Arg a b) where
  compare (Arg a _) (Arg b _) = compare a b
  min x@(Arg a _) y@(Arg b _) = if a <= b then x else y
  max x@(Arg a _) y@(Arg b _) = if a >= b then x else y

instance Functor (Arg a) where
  fmap f (Arg x a) = Arg x (f a)

diff :: Semigroup m => m -> Endo m
diff = Endo . (<>)

cycle1 :: Semigroup m => m -> m
cycle1 xs = xs' where xs' = xs <> xs'

mtimesDefault :: (Integral b, Monoid a) => b -> a -> a
mtimesDefault n x
  | n == 0 = mempty
  | otherwise = stimes n x

stimesIdempotent :: Integral b => b -> a -> a
stimesIdempotent n x
  | n <= 0 = errorWithoutStackTrace "stimesIdempotent: positive multiplier expected"
  | otherwise = x

stimesMonoid :: (Integral b, Monoid a) => b -> a -> a
stimesMonoid n x
  | n < 0 = errorWithoutStackTrace "stimesMonoid: negative multiplier"
  | n == 0 = mempty
  | otherwise = mconcat (replicate (fromIntegral n) x)
`;

/** `Data.List.NonEmpty`'s functions, whose names are those of the list functions they mirror. */
export const NON_EMPTY_SOURCE = String.raw`module Data.List.NonEmpty.Internal where

import Base hiding (map, head, tail, last, init, length, reverse, filter, takeWhile, dropWhile, span, break, zip, zipWith, unzip, iterate, repeat, cycle, (!!), sort, sortBy, sortOn, group, groupBy, nub, nubBy, partition, splitAt, take, drop, scanl, scanr, scanl1, scanr1, insert, transpose, toList, xor, singleton, cons, uncons, intersperse, isPrefixOf, some1, sortWith, groupWith, groupAllWith, unfoldr, inits, tails, append, unfold)
import qualified Base as B

infixr 5 <|

nonEmpty :: [a] -> Maybe (NonEmpty a)
nonEmpty [] = Nothing
nonEmpty (a : as) = Just (a :| as)

fromList :: [a] -> NonEmpty a
fromList (a : as) = a :| as
fromList [] = errorWithoutStackTrace "NonEmpty.fromList: empty list"

toList :: NonEmpty a -> [a]
toList (a :| as) = a : as

singleton :: a -> NonEmpty a
singleton a = a :| []

map :: (a -> b) -> NonEmpty a -> NonEmpty b
map f (a :| as) = f a :| B.map f as

head :: NonEmpty a -> a
head (a :| _) = a

tail :: NonEmpty a -> [a]
tail (_ :| as) = as

last :: NonEmpty a -> a
last (a :| as) = B.last (a : as)

init :: NonEmpty a -> [a]
init (a :| as) = B.init (a : as)

length :: NonEmpty a -> Int
length (_ :| as) = 1 + B.length as

(<|) :: a -> NonEmpty a -> NonEmpty a
a <| (b :| bs) = a :| (b : bs)

cons :: a -> NonEmpty a -> NonEmpty a
cons = (<|)

uncons :: NonEmpty a -> (a, Maybe (NonEmpty a))
uncons (a :| as) = (a, nonEmpty as)

reverse :: NonEmpty a -> NonEmpty a
reverse = liftNE B.reverse

sort :: Ord a => NonEmpty a -> NonEmpty a
sort = liftNE B.sort

sortBy :: (a -> a -> Ordering) -> NonEmpty a -> NonEmpty a
sortBy f = liftNE (B.sortBy f)

sortOn :: Ord b => (a -> b) -> NonEmpty a -> NonEmpty a
sortOn f = liftNE (B.sortOn f)

sortWith :: Ord o => (a -> o) -> NonEmpty a -> NonEmpty a
sortWith f = liftNE (B.sortBy (\x y -> compare (f x) (f y)))

nub :: Eq a => NonEmpty a -> NonEmpty a
nub = liftNE B.nub

nubBy :: (a -> a -> Bool) -> NonEmpty a -> NonEmpty a
nubBy f = liftNE (B.nubBy f)

intersperse :: a -> NonEmpty a -> NonEmpty a
intersperse x = liftNE (B.intersperse x)

liftNE :: ([a] -> [b]) -> NonEmpty a -> NonEmpty b
liftNE f = fromList . f . toList

zip :: NonEmpty a -> NonEmpty b -> NonEmpty (a, b)
zip (a :| as) (b :| bs) = (a, b) :| B.zip as bs

zipWith :: (a -> b -> c) -> NonEmpty a -> NonEmpty b -> NonEmpty c
zipWith f (a :| as) (b :| bs) = f a b :| B.zipWith f as bs

unzip :: Functor f => f (a, b) -> (f a, f b)
unzip xs = (fmap fst xs, fmap snd xs)

filter :: (a -> Bool) -> NonEmpty a -> [a]
filter p = B.filter p . toList

partition :: (a -> Bool) -> NonEmpty a -> ([a], [a])
partition p = B.partition p . toList

takeWhile :: (a -> Bool) -> NonEmpty a -> [a]
takeWhile p = B.takeWhile p . toList

dropWhile :: (a -> Bool) -> NonEmpty a -> [a]
dropWhile p = B.dropWhile p . toList

span :: (a -> Bool) -> NonEmpty a -> ([a], [a])
span p = B.span p . toList

break :: (a -> Bool) -> NonEmpty a -> ([a], [a])
break p = span (not . p)

take :: Int -> NonEmpty a -> [a]
take n = B.take n . toList

drop :: Int -> NonEmpty a -> [a]
drop n = B.drop n . toList

splitAt :: Int -> NonEmpty a -> ([a], [a])
splitAt n = B.splitAt n . toList

(!!) :: NonEmpty a -> Int -> a
(a :| as) !! n
  | n == 0 = a
  | n > 0 = as B.!! (n - 1)
  | otherwise = errorWithoutStackTrace "NonEmpty.!! negative index"

infixl 9 !!

iterate :: (a -> a) -> a -> NonEmpty a
iterate f a = a :| B.iterate f (f a)

repeat :: a -> NonEmpty a
repeat a = a :| B.repeat a

cycle :: NonEmpty a -> NonEmpty a
cycle = liftNE B.cycle

scanl :: Foldable f => (b -> a -> b) -> b -> f a -> NonEmpty b
scanl f z = fromList . B.scanl f z . B.toList

scanr :: Foldable f => (a -> b -> b) -> b -> f a -> NonEmpty b
scanr f z = fromList . B.scanr f z . B.toList

scanl1 :: (a -> a -> a) -> NonEmpty a -> NonEmpty a
scanl1 f (a :| as) = fromList (B.scanl f a as)

scanr1 :: (a -> a -> a) -> NonEmpty a -> NonEmpty a
scanr1 f (a :| as) = fromList (B.scanr1 f (a : as))

insert :: (Foldable f, Ord a) => a -> f a -> NonEmpty a
insert a = fromList . B.insert a . B.toList

groupBy :: Foldable f => (a -> a -> Bool) -> f a -> [NonEmpty a]
groupBy eq = go . B.toList
  where
    go [] = []
    go (x : xs) = let (ys, zs) = B.span (eq x) xs in (x :| ys) : go zs

group :: (Foldable f, Eq a) => f a -> [NonEmpty a]
group = groupBy (==)

groupWith :: (Foldable f, Eq b) => (a -> b) -> f a -> [NonEmpty a]
groupWith f = groupBy (\x y -> f x == f y)

groupAllWith :: Ord b => (a -> b) -> [a] -> [NonEmpty a]
groupAllWith f = groupWith f . B.sortBy (\x y -> compare (f x) (f y))

groupBy1 :: (a -> a -> Bool) -> NonEmpty a -> NonEmpty (NonEmpty a)
groupBy1 eq = fromList . groupBy eq . toList

group1 :: Eq a => NonEmpty a -> NonEmpty (NonEmpty a)
group1 = groupBy1 (==)

isPrefixOf :: Eq a => [a] -> NonEmpty a -> Bool
isPrefixOf xs ys = B.isPrefixOf xs (toList ys)

transpose :: NonEmpty (NonEmpty a) -> NonEmpty (NonEmpty a)
transpose = fromList . B.map fromList . B.transpose . B.map toList . toList

unfoldr :: (a -> (b, Maybe a)) -> a -> NonEmpty b
unfoldr f a = case f a of
  (b, mc) -> b :| maybe [] go mc
  where
    go c = case f c of
      (d, me) -> d : maybe [] go me

inits :: Foldable f => f a -> NonEmpty [a]
inits = fromList . B.inits . B.foldr (:) []

tails :: Foldable f => f a -> NonEmpty [a]
tails = fromList . B.tails . B.foldr (:) []

append :: NonEmpty a -> NonEmpty a -> NonEmpty a
append (a :| as) (b :| bs) = a :| (as ++ b : bs)

unfold :: (a -> (b, Maybe a)) -> a -> NonEmpty b
unfold = unfoldr

xor :: NonEmpty Bool -> Bool
xor (x :| xs) = B.foldr (\a b -> a /= b) x xs

some1 :: Alternative f => f a -> f (NonEmpty a)
some1 x = liftA2 (:|) x (many x)
`;
