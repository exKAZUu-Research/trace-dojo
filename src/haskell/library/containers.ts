import { BT } from './source';

/** `Data.Set` as a size-balanced binary tree, as the `containers` package implements it. */
export const SET_SOURCE = String.raw`module Data.Set.Internal where

import Base hiding (map, filter, foldr, foldl, foldr', foldl', null, toList, elem, insert, delete, partition, take, drop, splitAt, lookupMin, (\\))
import qualified Base as B

infixl 9 \\

data Set a = SBin !Int !a !(Set a) !(Set a) | STip

empty :: Set a
empty = STip

singleton :: a -> Set a
singleton x = SBin 1 x STip STip

size :: Set a -> Int
size STip = 0
size (SBin sz _ _ _) = sz

null :: Set a -> Bool
null STip = True
null _ = False

member :: Ord a => a -> Set a -> Bool
member x STip = x ${BT}seq${BT} False
member x (SBin _ y l r) = case compare x y of
  LT -> member x l
  GT -> member x r
  EQ -> True

notMember :: Ord a => a -> Set a -> Bool
notMember x s = not (member x s)

insert :: Ord a => a -> Set a -> Set a
insert x STip = singleton x
insert x t@(SBin sz y l r) = case compare x y of
  LT -> balance y (insert x l) r
  GT -> balance y l (insert x r)
  EQ -> SBin sz x l r

delete :: Ord a => a -> Set a -> Set a
delete x STip = x ${BT}seq${BT} STip
delete x (SBin _ y l r) = case compare x y of
  LT -> balance y (delete x l) r
  GT -> balance y l (delete x r)
  EQ -> glue l r

bin :: a -> Set a -> Set a -> Set a
bin x l r = SBin (size l + size r + 1) x l r

balance :: a -> Set a -> Set a -> Set a
balance x l r =
  let sl = size l
      sr = size r
  in if sl + sr <= 1 then SBin (sl + sr + 1) x l r
     else if sr > 3 * sl then rotateL x l r
     else if sl > 3 * sr then rotateR x l r
     else SBin (sl + sr + 1) x l r

rotateL :: a -> Set a -> Set a -> Set a
rotateL x l r@(SBin _ _ ly ry) = if size ly < 2 * size ry then singleL x l r else doubleL x l r

rotateR :: a -> Set a -> Set a -> Set a
rotateR x l@(SBin _ _ ly ry) r = if size ry < 2 * size ly then singleR x l r else doubleR x l r

singleL :: a -> Set a -> Set a -> Set a
singleL x1 t1 (SBin _ x2 t2 t3) = bin x2 (bin x1 t1 t2) t3

singleR :: a -> Set a -> Set a -> Set a
singleR x1 (SBin _ x2 t1 t2) t3 = bin x2 t1 (bin x1 t2 t3)

doubleL :: a -> Set a -> Set a -> Set a
doubleL x1 t1 (SBin _ x2 (SBin _ x3 t2 t3) t4) = bin x3 (bin x1 t1 t2) (bin x2 t3 t4)

doubleR :: a -> Set a -> Set a -> Set a
doubleR x1 (SBin _ x2 t1 (SBin _ x3 t2 t3)) t4 = bin x3 (bin x2 t1 t2) (bin x1 t3 t4)

glue :: Set a -> Set a -> Set a
glue STip r = r
glue l STip = l
glue l r = if size l > size r
  then (case deleteFindMax l of (m, l') -> balance m l' r)
  else (case deleteFindMin r of (m, r') -> balance m l r')

deleteFindMin :: Set a -> (a, Set a)
deleteFindMin (SBin _ x STip r) = (x, r)
deleteFindMin (SBin _ x l r) = case deleteFindMin l of (m, l') -> (m, balance x l' r)
deleteFindMin STip = (errorWithoutStackTrace "Set.deleteFindMin: can not return the minimal element of an empty set", STip)

deleteFindMax :: Set a -> (a, Set a)
deleteFindMax (SBin _ x l STip) = (x, l)
deleteFindMax (SBin _ x l r) = case deleteFindMax r of (m, r') -> (m, balance x l r')
deleteFindMax STip = (errorWithoutStackTrace "Set.deleteFindMax: can not return the maximal element of an empty set", STip)

fromList :: Ord a => [a] -> Set a
fromList = B.foldl (\t x -> insert x t) STip

fromAscList :: Eq a => [a] -> Set a
fromAscList xs = fromDistinctAscList (B.map B.last (group xs))

fromDistinctAscList :: [a] -> Set a
fromDistinctAscList xs = B.foldr seq () xs ${BT}seq${BT} fst (build (length xs) xs)
  where build n ys = if n == 0 then (STip, ys)
                     else let nl = (n - 1) ${BT}div${BT} 2
                              (l, rest) = build nl ys
                          in case rest of
                               (y:rest') -> let (r, rest'') = build (n - 1 - nl) rest' in (bin y l r, rest'')
                               [] -> (l, [])

toList :: Set a -> [a]
toList = toAscList

toAscList :: Set a -> [a]
toAscList = foldr (:) []

toDescList :: Set a -> [a]
toDescList = foldl (flip (:)) []

elems :: Set a -> [a]
elems = toAscList

foldr :: (a -> b -> b) -> b -> Set a -> b
foldr _ z STip = z
foldr f z (SBin _ x l r) = foldr f (f x (foldr f z r)) l

foldl :: (b -> a -> b) -> b -> Set a -> b
foldl _ z STip = z
foldl f z (SBin _ x l r) = foldl f (f (foldl f z l) x) r

foldr' :: (a -> b -> b) -> b -> Set a -> b
foldr' f z s = z ${BT}seq${BT} case s of
  STip -> z
  SBin _ x l r -> foldr' f (f x $! foldr' f z r) l

foldl' :: (b -> a -> b) -> b -> Set a -> b
foldl' f z s = B.foldl' f z (toAscList s)

union :: Ord a => Set a -> Set a -> Set a
union a b = b ${BT}seq${BT} a ${BT}seq${BT} fromDistinctAscList (mergeUnion (toAscList a) (toAscList b))
  where mergeUnion [] ys = ys
        mergeUnion xs [] = xs
        mergeUnion xs@(x:xt) ys@(y:yt) = case compare x y of
          LT -> x : mergeUnion xt ys
          GT -> y : mergeUnion xs yt
          EQ -> x : mergeUnion xt yt

unions :: (Foldable f, Ord a) => f (Set a) -> Set a
unions = B.foldl union empty

intersection :: Ord a => Set a -> Set a -> Set a
intersection a b = fromDistinctAscList (go (toAscList a) (toAscList b))
  where go [] _ = []
        go _ [] = []
        go xs@(x:xt) ys@(y:yt) = case compare x y of
          LT -> go xt ys
          GT -> go xs yt
          EQ -> x : go xt yt

difference :: Ord a => Set a -> Set a -> Set a
difference a b = fromDistinctAscList (go (toAscList a) (toAscList b))
  where go [] _ = []
        go xs [] = xs
        go xs@(x:xt) ys@(y:yt) = case compare x y of
          LT -> x : go xt ys
          GT -> go xs yt
          EQ -> go xt yt

(\\) :: Ord a => Set a -> Set a -> Set a
m1 \\ m2 = difference m1 m2

isSubsetOf :: Ord a => Set a -> Set a -> Bool
isSubsetOf a b = size a <= size b && all (\x -> member x b) (toAscList a)

isProperSubsetOf :: Ord a => Set a -> Set a -> Bool
isProperSubsetOf a b = size a < size b && isSubsetOf a b

disjoint :: Ord a => Set a -> Set a -> Bool
disjoint a b = null (intersection a b)

map :: Ord b => (a -> b) -> Set a -> Set b
map f s = fromList (B.map f (toAscList s))

filter :: (a -> Bool) -> Set a -> Set a
filter p s = fromDistinctAscList (B.filter p (toAscList s))

partition :: (a -> Bool) -> Set a -> (Set a, Set a)
partition p s = (filter p s, filter (not . p) s)

lookupMin :: Set a -> Maybe a
lookupMin STip = Nothing
lookupMin (SBin _ x STip _) = Just x
lookupMin (SBin _ _ l _) = lookupMin l

lookupMax :: Set a -> Maybe a
lookupMax STip = Nothing
lookupMax (SBin _ x _ STip) = Just x
lookupMax (SBin _ _ _ r) = lookupMax r

findMin :: Set a -> a
findMin s = case lookupMin s of
  Just x -> x
  Nothing -> errorWithoutStackTrace "Set.findMin: empty set has no minimal element"

findMax :: Set a -> a
findMax s = case lookupMax s of
  Just x -> x
  Nothing -> errorWithoutStackTrace "Set.findMax: empty set has no maximal element"

deleteMin :: Set a -> Set a
deleteMin STip = STip
deleteMin s = snd (deleteFindMin s)

deleteMax :: Set a -> Set a
deleteMax STip = STip
deleteMax s = snd (deleteFindMax s)

minView :: Set a -> Maybe (a, Set a)
minView STip = Nothing
minView s = Just (deleteFindMin s)

maxView :: Set a -> Maybe (a, Set a)
maxView STip = Nothing
maxView s = Just (deleteFindMax s)

elemAt :: Int -> Set a -> a
elemAt i s = if i < 0 || i >= size s then errorWithoutStackTrace "Set.elemAt: index out of range" else at i s
  where at n (SBin _ x l r) = case compare n (size l) of
          LT -> at n l
          EQ -> x
          GT -> at (n - size l - 1) r

findIndex :: Ord a => a -> Set a -> Int
findIndex x s = case lookupIndex x s of
  Just i -> i
  Nothing -> errorWithoutStackTrace "Set.findIndex: element is not in the set"

lookupIndex :: Ord a => a -> Set a -> Maybe Int
lookupIndex x tree = x ${BT}seq${BT} go 0 tree
  where go _ STip = Nothing
        go offset (SBin _ y l r) = case compare x y of
          LT -> go offset l
          EQ -> Just (offset + size l)
          GT -> go (offset + size l + 1) r

take :: Int -> Set a -> Set a
take n s = fromDistinctAscList (B.take n (toAscList s))

drop :: Int -> Set a -> Set a
drop n s = fromDistinctAscList (B.drop n (toAscList s))

splitAt :: Int -> Set a -> (Set a, Set a)
splitAt n s = (take n s, drop n s)

split :: Ord a => a -> Set a -> (Set a, Set a)
split x s = (filter (< x) s, filter (> x) s)

splitMember :: Ord a => a -> Set a -> (Set a, Bool, Set a)
splitMember x s = (filter (< x) s, member x s, filter (> x) s)

lookupLT :: Ord a => a -> Set a -> Maybe a
lookupLT x tree = x ${BT}seq${BT} (nearest (\y -> y < x) False) tree

lookupGT :: Ord a => a -> Set a -> Maybe a
lookupGT x tree = x ${BT}seq${BT} (nearest (\y -> y > x) True) tree

lookupLE :: Ord a => a -> Set a -> Maybe a
lookupLE x tree = x ${BT}seq${BT} (nearest (\y -> y <= x) False) tree

lookupGE :: Ord a => a -> Set a -> Maybe a
lookupGE x tree = x ${BT}seq${BT} (nearest (\y -> y >= x) True) tree

instance Eq a => Eq (Set a) where
  a == b = size a == size b && toAscList a == toAscList b

instance Ord a => Ord (Set a) where
  compare a b = compare (toAscList a) (toAscList b)

instance (Read a, Ord a) => Read (Set a) where
  readsPrec d = readParen (d > 10) (\r -> [(fromList xs, t) | ("fromList", s) <- lex r, (xs, t) <- reads s])

instance Show a => Show (Set a) where
  showsPrec p xs = showParen (p > 10) (showString "fromList " . shows (toAscList xs))

instance Ord a => Semigroup (Set a) where
  (<>) = union

instance Ord a => Monoid (Set a) where
  mempty = empty

instance Foldable Set where
  foldr = foldr
  foldl = foldl
  toList = toAscList
  null = null
  length = size
  elem x s = B.elem x (toAscList s)
  minimum = findMin
  maximum = findMax
  sum s = B.sum (toAscList s)
  product s = B.product (toAscList s)

nearest :: (a -> Bool) -> Bool -> Set a -> Maybe a
nearest _ _ STip = Nothing
nearest matches lower (SBin _ x l r) =
  let preferred = if lower then l else r
      other = if lower then r else l
  in if matches x then case nearest matches lower preferred of
       Just found -> Just found
       Nothing -> Just x
     else nearest matches lower other

powerSet :: Set a -> Set (Set a)
powerSet s = fromDistinctAscList (B.map fromDistinctAscList (subsets (toAscList s)))
  where subsets [] = [[]]
        subsets (x:xs) = let rest = subsets xs in [] : (B.map (x:) rest ++ B.tail rest)

cartesianProduct :: Set a -> Set b -> Set (a,b)
cartesianProduct a b = fromDistinctAscList [(x,y) | x <- toAscList a, y <- toAscList b]

mapMonotonic :: (a -> b) -> Set a -> Set b
mapMonotonic f s = fromDistinctAscList (B.map f (toAscList s))

symmetricDifference :: Ord a => Set a -> Set a -> Set a
symmetricDifference a b = union (difference a b) (difference b a)

fold :: (a -> b -> b) -> b -> Set a -> b
fold = foldr

fromDescList :: Eq a => [a] -> Set a
fromDescList xs = fromDistinctAscList (reverse (B.map B.last (group xs)))

fromDistinctDescList :: [a] -> Set a
fromDistinctDescList = fromDistinctAscList . reverse

`;

/** `Data.Map` as a size-balanced binary tree, as the `containers` package implements it. */
export const MAP_SOURCE = String.raw`module Data.Map.Internal where

import Base hiding (map, filter, foldr, foldl, foldr', foldl', null, toList, lookup, elem, insert, delete, partition, take, drop, splitAt, mapMaybe, (!?), (\\))
import qualified Base as B
import qualified Data.Set.Internal as S

infixl 9 !, !?, \\

data Map k a = Bin !Int !k a !(Map k a) !(Map k a) | Tip

empty :: Map k a
empty = Tip

singleton :: k -> a -> Map k a
singleton k x = Bin 1 k x Tip Tip

size :: Map k a -> Int
size Tip = 0
size (Bin sz _ _ _ _) = sz

null :: Map k a -> Bool
null Tip = True
null _ = False

lookup :: Ord k => k -> Map k a -> Maybe a
lookup k Tip = k ${BT}seq${BT} Nothing
lookup k (Bin _ kx x l r) = case compare k kx of
  LT -> lookup k l
  GT -> lookup k r
  EQ -> Just x

member :: Ord k => k -> Map k a -> Bool
member k m = case lookup k m of
  Nothing -> False
  Just _ -> True

notMember :: Ord k => k -> Map k a -> Bool
notMember k m = not (member k m)

findWithDefault :: Ord k => a -> k -> Map k a -> a
findWithDefault def k m = case lookup k m of
  Nothing -> def
  Just x -> x

(!) :: Ord k => Map k a -> k -> a
m ! k = case lookup k m of
  Nothing -> error "Map.!: given key is not an element in the map"
  Just x -> x

(!?) :: Ord k => Map k a -> k -> Maybe a
m !? k = lookup k m

insert :: Ord k => k -> a -> Map k a -> Map k a
insert kx x Tip = singleton kx x
insert kx x (Bin sz ky y l r) = case compare kx ky of
  LT -> balance ky y (insert kx x l) r
  GT -> balance ky y l (insert kx x r)
  EQ -> Bin sz kx x l r

insertWith :: Ord k => (a -> a -> a) -> k -> a -> Map k a -> Map k a
insertWith _ kx x Tip = singleton kx x
insertWith f kx x (Bin sy ky y l r) = case compare kx ky of
  LT -> balance ky y (insertWith f kx x l) r
  GT -> balance ky y l (insertWith f kx x r)
  EQ -> Bin sy kx (f x y) l r

insertWithKey :: Ord k => (k -> a -> a -> a) -> k -> a -> Map k a -> Map k a
insertWithKey f kx x m = insertWith (f kx) kx x m

delete :: Ord k => k -> Map k a -> Map k a
delete k Tip = k ${BT}seq${BT} Tip
delete k (Bin _ kx x l r) = case compare k kx of
  LT -> balance kx x (delete k l) r
  GT -> balance kx x l (delete k r)
  EQ -> glue l r

adjust :: Ord k => (a -> a) -> k -> Map k a -> Map k a
adjust f = adjustWithKey (\_ x -> f x)

adjustWithKey :: Ord k => (k -> a -> a) -> k -> Map k a -> Map k a
adjustWithKey _ k Tip = k ${BT}seq${BT} Tip
adjustWithKey f k (Bin sx kx x l r) = case compare k kx of
  LT -> Bin sx kx x (adjustWithKey f k l) r
  GT -> Bin sx kx x l (adjustWithKey f k r)
  EQ -> Bin sx kx (f kx x) l r

update :: Ord k => (a -> Maybe a) -> k -> Map k a -> Map k a
update f k m = case lookup k m of
  Nothing -> m
  Just x -> case f x of
    Nothing -> delete k m
    Just x' -> insert k x' m

alter :: Ord k => (Maybe a -> Maybe a) -> k -> Map k a -> Map k a
alter f k m = case f (lookup k m) of
  Nothing -> delete k m
  Just x -> insert k x m

bin :: k -> a -> Map k a -> Map k a -> Map k a
bin k x l r = Bin (size l + size r + 1) k x l r

balance :: k -> a -> Map k a -> Map k a -> Map k a
balance k x l r =
  let sl = size l
      sr = size r
  in if sl + sr <= 1 then Bin (sl + sr + 1) k x l r
     else if sr > 3 * sl then rotateL k x l r
     else if sl > 3 * sr then rotateR k x l r
     else Bin (sl + sr + 1) k x l r

rotateL :: k -> a -> Map k a -> Map k a -> Map k a
rotateL k x l r@(Bin _ _ _ ly ry) = if size ly < 2 * size ry then singleL k x l r else doubleL k x l r

rotateR :: k -> a -> Map k a -> Map k a -> Map k a
rotateR k x l@(Bin _ _ _ ly ry) r = if size ry < 2 * size ly then singleR k x l r else doubleR k x l r

singleL :: k -> a -> Map k a -> Map k a -> Map k a
singleL k1 x1 t1 (Bin _ k2 x2 t2 t3) = bin k2 x2 (bin k1 x1 t1 t2) t3

singleR :: k -> a -> Map k a -> Map k a -> Map k a
singleR k1 x1 (Bin _ k2 x2 t1 t2) t3 = bin k2 x2 t1 (bin k1 x1 t2 t3)

doubleL :: k -> a -> Map k a -> Map k a -> Map k a
doubleL k1 x1 t1 (Bin _ k2 x2 (Bin _ k3 x3 t2 t3) t4) = bin k3 x3 (bin k1 x1 t1 t2) (bin k2 x2 t3 t4)

doubleR :: k -> a -> Map k a -> Map k a -> Map k a
doubleR k1 x1 (Bin _ k2 x2 t1 (Bin _ k3 x3 t2 t3)) t4 = bin k3 x3 (bin k2 x2 t1 t2) (bin k1 x1 t3 t4)

glue :: Map k a -> Map k a -> Map k a
glue Tip r = r
glue l Tip = l
glue l r = if size l > size r
  then (case deleteFindMax l of ((km, m), l') -> balance km m l' r)
  else (case deleteFindMin r of ((km, m), r') -> balance km m l r')

deleteFindMin :: Map k a -> ((k, a), Map k a)
deleteFindMin (Bin _ k x Tip r) = ((k, x), r)
deleteFindMin (Bin _ k x l r) = case deleteFindMin l of (km, l') -> (km, balance k x l' r)
deleteFindMin Tip = (errorWithoutStackTrace "Map.deleteFindMin: can not return the minimal element of an empty map", Tip)

deleteFindMax :: Map k a -> ((k, a), Map k a)
deleteFindMax (Bin _ k x l Tip) = ((k, x), l)
deleteFindMax (Bin _ k x l r) = case deleteFindMax r of (km, r') -> (km, balance k x l r')
deleteFindMax Tip = (errorWithoutStackTrace "Map.deleteFindMax: can not return the maximal element of an empty map", Tip)

fromList :: Ord k => [(k, a)] -> Map k a
fromList = B.foldl (\t (k, x) -> insert k x t) Tip

fromListWith :: Ord k => (a -> a -> a) -> [(k, a)] -> Map k a
fromListWith f = B.foldl (\t (k, x) -> insertWith f k x t) Tip

fromListWithKey :: Ord k => (k -> a -> a -> a) -> [(k, a)] -> Map k a
fromListWithKey f = B.foldl (\t (k, x) -> insertWith (f k) k x t) Tip

fromAscList :: Eq k => [(k, a)] -> Map k a
fromAscList xs = fromDistinctAscList (combine xs)
  where combine ((k1, x1) : rest@((k2, _) : _)) = if k1 == k2 then combine rest else (k1, x1) : combine rest
        combine ys = ys

fromDistinctAscList :: [(k, a)] -> Map k a
fromDistinctAscList xs = B.foldr (\(k, _) rest -> k ${BT}seq${BT} rest) () xs ${BT}seq${BT} fst (build (length xs) xs)
  where build n ys = if n == 0 then (Tip, ys)
                     else let nl = (n - 1) ${BT}div${BT} 2
                              (l, rest) = build nl ys
                          in case rest of
                               ((k, x) : rest') -> let (r, rest'') = build (n - 1 - nl) rest' in (bin k x l r, rest'')
                               [] -> (l, [])

toList :: Map k a -> [(k, a)]
toList = toAscList

toAscList :: Map k a -> [(k, a)]
toAscList = foldrWithKey (\k x xs -> (k, x) : xs) []

toDescList :: Map k a -> [(k, a)]
toDescList = foldlWithKey (\xs k x -> (k, x) : xs) []

assocs :: Map k a -> [(k, a)]
assocs = toAscList

keys :: Map k a -> [k]
keys = foldrWithKey (\k _ ks -> k : ks) []

elems :: Map k a -> [a]
elems = foldr (:) []

keysSet :: Map k a -> S.Set k
keysSet m = S.fromDistinctAscList (keys m)

fromSet :: (k -> a) -> S.Set k -> Map k a
fromSet f s = fromDistinctAscList [(k, f k) | k <- S.toAscList s]

foldr :: (a -> b -> b) -> b -> Map k a -> b
foldr _ z Tip = z
foldr f z (Bin _ _ x l r) = foldr f (f x (foldr f z r)) l

foldl :: (b -> a -> b) -> b -> Map k a -> b
foldl _ z Tip = z
foldl f z (Bin _ _ x l r) = foldl f (f (foldl f z l) x) r

foldr' :: (a -> b -> b) -> b -> Map k a -> b
foldr' f z m = z ${BT}seq${BT} case m of
  Tip -> z
  Bin _ _ x l r -> foldr' f (f x $! foldr' f z r) l

foldl' :: (b -> a -> b) -> b -> Map k a -> b
foldl' f z m = B.foldl' f z (elems m)

foldrWithKey :: (k -> a -> b -> b) -> b -> Map k a -> b
foldrWithKey _ z Tip = z
foldrWithKey f z (Bin _ kx x l r) = foldrWithKey f (f kx x (foldrWithKey f z r)) l

foldlWithKey :: (a -> k -> b -> a) -> a -> Map k b -> a
foldlWithKey _ z Tip = z
foldlWithKey f z (Bin _ kx x l r) = foldlWithKey f (f (foldlWithKey f z l) kx x) r

foldrWithKey' :: (k -> a -> b -> b) -> b -> Map k a -> b
foldrWithKey' f z m = z ${BT}seq${BT} case m of
  Tip -> z
  Bin _ k x l r -> foldrWithKey' f (f k x $! foldrWithKey' f z r) l

foldlWithKey' :: (a -> k -> b -> a) -> a -> Map k b -> a
foldlWithKey' f z m = B.foldl' (\acc (k, x) -> f acc k x) z (toAscList m)

foldMapWithKey :: Monoid m => (k -> a -> m) -> Map k a -> m
foldMapWithKey f = foldrWithKey (\k x acc -> f k x <> acc) mempty

map :: (a -> b) -> Map k a -> Map k b
map _ Tip = Tip
map f (Bin sx kx x l r) = Bin sx kx (f x) (map f l) (map f r)

mapWithKey :: (k -> a -> b) -> Map k a -> Map k b
mapWithKey _ Tip = Tip
mapWithKey f (Bin sx kx x l r) = Bin sx kx (f kx x) (mapWithKey f l) (mapWithKey f r)

traverseWithKey :: Applicative t => (k -> a -> t b) -> Map k a -> t (Map k b)
traverseWithKey _ Tip = pure Tip
traverseWithKey f (Bin s k v l r) = liftA3 (\l' v' r' -> Bin s k v' l' r') (traverseWithKey f l) (f k v) (traverseWithKey f r)

mapKeys :: Ord k2 => (k1 -> k2) -> Map k1 a -> Map k2 a
mapKeys f m = fromList [(f k, x) | (k, x) <- toAscList m]

mapKeysWith :: Ord k2 => (a -> a -> a) -> (k1 -> k2) -> Map k1 a -> Map k2 a
mapKeysWith c f m = fromListWith c [(f k, x) | (k, x) <- toAscList m]

filter :: (a -> Bool) -> Map k a -> Map k a
filter p = filterWithKey (\_ x -> p x)

filterWithKey :: (k -> a -> Bool) -> Map k a -> Map k a
filterWithKey p m = fromDistinctAscList [(k, x) | (k, x) <- toAscList m, p k x]

partition :: (a -> Bool) -> Map k a -> (Map k a, Map k a)
partition p m = (filter p m, filter (not . p) m)

partitionWithKey :: (k -> a -> Bool) -> Map k a -> (Map k a, Map k a)
partitionWithKey p m = (filterWithKey p m, filterWithKey (\k x -> not (p k x)) m)

mapMaybe :: (a -> Maybe b) -> Map k a -> Map k b
mapMaybe f = mapMaybeWithKey (\_ x -> f x)

mapMaybeWithKey :: (k -> a -> Maybe b) -> Map k a -> Map k b
mapMaybeWithKey f m = fromDistinctAscList [(k, y) | (k, x) <- toAscList m, Just y <- [f k x]]

union :: Ord k => Map k a -> Map k a -> Map k a
union = unionWith const

unionWith :: Ord k => (a -> a -> a) -> Map k a -> Map k a -> Map k a
unionWith f = unionWithKey (\_ x y -> f x y)

unionWithKey :: Ord k => (k -> a -> a -> a) -> Map k a -> Map k a -> Map k a
unionWithKey f a b = b ${BT}seq${BT} a ${BT}seq${BT} fromDistinctAscList (go (toAscList a) (toAscList b))
  where go [] ys = ys
        go xs [] = xs
        go xs@((kx, x) : xt) ys@((ky, y) : yt) = case compare kx ky of
          LT -> (kx, x) : go xt ys
          GT -> (ky, y) : go xs yt
          EQ -> (kx, f kx x y) : go xt yt

unions :: (Foldable f, Ord k) => f (Map k a) -> Map k a
unions = B.foldl union Tip

unionsWith :: (Foldable f, Ord k) => (a -> a -> a) -> f (Map k a) -> Map k a
unionsWith f = B.foldl (unionWith f) Tip

intersection :: Ord k => Map k a -> Map k b -> Map k a
intersection = intersectionWith const

intersectionWith :: Ord k => (a -> b -> c) -> Map k a -> Map k b -> Map k c
intersectionWith f = intersectionWithKey (\_ x y -> f x y)

intersectionWithKey :: Ord k => (k -> a -> b -> c) -> Map k a -> Map k b -> Map k c
intersectionWithKey f a b = fromDistinctAscList (go (toAscList a) (toAscList b))
  where go [] _ = []
        go _ [] = []
        go xs@((kx, x) : xt) ys@((ky, y) : yt) = case compare kx ky of
          LT -> go xt ys
          GT -> go xs yt
          EQ -> (kx, f kx x y) : go xt yt

difference :: Ord k => Map k a -> Map k b -> Map k a
difference a b = fromDistinctAscList [(k, x) | (k, x) <- toAscList a, notMember k b]

differenceWith :: Ord k => (a -> b -> Maybe a) -> Map k a -> Map k b -> Map k a
differenceWith f a b = fromDistinctAscList [(k, z) | (k, x) <- toAscList a, Just z <- [case lookup k b of
                                                                                        Nothing -> Just x
                                                                                        Just y -> f x y]]

(\\) :: Ord k => Map k a -> Map k b -> Map k a
m1 \\ m2 = difference m1 m2

restrictKeys :: Ord k => Map k a -> S.Set k -> Map k a
restrictKeys m s = filterWithKey (\k _ -> S.member k s) m

withoutKeys :: Ord k => Map k a -> S.Set k -> Map k a
withoutKeys m s = filterWithKey (\k _ -> S.notMember k s) m

isSubmapOf :: (Ord k, Eq a) => Map k a -> Map k a -> Bool
isSubmapOf a b = all (\(k, x) -> lookup k b == Just x) (toAscList a)

lookupMin :: Map k a -> Maybe (k, a)
lookupMin Tip = Nothing
lookupMin (Bin _ k x Tip _) = Just (k, x)
lookupMin (Bin _ _ _ l _) = lookupMin l

lookupMax :: Map k a -> Maybe (k, a)
lookupMax Tip = Nothing
lookupMax (Bin _ k x _ Tip) = Just (k, x)
lookupMax (Bin _ _ _ _ r) = lookupMax r

findMin :: Map k a -> (k, a)
findMin m = case lookupMin m of
  Just r -> r
  Nothing -> errorWithoutStackTrace "Map.findMin: empty map has no minimal element"

findMax :: Map k a -> (k, a)
findMax m = case lookupMax m of
  Just r -> r
  Nothing -> errorWithoutStackTrace "Map.findMax: empty map has no maximal element"

deleteMin :: Map k a -> Map k a
deleteMin Tip = Tip
deleteMin m = snd (deleteFindMin m)

deleteMax :: Map k a -> Map k a
deleteMax Tip = Tip
deleteMax m = snd (deleteFindMax m)

minViewWithKey :: Map k a -> Maybe ((k, a), Map k a)
minViewWithKey Tip = Nothing
minViewWithKey m = Just (deleteFindMin m)

maxViewWithKey :: Map k a -> Maybe ((k, a), Map k a)
maxViewWithKey Tip = Nothing
maxViewWithKey m = Just (deleteFindMax m)

minView :: Map k a -> Maybe (a, Map k a)
minView m = fmap (\((_, x), m') -> (x, m')) (minViewWithKey m)

maxView :: Map k a -> Maybe (a, Map k a)
maxView m = fmap (\((_, x), m') -> (x, m')) (maxViewWithKey m)

elemAt :: Int -> Map k a -> (k, a)
elemAt i m = if i < 0 || i >= size m then errorWithoutStackTrace "Map.elemAt: index out of range" else at i m
  where at n (Bin _ k x l r) = case compare n (size l) of
          LT -> at n l
          EQ -> (k,x)
          GT -> at (n - size l - 1) r

lookupIndex :: Ord k => k -> Map k a -> Maybe Int
lookupIndex k tree = k ${BT}seq${BT} go 0 tree
  where go _ Tip = Nothing
        go offset (Bin _ key _ l r) = case compare k key of
          LT -> go offset l
          EQ -> Just (offset + size l)
          GT -> go (offset + size l + 1) r

findIndex :: Ord k => k -> Map k a -> Int
findIndex k m = case lookupIndex k m of
  Just i -> i
  Nothing -> errorWithoutStackTrace "Map.findIndex: element is not in the map"

take :: Int -> Map k a -> Map k a
take n m = fromDistinctAscList (B.take n (toAscList m))

drop :: Int -> Map k a -> Map k a
drop n m = fromDistinctAscList (B.drop n (toAscList m))

splitAt :: Int -> Map k a -> (Map k a, Map k a)
splitAt n m = (take n m, drop n m)

lookupLT :: Ord k => k -> Map k v -> Maybe (k, v)
lookupLT k tree = k ${BT}seq${BT} (nearest (\key -> key < k) False) tree

lookupGT :: Ord k => k -> Map k v -> Maybe (k, v)
lookupGT k tree = k ${BT}seq${BT} (nearest (\key -> key > k) True) tree

lookupLE :: Ord k => k -> Map k v -> Maybe (k, v)
lookupLE k tree = k ${BT}seq${BT} (nearest (\key -> key <= k) False) tree

lookupGE :: Ord k => k -> Map k v -> Maybe (k, v)
lookupGE k tree = k ${BT}seq${BT} (nearest (\key -> key >= k) True) tree

split :: Ord k => k -> Map k a -> (Map k a, Map k a)
split k m = (filterWithKey (\k' _ -> k' < k) m, filterWithKey (\k' _ -> k' > k) m)

instance (Eq k, Eq a) => Eq (Map k a) where
  t1 == t2 = size t1 == size t2 && toAscList t1 == toAscList t2

instance (Ord k, Ord v) => Ord (Map k v) where
  compare m1 m2 = compare (toAscList m1) (toAscList m2)

instance (Ord k, Read k, Read e) => Read (Map k e) where
  readsPrec d = readParen (d > 10) (\r -> [(fromList xs, t) | ("fromList", s) <- lex r, (xs, t) <- reads s])

instance (Show k, Show a) => Show (Map k a) where
  showsPrec d m = showParen (d > 10) (showString "fromList " . shows (toList m))

instance Functor (Map k) where
  fmap = map

instance Foldable (Map k) where
  foldr = foldr
  foldl = foldl
  toList = elems
  null = null
  length = size
  elem x m = B.elem x (elems m)
  sum m = B.sum (elems m)
  product m = B.product (elems m)

instance Traversable (Map k) where
  traverse f = traverseWithKey (\_ -> f)

instance Ord k => Semigroup (Map k v) where
  (<>) = union

instance Ord k => Monoid (Map k v) where
  mempty = Tip

nearest :: (k -> Bool) -> Bool -> Map k a -> Maybe (k,a)
nearest _ _ Tip = Nothing
nearest matches lower (Bin _ k x l r) =
  let preferred = if lower then l else r
      other = if lower then r else l
  in if matches k then case nearest matches lower preferred of
       Just found -> Just found
       Nothing -> Just (k,x)
     else nearest matches lower other

mapAccum :: (a -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccum f = mapAccumWithKey (\a _ x -> f a x)

mapAccumWithKey :: (a -> k -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccumWithKey f a m = let (b, xs) = B.mapAccumL (\acc (k,x) -> let (next,y) = f acc k x in (next,(k,y))) a (toAscList m)
                      in (b,fromDistinctAscList xs)

mapAccumRWithKey :: (a -> k -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccumRWithKey f a m = let (b, xs) = B.mapAccumR (\acc (k,x) -> let (next,y) = f acc k x in (next,(k,y))) a (toAscList m)
                       in (b,fromDistinctAscList xs)

splitLookup :: Ord k => k -> Map k a -> (Map k a,Maybe a,Map k a)
splitLookup k m = k ${BT}seq${BT} case m of
  Tip -> (Tip,Nothing,Tip)
  Bin _ key x l r -> case compare k key of
    EQ -> (l,Just x,r)
    LT -> case splitLookup k l of
      (lt,found,gt) -> let right = link key x gt r in right ${BT}seq${BT} (lt,found,right)
    GT -> case splitLookup k r of
      (lt,found,gt) -> let left = link key x l lt in left ${BT}seq${BT} (left,found,gt)

link :: k -> a -> Map k a -> Map k a -> Map k a
link k x Tip r = insertMin k x r
link k x l Tip = insertMax k x l
link k x l@(Bin sl kl xl ll lr) r@(Bin sr kr xr rl rr) =
  if 3 * sl < sr then balance kr xr (link k x l rl) rr
  else if 3 * sr < sl then balance kl xl ll (link k x lr r)
  else bin k x l r

insertMin :: k -> a -> Map k a -> Map k a
insertMin k x Tip = singleton k x
insertMin k x (Bin _ key y l r) = balance key y (insertMin k x l) r

insertMax :: k -> a -> Map k a -> Map k a
insertMax k x Tip = singleton k x
insertMax k x (Bin _ key y l r) = balance key y l (insertMax k x r)

link2 :: Map k a -> Map k a -> Map k a
link2 Tip r = r
link2 l Tip = l
link2 l@(Bin sl kl xl ll lr) r@(Bin sr kr xr rl rr) =
  if 3 * sl < sr then balance kr xr (link2 l rl) rr
  else if 3 * sr < sl then balance kl xl ll (link2 lr r)
  else glue l r

updateWithKey :: Ord k => (k -> a -> Maybe a) -> k -> Map k a -> Map k a
updateWithKey f k = update (f k) k

insertLookupWithKey :: Ord k => (k -> a -> a -> a) -> k -> a -> Map k a -> (Maybe a,Map k a)
insertLookupWithKey f k x m = (lookup k m,insertWith (f k) k x m)

mapEither :: (a -> Either b c) -> Map k a -> (Map k b,Map k c)
mapEither f = mapEitherWithKey (\_ x -> f x)

mapEitherWithKey :: (k -> a -> Either b c) -> Map k a -> (Map k b,Map k c)
mapEitherWithKey f m = (fromDistinctAscList [(k,x) | (k,Left x) <- xs],fromDistinctAscList [(k,x) | (k,Right x) <- xs])
  where xs = [(k,f k x) | (k,x) <- toAscList m]

alterF :: (Functor f, Ord k) => (Maybe a -> f (Maybe a)) -> k -> Map k a -> f (Map k a)
alterF f k m = fmap (\result -> alter (const result) k m) (f (lookup k m))

mapKeysMonotonic :: (k1 -> k2) -> Map k1 a -> Map k2 a
mapKeysMonotonic f m = fromDistinctAscList [(f k,x) | (k,x) <- toAscList m]

fromDescList :: Eq k => [(k,a)] -> Map k a
fromDescList xs = fromDistinctAscList (reverse (B.map B.last (groupBy (\(k,_) (l,_) -> k == l) xs)))

fromDistinctDescList :: [(k,a)] -> Map k a
fromDistinctDescList = fromDistinctAscList . reverse

`;

/** The functions of Data.Map.Strict that differ from Data.Map: each evaluates the values it stores. */
export const STRICT_MAP_VALUES = [
  'singleton',
  'insert',
  'insertWith',
  'insertWithKey',
  'adjust',
  'adjustWithKey',
  'update',
  'alter',
  'fromList',
  'fromListWith',
  'fromListWithKey',
  'fromAscList',
  'fromDistinctAscList',
  'fromSet',
  'map',
  'mapWithKey',
  'traverseWithKey',
  'mapKeysWith',
  'mapAccum',
  'mapAccumWithKey',
  'mapAccumRWithKey',
  'updateWithKey',
  'insertLookupWithKey',
  'mapEither',
  'mapEitherWithKey',
  'alterF',
  'fromDescList',
  'fromDistinctDescList',
  'mapMaybe',
  'mapMaybeWithKey',
  'unionWith',
  'unionWithKey',
  'unionsWith',
  'intersectionWith',
  'intersectionWithKey',
  'differenceWith',
];

export const STRICT_MAP_SOURCE = String.raw`module Data.Map.Strict.Internal where

import Base hiding (map, insert, lookup, mapMaybe)
import qualified Base as B
import qualified Data.Set.Internal as S
import qualified Data.Map.Internal as L
import Data.Map.Internal (Map)

forceValues :: Map k a -> Map k a
forceValues m = L.foldr seq () m ${BT}seq${BT} m

singleton :: k -> a -> Map k a
singleton k x = x ${BT}seq${BT} L.singleton k x

insert :: Ord k => k -> a -> Map k a -> Map k a
insert k x m = k ${BT}seq${BT} x ${BT}seq${BT} L.insert k x m

insertWith :: Ord k => (a -> a -> a) -> k -> a -> Map k a -> Map k a
insertWith f k x m = case L.lookup k m of
  Nothing -> insert k x m
  Just y -> insert k (f x y) m

insertWithKey :: Ord k => (k -> a -> a -> a) -> k -> a -> Map k a -> Map k a
insertWithKey f k = insertWith (f k) k

adjust :: Ord k => (a -> a) -> k -> Map k a -> Map k a
adjust f = adjustWithKey (\_ x -> f x)

adjustWithKey :: Ord k => (k -> a -> a) -> k -> Map k a -> Map k a
adjustWithKey f k m = case L.lookup k m of
  Nothing -> m
  Just x -> insert k (f k x) m

update :: Ord k => (a -> Maybe a) -> k -> Map k a -> Map k a
update f k m = case L.lookup k m of
  Nothing -> m
  Just x -> case f x of
    Nothing -> L.delete k m
    Just x' -> insert k x' m

alter :: Ord k => (Maybe a -> Maybe a) -> k -> Map k a -> Map k a
alter f k m = case f (L.lookup k m) of
  Nothing -> L.delete k m
  Just x -> insert k x m

fromList :: Ord k => [(k, a)] -> Map k a
fromList = B.foldl' (\t (k, x) -> insert k x t) L.empty

fromListWith :: Ord k => (a -> a -> a) -> [(k, a)] -> Map k a
fromListWith f = B.foldl' (\t (k, x) -> insertWith f k x t) L.empty

fromListWithKey :: Ord k => (k -> a -> a -> a) -> [(k, a)] -> Map k a
fromListWithKey f = B.foldl' (\t (k, x) -> insertWith (f k) k x t) L.empty

fromAscList :: Eq k => [(k, a)] -> Map k a
fromAscList xs = forceValues (L.fromAscList xs)

fromDistinctAscList :: [(k, a)] -> Map k a
fromDistinctAscList xs = forceValues (L.fromDistinctAscList xs)

fromSet :: (k -> a) -> S.Set k -> Map k a
fromSet f s = forceValues (L.fromSet f s)

map :: (a -> b) -> Map k a -> Map k b
map f = mapWithKey (\_ x -> f x)

mapWithKey :: (k -> a -> b) -> Map k a -> Map k b
mapWithKey _ L.Tip = L.Tip
mapWithKey f (L.Bin size k x l r) =
  let y = f k x
      right = mapWithKey f r
      left = mapWithKey f l
  in y ${BT}seq${BT} right ${BT}seq${BT} left ${BT}seq${BT} L.Bin size k y left right

traverseWithKey :: Applicative t => (k -> a -> t b) -> Map k a -> t (Map k b)
traverseWithKey f m = fmap forceValues (L.traverseWithKey f m)

mapKeysWith :: Ord k2 => (a -> a -> a) -> (k1 -> k2) -> Map k1 a -> Map k2 a
mapKeysWith c f m = fromListWith c [(f k, x) | (k, x) <- L.toAscList m]

mapMaybe :: (a -> Maybe b) -> Map k a -> Map k b
mapMaybe f m = forceValues (L.mapMaybe f m)

mapMaybeWithKey :: (k -> a -> Maybe b) -> Map k a -> Map k b
mapMaybeWithKey f m = forceValues (L.mapMaybeWithKey f m)

unionWith :: Ord k => (a -> a -> a) -> Map k a -> Map k a -> Map k a
unionWith f = unionWithKey (\_ x y -> f x y)

unionWithKey :: Ord k => (k -> a -> a -> a) -> Map k a -> Map k a -> Map k a
unionWithKey _ a L.Tip = a
unionWithKey f a (L.Bin _ k x L.Tip L.Tip) = insertCarried (\key old new -> f key old new) k x a
unionWithKey f (L.Bin _ k x L.Tip L.Tip) b = insertCarried (\key old new -> f key new old) k x b
unionWithKey _ L.Tip b = b
unionWithKey f (L.Bin _ k x l r) b = case L.splitLookup k b of
  (bl,found,br) -> let y = case found of Nothing -> x; Just z -> f k x z
                  in y ${BT}seq${BT} L.link k y (unionWithKey f l bl) (unionWithKey f r br)

insertCarried :: Ord k => (k -> a -> a -> a) -> k -> a -> Map k a -> Map k a
insertCarried _ k x L.Tip = k ${BT}seq${BT} x ${BT}seq${BT} L.singleton k x
insertCarried f k x (L.Bin size key y l r) = case compare k key of
  LT -> L.balance key y (insertCarried f k x l) r
  GT -> L.balance key y l (insertCarried f k x r)
  EQ -> let z = f key y x in z ${BT}seq${BT} L.Bin size key z l r

unionsWith :: (Foldable f, Ord k) => (a -> a -> a) -> f (Map k a) -> Map k a
unionsWith f = B.foldl' (unionWith f) L.empty

intersectionWith :: Ord k => (a -> b -> c) -> Map k a -> Map k b -> Map k c
intersectionWith f a b = forceValues (L.intersectionWith f a b)

intersectionWithKey :: Ord k => (k -> a -> b -> c) -> Map k a -> Map k b -> Map k c
intersectionWithKey f a b = forceValues (L.intersectionWithKey f a b)

differenceWith :: Ord k => (a -> b -> Maybe a) -> Map k a -> Map k b -> Map k a
differenceWith _ a L.Tip = a
differenceWith _ L.Tip _ = L.Tip
differenceWith f (L.Bin _ k x l r) b = case L.splitLookup k b of
  (bl,found,br) -> let left = differenceWith f l bl
                       right = differenceWith f r br
                       result = case found of Nothing -> Just x; Just y -> f x y
                   in right ${BT}seq${BT} left ${BT}seq${BT} case result of
                     Nothing -> L.link2 left right
                     Just z -> case found of
                       Nothing -> L.link k z left right
                       Just _ -> z ${BT}seq${BT} L.link k z left right

mapAccum :: (a -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccum f = mapAccumWithKey (\a _ x -> f a x)

mapAccumWithKey :: (a -> k -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccumWithKey f a m = let (b,n) = L.mapAccumWithKey f a m in (b,forceValues n)

mapAccumRWithKey :: (a -> k -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccumRWithKey f a m = let (b,n) = L.mapAccumRWithKey f a m in (b,forceValues n)

updateWithKey :: Ord k => (k -> a -> Maybe a) -> k -> Map k a -> Map k a
updateWithKey f k = update (f k) k

insertLookupWithKey :: Ord k => (k -> a -> a -> a) -> k -> a -> Map k a -> (Maybe a,Map k a)
insertLookupWithKey f k x m = (L.lookup k m,insertWith (f k) k x m)

mapEither :: (a -> Either b c) -> Map k a -> (Map k b,Map k c)
mapEither f = mapEitherWithKey (\_ x -> f x)

mapEitherWithKey :: (k -> a -> Either b c) -> Map k a -> (Map k b,Map k c)
mapEitherWithKey f m = let (l,r) = L.mapEitherWithKey f m in (forceValues l,forceValues r)

alterF :: (Functor f, Ord k) => (Maybe a -> f (Maybe a)) -> k -> Map k a -> f (Map k a)
alterF f k m = fmap (\result -> alter (const result) k m) (f (L.lookup k m))

fromDescList :: Eq k => [(k,a)] -> Map k a
fromDescList xs = forceValues (L.fromDescList xs)

fromDistinctDescList :: [(k,a)] -> Map k a
fromDistinctDescList xs = forceValues (L.fromDistinctDescList xs)

`;
