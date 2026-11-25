/**
 * `Data.Void`, `Data.Fixed`'s division of real numbers, and `Data.Complex`, as GHC's base defines them, which join
 * the base module.
 */
export const BASE_SMALL_MODULES = String.raw`
-- Data.Void

data Void

instance Eq Void where
  _ == _ = True

instance Ord Void where
  compare _ _ = EQ

instance Show Void where
  showsPrec _ v = absurd v

absurd :: Void -> a
absurd v = case v of {}

vacuous :: Functor f => f Void -> f a
vacuous = fmap absurd

-- Data.Fixed

div' :: (Real a, Integral b) => a -> a -> b
div' n d = floor (toRational n / toRational d)

mod' :: Real a => a -> a -> a
mod' n d = n - fromInteger f * d
  where f = div' n d

divMod' :: (Real a, Integral b) => a -> a -> (b, a)
divMod' n d = (f, n - fromIntegral f * d)
  where f = div' n d

-- Data.Complex

infix 6 :+

data Complex a = !a :+ !a deriving (Eq, Show, Read)

realPart :: Complex a -> a
realPart (x :+ _) = x

imagPart :: Complex a -> a
imagPart (_ :+ y) = y

conjugate :: Num a => Complex a -> Complex a
conjugate (x :+ y) = x :+ negate y

mkPolar :: Floating a => a -> a -> Complex a
mkPolar r theta = (r * cos theta) :+ (r * sin theta)

cis :: Floating a => a -> Complex a
cis theta = cos theta :+ sin theta

polar :: RealFloat a => Complex a -> (a, a)
polar z = (magnitude z, phase z)

-- As GHC's, scaling the parts first so that their squares do not overflow.
magnitude :: RealFloat a => Complex a -> a
magnitude (x :+ y) = scaleFloat k (sqrt (sqr (scaleFloat mk x) + sqr (scaleFloat mk y)))
  where
    k = max (exponent x) (exponent y)
    mk = negate k
    sqr z = z * z

phase :: RealFloat a => Complex a -> a
phase (0 :+ 0) = 0
phase (x :+ y) = atan2 y x

instance Functor Complex where
  fmap f (x :+ y) = f x :+ f y

instance Foldable Complex where
  foldr f z (x :+ y) = f x (f y z)

instance Traversable Complex where
  traverse f (x :+ y) = (:+) <$> f x <*> f y

instance Applicative Complex where
  pure a = a :+ a
  (f :+ g) <*> (a :+ b) = f a :+ g b

instance Monad Complex where
  (a :+ b) >>= f = realPart (f a) :+ imagPart (f b)

instance RealFloat a => Num (Complex a) where
  (x :+ y) + (x' :+ y') = (x + x') :+ (y + y')
  (x :+ y) - (x' :+ y') = (x - x') :+ (y - y')
  (x :+ y) * (x' :+ y') = (x * x' - y * y') :+ (x * y' + y * x')
  negate (x :+ y) = negate x :+ negate y
  abs z = magnitude z :+ 0
  signum (0 :+ 0) = 0
  signum z@(x :+ y) = let r = magnitude z in (x / r) :+ (y / r)
  fromInteger n = fromInteger n :+ 0

instance RealFloat a => Fractional (Complex a) where
  (x :+ y) / (x' :+ y') =
    let k = negate (max (exponent x') (exponent y'))
        x'' = scaleFloat k x'
        y'' = scaleFloat k y'
        d = x' * x'' + y' * y''
    in ((x * x'' + y * y'') / d) :+ ((y * x'' - x * y'') / d)
  fromRational a = fromRational a :+ 0

instance RealFloat a => Floating (Complex a) where
  pi = pi :+ 0
  exp (x :+ y) = let expx = exp x in (expx * cos y) :+ (expx * sin y)
  log z = log (magnitude z) :+ phase z
  sqrt (0 :+ 0) = 0
  sqrt z@(x :+ y) =
    let r = magnitude z
        u = sqrt ((r + abs x) / 2)
        v = abs y / (2 * u)
    in if x < 0 then v :+ (if y < 0 then negate u else u) else u :+ (if y < 0 then negate v else v)
  sin (x :+ y) = (sin x * cosh y) :+ (cos x * sinh y)
  cos (x :+ y) = (cos x * cosh y) :+ negate (sin x * sinh y)
  tan z = sin z / cos z
  sinh (x :+ y) = (cos y * sinh x) :+ (sin y * cosh x)
  cosh (x :+ y) = (cos y * cosh x) :+ (sin y * sinh x)
  tanh z = sinh z / cosh z
  asin z = let (x' :+ y') = log (((0 :+ 1) * z) + sqrt (1 - z * z)) in y' :+ negate x'
  acos z = let (x'' :+ y'') = log (z + ((0 :+ 1) * sqrt (1 - z * z))) in y'' :+ negate x''
  atan z = let (x' :+ y') = log (((1 :+ 0) + ((0 :+ 1) * z)) / sqrt (1 + z * z)) in y' :+ negate x'
  asinh z = log (z + sqrt (1 + z * z))
  acosh z = log (z + (sqrt (z + 1)) * (sqrt (z - 1)))
  atanh z = 0.5 * log ((1.0 + z) / (1.0 - z))
`;

/** `Data.Tree`, rose trees, as the containers package defines them. */
export const TREE_SOURCE = String.raw`module Data.Tree.Internal where

import Base

data Tree a = Node { rootLabel :: a, subForest :: [Tree a] } deriving (Eq, Ord, Show, Read)

type Forest a = [Tree a]

instance Functor Tree where
  fmap f (Node x ts) = Node (f x) (map (fmap f) ts)

instance Foldable Tree where
  foldr f z (Node x ts) = f x (foldr (\t acc -> foldr f acc t) z ts)

instance Traversable Tree where
  traverse f (Node x ts) = liftA2 Node (f x) (traverse (traverse f) ts)

instance Applicative Tree where
  pure x = Node x []
  Node f tfs <*> tx@(Node x txs) = Node (f x) (map (f <$>) txs ++ map (<*> tx) tfs)

instance Monad Tree where
  Node x ts >>= f = case f x of
    Node x' ts' -> Node x' (ts' ++ map (>>= f) ts)

flatten :: Tree a -> [a]
flatten t = squish t []
  where squish (Node x ts) xs = x : foldr squish xs ts

levels :: Tree a -> [[a]]
levels t = map (map rootLabel) (takeWhile (not . null) (iterate (concatMap subForest) [t]))

foldTree :: (a -> [b] -> b) -> Tree a -> b
foldTree f = go where go (Node x ts) = f x (map go ts)

unfoldTree :: (b -> (a, [b])) -> b -> Tree a
unfoldTree f b = let (a, bs) = f b in Node a (unfoldForest f bs)

unfoldForest :: (b -> (a, [b])) -> [b] -> [Tree a]
unfoldForest f = map (unfoldTree f)

drawTree :: Tree String -> String
drawTree = unlines . draw

drawForest :: [Tree String] -> String
drawForest = unlines . map drawTree

draw :: Tree String -> [String]
draw (Node x ts0) = lines x ++ drawSubTrees ts0
  where
    drawSubTrees [] = []
    drawSubTrees [t] = "|" : shift "${'`'}- " "   " (draw t)
    drawSubTrees (t : ts) = "|" : shift "+- " "|  " (draw t) ++ drawSubTrees ts
    shift first other = zipWith (++) (first : repeat other)
`;
