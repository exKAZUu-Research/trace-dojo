import { BT } from './source';

/**
 * `Data.Sequence`, size-annotated 2-3 finger trees transcribed from containers 0.8 (`Data.Sequence.Internal`,
 * `Data.Sequence.Internal.Sorting`, and the `State` and `StrictPair` of `Utils.Containers.Internal`), limited to what
 * `SEQUENCE_VALUES` and the instances need. Where containers branches on CPP, this takes its non-GHC branch, which needs
 * no `coerce`; instances of classes this library lacks (`NFData`, `Eq1`, `Show1`, `Data`, `Lift`, ...) are left out.
 */
export const SEQUENCE_SOURCE = String.raw`module Data.Sequence.Internal where

import Base hiding (length, null, reverse, lookup, filter, replicate, splitAt, take, drop, zip, zipWith, scanl, sort, sortBy, sortOn, unzip, partition, insertAt, deleteAt, foldlWithIndex, foldrWithIndex, iterate, unstableSort, elemIndexL, findIndexL, mapWithIndex, empty, singleton, fromList, adjust, update, index, intersperse, breakl, spanl, takeWhileL, dropWhileL, tails, inits, chunksOf, zip3, zipWith3, cycleTaking, fromFunction, replicateA, replicateM, unfoldr, iterateN, viewl, viewr)
import qualified Base as B

newtype State s a = State {runState :: s -> (s, a)}

instance Functor (State s) where
    fmap = liftA

instance Monad (State s) where
    m >>= k = State $ \ s -> case runState m s of
        (s', x) -> runState (k x) s'

instance Applicative (State s) where
    pure x = State $ \ s -> (s, x)
    (<*>) = ap
    m *> n = State $ \s -> case runState m s of
      (s', _) -> runState n s'
    liftA2 = liftM2

execState :: State s a -> s -> a
execState m x = snd (runState m x)

infixr 1 :*:
data StrictPair a b = !a :*: !b

toPair :: StrictPair a b -> (a, b)
toPair (x :*: y) = (x, y)

infixr 5 ${BT}consTree${BT}
infixl 5 ${BT}snocTree${BT}
infixr 5 ${BT}appendTree0${BT}

infixr 5 ><
infixr 5 <|, :<
infixl 5 |>, :>

class Sized a where
    size :: a -> Int

class MaybeForce a where
  maybeRwhnf :: a -> ()

mseq :: MaybeForce a => a -> b -> b
mseq a b = case maybeRwhnf a of () -> b

infixr 0 $!?
($!?) :: MaybeForce a => (a -> b) -> a -> b
f $!? a = case maybeRwhnf a of () -> f a

instance MaybeForce (Elem a) where
  maybeRwhnf _ = ()

instance MaybeForce (Node a) where
  maybeRwhnf !_ = ()

newtype Seq a = Seq (FingerTree (Elem a))

instance Functor Seq where
    fmap = fmapSeq

fmapSeq :: (a -> b) -> Seq a -> Seq b
fmapSeq f (Seq xs) = Seq (fmap (fmap f) xs)

instance Foldable Seq where
    foldMap f (Seq xs) = foldMap (f . getElem) xs

    foldr f z (Seq xs) = foldr (f . getElem) z xs

    foldl f z (Seq xs) = foldl (\z' x -> f z' (getElem x)) z xs

    foldr' f z (Seq xs) = foldr' (f . getElem) z xs

    foldl' f z (Seq xs) = foldl' (\z' x -> f z' (getElem x)) z xs

    foldr1 f (Seq xs) = getElem (foldr1 f' xs)
      where f' (Elem x) (Elem y) = Elem (f x y)

    foldl1 f (Seq xs) = getElem (foldl1 f' xs)
      where f' (Elem x) (Elem y) = Elem (f x y)

    length = length
    null   = null

instance Traversable Seq where
    traverse _ (Seq EmptyT) = pure (Seq EmptyT)
    traverse f' (Seq (Single (Elem x'))) =
        (\x'' -> Seq (Single (Elem x''))) <$> f' x'
    traverse f' (Seq (Deep s' pr' m' sf')) =
        liftA3
            (\pr'' m'' sf'' -> Seq (Deep s' pr'' m'' sf''))
            (traverseDigitE f' pr')
            (traverseTree (traverseNodeE f') m')
            (traverseDigitE f' sf')
      where
        traverseTree
            :: Applicative f
            => (Node a -> f (Node b))
            -> FingerTree (Node a)
            -> f (FingerTree (Node b))
        traverseTree _ EmptyT = pure EmptyT
        traverseTree f (Single x) = Single <$> f x
        traverseTree f (Deep s pr m sf) =
            liftA3
                (Deep s)
                (traverseDigitN f pr)
                (traverseTree (traverseNodeN f) m)
                (traverseDigitN f sf)
        traverseDigitE
            :: Applicative f
            => (a -> f b) -> Digit (Elem a) -> f (Digit (Elem b))
        traverseDigitE f (One (Elem a)) =
            (\a' -> One (Elem a')) <$>
            f a
        traverseDigitE f (Two (Elem a) (Elem b)) =
            liftA2
                (\a' b' -> Two (Elem a') (Elem b'))
                (f a)
                (f b)
        traverseDigitE f (Three (Elem a) (Elem b) (Elem c)) =
            liftA3
                (\a' b' c' ->
                      Three (Elem a') (Elem b') (Elem c'))
                (f a)
                (f b)
                (f c)
        traverseDigitE f (Four (Elem a) (Elem b) (Elem c) (Elem d)) =
            liftA3
                (\a' b' c' d' -> Four (Elem a') (Elem b') (Elem c') (Elem d'))
                (f a)
                (f b)
                (f c) <*>
                (f d)
        traverseDigitN
            :: Applicative f
            => (Node a -> f (Node b)) -> Digit (Node a) -> f (Digit (Node b))
        traverseDigitN f t = traverse f t
        traverseNodeE
            :: Applicative f
            => (a -> f b) -> Node (Elem a) -> f (Node (Elem b))
        traverseNodeE f (Node2 s (Elem a) (Elem b)) =
            liftA2
                (\a' b' -> Node2 s (Elem a') (Elem b'))
                (f a)
                (f b)
        traverseNodeE f (Node3 s (Elem a) (Elem b) (Elem c)) =
            liftA3
                (\a' b' c' ->
                      Node3 s (Elem a') (Elem b') (Elem c'))
                (f a)
                (f b)
                (f c)
        traverseNodeN
            :: Applicative f
            => (Node a -> f (Node b)) -> Node (Node a) -> f (Node (Node b))
        traverseNodeN f t = traverse f t

instance Monad Seq where
    xs >>= f = foldl' add empty xs
      where add ys x = ys >< f x
    (>>) = (*>)

instance MonadFix Seq where
    mfix = mfixSeq

mfixSeq :: (a -> Seq a) -> Seq a
mfixSeq f = fromFunction (length (f err)) (\k -> fix (\xk -> f xk ${BT}index${BT} k))
  where
    err = error "mfix for Data.Sequence.Seq applied to strict function"

instance Applicative Seq where
    pure = singleton
    xs *> ys = cycleNTimes (length xs) ys
    (<*>) = apSeq
    liftA2 = liftA2Seq
    xs <* ys = beforeSeq xs ys

apSeq :: Seq (a -> b) -> Seq a -> Seq b
apSeq fs xs@(Seq xsFT) = case viewl fs of
  EmptyL -> empty
  firstf :< fs' -> case viewr fs' of
    EmptyR -> fmap firstf xs
    Seq fs''FT :> lastf -> case rigidify xsFT of
         RigidEmpty -> empty
         RigidOne (Elem x) -> fmap ($ x) fs
         RigidTwo (Elem x1) (Elem x2) ->
            Seq $ ap2FT firstf fs''FT lastf (x1, x2)
         RigidThree (Elem x1) (Elem x2) (Elem x3) ->
            Seq $ ap3FT firstf fs''FT lastf (x1, x2, x3)
         RigidFull r@(Rigid s pr _m sf) -> Seq $
               Deep (s * length fs)
                    (fmap (fmap firstf) (nodeToDigit pr))
                    (liftA2Middle (fmap firstf) (fmap lastf) fmap fs''FT r)
                    (fmap (fmap lastf) (nodeToDigit sf))

ap2FT :: (a -> b) -> FingerTree (Elem (a->b)) -> (a -> b) -> (a,a) -> FingerTree (Elem b)
ap2FT firstf fs lastf (x,y) =
                 Deep (size fs * 2 + 4)
                      (Two (Elem $ firstf x) (Elem $ firstf y))
                      (mapMulFT 2 (\(Elem f) -> Node2 2 (Elem (f x)) (Elem (f y))) fs)
                      (Two (Elem $ lastf x) (Elem $ lastf y))

ap3FT :: (a -> b) -> FingerTree (Elem (a->b)) -> (a -> b) -> (a,a,a) -> FingerTree (Elem b)
ap3FT firstf fs lastf (x,y,z) = Deep (size fs * 3 + 6)
                        (Three (Elem $ firstf x) (Elem $ firstf y) (Elem $ firstf z))
                        (mapMulFT 3 (\(Elem f) -> Node3 3 (Elem (f x)) (Elem (f y)) (Elem (f z))) fs)
                        (Three (Elem $ lastf x) (Elem $ lastf y) (Elem $ lastf z))

lift2FT :: (a -> b -> c) -> a -> FingerTree (Elem a) -> a -> (b,b) -> FingerTree (Elem c)
lift2FT f firstx xs lastx (y1,y2) =
                 Deep (size xs * 2 + 4)
                      (Two (Elem $ f firstx y1) (Elem $ f firstx y2))
                      (mapMulFT 2 (\(Elem x) -> Node2 2 (Elem (f x y1)) (Elem (f x y2))) xs)
                      (Two (Elem $ f lastx y1) (Elem $ f lastx y2))

lift3FT :: (a -> b -> c) -> a -> FingerTree (Elem a) -> a -> (b,b,b) -> FingerTree (Elem c)
lift3FT f firstx xs lastx (y1,y2,y3) =
                 Deep (size xs * 3 + 6)
                      (Three (Elem $ f firstx y1) (Elem $ f firstx y2) (Elem $ f firstx y3))
                      (mapMulFT 3 (\(Elem x) -> Node3 3 (Elem (f x y1)) (Elem (f x y2)) (Elem (f x y3))) xs)
                      (Three (Elem $ f lastx y1) (Elem $ f lastx y2) (Elem $ f lastx y3))

liftA2Seq :: (a -> b -> c) -> Seq a -> Seq b -> Seq c
liftA2Seq f xs ys@(Seq ysFT) = case viewl xs of
  EmptyL -> empty
  firstx :< xs' -> case viewr xs' of
    EmptyR -> f firstx <$> ys
    Seq xs''FT :> lastx -> case rigidify ysFT of
      RigidEmpty -> empty
      RigidOne (Elem y) -> fmap (\x -> f x y) xs
      RigidTwo (Elem y1) (Elem y2) ->
        Seq $ lift2FT f firstx xs''FT lastx (y1, y2)
      RigidThree (Elem y1) (Elem y2) (Elem y3) ->
        Seq $ lift3FT f firstx xs''FT lastx (y1, y2, y3)
      RigidFull r@(Rigid s pr _m sf) -> Seq $
        Deep (s * length xs)
             (fmap (fmap (f firstx)) (nodeToDigit pr))
             (liftA2Middle (fmap (f firstx)) (fmap (f lastx)) (lift_elem f) xs''FT r)
             (fmap (fmap (f lastx)) (nodeToDigit sf))
  where
    lift_elem :: (a -> b -> c) -> a -> Elem b -> Elem c
    lift_elem f x (Elem y) = Elem (f x y)

data Rigidified a = RigidEmpty
                  | RigidOne a
                  | RigidTwo a a
                  | RigidThree a a a
                  | RigidFull (Rigid a)

data Rigid a = Rigid !Int !(Digit23 a) (Thin (Node a)) !(Digit23 a)

data Thin a = EmptyTh
            | SingleTh a
            | DeepTh !Int !(Digit12 a) (Thin (Node a)) !(Digit12 a)

data Digit12 a = One12 a | Two12 a a

type Digit23 a = Node a

liftA2Middle
  :: (b -> c)
  -> (b -> c)
  -> (a -> b -> c)
  -> FingerTree (Elem a)
  -> Rigid b
  -> FingerTree (Node c)

liftA2Middle
    ffirstx
    flastx
    f
    midxs
    (Rigid s pr (DeepTh sm prm mm sfm) sf)
    = Deep (sm + s * (size midxs + 1))
           (fmap (fmap ffirstx) (digit12ToDigit prm))
           (liftA2Middle
               (fmap ffirstx)
               (fmap flastx)
               (fmap . f)
               midxs
               (Rigid s (squashL pr prm) mm (squashR sfm sf)))
           (fmap (fmap flastx) (digit12ToDigit sfm))

liftA2Middle
    ffirstx
    flastx
    f
    midxs
    (Rigid s pr EmptyTh sf)
    = deep
           (One (fmap ffirstx sf))
           (mapMulFT s (\(Elem x) -> fmap (fmap (f x)) converted) midxs)
           (One (fmap flastx pr))
   where converted = node2 pr sf

liftA2Middle
    ffirstx
    flastx
    f
    midxs
    (Rigid s pr (SingleTh q) sf)
    = deep
           (Two (fmap ffirstx q) (fmap ffirstx sf))
           (mapMulFT s (\(Elem x) -> fmap (fmap (f x)) converted) midxs)
           (Two (fmap flastx pr) (fmap flastx q))
   where converted = node3 pr q sf

digit12ToDigit :: Digit12 a -> Digit a
digit12ToDigit (One12 a) = One a
digit12ToDigit (Two12 a b) = Two a b

squashL :: Digit23 a -> Digit12 (Node a) -> Digit23 (Node a)
squashL m (One12 n) = node2 m n
squashL m (Two12 n1 n2) = node3 m n1 n2

squashR :: Digit12 (Node a) -> Digit23 a -> Digit23 (Node a)
squashR (One12 n) m = node2 n m
squashR (Two12 n1 n2) m = node3 n1 n2 m

mapMulFT :: Int -> (a -> b) -> FingerTree a -> FingerTree b
mapMulFT !_ _ EmptyT = EmptyT
mapMulFT _mul f (Single a) = Single (f a)
mapMulFT mul f (Deep s pr m sf) = Deep (mul * s) (fmap f pr) (mapMulFT mul (mapMulNode mul f) m) (fmap f sf)

mapMulNode :: Int -> (a -> b) -> Node a -> Node b
mapMulNode mul f (Node2 s a b)   = Node2 (mul * s) (f a) (f b)
mapMulNode mul f (Node3 s a b c) = Node3 (mul * s) (f a) (f b) (f c)

rigidify :: FingerTree (Elem a) -> Rigidified (Elem a)

rigidify EmptyT = RigidEmpty

rigidify (Single q) = RigidOne q

rigidify (Deep s (Two a b) m sf) = rigidifyRight s (node2 a b) m sf
rigidify (Deep s (Three a b c) m sf) = rigidifyRight s (node3 a b c) m sf

rigidify (Deep s (Four a b c d) m sf) = rigidifyRight s (node2 a b) (node2 c d ${BT}consTree${BT} m) sf

rigidify (Deep s (One a) m sf) = case viewLTree m of
   ConsLTree (Node2 _ b c) m' -> rigidifyRight s (node3 a b c) m' sf
   ConsLTree (Node3 _ b c d) m' -> rigidifyRight s (node2 a b) (node2 c d ${BT}consTree${BT} m') sf
   EmptyLTree -> case sf of
     One b -> RigidTwo a b
     Two b c -> RigidThree a b c
     Three b c d -> RigidFull $ Rigid s (node2 a b) EmptyTh (node2 c d)
     Four b c d e -> RigidFull $ Rigid s (node3 a b c) EmptyTh (node2 d e)

rigidifyRight :: Int -> Digit23 (Elem a) -> FingerTree (Node (Elem a)) -> Digit (Elem a) -> Rigidified (Elem a)

rigidifyRight s pr m (Two a b) = RigidFull $ Rigid s pr (thin m) (node2 a b)
rigidifyRight s pr m (Three a b c) = RigidFull $ Rigid s pr (thin m) (node3 a b c)
rigidifyRight s pr m (Four a b c d) = RigidFull $ Rigid s pr (thin $ m ${BT}snocTree${BT} node2 a b) (node2 c d)

rigidifyRight s pr m (One e) = case viewRTree m of
    SnocRTree m' (Node2 _ a b) -> RigidFull $ Rigid s pr (thin m') (node3 a b e)
    SnocRTree m' (Node3 _ a b c) -> RigidFull $ Rigid s pr (thin $ m' ${BT}snocTree${BT} node2 a b) (node2 c e)
    EmptyRTree -> case pr of
      Node2 _ a b -> RigidThree a b e
      Node3 _ a b c -> RigidFull $ Rigid s (node2 a b) EmptyTh (node2 c e)

thin :: Sized a => FingerTree a -> Thin a
thin EmptyT = EmptyTh
thin (Single a) = SingleTh a
thin (Deep s pr m sf) =
  case pr of
    One a -> thin12 s (One12 a) m sf
    Two a b -> thin12 s (Two12 a b) m sf
    Three a b c  -> thin12 s (One12 a) (node2 b c ${BT}consTree${BT} m) sf
    Four a b c d -> thin12 s (Two12 a b) (node2 c d ${BT}consTree${BT} m) sf

thin12 :: Sized a => Int -> Digit12 a -> FingerTree (Node a) -> Digit a -> Thin a
thin12 s pr m (One a) = DeepTh s pr (thin m) (One12 a)
thin12 s pr m (Two a b) = DeepTh s pr (thin m) (Two12 a b)
thin12 s pr m (Three a b c) = DeepTh s pr (thin $ m ${BT}snocTree${BT} node2 a b) (One12 c)
thin12 s pr m (Four a b c d) = DeepTh s pr (thin $ m ${BT}snocTree${BT} node2 a b) (Two12 c d)

intersperse :: a -> Seq a -> Seq a
intersperse y xs = case viewl xs of
  EmptyL -> empty
  p :< ps -> p <| (ps <**> (const y <| singleton id))

instance MonadPlus Seq where
    mzero = empty
    mplus = (><)

instance Alternative Seq where
    empty = empty
    (<|>) = (><)

-- containers defines these through Eq1 and Ord1, which this library lacks.
instance Eq a => Eq (Seq a) where
  xs == ys = sameSize xs ys && sameSizeLiftEqLists (==) (toList xs) (toList ys)

instance Ord a => Ord (Seq a) where
  compare xs ys = liftCmpLists compare (toList xs) (toList ys)

instance Show a => Show (Seq a) where
    showsPrec p xs = showParen (p > 10) $
        showString "fromList " . shows (toList xs)

sameSize :: Seq a -> Seq b -> Bool
sameSize (Seq t1) (Seq t2) = case (t1, t2) of
  (EmptyT, EmptyT) -> True
  (Single _, Single _) -> True
  (Deep v1 _ _ _, Deep v2 _ _ _) -> v1 == v2
  _ -> False

sameSizeLiftEqLists :: (a -> b -> Bool) -> [a] -> [b] -> Bool
sameSizeLiftEqLists eq = go
  where
    go (x:xs) (y:ys) = eq x y && go xs ys
    go _ _ = True

liftCmpLists :: (a -> b -> Ordering) -> [a] -> [b] -> Ordering
liftCmpLists cmp = go
  where
    go [] [] = EQ
    go [] (_:_) = LT
    go (_:_) [] = GT
    go (x:xs) (y:ys) = cmp x y <> go xs ys

instance Read a => Read (Seq a) where
    readsPrec p = readParen (p > 10) $ \ r -> do
        ("fromList",s) <- lex r
        (xs,t) <- reads s
        return (fromList xs,t)

instance Monoid (Seq a) where
    mempty = empty
    mappend = (<>)

instance Semigroup (Seq a) where
    (<>)    = (><)
    stimes = cycleNTimes . fromIntegral

data FingerTree a
    = EmptyT
    | Single a
    | Deep !Int !(Digit a) (FingerTree (Node a)) !(Digit a)

instance Sized a => Sized (FingerTree a) where
    size EmptyT             = 0
    size (Single x)         = size x
    size (Deep v _ _ _)     = v

instance Foldable FingerTree where
    foldMap _ EmptyT = mempty
    foldMap f' (Single x') = f' x'
    foldMap f' (Deep _ pr' m' sf') =
        foldMapDigit f' pr' <>
        foldMapTree (foldMapNode f') m' <>
        foldMapDigit f' sf'
      where
        foldMapTree :: Monoid m => (Node a -> m) -> FingerTree (Node a) -> m
        foldMapTree _ EmptyT = mempty
        foldMapTree f (Single x) = f x
        foldMapTree f (Deep _ pr m sf) =
            foldMapDigitN f pr <>
            foldMapTree (foldMapNodeN f) m <>
            foldMapDigitN f sf

        foldMapDigit :: Monoid m => (a -> m) -> Digit a -> m
        foldMapDigit f t = foldDigit (<>) f t

        foldMapDigitN :: Monoid m => (Node a -> m) -> Digit (Node a) -> m
        foldMapDigitN f t = foldDigit (<>) f t

        foldMapNode :: Monoid m => (a -> m) -> Node a -> m
        foldMapNode f t = foldNode (<>) f t

        foldMapNodeN :: Monoid m => (Node a -> m) -> Node (Node a) -> m
        foldMapNodeN f t = foldNode (<>) f t

    foldr _ z' EmptyT = z'
    foldr f' z' (Single x') = x' ${BT}f'${BT} z'
    foldr f' z' (Deep _ pr' m' sf') =
        foldrDigit f' (foldrTree (foldrNode f') (foldrDigit f' z' sf') m') pr'
      where
        foldrTree :: (Node a -> b -> b) -> b -> FingerTree (Node a) -> b
        foldrTree _ z EmptyT = z
        foldrTree f z (Single x) = x ${BT}f${BT} z
        foldrTree f z (Deep _ pr m sf) =
            foldrDigitN f (foldrTree (foldrNodeN f) (foldrDigitN f z sf) m) pr

        foldrDigit :: (a -> b -> b) -> b -> Digit a -> b
        foldrDigit f z t = foldr f z t

        foldrDigitN :: (Node a -> b -> b) -> b -> Digit (Node a) -> b
        foldrDigitN f z t = foldr f z t

        foldrNode :: (a -> b -> b) -> Node a -> b -> b
        foldrNode f t z = foldr f z t

        foldrNodeN :: (Node a -> b -> b) -> Node (Node a) -> b -> b
        foldrNodeN f t z = foldr f z t

    foldl _ z' EmptyT = z'
    foldl f' z' (Single x') = z' ${BT}f'${BT} x'
    foldl f' z' (Deep _ pr' m' sf') =
        foldlDigit f' (foldlTree (foldlNode f') (foldlDigit f' z' pr') m') sf'
      where
        foldlTree :: (b -> Node a -> b) -> b -> FingerTree (Node a) -> b
        foldlTree _ z EmptyT = z
        foldlTree f z (Single x) = z ${BT}f${BT} x
        foldlTree f z (Deep _ pr m sf) =
            foldlDigitN f (foldlTree (foldlNodeN f) (foldlDigitN f z pr) m) sf

        foldlDigit :: (b -> a -> b) -> b -> Digit a -> b
        foldlDigit f z t = foldl f z t

        foldlDigitN :: (b -> Node a -> b) -> b -> Digit (Node a) -> b
        foldlDigitN f z t = foldl f z t

        foldlNode :: (b -> a -> b) -> b -> Node a -> b
        foldlNode f z t = foldl f z t

        foldlNodeN :: (b -> Node a -> b) -> b -> Node (Node a) -> b
        foldlNodeN f z t = foldl f z t

    foldr' _  !z' EmptyT = z'
    foldr' f' !z' (Single x') = f' x' z'
    foldr' f' !z' (Deep _ pr' m' sf') =
        (foldrDigit' f' $! (foldrTree' (foldrNode' f') $! (foldrDigit' f' z') sf') m') pr'
      where
        foldrTree' :: (Node a -> b -> b) -> b -> FingerTree (Node a) -> b
        foldrTree' _ !z EmptyT = z
        foldrTree' f !z (Single x) = f x z
        foldrTree' f !z (Deep _ pr m sf) =
            (foldr' f $! (foldrTree' (foldrNodeN' f) $! foldr' f z sf) m) pr

        foldrDigit' :: (a -> b -> b) -> b -> Digit a -> b
        foldrDigit' f z t = foldr' f z t

        foldrNode' :: (a -> b -> b) -> Node a -> b -> b
        foldrNode' f t z = foldr' f z t

        foldrNodeN' :: (Node a -> b -> b) -> Node (Node a) -> b -> b
        foldrNodeN' f t z = foldr' f z t

    foldl' _  !z' EmptyT = z'
    foldl' f' !z' (Single x') = f' z' x'
    foldl' f' !z' (Deep _ pr' m' sf') =
        (foldlDigit' f' $!
         (foldlTree' (foldlNode' f') $! (foldlDigit' f' z') pr') m')
            sf'
      where
        foldlTree' :: (b -> Node a -> b) -> b -> FingerTree (Node a) -> b
        foldlTree' _ !z EmptyT = z
        foldlTree' f !z (Single xs) = f z xs
        foldlTree' f !z (Deep _ pr m sf) =
            (foldl' f $! (foldlTree' (foldl' f) $! foldl' f z pr) m) sf

        foldlDigit' :: (b -> a -> b) -> b -> Digit a -> b
        foldlDigit' f z t = foldl' f z t

        foldlNode' :: (b -> a -> b) -> b -> Node a -> b
        foldlNode' f z t = foldl' f z t

    foldr1 _ EmptyT = error "foldr1: empty sequence"
    foldr1 _ (Single x) = x
    foldr1 f (Deep _ pr m sf) =
        foldr f (foldr (flip (foldr f)) (foldr1 f sf) m) pr

    foldl1 _ EmptyT = error "foldl1: empty sequence"
    foldl1 _ (Single x) = x
    foldl1 f (Deep _ pr m sf) =
        foldl f (foldl (foldl f) (foldl1 f pr) m) sf

instance Functor FingerTree where
    fmap _ EmptyT = EmptyT
    fmap f (Single x) = Single (f x)
    fmap f (Deep v pr m sf) =
        Deep v (fmap f pr) (fmap (fmap f) m) (fmap f sf)

instance Traversable FingerTree where
    traverse _ EmptyT = pure EmptyT
    traverse f (Single x) = Single <$> f x
    traverse f (Deep v pr m sf) =
        liftA3 (Deep v) (traverse f pr) (traverse (traverse f) m)
            (traverse f sf)

deep            :: Sized a => Digit a -> FingerTree (Node a) -> Digit a -> FingerTree a
deep pr m sf    =  Deep (size pr + size m + size sf) pr m sf

pullL :: Int -> FingerTree (Node a) -> Digit a -> FingerTree a
pullL s m sf = case viewLTree m of
    EmptyLTree          -> digitToTree' s sf
    ConsLTree pr m'     -> Deep s (nodeToDigit pr) m' sf

pullR :: Int -> Digit a -> FingerTree (Node a) -> FingerTree a
pullR s pr m = case viewRTree m of
    EmptyRTree          -> digitToTree' s pr
    SnocRTree m' sf     -> Deep s pr m' (nodeToDigit sf)

data Digit a
    = One a
    | Two a a
    | Three a a a
    | Four a a a a

foldDigit :: (b -> b -> b) -> (a -> b) -> Digit a -> b
foldDigit _     f (One a) = f a
foldDigit (<+>) f (Two a b) = f a <+> f b
foldDigit (<+>) f (Three a b c) = f a <+> f b <+> f c
foldDigit (<+>) f (Four a b c d) = f a <+> f b <+> f c <+> f d

instance Foldable Digit where
    foldMap = foldDigit mappend

    foldr f z (One a) = a ${BT}f${BT} z
    foldr f z (Two a b) = a ${BT}f${BT} (b ${BT}f${BT} z)
    foldr f z (Three a b c) = a ${BT}f${BT} (b ${BT}f${BT} (c ${BT}f${BT} z))
    foldr f z (Four a b c d) = a ${BT}f${BT} (b ${BT}f${BT} (c ${BT}f${BT} (d ${BT}f${BT} z)))

    foldl f z (One a) = z ${BT}f${BT} a
    foldl f z (Two a b) = (z ${BT}f${BT} a) ${BT}f${BT} b
    foldl f z (Three a b c) = ((z ${BT}f${BT} a) ${BT}f${BT} b) ${BT}f${BT} c
    foldl f z (Four a b c d) = (((z ${BT}f${BT} a) ${BT}f${BT} b) ${BT}f${BT} c) ${BT}f${BT} d

    foldr' f !z (One a) = f a z
    foldr' f !z (Two a b) = f a $! f b z
    foldr' f !z (Three a b c) = f a $! f b $! f c z
    foldr' f !z (Four a b c d) = f a $! f b $! f c $! f d z

    foldl' f !z (One a) = f z a
    foldl' f !z (Two a b) = (f $! f z a) b
    foldl' f !z (Three a b c) = (f $! (f $! f z a) b) c
    foldl' f !z (Four a b c d) = (f $! (f $! (f $! f z a) b) c) d

    foldr1 _ (One a) = a
    foldr1 f (Two a b) = a ${BT}f${BT} b
    foldr1 f (Three a b c) = a ${BT}f${BT} (b ${BT}f${BT} c)
    foldr1 f (Four a b c d) = a ${BT}f${BT} (b ${BT}f${BT} (c ${BT}f${BT} d))

    foldl1 _ (One a) = a
    foldl1 f (Two a b) = a ${BT}f${BT} b
    foldl1 f (Three a b c) = (a ${BT}f${BT} b) ${BT}f${BT} c
    foldl1 f (Four a b c d) = ((a ${BT}f${BT} b) ${BT}f${BT} c) ${BT}f${BT} d

instance Functor Digit where
    fmap f (One a) = One (f a)
    fmap f (Two a b) = Two (f a) (f b)
    fmap f (Three a b c) = Three (f a) (f b) (f c)
    fmap f (Four a b c d) = Four (f a) (f b) (f c) (f d)

instance Traversable Digit where
    traverse f (One a) = One <$> f a
    traverse f (Two a b) = liftA2 Two (f a) (f b)
    traverse f (Three a b c) = liftA3 Three (f a) (f b) (f c)
    traverse f (Four a b c d) = liftA3 Four (f a) (f b) (f c) <*> f d

instance Sized a => Sized (Digit a) where
    size = foldl1 (+) . fmap size

digitToTree     :: Sized a => Digit a -> FingerTree a
digitToTree (One a) = Single a
digitToTree (Two a b) = deep (One a) EmptyT (One b)
digitToTree (Three a b c) = deep (Two a b) EmptyT (One c)
digitToTree (Four a b c d) = deep (Two a b) EmptyT (Two c d)

digitToTree' :: Int -> Digit a -> FingerTree a
digitToTree' n (Four a b c d) = Deep n (Two a b) EmptyT (Two c d)
digitToTree' n (Three a b c) = Deep n (Two a b) EmptyT (One c)
digitToTree' n (Two a b) = Deep n (One a) EmptyT (One b)
digitToTree' !_n (One a) = Single a

data Node a
    = Node2 !Int a a
    | Node3 !Int a a a

foldNode :: (b -> b -> b) -> (a -> b) -> Node a -> b
foldNode (<+>) f (Node2 _ a b) = f a <+> f b
foldNode (<+>) f (Node3 _ a b c) = f a <+> f b <+> f c

instance Foldable Node where
    foldMap = foldNode mappend

    foldr f z (Node2 _ a b) = a ${BT}f${BT} (b ${BT}f${BT} z)
    foldr f z (Node3 _ a b c) = a ${BT}f${BT} (b ${BT}f${BT} (c ${BT}f${BT} z))

    foldl f z (Node2 _ a b) = (z ${BT}f${BT} a) ${BT}f${BT} b
    foldl f z (Node3 _ a b c) = ((z ${BT}f${BT} a) ${BT}f${BT} b) ${BT}f${BT} c

    foldr' f !z (Node2 _ a b) = f a $! f b z
    foldr' f !z (Node3 _ a b c) = f a $! f b $! f c z

    foldl' f !z (Node2 _ a b) = (f $! f z a) b
    foldl' f !z (Node3 _ a b c) = (f $! (f $! f z a) b) c

instance Functor Node where
    fmap f (Node2 v a b) = Node2 v (f a) (f b)
    fmap f (Node3 v a b c) = Node3 v (f a) (f b) (f c)

instance Traversable Node where
    traverse f (Node2 v a b) = liftA2 (Node2 v) (f a) (f b)
    traverse f (Node3 v a b c) = liftA3 (Node3 v) (f a) (f b) (f c)

instance Sized (Node a) where
    size (Node2 v _ _)      = v
    size (Node3 v _ _ _)    = v

node2           :: Sized a => a -> a -> Node a
node2 a b       =  Node2 (size a + size b) a b

node3           :: Sized a => a -> a -> a -> Node a
node3 a b c     =  Node3 (size a + size b + size c) a b c

nodeToDigit :: Node a -> Digit a
nodeToDigit (Node2 _ a b) = Two a b
nodeToDigit (Node3 _ a b c) = Three a b c

newtype Elem a  =  Elem { getElem :: a }

instance Sized (Elem a) where
    size _ = 1

instance Functor Elem where
    fmap f (Elem x) = Elem (f x)

instance Foldable Elem where
    foldr f z (Elem x) = f x z
    foldMap f (Elem x) = f x
    foldl f z (Elem x) = f z x
    foldl' f z (Elem x) = f z x

instance Traversable Elem where
    traverse f (Elem x) = Elem <$> f x

applicativeTree :: Applicative f => Int -> Int -> f a -> f (FingerTree a)
applicativeTree n !mSize m = case n of
    0 -> pure EmptyT
    1 -> fmap Single m
    2 -> deepA one emptyTree one
    3 -> deepA two emptyTree one
    4 -> deepA two emptyTree two
    5 -> deepA three emptyTree two
    6 -> deepA three emptyTree three
    _ -> case n ${BT}quotRem${BT} 3 of
           (q,0) -> deepA three (applicativeTree (q - 2) mSize' n3) three
           (q,1) -> deepA two (applicativeTree (q - 1) mSize' n3) two
           (q,_) -> deepA three (applicativeTree (q - 1) mSize' n3) two
      where !mSize' = 3 * mSize
            n3 = liftA3 (Node3 mSize') m m m
  where
    one = fmap One m
    two = liftA2 Two m m
    three = liftA3 Three m m m
    deepA = liftA3 (Deep (n * mSize))
    emptyTree = pure EmptyT

data RCountMid a = RCountMid
  !(Node a)
  !Int
  !(Node a)

beforeSeq :: Seq a -> Seq b -> Seq a
beforeSeq xs ys = replicateEach (length ys) xs

replicateEach :: Int -> Seq a -> Seq a
replicateEach lenys xs = case viewl xs of
  EmptyL -> empty
  firstx :< xs' -> case viewr xs' of
    EmptyR -> replicate lenys firstx
    Seq midxs :> lastx -> case lenys of
      0 -> empty
      1 -> xs
      2 ->
        Seq $ rep2EachFT fxE midxs lxE
      3 ->
        Seq $ rep3EachFT fxE midxs lxE
      _ -> Seq $ case lenys ${BT}quotRem${BT} 3 of
             (q,0) -> Deep (lenys * length xs) fd3
               (repEachMiddle_ lift_elem (RCountMid fn3 (q - 2) ln3))
               ld3
                   where
                    lift_elem a = let n3a = n3 a in (n3a, n3a, n3a)
             (q,1) -> Deep (lenys * length xs) fd2
               (repEachMiddle_ lift_elem (RCountMid fn2 (q - 1) ln2))
               ld2
                   where
                    lift_elem a = let n2a = n2 a in (n2a, n3 a, n2a)
             (q,_) -> Deep (lenys * length xs) fd3
               (repEachMiddle_ lift_elem (RCountMid fn2 (q - 1) ln3))
               ld2
                   where
                    lift_elem a = let n3a = n3 a in (n3a, n3a, n2 a)
        where
          repEachMiddle_ = repEachMiddle midxs lenys 3 fn3 ln3
          fd2 = Two fxE fxE
          fd3 = Three fxE fxE fxE
          ld2 = Two lxE lxE
          ld3 = Three lxE lxE lxE
          fn2 = Node2 2 fxE fxE
          fn3 = Node3 3 fxE fxE fxE
          ln2 = Node2 2 lxE lxE
          ln3 = Node3 3 lxE lxE lxE
          n3 a = Node3 3 (Elem a) (Elem a) (Elem a)
          n2 a = Node2 2 (Elem a) (Elem a)
      where
          fxE = Elem firstx
          lxE = Elem lastx

rep2EachFT :: Elem a -> FingerTree (Elem a) -> Elem a -> FingerTree (Elem a)
rep2EachFT firstx xs lastx =
                 Deep (size xs * 2 + 4)
                      (Two firstx firstx)
                      (mapMulFT 2 (\ex -> Node2 2 ex ex) xs)
                      (Two lastx lastx)

rep3EachFT :: Elem a -> FingerTree (Elem a) -> Elem a -> FingerTree (Elem a)
rep3EachFT firstx xs lastx =
                 Deep (size xs * 3 + 6)
                      (Three firstx firstx firstx)
                      (mapMulFT 3 (\ex -> Node3 3 ex ex ex) xs)
                      (Three lastx lastx lastx)

repEachMiddle
  :: FingerTree (Elem a)
  -> Int
  -> Int
  -> Node c
  -> Node c
  -> (a -> (Node c, Node c, Node c))
  -> RCountMid c
  -> FingerTree (Node c)

repEachMiddle midxs lenys
            !_sizec
            _firstx
            _lastx
            fill23
            (RCountMid pr 0 sf)
     = Deep (lenys * (size midxs + 1))
            (One pr)
            (mapMulFT lenys fill23_final midxs)
            (One sf)
   where
     fill23_final (Elem a) = case fill23 a of
        ~(lft, _fill, rght) -> Node2 (size pr + size sf) lft rght

repEachMiddle midxs lenys
            !sizec
            firstx
            lastx
            fill23
            (RCountMid pr 1 sf)
     = Deep (sizec + lenys * (size midxs + 1))
            (Two pr firstx)
            (mapMulFT lenys fill23_final midxs)
            (Two lastx sf)
   where
     fill23_final (Elem a) = case fill23 a of
        ~(lft, fill, rght) -> Node3 (size pr + size sf + sizec) lft fill rght

repEachMiddle midxs lenys
            !sizec
            firstx
            lastx
            fill23
            (RCountMid pr deep_count sf)
  = case deep_count ${BT}quotRem${BT} 3 of
      (q,0)
       -> deep'
        (Two firstx firstx)
        (repEachMiddle_
           (lift_fill23 TOT3 TOT2 fill23)
           (RCountMid pr' (q - 1) sf'))
        (One lastx)
       where
        pr' = node2 firstx pr
        sf' = node3 lastx lastx sf
      (q,1)
       -> deep'
        (Two firstx firstx)
        (repEachMiddle_
           (lift_fill23 TOT3 TOT3 fill23)
           (RCountMid pr' (q - 1) sf'))
        (Two lastx lastx)
       where
        pr' = node3 firstx firstx pr
        sf' = node3 lastx lastx sf
      (q,_)
       -> deep'
        (One firstx)
        (repEachMiddle_
           (lift_fill23 TOT2 TOT2 fill23)
           (RCountMid pr' q sf'))
        (One lastx)
       where
        pr' = node2 firstx pr
        sf' = node2 lastx sf

  where
    deep' = Deep (deep_count * sizec + lenys * (size midxs + 1))
    repEachMiddle_ = repEachMiddle midxs lenys sizec' fn3 ln3
    sizec' = 3 * sizec
    fn3 = Node3 sizec' firstx firstx firstx
    ln3 = Node3 sizec' lastx lastx lastx
    spr = size pr
    ssf = size sf
    lift_fill23
      :: TwoOrThree
      -> TwoOrThree
      -> (a -> (b, b, b))
      -> a -> (Node b, Node b, Node b)
    lift_fill23 !tl !tr f a = (lft', fill', rght')
      where
        !(lft, fill, rght) = f a
        !fill' = Node3 (3 * sizec) fill fill fill
        !lft' = case tl of
          TOT2 -> Node2 (ssf + sizec) lft fill
          TOT3 -> Node3 (ssf + 2 * sizec) lft fill fill
        !rght' = case tr of
          TOT2 -> Node2 (spr + sizec) rght fill
          TOT3 -> Node3 (spr + 2 * sizec) rght fill fill

data TwoOrThree = TOT2 | TOT3

empty           :: Seq a
empty           =  Seq EmptyT

singleton       :: a -> Seq a
singleton x     =  Seq (Single (Elem x))

replicate       :: Int -> a -> Seq a
replicate n x
  | n >= 0      = runIdentity (replicateA n (Identity x))
  | otherwise   = error "replicate takes a nonnegative integer argument"

replicateA :: Applicative f => Int -> f a -> f (Seq a)
replicateA n x
  | n >= 0      = Seq <$> applicativeTree n 1 (Elem <$> x)
  | otherwise   = error "replicateA takes a nonnegative integer argument"

replicateM :: Applicative m => Int -> m a -> m (Seq a)
replicateM = replicateA

cycleTaking :: Int -> Seq a -> Seq a
cycleTaking n !_xs | n <= 0 = empty
cycleTaking _n xs  | null xs = error "cycleTaking cannot take a positive number of elements from an empty cycle."
cycleTaking n xs = cycleNTimes reps xs >< take final xs
  where
    (reps, final) = n ${BT}quotRem${BT} length xs

cycleNTimes :: Int -> Seq a -> Seq a
cycleNTimes n !xs
  | n <= 0    = empty
  | n == 1    = xs
cycleNTimes n (Seq xsFT) = case rigidify xsFT of
             RigidEmpty -> empty
             RigidOne (Elem x) -> replicate n x
             RigidTwo x1 x2 -> Seq $
               Deep (n*2) pair
                    (runIdentity $ applicativeTree (n-2) 2 (Identity (node2 x1 x2)))
                    pair
               where pair = Two x1 x2
             RigidThree x1 x2 x3 -> Seq $
               Deep (n*3) triple
                    (runIdentity $ applicativeTree (n-2) 3 (Identity (node3 x1 x2 x3)))
                    triple
               where triple = Three x1 x2 x3
             RigidFull r@(Rigid s pr _m sf) -> Seq $
                   Deep (n*s)
                        (nodeToDigit pr)
                        (cycleNMiddle (n-2) r)
                        (nodeToDigit sf)

cycleNMiddle
  :: Int
     -> Rigid c
     -> FingerTree (Node c)

cycleNMiddle !n
           (Rigid s pr (DeepTh sm prm mm sfm) sf)
    = Deep (sm + s * (n + 1))
           (digit12ToDigit prm)
           (cycleNMiddle n
                       (Rigid s (squashL pr prm) mm (squashR sfm sf)))
           (digit12ToDigit sfm)

cycleNMiddle n
           (Rigid s pr EmptyTh sf)
     = deep
            (One sf)
            (runIdentity $ applicativeTree n s (Identity converted))
            (One pr)
   where converted = node2 pr sf

cycleNMiddle n
           (Rigid s pr (SingleTh q) sf)
     = deep
            (Two q sf)
            (runIdentity $ applicativeTree n s (Identity converted))
            (Two pr q)
   where converted = node3 pr q sf

(<|)            :: a -> Seq a -> Seq a
x <| Seq xs     =  Seq (Elem x ${BT}consTree${BT} xs)

consTree        :: Sized a => a -> FingerTree a -> FingerTree a
consTree a EmptyT       = Single a
consTree a (Single b)   = deep (One a) EmptyT (One b)
consTree a (Deep s (Four b c d e) m sf) = m ${BT}seq${BT}
    Deep (size a + s) (Two a b) (node3 c d e ${BT}consTree${BT} m) sf
consTree a (Deep s (Three b c d) m sf) =
    Deep (size a + s) (Four a b c d) m sf
consTree a (Deep s (Two b c) m sf) =
    Deep (size a + s) (Three a b c) m sf
consTree a (Deep s (One b) m sf) =
    Deep (size a + s) (Two a b) m sf

cons' :: a -> Seq a -> Seq a
cons' x (Seq xs) = Seq (Elem x ${BT}consTree'${BT} xs)

snoc' :: Seq a -> a -> Seq a
snoc' (Seq xs) x = Seq (xs ${BT}snocTree'${BT} Elem x)

consTree'        :: Sized a => a -> FingerTree a -> FingerTree a
consTree' a EmptyT       = Single a
consTree' a (Single b)   = deep (One a) EmptyT (One b)
consTree' a (Deep s (Four b c d e) m sf) =
    Deep (size a + s) (Two a b) m' sf
  where !m' = abc ${BT}consTree'${BT} m
        !abc = node3 c d e
consTree' a (Deep s (Three b c d) m sf) =
    Deep (size a + s) (Four a b c d) m sf
consTree' a (Deep s (Two b c) m sf) =
    Deep (size a + s) (Three a b c) m sf
consTree' a (Deep s (One b) m sf) =
    Deep (size a + s) (Two a b) m sf

(|>)            :: Seq a -> a -> Seq a
Seq xs |> x     =  Seq (xs ${BT}snocTree${BT} Elem x)

snocTree        :: Sized a => FingerTree a -> a -> FingerTree a
snocTree EmptyT a       =  Single a
snocTree (Single a) b   =  deep (One a) EmptyT (One b)
snocTree (Deep s pr m (Four a b c d)) e = m ${BT}seq${BT}
    Deep (s + size e) pr (m ${BT}snocTree${BT} node3 a b c) (Two d e)
snocTree (Deep s pr m (Three a b c)) d =
    Deep (s + size d) pr m (Four a b c d)
snocTree (Deep s pr m (Two a b)) c =
    Deep (s + size c) pr m (Three a b c)
snocTree (Deep s pr m (One a)) b =
    Deep (s + size b) pr m (Two a b)

snocTree'        :: Sized a => FingerTree a -> a -> FingerTree a
snocTree' EmptyT a       =  Single a
snocTree' (Single a) b   =  deep (One a) EmptyT (One b)
snocTree' (Deep s pr m (Four a b c d)) e =
    Deep (s + size e) pr m' (Two d e)
  where !m' = m ${BT}snocTree'${BT} abc
        !abc = node3 a b c
snocTree' (Deep s pr m (Three a b c)) d =
    Deep (s + size d) pr m (Four a b c d)
snocTree' (Deep s pr m (Two a b)) c =
    Deep (s + size c) pr m (Three a b c)
snocTree' (Deep s pr m (One a)) b =
    Deep (s + size b) pr m (Two a b)

(><)            :: Seq a -> Seq a -> Seq a
Seq xs >< Seq ys = Seq (appendTree0 xs ys)

appendTree0 :: FingerTree (Elem a) -> FingerTree (Elem a) -> FingerTree (Elem a)
appendTree0 EmptyT xs =
    xs
appendTree0 xs EmptyT =
    xs
appendTree0 (Single x) xs =
    x ${BT}consTree${BT} xs
appendTree0 xs (Single x) =
    xs ${BT}snocTree${BT} x
appendTree0 (Deep s1 pr1 m1 sf1) (Deep s2 pr2 m2 sf2) =
    Deep (s1 + s2) pr1 m sf2
  where !m = addDigits0 m1 sf1 pr2 m2

addDigits0 :: FingerTree (Node (Elem a)) -> Digit (Elem a) -> Digit (Elem a) -> FingerTree (Node (Elem a)) -> FingerTree (Node (Elem a))
addDigits0 m1 (One a) (One b) m2 =
    appendTree1 m1 (node2 a b) m2
addDigits0 m1 (One a) (Two b c) m2 =
    appendTree1 m1 (node3 a b c) m2
addDigits0 m1 (One a) (Three b c d) m2 =
    appendTree2 m1 (node2 a b) (node2 c d) m2
addDigits0 m1 (One a) (Four b c d e) m2 =
    appendTree2 m1 (node3 a b c) (node2 d e) m2
addDigits0 m1 (Two a b) (One c) m2 =
    appendTree1 m1 (node3 a b c) m2
addDigits0 m1 (Two a b) (Two c d) m2 =
    appendTree2 m1 (node2 a b) (node2 c d) m2
addDigits0 m1 (Two a b) (Three c d e) m2 =
    appendTree2 m1 (node3 a b c) (node2 d e) m2
addDigits0 m1 (Two a b) (Four c d e f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits0 m1 (Three a b c) (One d) m2 =
    appendTree2 m1 (node2 a b) (node2 c d) m2
addDigits0 m1 (Three a b c) (Two d e) m2 =
    appendTree2 m1 (node3 a b c) (node2 d e) m2
addDigits0 m1 (Three a b c) (Three d e f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits0 m1 (Three a b c) (Four d e f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits0 m1 (Four a b c d) (One e) m2 =
    appendTree2 m1 (node3 a b c) (node2 d e) m2
addDigits0 m1 (Four a b c d) (Two e f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits0 m1 (Four a b c d) (Three e f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits0 m1 (Four a b c d) (Four e f g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2

appendTree1 :: FingerTree (Node a) -> Node a -> FingerTree (Node a) -> FingerTree (Node a)
appendTree1 EmptyT !a xs =
    a ${BT}consTree${BT} xs
appendTree1 xs !a EmptyT =
    xs ${BT}snocTree${BT} a
appendTree1 (Single x) !a xs =
    x ${BT}consTree${BT} a ${BT}consTree${BT} xs
appendTree1 xs !a (Single x) =
    xs ${BT}snocTree${BT} a ${BT}snocTree${BT} x
appendTree1 (Deep s1 pr1 m1 sf1) a (Deep s2 pr2 m2 sf2) =
    Deep (s1 + size a + s2) pr1 m sf2
  where !m = addDigits1 m1 sf1 a pr2 m2

addDigits1 :: FingerTree (Node (Node a)) -> Digit (Node a) -> Node a -> Digit (Node a) -> FingerTree (Node (Node a)) -> FingerTree (Node (Node a))
addDigits1 m1 (One a) b (One c) m2 =
    appendTree1 m1 (node3 a b c) m2
addDigits1 m1 (One a) b (Two c d) m2 =
    appendTree2 m1 (node2 a b) (node2 c d) m2
addDigits1 m1 (One a) b (Three c d e) m2 =
    appendTree2 m1 (node3 a b c) (node2 d e) m2
addDigits1 m1 (One a) b (Four c d e f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits1 m1 (Two a b) c (One d) m2 =
    appendTree2 m1 (node2 a b) (node2 c d) m2
addDigits1 m1 (Two a b) c (Two d e) m2 =
    appendTree2 m1 (node3 a b c) (node2 d e) m2
addDigits1 m1 (Two a b) c (Three d e f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits1 m1 (Two a b) c (Four d e f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits1 m1 (Three a b c) d (One e) m2 =
    appendTree2 m1 (node3 a b c) (node2 d e) m2
addDigits1 m1 (Three a b c) d (Two e f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits1 m1 (Three a b c) d (Three e f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits1 m1 (Three a b c) d (Four e f g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits1 m1 (Four a b c d) e (One f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits1 m1 (Four a b c d) e (Two f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits1 m1 (Four a b c d) e (Three f g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits1 m1 (Four a b c d) e (Four f g h i) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node3 g h i) m2

appendTree2 :: FingerTree (Node a) -> Node a -> Node a -> FingerTree (Node a) -> FingerTree (Node a)
appendTree2 EmptyT !a !b xs =
    a ${BT}consTree${BT} b ${BT}consTree${BT} xs
appendTree2 xs !a !b EmptyT =
    xs ${BT}snocTree${BT} a ${BT}snocTree${BT} b
appendTree2 (Single x) a b xs =
    x ${BT}consTree${BT} a ${BT}consTree${BT} b ${BT}consTree${BT} xs
appendTree2 xs a b (Single x) =
    xs ${BT}snocTree${BT} a ${BT}snocTree${BT} b ${BT}snocTree${BT} x
appendTree2 (Deep s1 pr1 m1 sf1) a b (Deep s2 pr2 m2 sf2) =
    Deep (s1 + size a + size b + s2) pr1 m sf2
  where !m = addDigits2 m1 sf1 a b pr2 m2

addDigits2 :: FingerTree (Node (Node a)) -> Digit (Node a) -> Node a -> Node a -> Digit (Node a) -> FingerTree (Node (Node a)) -> FingerTree (Node (Node a))
addDigits2 m1 (One a) b c (One d) m2 =
    appendTree2 m1 (node2 a b) (node2 c d) m2
addDigits2 m1 (One a) b c (Two d e) m2 =
    appendTree2 m1 (node3 a b c) (node2 d e) m2
addDigits2 m1 (One a) b c (Three d e f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits2 m1 (One a) b c (Four d e f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits2 m1 (Two a b) c d (One e) m2 =
    appendTree2 m1 (node3 a b c) (node2 d e) m2
addDigits2 m1 (Two a b) c d (Two e f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits2 m1 (Two a b) c d (Three e f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits2 m1 (Two a b) c d (Four e f g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits2 m1 (Three a b c) d e (One f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits2 m1 (Three a b c) d e (Two f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits2 m1 (Three a b c) d e (Three f g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits2 m1 (Three a b c) d e (Four f g h i) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node3 g h i) m2
addDigits2 m1 (Four a b c d) e f (One g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits2 m1 (Four a b c d) e f (Two g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits2 m1 (Four a b c d) e f (Three g h i) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node3 g h i) m2
addDigits2 m1 (Four a b c d) e f (Four g h i j) m2 =
    appendTree4 m1 (node3 a b c) (node3 d e f) (node2 g h) (node2 i j) m2

appendTree3 :: FingerTree (Node a) -> Node a -> Node a -> Node a -> FingerTree (Node a) -> FingerTree (Node a)
appendTree3 EmptyT !a !b !c xs =
    a ${BT}consTree${BT} b ${BT}consTree${BT} c ${BT}consTree${BT} xs
appendTree3 xs !a !b !c EmptyT =
    xs ${BT}snocTree${BT} a ${BT}snocTree${BT} b ${BT}snocTree${BT} c
appendTree3 (Single x) a b c xs =
    x ${BT}consTree${BT} a ${BT}consTree${BT} b ${BT}consTree${BT} c ${BT}consTree${BT} xs
appendTree3 xs a b c (Single x) =
    xs ${BT}snocTree${BT} a ${BT}snocTree${BT} b ${BT}snocTree${BT} c ${BT}snocTree${BT} x
appendTree3 (Deep s1 pr1 m1 sf1) a b c (Deep s2 pr2 m2 sf2) =
    Deep (s1 + size a + size b + size c + s2) pr1 m sf2
  where !m = addDigits3 m1 sf1 a b c pr2 m2

addDigits3 :: FingerTree (Node (Node a)) -> Digit (Node a) -> Node a -> Node a -> Node a -> Digit (Node a) -> FingerTree (Node (Node a)) -> FingerTree (Node (Node a))
addDigits3 m1 (One a) !b !c !d (One e) m2 =
    appendTree2 m1 (node3 a b c) (node2 d e) m2
addDigits3 m1 (One a) b c d (Two e f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits3 m1 (One a) b c d (Three e f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits3 m1 (One a) b c d (Four e f g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits3 m1 (Two a b) !c !d !e (One f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits3 m1 (Two a b) c d e (Two f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits3 m1 (Two a b) c d e (Three f g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits3 m1 (Two a b) c d e (Four f g h i) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node3 g h i) m2
addDigits3 m1 (Three a b c) !d !e !f (One g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits3 m1 (Three a b c) d e f (Two g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits3 m1 (Three a b c) d e f (Three g h i) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node3 g h i) m2
addDigits3 m1 (Three a b c) d e f (Four g h i j) m2 =
    appendTree4 m1 (node3 a b c) (node3 d e f) (node2 g h) (node2 i j) m2
addDigits3 m1 (Four a b c d) !e !f !g (One h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits3 m1 (Four a b c d) e f g (Two h i) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node3 g h i) m2
addDigits3 m1 (Four a b c d) e f g (Three h i j) m2 =
    appendTree4 m1 (node3 a b c) (node3 d e f) (node2 g h) (node2 i j) m2
addDigits3 m1 (Four a b c d) e f g (Four h i j k) m2 =
    appendTree4 m1 (node3 a b c) (node3 d e f) (node3 g h i) (node2 j k) m2

appendTree4 :: FingerTree (Node a) -> Node a -> Node a -> Node a -> Node a -> FingerTree (Node a) -> FingerTree (Node a)
appendTree4 EmptyT !a !b !c !d xs =
    a ${BT}consTree${BT} b ${BT}consTree${BT} c ${BT}consTree${BT} d ${BT}consTree${BT} xs
appendTree4 xs !a !b !c !d EmptyT =
    xs ${BT}snocTree${BT} a ${BT}snocTree${BT} b ${BT}snocTree${BT} c ${BT}snocTree${BT} d
appendTree4 (Single x) a b c d xs =
    x ${BT}consTree${BT} a ${BT}consTree${BT} b ${BT}consTree${BT} c ${BT}consTree${BT} d ${BT}consTree${BT} xs
appendTree4 xs a b c d (Single x) =
    xs ${BT}snocTree${BT} a ${BT}snocTree${BT} b ${BT}snocTree${BT} c ${BT}snocTree${BT} d ${BT}snocTree${BT} x
appendTree4 (Deep s1 pr1 m1 sf1) a b c d (Deep s2 pr2 m2 sf2) =
    Deep (s1 + size a + size b + size c + size d + s2) pr1 m sf2
  where !m = addDigits4 m1 sf1 a b c d pr2 m2

addDigits4 :: FingerTree (Node (Node a)) -> Digit (Node a) -> Node a -> Node a -> Node a -> Node a -> Digit (Node a) -> FingerTree (Node (Node a)) -> FingerTree (Node (Node a))
addDigits4 m1 (One a) !b !c !d !e (One f) m2 =
    appendTree2 m1 (node3 a b c) (node3 d e f) m2
addDigits4 m1 (One a) b c d e (Two f g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits4 m1 (One a) b c d e (Three f g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits4 m1 (One a) b c d e (Four f g h i) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node3 g h i) m2
addDigits4 m1 (Two a b) !c !d !e !f (One g) m2 =
    appendTree3 m1 (node3 a b c) (node2 d e) (node2 f g) m2
addDigits4 m1 (Two a b) c d e f (Two g h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits4 m1 (Two a b) c d e f (Three g h i) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node3 g h i) m2
addDigits4 m1 (Two a b) c d e f (Four g h i j) m2 =
    appendTree4 m1 (node3 a b c) (node3 d e f) (node2 g h) (node2 i j) m2
addDigits4 m1 (Three a b c) !d !e !f !g (One h) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node2 g h) m2
addDigits4 m1 (Three a b c) d e f g (Two h i) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node3 g h i) m2
addDigits4 m1 (Three a b c) d e f g (Three h i j) m2 =
    appendTree4 m1 (node3 a b c) (node3 d e f) (node2 g h) (node2 i j) m2
addDigits4 m1 (Three a b c) d e f g (Four h i j k) m2 =
    appendTree4 m1 (node3 a b c) (node3 d e f) (node3 g h i) (node2 j k) m2
addDigits4 m1 (Four a b c d) !e !f !g !h (One i) m2 =
    appendTree3 m1 (node3 a b c) (node3 d e f) (node3 g h i) m2
addDigits4 m1 (Four a b c d) !e !f !g !h (Two i j) m2 =
    appendTree4 m1 (node3 a b c) (node3 d e f) (node2 g h) (node2 i j) m2
addDigits4 m1 (Four a b c d) !e !f !g !h (Three i j k) m2 =
    appendTree4 m1 (node3 a b c) (node3 d e f) (node3 g h i) (node2 j k) m2
addDigits4 m1 (Four a b c d) !e !f !g !h (Four i j k l) m2 =
    appendTree4 m1 (node3 a b c) (node3 d e f) (node3 g h i) (node3 j k l) m2

unfoldr :: (b -> Maybe (a, b)) -> b -> Seq a
unfoldr f = unfoldr' empty
  where unfoldr' !as b = maybe as (\ (a, b') -> unfoldr' (as ${BT}snoc'${BT} a) b') (f b)

unfoldl :: (b -> Maybe (b, a)) -> b -> Seq a
unfoldl f = unfoldl' empty
  where unfoldl' !as b = maybe as (\ (b', a) -> unfoldl' (a ${BT}cons'${BT} as) b') (f b)

iterateN :: Int -> (a -> a) -> a -> Seq a
iterateN n f x
  | n >= 0      = replicateA n (State (\ y -> (f y, y))) ${BT}execState${BT} x
  | otherwise   = error "iterateN takes a nonnegative integer argument"

null            :: Seq a -> Bool
null (Seq EmptyT) = True
null _            =  False

length          :: Seq a -> Int
length (Seq xs) =  size xs

data ViewLTree a = ConsLTree a (FingerTree a) | EmptyLTree
data ViewRTree a = SnocRTree (FingerTree a) a | EmptyRTree

data ViewL a
    = EmptyL
    | a :< Seq a
    deriving (Eq, Ord, Show, Read)

instance Functor ViewL where
    fmap _ EmptyL       = EmptyL
    fmap f (x :< xs)    = f x :< fmap f xs

instance Foldable ViewL where
    foldMap _ EmptyL = mempty
    foldMap f (x :< xs) = f x <> foldMap f xs

    foldr _ z EmptyL = z
    foldr f z (x :< xs) = f x (foldr f z xs)

    foldl _ z EmptyL = z
    foldl f z (x :< xs) = foldl f (f z x) xs

    foldl1 _ EmptyL = error "foldl1: empty view"
    foldl1 f (x :< xs) = foldl f x xs

    null EmptyL = True
    null (_ :< _) = False

    length EmptyL = 0
    length (_ :< xs) = 1 + length xs

instance Traversable ViewL where
    traverse _ EmptyL       = pure EmptyL
    traverse f (x :< xs)    = liftA2 (:<) (f x) (traverse f xs)

viewl           ::  Seq a -> ViewL a
viewl (Seq xs)  =  case viewLTree xs of
    EmptyLTree -> EmptyL
    ConsLTree (Elem x) xs' -> x :< Seq xs'

viewLTree       :: Sized a => FingerTree a -> ViewLTree a
viewLTree EmptyT                = EmptyLTree
viewLTree (Single a)            = ConsLTree a EmptyT
viewLTree (Deep s (One a) m sf) = ConsLTree a (pullL (s - size a) m sf)
viewLTree (Deep s (Two a b) m sf) =
    ConsLTree a (Deep (s - size a) (One b) m sf)
viewLTree (Deep s (Three a b c) m sf) =
    ConsLTree a (Deep (s - size a) (Two b c) m sf)
viewLTree (Deep s (Four a b c d) m sf) =
    ConsLTree a (Deep (s - size a) (Three b c d) m sf)

data ViewR a
    = EmptyR
    | Seq a :> a
    deriving (Eq, Ord, Show, Read)

instance Functor ViewR where
    fmap _ EmptyR       = EmptyR
    fmap f (xs :> x)    = fmap f xs :> f x

instance Foldable ViewR where
    foldMap _ EmptyR = mempty
    foldMap f (xs :> x) = foldMap f xs <> f x

    foldr _ z EmptyR = z
    foldr f z (xs :> x) = foldr f (f x z) xs

    foldl _ z EmptyR = z
    foldl f z (xs :> x) = foldl f z xs ${BT}f${BT} x

    foldr1 _ EmptyR = error "foldr1: empty view"
    foldr1 f (xs :> x) = foldr f x xs

    null EmptyR = True
    null (_ :> _) = False

    length EmptyR = 0
    length (xs :> _) = length xs + 1

instance Traversable ViewR where
    traverse _ EmptyR       = pure EmptyR
    traverse f (xs :> x)    = liftA2 (:>) (traverse f xs) (f x)

viewr           ::  Seq a -> ViewR a
viewr (Seq xs)  =  case viewRTree xs of
    EmptyRTree -> EmptyR
    SnocRTree xs' (Elem x) -> Seq xs' :> x

viewRTree       :: Sized a => FingerTree a -> ViewRTree a
viewRTree EmptyT                = EmptyRTree
viewRTree (Single z)            = SnocRTree EmptyT z
viewRTree (Deep s pr m (One z)) = SnocRTree (pullR (s - size z) pr m) z
viewRTree (Deep s pr m (Two y z)) =
    SnocRTree (Deep (s - size z) pr m (One y)) z
viewRTree (Deep s pr m (Three x y z)) =
    SnocRTree (Deep (s - size z) pr m (Two x y)) z
viewRTree (Deep s pr m (Four w x y z)) =
    SnocRTree (Deep (s - size z) pr m (Three w x y)) z

scanl :: (a -> b -> a) -> a -> Seq b -> Seq a
scanl f z0 xs = z0 <| snd (mapAccumL (\ x z -> let x' = f x z in (x', x')) z0 xs)

index           :: Seq a -> Int -> a
index (Seq xs) i
  | fromIntegral i < (fromIntegral (size xs) :: Word) = case lookupTree i xs of
                Place _ (Elem x) -> x
  | otherwise   =
      error $ "index out of bounds in call to: Data.Sequence.index " ++ show i

lookup            :: Int -> Seq a -> Maybe a
lookup i (Seq xs)
  | fromIntegral i < (fromIntegral (size xs) :: Word) = case lookupTree i xs of
                Place _ (Elem x) -> Just x
  | otherwise = Nothing

(!?) ::           Seq a -> Int -> Maybe a
(!?) = flip lookup

data Place a = Place !Int a

lookupTree :: Sized a => Int -> FingerTree a -> Place a
lookupTree !_ EmptyT = error "lookupTree of empty tree"
lookupTree i (Single x) = Place i x
lookupTree i (Deep _ pr m sf)
  | i < spr     =  lookupDigit i pr
  | i < spm     =  case lookupTree (i - spr) m of
                   Place i' xs -> lookupNode i' xs
  | otherwise   =  lookupDigit (i - spm) sf
  where
    spr     = size pr
    spm     = spr + size m

lookupNode :: Sized a => Int -> Node a -> Place a
lookupNode i (Node2 _ a b)
  | i < sa      = Place i a
  | otherwise   = Place (i - sa) b
  where
    sa      = size a
lookupNode i (Node3 _ a b c)
  | i < sa      = Place i a
  | i < sab     = Place (i - sa) b
  | otherwise   = Place (i - sab) c
  where
    sa      = size a
    sab     = sa + size b

lookupDigit :: Sized a => Int -> Digit a -> Place a
lookupDigit i (One a) = Place i a
lookupDigit i (Two a b)
  | i < sa      = Place i a
  | otherwise   = Place (i - sa) b
  where
    sa      = size a
lookupDigit i (Three a b c)
  | i < sa      = Place i a
  | i < sab     = Place (i - sa) b
  | otherwise   = Place (i - sab) c
  where
    sa      = size a
    sab     = sa + size b
lookupDigit i (Four a b c d)
  | i < sa      = Place i a
  | i < sab     = Place (i - sa) b
  | i < sabc    = Place (i - sab) c
  | otherwise   = Place (i - sabc) d
  where
    sa      = size a
    sab     = sa + size b
    sabc    = sab + size c

update          :: Int -> a -> Seq a -> Seq a
update i x (Seq xs)
  | fromIntegral i < (fromIntegral (size xs) :: Word) = Seq (updateTree (Elem x) i xs)
  | otherwise   = Seq xs

updateTree      :: Elem a -> Int -> FingerTree (Elem a) -> FingerTree (Elem a)
updateTree _ !_ EmptyT = EmptyT
updateTree v _i (Single _) = Single v
updateTree v i (Deep s pr m sf)
  | i < spr     = Deep s (updateDigit v i pr) m sf
  | i < spm     = let !m' = adjustTree (updateNode v) (i - spr) m
                  in Deep s pr m' sf
  | otherwise   = Deep s pr m (updateDigit v (i - spm) sf)
  where
    spr     = size pr
    spm     = spr + size m

updateNode      :: Elem a -> Int -> Node (Elem a) -> Node (Elem a)
updateNode v i (Node2 s a b)
  | i < sa      = Node2 s v b
  | otherwise   = Node2 s a v
  where
    sa      = size a
updateNode v i (Node3 s a b c)
  | i < sa      = Node3 s v b c
  | i < sab     = Node3 s a v c
  | otherwise   = Node3 s a b v
  where
    sa      = size a
    sab     = sa + size b

updateDigit     :: Elem a -> Int -> Digit (Elem a) -> Digit (Elem a)
updateDigit v !_i (One _) = One v
updateDigit v i (Two a b)
  | i < sa      = Two v b
  | otherwise   = Two a v
  where
    sa      = size a
updateDigit v i (Three a b c)
  | i < sa      = Three v b c
  | i < sab     = Three a v c
  | otherwise   = Three a b v
  where
    sa      = size a
    sab     = sa + size b
updateDigit v i (Four a b c d)
  | i < sa      = Four v b c d
  | i < sab     = Four a v c d
  | i < sabc    = Four a b v d
  | otherwise   = Four a b c v
  where
    sa      = size a
    sab     = sa + size b
    sabc    = sab + size c

adjust          :: (a -> a) -> Int -> Seq a -> Seq a
adjust f i (Seq xs)
  | fromIntegral i < (fromIntegral (size xs) :: Word) = Seq (adjustTree (${BT}seq${BT} fmap f) i xs)
  | otherwise   = Seq xs

adjust'          :: (a -> a) -> Int -> Seq a -> Seq a
adjust' f i xs =
  case xs !? i of
    Nothing -> xs
    Just x -> let !x' = f x
              in update i x' xs

adjustTree      :: (Sized a, MaybeForce a) => (Int -> a -> a) ->
             Int -> FingerTree a -> FingerTree a
adjustTree _ !_ EmptyT = EmptyT
adjustTree f i (Single x) = Single $!? f i x
adjustTree f i (Deep s pr m sf)
  | i < spr     = Deep s (adjustDigit f i pr) m sf
  | i < spm     = let !m' = adjustTree (adjustNode f) (i - spr) m
                  in Deep s pr m' sf
  | otherwise   = Deep s pr m (adjustDigit f (i - spm) sf)
  where
    spr     = size pr
    spm     = spr + size m

adjustNode      :: (Sized a, MaybeForce a) => (Int -> a -> a) -> Int -> Node a -> Node a
adjustNode f i (Node2 s a b)
  | i < sa      = let fia = f i a in fia ${BT}mseq${BT} Node2 s fia b
  | otherwise   = let fisab = f (i - sa) b in fisab ${BT}mseq${BT} Node2 s a fisab
  where
    sa      = size a
adjustNode f i (Node3 s a b c)
  | i < sa      = let fia = f i a in fia ${BT}mseq${BT} Node3 s fia b c
  | i < sab     = let fisab = f (i - sa) b in fisab ${BT}mseq${BT} Node3 s a fisab c
  | otherwise   = let fisabc = f (i - sab) c in fisabc ${BT}mseq${BT} Node3 s a b fisabc
  where
    sa      = size a
    sab     = sa + size b

adjustDigit     :: (Sized a, MaybeForce a) => (Int -> a -> a) -> Int -> Digit a -> Digit a
adjustDigit f !i (One a) = One $!? f i a
adjustDigit f i (Two a b)
  | i < sa      = let fia = f i a in fia ${BT}mseq${BT} Two fia b
  | otherwise   = let fisab = f (i - sa) b in fisab ${BT}mseq${BT} Two a fisab
  where
    sa      = size a
adjustDigit f i (Three a b c)
  | i < sa      = let fia = f i a in fia ${BT}mseq${BT} Three fia b c
  | i < sab     = let fisab = f (i - sa) b in fisab ${BT}mseq${BT} Three a fisab c
  | otherwise   = let fisabc = f (i - sab) c in fisabc ${BT}mseq${BT} Three a b fisabc
  where
    sa      = size a
    sab     = sa + size b
adjustDigit f i (Four a b c d)
  | i < sa      = let fia = f i a in fia ${BT}mseq${BT} Four fia b c d
  | i < sab     = let fisab = f (i - sa) b in fisab ${BT}mseq${BT} Four a fisab c d
  | i < sabc    = let fisabc = f (i - sab) c in fisabc ${BT}mseq${BT} Four a b fisabc d
  | otherwise   = let fisabcd = f (i - sabc) d in fisabcd ${BT}mseq${BT} Four a b c fisabcd
  where
    sa      = size a
    sab     = sa + size b
    sabc    = sab + size c

insertAt :: Int -> a -> Seq a -> Seq a
insertAt i a s@(Seq xs)
  | fromIntegral i < (fromIntegral (size xs) :: Word)
      = Seq (insTree (${BT}seq${BT} InsTwo (Elem a)) i xs)
  | i <= 0 = a <| s
  | otherwise = s |> a

data Ins a = InsOne a | InsTwo a a

insTree      :: Sized a => (Int -> a -> Ins a) ->
             Int -> FingerTree a -> FingerTree a
insTree _ !_ EmptyT = EmptyT
insTree f i (Single x) = case f i x of
  InsOne x' -> Single x'
  InsTwo m n -> deep (One m) EmptyT (One n)
insTree f i (Deep s pr m sf)
  | i < spr     = case insLeftDigit f i pr of
     InsLeftDig pr' -> Deep (s + 1) pr' m sf
     InsDigNode pr' n -> m ${BT}seq${BT} Deep (s + 1) pr' (n ${BT}consTree${BT} m) sf
  | i < spm     = let !m' = insTree (insNode f) (i - spr) m
                  in Deep (s + 1) pr m' sf
  | otherwise   = case insRightDigit f (i - spm) sf of
     InsRightDig sf' -> Deep (s + 1) pr m sf'
     InsNodeDig n sf' -> m ${BT}seq${BT} Deep (s + 1) pr (m ${BT}snocTree${BT} n) sf'
  where
    spr     = size pr
    spm     = spr + size m

insNode :: Sized a => (Int -> a -> Ins a) -> Int -> Node a -> Ins (Node a)
insNode f i (Node2 s a b)
  | i < sa = case f i a of
      InsOne n -> InsOne $ Node2 (s + 1) n b
      InsTwo m n -> InsOne $ Node3 (s + 1) m n b
  | otherwise = case f (i - sa) b of
      InsOne n -> InsOne $ Node2 (s + 1) a n
      InsTwo m n -> InsOne $ Node3 (s + 1) a m n
  where sa = size a
insNode f i (Node3 s a b c)
  | i < sa = case f i a of
      InsOne n -> InsOne $ Node3 (s + 1) n b c
      InsTwo m n -> InsTwo (Node2 (sa + 1) m n) (Node2 (s - sa) b c)
  | i < sab = case f (i - sa) b of
      InsOne n -> InsOne $ Node3 (s + 1) a n c
      InsTwo m n -> InsTwo am nc
        where !am = node2 a m
              !nc = node2 n c
  | otherwise = case f (i - sab) c of
      InsOne n -> InsOne $ Node3 (s + 1) a b n
      InsTwo m n -> InsTwo (Node2 sab a b) (Node2 (s - sab + 1) m n)
  where sa = size a
        sab = sa + size b

data InsDigNode a = InsLeftDig !(Digit a) | InsDigNode !(Digit a) !(Node a)
insLeftDigit :: Sized a => (Int -> a -> Ins a) -> Int -> Digit a -> InsDigNode a
insLeftDigit f !i (One a) = case f i a of
  InsOne a' -> InsLeftDig $ One a'
  InsTwo a1 a2 -> InsLeftDig $ Two a1 a2
insLeftDigit f i (Two a b)
  | i < sa = case f i a of
     InsOne a' -> InsLeftDig $ Two a' b
     InsTwo a1 a2 -> InsLeftDig $ Three a1 a2 b
  | otherwise = case f (i - sa) b of
     InsOne b' -> InsLeftDig $ Two a b'
     InsTwo b1 b2 -> InsLeftDig $ Three a b1 b2
  where sa = size a
insLeftDigit f i (Three a b c)
  | i < sa = case f i a of
     InsOne a' -> InsLeftDig $ Three a' b c
     InsTwo a1 a2 -> InsLeftDig $ Four a1 a2 b c
  | i < sab = case f (i - sa) b of
     InsOne b' -> InsLeftDig $ Three a b' c
     InsTwo b1 b2 -> InsLeftDig $ Four a b1 b2 c
  | otherwise = case f (i - sab) c of
     InsOne c' -> InsLeftDig $ Three a b c'
     InsTwo c1 c2 -> InsLeftDig $ Four a b c1 c2
  where sa = size a
        sab = sa + size b
insLeftDigit f i (Four a b c d)
  | i < sa = case f i a of
     InsOne a' -> InsLeftDig $ Four a' b c d
     InsTwo a1 a2 -> InsDigNode (Two a1 a2) (node3 b c d)
  | i < sab = case f (i - sa) b of
     InsOne b' -> InsLeftDig $ Four a b' c d
     InsTwo b1 b2 -> InsDigNode (Two a b1) (node3 b2 c d)
  | i < sabc = case f (i - sab) c of
     InsOne c' -> InsLeftDig $ Four a b c' d
     InsTwo c1 c2 -> InsDigNode (Two a b) (node3 c1 c2 d)
  | otherwise = case f (i - sabc) d of
     InsOne d' -> InsLeftDig $ Four a b c d'
     InsTwo d1 d2 -> InsDigNode (Two a b) (node3 c d1 d2)
  where sa = size a
        sab = sa + size b
        sabc = sab + size c

data InsNodeDig a = InsRightDig !(Digit a) | InsNodeDig !(Node a) !(Digit a)
insRightDigit :: Sized a => (Int -> a -> Ins a) -> Int -> Digit a -> InsNodeDig a
insRightDigit f !i (One a) = case f i a of
  InsOne a' -> InsRightDig $ One a'
  InsTwo a1 a2 -> InsRightDig $ Two a1 a2
insRightDigit f i (Two a b)
  | i < sa = case f i a of
     InsOne a' -> InsRightDig $ Two a' b
     InsTwo a1 a2 -> InsRightDig $ Three a1 a2 b
  | otherwise = case f (i - sa) b of
     InsOne b' -> InsRightDig $ Two a b'
     InsTwo b1 b2 -> InsRightDig $ Three a b1 b2
  where sa = size a
insRightDigit f i (Three a b c)
  | i < sa = case f i a of
     InsOne a' -> InsRightDig $ Three a' b c
     InsTwo a1 a2 -> InsRightDig $ Four a1 a2 b c
  | i < sab = case f (i - sa) b of
     InsOne b' -> InsRightDig $ Three a b' c
     InsTwo b1 b2 -> InsRightDig $ Four a b1 b2 c
  | otherwise = case f (i - sab) c of
     InsOne c' -> InsRightDig $ Three a b c'
     InsTwo c1 c2 -> InsRightDig $ Four a b c1 c2
  where sa = size a
        sab = sa + size b
insRightDigit f i (Four a b c d)
  | i < sa = case f i a of
     InsOne a' -> InsRightDig $ Four a' b c d
     InsTwo a1 a2 -> InsNodeDig (node3 a1 a2 b) (Two c d)
  | i < sab = case f (i - sa) b of
     InsOne b' -> InsRightDig $ Four a b' c d
     InsTwo b1 b2 -> InsNodeDig (node3 a b1 b2) (Two c d)
  | i < sabc = case f (i - sab) c of
     InsOne c' -> InsRightDig $ Four a b c' d
     InsTwo c1 c2 -> InsNodeDig (node3 a b c1) (Two c2 d)
  | otherwise = case f (i - sabc) d of
     InsOne d' -> InsRightDig $ Four a b c d'
     InsTwo d1 d2 -> InsNodeDig (node3 a b c) (Two d1 d2)
  where sa = size a
        sab = sa + size b
        sabc = sab + size c

deleteAt :: Int -> Seq a -> Seq a
deleteAt i (Seq xs)
  | fromIntegral i < (fromIntegral (size xs) :: Word) = Seq $ delTreeE i xs
  | otherwise = Seq xs

delTreeE :: Int -> FingerTree (Elem a) -> FingerTree (Elem a)
delTreeE !_i EmptyT = EmptyT
delTreeE _i Single{} = EmptyT
delTreeE i (Deep s pr m sf)
  | i < spr = delLeftDigitE i s pr m sf
  | i < spm = case delTree delNodeE (i - spr) m of
     FullTree m' -> Deep (s - 1) pr m' sf
     DefectTree e -> delRebuildMiddle (s - 1) pr e sf
  | otherwise = delRightDigitE (i - spm) s pr m sf
  where spr = size pr
        spm = spr + size m

delNodeE :: Int -> Node (Elem a) -> Del (Elem a)
delNodeE i (Node3 _ a b c) = case i of
  0 -> Full $ Node2 2 b c
  1 -> Full $ Node2 2 a c
  _ -> Full $ Node2 2 a b
delNodeE i (Node2 _ a b) = case i of
  0 -> Defect b
  _ -> Defect a

delLeftDigitE :: Int -> Int -> Digit (Elem a) -> FingerTree (Node (Elem a)) -> Digit (Elem a) -> FingerTree (Elem a)
delLeftDigitE !_i s One{} m sf = pullL (s - 1) m sf
delLeftDigitE i s (Two a b) m sf
  | i == 0 = Deep (s - 1) (One b) m sf
  | otherwise = Deep (s - 1) (One a) m sf
delLeftDigitE i s (Three a b c) m sf
  | i == 0 = Deep (s - 1) (Two b c) m sf
  | i == 1 = Deep (s - 1) (Two a c) m sf
  | otherwise = Deep (s - 1) (Two a b) m sf
delLeftDigitE i s (Four a b c d) m sf
  | i == 0 = Deep (s - 1) (Three b c d) m sf
  | i == 1 = Deep (s - 1) (Three a c d) m sf
  | i == 2 = Deep (s - 1) (Three a b d) m sf
  | otherwise = Deep (s - 1) (Three a b c) m sf

delRightDigitE :: Int -> Int -> Digit (Elem a) -> FingerTree (Node (Elem a)) -> Digit (Elem a) -> FingerTree (Elem a)
delRightDigitE !_i s pr m One{} = pullR (s - 1) pr m
delRightDigitE i s pr m (Two a b)
  | i == 0 = Deep (s - 1) pr m (One b)
  | otherwise = Deep (s - 1) pr m (One a)
delRightDigitE i s pr m (Three a b c)
  | i == 0 = Deep (s - 1) pr m (Two b c)
  | i == 1 = Deep (s - 1) pr m (Two a c)
  | otherwise = deep pr m (Two a b)
delRightDigitE i s pr m (Four a b c d)
  | i == 0 = Deep (s - 1) pr m (Three b c d)
  | i == 1 = Deep (s - 1) pr m (Three a c d)
  | i == 2 = Deep (s - 1) pr m (Three a b d)
  | otherwise = Deep (s - 1) pr m (Three a b c)

data DelTree a = FullTree !(FingerTree (Node a)) | DefectTree a

delTree :: Sized a => (Int -> Node a -> Del a) -> Int -> FingerTree (Node a) -> DelTree a
delTree _f !_i EmptyT = FullTree EmptyT
delTree f i (Single a) = case f i a of
  Full a' -> FullTree (Single a')
  Defect e -> DefectTree e
delTree f i (Deep s pr m sf)
  | i < spr = case delDigit f i pr of
     FullDig pr' -> FullTree $ Deep (s - 1) pr' m sf
     DefectDig e -> case viewLTree m of
                      EmptyLTree -> FullTree $ delRebuildRightDigit (s - 1) e sf
                      ConsLTree n m' -> FullTree $ delRebuildLeftSide (s - 1) e n m' sf
  | i < spm = case delTree (delNode f) (i - spr) m of
     FullTree m' -> FullTree (Deep (s - 1) pr m' sf)
     DefectTree e -> FullTree $ delRebuildMiddle (s - 1) pr e sf
  | otherwise = case delDigit f (i - spm) sf of
     FullDig sf' -> FullTree $ Deep (s - 1) pr m sf'
     DefectDig e -> case viewRTree m of
                      EmptyRTree -> FullTree $ delRebuildLeftDigit (s - 1) pr e
                      SnocRTree m' n -> FullTree $ delRebuildRightSide (s - 1) pr m' n e
  where spr = size pr
        spm = spr + size m

data Del a = Full !(Node a) | Defect a

delNode :: Sized a => (Int -> Node a -> Del a) -> Int -> Node (Node a) -> Del (Node a)
delNode f i (Node3 s a b c)
  | i < sa = case f i a of
     Full a' -> Full $ Node3 (s - 1) a' b c
     Defect e -> let !se = size e in case b of
       Node3 sxyz x y z -> Full $ Node3 (s - 1) (Node2 (se + sx) e x) (Node2 (sxyz - sx) y z) c
         where !sx = size x
       Node2 sxy x y -> Full $ Node2 (s - 1) (Node3 (sxy + se) e x y) c
  | i < sab = case f (i - sa) b of
     Full b' -> Full $ Node3 (s - 1) a b' c
     Defect e -> let !se = size e in case a of
       Node3 sxyz x y z -> Full $ Node3 (s - 1) (Node2 (sxyz - sz) x y) (Node2 (sz + se) z e) c
         where !sz = size z
       Node2 sxy x y -> Full $ Node2 (s - 1) (Node3 (sxy + se) x y e) c
  | otherwise = case f (i - sab) c of
     Full c' -> Full $ Node3 (s - 1) a b c'
     Defect e -> let !se = size e in case b of
       Node3 sxyz x y z -> Full $ Node3 (s - 1) a (Node2 (sxyz - sz) x y) (Node2 (sz + se) z e)
         where !sz = size z
       Node2 sxy x y -> Full $ Node2 (s - 1) a (Node3 (sxy + se) x y e)
  where sa = size a
        sab = sa + size b
delNode f i (Node2 s a b)
  | i < sa = case f i a of
     Full a' -> Full $ Node2 (s - 1) a' b
     Defect e -> let !se = size e in case b of
       Node3 sxyz x y z -> Full $ Node2 (s - 1) (Node2 (se + sx) e x) (Node2 (sxyz - sx) y z)
        where !sx = size x
       Node2 _ x y -> Defect $ Node3 (s - 1) e x y
  | otherwise = case f (i - sa) b of
     Full b' -> Full $ Node2 (s - 1) a b'
     Defect e -> let !se = size e in case a of
       Node3 sxyz x y z -> Full $ Node2 (s - 1) (Node2 (sxyz - sz) x y) (Node2 (sz + se) z e)
         where !sz = size z
       Node2 _ x y -> Defect $ Node3 (s - 1) x y e
  where sa = size a

delRebuildRightDigit :: Sized a => Int -> a -> Digit (Node a) -> FingerTree (Node a)
delRebuildRightDigit s p (One a) = let !sp = size p in case a of
  Node3 sxyz x y z -> Deep s (One (Node2 (sp + sx) p x)) EmptyT (One (Node2 (sxyz - sx) y z))
    where !sx = size x
  Node2 sxy x y -> Single (Node3 (sp + sxy) p x y)
delRebuildRightDigit s p (Two a b) = let !sp = size p in case a of
  Node3 sxyz x y z -> Deep s (Two (Node2 (sp + sx) p x) (Node2 (sxyz - sx) y z)) EmptyT (One b)
    where !sx = size x
  Node2 sxy x y -> Deep s (One (Node3 (sp + sxy) p x y)) EmptyT (One b)
delRebuildRightDigit s p (Three a b c) = let !sp = size p in case a of
  Node3 sxyz x y z -> Deep s (Two (Node2 (sp + sx) p x) (Node2 (sxyz - sx) y z)) EmptyT (Two b c)
    where !sx = size x
  Node2 sxy x y -> Deep s (Two (Node3 (sp + sxy) p x y) b) EmptyT (One c)
delRebuildRightDigit s p (Four a b c d) = let !sp = size p in case a of
  Node3 sxyz x y z -> Deep s (Three (Node2 (sp + sx) p x) (Node2 (sxyz - sx) y z) b) EmptyT (Two c d)
    where !sx = size x
  Node2 sxy x y -> Deep s (Two (Node3 (sp + sxy) p x y) b) EmptyT (Two c d)

delRebuildLeftDigit :: Sized a => Int -> Digit (Node a) -> a -> FingerTree (Node a)
delRebuildLeftDigit s (One a) p = let !sp = size p in case a of
  Node3 sxyz x y z -> Deep s (One (Node2 (sxyz - sz) x y)) EmptyT (One (Node2 (sz + sp) z p))
    where !sz = size z
  Node2 sxy x y -> Single (Node3 (sxy + sp) x y p)
delRebuildLeftDigit s (Two a b) p = let !sp = size p in case b of
  Node3 sxyz x y z -> Deep s (Two a (Node2 (sxyz - sz) x y)) EmptyT (One (Node2 (sz + sp) z p))
    where !sz = size z
  Node2 sxy x y -> Deep s (One a) EmptyT (One (Node3 (sxy + sp) x y p))
delRebuildLeftDigit s (Three a b c) p = let !sp = size p in case c of
  Node3 sxyz x y z -> Deep s (Two a b) EmptyT (Two (Node2 (sxyz - sz) x y) (Node2 (sz + sp) z p))
    where !sz = size z
  Node2 sxy x y -> Deep s (Two a b) EmptyT (One (Node3 (sxy + sp) x y p))
delRebuildLeftDigit s (Four a b c d) p = let !sp = size p in case d of
  Node3 sxyz x y z -> Deep s (Three a b c) EmptyT (Two (Node2 (sxyz - sz) x y) (Node2 (sz + sp) z p))
    where !sz = size z
  Node2 sxy x y -> Deep s (Two a b) EmptyT (Two c (Node3 (sxy + sp) x y p))

delRebuildLeftSide :: Sized a
                   => Int -> a -> Node (Node a) -> FingerTree (Node (Node a)) -> Digit (Node a)
                   -> FingerTree (Node a)
delRebuildLeftSide s p (Node2 _ a b) m sf = let !sp = size p in case a of
  Node2 sxy x y -> Deep s (Two (Node3 (sp + sxy) p x y) b) m sf
  Node3 sxyz x y z -> Deep s (Three (Node2 (sp + sx) p x) (Node2 (sxyz - sx) y z) b) m sf
    where !sx = size x
delRebuildLeftSide s p (Node3 _ a b c) m sf = let !sp = size p in case a of
  Node2 sxy x y -> Deep s (Three (Node3 (sp + sxy) p x y) b c) m sf
  Node3 sxyz x y z -> Deep s (Four (Node2 (sp + sx) p x) (Node2 (sxyz - sx) y z) b c) m sf
    where !sx = size x

delRebuildRightSide :: Sized a
                    => Int -> Digit (Node a) -> FingerTree (Node (Node a)) -> Node (Node a) -> a
                    -> FingerTree (Node a)
delRebuildRightSide s pr m (Node2 _ a b) p = let !sp = size p in case b of
  Node2 sxy x y -> Deep s pr m (Two a (Node3 (sxy + sp) x y p))
  Node3 sxyz x y z -> Deep s pr m (Three a (Node2 (sxyz - sz) x y) (Node2 (sz + sp) z p))
    where !sz = size z
delRebuildRightSide s pr m (Node3 _ a b c) p = let !sp = size p in case c of
  Node2 sxy x y -> Deep s pr m (Three a b (Node3 (sxy + sp) x y p))
  Node3 sxyz x y z -> Deep s pr m (Four a b (Node2 (sxyz - sz) x y) (Node2 (sz + sp) z p))
    where !sz = size z

delRebuildMiddle :: Sized a
                 => Int -> Digit a -> a -> Digit a
                 -> FingerTree a
delRebuildMiddle s (One a) e sf = Deep s (Two a e) EmptyT sf
delRebuildMiddle s (Two a b) e sf = Deep s (Three a b e) EmptyT sf
delRebuildMiddle s (Three a b c) e sf = Deep s (Four a b c e) EmptyT sf
delRebuildMiddle s (Four a b c d) e sf = Deep s (Two a b) (Single (node3 c d e)) sf

data DelDig a = FullDig !(Digit (Node a)) | DefectDig a

delDigit :: Sized a => (Int -> Node a -> Del a) -> Int -> Digit (Node a) -> DelDig a
delDigit f !i (One a) = case f i a of
  Full a' -> FullDig $ One a'
  Defect e -> DefectDig e
delDigit f i (Two a b)
  | i < sa = case f i a of
     Full a' -> FullDig $ Two a' b
     Defect e -> let !se = size e in case b of
       Node3 sxyz x y z -> FullDig $ Two (Node2 (se + sx) e x) (Node2 (sxyz - sx) y z)
         where !sx = size x
       Node2 sxy x y -> FullDig $ One (Node3 (se + sxy) e x y)
  | otherwise = case f (i - sa) b of
     Full b' -> FullDig $ Two a b'
     Defect e -> let !se = size e in case a of
       Node3 sxyz x y z -> FullDig $ Two (Node2 (sxyz - sz) x y) (Node2 (sz + se) z e)
         where !sz = size z
       Node2 sxy x y -> FullDig $ One (Node3 (sxy + se) x y e)
  where sa = size a
delDigit f i (Three a b c)
  | i < sa = case f i a of
     Full a' -> FullDig $ Three a' b c
     Defect e -> let !se = size e in case b of
       Node3 sxyz x y z -> FullDig $ Three (Node2 (se + sx) e x) (Node2 (sxyz - sx) y z) c
         where !sx = size x
       Node2 sxy x y -> FullDig $ Two (Node3 (se + sxy) e x y) c
  | i < sab = case f (i - sa) b of
     Full b' -> FullDig $ Three a b' c
     Defect e -> let !se = size e in case a of
       Node3 sxyz x y z -> FullDig $ Three (Node2 (sxyz - sz) x y) (Node2 (sz + se) z e) c
         where !sz = size z
       Node2 sxy x y -> FullDig $ Two (Node3 (sxy + se) x y e) c
  | otherwise = case f (i - sab) c of
     Full c' -> FullDig $ Three a b c'
     Defect e -> let !se = size e in case b of
       Node3 sxyz x y z -> FullDig $ Three a (Node2 (sxyz - sz) x y) (Node2 (sz + se) z e)
         where !sz = size z
       Node2 sxy x y -> FullDig $ Two a (Node3 (sxy + se) x y e)
  where sa = size a
        sab = sa + size b
delDigit f i (Four a b c d)
  | i < sa = case f i a of
     Full a' -> FullDig $ Four a' b c d
     Defect e -> let !se = size e in case b of
       Node3 sxyz x y z -> FullDig $ Four (Node2 (se + sx) e x) (Node2 (sxyz - sx) y z) c d
         where !sx = size x
       Node2 sxy x y -> FullDig $ Three (Node3 (se + sxy) e x y) c d
  | i < sab = case f (i - sa) b of
     Full b' -> FullDig $ Four a b' c d
     Defect e -> let !se = size e in case a of
       Node3 sxyz x y z -> FullDig $ Four (Node2 (sxyz - sz) x y) (Node2 (sz + se) z e) c d
         where !sz = size z
       Node2 sxy x y -> FullDig $ Three (Node3 (sxy + se) x y e) c d
  | i < sabc = case f (i - sab) c of
     Full c' -> FullDig $ Four a b c' d
     Defect e -> let !se = size e in case b of
       Node3 sxyz x y z -> FullDig $ Four a (Node2 (sxyz - sz) x y) (Node2 (sz + se) z e) d
         where !sz = size z
       Node2 sxy x y -> FullDig $ Three a (Node3 (sxy + se) x y e) d
  | otherwise = case f (i - sabc) d of
     Full d' -> FullDig $ Four a b c d'
     Defect e -> let !se = size e in case c of
       Node3 sxyz x y z -> FullDig $ Four a b (Node2 (sxyz - sz) x y) (Node2 (sz + se) z e)
         where !sz = size z
       Node2 sxy x y -> FullDig $ Three a b (Node3 (sxy + se) x y e)
  where sa = size a
        sab = sa + size b
        sabc = sab + size c

mapWithIndex :: (Int -> a -> b) -> Seq a -> Seq b
mapWithIndex f' (Seq xs') = Seq $ mapWithIndexTree (\s (Elem a) -> Elem (f' s a)) 0 xs'
 where
  mapWithIndexTree :: Sized a => (Int -> a -> b) -> Int -> FingerTree a -> FingerTree b
  mapWithIndexTree _ !_s EmptyT = EmptyT
  mapWithIndexTree f s (Single xs) = Single $ f s xs
  mapWithIndexTree f s (Deep n pr m sf) =
          Deep n
               (mapWithIndexDigit f s pr)
               (mapWithIndexTree (mapWithIndexNode f) sPspr m)
               (mapWithIndexDigit f sPsprm sf)
    where
      !sPspr = s + size pr
      !sPsprm = sPspr + size m

  mapWithIndexDigit :: Sized a => (Int -> a -> b) -> Int -> Digit a -> Digit b
  mapWithIndexDigit f !s (One a) = One (f s a)
  mapWithIndexDigit f s (Two a b) = Two (f s a) (f sPsa b)
    where
      !sPsa = s + size a
  mapWithIndexDigit f s (Three a b c) =
                                      Three (f s a) (f sPsa b) (f sPsab c)
    where
      !sPsa = s + size a
      !sPsab = sPsa + size b
  mapWithIndexDigit f s (Four a b c d) =
                          Four (f s a) (f sPsa b) (f sPsab c) (f sPsabc d)
    where
      !sPsa = s + size a
      !sPsab = sPsa + size b
      !sPsabc = sPsab + size c

  mapWithIndexNode :: Sized a => (Int -> a -> b) -> Int -> Node a -> Node b
  mapWithIndexNode f s (Node2 ns a b) = Node2 ns (f s a) (f sPsa b)
    where
      !sPsa = s + size a
  mapWithIndexNode f s (Node3 ns a b c) =
                                     Node3 ns (f s a) (f sPsa b) (f sPsab c)
    where
      !sPsa = s + size a
      !sPsab = sPsa + size b

foldWithIndexDigit :: Sized a => (b -> b -> b) -> (Int -> a -> b) -> Int -> Digit a -> b
foldWithIndexDigit _ f !s (One a) = f s a
foldWithIndexDigit (<+>) f s (Two a b) = f s a <+> f sPsa b
  where
    !sPsa = s + size a
foldWithIndexDigit (<+>) f s (Three a b c) = f s a <+> f sPsa b <+> f sPsab c
  where
    !sPsa = s + size a
    !sPsab = sPsa + size b
foldWithIndexDigit (<+>) f s (Four a b c d) =
    f s a <+> f sPsa b <+> f sPsab c <+> f sPsabc d
  where
    !sPsa = s + size a
    !sPsab = sPsa + size b
    !sPsabc = sPsab + size c

foldWithIndexNode :: Sized a => (m -> m -> m) -> (Int -> a -> m) -> Int -> Node a -> m
foldWithIndexNode (<+>) f !s (Node2 _ a b) = f s a <+> f sPsa b
  where
    !sPsa = s + size a
foldWithIndexNode (<+>) f s (Node3 _ a b c) = f s a <+> f sPsa b <+> f sPsab c
  where
    !sPsa = s + size a
    !sPsab = sPsa + size b

fromFunction :: Int -> (Int -> a) -> Seq a
fromFunction len f | len < 0 = error "Data.Sequence.fromFunction called with negative len"
                   | len == 0 = empty
                   | otherwise = Seq $ create (lift_elem f) 1 0 len
  where
    create :: (Int -> a) -> Int -> Int -> Int -> FingerTree a
    create b !s !i trees = case trees of
       1 -> Single $ b i
       2 -> Deep (2*s) (One (b i)) EmptyT (One (b (i+s)))
       3 -> Deep (3*s) (createTwo i) EmptyT (One (b (i+2*s)))
       4 -> Deep (4*s) (createTwo i) EmptyT (createTwo (i+2*s))
       5 -> Deep (5*s) (createThree i) EmptyT (createTwo (i+3*s))
       6 -> Deep (6*s) (createThree i) EmptyT (createThree (i+3*s))
       _ -> case trees ${BT}quotRem${BT} 3 of
           (trees', 1) -> Deep (trees*s) (createTwo i)
                              (create mb (3*s) (i+2*s) (trees'-1))
                              (createTwo (i+(2+3*(trees'-1))*s))
           (trees', 2) -> Deep (trees*s) (createThree i)
                              (create mb (3*s) (i+3*s) (trees'-1))
                              (createTwo (i+(3+3*(trees'-1))*s))
           (trees', _) -> Deep (trees*s) (createThree i)
                              (create mb (3*s) (i+3*s) (trees'-2))
                              (createThree (i+(3+3*(trees'-2))*s))
      where
        createTwo j = Two (b j) (b (j + s))
        createThree j = Three (b j) (b (j + s)) (b (j + 2*s))
        mb j = Node3 (3*s) (b j) (b (j + s)) (b (j + 2*s))

    lift_elem :: (Int -> a) -> (Int -> Elem a)
    lift_elem g = Elem . g

take :: Int -> Seq a -> Seq a
take i xs@(Seq t)
  | fromIntegral i - 1 < (fromIntegral (length xs) - 1 :: Word) =
      Seq (takeTreeE i t)
  | i <= 0 = empty
  | otherwise = xs

takeTreeE :: Int -> FingerTree (Elem a) -> FingerTree (Elem a)
takeTreeE !_i EmptyT = EmptyT
takeTreeE i t@(Single _)
   | i <= 0 = EmptyT
   | otherwise = t
takeTreeE i (Deep s pr m sf)
  | i < spr     = takePrefixE i pr
  | i < spm     = case takeTreeN im m of
            ml :*: xs -> takeMiddleE (im - size ml) spr pr ml xs
  | otherwise   = takeSuffixE (i - spm) s pr m sf
  where
    spr     = size pr
    spm     = spr + size m
    im      = i - spr

takeTreeN :: Int -> FingerTree (Node a) -> StrictPair (FingerTree (Node a)) (Node a)
takeTreeN !_i EmptyT = error "takeTreeN of empty tree"
takeTreeN _i (Single x) = EmptyT :*: x
takeTreeN i (Deep s pr m sf)
  | i < spr     = takePrefixN i pr
  | i < spm     = case takeTreeN im m of
            ml :*: xs -> takeMiddleN (im - size ml) spr pr ml xs
  | otherwise   = takeSuffixN (i - spm) s pr m sf  where
    spr     = size pr
    spm     = spr + size m
    im      = i - spr

takeMiddleN :: Int -> Int
             -> Digit (Node a) -> FingerTree (Node (Node a)) -> Node (Node a)
             -> StrictPair (FingerTree (Node a)) (Node a)
takeMiddleN i spr pr ml (Node2 _ a b)
  | i < sa      = pullR sprml pr ml :*: a
  | otherwise   = Deep sprmla pr ml (One a) :*: b
  where
    sa      = size a
    sprml   = spr + size ml
    sprmla  = sa + sprml
takeMiddleN i spr pr ml (Node3 _ a b c)
  | i < sa      = pullR sprml pr ml :*: a
  | i < sab     = Deep sprmla pr ml (One a) :*: b
  | otherwise   = Deep sprmlab pr ml (Two a b) :*: c
  where
    sa      = size a
    sab     = sa + size b
    sprml   = spr + size ml
    sprmla  = sa + sprml
    sprmlab = sprmla + size b

takeMiddleE :: Int -> Int
             -> Digit (Elem a) -> FingerTree (Node (Elem a)) -> Node (Elem a)
             -> FingerTree (Elem a)
takeMiddleE i spr pr ml (Node2 _ a _)
  | i < 1       = pullR sprml pr ml
  | otherwise   = Deep sprmla pr ml (One a)
  where
    sprml   = spr + size ml
    sprmla  = 1 + sprml
takeMiddleE i spr pr ml (Node3 _ a b _)
  | i < 1       = pullR sprml pr ml
  | i < 2       = Deep sprmla pr ml (One a)
  | otherwise   = Deep sprmlab pr ml (Two a b)
  where
    sprml   = spr + size ml
    sprmla  = 1 + sprml
    sprmlab = sprmla + 1

takePrefixE :: Int -> Digit (Elem a) -> FingerTree (Elem a)
takePrefixE !_i (One _) = EmptyT
takePrefixE i (Two a _)
  | i < 1       = EmptyT
  | otherwise   = Single a
takePrefixE i (Three a b _)
  | i < 1       = EmptyT
  | i < 2       = Single a
  | otherwise   = Deep 2 (One a) EmptyT (One b)
takePrefixE i (Four a b c _)
  | i < 1       = EmptyT
  | i < 2       = Single a
  | i < 3       = Deep 2 (One a) EmptyT (One b)
  | otherwise   = Deep 3 (Two a b) EmptyT (One c)

takePrefixN :: Int -> Digit (Node a)
                    -> StrictPair (FingerTree (Node a)) (Node a)
takePrefixN !_i (One a) = EmptyT :*: a
takePrefixN i (Two a b)
  | i < sa      = EmptyT :*: a
  | otherwise   = Single a :*: b
  where
    sa      = size a
takePrefixN i (Three a b c)
  | i < sa      = EmptyT :*: a
  | i < sab     = Single a :*: b
  | otherwise   = Deep sab (One a) EmptyT (One b) :*: c
  where
    sa      = size a
    sab     = sa + size b
takePrefixN i (Four a b c d)
  | i < sa      = EmptyT :*: a
  | i < sab     = Single a :*: b
  | i < sabc    = Deep sab (One a) EmptyT (One b) :*: c
  | otherwise   = Deep sabc (Two a b) EmptyT (One c) :*: d
  where
    sa      = size a
    sab     = sa + size b
    sabc    = sab + size c

takeSuffixE :: Int -> Int -> Digit (Elem a) -> FingerTree (Node (Elem a)) -> Digit (Elem a) ->
   FingerTree (Elem a)
takeSuffixE !_i !s pr m (One _) = pullR (s - 1) pr m
takeSuffixE i s pr m (Two a _)
  | i < 1      = pullR (s - 2) pr m
  | otherwise  = Deep (s - 1) pr m (One a)
takeSuffixE i s pr m (Three a b _)
  | i < 1      = pullR (s - 3) pr m
  | i < 2      = Deep (s - 2) pr m (One a)
  | otherwise  = Deep (s - 1) pr m (Two a b)
takeSuffixE i s pr m (Four a b c _)
  | i < 1      = pullR (s - 4) pr m
  | i < 2      = Deep (s - 3) pr m (One a)
  | i < 3      = Deep (s - 2) pr m (Two a b)
  | otherwise  = Deep (s - 1) pr m (Three a b c)

takeSuffixN :: Int -> Int -> Digit (Node a) -> FingerTree (Node (Node a)) -> Digit (Node a) ->
   StrictPair (FingerTree (Node a)) (Node a)
takeSuffixN !_i !s pr m (One a) = pullR (s - size a) pr m :*: a
takeSuffixN i s pr m (Two a b)
  | i < sa      = pullR (s - sa - size b) pr m :*: a
  | otherwise   = Deep (s - size b) pr m (One a) :*: b
  where
    sa      = size a
takeSuffixN i s pr m (Three a b c)
  | i < sa      = pullR (s - sab - size c) pr m :*: a
  | i < sab     = Deep (s - size b - size c) pr m (One a) :*: b
  | otherwise   = Deep (s - size c) pr m (Two a b) :*: c
  where
    sa      = size a
    sab     = sa + size b
takeSuffixN i s pr m (Four a b c d)
  | i < sa      = pullR (s - sa - sbcd) pr m :*: a
  | i < sab     = Deep (s - sbcd) pr m (One a) :*: b
  | i < sabc    = Deep (s - scd) pr m (Two a b) :*: c
  | otherwise   = Deep (s - sd) pr m (Three a b c) :*: d
  where
    sa      = size a
    sab     = sa + size b
    sabc    = sab + size c
    sd      = size d
    scd     = size c + sd
    sbcd    = size b + scd

drop            :: Int -> Seq a -> Seq a
drop i xs@(Seq t)
  | fromIntegral i - 1 < (fromIntegral (length xs) - 1 :: Word) =
      Seq (takeTreeER (length xs - i) t)
  | i <= 0 = xs
  | otherwise = empty

takeTreeER :: Int -> FingerTree (Elem a) -> FingerTree (Elem a)
takeTreeER !_i EmptyT = EmptyT
takeTreeER i t@(Single _)
   | i <= 0 = EmptyT
   | otherwise = t
takeTreeER i (Deep s pr m sf)
  | i < ssf     = takeSuffixER i sf
  | i < ssm     = case takeTreeNR im m of
            xs :*: mr -> takeMiddleER (im - size mr) ssf xs mr sf
  | otherwise   = takePrefixER (i - ssm) s pr m sf
  where
    ssf     = size sf
    ssm     = ssf + size m
    im      = i - ssf

takeTreeNR :: Int -> FingerTree (Node a) -> StrictPair (Node a) (FingerTree (Node a))
takeTreeNR !_i EmptyT = error "takeTreeNR of empty tree"
takeTreeNR _i (Single x) = x :*: EmptyT
takeTreeNR i (Deep s pr m sf)
  | i < ssf     = takeSuffixNR i sf
  | i < ssm     = case takeTreeNR im m of
            xs :*: mr -> takeMiddleNR (im - size mr) ssf xs mr sf
  | otherwise   = takePrefixNR (i - ssm) s pr m sf  where
    ssf     = size sf
    ssm     = ssf + size m
    im      = i - ssf

takeMiddleNR :: Int -> Int
             -> Node (Node a) -> FingerTree (Node (Node a)) -> Digit (Node a)
             -> StrictPair (Node a) (FingerTree (Node a))
takeMiddleNR i ssf (Node2 _ a b) mr sf
  | i < sb      = b :*: pullL ssfmr mr sf
  | otherwise   = a :*: Deep ssfmrb (One b) mr sf
  where
    sb      = size b
    ssfmr   = ssf + size mr
    ssfmrb  = sb + ssfmr
takeMiddleNR i ssf (Node3 _ a b c) mr sf
  | i < sc      = c :*: pullL ssfmr mr sf
  | i < sbc     = b :*: Deep ssfmrc (One c) mr sf
  | otherwise   = a :*: Deep ssfmrbc (Two b c) mr sf
  where
    sc      = size c
    sbc     = sc + size b
    ssfmr   = ssf + size mr
    ssfmrc  = sc + ssfmr
    ssfmrbc = ssfmrc + size b

takeMiddleER :: Int -> Int
             -> Node (Elem a) -> FingerTree (Node (Elem a)) -> Digit (Elem a)
             -> FingerTree (Elem a)
takeMiddleER i ssf (Node2 _ _ b) mr sf
  | i < 1       = pullL ssfmr mr sf
  | otherwise   = Deep ssfmrb (One b) mr sf
  where
    ssfmr   = ssf + size mr
    ssfmrb  = 1 + ssfmr
takeMiddleER i ssf (Node3 _ _ b c) mr sf
  | i < 1       = pullL ssfmr mr sf
  | i < 2       = Deep ssfmrc (One c) mr sf
  | otherwise   = Deep ssfmrbc (Two b c) mr sf
  where
    ssfmr   = ssf + size mr
    ssfmrc  = 1 + ssfmr
    ssfmrbc = ssfmr + 2

takeSuffixER :: Int -> Digit (Elem a) -> FingerTree (Elem a)
takeSuffixER !_i (One _) = EmptyT
takeSuffixER i (Two _ b)
  | i < 1       = EmptyT
  | otherwise   = Single b
takeSuffixER i (Three _ b c)
  | i < 1       = EmptyT
  | i < 2       = Single c
  | otherwise   = Deep 2 (One b) EmptyT (One c)
takeSuffixER i (Four _ b c d)
  | i < 1       = EmptyT
  | i < 2       = Single d
  | i < 3       = Deep 2 (One c) EmptyT (One d)
  | otherwise   = Deep 3 (Two b c) EmptyT (One d)

takeSuffixNR :: Int -> Digit (Node a)
                    -> StrictPair (Node a) (FingerTree (Node a))
takeSuffixNR !_i (One a) = a :*: EmptyT
takeSuffixNR i (Two a b)
  | i < sb      = b :*: EmptyT
  | otherwise   = a :*: Single b
  where
    sb      = size b
takeSuffixNR i (Three a b c)
  | i < sc      = c :*: EmptyT
  | i < sbc     = b :*: Single c
  | otherwise   = a :*: Deep sbc (One b) EmptyT (One c)
  where
    sc      = size c
    sbc     = sc + size b
takeSuffixNR i (Four a b c d)
  | i < sd      = d :*: EmptyT
  | i < scd     = c :*: Single d
  | i < sbcd    = b :*: Deep scd (One c) EmptyT (One d)
  | otherwise   = a :*: Deep sbcd (Two b c) EmptyT (One d)
  where
    sd      = size d
    scd     = sd + size c
    sbcd    = scd + size b

takePrefixER :: Int -> Int -> Digit (Elem a) -> FingerTree (Node (Elem a)) -> Digit (Elem a) ->
   FingerTree (Elem a)
takePrefixER !_i !s (One _) m sf = pullL (s - 1) m sf
takePrefixER i s (Two _ b) m sf
  | i < 1      = pullL (s - 2) m sf
  | otherwise  = Deep (s - 1) (One b) m sf
takePrefixER i s (Three _ b c) m sf
  | i < 1      = pullL (s - 3) m sf
  | i < 2      = Deep (s - 2) (One c) m sf
  | otherwise  = Deep (s - 1) (Two b c) m sf
takePrefixER i s (Four _ b c d) m sf
  | i < 1      = pullL (s - 4) m sf
  | i < 2      = Deep (s - 3) (One d) m sf
  | i < 3      = Deep (s - 2) (Two c d) m sf
  | otherwise  = Deep (s - 1) (Three b c d) m sf

takePrefixNR :: Int -> Int -> Digit (Node a) -> FingerTree (Node (Node a)) -> Digit (Node a) ->
   StrictPair (Node a) (FingerTree (Node a))
takePrefixNR !_i !s (One a) m sf = a :*: pullL (s - size a) m sf
takePrefixNR i s (Two a b) m sf
  | i < sb      = b :*: pullL (s - sb - size a) m sf
  | otherwise   = a :*: Deep (s - size a) (One b) m sf
  where
    sb      = size b
takePrefixNR i s (Three a b c) m sf
  | i < sc      = c :*: pullL (s - sbc - size a) m sf
  | i < sbc     = b :*: Deep (s - size b - size a) (One c) m sf
  | otherwise   = a :*: Deep (s - size a) (Two b c) m sf
  where
    sc      = size c
    sbc     = sc + size b
takePrefixNR i s (Four a b c d) m sf
  | i < sd      = d :*: pullL (s - sd - sabc) m sf
  | i < scd     = c :*: Deep (s - sabc) (One d) m sf
  | i < sbcd    = b :*: Deep (s - sab) (Two c d) m sf
  | otherwise   = a :*: Deep (s - sa) (Three b c d) m sf
  where
    sa      = size a
    sab     = sa + size b
    sabc    = sab + size c
    sd      = size d
    scd     = size c + sd
    sbcd    = size b + scd

splitAt                  :: Int -> Seq a -> (Seq a, Seq a)
splitAt i xs@(Seq t)
  | fromIntegral i - 1 < (fromIntegral (length xs) - 1 :: Word) =
      case splitTreeE i t of
        l :*: r -> (Seq l, Seq r)
  | i <= 0 = (empty, xs)
  | otherwise = (xs, empty)

uncheckedSplitAt :: Int -> Seq a -> (Seq a, Seq a)
uncheckedSplitAt i (Seq xs) = case splitTreeE i xs of
  l :*: r -> (Seq l, Seq r)

data Split a = Split !(FingerTree (Node a)) !(Node a) !(FingerTree (Node a))

splitTreeE :: Int -> FingerTree (Elem a) -> StrictPair (FingerTree (Elem a)) (FingerTree (Elem a))
splitTreeE !_i EmptyT = EmptyT :*: EmptyT
splitTreeE i t@(Single _)
   | i <= 0 = EmptyT :*: t
   | otherwise = t :*: EmptyT
splitTreeE i (Deep s pr m sf)
  | i < spr     = splitPrefixE i s pr m sf
  | i < spm     = case splitTreeN im m of
            Split ml xs mr -> splitMiddleE (im - size ml) s spr pr ml xs mr sf
  | otherwise   = splitSuffixE (i - spm) s pr m sf
  where
    spr     = size pr
    spm     = spr + size m
    im      = i - spr

splitTreeN :: Int -> FingerTree (Node a) -> Split a
splitTreeN !_i EmptyT = error "splitTreeN of empty tree"
splitTreeN _i (Single x) = Split EmptyT x EmptyT
splitTreeN i (Deep s pr m sf)
  | i < spr     = splitPrefixN i s pr m sf
  | i < spm     = case splitTreeN im m of
            Split ml xs mr -> splitMiddleN (im - size ml) s spr pr ml xs mr sf
  | otherwise   = splitSuffixN (i - spm) s pr m sf  where
    spr     = size pr
    spm     = spr + size m
    im      = i - spr

splitMiddleN :: Int -> Int -> Int
             -> Digit (Node a) -> FingerTree (Node (Node a)) -> Node (Node a) -> FingerTree (Node (Node a)) -> Digit (Node a)
             -> Split a
splitMiddleN i s spr pr ml (Node2 _ a b) mr sf
  | i < sa      = Split (pullR sprml pr ml) a (Deep (s - sprmla) (One b) mr sf)
  | otherwise   = Split (Deep sprmla pr ml (One a)) b (pullL (s - sprmla - size b) mr sf)
  where
    sa      = size a
    sprml   = spr + size ml
    sprmla  = sa + sprml
splitMiddleN i s spr pr ml (Node3 _ a b c) mr sf
  | i < sa      = Split (pullR sprml pr ml) a (Deep (s - sprmla) (Two b c) mr sf)
  | i < sab     = Split (Deep sprmla pr ml (One a)) b (Deep (s - sprmlab) (One c) mr sf)
  | otherwise   = Split (Deep sprmlab pr ml (Two a b)) c (pullL (s - sprmlab - size c) mr sf)
  where
    sa      = size a
    sab     = sa + size b
    sprml   = spr + size ml
    sprmla  = sa + sprml
    sprmlab = sprmla + size b

splitMiddleE :: Int -> Int -> Int
             -> Digit (Elem a) -> FingerTree (Node (Elem a)) -> Node (Elem a) -> FingerTree (Node (Elem a)) -> Digit (Elem a)
             -> StrictPair (FingerTree (Elem a)) (FingerTree (Elem a))
splitMiddleE i s spr pr ml (Node2 _ a b) mr sf
  | i < 1       = pullR sprml pr ml :*: Deep (s - sprml) (Two a b) mr sf
  | otherwise   = Deep sprmla pr ml (One a) :*: Deep (s - sprmla) (One b) mr sf
  where
    sprml   = spr + size ml
    sprmla  = 1 + sprml
splitMiddleE i s spr pr ml (Node3 _ a b c) mr sf = case i of
  0 -> pullR sprml pr ml :*: Deep (s - sprml) (Three a b c) mr sf
  1 -> Deep sprmla pr ml (One a) :*: Deep (s - sprmla) (Two b c) mr sf
  _ -> Deep sprmlab pr ml (Two a b) :*: Deep (s - sprmlab) (One c) mr sf
  where
    sprml   = spr + size ml
    sprmla  = 1 + sprml
    sprmlab = sprmla + 1

splitPrefixE :: Int -> Int -> Digit (Elem a) -> FingerTree (Node (Elem a)) -> Digit (Elem a) ->
                    StrictPair (FingerTree (Elem a)) (FingerTree (Elem a))
splitPrefixE !_i !s (One a) m sf = EmptyT :*: Deep s (One a) m sf
splitPrefixE i s (Two a b) m sf = case i of
  0 -> EmptyT :*: Deep s (Two a b) m sf
  _ -> Single a :*: Deep (s - 1) (One b) m sf
splitPrefixE i s (Three a b c) m sf = case i of
  0 -> EmptyT :*: Deep s (Three a b c) m sf
  1 -> Single a :*: Deep (s - 1) (Two b c) m sf
  _ -> Deep 2 (One a) EmptyT (One b) :*: Deep (s - 2) (One c) m sf
splitPrefixE i s (Four a b c d) m sf = case i of
  0 -> EmptyT :*: Deep s (Four a b c d) m sf
  1 -> Single a :*: Deep (s - 1) (Three b c d) m sf
  2 -> Deep 2 (One a) EmptyT (One b) :*: Deep (s - 2) (Two c d) m sf
  _ -> Deep 3 (Two a b) EmptyT (One c) :*: Deep (s - 3) (One d) m sf

splitPrefixN :: Int -> Int -> Digit (Node a) -> FingerTree (Node (Node a)) -> Digit (Node a) ->
                    Split a
splitPrefixN !_i !s (One a) m sf = Split EmptyT a (pullL (s - size a) m sf)
splitPrefixN i s (Two a b) m sf
  | i < sa      = Split EmptyT a (Deep (s - sa) (One b) m sf)
  | otherwise   = Split (Single a) b (pullL (s - sa - size b) m sf)
  where
    sa      = size a
splitPrefixN i s (Three a b c) m sf
  | i < sa      = Split EmptyT a (Deep (s - sa) (Two b c) m sf)
  | i < sab     = Split (Single a) b (Deep (s - sab) (One c) m sf)
  | otherwise   = Split (Deep sab (One a) EmptyT (One b)) c (pullL (s - sab - size c) m sf)
  where
    sa      = size a
    sab     = sa + size b
splitPrefixN i s (Four a b c d) m sf
  | i < sa      = Split EmptyT a $ Deep (s - sa) (Three b c d) m sf
  | i < sab     = Split (Single a) b $ Deep (s - sab) (Two c d) m sf
  | i < sabc    = Split (Deep sab (One a) EmptyT (One b)) c $ Deep (s - sabc) (One d) m sf
  | otherwise   = Split (Deep sabc (Two a b) EmptyT (One c)) d $ pullL (s - sabc - size d) m sf
  where
    sa      = size a
    sab     = sa + size b
    sabc    = sab + size c

splitSuffixE :: Int -> Int -> Digit (Elem a) -> FingerTree (Node (Elem a)) -> Digit (Elem a) ->
   StrictPair (FingerTree (Elem a)) (FingerTree (Elem a))
splitSuffixE !_i !s pr m (One a) = pullR (s - 1) pr m :*: Single a
splitSuffixE i s pr m (Two a b) = case i of
  0 -> pullR (s - 2) pr m :*: Deep 2 (One a) EmptyT (One b)
  _ -> Deep (s - 1) pr m (One a) :*: Single b
splitSuffixE i s pr m (Three a b c) = case i of
  0 -> pullR (s - 3) pr m :*: Deep 3 (Two a b) EmptyT (One c)
  1 -> Deep (s - 2) pr m (One a) :*: Deep 2 (One b) EmptyT (One c)
  _ -> Deep (s - 1) pr m (Two a b) :*: Single c
splitSuffixE i s pr m (Four a b c d) = case i of
  0 -> pullR (s - 4) pr m :*: Deep 4 (Two a b) EmptyT (Two c d)
  1 -> Deep (s - 3) pr m (One a) :*: Deep 3 (Two b c) EmptyT (One d)
  2 -> Deep (s - 2) pr m (Two a b) :*: Deep 2 (One c) EmptyT (One d)
  _ -> Deep (s - 1) pr m (Three a b c) :*: Single d

splitSuffixN :: Int -> Int -> Digit (Node a) -> FingerTree (Node (Node a)) -> Digit (Node a) ->
   Split a
splitSuffixN !_i !s pr m (One a) = Split (pullR (s - size a) pr m) a EmptyT
splitSuffixN i s pr m (Two a b)
  | i < sa      = Split (pullR (s - sa - size b) pr m) a (Single b)
  | otherwise   = Split (Deep (s - size b) pr m (One a)) b EmptyT
  where
    sa      = size a
splitSuffixN i s pr m (Three a b c)
  | i < sa      = Split (pullR (s - sab - size c) pr m) a (deep (One b) EmptyT (One c))
  | i < sab     = Split (Deep (s - size b - size c) pr m (One a)) b (Single c)
  | otherwise   = Split (Deep (s - size c) pr m (Two a b)) c EmptyT
  where
    sa      = size a
    sab     = sa + size b
splitSuffixN i s pr m (Four a b c d)
  | i < sa      = Split (pullR (s - sa - sbcd) pr m) a (Deep sbcd (Two b c) EmptyT (One d))
  | i < sab     = Split (Deep (s - sbcd) pr m (One a)) b (Deep scd (One c) EmptyT (One d))
  | i < sabc    = Split (Deep (s - scd) pr m (Two a b)) c (Single d)
  | otherwise   = Split (Deep (s - sd) pr m (Three a b c)) d EmptyT
  where
    sa      = size a
    sab     = sa + size b
    sabc    = sab + size c
    sd      = size d
    scd     = size c + sd
    sbcd    = size b + scd

chunksOf :: Int -> Seq a -> Seq (Seq a)
chunksOf n xs | n <= 0 =
  if null xs
    then empty
    else error "chunksOf: A non-empty sequence can only be broken up into positively-sized chunks."
chunksOf 1 s = fmap singleton s
chunksOf n s = splitMap (uncheckedSplitAt . (*n)) const most (replicate numReps ())
                 >< if null end then empty else singleton end
  where
    (numReps, endLength) = length s ${BT}quotRem${BT} n
    (most, end) = splitAt (length s - endLength) s

tails                   :: Seq a -> Seq (Seq a)
tails (Seq xs)          = Seq (tailsTree (Elem . Seq) xs) |> empty

inits                   :: Seq a -> Seq (Seq a)
inits (Seq xs)          = empty <| Seq (initsTree (Elem . Seq) xs)

tailsDigit :: Digit a -> Digit (Digit a)
tailsDigit (One a) = One (One a)
tailsDigit (Two a b) = Two (Two a b) (One b)
tailsDigit (Three a b c) = Three (Three a b c) (Two b c) (One c)
tailsDigit (Four a b c d) = Four (Four a b c d) (Three b c d) (Two c d) (One d)

initsDigit :: Digit a -> Digit (Digit a)
initsDigit (One a) = One (One a)
initsDigit (Two a b) = Two (One a) (Two a b)
initsDigit (Three a b c) = Three (One a) (Two a b) (Three a b c)
initsDigit (Four a b c d) = Four (One a) (Two a b) (Three a b c) (Four a b c d)

tailsNode :: Node a -> Node (Digit a)
tailsNode (Node2 s a b) = Node2 s (Two a b) (One b)
tailsNode (Node3 s a b c) = Node3 s (Three a b c) (Two b c) (One c)

initsNode :: Node a -> Node (Digit a)
initsNode (Node2 s a b) = Node2 s (One a) (Two a b)
initsNode (Node3 s a b c) = Node3 s (One a) (Two a b) (Three a b c)

tailsTree :: Sized a => (FingerTree a -> b) -> FingerTree a -> FingerTree b
tailsTree _ EmptyT = EmptyT
tailsTree f (Single x) = Single (f (Single x))
tailsTree f (Deep n pr m sf) =
    Deep n (fmap (\ pr' -> f (deep pr' m sf)) (tailsDigit pr))
        (tailsTree f' m)
        (fmap (f . digitToTree) (tailsDigit sf))
  where
    f' ms = let ConsLTree node m' = viewLTree ms in
        fmap (\ pr' -> f (deep pr' m' sf)) (tailsNode node)

initsTree :: Sized a => (FingerTree a -> b) -> FingerTree a -> FingerTree b
initsTree _ EmptyT = EmptyT
initsTree f (Single x) = Single (f (Single x))
initsTree f (Deep n pr m sf) =
    Deep n (fmap (f . digitToTree) (initsDigit pr))
        (initsTree f' m)
        (fmap (f . deep pr m) (initsDigit sf))
  where
    f' ms =  let SnocRTree m' node = viewRTree ms in
             fmap (\ sf' -> f (deep pr m' sf')) (initsNode node)

foldlWithIndex :: (b -> Int -> a -> b) -> b -> Seq a -> b
foldlWithIndex f z xs = foldl (\ g x !i -> f (g (i - 1)) i x) (const z) xs (length xs - 1)

foldrWithIndex :: (Int -> a -> b -> b) -> b -> Seq a -> b
foldrWithIndex f z xs = foldr (\ x g !i -> f i x (g (i+1))) (const z) xs 0

listToMaybe' :: [a] -> Maybe a
listToMaybe' = foldr (\ x _ -> Just x) Nothing

takeWhileL :: (a -> Bool) -> Seq a -> Seq a
takeWhileL p = fst . spanl p

dropWhileL :: (a -> Bool) -> Seq a -> Seq a
dropWhileL p = snd . spanl p

spanl :: (a -> Bool) -> Seq a -> (Seq a, Seq a)
spanl p = breakl (not . p)

breakl :: (a -> Bool) -> Seq a -> (Seq a, Seq a)
breakl p xs = foldr (\ i _ -> splitAt i xs) (xs, empty) (findIndicesL p xs)

partition :: (a -> Bool) -> Seq a -> (Seq a, Seq a)
partition p = toPair . foldl' part (empty :*: empty)
  where
    part (xs :*: ys) x
      | p x         = (xs ${BT}snoc'${BT} x) :*: ys
      | otherwise   = xs :*: (ys ${BT}snoc'${BT} x)

filter :: (a -> Bool) -> Seq a -> Seq a
filter p = foldl' (\ xs x -> if p x then xs ${BT}snoc'${BT} x else xs) empty

elemIndexL :: Eq a => a -> Seq a -> Maybe Int
elemIndexL x = findIndexL (x ==)

findIndexL :: (a -> Bool) -> Seq a -> Maybe Int
findIndexL p = listToMaybe' . findIndicesL p

findIndicesL :: (a -> Bool) -> Seq a -> [Int]
findIndicesL p xs = foldrWithIndex g [] xs
  where g i x is = if p x then i:is else is

fromList        :: [a] -> Seq a
fromList = Seq . mkTree . map_elem
  where
    mkTree :: [Elem a] -> FingerTree (Elem a)
    mkTree [] = EmptyT
    mkTree [x1] = Single x1
    mkTree [x1, x2] = Deep 2 (One x1) EmptyT (One x2)
    mkTree [x1, x2, x3] = Deep 3 (Two x1 x2) EmptyT (One x3)
    mkTree [x1, x2, x3, x4] = Deep 4 (Two x1 x2) EmptyT (Two x3 x4)
    mkTree [x1, x2, x3, x4, x5] = Deep 5 (Three x1 x2 x3) EmptyT (Two x4 x5)
    mkTree [x1, x2, x3, x4, x5, x6] =
      Deep 6 (Three x1 x2 x3) EmptyT (Three x4 x5 x6)
    mkTree [x1, x2, x3, x4, x5, x6, x7] =
      Deep 7 (Two x1 x2) (Single (Node3 3 x3 x4 x5)) (Two x6 x7)
    mkTree [x1, x2, x3, x4, x5, x6, x7, x8] =
      Deep 8 (Three x1 x2 x3) (Single (Node3 3 x4 x5 x6)) (Two x7 x8)
    mkTree [x1, x2, x3, x4, x5, x6, x7, x8, x9] =
      Deep 9 (Three x1 x2 x3) (Single (Node3 3 x4 x5 x6)) (Three x7 x8 x9)
    mkTree [x1, x2, x3, x4, x5, x6, x7, x8, y0, y1] =
      Deep 10 (Two x1 x2)
              (Deep 6 (One (Node3 3 x3 x4 x5)) EmptyT (One (Node3 3 x6 x7 x8)))
              (Two y0 y1)
    mkTree [x1, x2, x3, x4, x5, x6, x7, x8, x9, y0, y1] =
      Deep 11 (Three x1 x2 x3)
              (Deep 6 (One (Node3 3 x4 x5 x6)) EmptyT (One (Node3 3 x7 x8 x9)))
              (Two y0 y1)
    mkTree [x1, x2, x3, x4, x5, x6, x7, x8, x9, y0, y1, y2] =
      Deep 12 (Three x1 x2 x3)
              (Deep 6 (One (Node3 3 x4 x5 x6)) EmptyT (One (Node3 3 x7 x8 x9)))
              (Three y0 y1 y2)
    mkTree [x1, x2, x3, x4, x5, x6, x7, x8, y0, y1, y2, y3, y4] =
      Deep 13 (Two x1 x2)
              (Deep 9 (Two (Node3 3 x3 x4 x5) (Node3 3 x6 x7 x8)) EmptyT (One (Node3 3 y0 y1 y2)))
              (Two y3 y4)
    mkTree [x1, x2, x3, x4, x5, x6, x7, x8, x9, y0, y1, y2, y3, y4] =
      Deep 14 (Three x1 x2 x3)
              (Deep 9 (Two (Node3 3 x4 x5 x6) (Node3 3 x7 x8 x9)) EmptyT (One (Node3 3 y0 y1 y2)))
              (Two y3 y4)
    mkTree [x1, x2, x3, x4, x5, x6, x7, x8, x9, y0, y1, y2, y3, y4, y5] =
      Deep 15 (Three x1 x2 x3)
              (Deep 9 (Two (Node3 3 x4 x5 x6) (Node3 3 x7 x8 x9)) EmptyT (One (Node3 3 y0 y1 y2)))
              (Three y3 y4 y5)
    mkTree (x1:x2:x3:x4:x5:x6:x7:x8:x9:y0:y1:y2:y3:y4:y5:y6:xs) =
        mkTreeC cont 9 (getNodes 3 (Node3 3 y3 y4 y5) y6 xs)
      where
        d2 = Three x1 x2 x3
        d1 = Three (Node3 3 x4 x5 x6) (Node3 3 x7 x8 x9) (Node3 3 y0 y1 y2)
        cont (!r1, !r2) !sub =
          let !sub1 = Deep (9 + size r1 + size sub) d1 sub r1
          in Deep (3 + size r2 + size sub1) d2 sub1 r2

    getNodes :: Int
             -> Node a
             -> a
             -> [a]
             -> ListFinal (Node (Node a)) (Digit (Node a), Digit a)
    getNodes !_ n1 x1 [] = LFinal (One n1, One x1)
    getNodes _ n1 x1 [x2] = LFinal (One n1, Two x1 x2)
    getNodes _ n1 x1 [x2, x3] = LFinal (One n1, Three x1 x2 x3)
    getNodes s n1 x1 [x2, x3, x4] = LFinal (Two n1 (Node3 s x1 x2 x3), One x4)
    getNodes s n1 x1 [x2, x3, x4, x5] = LFinal (Two n1 (Node3 s x1 x2 x3), Two x4 x5)
    getNodes s n1 x1 [x2, x3, x4, x5, x6] = LFinal (Two n1 (Node3 s x1 x2 x3), Three x4 x5 x6)
    getNodes s n1 x1 [x2, x3, x4, x5, x6, x7] = LFinal (Three n1 (Node3 s x1 x2 x3) (Node3 s x4 x5 x6), One x7)
    getNodes s n1 x1 [x2, x3, x4, x5, x6, x7, x8] = LFinal (Three n1 (Node3 s x1 x2 x3) (Node3 s x4 x5 x6), Two x7 x8)
    getNodes s n1 x1 [x2, x3, x4, x5, x6, x7, x8, x9] = LFinal (Three n1 (Node3 s x1 x2 x3) (Node3 s x4 x5 x6), Three x7 x8 x9)
    getNodes s n1 x1 (x2:x3:x4:x5:x6:x7:x8:x9:x10:xs) = LCons n10 (getNodes s (Node3 s x7 x8 x9) x10 xs)
      where !n2 = Node3 s x1 x2 x3
            !n3 = Node3 s x4 x5 x6
            !n10 = Node3 (3*s) n1 n2 n3

    mkTreeC ::
               (b -> FingerTree (Node a) -> c)
            -> Int
            -> ListFinal (Node a) b
            -> c
    mkTreeC cont !_ (LFinal b) =
      cont b EmptyT
    mkTreeC cont _ (LCons x1 (LFinal b)) =
      cont b (Single x1)
    mkTreeC cont s (LCons x1 (LCons x2 (LFinal b))) =
      cont b (Deep (2*s) (One x1) EmptyT (One x2))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LFinal b)))) =
      cont b (Deep (3*s) (Two x1 x2) EmptyT (One x3))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LFinal b))))) =
      cont b (Deep (4*s) (Two x1 x2) EmptyT (Two x3 x4))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LFinal b)))))) =
      cont b (Deep (5*s) (Three x1 x2 x3) EmptyT (Two x4 x5))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LFinal b))))))) =
      cont b (Deep (6*s) (Three x1 x2 x3) EmptyT (Three x4 x5 x6))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LFinal b)))))))) =
      cont b (Deep (7*s) (Two x1 x2) (Single (Node3 (3*s) x3 x4 x5)) (Two x6 x7))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LFinal b))))))))) =
      cont b (Deep (8*s) (Three x1 x2 x3) (Single (Node3 (3*s) x4 x5 x6)) (Two x7 x8))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LCons x9 (LFinal b)))))))))) =
      cont b (Deep (9*s) (Three x1 x2 x3) (Single (Node3 (3*s) x4 x5 x6)) (Three x7 x8 x9))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LCons y0 (LCons y1 (LFinal b))))))))))) =
      cont b (Deep (10*s) (Two x1 x2) (Deep (6*s) (One (Node3 (3*s) x3 x4 x5)) EmptyT (One (Node3 (3*s) x6 x7 x8))) (Two y0 y1))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LCons x9 (LCons y0 (LCons y1 (LFinal b)))))))))))) =
      cont b (Deep (11*s) (Three x1 x2 x3) (Deep (6*s) (One (Node3 (3*s) x4 x5 x6)) EmptyT (One (Node3 (3*s) x7 x8 x9))) (Two y0 y1))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LCons x9 (LCons y0 (LCons y1 (LCons y2 (LFinal b))))))))))))) =
      cont b (Deep (12*s) (Three x1 x2 x3) (Deep (6*s) (One (Node3 (3*s) x4 x5 x6)) EmptyT (One (Node3 (3*s) x7 x8 x9))) (Three y0 y1 y2))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LCons y0 (LCons y1 (LCons y2 (LCons y3 (LCons y4 (LFinal b)))))))))))))) =
      cont b (Deep (13*s) (Two x1 x2) (Deep (9*s) (Two (Node3 (3*s) x3 x4 x5) (Node3 (3*s) x6 x7 x8)) EmptyT (One (Node3 (3*s) y0 y1 y2))) (Two y3 y4))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LCons x9 (LCons y0 (LCons y1 (LCons y2 (LCons y3 (LCons y4 (LFinal b))))))))))))))) =
      cont b (Deep (14*s) (Three x1 x2 x3) (Deep (9*s) (Two (Node3 (3*s) x4 x5 x6) (Node3 (3*s) x7 x8 x9)) EmptyT (One (Node3 (3*s) y0 y1 y2))) (Two y3 y4))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LCons x9 (LCons y0 (LCons y1 (LCons y2 (LCons y3 (LCons y4 (LCons y5 (LFinal b)))))))))))))))) =
      cont b (Deep (15*s) (Three x1 x2 x3) (Deep (9*s) (Two (Node3 (3*s) x4 x5 x6) (Node3 (3*s) x7 x8 x9)) EmptyT (One (Node3 (3*s) y0 y1 y2))) (Three y3 y4 y5))
    mkTreeC cont s (LCons x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LCons x9 (LCons y0 (LCons y1 (LCons y2 (LCons y3 (LCons y4 (LCons y5 (LCons y6 xs)))))))))))))))) =
      mkTreeC cont2 (9*s) (getNodesC (3*s) (Node3 (3*s) y3 y4 y5) y6 xs)
      where
        cont2 (b, r1, r2) !sub =
          let d2 = Three x1 x2 x3
              d1 = Three (Node3 (3*s) x4 x5 x6) (Node3 (3*s) x7 x8 x9) (Node3 (3*s) y0 y1 y2)
              !sub1 = Deep (9*s + size r1 + size sub) d1 sub r1
          in cont b $! Deep (3*s + size r2 + size sub1) d2 sub1 r2

    getNodesC :: Int
              -> Node a
              -> a
              -> ListFinal a b
              -> ListFinal (Node (Node a)) (b, Digit (Node a), Digit a)
    getNodesC !_ n1 x1 (LFinal b) = LFinal $ (b, One n1, One x1)
    getNodesC _  n1  x1 (LCons x2 (LFinal b)) = LFinal $ (b, One n1, Two x1 x2)
    getNodesC _  n1  x1 (LCons x2 (LCons x3 (LFinal b))) = LFinal $ (b, One n1, Three x1 x2 x3)
    getNodesC s  n1  x1 (LCons x2 (LCons x3 (LCons x4 (LFinal b)))) =
      let !n2 = Node3 s x1 x2 x3
      in LFinal $ (b, Two n1 n2, One x4)
    getNodesC s  n1  x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LFinal b))))) =
      let !n2 = Node3 s x1 x2 x3
      in LFinal $ (b, Two n1 n2, Two x4 x5)
    getNodesC s  n1  x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LFinal b)))))) =
      let !n2 = Node3 s x1 x2 x3
      in LFinal $ (b, Two n1 n2, Three x4 x5 x6)
    getNodesC s  n1  x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LFinal b))))))) =
      let !n2 = Node3 s x1 x2 x3
          !n3 = Node3 s x4 x5 x6
      in LFinal $ (b, Three n1 n2 n3, One x7)
    getNodesC s  n1  x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LFinal b)))))))) =
      let !n2 = Node3 s x1 x2 x3
          !n3 = Node3 s x4 x5 x6
      in LFinal $ (b, Three n1 n2 n3, Two x7 x8)
    getNodesC s  n1  x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LCons x9 (LFinal b))))))))) =
      let !n2 = Node3 s x1 x2 x3
          !n3 = Node3 s x4 x5 x6
      in LFinal $ (b, Three n1 n2 n3, Three x7 x8 x9)
    getNodesC s  n1  x1 (LCons x2 (LCons x3 (LCons x4 (LCons x5 (LCons x6 (LCons x7 (LCons x8 (LCons x9 (LCons x10 xs))))))))) =
        LCons n10 $ getNodesC s (Node3 s x7 x8 x9) x10 xs
      where !n2 = Node3 s x1 x2 x3
            !n3 = Node3 s x4 x5 x6
            !n10 = Node3 (3*s) n1 n2 n3

    map_elem :: [a] -> [Elem a]
    map_elem xs = B.map Elem xs

data ListFinal a cont = LFinal !cont | LCons !a (ListFinal a cont)

reverse :: Seq a -> Seq a
reverse (Seq xs) = Seq (fmapReverseTree id xs)

fmapReverseTree :: (a -> b) -> FingerTree a -> FingerTree b
fmapReverseTree _ EmptyT = EmptyT
fmapReverseTree f (Single x) = Single (f x)
fmapReverseTree f (Deep s pr m sf) =
    Deep s (reverseDigit f sf)
        (fmapReverseTree (reverseNode f) m)
        (reverseDigit f pr)

reverseDigit :: (a -> b) -> Digit a -> Digit b
reverseDigit f (One a) = One (f a)
reverseDigit f (Two a b) = Two (f b) (f a)
reverseDigit f (Three a b c) = Three (f c) (f b) (f a)
reverseDigit f (Four a b c d) = Four (f d) (f c) (f b) (f a)

reverseNode :: (a -> b) -> Node a -> Node b
reverseNode f (Node2 s a b) = Node2 s (f b) (f a)
reverseNode f (Node3 s a b c) = Node3 s (f c) (f b) (f a)

splitMap :: (Int -> s -> (s,s)) -> (s -> a -> b) -> s -> Seq a -> Seq b
splitMap splt' f0 s0 (Seq xs0) = Seq $ splitMapTreeE splt' (\s' (Elem a) -> Elem (f0 s' a)) s0 xs0

splitMapTreeE :: (Int -> s -> (s,s)) -> (s -> Elem y -> b) -> s -> FingerTree (Elem y) -> FingerTree b
splitMapTreeE _    _ _ EmptyT = EmptyT
splitMapTreeE _    f s (Single xs) = Single $ f s xs
splitMapTreeE splt f s (Deep n pr m sf) = Deep n (splitMapDigit splt f prs pr) (splitMapTreeN splt (\eta1 eta2 -> splitMapNode splt f eta1 eta2) ms m) (splitMapDigit splt f sfs sf)
      where
        !spr = size pr
        sm = n - spr - size sf
        (prs, r) = splt spr s
        (ms, sfs) = splt sm r

splitMapTreeN :: (Int -> s -> (s,s)) -> (s -> Node a -> b) -> s -> FingerTree (Node a) -> FingerTree b
splitMapTreeN _    _ _ EmptyT = EmptyT
splitMapTreeN _    f s (Single xs) = Single $ f s xs
splitMapTreeN splt f s (Deep n pr m sf) = Deep n (splitMapDigit splt f prs pr) (splitMapTreeN splt (\eta1 eta2 -> splitMapNode splt f eta1 eta2) ms m) (splitMapDigit splt f sfs sf)
      where
        (prs, r) = splt (size pr) s
        (ms, sfs) = splt (size m) r

splitMapDigit :: Sized a => (Int -> s -> (s,s)) -> (s -> a -> b) -> s -> Digit a -> Digit b
splitMapDigit _    f s (One a) = One (f s a)
splitMapDigit splt f s (Two a b) = Two (f first a) (f second b)
  where
    (first, second) = splt (size a) s
splitMapDigit splt f s (Three a b c) = Three (f first a) (f second b) (f third c)
  where
    (first, r) = splt (size a) s
    (second, third) = splt (size b) r
splitMapDigit splt f s (Four a b c d) = Four (f first a) (f second b) (f third c) (f fourth d)
  where
    (first, s') = splt (size a) s
    (middle, fourth) = splt (size b + size c) s'
    (second, third) = splt (size b) middle

splitMapNode :: Sized a => (Int -> s -> (s,s)) -> (s -> a -> b) -> s -> Node a -> Node b
splitMapNode splt f s (Node2 ns a b) = Node2 ns (f first a) (f second b)
  where
    (first, second) = splt (size a) s
splitMapNode splt f s (Node3 ns a b c) = Node3 ns (f first a) (f second b) (f third c)
  where
    (first, r) = splt (size a) s
    (second, third) = splt (size b) r

zip :: Seq a -> Seq b -> Seq (a, b)
zip = zipWith (,)

zipWith :: (a -> b -> c) -> Seq a -> Seq b -> Seq c
zipWith f s1 s2 = zipWith' f s1' s2'
  where
    minLen = min (length s1) (length s2)
    s1' = take minLen s1
    s2' = take minLen s2

zipWith' :: (a -> b -> c) -> Seq a -> Seq b -> Seq c
zipWith' f s1 s2 = splitMap uncheckedSplitAt goLeaf s2 s1
  where
    goLeaf (Seq (Single (Elem b))) a = f a b
    goLeaf _ _ = error "Data.Sequence.zipWith'.goLeaf internal error: not a singleton"

sort :: Ord a => Seq a -> Seq a
sort = sortBy compare

sortBy :: (a -> a -> Ordering) -> Seq a -> Seq a
sortBy cmp (Seq xs) =
    maybe
        (Seq EmptyT)
        (execState (replicateA (size xs) (State (popMinIQ cmp))))
        (buildIQ cmp (\s (Elem x) -> IQ s x IQNil) 0 xs)

sortOn :: Ord b => (a -> b) -> Seq a -> Seq a
sortOn f (Seq xs) =
    maybe
       (Seq EmptyT)
       (execState (replicateA (size xs) (State (popMinITQ compare))))
       (buildITQ compare (\s (Elem x) -> ITQ s (f x) x ITQNil) 0 xs)

unstableSort :: Ord a => Seq a -> Seq a
unstableSort = unstableSortBy compare

unstableSortBy :: (a -> a -> Ordering) -> Seq a -> Seq a
unstableSortBy cmp (Seq xs) =
    maybe
        (Seq EmptyT)
        (execState (replicateA (size xs) (State (popMinQ cmp))))
        (buildQ cmp (\(Elem x) -> Q x Nil) xs)

data Queue e = Q !e (QList e)
data QList e
    = Nil
    | QCons !(Queue e)
            (QList e)

data IndexedQueue e =
    IQ !Int !e (IQList e)
data IQList e
    = IQNil
    | IQCons !(IndexedQueue e)
             (IQList e)

data IndexedTaggedQueue e a =
    ITQ !Int !e a (ITQList e a)
data ITQList e a
    = ITQNil
    | ITQCons !(IndexedTaggedQueue e a)
              (ITQList e a)

infixr 8 ${BT}ITQCons${BT}, ${BT}QCons${BT}, ${BT}IQCons${BT}

mergeQ :: (a -> a -> Ordering) -> Queue a -> Queue a -> Queue a
mergeQ cmp q1@(Q x1 ts1) q2@(Q x2 ts2)
  | cmp x1 x2 == GT = Q x2 (q1 ${BT}QCons${BT} ts2)
  | otherwise       = Q x1 (q2 ${BT}QCons${BT} ts1)

mergeIQ :: (a -> a -> Ordering)
        -> IndexedQueue a
        -> IndexedQueue a
        -> IndexedQueue a
mergeIQ cmp q1@(IQ i1 x1 ts1) q2@(IQ i2 x2 ts2) =
    case cmp x1 x2 of
        LT -> IQ i1 x1 (q2 ${BT}IQCons${BT} ts1)
        EQ | i1 <= i2 -> IQ i1 x1 (q2 ${BT}IQCons${BT} ts1)
        _ -> IQ i2 x2 (q1 ${BT}IQCons${BT} ts2)

mergeITQ
    :: (a -> a -> Ordering)
    -> IndexedTaggedQueue a b
    -> IndexedTaggedQueue a b
    -> IndexedTaggedQueue a b
mergeITQ cmp q1@(ITQ i1 x1 y1 ts1) q2@(ITQ i2 x2 y2 ts2) =
    case cmp x1 x2 of
        LT -> ITQ i1 x1 y1 (q2 ${BT}ITQCons${BT} ts1)
        EQ | i1 <= i2 -> ITQ i1 x1 y1 (q2 ${BT}ITQCons${BT} ts1)
        _ -> ITQ i2 x2 y2 (q1 ${BT}ITQCons${BT} ts2)

popMinQ :: (e -> e -> Ordering) -> Queue e -> (Queue e, e)
popMinQ cmp (Q x xs) = (mergeQs xs, x)
  where
    mergeQs (t ${BT}QCons${BT} Nil) = t
    mergeQs (t1 ${BT}QCons${BT} t2 ${BT}QCons${BT} Nil) = t1 <+> t2
    mergeQs (t1 ${BT}QCons${BT} t2 ${BT}QCons${BT} ts) = (t1 <+> t2) <+> mergeQs ts
    mergeQs Nil = error "popMinQ: tried to pop from empty queue"
    (<+>) = mergeQ cmp

popMinIQ :: (e -> e -> Ordering) -> IndexedQueue e -> (IndexedQueue e, e)
popMinIQ cmp (IQ _ x xs) = (mergeQs xs, x)
  where
    mergeQs (t ${BT}IQCons${BT} IQNil) = t
    mergeQs (t1 ${BT}IQCons${BT} t2 ${BT}IQCons${BT} IQNil) = t1 <+> t2
    mergeQs (t1 ${BT}IQCons${BT} t2 ${BT}IQCons${BT} ts) = (t1 <+> t2) <+> mergeQs ts
    mergeQs IQNil = error "popMinQ: tried to pop from empty queue"
    (<+>) = mergeIQ cmp

popMinITQ :: (e -> e -> Ordering)
          -> IndexedTaggedQueue e b
          -> (IndexedTaggedQueue e b, b)
popMinITQ cmp (ITQ _ _ x xs) = (mergeQs xs, x)
  where
    mergeQs (t ${BT}ITQCons${BT} ITQNil) = t
    mergeQs (t1 ${BT}ITQCons${BT} t2 ${BT}ITQCons${BT} ITQNil) = t1 <+> t2
    mergeQs (t1 ${BT}ITQCons${BT} t2 ${BT}ITQCons${BT} ts) = (t1 <+> t2) <+> mergeQs ts
    mergeQs ITQNil = error "popMinQ: tried to pop from empty queue"
    (<+>) = mergeITQ cmp

buildQ :: (b -> b -> Ordering) -> (a -> Queue b) -> FingerTree a -> Maybe (Queue b)
buildQ cmp = foldToMaybeTree (mergeQ cmp)

buildIQ
    :: (b -> b -> Ordering)
    -> (Int -> Elem y -> IndexedQueue b)
    -> Int
    -> FingerTree (Elem y)
    -> Maybe (IndexedQueue b)
buildIQ cmp = foldToMaybeWithIndexTree (mergeIQ cmp)

buildITQ
    :: (b -> b -> Ordering)
    -> (Int -> Elem y -> IndexedTaggedQueue b c)
    -> Int
    -> FingerTree (Elem y)
    -> Maybe (IndexedTaggedQueue b c)
buildITQ cmp = foldToMaybeWithIndexTree (mergeITQ cmp)

foldToMaybeTree :: (b -> b -> b) -> (a -> b) -> FingerTree a -> Maybe b
foldToMaybeTree _ _ EmptyT = Nothing
foldToMaybeTree _ f (Single xs) = Just (f xs)
foldToMaybeTree (<+>) f (Deep _ pr m sf) =
    Just (maybe (pr' <+> sf') ((pr' <+> sf') <+>) m')
  where
    pr' = foldDigit (<+>) f pr
    sf' = foldDigit (<+>) f sf
    m' = foldToMaybeTree (<+>) (foldNode (<+>) f) m

foldToMaybeWithIndexTree :: (b -> b -> b)
                         -> (Int -> Elem y -> b)
                         -> Int
                         -> FingerTree (Elem y)
                         -> Maybe b
foldToMaybeWithIndexTree = foldToMaybeWithIndexTree'
  where
    foldToMaybeWithIndexTree'
        :: Sized a
        => (b -> b -> b) -> (Int -> a -> b) -> Int -> FingerTree a -> Maybe b
    foldToMaybeWithIndexTree' _ _ !_s EmptyT = Nothing
    foldToMaybeWithIndexTree' _ f s (Single xs) = Just (f s xs)
    foldToMaybeWithIndexTree' (<+>) f s (Deep _ pr m sf) =
        Just (maybe (pr' <+> sf') ((pr' <+> sf') <+>) m')
      where
        pr' = digit (<+>) f s pr
        sf' = digit (<+>) f sPsprm sf
        m' = foldToMaybeWithIndexTree' (<+>) (node (<+>) f) sPspr m
        !sPspr = s + size pr
        !sPsprm = sPspr + size m
    digit
        :: Sized a
        => (b -> b -> b) -> (Int -> a -> b) -> Int -> Digit a -> b
    digit = foldWithIndexDigit
    node
        :: Sized a
        => (b -> b -> b) -> (Int -> a -> b) -> Int -> Node a -> b
    node = foldWithIndexNode
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
