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
member x tree = x ${BT}seq${BT} go tree
  where
    go STip = False
    go (SBin _ y l r) = case compare x y of
      LT -> go l
      GT -> go r
      EQ -> True

notMember :: Ord a => a -> Set a -> Bool
notMember x s = not (member x s)

insert :: Ord a => a -> Set a -> Set a
insert x tree = x ${BT}seq${BT} go tree
  where
    go STip = singleton x
    go (SBin sz y l r) = case compare x y of
      LT -> balance y (go l) r
      GT -> balance y l (go r)
      EQ -> SBin sz x l r

delete :: Ord a => a -> Set a -> Set a
delete x tree = x ${BT}seq${BT} go tree
  where
    go STip = STip
    go (SBin _ y l r) = case compare x y of
      LT -> balance y (go l) r
      GT -> balance y l (go r)
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
fromList = B.foldl' (\t x -> insert x t) STip

fromAscList :: Eq a => [a] -> Set a
fromAscList xs = fromDistinctAscList (B.map B.last (group xs))

fromDistinctAscList :: [a] -> Set a
fromDistinctAscList = buildOrderedSet False

data OrderedSetStack a = SetPush !a !(Set a) !(OrderedSetStack a) | SetEnd

buildOrderedSet :: Bool -> [a] -> Set a
buildOrderedSet descending xs = finish STip (B.foldl' next SetEnd xs)
  where next (SetPush x STip rest) y = y ${BT}seq${BT} joinStack rest 1 (singleton x) y
        next stack x = x ${BT}seq${BT} SetPush x STip stack
        joinStack (SetPush x l@(SBin leftSize _ _ _) rest) rightSize r y =
          if leftSize == rightSize then
            let count = leftSize + rightSize + 1
                tree = if descending then SBin count x r l else SBin count x l r
            in joinStack rest count tree y
          else SetPush y r (SetPush x l rest)
        joinStack stack _ r y = SetPush y r stack
        finish tree SetEnd = tree
        finish tree (SetPush x subtree rest) =
          let nextTree = if descending then link x tree subtree else link x subtree tree
          in nextTree ${BT}seq${BT} finish nextTree rest

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
foldl' f z s = z ${BT}seq${BT} case s of
  STip -> z
  SBin _ x l r -> let left = foldl' f z l in left ${BT}seq${BT} foldl' f (f left x) r

union :: Ord a => Set a -> Set a -> Set a
union a STip = a
union a (SBin 1 x _ _) = insertKeeping x a
union (SBin 1 x _ _) b = insert x b
union STip b = b
union (SBin _ x l r) b = case split x b of
  (bl,br) ->
    let left = union l bl
        right = union r br
    in right ${BT}seq${BT} left ${BT}seq${BT} link x left right

insertKeeping :: Ord a => a -> Set a -> Set a
insertKeeping x STip = singleton x
insertKeeping x t@(SBin _ y l r) = case compare x y of
  LT -> balance y (insertKeeping x l) r
  GT -> balance y l (insertKeeping x r)
  EQ -> t

unions :: (Foldable f, Ord a) => f (Set a) -> Set a
unions = B.foldl' union empty

intersection :: Ord a => Set a -> Set a -> Set a
intersection STip _ = STip
intersection _ STip = STip
intersection (SBin _ x l r) b = case splitMember x b of
  (bl,found,br) -> let left = intersection l bl
                       right = intersection r br
                   in left ${BT}seq${BT} right ${BT}seq${BT} if found then link x left right else link2 left right

difference :: Ord a => Set a -> Set a -> Set a
difference STip _ = STip
difference a STip = a
difference a (SBin _ x l r) = case split x a of
  (al,ar) -> let left = difference al l
                 right = difference ar r
             in right ${BT}seq${BT} left ${BT}seq${BT}
                if size left + size right == size a then a else link2 left right

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
filter _ STip = STip
filter p (SBin _ x l r) =
  let left = filter p l
      right = filter p r
  in right ${BT}seq${BT} left ${BT}seq${BT} if p x then link x left right else link2 left right

partition :: (a -> Bool) -> Set a -> (Set a, Set a)
partition _ STip = (STip,STip)
partition p (SBin _ x l r) = case partition p l of
  (ll,lr) -> case partition p r of
    (rl,rr) -> if p x then strictPair (link x ll rl) (link2 lr rr)
              else strictPair (link2 ll rl) (link x lr rr)

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
elemAt i s = i ${BT}seq${BT} s ${BT}seq${BT} if i < 0 || i >= size s then errorWithoutStackTrace "Set.elemAt: index out of range" else at i s
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
take n tree = if n >= size tree then tree else go n tree
  where go i t | i <= 0 = t ${BT}seq${BT} STip
        go _ STip = STip
        go i (SBin _ x l r) = case compare i (size l) of
          LT -> go i l
          GT -> link x l (go (i-size l-1) r)
          EQ -> l

drop :: Int -> Set a -> Set a
drop n tree = if n >= size tree then STip else go n tree
  where go i t | i <= 0 = t
        go _ STip = STip
        go i (SBin _ x l r) = case compare i (size l) of
          LT -> link x (go i l) r
          GT -> go (i-size l-1) r
          EQ -> insertMin x r

splitAt :: Int -> Set a -> (Set a, Set a)
splitAt n s = if n >= size s then (s,STip) else go n s
  where go i t | i <= 0 = strictPair STip t
        go _ STip = (STip,STip)
        go i (SBin _ x l r) = case compare i (size l) of
          LT -> case go i l of (ll,lr) -> strictPair ll (link x lr r)
          GT -> case go (i-size l-1) r of (rl,rr) -> strictPair (link x l rl) rr
          EQ -> strictPair l (insertMin x r)

split :: Ord a => a -> Set a -> (Set a, Set a)
split _ STip = (STip,STip)
split x (SBin _ y l r) = case compare x y of
  LT -> case split x l of (lt,gt) -> strictPair lt (link y gt r)
  GT -> case split x r of (lt,gt) -> strictPair (link y l lt) gt
  EQ -> (l,r)

splitMember :: Ord a => a -> Set a -> (Set a, Bool, Set a)
splitMember _ STip = (STip,False,STip)
splitMember x (SBin _ y l r) = case compare x y of
  LT -> case splitMember x l of
    (lt,found,gt) -> let right = link y gt r in right ${BT}seq${BT} (lt,found,right)
  GT -> case splitMember x r of
    (lt,found,gt) -> let left = link y l lt in left ${BT}seq${BT} (left,found,gt)
  EQ -> (l,True,r)

link :: a -> Set a -> Set a -> Set a
link x STip r = insertMin x r
link x l STip = insertMax x l
link x l@(SBin sl kl ll lr) r@(SBin sr kr rl rr) =
  if 3*sl < sr then balance kr (link x l rl) rr
  else if 3*sr < sl then balance kl ll (link x lr r)
  else bin x l r

insertMin :: a -> Set a -> Set a
insertMin x STip = singleton x
insertMin x (SBin _ y l r) = balance y (insertMin x l) r

insertMax :: a -> Set a -> Set a
insertMax x STip = singleton x
insertMax x (SBin _ y l r) = balance y l (insertMax x r)

link2 :: Set a -> Set a -> Set a
link2 STip r = r
link2 l STip = l
link2 l@(SBin sl kl ll lr) r@(SBin sr kr rl rr) =
  if 3*sl < sr then balance kr (link2 l rl) rr
  else if 3*sr < sl then balance kl ll (link2 lr r)
  else glue l r

lookupLT :: Ord a => a -> Set a -> Maybe a
lookupLT x tree = x ${BT}seq${BT} (nearest (\y -> if x <= y then LT else GT) False) tree

lookupGT :: Ord a => a -> Set a -> Maybe a
lookupGT x tree = x ${BT}seq${BT} (nearest (\y -> if x < y then LT else GT) True) tree

lookupLE :: Ord a => a -> Set a -> Maybe a
lookupLE x tree = x ${BT}seq${BT} (nearest (compare x) False) tree

lookupGE :: Ord a => a -> Set a -> Maybe a
lookupGE x tree = x ${BT}seq${BT} (nearest (compare x) True) tree

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
  foldr' = foldr'
  foldl' = foldl'
  toList = toAscList
  null = null
  length = size
  elem x s = B.elem x (toAscList s)
  minimum = findMin
  maximum = findMax
  sum s = B.sum (toAscList s)
  product s = B.product (toAscList s)

nearest :: (a -> Ordering) -> Bool -> Set a -> Maybe a
nearest compareKey lower = go Nothing
  where go best STip = best
        go best (SBin _ x l r) = case compareKey x of
          EQ -> Just x
          LT -> go (if lower then Just x else best) l
          GT -> go (if lower then best else Just x) r

powerSet :: Set a -> Set (Set a)
powerSet s = fromDistinctAscList (B.map fromDistinctAscList (subsets (toAscList s)))
  where subsets [] = [[]]
        subsets (x:xs) = let rest = subsets xs in [] : (B.map (x:) rest ++ B.tail rest)

cartesianProduct :: Set a -> Set b -> Set (a,b)
cartesianProduct a b = fromDistinctAscList [(x,y) | x <- toAscList a, y <- toAscList b]

mapMonotonic :: (a -> b) -> Set a -> Set b
mapMonotonic _ STip = STip
mapMonotonic f (SBin count x l r) =
  let left = mapMonotonic f l
      right = mapMonotonic f r
  in right ${BT}seq${BT} left ${BT}seq${BT} SBin count (f x) left right

symmetricDifference :: Ord a => Set a -> Set a -> Set a
symmetricDifference a b = union (difference a b) (difference b a)

fold :: (a -> b -> b) -> b -> Set a -> b
fold = foldr

fromDescList :: Eq a => [a] -> Set a
fromDescList xs = fromDistinctDescList (B.map B.last (group xs))

fromDistinctDescList :: [a] -> Set a
fromDistinctDescList = buildOrderedSet True

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
lookup k tree = k ${BT}seq${BT} go tree
  where
    go Tip = Nothing
    go (Bin _ kx x l r) = case compare k kx of
      LT -> go l
      GT -> go r
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
insert kx x tree = kx ${BT}seq${BT} go tree
  where
    go Tip = singleton kx x
    go (Bin sz ky y l r) = case compare kx ky of
      LT -> balance ky y (go l) r
      GT -> balance ky y l (go r)
      EQ -> Bin sz kx x l r

insertWith :: Ord k => (a -> a -> a) -> k -> a -> Map k a -> Map k a
insertWith f kx x tree = kx ${BT}seq${BT} go tree
  where
    go Tip = singleton kx x
    go (Bin sy ky y l r) = case compare kx ky of
      LT -> balance ky y (go l) r
      GT -> balance ky y l (go r)
      EQ -> Bin sy kx (f x y) l r

insertWithKey :: Ord k => (k -> a -> a -> a) -> k -> a -> Map k a -> Map k a
insertWithKey f kx x m = insertWith (f kx) kx x m

delete :: Ord k => k -> Map k a -> Map k a
delete k tree = k ${BT}seq${BT} go tree
  where
    go Tip = Tip
    go (Bin _ kx x l r) = case compare k kx of
      LT -> balance kx x (go l) r
      GT -> balance kx x l (go r)
      EQ -> glue l r

adjust :: Ord k => (a -> a) -> k -> Map k a -> Map k a
adjust f = adjustWithKey (\_ x -> f x)

adjustWithKey :: Ord k => (k -> a -> a) -> k -> Map k a -> Map k a
adjustWithKey = adjustUsing False

adjustUsing :: Ord k => Bool -> (k -> a -> a) -> k -> Map k a -> Map k a
adjustUsing strict f k m = k ${BT}seq${BT} go m
  where
    go Tip = Tip
    go (Bin count key x l r) = case compare k key of
      LT -> Bin count key x (adjustUsing strict f k l) r
      GT -> Bin count key x l (adjustUsing strict f k r)
      EQ -> let y = f key x in forceValue strict y (Bin count key y l r)

update :: Ord k => (a -> Maybe a) -> k -> Map k a -> Map k a
update f = updateWithKey (\_ x -> f x)

updateUsing :: Ord k => Bool -> (k -> a -> Maybe a) -> k -> Map k a -> Map k a
updateUsing strict f k m = k ${BT}seq${BT} go m
  where
    go Tip = Tip
    go (Bin count key x l r) = case compare k key of
      LT -> balance key x (updateUsing strict f k l) r
      GT -> balance key x l (updateUsing strict f k r)
      EQ -> case f key x of
        Nothing -> glue l r
        Just y -> forceValue strict y (Bin count key y l r)

alter :: Ord k => (Maybe a -> Maybe a) -> k -> Map k a -> Map k a
alter = alterUsing False

alterUsing :: Ord k => Bool -> (Maybe a -> Maybe a) -> k -> Map k a -> Map k a
alterUsing strict f k m = k ${BT}seq${BT} go m
  where
    go Tip = case f Nothing of
      Nothing -> Tip
      Just x -> forceValue strict x (singleton k x)
    go (Bin count key x l r) = case compare k key of
      LT -> balance key x (alterUsing strict f k l) r
      GT -> balance key x l (alterUsing strict f k r)
      EQ -> case f (Just x) of
        Nothing -> glue l r
        Just y -> forceValue strict y (Bin count key y l r)

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
fromList = B.foldl' (\t (k, x) -> insert k x t) Tip

fromListWith :: Ord k => (a -> a -> a) -> [(k, a)] -> Map k a
fromListWith f = B.foldl' (\t (k, x) -> insertWith f k x t) Tip

fromListWithKey :: Ord k => (k -> a -> a -> a) -> [(k, a)] -> Map k a
fromListWithKey f = B.foldl' (\t (k, x) -> insertWith (f k) k x t) Tip

fromAscList :: Eq k => [(k, a)] -> Map k a
fromAscList xs = fromDistinctAscList (combine xs)
  where combine ((k1, x1) : rest@((k2, _) : _)) = if k1 == k2 then combine rest else (k1, x1) : combine rest
        combine ys = ys

fromDistinctAscList :: [(k, a)] -> Map k a
fromDistinctAscList = buildOrderedMap False

data OrderedMapStack k a = MapPush !k a !(Map k a) !(OrderedMapStack k a) | MapEnd

buildOrderedMap :: Bool -> [(k,a)] -> Map k a
buildOrderedMap descending xs = finish Tip (B.foldl' next MapEnd xs)
  where next (MapPush k x Tip rest) (key,y) = key ${BT}seq${BT} joinStack rest 1 (singleton k x) key y
        next stack (k,x) = k ${BT}seq${BT} MapPush k x Tip stack
        joinStack (MapPush k x l@(Bin leftSize _ _ _ _) rest) rightSize r key y =
          if leftSize == rightSize then
            let count = leftSize + rightSize + 1
                tree = if descending then Bin count k x r l else Bin count k x l r
            in joinStack rest count tree key y
          else MapPush key y r (MapPush k x l rest)
        joinStack stack _ r k x = MapPush k x r stack
        finish tree MapEnd = tree
        finish tree (MapPush k x subtree rest) =
          let nextTree = if descending then link k x tree subtree else link k x subtree tree
          in nextTree ${BT}seq${BT} finish nextTree rest

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
keysSet Tip = S.STip
keysSet (Bin count k _ l r) = S.SBin count k (keysSet l) (keysSet r)

fromSet :: (k -> a) -> S.Set k -> Map k a
fromSet = fromSetUsing False

fromSetUsing :: Bool -> (k -> a) -> S.Set k -> Map k a
fromSetUsing _ _ S.STip = Tip
fromSetUsing strict f (S.SBin count k l r) =
  let x = f k in forceValue strict x (Bin count k x (fromSetUsing strict f l) (fromSetUsing strict f r))

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
foldl' f z m = z ${BT}seq${BT} case m of
  Tip -> z
  Bin _ _ x l r -> let left = foldl' f z l in left ${BT}seq${BT} foldl' f (f left x) r

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
foldlWithKey' f z m = z ${BT}seq${BT} case m of
  Tip -> z
  Bin _ k x l r -> let left = foldlWithKey' f z l in left ${BT}seq${BT} foldlWithKey' f (f left k x) r

foldMapWithKey :: Monoid m => (k -> a -> m) -> Map k a -> m
foldMapWithKey f = foldrWithKey (\k x acc -> f k x <> acc) mempty

map :: (a -> b) -> Map k a -> Map k b
map _ Tip = Tip
map f (Bin sx kx x l r) = Bin sx kx (f x) (map f l) (map f r)

mapWithKey :: (k -> a -> b) -> Map k a -> Map k b
mapWithKey _ Tip = Tip
mapWithKey f (Bin sx kx x l r) = Bin sx kx (f kx x) (mapWithKey f l) (mapWithKey f r)

traverseWithKey :: Applicative t => (k -> a -> t b) -> Map k a -> t (Map k b)
traverseWithKey = traverseUsing False

traverseUsing :: Applicative t => Bool -> (k -> a -> t b) -> Map k a -> t (Map k b)
traverseUsing _ _ Tip = pure Tip
traverseUsing strict f (Bin count k x l r) =
  liftA3 (\left y right -> forceValue strict y (Bin count k y left right))
    (traverseUsing strict f l) (f k x) (traverseUsing strict f r)

mapKeys :: Ord k2 => (k1 -> k2) -> Map k1 a -> Map k2 a
mapKeys f m = fromList [(f k, x) | (k, x) <- toAscList m]

mapKeysWith :: Ord k2 => (a -> a -> a) -> (k1 -> k2) -> Map k1 a -> Map k2 a
mapKeysWith c f m = fromListWith c [(f k, x) | (k, x) <- toAscList m]

filter :: (a -> Bool) -> Map k a -> Map k a
filter p = filterWithKey (\_ x -> p x)

filterWithKey :: (k -> a -> Bool) -> Map k a -> Map k a
filterWithKey _ Tip = Tip
filterWithKey p (Bin _ k x l r) =
  let left = filterWithKey p l
      right = filterWithKey p r
  in right ${BT}seq${BT} left ${BT}seq${BT} if p k x then link k x left right else link2 left right

partition :: (a -> Bool) -> Map k a -> (Map k a, Map k a)
partition p = partitionWithKey (\_ x -> p x)

partitionWithKey :: (k -> a -> Bool) -> Map k a -> (Map k a, Map k a)
partitionWithKey _ Tip = (Tip,Tip)
partitionWithKey p (Bin _ k x l r) =
  let (ll,lr) = partitionWithKey p l
      (rl,rr) = partitionWithKey p r
  in if p k x then strictPair (link k x ll rl) (link2 lr rr)
     else strictPair (link2 ll rl) (link k x lr rr)

mapMaybe :: (a -> Maybe b) -> Map k a -> Map k b
mapMaybe f = mapMaybeWithKey (\_ x -> f x)

mapMaybeWithKey :: (k -> a -> Maybe b) -> Map k a -> Map k b
mapMaybeWithKey = mapMaybeUsing False

mapMaybeUsing :: Bool -> (k -> a -> Maybe b) -> Map k a -> Map k b
mapMaybeUsing _ _ Tip = Tip
mapMaybeUsing strict f (Bin _ k x l r) = case f k x of
  Nothing -> link2 (mapMaybeUsing strict f l) (mapMaybeUsing strict f r)
  Just y -> forceValue strict y (link k y (mapMaybeUsing strict f l) (mapMaybeUsing strict f r))

union :: Ord k => Map k a -> Map k a -> Map k a
union = unionWith const

unionWith :: Ord k => (a -> a -> a) -> Map k a -> Map k a -> Map k a
unionWith f = unionWithKey (\_ x y -> f x y)

unionWithKey :: Ord k => (k -> a -> a -> a) -> Map k a -> Map k a -> Map k a
unionWithKey = unionWithKeyUsing False

unionWithKeyUsing :: Ord k => Bool -> (k -> a -> a -> a) -> Map k a -> Map k a -> Map k a
unionWithKeyUsing _ _ a Tip = a
unionWithKeyUsing strict f a (Bin _ k x Tip Tip) = insertUnion strict True f k x a
unionWithKeyUsing strict f (Bin _ k x Tip Tip) b = insertUnion strict False f k x b
unionWithKeyUsing _ _ Tip b = b
unionWithKeyUsing strict f (Bin _ k x l r) b = case splitLookup k b of
  (bl,found,br) ->
    let y = case found of Nothing -> x; Just z -> f k x z
        left = unionWithKeyUsing strict f l bl
        right = unionWithKeyUsing strict f r br
    in if strict then y ${BT}seq${BT} right ${BT}seq${BT} left ${BT}seq${BT} link k y left right
       else right ${BT}seq${BT} left ${BT}seq${BT} link k y left right

insertUnion :: Ord k => Bool -> Bool -> (k -> a -> a -> a) -> k -> a -> Map k a -> Map k a
insertUnion strict _ _ k x Tip = k ${BT}seq${BT} forceValue strict x (singleton k x)
insertUnion strict keep f k x (Bin count key y l r) = case compare k key of
  LT -> balance key y (insertUnion strict keep f k x l) r
  GT -> balance key y l (insertUnion strict keep f k x r)
  EQ -> let key' = if keep then key else k
            z = if keep then f key y x else f k x y
        in forceValue strict z (Bin count key' z l r)

unions :: (Foldable f, Ord k) => f (Map k a) -> Map k a
unions = B.foldl' union Tip

unionsWith :: (Foldable f, Ord k) => (a -> a -> a) -> f (Map k a) -> Map k a
unionsWith f = B.foldl' (unionWith f) Tip

intersection :: Ord k => Map k a -> Map k b -> Map k a
intersection = intersectionWith const

intersectionWith :: Ord k => (a -> b -> c) -> Map k a -> Map k b -> Map k c
intersectionWith f = intersectionWithKey (\_ x y -> f x y)

intersectionWithKey :: Ord k => (k -> a -> b -> c) -> Map k a -> Map k b -> Map k c
intersectionWithKey = intersectionUsing False

intersectionUsing :: Ord k => Bool -> (k -> a -> b -> c) -> Map k a -> Map k b -> Map k c
intersectionUsing _ _ Tip _ = Tip
intersectionUsing _ _ _ Tip = Tip
intersectionUsing strict f (Bin _ k x l r) b = case splitLookup k b of
  (bl,found,br) -> let left = intersectionUsing strict f l bl
                       right = intersectionUsing strict f r br
                   in left ${BT}seq${BT} right ${BT}seq${BT} case found of
                     Nothing -> link2 left right
                     Just y -> let z = f k x y in forceValue strict z (link k z left right)

difference :: Ord k => Map k a -> Map k b -> Map k a
difference Tip _ = Tip
difference a Tip = a
difference a (Bin _ k _ l r) = case split k a of
  (al,ar) -> let left = difference al l
                 right = difference ar r
             in right ${BT}seq${BT} left ${BT}seq${BT}
                if size left + size right == size a then a else link2 left right

differenceWith :: Ord k => (a -> b -> Maybe a) -> Map k a -> Map k b -> Map k a
differenceWith = differenceUsing False

differenceUsing :: Ord k => Bool -> (a -> b -> Maybe a) -> Map k a -> Map k b -> Map k a
differenceUsing _ _ a Tip = a
differenceUsing _ _ Tip _ = Tip
differenceUsing strict f (Bin _ k x l r) b = case splitLookup k b of
  (bl,found,br) -> let left = differenceUsing strict f l bl
                       right = differenceUsing strict f r br
                       result = case found of Nothing -> Just x; Just y -> f x y
                   in right ${BT}seq${BT} left ${BT}seq${BT} case result of
                     Nothing -> link2 left right
                     Just z -> case found of
                       Nothing -> link k z left right
                       Just _ -> forceValue strict z (link k z left right)

(\\) :: Ord k => Map k a -> Map k b -> Map k a
m1 \\ m2 = difference m1 m2

restrictKeys :: Ord k => Map k a -> S.Set k -> Map k a
restrictKeys Tip _ = Tip
restrictKeys _ S.STip = Tip
restrictKeys m@(Bin _ k x l r) s = case S.splitMember k s of
  (sl,found,sr) -> let left = restrictKeys l sl
                       right = restrictKeys r sr
                   in left ${BT}seq${BT} right ${BT}seq${BT}
                      if found then if size left + size right + 1 == size m then m else link k x left right
                      else link2 left right

withoutKeys :: Ord k => Map k a -> S.Set k -> Map k a
withoutKeys Tip _ = Tip
withoutKeys m S.STip = m
withoutKeys m (S.SBin _ k sl sr) = case splitLookup k m of
  (l,_,r) -> let left = withoutKeys l sl
                 right = withoutKeys r sr
             in right ${BT}seq${BT} left ${BT}seq${BT}
                if size left + size right == size m then m else link2 left right

isSubmapOf :: (Ord k, Eq a) => Map k a -> Map k a -> Bool
isSubmapOf a b = b ${BT}seq${BT} size a <= size b && submapValues (==) a b

submapValues :: Ord k => (a -> b -> Bool) -> Map k a -> Map k b -> Bool
submapValues _ Tip _ = True
submapValues _ _ Tip = False
submapValues f (Bin 1 k x _ _) b = case lookup k b of
  Nothing -> False
  Just y -> f x y
submapValues f (Bin _ k x l r) b = case splitLookup k b of
  (bl,found,br) -> case found of
    Nothing -> False
    Just y -> f x y && size l <= size bl && size r <= size br
                   && submapValues f l bl && submapValues f r br

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
elemAt i m = i ${BT}seq${BT} m ${BT}seq${BT} if i < 0 || i >= size m then errorWithoutStackTrace "Map.elemAt: index out of range" else at i m
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
take n tree = if n >= size tree then tree else go n tree
  where go i t | i <= 0 = t ${BT}seq${BT} Tip
        go _ Tip = Tip
        go i (Bin _ k x l r) = case compare i (size l) of
          LT -> go i l
          GT -> link k x l (go (i-size l-1) r)
          EQ -> l

drop :: Int -> Map k a -> Map k a
drop n tree = if n >= size tree then Tip else go n tree
  where go i t | i <= 0 = t
        go _ Tip = Tip
        go i (Bin _ k x l r) = case compare i (size l) of
          LT -> link k x (go i l) r
          GT -> go (i-size l-1) r
          EQ -> insertMin k x r

splitAt :: Int -> Map k a -> (Map k a, Map k a)
splitAt n m = if n >= size m then (m,Tip) else go n m
  where go i t | i <= 0 = strictPair Tip t
        go _ Tip = (Tip,Tip)
        go i (Bin _ k x l r) = case compare i (size l) of
          LT -> case go i l of (ll,lr) -> strictPair ll (link k x lr r)
          GT -> case go (i-size l-1) r of (rl,rr) -> strictPair (link k x l rl) rr
          EQ -> strictPair l (insertMin k x r)

lookupLT :: Ord k => k -> Map k v -> Maybe (k, v)
lookupLT k tree = k ${BT}seq${BT} (nearest (\key -> if k <= key then LT else GT) False) tree

lookupGT :: Ord k => k -> Map k v -> Maybe (k, v)
lookupGT k tree = k ${BT}seq${BT} (nearest (\key -> if k < key then LT else GT) True) tree

lookupLE :: Ord k => k -> Map k v -> Maybe (k, v)
lookupLE k tree = k ${BT}seq${BT} (nearest (compare k) False) tree

lookupGE :: Ord k => k -> Map k v -> Maybe (k, v)
lookupGE k tree = k ${BT}seq${BT} (nearest (compare k) True) tree

split :: Ord k => k -> Map k a -> (Map k a, Map k a)
split k m = case splitLookup k m of (l,_,r) -> (l,r)

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
  foldr' = foldr'
  foldl' = foldl'
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

nearest :: (k -> Ordering) -> Bool -> Map k a -> Maybe (k,a)
nearest compareKey lower = go Nothing
  where go best Tip = best
        go best (Bin _ k x l r) = case compareKey k of
          EQ -> Just (k,x)
          LT -> go (if lower then Just (k,x) else best) l
          GT -> go (if lower then best else Just (k,x)) r

mapAccum :: (a -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccum f = mapAccumWithKey (\a _ x -> f a x)

mapAccumWithKey :: (a -> k -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccumWithKey = mapAccumUsing False False

mapAccumRWithKey :: (a -> k -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccumRWithKey = mapAccumUsing False True

mapAccumUsing :: Bool -> Bool -> (a -> k -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccumUsing _ _ _ a Tip = (a,Tip)
mapAccumUsing strict descending f a (Bin count k x l r) =
  let first = if descending then r else l
      second = if descending then l else r
      (a1,firstResult) = mapAccumUsing strict descending f a first
      (a2,y) = f a1 k x
      (a3,secondResult) = mapAccumUsing strict descending f a2 second
      left = if descending then secondResult else firstResult
      right = if descending then firstResult else secondResult
  in forceValue strict y (a3,Bin count k y left right)

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
updateWithKey = updateUsing False

insertLookupWithKey :: Ord k => (k -> a -> a -> a) -> k -> a -> Map k a -> (Maybe a,Map k a)
insertLookupWithKey = insertLookupUsing False

insertLookupUsing :: Ord k => Bool -> (k -> a -> a -> a) -> k -> a -> Map k a -> (Maybe a,Map k a)
insertLookupUsing strict f k x m = k ${BT}seq${BT} case m of
  Tip -> forceValue strict x (strictPair Nothing (singleton k x))
  Bin count key y l r -> case compare k key of
    LT -> case insertLookupUsing strict f k x l of (old,l') -> strictPair old (balance key y l' r)
    GT -> case insertLookupUsing strict f k x r of (old,r') -> strictPair old (balance key y l r')
    EQ -> let z = f k x y in forceValue strict z (strictPair (Just y) (Bin count k z l r))

mapEither :: (a -> Either b c) -> Map k a -> (Map k b,Map k c)
mapEither f = mapEitherWithKey (\_ x -> f x)

mapEitherWithKey :: (k -> a -> Either b c) -> Map k a -> (Map k b,Map k c)
mapEitherWithKey = mapEitherUsing False

mapEitherUsing :: Bool -> (k -> a -> Either b c) -> Map k a -> (Map k b,Map k c)
mapEitherUsing _ _ Tip = (Tip,Tip)
mapEitherUsing strict f (Bin _ k x l r) =
  let left = mapEitherUsing strict f l
      right = mapEitherUsing strict f r
      build result = case left of
        (ll,lr) -> case right of
          (rl,rr) -> case result of
            Left y -> strictPair (link k y ll rl) (link2 lr rr)
            Right z -> strictPair (link2 ll rl) (link k z lr rr)
      classify = case f k x of
        Left y -> forceValue strict y (build (Left y))
        Right z -> forceValue strict z (build (Right z))
  in if strict then classify else left ${BT}seq${BT} right ${BT}seq${BT} classify

alterF :: (Functor f, Ord k) => (Maybe a -> f (Maybe a)) -> k -> Map k a -> f (Map k a)
alterF = alterFUsing False

alterFUsing :: (Functor f, Ord k) => Bool -> (Maybe a -> f (Maybe a)) -> k -> Map k a -> f (Map k a)
alterFUsing strict f k m = k ${BT}seq${BT}
  let found = lookup k m
  in found ${BT}seq${BT} fmap (\result -> alterUsing strict (const result) k m) (f found)

mapKeysMonotonic :: (k1 -> k2) -> Map k1 a -> Map k2 a
mapKeysMonotonic _ Tip = Tip
mapKeysMonotonic f (Bin count k x l r) =
  let left = mapKeysMonotonic f l
      right = mapKeysMonotonic f r
  in right ${BT}seq${BT} left ${BT}seq${BT} Bin count (f k) x left right

fromDescList :: Eq k => [(k,a)] -> Map k a
fromDescList xs = fromDistinctDescList (B.map B.last (groupBy (\(k,_) (l,_) -> k == l) xs))

fromDistinctDescList :: [(k,a)] -> Map k a
fromDistinctDescList = buildOrderedMap True

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
adjustWithKey = L.adjustUsing True

update :: Ord k => (a -> Maybe a) -> k -> Map k a -> Map k a
update f = updateWithKey (\_ x -> f x)

alter :: Ord k => (Maybe a -> Maybe a) -> k -> Map k a -> Map k a
alter = L.alterUsing True

fromList :: Ord k => [(k, a)] -> Map k a
fromList = B.foldl' (\t (k, x) -> insert k x t) L.empty

fromListWith :: Ord k => (a -> a -> a) -> [(k, a)] -> Map k a
fromListWith f = B.foldl' (\t (k, x) -> insertWith f k x t) L.empty

fromListWithKey :: Ord k => (k -> a -> a -> a) -> [(k, a)] -> Map k a
fromListWithKey f = B.foldl' (\t (k, x) -> insertWith (f k) k x t) L.empty

fromAscList :: Eq k => [(k, a)] -> Map k a
fromAscList xs = L.fromDistinctAscList (reverse (collapseOrdered xs))

fromDistinctAscList :: [(k, a)] -> Map k a
fromDistinctAscList xs = forceInputValues xs ${BT}seq${BT} L.fromDistinctAscList xs

fromSet :: (k -> a) -> S.Set k -> Map k a
fromSet = L.fromSetUsing True

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
traverseWithKey = L.traverseUsing True

mapKeysWith :: Ord k2 => (a -> a -> a) -> (k1 -> k2) -> Map k1 a -> Map k2 a
mapKeysWith c f m = fromListWith c [(f k, x) | (k, x) <- L.toAscList m]

mapMaybe :: (a -> Maybe b) -> Map k a -> Map k b
mapMaybe f = mapMaybeWithKey (\_ x -> f x)

mapMaybeWithKey :: (k -> a -> Maybe b) -> Map k a -> Map k b
mapMaybeWithKey = L.mapMaybeUsing True

unionWith :: Ord k => (a -> a -> a) -> Map k a -> Map k a -> Map k a
unionWith f = unionWithKey (\_ x y -> f x y)

unionWithKey :: Ord k => (k -> a -> a -> a) -> Map k a -> Map k a -> Map k a
unionWithKey = L.unionWithKeyUsing True

unionsWith :: (Foldable f, Ord k) => (a -> a -> a) -> f (Map k a) -> Map k a
unionsWith f = B.foldl' (unionWith f) L.empty

intersectionWith :: Ord k => (a -> b -> c) -> Map k a -> Map k b -> Map k c
intersectionWith f = intersectionWithKey (\_ x y -> f x y)

intersectionWithKey :: Ord k => (k -> a -> b -> c) -> Map k a -> Map k b -> Map k c
intersectionWithKey = L.intersectionUsing True

differenceWith :: Ord k => (a -> b -> Maybe a) -> Map k a -> Map k b -> Map k a
differenceWith = L.differenceUsing True

mapAccum :: (a -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccum f = mapAccumWithKey (\a _ x -> f a x)

mapAccumWithKey :: (a -> k -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccumWithKey = L.mapAccumUsing True False

mapAccumRWithKey :: (a -> k -> b -> (a,c)) -> a -> Map k b -> (a,Map k c)
mapAccumRWithKey = L.mapAccumUsing True True

updateWithKey :: Ord k => (k -> a -> Maybe a) -> k -> Map k a -> Map k a
updateWithKey = L.updateUsing True

insertLookupWithKey :: Ord k => (k -> a -> a -> a) -> k -> a -> Map k a -> (Maybe a,Map k a)
insertLookupWithKey = L.insertLookupUsing True

mapEither :: (a -> Either b c) -> Map k a -> (Map k b,Map k c)
mapEither f = mapEitherWithKey (\_ x -> f x)

mapEitherWithKey :: (k -> a -> Either b c) -> Map k a -> (Map k b,Map k c)
mapEitherWithKey = L.mapEitherUsing True

alterF :: (Functor f, Ord k) => (Maybe a -> f (Maybe a)) -> k -> Map k a -> f (Map k a)
alterF = L.alterFUsing True

fromDescList :: Eq k => [(k,a)] -> Map k a
fromDescList xs = L.fromDistinctDescList (reverse (collapseOrdered xs))

collapseOrdered :: Eq k => [(k,a)] -> [(k,a)]
collapseOrdered = B.foldl' step []
  where step [] (k,x) = k ${BT}seq${BT} x ${BT}seq${BT} [(k,x)]
        step acc@((previous,_):rest) (k,x) = k ${BT}seq${BT}
          if k == previous then x ${BT}seq${BT} (k,x):rest else x ${BT}seq${BT} (k,x):acc

fromDistinctDescList :: [(k,a)] -> Map k a
fromDistinctDescList xs = forceInputValues xs ${BT}seq${BT} L.fromDistinctDescList xs

forceInputValues :: [(k,a)] -> ()
forceInputValues = B.foldl' (\_ (k,x) -> k ${BT}seq${BT} x ${BT}seq${BT} ()) ()

`;
