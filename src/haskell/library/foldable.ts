import { BT } from './source';

export const FOLDABLE = String.raw`
data FoldEndo a = FoldEndo !(a -> a)

runFoldEndo :: FoldEndo a -> a -> a
runFoldEndo (FoldEndo f) = f

instance Semigroup (FoldEndo a) where
  FoldEndo f <> FoldEndo g = FoldEndo (f . g)

instance Monoid (FoldEndo a) where
  mempty = FoldEndo id

data FoldDual a = FoldDual { runFoldDual :: !a }
data FoldSum a = FoldSum { runFoldSum :: !a }
data FoldProduct a = FoldProduct { runFoldProduct :: !a }
data FoldMax a = FoldMax { runFoldMax :: !(Maybe a) }
data FoldMin a = FoldMin { runFoldMin :: !(Maybe a) }
data FoldAny = FoldAny { runFoldAny :: !Bool }
data FoldAll = FoldAll { runFoldAll :: !Bool }
data FoldFirst a = FoldFirst { runFoldFirst :: !(Maybe a) }

instance Semigroup a => Semigroup (FoldDual a) where
  FoldDual x <> FoldDual y = FoldDual (y <> x)

instance Monoid a => Monoid (FoldDual a) where
  mempty = FoldDual mempty

instance Num a => Semigroup (FoldSum a) where
  FoldSum x <> FoldSum y = FoldSum (x + y)

instance Num a => Monoid (FoldSum a) where
  mempty = FoldSum 0
  mconcat = listFoldl' (<>) mempty

instance Num a => Semigroup (FoldProduct a) where
  FoldProduct x <> FoldProduct y = FoldProduct (x * y)

instance Num a => Monoid (FoldProduct a) where
  mempty = FoldProduct 1
  mconcat = listFoldl' (<>) mempty

instance Ord a => Semigroup (FoldMax a) where
  m <> FoldMax Nothing = m
  FoldMax Nothing <> n = n
  (FoldMax m@(Just x)) <> (FoldMax n@(Just y)) = if x >= y then FoldMax m else FoldMax n

instance Ord a => Monoid (FoldMax a) where
  mempty = FoldMax Nothing
  mconcat = listFoldl' (<>) mempty

instance Ord a => Semigroup (FoldMin a) where
  m <> FoldMin Nothing = m
  FoldMin Nothing <> n = n
  (FoldMin m@(Just x)) <> (FoldMin n@(Just y)) = if x <= y then FoldMin m else FoldMin n

instance Ord a => Monoid (FoldMin a) where
  mempty = FoldMin Nothing
  mconcat = listFoldl' (<>) mempty

instance Semigroup FoldAny where
  FoldAny x <> FoldAny y = FoldAny (x || y)

instance Monoid FoldAny where
  mempty = FoldAny False

instance Semigroup FoldAll where
  FoldAll x <> FoldAll y = FoldAll (x && y)

instance Monoid FoldAll where
  mempty = FoldAll True

instance Semigroup (FoldFirst a) where
  FoldFirst Nothing <> n = n
  m <> _ = m

instance Monoid (FoldFirst a) where
  mempty = FoldFirst Nothing

class Foldable t where
  fold :: Monoid m => t m -> m
  foldMap' :: Monoid m => (a -> m) -> t a -> m
  foldMap :: Monoid m => (a -> m) -> t a -> m
  foldr :: (a -> b -> b) -> b -> t a -> b
  foldl :: (b -> a -> b) -> b -> t a -> b
  foldr' :: (a -> b -> b) -> b -> t a -> b
  foldl' :: (b -> a -> b) -> b -> t a -> b
  foldr1 :: (a -> a -> a) -> t a -> a
  foldl1 :: (a -> a -> a) -> t a -> a
  toList :: t a -> [a]
  null :: t a -> Bool
  length :: t a -> Int
  elem :: Eq a => a -> t a -> Bool
  maximum :: Ord a => t a -> a
  minimum :: Ord a => t a -> a
  sum :: Num a => t a -> a
  product :: Num a => t a -> a
  fold = foldMap id
  foldMap' f = foldl' (\acc x -> acc <> f x) mempty
  foldMap f = foldr (\x acc -> mappend (f x) acc) mempty
  foldr f z t = runFoldEndo (foldMap (\x -> FoldEndo (f x)) t) z
  foldl f z t = runFoldEndo (runFoldDual (foldMap (\x -> FoldDual (FoldEndo (\acc -> f acc x))) t)) z
  foldr' f z t = foldl (\k x acc -> acc ${BT}seq${BT} k (f x acc)) id t z
  foldl' f z t = foldr (\x k acc -> acc ${BT}seq${BT} k (f acc x)) id t z
  foldr1 f t = fromMaybe (errorWithoutStackTrace "foldr1: empty structure") (foldr step Nothing t)
    where step x rest = Just (case rest of
            Nothing -> x
            Just y -> f x y)
  foldl1 f t = fromMaybe (errorWithoutStackTrace "foldl1: empty structure") (foldl step Nothing t)
    where step rest y = Just (case rest of
            Nothing -> y
            Just x -> f x y)
  toList t = foldr (:) [] t
  null t = foldr (\_ _ -> False) True t
  length = foldl' (\count _ -> count + 1) 0
  elem x = any (x ==)
  maximum = fromMaybe (errorWithoutStackTrace "maximum: empty structure") . runFoldMax . foldMap' (\x -> FoldMax (Just x))
  minimum = fromMaybe (errorWithoutStackTrace "minimum: empty structure") . runFoldMin . foldMap' (\x -> FoldMin (Just x))
  sum = runFoldSum . foldMap' FoldSum
  product = runFoldProduct . foldMap' FoldProduct

instance Foldable [] where
  fold = mconcat
  foldMap f = mconcat . map f
  foldr = listFoldr
  foldr' = listFoldr'
  foldl = listFoldl
  foldl' = listFoldl'
  foldr1 = listFoldr1
  foldl1 = listFoldl1
  toList xs = xs
  null [] = True
  null _ = False
  length = listLength
  elem = listElem
  maximum = listMaximum
  minimum = listMinimum
  sum = listSum
  product = listProduct

instance Foldable Maybe where
  foldMap f Nothing = mempty
  foldMap f (Just x) = f x
  foldr _ z Nothing = z
  foldr f z (Just x) = f x z
  toList Nothing = []
  toList (Just x) = [x]

instance Foldable (Either a) where
  foldMap _ (Left _) = mempty
  foldMap f (Right y) = f y
  foldr _ z (Left _) = z
  foldr f z (Right y) = f y z
  toList (Left _) = []
  toList (Right y) = [y]
  length (Left _) = 0
  length (Right _) = 1
  null (Left _) = True
  null (Right _) = False

instance Foldable ((,) a) where
  foldMap f (_, y) = f y
  foldr f z (_, y) = f y z
  toList (_, y) = [y]
  length _ = 1
  null _ = False
`;
