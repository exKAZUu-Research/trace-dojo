import { BT } from './source';

/** Lists, the functor-to-monad classes, `Semigroup`, `Monoid`, `Foldable`, and `Traversable`. */
export const BASE_LIST = String.raw`
-- Functor, Applicative, Monad

class Functor f where
  fmap :: (a -> b) -> f a -> f b
  (<$) :: a -> f b -> f a
  (<$) = fmap . const

class Functor f => Applicative f where
  pure :: a -> f a
  (<*>) :: f (a -> b) -> f a -> f b
  liftA2 :: (a -> b -> c) -> f a -> f b -> f c
  (*>) :: f a -> f b -> f b
  (<*) :: f a -> f b -> f a
  (<*>) = liftA2 id
  liftA2 f x y = fmap f x <*> y
  a1 *> a2 = (id <$ a1) <*> a2
  a <* b = liftA2 const a b

class Applicative m => Monad m where
  (>>=) :: m a -> (a -> m b) -> m b
  (>>) :: m a -> m b -> m b
  return :: a -> m a
  m >> k = m >>= \_ -> k
  return = pure

class Monad m => MonadFail m where
  fail :: String -> m a

class Applicative f => Alternative f where
  empty :: f a
  (<|>) :: f a -> f a -> f a
  some :: f a -> f [a]
  many :: f a -> f [a]
  some v = (:) <$> v <*> many v
  many v = some v <|> pure []

class (Alternative m, Monad m) => MonadPlus m where
  mzero :: m a
  mplus :: m a -> m a -> m a
  mzero = empty
  mplus = (<|>)

(<$>) :: Functor f => (a -> b) -> f a -> f b
(<$>) = fmap

(<&>) :: Functor f => f a -> (a -> b) -> f b
as <&> f = f <$> as

($>) :: Functor f => f a -> b -> f b
($>) = flip (<$)

void :: Functor f => f a -> f ()
void x = () <$ x

(=<<) :: Monad m => (a -> m b) -> m a -> m b
f =<< x = x >>= f

(>=>) :: Monad m => (a -> m b) -> (b -> m c) -> a -> m c
f >=> g = \x -> f x >>= g

(<=<) :: Monad m => (b -> m c) -> (a -> m b) -> a -> m c
g <=< f = \x -> f x >>= g

liftA :: Applicative f => (a -> b) -> f a -> f b
liftA f a = pure f <*> a

liftA3 :: Applicative f => (a -> b -> c -> d) -> f a -> f b -> f c -> f d
liftA3 f a b c = liftA2 f a b <*> c

liftM :: Monad m => (a1 -> r) -> m a1 -> m r
liftM f m1 = m1 >>= \x1 -> return (f x1)

liftM2 :: Monad m => (a1 -> a2 -> r) -> m a1 -> m a2 -> m r
liftM2 f m1 m2 = m1 >>= \x1 -> m2 >>= \x2 -> return (f x1 x2)

ap :: Monad m => m (a -> b) -> m a -> m b
ap m1 m2 = m1 >>= \x1 -> m2 >>= \x2 -> return (x1 x2)

join :: Monad m => m (m a) -> m a
join x = x >>= id

when :: Applicative f => Bool -> f () -> f ()
when p s = if p then s else pure ()

unless :: Applicative f => Bool -> f () -> f ()
unless p s = if p then pure () else s

guard :: Alternative f => Bool -> f ()
guard True = pure ()
guard False = empty

mapM_ :: (Foldable t, Monad m) => (a -> m b) -> t a -> m ()
mapM_ f = foldr c (return ())
  where c x k = f x >> k

forM_ :: (Foldable t, Monad m) => t a -> (a -> m b) -> m ()
forM_ = flip mapM_

traverse_ :: (Foldable t, Applicative f) => (a -> f b) -> t a -> f ()
traverse_ f = foldr c (pure ())
  where c x k = f x *> k

for_ :: (Foldable t, Applicative f) => t a -> (a -> f b) -> f ()
for_ = flip traverse_

sequence_ :: (Foldable t, Monad m) => t (m a) -> m ()
sequence_ = foldr c (return ())
  where c m k = m >> k

sequenceA_ :: (Foldable t, Applicative f) => t (f a) -> f ()
sequenceA_ = foldr c (pure ())
  where c m k = m *> k

forM :: (Traversable t, Monad m) => t a -> (a -> m b) -> m (t b)
forM = flip mapM

for :: (Traversable t, Applicative f) => t a -> (a -> f b) -> f (t b)
for = flip traverse

msum :: (Foldable t, MonadPlus m) => t (m a) -> m a
msum = foldr mplus mzero

asum :: (Foldable t, Alternative f) => t (f a) -> f a
asum = foldr (<|>) empty

replicateM :: Applicative m => Int -> m a -> m [a]
replicateM cnt0 f = loop cnt0
  where loop cnt = if cnt <= 0 then pure [] else liftA2 (:) f (loop (cnt - 1))

replicateM_ :: Applicative m => Int -> m a -> m ()
replicateM_ cnt0 f = loop cnt0
  where loop cnt = if cnt <= 0 then pure () else f *> loop (cnt - 1)

foldM :: (Foldable t, Monad m) => (b -> a -> m b) -> b -> t a -> m b
foldM f z0 xs = foldr c return xs z0
  where c x k z = f z x >>= k

foldM_ :: (Foldable t, Monad m) => (b -> a -> m b) -> b -> t a -> m ()
foldM_ f a xs = foldM f a xs >> return ()

zipWithM :: Applicative m => (a -> b -> m c) -> [a] -> [b] -> m [c]
zipWithM f xs ys = sequenceA (zipWith f xs ys)

zipWithM_ :: Applicative m => (a -> b -> m c) -> [a] -> [b] -> m ()
zipWithM_ f xs ys = sequenceA_ (zipWith f xs ys)

filterM :: Applicative m => (a -> m Bool) -> [a] -> m [a]
filterM p = foldr (\x -> liftA2 (\flg -> if flg then (x:) else id) (p x)) (pure [])

mapAndUnzipM :: Applicative m => (a -> m (b, c)) -> [a] -> m ([b], [c])
mapAndUnzipM f xs = unzip <$> traverse f xs

forever :: Applicative f => f a -> f b
forever a = let a' = a *> a' in a'

instance Functor [] where
  fmap = map

instance Applicative [] where
  pure x = [x]
  fs <*> xs = [f x | f <- fs, x <- xs]
  liftA2 f xs ys = [f x y | x <- xs, y <- ys]
  xs *> ys = [y | _ <- xs, y <- ys]

instance Monad [] where
  xs >>= f = concatMapList f xs
  (>>) = (*>)

instance MonadFail [] where
  fail _ = []

instance Alternative [] where
  empty = []
  (<|>) = (++)

instance MonadPlus []

instance Functor Maybe where
  fmap _ Nothing = Nothing
  fmap f (Just a) = Just (f a)

instance Applicative Maybe where
  pure = Just
  Just f <*> m = fmap f m
  Nothing <*> _m = Nothing
  liftA2 f (Just x) (Just y) = Just (f x y)
  liftA2 _ _ _ = Nothing
  Just _m1 *> m2 = m2
  Nothing *> _m2 = Nothing

instance Monad Maybe where
  (Just x) >>= k = k x
  Nothing >>= _ = Nothing
  (>>) = (*>)

instance MonadFail Maybe where
  fail _ = Nothing

instance Alternative Maybe where
  empty = Nothing
  Nothing <|> r = r
  l <|> _ = l

instance MonadPlus Maybe

instance Functor (Either e) where
  fmap _ (Left x) = Left x
  fmap f (Right y) = Right (f y)

instance Applicative (Either e) where
  pure = Right
  Left e <*> _ = Left e
  Right f <*> r = fmap f r

instance Monad (Either e) where
  Left l >>= _ = Left l
  Right r >>= k = k r

instance Functor ((->) r) where
  fmap = (.)

instance Applicative ((->) r) where
  pure = const
  (<*>) f g x = f x (g x)
  liftA2 q f g x = q (f x) (g x)

instance Monad ((->) r) where
  f >>= k = \r -> k (f r) r

instance Functor ((,) a) where
  fmap f (x, y) = (x, f y)

instance Monoid a => Applicative ((,) a) where
  pure x = (mempty, x)
  (u, f) <*> (v, x) = (u <> v, f x)
  liftA2 f (u, x) (v, y) = (u <> v, f x y)

instance Monoid a => Monad ((,) a) where
  (u, a) >>= k = case k a of
    (v, b) -> (u <> v, b)

-- Semigroup and Monoid

class Semigroup a where
  (<>) :: a -> a -> a
  stimes :: Integral b => b -> a -> a
  stimes n x = if n <= fromInteger 0 then errorWithoutStackTrace "stimes: positive multiplier expected"
               else if n == fromInteger 1 then x else x <> stimes (n - fromInteger 1) x

class Semigroup a => Monoid a where
  mempty :: a
  mappend :: a -> a -> a
  mconcat :: [a] -> a
  mappend = (<>)
  mconcat = foldr mappend mempty

instance Semigroup [a] where
  (<>) = (++)

instance Monoid [a] where
  mempty = []

instance Semigroup Ordering where
  LT <> _ = LT
  EQ <> y = y
  GT <> _ = GT

instance Monoid Ordering where
  mempty = EQ

instance Semigroup () where
  _ <> _ = ()

instance Monoid () where
  mempty = ()

instance Semigroup a => Semigroup (Maybe a) where
  Nothing <> b = b
  a <> Nothing = a
  Just a <> Just b = Just (a <> b)

instance Semigroup a => Monoid (Maybe a) where
  mempty = Nothing

instance Semigroup b => Semigroup (a -> b) where
  f <> g = \x -> f x <> g x

instance Monoid b => Monoid (a -> b) where
  mempty _ = mempty

instance (Semigroup a, Semigroup b) => Semigroup (a, b) where
  (a, b) <> (a', b') = (a <> a', b <> b')

instance (Monoid a, Monoid b) => Monoid (a, b) where
  mempty = (mempty, mempty)

instance Semigroup (Either a b) where
  Left _ <> b = b
  a <> _ = a

-- Lists

concatMapList :: (a -> [b]) -> [a] -> [b]
concatMapList _ [] = []
concatMapList f (x:xs) = f x ++ concatMapList f xs

map :: (a -> b) -> [a] -> [b]
map _ [] = []
map f (x:xs) = f x : map f xs

(++) :: [a] -> [a] -> [a]
(++) [] ys = ys
(++) (x:xs) ys = x : xs ++ ys

filter :: (a -> Bool) -> [a] -> [a]
filter _ [] = []
filter pred (x:xs) = if pred x then x : filter pred xs else filter pred xs

head :: [a] -> a
head (x:_) = x
head [] = errorEmptyList "head"

last :: [a] -> a
last [x] = x
last (_:xs) = last xs
last [] = errorEmptyList "last"

tail :: [a] -> [a]
tail (_:xs) = xs
tail [] = errorEmptyList "tail"

init :: [a] -> [a]
init [x] = []
init (x:xs) = x : init xs
init [] = errorEmptyList "init"

uncons :: [a] -> Maybe (a, [a])
uncons [] = Nothing
uncons (x:xs) = Just (x, xs)

unsnoc :: [a] -> Maybe ([a], a)
unsnoc [] = Nothing
unsnoc xs = Just (init xs, last xs)

singleton :: a -> [a]
singleton x = [x]

(!!) :: [a] -> Int -> a
xs !! n = if n < 0 then errorWithoutStackTrace "Prelude.!!: negative index" else nth xs n
  where nth [] _ = errorWithoutStackTrace "Prelude.!!: index too large"
        nth (y:ys) k = if k == 0 then y else nth ys (k - 1)

(!?) :: [a] -> Int -> Maybe a
xs !? n = if n < 0 then Nothing else nth xs n
  where nth [] _ = Nothing
        nth (y:ys) k = if k == 0 then Just y else nth ys (k - 1)

reverse :: [a] -> [a]
reverse l = rev l []
  where rev [] a = a
        rev (x:xs) a = rev xs (x:a)

listFoldl :: (b -> a -> b) -> b -> [a] -> b
listFoldl f z [] = z
listFoldl f z (x:xs) = listFoldl f (f z x) xs

listFoldl' :: (b -> a -> b) -> b -> [a] -> b
listFoldl' f z [] = z
listFoldl' f z (x:xs) = z ${BT}seq${BT} listFoldl' f (f z x) xs

listFoldr :: (a -> b -> b) -> b -> [a] -> b
listFoldr k z = go
  where go [] = z
        go (y:ys) = y ${BT}k${BT} go ys

listFoldr1 :: (a -> a -> a) -> [a] -> a
listFoldr1 f = go
  where go [x] = x
        go (x:xs) = f x (go xs)
        go [] = errorEmptyList "foldr1"

listFoldl1 :: (a -> a -> a) -> [a] -> a
listFoldl1 f (x:xs) = listFoldl f x xs
listFoldl1 _ [] = errorEmptyList "foldl1"

listMaximum :: Ord a => [a] -> a
listMaximum [] = errorEmptyList "maximum"
listMaximum (x:xs) = listFoldl' max x xs

listMinimum :: Ord a => [a] -> a
listMinimum [] = errorEmptyList "minimum"
listMinimum (x:xs) = listFoldl' min x xs

listLength :: [a] -> Int
listLength xs = lenAcc xs 0
  where lenAcc :: [a] -> Int -> Int
        lenAcc [] n = n
        lenAcc (_:ys) n = let n' = n + 1 in n' ${BT}seq${BT} lenAcc ys n'

listSum :: Num a => [a] -> a
listSum = listFoldl' (+) (fromInteger 0)

listProduct :: Num a => [a] -> a
listProduct = listFoldl' (*) (fromInteger 1)

listElem :: Eq a => a -> [a] -> Bool
listElem _ [] = False
listElem x (y:ys) = x == y || listElem x ys

scanl :: (b -> a -> b) -> b -> [a] -> [b]
scanl f q ls = q : (case ls of
                      [] -> []
                      x:xs -> scanl f (f q x) xs)

scanl1 :: (a -> a -> a) -> [a] -> [a]
scanl1 f (x:xs) = scanl f x xs
scanl1 _ [] = []

scanl' :: (b -> a -> b) -> b -> [a] -> [b]
scanl' f q ls = q ${BT}seq${BT} (q : (case ls of
                                  [] -> []
                                  x:xs -> scanl' f (f q x) xs))

scanr :: (a -> b -> b) -> b -> [a] -> [b]
scanr _ q0 [] = [q0]
scanr f q0 (x:xs) = let qs = scanr f q0 xs in f x (head qs) : qs

scanr1 :: (a -> a -> a) -> [a] -> [a]
scanr1 _ [] = []
scanr1 _ [x] = [x]
scanr1 f (x:xs) = let qs = scanr1 f xs in f x (head qs) : qs

iterate :: (a -> a) -> a -> [a]
iterate f x = x : iterate f (f x)

iterate' :: (a -> a) -> a -> [a]
iterate' f x = let x' = f x in x' ${BT}seq${BT} (x : iterate' f x')

repeat :: a -> [a]
repeat x = let xs = x : xs in xs

replicate :: Int -> a -> [a]
replicate n x = take n (repeat x)

cycle :: [a] -> [a]
cycle [] = errorEmptyList "cycle"
cycle xs = let xs' = xs ++ xs' in xs'

take :: Int -> [a] -> [a]
take n xs = if n <= 0 then [] else case xs of
  [] -> []
  (y:ys) -> y : take (n - 1) ys

drop :: Int -> [a] -> [a]
drop n xs = if n <= 0 then xs else case xs of
  [] -> []
  (_:ys) -> drop (n - 1) ys

splitAt :: Int -> [a] -> ([a], [a])
splitAt n xs = (take n xs, drop n xs)

takeWhile :: (a -> Bool) -> [a] -> [a]
takeWhile _ [] = []
takeWhile p (x:xs) = if p x then x : takeWhile p xs else []

dropWhile :: (a -> Bool) -> [a] -> [a]
dropWhile _ [] = []
dropWhile p xs@(x:xs') = if p x then dropWhile p xs' else xs

dropWhileEnd :: (a -> Bool) -> [a] -> [a]
dropWhileEnd p = foldr (\x xs -> if p x && null xs then [] else x : xs) []

span :: (a -> Bool) -> [a] -> ([a], [a])
span _ xs@[] = (xs, xs)
span p xs@(x:xs') = if p x then (let (ys, zs) = span p xs' in (x:ys, zs)) else ([], xs)

break :: (a -> Bool) -> [a] -> ([a], [a])
break p = span (not . p)

stripPrefix :: Eq a => [a] -> [a] -> Maybe [a]
stripPrefix [] ys = Just ys
stripPrefix (x:xs) (y:ys) = if x == y then stripPrefix xs ys else Nothing
stripPrefix _ _ = Nothing

lookup :: Eq a => a -> [(a, b)] -> Maybe b
lookup _ [] = Nothing
lookup key ((x, y):xys) = if key == x then Just y else lookup key xys

zip :: [a] -> [b] -> [(a, b)]
zip (a:as) (b:bs) = (a, b) : zip as bs
zip _ _ = []

zip3 :: [a] -> [b] -> [c] -> [(a, b, c)]
zip3 (a:as) (b:bs) (c:cs) = (a, b, c) : zip3 as bs cs
zip3 _ _ _ = []

zipWith :: (a -> b -> c) -> [a] -> [b] -> [c]
zipWith f (a:as) (b:bs) = f a b : zipWith f as bs
zipWith _ _ _ = []

zipWith3 :: (a -> b -> c -> d) -> [a] -> [b] -> [c] -> [d]
zipWith3 z (a:as) (b:bs) (c:cs) = z a b c : zipWith3 z as bs cs
zipWith3 _ _ _ _ = []

unzip :: [(a, b)] -> ([a], [b])
unzip xs = (map fst xs, map snd xs)

unzip3 :: [(a, b, c)] -> ([a], [b], [c])
unzip3 xs = (map (\(a, _, _) -> a) xs, map (\(_, b, _) -> b) xs, map (\(_, _, c) -> c) xs)

lines :: String -> [String]
lines "" = []
lines s = let (l, s') = break (== '\n') s
          in l : (case s' of
                    [] -> []
                    _:s'' -> lines s'')

unlines :: [String] -> String
unlines [] = []
unlines (l:ls) = l ++ '\n' : unlines ls

words :: String -> [String]
words s = case dropWhile isSpace s of
  "" -> []
  s' -> let (w, s'') = break isSpace s' in w : words s''

unwords :: [String] -> String
unwords [] = ""
unwords [w] = w
unwords (w:ws) = w ++ ' ' : unwords ws

-- Foldable and Traversable

data FoldEndo a = FoldEndo (a -> a)

runFoldEndo :: FoldEndo a -> a -> a
runFoldEndo (FoldEndo f) = f

instance Semigroup (FoldEndo a) where
  FoldEndo f <> FoldEndo g = FoldEndo (f . g)

instance Monoid (FoldEndo a) where
  mempty = FoldEndo id

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
  foldMap f = foldr (\x acc -> f x <> acc) mempty
  foldr f z t = runFoldEndo (foldMap (\x -> FoldEndo (f x)) t) z
  foldl f z t = listFoldl f z (toList t)
  foldr' f z t = foldl (\k x acc -> k $! f x acc) id t z
  foldl' f z t = listFoldl' f z (toList t)
  foldr1 f t = case toList t of
    [] -> errorWithoutStackTrace "foldr1: empty structure"
    xs -> listFoldr1 f xs
  foldl1 f t = case toList t of
    [] -> errorWithoutStackTrace "foldl1: empty structure"
    xs -> listFoldl1 f xs
  toList t = foldr (:) [] t
  null t = foldr (\_ _ -> False) True t
  length t = listLength (toList t)
  elem x t = listElem x (toList t)
  maximum t = case toList t of
    [] -> errorWithoutStackTrace "maximum: empty structure"
    xs -> listMaximum xs
  minimum t = case toList t of
    [] -> errorWithoutStackTrace "minimum: empty structure"
    xs -> listMinimum xs
  sum t = listSum (toList t)
  product t = listProduct (toList t)

instance Foldable [] where
  foldMap f = listFoldr (\x acc -> f x <> acc) mempty
  foldr = listFoldr
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

class (Functor t, Foldable t) => Traversable t where
  traverse :: Applicative f => (a -> f b) -> t a -> f (t b)
  sequenceA :: Applicative f => t (f a) -> f (t a)
  mapM :: Monad m => (a -> m b) -> t a -> m (t b)
  sequence :: Monad m => t (m a) -> m (t a)
  traverse f = sequenceA . fmap f
  sequenceA = traverse id
  mapM = traverse
  sequence = sequenceA

instance Traversable [] where
  traverse f = listFoldr cons_f (pure [])
    where cons_f x ys = liftA2 (:) (f x) ys

instance Traversable Maybe where
  traverse _ Nothing = pure Nothing
  traverse f (Just x) = Just <$> f x

instance Traversable (Either a) where
  traverse _ (Left x) = pure (Left x)
  traverse f (Right y) = Right <$> f y

instance Traversable ((,) a) where
  traverse f (x, y) = (\b -> (x, b)) <$> f y

concat :: Foldable t => t [a] -> [a]
concat xs = foldr (++) [] xs

concatMap :: Foldable t => (a -> [b]) -> t a -> [b]
concatMap f xs = foldr (\x b -> f x ++ b) [] xs

and :: Foldable t => t Bool -> Bool
and = foldr (&&) True

or :: Foldable t => t Bool -> Bool
or = foldr (||) False

any :: Foldable t => (a -> Bool) -> t a -> Bool
any p = foldr (\x acc -> p x || acc) False

all :: Foldable t => (a -> Bool) -> t a -> Bool
all p = foldr (\x acc -> p x && acc) True

notElem :: (Foldable t, Eq a) => a -> t a -> Bool
notElem x = not . elem x

find :: Foldable t => (a -> Bool) -> t a -> Maybe a
find p t = listFind (toList t)
  where listFind [] = Nothing
        listFind (x:xs) = if p x then Just x else listFind xs

maximumBy :: Foldable t => (a -> a -> Ordering) -> t a -> a
maximumBy cmp t = case toList t of
  [] -> errorWithoutStackTrace "maximumBy: empty structure"
  (x:xs) -> listFoldl (\a b -> case cmp a b of
                                 GT -> a
                                 _ -> b) x xs

minimumBy :: Foldable t => (a -> a -> Ordering) -> t a -> a
minimumBy cmp t = case toList t of
  [] -> errorWithoutStackTrace "minimumBy: empty structure"
  (x:xs) -> listFoldl (\a b -> case cmp a b of
                                 GT -> b
                                 _ -> a) x xs

foldrM :: (Foldable t, Monad m) => (a -> b -> m b) -> b -> t a -> m b
foldrM f z0 xs = foldl c return xs z0
  where c k x z = f x z >>= k

foldlM :: (Foldable t, Monad m) => (b -> a -> m b) -> b -> t a -> m b
foldlM f z0 xs = foldr c return xs z0
  where c x k z = f z x >>= k

-- Maybe and Either helpers

fromMaybe :: a -> Maybe a -> a
fromMaybe d x = case x of
  Nothing -> d
  Just v -> v

fromJust :: Maybe a -> a
fromJust Nothing = error "Maybe.fromJust: Nothing"
fromJust (Just x) = x

isJust :: Maybe a -> Bool
isJust Nothing = False
isJust _ = True

isNothing :: Maybe a -> Bool
isNothing Nothing = True
isNothing _ = False

catMaybes :: [Maybe a] -> [a]
catMaybes ls = [x | Just x <- ls]

mapMaybe :: (a -> Maybe b) -> [a] -> [b]
mapMaybe _ [] = []
mapMaybe f (x:xs) = let rs = mapMaybe f xs in case f x of
  Nothing -> rs
  Just r -> r : rs

listToMaybe :: [a] -> Maybe a
listToMaybe [] = Nothing
listToMaybe (a:_) = Just a

maybeToList :: Maybe a -> [a]
maybeToList Nothing = []
maybeToList (Just x) = [x]

lefts :: [Either a b] -> [a]
lefts x = [a | Left a <- x]

rights :: [Either a b] -> [b]
rights x = [a | Right a <- x]

partitionEithers :: [Either a b] -> ([a], [b])
partitionEithers xs = (lefts xs, rights xs)

isLeft :: Either a b -> Bool
isLeft (Left _) = True
isLeft (Right _) = False

isRight :: Either a b -> Bool
isRight (Left _) = False
isRight (Right _) = True

fromLeft :: a -> Either a b -> a
fromLeft _ (Left a) = a
fromLeft a _ = a

fromRight :: b -> Either a b -> b
fromRight _ (Right b) = b
fromRight b _ = b
`;
void BT;
