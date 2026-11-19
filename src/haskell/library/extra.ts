import { BT } from './source';

export const BASE_EXTRA = String.raw`
deleteFirstsBy :: (a -> a -> Bool) -> [a] -> [a] -> [a]
deleteFirstsBy eq = foldl (flip (deleteBy eq))

compareLength :: [a] -> Int -> Ordering
compareLength _ n | n < 0 = GT
compareLength [] n = compare 0 n
compareLength (_:xs) n = if n == 0 then GT else compareLength xs (n - 1)

applyWhen :: Bool -> (a -> a) -> a -> a
applyWhen b f x = if b then f x else x

mfilter :: MonadPlus m => (a -> Bool) -> m a -> m a
mfilter p m = m >>= \x -> if p x then return x else mzero

liftM3 :: Monad m => (a -> b -> c -> d) -> m a -> m b -> m c -> m d
liftM3 f a b c = a >>= \x -> b >>= \y -> c >>= \z -> return (f x y z)

liftM4 :: Monad m => (a -> b -> c -> d -> e) -> m a -> m b -> m c -> m d -> m e
liftM4 f a b c d = liftM3 f a b c >>= \g -> d >>= \x -> return (g x)

liftM5 :: Monad m => (a -> b -> c -> d -> e -> r) -> m a -> m b -> m c -> m d -> m e -> m r
liftM5 f a b c d e = liftM4 f a b c d >>= \g -> e >>= \x -> return (g x)

(<$!>) :: Monad m => (a -> b) -> m a -> m b
f <$!> m = m >>= \x -> let y = f x in y ${BT}seq${BT} return y
infixl 4 <$!>

optional :: Alternative f => f a -> f (Maybe a)
optional v = (Just <$> v) <|> pure Nothing

(<**>) :: Applicative f => f a -> f (a -> b) -> f b
(<**>) = liftA2 (flip ($))
infixl 4 <**>

data TraversalIdentity a = TraversalIdentity !a

instance Functor TraversalIdentity where
  fmap f (TraversalIdentity x) = TraversalIdentity (f x)

instance Applicative TraversalIdentity where
  pure = TraversalIdentity
  TraversalIdentity f <*> TraversalIdentity x = TraversalIdentity (f x)

fmapDefault :: Traversable t => (a -> b) -> t a -> t b
fmapDefault f x = runTraversalIdentity (traverse (TraversalIdentity . f) x)

runTraversalIdentity :: TraversalIdentity a -> a
runTraversalIdentity (TraversalIdentity x) = x

readInt :: Num a => a -> (Char -> Bool) -> (Char -> Int) -> ReadS a
readInt base valid digit s = [(foldl (\n c -> n * base + fromIntegral (digit c)) 0 ds, rest) | (ds, rest) <- [span valid s], not (null ds)]

readBin :: (Eq a, Num a) => ReadS a
readBin = readInt 2 (\c -> c == '0' || c == '1') digitToInt

readFloat :: RealFrac a => ReadS a
readFloat s = [(x, rest) | (token, rest) <- lex s, not (null token), isDigit (head token), Just x <- [convFractional token]]

readSigned :: Real a => ReadS a -> ReadS a
readSigned reader = readParen False (\s -> [(x, rest) | (token, rest) <- lex s, (x, "") <- reader token] ++ [(-x, rest) | ("-", after) <- lex s, (token, rest) <- lex after, (x, "") <- reader token])

fromRat :: RealFloat a => Rational -> a
fromRat = fromRational

`;
