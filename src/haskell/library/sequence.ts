/**
 * `Data.Sequence`, finite sequences: a balanced tree of the elements by increasing keys, which adds at either end,
 * indexes, updates, and splits in logarithmic time, as the containers package's finger trees do.
 */
export const SEQUENCE_SOURCE = String.raw`module Data.Sequence.Internal where

import Base hiding (length, null, reverse, lookup, filter, replicate, splitAt, take, drop, zip, zipWith, scanl, sort, sortBy, sortOn, unzip, partition, insertAt, deleteAt, foldlWithIndex, foldrWithIndex, iterate, unstableSort, elemIndexL, findIndexL, mapWithIndex, empty, singleton, fromList, adjust, update, index, intersperse, breakl, spanl, takeWhileL, dropWhileL, tails, inits, chunksOf, zip3, zipWith3, cycleTaking, fromFunction, replicateA, replicateM, unfoldr, iterateN, viewl, viewr)
import qualified Base as B
import qualified Data.Map.Internal as M

infixr 5 <|
infixl 5 |>
infixr 5 ><
infixr 5 :<
infixl 5 :>

-- The keys only order the elements; adding at the front takes a key below the least.
newtype Seq a = Seq (M.Map Integer a)

data ViewL a = EmptyL | a :< Seq a

data ViewR a = EmptyR | Seq a :> a

instance Show a => Show (Seq a) where
  showsPrec d s = showParen (d > 10) (showString "fromList " . shows (toList s))

instance Eq a => Eq (Seq a) where
  a == b = toList a == toList b

instance Ord a => Ord (Seq a) where
  compare a b = compare (toList a) (toList b)

instance Show a => Show (ViewL a) where
  showsPrec _ EmptyL = showString "EmptyL"
  showsPrec d (x :< s) = showParen (d > 5) (showsPrec 6 x . showString " :< " . showsPrec 6 s)

instance Show a => Show (ViewR a) where
  showsPrec _ EmptyR = showString "EmptyR"
  showsPrec d (s :> x) = showParen (d > 5) (showsPrec 6 s . showString " :> " . showsPrec 6 x)

instance Eq a => Eq (ViewL a) where
  EmptyL == EmptyL = True
  (x :< s) == (y :< t) = x == y && s == t
  _ == _ = False

instance Eq a => Eq (ViewR a) where
  EmptyR == EmptyR = True
  (s :> x) == (t :> y) = x == y && s == t
  _ == _ = False

instance Functor Seq where
  fmap f (Seq m) = Seq (fmap f m)

instance Foldable Seq where
  foldr f z (Seq m) = foldr f z (M.elems m)
  length (Seq m) = M.size m
  null (Seq m) = M.null m
  toList (Seq m) = M.elems m

instance Traversable Seq where
  traverse f s = fmap fromList (traverse f (toList s))

instance Semigroup (Seq a) where
  (<>) = (><)

instance Monoid (Seq a) where
  mempty = empty

instance Applicative Seq where
  pure = singleton
  fs <*> xs = fromList (toList fs <*> toList xs)

instance Monad Seq where
  xs >>= f = fromList (toList xs >>= (toList . f))

empty :: Seq a
empty = Seq M.empty

singleton :: a -> Seq a
singleton x = Seq (M.singleton 0 x)

fromList :: [a] -> Seq a
fromList xs = Seq (M.fromDistinctAscList (B.zip [0 ..] xs))

replicate :: Int -> a -> Seq a
replicate n x
  | n < 0 = error "replicate takes a nonnegative integer argument"
  | otherwise = fromList (B.replicate n x)

fromFunction :: Int -> (Int -> a) -> Seq a
fromFunction n f
  | n < 0 = error "Data.Sequence.fromFunction called with negative len"
  | otherwise = fromList (map f [0 .. n - 1])

(<|) :: a -> Seq a -> Seq a
x <| Seq m = Seq (case M.lookupMin m of
  Nothing -> M.singleton 0 x
  Just (k, _) -> M.insert (k - 1) x m)

(|>) :: Seq a -> a -> Seq a
Seq m |> x = Seq (case M.lookupMax m of
  Nothing -> M.singleton 0 x
  Just (k, _) -> M.insert (k + 1) x m)

-- Renumbers the smaller side, so that concatenations in any association take n log n in total.
(><) :: Seq a -> Seq a -> Seq a
Seq a >< Seq b = case (M.lookupMax a, M.lookupMin b) of
  (Just (hi, _), Just (lo, _))
    | M.size a < M.size b -> Seq (M.union (M.mapKeysMonotonic (\k -> k - hi + lo - 1) a) b)
    | otherwise -> Seq (M.union a (M.mapKeysMonotonic (\k -> k - lo + hi + 1) b))
  (Nothing, _) -> Seq b
  _ -> Seq a

length :: Seq a -> Int
length (Seq m) = M.size m

null :: Seq a -> Bool
null (Seq m) = M.null m

viewl :: Seq a -> ViewL a
viewl (Seq m) = case M.lookupMin m of
  Nothing -> EmptyL
  Just (k, x) -> x :< Seq (M.delete k m)

viewr :: Seq a -> ViewR a
viewr (Seq m) = case M.lookupMax m of
  Nothing -> EmptyR
  Just (k, x) -> Seq (M.delete k m) :> x

lookup :: Int -> Seq a -> Maybe a
lookup i (Seq m) = if i < 0 || i >= M.size m then Nothing else Just (snd (M.elemAt i m))

(!?) :: Seq a -> Int -> Maybe a
s !? i = lookup i s

index :: Seq a -> Int -> a
index s i = case lookup i s of
  Just x -> x
  Nothing -> error ("index out of bounds in call to: Data.Sequence.index " ++ show i)

adjust :: (a -> a) -> Int -> Seq a -> Seq a
adjust f i s@(Seq m) = if i < 0 || i >= M.size m then s else Seq (M.adjust f (fst (M.elemAt i m)) m)

adjust' :: (a -> a) -> Int -> Seq a -> Seq a
adjust' f i s@(Seq m) =
  if i < 0 || i >= M.size m then s else let (k, x) = M.elemAt i m; y = f x in y ${'`'}seq${'`'} Seq (M.insert k y m)

update :: Int -> a -> Seq a -> Seq a
update i x = adjust (const x) i

insertAt :: Int -> a -> Seq a -> Seq a
insertAt i x s
  | i <= 0 = x <| s
  | i >= length s = s |> x
  | otherwise = let (a, b) = splitAt i s in (a |> x) >< b

deleteAt :: Int -> Seq a -> Seq a
deleteAt i s@(Seq m) = if i < 0 || i >= M.size m then s else Seq (M.delete (fst (M.elemAt i m)) m)

take :: Int -> Seq a -> Seq a
take n (Seq m) = Seq (M.take n m)

drop :: Int -> Seq a -> Seq a
drop n (Seq m) = Seq (M.drop n m)

splitAt :: Int -> Seq a -> (Seq a, Seq a)
splitAt n s = (take n s, drop n s)

reverse :: Seq a -> Seq a
reverse s = fromList (B.reverse (toList s))

filter :: (a -> Bool) -> Seq a -> Seq a
filter p (Seq m) = Seq (M.filter p m)

partition :: (a -> Bool) -> Seq a -> (Seq a, Seq a)
partition p s = (filter p s, filter (not . p) s)

mapWithIndex :: (Int -> a -> b) -> Seq a -> Seq b
mapWithIndex f s = fromList (B.zipWith f [0 ..] (toList s))

foldlWithIndex :: (b -> Int -> a -> b) -> b -> Seq a -> b
foldlWithIndex f z s = foldl (\acc (i, x) -> f acc i x) z (B.zip [0 ..] (toList s))

foldrWithIndex :: (Int -> a -> b -> b) -> b -> Seq a -> b
foldrWithIndex f z s = foldr (\(i, x) acc -> f i x acc) z (B.zip [0 ..] (toList s))

zip :: Seq a -> Seq b -> Seq (a, b)
zip a b = fromList (B.zip (toList a) (toList b))

zipWith :: (a -> b -> c) -> Seq a -> Seq b -> Seq c
zipWith f a b = fromList (B.zipWith f (toList a) (toList b))

scanl :: (b -> a -> b) -> b -> Seq a -> Seq b
scanl f z s = fromList (B.scanl f z (toList s))

sort :: Ord a => Seq a -> Seq a
sort s = fromList (B.sort (toList s))

sortBy :: (a -> a -> Ordering) -> Seq a -> Seq a
sortBy f s = fromList (B.sortBy f (toList s))

sortOn :: Ord b => (a -> b) -> Seq a -> Seq a
sortOn f s = fromList (B.sortOn f (toList s))

unstableSort :: Ord a => Seq a -> Seq a
unstableSort = sort

elemIndexL :: Eq a => a -> Seq a -> Maybe Int
elemIndexL x s = B.elemIndex x (toList s)

findIndexL :: (a -> Bool) -> Seq a -> Maybe Int
findIndexL p s = B.findIndex p (toList s)

takeWhileL :: (a -> Bool) -> Seq a -> Seq a
takeWhileL p s = fromList (B.takeWhile p (toList s))

dropWhileL :: (a -> Bool) -> Seq a -> Seq a
dropWhileL p s = fromList (B.dropWhile p (toList s))

spanl :: (a -> Bool) -> Seq a -> (Seq a, Seq a)
spanl p s = let (a, b) = B.span p (toList s) in (fromList a, fromList b)

breakl :: (a -> Bool) -> Seq a -> (Seq a, Seq a)
breakl p = spanl (not . p)

intersperse :: a -> Seq a -> Seq a
intersperse x s = fromList (B.intersperse x (toList s))

chunksOf :: Int -> Seq a -> Seq (Seq a)
chunksOf n s
  | null s = empty
  | n <= 0 = error "chunksOf: A non-empty sequence can only be broken up into positively-sized chunks."
  | otherwise = take n s <| chunksOf n (drop n s)

tails :: Seq a -> Seq (Seq a)
tails s = fromList (map fromList (B.tails (toList s)))

inits :: Seq a -> Seq (Seq a)
inits s = fromList (map fromList (B.inits (toList s)))

iterateN :: Int -> (a -> a) -> a -> Seq a
iterateN n f x
  | n < 0 = error "iterateN takes a nonnegative integer argument"
  | otherwise = fromList (B.take n (B.iterate f x))

unfoldr :: (b -> Maybe (a, b)) -> b -> Seq a
unfoldr f b = fromList (B.unfoldr f b)

replicateA :: Applicative f => Int -> f a -> f (Seq a)
replicateA n x
  | n < 0 = error "replicateA takes a nonnegative integer argument"
  | otherwise = fmap fromList (sequenceA (B.replicate n x))

replicateM :: Applicative f => Int -> f a -> f (Seq a)
replicateM = replicateA
`;

export const SEQUENCE_VALUES = [
  'empty',
  'singleton',
  'fromList',
  'replicate',
  'fromFunction',
  '<|',
  '|>',
  '><',
  'length',
  'null',
  'viewl',
  'viewr',
  'lookup',
  '!?',
  'index',
  'adjust',
  "adjust'",
  'update',
  'insertAt',
  'deleteAt',
  'take',
  'drop',
  'splitAt',
  'reverse',
  'filter',
  'partition',
  'mapWithIndex',
  'foldlWithIndex',
  'foldrWithIndex',
  'zip',
  'zipWith',
  'scanl',
  'sort',
  'sortBy',
  'sortOn',
  'unstableSort',
  'elemIndexL',
  'findIndexL',
  'takeWhileL',
  'dropWhileL',
  'spanl',
  'breakl',
  'intersperse',
  'chunksOf',
  'tails',
  'inits',
  'iterateN',
  'unfoldr',
  'replicateA',
  'replicateM',
];
